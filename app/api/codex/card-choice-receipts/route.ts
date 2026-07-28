import { NextResponse } from "next/server";
import { z } from "zod";

import { createChildLogger } from "@/server/logger";
import {
  recordStagePassChoiceReceipt,
  StagePassChoiceReceiptError,
  type StagePassChoiceReceiptInput,
  type StagePassChoiceReceiptResult,
} from "@/server/services/stagepass-choice-receipt-service";

const log = createChildLogger("card-choice-receipts");

const MAX_OPTIONS = 8;
const MAX_QUESTIONS = 10;
const RECEIPT_V1_SCHEMA = z.object({
  schemaVersion: z.literal("stagepass.choice-receipt/v1"),
  receiptId: z.string().uuid(),
  interactionId: z.string().trim().min(1).max(256),
  idempotencyKey: z.string().trim().min(1).max(512),
  logicalTurnId: z.string().trim().min(1).max(256),
  projectId: z.string().trim().min(1).max(256),
  changeId: z.string().trim().min(1).max(256).nullable(),
  threadId: z.string().trim().min(1).max(256),
  stage: z.string().trim().min(1).max(128).nullable(),
  question: z.string().trim().min(1).max(8_000),
  selectedOptionIds: z.array(
    z.string().trim().min(1).max(128),
  ).min(1).max(MAX_OPTIONS),
  selectedLabels: z.array(
    z.string().trim().min(1).max(512),
  ).min(1).max(MAX_OPTIONS),
  clientRecordedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.selectedOptionIds.length !== value.selectedLabels.length) {
    context.addIssue({
      code: "custom",
      message: "selection_labels_mismatch",
      path: ["selectedLabels"],
    });
  }
  if (new Set(value.selectedOptionIds).size !== value.selectedOptionIds.length) {
    context.addIssue({
      code: "custom",
      message: "duplicate_selection",
      path: ["selectedOptionIds"],
    });
  }
});

const BATCH_ANSWER_SCHEMA = z.object({
  questionId: z.string().trim().min(1).max(128),
  question: z.string().trim().min(1).max(8_000),
  selectedOptionIds: z.array(
    z.string().trim().min(1).max(128),
  ).min(1).max(MAX_OPTIONS),
  selectedLabels: z.array(
    z.string().trim().min(1).max(512),
  ).min(1).max(MAX_OPTIONS),
}).strict().superRefine((value, context) => {
  if (value.selectedOptionIds.length !== value.selectedLabels.length) {
    context.addIssue({
      code: "custom",
      message: "selection_labels_mismatch",
      path: ["selectedLabels"],
    });
  }
  if (new Set(value.selectedOptionIds).size !== value.selectedOptionIds.length) {
    context.addIssue({
      code: "custom",
      message: "duplicate_selection",
      path: ["selectedOptionIds"],
    });
  }
});

const RECEIPT_V2_SCHEMA = z.object({
  schemaVersion: z.literal("stagepass.choice-receipt/v2"),
  receiptId: z.string().uuid(),
  interactionId: z.string().trim().min(1).max(256),
  idempotencyKey: z.string().trim().min(1).max(512),
  logicalTurnId: z.string().trim().min(1).max(256),
  projectId: z.string().trim().min(1).max(256),
  changeId: z.string().trim().min(1).max(256).nullable(),
  threadId: z.string().trim().min(1).max(256),
  stage: z.string().trim().min(1).max(128).nullable(),
  batchTitle: z.string().trim().min(1).max(512),
  answers: z.array(BATCH_ANSWER_SCHEMA).min(1).max(MAX_QUESTIONS),
  clientRecordedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  const questionIds = value.answers.map((answer) => answer.questionId);
  if (new Set(questionIds).size !== questionIds.length) {
    context.addIssue({
      code: "custom",
      message: "duplicate_question_id",
      path: ["answers"],
    });
  }
});

const RECEIPT_SCHEMA = z.union([
  RECEIPT_V1_SCHEMA,
  RECEIPT_V2_SCHEMA,
]);

export interface StagePassChoiceReceiptRouteDependencies {
  record(
    input: StagePassChoiceReceiptInput,
  ): Promise<StagePassChoiceReceiptResult>;
}

const defaultDependencies: StagePassChoiceReceiptRouteDependencies = {
  record: recordStagePassChoiceReceipt,
};

export async function handleStagePassChoiceReceipt(
  request: Request,
  dependencies: StagePassChoiceReceiptRouteDependencies = defaultDependencies,
): Promise<NextResponse> {
  if (request.headers.get("origin")) {
    return NextResponse.json(
      { error: "choice_receipt_browser_origin_forbidden" },
      { status: 403 },
    );
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return NextResponse.json(
      { error: "choice_receipt_json_required" },
      { status: 415 },
    );
  }
  try {
    const input = RECEIPT_SCHEMA.parse(await request.json());
    return NextResponse.json(await dependencies.record(input));
  } catch (error) {
    if (error instanceof StagePassChoiceReceiptError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status },
      );
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "invalid_choice_receipt" },
        { status: 422 },
      );
    }
    // Name the underlying failure. The plugin turns any non-2xx into 「提交失败，
    // 请重试」, so an unclassified 500 left both the user and whoever debugs it
    // with a card that fails for no stated reason -- and the reason is usually
    // a gate refusing the command, which retrying cannot change.
    log.error(
      { err: error },
      "StagePass choice receipt failed outside the classified errors",
    );
    return NextResponse.json(
      {
        error: "choice_receipt_record_failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return handleStagePassChoiceReceipt(request);
}
