import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Gap } from "./gap";
import type { Assessment } from "./rubric";
import { applyAssessments, retireStandards, standardGapId } from "./rubric-gaps";

/**
 * 一轮 rubric 判定怎么变成挡门的东西，以及怎么不再挡。
 *
 * 三条不许含糊的规则，每一条都有测试盯着：
 *
 * 1. **开启读判定当时的快照，退休读当前 rubric。** 这个不对称是「编辑 rubric 只能
 *    关不能开」的全部依据 —— 一次编辑绝不可能让一个已盖章的 change 重新被挡。
 * 2. **退休需要正面证据，缺席永远不算。** 一轮在 rubric 跑之前就死掉，不是「标准
 *    已满足」的证据。
 * 3. **标了阻断的漏答视同阻断。** 否则漏答就成了一条绕过标准的路，而漏答是模型最
 *    可能做的事。
 */

const KEY = "RBC-a";
const ID = standardGapId("producer", KEY);

const judged = (patch: Partial<Assessment> = {}): Assessment => ({
  criterionKey: KEY,
  verdict: "no",
  evidence: "第 2 条只写了「要快」",
  criterionText: "每条需求都有可测的验收标准",
  blockingThen: true,
  ...patch,
});

const openStandard = (patch: Partial<Gap> = {}): Gap => ({
  id: ID, kind: "standard", severity: null,
  title: "每条需求都有可测的验收标准",
  status: "open", openedRound: 1, resolution: null, note: null,
  ...patch,
});

const apply = (before: readonly Gap[], assessments: readonly Assessment[], round = 1) =>
  applyAssessments(before, { round, role: "producer", assessments });

describe("L5 · 判定变成挡门的标准", () => {
  it("阻断的条目判 no —— 开一条 standard，标题用判定当时的正文", () => {
    const [gap] = apply([], [judged()]);
    assert.equal(gap?.id, ID);
    assert.equal(gap?.kind, "standard");
    assert.equal(gap?.severity, null);
    assert.equal(gap?.title, "每条需求都有可测的验收标准");
    assert.equal(gap?.status, "open");
  });

  it("阻断的条目漏答 —— 一样挡住", () => {
    // 漏答被静默当成通过，正是这套机制存在的理由。
    const [gap] = apply([], [judged({ verdict: "not_assessed", evidence: null })]);
    assert.equal(gap?.status, "open");
  });

  it("不阻断的条目判 no —— 只是没有 gap，不挡", () => {
    assert.deepEqual(apply([], [judged({ blockingThen: false })]), []);
  });

  it("同一条再判一次 no —— 还是那一条，不会开出第二条", () => {
    const after = apply([openStandard()], [judged()], 2);
    assert.equal(after.length, 1);
    assert.equal(after[0]?.openedRound, 1, "开出来的轮次不该被后一轮改写");
  });

  it("标题用快照，不回溯派生 —— 改了措辞的 rubric 动不了已经开出去的那条", () => {
    const after = apply([openStandard()], [judged({ criterionText: "换了个说法" })], 2);
    // 标题若跟着当前 rubric 变，specSourceDbHash 就会动，fence 跟着作废。
    assert.equal(after[0]?.title, "每条需求都有可测的验收标准");
  });
});

describe("L5 · 什么能让一条标准不再挡", () => {
  it("后续某轮答了 yes —— 关掉，并写明是哪一轮", () => {
    const [gap] = apply([openStandard()], [judged({ verdict: "yes", evidence: "都补上了" })], 3);
    assert.equal(gap?.status, "closed");
    assert.match(gap?.resolution ?? "", /3/);
  });

  it("这一轮里这条标准已经不阻断了 —— 关掉，理由是标准撤下了", () => {
    // 判定当时它已经不是阻断项，那就是「标准被撤下」在这一轮留下的正面证据。
    const [gap] = apply([openStandard()], [judged({ blockingThen: false })], 2);
    assert.equal(gap?.status, "closed");
    assert.match(gap?.resolution ?? "", /不再/);
  });

  it("**这一轮压根没提它 —— 保持开着**", () => {
    // 缺席永远不是证据。一轮在 rubric 跑之前就死掉，不等于标准满足了。
    const after = apply([openStandard()], [], 2);
    assert.equal(after[0]?.status, "open");
  });

  it("这一轮只提了别的条目 —— 它照样保持开着", () => {
    const after = apply([openStandard()], [judged({ criterionKey: "RBC-b" })], 2);
    const mine = after.find((gap) => gap.id === ID);
    assert.equal(mine?.status, "open");
  });

  it("关掉之后又判 no —— 重新开，轮次记新的", () => {
    const closed = openStandard({ status: "closed", resolution: "第 2 轮答了 yes" });
    const [gap] = apply([closed], [judged()], 4);
    assert.equal(gap?.status, "open");
    assert.equal(gap?.openedRound, 4);
    assert.equal(gap?.resolution, null);
  });

  it("不碰 finding —— 那是另一套东西", () => {
    const finding: Gap = {
      id: "G-1", kind: "finding", severity: "P0", title: "范围冲突",
      status: "open", openedRound: 1, resolution: null, note: null,
    };
    assert.deepEqual(apply([finding], [judged({ verdict: "yes" })], 2), [finding]);
  });
});

describe("L5 · 撤下标准时退休它派生的阻断项", () => {
  it("撤下一条 —— 关掉它派生的那条，理由带上人写的话", () => {
    const [gap] = retireStandards([openStandard()], "producer", [KEY], "这条本来就不该要求");
    assert.equal(gap?.status, "closed");
    assert.match(gap?.resolution ?? "", /这条本来就不该要求/);
  });

  it("没开着的不动", () => {
    const closed = openStandard({ status: "closed", resolution: "早就关了" });
    assert.deepEqual(retireStandards([closed], "producer", [KEY], "撤了"), [closed]);
  });

  it("只退休这个 role 的 —— 不同角色各有各的标准", () => {
    const critic = openStandard({ id: standardGapId("critic", KEY) });
    const after = retireStandards([openStandard(), critic], "producer", [KEY], "撤了");
    assert.equal(after.find((gap) => gap.id === ID)?.status, "closed");
    assert.equal(after.find((gap) => gap.id === critic.id)?.status, "open");
  });

  it("退休名单是空的就什么都不做", () => {
    const before = [openStandard()];
    assert.deepEqual(retireStandards(before, "producer", [], "随便"), before);
  });
});
