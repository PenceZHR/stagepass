import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";

import { db } from "../db/index.ts";
import { changes, planSnapshots, projects, requiredValidationCommands } from "../db/schema.ts";
import { runScopeCheck } from "./scope-check-service.ts";

/**
 * D2 (docs/state-projection-audit-2026-07-14.md §4, Site 7): runScopeCheck used
 * to read plan.json directly off disk, while Build-time scope enforcement
 * (validateImplementScope) already read the approved DB Plan snapshot via
 * loadDbPlanScope -- the same underlying fact, enforced two different ways
 * depending on which stage asked. Since plan.json is a human-editable phase
 * artifact, this meant Build-time and QA-time scope enforcement could
 * legitimately disagree. No test existed for this file at all before this one.
 */

const PROJECT_ID = "PRJ-SCOPE-CHECK";
const CHANGE_ID = "CHG-SCOPE-CHECK";
const NOW = "2026-07-14T00:00:00.000Z";

function cleanupRows(): void {
  db.delete(requiredValidationCommands).where(eq(requiredValidationCommands.changeId, CHANGE_ID)).run();
  db.delete(planSnapshots).where(eq(planSnapshots.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "scope-check-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src-app.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src-forbidden.ts"), "export const secret = 1;\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  return repo;
}

function seedChange(repoPath: string): void {
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Scope check",
    repoPath,
    contextStatus: "ready",
    contextProvider: "codex",
    prdStatus: "ready",
    prdProvider: "codex",
    prdJson: null,
    prdMarkdown: null,
    gitEnabled: 0,
    gitDefaultBranch: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Scope check",
    status: "PLAN_APPROVED",
    provider: "codex",
    codexThreadId: null,
    fixIterations: 0,
    blockedPhase: null,
    reworkFromPhase: null,
    suspendedByPrd: 0,
    preSuspendStatus: null,
    gitBranch: null,
    gateState: null,
    docsComplete: 0,
    retroDone: 0,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

function seedApprovedPlan(input: { expectedFiles: string[]; forbiddenFiles: string[] }): void {
  db.insert(planSnapshots).values({
    id: "PLAN-SNAP-SCOPE-CHECK",
    changeId: CHANGE_ID,
    status: "approved",
    sourceSpecHash: "spec-hash",
    expectedFilesJson: JSON.stringify(input.expectedFiles),
    forbiddenFilesJson: JSON.stringify(input.forbiddenFiles),
    validationPolicyHash: "validation-hash",
    approvedAt: NOW,
    approvalDecisionId: null,
    snapshotDbHash: "db-scope-hash",
    createdAt: NOW,
  }).run();
}

describe("runScopeCheck", () => {
  let repoPath: string;

  beforeEach(() => {
    cleanupRows();
    repoPath = makeRepo();
  });

  afterEach(() => {
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("flags a modified file that is outside the approved DB plan scope", () => {
    seedChange(repoPath);
    seedApprovedPlan({ expectedFiles: ["src-app.ts"], forbiddenFiles: [] });
    fs.writeFileSync(path.join(repoPath, "src-app.ts"), "export const value = 2;\n");
    fs.writeFileSync(path.join(repoPath, "src-forbidden.ts"), "export const secret = 2;\n");

    const result = runScopeCheck(repoPath, CHANGE_ID);

    assert.equal(result.success, false);
    assert.deepEqual(result.outOfScopeFiles, ["src-forbidden.ts"]);
    assert.deepEqual(result.blockedFiles, []);
  });

  it("passes when every modified file is within the approved DB plan scope", () => {
    seedChange(repoPath);
    seedApprovedPlan({ expectedFiles: ["src-app.ts", "src-forbidden.ts"], forbiddenFiles: [] });
    fs.writeFileSync(path.join(repoPath, "src-app.ts"), "export const value = 2;\n");

    const result = runScopeCheck(repoPath, CHANGE_ID);

    assert.equal(result.success, true);
    assert.deepEqual(result.outOfScopeFiles, []);
  });

  it("blocks a file the plan explicitly forbids, even if it's also expected", () => {
    seedChange(repoPath);
    seedApprovedPlan({ expectedFiles: ["src-app.ts"], forbiddenFiles: ["src-app.ts"] });
    fs.writeFileSync(path.join(repoPath, "src-app.ts"), "export const value = 2;\n");

    const result = runScopeCheck(repoPath, CHANGE_ID);

    assert.equal(result.success, false);
    assert.equal(result.blocked, true);
    assert.deepEqual(result.blockedFiles, ["src-app.ts"]);
  });

  // Every case above modifies a file that is already tracked -- the one shape
  // `git diff --name-only` can see. It lists neither newly created files nor
  // staged ones, so an agent that writes a brand new file outside the approved
  // scope walked through this check untouched. Creating a file where the plan
  // never said you could is the violation scope enforcement most exists to
  // catch, and it was the one violation invisible to it.
  it("flags a newly created file that is outside the approved DB plan scope", () => {
    seedChange(repoPath);
    seedApprovedPlan({ expectedFiles: ["src-app.ts"], forbiddenFiles: [] });
    fs.writeFileSync(path.join(repoPath, "src-leaked.ts"), "export const leaked = 1;\n");

    const result = runScopeCheck(repoPath, CHANGE_ID);

    assert.equal(result.success, false);
    assert.deepEqual(result.outOfScopeFiles, ["src-leaked.ts"]);
  });

  it("blocks a newly created file the plan forbids", () => {
    seedChange(repoPath);
    seedApprovedPlan({ expectedFiles: ["src-app.ts"], forbiddenFiles: ["secrets/**"] });
    fs.mkdirSync(path.join(repoPath, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "secrets", "keys.ts"), "export const key = 1;\n");

    const result = runScopeCheck(repoPath, CHANGE_ID);

    assert.equal(result.blocked, true);
    assert.deepEqual(result.blockedFiles, ["secrets/keys.ts"]);
  });

  it("sees a staged out-of-scope change as well as an unstaged one", () => {
    seedChange(repoPath);
    seedApprovedPlan({ expectedFiles: ["src-app.ts"], forbiddenFiles: [] });
    fs.writeFileSync(path.join(repoPath, "src-forbidden.ts"), "export const secret = 2;\n");
    execFileSync("git", ["add", "src-forbidden.ts"], { cwd: repoPath });

    const result = runScopeCheck(repoPath, CHANGE_ID);

    assert.equal(result.success, false);
    assert.deepEqual(result.outOfScopeFiles, ["src-forbidden.ts"]);
  });

  // "Nothing was written" and "we could not look" used to be the same answer:
  // the catch swallowed the failure and left an empty changeset, which passes.
  // A check whose entire job is to notice writes must not report clean when it
  // could not read the repository.
  it("blocks instead of passing when git status cannot be read", () => {
    seedChange(repoPath);
    seedApprovedPlan({ expectedFiles: ["src-app.ts"], forbiddenFiles: [] });
    fs.writeFileSync(path.join(repoPath, ".git", "HEAD"), "not a ref\n");

    const result = runScopeCheck(repoPath, CHANGE_ID);

    assert.equal(result.success, false);
    assert.equal(result.blocked, true);
    assert.equal(
      result.findings.some((finding) => finding.title === "Scope could not be checked"),
      true,
      "an unreadable repository must surface as a blocker, not as a clean scope",
    );
  });

  it("ignores a tampered plan.json on disk -- the approved DB snapshot is authoritative", () => {
    seedChange(repoPath);
    seedApprovedPlan({ expectedFiles: ["src-app.ts"], forbiddenFiles: [] });
    // A human (or a stale/leftover file) claims src-forbidden.ts is in scope.
    // This must not widen what the DB actually approved.
    fs.mkdirSync(path.join(repoPath, ".ship", "changes", CHANGE_ID), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, ".ship", "changes", CHANGE_ID, "plan.json"),
      JSON.stringify({ expectedFiles: ["src-app.ts", "src-forbidden.ts"], forbiddenFiles: [] }, null, 2),
    );
    fs.writeFileSync(path.join(repoPath, "src-app.ts"), "export const value = 2;\n");
    fs.writeFileSync(path.join(repoPath, "src-forbidden.ts"), "export const secret = 2;\n");

    const result = runScopeCheck(repoPath, CHANGE_ID);

    assert.equal(result.success, false);
    assert.deepEqual(
      result.outOfScopeFiles,
      ["src-forbidden.ts"],
      "the tampered plan.json's wider scope must not override the approved DB snapshot",
    );
  });
});
