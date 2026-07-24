import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const component = fs.readFileSync(
  path.join(process.cwd(), "app", "projects", "[id]", "changes", "[changeId]", "build-sandbox.tsx"),
  "utf8",
);
const page = fs.readFileSync(
  path.join(process.cwd(), "app", "projects", "[id]", "changes", "[changeId]", "page.tsx"),
  "utf8",
);

describe("Build workspace in the Codex-native control plane", () => {
  it("keeps operational start/retry in Web", () => {
    assert.match(component, /function selectBuildStartAction/);
    assert.match(component, /run_build/);
    assert.match(component, /retry_build/);
    assert.match(component, /\/implement/);
  });

  it("routes human Build and Fix decisions to the bound Codex task", () => {
    assert.match(component, /fetch\("\/api\/codex\/health"\)/);
    assert.match(component, /const openInCodex = useCallback/);
    assert.match(component, /\/codex\/open/);
    assert.match(component, /codexRollout\.phases\.includes\(codexDecisionPhase\)/);
    assert.doesNotMatch(component, /action:\s*"approve_absorb"/);
    assert.doesNotMatch(component, /action:\s*"reject_build"/);
  });

  it("projects evidence without exposing StagePass Git operations", () => {
    assert.match(component, /changedFiles/);
    assert.match(component, /deviations/);
    assert.match(component, /blockers/);
    assert.doesNotMatch(component, /commit_changes|init_git_repo|pushCurrentBranch/);
  });

  it("mounts Build through the shared stage shell", () => {
    assert.match(page, /<PhaseStageShell[\s\S]*?<BuildSandbox/);
    assert.match(page, /onStageActionsChange=\{setBuildStageActions\}/);
  });
});
