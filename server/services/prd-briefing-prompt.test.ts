import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { assemblePrompt, type PromptPhase } from "./prompt-service.ts";
import { DEFAULT_STAGE_SCOPES } from "./stage-guard-service.ts";

const TEMPLATES_DIR = path.join(process.cwd(), "server", "templates", "prompts");

describe("PRD briefing prompt templates", () => {
  it("question prompt teaches the QUESTION line protocol and never JSON output", () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, "prd-briefing-questions.md"), "utf-8");
    assert.match(content, /反方需求质询 Agent/);
    assert.match(content, /红方是人类用户本人/);
    assert.match(content, /PRD_BLUE_INTERROGATOR/);
    assert.match(content, /QUESTION: category \| severity \| question \| whyItMatters \| suggestedDefault/);
    assert.match(content, /不要输出任何 JSON、代码块或花括号结构/);
    assert.doesNotMatch(content, /~~~json|```json/);
    // unit/changeId/phase are stagepass constants; asking the model to echo
    // them is what let a mis-typed changeId into the payload.
    assert.match(content, /unit \/ changeId \/ phase 由系统填写，你不要输出/);
    // The enum vocabulary the parser accepts must reach the model.
    assert.match(content, /goal \/ user \/ scope \/ success \/ negative_case \/ risk \/ constraint \/ spec_blocker/);
    assert.match(content, /critical \/ important \/ optional/);
  });

  it("draft prompt requires a MARKDOWN block and keeps its section list", () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, "prd-briefing-draft.md"), "utf-8");
    assert.match(content, /MARKDOWN<</);
    // Named terminator, not a bare `>>` (a `>>` in the markdown body would else truncate it).
    assert.match(content, />>MARKDOWN/);
    assert.match(content, /不要输出 JSON/);
    assert.doesNotMatch(content, /~~~json|```json/);
    assert.match(content, /背景/);
    assert.match(content, /目标/);
    assert.match(content, /未决问题/);
    assert.match(content, /进入 Spec Battle 的建议/);
  });

  it("final review prompt teaches the VERDICT/BLOCKING/NEXT protocol", () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, "prd-briefing-final-review.md"), "utf-8");
    assert.match(content, /不要修改文件/);
    assert.match(content, /VERDICT: ready 或 needs_answer 或 risky_but_allowed/);
    assert.match(content, /NEXT: lock_prd 或 answer_questions 或 cancel_change/);
    assert.match(content, /BLOCKING:/);
    assert.match(content, /RISK_SUMMARY<</);
    assert.match(content, />>RISK_SUMMARY/);
    assert.match(content, /不要输出任何 JSON、代码块或花括号结构/);
    assert.doesNotMatch(content, /~~~json|```json/);
    // Opaque ids must be copied verbatim; the parser rejects the rest.
    assert.match(content, /逐字抄自 \{briefingQuestionsPath\} 里真实存在的疑点卡 ID/);
  });

  it("assembles PRD briefing prompts with change paths", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "prd-briefing-prompt-"));
    try {
      fs.mkdirSync(path.join(repoPath, ".ship", "changes", "CHG-001"), { recursive: true });
      const phase: PromptPhase = "prd_briefing_questions";
      const prompt = assemblePrompt(phase, { changeId: "CHG-001", repoPath });
      assert.match(prompt, /CHG-001/);
      assert.match(prompt, /prd-intent\.md/);
      assert.match(prompt, /briefing-questions\.json/);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("makes PRD briefing artifacts readable to Spec", () => {
    for (const pattern of [
      ".ship/changes/**/prd-intent.md",
      ".ship/changes/**/briefing-questions.json",
      ".ship/changes/**/prd-draft.md",
      ".ship/changes/**/prd-gate.json",
    ]) {
      assert.ok(DEFAULT_STAGE_SCOPES.spec.readableFiles.includes(pattern), `${pattern} should be readable in Spec`);
    }
  });
});
