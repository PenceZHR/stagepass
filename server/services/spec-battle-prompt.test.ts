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

  it("requires our-side agent structured output with fix claims", () => {
    assert.match(content, /只输出结构化 JSON/);
    assert.match(content, /我方执行代理/);
    assert.match(content, /红方只指人类用户本人/);
    assert.match(content, /反方负责质询/);
    assert.match(content, /"unit": "SPEC_WRITER"/);
    assert.match(content, /"changeId": "\{changeId\}"/);
    assert.match(content, /"phase": "Spec"/);
    assert.match(content, /prdDeltaMarkdown/);
    assert.match(content, /fixClaims/);
    assert.match(content, /RedFixClaim/);
    assert.match(content, /canonicalGapId/);
    assert.match(content, /claimStatus/);
    assert.match(content, /claimSummary/);
    assert.match(content, /evidence/);
    assert.match(content, /artifactPath/);
  });

  it("requires PRD briefing mirrors to guide spec output", () => {
    assert.match(content, /briefing-questions\.json/);
    assert.match(content, /deferred/);
    assert.match(content, /仍需人工判断/);
    assert.match(content, /待确认问题/);
    assert.match(content, /prdDeltaMarkdown/);
    assert.match(content, /prd-draft\.md/);
    assert.match(content, /当前 PRD 草稿基础/);
  });
});

describe("spec-critic.md template", () => {
  const content = fs.readFileSync(path.join(TEMPLATES_DIR, "spec-critic.md"), "utf-8");

  it("defines the opposition requirement critic role", () => {
    assert.match(content, /反方需求审查 Agent/);
    assert.match(content, /SPEC_WRITER 是服务红方的我方执行代理/);
    assert.match(content, /REQUIREMENT_CRITIC/);
    assert.match(content, /Requirement Gap/);
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
