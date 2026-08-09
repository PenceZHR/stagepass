import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";

/**
 * Which Codex thread a phase's work happens in: one thread per (Change, phase).
 *
 * ## Why the pair, and not the Change
 *
 * The reason is the fence, not tidiness. With one thread per Change, part of a
 * phase's decision rests on what the model remembers from EARLIER phases -- and
 * that memory lives in Codex's conversation history, inside no StagePass
 * snapshot. The fence cannot reach it, which is a structural hole rather than a
 * bug. One thread per phase forces cross-phase information through documents,
 * and documents are the thing that can be snapshotted, hashed and fenced.
 *
 * The price is real and is paid on purpose: each phase opens on a conversation
 * that knows nothing about the earlier ones, so every phase's opening prompt has
 * to carry its upstream documents itself.
 *
 * ## Re-entering a phase reuses its thread
 *
 * `Fix` can be entered many times, and a rejected design phase runs another
 * round in place, so the pair is not unique in TIME. It still gets one thread:
 * what a third round of Fix most needs is what the first two changed and why it
 * still failed, and that is already in this thread. The cost is that a
 * much-rejected phase's thread grows long -- accepted, because what it is long
 * with is the history of ONE thing rather than twelve.
 *
 * ## Why binding is StagePass's record rather than a lookup
 *
 * StagePass has to be able to say which thread a phase's work is in without
 * asking Codex. So the mapping is durable, unique in both directions while
 * bound, and survives a restart.
 *
 * ## Detaching is explicit
 *
 * A thread that is gone (the user closed it, Codex forgot it) is marked
 * `detached` rather than deleted, so the next bind is a visible event and the
 * history of which thread held which phase stays readable.
 */

export type BindingStatus = "bound" | "detached";

export interface Binding {
  readonly changeId: string;
  readonly phase: Phase;
  readonly threadId: string;
  readonly status: BindingStatus;
}

export class ChangeNotBoundError extends Error {
  constructor(readonly changeId: string, readonly phase: Phase) {
    super(`Change ${changeId} has no Codex thread bound to its ${phase} phase`);
    this.name = "ChangeNotBoundError";
  }
}

export class ThreadAlreadyBoundError extends Error {
  constructor(
    readonly threadId: string,
    readonly changeId: string,
    /** null = 占着它的是那条旁路会话（aside），不属于任何阶段。 */
    readonly phase: Phase | null,
  ) {
    super(`Thread ${threadId} is already bound to ${changeId} at ${phase ?? "aside"}`);
    this.name = "ThreadAlreadyBoundError";
  }
}

interface BindingRow {
  change_id: string;
  phase: Phase;
  thread_id: string;
  status: BindingStatus;
}

export class BindingStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Bind a phase to a thread, or confirm the binding it already has.
   *
   * Idempotent for the same triple, because the caller is a worker that may be
   * retried and must not have to know whether it already ran.
   */
  bind(changeId: string, phase: Phase, threadId: string): Binding {
    const at = this.now().toISOString();
    return this.database.transaction((): Binding => {
      const existing = this.find(changeId, phase);
      if (existing?.status === "bound") {
        if (existing.threadId === threadId) return existing;
        // Rebinding a live phase to a different thread would strand the
        // conversation the human is watching. Detach first, deliberately.
        throw new ThreadAlreadyBoundError(existing.threadId, changeId, phase);
      }
      // A thread belongs to exactly one seat. The same thread turning up under
      // a second phase (or doubling as an aside) would mean two callers
      // appending to one rollout, which is the interleaving that makes "which
      // turn was mine" unanswerable.
      this.assertThreadFree(threadId, changeId, phase);

      this.database.prepare(
        `INSERT INTO change_bindings
           (change_id, kind, phase, thread_id, status, bound_at, updated_at)
         VALUES (?, 'round', ?, ?, 'bound', ?, ?)
         ON CONFLICT (change_id, phase) WHERE kind = 'round' DO UPDATE SET
           thread_id = excluded.thread_id,
           status = 'bound',
           bound_at = excluded.bound_at,
           updated_at = excluded.updated_at`,
      ).run(changeId, phase, threadId, at, at);
      return { changeId, phase, threadId, status: "bound" };
    })();
  }

  /** 这条线程还没被别的座位占着。占着就抛 —— 静默共用一条 rollout 更糟。 */
  private assertThreadFree(
    threadId: string, changeId: string, phase: Phase | null,
  ): void {
    const holder = this.database.prepare(
      "SELECT change_id, phase FROM change_bindings WHERE thread_id = ? AND status = 'bound'",
    ).get(threadId) as { change_id: string; phase: Phase | null } | undefined;
    if (holder && !(holder.change_id === changeId && holder.phase === phase)) {
      throw new ThreadAlreadyBoundError(threadId, holder.change_id, holder.phase);
    }
  }

  find(changeId: string, phase: Phase): Binding | null {
    const row = this.database.prepare(
      `SELECT change_id, phase, thread_id, status FROM change_bindings
        WHERE change_id = ? AND phase = ? AND kind = 'round'`,
    ).get(changeId, phase) as BindingRow | undefined;
    return row
      ? {
          changeId: row.change_id,
          phase: row.phase,
          threadId: row.thread_id,
          status: row.status,
        }
      : null;
  }

  /** The bound thread, or a named failure. Never a silent empty string. */
  require(changeId: string, phase: Phase): string {
    const binding = this.find(changeId, phase);
    if (!binding || binding.status !== "bound") {
      throw new ChangeNotBoundError(changeId, phase);
    }
    return binding.threadId;
  }

  detach(changeId: string, phase: Phase): void {
    this.database.prepare(
      `UPDATE change_bindings SET status = 'detached', updated_at = ?
        WHERE change_id = ? AND phase = ? AND kind = 'round'`,
    ).run(this.now().toISOString(), changeId, phase);
  }

  /*
   * ── 旁路会话（aside，DESIGN-phase-not-the-only-axis §3.3）──────────────
   *
   * 一个 Change 一条：它是「这个 Change 的闲聊」，不属于任何阶段、不产出、
   * 不推闸门。批 2 的「把闲聊收敛成 brief」按它找到那段对话 —— 两条并存就
   * 不知道读哪条，所以 schema 用部分唯一索引钉死一条。
   */

  /** 绑定这个 Change 的旁路线程，或确认已有的那条。和 `bind` 同一套幂等契约。 */
  bindAside(changeId: string, threadId: string): void {
    const at = this.now().toISOString();
    this.database.transaction((): void => {
      const existing = this.findAside(changeId);
      if (existing?.status === "bound" && existing.threadId === threadId) return;
      this.assertThreadFree(threadId, changeId, null);
      this.database.prepare(
        `INSERT INTO change_bindings
           (change_id, kind, phase, thread_id, status, bound_at, updated_at)
         VALUES (?, 'aside', NULL, ?, 'bound', ?, ?)
         ON CONFLICT (change_id) WHERE kind = 'aside' DO UPDATE SET
           thread_id = excluded.thread_id,
           status = 'bound',
           bound_at = excluded.bound_at,
           updated_at = excluded.updated_at`,
      ).run(changeId, threadId, at, at);
    })();
  }

  findAside(changeId: string): {
    readonly threadId: string;
    readonly status: BindingStatus;
  } | null {
    const row = this.database.prepare(
      `SELECT thread_id, status FROM change_bindings
        WHERE change_id = ? AND kind = 'aside'`,
    ).get(changeId) as { thread_id: string; status: BindingStatus } | undefined;
    return row ? { threadId: row.thread_id, status: row.status } : null;
  }

  /**
   * 这个 Change 还绑着（`bound`）的全部线程，round 和 aside 一起，去重。
   *
   * 删除用（`app/workspace.ts`）：删掉的 Change 不该在 Codex 里留活线程。
   * `detached` 的不算 —— 解绑说明别处已经处置过它。
   */
  boundThreads(changeId: string): string[] {
    const rows = this.database.prepare(
      `SELECT DISTINCT thread_id FROM change_bindings
        WHERE change_id = ? AND status = 'bound'`,
    ).all(changeId) as { thread_id: string }[];
    return rows.map((row) => row.thread_id);
  }

  detachAside(changeId: string): void {
    this.database.prepare(
      `UPDATE change_bindings SET status = 'detached', updated_at = ?
        WHERE change_id = ? AND kind = 'aside'`,
    ).run(this.now().toISOString(), changeId);
  }
}
