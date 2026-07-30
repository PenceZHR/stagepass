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

describe("出厂标准 · 共用的 critic 不许和某个阶段的规矩打架", () => {
  /**
   * `CRITIC` 是**所有阶段共用一份**（它讲的是方法，不是产物）。所以它里面任何一句
   * 绝对化的话，都必须在**每一个**阶段都成立。
   *
   * 2026-07-30 抓到的一次：那条原来写「没有提出需要读仓库或跑代码才能验证的问题 ——
   * 只基于摆在面前的产出」。而 Build 和 Review 的蓝方现在**明确被允许读代码** ——
   * 裁判会拿这条把蓝方最有价值的那类发现判成违规，正好把新开的权限抵消掉。
   */
  it("**不许写死「只基于摆在面前的产出」** —— 有的阶段蓝方就是要去读代码", () => {
    for (const entry of defaultCriteria("Review", "critic")) {
      assert.doesNotMatch(entry.text, /只基于摆在面前的产出|不.*读仓库/,
        `这条和 Review 的蓝方规矩打架：${entry.text}`);
    }
  });

  it("这条护栏不是空转的 —— critic 那一份确实有内容", () => {
    assert.ok(defaultCriteria("Review", "critic").length >= 3);
  });
});
