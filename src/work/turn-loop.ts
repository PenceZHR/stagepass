import type Database from "better-sqlite3";

import type { Blocker } from "../domain/gate";
import { ChangeStore } from "../store/change-store";
import { EvidenceStore } from "../store/evidence-store";
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
  readonly blockers: readonly Blocker[];
}

export interface TurnRunner {
  run(job: Job): Promise<TurnOutcome>;
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
  private readonly jobs: JobStore;

  constructor(private readonly dependencies: TurnLoopDependencies) {
    const now = dependencies.now ?? (() => new Date());
    this.changes = new ChangeStore(dependencies.database, { now });
    this.evidence = new EvidenceStore(dependencies.database, now);
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
        // A re-run replaces the phase's evidence rather than adding to it: the
        // new round's findings supersede the old round's. Blockers that are
        // still true are the round's job to re-report.
        this.evidence.put(job.changeId, phase, {
          artifactIds: outcome.artifactIds,
          blockers: outcome.blockers,
          waivedBlockerIds: this.evidence.read(job.changeId, phase)
            .waivedBlockerIds,
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
