import { randomUUID } from "node:crypto";

import { and, eq, gt, lte, or } from "drizzle-orm";

import { db } from "../db";
import {
  codexFollowerStartAttempts,
  codexLogicalTurns,
  pipelineJobs,
} from "../db/schema";
import {
  InteractionWakeupOrchestrator,
} from "./interaction-wakeup-orchestrator";
import type { JobExecutionContext } from "./job-execution-context";

type RecoveryDb = typeof db;

export interface InteractionWakeupRecoveryDependencies {
  database?: RecoveryDb;
  orchestrator?: Pick<InteractionWakeupOrchestrator, "run">;
  now?: () => Date;
  leaseMs?: number;
  heartbeatMs?: number;
  workerId?: string;
  recoverCodexNativeAttempt?: (attemptId: string) => Promise<{
    action: string;
  }>;
}

export class InteractionWakeupRecoveryService {
  private readonly database: RecoveryDb;
  private readonly orchestrator: Pick<InteractionWakeupOrchestrator, "run">;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly workerId: string;
  private readonly recoverCodexNativeAttempt:
    InteractionWakeupRecoveryDependencies["recoverCodexNativeAttempt"];

  constructor(
    dependencies: InteractionWakeupRecoveryDependencies = {},
  ) {
    this.database = dependencies.database ?? db;
    this.orchestrator = dependencies.orchestrator
      ?? new InteractionWakeupOrchestrator({ database: this.database });
    this.now = dependencies.now ?? (() => new Date());
    this.leaseMs = dependencies.leaseMs ?? 30_000;
    this.heartbeatMs = dependencies.heartbeatMs
      ?? Math.max(1, Math.floor(this.leaseMs / 3));
    this.workerId = dependencies.workerId
      ?? `interaction-wakeup-recovery:${process.pid}`;
    this.recoverCodexNativeAttempt =
      dependencies.recoverCodexNativeAttempt;
  }

  async recoverPending(): Promise<Array<{
    pipelineJobId: string;
    status: "recovered" | "reconciliation_required" | "lost_race";
  }>> {
    const now = this.now();
    const candidates = this.database.select().from(pipelineJobs).where(and(
      eq(pipelineJobs.jobKind, "interaction_wakeup"),
      or(
        eq(pipelineJobs.status, "queued"),
        and(
          eq(pipelineJobs.status, "running"),
          lte(pipelineJobs.leaseExpiresAt, now.toISOString()),
        ),
        and(
          eq(pipelineJobs.status, "leased"),
          lte(pipelineJobs.leaseExpiresAt, now.toISOString()),
        ),
        // A failed wakeup is not a finished one. It now owns persisting the
        // stage result, so giving up on it strands a decision the human
        // already made, with their answers spent. The effect budget the
        // receipt granted is the bound on retrying.
        and(
          eq(pipelineJobs.status, "failed"),
          gt(pipelineJobs.effectDeadlineAt, now.toISOString()),
        ),
      ),
    )).all();
    const results: Array<{
      pipelineJobId: string;
      status: "recovered" | "reconciliation_required" | "lost_race";
    }> = [];
    for (const candidate of candidates) {
      const context = this.acquire(candidate.id, now);
      if (!context) {
        results.push({ pipelineJobId: candidate.id, status: "lost_race" });
        continue;
      }
      const attempt = this.database.select().from(codexFollowerStartAttempts)
        .innerJoin(
          codexLogicalTurns,
          eq(
            codexLogicalTurns.logicalTurnId,
            codexFollowerStartAttempts.logicalTurnId,
          ),
        )
        .where(eq(codexLogicalTurns.pipelineJobId, candidate.id)).get()
        ?.codex_follower_start_attempts;
      if (attempt && this.recoverCodexNativeAttempt) {
        const recovered = await this.recoverCodexNativeAttempt(
          attempt.attemptId,
        );
        if ([
          "turn_not_yet_visible",
          "quarantined",
          "already_quarantined",
          "left_owned_by_live_worker",
          "lost_race",
        ].includes(recovered.action)) {
          results.push({
            pipelineJobId: candidate.id,
            status: "reconciliation_required",
          });
          continue;
        }
      }
      if (attempt && !["prepared", "no_client_found", "succeeded"].includes(
        attempt.state,
      )) {
        results.push({
          pipelineJobId: candidate.id,
          status: "reconciliation_required",
        });
        continue;
      }
      if (attempt && attempt.state !== "succeeded") {
        this.database.update(codexFollowerStartAttempts).set({
          state: "prepared",
          workerId: context.workerId,
          leaseToken: context.leaseToken,
          ownerAttempt: context.attemptNo,
          ownerEpoch: attempt.ownerEpoch + 1,
        }).where(and(
          eq(codexFollowerStartAttempts.attemptId, attempt.attemptId),
          eq(codexFollowerStartAttempts.state, attempt.state),
          eq(codexFollowerStartAttempts.workerId, attempt.workerId),
          eq(codexFollowerStartAttempts.leaseToken, attempt.leaseToken),
          eq(codexFollowerStartAttempts.ownerEpoch, attempt.ownerEpoch),
        )).run();
      }
      // A wakeup now watches its whole continuation turn, which outlives the
      // lease this sweep just took. Without renewal the next sweep re-acquires
      // the same job, fences the attempt still running, and the two livelock.
      const heartbeat = setInterval(
        () => this.renewLease(context),
        this.heartbeatMs,
      );
      heartbeat.unref?.();
      try {
        await this.orchestrator.run(candidate.id, context);
      } finally {
        clearInterval(heartbeat);
      }
      results.push({ pipelineJobId: candidate.id, status: "recovered" });
    }
    return results;
  }

  private renewLease(context: JobExecutionContext): void {
    const now = this.now();
    this.database.update(pipelineJobs).set({
      leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
      heartbeatAt: now.toISOString(),
    }).where(and(
      eq(pipelineJobs.id, context.jobId),
      eq(pipelineJobs.leasedBy, context.workerId),
      eq(pipelineJobs.leaseToken, context.leaseToken),
      eq(pipelineJobs.attemptNo, context.attemptNo),
    )).run();
  }

  private acquire(
    jobId: string,
    now: Date,
  ): JobExecutionContext | null {
    return this.database.transaction((tx) => {
      const job = tx.select().from(pipelineJobs)
        .where(eq(pipelineJobs.id, jobId)).get();
      if (
        !job
        || job.jobKind !== "interaction_wakeup"
        || !["queued", "leased", "running", "failed"].includes(job.status)
        || (
          job.status === "failed"
          && (!job.effectDeadlineAt
            || Date.parse(job.effectDeadlineAt) <= now.getTime())
        )
        || (
          job.status !== "queued"
          && job.status !== "failed"
          && (!job.leaseExpiresAt
            || Date.parse(job.leaseExpiresAt) > now.getTime())
        )
      ) return null;
      const leaseToken = randomUUID();
      const attemptNo = job.status === "queued"
        ? job.attemptNo
        : job.attemptNo + 1;
      const changed = tx.update(pipelineJobs).set({
        status: "running",
        leasedBy: this.workerId,
        leaseToken,
        workerNonce: randomUUID(),
        attemptNo,
        leaseExpiresAt: new Date(
          Math.min(
            now.getTime() + this.leaseMs,
            Date.parse(job.effectDeadlineAt!),
          ),
        ).toISOString(),
        heartbeatAt: now.toISOString(),
        startedAt: job.startedAt ?? now.toISOString(),
      }).where(and(
        eq(pipelineJobs.id, job.id),
        eq(pipelineJobs.status, job.status),
        eq(pipelineJobs.attemptNo, job.attemptNo),
      )).run().changes;
      return changed === 1
        ? {
            jobId,
            workerId: this.workerId,
            leaseToken,
            attemptNo,
          }
        : null;
    });
  }
}
