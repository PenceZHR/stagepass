import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import * as versioning from "./workspace-versioning-service.ts";

describe("workspace-versioning-service", () => {
  let repoPath: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-versioning-repo-"));
    cleanup.push(repoPath);
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, "app.txt"), "initial\n");
    execFileSync("git", ["add", "."], { cwd: repoPath });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath });
  });

  afterEach(() => {
    for (const directory of cleanup.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps internal adoption mutations in workspace versioning", () => {
    assert.equal("createBuildWorktree" in versioning, true);
    assert.equal("applyAdoptionPatch" in versioning, true);
    assert.equal("commitAdoptedPatch" in versioning, true);
    assert.equal("pushCurrentBranch" in versioning, false);
    assert.equal("createRemoteRepo" in versioning, false);
  });

  it("creates an isolated worktree and commits an adopted patch", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-versioning-tree-"));
    cleanup.push(workspaceRoot);
    const workspacePath = path.join(workspaceRoot, "build");
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
    versioning.createBuildWorktree(repoPath, {
      workspacePath,
      branchName: "stagepass/build/test",
      baseCommit,
    });
    fs.writeFileSync(path.join(workspacePath, "app.txt"), "changed\n");
    const patch = execFileSync("git", ["diff", "--binary"], {
      cwd: workspacePath,
      encoding: "utf-8",
    });
    versioning.applyAdoptionPatch(repoPath, patch);
    const { sha } = versioning.commitAdoptedPatch(repoPath, "build: adopt patch", ["app.txt"]);
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(fs.readFileSync(path.join(repoPath, "app.txt"), "utf-8"), "changed\n");
  });
});
