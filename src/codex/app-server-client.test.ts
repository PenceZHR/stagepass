import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  AppServerClient,
  AppServerError,
} from "./app-server-client";

const FAKE_APP_SERVER = join(
  process.cwd(),
  "src",
  "codex",
  "__fixtures__",
  "fake-app-server.cjs",
);

function spawnClient(input: {
  mode?: "normal" | "chunked" | "approval" | "hang" | "exit1";
  onNotification?: Parameters<typeof AppServerClient.spawn>[0]["onNotification"];
  onServerRequest?: Parameters<typeof AppServerClient.spawn>[0]["onServerRequest"];
  onStderr?: Parameters<typeof AppServerClient.spawn>[0]["onStderr"];
} = {}): AppServerClient {
  return AppServerClient.spawn({
    command: process.execPath,
    args: [FAKE_APP_SERVER, "app-server", "--listen", "stdio://"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      FAKE_APP_SERVER_MODE: input.mode ?? "normal",
    },
    onNotification: input.onNotification ?? (() => {}),
    onServerRequest: input.onServerRequest ?? (async () => ({ decision: "decline" })),
    ...(input.onStderr === undefined ? {} : { onStderr: input.onStderr }),
  });
}

describe("AppServerClient", () => {
  it("initializes, correlates responses, and routes notifications", async () => {
    const notifications: string[] = [];
    const client = spawnClient({
      onNotification: (message) => notifications.push(message.method),
    });

    assert.ok(client.pid);
    const initialized = await client.initialize();
    const started = await client.request("thread/start", { cwd: process.cwd() });
    const closed = await client.close();

    assert.equal(initialized.userAgent, "stagepass-fake/1");
    assert.equal(
      (started as { thread?: { id?: string } }).thread?.id,
      "THREAD-1",
    );
    assert.deepEqual(notifications, ["thread/started"]);
    assert.deepEqual(closed, { code: 0, signal: null });
  });

  it("parses one response split across stdout chunks exactly once", async () => {
    const client = spawnClient({ mode: "chunked" });

    const initialized = await client.initialize();
    await client.close();

    assert.equal(initialized.userAgent, "stagepass-fake/1");
  });

  it("routes a server approval request and answers under the same id", async () => {
    const requests: string[] = [];
    let resolveApproval!: () => void;
    const approvalReceived = new Promise<void>((resolve) => {
      resolveApproval = resolve;
    });
    const client = spawnClient({
      mode: "approval",
      onNotification: (message) => {
        if (message.method === "fake/approvalReceived") resolveApproval();
      },
      onServerRequest: async (message) => {
        requests.push(message.method);
        return { decision: "decline" };
      },
    });

    await client.initialize();
    await client.request("thread/start", { cwd: process.cwd() });
    await approvalReceived;
    const closed = await client.close();

    assert.deepEqual(requests, ["item/commandExecution/requestApproval"]);
    assert.deepEqual(closed, { code: 0, signal: null });
  });

  it("times out only the target request and keeps the connection usable", async () => {
    const client = spawnClient();
    await client.initialize();

    await assert.rejects(
      client.request("fake/slow", {}, 20),
      (error: unknown) =>
        error instanceof AppServerError
        && error.code === "app_server_request_timeout",
    );
    const ping = await client.request("fake/ping");
    await client.close();

    assert.deepEqual(ping, { pong: true });
  });

  it("rejects pending work on exit without exposing stderr secrets", async () => {
    const diagnostics: string[] = [];
    const client = spawnClient({
      mode: "exit1",
      onStderr: (message) => diagnostics.push(message),
    });

    await assert.rejects(
      client.initialize(),
      (error: unknown) =>
        error instanceof AppServerError
        && error.code === "app_server_disconnected"
        && !error.message.includes("fixture-secret"),
    );
    assert.deepEqual(await client.close(), { code: 1, signal: null });
    assert.equal(diagnostics.join(" ").includes("fixture-secret"), false);
  });

  it("force-kills a server that ignores graceful close", async () => {
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const client = spawnClient({
      mode: "hang",
      onNotification: (message) => {
        if (message.method === "fake/ready") markReady();
      },
    });
    assert.ok(client.pid);
    await ready;

    const closed = await client.close(20);

    assert.equal(closed.signal, "SIGKILL");
  });
});
