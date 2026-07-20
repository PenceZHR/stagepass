import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import fs from "fs";
import os from "os";
import path from "path";
import * as schema from "../db/schema.ts";
import { ReworkChangeInput } from "../types/api.ts";
import { reworkChangeWithDb } from "./change-rework-service.ts";

const { projects, changes, runs, events, artifacts, findings } = schema;

function setupTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL UNIQUE,
      context_status TEXT NOT NULL DEFAULT 'pending',
      context_provider TEXT NOT NULL DEFAULT 'codex',
      prd_status TEXT NOT NULL DEFAULT 'none',
      prd_provider TEXT NOT NULL DEFAULT 'codex',
      prd_json TEXT,
      prd_markdown TEXT,
      git_enabled INTEGER NOT NULL DEFAULT 0,
      git_default_branch TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE changes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'codex',
      codex_thread_id TEXT,
      fix_iterations INTEGER DEFAULT 0,
      blocked_phase TEXT,
      rework_from_phase TEXT,
      suspended_by_prd INTEGER NOT NULL DEFAULT 0,
      pre_suspend_status TEXT,
      git_branch TEXT,
      gate_state TEXT,
      docs_complete INTEGER NOT NULL DEFAULT 0,
      retro_done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      change_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      summary TEXT,
      job_id TEXT,
      worker_id TEXT,
      lease_token TEXT,
      attempt_no INTEGER,
      provider TEXT
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      change_id TEXT,
      run_id TEXT,
      type TEXT NOT NULL,
      message TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      change_id TEXT NOT NULL,
      run_id TEXT,
      type TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE findings (
      id TEXT PRIMARY KEY,
      change_id TEXT NOT NULL,
      run_id TEXT,
      round_id TEXT,
      phase TEXT,
      source TEXT NOT NULL,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      file TEXT,
      line INTEGER,
      evidence TEXT,
      required_fix TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      review_attempt_id TEXT,
      source_build_run_id TEXT,
      source_head_sha TEXT,
      waivable INTEGER NOT NULL DEFAULT 0,
      waived_by TEXT,
      waived_at TEXT,
      waiver_decision_id TEXT,
      legacy_state TEXT,
      legacy_finding_key TEXT,
      finding_version INTEGER NOT NULL DEFAULT 1
    );
  `);
  return drizzle(sqlite, { schema });
}

function seedChange(db: ReturnType<typeof setupTestDb>, repoPath: string, status = "LOCAL_READY") {
  const now = "2026-06-20T00:00:00.000Z";
  const changeDir = path.join(repoPath, ".ship", "changes", "CHG-001");
  fs.mkdirSync(path.join(changeDir, "runs", "RUN-003"), { recursive: true });
  fs.writeFileSync(path.join(changeDir, "test-plan-delta.md"), "# TestPlan\n");
  fs.writeFileSync(path.join(changeDir, "changed-files.json"), "[]");
  fs.writeFileSync(path.join(changeDir, "implement-summary.md"), "# Build\n");
  fs.mkdirSync(path.join(changeDir, "build", "runs", "build-1", "result"), { recursive: true });
  fs.mkdirSync(path.join(changeDir, "reports"), { recursive: true });
  fs.writeFileSync(path.join(changeDir, "build", "runs", "build-1", "build-1.json"), "{}");
  fs.writeFileSync(path.join(changeDir, "build", "runs", "build-1", "result", "build.patch"), "");
  fs.writeFileSync(path.join(changeDir, "reports", "build-1-report.md"), "# Build Report\n");
  fs.writeFileSync(path.join(changeDir, "runs", "RUN-003", "local-check.json"), "{}");
  fs.writeFileSync(path.join(changeDir, "local-check.json"), "{}");
  fs.writeFileSync(path.join(changeDir, "findings.json"), "[]");

  db.insert(projects).values({
    id: "PRJ-001",
    name: "Test",
    repoPath,
    contextStatus: "ready",
    contextProvider: "codex",
    prdStatus: "ready",
    prdProvider: "codex",
    prdJson: null,
    prdMarkdown: null,
    gitEnabled: 0,
    gitDefaultBranch: null,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(changes).values({
    id: "CHG-001",
    projectId: "PRJ-001",
    title: "Change",
    status,
    provider: "codex",
    codexThreadId: null,
    fixIterations: 1,
    blockedPhase: "local_check",
    reworkFromPhase: null,
    suspendedByPrd: 0,
    preSuspendStatus: null,
    gitBranch: null,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(runs).values([
    { id: "RUN-001", changeId: "CHG-001", phase: "generate_plan", status: "completed", startedAt: now, endedAt: now, summary: "plan" },
    { id: "RUN-002", changeId: "CHG-001", phase: "test_plan", status: "completed", startedAt: now, endedAt: now, summary: "test plan" },
    { id: "RUN-003", changeId: "CHG-001", phase: "implement", status: "completed", startedAt: now, endedAt: now, summary: "impl" },
    { id: "RUN-004", changeId: "CHG-001", phase: "local_check", status: "completed", startedAt: now, endedAt: now, summary: "check" },
  ]).run();
  db.insert(events).values([
    { id: "EVT-001", changeId: "CHG-001", runId: "RUN-001", type: "run_completed", message: "plan", rawJson: null, createdAt: now },
    { id: "EVT-002", changeId: "CHG-001", runId: "RUN-002", type: "run_completed", message: "test plan", rawJson: null, createdAt: now },
    { id: "EVT-003", changeId: "CHG-001", runId: "RUN-003", type: "run_completed", message: "impl", rawJson: null, createdAt: now },
    { id: "EVT-004", changeId: "CHG-001", runId: "RUN-004", type: "run_completed", message: "check", rawJson: null, createdAt: now },
  ]).run();
  db.insert(artifacts).values([
    { id: "ART-001", changeId: "CHG-001", runId: "RUN-001", type: "plan_md", path: path.join(changeDir, "runs", "RUN-001", "plan.md"), createdAt: now },
    { id: "ART-002", changeId: "CHG-001", runId: "RUN-002", type: "test_plan_delta", path: path.join(changeDir, "test-plan-delta.md"), createdAt: now },
    { id: "ART-003", changeId: "CHG-001", runId: "RUN-004", type: "local_check", path: path.join(changeDir, "runs", "RUN-003", "local-check.json"), createdAt: now },
  ]).run();
  db.insert(findings).values({
    id: "FND-001",
    changeId: "CHG-001",
    runId: "RUN-003",
    source: "lint",
    severity: "P1",
    category: "quality",
    title: "lint failed",
    file: "src/app.ts",
    line: null,
    evidence: null,
    requiredFix: null,
    status: "open",
    createdAt: now,
  }).run();
}

describe("change-rework-service", () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "rework-service-"));
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("accepts TestPlan and Build as public rework API phases", () => {
    assert.equal(ReworkChangeInput.safeParse({ phase: "TestPlan" }).success, true);
    assert.equal(ReworkChangeInput.safeParse({ phase: "Build" }).success, true);
  });

  it("moves Plan rework back to DRAFT and deletes later phase records", async () => {
    const db = setupTestDb();
    seedChange(db, repoPath);

    const updated = await reworkChangeWithDb(db, "PRJ-001", "CHG-001", "Plan");

    assert.equal(updated.status, "DRAFT");
    assert.equal(updated.reworkFromPhase, "generate_plan");
    assert.equal(updated.blockedPhase, null);
    assert.deepEqual(db.select().from(runs).where(eq(runs.changeId, "CHG-001")).all().map((run) => run.id), ["RUN-001"]);
    assert.deepEqual(db.select().from(artifacts).where(eq(artifacts.changeId, "CHG-001")).all().map((artifact) => artifact.id), ["ART-001"]);
    assert.equal(db.select().from(findings).where(eq(findings.changeId, "CHG-001")).all().length, 0);
    assert.equal(fs.existsSync(path.join(repoPath, ".ship", "changes", "CHG-001", "test-plan-delta.md")), false);
    assert.equal(fs.existsSync(path.join(repoPath, ".ship", "changes", "CHG-001", "local-check.json")), false);
  });

  it("clears release and retro root files when reworking from Plan", async () => {
    const db = setupTestDb();
    seedChange(db, repoPath);
    const changeDir = path.join(repoPath, ".ship", "changes", "CHG-001");
    fs.writeFileSync(path.join(changeDir, "release-note.md"), "# Release\n");
    fs.writeFileSync(path.join(changeDir, "retro.md"), "# Retro\n");

    await reworkChangeWithDb(db, "PRJ-001", "CHG-001", "Plan");

    assert.equal(fs.existsSync(path.join(changeDir, "release-note.md")), false);
    assert.equal(fs.existsSync(path.join(changeDir, "retro.md")), false);
  });

  it("moves TestPlan rework back to PLAN_APPROVED while retaining Plan history", async () => {
    const db = setupTestDb();
    seedChange(db, repoPath);
    const changeDir = path.join(repoPath, ".ship", "changes", "CHG-001");

    const updated = await reworkChangeWithDb(db, "PRJ-001", "CHG-001", "TestPlan");

    assert.equal(updated.status, "PLAN_APPROVED");
    assert.equal(updated.reworkFromPhase, "test_plan");
    assert.deepEqual(db.select().from(runs).where(eq(runs.changeId, "CHG-001")).all().map((run) => run.id), ["RUN-001"]);
    assert.equal(fs.existsSync(path.join(changeDir, "test-plan-delta.md")), false);
    assert.equal(fs.existsSync(path.join(changeDir, "changed-files.json")), false);
    assert.equal(fs.existsSync(path.join(changeDir, "build")), false);
    assert.equal(fs.existsSync(path.join(changeDir, "reports", "build-1-report.md")), false);
  });

  it("accepts Build rework as the UI phase name and retains TestPlan history", async () => {
    const db = setupTestDb();
    seedChange(db, repoPath);
    const changeDir = path.join(repoPath, ".ship", "changes", "CHG-001");

    const updated = await reworkChangeWithDb(db, "PRJ-001", "CHG-001", "Build");

    assert.equal(updated.status, "PLAN_APPROVED");
    assert.equal(updated.reworkFromPhase, "implement");
    assert.deepEqual(db.select().from(runs).where(eq(runs.changeId, "CHG-001")).all().map((run) => run.id), ["RUN-001", "RUN-002"]);
    assert.equal(fs.existsSync(path.join(changeDir, "test-plan-delta.md")), true);
    assert.equal(fs.existsSync(path.join(changeDir, "changed-files.json")), false);
    assert.equal(fs.existsSync(path.join(changeDir, "build")), false);
    assert.equal(fs.existsSync(path.join(changeDir, "reports", "build-1-report.md")), false);
  });

  it("keeps legacy Implement rework as an alias for Build", async () => {
    const db = setupTestDb();
    seedChange(db, repoPath);

    const updated = await reworkChangeWithDb(db, "PRJ-001", "CHG-001", "Implement");

    assert.equal(updated.status, "PLAN_APPROVED");
    assert.equal(updated.reworkFromPhase, "implement");
    assert.deepEqual(db.select().from(runs).where(eq(runs.changeId, "CHG-001")).all().map((run) => run.id), ["RUN-001", "RUN-002"]);
  });

  it("rejects rework while a change is actively running", async () => {
    const db = setupTestDb();
    seedChange(db, repoPath, "IMPLEMENTING");

    await assert.rejects(
      () => reworkChangeWithDb(db, "PRJ-001", "CHG-001", "Plan"),
      /Cannot rework while change is in IMPLEMENTING/
    );
  });

  /**
   * D6 audit (docs/state-projection-audit-2026-07-14.md): the running-status
   * guard used to list only 4 of the 10 running statuses (PLANNING, IMPLEMENTING,
   * CHECKING, FIXING). REVIEWING was not one of them, so /rework could fire while
   * a Review run was live, delete that run's row out from under it, and
   * force-set changes.status without going through assertLegalTransition.
   */
  it("rejects rework for every running status, not just the four it originally covered", async () => {
    const db = setupTestDb();
    const runningStatuses = [
      "SPECCING", "TECHSPECCING", "TESTPLANNING", "REVIEWING", "MERGING", "RETRO_PENDING",
    ];

    for (const status of runningStatuses) {
      seedChange(db, repoPath, status);

      await assert.rejects(
        () => reworkChangeWithDb(db, "PRJ-001", "CHG-001", "Plan"),
        new RegExp(`Cannot rework while change is in ${status}`),
        `expected rework to be rejected while status is ${status}`,
      );

      db.delete(runs).where(eq(runs.changeId, "CHG-001")).run();
      db.delete(events).where(eq(events.changeId, "CHG-001")).run();
      db.delete(artifacts).where(eq(artifacts.changeId, "CHG-001")).run();
      db.delete(findings).where(eq(findings.changeId, "CHG-001")).run();
      db.delete(changes).where(eq(changes.id, "CHG-001")).run();
      db.delete(projects).where(eq(projects.id, "PRJ-001")).run();
    }
  });

  it("restores staged files and rolls back rows when the DB transaction fails", async () => {
    const db = setupTestDb();
    seedChange(db, repoPath);
    const changeDir = path.join(repoPath, ".ship", "changes", "CHG-001");
    const artifactPath = path.join(changeDir, "test-plan-delta.md");

    await assert.rejects(
      () => reworkChangeWithDb(db, "PRJ-001", "CHG-001", "Plan", {
        beforeDbCommit: () => { throw new Error("injected DB failure"); },
      }),
      /injected DB failure/,
    );

    assert.equal(fs.readFileSync(artifactPath, "utf8"), "# TestPlan\n");
    assert.equal(db.select().from(runs).where(eq(runs.changeId, "CHG-001")).all().length, 4);
    assert.equal(db.select().from(changes).where(eq(changes.id, "CHG-001")).get()?.status, "LOCAL_READY");
    assert.equal(fs.readdirSync(changeDir).some((name) => name.startsWith(".rework-staging-")), false);
  });

  it("restores every already-staged path when a later rename fails", async () => {
    const db = setupTestDb();
    seedChange(db, repoPath);
    const changeDir = path.join(repoPath, ".ship", "changes", "CHG-001");
    const expected = ["test-plan-delta.md", "changed-files.json"]
      .map((name) => [name, fs.readFileSync(path.join(changeDir, name), "utf8")] as const);

    await assert.rejects(
      () => reworkChangeWithDb(db, "PRJ-001", "CHG-001", "Plan", {
        beforeStageRename: (_path, index) => {
          if (index === 1) throw new Error("injected rename failure");
        },
      }),
      /injected rename failure/,
    );

    for (const [name, content] of expected) {
      assert.equal(fs.readFileSync(path.join(changeDir, name), "utf8"), content);
    }
    assert.equal(db.select().from(runs).where(eq(runs.changeId, "CHG-001")).all().length, 4);
    assert.equal(fs.readdirSync(changeDir).some((name) => name.startsWith(".rework-staging-")), false);
  });

  it("restores all staged paths when afterStage fails before the DB transaction", async () => {
    const db = setupTestDb();
    seedChange(db, repoPath);
    const changeDir = path.join(repoPath, ".ship", "changes", "CHG-001");

    await assert.rejects(
      () => reworkChangeWithDb(db, "PRJ-001", "CHG-001", "Plan", {
        afterStage: () => { throw new Error("injected after-stage failure"); },
      }),
      /injected after-stage failure/,
    );

    assert.equal(fs.existsSync(path.join(changeDir, "test-plan-delta.md")), true);
    assert.equal(fs.existsSync(path.join(changeDir, "changed-files.json")), true);
    assert.equal(fs.existsSync(path.join(changeDir, "build")), true);
    assert.equal(db.select().from(runs).where(eq(runs.changeId, "CHG-001")).all().length, 4);
    assert.equal(fs.readdirSync(changeDir).some((name) => name.startsWith(".rework-staging-")), false);
  });

  it("never leaves DB artifact rows pointing at removed originals when final cleanup fails", async () => {
    const db = setupTestDb();
    seedChange(db, repoPath);
    const changeDir = path.join(repoPath, ".ship", "changes", "CHG-001");

    await reworkChangeWithDb(db, "PRJ-001", "CHG-001", "Plan", {
      beforeStagingCleanup: () => { throw new Error("injected cleanup failure"); },
    });

    const remainingPaths = db.select().from(artifacts)
      .where(eq(artifacts.changeId, "CHG-001"))
      .all()
      .map((artifact) => artifact.path);
    assert.deepEqual(remainingPaths, [path.join(changeDir, "runs", "RUN-001", "plan.md")]);
    assert.equal(fs.existsSync(path.join(changeDir, "test-plan-delta.md")), false);
    assert.equal(fs.readdirSync(changeDir).some((name) => name.startsWith(".rework-staging-")), true);
  });
});
