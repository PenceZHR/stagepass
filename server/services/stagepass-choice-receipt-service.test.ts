import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { and, eq } from "drizzle-orm";

import { db } from "../db";
import {
  changes,
  codexInteractions,
  codexLogicalTurns,
  codexThreadBindings,
  events,
  pipelineCommandOutbox,
  pipelineCommandReceipts,
  pipelineJobs,
  projects,
} from "../db/schema";
import {
  recordStagePassChoiceReceipt,
  StagePassChoiceReceiptError,
} from "./stagepass-choice-receipt-service";

const PROJECT_ID = "PRJ-CARD-RECEIPT";
const CHANGE_ID = "CHG-CARD-RECEIPT";
const BINDING_ID = "BIND-CARD-RECEIPT";
const JOB_ID = "PJOB-CARD-RECEIPT";
const LOGICAL_TURN_ID = "00000000-0000-4000-8000-000000000041";
const THREAD_ID = "00000000-0000-4000-8000-000000000042";

function cleanup() {
  db.delete(codexLogicalTurns)
    .where(eq(codexLogicalTurns.interactionId, "INT-CARD-RECEIPT"))
    .run();
  db.delete(pipelineCommandOutbox)
    .where(eq(pipelineCommandOutbox.interactionId, "INT-CARD-RECEIPT"))
    .run();
  db.delete(pipelineJobs)
    .where(eq(pipelineJobs.interactionId, "INT-CARD-RECEIPT"))
    .run();
  db.delete(pipelineCommandReceipts)
    .where(eq(pipelineCommandReceipts.interactionId, "INT-CARD-RECEIPT"))
    .run();
  db.delete(codexInteractions)
    .where(eq(codexInteractions.id, "INT-CARD-RECEIPT"))
    .run();
  db.delete(events).where(and(
    eq(events.changeId, CHANGE_ID),
    eq(events.type, "codex_card_choice_recorded"),
  )).run();
  db.delete(codexLogicalTurns)
    .where(eq(codexLogicalTurns.logicalTurnId, LOGICAL_TURN_ID))
    .run();
  db.delete(pipelineJobs).where(eq(pipelineJobs.id, JOB_ID)).run();
  db.delete(codexThreadBindings)
    .where(eq(codexThreadBindings.bindingId, BINDING_ID))
    .run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seed() {
  cleanup();
  const now = "2026-07-26T12:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Card receipt fixture",
    repoPath: "/tmp/stagepass-card-receipt",
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Verify card callback",
    status: "SPECCING",
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(codexThreadBindings).values({
    bindingId: BINDING_ID,
    scopeKind: "change",
    scopeId: CHANGE_ID,
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    threadId: THREAD_ID,
    title: "Visible Codex card task",
    status: "running",
    bridgeProtocolVersion: "stagepass-desktop-v1",
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(pipelineJobs).values({
    id: JOB_ID,
    changeId: CHANGE_ID,
    phase: "Spec",
    actionId: "run_spec",
    status: "running",
    createdAt: now,
  }).run();
  db.insert(codexLogicalTurns).values({
    logicalTurnId: LOGICAL_TURN_ID,
    pipelineJobId: JOB_ID,
    projectAiRunId: null,
    bindingId: BINDING_ID,
    interactionId: null,
    commandId: null,
    phase: "Spec",
    role: "stage",
    round: 0,
    ordinal: 0,
    turnSlot: "card-receipt-fixture",
    runCorrelationId: "card-receipt-correlation",
    canonicalRequestJson: "{}",
    canonicalRequestHash: "fixture",
    dispatchSurface: "follower_ipc",
    status: "running",
    createdAt: now,
    updatedAt: now,
  }).run();
}

function receipt(patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: "stagepass.choice-receipt/v1" as const,
    receiptId: "00000000-0000-4000-8000-000000000043",
    interactionId: "spec-question-1",
    idempotencyKey: "stagepass-choice:spec-question-1:focused",
    logicalTurnId: LOGICAL_TURN_ID,
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    threadId: THREAD_ID,
    stage: "Spec",
    question: "先做哪一档？",
    selectedOptionIds: ["focused"],
    selectedLabels: ["聚焦当前阶段"],
    clientRecordedAt: "2026-07-26T12:00:00.000Z",
    ...patch,
  };
}

function batchReceipt(patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: "stagepass.choice-receipt/v2" as const,
    receiptId: "00000000-0000-4000-8000-000000000044",
    interactionId: "spec-question-batch-1",
    idempotencyKey: "stagepass-choice:spec-question-batch-1:answers",
    logicalTurnId: LOGICAL_TURN_ID,
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    threadId: THREAD_ID,
    stage: "PRD",
    batchTitle: "第 1 批 · 运行前必须确认",
    answers: [
      {
        questionId: "target-player",
        question: "这个小游戏第一版主要给谁玩？",
        selectedOptionIds: ["solo"],
        selectedLabels: ["单人玩家"],
      },
      {
        questionId: "lose-condition",
        question: "哪些情况应立即判定失败？",
        selectedOptionIds: ["timeout", "collision"],
        selectedLabels: ["倒计时结束", "碰到障碍"],
      },
    ],
    clientRecordedAt: "2026-07-26T12:00:00.000Z",
    ...patch,
  };
}

afterEach(cleanup);

describe("StagePass choice receipt service", () => {
  it("persists one authoritative receipt and confirms one same-task continuation", async () => {
    seed();
    const dispatched: string[] = [];
    const dependencies = {
      now: () => new Date("2026-07-26T12:00:01.000Z"),
      interactionId: () => "INT-CARD-RECEIPT",
      commandId: () => "CMD-CARD-RECEIPT",
      async dispatchAndWait(input: { jobId: string; threadId: string }) {
        dispatched.push(input.jobId);
        assert.equal(input.threadId, THREAD_ID);
        return { turnId: "TURN-CARD-CONTINUATION" };
      },
    };
    const first = await recordStagePassChoiceReceipt(receipt(), dependencies);
    const duplicate = await recordStagePassChoiceReceipt(receipt(), dependencies);

    assert.equal(first.status, "recorded");
    assert.equal(first.duplicate, false);
    assert.equal(first.acceptedAt, "2026-07-26T12:00:01.000Z");
    assert.equal(first.continuationConfirmed, true);
    assert.equal(first.continuationThreadId, THREAD_ID);
    assert.equal(first.continuationTurnId, "TURN-CARD-CONTINUATION");
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.acceptedAt, first.acceptedAt);
    assert.equal(duplicate.continuationTurnId, first.continuationTurnId);
    assert.deepEqual(dispatched, [
      "PJOB-WAKE-CMD-CARD-RECEIPT",
      "PJOB-WAKE-CMD-CARD-RECEIPT",
    ]);

    const rows = db.select().from(events).where(and(
      eq(events.changeId, CHANGE_ID),
      eq(events.type, "codex_card_choice_recorded"),
    )).all();
    assert.equal(rows.length, 1);
    const stored = JSON.parse(rows[0].rawJson ?? "{}");
    assert.equal(stored.logicalTurnId, LOGICAL_TURN_ID);
    assert.equal(stored.threadId, THREAD_ID);
    assert.deepEqual(stored.selectedOptionIds, ["focused"]);

    const interactions = db.select().from(codexInteractions)
      .where(eq(codexInteractions.id, "INT-CARD-RECEIPT")).all();
    const wakeJobs = db.select().from(pipelineJobs)
      .where(eq(pipelineJobs.interactionId, "INT-CARD-RECEIPT")).all();
    assert.equal(interactions.length, 1);
    assert.equal(interactions[0]?.status, "completed");
    assert.equal(interactions[0]?.codexThreadId, THREAD_ID);
    assert.equal(wakeJobs.length, 1);
    assert.equal(wakeJobs[0]?.jobKind, "interaction_wakeup");
  });

  it("rejects a callback for a different visible Codex task", async () => {
    seed();
    await assert.rejects(
      recordStagePassChoiceReceipt(receipt({ threadId: "wrong-thread" })),
      (error) =>
        error instanceof StagePassChoiceReceiptError
        && error.code === "choice_receipt_thread_mismatch",
    );
  });

  it("persists question-to-answer mappings for a ten-question clarification batch", async () => {
    seed();
    await recordStagePassChoiceReceipt(batchReceipt(), {
      now: () => new Date("2026-07-26T12:00:01.000Z"),
      interactionId: () => "INT-CARD-RECEIPT",
      commandId: () => "CMD-CARD-RECEIPT",
      async dispatchAndWait() {
        return { turnId: "TURN-CARD-CONTINUATION" };
      },
    });

    const interaction = db.select().from(codexInteractions)
      .where(eq(codexInteractions.id, "INT-CARD-RECEIPT")).get();
    const payload = JSON.parse(interaction?.payloadJson ?? "{}");
    assert.equal(payload.schemaVersion, "stagepass.choice-receipt/v2");
    assert.equal(payload.answers.length, 2);
    assert.deepEqual(payload.answers[0], {
      questionId: "target-player",
      question: "这个小游戏第一版主要给谁玩？",
      selectedOptionIds: ["solo"],
      selectedLabels: ["单人玩家"],
    });
  });

  it("rejects a batch with duplicate question identifiers", async () => {
    seed();
    const duplicate = batchReceipt({
      answers: [
        {
          questionId: "same",
          question: "问题一？",
          selectedOptionIds: ["a"],
          selectedLabels: ["A"],
        },
        {
          questionId: "same",
          question: "问题二？",
          selectedOptionIds: ["b"],
          selectedLabels: ["B"],
        },
      ],
    });

    await assert.rejects(
      recordStagePassChoiceReceipt(duplicate),
      (error) =>
        error instanceof StagePassChoiceReceiptError
        && error.code === "choice_receipt_selection_invalid",
    );
  });

  it("rejects a different selection that reuses one idempotency key", async () => {
    seed();
    const dependencies = {
      interactionId: () => "INT-CARD-RECEIPT",
      commandId: () => "CMD-CARD-RECEIPT",
      async dispatchAndWait() {
        return { turnId: "TURN-CARD-CONTINUATION" };
      },
    };
    await recordStagePassChoiceReceipt(receipt(), dependencies);
    await assert.rejects(
      recordStagePassChoiceReceipt(receipt({
        selectedOptionIds: ["extended"],
        selectedLabels: ["扩展范围"],
      }), dependencies),
      (error) =>
        error instanceof StagePassChoiceReceiptError
        && error.code === "choice_receipt_idempotency_conflict",
    );
  });
});
