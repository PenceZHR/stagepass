import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, sql } from "drizzle-orm";
import fs from "fs";
import os from "os";
import path from "path";
import * as schema from "../db/schema.ts";
import { runMigrations } from "../db/migrate.ts";
import { ReworkChangeInput } from "../types/api.ts";
import { reworkChangeWithDb } from "./change-rework-service.ts";

const {
  projects, changes, runs, events, artifacts, findings,
  rubrics, rubricCriteria, rubricAssessments, reviewState, reviewAttempts, reviewReports,
  reviewArtifactMirrors, reviewPriorFindingReviews, buildRunRecords, providerRunProcesses,
  releaseNoteState, qaRuns, qaCommandResults, qaEvidence, qaFailures, changeProviderSessions,
} = schema;

/**
 * The real schema, migrated, with foreign keys enforced.
 *
 * This used to be a hand-written CREATE TABLE for the six tables the test
 * happened to touch, run with `foreign_keys = OFF`. Both halves of that hid the
 * bug this file now covers: the other ten tables that reference a run did not
 * exist to be left behind, and even if they had, nothing would have objected.
 * /rework was failing on SQLITE_CONSTRAINT_FOREIGNKEY for all 21 phase/change
 * combinations in production while this suite stayed green.
 *
 * `runMigrations` takes the connection it is handed, so the fixture still owns
 * a private in-memory database and never opens a file -- local-memory, as
 * db-write-policy.json records.
 */
function setupTestDb() {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite);
  sqlite.pragma("foreign_keys = ON");
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

      // Children before parents: with the fixture on the real schema these
      // deletes are foreign-key checked, and `runs` last is the whole point.
      db.delete(findings).where(eq(findings.changeId, "CHG-001")).run();
      db.delete(artifacts).where(eq(artifacts.changeId, "CHG-001")).run();
      db.delete(events).where(eq(events.changeId, "CHG-001")).run();
      db.delete(runs).where(eq(runs.changeId, "CHG-001")).run();
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

  /**
   * Everything below covers the run-scoped cascade itself. `seedChange` only
   * populates four of the tables that reference a run; these seed all of them,
   * which is what it takes to see SQLITE_CONSTRAINT_FOREIGNKEY.
   */
  describe("run-scoped cascade", () => {
    /** One row in every table that references RUN-003 (implement) or RUN-004 (local_check). */
    function seedRunClosure(db: ReturnType<typeof setupTestDb>) {
      const now = "2026-06-20T00:00:00.000Z";
      db.insert(rubrics).values({
        id: "RUB-001", projectId: "PRJ-001", changeId: "CHG-001", phase: "review", role: "reviewer", createdAt: now,
      }).run();
      db.insert(rubricCriteria).values({
        id: "RC-001", rubricId: "RUB-001", criterionKey: "k", ordinal: 1, text: "t", createdAt: now,
      }).run();
      db.insert(reviewState).values({ changeId: "CHG-001", updatedAt: now }).run();

      for (const [index, runId] of ["RUN-003", "RUN-004"].entries()) {
        const n = index + 1;
        db.insert(buildRunRecords).values({
          id: `BRR-00${n}`, changeId: "CHG-001", runId, buildRunId: `build-${n}`, status: "ok", createdAt: now, updatedAt: now,
        }).run();
        db.insert(providerRunProcesses).values({
          id: `PRP-00${n}`, changeId: "CHG-001", runId, phase: "implement", provider: "codex", ppid: 1, status: "exited", startedAt: now,
        }).run();
        db.insert(releaseNoteState).values({
          id: `RNS-00${n}`, changeId: "CHG-001", runId, artifactId: "ART-003", approvedContentHash: "h", createdAt: now,
        }).run();
        db.insert(reviewAttempts).values({
          id: `RAT-00${n}`, changeId: "CHG-001", runId, attemptNo: n, status: "done",
          idempotencyKey: `idem-${n}`, startedAt: now, createdAt: now, updatedAt: now,
        }).run();
        db.insert(reviewReports).values({
          id: `RRP-00${n}`, attemptId: `RAT-00${n}`, changeId: "CHG-001", reportVersion: 1,
          reportDbHash: "h", gateStatus: "pass", generatedAt: now, createdAt: now,
        }).run();
        db.insert(reviewArtifactMirrors).values({
          id: `RAM-00${n}`, reportId: `RRP-00${n}`, changeId: "CHG-001", artifactId: "ART-003", kind: "report", createdAt: now,
        }).run();
        db.insert(qaRuns).values({
          id: `QAR-00${n}`, changeId: "CHG-001", sourceReviewReportId: `RRP-00${n}`, status: "passed", startedAt: now,
        }).run();
        db.insert(qaCommandResults).values({
          id: `QCR-00${n}`, qaRunId: `QAR-00${n}`, command: "pnpm test", commandOrder: 1, status: "passed",
        }).run();
        db.insert(qaEvidence).values({
          id: `QEV-00${n}`, qaRunId: `QAR-00${n}`, evidenceType: "log", createdAt: now,
        }).run();
        db.insert(qaFailures).values({
          id: `QAF-00${n}`, qaRunId: `QAR-00${n}`, severity: "P1", status: "open", createdAt: now,
        }).run();
        db.insert(changeProviderSessions).values({
          changeId: "CHG-001", provider: "codex", sessionKind: `kind-${n}`,
          externalSessionId: `ext-${n}`, lastRunId: runId, createdAt: now, updatedAt: now,
        }).run();
        db.insert(rubricAssessments).values({
          id: `RA-00${n}`, changeId: "CHG-001", runId, rubricId: "RUB-001",
          criterionId: "RC-001", verdict: "yes", createdAt: now,
        }).run();
      }
      // A review finding on RUN-003, re-reviewed by the RUN-004 attempt.
      db.insert(findings).values({
        id: "FND-REVIEW", changeId: "CHG-001", runId: "RUN-003", source: "review", severity: "P1",
        category: "correctness", title: "review finding", status: "open", createdAt: now,
      }).run();
      db.insert(reviewPriorFindingReviews).values({
        id: "RPF-001", attemptId: "RAT-002", priorFindingId: "FND-REVIEW", verdict: "keep", createdAt: now,
      }).run();
      db.update(reviewState).set({
        latestAttemptId: "RAT-002", latestReportId: "RRP-002", latestValidReviewReportId: "RRP-002",
      }).where(eq(reviewState.changeId, "CHG-001")).run();
    }

    const foreignKeyViolations = (db: ReturnType<typeof setupTestDb>) =>
      db.all(sql`PRAGMA foreign_key_check`) as unknown[];

    /**
     * The headline bug. The service deleted findings, artifacts, events and runs
     * -- four of the sixteen tables that reference a run -- so the transaction
     * hit SQLITE_CONSTRAINT_FOREIGNKEY and rolled back, and every /rework
     * returned 400.
     */
    it("deletes a run's whole closure without tripping a foreign key", async () => {
      const db = setupTestDb();
      seedChange(db, repoPath);
      seedRunClosure(db);

      await reworkChangeWithDb(db, "PRJ-001", "CHG-001", "Build");

      assert.deepEqual(foreignKeyViolations(db), []);
      assert.deepEqual(
        db.select().from(runs).where(eq(runs.changeId, "CHG-001")).all().map((run) => run.id),
        ["RUN-001", "RUN-002"],
      );
      assert.equal(db.select().from(reviewAttempts).all().length, 0);
      assert.equal(db.select().from(reviewReports).all().length, 0);
      assert.equal(db.select().from(providerRunProcesses).all().length, 0);
      assert.equal(db.select().from(buildRunRecords).all().length, 0);
      assert.equal(db.select().from(releaseNoteState).all().length, 0);
    });

    /**
     * rubric_assessments.run_id is NOT NULL and carries no foreign key, so
     * SQLite would never have objected to leaving these rows behind. Before the
     * closure was fixed they were invisible -- the transaction always rolled
     * back first -- which means fixing the foreign keys is exactly what would
     * have activated them.
     */
    it("leaves no rubric assessment pointing at a deleted run", async () => {
      const db = setupTestDb();
      seedChange(db, repoPath);
      seedRunClosure(db);

      await reworkChangeWithDb(db, "PRJ-001", "CHG-001", "Build");

      const survivingRunIds = new Set(db.select().from(runs).all().map((run) => run.id));
      const orphans = db.select().from(rubricAssessments).all()
        .filter((assessment) => !survivingRunIds.has(assessment.runId));
      assert.deepEqual(orphans, [], "a rubric assessment outlived the run it judged");
    });

    /**
     * review_state is one row per change and change_provider_sessions one row
     * per change+provider+kind: both outlive the runs they point at, so the
     * pointer is what has to go, not the row.
     */
    it("clears pointers into deleted runs instead of deleting the rows that hold them", async () => {
      const db = setupTestDb();
      seedChange(db, repoPath);
      seedRunClosure(db);

      await reworkChangeWithDb(db, "PRJ-001", "CHG-001", "Build");

      const state = db.select().from(reviewState).where(eq(reviewState.changeId, "CHG-001")).get();
      assert.ok(state, "review_state row was deleted; it belongs to the change, not the run");
      assert.equal(state.latestAttemptId, null);
      assert.equal(state.latestReportId, null);
      assert.equal(state.latestValidReviewReportId, null);

      const sessions = db.select().from(changeProviderSessions).all();
      assert.equal(sessions.length, 2, "provider session rows were deleted rather than unpointed");
      assert.deepEqual(sessions.map((session) => session.lastRunId), [null, null]);

      // A QA run keeps its evidence; merge-readiness reads the null source
      // report as "QA source Review report is stale".
      const qa = db.select().from(qaRuns).all();
      assert.equal(qa.length, 2);
      assert.deepEqual(qa.map((run) => run.sourceReviewReportId), [null, null]);
      assert.equal(db.select().from(qaEvidence).all().length, 2);
    });

    /**
     * pipeline-qa-stage-service deliberately skips `source === "review"` when it
     * clears a change's findings, because those rows are Review lineage rather
     * than local-check output. Rework did the same clear without the filter, so
     * it destroyed that lineage -- and, since
     * review_prior_finding_reviews.prior_finding_id is NOT NULL, raised
     * SQLITE_CONSTRAINT_FOREIGNKEY whenever a surviving attempt had re-reviewed
     * one of them. Reworking to Check deletes no review run at all, so nothing
     * else in the cascade covers this.
     */
    it("keeps review findings when clearing a change's findings for a Check rework", async () => {
      const db = setupTestDb();
      seedChange(db, repoPath, "CHECK_FAILED");
      seedRunClosure(db);

      await reworkChangeWithDb(db, "PRJ-001", "CHG-001", "Check");

      assert.deepEqual(foreignKeyViolations(db), []);
      const remaining = db.select().from(findings).where(eq(findings.changeId, "CHG-001")).all();
      assert.deepEqual(
        remaining.map((finding) => finding.id),
        ["FND-REVIEW"],
        "the lint finding should be cleared and the review finding kept",
      );
      assert.equal(
        db.select().from(reviewPriorFindingReviews).all().length,
        1,
        "the lineage row referencing the review finding should survive with it",
      );
    });
  });
});
