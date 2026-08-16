import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { AppServerError } from "../codex/app-server-client";
import { AppServerHistory } from "../codex/app-server-history";
import type {
  AppServerNotification,
} from "../codex/app-server-protocol";
import type { AppServerConnection } from "../codex/app-server-session";
import { AppServerSessionHost } from "../codex/app-server-transport";
import { SCHEMA_SQL } from "../db/schema";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { createPanelServer } from "./panel-server";
import type {
  NativeSeat,
  NativeSessionStatus,
  NativeSessionsPort,
} from "./native-sessions";
import { StreamSessions } from "./stream-session";

class FakeConnection implements AppServerConnection {
  readonly calls: Array<{
    method: string;
    params: Readonly<Record<string, unknown>>;
  }> = [];
  readonly threads = new Map<string, {
    id: string;
    parentThreadId: null;
    status: { type: string };
    turns: Array<Record<string, unknown>>;
  }>();
  readonly archived = new Set<string>();
  private readonly listeners = new Set<
    (message: AppServerNotification) => void
  >();
  private nextThread = 1;
  private nextTurn = 1;

  async request(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      const id = `THREAD-${this.nextThread++}`;
      const thread = {
        id,
        parentThreadId: null,
        status: { type: "idle" },
        turns: [],
      };
      this.threads.set(id, thread);
      return { thread };
    }
    if (method === "thread/resume") {
      const thread = this.threads.get(String(params.threadId));
      if (thread === undefined) throw this.missing(String(params.threadId));
      return { thread };
    }
    if (method === "thread/read") {
      const thread = this.threads.get(String(params.threadId));
      if (thread === undefined) throw this.missing(String(params.threadId));
      return { thread };
    }
    if (method === "thread/list") {
      const wantArchived = params.archived === true;
      return {
        data: [...this.threads.values()].filter((thread) =>
          this.archived.has(thread.id) === wantArchived),
        nextCursor: null,
      };
    }
    if (method === "thread/archive") {
      this.archived.add(String(params.threadId));
      return {};
    }
    if (method === "thread/unarchive") {
      this.archived.delete(String(params.threadId));
      return { thread: this.threads.get(String(params.threadId)) };
    }
    if (method === "turn/start") {
      const threadId = String(params.threadId);
      const thread = this.threads.get(threadId);
      assert.ok(thread);
      const turn = {
        id: `TURN-${this.nextTurn++}`,
        status: "inProgress",
        items: [],
      };
      thread.turns.push(turn);
      thread.status = { type: "active" };
      return { turn };
    }
    if (method === "turn/interrupt") return {};
    throw new Error(`unexpected App Server request: ${method}`);
  }

  subscribeNotifications(
    listener: (message: AppServerNotification) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private missing(threadId: string): AppServerError {
    return new AppServerError(
      "app_server_request_failed",
      `thread not loaded: ${threadId}`,
      -32600,
    );
  }
}

class FakeNativeSessions implements NativeSessionsPort {
  readonly calls: string[] = [];

  private answer(changeId: string, seat: NativeSeat, action: string): Promise<NativeSessionStatus> {
    this.calls.push(`${action}:${changeId}/${seat}`);
    return Promise.resolve({
      changeId,
      seat,
      threadId: "THREAD-NATIVE",
      thread: "idle",
      tmuxSession: "sp_0123456789abcdef0123",
      tmux: action === "close-window" || action === "end-session" ? "detached" : "attached",
      terminal: action === "close-window" || action === "end-session" ? "closed" : "open",
      action: action === "close-window" || action === "end-session" ? "reopen" : "focus",
    });
  }

  status(changeId: string, seat: NativeSeat) { return this.answer(changeId, seat, "status"); }
  open(changeId: string, seat: NativeSeat) { return this.answer(changeId, seat, "open"); }
  focus(changeId: string, seat: NativeSeat) { return this.answer(changeId, seat, "focus"); }
  closeWindow(changeId: string, seat: NativeSeat) {
    return this.answer(changeId, seat, "close-window");
  }
  endSession(changeId: string, seat: NativeSeat) {
    return this.answer(changeId, seat, "end-session");
  }
  archiveAndEnd(): Promise<void> { return Promise.resolve(); }
  releaseObserver(): void {}
  forget(): Promise<void> { return Promise.resolve(); }
  closeControlConnection(): void {}
}

async function withPanel(body: (input: {
  base: string;
  database: Database.Database;
  connection: FakeConnection;
  native: FakeNativeSessions;
  sessions: ReturnType<typeof createPanelServer>["sessions"];
}) => Promise<void>): Promise<void> {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure("PRJ-1", "Project", "/repo");
  new ChangeStore(database).create("CHG-1", { projectId: "PRJ-1" });
  const connection = new FakeConnection();
  const host = new AppServerSessionHost(connection);
  const history = new AppServerHistory(connection);
  const native = new FakeNativeSessions();
  const streams = new StreamSessions({
    database,
    host,
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    effort: "xhigh",
  });
  const created = createPanelServer({
    database,
    history,
    streams,
    appServerTransport: () => ({
      async runTurn() {
        throw new Error("background turns are outside this routing test");
      },
    }),
    nativeSessions: native,
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
  await new Promise<void>((resolve) => {
    created.server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${
    (created.server.address() as AddressInfo).port
  }`;
  try {
    await body({ base, database, connection, native, sessions: created.sessions });
  } finally {
    history.dispose();
    created.sessions.closeAll();
    created.server.closeAllConnections();
    await new Promise<void>((resolve) => created.server.close(() => resolve()));
    database.close();
  }
}

describe("pure App Server panel", () => {
  it("只开放归一化终端桥，旧 terminal / Codex 写路由和 PTY 都不存在", async () => {
    await withPanel(async ({ base, native }) => {
      assert.equal((await fetch(`${base}/api/terminal?change=CHG-1&phase=PRD`, {
        method: "POST",
      })).status, 404);
      assert.equal((await fetch(`${base}/api/codex/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changeId: "CHG-1", seat: "PRD", prompt: "raw" }),
      })).status, 404);
      assert.equal((await fetch(`${base}/pty/CHG-1/PRD`)).status, 404);

      const opened = await fetch(`${base}/api/terminal/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changeId: "CHG-1", seat: "PRD" }),
      });
      assert.equal(opened.status, 200);
      assert.deepEqual(native.calls, ["open:CHG-1/PRD"]);
    });
  });

  it("启动巡检只解绑 App Server 明确认定不存在的 binding", async () => {
    await withPanel(async ({ database, sessions }) => {
      const bindings = new BindingStore(database);
      bindings.bind("CHG-1", "PRD", "THREAD-MISSING");
      const report = await sessions.reconcileBindings();
      assert.deepEqual(report.detached, [{
        changeId: "CHG-1",
        kind: "round",
        phase: "PRD",
        threadId: "THREAD-MISSING",
      }]);
      assert.equal(bindings.find("CHG-1", "PRD")?.status, "detached");
    });
  });

  it("关闭窗口与结束会话是两条独立的本机动作", async () => {
    await withPanel(async ({ base, native }) => {
      for (const action of ["close-window", "end-session"]) {
        const response = await fetch(`${base}/api/terminal/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ changeId: "CHG-1", seat: "PRD" }),
        });
        assert.equal(response.status, 200);
      }
      assert.deepEqual(native.calls, [
        "close-window:CHG-1/PRD",
        "end-session:CHG-1/PRD",
      ]);
    });
  });
});
