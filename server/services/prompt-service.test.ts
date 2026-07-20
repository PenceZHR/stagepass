import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { assemblePrompt, type PromptPhase } from "./prompt-service.ts";

function writeFile(root: string, file: string, content: string) {
  const filePath = path.join(root, file);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("prompt-service v2 phases", () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-service-"));
    writeFile(repoPath, ".ship/architecture.md", "UNSCOPED_CONTEXT\n");
    writeFile(repoPath, ".ship/changes/CHG-001/prd-delta.md", "READABLE_PRD_DELTA\n");
    writeFile(repoPath, "src/secret.ts", "HIDDEN_SOURCE_CONTEXT\n");
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("assembles prompts for every v2 phase", () => {
    const phases: PromptPhase[] = [
      "intake",
      "spec",
      "tech_spec",
      "test_plan",
      "release",
      "retro",
    ];

    for (const phase of phases) {
      const prompt = assemblePrompt(phase, { changeId: "CHG-001", repoPath });

      assert.match(prompt, /CHG-001/, phase);
      assert.match(prompt, /阶段边界/, phase);
    }
  });

  it("injects only files allowed by the stage readable boundary", () => {
    const prompt = assemblePrompt(
      "tech_spec",
      { changeId: "CHG-001", repoPath },
      {
        phase: "tech_spec",
        readableFiles: [".ship/changes/CHG-001/prd-delta.md"],
        writableFiles: [".ship/changes/CHG-001/tech-spec-delta.md"],
      }
    );

    assert.match(prompt, /READABLE_PRD_DELTA/);
    assert.doesNotMatch(prompt, /UNSCOPED_CONTEXT/);
    assert.doesNotMatch(prompt, /HIDDEN_SOURCE_CONTEXT/);
  });

  it("scopes wildcard change context to the requested change and excludes run copies", () => {
    writeFile(repoPath, ".ship/changes/CHG-002/prd-delta.md", "OTHER_CHANGE_PRD_DELTA\n");
    writeFile(
      repoPath,
      ".ship/changes/CHG-001/runs/RUN-001/prd-delta.md",
      "HISTORICAL_RUN_PRD_DELTA\n",
    );

    const prompt = assemblePrompt(
      "spec_critic",
      { changeId: "CHG-001", repoPath },
      {
        phase: "spec",
        readableFiles: [".ship/changes/**/prd-delta.md"],
        writableFiles: [],
      },
    );

    assert.match(prompt, /READABLE_PRD_DELTA/);
    assert.doesNotMatch(prompt, /OTHER_CHANGE_PRD_DELTA/);
    assert.doesNotMatch(prompt, /HISTORICAL_RUN_PRD_DELTA/);
  });

  it("does not prepend default .ship context docs for Build implement prompts", () => {
    const prompt = assemblePrompt("implement", { changeId: "CHG-001", repoPath });

    assert.doesNotMatch(prompt, /UNSCOPED_CONTEXT/);
  });

  it("assembles Review prompts without Build implement instructions", () => {
    const prompt = assemblePrompt("review", { changeId: "CHG-001", repoPath });

    assert.match(prompt, /You are a code reviewer/);
    assert.doesNotMatch(prompt, /UNSCOPED_CONTEXT/);
    assert.doesNotMatch(prompt, /严格按计划执行的实现者/);
    assert.doesNotMatch(prompt, /当前阶段是 implement/);
  });

  it("ignores project-level Build implement prompt overrides", () => {
    writeFile(repoPath, ".ship/prompts/implement.md", "FORBIDDEN_PROJECT_IMPLEMENT_PROMPT\n");

    const prompt = assemblePrompt("implement", { changeId: "CHG-001", repoPath });

    assert.match(prompt, /严格按计划执行的实现者/);
    assert.doesNotMatch(prompt, /FORBIDDEN_PROJECT_IMPLEMENT_PROMPT/);
  });
});

describe("build workspace stage prompts", () => {
  let workspacePath: string;

  beforeEach(() => {
    // Build and Fix run inside a git-derived workspace, and `.ship/` is
    // gitignored by convention, so the workspace never carries the project's
    // .ship mirrors. Model that here by creating a workspace without one.
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "build-workspace-"));
    writeFile(workspacePath, "src/index.js", "export function compareSemver() {}\n");
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  const workspacePhases: PromptPhase[] = ["implement", "fix"];

  for (const phase of workspacePhases) {
    it(`does not send the ${phase} stage after .ship mirrors its workspace cannot contain`, () => {
      const prompt = assemblePrompt(phase, { changeId: "CHG-001", repoPath: workspacePath });

      // Directing the model to read these paths starves it of the context it
      // was promised: it finds nothing, refuses to invent the missing input,
      // and the stage dies with "Build workspace produced no changes".
      assert.doesNotMatch(
        prompt,
        /\.ship\/changes\/CHG-001\//,
        `${phase} prompt points at a .ship path no build workspace ever has`,
      );
    });
  }
});
