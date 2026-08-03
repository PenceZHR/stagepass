import type Database from "better-sqlite3";

import {
  claim,
  heartbeat,
  recoveryFor,
  type HeartbeatResult,
  type Lease,
} from "../domain/lease";

/**
 * Long-running work, and who owns it.
 *
 * ## Claiming and recovering are separate on purpose
 *
 * `claimNext` only hands out `queued` work. Work whose owner vanished is put
 * back by `recover`, which is also where the decision "resume or fail" is made.
 * Folding takeover into claiming would hide that decision inside a hot path and
 * make "this job has been retried nineteen times" invisible.
 *
 * ## Nothing sits in `running` with nobody on it
 *
 * The schema forbids the row shape, and `recover` is what stops it from
 * happening in time rather than in structure: a lapsed lease is resolved to
 * `queued` or to `failed` with a stated reason. There is no third outcome,
 * because the third outcome is the one where work looks alive forever.
 */

const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface Job {
  readonly id: string;
  readonly changeId: string;
  readonly kind: string;
  readonly status: JobStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly lease: Lease | null;
  readonly error: string | null;
}

interface JobRow {
  id: string;
  change_id: string;
  kind: string;
  status: JobStatus;
  attempt: number;
  max_attempts: number;
  owner: string | null;
  token: string | null;
  expires_at: number | null;
  deadline_at: number;
  error: string | null;
}

export class JobNotFoundError extends Error {
  constructor(readonly jobId: string) {
    super(`No job with id ${jobId}`);
    this.name = "JobNotFoundError";
  }
}

/** Raised when a worker acts on work it does not (or no longer) owns. */
export class NotJobOwnerError extends Error {
  constructor(readonly jobId: string) {
    super(`This worker does not own job ${jobId}`);
    this.name = "NotJobOwnerError";
  }
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    changeId: row.change_id,
    kind: row.kind,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    lease: row.owner !== null && row.token !== null && row.expires_at !== null
      ? {
          owner: row.owner,
          token: row.token,
          expiresAt: row.expires_at,
          deadlineAt: row.deadline_at,
        }
      : null,
    error: row.error,
  };
}

export interface RecoverySummary {
  readonly resumed: readonly string[];
  readonly failed: readonly { id: string; reason: string }[];
}

export class JobStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  enqueue(input: {
    id: string;
    changeId: string;
    kind: string;
    deadlineAt: number;
    maxAttempts: number;
  }): Job {
    const at = this.now().toISOString();
    this.database.prepare(
      `INSERT INTO jobs
         (id, change_id, kind, status, attempt, max_attempts,
          owner, token, expires_at, deadline_at, error, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL, ?, NULL, ?, ?)`,
    ).run(
      input.id, input.changeId, input.kind, input.maxAttempts,
      input.deadlineAt, at, at,
    );
    return this.read(input.id);
  }

  read(jobId: string): Job {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?")
      .get(jobId) as JobRow | undefined;
    if (!row) throw new JobNotFoundError(jobId);
    return toJob(row);
  }

  /**
   * 这个 Change 最近排的那个 job。没有就是 null。**只读。**
   *
   * ## 为什么它不返回 `Job`
   *
   * 进度那一屏要说的是「已经跑了多久」，而那要 `created_at` —— 而 `Job` 上没有这一列，
   * 因为在它之前没有任何一处需要它。为一个调用方给 `Job` 加一列，等于让每个用 `Job`
   * 的地方都多背一个它不关心的字段；所以这里给一个**窄的读**，字段就是那一屏要的那几个。
   *
   * 「最近」按 `created_at` 取，不按 rowid：一个 Change 的 job id 里带时间戳，
   * 但排序要按库说的算，不按 id 的字面顺序。
   */
  latestFor(changeId: string): {
    id: string;
    status: JobStatus;
    createdAt: string;
    attempt: number;
  } | null {
    const row = this.database.prepare(
      `SELECT id, status, attempt, created_at FROM jobs
        WHERE change_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(changeId) as
      | { id: string; status: JobStatus; attempt: number; created_at: string }
      | undefined;
    return row === undefined
      ? null
      : {
          id: row.id, status: row.status, attempt: row.attempt,
          createdAt: row.created_at,
        };
  }

  /**
   * 这个 Change 现在有活儿在进行中吗 —— **排着队的也算。**
   *
   * ## 为什么闸门不能只看「进程活着吗」
   *
   * 三条问人的路和派发那条路，判据一直是 `sessions.has()`（注册表里还有没有这个
   * 阶段的 pty）。2026-08-03 真机撞出来它挡不住什么：
   *
   * 一轮跑完，会话结束、注册表里没了，**而库里那个 job 还是 `running`**（没人收尾，
   * 见下）。于是下一次派发畅通无阻，起了第二条裁判线程 —— 同一个 (Change, 阶段) 上
   * 两条线程同时跑，正是 §6.5 规则 5 明令不许的那件事。实测那一次两条线程互相打断，
   * 一条烧了近 300 万 input token，人在终端里连字都打不进去。
   *
   * 「进程活着」是**当下这一刻**的事实，而闸门要问的是**这个阶段有没有事情还没了结**。
   * 后者只有账本知道。
   */
  busyFor(changeId: string): { id: string; status: JobStatus } | null {
    const row = this.database.prepare(
      `SELECT id, status FROM jobs
        WHERE change_id = ? AND status IN ('queued', 'running')
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(changeId) as { id: string; status: JobStatus } | undefined;
    return row ?? null;
  }

  /**
   * Take the oldest queued job, or nothing.
   *
   * A job whose attempts are spent is failed here rather than handed out, so a
   * worker never receives work that cannot legitimately run.
   */
  claimNext(input: {
    owner: string;
    token: string;
    now: number;
    ttlMs: number;
  }): Job | null {
    return this.database.transaction((): Job | null => {
      const row = this.database.prepare(
        "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1",
      ).get() as JobRow | undefined;
      if (!row) return null;

      const attempt = row.attempt + 1;
      if (attempt > row.max_attempts) {
        this.markFailed(row.id, "attempts_exhausted");
        return null;
      }
      const claimed = claim({
        existing: null,
        owner: input.owner,
        token: input.token,
        now: input.now,
        ttlMs: input.ttlMs,
        deadlineAt: row.deadline_at,
      });
      // `existing` is null by construction -- only queued rows reach here, and
      // a queued row has no lease -- so a claim can never be refused.
      if (claimed.kind !== "claimed") throw new Error("unreachable_claim_refusal");

      this.database.prepare(
        `UPDATE jobs
            SET status = 'running', attempt = ?, owner = ?, token = ?,
                expires_at = ?, updated_at = ?
          WHERE id = ? AND status = 'queued'`,
      ).run(
        attempt, claimed.lease.owner, claimed.lease.token,
        claimed.lease.expiresAt, this.now().toISOString(), row.id,
      );
      return this.read(row.id);
    })();
  }

  /**
   * Keep a claim alive.
   *
   * `deadline_reached` is answered by failing the job with that reason. The old
   * tree had no answer for it: the lease was pinned to the deadline, the state
   * machine demanded strict forward movement, and the work died of a database
   * ABORT whose message was about a constraint rather than about time.
   */
  heartbeat(input: {
    jobId: string;
    owner: string;
    token: string;
    now: number;
    ttlMs: number;
  }): HeartbeatResult {
    const job = this.read(input.jobId);
    if (job.status !== "running" || job.lease === null) return { kind: "lost" };

    const result = heartbeat({
      lease: job.lease,
      owner: input.owner,
      token: input.token,
      now: input.now,
      ttlMs: input.ttlMs,
    });
    if (result.kind === "extended") {
      this.database.prepare(
        "UPDATE jobs SET expires_at = ?, updated_at = ? WHERE id = ? AND token = ?",
      ).run(
        result.lease.expiresAt, this.now().toISOString(),
        input.jobId, input.token,
      );
    }
    if (result.kind === "deadline_reached") {
      this.markFailed(input.jobId, "deadline_reached");
    }
    return result;
  }

  complete(input: { jobId: string; owner: string; token: string }): Job {
    this.assertOwner(input);
    this.database.prepare(
      `UPDATE jobs
          SET status = 'done', owner = NULL, token = NULL, expires_at = NULL,
              updated_at = ?
        WHERE id = ?`,
    ).run(this.now().toISOString(), input.jobId);
    return this.read(input.jobId);
  }

  fail(input: {
    jobId: string;
    owner: string;
    token: string;
    reason: string;
  }): Job {
    this.assertOwner(input);
    this.markFailed(input.jobId, input.reason);
    return this.read(input.jobId);
  }

  /**
   * Resolve every job whose owner is gone. Called on startup and periodically;
   * this is what makes "the process died" a survivable event rather than a
   * permanently stuck Change.
   */
  recover(now: number): RecoverySummary {
    const rows = this.database.prepare(
      "SELECT * FROM jobs WHERE status = 'running' AND expires_at <= ?",
    ).all(now) as JobRow[];

    const resumed: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const row of rows) {
      const job = toJob(row);
      if (job.lease === null) continue;
      const { outcome, reason } = recoveryFor({
        lease: job.lease,
        now,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
      });
      if (outcome === "resume") {
        this.database.prepare(
          `UPDATE jobs
              SET status = 'queued', owner = NULL, token = NULL,
                  expires_at = NULL, updated_at = ?
            WHERE id = ?`,
        ).run(this.now().toISOString(), row.id);
        resumed.push(row.id);
      } else {
        this.markFailed(row.id, reason);
        failed.push({ id: row.id, reason });
      }
    }
    return { resumed, failed };
  }

  private assertOwner(input: {
    jobId: string;
    owner: string;
    token: string;
  }): void {
    const job = this.read(input.jobId);
    if (
      job.status !== "running"
      || job.lease === null
      || job.lease.owner !== input.owner
      || job.lease.token !== input.token
    ) {
      throw new NotJobOwnerError(input.jobId);
    }
  }

  private markFailed(jobId: string, reason: string): void {
    this.database.prepare(
      `UPDATE jobs
          SET status = 'failed', error = ?, owner = NULL, token = NULL,
              expires_at = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(reason, this.now().toISOString(), jobId);
  }
}
