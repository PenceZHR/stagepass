import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
  connectUnixAppServer,
  type AppServerWebSocket,
} from "./app-server-websocket";

class FakeDaemonSocket extends EventEmitter implements AppServerWebSocket {
  readonly sent: string[] = [];

  constructor() {
    super();
    queueMicrotask(() => this.emit("open"));
  }

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    const request = JSON.parse(data) as { id: number; method: string };
    callback?.();
    if (request.method === "initialize") {
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({
        id: request.id,
        result: { userAgent: "stagepass-websocket-test/1" },
      }))));
    }
  }

  close(): void {
    queueMicrotask(() => this.emit("close", 1_000));
  }

  terminate(): void {
    this.emit("close", 1_001);
  }
}

describe("Unix-socket App Server WebSocket", () => {
  it("initializes over the daemon WebSocket instead of writing JSONL to its raw socket", async () => {
    const socket = new FakeDaemonSocket();
    const client = await connectUnixAppServer({
      socketPath: "/tmp/codex.sock",
      socketFactory: () => socket,
      onNotification: () => {},
      onServerRequest: async () => ({ decision: "decline" }),
    });

    const initialized = await client.initialize(1_000);
    assert.equal(initialized.userAgent, "stagepass-websocket-test/1");
    assert.equal(JSON.parse(socket.sent[0] ?? "{}").method, "initialize");
    await client.close();
  });
});
