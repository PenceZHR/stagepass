import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AppServerNotification,
  AppServerRequest,
} from "./app-server-protocol";
import {
  ManagedAppServerError,
  startManagedAppServer,
  type AppServerControlClient,
} from "./app-server-daemon";
import { AppServerError, type AppServerExit } from "./app-server-client";
import type { AppServerConnection } from "./app-server-session";
import type {
  ProcessOps,
  ProcessRequest,
  ProcessResult,
} from "../system/process";

const successful = (): ProcessResult => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
});

class RecordingProcess implements ProcessOps {
  readonly runs: ProcessRequest[] = [];

  constructor(private readonly result: ProcessResult = successful()) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.runs.push(request);
    return this.result;
  }

  spawn(): never {
    throw new Error("daemon test injects the App Server client factory");
  }
}

class RecordingClient implements AppServerControlClient, AppServerConnection {
  initialized = 0;
  closed = 0;
  readonly initializeTimeouts: Array<number | undefined> = [];

  constructor(private readonly initializeError: Error | null = null) {}

  async initialize(timeoutMs?: number): Promise<Readonly<Record<string, unknown>>> {
    this.initialized += 1;
    this.initializeTimeouts.push(timeoutMs);
    if (this.initializeError !== null) throw this.initializeError;
    return {};
  }

  async close(): Promise<AppServerExit> {
    this.closed += 1;
    return { code: 0, signal: null };
  }

  async request(): Promise<unknown> {
    return {};
  }

  notify(): void {}
  respond(): void {}
  reject(): void {}

  subscribeNotifications(
    _listener: (message: AppServerNotification) => void,
  ): () => void {
    return () => {};
  }

  subscribeDisconnect(_listener: (error: Error) => void): () => void {
    return () => {};
  }
}

const callbacks = {
  onNotification: (_message: AppServerNotification): void => {},
  onServerRequest: async (_message: AppServerRequest): Promise<unknown> => ({}),
};

describe("managed App Server owner", () => {
  it("starts the daemon, opens its proxy, and closes only the proxy", async () => {
    const process = new RecordingProcess();
    const client = new RecordingClient();
    const factories: Array<Readonly<{ command: string; args: readonly string[] }>> = [];

    const runtime = await startManagedAppServer({
      command: "codex",
      cwd: "/repo",
      process,
      ...callbacks,
      clientFactory: (options) => {
        factories.push(options);
        return client;
      },
    });

    await runtime.close();

    assert.deepEqual(process.runs.map(({ command, args }) => [command, ...args]), [[
      "codex", "app-server", "daemon", "start",
    ]]);
    assert.deepEqual(factories.map(({ command, args }) => [command, ...args]), [[
      "codex", "app-server", "proxy",
    ]]);
    assert.equal(client.initialized, 1);
    assert.equal(client.closed, 1);
  });

  it("names a daemon start failure and never creates a proxy client", async () => {
    const process = new RecordingProcess({
      code: 1,
      signal: null,
      stdout: "",
      stderr: "standalone install missing",
    });
    let factories = 0;

    await assert.rejects(
      startManagedAppServer({
        command: "codex",
        cwd: "/repo",
        process,
        ...callbacks,
        clientFactory: () => {
          factories += 1;
          return new RecordingClient();
        },
      }),
      (error: unknown) => error instanceof ManagedAppServerError
        && error.code === "app_server_daemon_unavailable"
        && /standalone install missing/.test(error.message),
    );
    assert.equal(factories, 0);
  });

  it("closes a proxy that fails during initialize", async () => {
    const client = new RecordingClient(new Error("initialize failed"));

    await assert.rejects(
      startManagedAppServer({
        command: "codex",
        cwd: "/repo",
        process: new RecordingProcess(),
        ...callbacks,
        clientFactory: () => client,
      }),
      /initialize failed/,
    );

    assert.equal(client.initialized, 1);
    assert.equal(client.closed, 1);
  });

  it("bounds a silent proxy and names the one-time remote-control prerequisite", async () => {
    const client = new RecordingClient(new AppServerError(
      "app_server_request_timeout",
      "codex app-server request timed out: initialize",
    ));

    await assert.rejects(
      startManagedAppServer({
        command: "codex",
        cwd: "/repo",
        process: new RecordingProcess(),
        ...callbacks,
        clientFactory: () => client,
      }),
      (error: unknown) => error instanceof ManagedAppServerError
        && error.code === "app_server_daemon_unavailable"
        && /enable-remote-control/.test(error.message),
    );

    assert.deepEqual(client.initializeTimeouts, [10_000]);
    assert.equal(client.closed, 1);
  });
});
