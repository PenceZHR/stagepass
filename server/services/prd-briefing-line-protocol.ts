import {
  type LineProtocolContext,
  collectSingletonBlock,
  findStructuralGarbage,
  nullableField,
  findStructuralBlockError,
  scanProtocolLines,
  splitFields,
} from "./ai-line-protocol";
import {
  BRIEFING_QUESTION_CATEGORIES,
  type BriefingQuestionsOutput,
  type FinalReviewOutput,
  type PrdBriefingDraftOutput,
} from "./prd-briefing-ledger";

/**
 * Line-oriented output protocols for the three PRD briefing sub-stages
 * (questions / draft / final review). Shared primitives live in
 * ai-line-protocol.ts; the project rule is that models never author JSON.
 *
 * The three payloads keep their exact current shape — only the authoring
 * changes. `unit` / `changeId` / `phase` were always constants the prompt
 * asked the model to echo back verbatim; stagepass now supplies them itself,
 * so a mis-typed changeId or codename is no longer expressible.
 */

/** The blue interrogator's codename; previously echoed by the model. */
const BLUE_UNIT = "PRD_BLUE_INTERROGATOR";
const PRD_PHASE = "PRD";

export type PrdBriefingLineProtocolResult<T> =
  | { ok: true; payload: T }
  | { ok: false; message: string };

const QUESTION_CATEGORIES = new Set<string>(BRIEFING_QUESTION_CATEGORIES);
const QUESTION_SEVERITIES = new Set(["critical", "important", "optional"]);
const VERDICTS = new Set(["ready", "needs_answer", "risky_but_allowed"]);
const NEXT_ACTIONS = new Set(["lock_prd", "answer_questions", "cancel_change"]);

const QUESTION_FIELDS = 5;

// --- questions ---

export function parseBriefingQuestionsLineProtocol(
  rawText: string,
  ctx: LineProtocolContext,
): PrdBriefingLineProtocolResult<BriefingQuestionsOutput> {
  const structural = findStructuralBlockError(rawText, []);
  if (structural) return { ok: false, message: `prd-briefing questions line protocol rejected: ${structural}` };
  const questions: BriefingQuestionsOutput["questions"] = [];
  const errors: string[] = [];

  let noNewQuestions = false;
  for (const { lineNo, keyword, rest } of scanProtocolLines(rawText, ["QUESTION", "NO_NEW_QUESTIONS"])) {
    if (keyword === "NO_NEW_QUESTIONS") {
      if (rest === "true") noNewQuestions = true;
      else errors.push(`line ${lineNo}: NO_NEW_QUESTIONS must be true, got "${rest}"`);
      continue;
    }
    const fields = splitFields(rest);
    if (fields.length !== QUESTION_FIELDS) {
      errors.push(
        `line ${lineNo}: QUESTION needs exactly ${QUESTION_FIELDS} "|" fields (category | severity | question | whyItMatters | suggestedDefault 或 -), got ${fields.length}. 文本字段不得含 "|"`,
      );
      continue;
    }
    const [category, severity, question, whyItMatters, suggestedDefaultRaw] = fields as [
      string, string, string, string, string,
    ];
    if (!QUESTION_CATEGORIES.has(category)) {
      errors.push(
        `line ${lineNo}: QUESTION category must be one of ${BRIEFING_QUESTION_CATEGORIES.join("/")}, got "${category}"`,
      );
      continue;
    }
    if (!QUESTION_SEVERITIES.has(severity)) {
      errors.push(
        `line ${lineNo}: QUESTION severity must be critical/important/optional, got "${severity}"`,
      );
      continue;
    }
    if (!question) {
      errors.push(`line ${lineNo}: QUESTION question is empty`);
      continue;
    }
    if (!whyItMatters) {
      errors.push(`line ${lineNo}: QUESTION whyItMatters is empty`);
      continue;
    }
    questions.push({
      category: category as BriefingQuestionsOutput["questions"][number]["category"],
      severity: severity as BriefingQuestionsOutput["questions"][number]["severity"],
      question,
      whyItMatters,
      suggestedDefault: nullableField(suggestedDefaultRaw),
    });
  }

  // Three-state, not "at least one".
  //
  // A reply truncated just before its first QUESTION line and a reply that
  // genuinely has nothing left to ask are indistinguishable on "zero QUESTION
  // lines" alone. Requiring an explicit marker makes truncation a loud failure
  // instead of a silently swallowed round. Same reasoning as PRD_DONE in
  // prd-line-protocol.ts:328.
  if (questions.length === 0 && !noNewQuestions) {
    errors.push("expected at least 1 QUESTION line, or NO_NEW_QUESTIONS: true to declare convergence");
  }
  if (questions.length > 0 && noNewQuestions) {
    errors.push("NO_NEW_QUESTIONS: true cannot appear alongside QUESTION lines");
  }

  if (errors.length > 0) {
    return { ok: false, message: `prd-briefing questions line protocol rejected: ${errors.join("; ")}` };
  }

  return {
    ok: true,
    payload: {
      unit: BLUE_UNIT,
      changeId: ctx.changeId,
      phase: PRD_PHASE,
      questions,
      ...(noNewQuestions ? { noNewQuestions: true } : {}),
    },
  };
}

// --- draft ---

export function parsePrdBriefingDraftLineProtocol(
  rawText: string,
): PrdBriefingLineProtocolResult<PrdBriefingDraftOutput> {
  // MARKDOWN is the only block this stage produces; reject any off-script block
  // (a balanced NOTE<< … >>NOTE) whose body would silently swallow content.
  const structural = findStructuralBlockError(rawText, ["MARKDOWN"]);
  if (structural) {
    return { ok: false, message: `prd-briefing draft line protocol rejected: ${structural}` };
  }
  const block = collectSingletonBlock(rawText, "MARKDOWN");
  if (!block.ok) {
    return { ok: false, message: `prd-briefing draft line protocol rejected: ${block.message}` };
  }
  const markdown = (block.content ?? "").trim();
  if (!markdown) {
    return {
      ok: false,
      message: block.content === null
        ? "prd-briefing draft line protocol rejected: expected a MARKDOWN<< … >>MARKDOWN block"
        : "prd-briefing draft line protocol rejected: MARKDOWN<< … >>MARKDOWN block is empty",
    };
  }
  return { ok: true, payload: { markdown } };
}

// --- final review ---

export function parseFinalReviewLineProtocol(
  rawText: string,
  knownQuestionIds: readonly string[],
): PrdBriefingLineProtocolResult<FinalReviewOutput> {
  const structural = findStructuralBlockError(rawText, ["RISK_SUMMARY"]);
  if (structural) return { ok: false, message: `prd-briefing final review line protocol rejected: ${structural}` };
  const verdicts: string[] = [];
  const nextActions: string[] = [];
  const blockingQuestionIds: string[] = [];
  const errors: string[] = [];
  const known = new Set(knownQuestionIds);

  for (const { lineNo, keyword, rest } of scanProtocolLines(rawText, ["VERDICT", "NEXT", "BLOCKING"])) {
    if (keyword === "VERDICT") {
      if (VERDICTS.has(rest)) verdicts.push(rest);
      else errors.push(`line ${lineNo}: VERDICT must be ready/needs_answer/risky_but_allowed, got "${rest}"`);
      continue;
    }
    if (keyword === "NEXT") {
      if (NEXT_ACTIONS.has(rest)) nextActions.push(rest);
      else errors.push(`line ${lineNo}: NEXT must be lock_prd/answer_questions/cancel_change, got "${rest}"`);
      continue;
    }
    // BLOCKING: every non-empty entry blocks the PRD lock and cannot be
    // answered away, so an id the model mis-transcribed would be a permanent
    // phantom blocker. Ids are opaque (BQ-<base36>-<hex>) — only the real set
    // can validate them.
    if (!rest) {
      errors.push(`line ${lineNo}: BLOCKING question id is empty`);
      continue;
    }
    if (!known.has(rest)) {
      errors.push(
        `line ${lineNo}: BLOCKING references unknown question id "${rest}" (must be one of the briefing question ids)`,
      );
      continue;
    }
    blockingQuestionIds.push(rest);
  }

  const block = collectSingletonBlock(rawText, "RISK_SUMMARY");
  if (!block.ok) errors.push(block.message);
  const riskSummary = block.ok ? (block.content ?? "").trim() : "";

  if (verdicts.length !== 1) {
    errors.push(`expected exactly 1 VERDICT line, got ${verdicts.length}`);
  }
  if (nextActions.length !== 1) {
    errors.push(`expected exactly 1 NEXT line, got ${nextActions.length}`);
  }
  if (block.ok && !riskSummary) {
    errors.push("expected a non-empty RISK_SUMMARY<< … >>RISK_SUMMARY block");
  }
  const garbage = findStructuralGarbage(riskSummary);
  if (garbage) errors.push(`RISK_SUMMARY ${garbage}`);

  if (errors.length > 0) {
    return { ok: false, message: `prd-briefing final review line protocol rejected: ${errors.join("; ")}` };
  }

  return {
    ok: true,
    payload: {
      unit: BLUE_UNIT,
      verdict: verdicts[0] as FinalReviewOutput["verdict"],
      blockingQuestionIds,
      riskSummary,
      recommendedNextAction: nextActions[0] as FinalReviewOutput["recommendedNextAction"],
    },
  };
}
