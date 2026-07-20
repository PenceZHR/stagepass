import {
  findStructuralGarbage,
  nullableField,
  findStructuralBlockError,
  scanProtocolLines,
  splitFields,
} from "./ai-line-protocol";
import type {
  BlueGapReview,
  BlueRequirementGap,
} from "./spec-battle-ledger";

/**
 * Line-oriented output protocol for the spec battle blue critique
 * (REQUIREMENT_CRITIC). Shared primitives live in ai-line-protocol.ts; the
 * project rule is that models never author JSON.
 *
 * The assembled payload's shape is byte-for-byte what BlueCritiqueOutputSchema
 * and completeBlueCritique() already consume — only the authoring changes.
 */

export interface SpecCritiqueLinePayload {
  gapReviews: BlueGapReview[];
  requirementGaps: BlueRequirementGap[];
}

export type SpecCritiqueLineProtocolResult =
  | { ok: true; payload: SpecCritiqueLinePayload }
  | { ok: false; message: string };

const VERDICTS = new Set(["resolved", "still_open", "downgraded", "needs_human_decision"]);
const SEVERITIES = new Set(["P0", "P1", "P2"]);
const DOWNGRADE_TARGETS = new Set(["P1", "P2"]);

const KEYWORDS = ["REVIEW", "GAP", "ARTIFACT", "CRITIQUE_DONE"] as const;

const REVIEW_FIELDS = 6;
const GAP_FIELDS = 6;
const ARTIFACT_FIELDS = 2;

/** Ids key a cross-round upsert, so they must survive verbatim round-tripping. */
function validateCanonicalGapId(value: string): string | null {
  if (!value) return "canonicalGapId is empty";
  const garbage = findStructuralGarbage(value);
  if (garbage) return `canonicalGapId ${garbage}`;
  if (/\s/.test(value)) return "canonicalGapId contains whitespace (it must be a short stable id)";
  return null;
}

export function parseSpecCritiqueLineProtocol(rawText: string): SpecCritiqueLineProtocolResult {
  const structural = findStructuralBlockError(rawText, []);
  if (structural) return { ok: false, message: `spec critique line protocol rejected: ${structural}` };
  const gapReviews: BlueGapReview[] = [];
  const gaps: Array<Omit<BlueRequirementGap, "affectedArtifacts">> = [];
  const artifactsByGapId = new Map<string, string[]>();
  const doneMarkers: string[] = [];
  const errors: string[] = [];

  for (const { lineNo, keyword, rest } of scanProtocolLines(rawText, KEYWORDS)) {
    if (keyword === "CRITIQUE_DONE") {
      if (rest === "true") doneMarkers.push(rest);
      else errors.push(`line ${lineNo}: CRITIQUE_DONE must be true, got "${rest}"`);
      continue;
    }

    if (keyword === "REVIEW") {
      const fields = splitFields(rest);
      if (fields.length !== REVIEW_FIELDS) {
        errors.push(
          `line ${lineNo}: REVIEW needs exactly ${REVIEW_FIELDS} "|" fields (canonicalGapId | verdict | reviewSummary | evidence | resolutionEvidence 或 - | downgradedTo 或 -), got ${fields.length}. 文本字段不得含 "|"`,
        );
        continue;
      }
      const [canonicalGapId, verdict, reviewSummary, evidence, resolutionRaw, downgradedRaw] = fields as [
        string, string, string, string, string, string,
      ];
      const idError = validateCanonicalGapId(canonicalGapId);
      if (idError) {
        errors.push(`line ${lineNo}: REVIEW ${idError}`);
        continue;
      }
      if (!VERDICTS.has(verdict)) {
        errors.push(
          `line ${lineNo}: REVIEW verdict must be resolved/still_open/downgraded/needs_human_decision, got "${verdict}"`,
        );
        continue;
      }
      if (!reviewSummary) {
        errors.push(`line ${lineNo}: REVIEW reviewSummary is empty`);
        continue;
      }
      if (!evidence) {
        errors.push(`line ${lineNo}: REVIEW evidence is empty`);
        continue;
      }
      const resolutionEvidence = nullableField(resolutionRaw);
      const downgradedTo = nullableField(downgradedRaw);
      if ((verdict === "resolved" || verdict === "downgraded") && !resolutionEvidence) {
        errors.push(`line ${lineNo}: REVIEW ${verdict} verdict requires resolutionEvidence`);
        continue;
      }
      // A downgraded verdict without a target silently updates nothing in
      // completeBlueCritique() — the gap stays open and un-evaluated. Refuse it
      // here instead of letting the round no-op.
      if (verdict === "downgraded" && !DOWNGRADE_TARGETS.has(downgradedTo ?? "")) {
        errors.push(
          `line ${lineNo}: REVIEW downgraded verdict requires downgradedTo P1 or P2, got "${downgradedRaw}"`,
        );
        continue;
      }
      if (verdict !== "downgraded" && downgradedTo !== null) {
        errors.push(
          `line ${lineNo}: REVIEW downgradedTo must be - unless the verdict is downgraded, got "${downgradedRaw}"`,
        );
        continue;
      }
      gapReviews.push({
        canonicalGapId,
        verdict: verdict as BlueGapReview["verdict"],
        reviewSummary,
        evidence,
        resolutionEvidence,
        downgradedTo: downgradedTo as BlueGapReview["downgradedTo"],
      });
      continue;
    }

    if (keyword === "GAP") {
      const fields = splitFields(rest);
      if (fields.length !== GAP_FIELDS) {
        errors.push(
          `line ${lineNo}: GAP needs exactly ${GAP_FIELDS} "|" fields (canonicalGapId | title | category | P0/P1/P2 | evidence | proposedSpecPatch 或 -), got ${fields.length}. 文本字段不得含 "|"`,
        );
        continue;
      }
      const [canonicalGapId, title, category, severity, evidence, patchRaw] = fields as [
        string, string, string, string, string, string,
      ];
      const idError = validateCanonicalGapId(canonicalGapId);
      if (idError) {
        errors.push(`line ${lineNo}: GAP ${idError}`);
        continue;
      }
      if (!title) {
        errors.push(`line ${lineNo}: GAP title is empty`);
        continue;
      }
      if (!category) {
        errors.push(`line ${lineNo}: GAP category is empty`);
        continue;
      }
      if (!SEVERITIES.has(severity)) {
        errors.push(`line ${lineNo}: GAP severity must be P0/P1/P2, got "${severity}"`);
        continue;
      }
      if (!evidence) {
        errors.push(`line ${lineNo}: GAP evidence is empty`);
        continue;
      }
      gaps.push({
        canonicalGapId,
        title,
        category,
        severity: severity as BlueRequirementGap["severity"],
        evidence,
        proposedSpecPatch: nullableField(patchRaw),
        // completeBlueCritique() ignores whatever the model claims here and
        // recomputes both flags from the severity rules (isSpecBlockingGap /
        // isMergeBlockingGap). Deriving them reproduces the documented rule
        // (P0/P1 block, P2 does not) without asking the model for a value that
        // is discarded anyway.
        specBlocking: severity !== "P2",
        mergeBlocking: severity !== "P2",
      });
      continue;
    }

    // ARTIFACT
    const fields = splitFields(rest);
    if (fields.length !== ARTIFACT_FIELDS) {
      errors.push(
        `line ${lineNo}: ARTIFACT needs exactly ${ARTIFACT_FIELDS} "|" fields (canonicalGapId | artifactPath), got ${fields.length}`,
      );
      continue;
    }
    const [canonicalGapId, artifact] = fields as [string, string];
    if (!artifact) {
      errors.push(`line ${lineNo}: ARTIFACT path is empty`);
      continue;
    }
    const artifactGarbage = findStructuralGarbage(artifact);
    if (artifactGarbage) {
      errors.push(`line ${lineNo}: ARTIFACT path ${artifactGarbage}: ${artifact}`);
      continue;
    }
    const existing = artifactsByGapId.get(canonicalGapId);
    if (existing) existing.push(artifact);
    else artifactsByGapId.set(canonicalGapId, [artifact]);
  }

  const gapIds = new Set(gaps.map((gap) => gap.canonicalGapId));
  for (const canonicalGapId of artifactsByGapId.keys()) {
    if (!gapIds.has(canonicalGapId)) {
      errors.push(`ARTIFACT references unknown GAP canonicalGapId "${canonicalGapId}"`);
    }
  }
  const duplicateGapIds = gaps
    .map((gap) => gap.canonicalGapId)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateGapIds.length > 0) {
    errors.push(`duplicate GAP canonicalGapId: ${Array.from(new Set(duplicateGapIds)).join(", ")}`);
  }
  // Two REVIEW lines for the same gap carry contradictory verdicts (resolved vs
  // still_open) that both survive into completeBlueCritique's cross-round upsert.
  const duplicateReviewIds = gapReviews
    .map((review) => review.canonicalGapId)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateReviewIds.length > 0) {
    errors.push(`duplicate REVIEW canonicalGapId: ${Array.from(new Set(duplicateReviewIds)).join(", ")}`);
  }

  // Both arrays may legitimately be empty (no prior gaps to recheck, no new
  // gaps found), so an empty payload cannot itself prove the model followed the
  // protocol. Without this marker a prose-only reply would settle the round as
  // a clean critique. It is written last, so a truncated reply loses it too.
  if (doneMarkers.length !== 1) {
    errors.push(`expected exactly 1 CRITIQUE_DONE: true line, got ${doneMarkers.length}`);
  }

  if (errors.length > 0) {
    return { ok: false, message: `spec critique line protocol rejected: ${errors.join("; ")}` };
  }

  return {
    ok: true,
    payload: {
      gapReviews,
      requirementGaps: gaps.map((gap) => ({
        ...gap,
        affectedArtifacts: artifactsByGapId.get(gap.canonicalGapId) ?? [],
      })),
    },
  };
}
