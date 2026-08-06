import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MINIMAL_PHASE_INSTRUCTIONS } from "../codex/turn-runner";
import { PHASES } from "./phase";
import { reportsFreeFormBlockers } from "./phase-play";
import { templateFor } from "./phase-template";
import { RUBRIC_ROLES } from "./rubric";
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

  /*
   * 「出厂一律不阻断」是 2026-07-31 拍的，2026-08-06 **只被挂了模板节的那些narrowly
   * 例外掉**。所以这条护栏改成钉那个例外的边界，而不是放宽 ——
   * 判据是**结构性的**：阻断 ⟺ 挂了节，两个方向都要成立。
   */
  it("阻断 ⟺ 挂了模板节，一条都不许多", () => {
    for (const phase of PHASES) {
      for (const role of RUBRIC_ROLES) {
        for (const entry of defaultCriteria(phase, role)) {
          assert.equal(
            entry.blocking, entry.section !== null && entry.section !== undefined,
            `${phase}/${role}：${entry.text}`,
          );
        }
      }
    }
  });

  it("没有模板的阶段，出厂仍然一条都不阻断 —— 那条拍板没被翻", () => {
    for (const phase of ["Build", "Fix"] as const) {
      for (const role of RUBRIC_ROLES) {
        for (const entry of defaultCriteria(phase, role)) {
          assert.equal(entry.blocking, false, `${phase}/${role}：${entry.text}`);
        }
      }
    }
  });

  it("**critic / verdict 那两份永远不挂节** —— 它们讲的是方法，和产物无关", () => {
    for (const phase of PHASES) {
      for (const role of ["critic", "verdict"] as const) {
        for (const entry of defaultCriteria(phase, role)) {
          assert.equal(entry.section, null, `${phase}/${role}：${entry.text}`);
          assert.equal(entry.blocking, false, `${phase}/${role}：${entry.text}`);
        }
      }
    }
  });

  it("有模板的阶段：producer 每条都挂在一个真实存在的节上", () => {
    for (const phase of PHASES) {
      const sections = templateFor(phase);
      if (sections === null) continue;
      const keys = new Set(sections.map((each) => each.key));
      for (const entry of defaultCriteria(phase, "producer")) {
        assert.ok(entry.section != null, `${phase} 没挂节：${entry.text}`);
        assert.ok(keys.has(entry.section!), `${phase} 挂到了不存在的节 ${entry.section}`);
      }
    }
  });

  it("**每一节都至少有一条标准** —— 没人判的节等于没有那一节", () => {
    for (const phase of PHASES) {
      const sections = templateFor(phase);
      if (sections === null) continue;
      const covered = new Set(defaultCriteria(phase, "producer").map((each) => each.section));
      for (const section of sections) {
        assert.ok(covered.has(section.key), `${phase} 没人判这一节：${section.key}`);
      }
    }
  });

  it("没有模板的阶段，producer 一条都不许挂节 —— 挂了就是悬空", () => {
    for (const phase of PHASES) {
      if (templateFor(phase) !== null) continue;
      for (const entry of defaultCriteria(phase, "producer")) {
        assert.equal(entry.section, null, `${phase} 挂到了不存在的模板：${entry.text}`);
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

/*
 * **收走一样能力，就要回头看有没有哪条标准在要它。**
 *
 * 2026-08-06 真机：08-06 那一刀砍掉了有模板的阶段里反方的 blockers 通道，而
 * `CRITIC` 里「沿用同一个 id」「每条问题指向具体位置」两条还在 —— 裁判照着判，
 * 两条当场 no，理由是「反方的返回 JSON 里没有携带既有问题的 id」。
 * 一条建在已经没有的能力上的标准，每一轮都给出一个没有依据的 no。
 */
describe("出厂标准 · critic 那份不许要一个这阶段没有的能力", () => {
  it("**不交问题清单的阶段，标准里不许提「问题的 id」或「每条问题」**", () => {
    for (const phase of PHASES) {
      if (phase === "Done" || reportsFreeFormBlockers(phase)) continue;
      for (const entry of defaultCriteria(phase, "critic")) {
        assert.doesNotMatch(entry.text, /同一个 id|每条问题/,
          `${phase} 的反方没有这个通道，这条永远判 no：${entry.text}`);
      }
    }
  });

  it("交问题清单的阶段照旧要判那几条 —— 别把它们一起删了", () => {
    for (const phase of ["Build", "Fix", "Review", "QA", "Merge"] as const) {
      const texts = defaultCriteria(phase, "critic").map((each) => each.text);
      assert.ok(texts.some((t) => t.includes("同一个 id")), `${phase} 少了 id 那条`);
      assert.ok(texts.some((t) => t.includes("每条问题都指向")), `${phase} 少了位置那条`);
    }
  });

  it("**两边都不许只剩一条** —— 反方在哪个阶段都有实打实的活儿要被判", () => {
    for (const phase of PHASES) {
      if (phase === "Done") continue;
      assert.ok(defaultCriteria(phase, "critic").length >= 3,
        `${phase} 的 critic 只剩 ${defaultCriteria(phase, "critic").length} 条`);
    }
  });
});

