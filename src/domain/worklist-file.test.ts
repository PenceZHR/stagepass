import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readWorklistAnswers, renderWorklist } from "./worklist";
import type { WorkItemDraft } from "./worklist";

const GAP: WorkItemDraft = {
  kind: "gap",
  target: "RB:critic:RBC-8f3a1c22-0000-4000-8000-000000000001",
  prompt: "这个问题还成不成立？\n去重语义没定义\n人说：按 url 去重",
  choices: ["closed", "still_open"],
};
const CRITERION: WorkItemDraft = {
  kind: "criterion",
  target: "0f7d2b9e-1111-4000-8000-000000000002",
  prompt: "反方这一轮挑问题的表现：这一条标准满足了吗？\n有没有指出可证伪的问题",
  choices: ["yes", "no"],
};

describe("L0 · 名单印成文件", () => {
  it("**序号是模型看得到的唯一身份 —— target 一个字都不出现**", () => {
    const rendered = renderWorklist([GAP, CRITERION]);

    assert.match(rendered, /^1\. /m);
    assert.match(rendered, /^2\. /m);
    assert.doesNotMatch(rendered, /RBC-8f3a1c22/);
    assert.doesNotMatch(rendered, /0f7d2b9e/);
  });

  it("每一条把它自己的可选项印在旁边 —— 两种条目的选项不一样", () => {
    const rendered = renderWorklist([GAP, CRITERION]);

    assert.match(rendered, /`closed`.*`still_open`/);
    assert.match(rendered, /`yes`.*`no`/);
  });

  it("多行的正文缩进进去，不会被读成下一条", () => {
    const rendered = renderWorklist([GAP]);
    const lines = rendered.split("\n").filter((line) => /^\d+\. /.test(line));

    assert.equal(lines.length, 1);
  });
});

describe("L0 · 把答案按序号读回来", () => {
  const items = [GAP, CRITERION];

  it("按序号映射，模型一个标识符都不用写", () => {
    const read = readWorklistAnswers("1: closed —— 已经按 url 去重了\n2: yes —— 它报了三条可证伪的", items);

    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.answers, [
      { ordinal: 1, answer: "closed", reason: "已经按 url 去重了" },
      { ordinal: 2, answer: "yes", reason: "它报了三条可证伪的" },
    ]);
  });

  it("**答一半不作废** —— 沉默的那几条保持原样，这是它的判断", () => {
    const read = readWorklistAnswers("2: no —— 一条都没报", items);

    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.answers.map((each) => each.ordinal), [2]);
  });

  it("文件不在 = 它没写。说出来，而不是当成「全都没问题」", () => {
    const read = readWorklistAnswers(null, items);

    assert.deepEqual(read.answers, []);
    assert.deepEqual(read.problems, ["worklist_answers_missing"]);
  });

  it("**答了一个不在选项里的值，那一条不算** —— 枚举是这套机制的全部意义", () => {
    const read = readWorklistAnswers("1: maybe —— 说不好", items);

    assert.deepEqual(read.answers, []);
    assert.deepEqual(read.problems, ["worklist_answer_not_a_choice:1"]);
  });

  it("范围外的序号映不回任何一条，报出来", () => {
    const read = readWorklistAnswers("7: closed —— 修了", items);

    assert.deepEqual(read.answers, []);
    assert.deepEqual(read.problems, ["worklist_answer_out_of_range:7"]);
  });

  it("同一条答两次是含糊，取第一次并且说出来", () => {
    const read = readWorklistAnswers("1: closed —— 修了\n1: still_open —— 又觉得没修", items);

    assert.deepEqual(read.answers, [{ ordinal: 1, answer: "closed", reason: "修了" }]);
    assert.deepEqual(read.problems, ["worklist_answer_duplicated:1"]);
  });

  it("**没写理由的不算** —— 关掉一个问题必须说清它为什么不再成立", () => {
    const read = readWorklistAnswers("1: closed", items);

    assert.deepEqual(read.answers, []);
    assert.deepEqual(read.problems, ["worklist_answer_has_no_reason:1"]);
  });

  it("读不懂的行不是问题 —— 它可能写了标题或者说明", () => {
    const read = readWorklistAnswers(
      "# 逐条表态\n\n（说明）\n1: closed —— 修了\n", items,
    );

    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.answers.map((each) => each.ordinal), [1]);
  });

  it("破折号是排版不是内容，中文冒号和列表符号都认", () => {
    const read = readWorklistAnswers("- 1：closed -- 修了", items);

    assert.deepEqual(read.answers, [{ ordinal: 1, answer: "closed", reason: "修了" }]);
  });
});
