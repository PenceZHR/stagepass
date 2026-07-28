import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db } from "../db";
import {
  codexFollowerStartAttempts,
  codexInteractions,
  codexLogicalTurns,
  codexThreadBindings,
  events,
  pipelineJobs,
} from "../db/schema";
import type { AiRunResult } from "./ai-engine-types";
import { classifyStageConvergence } from "./stage-convergence-service";
import {
  attachCodexBindingRunAttempt,
  releaseCodexBindingRunLease,
  waitForCodexBindingRunLease,
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
  /** Watches the dispatched continuation turn to a terminal snapshot. */
  observeTurn?: (logicalTurnId: string) => Promise<AiRunResult>;
  /** Persists a converged reply as the stage's formal result. */
  adoptResult?: (input: {
    changeId: string;
    phase: string;
    result: AiRunResult;
    context: JobExecutionContext;
  }) => Promise<void>;
}

export type InteractionWakeupConvergence =
  | "converged"
  | "already_adopted"
  | "asked_again"
  | "inconclusive";

function adoptionEventId(commandId: string): string {
  return `EV-STAGE-ADOPT-${commandId}`;
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
    convergence: InteractionWakeupConvergence;
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
        prompt: identity.prompt,
        sandboxMode: "read-only",
      },
    });
    this.allocateOrdinal(jobId, context, logical.logicalTurnId);
    const start = await readLogicalTurnForStart(logical.logicalTurnId);
    // Wait rather than fail: the previous batch's wakeup holds this binding
    // while it watches its own continuation turn, so a human who answers the
    // next card before that turn settles would otherwise be told their
    // selection did not take.
    const bindingLease = await waitForCodexBindingRunLease({
      logicalTurnId: logical.logicalTurnId,
      workerId: context.workerId,
      ownerLeaseToken: context.leaseToken,
      ownerAttempt: context.attemptNo,
      ownerEpoch: context.attemptNo,
      deadlineAt: start.fence.deadlineAt,
    });
    const dispatched = await (async () => {
      try {
      const attempt = this.prepareAttempt(logical.logicalTurnId, context);
      if (attempt.state === "succeeded" && attempt.followerTurnId) {
        return {
          status: "already_dispatched" as const,
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
        status: "dispatched" as const,
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
    })();

    return {
      ...dispatched,
      convergence: await this.settleConvergence({
        jobId,
        context,
        identity,
        logicalTurnId: dispatched.logicalTurnId,
      }),
    };
  }

  /**
   * Watch the continuation turn and, if the task stopped asking, persist what
   * it produced as the stage's formal result.
   *
   * The clarification loop owns the Codex task across many batches, so no stage
   * job is alive to ingest the answer when it finally arrives: this wakeup is
   * the only owner still holding a lease over the turn that produced it.
   */
  private async settleConvergence(input: {
    jobId: string;
    context: JobExecutionContext;
    identity: { phase: string; commandId: string; changeId: string };
    logicalTurnId: string;
  }): Promise<InteractionWakeupConvergence> {
    const observeTurn = this.dependencies.observeTurn ?? (async (id: string) => {
      const { createProductionCodexDesktopEngine } = await import(
        "./codex-desktop-engine"
      );
      return (await createProductionCodexDesktopEngine())
        .observeDispatchedTurn(id);
    });
    const observed = await observeTurn(input.logicalTurnId);
    const classified = classifyStageConvergence(observed);
    // Why a stage did or did not finish is the first question anyone asks when
    // a card loop stalls, and it is invisible in the job row.
    this.recordConvergenceObservation(input.identity, classified.kind, observed);
    if (classified.kind !== "converged") return classified.kind;
    if (this.alreadyAdopted(input.identity.commandId)) return "already_adopted";

    const adoptResult = this.dependencies.adoptResult ?? (async (adoption) => {
      const { adoptConvergedStageResult } = await import(
        "./stage-result-adoption-service"
      );
      await adoptConvergedStageResult(adoption);
    });
    await adoptResult({
      changeId: input.identity.changeId,
      phase: input.identity.phase,
      result: observed,
      context: input.context,
    });
    this.recordAdoption(input.identity);
    return "converged";
  }

  private recordConvergenceObservation(
    identity: { changeId: string; commandId: string; phase: string },
    kind: string,
    observed: AiRunResult,
  ): void {
    this.database.insert(events).values({
      id: `EV-CONV-${randomUUID()}`,
      changeId: identity.changeId,
      runId: null,
      type: "stage_convergence_observed",
      message: `${identity.phase} continuation turn observed as ${kind}`,
      rawJson: JSON.stringify({
        commandId: identity.commandId,
        kind,
        success: observed.success,
        providerErrorCode: observed.providerErrorCode ?? null,
        summaryChars: (observed.summary ?? "").length,
        itemTypes: (observed.items ?? []).map((item) => item.type),
      }),
      createdAt: this.now().toISOString(),
    }).run();
  }

  private alreadyAdopted(commandId: string): boolean {
    return Boolean(
      this.database.select().from(events)
        .where(eq(events.id, adoptionEventId(commandId))).get(),
    );
  }

  private recordAdoption(identity: {
    changeId: string;
    commandId: string;
    phase: string;
  }): void {
    this.database.insert(events).values({
      id: adoptionEventId(identity.commandId),
      changeId: identity.changeId,
      runId: null,
      type: "stage_result_adopted",
      message: `Codex task converged and produced the ${identity.phase} result`,
      rawJson: JSON.stringify({
        commandId: identity.commandId,
        phase: identity.phase,
      }),
      createdAt: this.now().toISOString(),
    }).onConflictDoNothing().run();
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
    let prompt =
      `StagePass decision ${job.commandId} was saved for interaction `
      + `${job.interactionId}. Continue this same task from the `
      + "authoritative Server state.";
    if (interaction.kind === "requirement_choice") {
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(interaction.payloadJson);
        payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
      } catch {
        throw new InteractionWakeupError(
          "interaction_wakeup_identity_invalid",
        );
      }
      if (
        payload.schemaVersion === "stagepass.choice-receipt/v2"
        && Array.isArray(payload.answers)
      ) {
        const answers = payload.answers.map((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new InteractionWakeupError(
              "interaction_wakeup_identity_invalid",
            );
          }
          const answer = value as Record<string, unknown>;
          const selectedOptionIds = Array.isArray(answer.selectedOptionIds)
            ? answer.selectedOptionIds.filter(
                (selected): selected is string => typeof selected === "string",
              )
            : [];
          const selectedLabels = Array.isArray(answer.selectedLabels)
            ? answer.selectedLabels.filter(
                (selected): selected is string => typeof selected === "string",
              )
            : [];
          if (
            typeof answer.questionId !== "string"
            || !answer.questionId
            || typeof answer.question !== "string"
            || !answer.question
            || selectedOptionIds.length === 0
            || selectedOptionIds.length !== selectedLabels.length
          ) {
            throw new InteractionWakeupError(
              "interaction_wakeup_identity_invalid",
            );
          }
          return {
            questionId: answer.questionId,
            question: answer.question,
            selectedOptionIds,
            selectedLabels,
          };
        });
        if (
          answers.length < 1
          || answers.length > 10
          || new Set(answers.map((answer) => answer.questionId)).size
            !== answers.length
        ) {
          throw new InteractionWakeupError(
            "interaction_wakeup_identity_invalid",
          );
        }
        prompt = [
          "STAGEPASS_SELECTION_CONFIRMED",
          `interactionId=${String(payload.cardInteractionId ?? interaction.id)}`,
          `stage=${interaction.phase}`,
          `answersJson=${JSON.stringify(answers)}`,
          "",
          "用户已经逐题提交本批 StagePass 具体问题。先按问题简短整理本批答案，并把决定纳入当前阶段。",
          "然后重新检查是否仍有阻塞运行的问题：如果有，立即再次调用 present_stagepass_choices，在同一个 Codex 任务中展示下一批具体问题，每批最多 10 个，不要改成普通文本提问，也不要重复已回答的问题。",
          "如果没有阻塞项，停止提问并继续完成当前阶段。只有没有阻塞项时才输出该阶段的正式结果。",
        ].join("\n");
      } else {
        const selectedOptionIds = Array.isArray(payload.selectedOptionIds)
          ? payload.selectedOptionIds.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        const selectedLabels = Array.isArray(payload.selectedLabels)
          ? payload.selectedLabels.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        if (
          selectedOptionIds.length === 0
          || selectedOptionIds.length !== selectedLabels.length
        ) {
          throw new InteractionWakeupError(
            "interaction_wakeup_identity_invalid",
          );
        }
        prompt = [
          "STAGEPASS_SELECTION_CONFIRMED",
          `interactionId=${String(payload.cardInteractionId ?? interaction.id)}`,
          `stage=${interaction.phase}`,
          `selectedOptionIds=${JSON.stringify(selectedOptionIds)}`,
          `selectedLabels=${JSON.stringify(selectedLabels)}`,
          "",
          "用户已经在 StagePass 卡片中明确勾选以上选项。请确认该选择，并在当前同一个 Codex 任务中继续执行；不要重新询问同一问题。",
        ].join("\n");
      }
    }
    return {
      phase: job.phase,
      changeId: job.changeId,
      interactionId: job.interactionId,
      commandId: job.commandId,
      prompt,
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
    if (existing) {
      // A re-leased job runs under a new attempt number, and every fence over
      // this row compares that number against the one it was stamped with. Its
      // turn is already dispatched and still the one to watch, so this owner
      // adopts the row rather than being told its own dispatch is stale.
      if (
        existing.ownerAttempt !== context.attemptNo
        || existing.ownerEpoch !== context.attemptNo
        || existing.workerId !== context.workerId
        || existing.leaseToken !== context.leaseToken
      ) {
        this.database.update(codexFollowerStartAttempts).set({
          workerId: context.workerId,
          leaseToken: context.leaseToken,
          ownerAttempt: context.attemptNo,
          ownerEpoch: context.attemptNo,
        }).where(and(
          eq(codexFollowerStartAttempts.attemptId, existing.attemptId),
          eq(codexFollowerStartAttempts.state, existing.state),
        )).run();
        return this.database.select().from(codexFollowerStartAttempts)
          .where(eq(codexFollowerStartAttempts.attemptId, existing.attemptId))
          .get()!;
      }
      return existing;
    }
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
