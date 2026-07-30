import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeGate, EMPTY_EVIDENCE, type Evidence } from "./gate";
import {
  clarificationQuestion,
  decisionFrom,
  DECISION_FIELD,
  gateDecisionQuestion,
  readAnswer,
  UnreadableAnswerError,
  type Question,
  waiveQuestion,
  waiveFrom,
} from "./question";
import type { ChangeState } from "./change-state";

const SETTLED: ChangeState = { phase: "Spec", status: "settled", returnPhase: null };
const BLOCKED: ChangeState = { phase: "Spec", status: "blocked", returnPhase: null };
const CLEAN: Evidence = { ...EMPTY_EVIDENCE, artifactIds: ["spec.md"] };
const WITH_P0: Evidence = {
  ...CLEAN,
  blockers: [{ id: "B-1", kind: "finding", severity: "P0", title: "范围冲突" }],
};

function ask(state: ChangeState, evidence: Evidence): Question | null {
  return gateDecisionQuestion({
    phase: state.phase,
    gate: computeGate(state, evidence),
    summary: "第 2 轮已结算",
  });
}

describe("L3 · the question offers exactly what the gate permits", () => {
  it("offers approve and reject on a clean settled phase", () => {
    const question = ask(SETTLED, CLEAN)!;
    assert.deepEqual(
      question.requestedSchema.properties[DECISION_FIELD]?.enum,
      ["approve", "reject"],
    );
    assert.equal(question.requestedSchema.required[0], DECISION_FIELD);
    assert.match(question.message, /Spec/);
  });

  /**
   * The rule the old tree broke in five places at once: a button that is shown
   * and then refused. Here the option list IS the gate's permitted list, so
   * there is nothing to keep in sync.
   */
  it("drops approve when the gate refuses it", () => {
    assert.deepEqual(
      ask(SETTLED, WITH_P0)!.requestedSchema.properties[DECISION_FIELD]?.enum,
      ["reject"],
    );
  });

  it("offers retry, and only retry, on a blocked phase", () => {
    assert.deepEqual(
      ask(BLOCKED, WITH_P0)!.requestedSchema.properties[DECISION_FIELD]?.enum,
      ["retry"],
    );
  });

  /**
   * A question with nothing to choose interrupts someone to show them a
   * decision they cannot make.
   */
  it("asks nothing when no decision is available", () => {
    assert.equal(ask({ ...SETTLED, status: "running" }, CLEAN), null);
    assert.equal(ask({ phase: "Done", status: "closed", returnPhase: null }, CLEAN), null);
  });

  /**
   * `start`, `settle` and `fail` are the system reporting what happened. Putting
   * them to a person would be asking them to do the machine's bookkeeping.
   */
  it("never offers a system transition", () => {
    for (const state of [SETTLED, BLOCKED, { ...SETTLED, status: "pending" as const }]) {
      const offered = ask(state, CLEAN)?.requestedSchema
        .properties[DECISION_FIELD]?.enum ?? [];
      for (const system of ["start", "settle", "fail"]) {
        assert.ok(!offered.includes(system), `${state.status} offered ${system}`);
      }
    }
  });
});

describe("L3 · a batch is one form, not a conversation", () => {
  it("puts every open question in a single schema", () => {
    const question = clarificationQuestion({
      title: "PRD 有三个阻断问题",
      items: [
        { id: "q1", question: "目标用户是谁？", options: ["个人开发者", "团队"] },
        { id: "q2", question: "失败时怎么办？", options: ["重试", "停下来问我"] },
      ],
    })!;
    assert.deepEqual(question.requestedSchema.required, ["q1", "q2"]);
    assert.equal(question.requestedSchema.properties.q1?.title, "目标用户是谁？");
    assert.deepEqual(question.requestedSchema.properties.q2?.enum, ["重试", "停下来问我"]);
  });

  it("asks nothing when there is nothing open", () => {
    assert.equal(clarificationQuestion({ title: "t", items: [] }), null);
  });

  /**
   * `required` 在客户端是硬闸门，不是提示。
   *
   * 2026-07-30 在 Codex TUI 实测：选择器写着
   * `Field 3/17 (17 required unanswered)`，而在还有必填没答的时候按回车，
   * **屏幕上什么都不会发生** —— 没有报错、没有提示，看着和终端卡死一模一样。
   *
   * 所以一格「可以留空」必须在 schema 上说，不能只在 title 里说。
   */
  it("把 optional 的那些格子留在 required 之外", () => {
    const question = clarificationQuestion({
      title: "t",
      items: [
        { id: "B01", question: "给谁用？", options: ["我", "团队", "外部"] },
        { id: "B01x", question: "你自己怎么说？", options: [], optional: true },
      ],
    })!;
    assert.deepEqual(question.requestedSchema.required, ["B01"]);
    // 但两格都在，都画得出来 —— optional 说的是「可以不答」，不是「不问」。
    assert.deepEqual(Object.keys(question.requestedSchema.properties),
      ["B01", "B01x"]);
  });
});

describe("L3 · reading what came back", () => {
  it("reads an accepted choice", () => {
    assert.deepEqual(
      readAnswer({ action: "accept", content: { [DECISION_FIELD]: "approve" } }),
      { action: "accept", content: { decision: "approve" } },
    );
  });

  it("reads a batch, booleans included", () => {
    assert.deepEqual(
      readAnswer({ action: "accept", content: { q1: "个人开发者", q3: true } }),
      { action: "accept", content: { q1: "个人开发者", q3: true } },
    );
  });

  /**
   * Measured: a human pressing Esc comes back as an ordinary result with
   * `action: "cancel"` and no content. Not an error, not a timeout, not an
   * empty accept -- StagePass would mistake all three for something else.
   */
  it("reads a decline as an answer, not a failure", () => {
    for (const action of ["cancel", "decline"] as const) {
      assert.deepEqual(readAnswer({ action }), { action, content: {} });
    }
  });

  it("refuses a result it cannot read, by name", () => {
    for (const result of [{}, { action: "maybe" }, { action: 7 }]) {
      assert.throws(
        () => readAnswer(result),
        (error: unknown) =>
          error instanceof UnreadableAnswerError
          && error.code === "answer_action_unknown",
      );
    }
    for (const content of [[], "text", { q1: { nested: true } }, { q1: 7 }]) {
      assert.throws(
        () => readAnswer({ action: "accept", content }),
        (error: unknown) =>
          error instanceof UnreadableAnswerError
          && error.code === "answer_content_invalid",
      );
    }
  });
});

describe("L3 · turning an answer into a decision", () => {
  it("returns the action the human picked", () => {
    const question = ask(SETTLED, CLEAN)!;
    assert.equal(
      decisionFrom(question, { action: "accept", content: { decision: "approve" } }),
      "approve",
    );
  });

  /**
   * Checked against the enum the human was actually shown, not against the
   * action list -- so an answer naming something that was never offered is
   * refused before it can become a command.
   */
  it("refuses an action that was not offered", () => {
    const question = ask(SETTLED, WITH_P0)!; // only `reject` was offered
    assert.equal(
      decisionFrom(question, { action: "accept", content: { decision: "approve" } }),
      null,
    );
    assert.equal(
      decisionFrom(question, { action: "accept", content: { decision: "settle" } }),
      null,
    );
  });

  it("returns nothing for a declined question", () => {
    const question = ask(SETTLED, CLEAN)!;
    for (const action of ["cancel", "decline"] as const) {
      assert.equal(decisionFrom(question, { action, content: {} }), null);
    }
  });

  it("returns nothing for a batch, which carries no gate action", () => {
    const batch = clarificationQuestion({
      title: "t", items: [{ id: "q1", question: "?", options: ["a", "b"] }],
    })!;
    assert.equal(
      decisionFrom(batch, { action: "accept", content: { q1: "a" } }),
      null,
    );
  });
});

describe("L3 · 接受风险问的是「哪一条」加「为什么」", () => {
  const waivable = [
    { id: "SPEC-1", title: "写入不是原子的" },
    { id: "SPEC-2", title: "命令行没有定义" },
  ];

  it("两个字段都必填 —— 一次点击给不出这两样，老树就死在这儿", () => {
    const question = waiveQuestion({ phase: "Spec", waivable })!;
    assert.deepEqual([...question.requestedSchema.required].sort(), ["gapId", "reason"]);
    assert.deepEqual(question.requestedSchema.properties.gapId?.enum, ["SPEC-1", "SPEC-2"]);
  });

  it("标题列在正文里 —— 只给一串 id 去选，等于让人凭记忆决定", () => {
    const question = waiveQuestion({ phase: "Spec", waivable })!;
    assert.match(question.message, /写入不是原子的/);
    assert.match(question.message, /命令行没有定义/);
  });

  it("没有可接受的 —— 不问", () => {
    // 一道没有选项的题比不问更糟：它打断人来展示一个做不了的决定。
    assert.equal(waiveQuestion({ phase: "Spec", waivable: [] }), null);
  });

  it("读回来：选了哪一条、写了什么", () => {
    const question = waiveQuestion({ phase: "Spec", waivable })!;
    assert.deepEqual(
      waiveFrom(question, {
        action: "accept",
        content: { gapId: "SPEC-2", reason: "这一版先不做命令行" },
      }),
      { gapId: "SPEC-2", reason: "这一版先不做命令行" });
  });

  it("选了一条没被提供过的 —— 拒绝", () => {
    // 对着问题自己的 enum 校验，不是对着当前还有哪些 gap —— enum 是人当时真正
    // 看见的东西。名单在他想的时候变了，就该拒绝，而不是把他的选择套到一条他
    // 没看见的问题上。
    const question = waiveQuestion({ phase: "Spec", waivable })!;
    assert.equal(
      waiveFrom(question, { action: "accept", content: { gapId: "SPEC-9", reason: "x" } }),
      null);
  });

  it("没写理由 —— 拒绝", () => {
    // 一个没有理由的 waive 和「忘了处理」在库里长得一模一样。
    const question = waiveQuestion({ phase: "Spec", waivable })!;
    assert.equal(
      waiveFrom(question, { action: "accept", content: { gapId: "SPEC-1", reason: "  " } }),
      null);
    assert.equal(
      waiveFrom(question, { action: "decline", content: {} }), null);
  });
});
