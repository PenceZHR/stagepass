import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Gap } from "./gap";
import { BLUE, judgePrompt, readRound, readVerdicts, RED, UnreadableVerdictError } from "./round";
import { TurnResultUnparsableError } from "./turn";

const answer = (artifacts: string[], blockers: object[] = []) =>
  "```json\n" + JSON.stringify({ artifactIds: artifacts, blockers }) + "\n```";

const gap = (id: string, title: string): Gap => ({
  id, kind: "finding", severity: "P1", title, status: "open", openedRound: 1, resolution: null,
});

describe("L4 · what the judge is told", () => {
  it("names both roles by their exact paths", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 2, task: "写出 Spec", openGaps: [],
    });
    assert.match(prompt, new RegExp(`"${RED}"`));
    assert.match(prompt, new RegExp(`"${BLUE}"`));
    assert.match(prompt, /Spec/);
    assert.match(prompt, /第 2 轮/);
  });

  it("carries the result contract to both roles", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 1, task: "写出 Spec", openGaps: [],
    });
    assert.match(prompt, /artifactIds/);
    assert.match(prompt, /P0\|P1\|P2/);
  });

  it("lists the open problems the judge must rule on", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 3, task: "t",
      openGaps: [gap("SPEC-1", "范围与 PRD 冲突"), gap("SPEC-2", "验收不可测")],
    });
    assert.match(prompt, /SPEC-1 \[P1\] 范围与 PRD 冲突/);
    assert.match(prompt, /SPEC-2 \[P1\] 验收不可测/);
  });

  /**
   * The rule has to reach the judge, not just the code. A judge that believes
   * silence closes a problem will close problems by staying quiet.
   */
  it("tells the judge that silence keeps a problem open", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 2, task: "t", openGaps: [gap("SPEC-1", "x")],
    });
    assert.match(prompt, /沉默等于仍然存在/);
  });

  /**
   * Blue investigating the repository turns an attack on the artifact into an
   * investigation of something else, and the gap it reports stops being about
   * the document under review.
   */
  it("tells blue to attack the artifact and nothing else", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 1, task: "t", openGaps: [],
    });
    assert.match(prompt, /只许基于正方产出提出问题/);
    assert.match(prompt, /不要去读仓库/);
  });

  it("says nothing to rule on when nothing is open", () => {
    assert.match(
      judgePrompt({ phase: "PRD", round: 1, task: "t", openGaps: [] }),
      /没有未关闭的问题/,
    );
  });

  /**
   * 一条 `standard` 没有 severity（rubric 是二元判断，REMAP §5.1）。原来无条件插
   * `[${gap.severity}]`，于是每条 rubric 派生的 gap 在裁判眼里都是 `[null]` ——
   * 一个模型看不懂的分级，而它正要对这条表态。
   */
  it("一条 standard 写「标准」，不写 [null]", () => {
    const prompt = judgePrompt({
      phase: "Spec", round: 2, task: "t",
      openGaps: [{
        id: "RB:producer:RBC-a", kind: "standard", severity: null,
        title: "每条需求都有可测的验收标准",
        status: "open", openedRound: 1, resolution: null,
      }],
    });
    assert.match(prompt, /RB:producer:RBC-a \[标准\]/);
    assert.doesNotMatch(prompt, /\[null\]/);
  });
});

describe("L4 · 人提的要求单独一区", () => {
  /*
   * 用户 2026-07-30：「judgePrompt 把人开的那些单独列出来，措辞要区别于模型报的。」
   *
   * 混在一起列，「用户明确要求的」和「反方顺口提的」在裁判眼里一模一样 —— 而分量
   * 不一样：判一条模型报的问题不成立是裁判的本职；一条人提的要求，它不该拿「我觉得
   * 这个建议可以不采纳」把它关掉。
   */
  const human = (id: string, title: string): Gap => ({ ...gap(id, title) });

  it("分区，而且措辞明确说了它不是建议", () => {
    const prompt = judgePrompt({
      phase: "PRD", round: 2, task: "t",
      openGaps: [
        gap("SPEC-1", "验收不可测"),
        human("HUMAN-1", "没说清楚失败时回滚到哪"),
      ],
    });
    assert.match(prompt, /人明确要求下一轮处理的（不许当成建议）/);
    assert.match(prompt, /HUMAN-1 \[P1\] 没说清楚失败时回滚到哪/);
    assert.match(prompt, /之前轮次报出来的问题/);
    // 人提的排在模型报的前面 —— 先看要求，再看建议。
    assert.ok(prompt.indexOf("HUMAN-1") < prompt.indexOf("SPEC-1"));
  });

  it("没有人提的问题时**不出现那一区**，也不留一段空白", () => {
    // 提示词里一段没内容的标题是噪音，而噪音会挤掉真正要读的东西。
    const prompt = judgePrompt({
      phase: "PRD", round: 2, task: "t", openGaps: [gap("SPEC-1", "验收不可测")],
    });
    assert.doesNotMatch(prompt, /人明确要求/);
    // 只有模型报的那些时也不加那句分隔标题 —— 没有第二区要跟它分开。
    assert.doesNotMatch(prompt, /之前轮次报出来的问题/);
    assert.match(prompt, /SPEC-1 \[P1\] 验收不可测/);
  });

  it("只有人提的问题时，模型那一区也不出现", () => {
    const prompt = judgePrompt({
      phase: "PRD", round: 2, task: "t", openGaps: [human("HUMAN-1", "我要的")],
    });
    assert.match(prompt, /人明确要求下一轮处理的/);
    assert.doesNotMatch(prompt, /之前轮次报出来的问题/);
    assert.doesNotMatch(prompt, /没有未关闭的问题/);
  });

  it("**仍然可以被判 closed** —— 这里管的是措辞，不是给它免疫", () => {
    // 人的要求真被满足了就该关掉。加一层「人提的不可关闭」等于让人给自己设一道
    // 自己也打不开的闸门。
    const prompt = judgePrompt({
      phase: "PRD", round: 2, task: "t", openGaps: [human("HUMAN-1", "我要的")],
    });
    assert.match(prompt, /"kind": "closed" \| "still_open"/);
  });
});

describe("L4 · reading the judge's verdicts", () => {
  it("reads a verdict on each named problem", () => {
    assert.deepEqual(readVerdicts(
      '```json\n{"verdicts":{"SPEC-1":{"kind":"closed","reason":"范围已收窄"},'
      + '"SPEC-2":{"kind":"still_open","reason":"仍不可测"}}}\n```',
    ), {
      verdicts: {
        "SPEC-1": { kind: "closed", reason: "范围已收窄" },
        "SPEC-2": { kind: "still_open", reason: "仍不可测" },
      },
    });
  });

  /**
   * A judge that said nothing readable has ruled on nothing, and every open gap
   * stays open. That is the safe direction, so it is not an error.
   */
  it("yields no verdicts when the judge said nothing readable", () => {
    for (const text of ["都挺好的", "```json\n{}\n```", '{"verdicts":null}']) {
      assert.deepEqual(readVerdicts(text), { verdicts: {} });
    }
  });

  /**
   * But a malformed verdict IS refused: dropping it silently would look exactly
   * like the judge having stayed quiet, and those two must not be confusable.
   */
  it("refuses a verdict that claims to be one and is not", () => {
    for (const bad of [
      '{"verdicts":{"G-1":{"kind":"maybe","reason":"r"}}}',
      '{"verdicts":{"G-1":{"kind":"closed"}}}',
      '{"verdicts":{"G-1":{"kind":"closed","reason":"  "}}}',
      '{"verdicts":[]}',
    ]) {
      assert.throws(() => readVerdicts(bad), UnreadableVerdictError, bad);
    }
  });
});

describe("L4 · each role is read from its own transcript", () => {
  it("takes artifacts from red and problems from blue", () => {
    const reading = readRound({
      round: 2,
      red: answer(["spec.md"]),
      blue: answer([], [{ id: "SPEC-9", severity: "P0", title: "范围冲突" }]),
      judge: '```json\n{"verdicts":{}}\n```',
    });
    assert.deepEqual(reading.artifactIds, ["spec.md"]);
    assert.deepEqual(reading.outcome.found, [
      { id: "SPEC-9", severity: "P0", title: "范围冲突" },
    ]);
    assert.equal(reading.outcome.round, 2);
  });

  /**
   * A producer grading its own work is not an adversarial finding. Counting
   * red's blockers would let it decide how bad its own output is, which is
   * blue's job precisely because red cannot do it.
   */
  it("ignores problems red reported about its own work", () => {
    const reading = readRound({
      round: 1,
      red: answer(["spec.md"], [{ id: "RED-SELF", kind: "finding", severity: "P0", title: "我觉得还行" }]),
      blue: answer([], []),
      judge: "",
    });
    assert.deepEqual(reading.outcome.found, []);
  });

  /**
   * A blue that answered in the wrong shape found nothing StagePass can act on.
   * Reading that as "no problems" would turn a broken attacker into a clean
   * bill of health.
   */
  it("fails the round when blue's answer cannot be read", () => {
    assert.throws(
      () => readRound({
        round: 1, red: answer(["spec.md"]), blue: "看起来没问题", judge: "",
      }),
      (error: unknown) =>
        error instanceof TurnResultUnparsableError
        && error.detail.startsWith("blue:"),
    );
  });

  it("fails the round when red produced nothing readable", () => {
    assert.throws(
      () => readRound({ round: 1, red: "写完了", blue: answer([]), judge: "" }),
      TurnResultUnparsableError,
    );
  });

  it("carries the judge's verdicts into the round's outcome", () => {
    const reading = readRound({
      round: 3,
      red: answer(["spec.md"]),
      blue: answer([]),
      judge: '```json\n{"verdicts":{"SPEC-1":{"kind":"closed","reason":"已收窄"}}}\n```',
    });
    assert.deepEqual(reading.outcome.verdicts, {
      "SPEC-1": { kind: "closed", reason: "已收窄" },
    });
  });
});
