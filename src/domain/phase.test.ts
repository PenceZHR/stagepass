import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advancesTo,
  DEFAULT_GRAPH,
  FIRST_PHASE,
  InvalidPhaseGraphError,
  PHASES,
  phaseGraphOf,
  upstreamOf,
  type Phase,
} from "./phase";

/**
 * L0 · 阶段图是数据，不是常量（BACKLOG §4.5）。
 *
 * bootstrap 框架下「只有一个 Change，YAGNI」不成立 —— 不是每个项目都值得走
 * 12 个阶段（§1.5·④）。图变成值：默认图 = 全序，自定义图 = 全序的**子序列**
 * （跳过阶段，不重排 —— 重排会让「上游」这个词失去意义，而长回边建在它上面）。
 */
describe("L0 · 阶段图是值：默认图与老常量逐字一致", () => {
  it("默认图的主线 = 除 Fix 外的 11 个阶段，Done 收尾", () => {
    assert.deepEqual(DEFAULT_GRAPH.order, [
      "PRD", "Spec", "TechSpec", "Plan", "TestPlan",
      "Build", "Review", "QA", "Merge", "Retro", "Done",
    ]);
  });

  it("advancesTo 不带图参数 —— 和原来那张 ADVANCES_TO 逐字一致", () => {
    assert.equal(advancesTo("PRD"), "Spec");
    assert.equal(advancesTo("Review"), "QA");
    assert.equal(advancesTo("Retro"), "Done");
    assert.equal(advancesTo("Done"), null);
    // Fix 不在主线上：进它靠打回，出它靠弹栈，不靠这张图。
    assert.equal(advancesTo("Fix"), null);
  });

  it("子序列图：advancesTo 沿着子序列走", () => {
    const graph = phaseGraphOf(["PRD", "Build", "Review", "Done"]);
    assert.equal(advancesTo("PRD", graph), "Build");
    assert.equal(advancesTo("Build", graph), "Review");
    assert.equal(advancesTo("Review", graph), "Done");
    assert.equal(advancesTo("Done", graph), null);
  });
});

describe("L0 · 图的合法性 —— 拒绝在构造时发生，不在走到一半时", () => {
  it("必须以 Done 收尾 —— 终点语义全树按名字判", () => {
    assert.throws(
      () => phaseGraphOf(["PRD", "Build"]),
      (error: unknown) => error instanceof InvalidPhaseGraphError
        && error.code === "must_end_with_done",
    );
  });

  it("Fix 不许进主线 —— 它由打回进入，写进主线就是每个阶段都路过修理厂", () => {
    assert.throws(
      () => phaseGraphOf(["PRD", "Fix", "Done"]),
      (error: unknown) => error instanceof InvalidPhaseGraphError
        && error.code === "fix_not_on_the_line",
    );
  });

  it("不认识的阶段名 —— 拒绝（One phase, one name）", () => {
    assert.throws(
      () => phaseGraphOf(["PRD", "Implement", "Done"]),
      (error: unknown) => error instanceof InvalidPhaseGraphError
        && error.code === "unknown_phase",
    );
  });

  it("重排 —— 拒绝：「上游」这个词建立在全序上，长回边全靠它", () => {
    assert.throws(
      () => phaseGraphOf(["Spec", "PRD", "Done"]),
      (error: unknown) => error instanceof InvalidPhaseGraphError
        && error.code === "not_a_subsequence",
    );
  });

  it("空的 —— 拒绝", () => {
    assert.throws(
      () => phaseGraphOf([]),
      (error: unknown) => error instanceof InvalidPhaseGraphError
        && error.code === "must_end_with_done",
    );
  });
});

describe("L0 · upstreamOf —— sendBack 的合法目标名单", () => {
  it("严格上游，按主线顺序", () => {
    assert.deepEqual(upstreamOf("TechSpec"), ["PRD", "Spec"]);
    assert.deepEqual(upstreamOf("Spec"), ["PRD"]);
  });

  it("第一个阶段没有上游 —— 空名单，问出去就是一道没有选项的题", () => {
    assert.deepEqual(upstreamOf(FIRST_PHASE), []);
  });

  it("Fix 不在主线上 —— 没有「上游」可言", () => {
    assert.deepEqual(upstreamOf("Fix"), []);
  });

  it("子序列图里上游跟着图走", () => {
    const graph = phaseGraphOf(["PRD", "Build", "Review", "Done"]);
    assert.deepEqual(upstreamOf("Review", graph), ["PRD", "Build"]);
  });

  it("每个阶段名仍然只有一份 —— PHASES 是全集，图只是选择", () => {
    for (const phase of DEFAULT_GRAPH.order) {
      assert.ok((PHASES as readonly string[]).includes(phase));
    }
  });

  /**
   * §8.6·①：**上游按「真正消费谁」算，不按顺序上谁在前面。**
   *
   * `upstreamOf("TestPlan")` 原来含 `Plan` —— 面板就摆着「从 TestPlan 打回 Plan」
   * 这个选项，而 TestPlan 从来没消费过 Plan 的任何东西。一个必然说不通的打回摆在
   * 人眼前，和一个假选项没有区别。
   */
  it("**TestPlan 的上游里没有 Plan** —— 它没消费过 Plan 的任何东西", () => {
    assert.deepEqual(upstreamOf("TestPlan"), ["PRD", "Spec", "TechSpec"]);
    assert.deepEqual(upstreamOf("Plan"), ["PRD", "Spec", "TechSpec"]);
  });

  /**
   * 换掉的只有 TestPlan 那一行。**其余十一个逐条和原来的顺序前缀一致** ——
   * 这条把「这一刀有多窄」钉住：Build 消费 Plan 和 TestPlan，传递下去仍然够得着
   * TechSpec / Spec / PRD；Review 之后的每一个都通过 Build 够得着全部。
   */
  it("除 TestPlan 外，谁的上游都没变", () => {
    const prefix = (phase: Phase): Phase[] => {
      const at = DEFAULT_GRAPH.order.indexOf(phase);
      return at <= 0 ? [] : [...DEFAULT_GRAPH.order.slice(0, at)];
    };
    for (const phase of PHASES) {
      if (phase === "TestPlan" || phase === "Fix") continue;
      assert.deepEqual(upstreamOf(phase), prefix(phase), phase);
    }
  });

  it("传递闭包跨得过被跳掉的阶段", () => {
    // TechSpec 被跳了，Plan 的上游仍然是 Spec / PRD —— 传递过来的。
    const graph = phaseGraphOf(["PRD", "Spec", "Plan", "Build", "Review", "Done"]);
    assert.deepEqual(upstreamOf("Plan", graph), ["PRD", "Spec"]);
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
    assert.equal(upstreamOf("Build").at(-1), "TestPlan");
  });
});
