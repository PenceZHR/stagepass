import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db } from "../db";
import {
  codexFollowerStartAttempts,
  codexInteractions,
  codexLogicalTurns,
  codexThreadBindings,
  pipelineJobs,
} from "../db/schema";
import {
  attachCodexBindingRunAttempt,
  claimCodexBindingRunLease,
  releaseCodexBindingRunLease,
} from "./codex-binding-run-lease-service";
import {
  readLogicalTurnForStart,
  resolveLogicalTurn,
} from "./codex-logical-turn-service";
import {
  deliverHostContinuation,
  type HostUiMessageClient,
} from "./host-continuation-delivery";
import type { JobExecutionContext } from "./job-execution-context";
import { startCodexTurnExecution } from "./codex-turn-lifecycle-service";

type WakeDb = typeof db;

export class InteractionWakeupError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "InteractionWakeupError";
  }
}

export interface InteractionWakeupDependencies {
  database?: WakeDb;
  hostClient?: HostUiMessageClient;
  now?: () => Date;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class InteractionWakeupOrchestrator {
  private readonly database: WakeDb;
  private readonly now: () => Date;

  constructor(private readonly dependencies: InteractionWakeupDependencies = {}) {
    this.database = dependencies.database ?? db;
    this.now = dependencies.now ?? (() => new Date());
  }

  async run(
    jobId: string,
    context: JobExecutionContext,
  ): Promise<{
    status: "dispatched" | "already_dispatched";
    pipelineJobId: string;
    logicalTurnId: string;
    attemptId: string;
    turnId: string;
  }> {
    const identity = this.readIdentity(jobId, context);
    const logical = await resolveLogicalTurn({
      owner: { kind: "pipeline_job", pipelineJobId: jobId },
      phase: identity.phase,
      role: "interaction_wakeup",
      round: 0,
      ordinal: 0,
      interactionId: identity.interactionId,
      commandId: identity.commandId,
      request: {
        prompt:
          `StagePass decision ${identity.commandId} was saved for interaction `
          + `${identity.interactionId}. Continue this same task from the `
          + "authoritative Server state.",
        sandboxMode: "read-only",
      },
    });
    this.allocateOrdinal(jobId, context, logical.logicalTurnId);
    const start = await readLogicalTurnForStart(logical.logicalTurnId);
    const bindingLease = claimCodexBindingRunLease({
      logicalTurnId: logical.logicalTurnId,
      workerId: context.workerId,
      ownerLeaseToken: context.leaseToken,
      ownerAttempt: context.attemptNo,
      ownerEpoch: context.attemptNo,
      deadlineAt: start.fence.deadlineAt,
    });
    try {
      const attempt = this.prepareAttempt(logical.logicalTurnId, context);
      if (attempt.state === "succeeded" && attempt.followerTurnId) {
        return {
          status: "already_dispatched",
          pipelineJobId: jobId,
          logicalTurnId: logical.logicalTurnId,
          attemptId: attempt.attemptId,
          turnId: attempt.followerTurnId,
        };
      }
      if (attempt.state !== "prepared") {
        throw new InteractionWakeupError("interaction_wakeup_reconciliation_required");
      }
      attachCodexBindingRunAttempt(bindingLease, attempt.attemptId);
      const dispatchOrdinal = this.claimDispatch(attempt.attemptId, context);
      const persisted = this.database.select().from(codexFollowerStartAttempts)
        .where(eq(codexFollowerStartAttempts.attemptId, attempt.attemptId))
        .get()!;
      const delivered = await deliverHostContinuation({
        logicalTurnId: logical.logicalTurnId,
        attemptId: persisted.attemptId,
        interactionId: identity.interactionId,
        commandId: identity.commandId,
        sourceThreadId: start.request.threadId,
        correlationMarker: persisted.correlationMarker,
        message: `${start.request.prompt}\n\n${persisted.correlationMarker}`,
      }, this.dependencies.hostClient);
      this.recordSuccess(
        persisted.attemptId,
        context,
        dispatchOrdinal,
        delivered.turnId,
      );
      startCodexTurnExecution({
        logicalTurnId: logical.logicalTurnId,
        attemptId: persisted.attemptId,
        threadId: start.request.threadId,
        turnId: delivered.turnId,
      });
      return {
        status: "dispatched",
        pipelineJobId: jobId,
        logicalTurnId: logical.logicalTurnId,
        attemptId: persisted.attemptId,
        turnId: delivered.turnId,
      };
    } catch (error) {
      this.recordAmbiguousIfDispatching(logical.logicalTurnId, context, error);
      throw error;
    } finally {
      releaseCodexBindingRunLease(bindingLease);
    }
  }

  private readIdentity(jobId: string, context: JobExecutionContext) {
    const now = this.now().getTime();
    const job = this.database.select().from(pipelineJobs)
      .where(eq(pipelineJobs.id, jobId)).get();
    if (
      !job
      || job.jobKind !== "interaction_wakeup"
      || job.effectType !== "interaction_wakeup"
      || !job.interactionId
      || !job.commandId
      || job.status !== "running"
      || job.leasedBy !== context.workerId
      || job.leaseToken !== context.leaseToken
      || job.attemptNo !== context.attemptNo
      || !job.leaseExpiresAt
      || Date.parse(job.leaseExpiresAt) <= now
      || !job.effectDeadlineAt
      || Date.parse(job.effectDeadlineAt) <= now
    ) throw new InteractionWakeupError("interaction_wakeup_lease_stale");
    const interaction = this.database.select().from(codexInteractions)
      .where(eq(codexInteractions.id, job.interactionId)).get();
    if (
      !interaction
      || interaction.status !== "completed"
      || interaction.changeId !== job.changeId
    ) throw new InteractionWakeupError("interaction_wakeup_identity_invalid");
    return {
      phase: job.phase,
      interactionId: job.interactionId,
      commandId: job.commandId,
    };
  }

  private allocateOrdinal(
    jobId: string,
    context: JobExecutionContext,
    logicalTurnId: string,
  ): void {
    this.database.transaction((tx) => {
      const logical = tx.select().from(codexLogicalTurns)
        .where(eq(codexLogicalTurns.logicalTurnId, logicalTurnId)).get();
      if (
        !logical
        || logical.pipelineJobId !== jobId
        || logical.role !== "interaction_wakeup"
        || logical.ordinal !== 0
      ) throw new InteractionWakeupError("interaction_wakeup_slot_invalid");
      const job = tx.select().from(pipelineJobs)
        .where(eq(pipelineJobs.id, jobId)).get()!;
      if (job.nextTurnOrdinal >= 1) return;
      const changed = tx.update(pipelineJobs).set({
        nextTurnOrdinal: 1,
      }).where(and(
        eq(pipelineJobs.id, jobId),
        eq(pipelineJobs.status, "running"),
        eq(pipelineJobs.leaseToken, context.leaseToken),
        eq(pipelineJobs.attemptNo, context.attemptNo),
        eq(pipelineJobs.nextTurnOrdinal, 0),
      )).run().changes;
      if (changed !== 1) {
        throw new InteractionWakeupError("interaction_wakeup_ordinal_conflict");
      }
    });
  }

  private prepareAttempt(
    logicalTurnId: string,
    context: JobExecutionContext,
  ) {
    const existing = this.database.select().from(codexFollowerStartAttempts)
      .where(eq(codexFollowerStartAttempts.logicalTurnId, logicalTurnId)).get();
    if (existing) return existing;
    const logical = this.database.select().from(codexLogicalTurns)
      .where(eq(codexLogicalTurns.logicalTurnId, logicalTurnId)).get()!;
    const job = this.database.select().from(pipelineJobs)
      .where(eq(pipelineJobs.id, context.jobId)).get()!;
    const binding = this.database.select().from(codexThreadBindings)
      .where(eq(codexThreadBindings.bindingId, logical.bindingId)).get();
    if (!binding?.threadId) {
      throw new InteractionWakeupError("interaction_wakeup_binding_missing");
    }
    const request = JSON.parse(logical.canonicalRequestJson) as {
      request?: { prompt?: string };
    };
    const prompt = request.request?.prompt ?? "";
    const attemptId = randomUUID();
    const marker =
      `[stagepass-run:${logical.runCorrelationId}:attempt:${attemptId}]`;
    const now = this.now().toISOString();
    try {
      this.database.insert(codexFollowerStartAttempts).values({
        attemptId,
        logicalTurnId,
        runCorrelationId: logical.runCorrelationId,
        pipelineJobId: context.jobId,
        projectAiRunId: null,
        workerId: context.workerId,
        leaseToken: context.leaseToken,
        ownerAttempt: context.attemptNo,
        ownerEpoch: context.attemptNo,
        threadId: binding.threadId,
        purpose: "interaction_wakeup",
        dispatchSurface: "host_ui_message",
        normalizedPromptHash: digest(`${prompt}\n\n${marker}`),
        correlationMarker: marker,
        cwd: process.cwd(),
        model: null,
        reasoningEffort: null,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        preStartTurnIdsJson: "[]",
        preStartSemanticHash: digest("[]"),
        state: "prepared",
        dispatchOrdinal: 0,
        dispatchCount: 0,
        budgetDeadline: job.effectDeadlineAt!,
        recoveryEpoch: 0,
        preparedAt: now,
      }).run();
    } catch {
      const won = this.database.select().from(codexFollowerStartAttempts)
        .where(eq(codexFollowerStartAttempts.logicalTurnId, logicalTurnId)).get();
      if (won) return won;
      throw new InteractionWakeupError("interaction_wakeup_prepare_failed");
    }
    return this.database.select().from(codexFollowerStartAttempts)
      .where(eq(codexFollowerStartAttempts.attemptId, attemptId)).get()!;
  }

  private claimDispatch(
    attemptId: string,
    context: JobExecutionContext,
  ): number {
    return this.database.transaction((tx) => {
      const attempt = tx.select().from(codexFollowerStartAttempts)
        .where(eq(codexFollowerStartAttempts.attemptId, attemptId)).get();
      if (
        !attempt
        || attempt.pipelineJobId !== context.jobId
        || attempt.workerId !== context.workerId
        || attempt.leaseToken !== context.leaseToken
        || attempt.ownerAttempt !== context.attemptNo
        || attempt.state !== "prepared"
      ) throw new InteractionWakeupError("stale_start_attempt_fence");
      const dispatchOrdinal = attempt.dispatchOrdinal + 1;
      const changed = tx.update(codexFollowerStartAttempts).set({
        state: "dispatching",
        dispatchOrdinal,
        dispatchCount: attempt.dispatchCount + 1,
        dispatchedAt: this.now().toISOString(),
      }).where(and(
        eq(codexFollowerStartAttempts.attemptId, attemptId),
        eq(codexFollowerStartAttempts.state, "prepared"),
        eq(codexFollowerStartAttempts.dispatchOrdinal, attempt.dispatchOrdinal),
      )).run().changes;
      if (changed !== 1) {
        throw new InteractionWakeupError("stale_start_attempt_fence");
      }
      return dispatchOrdinal;
    });
  }

  private recordSuccess(
    attemptId: string,
    context: JobExecutionContext,
    dispatchOrdinal: number,
    turnId: string,
  ): void {
    const changed = this.database.update(codexFollowerStartAttempts).set({
      state: "succeeded",
      followerTurnId: turnId,
      lastResult: "started",
      completedAt: this.now().toISOString(),
    }).where(and(
      eq(codexFollowerStartAttempts.attemptId, attemptId),
      eq(codexFollowerStartAttempts.pipelineJobId, context.jobId),
      eq(codexFollowerStartAttempts.workerId, context.workerId),
      eq(codexFollowerStartAttempts.leaseToken, context.leaseToken),
      eq(codexFollowerStartAttempts.ownerAttempt, context.attemptNo),
      eq(codexFollowerStartAttempts.state, "dispatching"),
      eq(codexFollowerStartAttempts.dispatchOrdinal, dispatchOrdinal),
    )).run().changes;
    if (changed !== 1) {
      throw new InteractionWakeupError("stale_start_attempt_fence");
    }
  }

  private recordAmbiguousIfDispatching(
    logicalTurnId: string,
    context: JobExecutionContext,
    error: unknown,
  ): void {
    this.database.update(codexFollowerStartAttempts).set({
      state: "ambiguous",
      lastResult: "unknown_response",
      lastErrorCode: error instanceof Error
        ? error.message.slice(0, 80)
        : "host_continuation_failed",
    }).where(and(
      eq(codexFollowerStartAttempts.logicalTurnId, logicalTurnId),
      eq(codexFollowerStartAttempts.pipelineJobId, context.jobId),
      eq(codexFollowerStartAttempts.workerId, context.workerId),
      eq(codexFollowerStartAttempts.leaseToken, context.leaseToken),
      eq(codexFollowerStartAttempts.state, "dispatching"),
    )).run();
  }
}
