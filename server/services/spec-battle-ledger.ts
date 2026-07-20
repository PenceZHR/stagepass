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
const BlueReviewVerdictSchema = z.enum([
  "resolved",
  "still_open",
  "downgraded",
  "needs_human_decision",
]);
const DowngradedToSchema = z.enum(["P1", "P2"]).nullable();

const RedFixClaimSchema = z
  .object({
    canonicalGapId: z.string(),
    claimStatus: RedClaimStatusSchema,
    claimSummary: z.string(),
    evidence: z.string(),
    artifactPath: z.string().nullable().default(null),
  })
  .strict();

const BlueGapReviewSchema = z
  .object({
    canonicalGapId: z.string(),
    verdict: BlueReviewVerdictSchema,
    reviewSummary: z.string(),
    evidence: z.string(),
    resolutionEvidence: z.string().nullable(),
    downgradedTo: DowngradedToSchema,
  })
  .strict();

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

const RedSpecOutputSchema = z.object({
  prdDeltaMarkdown: z.string(),
  fixClaims: z.array(RedFixClaimSchema).default([]),
});

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
export type BlueGapReview = BlueGapReviewInput;
export type BlueRequirementGap = BlueRequirementGapInput;

export interface ParsedRedSpecOutput {
  prdDeltaMarkdown: string;
  fixClaims: RedFixClaimInput[];
}

export interface ParsedBlueCritiqueOutput {
  gapReviews: BlueGapReviewInput[];
  requirementGaps: BlueRequirementGapInput[];
}

export interface ComputeRoundDeltaInput {
  roundId: string;
  previousBlockingGaps: LedgerGap[];
  fixClaims: RedFixClaimInput[];
  gapReviews: BlueGapReviewInput[];
  newGaps: BlueRequirementGapInput[];
}

export interface RoundDelta {
  roundId: string;
  resolvedThisRound: LedgerGap[];
  stillOpen: LedgerGap[];
  newlyFound: BlueRequirementGapInput[];
  notRechecked: LedgerGap[];
  fixClaims: RedFixClaimInput[];
  gapReviews: BlueGapReviewInput[];
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

function effectiveSeverity(gap: Pick<LedgerGap, "severity" | "downgradedTo">): Severity {
  return gap.downgradedTo ?? gap.severity;
}

export function parseRedSpecOutput(raw: string): ParsedRedSpecOutput {
  try {
    return RedSpecOutputSchema.parse(parseJson(raw));
  } catch {
    return {
      prdDeltaMarkdown: raw,
      fixClaims: [],
    };
  }
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
