import type { AppServerRequest } from "./app-server-protocol";
import {
  AppServerSession,
  AppServerSessionError,
  type AppServerConnection,
  type AppServerSessionOptions,
} from "./app-server-session";
import {
  CodexUnavailableError,
  type CodexTransport,
  type TurnDelivery,
  type TurnDispatch,
} from "./transport";

export interface AppServerTransportOptions extends AppServerSessionOptions {
  readonly timeoutMs?: number;
}

export class CodexTurnError extends Error {
  constructor(
    readonly code:
      | "codex_turn_failed"
      | "codex_turn_interrupted"
      | "codex_turn_timeout",
    message: string,
  ) {
    super(message);
    this.name = "CodexTurnError";
  }
}

/**
 * Shared owner of App Server sessions.
 *
 * It is also the reverse-request router: the App Server client receives one
 * approval/elicitation request and this host sends it to the session owning
 * that thread. The JSON-RPC id stays inside the client/session boundary.
 */
export class AppServerSessionHost {
  private readonly sessions = new Map<string, AppServerSession>();
  private readonly disconnectWaiters = new Set<{
    readonly reject: (error: Error) => void;
  }>();
  private disconnected: Error | null = null;

  constructor(private readonly connection: AppServerConnection) {
    connection.subscribeDisconnect?.(() => {
      const error = new CodexUnavailableError("app_server_disconnected");
      this.disconnected = error;
      for (const waiter of this.disconnectWaiters) waiter.reject(error);
      this.disconnectWaiters.clear();
      for (const session of this.sessions.values()) {
        session.dispose("codex app-server disconnected");
      }
    });
  }

  async open(
    threadId: string | null,
    options: AppServerSessionOptions,
  ): Promise<AppServerSession> {
    if (threadId !== null) {
      const existing = this.sessions.get(threadId);
      if (existing !== undefined) return existing;
    }
    const session = threadId === null
      ? await AppServerSession.start(this.connection, options)
      : await AppServerSession.resume(this.connection, threadId, options);
    const collision = this.sessions.get(session.threadId);
    if (collision !== undefined) {
      session.dispose();
      return collision;
    }
    this.sessions.set(session.threadId, session);
    return session;
  }

  session(threadId: string): AppServerSession | null {
    return this.sessions.get(threadId) ?? null;
  }

  handleServerRequest(request: AppServerRequest): Promise<unknown> {
    const threadId = typeof request.params.threadId === "string"
      ? request.params.threadId
      : "";
    const session = this.sessions.get(threadId);
    if (session === undefined) {
      return Promise.reject(new AppServerSessionError(
        "interaction_missing",
        `no open StagePass session owns thread ${threadId || "(missing)"}`,
      ));
    }
    return session.handleServerRequest(request);
  }

  close(threadId: string): void {
    this.sessions.get(threadId)?.dispose();
    this.sessions.delete(threadId);
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  subscribeDisconnect(reject: (error: Error) => void): () => void {
    if (this.disconnected !== null) {
      queueMicrotask(() => reject(this.disconnected!));
      return () => {};
    }
    const waiter = { reject };
    this.disconnectWaiters.add(waiter);
    return () => this.disconnectWaiters.delete(waiter);
  }
}

/** CodexTransport implementation backed exclusively by structured App Server RPC. */
export class AppServerCodexTransport implements CodexTransport {
  constructor(
    private readonly host: AppServerSessionHost,
    private readonly options: AppServerTransportOptions,
  ) {}

  async runTurn(dispatch: TurnDispatch): Promise<TurnDelivery> {
    const session = await this.host.open(dispatch.threadId, this.sessionOptions());
    dispatch.onThread?.(session.threadId);
    const turnId = await session.startTurn(dispatch.prompt);
    let outcome;
    try {
      let unsubscribe = (): void => {};
      const disconnected = new Promise<never>((_resolve, reject) => {
        unsubscribe = this.host.subscribeDisconnect(reject);
      });
      try {
        outcome = await Promise.race([
          session.awaitTurn(turnId, this.options.timeoutMs ?? 0),
          disconnected,
        ]);
      } finally {
        unsubscribe();
      }
    } catch (error) {
      if (error instanceof AppServerSessionError && error.code === "turn_timeout") {
        throw new CodexTurnError(
          "codex_turn_timeout",
          `codex turn ${turnId} did not finish before the deadline`,
        );
      }
      throw error;
    }
    if (outcome.status === "failed") {
      throw new CodexTurnError("codex_turn_failed", `codex turn ${turnId} failed`);
    }
    if (outcome.status === "interrupted") {
      throw new CodexTurnError(
        "codex_turn_interrupted",
        `codex turn ${turnId} was interrupted`,
      );
    }
    return { threadId: session.threadId, text: outcome.text };
  }

  private sessionOptions(): AppServerSessionOptions {
    const {
      timeoutMs: _timeoutMs,
      ...sessionOptions
    } = this.options;
    return sessionOptions;
  }
}
