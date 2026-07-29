import type Database from "better-sqlite3";

/**
 * Which Codex thread a Change's work happens in.
 *
 * ## The granularity here is superseded, and deliberately not rebuilt yet
 *
 * This store is keyed by Change alone: one Change, one persistent thread. That
 * decision was overturned on 2026-07-28 -- the binding granularity is now one
 * thread per (Change, phase), see the rebuild PRD §6.5. Re-keying the table is
 * scheduled work, not a drive-by, so the old shape is what still runs.
 *
 * Read the next paragraph as the record of a decision that was reversed, NOT
 * as a live argument for the code below.
 *
 * The original case for one-thread-per-Change was that a thread per phase would
 * scatter the human's work across a dozen tasks. That reason is dead: per-phase
 * threads laid out as tabs in the terminal panel are organised, not scattered.
 * What replaced it is a hole the old shape could not close -- with one thread
 * per Change, part of a phase's decision rests on what the model remembers from
 * earlier phases, and that memory lives in Codex's conversation history, inside
 * no StagePass snapshot. The fence cannot reach it. One thread per phase forces
 * cross-phase information through documents, which can be snapshotted, hashed
 * and fenced.
 *
 * The old argument was right about one thing, and it is the price now being
 * paid: each phase opens on a conversation that knows nothing about the earlier
 * ones, so every phase's opening prompt has to carry its upstream documents
 * itself.
 *
 * ## Why binding is StagePass's record rather than a lookup
 *
 * Untouched by the above, and the reason this store exists at all: StagePass
 * has to be able to say which thread its work is in without asking Codex. So
 * the mapping is durable, unique in both directions while bound, and survives a
 * restart. When §6.5 is built, the key changes; these properties do not.
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
