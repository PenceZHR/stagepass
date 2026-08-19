import type { AppServerRequest } from "./app-server-protocol";
import {
  AppServerSession,
  AppServerSessionError,
  type AppServerConnection,
  type AppServerSessionOptions,
} from "./app-server-session";
import {
  CodexUnavailableError,
} from "./transport";

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

  /**
   * 把这条线程还给人。
   *
   * 2026-08-18 实测（`docs/DESIGN-thread-ownership-2026-08-18.md` §11）：Codex App 说
   * 「This is open in another app」看的是**订阅**，而**关掉连接不等于退订** ——
   * 两条只差一次显式 `thread/unsubscribe` 的线程，一条打得开、一条打不开。
   *
   * 退订之后这条连接收不到它的事件了，这是**故意的**：流让出去，人才进得来。
   */
  async unsubscribe(threadId: string): Promise<void> {
    await this.connection.request("thread/unsubscribe", { threadId });
    this.sessions.delete(threadId);
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
