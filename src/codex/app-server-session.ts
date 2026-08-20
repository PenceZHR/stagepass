import {
  asRecord,
  type AppServerNotification,
  type AppServerRequest,
  type RpcId,
} from "./app-server-protocol";
import {
  StreamState,
  type InteractionKind,
  type StreamEvent,
  type StreamSnapshot,
  type StreamTurnStatus,
} from "./stream-state";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface AppServerConnection {
  request(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<unknown>;
  subscribeNotifications(
    listener: (message: AppServerNotification) => void,
  ): () => void;
  subscribeDisconnect?(listener: (error: Error) => void): () => void;
}

/**
 * `thread/start` 的 `threadSource` —— **决定这条线程进不进 Codex App 的项目分类**。
 *
 * 2026-08-18 真机实测：不传这个字段，线程落库时 `thread_source = null`，App 里
 * **只出现在 Recents**，项目分类下看不到；传 `"user"` 就和 App 自己开的会话一样。
 * 用户目视确认过两次（先没有、补上之后就有了）。
 *
 * 这个差异**在 API 层看不出来** —— 两条线程的 `thread/read` 返回完全相同，一个字节
 * 都不差，只有 `~/.codex/state_5.sqlite` 的 `threads.thread_source` 列不一样。
 *
 * 另外别和 `source` 字段混：`ThreadSourceKind`（`cli|vscode|exec|appServer|subAgent…`）
 * 是 `source` 的枚举；`thread_source` 是另一回事，实际取值只有 `user` / `subagent` /
 * `null`，schema 里的类型就是个裸 string（说明还写成 "analytics source classification"，
 * 光看描述完全想不到它管分类）。
 */
const THREAD_SOURCE = "user";

export interface AppServerSessionOptions {
  readonly cwd: string;
  readonly sandbox: string;
  readonly approvalPolicy: string | Readonly<Record<string, unknown>>;
  readonly effort: string;
  readonly model?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly requestTimeoutMs?: number;
}

export interface CompletedTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: Exclude<StreamTurnStatus, "inProgress">;
  readonly text: string;
}

interface PendingInteraction {
  readonly rpcId: RpcId;
  readonly resolve: (response: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class AppServerSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppServerSessionError";
  }
}

function requiredId(value: unknown, context: string): string {
  const id = typeof value === "string" ? value : "";
  if (id === "") {
    throw new AppServerSessionError(
      "app_server_protocol_error",
      `codex app-server ${context} response has no id`,
    );
  }
  return id;
}

function input(text: string): readonly Readonly<Record<string, unknown>>[] {
  return [{ type: "text", text, text_elements: [] }];
}

function interactionKind(method: string): InteractionKind | null {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "commandApproval";
    case "item/fileChange/requestApproval":
      return "fileChangeApproval";
    case "item/permissions/requestApproval":
      return "permissionsApproval";
    case "mcpServer/elicitation/request":
      return "mcpElicitation";
    case "item/tool/requestUserInput":
      return "toolUserInput";
    default:
      return null;
  }
}

function isTerminal(
  status: StreamTurnStatus | null,
): status is Exclude<StreamTurnStatus, "inProgress"> {
  return status === "completed" || status === "failed" || status === "interrupted";
}

/** Owns one Codex thread's turn lifecycle and human interaction boundary. */
export class AppServerSession {
  static async start(
    connection: AppServerConnection,
    options: AppServerSessionOptions,
  ): Promise<AppServerSession> {
    const result = asRecord(await connection.request(
      "thread/start",
      AppServerSession.threadParams(options, { ephemeral: false }),
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ));
    return AppServerSession.fromThreadResult(connection, result, options, "thread/start");
  }

  static async resume(
    connection: AppServerConnection,
    threadId: string,
    options: AppServerSessionOptions,
  ): Promise<AppServerSession> {
    const result = asRecord(await connection.request(
      "thread/resume",
      AppServerSession.threadParams(options, { threadId }),
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ));
    const session = AppServerSession.fromThreadResult(
      connection,
      result,
      options,
      "thread/resume",
    );
    if (session.threadId !== threadId) {
      session.dispose();
      throw new AppServerSessionError(
        "app_server_protocol_error",
        "codex app-server resumed a different thread",
      );
    }
    return session;
  }

  readonly state: StreamState;
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly pendingWaits = new Set<(error: Error) => void>();
  private readonly unsubscribeNotifications: () => void;
  private disposedError: AppServerSessionError | null = null;

  private constructor(
    private readonly connection: AppServerConnection,
    readonly threadId: string,
    private readonly options: AppServerSessionOptions,
    turns: readonly unknown[],
  ) {
    this.state = new StreamState(threadId);
    this.state.hydrate(turns);
    this.unsubscribeNotifications = connection.subscribeNotifications((message) => {
      this.state.accept(message);
    });
  }

  snapshot(): StreamSnapshot {
    return this.state.snapshot();
  }

  eventsAfter(seq: number): readonly StreamEvent[] | null {
    return this.state.eventsAfter(seq);
  }

  subscribe(listener: (event: StreamEvent) => void): () => void {
    return this.state.subscribe(listener);
  }

  async startTurn(prompt: string): Promise<string> {
    if (prompt.trim() === "") {
      throw new AppServerSessionError("invalid_prompt", "turn prompt cannot be empty");
    }
    if (this.state.snapshot().activeTurnId !== null) {
      throw new AppServerSessionError("turn_busy", "this thread already has an active turn");
    }
    const result = asRecord(await this.connection.request("turn/start", {
      threadId: this.threadId,
      input: input(prompt),
      cwd: this.options.cwd,
      approvalPolicy: this.options.approvalPolicy,
      effort: this.options.effort,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
    }, this.requestTimeoutMs()));
    const turn = asRecord(result.turn);
    const turnId = requiredId(turn.id, "turn/start");
    this.state.noteTurnStarted(turn);
    return turnId;
  }

  async steer(direction: string, expectedTurnId: string): Promise<void> {
    this.assertCurrentTurn(expectedTurnId);
    if (direction.trim() === "") {
      throw new AppServerSessionError("invalid_prompt", "steer direction cannot be empty");
    }
    await this.connection.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId,
      input: input(direction),
    }, this.requestTimeoutMs());
  }

  async interrupt(turnId: string): Promise<void> {
    this.assertCurrentTurn(turnId);
    await this.connection.request("turn/interrupt", {
      threadId: this.threadId,
      turnId,
    }, this.requestTimeoutMs());
  }

  awaitTurn(turnId: string, timeoutMs = 0): Promise<CompletedTurn> {
    if (this.disposedError !== null) return Promise.reject(this.disposedError);
    const ready = this.completedTurn(turnId);
    if (ready !== null) return Promise.resolve(ready);
    return new Promise<CompletedTurn>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        unsubscribe();
        this.pendingWaits.delete(fail);
        if (timer !== null) clearTimeout(timer);
      };
      const fail = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const unsubscribe = this.state.subscribe((event) => {
        if (event.kind !== "turn.completed" || event.turnId !== turnId) return;
        const completed = this.completedTurn(turnId);
        if (completed === null) return;
        cleanup();
        resolve(completed);
      });
      this.pendingWaits.add(fail);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          fail(new AppServerSessionError(
            "turn_timeout",
            `timed out waiting for turn ${turnId}`,
          ));
        }, timeoutMs);
      }
    });
  }

  awaitNextTurn(afterTurnId: string | null, timeoutMs: number): Promise<string> {
    if (this.disposedError !== null) return Promise.reject(this.disposedError);
    const current = this.state.snapshot().lastTurnId;
    if (current !== null && current !== afterTurnId) return Promise.resolve(current);

    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        unsubscribe();
        this.pendingWaits.delete(fail);
        if (timer !== null) clearTimeout(timer);
      };
      const fail = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const unsubscribe = this.state.subscribe((event) => {
        if (
          event.kind !== "turn.started"
          || event.turnId === undefined
          || event.turnId === afterTurnId
        ) return;
        cleanup();
        resolve(event.turnId);
      });
      this.pendingWaits.add(fail);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          fail(new AppServerSessionError(
            "turn_start_timeout",
            "timed out waiting for the native Codex client to start a turn",
          ));
        }, timeoutMs);
      }
    });
  }

  handleServerRequest(request: AppServerRequest): Promise<unknown> {
    if (request.params.threadId !== this.threadId) {
      return Promise.reject(new AppServerSessionError(
        "interaction_missing",
        "server interaction does not belong to this thread",
      ));
    }
    const kind = interactionKind(request.method);
    if (kind === null) {
      return Promise.reject(new AppServerSessionError(
        "unsupported_interaction",
        `unsupported codex app-server request: ${request.method}`,
      ));
    }
    const interaction = this.state.openInteraction({
      kind,
      method: request.method,
      params: request.params,
    });
    return new Promise<unknown>((resolve, reject) => {
      this.pendingInteractions.set(interaction.id, {
        rpcId: request.id,
        resolve,
        reject,
      });
    });
  }

  async respond(interactionId: string, response: unknown): Promise<void> {
    const pending = this.pendingInteractions.get(interactionId);
    if (pending === undefined) {
      const known = this.snapshot().interactions.find(({ id }) => id === interactionId);
      throw new AppServerSessionError(
        known?.status === "resolved"
          ? "interaction_already_resolved"
          : "interaction_missing",
        `interaction ${interactionId} is not pending`,
      );
    }
    this.pendingInteractions.delete(interactionId);
    this.state.resolveInteraction(interactionId);
    pending.resolve(response);
  }

  dispose(reason = "app-server session closed"): void {
    if (this.disposedError !== null) return;
    this.disposedError = new AppServerSessionError("app_server_disconnected", reason);
    this.unsubscribeNotifications();
    for (const fail of [...this.pendingWaits]) fail(this.disposedError);
    this.pendingWaits.clear();
    for (const pending of this.pendingInteractions.values()) {
      pending.reject(this.disposedError);
    }
    this.pendingInteractions.clear();
  }

  private static fromThreadResult(
    connection: AppServerConnection,
    result: Readonly<Record<string, unknown>>,
    options: AppServerSessionOptions,
    context: string,
  ): AppServerSession {
    const thread = asRecord(result.thread);
    const threadId = requiredId(thread.id, context);
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    return new AppServerSession(connection, threadId, options, turns);
  }

  private static threadParams(
    options: AppServerSessionOptions,
    identity: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    return {
      ...identity,
      cwd: options.cwd,
      sandbox: options.sandbox,
      approvalPolicy: options.approvalPolicy,
      threadSource: THREAD_SOURCE,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.config === undefined ? {} : { config: options.config }),
    };
  }

  private requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private assertCurrentTurn(expectedTurnId: string): void {
    const active = this.state.snapshot().activeTurnId;
    if (active === null) {
      throw new AppServerSessionError("no_active_turn", "this thread has no active turn");
    }
    if (active !== expectedTurnId) {
      throw new AppServerSessionError(
        "stale_turn",
        `active turn changed from ${expectedTurnId} to ${active}`,
      );
    }
  }

  private completedTurn(turnId: string): CompletedTurn | null {
    const status = this.state.statusOf(turnId);
    if (!isTerminal(status)) return null;
    const messages = this.state.itemsForTurn(turnId)
      .filter((item) => item.kind === "agentMessage" && item.text !== "");
    return {
      threadId: this.threadId,
      turnId,
      status,
      text: messages.at(-1)?.text ?? "",
    };
  }
}
