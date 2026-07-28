import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  handleStagePassChoiceReceipt,
  type StagePassChoiceReceiptRouteDependencies,
} from "./route";
import { StagePassChoiceReceiptError } from "@/server/services/stagepass-choice-receipt-service";

function body() {
  return {
    schemaVersion: "stagepass.choice-receipt/v1",
    receiptId: "00000000-0000-4000-8000-000000000043",
    interactionId: "spec-question-1",
    idempotencyKey: "stagepass-choice:spec-question-1:focused",
    logicalTurnId: "00000000-0000-4000-8000-000000000041",
    projectId: "PRJ-004",
    changeId: "CHG-006",
    threadId: "00000000-0000-4000-8000-000000000042",
    stage: "Spec",
    question: "先做哪一档？",
    selectedOptionIds: ["focused"],
    selectedLabels: ["聚焦当前阶段"],
    clientRecordedAt: "2026-07-26T12:00:00.000Z",
  };
}

function batchBody(questionCount = 2) {
  return {
    schemaVersion: "stagepass.choice-receipt/v2",
    receiptId: "00000000-0000-4000-8000-000000000044",
    interactionId: "spec-question-batch-1",
    idempotencyKey: "stagepass-choice:spec-question-batch-1:answers",
    logicalTurnId: "00000000-0000-4000-8000-000000000041",
    projectId: "PRJ-004",
    changeId: "CHG-006",
    threadId: "00000000-0000-4000-8000-000000000042",
    stage: "PRD",
    batchTitle: "第 1 批 · 运行前必须确认",
    answers: Array.from({ length: questionCount }, (_, index) => ({
      questionId: `question-${index + 1}`,
      question: `具体问题 ${index + 1}？`,
      selectedOptionIds: [`option-${index + 1}`],
      selectedLabels: [`选择 ${index + 1}`],
    })),
    clientRecordedAt: "2026-07-26T12:00:00.000Z",
  } as const;
}

function request(value: unknown, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3000/api/codex/card-choice-receipts", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  });
}

describe("Codex card choice receipt API", () => {
  it("returns the authoritative backend acknowledgement", async () => {
    let recorded: unknown = null;
    const dependencies: StagePassChoiceReceiptRouteDependencies = {
      record(input) {
        recorded = input;
        return Promise.resolve({
          status: "recorded",
          receiptId: input.receiptId,
          acceptedAt: "2026-07-26T12:00:01.000Z",
          duplicate: false,
          continuationConfirmed: true,
          continuationThreadId: input.threadId,
          continuationTurnId: "TURN-CARD-CONTINUATION",
        });
      },
    };
    const response = await handleStagePassChoiceReceipt(
      request(body()),
      dependencies,
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "recorded");
    assert.deepEqual(recorded, body());
  });

  it("rejects malformed or browser-originated submissions", async () => {
    const dependencies: StagePassChoiceReceiptRouteDependencies = {
      async record() {
        throw new Error("must_not_run");
      },
    };
    const malformed = await handleStagePassChoiceReceipt(
      request({ interactionId: "missing-contract" }),
      dependencies,
    );
    const browser = await handleStagePassChoiceReceipt(
      request(body(), { origin: "http://evil.test" }),
      dependencies,
    );

    assert.equal(malformed.status, 422);
    assert.equal(browser.status, 403);
  });

  it("preserves stable service conflict codes", async () => {
    const response = await handleStagePassChoiceReceipt(request(body()), {
      async record() {
        throw new StagePassChoiceReceiptError(
          "choice_receipt_idempotency_conflict",
          409,
        );
      },
    });

    assert.equal(response.status, 409);
    assert.equal(
      (await response.json()).error,
      "choice_receipt_idempotency_conflict",
    );
  });

  it("accepts at most ten concrete question answers in one batch", async () => {
    let recorded: unknown = null;
    const dependencies: StagePassChoiceReceiptRouteDependencies = {
      record(input) {
        recorded = input;
        return Promise.resolve({
          status: "recorded",
          receiptId: input.receiptId,
          acceptedAt: "2026-07-26T12:00:01.000Z",
          duplicate: false,
          continuationConfirmed: true,
          continuationThreadId: input.threadId,
          continuationTurnId: "TURN-CARD-CONTINUATION",
        });
      },
    };

    const accepted = await handleStagePassChoiceReceipt(
      request(batchBody(10)),
      dependencies,
    );
    const rejected = await handleStagePassChoiceReceipt(
      request(batchBody(11)),
      dependencies,
    );

    assert.equal(accepted.status, 200);
    assert.equal(
      (recorded as ReturnType<typeof batchBody>).answers.length,
      10,
    );
    assert.equal(rejected.status, 422);
  });
});
