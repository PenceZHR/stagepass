import type Database from "better-sqlite3";

import type { Finding } from "../domain/gate";
import type { Verdict } from "../domain/gap";
import { ChangeStore } from "../store/change-store";
import { EvidenceStore } from "../store/evidence-store";
import { GapStore } from "../store/gap-store";
import { JobStore, type Job } from "./job-store";

/**
 * The loop that turns queued work into evidence a gate can read.
 *
 * ## Why the turn is injected
 *
 * At L1 the turn is a fake. That is not a testing convenience, it is the
 * layer's deliverable: everything from "start a phase" to "the gate now permits
 * approval" is drivable with no Codex, no network and no human, so all of it is
 * proved before L2 is allowed to exist. L2 replaces `TurnRunner` with one that
 * actually talks to Codex and changes nothing else.
 *
 * ## System moves and human moves are different writes
 *
 * `start`, `settle` and `fail` are the system reporting what happened; they go
 * straight to the ledger. `approve`, `reject` and `retry` are decisions, and
 * they go through `CommandStore`, which fences them against the evidence the
 * decider saw. Routing a system move through the fence would mean a turn could
 * fail to record its own failure because the gate had moved.
 */

export interface TurnOutcome {
  readonly artifactIds: readonly string[];
  /**
   * Problems this round found. Re-finding an open one is not re-adding it.
   *
   * `Finding`，不是 `Blocker`：一轮报出来的都是 finding 且必带严重度。
   * 一条 `standard`（没被满足的标准）是 rubric 判出来的二元结论，走的是另一条路，
   * 不从这里进 `settleRound`。
   */
  readonly blockers: readonly Finding[];
  /**
   * What this round says about problems that were already open.
   *
   * Optional, and its absence is meaningful rather than lazy: a round that says
   * nothing about an open gap leaves it open. Closing one has to be said out
   * loud, with a reason.
   */
  readonly verdicts?: Readonly<Record<string, Verdict>>;
}

export interface TurnRunner {
  run(job: Job): Promise<TurnOutcome>;
}

/**
 * 收拾主已经死了的活。**进程重启时调一次。**
 *
 * ## 为什么它必须存在，而且必须在这一层
 *
 * `JobStore.recover` 早就写好了、也离线证过 —— 但在新树里**一个生产调用者都没有**
 * （只有它自己的测试在调）。于是 2026-07-30 实测到了它本该防住的那件事：面板被杀掉，
 * 库里留下一个 `running` 的 job 和一个 `running` 的 Change，而
 * **`running` 的 Change 只允许 `settle` / `fail`** —— 两个都不是人能裁决的动作，
 * 于是「跑这个阶段」和「请 Codex 问我」全灰，那个 Change **永远动不了了**。
 *
 * 而 `JobStore.recover` 只收拾 job，不动 Change：它是 L1 的 store，不该知道状态机。
 * 所以这一步放在这里 —— 和 `runOnce` 的 catch 一样，**失败要在两个地方都记上**。
 * 只记一个，就是老树那种「绿色的 job 压在一个从没动过的 Change 上面」。
 *
 * ## 判据是租约过期，不是「看起来卡住了」
 *
 * 只有 `expires_at <= now` 的 job 会被收拾（`JobStore.recover` 定的）。一个还在心跳
 * 的 job 不会被这里碰到 —— 那正是租约存在的意义，不许在这儿用「跑了很久」去猜。
 */
export function recoverStuckTurns(
  database: Database.Database,
  now: number,
): { resumed: readonly string[]; failed: readonly { id: string; reason: string }[] } {
  const jobs = new JobStore(database);
  const changes = new ChangeStore(database);
  const summary = jobs.recover(now);

  for (const each of summary.failed) {
    const changeId = jobs.read(each.id).changeId;
    // 幂等：Change 可能已经不是 running 了（比如上一次恢复已经处理过），那就不用再动。
    if (changes.read(changeId).state.status !== "running") continue;
    changes.apply(changeId, "fail");
  }
  return summary;
}

/**
 * A scripted turn, for driving the loop offline.
 *
 * `L1`'s stand-in for Codex. Deliberately dumb: it returns what it was told to
 * return, or throws what it was told to throw, so a test states the situation
 * it is exercising instead of arranging for one to occur.
 */
export class ScriptedTurnRunner implements TurnRunner {
  private readonly script: (TurnOutcome | Error)[];

  constructor(script: (TurnOutcome | Error)[]) {
    this.script = [...script];
  }

  async run(): Promise<TurnOutcome> {
    const next = this.script.shift();
    if (next === undefined) throw new Error("scripted_runner_exhausted");
    if (next instanceof Error) throw next;
    return next;
  }
}

export interface TurnLoopDependencies {
  readonly database: Database.Database;
  readonly runner: TurnRunner;
  readonly now?: () => Date;
}

export type RunResult =
  | { readonly kind: "idle" }
  | { readonly kind: "settled"; readonly jobId: string }
  | { readonly kind: "failed"; readonly jobId: string; readonly reason: string };

export class TurnLoop {
  private readonly changes: ChangeStore;
  private readonly evidence: EvidenceStore;
  private readonly gaps: GapStore;
  private readonly jobs: JobStore;

  constructor(private readonly dependencies: TurnLoopDependencies) {
    const now = dependencies.now ?? (() => new Date());
    this.changes = new ChangeStore(dependencies.database, { now });
    this.evidence = new EvidenceStore(dependencies.database, now);
    this.gaps = new GapStore(dependencies.database, now);
    this.jobs = new JobStore(dependencies.database, now);
  }

  /**
   * Ensure a turn is queued for this phase, moving the Change to `running` if
   * it is not already.
   *
   * One method rather than a start-one and a retry-one, because the trigger is
   * not "someone called start" -- it is "the Change is running and needs work
   * behind it". `start` gets there from `pending`; a human's `retry` gets there
   * from `blocked`. Two methods differing by one line is how the two drift.
   *
   * Both writes are one transaction, so a queued job always has a Change that
   * expects it, and a running Change always has work behind it.
   */
  queueTurn(input: {
    changeId: string;
    jobId: string;
    deadlineAt: number;
    maxAttempts: number;
  }): Job {
    return this.dependencies.database.transaction((): Job => {
      const status = this.changes.read(input.changeId).state.status;
      if (status === "pending") {
        this.changes.apply(input.changeId, "start");
      } else if (status !== "running") {
        throw new Error(
          `cannot queue a turn for a Change that is ${status}`,
        );
      }
      return this.jobs.enqueue({
        id: input.jobId,
        changeId: input.changeId,
        kind: "phase_turn",
        deadlineAt: input.deadlineAt,
        maxAttempts: input.maxAttempts,
      });
    })();
  }

  /** Claim one job, run it, and record what it produced. */
  async runOnce(input: {
    owner: string;
    token: string;
    now: number;
    ttlMs: number;
  }): Promise<RunResult> {
    const job = this.jobs.claimNext(input);
    if (!job) return { kind: "idle" };

    try {
      const outcome = await this.dependencies.runner.run(job);
      const phase = this.changes.read(job.changeId).state.phase;
      this.dependencies.database.transaction(() => {
        // Artifacts belong to the round that made them, so they are replaced.
        // Problems do not: they go to `gaps`, where a later round that never
        // mentions one leaves it open. The old shape put blockers here and
        // replaced them wholesale, which meant a round could resolve a problem
        // by forgetting it -- and forgetting is the likeliest thing a model
        // does. Nothing about the gate changed; what changed is where it reads.
        this.evidence.put(job.changeId, phase, {
          artifactIds: outcome.artifactIds,
          blockers: [],
          waivedBlockerIds: [],
        });
        this.gaps.settleRound(job.changeId, phase, {
          round: job.attempt,
          found: outcome.blockers.map((blocker) => ({
            id: blocker.id,
            severity: blocker.severity,
            title: blocker.title,
          })),
          verdicts: outcome.verdicts ?? {},
        });
        this.changes.apply(job.changeId, "settle");
      })();
      this.jobs.complete({ jobId: job.id, owner: input.owner, token: input.token });
      return { kind: "settled", jobId: job.id };
    } catch (error) {
      // The failure is recorded on both the job and the Change. Recording it on
      // only one is how the old tree produced a green job above a Change that
      // had never moved.
      const reason = error instanceof Error ? error.message : String(error);
      this.changes.apply(job.changeId, "fail");
      this.jobs.fail({
        jobId: job.id, owner: input.owner, token: input.token, reason,
      });
      return { kind: "failed", jobId: job.id, reason };
    }
  }
}
