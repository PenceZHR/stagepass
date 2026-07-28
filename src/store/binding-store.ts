import type Database from "better-sqlite3";

/**
 * One Change, one persistent Codex thread.
 *
 * ## Why binding is StagePass's record rather than a lookup
 *
 * The thread is where the whole Change's context lives. If StagePass could not
 * say which thread belongs to a Change, every phase would start a fresh
 * conversation that knows nothing about the previous ones -- and the human
 * would watch their work scatter across a dozen tasks. So the mapping is
 * durable, unique in both directions while bound, and survives a restart.
 *
 * ## Detaching is explicit
 *
 * A thread that is gone (the user closed it, Codex forgot it) is marked
 * `detached` rather than deleted, so the next bind is a visible event and the
 * history of which thread held which Change stays readable.
 */

export type BindingStatus = "bound" | "detached";

export interface Binding {
  readonly changeId: string;
  readonly threadId: string;
  readonly status: BindingStatus;
}

export class ChangeNotBoundError extends Error {
  constructor(readonly changeId: string) {
    super(`Change ${changeId} has no Codex thread bound to it`);
    this.name = "ChangeNotBoundError";
  }
}

export class ThreadAlreadyBoundError extends Error {
  constructor(readonly threadId: string, readonly changeId: string) {
    super(`Thread ${threadId} is already bound to ${changeId}`);
    this.name = "ThreadAlreadyBoundError";
  }
}

interface BindingRow {
  change_id: string;
  thread_id: string;
  status: BindingStatus;
}

export class BindingStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Bind a Change to a thread, or confirm the binding it already has.
   *
   * Idempotent for the same pair, because the caller is a worker that may be
   * retried and must not have to know whether it already ran.
   */
  bind(changeId: string, threadId: string): Binding {
    const at = this.now().toISOString();
    return this.database.transaction((): Binding => {
      const existing = this.find(changeId);
      if (existing?.status === "bound") {
        if (existing.threadId === threadId) return existing;
        // Rebinding a live Change to a different thread would strand the
        // conversation the human is watching. Detach first, deliberately.
        throw new ThreadAlreadyBoundError(existing.threadId, changeId);
      }
      const holder = this.database.prepare(
        "SELECT change_id FROM change_bindings WHERE thread_id = ? AND status = 'bound'",
      ).get(threadId) as { change_id: string } | undefined;
      if (holder && holder.change_id !== changeId) {
        throw new ThreadAlreadyBoundError(threadId, holder.change_id);
      }

      this.database.prepare(
        `INSERT INTO change_bindings
           (change_id, thread_id, status, bound_at, updated_at)
         VALUES (?, ?, 'bound', ?, ?)
         ON CONFLICT (change_id) DO UPDATE SET
           thread_id = excluded.thread_id,
           status = 'bound',
           bound_at = excluded.bound_at,
           updated_at = excluded.updated_at`,
      ).run(changeId, threadId, at, at);
      return { changeId, threadId, status: "bound" };
    })();
  }

  find(changeId: string): Binding | null {
    const row = this.database.prepare(
      "SELECT change_id, thread_id, status FROM change_bindings WHERE change_id = ?",
    ).get(changeId) as BindingRow | undefined;
    return row
      ? { changeId: row.change_id, threadId: row.thread_id, status: row.status }
      : null;
  }

  /** The bound thread, or a named failure. Never a silent empty string. */
  require(changeId: string): string {
    const binding = this.find(changeId);
    if (!binding || binding.status !== "bound") {
      throw new ChangeNotBoundError(changeId);
    }
    return binding.threadId;
  }

  detach(changeId: string): void {
    this.database.prepare(
      "UPDATE change_bindings SET status = 'detached', updated_at = ? WHERE change_id = ?",
    ).run(this.now().toISOString(), changeId);
  }
}
