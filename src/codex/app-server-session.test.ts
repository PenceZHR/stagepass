import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppServerNotification, AppServerRequest } from "./app-server-protocol";
import {
  AppServerSession,
  AppServerSessionError,
  type AppServerConnection,
} from "./app-server-session";

class FakeConnection implements AppServerConnection {
  readonly requests: Array<{
    method: string;
    params: Readonly<Record<string, unknown>>;
  }> = [];
  private readonly listeners = new Set<(message: AppServerNotification) => void>();
  private next: (method: string, params: Readonly<Record<string, unknown>>) => unknown =
    (method) => {
      if (method === "thread/start" || method === "thread/resume") {
        return { thread: { id: "THREAD-1", turns: [] } };
      }
      if (method === "turn/start") {
        return { turn: { id: "TURN-1", status: "inProgress", items: [] } };
      }
      if (method === "turn/steer") return { turnId: "TURN-1" };
      if (method === "turn/interrupt") return {};
      throw new Error(`unexpected request: ${method}`);
    };

  request(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
    this.requests.push({ method, params });
    return Promise.resolve(this.next(method, params));
  }

  subscribeNotifications(listener: (message: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method: string, params: Record<string, unknown>): void {
    for (const listener of this.listeners) listener({ method, params });
  }
}

const options = {
  cwd: "/repo",
  sandbox: "workspace-write" as const,
  approvalPolicy: "on-request" as const,
  effort: "xhigh",
};

describe("AppServerSession", () => {
  it("starts a persistent thread without starting a turn", async () => {
    const connection = new FakeConnection();

    const session = await AppServerSession.start(connection, options);

    assert.equal(session.threadId, "THREAD-1");
    assert.deepEqual(connection.requests.map((request) => request.method), ["thread/start"]);
    assert.equal(session.snapshot().activeTurnId, null);
    assert.equal(connection.requests[0]?.params.ephemeral, false);
  });

  it("resumes the exact bound thread", async () => {
    const connection = new FakeConnection();

    const session = await AppServerSession.resume(connection, "THREAD-1", options);

    assert.equal(session.threadId, "THREAD-1");
    assert.equal(connection.requests[0]?.method, "thread/resume");
    assert.equal(connection.requests[0]?.params.threadId, "THREAD-1");
  });

  it("streams a turn and returns terminal agent text", async () => {
    const connection = new FakeConnection();
    const session = await AppServerSession.start(connection, options);

    const turnId = await session.startTurn("继续");
    const completed = session.awaitTurn(turnId, 200);
    connection.emit("turn/started", {
      threadId: "THREAD-1",
      turn: { id: "TURN-1", status: "inProgress", items: [] },
    });
    connection.emit("item/started", {
      threadId: "THREAD-1",
      turnId: "TURN-1",
      item: { type: "agentMessage", id: "ITEM-1", text: "" },
      startedAtMs: 1,
    });
    connection.emit("item/agentMessage/delta", {
      threadId: "THREAD-1",
      turnId: "TURN-1",
      itemId: "ITEM-1",
      delta: "完成",
    });
    connection.emit("turn/completed", {
      threadId: "THREAD-1",
      turn: {
        id: "TURN-1",
        status: "completed",
        items: [{ type: "agentMessage", id: "ITEM-1", text: "完成。" }],
      },
    });

    assert.deepEqual(await completed, {
      threadId: "THREAD-1",
      turnId: "TURN-1",
      status: "completed",
      text: "完成。",
    });
    assert.equal(
      (connection.requests[1]?.params.input as Array<{ text?: string }>)[0]?.text,
      "继续",
    );
  });

  it("waits for a turn newer than the captured baseline", async () => {
    const connection = new FakeConnection();
    const session = await AppServerSession.start(connection, options);
    connection.emit("turn/started", {
      threadId: "THREAD-1",
      turn: { id: "TURN-OLD", status: "inProgress", items: [] },
    });
    connection.emit("turn/completed", {
      threadId: "THREAD-1",
      turn: { id: "TURN-OLD", status: "completed", items: [] },
    });

    const waiting = session.awaitNextTurn("TURN-OLD", 200);
    connection.emit("item/started", {
      threadId: "THREAD-1",
      turnId: "TURN-OLD",
      item: { type: "agentMessage", id: "OLD-ITEM", text: "old" },
    });
    connection.emit("turn/started", {
      threadId: "OTHER-THREAD",
      turn: { id: "TURN-OTHER", status: "inProgress", items: [] },
    });
    connection.emit("turn/started", {
      threadId: "THREAD-1",
      turn: { id: "TURN-NEW", status: "inProgress", items: [] },
    });

    assert.equal(await waiting, "TURN-NEW");
  });

  it("bounds the wait for an externally started turn", async () => {
    const session = await AppServerSession.start(new FakeConnection(), options);

    await assert.rejects(
      session.awaitNextTurn(null, 5),
      (error: unknown) => error instanceof AppServerSessionError
        && error.code === "turn_start_timeout",
    );
  });

  it("steers and interrupts only the current turn", async () => {
    const connection = new FakeConnection();
    const session = await AppServerSession.start(connection, options);
    await session.startTurn("开始");

    await session.steer("先检查测试", "TURN-1");
    await session.interrupt("TURN-1");

    assert.deepEqual(
      connection.requests.slice(2).map((request) => request.method),
      ["turn/steer", "turn/interrupt"],
    );
    assert.equal(connection.requests[2]?.params.expectedTurnId, "TURN-1");
    assert.equal(connection.requests[3]?.params.turnId, "TURN-1");
    await assert.rejects(
      session.steer("迟到的方向", "TURN-OLD"),
      (error: unknown) =>
        error instanceof AppServerSessionError && error.code === "stale_turn",
    );
  });

  it("holds a server interaction until the human response arrives", async () => {
    const connection = new FakeConnection();
    const session = await AppServerSession.start(connection, options);
    const request: AppServerRequest = {
      id: 77,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "THREAD-1",
        turnId: "TURN-1",
        serverName: "stagepass",
        mode: "form",
        message: "请选择",
        requestedSchema: { type: "object" },
      },
    };

    const result = session.handleServerRequest(request);
    const interaction = session.snapshot().interactions[0];
    assert.equal(interaction?.kind, "mcpElicitation");
    assert.equal(interaction?.status, "pending");

    await session.respond(interaction!.id, {
      action: "accept",
      content: { choice: "A" },
      _meta: null,
    });

    assert.deepEqual(await result, {
      action: "accept",
      content: { choice: "A" },
      _meta: null,
    });
    assert.equal(session.snapshot().interactions[0]?.status, "resolved");
  });
});
