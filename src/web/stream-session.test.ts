import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import type { AppServerNotification } from "../codex/app-server-protocol";
import type { AppServerConnection } from "../codex/app-server-session";
import { AppServerSessionHost } from "../codex/app-server-transport";
import { SCHEMA_SQL } from "../db/schema";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { StreamSessions, StreamSessionError } from "./stream-session";

class FakeConnection implements AppServerConnection {
  readonly requests: Array<{
    method: string;
    params: Readonly<Record<string, unknown>>;
  }> = [];
  private readonly listeners = new Set<(message: AppServerNotification) => void>();
  private nextThread = 1;

  request(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      return Promise.resolve({
        thread: { id: `THREAD-${this.nextThread++}`, turns: [] },
      });
    }
    if (method === "thread/resume") {
      return Promise.resolve({ thread: { id: params.threadId, turns: [] } });
    }
    if (method === "turn/start") {
      return Promise.resolve({
        turn: { id: "TURN-1", status: "inProgress", items: [] },
      });
    }
    if (method === "turn/steer") return Promise.resolve({ turnId: params.expectedTurnId });
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

function setup(now?: () => number) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure("PRJ-1", "Project", "/repo");
  new ChangeStore(database).create("CHG-1", { projectId: "PRJ-1" });
  const connection = new FakeConnection();
  const sessions = new StreamSessions({
    database,
    host: new AppServerSessionHost(connection),
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    effort: "xhigh",
    ...(now === undefined ? {} : { now }),
  });
  return { database, connection, sessions };
}

describe("StreamSessions", () => {
  it("keeps a new zero-turn thread ephemeral", async () => {
    const { database, connection, sessions } = setup();
    try {
      const first = await sessions.open("CHG-1", "PRD", {
        threadId: null,
        config: { stagepass: true },
      });
      const second = await sessions.open("CHG-1", "PRD");

      assert.equal(first, second);
      assert.deepEqual(
        connection.requests.map(({ method }) => method),
        ["thread/start"],
      );
      assert.equal(new BindingStore(database).find("CHG-1", "PRD"), null);
      assert.equal(first.snapshot().activeTurnId, null);
      assert.equal(connection.requests[0]?.params.cwd, "/repo");
    } finally {
      database.close();
    }
  });

  it("resumes an explicitly selected thread without binding a new aside", async () => {
    const { database, connection, sessions } = setup();
    try {
      const bindings = new BindingStore(database);

      assert.equal(
        (await sessions.open("CHG-1", "PRD", { threadId: "THREAD-OLD" })).threadId,
        "THREAD-OLD",
      );
      assert.equal(
        (await sessions.open("CHG-1", "aside", { threadId: null })).threadId,
        "THREAD-1",
      );
      assert.equal(bindings.find("CHG-1", "PRD"), null);
      assert.equal(bindings.findAside("CHG-1"), null);
      assert.deepEqual(
        connection.requests.map(({ method }) => method),
        ["thread/resume", "thread/start"],
      );
    } finally {
      database.close();
    }
  });

  it("projects events and delegates turn controls to the exact open seat", async () => {
    let clock = 1_000;
    const { database, connection, sessions } = setup(() => clock);
    try {
      assert.equal(sessions.quietForMs("CHG-1", "PRD"), null);
      await sessions.open("CHG-1", "PRD");
      assert.equal(sessions.quietForMs("CHG-1", "PRD"), 0);
      clock = 1_250;
      assert.equal(sessions.quietForMs("CHG-1", "PRD"), 250);
      assert.equal(sessions.has("CHG-1", "PRD"), true);
      assert.equal(sessions.active("CHG-1", "PRD"), false);
      const turnId = await sessions.startTurn("CHG-1", "PRD", "开始");
      assert.equal(sessions.active("CHG-1", "PRD"), true);
      connection.emit("item/started", {
        threadId: "THREAD-1",
        turnId,
        item: { type: "agentMessage", id: "ITEM-1", text: "" },
      });
      assert.equal(sessions.quietForMs("CHG-1", "PRD"), 0);
      clock = 1_500;
      connection.emit("item/agentMessage/delta", {
        threadId: "THREAD-1",
        turnId,
        itemId: "ITEM-1",
        delta: "流式",
      });
      assert.equal(sessions.quietForMs("CHG-1", "PRD"), 0);
      await sessions.steer("CHG-1", "PRD", "继续", turnId);
      await sessions.interrupt("CHG-1", "PRD", turnId);
      connection.emit("turn/completed", {
        threadId: "THREAD-1",
        turn: { id: turnId, status: "interrupted", items: [] },
      });

      assert.equal(sessions.snapshot("CHG-1", "PRD").items[0]?.text, "流式");
      assert.equal(sessions.active("CHG-1", "PRD"), false);
      assert.deepEqual(
        connection.requests.slice(1).map(({ method }) => method),
        ["turn/start", "turn/steer", "turn/interrupt"],
      );
    } finally {
      database.close();
    }
  });

  it("fails closed for an unopened seat or a Change without a project path", async () => {
    const { database, sessions } = setup();
    try {
      assert.equal(sessions.active("CHG-1", "Spec"), false);
      assert.throws(
        () => sessions.snapshot("CHG-1", "Spec"),
        (error: unknown) =>
          error instanceof StreamSessionError && error.code === "session_not_open",
      );
      new ProjectStore(database).ensure("PRJ-EMPTY", "No path");
      new ChangeStore(database).create("CHG-EMPTY", { projectId: "PRJ-EMPTY" });
      await assert.rejects(
        sessions.open("CHG-EMPTY", "PRD"),
        (error: unknown) =>
          error instanceof StreamSessionError && error.code === "project_path_missing",
      );
    } finally {
      database.close();
    }
  });
});
