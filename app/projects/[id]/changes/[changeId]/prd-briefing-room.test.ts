import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrdBriefingRoom } from "./prd-briefing-room";
import type { BriefingQuestion, PrdBriefingState } from "./prd-briefing-types";

const source = readFileSync(resolve(__dirname, "prd-briefing-room.tsx"), "utf-8");

function card(overrides: Partial<BriefingQuestion> & { id: string; roundNo: number }): BriefingQuestion {
  return {
    changeId: "CHG-001",
    category: "scope",
    severity: "important",
    question: `问题 ${overrides.id}`,
    whyItMatters: `理由 ${overrides.id}`,
    suggestedDefault: null,
    status: "open",
    answer: null,
    source: "ai_blue",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

function stateWith(questions: BriefingQuestion[]): PrdBriefingState {
  return {
    briefing: {
      id: "PBR-1",
      changeId: "CHG-001",
      status: "questions_ready",
      intentText: "我要做一个战前会议室。",
      finalReviewJson: null,
      sourceHashesJson: "{}",
      lockedAt: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    },
    questions,
    latestDraft: null,
    gate: {
      canLock: false,
      blockingQuestionIds: [],
      deferredQuestionIds: [],
      clarityLevel: "low",
      riskLevel: "low",
      draftFresh: false,
      finalReviewFresh: false,
    },
    finalReview: null,
    activeRun: null,
    stageProgress: null,
  };
}

function render(questions: BriefingQuestion[]): string {
  return renderToStaticMarkup(
    createElement(PrdBriefingRoom, {
      projectId: "PRJ-1",
      changeId: "CHG-001",
      initialState: stateWith(questions),
      onLocked: () => {},
    }),
  );
}

describe("PRD briefing response boundaries", () => {
  it("keeps asynchronous queue receipts out of page state", () => {
    const commandStart = source.indexOf("const requestCommandJson");
    const stateStart = source.indexOf("const requestStateJson");
    const saveIntentStart = source.indexOf("const saveIntent");
    const startAiJobStart = source.indexOf("const startAiJob");
    const questionActionStart = source.indexOf("const handleQuestionAction");

    assert.notEqual(commandStart, -1, "queue commands need a dedicated request helper");
    assert.notEqual(stateStart, -1, "state-returning commands need a dedicated request helper");
    assert.notEqual(startAiJobStart, -1);
    assert.notEqual(questionActionStart, -1);

    const commandHelper = source.slice(commandStart, stateStart);
    const saveIntent = source.slice(saveIntentStart, startAiJobStart);
    const startAiJob = source.slice(startAiJobStart, questionActionStart);

    assert.doesNotMatch(commandHelper, /normalizeState|syncState/);
    assert.match(saveIntent, /requestStateJson\(/);
    assert.match(startAiJob, /requestCommandJson\(/);
    assert.doesNotMatch(startAiJob, /requestStateJson\(/);
  });
});

describe("PRD briefing question rounds", () => {
  it("groups cards under the round that produced them and labels each card", () => {
    const html = render([
      card({ id: "BQ-1", roundNo: 1, status: "answered", answer: "由 owner 审批。" }),
      card({ id: "BQ-2", roundNo: 2 }),
      card({ id: "BQ-3", roundNo: 2 }),
    ]);

    assert.match(html, /data-prd-question-round="1"/);
    assert.match(html, /data-prd-question-round="2"/);
    assert.match(html, /第 1 轮/);
    assert.match(html, /第 2 轮/);
    assert.match(html, /共 2 轮/);
    // Every card carries its own round, so a card read on its own is still placed.
    assert.equal(html.match(/第 1 轮/g)?.length, 2, "round 1 header plus its one card badge");
    assert.equal(html.match(/第 2 轮/g)?.length, 3, "round 2 header plus its two card badges");
  });

  it("keeps every round's cards on the page, not just the newest", () => {
    const html = render([
      card({ id: "BQ-OLD", roundNo: 1, status: "answered", answer: "由 owner 审批。" }),
      card({ id: "BQ-NEW", roundNo: 2 }),
    ]);

    assert.match(html, /问题 BQ-OLD/, "an earlier round must stay readable");
    assert.match(html, /由 owner 审批。/, "its recorded decision must stay visible");
    assert.match(html, /问题 BQ-NEW/);
  });

  /**
   * An earlier round collapses only when every card in it is handled. A round
   * still holding an open card stays expanded, because those cards remain
   * answerable and still block the gate -- collapsing them would hide the
   * reason the draft is being refused.
   */
  it("leaves an earlier round expanded while it still holds an open card", () => {
    const html = render([
      card({ id: "BQ-OPEN", roundNo: 1, severity: "critical" }),
      card({ id: "BQ-NEW", roundNo: 2 }),
    ]);

    const round1 = /<details[^>]*data-prd-question-round="1"[^>]*>/.exec(html)?.[0] ?? "";
    assert.notEqual(round1, "");
    assert.match(round1, /\sopen/, "an unhandled round stays open");
    assert.match(html, /1 个待处理/);
  });

  it("collapses a fully handled earlier round while keeping the newest open", () => {
    const html = render([
      card({ id: "BQ-DONE", roundNo: 1, status: "answered", answer: "由 owner 审批。" }),
      card({ id: "BQ-NEW", roundNo: 2 }),
    ]);

    const round1 = /<details[^>]*data-prd-question-round="1"[^>]*>/.exec(html)?.[0] ?? "";
    const round2 = /<details[^>]*data-prd-question-round="2"[^>]*>/.exec(html)?.[0] ?? "";
    assert.notEqual(round1, "");
    assert.doesNotMatch(round1, /\sopen/, "a fully handled earlier round collapses");
    assert.match(round2, /\sopen/, "the newest round is always open");
  });

  it("names the round the next generation will open", () => {
    assert.match(render([card({ id: "BQ-1", roundNo: 2 })]), /追加第 3 轮追问/);
    assert.match(render([]), /生成追问/);
  });
});
