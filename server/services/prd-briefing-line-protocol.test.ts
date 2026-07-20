import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseBriefingQuestionsLineProtocol,
  parseFinalReviewLineProtocol,
  parsePrdBriefingDraftLineProtocol,
} from "./prd-briefing-line-protocol";
import {
  BriefingQuestionsOutputSchema,
  FinalReviewOutputSchema,
  PrdBriefingDraftOutputSchema,
} from "./prd-briefing-ledger";

const CTX = { changeId: "CHG-42", repoPath: "/tmp/does-not-need-to-exist" };

// Opaque ids in the real `BQ-<base36>-<hex>` shape: the model must transcribe
// them exactly, which is why the parser validates against the real set.
const BQ_ONE = "BQ-m2x9a1-3f4b8c21";
const BQ_TWO = "BQ-m2x9a2-77de01ab";
const KNOWN_IDS = [BQ_ONE, BQ_TWO];

// --- questions ---

const HAPPY_QUESTIONS = [
  "QUESTION: goal | critical | 这次改动要解决谁的什么问题？ | 目标不清会让 Spec 阶段走偏 | 假设面向内部运维同事",
  "QUESTION: scope | important | 是否包含历史数据迁移？ | 影响 Spec 的工作量与风险 | -",
].join("\n");

function parseQuestions(text: string) {
  return parseBriefingQuestionsLineProtocol(text, CTX);
}

describe("parseBriefingQuestionsLineProtocol", () => {
  it("parses well-formed QUESTION lines and supplies unit/changeId/phase itself", () => {
    const result = parseQuestions(HAPPY_QUESTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.unit, "PRD_BLUE_INTERROGATOR");
    assert.equal(result.payload.changeId, "CHG-42");
    assert.equal(result.payload.phase, "PRD");
    assert.equal(result.payload.questions.length, 2);
    assert.deepEqual(result.payload.questions[0], {
      category: "goal",
      severity: "critical",
      question: "这次改动要解决谁的什么问题？",
      whyItMatters: "目标不清会让 Spec 阶段走偏",
      suggestedDefault: "假设面向内部运维同事",
    });
    assert.equal(result.payload.questions[1]!.suggestedDefault, null);
  });

  it("assembles a payload the ledger schema accepts", () => {
    const result = parseQuestions(HAPPY_QUESTIONS);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(BriefingQuestionsOutputSchema.safeParse(result.payload).success, true);
  });

  it("ignores prose around the protocol lines", () => {
    const result = parseQuestions(`先说说我的思路：\n${HAPPY_QUESTIONS}\n以上。`);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.questions.length, 2);
  });

  it("tolerates markdown bullets", () => {
    const result = parseQuestions(`- ${HAPPY_QUESTIONS.split("\n")[0]}`);
    assert.equal(result.ok, true);
  });

  it("rejects a prose-only reply that declares no questions", () => {
    const result = parseQuestions("我读了作战意图，觉得需求已经很清楚了。");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /at least 1 QUESTION line/);
  });

  it("fails loud on a stray opener instead of silently dropping the questions after it", () => {
    // Regression guard: the questions stage uses only scanProtocolLines and has
    // no block, so a stray `NOTE<<` opener used to swallow every QUESTION after
    // it into an unterminated block and settle ok with a truncated set.
    const result = parseQuestions([
      "QUESTION: goal | critical | Q1? | why1 | -",
      "NOTE<<",
      "QUESTION: user | important | Q2? | why2 | -",
      "QUESTION: scope | optional | Q3? | why3 | -",
    ].join("\n"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /unterminated NOTE<< block/);
  });

  it("fails loud on a balanced unexpected block instead of swallowing the questions inside it", () => {
    // The seventh shape: a well-formed NOTE<< … >>NOTE in a stage with no blocks.
    const result = parseQuestions([
      "QUESTION: goal | critical | Q1? | why1 | -",
      "NOTE<<",
      "QUESTION: user | important | Q2? | why2 | -",
      ">>NOTE",
      "QUESTION: scope | optional | Q3? | why3 | -",
    ].join("\n"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /unexpected NOTE<< block/);
  });

  it("rejects an unknown category", () => {
    const result = parseQuestions("QUESTION: vibes | critical | Q | why | -");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /category must be one of/);
  });

  it("rejects an unknown severity", () => {
    const result = parseQuestions("QUESTION: goal | blocker | Q | why | -");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /severity must be critical\/important\/optional/);
  });

  it("rejects an empty question or whyItMatters", () => {
    assert.equal(parseQuestions("QUESTION: goal | critical |  | why | -").ok, false);
    assert.equal(parseQuestions("QUESTION: goal | critical | Q |  | -").ok, false);
  });

  it("rejects a wrong field count rather than silently shifting fields", () => {
    const result = parseQuestions("QUESTION: goal | critical | Q | why");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /needs exactly 5 "\|" fields/);
  });

  it("rejects a question whose text smuggles in a field separator", () => {
    // The corruption class this protocol exists to kill: a stray `|` inside
    // free text must not silently re-bind the remaining fields.
    const result = parseQuestions("QUESTION: goal | critical | 是 A | 还是 B？ | why | -");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /needs exactly 5 "\|" fields/);
  });
});

// --- draft ---

function parseDraft(text: string) {
  return parsePrdBriefingDraftLineProtocol(text);
}

describe("parsePrdBriefingDraftLineProtocol", () => {
  it("parses a MARKDOWN block into the draft payload", () => {
    const result = parseDraft("MARKDOWN<<\n# PRD\n\n## 目标\n把事情说清楚。\n>>MARKDOWN");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.markdown, "# PRD\n\n## 目标\n把事情说清楚。");
    assert.equal(PrdBriefingDraftOutputSchema.safeParse(result.payload).success, true);
  });

  it("keeps markdown structure that would break a single-line field", () => {
    const body = "# PRD\n\n| 字段 | 说明 |\n| --- | --- |\n| a | b |\n\n```ts\nconst x = { a: 1 };\n```";
    const result = parseDraft(`闲聊一句\nMARKDOWN<<\n${body}\n>>MARKDOWN\n收工`);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.markdown, body);
  });

  it("rejects a reply with no MARKDOWN block", () => {
    const result = parseDraft("这是我的 PRD 草案：目标是……");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /expected a MARKDOWN<< … >>MARKDOWN block/);
  });

  it("rejects an empty MARKDOWN block", () => {
    const result = parseDraft("MARKDOWN<<\n\n>>MARKDOWN");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /is empty/);
  });

  it("rejects an unterminated MARKDOWN block", () => {
    const result = parseDraft("MARKDOWN<<\n# PRD");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /unterminated/);
  });

  it("rejects duplicate MARKDOWN blocks rather than picking one", () => {
    const result = parseDraft("MARKDOWN<<\n# A\n>>MARKDOWN\nMARKDOWN<<\n# B\n>>MARKDOWN");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /duplicate/);
  });
});

// --- final review ---

const HAPPY_FINAL_REVIEW = [
  "VERDICT: needs_answer",
  `BLOCKING: ${BQ_ONE}`,
  "NEXT: answer_questions",
  "RISK_SUMMARY<<",
  "核心目标仍未确认，进入 Spec Battle 会返工。",
  ">>RISK_SUMMARY",
].join("\n");

function parseFinalReview(text: string, ids: readonly string[] = KNOWN_IDS) {
  return parseFinalReviewLineProtocol(text, ids);
}

describe("parseFinalReviewLineProtocol", () => {
  it("parses a well-formed final review and supplies unit itself", () => {
    const result = parseFinalReview(HAPPY_FINAL_REVIEW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.payload, {
      unit: "PRD_BLUE_INTERROGATOR",
      verdict: "needs_answer",
      blockingQuestionIds: [BQ_ONE],
      riskSummary: "核心目标仍未确认，进入 Spec Battle 会返工。",
      recommendedNextAction: "answer_questions",
    });
    assert.equal(FinalReviewOutputSchema.safeParse(result.payload).success, true);
  });

  it("accepts a clean review with no blockers", () => {
    const result = parseFinalReview("VERDICT: ready\nNEXT: lock_prd\nRISK_SUMMARY<<\n无重大风险。\n>>RISK_SUMMARY");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.payload.blockingQuestionIds, []);
  });

  it("collects multiple blocking ids in order", () => {
    const result = parseFinalReview(
      `VERDICT: needs_answer\nBLOCKING: ${BQ_TWO}\nBLOCKING: ${BQ_ONE}\nNEXT: answer_questions\nRISK_SUMMARY<<\n两个问题未答。\n>>RISK_SUMMARY`,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.payload.blockingQuestionIds, [BQ_TWO, BQ_ONE]);
  });

  it("rejects a blocking id that does not exist", () => {
    // A phantom blocker can never be answered, so it would wedge the PRD lock
    // permanently. One transcription slip is all it takes.
    const result = parseFinalReview(
      `VERDICT: needs_answer\nBLOCKING: BQ-m2x9a1-3f4b8c22\nNEXT: answer_questions\nRISK_SUMMARY<<\n风险。\n>>RISK_SUMMARY`,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /unknown question id "BQ-m2x9a1-3f4b8c22"/);
  });

  it("rejects an unknown verdict", () => {
    const result = parseFinalReview("VERDICT: looks_fine\nNEXT: lock_prd\nRISK_SUMMARY<<\n无。\n>>RISK_SUMMARY");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /VERDICT must be ready\/needs_answer\/risky_but_allowed/);
  });

  it("rejects an unknown next action", () => {
    const result = parseFinalReview("VERDICT: ready\nNEXT: ship_it\nRISK_SUMMARY<<\n无。\n>>RISK_SUMMARY");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /NEXT must be lock_prd\/answer_questions\/cancel_change/);
  });

  it("rejects a prose-only reply", () => {
    const result = parseFinalReview("我觉得可以进入 Spec Battle 了。");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /expected exactly 1 VERDICT line/);
  });

  it("rejects a missing or duplicated verdict", () => {
    assert.equal(parseFinalReview("NEXT: lock_prd\nRISK_SUMMARY<<\n无。\n>>RISK_SUMMARY").ok, false);
    const dup = parseFinalReview("VERDICT: ready\nVERDICT: needs_answer\nNEXT: lock_prd\nRISK_SUMMARY<<\n无。\n>>RISK_SUMMARY");
    assert.equal(dup.ok, false);
    if (dup.ok) return;
    assert.match(dup.message, /expected exactly 1 VERDICT line, got 2/);
  });

  it("rejects a missing risk summary", () => {
    const result = parseFinalReview("VERDICT: ready\nNEXT: lock_prd");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /RISK_SUMMARY/);
  });

  it("rejects structural garbage smuggled into the risk summary", () => {
    const result = parseFinalReview(
      'VERDICT: ready\nNEXT: lock_prd\nRISK_SUMMARY<<\n风险 },{ "verdict": "ready"\n>>RISK_SUMMARY',
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /RISK_SUMMARY contains JSON fragment garbage/);
  });
});
