import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { artifactHome, blueDocPath, redDocPath } from "./artifact-home";

describe("L4 · 一个 Change 的产物在仓库里只有一个家", () => {
  /**
   * 路径由 StagePass 指定，不由模型现编 —— 这是 E 的全部前提。
   *
   * 实测过模型现编的下场（2026-08-05 清旧账时数的）：一个仓库里四套互不兼容的
   * 命名（`CHG-001-PRD-r2.md` / `PRD-CHG-001-PRD-r3.md` / `PRD_CHG_002_…_JHS8X3.md`
   * / `PRD-CHG-001.md`），**连 Change id 都编**（`CHG_002`，任何库里都没有过）。
   * 「从文件名认出它属于谁」这条路根本不通。
   */
  it("每个 Change 一个目录 —— 同仓库两个 Change 谁也提交不了对方的", () => {
    assert.equal(artifactHome("CHG-001"), "docs/stagepass/CHG-001");
    assert.notEqual(artifactHome("CHG-001"), artifactHome("CHG-002"));
  });

  it("**文件名用阶段标识符原样** —— One phase, one name 管到文件名里", () => {
    // phase.ts 开头那条：这些标识符是唯一的名字，「in a card, in a log line」，
    // 大小写变体也不许。spec-r1.md 就是第二个名字。
    assert.equal(redDocPath("CHG-001", "Spec", 1), "docs/stagepass/CHG-001/Spec-r1.md");
    assert.equal(redDocPath("CHG-001", "TestPlan", 7),
      "docs/stagepass/CHG-001/TestPlan-r7.md");
  });

  it("反方的意见有自己的名字，不和正方的抢", () => {
    assert.equal(blueDocPath("CHG-001", "Spec", 1),
      "docs/stagepass/CHG-001/Spec-r1-opposition.md");
  });

  it("路径是相对项目根的 —— Codex 就跑在项目根，绝对路径反而挪不动", () => {
    assert.ok(!artifactHome("CHG-001").startsWith("/"));
  });
});
