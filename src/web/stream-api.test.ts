import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import type {
  AppServerNotification,
  AppServerRequest,
} from "../codex/app-server-protocol";
import { AppServerHistory } from "../codex/app-server-history";
import type { AppServerConnection } from "../codex/app-server-session";
import { AppServerSessionHost } from "../codex/app-server-transport";
import type { StreamEvent } from "../codex/stream-state";
import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { createPanelServer } from "./panel-server";
import { StreamSessions, type StreamSeat } from "./stream-session";

class FakeConnection implements AppServerConnection {
  readonly requests: Array<{
    method: string;
    params: Readonly<Record<string, unknown>>;
  }> = [];
  private readonly listeners = new Set<(message: AppServerNotification) => void>();

  request(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      return Promise.resolve({ thread: { id: "THREAD-1", turns: [] } });
    }
    if (method === "thread/resume") {
      return Promise.resolve({ thread: { id: params.threadId, turns: [] } });
    }
    if (method === "turn/start") {
      return Promise.resolve({
        turn: { id: "TURN-1", status: "inProgress", items: [] },
      });
    }
    if (method === "turn/steer") return Promise.resolve({ turnId: "TURN-1" });
    if (method === "turn/interrupt") return Promise.resolve({});
    throw new Error(`unexpected request: ${method}`);
  }

  subscribeNotifications(listener: (message: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method: string, params: Record<string, unknown>): void {
    for (const listener of this.listeners) listener({ method, params });
  }
}

class ObservedStreamSessions extends StreamSessions {
  removals = 0;

  override subscribe(
    changeId: string,
    seat: StreamSeat,
    listener: (event: StreamEvent) => void,
  ): () => void {
    const unsubscribe = super.subscribe(changeId, seat, listener);
    return () => {
      this.removals += 1;
      unsubscribe();
    };
  }
}

async function withStreamPanel(body: (input: {
  readonly base: string;
  readonly connection: FakeConnection;
  readonly host: AppServerSessionHost;
  readonly streams: ObservedStreamSessions;
}) => Promise<void>): Promise<void> {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure("PRJ-1", "Project", "/repo");
  new ChangeStore(database).create("CHG-1", { projectId: "PRJ-1" });
  const connection = new FakeConnection();
  const host = new AppServerSessionHost(connection);
  const history = new AppServerHistory(connection);
  const streams = new ObservedStreamSessions({
    database,
    host,
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    effort: "xhigh",
  });
  const { server, sessions } = createPanelServer({
    database,
    streams,
    history,
    appServerTransport: () => ({
      async runTurn() {
        throw new Error("background turn is outside stream API tests");
      },
    }),
    recoverEveryMs: 3_600_000,
    repo: {
      dirtyPaths: () => [],
      commitAll: () => null,
      commitPaths: () => null,
      show: () => null,
      head: () => null,
      trackedFiles: () => [],
    },
    trust: { isTrusted: () => null },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await body({ base, connection, host, streams });
  } finally {
    history.dispose();
    sessions.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  }
}

const post = (base: string, path: string, value: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });

describe("panel · structured App Server stream API", () => {
  it("opens without a turn and serves the materialized snapshot", async () => {
    await withStreamPanel(async ({ base, connection }) => {
      const opened = await post(base, "/api/codex/open", {
        changeId: "CHG-1",
        seat: "PRD",
      });
      const snapshot = await (await fetch(
        `${base}/api/codex/snapshot?change=CHG-1&seat=PRD`,
      )).json() as { threadId: string; activeTurnId: string | null };

      assert.equal(opened.status, 200);
      assert.equal(snapshot.threadId, "THREAD-1");
      assert.equal(snapshot.activeTurnId, null);
      assert.deepEqual(connection.requests.map(({ method }) => method), ["thread/start"]);
    });
  });

  it("replays SSE ids and removes its listener when the browser leaves", async () => {
    await withStreamPanel(async ({ base, connection, streams }) => {
      await post(base, "/api/codex/open", { changeId: "CHG-1", seat: "PRD" });
      await post(base, "/api/codex/turn", {
        changeId: "CHG-1",
        seat: "PRD",
        prompt: "开始",
      });
      connection.emit("item/started", {
        threadId: "THREAD-1",
        turnId: "TURN-1",
        item: { type: "agentMessage", id: "ITEM-1", text: "" },
      });
      connection.emit("item/agentMessage/delta", {
        threadId: "THREAD-1",
        turnId: "TURN-1",
        itemId: "ITEM-1",
        delta: "原生流",
      });

      const response = await fetch(
        `${base}/api/codex/events?change=CHG-1&seat=PRD`,
        { headers: { "last-event-id": "1" } },
      );
      const reader = response.body!.getReader();
      const chunk = new TextDecoder().decode((await reader.read()).value);

      assert.equal(response.status, 200);
      assert.match(chunk, /id: 2\nevent: item\.started/);
      assert.match(chunk, /id: 3\nevent: item\.delta/);
      await reader.cancel();
      for (let attempt = 0; attempt < 50 && streams.removals === 0; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(streams.removals, 1);
    });
  });

  it("requires a fresh snapshot when Last-Event-ID fell out of the replay ring", async () => {
    await withStreamPanel(async ({ base, connection }) => {
      await post(base, "/api/codex/open", { changeId: "CHG-1", seat: "PRD" });
      for (let index = 0; index < 513; index += 1) {
        connection.emit("error", {
          threadId: "THREAD-1",
          message: `error-${index}`,
        });
      }

      const response = await fetch(
        `${base}/api/codex/events?change=CHG-1&seat=PRD`,
        { headers: { "last-event-id": "0" } },
      );
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.match(text, /event: snapshot\.required/);
      assert.match(text, /"reason":"replay_gap"/);
    });
  });

  it("returns stable conflict codes for busy/stale/resolved actions", async () => {
    await withStreamPanel(async ({ base, host }) => {
      await post(base, "/api/codex/open", { changeId: "CHG-1", seat: "PRD" });
      await post(base, "/api/codex/turn", {
        changeId: "CHG-1", seat: "PRD", prompt: "开始",
      });
      const busy = await post(base, "/api/codex/turn", {
        changeId: "CHG-1", seat: "PRD", prompt: "第二条",
      });
      const stale = await post(base, "/api/codex/steer", {
        changeId: "CHG-1", seat: "PRD", direction: "转向", expectedTurnId: "OLD",
      });
      const staleInterrupt = await post(base, "/api/codex/interrupt", {
        changeId: "CHG-1", seat: "PRD", turnId: "OLD",
      });
      const pending = host.handleServerRequest({
        id: 9,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "THREAD-1",
          turnId: "TURN-1",
          serverName: "stagepass",
          message: "请选择",
        },
      } satisfies AppServerRequest);
      const snapshot = await (await fetch(
        `${base}/api/codex/snapshot?change=CHG-1&seat=PRD`,
      )).json() as { interactions: Array<{ id: string }> };
      const answer = {
        action: "accept",
        content: { choice: "A" },
        _meta: null,
      };
      const first = await post(base, "/api/codex/respond", {
        changeId: "CHG-1",
        seat: "PRD",
        interactionId: snapshot.interactions[0]?.id,
        response: answer,
      });
      const repeated = await post(base, "/api/codex/respond", {
        changeId: "CHG-1",
        seat: "PRD",
        interactionId: snapshot.interactions[0]?.id,
        response: answer,
      });

      assert.equal((await busy.json() as { code: string }).code, "turn_busy");
      assert.equal((await stale.json() as { code: string }).code, "stale_turn");
      assert.equal(
        (await staleInterrupt.json() as { code: string }).code,
        "stale_turn",
      );
      assert.equal(first.status, 200);
      assert.deepEqual(await pending, answer);
      assert.equal(
        (await repeated.json() as { code: string }).code,
        "interaction_already_resolved",
      );
    });
  });
});
