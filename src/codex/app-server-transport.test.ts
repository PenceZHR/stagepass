import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppServerNotification } from "./app-server-protocol";
import type { AppServerConnection } from "./app-server-session";
import { AppServerSessionHost } from "./app-server-transport";
import { CodexUnavailableError } from "./transport";

class FakeConnection implements AppServerConnection {
  readonly calls: string[] = [];
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
}

const OPTIONS = {
  cwd: "/repo",
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
  effort: "xhigh",
} as const;

describe("AppServerSessionHost observer", () => {
  it("starts or resumes an observer but never starts a turn", async () => {
    const connection = new FakeConnection();
    const host = new AppServerSessionHost(connection);

    const fresh = await host.open(null, OPTIONS);
    const resumed = await host.open("THREAD-OLD", OPTIONS);

    assert.equal(fresh.threadId, "THREAD-1");
    assert.equal(resumed.threadId, "THREAD-OLD");
    assert.deepEqual(connection.calls, ["thread/start", "thread/resume"]);
    assert.equal(connection.calls.includes("turn/start"), false);
    assert.equal("runTurn" in host, false);
  });

  it("reuses one observer and releases it without touching the thread", async () => {
    const connection = new FakeConnection();
    const host = new AppServerSessionHost(connection);
    const first = await host.open("THREAD-OLD", OPTIONS);
    const second = await host.open("THREAD-OLD", OPTIONS);
    assert.equal(second, first);
    host.close("THREAD-OLD");
    assert.equal(host.session("THREAD-OLD"), null);
    assert.deepEqual(connection.calls, ["thread/resume"]);
  });

  it("fails native observers immediately when the proxy disconnects", async () => {
    const connection = new FakeConnection();
    const host = new AppServerSessionHost(connection);
    const disconnected = new Promise<never>((_resolve, reject) => {
      host.subscribeDisconnect(reject);
    });
    connection.disconnect();
    await assert.rejects(
      disconnected,
      (error: unknown) => error instanceof CodexUnavailableError
        && error.detail === "app_server_disconnected",
    );
  });
});
