import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { assemblePrompt, type PromptPhase } from "./prompt-service.ts";
import { DEFAULT_STAGE_SCOPES } from "./stage-guard-service.ts";

const TEMPLATES_DIR = path.join(process.cwd(), "server", "templates", "prompts");

function writeFile(root: string, file: string, content: string) {
  const filePath = path.join(root, file);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("spec.md template", () => {
  const content = fs.readFileSync(path.join(TEMPLATES_DIR, "spec.md"), "utf-8");

  /**
   * Red is the PRODUCER and blue is the SUPERVISOR. Both are agents; neither is
   * the human.
   *
   * This used to pin the opposite: the templates declared "红方只指人类用户本人"
   * and cast SPEC_WRITER as an agent serving red rather than red itself -- while
   * `battle_rounds.red_unit` has always been `SPEC_WRITER`. One role, two
   * contradictory definitions, and the model was told it was NOT the thing the
   * database was recording it as. The human belongs to the gate, which is a
   * different layer entirely and has no side in the battle.
   */
  it("casts red as the producer and never as the human", () => {
    assert.match(content, /红方是\*\*生产者\*\*/);
    assert.match(content, /你就是红方/);
    assert.match(content, /蓝方是\*\*监督者\*\*/);
    assert.match(content, /红蓝双方都是 Agent，与人类无关/);
    assert.doesNotMatch(content, /红方只指人类用户本人/);
    // The old vocabulary is gone, not merely outnumbered: "我方"/"反方"/"正方"
    // only make sense under the discarded human-is-red framing.
    assert.doesNotMatch(content, /我方|反方|正方/);
  });

  it("teaches the line protocol and never JSON output", () => {
    // Replaces /只输出结构化 JSON/, the three "unit"/"changeId"/"phase" keys and
    // the prdDeltaMarkdown/fixClaims JSON field names.
    //
    // Those pinned a prompt that told the model to author JSON -- red was the
    // last stage still doing so -- and to emit three fields RedSpecOutputSchema
    // never declared. That schema was not .strict(), so zod stripped them
    // instead of rejecting: the prompt asked for values nothing read, and
    // nothing could tell. What must be pinned now is the protocol itself.
    assert.match(content, /PRD_DELTA<</);
    assert.match(content, />>PRD_DELTA/);
    assert.match(
      content,
      /FIXCLAIM: canonicalGapId \| claimStatus \| claimSummary \| evidence \| artifactPath/,
    );
    assert.match(content, /SPEC_DONE: true/);
    assert.match(content, /不要输出任何 JSON、代码块包裹的对象或花括号结构/);
    assert.doesNotMatch(content, /```json/);
    assert.doesNotMatch(content, /prdDeltaMarkdown/);
    assert.match(content, /不要输出 unit、changeId、phase 等额外字段/);
  });

  it("declares the vocabulary the parser accepts", () => {
    assert.match(content, /RedFixClaim/);
    assert.match(content, /`fixed` \/ `partially_fixed` \/ `not_fixed` \/ `needs_human_decision` 之一/);
    assert.match(content, /canonicalGapId/);
    assert.match(content, /claimStatus/);
    assert.match(content, /claimSummary/);
    assert.match(content, /evidence/);
    assert.match(content, /artifactPath/);
  });

  // Both placements are load-bearing. A FIXCLAIM line inside the block becomes
  // PRD prose and the claim vanishes. A RUBRIC line inside the block is excluded
  // from scanProtocolLines, so it is neither harvested nor stripped and rides
  // into prd-delta.md for the next round's agents to echo back.
  it("keeps FIXCLAIM and RUBRIC lines outside the block", () => {
    assert.match(content, /FIXCLAIM 行必须写在 PRD_DELTA 块外面/);
    assert.match(content, /RUBRIC.*必须写在 PRD_DELTA 块外面/s);
  });

  it("documents that zero FIXCLAIM lines is legal but SPEC_DONE is not optional", () => {
    assert.match(content, /没有旧 gap 要声明就不写 FIXCLAIM 行；但 SPEC_DONE 一定要写/);
  });

  it("requires PRD briefing mirrors to guide spec output", () => {
    assert.match(content, /briefing-questions\.json/);
    assert.match(content, /deferred/);
    assert.match(content, /仍需人工判断/);
    assert.match(content, /待确认问题/);
    // Was /prdDeltaMarkdown/, the JSON field name. The deferred questions must
    // still reach the document; that document is now the PRD_DELTA block.
    assert.match(content, /PRD_DELTA 块/);
    assert.match(content, /prd-draft\.md/);
    assert.match(content, /当前 PRD 草稿基础/);
  });
});

describe("spec-critic.md template", () => {
  const content = fs.readFileSync(path.join(TEMPLATES_DIR, "spec-critic.md"), "utf-8");

  it("casts blue as the supervisor of red the producer", () => {
    assert.match(content, /蓝方需求审查 Agent/);
    assert.match(content, /你就是蓝方/);
    assert.match(content, /红方是\*\*生产者\*\*/);
    assert.match(content, /REQUIREMENT_CRITIC/);
    assert.match(content, /Requirement Gap/);
    assert.match(content, /红蓝双方都是 Agent，与人类无关/);
    assert.doesNotMatch(content, /我方|反方|正方/);
  });

  it("teaches the line protocol and never JSON output", () => {
    assert.match(
      content,
      /REVIEW: canonicalGapId \| verdict \| reviewSummary \| evidence \| resolutionEvidence \| downgradedTo/,
    );
    assert.match(content, /GAP: canonicalGapId \| title \| category \| severity \| evidence \| proposedSpecPatch/);
    assert.match(content, /ARTIFACT: canonicalGapId/);
    assert.match(content, /CRITIQUE_DONE: true/);
    assert.match(content, /不要输出任何 JSON、代码块或花括号结构/);
    // The template must model no JSON at all: key ordering and fenced examples
    // were contracts only while the model typed the payload by hand.
    assert.doesNotMatch(content, /```json/);
    assert.match(content, /不要输出 unit、changeId、phase、specFindings、summary 等额外字段/);
    assert.match(content, /先复核旧的 P0\/P1 Requirement Gaps/);
  });

  it("declares the vocabularies the parser accepts", () => {
    assert.match(content, /`resolved` \/ `still_open` \/ `downgraded` \/ `needs_human_decision` 之一/);
    assert.match(content, /`P0` \/ `P1` \/ `P2` 之一/);
    assert.match(content, /canonicalGapId/);
  });

  it("leaves the blocking flags to stagepass", () => {
    // completeBlueCritique() recomputes both from severity, so asking the model
    // for them only invites a value that is discarded.
    assert.match(content, /specBlocking 与 mergeBlocking 由系统按严重度推导/);
  });

  it("keeps critique read-only", () => {
    assert.match(content, /不要修改文件/);
    assert.match(content, /不要创建文件，不要运行命令/);
  });
});

/**
 * The third template carrying the role semantics, and the only one that had no
 * guard at all -- so it kept the discarded "红方只指人类用户本人" framing with
 * nothing to notice.
 */
describe("spec-verdict.md template", () => {
  const content = fs.readFileSync(path.join(TEMPLATES_DIR, "spec-verdict.md"), "utf-8");

  it("casts the judge as neither side, over a producer and a supervisor", () => {
    assert.match(content, /你是裁决者/);
    assert.match(content, /红方是\*\*生产者\*\*/);
    assert.match(content, /蓝方是\*\*监督者\*\*/);
    assert.match(content, /红蓝双方都是 Agent，与人类无关/);
    assert.doesNotMatch(content, /我方|反方|正方/);
  });

  /**
   * The judge exists because a producer's self-report is not evidence. If it
   * were allowed to accept `fixed` on red's word alone, the round would have a
   * critic in name only.
   */
  it("refuses to take red's self-report as proof", () => {
    assert.match(content, /红方的自证不等于事实/);
    assert.match(content, /blue-gap-reviews\.json/);
  });

  it("keeps the verdict read-only and off the business result", () => {
    assert.match(content, /你的判定\*\*不会\*\*改写它们/);
    assert.match(content, /不要修改文件/);
  });
});

describe("spec stage scope", () => {
  it("allows PRD briefing mirror artifacts as readable context", () => {
    assert.deepEqual(
      [
        ".ship/changes/**/prd-intent.md",
        ".ship/changes/**/briefing-questions.json",
        ".ship/changes/**/prd-draft.md",
        ".ship/changes/**/prd-gate.json",
      ].filter((pattern) => !DEFAULT_STAGE_SCOPES.spec.readableFiles.includes(pattern)),
      []
    );
  });

  it("allows spec battle ledger artifacts as readable context", () => {
    assert.deepEqual(
      [
        ".ship/changes/**/requirement-gaps.json",
        ".ship/changes/**/red-fix-claims.json",
        ".ship/changes/**/blue-gap-reviews.json",
        ".ship/changes/**/reports/spec-report.md",
      ].filter((pattern) => !DEFAULT_STAGE_SCOPES.spec.readableFiles.includes(pattern)),
      []
    );
  });
});

describe("spec_critic prompt phase", () => {
  it("assembles the opposition prompt with change paths", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "spec-critic-prompt-"));
    try {
      writeFile(repoPath, ".ship/architecture.md", "ARCH_CONTEXT\n");
      const phase: PromptPhase = "spec_critic";

      const prompt = assemblePrompt(phase, { changeId: "CHG-001", repoPath });

      assert.match(prompt, /REQUIREMENT_CRITIC/);
      assert.match(prompt, /CHG-001/);
      assert.match(prompt, /prd-delta\.md/);
      assert.match(prompt, /requirement-gaps\.json/);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
