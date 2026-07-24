import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import * as evidence from "./repository-evidence-service.ts";

describe("repository-evidence-service", () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "repository-evidence-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, "app.txt"), "initial\n");
    execFileSync("git", ["add", "."], { cwd: repoPath });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath });
  });

  afterEach(() => fs.rmSync(repoPath, { recursive: true, force: true }));

  it("exports repository facts without remote, push, stage, or commit UI methods", () => {
    assert.equal("getHeadSha" in evidence, true);
    assert.equal("getBinaryDiff" in evidence, true);
    assert.equal("pushCurrentBranch" in evidence, false);
    assert.equal("createRemoteRepo" in evidence, false);
    assert.equal("commitAll" in evidence, false);
  });

  it("reads stable HEAD and dirty-file evidence", () => {
    const head = evidence.getHeadSha(repoPath);
    fs.writeFileSync(path.join(repoPath, "app.txt"), "changed\n");
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.equal(evidence.getWorkingTreeStatus(repoPath).clean, false);
    assert.deepEqual(evidence.getNameStatusDiff(repoPath), [{ status: "M", path: "app.txt" }]);
  });
});
