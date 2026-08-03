import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeGate, EMPTY_EVIDENCE, type Evidence } from "./gate";
import {
  BadQuestionShapeError,
  clarificationQuestion,
  decisionFrom,
  decisionLabel,
  DECISION_FIELD,
  gateDecisionQuestion,
  runsAgainHere,
  readAnswer,
  RESPONSE_AGREE,
  RAISE_SOMETHING,
  RAISE_NOTHING,
  FOLLOW_UP_CONFIRM_OPTION,
  responseFollowUpQuestion,
  RESPONSE_DISMISS,
  RESPONSE_OWN,
  RESPONSE_WAIVE,
  responsesFrom,
  UnreadableAnswerError,
  type Question,
  waiveQuestion,
  waiveFrom,
} from "./question";
import type { ChangeState } from "./change-state";
import type { Gap } from "./gap";

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
    // enum 里是**人看见的那句话**，不是动作名 —— `reject` 这个词没人猜得到它是重跑。
    assert.deepEqual(
      question.requestedSchema.properties[DECISION_FIELD]?.enum,
      [decisionLabel("approve", "Spec"), decisionLabel("reject", "Spec")],
    );
    assert.equal(question.requestedSchema.required[0], DECISION_FIELD);
    assert.match(question.message, /Spec/);
  });

  /**
   * The rule the old tree broke in five places at once: a button that is shown
   * and then refused. Here the option list IS the gate's permitted list, so
   * there is nothing to keep in sync.
   */
  /**
   * 2026-07-30 起这条变了：一个只被「还有问题挡着」拒掉的 approve **照样提供** ——
   * 因为人在同一道题里就能把那些问题驳回或接受掉（用户要的「现在再跑一轮，还是就
   * 这样批准？」）。判断权没有离开闸门：他没处理，落地时照样拒。
   */
  it("还有问题挡着时 approve 照样提供 —— 人能在同一次回答里清掉它", () => {
    assert.deepEqual(
      ask(SETTLED, WITH_P0)!.requestedSchema.properties[DECISION_FIELD]?.enum,
      [decisionLabel("approve", "Spec"), decisionLabel("reject", "Spec")],
    );
  });

  it("**什么都没产出时 approve 不提供** —— 那个拒是驳回问题清不掉的", () => {
    // 驳回一条问题变不出一份产物来。这一条还是 §5.4：永远执行不了的选项不许出现。
    const nothing = gateDecisionQuestion({
      phase: "Spec",
      gate: computeGate(SETTLED, EMPTY_EVIDENCE),
      summary: "s",
    })!;
    assert.deepEqual(nothing.requestedSchema.properties[DECISION_FIELD]?.enum,
      [decisionLabel("reject", "Spec")]);
  });

  it("offers retry, and only retry, on a blocked phase", () => {
    assert.deepEqual(
      ask(BLOCKED, WITH_P0)!.requestedSchema.properties[DECISION_FIELD]?.enum,
      [decisionLabel("retry", "Spec")],
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

describe("L3 · 裁决那一格说人话", () => {
  /*
   * 用户 2026-07-30 的原话：「**reject 这个词没人猜得到它是重跑。**」
   * 而它确实是：驳回一个设计阶段就是「在这儿再来一轮」，阶段一步都没动。
   */
  it("设计阶段的 reject 写「再来一轮」，而且不出现 reject 这个词", () => {
    const offered = ask(SETTLED, CLEAN)!.requestedSchema
      .properties[DECISION_FIELD]?.enum ?? [];
    assert.ok(offered.some((label) => label.includes("再来一轮")), offered.join(" / "));
    assert.ok(!offered.some((label) => label.includes("reject")));
    assert.ok(offered.some((label) => label.includes("批准")));
  });

  it("**Review / QA 的 reject 写「打回去修」** —— 同一个动作，两句不同的话", () => {
    // 驳回 Review 不是重跑 Review，是把活送到 Fix（`sendsToFix`）。用「再来一轮」
    // 去说它就是在界面上撒谎。
    for (const phase of ["Review", "QA"] as const) {
      const offered = gateDecisionQuestion({
        phase,
        gate: computeGate({ phase, status: "settled", returnPhase: null }, CLEAN),
        summary: "s",
      })!.requestedSchema.properties[DECISION_FIELD]?.enum ?? [];
      assert.ok(offered.some((label) => label.includes("打回去修")), `${phase}: ${offered}`);
      assert.ok(!offered.some((label) => label.includes("再来一轮")), phase);
    }
  });

  it("那句话回来之后映射回动作 —— 两种 reject 说法都是 reject", () => {
    for (const phase of ["Spec", "Review"] as const) {
      const question = gateDecisionQuestion({
        phase,
        gate: computeGate({ phase, status: "settled", returnPhase: null }, CLEAN),
        summary: "s",
      })!;
      assert.equal(decisionFrom(question, {
        action: "accept", content: { decision: decisionLabel("reject", phase) },
      }), "reject");
    }
  });

  it("认不出来的那句话 —— 什么都不推动", () => {
    // 失败的方向要在安全那一边：答案记下来，闸门不动。
    assert.equal(decisionFrom(ask(SETTLED, CLEAN)!, {
      action: "accept", content: { decision: "随便写一句" },
    }), null);
  });

  it("`runsAgainHere`：活儿留在这个阶段的那两句都算", () => {
    // 「再来一轮」和「重跑一次」都是「阶段一步没动，再跑一次」，中间那一步一样
    // 看不出来。「打回去修」不算：那时 Change 已经换到 Fix 了，自动在一个刚到的
    // 阶段上开跑，等于替人决定了 Fix 该做什么。
    assert.equal(runsAgainHere(decisionLabel("reject", "Spec")), true);
    assert.equal(runsAgainHere(decisionLabel("retry", "Spec")), true);
    assert.equal(runsAgainHere(decisionLabel("reject", "Review")), false);
    assert.equal(runsAgainHere(decisionLabel("approve", "Spec")), false);
    assert.equal(runsAgainHere(undefined), false);
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
        // 最后一格是选项格，不然整张表交不上去 —— 见下面那两条。
        { id: "B02", question: "什么明确不做？", options: ["甲", "乙", "丙"] },
      ],
    })!;
    assert.deepEqual(question.requestedSchema.required, ["B01", "B02"]);
    // 但三格都在，都画得出来 —— optional 说的是「可以不答」，不是「不问」。
    assert.deepEqual(Object.keys(question.requestedSchema.properties),
      ["B01", "B01x", "B02"]);
  });

  /*
   * 下面两条钉住的是**客户端的行为**，2026-07-30 在 Codex TUI 上实测出来的。它们
   * 不是风格约定：违反哪一条，人拿到的都是一张不对或者交不上去的表，而且屏幕上
   * 什么都不说。
   */
  it("**顺序不等于排序 —— 拒绝组题**", () => {
    // 实测：客户端按字段名排序显示，不按 properties 的书写顺序。这里悄悄替它排掉，
    // 组题的人写下的顺序就和人看到的顺序永远对不上，而他不会知道。
    assert.throws(() => clarificationQuestion({
      title: "t",
      items: [
        { id: "B02", question: "第二题", options: ["甲", "乙", "丙"] },
        { id: "B01", question: "第一题", options: ["甲", "乙", "丙"] },
      ],
    }), (error: unknown) => {
      assert.ok(error instanceof BadQuestionShapeError);
      assert.equal(error.code, "order_not_sorted");
      return true;
    });
  });

  it("**最后一格是可留空的自由文本 —— 拒绝组题**", () => {
    /*
     * 实测：光标停在一个空的自由文本格上按回车，屏幕上什么都不发生 —— optional
     * 不管用、必填项全答完也不管用、底下写着 `enter to submit all` 也不管用。
     * 而整张表只能从最后一格提交。所以这种表**交不上去**。
     */
    assert.throws(() => clarificationQuestion({
      title: "t",
      items: [
        { id: "B01", question: "第一题", options: ["甲", "乙", "丙"] },
        { id: "B02x", question: "还有什么？", options: [], optional: true },
      ],
    }), (error: unknown) => {
      assert.ok(error instanceof BadQuestionShapeError);
      assert.equal(error.code, "last_field_unsubmittable");
      assert.equal(error.detail, "B02x");
      return true;
    });
  });

  it("最后一格是**必填**的自由文本 —— 可以，人看得见「还差 1 个」", () => {
    const question = clarificationQuestion({
      title: "t",
      items: [
        { id: "B01", question: "第一题", options: ["甲", "乙", "丙"] },
        { id: "BZ", question: "最后一句", options: [] },
      ],
    })!;
    assert.deepEqual(question.requestedSchema.required, ["B01", "BZ"]);
  });
});

describe("L3 · 回应蓝方：一条 open gap 一道题", () => {
  /*
   * 用户 2026-07-30 的原话：「⑤ 我决定再来一轮还是接受 —— 路径存在但要两步、词是
   * `reject`、**我说的话没有容器**。」
   *
   * 他觉得反方第一条提错了、第二条可以带着走、第三条必须改 —— 三种意思在这之前只能
   * 压成一个 `reject`，而下一轮的红方什么也不知道。
   */
  const openGap = (id: string, title: string): Gap => ({
    id, kind: "finding", severity: "P1", title,
    status: "open", openedRound: 1, resolution: null, note: null,
  });
  const GAPS = [openGap("SPEC-1", "验收标准不可测"), openGap("SPEC-2", "范围与 PRD 冲突")];

  const asked = (gaps: readonly Gap[] = GAPS): Question => gateDecisionQuestion({
    phase: "PRD", gate: computeGate(SETTLED, CLEAN), summary: "第 1 轮已结算",
    openGaps: gaps,
  })!;

  const answered = (content: Record<string, string>, gaps: readonly Gap[] = GAPS) =>
    responsesFrom({
      question: asked(gaps),
      answer: { action: "accept", content },
      openGaps: gaps,
    });

  it("**第一趟一条 gap 一格，全是选项** —— 一路回车就裁决得完", () => {
    /*
     * 客户端空的自由文本格会吃掉回车（`optional` 也不管用）。原来每条 gap 摊成两格，
     * 于是八条 gap 就是八个空格子要挨个动手 —— 2026-08-03 真机上用户在八格里各打了
     * 一个「1」纯粹为了过去。理由改到第二趟去问（`responseFollowUps`），而且只问
     * 那几条**语义上真的需要理由**的。
     */
    const fields = Object.keys(asked().requestedSchema.properties);
    assert.deepEqual(fields, ["R01", "R02", "RY", DECISION_FIELD]);
    for (const field of Object.values(asked().requestedSchema.properties)) {
      assert.ok(field.enum, "第一趟里还有自由文本格");
    }
    // 标题里带着 id 和正文 —— 只给一个 R01 去选，等于让人凭记忆决定。
    assert.match(asked().requestedSchema.properties.R01!.title, /SPEC-1.*验收标准不可测/);
    assert.deepEqual(asked().requestedSchema.properties.R01?.enum,
      [RESPONSE_AGREE, RESPONSE_DISMISS, RESPONSE_WAIVE, RESPONSE_OWN]);
  });

  it("第一趟每一格都必答 —— 它们全是选项格，回车总有值", () => {
    assert.deepEqual(asked().requestedSchema.required,
      ["R01", "R02", "RY", DECISION_FIELD]);
  });

  /**
   * `decision` 排在最后**而且是选项格**，所以整张表提交得动（compose 第二条）。
   * 这不是巧合：小写 `d` 排在 `R` 之后，名字是这么挑的。
   */
  it("最后一格是裁决，而它是选项格", () => {
    const fields = Object.keys(asked().requestedSchema.properties);
    assert.equal(fields[fields.length - 1], DECISION_FIELD);
    assert.ok((asked().requestedSchema.properties[DECISION_FIELD]?.enum ?? []).length > 0);
  });

  it("不给 openGaps —— 和加这个参数之前逐字一样", () => {
    const plain = gateDecisionQuestion({
      phase: "PRD", gate: computeGate(SETTLED, CLEAN), summary: "s",
    })!;
    assert.deepEqual(Object.keys(plain.requestedSchema.properties), [DECISION_FIELD]);
  });

  it("四个选项各自分流到哪", () => {
    assert.deepEqual(answered({
      R01: RESPONSE_DISMISS, R01x: "验收标准在第 3 节，反方没读到",
      R02: RESPONSE_AGREE, R02x: "范围要按 PRD 收窄",
      [DECISION_FIELD]: decisionLabel("reject", "PRD"),
    }).responses, {
      "SPEC-1": { kind: "dismiss", reason: "验收标准在第 3 节，反方没读到" },
      "SPEC-2": { kind: "agree", note: "范围要按 PRD 收窄" },
    });

    assert.deepEqual(answered({
      R01: RESPONSE_WAIVE, R01x: "这一版先带着它走",
      R02: RESPONSE_OWN, R02x: "我要的是另一个意思",
      [DECISION_FIELD]: decisionLabel("approve", "PRD"),
    }).responses, {
      "SPEC-1": { kind: "waive", reason: "这一版先带着它走" },
      // 「我自己说」等同「同意」：他的文字进下一轮，这一条留着。
      "SPEC-2": { kind: "agree", note: "我要的是另一个意思" },
    });
  });

  it("同意但什么也没写 —— 也是一次表态，只是没有话要带", () => {
    assert.deepEqual(answered({
      R01: RESPONSE_AGREE, R02: RESPONSE_AGREE, [DECISION_FIELD]: decisionLabel("reject", "PRD"),
    }).responses, {
      "SPEC-1": { kind: "agree", note: "" },
      "SPEC-2": { kind: "agree", note: "" },
    });
  });

  it("一条都没选 —— 什么都不做，不猜", () => {
    assert.deepEqual(answered({ [DECISION_FIELD]: decisionLabel("reject", "PRD") }).responses, {});
  });

  it("按了 Esc —— 一条表态都不落，人的意思是「我先不决定」", () => {
    assert.deepEqual(responsesFrom({
      question: asked(), answer: { action: "cancel", content: {} }, openGaps: GAPS,
    }), { responses: {}, raised: "" });
  });

  it("人自己提的那条从 RYx 出来 —— RY 只是「有没有」", () => {
    // 第一趟点「有，我来提」，正文在第二趟那一格里。
    const read = answered({
      R01: RESPONSE_AGREE, R02: RESPONSE_AGREE,
      RY: RAISE_SOMETHING, RYx: "没说清楚失败时回滚到哪",
      [DECISION_FIELD]: decisionLabel("reject", "PRD"),
    });
    assert.equal(read.raised, "没说清楚失败时回滚到哪");
  });

  it("**全点「同意」就没有第二趟** —— 一个字都不用打", () => {
    const first = { action: "accept" as const, content: {
      R01: RESPONSE_AGREE, R02: RESPONSE_AGREE, RY: RAISE_NOTHING,
      [DECISION_FIELD]: decisionLabel("reject", "PRD"),
    } };
    assert.equal(responseFollowUpQuestion(GAPS, first), null);
  });

  it("**只有需要理由的那几条进第二趟**，压轴是选项格", () => {
    /*
     * 哪几条要问由语义定：同意不用说话；不同意 / 先接受风险都会关掉一条 gap，而
     * 一次没有理由的关闭和「这一轮忘了提」在库里长得一模一样；「我自己说」是他
     * 自己要求的。
     */
    const first = { action: "accept" as const, content: {
      R01: RESPONSE_DISMISS, R02: RESPONSE_AGREE, RY: RAISE_SOMETHING,
      [DECISION_FIELD]: decisionLabel("reject", "PRD"),
    } };
    const more = responseFollowUpQuestion(GAPS, first)!;
    assert.ok(more);
    const ids = Object.keys(more.requestedSchema.properties);
    assert.deepEqual(ids, ["R01x", "RYx", "z-confirm"]);
    // 空文本格吃回车、只有最后一格能提交 —— 所以压轴必须是选项格。
    assert.deepEqual(more.requestedSchema.properties["z-confirm"]?.enum,
      [FOLLOW_UP_CONFIRM_OPTION]);
  });

  it("点了「有」却没写 —— 就当没提", () => {
    const read = answered({
      R01: RESPONSE_AGREE, R02: RESPONSE_AGREE,
      RY: RAISE_SOMETHING, [DECISION_FIELD]: decisionLabel("reject", "PRD"),
    });
    assert.equal(read.raised, "");
  });

  it("**一道普通闸门裁决喂进来 —— 一条表态都读不出**", () => {
    // 位置对应只在真有 R01 那些格子时成立。没有它们就说明这不是一次「回应蓝方」，
    // 那就什么都不做 —— 不许拿 decision 那一格去套到某条 gap 上。
    const plain = gateDecisionQuestion({
      phase: "PRD", gate: computeGate(SETTLED, CLEAN), summary: "s",
    })!;
    assert.deepEqual(responsesFrom({
      question: plain,
      answer: { action: "accept", content: { [DECISION_FIELD]: decisionLabel("approve", "PRD") } },
      openGaps: GAPS,
    }), { responses: {}, raised: "" });
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
      decisionFrom(question, { action: "accept", content: { decision: decisionLabel("approve", "Spec") } }),
      "approve",
    );
  });

  /**
   * Checked against the enum the human was actually shown, not against the
   * action list -- so an answer naming something that was never offered is
   * refused before it can become a command.
   */
  it("refuses an action that was not offered", () => {
    // 什么都没产出 —— 那时 approve 真的没被提供（那个拒清不掉，见上面那条）。
    const question = ask(SETTLED, EMPTY_EVIDENCE)!;
    assert.equal(
      decisionFrom(question, { action: "accept", content: { decision: decisionLabel("approve", "Spec") } }),
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
