import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

import {
  asRecord,
  isRpcId,
  parseJsonObject,
  type AppServerNotification,
  type AppServerRequest,
  type RpcId,
} from "./app-server-protocol";

const DEFAULT_CLOSE_GRACE_MS = 2_000;
const FORCE_KILL_GRACE_MS = 100;
const STDERR_TAIL_LIMIT = 1_000;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | null;
}

export interface AppServerExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface AppServerClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly onNotification: (message: AppServerNotification) => void;
  readonly onServerRequest: (message: AppServerRequest) => Promise<unknown>;
  readonly onStderr?: (message: string) => void;
}

export class AppServerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly rpcCode: number | null = null,
    readonly data?: unknown,
  ) {
    super(sanitizeAppServerMessage(message));
    this.name = "AppServerError";
  }
}

function sanitizeAppServerMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "unknown app-server error";
  return raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000) || "unknown app-server error";
}

function positiveGraceMs(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : DEFAULT_CLOSE_GRACE_MS;
}

/**
 * A supervised JSON-RPC client for `codex app-server --listen stdio://`.
 *
 * stdout is protocol-only JSONL. stderr is diagnostic-only and is sanitized
 * before it leaves this boundary.
 */
export class AppServerClient {
  static spawn(options: AppServerClientOptions): AppServerClient {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new AppServerClient(child, options);
  }

  readonly pid: number | null;

  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly notificationListeners = new Set<
    (message: AppServerNotification) => void
  >();
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private readonly exitPromise: Promise<AppServerExit>;
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private stderrTail = "";
  private exitFacts: AppServerExit | null = null;
  private closeStarted = false;
  private disconnectError: Error | null = null;
  private resolveExit!: (facts: AppServerExit) => void;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: AppServerClientOptions,
  ) {
    this.pid = child.pid ?? null;
    this.notificationListeners.add(options.onNotification);
    this.exitPromise = new Promise<AppServerExit>((resolve) => {
      this.resolveExit = resolve;
    });
    this.bindProcess();
  }

  async initialize(): Promise<Readonly<Record<string, unknown>>> {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "stagepass",
        title: "StagePass",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized");
    return asRecord(result);
  }

  request(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.exitFacts !== null) return Promise.reject(this.exitedError());
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
          this.rejectPending(id, new AppServerError(
            "app_server_request_timeout",
            `codex app-server request timed out: ${method}`,
          ));
        }, timeoutMs)
        : null;
      this.pending.set(id, { method, resolve, reject, timer });
      this.writeMessage({ id, method, params }, (error) => {
        if (error === null || error === undefined) return;
        this.rejectPending(id, new AppServerError(
          "app_server_disconnected",
          `failed to write codex app-server request: ${error.message}`,
        ));
      });
    });
  }

  notify(method: string, params: Readonly<Record<string, unknown>> = {}): void {
    if (this.exitFacts !== null) throw this.exitedError();
    this.writeMessage({ method, params });
  }

  subscribeNotifications(
    listener: (message: AppServerNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  subscribeDisconnect(listener: (error: Error) => void): () => void {
    if (this.disconnectError !== null) {
      queueMicrotask(() => listener(this.disconnectError!));
      return () => {};
    }
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  respond(id: RpcId, result: unknown): void {
    this.writeMessage({ id, result });
  }

  reject(id: RpcId, code: number, message: string): void {
    this.writeMessage({
      id,
      error: { code, message: sanitizeAppServerMessage(message) },
    });
  }

  async close(graceMs?: number): Promise<AppServerExit> {
    if (this.exitFacts !== null) return this.exitFacts;
    if (!this.closeStarted) {
      this.closeStarted = true;
      if (!this.child.stdin.destroyed) this.child.stdin.end();
      const grace = positiveGraceMs(graceMs);
      const terminateTimer = setTimeout(() => this.kill("SIGTERM"), grace);
      const forceTimer = setTimeout(
        () => this.kill("SIGKILL"),
        grace + FORCE_KILL_GRACE_MS,
      );
      void this.exitPromise.finally(() => {
        clearTimeout(terminateTimer);
        clearTimeout(forceTimer);
      });
    }
    return this.exitPromise;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.exitFacts === null) this.child.kill(signal);
  }

  private bindProcess(): void {
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    this.child.stdout.on("end", () => this.flushStdout());
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.consumeStderr(chunk));
    this.child.once("error", (error) => {
      const disconnected = new AppServerError(
        "app_server_disconnected",
        `codex app-server process error: ${error.message}`,
      );
      this.rejectAll(disconnected);
      this.reportDisconnect(disconnected);
    });
    this.child.once("close", (code, signal) => {
      this.flushStdout();
      const facts = { code, signal };
      this.exitFacts = facts;
      const disconnected = this.exitedError();
      this.rejectAll(disconnected);
      this.reportDisconnect(disconnected);
      this.resolveExit(facts);
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim() !== "") this.handleLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private flushStdout(): void {
    const line = this.stdoutBuffer.trim();
    this.stdoutBuffer = "";
    if (line !== "") this.handleLine(line);
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = parseJsonObject(line);
    } catch (error) {
      this.reportStderr(`invalid codex app-server JSON: ${
        error instanceof Error ? error.message : String(error)
      }`);
      return;
    }

    const id = message.id;
    const method = message.method;
    if (isRpcId(id) && typeof method === "string") {
      void this.handleServerRequest({
        id,
        method,
        params: asRecord(message.params),
      });
      return;
    }
    if (typeof method === "string") {
      const notification = {
        method,
        params: asRecord(message.params),
      };
      for (const listener of this.notificationListeners) listener(notification);
      return;
    }
    if (!isRpcId(id)) return;

    const pending = this.takePending(id);
    if (pending === null) return;
    const rpcError = asRecord(message.error);
    if (Object.keys(rpcError).length > 0) {
      pending.reject(new AppServerError(
        "app_server_request_failed",
        typeof rpcError.message === "string"
          ? rpcError.message
          : `codex app-server request failed: ${pending.method}`,
        typeof rpcError.code === "number" ? rpcError.code : null,
        rpcError.data,
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(message: AppServerRequest): Promise<void> {
    try {
      this.respond(message.id, await this.options.onServerRequest(message));
    } catch (error) {
      this.reject(message.id, -32_000, error instanceof Error
        ? error.message
        : String(error));
    }
  }

  private writeMessage(
    message: Readonly<Record<string, unknown>>,
    callback?: (error: Error | null | undefined) => void,
  ): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      callback?.(this.exitedError());
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, callback);
  }

  private consumeStderr(chunk: string): void {
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
    this.reportStderr(chunk);
  }

  private reportStderr(message: string): void {
    this.options.onStderr?.(sanitizeAppServerMessage(message));
  }

  private takePending(id: RpcId): PendingRequest | null {
    const pending = this.pending.get(id) ?? null;
    if (pending === null) return null;
    this.pending.delete(id);
    if (pending.timer !== null) clearTimeout(pending.timer);
    return pending;
  }

  private rejectPending(id: RpcId, error: Error): void {
    this.takePending(id)?.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.rejectPending(id, error);
  }

  private reportDisconnect(error: Error): void {
    if (this.disconnectError !== null) return;
    this.disconnectError = error;
    for (const listener of this.disconnectListeners) listener(error);
    this.disconnectListeners.clear();
  }

  private exitedError(): AppServerError {
    const suffix = this.exitFacts === null
      ? "before the request completed"
      : `code ${this.exitFacts.code ?? "null"}${
        this.exitFacts.signal === null ? "" : `, signal ${this.exitFacts.signal}`
      }`;
    const stderr = sanitizeAppServerMessage(this.stderrTail);
    return new AppServerError(
      "app_server_disconnected",
      `codex app-server exited ${suffix}${this.stderrTail === "" ? "" : `: ${stderr}`}`,
    );
  }
}
