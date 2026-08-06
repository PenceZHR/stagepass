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
});
