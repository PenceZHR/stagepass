import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commitWithMessage } from "./git-service.ts";

describe("git-service", () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-service-"));
    execSync("git init -b main", { cwd: repoPath, stdio: "ignore" });
    execSync("git config user.email test@example.com", { cwd: repoPath });
    execSync("git config user.name 'Test User'", { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, "app.txt"), "initial\n");
    execSync("git add .", { cwd: repoPath });
    execSync("git commit -m init", { cwd: repoPath, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("returns the full 40 character HEAD after committing", () => {
    fs.writeFileSync(path.join(repoPath, "app.txt"), "changed\n");

    const { sha } = commitWithMessage(repoPath, "chore: update app");
    const head = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();

    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(sha, head);
  });

  it("commits only selected modified, untracked, and deleted paths", () => {
    fs.writeFileSync(path.join(repoPath, "delete-me.txt"), "delete me\n");
    fs.writeFileSync(path.join(repoPath, "unselected.txt"), "keep dirty\n");
    execSync("git add delete-me.txt unselected.txt", { cwd: repoPath });
    execSync("git commit -m baseline-paths", { cwd: repoPath, stdio: "ignore" });

    fs.writeFileSync(path.join(repoPath, "app.txt"), "selected modified\n");
    fs.writeFileSync(path.join(repoPath, "selected-new.txt"), "selected new\n");
    fs.rmSync(path.join(repoPath, "delete-me.txt"));
    fs.writeFileSync(path.join(repoPath, "unselected.txt"), "still dirty\n");

    commitWithMessage(repoPath, "chore: selected paths", [
      "app.txt",
      "selected-new.txt",
      "delete-me.txt",
    ]);

    const committed = execSync("git show --name-only --format= HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim().split("\n").filter(Boolean).sort();
    const status = execSync("git status --porcelain", { cwd: repoPath, encoding: "utf-8" });

    assert.deepEqual(committed, ["app.txt", "delete-me.txt", "selected-new.txt"].sort());
    assert.match(status, /unselected\.txt/);
    assert.doesNotMatch(status, /app\.txt/);
    assert.doesNotMatch(status, /selected-new\.txt/);
    assert.doesNotMatch(status, /delete-me\.txt/);
  });

  it("commits a selected rename without committing unrelated dirty files", () => {
    fs.writeFileSync(path.join(repoPath, "old-name.txt"), "rename me\n");
    fs.writeFileSync(path.join(repoPath, "unselected.txt"), "keep dirty\n");
    execSync("git add old-name.txt unselected.txt", { cwd: repoPath });
    execSync("git commit -m baseline-rename", { cwd: repoPath, stdio: "ignore" });

    fs.renameSync(path.join(repoPath, "old-name.txt"), path.join(repoPath, "new-name.txt"));
    fs.writeFileSync(path.join(repoPath, "unselected.txt"), "still dirty\n");

    commitWithMessage(repoPath, "chore: selected rename", ["old-name.txt", "new-name.txt"]);

    const nameStatus = execSync("git show --name-status --format= HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
    });
    const status = execSync("git status --porcelain", { cwd: repoPath, encoding: "utf-8" });

    assert.match(nameStatus, /old-name\.txt/);
    assert.match(nameStatus, /new-name\.txt/);
    assert.match(status, /unselected\.txt/);
  });

  it("does not fall back to a full commit when explicit selected paths fail to add", () => {
    const before = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();
    fs.writeFileSync(path.join(repoPath, "app.txt"), "must stay dirty\n");

    assert.throws(
      () => commitWithMessage(repoPath, "chore: should fail", ["missing-selected.txt"]),
      /Git add selected paths failed/
    );

    const after = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();
    const status = execSync("git status --porcelain", { cwd: repoPath, encoding: "utf-8" });
    assert.equal(after, before);
    assert.match(status, /app\.txt/);
  });

  it("rejects selected paths that are not repo-relative", () => {
    assert.throws(
      () => commitWithMessage(repoPath, "chore: invalid path", [path.join(repoPath, "app.txt")]),
      /repo-relative/
    );
    assert.throws(
      () => commitWithMessage(repoPath, "chore: invalid path", ["../outside.txt"]),
      /inside the repository/
    );
    assert.throws(
      () => commitWithMessage(repoPath, "chore: invalid path", [""]),
      /must not be empty/
    );
  });
});
