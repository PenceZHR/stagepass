import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";

import { db } from "../db";
import { changes, projects } from "../db/schema";
import { resolveAdoptionCommitBranch } from "./change-service";

const PROJECT_ID = "PRJ-ADOPT-BRANCH";
const CHANGE_ID = "CHG-ADOPT-BRANCH";
const AT = "2026-07-20T00:00:00.000Z";

let repoPath = "";

function seedChange(gitBranch: string | null): void {
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Adoption branch repair",
    repoPath,
    contextStatus: "ready",
    createdAt: AT,
    updatedAt: AT,
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Adoption branch repair",
    status: "IMPLEMENTING",
    gitBranch,
    createdAt: AT,
    updatedAt: AT,
  }).run();
}

function storedBranch(): string | null {
  return db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.gitBranch ?? null;
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "stagepass-adopt-branch-"));
});

afterEach(() => {
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function initRepoOnBranch(branch: string): void {
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf-8" });
  git(["init", "-q", "-b", branch]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "base\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
}

describe("adoption commit branch repair", () => {
  // A change opened before its repository was a git repository never got the
  // per-change branch createChange assigns, and callers read that null as
  // "do not commit". Adoption then left HEAD on the run's base commit while the
  // working tree filled with adopted output, so the next fix's patch collided
  // with files already there -- and committing by hand to clear it moved HEAD
  // and refused the adoption for good.
  it("adopts the current branch for a change that never got one, and persists it", () => {
    initRepoOnBranch("main");
    seedChange(null);

    const branch = resolveAdoptionCommitBranch({
      changeId: CHANGE_ID,
      gitEnabled: true,
      repoPath,
      gitBranch: null,
    });

    assert.equal(branch, "main");
    // Persisted, so the next adoption does not have to rediscover it.
    assert.equal(storedBranch(), "main");
  });

  it("keeps an existing branch instead of retargeting the change", () => {
    initRepoOnBranch("main");
    seedChange("chg-1-existing");

    const branch = resolveAdoptionCommitBranch({
      changeId: CHANGE_ID,
      gitEnabled: true,
      repoPath,
      gitBranch: "chg-1-existing",
    });

    assert.equal(branch, "chg-1-existing");
    assert.equal(storedBranch(), "chg-1-existing");
  });

  it("does not commit for a project with git turned off", () => {
    initRepoOnBranch("main");
    seedChange(null);

    assert.equal(
      resolveAdoptionCommitBranch({ changeId: CHANGE_ID, gitEnabled: false, repoPath, gitBranch: null }),
      null,
    );
    assert.equal(storedBranch(), null);
  });

  it("does not invent a branch when the path is not a git repository", () => {
    seedChange(null);

    assert.equal(
      resolveAdoptionCommitBranch({ changeId: CHANGE_ID, gitEnabled: true, repoPath, gitBranch: null }),
      null,
    );
    // Nothing recorded: there is no branch to record, and claiming one would
    // make adoption try to commit into a directory git does not track.
    assert.equal(storedBranch(), null);
  });

  it("uses whatever branch the work is actually on, not a fixed name", () => {
    initRepoOnBranch("trunk");
    seedChange(null);

    assert.equal(
      resolveAdoptionCommitBranch({ changeId: CHANGE_ID, gitEnabled: true, repoPath, gitBranch: null }),
      "trunk",
    );
  });
});
