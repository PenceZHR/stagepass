import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commitChangesDecision } from "./action-contract-git-policy";
import { redactAbsolutePaths, writeBuildRun } from "./build-workspace-service";

const CHANGE_ID = "CHG-GIT-POLICY";

let repoPath: string | null = null;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath ?? ".", encoding: "utf-8" }).trim();
}

function createRepoWithCommit(): string {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "stagepass-git-policy-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "base\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  return git(["rev-parse", "HEAD"]);
}

function dirtyTheTree(): void {
  fs.writeFileSync(path.join(repoPath!, "src-new.mjs"), "export const x = 1;\n");
}

function writePendingFix(input: { baseCommit: string; status: "approved_for_absorb" | "adopted"; purpose: "fix" | "build" }): void {
  writeBuildRun(repoPath!, {
    changeId: CHANGE_ID,
    runNumber: 1,
    status: input.status,
    purpose: input.purpose,
    baseHeadSha: input.baseCommit,
    baseCommit: input.baseCommit,
    workspacePath: repoPath!,
    branchName: "build-1",
    expectedFiles: [],
    forbiddenFiles: [],
    changedFiles: [],
    deviations: [],
    blockers: [],
    patchPath: null,
    patchSha256: null,
    approvalPath: null,
    diffPath: null,
    auditPath: null,
    reportPath: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  });
}

afterEach(() => {
  if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
  repoPath = null;
});

describe("commit_changes guard against drifting a pending fix", () => {
  // Adopting a fix replays its patch onto the commit it was cut from, so
  // adoptFix refuses for good once HEAD moves (git_head_drift). Committing is
  // exactly what moves HEAD, and the dirty tree that makes committing look
  // necessary is usually the fix's own output -- offering the button there hands
  // the user the one action that destroys the absorb they are reaching for.
  it("withholds commit while a fix waits to be absorbed at the current HEAD", () => {
    const head = createRepoWithCommit();
    dirtyTheTree();
    writePendingFix({ baseCommit: head, status: "approved_for_absorb", purpose: "fix" });

    const decision = commitChangesDecision(repoPath!, CHANGE_ID);

    assert.equal(decision.enabled, false);
    assert.equal(decision.reasonCode, "git_commit_would_drift_fix_base");
    assert.match(decision.reason ?? "", /先收编这一轮 Fix/);
    // Not a blocker: nothing is broken, the two actions are simply ordered.
    assert.deepEqual(decision.blockers, []);
  });

  it("allows commit once HEAD has already left the fix base", () => {
    createRepoWithCommit();
    writePendingFix({ baseCommit: "0".repeat(40), status: "approved_for_absorb", purpose: "fix" });
    dirtyTheTree();

    const decision = commitChangesDecision(repoPath!, CHANGE_ID);

    // The absorb is already unreachable through this path, so withholding the
    // commit would only strand the user with no action at all.
    assert.equal(decision.enabled, true);
    assert.equal(decision.reasonCode, null);
  });

  it("allows commit when the pending run is a build rather than a fix", () => {
    const head = createRepoWithCommit();
    dirtyTheTree();
    writePendingFix({ baseCommit: head, status: "approved_for_absorb", purpose: "build" });

    assert.equal(commitChangesDecision(repoPath!, CHANGE_ID).enabled, true);
  });

  it("allows commit when the fix is already adopted", () => {
    const head = createRepoWithCommit();
    dirtyTheTree();
    writePendingFix({ baseCommit: head, status: "adopted", purpose: "fix" });

    assert.equal(commitChangesDecision(repoPath!, CHANGE_ID).enabled, true);
  });

  it("still reports a clean tree as nothing to commit, not as a drift risk", () => {
    const head = createRepoWithCommit();
    writePendingFix({ baseCommit: head, status: "approved_for_absorb", purpose: "fix" });

    const decision = commitChangesDecision(repoPath!, CHANGE_ID);

    assert.equal(decision.enabled, false);
    assert.equal(decision.reasonCode, "git_worktree_clean");
  });
});

describe("git failure detail redaction", () => {
  // git stderr is the only thing that names the offending file, but it can also
  // carry absolute paths from outside the repository. Relative paths must
  // survive whole; absolute ones must not appear at all.
  it("keeps the relative path that names the offending file", () => {
    const redacted = redactAbsolutePaths(
      "error: tests/config/map-catalog.test.mjs: already exists in working directory",
    );

    assert.equal(
      redacted,
      "error: tests/config/map-catalog.test.mjs: already exists in working directory",
    );
  });

  it("removes absolute paths wherever they appear", () => {
    const secret = "/private/workspace/customer-secret";

    for (const raw of [
      `fatal: ${secret}`,
      `fatal: not a git repository: '${secret}'`,
      `error: cannot open (${secret})`,
      secret,
    ]) {
      const redacted = redactAbsolutePaths(raw);
      assert.equal(redacted.includes(secret), false, `leaked in: ${raw}`);
      assert.match(redacted, /<path>/);
    }
  });

  it("leaves text without paths untouched", () => {
    assert.equal(redactAbsolutePaths("fatal: bad object HEAD"), "fatal: bad object HEAD");
  });
});
