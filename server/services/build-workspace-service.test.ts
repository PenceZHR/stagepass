import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "../db/schema.ts";
import {
  applyPatch,
  commitAll,
  commitWithMessage,
  createGitWorktree,
  getBinaryDiff,
  getCommitSubject,
  getHeadSha,
  getPorcelainStatus,
  isWorkingTreeClean,
  removeGitWorktree,
} from "./git-service";
import {
  absorbBuildPatch,
  adoptFixPatch,
  approveBuildForAbsorb,
  assertAdoptedBuildRunMatchesWorkspace,
  changeArtifactIgnoredPrefixes,
  checkGitBaseCamp,
  collectBuildResult,
  createBuildWorkspace,
  evaluateBuildGate,
  isDeadBuildRunStatus,
  readLatestApprovedBuildRun,
  readLatestBuildRun,
  rejectLatestBuildRun,
  resolveApprovedBuildRun,
  writeBuildRun,
  BuildWorkspaceGitProbeError,
  setBuildWorkspaceGitRunnerForTest,
} from "./build-workspace-service";
import { buildRunsDir } from "./build-workspace-paths";
import {
  allChangeArtifactIgnoredPrefixes,
  trustedPipelineArtifactIgnoredPrefixes,
} from "./build-workspace-ignored-prefixes";
import type {
  BuildWorkspaceGitCommandOptions,
  BuildWorkspaceGitCommandRunner,
} from "./build-workspace-service";
import type { BuildRunFile } from "./build-workspace-service";
import {
  getLatestAdoptedBuildRecord,
  setBuildRunRecordDbForTest,
} from "./build-run-record-service.ts";
import { setStageGuardServiceDbForTest } from "./stage-guard-service.ts";

const tempDirs: string[] = [];
let restoreBuildRunRecordDb: (() => void) | null = null;
let restoreStageGuardDb: (() => void) | null = null;
let buildRunRecordDb: ReturnType<typeof makeBuildRunRecordTestDb> | null = null;
let stageGuardPlanDb: ReturnType<typeof makePlanScopeTestDb> | null = null;
let restoreBuildWorkspaceGitRunner: (() => void) | null = null;

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function makeBuildRun(overrides: Partial<BuildRunFile> = {}): BuildRunFile {
  const now = new Date().toISOString();
  return {
    changeId: "CHG-001",
    runNumber: 1,
    status: "created",
    baseCommit: "0".repeat(40),
    workspacePath: "/tmp/workspace",
    branchName: "stagepass/build/CHG-001/build-1",
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "build-workspace-repo-"));
  tempDirs.push(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  return repo;
}

function makeWorkspace(repo: string): string {
  const baseCommit = getHeadSha(repo);
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ai-workspaces-"));
  tempDirs.push(workspaceRoot);
  const workspacePath = path.join(workspaceRoot, `CHG-${tempDirs.length}`);

  createGitWorktree(repo, {
    workspacePath,
    branchName: `stagepass/change/CHG-${tempDirs.length}`,
    baseCommit,
  });

  return workspacePath;
}

function trackBuildWorkspace(repo: string, changeId = "CHG-001"): void {
  tempDirs.push(path.join(path.dirname(repo), ".stagepass-workspaces", path.basename(repo), changeId));
}

function writeAndCommitPlan(repo: string, changeId: string, plan: unknown): void {
  fs.mkdirSync(path.join(repo, ".ship", "changes", changeId), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".ship", "changes", changeId, "plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`
  );
  if (stageGuardPlanDb && plan && typeof plan === "object") {
    const planRecord = plan as {
      expectedFiles?: string[];
      allowedFiles?: string[];
      forbiddenFiles?: string[];
    };
    seedApprovedPlanScope(
      stageGuardPlanDb,
      changeId,
      planRecord.expectedFiles ?? planRecord.allowedFiles ?? [],
      planRecord.forbiddenFiles ?? [],
    );
  }
  execFileSync("git", ["add", ".ship"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "add build plan"], { cwd: repo, stdio: "ignore" });
}

function makeBuildRunRecordTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE build_run_records (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT NOT NULL,
      run_id TEXT,
      build_run_id TEXT,
      status TEXT NOT NULL,
      head_sha TEXT,
      base_head_sha TEXT,
      base_commit TEXT,
      patch_hash TEXT,
      changed_files_hash TEXT,
      adopted_head_sha TEXT,
      adoption_decision_id TEXT,
      adopted_at TEXT,
      artifact_hash TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_build_run_records_change_status_adopted
      ON build_run_records (change_id, status, adopted_at);
  `);
  return drizzle(sqlite, { schema });
}

function makePlanScopeTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE plan_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_name TEXT,
      source_spec_hash TEXT,
      expected_files_json TEXT,
      forbidden_files_json TEXT,
      test_plan_json TEXT,
      model_risks_json TEXT,
      validation_policy_hash TEXT,
      approved_at TEXT,
      approval_decision_id TEXT,
      snapshot_db_hash TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE required_validation_commands (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      source_snapshot_id TEXT,
      command TEXT NOT NULL,
      command_order INTEGER NOT NULL,
      required INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
  `);
  return drizzle(sqlite, { schema });
}

function seedApprovedPlanScope(
  db: ReturnType<typeof makePlanScopeTestDb>,
  changeId: string,
  expectedFiles: string[],
  forbiddenFiles: string[],
) {
  const now = new Date().toISOString();
  db.insert(schema.planSnapshots).values({
    id: `${changeId}-PLAN-SNAP-001`,
    changeId,
    status: "approved",
    planName: `${changeId} plan`,
    sourceSpecHash: "spec-hash",
    expectedFilesJson: JSON.stringify(expectedFiles),
    forbiddenFilesJson: JSON.stringify(forbiddenFiles),
    validationPolicyHash: "validation-hash",
    approvedAt: now,
    approvalDecisionId: null,
    snapshotDbHash: `${changeId}-source-db-hash`,
    createdAt: now,
  }).run();
  db.insert(schema.requiredValidationCommands).values({
    id: `${changeId}-VAL-CMD-001`,
    changeId,
    phase: "Plan",
    sourceSnapshotId: `${changeId}-PLAN-SNAP-001`,
    command: "npm test",
    commandOrder: 1,
    required: 1,
    createdAt: now,
  }).run();
}

function porcelainPaths(repo: string): string[] {
  const output = execFileSync("git", ["status", "--porcelain", "-uall"], {
    cwd: repo,
    encoding: "utf-8",
  }).trimEnd();
  return output ? output.split("\n").map((line) => line.slice(3).trim()) : [];
}

/**
 * The artifact set a change leaves behind once it has run PAST Build. Every one
 * of these paths is outside `trustedPipelineArtifactIgnoredPrefixes`, which is
 * the whole point: a per-file whitelist -- even one extended to siblings --
 * still reads them as dirty, so tests built on this helper can only pass when
 * the sibling's directory is ignored wholesale.
 *
 * Returns the repo-relative paths it wrote.
 */
function writePostBuildChangeArtifacts(repo: string, changeId: string): string[] {
  const relativePaths = [
    "plan.json",
    "build/runs/build-1.json",
    "approvals/build-1-approval.json",
    "mirrors/review-report.md",
    "review-findings.json",
    "retro.md",
    "scope-check.json",
    "local-check.json",
  ].map((relativePath) => path.posix.join(".ship", "changes", changeId, relativePath));

  for (const relativePath of relativePaths) {
    const target = path.join(repo, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${changeId} artifact: ${relativePath}\n`);
  }
  return relativePaths;
}

/** Drives an approved-for-absorb build run for `changeId` that rewrites app.ts. */
function approveAppTsBuild(repo: string, changeId = "CHG-001"): void {
  trackBuildWorkspace(repo, changeId);
  writeAndCommitPlan(repo, changeId, { allowedFiles: ["app.ts"] });
  const run = createBuildWorkspace({ repoPath: repo, changeId });
  fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
  collectBuildResult({ repoPath: repo, changeId });
  approveBuildForAbsorb({ repoPath: repo, changeId });
}

describe("git worktree primitives", () => {
  beforeEach(() => {
    buildRunRecordDb = makeBuildRunRecordTestDb();
    restoreBuildRunRecordDb = setBuildRunRecordDbForTest(buildRunRecordDb);
    stageGuardPlanDb = makePlanScopeTestDb();
    restoreStageGuardDb = setStageGuardServiceDbForTest(stageGuardPlanDb);
  });

  afterEach(() => {
    restoreBuildWorkspaceGitRunner?.();
    restoreBuildWorkspaceGitRunner = null;
    restoreBuildRunRecordDb?.();
    restoreBuildRunRecordDb = null;
    buildRunRecordDb = null;
    restoreStageGuardDb?.();
    restoreStageGuardDb = null;
    stageGuardPlanDb = null;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills a hung git probe within the configured command budget", () => {
    let receivedOptions: BuildWorkspaceGitCommandOptions | undefined;
    const runner: BuildWorkspaceGitCommandRunner = (_args, options) => {
      receivedOptions = options;
      return spawnSync(process.execPath, ["-e", "setInterval(() => {}, 10_000)"], options);
    };
    restoreBuildWorkspaceGitRunner = setBuildWorkspaceGitRunnerForTest(runner, 60);
    const startedAt = Date.now();

    assert.throws(
      () => checkGitBaseCamp(process.cwd()),
      (error: unknown) => {
        assert.ok(error instanceof BuildWorkspaceGitProbeError);
        assert.equal(error.code, "build_workspace_probe_timeout");
        assert.equal(error.message, "Build workspace Git probe timed out");
        assert.equal(error.message.includes("customer-secret"), false);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 750, "hung git probe exceeded its response budget");
    assert.equal(receivedOptions?.timeout, 60);
    assert.equal(receivedOptions?.killSignal, "SIGKILL");
    assert.ok((receivedOptions?.maxBuffer ?? 0) > 0);
  });

  it("maps oversized git output to a typed bounded failure", () => {
    const runner: BuildWorkspaceGitCommandRunner = (_args, options) => spawnSync(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(Number(process.argv[1]) + 1024))", String(options.maxBuffer)],
      options,
    );
    restoreBuildWorkspaceGitRunner = setBuildWorkspaceGitRunnerForTest(runner, 200);

    assert.throws(
      () => checkGitBaseCamp(process.cwd()),
      (error: unknown) => {
        assert.ok(error instanceof BuildWorkspaceGitProbeError);
        assert.equal(error.code, "build_workspace_probe_output_limit");
        assert.equal(error.message, "Build workspace Git probe output exceeded limit");
        assert.equal(error.message.includes("customer-secret"), false);
        return true;
      },
    );
  });

  it("maps git failures without exposing repository paths or stderr", () => {
    const secret = "/private/workspace/customer-secret";
    restoreBuildWorkspaceGitRunner = setBuildWorkspaceGitRunnerForTest(() => ({
      pid: 1,
      output: [null, "", `fatal: ${secret}`],
      stdout: "",
      stderr: `fatal: ${secret}`,
      status: 2,
      signal: null,
      error: undefined,
    }), 100);

    assert.throws(
      () => checkGitBaseCamp(secret),
      (error: unknown) => {
        assert.ok(error instanceof BuildWorkspaceGitProbeError);
        assert.equal(error.code, "build_workspace_probe_failure");
        assert.equal(error.message, "Build workspace Git probe failed");
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  });

  it("caps configured command timeouts at one second and returns successful probes", () => {
    const receivedTimeouts: number[] = [];
    restoreBuildWorkspaceGitRunner = setBuildWorkspaceGitRunnerForTest((args, options) => {
      receivedTimeouts.push(options.timeout);
      const command = args.join(" ");
      const stdout = command === "rev-parse --is-inside-work-tree"
        ? "true\n"
        : command === "rev-parse --verify HEAD" || command === "rev-parse HEAD"
          ? `${"a".repeat(40)}\n`
          : "";
      return {
        pid: 1,
        output: [null, stdout, ""],
        stdout,
        stderr: "",
        status: 0,
        signal: null,
        error: undefined,
      };
    }, 5_000);

    const result = checkGitBaseCamp(process.cwd());

    assert.equal(result.status, "ready");
    assert.equal(result.headSha, "a".repeat(40));
    assert.deepEqual(receivedTimeouts, [1_000, 1_000, 1_000, 1_000]);
  });

  it("reads HEAD and clean status", () => {
    const repo = makeRepo();
    assert.match(getHeadSha(repo), /^[0-9a-f]{40}$/);
    assert.equal(isWorkingTreeClean(repo), true);
    fs.writeFileSync(path.join(repo, "dirty.ts"), "export const dirty = true;\n");
    assert.equal(isWorkingTreeClean(repo), false);
    assert.deepEqual(getPorcelainStatus(repo), ["?? dirty.ts"]);
  });

  it("creates a worktree, removes it, builds a binary diff, and applies it back", () => {
    const repo = makeRepo();
    const workspacePath = makeWorkspace(repo);

    fs.writeFileSync(path.join(workspacePath, "app.ts"), "export const value = 2;\n");
    const patch = getBinaryDiff(workspacePath);
    assert.match(patch, /diff --git a\/app\.ts b\/app\.ts/);

    applyPatch(repo, patch);
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 2;\n");
    assert.deepEqual(getPorcelainStatus(repo), [" M app.ts"]);

    removeGitWorktree(repo, workspacePath, true);
    assert.equal(fs.existsSync(workspacePath), false);
  });

  it("includes untracked new files in binary diffs", () => {
    const repo = makeRepo();
    const workspacePath = makeWorkspace(repo);

    fs.writeFileSync(path.join(workspacePath, "new-file.ts"), "export const fresh = true;\n");
    const patch = getBinaryDiff(workspacePath);

    assert.match(patch, /diff --git a\/new-file\.ts b\/new-file\.ts/);
    assert.match(patch, /new file mode 100644/);

    applyPatch(repo, patch);
    assert.equal(fs.readFileSync(path.join(repo, "new-file.ts"), "utf-8"), "export const fresh = true;\n");
  });

  it("includes deleted files in binary diffs", () => {
    const repo = makeRepo();
    const workspacePath = makeWorkspace(repo);

    fs.rmSync(path.join(workspacePath, "app.ts"));
    const patch = getBinaryDiff(workspacePath);

    assert.match(patch, /diff --git a\/app\.ts b\/app\.ts/);
    assert.match(patch, /deleted file mode 100644/);

    applyPatch(repo, patch);
    assert.equal(fs.existsSync(path.join(repo, "app.ts")), false);
  });

  it("includes staged changes in binary diffs without changing the real index", () => {
    const repo = makeRepo();
    const workspacePath = makeWorkspace(repo);

    fs.writeFileSync(path.join(workspacePath, "app.ts"), "export const value = 3;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: workspacePath });
    const statusBefore = getPorcelainStatus(workspacePath);

    const patch = getBinaryDiff(workspacePath);

    assert.deepEqual(getPorcelainStatus(workspacePath), statusBefore);
    assert.deepEqual(statusBefore, ["M  app.ts"]);
    assert.match(patch, /diff --git a\/app\.ts b\/app\.ts/);
    assert.match(patch, /export const value = 3;/);

    applyPatch(repo, patch);
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 3;\n");
  });

  it("rejects invalid patches without changing files or the real index", () => {
    const repo = makeRepo();
    const beforeContent = fs.readFileSync(path.join(repo, "app.ts"), "utf-8");
    const beforeStatus = getPorcelainStatus(repo);
    const invalidPatch = [
      "diff --git a/app.ts b/app.ts",
      "index 1111111..2222222 100644",
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -1 +1 @@",
      "-export const value = 99;",
      "+export const value = 100;",
      "",
    ].join("\n");

    assert.throws(() => applyPatch(repo, invalidPatch), /Git apply check failed/);
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), beforeContent);
    assert.deepEqual(getPorcelainStatus(repo), beforeStatus);
  });
});

describe("Build Gate", () => {
  it("marks expectedFiles deviations without blocking", () => {
    const result = evaluateBuildGate({
      mutations: [
        { kind: "modified", path: "src/app.ts" },
        { kind: "created", path: "src/extra.ts" },
      ],
      plan: {
        expectedFiles: ["src/app.ts"],
        forbiddenFiles: [],
      },
      policy: { blockedFiles: [], blockedGlobs: [] },
    });

    assert.equal(result.blocked, false);
    assert.deepEqual(result.blockingFiles, []);
    assert.deepEqual(result.deviations, [
      {
        file: "src/extra.ts",
        reason: "outside_expected_files",
        severityHint: "P2",
      },
    ]);
  });

  it("uses allowedFiles as legacy expectedFiles alias", () => {
    const result = evaluateBuildGate({
      mutations: [{ kind: "modified", path: "src/app.ts" }],
      plan: {
        allowedFiles: ["src/app.ts"],
        forbiddenFiles: [],
      },
      policy: { blockedFiles: [], blockedGlobs: [] },
    });

    assert.equal(result.blocked, false);
    assert.deepEqual(result.blockingFiles, []);
    assert.deepEqual(result.deviations, []);
  });

  it("treats source changes as deviations when no expectedFiles are declared", () => {
    const result = evaluateBuildGate({
      mutations: [{ kind: "modified", path: "src/app.ts" }],
      plan: {
        forbiddenFiles: [],
      },
      policy: { blockedFiles: [], blockedGlobs: [] },
    });

    assert.equal(result.blocked, false);
    assert.deepEqual(result.blockingFiles, []);
    assert.deepEqual(result.deviations, [
      {
        file: "src/app.ts",
        reason: "outside_expected_files",
        severityHint: "P2",
      },
    ]);
  });

  it("deduplicates and sorts deviations for stable build reports", () => {
    const result = evaluateBuildGate({
      mutations: [
        { kind: "modified", path: "src/z.ts" },
        { kind: "modified", path: "src/a.ts" },
        { kind: "modified", path: "src/z.ts" },
      ],
      plan: {
        expectedFiles: ["src/app.ts"],
        forbiddenFiles: [],
      },
      policy: { blockedFiles: [], blockedGlobs: [] },
    });

    assert.deepEqual(result.deviations, [
      {
        file: "src/a.ts",
        reason: "outside_expected_files",
        severityHint: "P2",
      },
      {
        file: "src/z.ts",
        reason: "outside_expected_files",
        severityHint: "P2",
      },
    ]);
  });

  it("hard blocks forbiddenFiles and policy globs", () => {
    const result = evaluateBuildGate({
      mutations: [
        { kind: "modified", path: "infra/main.tf" },
        { kind: "modified", path: "src/secret.ts" },
        { kind: "created", path: "deploy/prod.yaml" },
      ],
      plan: {
        expectedFiles: ["src/app.ts"],
        forbiddenFiles: ["infra/**"],
      },
      policy: {
        blockedFiles: ["src/secret.ts"],
        blockedGlobs: ["deploy/**"],
      },
    });

    assert.equal(result.blocked, true);
    assert.deepEqual(result.blockingFiles, [
      "deploy/prod.yaml",
      "infra/main.tf",
      "src/secret.ts",
    ]);
  });

  it("hard blocks default secrets paths", () => {
    const result = evaluateBuildGate({
      mutations: [{ kind: "created", path: "secrets/token.txt" }],
      plan: {
        expectedFiles: ["secrets/token.txt"],
        forbiddenFiles: [],
      },
      policy: { blockedFiles: [], blockedGlobs: [] },
    });

    assert.equal(result.blocked, true);
    assert.deepEqual(result.blockingFiles, ["secrets/token.txt"]);
    assert.deepEqual(result.deviations, []);
  });

  it("ignores .ship artifacts for deviations and blockers", () => {
    const result = evaluateBuildGate({
      mutations: [
        { kind: "created", path: ".ship/changes/CHG-001/build/runs/build-1.json" },
      ],
      plan: {
        expectedFiles: ["src/app.ts"],
        forbiddenFiles: [],
      },
      policy: {
        blockedFiles: [],
        blockedGlobs: [".ship/**"],
      },
    });

    assert.equal(result.blocked, false);
    assert.deepEqual(result.blockingFiles, []);
    assert.deepEqual(result.deviations, []);
  });

  it("hard blocks absolute paths and parent directory path escapes", () => {
    const result = evaluateBuildGate({
      mutations: [
        { kind: "modified", path: "/tmp/outside.ts" },
        { kind: "modified", path: "src/../secret.ts" },
        { kind: "modified", path: "../secret.ts" },
      ],
      plan: {
        expectedFiles: ["src/app.ts"],
        forbiddenFiles: [],
      },
      policy: { blockedFiles: [], blockedGlobs: [] },
    });

    assert.equal(result.blocked, true);
    assert.deepEqual(result.blockingFiles, [
      "../secret.ts",
      "/tmp/outside.ts",
      "src/../secret.ts",
    ]);
  });
});

describe("build workspace metadata and git base camp", () => {
  beforeEach(() => {
    buildRunRecordDb = makeBuildRunRecordTestDb();
    restoreBuildRunRecordDb = setBuildRunRecordDbForTest(buildRunRecordDb);
    stageGuardPlanDb = makePlanScopeTestDb();
    restoreStageGuardDb = setStageGuardServiceDbForTest(stageGuardPlanDb);
  });

  afterEach(() => {
    restoreBuildWorkspaceGitRunner?.();
    restoreBuildWorkspaceGitRunner = null;
    restoreBuildRunRecordDb?.();
    restoreBuildRunRecordDb = null;
    buildRunRecordDb = null;
    restoreStageGuardDb?.();
    restoreStageGuardDb = null;
    stageGuardPlanDb = null;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports ready when the repo has a clean committed HEAD", () => {
    const repo = makeRepo();

    const baseCamp = checkGitBaseCamp(repo);

    assert.equal(baseCamp.status, "ready");
    assert.equal(baseCamp.headSha, getHeadSha(repo));
    assert.equal(baseCamp.clean, true);
    assert.deepEqual(baseCamp.blockers, []);
  });

  it("reports dirty when the repo has uncommitted changes", () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, "dirty.ts"), "export const dirty = true;\n");

    const baseCamp = checkGitBaseCamp(repo);

    assert.equal(baseCamp.status, "dirty");
    assert.equal(baseCamp.headSha, getHeadSha(repo));
    assert.equal(baseCamp.clean, false);
    assert.match(baseCamp.warnings.join("\n"), /working tree/i);
  });

  it("allows pipeline .ship metadata to be ignored without ignoring product files", () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".ship", "baseline"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".ship", "baseline", "prd.md"), "# PRD\n");

    const baseCamp = checkGitBaseCamp(repo, {
      ignoredPrefixes: changeArtifactIgnoredPrefixes("CHG-001"),
    });

    assert.equal(baseCamp.status, "ready");
    fs.writeFileSync(path.join(repo, "dirty.ts"), "export const dirty = true;\n");
    const blocked = checkGitBaseCamp(repo, {
      ignoredPrefixes: changeArtifactIgnoredPrefixes("CHG-001"),
    });
    assert.equal(blocked.status, "dirty");
    assert.match(blocked.warnings.join("\n"), /dirty\.ts/);
    assert.doesNotMatch(blocked.warnings.join("\n"), /\.ship/);
  });

  it("blocks when the path is not a git repository", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "build-workspace-no-git-"));
    tempDirs.push(repo);

    const baseCamp = checkGitBaseCamp(repo);

    assert.equal(baseCamp.status, "blocked");
    assert.equal(baseCamp.headSha, null);
    assert.equal(baseCamp.clean, false);
    assert.match(baseCamp.blockers.join("\n"), /git repository/i);
  });

  it("creates a worktree, writes build run metadata, and reads the latest run", () => {
    const repo = makeRepo();
    const baseCommit = getHeadSha(repo);

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    trackBuildWorkspace(repo);

    assert.equal(run.changeId, "CHG-001");
    assert.equal(run.runNumber, 1);
    assert.equal(run.status, "created");
    assert.equal(run.baseCommit, baseCommit);
    assert.equal(run.branchName, "stagepass/build/CHG-001/build-1");
    assert.ok(run.workspacePath);
    assert.equal(fs.existsSync(path.join(run.workspacePath, ".git")), true);

    const runPath = path.join(repo, ".ship", "changes", "CHG-001", "build", "runs", "build-1.json");
    assert.equal(fs.existsSync(runPath), true);

    const latest = readLatestBuildRun(repo, "CHG-001");
    assert.deepEqual(latest, run);
  });

  it("resolves the approved build run past newer unapproved runs", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    const adopted = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    writeBuildRun(repo, { ...adopted, status: "adopted" });

    // Two fix runs that failed. Each wrote a higher-numbered build-N.json, and
    // neither may shadow the adopted run downstream stages must validate.
    for (const runNumber of [2, 3]) {
      writeBuildRun(repo, { ...adopted, runNumber, status: "failed", purpose: "fix" });
    }

    assert.equal(readLatestBuildRun(repo, "CHG-001")?.runNumber, 3);
    assert.equal(readLatestApprovedBuildRun(repo, "CHG-001")?.runNumber, 1);
    assert.equal(readLatestApprovedBuildRun(repo, "CHG-001")?.status, "adopted");
  });

  it("resolves a newer adopted fix run once the fix succeeds", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    const adopted = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    writeBuildRun(repo, { ...adopted, status: "adopted" });
    writeBuildRun(repo, { ...adopted, runNumber: 2, status: "failed", purpose: "fix" });
    writeBuildRun(repo, { ...adopted, runNumber: 3, status: "adopted", purpose: "fix" });
    writeBuildRun(repo, { ...adopted, runNumber: 4, status: "rejected", purpose: "fix" });

    // The successful fix is what the change now carries, so it wins over build-1.
    assert.equal(readLatestApprovedBuildRun(repo, "CHG-001")?.runNumber, 3);

    writeBuildRun(repo, { ...adopted, runNumber: 5, status: "approved_for_absorb", purpose: "fix" });
    assert.equal(readLatestApprovedBuildRun(repo, "CHG-001")?.runNumber, 5);
  });

  it("returns no approved build run when every run is unapproved", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    const created = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    writeBuildRun(repo, { ...created, runNumber: 2, status: "failed" });

    assert.equal(readLatestApprovedBuildRun(repo, "CHG-001"), null);
    assert.equal(readLatestApprovedBuildRun(repo, "CHG-404"), null);
  });

  it("resolves the approved build run past newer dead runs, and only those", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    const adopted = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    writeBuildRun(repo, { ...adopted, status: "adopted" });
    writeBuildRun(repo, { ...adopted, runNumber: 2, status: "failed", purpose: "fix" });
    writeBuildRun(repo, { ...adopted, runNumber: 3, status: "rejected", purpose: "fix" });

    // Both newer runs are over and were never approved, so neither may shadow
    // the adopted build the change actually carries.
    const resolved = resolveApprovedBuildRun(repo, "CHG-001");
    assert.equal(resolved.run?.runNumber, 1);
    assert.equal(resolved.run?.status, "adopted");
    assert.equal(resolved.blockedBy, null);

    // A newer run that is still live or awaiting a decision is a different
    // matter: it may yet become the deliverable, so refuse instead of falling
    // back. Only `failed`/`rejected` are inert enough to skip.
    for (const status of ["created", "running", "gate_blocked", "awaiting_human", "audit_ready"] as const) {
      writeBuildRun(repo, { ...adopted, runNumber: 4, status, purpose: "fix" });
      const blocked = resolveApprovedBuildRun(repo, "CHG-001");
      assert.equal(blocked.run, null, `a newer ${status} run must not resolve build-1`);
      assert.equal(blocked.blockedBy?.runNumber, 4);
      assert.equal(blocked.blockedBy?.status, status);
      fs.rmSync(path.join(buildRunsDir(repo, "CHG-001"), "build-4.json"));
    }

    assert.equal(isDeadBuildRunStatus("failed"), true);
    assert.equal(isDeadBuildRunStatus("rejected"), true);
    for (const status of ["created", "running", "gate_blocked", "awaiting_human", "audit_ready"] as const) {
      assert.equal(isDeadBuildRunStatus(status), false, `${status} is not a dead run`);
    }
  });

  it("resolves a newer approved run, and nothing at all when none is approved", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    const adopted = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    writeBuildRun(repo, { ...adopted, status: "adopted" });
    writeBuildRun(repo, { ...adopted, runNumber: 2, status: "failed", purpose: "fix" });
    writeBuildRun(repo, { ...adopted, runNumber: 3, status: "adopted", purpose: "fix" });

    // A fix that succeeded is what the change now carries; it wins over build-1.
    assert.equal(resolveApprovedBuildRun(repo, "CHG-001").run?.runNumber, 3);

    assert.deepEqual(resolveApprovedBuildRun(repo, "CHG-404"), { run: null, blockedBy: null });
  });

  it("rejects path-like change ids before creating build artifacts", () => {
    const repo = makeRepo();

    assert.throws(
      () => createBuildWorkspace({ repoPath: repo, changeId: ".." }),
      /Invalid changeId/
    );
    assert.throws(
      () => createBuildWorkspace({ repoPath: repo, changeId: "." }),
      /Invalid changeId/
    );
    assert.throws(
      () => createBuildWorkspace({ repoPath: repo, changeId: "CHG.001" }),
      /Invalid changeId/
    );
  });

  it("does not follow symlinked build artifact ancestors when writing metadata", () => {
    const repo = makeRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "build-workspace-outside-"));
    tempDirs.push(outside);
    fs.symlinkSync(outside, path.join(repo, ".ship"));

    assert.throws(
      () => writeBuildRun(repo, makeBuildRun()),
      /symlink|outside the repository/i
    );
    assert.equal(fs.existsSync(path.join(outside, "changes", "CHG-001", "build")), false);
  });

  it("removes the worktree branch when metadata writing fails", () => {
    const repo = makeRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "build-workspace-outside-"));
    tempDirs.push(outside);
    trackBuildWorkspace(repo);

    const changeRoot = path.join(repo, ".ship", "changes", "CHG-001");
    fs.mkdirSync(changeRoot, { recursive: true });
    fs.symlinkSync(outside, path.join(changeRoot, "build"));
    execFileSync("git", ["add", ".ship"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "track unsafe build symlink"], {
      cwd: repo,
      stdio: "ignore",
    });

    assert.throws(
      () => createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" }),
      /symlink|outside the repository/i
    );

    const branchOutput = execFileSync(
      "git",
      ["branch", "--list", "stagepass/build/CHG-001/build-1"],
      { cwd: repo, encoding: "utf-8" }
    );
    assert.equal(branchOutput.trim(), "");
    assert.equal(
      fs.existsSync(path.join(path.dirname(repo), ".stagepass-workspaces", path.basename(repo), "CHG-001", "build-1")),
      false
    );

    fs.rmSync(path.join(changeRoot, "build"));
    fs.mkdirSync(path.join(changeRoot, "build"), { recursive: true });
    execFileSync("git", ["add", ".ship"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "replace build symlink"], {
      cwd: repo,
      stdio: "ignore",
    });

    const retry = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    assert.equal(retry.runNumber, 1);
    assert.equal(retry.branchName, "stagepass/build/CHG-001/build-1");
  });

  it("rejects a controlled worktree root that is a symlink to an external directory", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "build-workspace-parent-"));
    tempDirs.push(parent);
    const repo = path.join(parent, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "app.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "build-workspace-external-"));
    tempDirs.push(outside);
    fs.symlinkSync(outside, path.join(parent, ".stagepass-workspaces"));

    assert.throws(
      () => createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" }),
      /worktree root.*symlink|controlled.*outside|untrusted/i
    );
    assert.equal(fs.readdirSync(outside).length, 0);
  });

  it("can create a second build run while its own build metadata is dirty", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);

    const first = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    const strictBaseCamp = checkGitBaseCamp(repo);
    assert.equal(strictBaseCamp.status, "dirty");

    const second = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(first.runNumber, 1);
    assert.equal(second.runNumber, 2);
    assert.equal(second.branchName, "stagepass/build/CHG-001/build-2");
    assert.equal(fs.existsSync(path.join(second.workspacePath, ".git")), true);
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.runNumber, 2);
  });

  it("allows current change plan artifacts when creating and collecting a build", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    assert.ok(stageGuardPlanDb);
    seedApprovedPlanScope(stageGuardPlanDb, "CHG-001", ["app.ts"], []);
    const changeDir = path.join(repo, ".ship", "changes", "CHG-001");
    fs.mkdirSync(path.join(changeDir, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir, "plan.json"),
      `${JSON.stringify({ allowedFiles: ["app.ts"], forbiddenFiles: [] }, null, 2)}\n`
    );
    fs.writeFileSync(path.join(changeDir, "plan.md"), "# Implementation Plan\n");
    fs.writeFileSync(path.join(changeDir, "reports", "plan-report.md"), "Verdict: can_approve\n");

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    const collected = collectBuildResult({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(collected.status, "awaiting_human");
    assert.deepEqual(collected.changedFiles, ["app.ts"]);
  });

  it("collects Build scope from DB even when plan.json is tampered to allow a forbidden file", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo, "CHG-DB-SCOPE");
    const planDb = makePlanScopeTestDb();
    restoreStageGuardDb?.();
    restoreStageGuardDb = setStageGuardServiceDbForTest(planDb);
    seedApprovedPlanScope(planDb, "CHG-DB-SCOPE", ["app.ts"], ["secret.ts"]);
    writeAndCommitPlan(repo, "CHG-DB-SCOPE", {
      expectedFiles: ["secret.ts"],
      forbiddenFiles: [],
      validationCommands: ["echo tampered"],
    });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-DB-SCOPE" });
    fs.writeFileSync(path.join(run.workspacePath, "secret.ts"), "export const leaked = true;\n");

    const collected = collectBuildResult({ repoPath: repo, changeId: "CHG-DB-SCOPE" });

    assert.equal(collected.status, "gate_blocked");
    assert.deepEqual(collected.expectedFiles, ["app.ts"]);
    assert.deepEqual(collected.forbiddenFiles, ["secret.ts"]);
    assert.deepEqual(collected.blockers, ["secret.ts"]);
  });

  it("creates an isolated build workspace without modifying dirty source files", () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".ship", "changes", "CHG-001"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".ship", "changes", "CHG-001", "plan.json"),
      `${JSON.stringify({ allowedFiles: ["app.ts"], forbiddenFiles: [] }, null, 2)}\n`
    );
    fs.writeFileSync(path.join(repo, "app.ts"), "export const value = 99;\n");

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf8"), "export const value = 99;\n");
    assert.equal(fs.readFileSync(path.join(run.workspacePath, "app.ts"), "utf8"), "export const value = 1;\n");
  });

  it("collects build artifacts and marks non-blocked runs as awaiting human review", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");

    const collected = collectBuildResult({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(collected.status, "awaiting_human");
    assert.deepEqual(collected.changedFiles, ["app.ts"]);
    assert.equal(collected.patchPath, ".ship/changes/CHG-001/build/runs/build-1/result/build.patch");
    assert.match(collected.patchSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(collected.diffPath, ".ship/changes/CHG-001/build/runs/build-1/result/build.diff");
    assert.equal(collected.auditPath, ".ship/changes/CHG-001/build/runs/build-1/result/build-audit.json");
    assert.equal(collected.reportPath, ".ship/changes/CHG-001/reports/build-1-report.md");
    assert.match(
      fs.readFileSync(path.join(repo, collected.patchPath!), "utf-8"),
      /diff --git a\/app\.ts b\/app\.ts/
    );
    assert.match(
      fs.readFileSync(path.join(repo, collected.diffPath!), "utf-8"),
      /diff --git a\/app\.ts b\/app\.ts/
    );
    const audit = JSON.parse(fs.readFileSync(path.join(repo, collected.auditPath!), "utf-8"));
    assert.equal(audit.status, "awaiting_human");
    assert.deepEqual(audit.changedFiles, ["app.ts"]);
    assert.deepEqual(audit.blockingFiles, []);
    assert.match(
      fs.readFileSync(path.join(repo, collected.reportPath), "utf-8"),
      /Status: awaiting_human/
    );
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "awaiting_human");
  });

  it("marks forbidden build changes as gate blocked and records blocking files in audit", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"], forbiddenFiles: ["infra/**"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.mkdirSync(path.join(run.workspacePath, "infra"));
    fs.writeFileSync(path.join(run.workspacePath, "infra", "main.tf"), "resource \"x\" \"y\" {}\n");

    const collected = collectBuildResult({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(collected.status, "gate_blocked");
    assert.deepEqual(collected.changedFiles, ["infra/main.tf"]);
    assert.deepEqual(collected.blockers, ["infra/main.tf"]);
    const audit = JSON.parse(fs.readFileSync(path.join(repo, collected.auditPath!), "utf-8"));
    assert.equal(audit.status, "gate_blocked");
    assert.deepEqual(audit.blockingFiles, ["infra/main.tf"]);
    assert.deepEqual(audit.changedFiles, ["infra/main.tf"]);
  });

  it("uses git name-status output so quoted secret paths cannot bypass the build gate", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.mkdirSync(path.join(run.workspacePath, "secrets"));
    fs.writeFileSync(path.join(run.workspacePath, "secrets", "雪.txt"), "token\n");

    const collected = collectBuildResult({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(collected.status, "gate_blocked");
    assert.deepEqual(collected.changedFiles, ["secrets/雪.txt"]);
    assert.deepEqual(collected.blockers, ["secrets/雪.txt"]);
  });

  it("fails collection when the build workspace produced no changes", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });

    assert.throws(
      () => collectBuildResult({ repoPath: repo, changeId: "CHG-001" }),
      /no changes/i
    );
    const latest = readLatestBuildRun(repo, "CHG-001");
    assert.equal(latest?.status, "failed");
    assert.deepEqual(latest?.blockers, ["Build workspace produced no changes."]);
  });

  it("includes added and deleted files in collected changedFiles", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts", "new-file.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.rmSync(path.join(run.workspacePath, "app.ts"));
    fs.writeFileSync(path.join(run.workspacePath, "new-file.ts"), "export const fresh = true;\n");

    const collected = collectBuildResult({ repoPath: repo, changeId: "CHG-001" });

    assert.deepEqual(collected.changedFiles, ["app.ts", "new-file.ts"]);
    assert.match(
      fs.readFileSync(path.join(repo, collected.patchPath!), "utf-8"),
      /deleted file mode 100644/
    );
    assert.match(
      fs.readFileSync(path.join(repo, collected.patchPath!), "utf-8"),
      /new file mode 100644/
    );
  });

  it("rejects absorb unless the latest run is approved for absorb", () => {
    const repo = makeRepo();
    writeBuildRun(repo, makeBuildRun({ status: "awaiting_human" }));

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      /approved_for_absorb/
    );
  });

  it("marks the latest build run as rejected", () => {
    const repo = makeRepo();
    const originalUpdatedAt = "2026-01-01T00:00:00.000Z";
    writeBuildRun(
      repo,
      makeBuildRun({
        status: "awaiting_human",
        updatedAt: originalUpdatedAt,
      })
    );

    const rejected = rejectLatestBuildRun({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(rejected.status, "rejected");
    assert.notEqual(rejected.updatedAt, originalUpdatedAt);
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "rejected");
  });

  it("marks a gate-blocked build run as rejected", () => {
    const repo = makeRepo();
    writeBuildRun(repo, makeBuildRun({ status: "gate_blocked" }));

    const rejected = rejectLatestBuildRun({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(rejected.status, "rejected");
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "rejected");
  });

  it("does not reject build runs in terminal or approved states", () => {
    const repo = makeRepo();
    const protectedStatuses: BuildRunFile["status"][] = [
      "approved_for_absorb",
      "adopted",
      "rejected",
      "failed",
    ];

    for (const status of protectedStatuses) {
      writeBuildRun(repo, makeBuildRun({ status }));

      assert.throws(
        () => rejectLatestBuildRun({ repoPath: repo, changeId: "CHG-001" }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(`cannot be rejected.*${status}`, "i"));
          assert.equal((error as { statusCode?: number }).statusCode, 409);
          return true;
        }
      );
      assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, status);
    }
  });

  it("rejects build rejection when there is no build run", () => {
    const repo = makeRepo();

    assert.throws(
      () => rejectLatestBuildRun({ repoPath: repo, changeId: "CHG-001" }),
      /No build run found/
    );
  });

  it("approves an awaiting human build run for absorb", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });

    const approved = approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(approved.status, "approved_for_absorb");
    assert.equal(
      approved.approvalPath,
      ".ship/changes/CHG-001/approvals/build-1-approval.json"
    );
    const approval = JSON.parse(fs.readFileSync(path.join(repo, approved.approvalPath!), "utf-8"));
    assert.equal(approval.changeId, "CHG-001");
    assert.equal(approval.runNumber, 1);
    assert.equal(approval.baseCommit, approved.baseCommit);
    assert.equal(approval.patchPath, approved.patchPath);
    assert.equal(approval.patchSha256, approved.patchSha256);
    assert.match(approval.approvedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "approved_for_absorb");
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.approvalPath, approved.approvalPath);
  });

  it("treats an already approved build run as the same absorb approval", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });

    const firstApproval = approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    const secondApproval = approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(secondApproval.status, "approved_for_absorb");
    assert.equal(secondApproval.approvalPath, firstApproval.approvalPath);
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.approvalPath, firstApproval.approvalPath);
  });

  it("rejects approval when the collected patch artifact was changed", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    const collected = collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    const patchPath = path.join(repo, collected.patchPath!);
    fs.writeFileSync(
      patchPath,
      fs.readFileSync(patchPath, "utf-8").replace(
        "+export const value = 2;",
        "+export const value = 3;"
      )
    );

    assert.throws(
      () => approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" }),
      /patch.*hash|hash.*patch/i
    );
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "awaiting_human");
  });

  it("rejects absorb when HEAD drifted from the build base commit", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(repo, "other.ts"), "export const other = true;\n");
    execFileSync("git", ["add", "other.ts"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "advance head"], { cwd: repo, stdio: "ignore" });

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      /HEAD drifted/
    );
  });

  it("rejects absorb when source files are dirty", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(repo, "dirty.ts"), "export const dirty = true;\n");

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      /dirty|uncommitted/i
    );
  });

  it("rejects absorb when current change artifacts leave the main workspace dirty", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });

    const changeDir = path.join(repo, ".ship", "changes", "CHG-001");
    fs.writeFileSync(path.join(changeDir, "unexpected-approval.json"), "{\"approved\":true}\n");
    fs.mkdirSync(path.join(changeDir, "untrusted", "RUN-TESTPLAN"), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir, "untrusted", "RUN-TESTPLAN", "test-plan-delta.md"),
      "# Untrusted TestPlan Snapshot\n"
    );

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      /dirty|uncommitted/i
    );
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 1;\n");
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "approved_for_absorb");
    assert.equal(getLatestAdoptedBuildRecord("CHG-001"), null);
  });

  it("absorbs while a sibling change's post-Build artifacts sit uncommitted", () => {
    const repo = makeRepo();
    approveAppTsBuild(repo, "CHG-001");
    // CHG-002 ran the full pipeline and, as the pipeline never commits its own
    // artifacts, left all of them uncommitted. None of these paths is in the
    // per-file trusted whitelist, so scoping the ignore list to the change being
    // adopted made every change after the first one permanently unadoptable.
    const siblingFiles = writePostBuildChangeArtifacts(repo, "CHG-002");
    const dirtyBefore = porcelainPaths(repo);
    for (const siblingFile of siblingFiles) {
      assert.ok(
        dirtyBefore.includes(siblingFile),
        `expected git to report ${siblingFile} as uncommitted before absorb`
      );
    }

    const adopted = absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(adopted.status, "adopted");
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 2;\n");
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "adopted");
    assert.ok(getLatestAdoptedBuildRecord("CHG-001"));
    // Ignored, not swallowed: adoption must leave the sibling's files untouched.
    for (const siblingFile of siblingFiles) {
      assert.equal(
        fs.readFileSync(path.join(repo, siblingFile), "utf-8"),
        `CHG-002 artifact: ${siblingFile}\n`
      );
    }
  });

  it("still rejects absorb when the current change's own directory holds an unknown file", () => {
    const repo = makeRepo();
    approveAppTsBuild(repo, "CHG-001");
    // The sibling relaxation is directory-level; the change being adopted keeps
    // the narrow per-file whitelist, so an unrecognised file it wrote is still
    // the anomaly the dirty check exists to surface.
    fs.writeFileSync(
      path.join(repo, ".ship", "changes", "CHG-001", "weird-model-output.txt"),
      "the model wrote something nobody asked for\n"
    );

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        assert.match((error as Error).message, /dirty workspace/i);
        assert.match((error as Error).message, /weird-model-output\.txt/);
        return true;
      }
    );
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 1;\n");
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "approved_for_absorb");
    assert.equal(getLatestAdoptedBuildRecord("CHG-001"), null);
  });

  it("still rejects absorb for a dirty source file even when sibling artifacts are ignored", () => {
    const repo = makeRepo();
    approveAppTsBuild(repo, "CHG-001");
    writePostBuildChangeArtifacts(repo, "CHG-002");
    fs.writeFileSync(path.join(repo, "README-scratch.md"), "# notes I never committed\n");

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        assert.match((error as Error).message, /README-scratch\.md/);
        assert.match((error as Error).message, /outside the adopted patch/);
        // The sibling is genuinely filtered out of the dirty set rather than
        // merely outweighed: it must not appear among the blocking files.
        assert.equal(/CHG-002/.test((error as Error).message), false);
        return true;
      }
    );
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 1;\n");
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "approved_for_absorb");
    assert.equal(getLatestAdoptedBuildRecord("CHG-001"), null);
  });

  it("survives a missing or non-directory .ship/changes when building the ignore list", () => {
    const repo = makeRepo();
    assert.equal(fs.existsSync(path.join(repo, ".ship")), false);

    // No `.ship/changes` at all: the readdir catch branch must degrade to the
    // current change's own whitelist rather than throw.
    assert.deepEqual(
      allChangeArtifactIgnoredPrefixes(repo, "CHG-001"),
      trustedPipelineArtifactIgnoredPrefixes("CHG-001")
    );

    // A stray file under `.ship/changes` is not a sibling change.
    fs.mkdirSync(path.join(repo, ".ship", "changes"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".ship", "changes", "notes.txt"), "not a change\n");
    assert.deepEqual(
      allChangeArtifactIgnoredPrefixes(repo, "CHG-001"),
      trustedPipelineArtifactIgnoredPrefixes("CHG-001")
    );

    // And absorb still works end to end when the current change is the only one.
    approveAppTsBuild(repo, "CHG-001");
    assert.deepEqual(
      allChangeArtifactIgnoredPrefixes(repo, "CHG-001"),
      trustedPipelineArtifactIgnoredPrefixes("CHG-001")
    );

    const adopted = absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(adopted.status, "adopted");
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 2;\n");
  });

  it("applies an approved build patch and marks the run adopted", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });

    const adopted = absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(adopted.status, "adopted");
    assert.equal(adopted.adoptedHeadSha, getHeadSha(repo));
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 2;\n");
    const latest = readLatestBuildRun(repo, "CHG-001");
    assert.equal(latest?.status, "adopted");
    assert.equal(latest?.adoptedHeadSha, adopted.adoptedHeadSha);
    const record = getLatestAdoptedBuildRecord("CHG-001");
    assert.ok(record);
    assert.equal(record.buildRunId, "build-1");
    assert.equal(record.headSha, adopted.adoptedHeadSha);
    assert.equal(record.artifactHash, adopted.patchSha256);
  });

  it("recovers adoption metadata when the verified patch was already applied before persistence", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });
    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    const approved = approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    assert.ok(approved.patchPath);
    applyPatch(repo, fs.readFileSync(path.resolve(repo, approved.patchPath), "utf-8"));

    const recovered = absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(recovered.status, "adopted");
    assert.ok(recovered.adoptedHeadSha);
    assert.ok(recovered.adoptionDecisionId);
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 2;\n");
    assert.ok(getLatestAdoptedBuildRecord("CHG-001"));
  });

  it("makes repeated approval and adoption idempotently repair the adopted DB record", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });
    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    const first = absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" });

    const secondApproval = approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    const second = absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(secondApproval.status, "adopted");
    assert.equal(second.status, "adopted");
    assert.equal(second.adoptedHeadSha, first.adoptedHeadSha);
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 2;\n");
    assert.ok(getLatestAdoptedBuildRecord("CHG-001"));
  });

  it("commits the adopted patch when commit is enabled, leaving the tree clean", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });
    const headBeforeAdoption = getHeadSha(repo);
    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    const approved = approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });

    const adopted = absorbBuildPatch({
      repoPath: repo,
      changeId: "CHG-001",
      commit: { enabled: true },
    });

    assert.equal(adopted.status, "adopted");
    assert.notEqual(adopted.adoptedHeadSha, headBeforeAdoption, "adoption should have created a new commit");
    assert.equal(adopted.adoptedHeadSha, getHeadSha(repo));
    assert.ok(
      !getPorcelainStatus(repo).some((line) => line.endsWith("app.ts")),
      "the patched file should no longer show as dirty once committed",
    );
    assert.equal(
      getCommitSubject(repo, "HEAD"),
      `build(CHG-001): adopt build-${approved.runNumber}-adoption`,
    );
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 2;\n");
  });

  it("does not commit when commit is disabled, leaving the tree dirty as before", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });
    const headBeforeAdoption = getHeadSha(repo);
    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });

    const adopted = absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" });

    assert.equal(adopted.status, "adopted");
    assert.equal(adopted.adoptedHeadSha, headBeforeAdoption, "no commit should have been created");
    assert.notDeepEqual(getPorcelainStatus(repo), [], "the tree should stay dirty when commit is not enabled");
  });

  it("recognises its own commit on retry after a crash between commit and persisting `adopted`", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });
    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    const approved = approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    assert.ok(approved.patchPath);

    // Simulate the crash window: the patch was applied and committed, but the
    // process died before absorbBuildPatch could persist `adopted`. run.status
    // is still approved_for_absorb, and HEAD has moved past run.baseCommit.
    applyPatch(repo, fs.readFileSync(path.resolve(repo, approved.patchPath), "utf-8"));
    commitWithMessage(repo, `build(CHG-001): adopt build-${approved.runNumber}-adoption`, ["app.ts"]);
    const committedHeadSha = getHeadSha(repo);

    const recovered = absorbBuildPatch({
      repoPath: repo,
      changeId: "CHG-001",
      commit: { enabled: true },
    });

    assert.equal(recovered.status, "adopted");
    assert.equal(recovered.adoptedHeadSha, committedHeadSha, "retry should not create a second commit");
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 2;\n");
    assert.ok(getLatestAdoptedBuildRecord("CHG-001"));
  });

  it("still rejects real HEAD drift when commit is enabled but the message does not match", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });
    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });

    // An unrelated commit lands on the branch -- not the retry-of-our-own-commit case.
    fs.writeFileSync(path.join(repo, "unrelated.txt"), "someone else's change\n");
    commitAll(repo, "unrelated: someone else committed something");

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001", commit: { enabled: true } }),
      /HEAD drifted from build base commit/,
    );
  });

  it("reports a 409 conflict when an adopted patch is no longer applied", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });
    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(repo, "app.ts"), "export const value = 1;\n");

    assert.throws(
      () => assertAdoptedBuildRunMatchesWorkspace({ repoPath: repo, changeId: "CHG-001" }),
      (error: unknown) => {
        assert.equal(error instanceof BuildWorkspaceGitProbeError, false);
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        assert.match((error as Error).message, /patch is not applied|does not exactly match/i);
        return true;
      },
    );
  });

  it("keeps reverse apply check timeouts as typed probe failures", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });
    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" });
    restoreBuildWorkspaceGitRunner = setBuildWorkspaceGitRunnerForTest((args, options) => {
      if (args[0] === "apply" && args.includes("--reverse")) {
        return spawnSync(process.execPath, ["-e", "setInterval(() => {}, 10_000)"], options);
      }
      return spawnSync("git", [...args], options);
    }, 60);

    assert.throws(
      () => assertAdoptedBuildRunMatchesWorkspace({ repoPath: repo, changeId: "CHG-001" }),
      (error: unknown) => {
        assert.ok(error instanceof BuildWorkspaceGitProbeError);
        assert.equal(error.code, "build_workspace_probe_timeout");
        return true;
      },
    );
  });

  it("rejects unexpected reverse apply exits and missing statuses as typed failures", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });
    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" });
    const secret = "/private/workspace/customer-secret";
    const failures = [
      { status: 128, signal: null },
      { status: null, signal: null },
      { status: null, signal: "SIGTERM" as NodeJS.Signals },
    ];

    for (const failure of failures) {
      const restoreRunner = setBuildWorkspaceGitRunnerForTest((args, options) => {
        if (args[0] === "apply" && args.includes("--reverse")) {
          return {
            pid: 1,
            output: [null, "", `fatal: ${secret}`],
            stdout: "",
            stderr: `fatal: ${secret}`,
            status: failure.status,
            signal: failure.signal,
            error: undefined,
          };
        }
        return spawnSync("git", [...args], options);
      }, 100);
      try {
        assert.throws(
          () => assertAdoptedBuildRunMatchesWorkspace({ repoPath: repo, changeId: "CHG-001" }),
          (error: unknown) => {
            assert.ok(error instanceof BuildWorkspaceGitProbeError);
            assert.equal(error.code, "build_workspace_probe_failure");
            assert.equal(error.message, "Build workspace Git probe failed");
            assert.equal(error.message.includes(secret), false);
            return true;
          },
        );
      } finally {
        restoreRunner();
      }
    }
  });

  it("rejects adoption when the DB patch hash drifts from the recomputed workspace patch", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo, "CHG-001");
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    assert.ok(buildRunRecordDb);
    buildRunRecordDb
      .update(schema.buildRunRecords)
      .set({ patchHash: "sha256:old" })
      .where(eq(schema.buildRunRecords.changeId, "CHG-001"))
      .run();

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /build_hash_drift|patch hash/i);
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        return true;
      },
    );
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "approved_for_absorb");
    assert.equal(getLatestAdoptedBuildRecord("CHG-001"), null);
  });

  it("rejects adoption when the DB changed files hash drifts from collected changed files", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo, "CHG-001");
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    assert.ok(buildRunRecordDb);
    buildRunRecordDb
      .update(schema.buildRunRecords)
      .set({ changedFilesHash: "sha256:old-files" })
      .where(eq(schema.buildRunRecords.changeId, "CHG-001"))
      .run();

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /build_hash_drift|changed files hash/i);
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        return true;
      },
    );
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "approved_for_absorb");
    assert.equal(getLatestAdoptedBuildRecord("CHG-001"), null);
  });

  it("rejects fix adoption when the DB patch hash drifts and does not write adopted HEAD", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo, "CHG-001");
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001", purpose: "fix" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    assert.ok(buildRunRecordDb);
    buildRunRecordDb
      .update(schema.buildRunRecords)
      .set({ patchHash: "sha256:old-fix" })
      .where(eq(schema.buildRunRecords.changeId, "CHG-001"))
      .run();

    assert.throws(
      () => adoptFixPatch({ repoPath: repo, changeId: "CHG-001" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /fix_hash_drift|build_hash_drift|patch hash/i);
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        return true;
      },
    );
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "approved_for_absorb");
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.adoptedHeadSha ?? null, null);
    assert.equal(getLatestAdoptedBuildRecord("CHG-001"), null);
  });

  it("rejects adopted build runs without adopted HEAD metadata", () => {
    const repo = makeRepo();
    writeBuildRun(repo, makeBuildRun({ status: "adopted" }));

    assert.throws(
      () => assertAdoptedBuildRunMatchesWorkspace({ repoPath: repo, changeId: "CHG-001" }),
      /missing adopted HEAD/i
    );
  });

  it("recovers adoption when the approved patch is the only main workspace change", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    const collected = collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    applyPatch(repo, fs.readFileSync(path.join(repo, collected.patchPath!), "utf-8"));

    const adopted = absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" });
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 2;\n");
    assert.equal(adopted.status, "adopted");
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "adopted");
    assert.ok(getLatestAdoptedBuildRecord("CHG-001"));
  });

  it("rejects already-applied absorb recovery when extra source files are dirty", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    const collected = collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    applyPatch(repo, fs.readFileSync(path.join(repo, collected.patchPath!), "utf-8"));
    fs.writeFileSync(path.join(repo, "extra.ts"), "export const extra = true;\n");

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      (error: unknown) => {
        assert.equal(error instanceof BuildWorkspaceGitProbeError, false);
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        assert.match((error as Error).message, /dirty|already applied|approved patch/i);
        return true;
      },
    );
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "approved_for_absorb");
  });

  it("rejects already-applied absorb recovery when an unapproved approval artifact is dirty", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    const collected = collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    applyPatch(repo, fs.readFileSync(path.join(repo, collected.patchPath!), "utf-8"));
    fs.writeFileSync(
      path.join(repo, ".ship", "changes", "CHG-001", "approvals", "other-approval.json"),
      "{}\n"
    );

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      /approval|dirty|approved patch/i
    );
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "approved_for_absorb");
  });

  it("rejects already-applied absorb recovery when the same dirty path has different content", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    const collected = collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    applyPatch(repo, fs.readFileSync(path.join(repo, collected.patchPath!), "utf-8"));
    fs.writeFileSync(path.join(repo, "app.ts"), "export const value = 3;\n");

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      (error: unknown) => {
        assert.equal(error instanceof BuildWorkspaceGitProbeError, false);
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        assert.match((error as Error).message, /dirty|already applied|approved patch/i);
        return true;
      },
    );
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "approved_for_absorb");
  });

  it("rejects an adopted-state bypass with extra staged edits in an approved file", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });
    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });
    const adopted = absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" });
    fs.appendFileSync(path.join(repo, "app.ts"), "export const unapproved = true;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: repo });

    assert.throws(
      () => assertAdoptedBuildRunMatchesWorkspace({ repoPath: repo, changeId: "CHG-001" }),
      (error: unknown) => {
        assert.equal(error instanceof BuildWorkspaceGitProbeError, false);
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        assert.match((error as Error).message, /does not exactly match|approved patch/i);
        return true;
      },
    );
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.adoptedHeadSha, adopted.adoptedHeadSha);
  });

  it("rejects absorb when the approved patch artifact was changed", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    const collected = collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });

    const patchPath = path.join(repo, collected.patchPath!);
    fs.writeFileSync(
      patchPath,
      fs.readFileSync(patchPath, "utf-8").replace(
        "+export const value = 2;",
        "+export const value = 3;"
      )
    );

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      (error: unknown) => {
        assert.equal(error instanceof BuildWorkspaceGitProbeError, false);
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        assert.match((error as Error).message, /patch.*hash|hash.*patch/i);
        return true;
      },
    );
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 1;\n");
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "approved_for_absorb");
  });

  it("rejects absorb when the approved patch and run hash are both changed", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    const collected = collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });

    const patchPath = path.join(repo, collected.patchPath!);
    const tamperedPatch = fs.readFileSync(patchPath, "utf-8").replace(
      "+export const value = 2;",
      "+export const value = 3;"
    );
    fs.writeFileSync(patchPath, tamperedPatch);
    writeBuildRun(repo, {
      ...readLatestBuildRun(repo, "CHG-001")!,
      patchSha256: sha256(tamperedPatch),
    });

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      /approval|patch.*hash|hash.*patch/i
    );
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 1;\n");
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "approved_for_absorb");
  });

  it("does not trust run approvalPath when patch, run hash, and pointed approval are replaced", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    writeAndCommitPlan(repo, "CHG-001", { allowedFiles: ["app.ts"] });

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");
    const collected = collectBuildResult({ repoPath: repo, changeId: "CHG-001" });
    const approved = approveBuildForAbsorb({ repoPath: repo, changeId: "CHG-001" });

    const patchPath = path.join(repo, collected.patchPath!);
    const tamperedPatch = fs.readFileSync(patchPath, "utf-8").replace(
      "+export const value = 2;",
      "+export const value = 3;"
    );
    const tamperedPatchSha256 = sha256(tamperedPatch);
    fs.writeFileSync(patchPath, tamperedPatch);

    const maliciousApprovalPath = ".ship/changes/CHG-001/build/approvals/malicious-approval.json";
    fs.mkdirSync(path.dirname(path.join(repo, maliciousApprovalPath)), { recursive: true });
    fs.writeFileSync(
      path.join(repo, maliciousApprovalPath),
      `${JSON.stringify(
        {
          changeId: "CHG-001",
          runNumber: 1,
          baseCommit: approved.baseCommit,
          patchPath: collected.patchPath,
          patchSha256: tamperedPatchSha256,
          approvedAt: new Date().toISOString(),
        },
        null,
        2
      )}\n`
    );
    writeBuildRun(repo, {
      ...approved,
      patchSha256: tamperedPatchSha256,
      approvalPath: maliciousApprovalPath,
    });

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      /approval|patch.*hash|hash.*patch/i
    );
    assert.equal(fs.readFileSync(path.join(repo, "app.ts"), "utf-8"), "export const value = 1;\n");
    assert.equal(readLatestBuildRun(repo, "CHG-001")?.status, "approved_for_absorb");
  });

  it("rejects absorb when the patch path is missing or points to a missing file", () => {
    const repo = makeRepo();

    writeBuildRun(repo, makeBuildRun({ status: "approved_for_absorb", patchPath: null }));
    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      /patchPath/
    );

    writeBuildRun(
      repo,
      makeBuildRun({
        status: "approved_for_absorb",
        patchPath: ".ship/changes/CHG-001/build/runs/build-1/result/missing.patch",
        patchSha256: "0".repeat(64),
      })
    );
    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      /patch.*not found|missing/i
    );
  });

  it("rejects absorb when patchPath escapes the current change build artifacts", () => {
    const cases = [
      {
        name: "parent directory traversal",
        patchPath: "../outside.patch",
      },
      {
        name: "absolute path",
        patchPath: path.join(os.tmpdir(), "outside.patch"),
      },
      {
        name: "another change build artifact",
        patchPath: ".ship/changes/CHG-002/build/runs/build-1/result/build.patch",
      },
    ];

    for (const testCase of cases) {
      const repo = makeRepo();
      writeBuildRun(
        repo,
        makeBuildRun({
          status: "approved_for_absorb",
          baseCommit: getHeadSha(repo),
          patchPath: testCase.patchPath,
          patchSha256: "0".repeat(64),
        })
      );

      assert.throws(
        () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
        /outside this change/i,
        testCase.name
      );
    }
  });

  it("rejects absorb when the patch artifact is a symlink", () => {
    const repo = makeRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "build-workspace-patch-outside-"));
    tempDirs.push(outside);
    const patchPath = ".ship/changes/CHG-001/build/runs/build-1/result/build.patch";
    const patchTarget = path.join(repo, patchPath);
    fs.mkdirSync(path.dirname(patchTarget), { recursive: true });
    fs.writeFileSync(path.join(outside, "build.patch"), "not a trusted patch\n");
    fs.symlinkSync(path.join(outside, "build.patch"), patchTarget);
    writeBuildRun(
      repo,
      makeBuildRun({
        status: "approved_for_absorb",
        baseCommit: getHeadSha(repo),
        patchPath,
        patchSha256: "0".repeat(64),
      })
    );

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      /patch artifact is a symlink/i
    );
  });

  it("rejects absorb when a build artifact ancestor directory is a symlink", () => {
    const repo = makeRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "build-workspace-result-outside-"));
    tempDirs.push(outside);
    const patchPath = ".ship/changes/CHG-001/build/runs/build-1/result/build.patch";
    const resultDir = path.join(
      repo,
      ".ship",
      "changes",
      "CHG-001",
      "build",
      "runs",
      "build-1",
      "result"
    );
    fs.mkdirSync(path.dirname(resultDir), { recursive: true });
    fs.writeFileSync(path.join(outside, "build.patch"), "not a trusted patch\n");
    fs.symlinkSync(outside, resultDir);
    writeBuildRun(
      repo,
      makeBuildRun({
        status: "approved_for_absorb",
        baseCommit: getHeadSha(repo),
        patchPath,
        patchSha256: "0".repeat(64),
      })
    );

    assert.throws(
      () => absorbBuildPatch({ repoPath: repo, changeId: "CHG-001" }),
      /artifact directory is a symlink/i
    );
  });

  it("does not create build result report directories through a symlink", () => {
    const repo = makeRepo();
    trackBuildWorkspace(repo);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "build-workspace-report-outside-"));
    tempDirs.push(outside);

    const run = createBuildWorkspace({ repoPath: repo, changeId: "CHG-001" });
    fs.mkdirSync(path.join(repo, ".ship", "changes", "CHG-001"), { recursive: true });
    fs.symlinkSync(outside, path.join(repo, ".ship", "changes", "CHG-001", "reports"));
    fs.writeFileSync(path.join(run.workspacePath, "app.ts"), "export const value = 2;\n");

    assert.throws(
      () => collectBuildResult({ repoPath: repo, changeId: "CHG-001", plan: { allowedFiles: ["app.ts"] } }),
      /symlink|outside the repository/i
    );
    assert.equal(fs.existsSync(path.join(outside, "build-report.md")), false);
  });
});
