import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyQuestionAction,
  computePrdGate,
  parseBriefingQuestionsOutput,
  parseFinalReviewOutput,
  prdBriefingInputHash,
  type BriefingQuestionInput,
  type PrdBriefingInputQuestion,
} from "./prd-briefing-ledger.ts";

const question = (overrides: Partial<BriefingQuestionInput> = {}): BriefingQuestionInput => ({
  category: "goal",
  severity: "critical",
  question: "谁是目标用户？",
  whyItMatters: "目标用户不清会导致验收标准不可判断。",
  suggestedDefault: "默认目标用户是项目 owner。",
  ...overrides,
});

describe("prd-briefing-ledger", () => {
  it("parses blue question cards from structured JSON", () => {
    const parsed = parseBriefingQuestionsOutput(JSON.stringify({
      unit: "PRD_BLUE_INTERROGATOR",
      changeId: "CHG-001",
      phase: "PRD",
      questions: [
        question(),
        question({
          category: "risk",
          severity: "important",
          question: "是否存在数据损坏风险？",
          whyItMatters: "数据风险会影响后续 Spec gate。",
          suggestedDefault: null,
        }),
      ],
    }));

    assert.equal(parsed.questions.length, 2);
    assert.equal(parsed.questions[0].severity, "critical");
    assert.equal(parsed.questions[1].category, "risk");
  });

  it("rejects unsupported question categories", () => {
    assert.throws(() => parseBriefingQuestionsOutput(JSON.stringify({
      questions: [{ ...question(), category: "random" }],
    })), /Invalid/);
  });

  it("computes PRD gate blocked by open critical questions", () => {
    const gate = computePrdGate({
      hasDraft: true,
      draftFresh: true,
      questions: [
        { id: "BQ-1", severity: "critical", status: "open" },
        { id: "BQ-2", severity: "important", status: "deferred" },
      ],
    });

    assert.equal(gate.canLock, false);
    assert.deepEqual(gate.blockingQuestionIds, ["BQ-1"]);
    assert.deepEqual(gate.deferredQuestionIds, ["BQ-2"]);
  });

  it("allows locking when critical questions are answered and draft is fresh", () => {
    const gate = computePrdGate({
      hasDraft: true,
      draftFresh: true,
      finalReview: {
        fresh: true,
        verdict: "ready",
        blockingQuestionIds: [],
      },
      questions: [
        { id: "BQ-1", severity: "critical", status: "answered" },
        { id: "BQ-2", severity: "important", status: "deferred" },
      ],
    });

    assert.equal(gate.canLock, true);
    assert.deepEqual(gate.blockingQuestionIds, []);
  });

  it("normalizes human question actions", () => {
    assert.deepEqual(applyQuestionAction({ action: "answer", value: "由项目 owner 审批。" }), {
      status: "answered",
      answer: "由项目 owner 审批。",
    });
    assert.deepEqual(applyQuestionAction({ action: "accept_assumption", value: "默认 owner 审批。" }), {
      status: "assumption_accepted",
      answer: "默认 owner 审批。",
    });
    assert.deepEqual(applyQuestionAction({ action: "defer", value: "进入 Spec 再确认。" }), {
      status: "deferred",
      answer: "进入 Spec 再确认。",
    });
  });

  it("parses final review output", () => {
    const parsed = parseFinalReviewOutput(JSON.stringify({
      unit: "PRD_BLUE_INTERROGATOR",
      verdict: "ready",
      blockingQuestionIds: [],
      riskSummary: "仍有一个 important 疑点暂缓。",
      recommendedNextAction: "lock_prd",
    }));

    assert.equal(parsed.verdict, "ready");
    assert.equal(parsed.recommendedNextAction, "lock_prd");
  });

  /**
   * Row order must not reach the digest. Two callers hash through here -- the
   * write path sorted by (createdAt, id), the read path with a bare `.all()` in
   * rowid order -- and when ordering was left to them they disagreed on every
   * multi-card briefing, which read as a permanently stale draft and blocked
   * the PRD stage outright. Normalizing here is what makes the two agree by
   * construction rather than by each caller remembering.
   */
  it("hashes the same question cards identically whatever order they arrive in", () => {
    const briefing = { intentText: "Ship the ordering fix." };
    // The production shape: one hoisted createdAt shared by the whole insert
    // loop, so the sort falls through to ids that end in random bytes.
    const createdAt = "2026-07-18T14:27:46.970Z";
    const card = (id: string, overrides: Partial<PrdBriefingInputQuestion> = {}) => ({
      id,
      category: "scope",
      severity: "important",
      question: `Question ${id}?`,
      whyItMatters: "keeps the briefing bounded",
      suggestedDefault: null,
      status: "open",
      answer: null,
      createdAt,
      ...overrides,
    });
    const rowidOrder = [card("BQ-ede98738"), card("BQ-01edf6b6"), card("BQ-d7a21f82")];
    const sorted = [...rowidOrder].sort((a, b) => a.id.localeCompare(b.id));
    const reversed = [...sorted].reverse();

    const expected = prdBriefingInputHash(briefing, sorted);
    assert.equal(prdBriefingInputHash(briefing, rowidOrder), expected);
    assert.equal(prdBriefingInputHash(briefing, reversed), expected);
    // The caller's array is an input, not scratch space.
    assert.deepEqual(
      rowidOrder.map((row) => row.id),
      ["BQ-ede98738", "BQ-01edf6b6", "BQ-d7a21f82"],
      "hashing must not reorder the caller's array in place",
    );

    // createdAt breaks ties but must stay OUT of the hashed payload: folding it
    // in would move every digest and invalidate every stamped hash on record.
    assert.equal(
      prdBriefingInputHash(briefing, [
        card("BQ-01edf6b6", { createdAt: "2020-01-01T00:00:00.000Z" }),
        card("BQ-d7a21f82", { createdAt: "2020-01-01T00:00:00.000Z" }),
        card("BQ-ede98738", { createdAt: "2020-01-01T00:00:00.000Z" }),
      ]),
      expected,
      "createdAt is a sort key only, never hashed content",
    );

    // Content still moves the hash -- normalization must not flatten answers.
    assert.notEqual(
      prdBriefingInputHash(briefing, [
        card("BQ-01edf6b6", { status: "answered", answer: "yes" }),
        card("BQ-d7a21f82"),
        card("BQ-ede98738"),
      ]),
      expected,
      "answering a card must still move the input hash",
    );
  });
});
