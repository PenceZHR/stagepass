import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { DEFAULT_AI_PROVIDER_TIMEOUT_MS } from "./ai-timeout-policy";
import {
  codexFollowerStartAttempts,
  codexInteractions,
  codexLogicalTurns,
  codexThreadBindings,
  events,
  pipelineCommandOutbox,
  pipelineCommandReceipts,
  pipelineJobs,
} from "../db/schema";
import { changeStageScopeId } from "./codex-desktop-bridge-types";
import { emitIdempotentEvent } from "./event-service";
import {
  approvalDecisionFromAnswers,
  executeStageApproval,
} from "./stage-approval-command-service";
import {
  PipelineCommandOutboxDispatcher,
} from "./pipeline-command-outbox-dispatcher";

interface StagePassChoiceReceiptCommon {
  receiptId: string;
  interactionId: string;
  idempotencyKey: string;
  logicalTurnId: string;
  projectId: string;
  changeId: string | null;
  threadId: string;
  stage: string | null;
  clientRecordedAt: string;
}

export interface StagePassSingleChoiceReceiptInput
  extends StagePassChoiceReceiptCommon {
  schemaVersion: "stagepass.choice-receipt/v1";
  question: string;
  selectedOptionIds: string[];
  selectedLabels: string[];
}

export interface StagePassBatchChoiceAnswer {
  questionId: string;
  question: string;
  selectedOptionIds: string[];
  selectedLabels: string[];
}

export interface StagePassBatchChoiceReceiptInput
  extends StagePassChoiceReceiptCommon {
  schemaVersion: "stagepass.choice-receipt/v2";
  batchTitle: string;
  answers: StagePassBatchChoiceAnswer[];
}

export type StagePassChoiceReceiptInput =
  | StagePassSingleChoiceReceiptInput
  | StagePassBatchChoiceReceiptInput;

export interface StagePassChoiceReceiptResult {
  status: "recorded";
  receiptId: string;
  acceptedAt: string;
  duplicate: boolean;
  continuationConfirmed: boolean;
  continuationThreadId: string;
  continuationTurnId: string | null;
  continuationErrorCode?: string;
}

export class StagePassChoiceReceiptError extends Error {
  constructor(
    readonly code:
      | "choice_receipt_logical_turn_not_found"
      | "choice_receipt_binding_not_found"
      | "choice_receipt_thread_mismatch"
      | "choice_receipt_scope_mismatch"
      | "choice_receipt_selection_invalid"
      | "choice_receipt_idempotency_conflict"
      | "choice_receipt_persistence_failed"
      | "choice_receipt_continuation_identity_invalid",
    readonly status = 409,
  ) {
    super(code);
    this.name = "StagePassChoiceReceiptError";
  }
}

function canonical(value: unknown): string {
  const stable = (child: unknown): unknown => {
    if (Array.isArray(child)) return child.map(stable);
    if (child && typeof child === "object") {
      return Object.fromEntries(
        Object.entries(child as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, stable(nested)]),
      );
    }
    return child;
  };
  return JSON.stringify(stable(value));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function eventId(input: StagePassChoiceReceiptInput): string {
  return `EVT-stagepass-choice-${hash(
    `${input.logicalTurnId}\0${input.idempotencyKey}`,
  ).slice(0, 32)}`;
}

function parseStored(rawJson: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawJson ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function selectionPairValid(
  selectedOptionIds: string[],
  selectedLabels: string[],
): boolean {
  return selectedOptionIds.length > 0
    && selectedOptionIds.length === selectedLabels.length
    && new Set(selectedOptionIds).size === selectedOptionIds.length;
}

function receiptSelectionsValid(input: StagePassChoiceReceiptInput): boolean {
  if (input.schemaVersion === "stagepass.choice-receipt/v1") {
    return selectionPairValid(
      input.selectedOptionIds,
      input.selectedLabels,
    );
  }
  if (input.answers.length < 1 || input.answers.length > 10) return false;
  const questionIds = input.answers.map((answer) => answer.questionId);
  return new Set(questionIds).size === questionIds.length
    && input.answers.every((answer) =>
      Boolean(answer.question.trim())
      && selectionPairValid(
        answer.selectedOptionIds,
        answer.selectedLabels,
      )
    );
}

function interactionPayload(input: StagePassChoiceReceiptInput) {
  if (input.schemaVersion === "stagepass.choice-receipt/v1") {
    return {
      schemaVersion: input.schemaVersion,
      cardInteractionId: input.interactionId,
      question: input.question,
      selectedOptionIds: input.selectedOptionIds,
      selectedLabels: input.selectedLabels,
      receiptId: input.receiptId,
    };
  }
  return {
    schemaVersion: input.schemaVersion,
    cardInteractionId: input.interactionId,
    batchTitle: input.batchTitle,
    answers: input.answers,
    receiptId: input.receiptId,
  };
}

interface StagePassChoiceContinuationInput {
  jobId: string;
  outboxEffectId: string;
  threadId: string;
}

export interface StagePassChoiceReceiptDependencies {
  now?(): Date;
  interactionId?(input: StagePassChoiceReceiptInput): string;
  commandId?(input: StagePassChoiceReceiptInput): string;
  dispatchAndWait?(
    input: StagePassChoiceContinuationInput,
  ): Promise<{ turnId: string } | null>;
}

const WAKEUP_EFFECT_BUDGET_MS = DEFAULT_AI_PROVIDER_TIMEOUT_MS;

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function dispatchAndWaitForContinuation(
  input: StagePassChoiceContinuationInput,
): Promise<{ turnId: string } | null> {
  await new PipelineCommandOutboxDispatcher().dispatch(input.outboxEffectId);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const logical = db.select().from(codexLogicalTurns).where(and(
      eq(codexLogicalTurns.pipelineJobId, input.jobId),
      eq(codexLogicalTurns.role, "interaction_wakeup"),
    )).get();
    const attempt = logical
      ? db.select().from(codexFollowerStartAttempts).where(
          eq(codexFollowerStartAttempts.logicalTurnId, logical.logicalTurnId),
        ).get()
      : null;
    if (
      attempt?.state === "succeeded"
      && attempt.threadId === input.threadId
      && attempt.followerTurnId
    ) {
      return { turnId: attempt.followerTurnId };
    }
    const job = db.select().from(pipelineJobs)
      .where(eq(pipelineJobs.id, input.jobId)).get();
    if (!job || ["failed", "canceled", "cancelled"].includes(job.status)) {
      return null;
    }
    await wait(200);
  }
  return null;
}

function defaultInteractionId(input: StagePassChoiceReceiptInput): string {
  return `INT-CARD-${hash(
    `${input.logicalTurnId}\0${input.interactionId}`,
  ).slice(0, 32)}`;
}

function defaultCommandId(input: StagePassChoiceReceiptInput): string {
  return `CMD-CARD-${hash(
    `${input.logicalTurnId}\0${input.idempotencyKey}`,
  ).slice(0, 32)}`;
}

function ensureContinuationControlPlane(input: {
  receipt: StagePassChoiceReceiptInput;
  requestHash: string;
  bindingId: string;
  phase: string;
  acceptedAt: string;
  preparedAt: string;
  interactionId: string;
  commandId: string;
}): { jobId: string; outboxEffectId: string } {
  const jobId = `PJOB-WAKE-${input.commandId}`;
  const outboxEffectId =
    `PCO-${input.commandId}-interaction_wakeup`;
  // The wakeup job no longer just delivers a message: it watches the
  // continuation turn and, when the task stops asking, ingests the stage
  // result. That budget has to cover a model writing a full stage document,
  // so it matches the document stage timeout rather than a delivery timeout.
  const deadlineAt = new Date(
    Date.parse(input.preparedAt) + WAKEUP_EFFECT_BUDGET_MS,
  ).toISOString();
  const effect = {
    schemaVersion: "stagepass.pipeline-effect/v1",
    kind: "interaction_wakeup",
    interactionId: input.interactionId,
    commandId: input.commandId,
  } as const;
  const payload = interactionPayload(input.receipt);

  db.transaction((tx) => {
    tx.insert(codexInteractions).values({
      id: input.interactionId,
      changeId: input.receipt.changeId!,
      bindingId: input.bindingId,
      codexThreadId: input.receipt.threadId,
      phase: input.phase,
      kind: "requirement_choice",
      gateVersion: 0,
      sourceDbHash: input.requestHash,
      payloadJson: JSON.stringify(payload),
      formJson: null,
      status: "completed",
      idempotencyKey: `card-choice:${input.requestHash}`,
      invocationNonceHash: null,
      sourceThreadId: input.receipt.threadId,
      nonceExpiresAt: null,
      nonceConsumedAt: input.acceptedAt,
      expectedHeadSha: null,
      requestHash: input.requestHash,
      supersededById: null,
      presentedAt: input.acceptedAt,
      completedAt: input.acceptedAt,
      expiresAt: deadlineAt,
      supersededAt: null,
      createdAt: input.acceptedAt,
      updatedAt: input.acceptedAt,
    }).onConflictDoNothing().run();
    tx.insert(pipelineCommandReceipts).values({
      commandId: input.commandId,
      changeId: input.receipt.changeId!,
      interactionId: input.interactionId,
      codexThreadId: input.receipt.threadId,
      action: "record_stagepass_choice",
      actorKind: "human",
      actorSurface: "codex_mcp_app",
      idempotencyKey: `card-choice-command:${input.requestHash}`,
      requestHash: input.requestHash,
      status: "completed",
      resultJson: JSON.stringify({
        status: "completed",
        receiptId: input.receipt.receiptId,
      }),
      errorCode: null,
      createdAt: input.acceptedAt,
      completedAt: input.acceptedAt,
    }).onConflictDoNothing().run();
    tx.insert(pipelineJobs).values({
      id: jobId,
      changeId: input.receipt.changeId!,
      phase: input.phase,
      actionId: "continue_stagepass_interaction",
      idempotencyKey: `interaction-wakeup:${input.commandId}`,
      status: "queued",
      attemptNo: 1,
      provider: "codex",
      jobKind: "interaction_wakeup",
      effectType: "interaction_wakeup",
      interactionId: input.interactionId,
      commandId: input.commandId,
      effectSchemaVersion: effect.schemaVersion,
      effectPayloadJson: JSON.stringify(effect),
      nextTurnOrdinal: 0,
      effectDeadlineAt: deadlineAt,
      createdAt: input.preparedAt,
    }).onConflictDoNothing().run();
    tx.insert(pipelineCommandOutbox).values({
      id: outboxEffectId,
      commandId: input.commandId,
      interactionId: input.interactionId,
      effectType: "interaction_wakeup",
      effectPayloadJson: JSON.stringify({ ...effect, pipelineJobId: jobId }),
      status: "pending",
      attemptCount: 0,
      lastErrorCode: null,
      createdAt: input.preparedAt,
      updatedAt: input.preparedAt,
      dispatchedAt: null,
    }).onConflictDoNothing().run();

    const interaction = tx.select().from(codexInteractions)
      .where(eq(codexInteractions.id, input.interactionId)).get();
    const command = tx.select().from(pipelineCommandReceipts)
      .where(eq(pipelineCommandReceipts.commandId, input.commandId)).get();
    const job = tx.select().from(pipelineJobs)
      .where(eq(pipelineJobs.id, jobId)).get();
    if (
      !interaction
      || interaction.changeId !== input.receipt.changeId
      || interaction.bindingId !== input.bindingId
      || interaction.codexThreadId !== input.receipt.threadId
      || interaction.requestHash !== input.requestHash
      || interaction.status !== "completed"
      || !command
      || command.interactionId !== input.interactionId
      || command.codexThreadId !== input.receipt.threadId
      || command.requestHash !== input.requestHash
      || command.status !== "completed"
      || !job
      || job.interactionId !== input.interactionId
      || job.commandId !== input.commandId
      || job.jobKind !== "interaction_wakeup"
    ) {
      throw new StagePassChoiceReceiptError(
        "choice_receipt_continuation_identity_invalid",
      );
    }
  });
  return { jobId, outboxEffectId };
}

export async function recordStagePassChoiceReceipt(
  input: StagePassChoiceReceiptInput,
  dependencies: StagePassChoiceReceiptDependencies = {},
): Promise<StagePassChoiceReceiptResult> {
  if (!receiptSelectionsValid(input)) {
    throw new StagePassChoiceReceiptError(
      "choice_receipt_selection_invalid",
      422,
    );
  }
  const logical = db.select().from(codexLogicalTurns)
    .where(eq(codexLogicalTurns.logicalTurnId, input.logicalTurnId))
    .get();
  if (!logical) {
    throw new StagePassChoiceReceiptError(
      "choice_receipt_logical_turn_not_found",
      404,
    );
  }
  const binding = db.select().from(codexThreadBindings)
    .where(eq(codexThreadBindings.bindingId, logical.bindingId))
    .get();
  if (!binding?.threadId) {
    throw new StagePassChoiceReceiptError(
      "choice_receipt_binding_not_found",
      404,
    );
  }
  if (binding.threadId !== input.threadId) {
    throw new StagePassChoiceReceiptError(
      "choice_receipt_thread_mismatch",
      403,
    );
  }
  const expectedChangeId =
    binding.scopeKind === "change" || binding.scopeKind === "change_stage"
      ? binding.changeId
      : null;
  // The scope id a receipt with these fields must belong to.
  //
  // A stage-scoped binding's scopeId is `${changeId}:${stageId}`, so comparing
  // it against `input.changeId` was unsatisfiable for every change_stage
  // binding: no card presented by a stage could ever be answered, and the user
  // saw 「提交失败」 on a card whose run was alive and waiting for it. The
  // receipt carries the stage it came from, so the compound id is rebuilt from
  // what the receipt claims and compared -- which still fails a receipt naming
  // the wrong stage, rather than passing everything.
  const receiptScopeId = binding.scopeKind === "change_stage"
    ? (input.changeId && input.stage
      ? changeStageScopeId(input.changeId, input.stage)
      : null)
    : (input.changeId ?? input.projectId);
  if (
    binding.projectId !== input.projectId
    || expectedChangeId !== input.changeId
    || binding.scopeId !== receiptScopeId
  ) {
    throw new StagePassChoiceReceiptError(
      "choice_receipt_scope_mismatch",
      403,
    );
  }

  const id = eventId(input);
  const requestHash = hash(canonical(input));
  const existing = db.select().from(events).where(eq(events.id, id)).get();
  let acceptedAt: string;
  let duplicate: boolean;
  if (existing) {
    const stored = parseStored(existing.rawJson);
    if (
      stored.requestHash !== requestHash
      || stored.receiptId !== input.receiptId
    ) {
      throw new StagePassChoiceReceiptError(
        "choice_receipt_idempotency_conflict",
      );
    }
    acceptedAt =
      typeof stored.backendAcceptedAt === "string"
        ? stored.backendAcceptedAt
        : existing.createdAt;
    duplicate = true;
  } else {
    acceptedAt = (dependencies.now?.() ?? new Date()).toISOString();
    const stored = {
      ...input,
      bindingId: binding.bindingId,
      requestHash,
      backendAcceptedAt: acceptedAt,
    };
    const inserted = emitIdempotentEvent({
      id,
      changeId: input.changeId,
      type: "codex_card_choice_recorded",
      message: "Codex card choice recorded by StagePass backend",
      rawJson: stored,
    });
    const authoritative = db.select().from(events).where(eq(events.id, id)).get();
    if (!authoritative) {
      throw new StagePassChoiceReceiptError(
        "choice_receipt_persistence_failed",
        500,
      );
    }
    const authoritativeStored = parseStored(authoritative.rawJson);
    if (
      authoritativeStored.requestHash !== requestHash
      || authoritativeStored.receiptId !== input.receiptId
    ) {
      throw new StagePassChoiceReceiptError(
        "choice_receipt_idempotency_conflict",
      );
    }
    acceptedAt =
      typeof authoritativeStored.backendAcceptedAt === "string"
        ? authoritativeStored.backendAcceptedAt
        : authoritative.createdAt;
    duplicate = !inserted;
  }

  const phase = input.stage?.trim() || logical.phase;
  // An approval card is the human clearing the gate, not another answer for
  // the model to summarize. It has to reach the gate as a real command, or the
  // click records a decision that never takes effect anywhere.
  if (input.schemaVersion === "stagepass.choice-receipt/v2") {
    const decision = approvalDecisionFromAnswers(phase, input.answers);
    if (decision) {
      await executeStageApproval({
        changeId: input.changeId!,
        phase,
        actionId: decision.actionId,
        idempotencyKey: `stage-approval:${input.logicalTurnId}:${input.idempotencyKey}`,
      });
    }
  }

  const control = ensureContinuationControlPlane({
    receipt: input,
    requestHash,
    bindingId: binding.bindingId,
    phase,
    acceptedAt,
    preparedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    interactionId:
      dependencies.interactionId?.(input) ?? defaultInteractionId(input),
    commandId: dependencies.commandId?.(input) ?? defaultCommandId(input),
  });
  let continuation: { turnId: string } | null = null;
  let continuationErrorCode: string | undefined;
  try {
    continuation = await (
      dependencies.dispatchAndWait ?? dispatchAndWaitForContinuation
    )({
      ...control,
      threadId: input.threadId,
    });
    if (!continuation) continuationErrorCode = "same_task_continuation_unproved";
  } catch (error) {
    continuationErrorCode = error instanceof Error
      ? error.message.slice(0, 120)
      : "same_task_continuation_failed";
  }

  return {
    status: "recorded",
    receiptId: input.receiptId,
    acceptedAt,
    duplicate,
    continuationConfirmed: Boolean(continuation?.turnId),
    continuationThreadId: input.threadId,
    continuationTurnId: continuation?.turnId ?? null,
    ...(continuationErrorCode ? { continuationErrorCode } : {}),
  };
}
