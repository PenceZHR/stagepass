import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CodexAppServerClient,
  CodexAppServerError,
} from "./codex-app-server-client.ts";

const FAKE_APP_SERVER = path.join(
  process.cwd(),
  "server",
  "services",
  "__fixtures__",
  "fake-codex-app-server.cjs",
);

function spawnClient(input: {
  mode?: "normal" | "hang" | "exit1" | "approval";
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  onServerRequest?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  onStderr?: (chunk: string) => void;
} = {}): CodexAppServerClient {
  return CodexAppServerClient.spawn({
    bin: FAKE_APP_SERVER,
    cwd: process.cwd(),
    env: {
      ...process.env,
      FAKE_MODE: input.mode ?? "normal",
    },
    onNotification: input.onNotification ?? (() => {}),
    onServerRequest: input.onServerRequest ?? (async () => ({ decision: "decline" })),
    onStderr: input.onStderr,
  });
}

describe("CodexAppServerClient", () => {
  it("fails closed on methods outside shell/read control", async () => {
    const client = spawnClient();
    try {
      await client.initialize();
      await assert.rejects(
        client.request("managed/write", { threadId: "THREAD-1" }),
        /outside the shell\/read-control boundary/,
      );
    } finally {
      await client.close().catch(() => {});
    }
  });

  it("initializes and routes thread notifications while correlating responses", async () => {
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = spawnClient({
      onNotification: (method, params) => notifications.push({ method, params }),
    });

    assert.ok(client.pid);
    const initialized = await client.initialize();
    const result = await client.request("thread/start", {
      cwd: process.cwd(),
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    const closed = await client.close();

    assert.deepEqual(initialized, { userAgent: "stagepass-fake/1" });
    assert.equal(
      (result as { thread?: { id?: string } }).thread?.id,
      "THREAD-1",
    );
    assert.equal(notifications[0]?.method, "thread/started");
    assert.equal(
      (notifications[0]?.params.thread as { id?: string } | undefined)?.id,
      "THREAD-1",
    );
    assert.deepEqual(closed, { code: 0, signal: null });
  });

  it("rejects pending requests when the app-server exits and reports exit facts", async () => {
    const stderr: string[] = [];
    const client = spawnClient({
      mode: "exit1",
      onStderr: (chunk) => stderr.push(chunk),
    });

    await assert.rejects(
      client.initialize(),
      (error: unknown) =>
        error instanceof CodexAppServerError
        && error.code === null
        && !error.message.includes("fixture-secret"),
    );
    assert.deepEqual(await client.close(), { code: 1, signal: null });
    assert.equal(stderr.some((chunk) => chunk.includes("fixture-secret")), false);
  });

  it("routes server approval requests and writes the decline response", async () => {
    const serverRequests: string[] = [];
    let approvalReceivedResolve: (() => void) | null = null;
    const approvalReceived = new Promise<void>((resolve) => {
      approvalReceivedResolve = resolve;
    });
    const client = spawnClient({
      mode: "approval",
      onNotification: (method) => {
        if (method === "fake/approvalReceived") approvalReceivedResolve?.();
      },
      onServerRequest: async (method) => {
        serverRequests.push(method);
        return { decision: "decline" };
      },
    });

    await client.initialize();
    await client.request("thread/start", {
      cwd: process.cwd(),
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    await approvalReceived;
    const closed = await client.close();

    assert.deepEqual(serverRequests, ["item/commandExecution/requestApproval"]);
    assert.deepEqual(closed, { code: 0, signal: null });
  });

  it("force-kills an app-server that ignores the graceful close signal", async () => {
    let readyResolve!: () => void;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    const client = spawnClient({
      mode: "hang",
      onStderr: (chunk) => {
        if (chunk.includes("fake hang ready")) readyResolve();
      },
    });
    assert.ok(client.pid);
    const readinessTimeout = setTimeout(() => {
      readyResolve();
    }, 5_000);
    await ready;
    clearTimeout(readinessTimeout);
    const startedAt = Date.now();
    const safetyKill = setTimeout(() => {
      if (client.pid) process.kill(client.pid, "SIGKILL");
    }, 500);

    const closed = await client.close(20);
    clearTimeout(safetyKill);

    assert.equal(closed.signal, "SIGKILL");
    assert.ok(
      Date.now() - startedAt < 450,
      "the client should send SIGKILL after its own force-kill grace",
    );
  });
});
