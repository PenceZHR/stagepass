import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "app", "projects", "[id]", "changes", "[changeId]");
const page = fs.readFileSync(path.join(root, "page.tsx"), "utf8");
const commands = fs.readFileSync(path.join(root, "pipeline-action-commands.ts"), "utf8");
const runner = fs.readFileSync(path.join(root, "pipeline-action-runner.ts"), "utf8");

describe("DB-first Codex-native pipeline UI", () => {
  it("keeps run and retry actions contract-backed", () => {
    assert.match(commands, /run_plan:\s*"plan"/);
    assert.match(commands, /retry_build:\s*"implement"/);
    assert.match(runner, /pipelineActionDisabledReason/);
    assert.match(runner, /createPipelinePreflightPayload/);
  });

  it("does not POST business decisions from the default Web surface", () => {
    assert.doesNotMatch(page, /\/gate\/approve|\/gate\/reject/);
    assert.doesNotMatch(page, /\/plan-sandbox\/decision|\/spec-battle\/decision/);
    assert.doesNotMatch(page, /\/findings\/.*\/waive/);
    assert.match(commands, /Decision action ids intentionally do not resolve in Web/);
  });

  it("does not expose the removed Git action surface", () => {
    assert.doesNotMatch(page, /StageGitPanel|GitWorkspacePanel|GitSetupPanel/);
    assert.doesNotMatch(commands, /init_git_repo|commit_changes/);
  });
});
