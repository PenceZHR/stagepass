import type Database from "better-sqlite3";

import type { AppServerSession, AppServerSessionOptions } from "../codex/app-server-session";
import type { AppServerSessionHost } from "../codex/app-server-transport";
import type { StreamEvent, StreamSnapshot } from "../codex/stream-state";
import { isPhase, type Phase } from "../domain/phase";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";

export const STREAM_ASIDE = "aside" as const;
export type StreamSeat = Phase | typeof STREAM_ASIDE;

export interface StreamSessionsOptions {
  readonly database: Database.Database;
  readonly host: AppServerSessionHost;
  readonly sandbox: string;
  readonly approvalPolicy: string | Readonly<Record<string, unknown>>;
  readonly effort: string;
  readonly model?: string;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

export interface StreamOpenOptions {
  readonly threadId?: string | null;
  readonly config?: Readonly<Record<string, unknown>>;
}

export class StreamSessionError extends Error {
  constructor(
    readonly code:
      | "invalid_seat"
      | "no_such_change"
      | "project_path_missing"
      | "session_not_open",
    message: string,
  ) {
    super(message);
    this.name = "StreamSessionError";
  }
}

export function isStreamSeat(value: string): value is StreamSeat {
  return value === STREAM_ASIDE || (isPhase(value) && value !== "Done");
}

/** One structured App Server session per durable StagePass (Change, seat). */
export class StreamSessions {
  private readonly sessions = new Map<string, AppServerSession>();
  private readonly opening = new Map<string, Promise<AppServerSession>>();
  private readonly lastActivityAt = new Map<string, number>();
  private readonly unsubscribeActivity = new Map<string, () => void>();

  constructor(private readonly options: StreamSessionsOptions) {}

  open(
    changeId: string,
    seat: StreamSeat,
    openOptions: StreamOpenOptions = {},
  ): Promise<AppServerSession> {
    const key = StreamSessions.key(changeId, seat);
    const current = this.sessions.get(key);
    if (current !== undefined) return Promise.resolve(current);
    const pending = this.opening.get(key);
    if (pending !== undefined) return pending;
    const opening = this.openOnce(changeId, seat, openOptions)
      .then((session) => {
        this.sessions.set(key, session);
        return session;
      })
      .finally(() => this.opening.delete(key));
    this.opening.set(key, opening);
    return opening;
  }

  snapshot(changeId: string, seat: StreamSeat): StreamSnapshot {
    return this.require(changeId, seat).snapshot();
  }

  has(changeId: string, seat: StreamSeat): boolean {
    return this.sessions.has(StreamSessions.key(changeId, seat));
  }

  active(changeId: string, seat: StreamSeat): boolean {
    const session = this.sessions.get(StreamSessions.key(changeId, seat));
    return session !== undefined && session.snapshot().activeTurnId !== null;
  }

  /** Milliseconds since the last typed App Server event for an open seat. */
  quietForMs(changeId: string, seat: StreamSeat): number | null {
    const at = this.lastActivityAt.get(StreamSessions.key(changeId, seat));
    return at === undefined ? null : Math.max(0, this.now() - at);
  }

  eventsAfter(
    changeId: string,
    seat: StreamSeat,
    seq: number,
  ): readonly StreamEvent[] | null {
    return this.require(changeId, seat).eventsAfter(seq);
  }

  subscribe(
    changeId: string,
    seat: StreamSeat,
    listener: (event: StreamEvent) => void,
  ): () => void {
    return this.require(changeId, seat).subscribe(listener);
  }

  startTurn(changeId: string, seat: StreamSeat, prompt: string): Promise<string> {
    return this.require(changeId, seat).startTurn(prompt);
  }

  steer(
    changeId: string,
    seat: StreamSeat,
    direction: string,
    expectedTurnId: string,
  ): Promise<void> {
    return this.require(changeId, seat).steer(direction, expectedTurnId);
  }

  interrupt(changeId: string, seat: StreamSeat, turnId: string): Promise<void> {
    return this.require(changeId, seat).interrupt(turnId);
  }

  respond(
    changeId: string,
    seat: StreamSeat,
    interactionId: string,
    response: unknown,
  ): Promise<void> {
    return this.require(changeId, seat).respond(interactionId, response);
  }

  close(changeId: string, seat: StreamSeat): void {
    const key = StreamSessions.key(changeId, seat);
    const session = this.sessions.get(key);
    if (session !== undefined) this.options.host.close(session.threadId);
    this.unsubscribeActivity.get(key)?.();
    this.unsubscribeActivity.delete(key);
    this.lastActivityAt.delete(key);
    this.sessions.delete(key);
  }

  forget(changeId: string): void {
    const prefix = `${changeId}\0`;
    for (const [key, session] of this.sessions) {
      if (!key.startsWith(prefix)) continue;
      this.options.host.close(session.threadId);
      this.unsubscribeActivity.get(key)?.();
      this.unsubscribeActivity.delete(key);
      this.lastActivityAt.delete(key);
      this.sessions.delete(key);
    }
  }

  closeAll(): void {
    for (const unsubscribe of this.unsubscribeActivity.values()) unsubscribe();
    this.sessions.clear();
    this.opening.clear();
    this.unsubscribeActivity.clear();
    this.lastActivityAt.clear();
    this.options.host.closeAll();
  }

  private async openOnce(
    changeId: string,
    seat: StreamSeat,
    openOptions: StreamOpenOptions,
  ): Promise<AppServerSession> {
    const cwd = this.workspaceFor(changeId);
    const session = await this.options.host.open(
      openOptions.threadId ?? null,
      this.sessionOptions(cwd, openOptions.config),
    );
    const key = StreamSessions.key(changeId, seat);
    this.lastActivityAt.set(key, this.now());
    this.unsubscribeActivity.set(key, session.subscribe(() => {
      this.lastActivityAt.set(key, this.now());
    }));
    return session;
  }

  private workspaceFor(changeId: string): string {
    let projectId: string | null;
    try {
      projectId = new ChangeStore(this.options.database).read(changeId).projectId;
    } catch {
      throw new StreamSessionError("no_such_change", `no Change ${changeId}`);
    }
    if (projectId === null) {
      throw new StreamSessionError(
        "project_path_missing",
        `Change ${changeId} belongs to no project`,
      );
    }
    let path: string | null;
    try {
      path = new ProjectStore(this.options.database).read(projectId).path;
    } catch {
      path = null;
    }
    if (path === null) {
      throw new StreamSessionError(
        "project_path_missing",
        `Change ${changeId} has no project path`,
      );
    }
    return path;
  }

  private sessionOptions(
    cwd: string,
    config: Readonly<Record<string, unknown>> | undefined,
  ): AppServerSessionOptions {
    return {
      cwd,
      sandbox: this.options.sandbox,
      approvalPolicy: this.options.approvalPolicy,
      effort: this.options.effort,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...(this.options.requestTimeoutMs === undefined
        ? {} : { requestTimeoutMs: this.options.requestTimeoutMs }),
      ...(config === undefined ? {} : { config }),
    };
  }

  private require(changeId: string, seat: StreamSeat): AppServerSession {
    const session = this.sessions.get(StreamSessions.key(changeId, seat));
    if (session === undefined) {
      throw new StreamSessionError(
        "session_not_open",
        `no open App Server session for ${changeId}/${seat}`,
      );
    }
    return session;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private static key(changeId: string, seat: StreamSeat): string {
    return `${changeId}\0${seat}`;
  }
}
