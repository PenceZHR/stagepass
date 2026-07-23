import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

const DEFAULT_CLOSE_GRACE_MS = 2_000;
const FORCE_KILL_GRACE_MS = 250;
const STDERR_TAIL_LIMIT = 500;

type RpcId = number | string;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ExitFacts {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface AppServerClientOptions {
  bin: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onNotification: (method: string, params: Record<string, unknown>) => void;
  onServerRequest: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  onStderr?: (chunk: string) => void;
}

export class CodexAppServerError extends Error {
  readonly code: number | null;
  readonly data?: unknown;

  constructor(message: string, code: number | null = null, data?: unknown) {
    super(sanitizeAppServerMessage(message));
    this.name = "CodexAppServerError";
    this.code = code;
    this.data = data;
  }
}

function sanitizeAppServerMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown provider error";
  return (
    raw
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500) || "unknown provider error"
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function positiveGraceMs(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : DEFAULT_CLOSE_GRACE_MS;
}

export class CodexAppServerClient {
  static spawn(options: AppServerClientOptions): CodexAppServerClient {
    const child = spawn(options.bin, ["app-server"], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new CodexAppServerClient(child, options);
  }

  readonly pid: number | null;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly options: AppServerClientOptions;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly exitPromise: Promise<ExitFacts>;
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private stderrTail = "";
  private exitFacts: ExitFacts | null = null;
  private closeStarted = false;
  private resolveExit!: (facts: ExitFacts) => void;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    options: AppServerClientOptions,
  ) {
    this.child = child;
    this.options = options;
    this.pid = child.pid ?? null;
    this.exitPromise = new Promise<ExitFacts>((resolve) => {
      this.resolveExit = resolve;
    });
    this.bindProcess();
  }

  async initialize(
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "stagepass",
        version: "0.1.0",
      },
      ...params,
    });
    this.notify("initialized");
    return asRecord(result);
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.exitFacts) {
      return Promise.reject(this.exitedError());
    }
    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        typeof timeoutMs === "number" && timeoutMs > 0
          ? setTimeout(() => {
            this.rejectPending(
              id,
              new CodexAppServerError(
                `codex app-server request timed out: ${method}`,
              ),
            );
          }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage({ id, method, params }, (error) => {
        if (error) {
          this.rejectPending(
            id,
            new CodexAppServerError(
              `failed to write codex app-server request: ${error.message}`,
            ),
          );
        }
      });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.exitFacts) throw this.exitedError();
    this.writeMessage({ method, params });
  }

  async close(graceMs?: number): Promise<ExitFacts> {
    if (this.exitFacts) return this.exitFacts;
    if (!this.closeStarted) {
      this.closeStarted = true;
      if (!this.child.stdin.destroyed) this.child.stdin.end();
      const grace = positiveGraceMs(graceMs);
      const terminateTimer = setTimeout(() => this.kill("SIGTERM"), grace);
      const forceTimer = setTimeout(
        () => this.kill("SIGKILL"),
        grace + FORCE_KILL_GRACE_MS,
      );
      this.exitPromise.finally(() => {
        clearTimeout(terminateTimer);
        clearTimeout(forceTimer);
      }).catch(() => {});
    }
    return this.exitPromise;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.exitFacts) return;
    this.child.kill(signal);
  }

  private bindProcess(): void {
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    this.child.stdout.on("end", () => this.flushStdout());
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.consumeStderr(chunk));
    this.child.once("error", (error) => {
      this.rejectAll(
        new CodexAppServerError(
          `codex app-server process error: ${error.message}`,
        ),
      );
    });
    this.child.once("close", (code, signal) => {
      this.flushStdout();
      const facts = { code, signal };
      this.exitFacts = facts;
      this.rejectAll(this.exitedError());
      this.resolveExit(facts);
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim()) this.handleLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private flushStdout(): void {
    const line = this.stdoutBuffer.trim();
    this.stdoutBuffer = "";
    if (line) this.handleLine(line);
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      this.reportStderr(`invalid codex app-server JSON: ${line}`);
      return;
    }

    const id = message.id;
    const method = message.method;
    if ((typeof id === "number" || typeof id === "string") && typeof method === "string") {
      void this.handleServerRequest(id, method, asRecord(message.params));
      return;
    }
    if (typeof method === "string") {
      this.options.onNotification(method, asRecord(message.params));
      return;
    }
    if (typeof id !== "number" && typeof id !== "string") return;

    const pending = this.takePending(id);
    if (!pending) return;
    const rpcError = asRecord(message.error);
    if (Object.keys(rpcError).length > 0) {
      const code = typeof rpcError.code === "number" ? rpcError.code : null;
      const text =
        typeof rpcError.message === "string"
          ? rpcError.message
          : "codex app-server request failed";
      pending.reject(new CodexAppServerError(text, code, rpcError.data));
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(
    id: RpcId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      const result = await this.options.onServerRequest(method, params);
      this.writeMessage({ id, result });
    } catch (error) {
      this.writeMessage({
        id,
        error: {
          code: -32000,
          message: sanitizeAppServerMessage(error),
        },
      });
    }
  }

  private writeMessage(
    message: Record<string, unknown>,
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
    if (!pending) return null;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    return pending;
  }

  private rejectPending(id: RpcId, error: Error): void {
    this.takePending(id)?.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const id of this.pending.keys()) this.rejectPending(id, error);
  }

  private exitedError(): CodexAppServerError {
    const suffix = this.exitFacts
      ? `code ${this.exitFacts.code ?? "null"}`
        + `${this.exitFacts.signal ? `, signal ${this.exitFacts.signal}` : ""}`
      : "before the request completed";
    const stderr = sanitizeAppServerMessage(this.stderrTail);
    return new CodexAppServerError(
      `codex app-server exited ${suffix}${this.stderrTail ? `: ${stderr}` : ""}`,
    );
  }
}
