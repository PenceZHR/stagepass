import crypto from "node:crypto";

import { z } from "zod";

export const BriefingQuestionCategorySchema = z.enum([
  "goal",
  "user",
  "scope",
  "success",
  "negative_case",
  "risk",
  "constraint",
  "spec_blocker",
]);

export const BriefingQuestionSeveritySchema = z.enum(["critical", "important", "optional"]);
export const BriefingQuestionStatusSchema = z.enum([
  "open",
  "answered",
  "assumption_accepted",
  "deferred",
]);

const BriefingQuestionInputSchema = z
  .object({
    category: BriefingQuestionCategorySchema,
    severity: BriefingQuestionSeveritySchema,
    question: z.string().min(1),
    whyItMatters: z.string().min(1),
    suggestedDefault: z.string().nullable().default(null),
  })
  .strict();

export const BriefingQuestionsOutputSchema = z
  .object({
    unit: z.string().optional(),
    changeId: z.string().optional(),
    phase: z.string().optional(),
    questions: z.array(BriefingQuestionInputSchema),
  })
  .strict();

export const PrdBriefingDraftOutputSchema = z
  .object({
    markdown: z.string().min(1),
  })
  .strict();

export const FinalReviewOutputSchema = z
  .object({
    unit: z.string().optional(),
    verdict: z.enum(["ready", "needs_answer", "risky_but_allowed"]),
    blockingQuestionIds: z.array(z.string()).default([]),
    riskSummary: z.string(),
    recommendedNextAction: z.enum(["lock_prd", "answer_questions", "cancel_change"]),
  })
  .strict();

export type BriefingQuestionInput = z.infer<typeof BriefingQuestionInputSchema>;
export type BriefingQuestionsOutput = z.infer<typeof BriefingQuestionsOutputSchema>;
export type PrdBriefingDraftOutput = z.infer<typeof PrdBriefingDraftOutputSchema>;
export type FinalReviewOutput = z.infer<typeof FinalReviewOutputSchema>;

export interface ParsedBriefingQuestionsOutput {
  questions: BriefingQuestionInput[];
}

export interface GateQuestion {
  id: string;
  severity: "critical" | "important" | "optional";
  status: "open" | "answered" | "assumption_accepted" | "deferred";
}

export interface PrdGateResult {
  canLock: boolean;
  blockingQuestionIds: string[];
  deferredQuestionIds: string[];
  clarityLevel: "low" | "medium" | "high";
  riskLevel: "low" | "medium" | "high";
  draftFresh: boolean;
  finalReviewFresh: boolean;
  finalReviewVerdict: FinalReviewOutput["verdict"] | null;
}

/**
 * The recorded input hashes a briefing stamps onto `prd_briefings.sourceHashesJson`
 * when a step completes. A step's output is *fresh* while the hash it was stamped
 * with still equals the briefing's current input hash.
 */
export interface PrdBriefingSourceHashes {
  currentInputHash?: string;
  draftInputHash?: string;
  finalReviewInputHash?: string;
  finalReviewDraftHash?: string;
}

export interface PrdBriefingInputQuestion {
  id: string;
  category: string;
  severity: string;
  question: string;
  whyItMatters: string;
  suggestedDefault: string | null;
  status: string;
  answer: string | null;
  /** Sort key only -- deliberately NOT hashed. See prdBriefingInputHash. */
  createdAt: string;
}

export interface PrdBriefingInputSource {
  intentText: string;
}

/**
 * The question-card shape that feeds the PRD *stage* source hash
 * (computeSourceDbHash over `briefing_questions`), as opposed to the briefing
 * *input* hash above. Both PRD callers -- prd-briefing-service, which stamps
 * the gate, and spec-battle-service, which re-derives it and refuses a stale
 * PRD baseline -- must project rows through here so they cannot drift.
 *
 * `roundNo` is deliberately NOT projected, for the same reason `createdAt` is
 * excluded from prdBriefingInputHash: it is immutable for the life of a card
 * and carries no state the hash does not already see. A new round only ever
 * ADDS rows, and those rows move the digest on their own; an existing card's
 * round never changes, so there is nothing for the hash to detect. Including
 * it would have re-digested every card already on disk and invalidated every
 * stamped gate -- measured, not assumed: on the production database the stored
 * PRD gate for the locked change is 0ab2ffe4..., which this projection still
 * reproduces exactly, while hashing roundNo alongside it yields 2c39ab40... .
 * That gate belongs to a locked PRD with a Spec battle already in flight, and
 * assertLockedPrdDbBaseline turns any mismatch into prd_gate_stale, so the
 * difference is the difference between a working pipeline and a wedged one.
 *
 * Row ORDER is normalized here rather than trusted from the caller, exactly as
 * prdBriefingInputHash does and for the same reason -- computeSourceDbHash sorts
 * only its OUTER row list; `sortForStableJson` maps over an inner array and
 * keeps its order, so the sequence a caller hands in lands in the digest. The
 * two callers did not agree on one: prd-briefing-service reads cards through
 * getQuestions, ordered by (roundNo, createdAt, id), while spec-battle-service
 * ordered by (createdAt, id). Cards are written with a single hoisted
 * `createdAt` per round, so two rounds generated inside the same millisecond
 * share it and the tie-break falls to ids ending in random bytes -- the two
 * orders then differ, the same rows hash to two digests, and
 * assertLockedPrdDbBaseline reports prd_gate_stale against a PRD nothing
 * touched. Sorting here makes ordering a property of the hash instead of an
 * invariant each caller has to remember. Legacy rows are uniformly round 1,
 * where (roundNo, createdAt, id) and (createdAt, id) coincide, so every digest
 * already stamped on disk is reproduced byte for byte.
 */
export interface PrdStageHashQuestion {
  id: string;
  changeId: string;
  category: string;
  severity: string;
  question: string;
  whyItMatters: string;
  suggestedDefault: string | null;
  status: string;
  answer: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the callers read out of `briefing_questions`: the projected shape plus
 * the `roundNo` that orders it. Wider than the output on purpose -- the round
 * decides the sequence but is not itself hashed.
 */
export type PrdStageHashQuestionSource = PrdStageHashQuestion & { roundNo: number };

export function prdStageHashQuestionRows(
  questions: PrdStageHashQuestionSource[],
): PrdStageHashQuestion[] {
  return [...questions].sort(
    (a, b) =>
      a.roundNo - b.roundNo
      || a.createdAt.localeCompare(b.createdAt)
      || a.id.localeCompare(b.id),
  ).map((question) => ({
    id: question.id,
    changeId: question.changeId,
    category: question.category,
    severity: question.severity,
    question: question.question,
    whyItMatters: question.whyItMatters,
    suggestedDefault: question.suggestedDefault,
    status: question.status,
    answer: question.answer,
    source: question.source,
    createdAt: question.createdAt,
    updatedAt: question.updatedAt,
  }));
}

/**
 * The single definition of "what a PRD briefing step consumed": the human intent
 * plus every question card, content and status included. Answering a question
 * moves this hash, which is what makes an already-generated draft stale.
 *
 * Pure and row-shaped on purpose. Both the write path (prd-briefing-service,
 * which stamps and enforces it) and the read path (provider-action-authority-
 * service, which must report the same verdict /gate would get from a POST) hash
 * through here, so the two cannot drift into disagreeing about freshness.
 *
 * Row ORDER is normalized here rather than trusted from the caller, and that is
 * load-bearing. Sharing the hash body was not enough: the write path handed in
 * rows sorted by (createdAt, id) while the read path handed in a bare `.all()`
 * in rowid order, so the two hashed the same cards into different digests and
 * every briefing reported its draft permanently stale. Cards are written with a
 * single hoisted `createdAt`, so the tie-break falls to ids that end in random
 * bytes -- sorted order is a random permutation of insertion order, and the two
 * callers agreed only by 1/n! luck. An invariant every caller must remember is
 * one caller away from breaking; this makes ordering a property of the hash.
 *
 * `createdAt` is a sort key and is deliberately NOT part of the hashed payload:
 * including it would change every digest and invalidate every stamped hash on
 * record. Sorting the rows the write path already sorted keeps the output
 * byte-identical, so existing stamps stay valid with no migration.
 */
export function prdBriefingInputHash(
  briefing: PrdBriefingInputSource | null | undefined,
  questions: PrdBriefingInputQuestion[],
): string {
  const ordered = [...questions].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  return crypto.createHash("sha256").update(JSON.stringify({
    intentText: briefing?.intentText ?? "",
    questions: ordered.map((question) => ({
      id: question.id,
      category: question.category,
      severity: question.severity,
      question: question.question,
      whyItMatters: question.whyItMatters,
      suggestedDefault: question.suggestedDefault,
      status: question.status,
      answer: question.answer,
    })),
  })).digest("hex");
}

/** Tolerant reader for the stamped hashes: an absent or corrupt blob is "nothing stamped". */
export function readPrdBriefingSourceHashes(raw: string | null | undefined): PrdBriefingSourceHashes {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function parseBriefingQuestionsOutput(raw: string): ParsedBriefingQuestionsOutput {
  const parsed = BriefingQuestionsOutputSchema.parse(JSON.parse(raw));
  return { questions: parsed.questions };
}

export function parseFinalReviewOutput(raw: string): FinalReviewOutput {
  return FinalReviewOutputSchema.parse(JSON.parse(raw));
}

export function applyQuestionAction(input: {
  action: "answer" | "accept_assumption" | "defer";
  value: string;
}): { status: "answered" | "assumption_accepted" | "deferred"; answer: string } {
  const value = input.value.trim();
  if (!value) throw new Error("Question action requires a non-empty value");

  if (input.action === "answer") return { status: "answered", answer: value };
  if (input.action === "accept_assumption") {
    return { status: "assumption_accepted", answer: value };
  }
  return { status: "deferred", answer: value };
}

export function computePrdGate(input: {
  hasDraft: boolean;
  draftFresh: boolean;
  questions: GateQuestion[];
  finalReview?: {
    fresh: boolean;
    verdict: FinalReviewOutput["verdict"] | null;
    blockingQuestionIds: string[];
  };
  locked?: boolean;
}): PrdGateResult {
  const openCriticalQuestionIds = input.questions
    .filter((question) => question.severity === "critical" && question.status === "open")
    .map((question) => question.id);
  const finalReview = input.finalReview ?? {
    fresh: false,
    verdict: null,
    blockingQuestionIds: [],
  };
  const finalReviewBlocks = finalReview.fresh
    && (
      finalReview.verdict === "needs_answer"
      || finalReview.blockingQuestionIds.length > 0
    );
  const blockingQuestionIds = Array.from(new Set([
    ...openCriticalQuestionIds,
    ...(finalReviewBlocks ? finalReview.blockingQuestionIds : []),
  ]));
  const deferredQuestionIds = input.questions
    .filter((question) => question.status === "deferred")
    .map((question) => question.id);
  const answered = input.questions.filter((question) => question.status !== "open").length;
  const clarityRatio = input.questions.length === 0 ? 0 : answered / input.questions.length;
  const criticalOpen = openCriticalQuestionIds.length;
  const importantDeferred = input.questions.filter(
    (question) => question.severity === "important" && question.status === "deferred"
  ).length;
  const finalReviewAllowsLock = finalReview.fresh
    && (finalReview.verdict === "ready" || finalReview.verdict === "risky_but_allowed")
    && finalReview.blockingQuestionIds.length === 0;
  const canLock = Boolean(input.locked)
    || (
      input.hasDraft
      && input.draftFresh
      && openCriticalQuestionIds.length === 0
      && finalReviewAllowsLock
    );

  return {
    canLock,
    blockingQuestionIds,
    deferredQuestionIds,
    clarityLevel: clarityRatio >= 0.8 ? "high" : clarityRatio >= 0.5 ? "medium" : "low",
    riskLevel: criticalOpen > 0 || finalReviewBlocks ? "high" : importantDeferred > 0 ? "medium" : "low",
    draftFresh: input.draftFresh,
    finalReviewFresh: finalReview.fresh,
    finalReviewVerdict: finalReview.verdict,
  };
}
