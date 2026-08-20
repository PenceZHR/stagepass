import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advancesTo,
  DEFAULT_GRAPH,
  InvalidPhaseGraphError,
  isRetired,
  PHASES,
  phaseGraphOf,
  TERMINAL_PHASE,
  upstreamOf,
} from "./phase";

/**
 * L0 · 阶段图是数据，不是常量（BACKLOG §4.5）。
 *
 * bootstrap 框架下「只有一个 Change，YAGNI」不成立 —— 不是每个项目都值得走
 * 全部八个阶段（§1.5·④）。图变成值：默认图 = 全序，自定义图 = 全序的**子序列**
 * （跳过阶段，不重排 —— 重排会让「上游」这个词失去意义，而长回边建在它上面）。
 */
describe("L0 · 阶段图是值：环 v3 的八阶段主线", () => {
  it("默认图的主线 = 环 v3 的八个，QA 收尾", () => {
    // 钻石结构：BuildPlan∥TestPlan、Build∥Test 的并行走座位层，图保持全序。
    assert.deepEqual(DEFAULT_GRAPH.order, [
      "PRD", "Spec", "Arch", "BuildPlan", "TestPlan", "Build", "Test", "QA",
    ]);
  });

  it("advancesTo 沿主线走，终点是 QA", () => {
    assert.equal(advancesTo("PRD"), "Spec");
    assert.equal(advancesTo("Build"), "Test");
    assert.equal(advancesTo("Test"), "QA");
    assert.equal(advancesTo("QA"), null);
  });

  it("advancesTo 对退休阶段抛 unknown_phase —— 静默的 null 会被当成终点直接 closed", () => {
    for (const phase of ["Fix", "Plan", "Review", "Merge", "Retro", "Done"] as const) {
      assert.throws(
        () => advancesTo(phase),
        (error: unknown) => error instanceof InvalidPhaseGraphError
          && error.code === "unknown_phase",
        phase,
      );
    }
  });

  it("子序列图：advancesTo 沿着子序列走", () => {
    const graph = phaseGraphOf(["PRD", "Build", "QA"]);
    assert.equal(advancesTo("PRD", graph), "Build");
    assert.equal(advancesTo("Build", graph), "QA");
    assert.equal(advancesTo("QA", graph), null);
  });

  it("退休名单 = 七个；主线上一个退休的都没有", () => {
    for (const phase of ["TechSpec", "Plan", "Review", "Fix", "Merge", "Retro", "Done"]) {
      assert.ok(isRetired(phase), phase);
      assert.ok(!DEFAULT_GRAPH.order.includes(phase as never), phase);
    }
    assert.equal(TERMINAL_PHASE, "QA");
  });
});

describe("L0 · 图的合法性 —— 拒绝在构造时发生，不在走到一半时", () => {
  it("必须以终点（QA）收尾 —— 终点语义全树按名字判", () => {
    assert.throws(
      () => phaseGraphOf(["PRD", "Build"]),
      (error: unknown) => error instanceof InvalidPhaseGraphError
        && error.code === "must_end_with_terminal",
    );
  });

  it("退休的阶段不许进图 —— Fix / Plan / Done 都一样，报错指着「它没了」", () => {
    for (const retired of ["Fix", "Plan", "Done"]) {
      assert.throws(
        () => phaseGraphOf(["PRD", retired, "QA"]),
        (error: unknown) => error instanceof InvalidPhaseGraphError
          && error.code === "retired_phase",
        retired,
      );
    }
  });

  it("不认识的阶段名 —— 拒绝（One phase, one name）", () => {
    assert.throws(
      () => phaseGraphOf(["PRD", "Implement", "QA"]),
      (error: unknown) => error instanceof InvalidPhaseGraphError
        && error.code === "unknown_phase",
    );
  });

  it("重排 —— 拒绝：「上游」这个词建立在全序上，长回边全靠它", () => {
    assert.throws(
      () => phaseGraphOf(["Spec", "PRD", "QA"]),
      (error: unknown) => error instanceof InvalidPhaseGraphError
        && error.code === "not_a_subsequence",
    );
  });

  it("空的 —— 拒绝", () => {
    assert.throws(
      () => phaseGraphOf([]),
      (error: unknown) => error instanceof InvalidPhaseGraphError
        && error.code === "must_end_with_terminal",
    );
  });
});

describe("L0 · upstreamOf —— sendBack 的合法目标名单（按消费算）", () => {
  it("设计链：严格上游，按主线顺序", () => {
    assert.deepEqual(upstreamOf("Spec"), ["PRD"]);
    assert.deepEqual(upstreamOf("Arch"), ["PRD", "Spec"]);
    assert.deepEqual(upstreamOf("BuildPlan"), ["PRD", "Spec", "Arch"]);
    assert.deepEqual(upstreamOf("TestPlan"), ["PRD", "Spec", "Arch"]);
  });

  /**
   * **两轨互盲是消费表说的，不是提示词说的**：Build 的上游里没有任何 Test 轨的
   * 东西，Test 的上游里没有任何 Build 轨的东西。这两条破了，打回选项就会摆出
   * 「从 Build 打回 TestPlan」这种必然说不通的边 —— 而任务书的上游投递读的是
   * 同一张表，破了就是把测试递给了施工方。
   */
  it("Build 只够得着施工轨：上游里没有 TestPlan / Test", () => {
    assert.deepEqual(upstreamOf("Build"), ["PRD", "Spec", "Arch", "BuildPlan"]);
  });

  it("Test 只够得着测试轨：上游里没有 BuildPlan / Build", () => {
    assert.deepEqual(upstreamOf("Test"), ["PRD", "Spec", "Arch", "TestPlan"]);
  });

  it("QA 是对撞点：两条轨都在它的上游里 —— 三向归因的名单从这儿来", () => {
    assert.deepEqual(upstreamOf("QA"),
      ["PRD", "Spec", "Arch", "BuildPlan", "TestPlan", "Build", "Test"]);
  });

  it("第一个阶段没有上游 —— 空名单，问出去就是一道没有选项的题", () => {
    // 全序图的头一个阶段没有上游。（起点本身归项目的图管，见 ChangeStore.create）
    assert.deepEqual(upstreamOf("PRD"), []);
  });

  it("Fix 退休且从不在主线上 —— 没有「上游」可言", () => {
    assert.deepEqual(upstreamOf("Fix"), []);
  });

  it("子序列图里上游跟着图走", () => {
    const graph = phaseGraphOf(["PRD", "Build", "QA"]);
    assert.deepEqual(upstreamOf("Build", graph), ["PRD"]);
  });

  it("每个阶段名仍然只有一份 —— PHASES 是全集，图只是选择", () => {
    for (const phase of DEFAULT_GRAPH.order) {
      assert.ok((PHASES as readonly string[]).includes(phase));
    }
  });

  it("传递闭包跨得过被跳掉的阶段", () => {
    // Arch 被跳了，BuildPlan 的上游仍然是 Spec / PRD —— 传递过来的。
    const graph = phaseGraphOf(["PRD", "Spec", "BuildPlan", "Build", "QA"]);
    assert.deepEqual(upstreamOf("BuildPlan", graph), ["PRD", "Spec"]);
  });

  /**
   * **名单的顺序是有语义的**：`journey.ts` 画环时取 `.at(-1)` 当「最近的那个上游」。
   * 闭包的遍历顺序不是主线顺序，靠它等于靠巧合。
   */
  it("名单按主线顺序排 —— `.at(-1)` 必须是最近的那个上游", () => {
    for (const phase of PHASES) {
      const upstream = upstreamOf(phase);
      const byOrder = DEFAULT_GRAPH.order.filter((each) => upstream.includes(each));
      assert.deepEqual(upstream, byOrder, phase);
    }
    assert.equal(upstreamOf("Build").at(-1), "BuildPlan");
    assert.equal(upstreamOf("QA").at(-1), "Test");
  });

  /**
   * 退休阶段的历史行还要读得出：它们的消费行留在表里，`upstreamOf` 照样算得动
   * （按图过滤后给出的是主线上的祖先）。没有 Change 会再走到这儿去问，但读历史
   * 的代码问到了不许炸。
   */
  it("退休阶段问上游不炸 —— 历史要读得出", () => {
    assert.deepEqual(upstreamOf("TechSpec"), ["PRD", "Spec", "Arch"]);
    assert.deepEqual(upstreamOf("Review"), ["PRD", "Spec", "Arch", "BuildPlan", "Build"]);
  });
});
