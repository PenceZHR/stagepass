import {
  AppServerClient,
  AppServerError,
  type AppServerClientOptions,
  type AppServerExit,
} from "./app-server-client";
import type { AppServerConnection } from "./app-server-session";
import {
  createProcessOps,
  type ProcessOps,
} from "../system/process";

export interface AppServerControlClient extends AppServerConnection {
  initialize(timeoutMs?: number): Promise<Readonly<Record<string, unknown>>>;
  close(graceMs?: number): Promise<AppServerExit>;
}

const MANAGED_PROXY_INITIALIZE_TIMEOUT_MS = 10_000;

export interface ManagedAppServer {
  readonly client: AppServerControlClient;
  close(): Promise<void>;
}

interface ManagedAppServerOptions extends Pick<
  AppServerClientOptions,
  "command" | "cwd" | "env" | "onNotification" | "onServerRequest" | "onStderr"
> {
  readonly process?: ProcessOps;
  readonly clientFactory?: (options: AppServerClientOptions) => AppServerControlClient;
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

/** Start the durable Codex daemon and attach StagePass through its stdio proxy. */
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

  // App Server documents stdio as JSONL and Unix sockets as remote TUI endpoints.
  // Source: https://developers.openai.com/codex/app-server#protocol
  const client = (options.clientFactory ?? AppServerClient.spawn)({
    command: options.command,
    args: ["app-server", "proxy"],
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    onNotification: options.onNotification,
    onServerRequest: options.onServerRequest,
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
    process,
  });
  try {
    await client.initialize(MANAGED_PROXY_INITIALIZE_TIMEOUT_MS);
  } catch (error) {
    try { await client.close(1_000); } catch { /* preserve initialize failure */ }
    if (
      error instanceof AppServerError
      && error.code === "app_server_request_timeout"
    ) {
      throw new ManagedAppServerError(
        "app_server_daemon_unavailable",
        "Codex managed proxy did not answer initialize; run "
        + "`codex app-server daemon enable-remote-control` once, then restart StagePass",
      );
    }
    throw error;
  }
  return {
    client,
    close: async () => { await client.close(1_000); },
  };
}
