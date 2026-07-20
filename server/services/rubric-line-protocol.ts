import {
  findStructuralBlockError,
  findStructuralGarbage,
  scanProtocolLines,
  splitFields,
} from "./ai-line-protocol";

/**
 * Line-oriented output protocol for rubric judgments.
 *
 * This is the generalisation of review.md's `PRIOR` contract, which is the one
 * place in this repo where "enumerate a checklist, demand an explicit verdict
 * per item, and fail closed on a missing one" is already production-proven:
 *
 *   > a missing verdict is recorded as `not_rechecked` and keeps the old
 *   > blocker open; an unknown verdict voids the entire Review output.
 *
 * A rubric applies the same skeleton to a FIXED, user-editable checklist rather
 * than to the previous round's findings. Nothing about the mechanism is new --
 * only what populates the checklist.
 *
 * Wire format (`RUBRIC: criterionId | verdict | evidence`) follows the PRIOR
 * line rather than §6's shorthand `RUBRIC <criterionId> yes|no <evidence>`:
 * every other protocol in this repo is `KEYWORD: field | field`, and reusing
 * scanProtocolLines/splitFields means the rubric protocol inherits the shared
 * tokenizer's block handling, bullet stripping and prose tolerance instead of
 * growing a second, subtly different scanner. `yes|no` in the design doc is
 * alternation in prose, not a field separator.
 *
 * ## Why the verdict vocabulary the MODEL may write is only yes/no
 *
 * The stored vocabulary is three-valued (yes / no / not_assessed), but
 * `not_assessed` is deliberately NOT writable by the model. It is stagepass's
 * accounting entry for "the model did not answer this", produced by
 * buildRubricAssessments() when a criterion has no line. Letting a model
 * declare `not_assessed` itself would turn a bookkeeping state into a third
 * answer -- exactly the "AI hallucinates a score" failure the yes/no-only rule
 * exists to prevent.
 *
 * ## Two different failure modes, two different responses
 *
 *  - MISSING line  -> `not_assessed` at the assessment layer, treated as
 *    blocking. Silent omission is the failure this whole mechanism exists to
 *    catch, so it must never read as a pass.
 *  - UNKNOWN criterion id, unknown verdict, duplicate id -> the whole output is
 *    void (retryable invalid output). These are malformed protocol, not
 *    judgments, and review.md already answers them this way. Voiding is
 *    strictly better than coercing to `not_assessed`: it gives the model a
 *    chance to fix a typo instead of permanently recording a criterion as
 *    unanswered, and it can never be mistaken for a real verdict.
 */

export type RubricVerdict = "yes" | "no" | "not_assessed";

/** What the model may actually write on a RUBRIC line. */
export type RubricModelVerdict = Extract<RubricVerdict, "yes" | "no">;

export interface RubricJudgment {
  criterionId: string;
  verdict: RubricModelVerdict;
  evidence: string;
}

export type RubricLineProtocolResult =
  | { ok: true; payload: { judgments: RubricJudgment[] } }
  | { ok: false; message: string };

export interface RubricLineProtocolOptions {
  /**
   * The criterion ids of the rubric version this run was actually given.
   * Required, not optional: "unknown criterion id voids the output" is
   * unenforceable without it, and a parser that silently skips the check when
   * the caller forgets to pass ids would fail open on the exact case §4.2
   * names.
   */
  criterionIds: readonly string[];
  /**
   * Block names the HOST stage legitimately emits. Rubric lines are embedded in
   * a host stage's reply (spec, review, ...), and that stage owns its own
   * blocks -- passing its set here keeps the shared structural check from
   * rejecting a legitimate SUMMARY<< block. Defaults to none for standalone use.
   */
  expectedBlockNames?: readonly string[];
}

const KEYWORDS = ["RUBRIC"] as const;
const MODEL_VERDICTS = new Set<RubricModelVerdict>(["yes", "no"]);
const MAX_EVIDENCE_LENGTH = 2_000;

export function parseRubricLineProtocol(
  rawText: string,
  options: RubricLineProtocolOptions,
): RubricLineProtocolResult {
  const structural = findStructuralBlockError(rawText, options.expectedBlockNames ?? []);
  if (structural) return { ok: false, message: `rubric line protocol rejected: ${structural}` };

  const known = new Set(options.criterionIds);
  const judgments: RubricJudgment[] = [];
  const errors: string[] = [];

  for (const { lineNo, rest } of scanProtocolLines(rawText, KEYWORDS)) {
    const fields = splitFields(rest);
    if (fields.length < 3) {
      errors.push(
        `line ${lineNo}: RUBRIC needs 3 "|" fields (criterionId | yes/no | evidence), got ${fields.length}`,
      );
      continue;
    }
    const [criterionId, verdict] = fields as [string, string];
    // Evidence is last so it absorbs surplus "|": a human-written criterion
    // quoted in the evidence cannot shift the two fixed-vocabulary fields, which
    // sit up front where a typo is a loud error rather than a silent shift.
    // Same rule, same reason, as refine's `description`.
    const evidence = fields.slice(2).join(" | ").trim();

    if (!criterionId) {
      errors.push(`line ${lineNo}: RUBRIC criterionId is empty`);
      continue;
    }
    // §4.2: an id this rubric does not contain means the model answered a
    // checklist that is not the one it was given -- every judgment in the reply
    // is then unattributable, so the whole output is void rather than partially
    // salvaged.
    if (!known.has(criterionId)) {
      errors.push(
        `line ${lineNo}: RUBRIC unknown criterionId "${criterionId}" is not part of this rubric`,
      );
      continue;
    }
    if (!MODEL_VERDICTS.has(verdict as RubricModelVerdict)) {
      errors.push(
        `line ${lineNo}: RUBRIC verdict must be yes or no, got "${verdict}"`
        + (verdict === "not_assessed"
          ? " (not_assessed is recorded by stagepass for an unanswered criterion; it is not a verdict you may write)"
          : ""),
      );
      continue;
    }
    // Every judgment carries evidence, `yes` included. An unevidenced `yes` is
    // precisely the "trust me" answer the yes/no rule is meant to squeeze out,
    // and review.md already requires evidence on every FINDING for this reason.
    if (!evidence) {
      errors.push(`line ${lineNo}: RUBRIC evidence is empty (every judgment requires evidence)`);
      continue;
    }
    if (evidence.length > MAX_EVIDENCE_LENGTH) {
      errors.push(`line ${lineNo}: RUBRIC evidence exceeds ${MAX_EVIDENCE_LENGTH} chars`);
      continue;
    }
    const garbage = findStructuralGarbage(evidence);
    if (garbage) {
      errors.push(`line ${lineNo}: RUBRIC evidence ${garbage}`);
      continue;
    }
    judgments.push({ criterionId, verdict: verdict as RubricModelVerdict, evidence });
  }

  // Two lines for one criterion carry contradictory verdicts that would both
  // settle; which one wins would be decided by iteration order. The same rule
  // review.md applies to duplicate PRIOR ids.
  const duplicates = judgments
    .map((judgment) => judgment.criterionId)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    errors.push(`duplicate RUBRIC criterionId: ${Array.from(new Set(duplicates)).join(", ")}`);
  }

  if (errors.length > 0) {
    return { ok: false, message: `rubric line protocol rejected: ${errors.join("; ")}` };
  }

  // Zero RUBRIC lines is NOT a parse error. An empty rubric is legal (§4.5:
  // "行为退回现状"), and for a non-empty rubric the omission is caught by
  // buildRubricAssessments as not_assessed on every criterion -- which blocks.
  // Failing here instead would report "malformed output" for what is really a
  // complete refusal to answer, and would lose the per-criterion accounting.
  return { ok: true, payload: { judgments } };
}

export const RUBRIC_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    judgments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterionId: { type: "string" },
          verdict: { type: "string", enum: ["yes", "no"] },
          evidence: { type: "string" },
        },
        required: ["criterionId", "verdict", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["judgments"],
  additionalProperties: false,
};
