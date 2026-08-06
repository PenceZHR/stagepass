import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PHASES } from "./phase";
import { PHASE_PLAY, reportsFreeFormBlockers } from "./phase-play";

/*
 * 反方交不交自由 blockers，判据只有一条：**它够不够得着代码**（`blue.investigates`）。
 *
 * 够得着 → 它自己去看，报的是真缺陷，那个空间无界是本质的：Review 砍掉它，就只剩
 * 红方一个人看代码，对抗价值当场归零。够不着 → 它对着标准评一份文档，判断全部走
 * 逐条判定，每轮上限 = criterion 条数。
 */
describe("L4 · 反方够不够得着代码，决定它交不交自由 blockers", () => {
  it("够得着代码的五个照交", () => {
    for (const phase of ["Build", "Fix", "Review", "QA", "Merge"] as const) {
      assert.equal(reportsFreeFormBlockers(phase), true, `${phase} 的 blockers 被砍了`);
    }
  });

  it("只读那份产出的六个不交 —— 判断走逐条判定", () => {
    for (const phase of ["PRD", "Spec", "TechSpec", "Plan", "TestPlan", "Retro"] as const) {
      assert.equal(reportsFreeFormBlockers(phase), false, `${phase} 还在收自由 blockers`);
    }
  });

  it("Done 什么都不派，问到它不抛也不返回 true", () => {
    assert.equal(reportsFreeFormBlockers("Done"), false);
    assert.equal(reportsFreeFormBlockers("不是个阶段"), false);
  });

  it("**不交 blockers 的阶段，任务里就不许再说「放进 blockers」** —— 要求和判据得是同一件事", () => {
    for (const phase of PHASES) {
      if (phase === "Done") continue;
      const play = PHASE_PLAY[phase];
      if (reportsFreeFormBlockers(phase)) continue;
      assert.ok(
        !play.blue.after.some((line) => line.includes("放进 blockers")),
        `${phase} 的任务还在要 blockers，而解析层会把它们丢掉`,
      );
      assert.deepEqual(play.blue.idRule, [],
        `${phase} 的反方不报问题了，却还在给它规定 id 前缀`);
    }
  });
});
