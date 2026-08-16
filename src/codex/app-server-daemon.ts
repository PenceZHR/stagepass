import {
  AppServerError,
  type AppServerClientOptions,
  type AppServerExit,
} from "./app-server-client";
import {
  connectUnixAppServer,
  type UnixAppServerOptions,
} from "./app-server-websocket";
import type { AppServerConnection } from "./app-server-session";
import {
  createProcessOps,
  type ProcessOps,
} from "../system/process";

export interface AppServerControlClient extends AppServerConnection {
  initialize(timeoutMs?: number): Promise<Readonly<Record<string, unknown>>>;
  close(graceMs?: number): Promise<AppServerExit>;
}

const MANAGED_WEBSOCKET_INITIALIZE_TIMEOUT_MS = 10_000;

export interface ManagedAppServer {
  readonly client: AppServerControlClient;
  close(): Promise<void>;
}

interface ManagedAppServerOptions extends Pick<
  AppServerClientOptions,
  "command" | "cwd" | "env" | "onNotification" | "onServerRequest" | "onStderr"
> {
  readonly process?: ProcessOps;
  readonly clientFactory?: (
    options: UnixAppServerOptions,
  ) => AppServerControlClient | Promise<AppServerControlClient>;
}

export class ManagedAppServerError extends Error {
  constructor(
    readonly code: "app_server_daemon_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ManagedAppServerError";
  }
}

function publicDetail(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function managedSocketPath(stdout: string): string {
  try {
    const status = JSON.parse(stdout.trim()) as { socketPath?: unknown };
    if (typeof status.socketPath === "string" && status.socketPath.startsWith("/")) {
      return status.socketPath;
    }
  } catch { /* mapped to the stable startup error below */ }
  throw new ManagedAppServerError(
    "app_server_daemon_unavailable",
    "Codex managed daemon did not report an absolute socketPath",
  );
}

/** Start the durable Codex daemon and attach StagePass to its WebSocket socket. */
export async function startManagedAppServer(
  options: ManagedAppServerOptions,
): Promise<ManagedAppServer> {
  const process = options.process ?? createProcessOps();
  const started = await process.run({
    command: options.command,
    args: ["app-server", "daemon", "start"],
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  if (started.code !== 0) {
    const detail = publicDetail(started.stderr || started.stdout);
    throw new ManagedAppServerError(
      "app_server_daemon_unavailable",
      `could not start Codex managed app-server daemon${
        detail === "" ? "" : `: ${detail}`
      }`,
    );
  }

  const client = await (options.clientFactory ?? connectUnixAppServer)({
    socketPath: managedSocketPath(started.stdout),
    onNotification: options.onNotification,
    onServerRequest: options.onServerRequest,
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
  });
  try {
    await client.initialize(MANAGED_WEBSOCKET_INITIALIZE_TIMEOUT_MS);
  } catch (error) {
    try { await client.close(1_000); } catch { /* preserve initialize failure */ }
    if (
      error instanceof AppServerError
      && error.code === "app_server_request_timeout"
    ) {
      throw new ManagedAppServerError(
        "app_server_daemon_unavailable",
        "Codex managed daemon WebSocket did not answer initialize",
      );
    }
    throw error;
  }
  return {
    client,
    close: async () => { await client.close(1_000); },
  };
}
