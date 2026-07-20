import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GIT_STAGE_ACTION_IDS, selectVisibleGitStageActions } from "./git-action-policy";
import { isPostRoutedAction } from "./pipeline-action-commands";
import type { PipelineActionContract } from "./pipeline-action-contract";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const pipelineUiModelSource = readFileSync(resolve(__dirname, "pipeline-ui-model.ts"), "utf-8");

function gitAction(
  actionId: string,
  overrides: Partial<PipelineActionContract> = {},
): PipelineActionContract {
  return {
    actionId,
    phase: "Build",
    label: actionId,
    enabled: false,
    reasonCode: null,
    reason: null,
    blockers: [],
    warnings: [],
    gateVersion: "0",
    sourceDbHash: "git_head:abc",
    requiresIdempotencyKey: false,
    requiresProvider: false,
    providerSelectable: false,
    defaultProvider: "codex",
    ...overrides,
  };
}

/** The contract a project whose repoPath was never `git init`ed actually serves. */
function nonRepositoryContract(): PipelineActionContract[] {
  return [
    gitAction("init_git_repo", { enabled: true, label: "初始化 Git 仓库" }),
    gitAction("commit_changes", {
      label: "提交改动",
      reasonCode: "git_repo_missing",
      reason: "Cannot commit: Path is not a git repository.",
      blockers: [{ id: "git_repo_missing", severity: "P1", title: "Path is not a git repository." }],
    }),
  ];
}

describe("git stage action policy", () => {
  it("offers init as the only action on a path that is not a git repository", () => {
    const visible = selectVisibleGitStageActions(nonRepositoryContract());

    // Both are visible: init is the way out, and commit carries the blocker that
    // explains why the stage is stuck. This is the PRJ-001 shape -- run_build
    // refusing itself with build_base_camp_blocked / "Path is not a git
    // repository." and, before init_git_repo existed, nothing on any stage that
    // could clear it.
    assert.deepEqual(visible.map((action) => action.actionId), ["init_git_repo", "commit_changes"]);
    assert.equal(visible[0].enabled, true);
    assert.equal(visible[1].enabled, false);
    assert.deepEqual(visible[1].blockers, [
      { id: "git_repo_missing", severity: "P1", title: "Path is not a git repository." },
    ]);
  });

  it("offers commit as the next step once a real repository has uncommitted work", () => {
    const visible = selectVisibleGitStageActions([
      gitAction("init_git_repo", {
        reasonCode: "git_repo_already_initialized",
        reason: "Repository path is already a git repository",
      }),
      gitAction("commit_changes", { enabled: true, label: "提交改动" }),
    ]);

    assert.deepEqual(visible.map((action) => action.actionId), ["commit_changes"]);
    assert.equal(visible[0].enabled, true);
  });

  it("shows no git action at all on a clean tree in an initialised repository", () => {
    // The steady state of a healthy change. A permanently greyed-out "提交改动"
    // would sit on the Build and Fix stages for the entire life of the change,
    // which is exactly the noise the blocker-less filter exists to remove.
    const visible = selectVisibleGitStageActions([
      gitAction("init_git_repo", { reasonCode: "git_repo_already_initialized" }),
      gitAction("commit_changes", {
        reasonCode: "git_worktree_clean",
        reason: "Working tree has no uncommitted changes",
      }),
    ]);

    assert.deepEqual(visible, []);
  });

  it("keeps a disabled git action visible whenever it carries a blocker", () => {
    // A probe failure is not "nothing to do", it is a fault the user has to see.
    const visible = selectVisibleGitStageActions([
      gitAction("commit_changes", {
        reasonCode: "git_probe_failed",
        reason: "Git working tree could not be inspected: boom",
        blockers: [
          { id: "git_probe_failed", severity: "P1", title: "Git working tree could not be inspected." },
        ],
      }),
    ]);

    assert.deepEqual(visible.map((action) => action.actionId), ["commit_changes"]);
  });

  it("tolerates a contract that carries no git actions", () => {
    assert.deepEqual(selectVisibleGitStageActions(undefined), []);
    assert.deepEqual(selectVisibleGitStageActions([]), []);
  });

  it("routes every git stage action to a server endpoint", () => {
    // A stage button whose action id is in neither ACTION_ENDPOINTS nor
    // NON_POST_ROUTED_ACTION_IDS silently does nothing when clicked.
    for (const actionId of GIT_STAGE_ACTION_IDS) {
      assert.equal(isPostRoutedAction(actionId), true, `${actionId} must be POST-routable`);
    }
  });

  it("renders the git actions on the Build and Fix stage bars", () => {
    assert.match(pageSource, /import \{ selectVisibleGitStageActions \} from "\.\/git-action-policy";/);
    assert.match(pageSource, /selectVisibleGitStageActions\(pipelineActions\)/);
    // Both Build-only and Fix branches of buildOrFixStageActions must carry them;
    // the Fix branch has two returns of its own (with and without fix_blockers).
    assert.equal(pageSource.match(/\.\.\.gitStageActions/g)?.length, 3);
    assert.match(pipelineUiModelSource, /actionIds: \["run_build", "retry_build", "adopt_build", "reject_build", "init_git_repo", "commit_changes"\]/);
    assert.match(pipelineUiModelSource, /actionIds: \["adopt_fix", "reject_build", "fix_blockers", "init_git_repo", "commit_changes"\]/);
  });
});
