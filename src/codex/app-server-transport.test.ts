import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppServerNotification } from "./app-server-protocol";
import type { AppServerConnection } from "./app-server-session";
import { CodexUnavailableError } from "./transport";
import {
  AppServerCodexTransport,
  AppServerSessionHost,
  CodexTurnError,
} from "./app-server-transport";

class FakeConnection implements AppServerConnection {
  readonly calls: string[] = [];
  terminal: "completed" | "failed" | "interrupted" | "none" = "completed";
  private readonly listeners = new Set<(message: AppServerNotification) => void>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();

  request(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
    this.calls.push(method);
    if (method === "thread/start") {
      return Promise.resolve({ thread: { id: "THREAD-1", turns: [] } });
    }
    if (method === "thread/resume") {
      return Promise.resolve({ thread: { id: params.threadId, turns: [] } });
    }
    if (method === "turn/start") {
      if (this.terminal !== "none") {
        const status = this.terminal;
        queueMicrotask(() => this.emit("turn/completed", {
          threadId: params.threadId,
          turn: {
            id: "TURN-1",
            status,
            items: status === "completed"
              ? [{ type: "agentMessage", id: "ITEM-1", text: "final answer" }]
              : [],
          },
        }));
      }
      return Promise.resolve({
        turn: { id: "TURN-1", status: "inProgress", items: [] },
      });
    }
    throw new Error(`unexpected request: ${method}`);
  }

  subscribeNotifications(listener: (message: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  disconnect(): void {
    for (const listener of this.disconnectListeners) {
      listener(new Error("fake app-server exited"));
    }
  }

  private emit(method: string, params: Record<string, unknown>): void {
    for (const listener of this.listeners) listener({ method, params });
  }
}

function transport(connection: FakeConnection, timeoutMs = 100): AppServerCodexTransport {
  return new AppServerCodexTransport(new AppServerSessionHost(connection), {
    cwd: "/repo",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    effort: "xhigh",
    timeoutMs,
  });
}

describe("AppServerCodexTransport", () => {
  it("publishes a new thread before starting and completing its turn", async () => {
    const connection = new FakeConnection();
    const timeline = connection.calls;

    const delivery = await transport(connection).runTurn({
      threadId: null,
      prompt: "Return the contract",
      onThread: (threadId) => timeline.push(`onThread:${threadId}`),
    });

    assert.deepEqual(timeline, [
      "thread/start",
      "onThread:THREAD-1",
      "turn/start",
    ]);
    assert.deepEqual(delivery, {
      threadId: "THREAD-1",
      text: "final answer",
    });
  });

  it("resumes exactly the supplied thread", async () => {
    const connection = new FakeConnection();

    const delivery = await transport(connection).runTurn({
      threadId: "THREAD-OLD",
      prompt: "Continue",
    });

    assert.equal(delivery.threadId, "THREAD-OLD");
    assert.deepEqual(connection.calls, ["thread/resume", "turn/start"]);
  });

  for (const status of ["failed", "interrupted"] as const) {
    it(`keeps terminal ${status} distinct from a completed answer`, async () => {
      const connection = new FakeConnection();
      connection.terminal = status;

      await assert.rejects(
        transport(connection).runTurn({ threadId: null, prompt: "Go" }),
        (error: unknown) =>
          error instanceof CodexTurnError
          && error.code === `codex_turn_${status}`,
      );
    });
  }

  it("fails a bounded wait instead of pretending the turn completed", async () => {
    const connection = new FakeConnection();
    connection.terminal = "none";

    await assert.rejects(
      transport(connection, 10).runTurn({ threadId: null, prompt: "Go" }),
      (error: unknown) =>
        error instanceof CodexTurnError && error.code === "codex_turn_timeout",
    );
  });

  it("fails immediately when the shared app-server disconnects", async () => {
    const connection = new FakeConnection();
    connection.terminal = "none";

    const running = transport(connection, 1_000).runTurn({
      threadId: null,
      prompt: "Go",
    });
    queueMicrotask(() => connection.disconnect());

    await assert.rejects(
      running,
      (error: unknown) =>
        error instanceof CodexUnavailableError
        && error.detail === "app_server_disconnected",
    );
  });
});
