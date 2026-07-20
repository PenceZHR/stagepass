import {
  collectSingletonBlock,
  findStructuralBlockError,
  nullableField,
  scanProtocolLines,
  splitFields,
  validateRepoRelativePath,
} from "./ai-line-protocol";
import type {
  PriorFindingReviewVerdict,
  ReviewFindingSeverity,
  ReviewStructuredOutput,
} from "./review-structured-output-parser";

/**
 * Line-oriented output protocol for the review stage.
 *
 * FINDING / PRIOR / APPROVED lines plus a single SUMMARY<< … >>SUMMARY block are
 * parsed deterministically into the ReviewStructuredOutput shape the settlement
 * path (parseReviewStructuredOutput / completeReviewAttemptFromStructuredOutput)
 * already consumes — the model never authors review JSON. This kills the
 * "model corrupts the review-output JSON / a repair pass fixes syntax but not
 * semantics" failure class: any prose JSON (declared, fenced, or written to the
 * review-output.json candidate file) is refused instead of resurrected.
 *
 * The assembled payload's object/field shape is byte-for-byte what
 * REVIEW_OUTPUT_SCHEMA and the review parser expect; only its authoring changes.
 */

export type ReviewLineProtocolResult =
  | { ok: true; payload: ReviewStructuredOutput }
  | { ok: false; message: string };

const SEVERITIES = new Set<ReviewFindingSeverity>(["P0", "P1", "P2"]);
const PRIOR_VERDICTS = new Set<PriorFindingReviewVerdict>([
  "still_open",
  "fixed",
  "downgraded",
  "not_reviewable",
  "not_rechecked",
]);

const KEYWORDS = ["FINDING", "PRIOR", "APPROVED"] as const;

const FINDING_FIELDS = 7;
const PRIOR_FIELDS = 6;

function parseLineNumber(value: string): number | null | "invalid" {
  const nullable = nullableField(value);
  if (nullable === null) return null;
  if (!/^\d+$/.test(nullable)) return "invalid";
  const parsed = Number(nullable);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : "invalid";
}

export function parseReviewLineProtocol(rawText: string): ReviewLineProtocolResult {
  const structural = findStructuralBlockError(rawText, ["SUMMARY"]);
  if (structural) {
    return { ok: false, message: `review line protocol rejected: ${structural}` };
  }
  const findings: ReviewStructuredOutput["findings"] = [];
  const priorFindingReviews: ReviewStructuredOutput["priorFindingReviews"] = [];
  const approvals: boolean[] = [];
  const errors: string[] = [];

  for (const { lineNo, keyword, rest } of scanProtocolLines(rawText, KEYWORDS)) {
    if (keyword === "APPROVED") {
      if (rest === "true") approvals.push(true);
      else if (rest === "false") approvals.push(false);
      else errors.push(`line ${lineNo}: APPROVED must be true or false, got "${rest}"`);
      continue;
    }

    if (keyword === "FINDING") {
      const fields = splitFields(rest);
      if (fields.length !== FINDING_FIELDS) {
        errors.push(
          `line ${lineNo}: FINDING needs exactly ${FINDING_FIELDS} "|" fields (severity | category | file 或 - | line 或 - | title | evidence | requiredFix 或 -), got ${fields.length}. 文本字段不得含 "|"`,
        );
        continue;
      }
      const [severity, category, file, lineField, title, evidenceRaw, requiredFixRaw] = fields as [
        string, string, string, string, string, string, string,
      ];
      if (!SEVERITIES.has(severity as ReviewFindingSeverity)) {
        errors.push(`line ${lineNo}: FINDING severity must be P0/P1/P2, got "${severity}"`);
        continue;
      }
      if (!category) {
        errors.push(`line ${lineNo}: FINDING category is empty`);
        continue;
      }
      if (!title) {
        errors.push(`line ${lineNo}: FINDING title is empty`);
        continue;
      }
      const evidence = nullableField(evidenceRaw);
      if (!evidence) {
        errors.push(`line ${lineNo}: FINDING evidence is empty (every finding requires evidence)`);
        continue;
      }
      const fileValue = nullableField(file);
      if (fileValue !== null) {
        const pathError = validateRepoRelativePath(fileValue);
        if (pathError) {
          errors.push(`line ${lineNo}: FINDING file ${pathError}: ${fileValue}`);
          continue;
        }
      }
      const lineValue = parseLineNumber(lineField);
      if (lineValue === "invalid") {
        errors.push(`line ${lineNo}: FINDING line must be a non-negative integer or -, got "${lineField}"`);
        continue;
      }
      const requiredFix = nullableField(requiredFixRaw);
      if ((severity === "P0" || severity === "P1") && !requiredFix) {
        errors.push(`line ${lineNo}: ${severity} FINDING requires a non-empty requiredFix`);
        continue;
      }
      findings.push({
        severity: severity as ReviewFindingSeverity,
        category,
        file: fileValue,
        line: lineValue,
        title,
        evidence,
        requiredFix,
      });
      continue;
    }

    // PRIOR
    const fields = splitFields(rest);
    if (fields.length !== PRIOR_FIELDS) {
      errors.push(
        `line ${lineNo}: PRIOR needs exactly ${PRIOR_FIELDS} "|" fields (priorFindingId | verdict | evidence 或 - | requiredFix 或 - | replacementFindingId 或 - | reviewerNotes 或 -), got ${fields.length}. 文本字段不得含 "|"`,
      );
      continue;
    }
    const [priorFindingId, verdict, evidenceRaw, requiredFixRaw, replacementRaw, notesRaw] = fields as [
      string, string, string, string, string, string,
    ];
    if (!priorFindingId) {
      errors.push(`line ${lineNo}: PRIOR priorFindingId is empty`);
      continue;
    }
    if (!PRIOR_VERDICTS.has(verdict as PriorFindingReviewVerdict)) {
      errors.push(
        `line ${lineNo}: PRIOR verdict must be still_open/fixed/downgraded/not_reviewable/not_rechecked, got "${verdict}"`,
      );
      continue;
    }
    const evidence = nullableField(evidenceRaw);
    const requiredFix = nullableField(requiredFixRaw);
    const replacementFindingId = nullableField(replacementRaw);
    const reviewerNotes = nullableField(notesRaw);
    if (verdict === "fixed" && !evidence) {
      errors.push(`line ${lineNo}: PRIOR fixed verdict requires evidence`);
      continue;
    }
    if (!evidence && !reviewerNotes) {
      errors.push(`line ${lineNo}: PRIOR requires evidence or reviewerNotes`);
      continue;
    }
    if ((verdict === "still_open" || verdict === "downgraded") && !requiredFix) {
      errors.push(`line ${lineNo}: PRIOR ${verdict} verdict requires requiredFix`);
      continue;
    }
    priorFindingReviews.push({
      priorFindingId,
      verdict: verdict as PriorFindingReviewVerdict,
      evidence,
      requiredFix,
      replacementFindingId,
      reviewerNotes,
    });
  }

  const summaryBlock = collectSingletonBlock(rawText, "SUMMARY");
  if (!summaryBlock.ok) {
    errors.push(summaryBlock.message);
  }
  const summary = summaryBlock.ok ? (summaryBlock.content ?? "").trim() : "";

  if (approvals.length !== 1) {
    errors.push(`expected exactly 1 APPROVED line, got ${approvals.length}`);
  }
  if (summaryBlock.ok && !summary) {
    errors.push("expected a non-empty SUMMARY<< … >>SUMMARY block");
  }
  // Two PRIOR lines for the same finding carry contradictory verdicts (fixed vs
  // still_open) that would both settle; the recheck must be unambiguous.
  const duplicatePriorIds = priorFindingReviews
    .map((review) => review.priorFindingId)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicatePriorIds.length > 0) {
    errors.push(`duplicate PRIOR priorFindingId: ${Array.from(new Set(duplicatePriorIds)).join(", ")}`);
  }

  if (errors.length > 0) {
    return { ok: false, message: `review line protocol rejected: ${errors.join("; ")}` };
  }

  return {
    ok: true,
    payload: {
      findings,
      priorFindingReviews,
      approved: approvals[0]!,
      summary,
    },
  };
}
