import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MINIMAL_PHASE_INSTRUCTIONS } from "../codex/turn-runner";
import { defaultCriteria } from "./rubric-defaults";

/**
 * 出厂标准和阶段指令**必须配对**。
 *
 * 「模型答不出它没被问过的题」是这棵树上反复出现的那条：一条标准要求的东西，如果
 * 红方的任务书里没写，那条标准每一轮都会判不满足 —— 而那不是模型不行，是我们在罚
 * 它没做一件没人让它做的事。
 *
 * 这里只钉住 Build 那一对，因为它是唯一一条**判它的人做不到的事**：蓝方读得了代码
 * 但跑不了东西，所以「跑过没有」只能靠红方交证据。别的阶段的标准都是读产出就能判的。
 */
describe("出厂标准 · 要求的东西必须先被要求", () => {
  it("**Build 要「运行证据」，任务书里就得让红方交**", () => {
    const wantsEvidence = defaultCriteria("Build", "producer")
      .some((entry) => entry.text.includes("运行证据"));
    assert.ok(wantsEvidence, "Build 的标准里没有运行证据这条了 —— 这条测试该跟着改");
    assert.match(
      MINIMAL_PHASE_INSTRUCTIONS.Build, /output/,
      "标准要运行证据，任务书却没让红方交 —— 它每一轮都会被判不满足",
    );
  });

  it("Build 的标准里不许出现「判它的人做不到」的动作", () => {
    // 蓝方不自己执行（domain/round.ts 的 blueReach）。一条要求判定者去跑的标准
    // 只能靠猜，而一条只能靠猜的标准比没有更糟：它每一轮都给出一个没有依据的 yes。
    for (const entry of defaultCriteria("Build", "producer")) {
      assert.doesNotMatch(entry.text, /^自己跑过/, `这条要判定者去跑：${entry.text}`);
    }
  });

  it("出厂的一条都不阻断 —— 这是拍过板的，别顺手翻掉", () => {
    for (const phase of ["PRD", "Build", "Review"] as const) {
      for (const entry of defaultCriteria(phase, "producer")) {
        assert.equal(entry.blocking, false, `${phase}：${entry.text}`);
      }
    }
  });
});
