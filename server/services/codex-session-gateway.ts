import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * The one sanctioned place that starts Codex turns over the app-server
 * protocol.
 *
 * ## Why this exists at all
 *
 * Until now a turn could only be started by asking Codex Desktop to start it
 * (`thread-follower-start-turn` over Desktop's private IPC socket), because a
 * turn started anywhere else was believed not to render StagePass's MCP App
 * cards -- and a phase the human cannot rule on is not a phase. That belief was
 * tested on 2026-07-28 and is false: a turn started over `codex app-server`
 * emits a native `mcpToolCall` item, and the card renders in Desktop when the
 * thread is opened. So the private socket is no longer the only way in.
 *
 * ## Why it is a single module rather than a helper
 *
 * `codex-standalone-boundary.test.ts` forbids the string `turn/start` in every
 * production source except this one. Starting turns is the sharpest capability
 * in the system -- it spends money, mutates a workspace, and is the thing
 * recovery has to reason about -- so it stays behind one door with one owner
 * rather than becoming a utility anyone can reach for.
 *
 * ## Why one long-lived connection
 *
 * Each `codex app-server` spawn re-reads config, restarts every configured MCP
 * server, and reloads plugins; measured at ~7s of startup before the first
 * token. Per-request spawning would pay that on every turn. One process is held
 * open and re-established on exit.
 */

/** Methods this gateway is allowed to send. Anything else is a bug, not a feature. */
const GATEWAY_METHODS = new Set([
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/list",
  "thread/read",
  "thread/name/set",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "model/list",
]);

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const CONNECT_GRACE_MS = 15_000;
const STDERR_TAIL_LIMIT = 500;

export type GatewayErrorCode =
  | "APP_SERVER_UNAVAILABLE"
  | "APP_SERVER_DISCONNECTED"
  | "REQUEST_TIMEOUT"
  | "METHOD_NOT_ALLOWED"
  | "THREAD_BUSY"
  | "PROTOCOL_ERROR";

export class CodexSessionGatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly detail?: unknown;

  constructor(code: GatewayErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "CodexSessionGatewayError";
    this.code = code;
    this.detail = detail;
  }
}

export interface TurnItem {
  type: string;
  [key: string]: unknown;
}

/**
 * What a caller learns while a turn runs.
 *
 * Deliberately not the raw notification stream: callers that render progress
 * need items and completion, and callers that only need the result should not
 * have to know the protocol's shape to ignore the rest.
 */
export interface TurnObserver {
  onItemStarted?: (threadId: string, item: TurnItem) => void;
  onItemCompleted?: (threadId: string, item: TurnItem) => void;
  /** Fires for sub-agent threads too -- check `threadId` before attributing. */
  onTurnCompleted?: (threadId: string, turn: Record<string, unknown>) => void;
  onTurnFailed?: (threadId: string, error: unknown) => void;
}

export interface TurnStartInput {
  threadId: string;
  prompt: string;
  cwd?: string;
  model?: string;
  effort?: string;
  approvalPolicy?: "never";
  sandboxMode?: "read-only" | "workspace-write";
  /**
   * A JSON Schema the runtime enforces on the final assistant message.
   *
   * Sent straight to app-server's TurnStartParams. Going direct settles a doubt
   * the Desktop follower path never could: that wrapper may whitelist fields
   * and drop this one silently, so callers there had to re-validate anyway.
   * Here the field reaches the runtime that enforces it.
   */
  outputSchema?: Record<string, unknown>;
}

export interface CodexSessionGatewayOptions {
  bin: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  /**
   * Answers server->client requests (approvals and elicitations). Returning a
   * rejection is a decision, not an error; throwing is an error.
   */
  onServerRequest?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  onStderr?: (chunk: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Mirrors the policy the Desktop follower path builds, so a turn does not
 * silently gain or lose filesystem reach by changing which door it came in.
 */
function sandboxPolicyFor(
  mode: "read-only" | "workspace-write",
  cwd: string | undefined,
): Record<string, unknown> {
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: cwd ? [cwd] : [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export class CodexSessionGateway {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly observers = new Set<TurnObserver>();
  private stderrTail = "";
  private connecting: Promise<void> | null = null;

  constructor(private readonly options: CodexSessionGatewayOptions) {}

  /** Idempotent: repeated calls while connecting await the same attempt. */
  async connect(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.spawnAndInitialize().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async spawnAndInitialize(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.bin, ["app-server", "--stdio"], {
        cwd: this.options.cwd,
        env: { ...process.env, TERM: "dumb", ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new CodexSessionGatewayError(
        "APP_SERVER_UNAVAILABLE",
        `could not spawn ${this.options.bin} app-server`,
        error,
      );
    }
    this.child = child;
    this.buffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.ingest(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      this.options.onStderr?.(chunk);
    });
    child.on("exit", (code, signal) => this.failAllPending(code, signal));

    await this.request(
      "initialize",
      {
        clientInfo: {
          name: "stagepass-session-gateway",
          title: "StagePass",
          version: "0.1.0",
        },
        capabilities: null,
      },
      CONNECT_GRACE_MS,
    );
    this.notify("initialized");
  }

  private failAllPending(code: number | null, signal: NodeJS.Signals | null) {
    this.child = null;
    const error = new CodexSessionGatewayError(
      "APP_SERVER_DISCONNECTED",
      `app-server exited (code=${code} signal=${signal}) ${this.stderrTail}`.trim(),
    );
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private ingest(chunk: string) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A non-JSON line is the server talking to a human, not to us.
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>) {
    const id = message.id;
    const method = message.method;

    // Server -> client request (approval / elicitation).
    if (typeof method === "string" && id !== undefined) {
      void this.answerServerRequest(id as number | string, method, asRecord(message.params));
      return;
    }
    // Notification.
    if (typeof method === "string") {
      this.handleNotification(method, asRecord(message.params));
      return;
    }
    // Response.
    if (typeof id === "number" && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new CodexSessionGatewayError(
            "PROTOCOL_ERROR",
            JSON.stringify(message.error),
            message.error,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private async answerServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ) {
    if (!this.options.onServerRequest) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "unhandled" } });
      return;
    }
    try {
      const result = await this.options.onServerRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: String(error) },
      });
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>) {
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const item = asRecord(params.item) as TurnItem;
    for (const observer of this.observers) {
      switch (method) {
        case "item/started":
          observer.onItemStarted?.(threadId, item);
          break;
        case "item/completed":
          observer.onItemCompleted?.(threadId, item);
          break;
        case "turn/completed":
          observer.onTurnCompleted?.(threadId, asRecord(params.turn));
          break;
        case "turn/failed":
          observer.onTurnFailed?.(threadId, params.error);
          break;
      }
    }
  }

  private write(message: unknown) {
    const child = this.child;
    if (!child || child.killed) {
      throw new CodexSessionGatewayError(
        "APP_SERVER_DISCONNECTED",
        "app-server connection is not open",
      );
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string, params: Record<string, unknown> = {}) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!GATEWAY_METHODS.has(method)) {
      return Promise.reject(
        new CodexSessionGatewayError(
          "METHOD_NOT_ALLOWED",
          `method outside the gateway boundary: ${method}`,
        ),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodexSessionGatewayError(
            "REQUEST_TIMEOUT",
            `app-server request timed out: ${method}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  observe(observer: TurnObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  // ---- public surface -----------------------------------------------------

  async listThreads(params: Record<string, unknown> = {}): Promise<unknown> {
    await this.connect();
    return this.request("thread/list", params);
  }

  async readThread(threadId: string, includeTurns = true): Promise<unknown> {
    await this.connect();
    return this.request("thread/read", { threadId, includeTurns });
  }

  async startThread(input: {
    cwd: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  }): Promise<string> {
    await this.connect();
    const result = asRecord(
      await this.request("thread/start", {
        cwd: input.cwd,
        sandbox: input.sandbox ?? "workspace-write",
      }),
    );
    const threadId = result.threadId ?? asRecord(result.thread).id ?? result.id;
    if (typeof threadId !== "string") {
      throw new CodexSessionGatewayError(
        "PROTOCOL_ERROR",
        "thread/start returned no thread id",
        result,
      );
    }
    return threadId;
  }

  async resumeThread(threadId: string): Promise<unknown> {
    await this.connect();
    return this.request("thread/resume", { threadId });
  }

  /**
   * Starts a turn and returns as soon as the runtime accepts it.
   *
   * Separate from `runTurn` because the Desktop follower contract this replaces
   * is start-and-return: the pipeline records the turn id, then learns the
   * outcome from its own journal rather than from a held-open promise, so a
   * server restart mid-turn is recoverable.
   */
  async startTurn(input: TurnStartInput): Promise<{ turnId?: string }> {
    await this.connect();
    const result = asRecord(
      await this.request("turn/start", {
        threadId: input.threadId,
        input: [{ type: "text", text: input.prompt }],
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.approvalPolicy
          ? { approvalPolicy: input.approvalPolicy }
          : {}),
        ...(input.sandboxMode
          ? { sandboxPolicy: sandboxPolicyFor(input.sandboxMode, input.cwd) }
          : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      }),
    );
    const turn = asRecord(result.turn);
    return { turnId: typeof turn.id === "string" ? turn.id : undefined };
  }

  /**
   * Starts a turn and resolves when the ROOT thread completes.
   *
   * Sub-agent turns stream over the same connection with their own thread ids,
   * so an unqualified `turn/completed` is usually a sub-agent finishing rather
   * than the root -- resolving on it would cut delegation off mid-round.
   */
  async runTurn(input: TurnStartInput & {
    observer?: TurnObserver;
  }): Promise<{
    status: "completed" | "failed";
    turnId?: string;
    turn: Record<string, unknown>;
  }> {
    await this.connect();
    const { threadId } = input;
    let startedTurnId: string | undefined;

    return new Promise((resolve, reject) => {
      const detach = this.observe({
        onItemStarted: (id, item) => input.observer?.onItemStarted?.(id, item),
        onItemCompleted: (id, item) => input.observer?.onItemCompleted?.(id, item),
        onTurnCompleted: (id, turn) => {
          input.observer?.onTurnCompleted?.(id, turn);
          if (id !== threadId) return;
          detach();
          resolve({ status: "completed", turnId: startedTurnId, turn });
        },
        onTurnFailed: (id, error) => {
          input.observer?.onTurnFailed?.(id, error);
          if (id !== threadId) return;
          detach();
          resolve({
            status: "failed",
            turnId: startedTurnId,
            turn: asRecord(error),
          });
        },
      });

      // The observer is attached above, before the request goes out, so a turn
      // that finishes quickly cannot complete in the gap.
      this.startTurn(input)
        .then(({ turnId }) => {
          startedTurnId = turnId;
        })
        .catch((error) => {
          detach();
          reject(error);
        });
    });
  }

  /** Appends an instruction to a turn already in flight. */
  async steerTurn(threadId: string, prompt: string): Promise<unknown> {
    await this.connect();
    return this.request("turn/steer", {
      threadId,
      input: [{ type: "text", text: prompt }],
    });
  }

  async interruptTurn(threadId: string): Promise<unknown> {
    await this.connect();
    return this.request("turn/interrupt", { threadId });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    this.child = null;
  }

  get isConnected(): boolean {
    return Boolean(this.child && !this.child.killed);
  }
}

/** The deep link that puts Codex Desktop on a thread this gateway created. */
export function codexThreadDeepLink(threadId: string): `codex://threads/${string}` {
  if (!/^[A-Za-z0-9-]+$/.test(threadId)) {
    throw new CodexSessionGatewayError(
      "PROTOCOL_ERROR",
      "refusing to build a deep link from a malformed thread id",
    );
  }
  return `codex://threads/${threadId}`;
}
