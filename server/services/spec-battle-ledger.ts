import { z } from "zod";

export type Severity = "P0" | "P1" | "P2";
export type GapStatus = "open" | "resolved" | "waived" | "downgraded" | "overridden";
export type RedClaimStatus =
  | "fixed"
  | "partially_fixed"
  | "not_fixed"
  | "needs_human_decision";
export type BlueReviewVerdict =
  | "resolved"
  | "still_open"
  | "downgraded"
  | "needs_human_decision";

const SeveritySchema = z.enum(["P0", "P1", "P2"]);
const RedClaimStatusSchema = z.enum([
  "fixed",
  "partially_fixed",
  "not_fixed",
  "needs_human_decision",
]);
const DowngradeTargetSchema = z.enum(["P1", "P2"]);

const RedFixClaimSchema = z
  .object({
    canonicalGapId: z.string(),
    claimStatus: RedClaimStatusSchema,
    claimSummary: z.string(),
    evidence: z.string(),
    artifactPath: z.string().nullable().default(null),
  })
  .strict();

const blueGapReviewFields = {
  canonicalGapId: z.string(),
  reviewSummary: z.string(),
  evidence: z.string(),
  resolutionEvidence: z.string().nullable(),
};

/**
 * verdict and downgradedTo are one fact, not two independent fields.
 *
 * As two fields, a null downgradedTo had two readings that no code could tell
 * apart: "this is not a downgrade" (true of every other verdict) and "this IS a
 * downgrade, and the target is missing". completeBlueCritique() branched on the
 * first reading -- `verdict === "downgraded" && review.downgradedTo` -- and its
 * still_open branch excluded the verdict, so the second reading matched neither.
 * The round then wrote the blue_gap_reviews row, recorded verdict "downgraded",
 * closed the round to report_ready, and updated requirement_gaps not at all: the
 * gap stayed open, stayed spec-blocking, and kept the PREVIOUS round's
 * lastEvaluatedRoundId. The generated report printed "[downgraded]" and
 * "[P0/open/blocks-spec]" for one gap in one document, with no error and no
 * event to say a whole round had done nothing.
 *
 * A discriminated union makes the pair inseparable: "downgraded" is the only
 * verdict that carries a target, and it always carries one. The illegal
 * combination is now unconstructible in TypeScript and rejected by the parser,
 * so it can neither be written by hand nor arrive from a provider.
 *
 * The line-protocol parser already refused this (spec-critique-line-protocol.ts),
 * but it was the only thing that did, and the production call site hands
 * completeBlueCritique an assembled payload rather than protocol text.
 */
const withoutDowngradeTarget = <V extends Exclude<BlueReviewVerdict, "downgraded">>(verdict: V) =>
  z.object({ ...blueGapReviewFields, verdict: z.literal(verdict), downgradedTo: z.null() }).strict();

const BlueGapReviewSchema = z.discriminatedUnion("verdict", [
  z
    .object({
      ...blueGapReviewFields,
      verdict: z.literal("downgraded"),
      downgradedTo: DowngradeTargetSchema,
    })
    .strict(),
  // One option per verdict rather than one option with a three-verdict enum:
  // narrowing a union of object types down to `never` is what lets an
  // unhandled verdict fail to compile, and a single option whose discriminant
  // is an enum narrows the property without ever collapsing the object.
  withoutDowngradeTarget("resolved"),
  withoutDowngradeTarget("still_open"),
  withoutDowngradeTarget("needs_human_decision"),
]);

const BlueRequirementGapSchema = z
  .object({
    canonicalGapId: z.string(),
    title: z.string(),
    category: z.string(),
    severity: SeveritySchema,
    evidence: z.string(),
    affectedArtifacts: z.array(z.string()),
    proposedSpecPatch: z.string().nullable(),
    specBlocking: z.boolean(),
    mergeBlocking: z.boolean(),
  })
  .strict();

/**
 * The deterministically assembled red line-protocol payload.
 *
 * Strict, unlike the RedSpecOutputSchema it replaces: that one tolerated
 * unknown keys, and that tolerance is the only reason production ever survived.
 * spec.md told the model to emit `unit`/`changeId`/`phase`, three fields the
 * schema never declared; zod stripped them instead of rejecting, so
 * parseRedSpecOutput's bare catch went unreached by luck rather than by design.
 *
 * `markdown` rather than `prdDeltaMarkdown` because the document stage runner
 * writes .md artifacts from `structuredOutput.markdown`; see
 * spec-red-line-protocol.ts. It is non-empty because this string IS prd-delta.md.
 */
const RedSpecLinePayloadSchema = z
  .object({
    markdown: z.string().min(1),
    fixClaims: z.array(RedFixClaimSchema).default([]),
  })
  .strict();

export function validateRedSpecLinePayload(value: unknown) {
  return RedSpecLinePayloadSchema.safeParse(value);
}

export const RED_SPEC_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["markdown", "fixClaims"],
  properties: {
    markdown: { type: "string", minLength: 1 },
    fixClaims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          canonicalGapId: { type: "string" },
          claimStatus: {
            type: "string",
            enum: ["fixed", "partially_fixed", "not_fixed", "needs_human_decision"],
          },
          claimSummary: { type: "string" },
          evidence: { type: "string" },
          artifactPath: { type: ["string", "null"] },
        },
        required: [
          "canonicalGapId",
          "claimStatus",
          "claimSummary",
          "evidence",
          "artifactPath",
        ],
      },
    },
  },
};

export const BlueCritiqueOutputSchema = z.object({
  gapReviews: z.array(BlueGapReviewSchema),
  requirementGaps: z.array(BlueRequirementGapSchema),
}).strict();

export const BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["gapReviews", "requirementGaps"],
  properties: {
    gapReviews: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          canonicalGapId: { type: "string" },
          verdict: {
            type: "string",
            enum: ["resolved", "still_open", "downgraded", "needs_human_decision"],
          },
          reviewSummary: { type: "string" },
          evidence: { type: "string" },
          resolutionEvidence: { type: ["string", "null"] },
          downgradedTo: { type: ["string", "null"], enum: ["P1", "P2", null] },
        },
        required: [
          "canonicalGapId",
          "verdict",
          "reviewSummary",
          "evidence",
          "resolutionEvidence",
          "downgradedTo",
        ],
      },
    },
    requirementGaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          canonicalGapId: { type: "string" },
          title: { type: "string" },
          category: { type: "string" },
          severity: { type: "string", enum: ["P0", "P1", "P2"] },
          evidence: { type: "string" },
          affectedArtifacts: { type: "array", items: { type: "string" } },
          proposedSpecPatch: { type: ["string", "null"] },
          specBlocking: { type: "boolean" },
          mergeBlocking: { type: "boolean" },
        },
        required: [
          "canonicalGapId",
          "title",
          "category",
          "severity",
          "evidence",
          "affectedArtifacts",
          "proposedSpecPatch",
          "specBlocking",
          "mergeBlocking",
        ],
      },
    },
  },
};

export interface LedgerGap {
  id: string;
  canonicalGapId: string;
  severity: Severity;
  originalSeverity: Severity;
  downgradedTo: "P1" | "P2" | null;
  status: GapStatus;
  firstSeenRoundId: string;
  lastEvaluatedRoundId: string;
}

export type RedFixClaimInput = z.infer<typeof RedFixClaimSchema>;
export type BlueGapReviewInput = z.infer<typeof BlueGapReviewSchema>;
export type BlueRequirementGapInput = z.infer<typeof BlueRequirementGapSchema>;
export type RedFixClaim = RedFixClaimInput;
export type BlueRequirementGap = BlueRequirementGapInput;

/**
 * The shape a line-protocol assembler builds field by field, BEFORE the schema
 * has run: verdict and downgradedTo are read out of two separate text fields,
 * and a `Set.has()` check on each cannot prove to the compiler that the two
 * agree. Widening exactly those two fields -- and deriving the rest from
 * BlueGapReviewInput so they cannot drift -- keeps assembly expressible without
 * handing the widened pair to the ledger: every assembled payload is re-parsed
 * by BlueCritiqueOutputSchema, and only BlueGapReviewInput (the discriminated
 * union) is accepted past that point.
 */
export type BlueGapReview = Omit<BlueGapReviewInput, "verdict" | "downgradedTo"> & {
  verdict: BlueReviewVerdict;
  downgradedTo: "P1" | "P2" | null;
};

export interface ParsedRedSpecOutput {
  prdDeltaMarkdown: string;
  fixClaims: RedFixClaimInput[];
}

export interface ParsedBlueCritiqueOutput {
  gapReviews: BlueGapReviewInput[];
  requirementGaps: BlueRequirementGapInput[];
}

/**
 * Reviews here are rehydrated from blue_gap_reviews rows, not handed over by a
 * provider, so they carry the widened shape: the columns are plain text and a
 * row written before the verdict/target pair was inseparable can still be read
 * back. computeRoundDelta only reads canonicalGapId and verdict, so widening
 * costs it nothing -- and refusing to re-validate history here keeps a report
 * of an old round renderable.
 */
export interface ComputeRoundDeltaInput {
  roundId: string;
  previousBlockingGaps: LedgerGap[];
  fixClaims: RedFixClaimInput[];
  gapReviews: BlueGapReview[];
  newGaps: BlueRequirementGapInput[];
}

export interface RoundDelta {
  roundId: string;
  resolvedThisRound: LedgerGap[];
  stillOpen: LedgerGap[];
  newlyFound: BlueRequirementGapInput[];
  notRechecked: LedgerGap[];
  fixClaims: RedFixClaimInput[];
  gapReviews: BlueGapReview[];
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

function effectiveSeverity(gap: Pick<LedgerGap, "severity" | "downgradedTo">): Severity {
  return gap.downgradedTo ?? gap.severity;
}

export function parseBlueCritiqueOutput(raw: string): ParsedBlueCritiqueOutput {
  return BlueCritiqueOutputSchema.parse(parseJson(raw));
}

export function validateBlueCritiqueOutput(value: unknown) {
  return BlueCritiqueOutputSchema.safeParse(value);
}

export function activeSpecBlocking(gap: LedgerGap): boolean {
  const severity = effectiveSeverity(gap);

  if (gap.status === "resolved") return false;
  if (gap.status === "overridden") return false;
  if (gap.status === "waived" && severity === "P1") return false;

  return severity === "P0" || severity === "P1";
}

export function computeRoundDelta(input: ComputeRoundDeltaInput): RoundDelta {
  const reviewsByCanonicalGapId = new Map(
    input.gapReviews.map((review) => [review.canonicalGapId, review])
  );
  const resolvedThisRound: LedgerGap[] = [];
  const stillOpen: LedgerGap[] = [];
  const notRechecked: LedgerGap[] = [];

  for (const gap of input.previousBlockingGaps) {
    const review = reviewsByCanonicalGapId.get(gap.canonicalGapId);

    if (!review) {
      notRechecked.push(gap);
      stillOpen.push(gap);
      continue;
    }

    if (review.verdict === "resolved") {
      resolvedThisRound.push(gap);
      continue;
    }

    stillOpen.push(gap);
  }

  return {
    roundId: input.roundId,
    resolvedThisRound,
    stillOpen,
    newlyFound: input.newGaps,
    notRechecked,
    fixClaims: input.fixClaims,
    gapReviews: input.gapReviews,
  };
}
