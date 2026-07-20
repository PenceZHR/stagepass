import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "../db/schema.ts";
import {
  recomputeReviewReport,
  setReviewReportServiceDbForTest,
} from "./review-report-service.ts";

const CHANGE_ID = "CHG-REPORT";
const PROJECT_ID = "PRJ-REPORT";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
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
      id TEXT PRIMARY KEY NOT NULL,
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
    CREATE TABLE review_attempts (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT NOT NULL,
      run_id TEXT,
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'codex',
      review_status TEXT NOT NULL DEFAULT 'running',
      idempotency_key TEXT NOT NULL,
      source_build_run_id TEXT,
      source_head_sha TEXT,
      input_source_db_hash TEXT,
      input_source_lineage_json TEXT,
      prior_blocking_finding_ids_json TEXT,
      raw_output_artifact_id TEXT,
      error_code TEXT,
      sanitized_error_summary TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE findings (
      id TEXT PRIMARY KEY NOT NULL,
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
    CREATE TABLE review_reports (
      id TEXT PRIMARY KEY NOT NULL,
      attempt_id TEXT NOT NULL,
      change_id TEXT NOT NULL,
      report_version INTEGER NOT NULL,
      review_conclusion TEXT,
      report_db_hash TEXT NOT NULL,
      gate_status TEXT NOT NULL,
      qa_allowed INTEGER NOT NULL DEFAULT 0,
      source_build_run_id TEXT,
      source_head_sha TEXT,
      finding_version INTEGER NOT NULL DEFAULT 1,
      waiver_version INTEGER NOT NULL DEFAULT 1,
      blocking_p0 INTEGER NOT NULL DEFAULT 0,
      blocking_p1 INTEGER NOT NULL DEFAULT 0,
      waived_p1 INTEGER NOT NULL DEFAULT 0,
      p2_count INTEGER NOT NULL DEFAULT 0,
      findings_db_hash TEXT,
      stale_reason TEXT,
      legacy_state TEXT,
      report_json TEXT,
      generated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE review_state (
      change_id TEXT PRIMARY KEY NOT NULL,
      latest_attempt_id TEXT,
      latest_attempt_no INTEGER,
      latest_report_id TEXT,
      latest_valid_review_report_id TEXT,
      latest_valid_attempt_no INTEGER,
      gate_status TEXT,
      review_status TEXT,
      source_build_run_id TEXT,
      source_head_sha TEXT,
      report_db_hash TEXT,
      finding_version INTEGER NOT NULL DEFAULT 1,
      waiver_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE review_prior_finding_reviews (
      id TEXT PRIMARY KEY NOT NULL,
      attempt_id TEXT NOT NULL,
      prior_finding_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      evidence TEXT,
      required_fix TEXT,
      replacement_finding_id TEXT,
      reviewer_notes TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return drizzle(sqlite, { schema });
}

function seedChange(db: ReturnType<typeof createTestDb>) {
  const now = new Date().toISOString();
  db.insert(schema.projects).values({
    id: PROJECT_ID,
    name: "Review Report",
    repoPath: "/tmp/review-report",
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(schema.changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Review report",
    status: "IMPLEMENTED",
    provider: "codex",
    createdAt: now,
    updatedAt: now,
  }).run();
}

function seedBuild(
  db: ReturnType<typeof createTestDb>,
  {
    id,
    buildRunId = id,
    headSha = "head-a",
    adoptedAt,
  }: { id: string; buildRunId?: string; headSha?: string; adoptedAt: string },
) {
  const now = new Date().toISOString();
  db.insert(schema.buildRunRecords).values({
    id,
    changeId: CHANGE_ID,
    runId: null,
    buildRunId,
    status: "adopted",
    headSha,
    adoptedAt,
    artifactHash: null,
    source: "test",
    createdAt: now,
    updatedAt: now,
  }).run();
}

function seedAttempt(
  db: ReturnType<typeof createTestDb>,
  {
    id,
    attemptNo,
    status = "completed",
    reviewStatus = "passed",
    sourceBuildRunId = "build-1",
    sourceHeadSha = "head-a",
    priorBlockingFindingIdsJson = null,
  }: {
    id: string;
    attemptNo: number;
    status?: "running" | "completed" | "failed";
    reviewStatus?:
      | "running"
      | "passed"
      | "issues_found"
      | "failed"
      | "invalid_output"
      | "data_inconsistent";
    sourceBuildRunId?: string | null;
    sourceHeadSha?: string | null;
    priorBlockingFindingIdsJson?: string | null;
  },
) {
  const now = new Date().toISOString();
  db.insert(schema.reviewAttempts).values({
    id,
    changeId: CHANGE_ID,
    runId: `RUN-${attemptNo}`,
    attemptNo,
    status,
    reviewStatus,
    provider: "codex",
    idempotencyKey: id,
    sourceBuildRunId,
    sourceHeadSha,
    priorBlockingFindingIdsJson,
    startedAt: now,
    endedAt: status === "running" ? null : now,
    completedAt: reviewStatus === "passed" || reviewStatus === "issues_found" ? now : null,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function seedFinding(
  db: ReturnType<typeof createTestDb>,
  {
    id,
    attemptId,
    severity,
    status = "open",
    waivable = severity === "P1",
    evidence = "evidence",
    requiredFix = severity === "P2" ? null : "fix it",
    findingVersion = 1,
  }: {
    id: string;
    attemptId: string;
    severity: "P0" | "P1" | "P2";
    status?: "open" | "fixed" | "waived";
    waivable?: boolean;
    evidence?: string | null;
    requiredFix?: string | null;
    findingVersion?: number;
  },
) {
  const now = new Date().toISOString();
  db.insert(schema.findings).values({
    id,
    changeId: CHANGE_ID,
    runId: `RUN-${attemptId.replace("RAT-", "")}`,
    source: "review",
    severity,
    category: "logic",
    title: `${severity} finding`,
    file: "src/app.ts",
    line: null,
    evidence,
    requiredFix,
    status,
    createdAt: now,
    updatedAt: now,
    reviewAttemptId: attemptId,
    sourceBuildRunId: "build-1",
    sourceHeadSha: "head-a",
    waivable: waivable ? 1 : 0,
    waivedBy: status === "waived" ? "human" : null,
    waivedAt: status === "waived" ? now : null,
    findingVersion,
  }).run();
}

function seedPriorFindingReview(
  db: ReturnType<typeof createTestDb>,
  {
    id,
    attemptId,
    priorFindingId,
    verdict = "still_open",
    evidence = "prior evidence",
    requiredFix = "prior fix",
    reviewerNotes = null,
  }: {
    id: string;
    attemptId: string;
    priorFindingId: string;
    verdict?: string;
    evidence?: string | null;
    requiredFix?: string | null;
    reviewerNotes?: string | null;
  },
) {
  db.insert(schema.reviewPriorFindingReviews).values({
    id,
    attemptId,
    priorFindingId,
    verdict,
    evidence,
    requiredFix,
    replacementFindingId: null,
    reviewerNotes,
    createdAt: new Date().toISOString(),
  }).run();
}

describe("review-report-service", { concurrency: false }, () => {
  let db: ReturnType<typeof createTestDb>;
  let restoreDb: (() => void) | null = null;

  beforeEach(() => {
    db = createTestDb();
    restoreDb = setReviewReportServiceDbForTest(db);
    seedChange(db);
    seedBuild(db, { id: "BR-1", buildRunId: "build-1", adoptedAt: "2026-06-29T01:00:00.000Z" });
  });

  afterEach(() => {
    restoreDb?.();
    restoreDb = null;
  });

  it("tracks latestAttempt by highest attemptNo while keeping latestValidReview from review_state", () => {
    seedAttempt(db, { id: "RAT-1", attemptNo: 1, reviewStatus: "passed" });
    const first = recomputeReviewReport(CHANGE_ID, "RAT-1");
    seedAttempt(db, { id: "RAT-2", attemptNo: 2, status: "failed", reviewStatus: "invalid_output" });

    const second = recomputeReviewReport(CHANGE_ID, "RAT-2");
    const state = db.select().from(schema.reviewState).where(eq(schema.reviewState.changeId, CHANGE_ID)).get();

    assert.equal(second.report.reviewConclusion, "invalid_output");
    assert.equal(second.report.gateStatus, "invalid_output");
    assert.equal(state?.latestAttemptId, "RAT-2");
    assert.equal(state?.latestAttemptNo, 2);
    assert.equal(state?.latestValidReviewReportId, first.report.id);
    assert.equal(state?.latestValidAttemptNo, 1);
  });

  it("does not let an old attempt recompute replace a newer latest valid review", () => {
    seedAttempt(db, { id: "RAT-1", attemptNo: 1, reviewStatus: "passed" });
    const oldReport = recomputeReviewReport(CHANGE_ID, "RAT-1").report;
    seedAttempt(db, { id: "RAT-2", attemptNo: 2, reviewStatus: "passed" });
    const newReport = recomputeReviewReport(CHANGE_ID, "RAT-2").report;

    const oldAgain = recomputeReviewReport(CHANGE_ID, "RAT-1").report;
    const state = db.select().from(schema.reviewState).where(eq(schema.reviewState.changeId, CHANGE_ID)).get();

    assert.equal(oldAgain.id, oldReport.id);
    assert.equal(state?.latestValidReviewReportId, newReport.id);
    assert.equal(state?.latestValidAttemptNo, 2);
    assert.equal(state?.latestAttemptId, "RAT-2");
  });

  for (const reviewStatus of ["failed", "invalid_output", "data_inconsistent"] as const) {
    it(`does not replace the latest valid review with ${reviewStatus}`, () => {
      seedAttempt(db, { id: "RAT-1", attemptNo: 1, reviewStatus: "passed" });
      const validReport = recomputeReviewReport(CHANGE_ID, "RAT-1").report;
      seedAttempt(db, {
        id: "RAT-2",
        attemptNo: 2,
        status: "failed",
        reviewStatus,
      });

      const latestReport = recomputeReviewReport(CHANGE_ID, "RAT-2").report;
      const state = db.select().from(schema.reviewState).where(eq(schema.reviewState.changeId, CHANGE_ID)).get();

      assert.equal(latestReport.reviewConclusion, reviewStatus);
      assert.equal(state?.latestValidReviewReportId, validReport.id);
    });
  }

  it("does not replace the latest valid review with running or legacy_incomplete reports", () => {
    seedAttempt(db, { id: "RAT-1", attemptNo: 1, reviewStatus: "passed" });
    const validReport = recomputeReviewReport(CHANGE_ID, "RAT-1").report;
    seedAttempt(db, { id: "RAT-2", attemptNo: 2, status: "running", reviewStatus: "running" });
    const runningReport = recomputeReviewReport(CHANGE_ID, "RAT-2").report;
    seedAttempt(db, { id: "RAT-3", attemptNo: 3, reviewStatus: "issues_found" });
    seedFinding(db, {
      id: "FND-LEGACY",
      attemptId: "RAT-3",
      severity: "P1",
      requiredFix: null,
    });
    const legacyReport = recomputeReviewReport(CHANGE_ID, "RAT-3").report;
    const state = db.select().from(schema.reviewState).where(eq(schema.reviewState.changeId, CHANGE_ID)).get();

    assert.equal(runningReport.gateStatus, "running");
    assert.equal(legacyReport.reviewConclusion, "legacy_incomplete");
    assert.equal(state?.latestValidReviewReportId, validReport.id);
  });

  it("blocks on open P0/P1 and allows QA when all P1 blockers are waived", () => {
    seedAttempt(db, { id: "RAT-1", attemptNo: 1, reviewStatus: "issues_found" });
    seedFinding(db, { id: "FND-P0", attemptId: "RAT-1", severity: "P0" });
    seedFinding(db, { id: "FND-P1", attemptId: "RAT-1", severity: "P1" });

    const blocked = recomputeReviewReport(CHANGE_ID, "RAT-1").report;
    assert.equal(blocked.gateStatus, "blocked_p0");
    assert.equal(blocked.qaAllowed, 0);
    assert.equal(blocked.blockingP0, 1);
    assert.equal(blocked.blockingP1, 1);

    db.update(schema.findings)
      .set({ status: "fixed", findingVersion: 2 })
      .where(eq(schema.findings.id, "FND-P0"))
      .run();
    db.update(schema.findings)
      .set({ status: "waived", waivedBy: "human", waivedAt: new Date().toISOString(), findingVersion: 2 })
      .where(eq(schema.findings.id, "FND-P1"))
      .run();

    const waived = recomputeReviewReport(CHANGE_ID, "RAT-1").report;
    assert.equal(waived.gateStatus, "passed_with_waived_p1");
    assert.equal(waived.qaAllowed, 1);
    assert.equal(waived.waivedP1, 1);
  });

  it("counts P2 as non-blocking and ignores missing mirrors for report and gate status", () => {
    seedAttempt(db, { id: "RAT-1", attemptNo: 1, reviewStatus: "issues_found" });
    seedFinding(db, { id: "FND-P2", attemptId: "RAT-1", severity: "P2" });

    const result = recomputeReviewReport(CHANGE_ID, "RAT-1");

    assert.equal(result.report.reviewConclusion, "issues_found");
    assert.equal(result.report.gateStatus, "passed");
    assert.equal(result.report.qaAllowed, 1);
    assert.equal(result.report.p2Count, 1);
    assert.equal(result.report.staleReason, null);
  });

  it("settles a clean new attempt without counting old P2 or old legacy incomplete findings", () => {
    seedAttempt(db, { id: "RAT-1", attemptNo: 1, reviewStatus: "issues_found" });
    seedFinding(db, { id: "FND-OLD-P2", attemptId: "RAT-1", severity: "P2" });
    seedFinding(db, {
      id: "FND-OLD-LEGACY-P2",
      attemptId: "RAT-1",
      severity: "P2",
      evidence: null,
    });
    const old = recomputeReviewReport(CHANGE_ID, "RAT-1").report;
    assert.equal(old.reviewConclusion, "legacy_incomplete");

    seedAttempt(db, { id: "RAT-2", attemptNo: 2, reviewStatus: "passed" });
    const result = recomputeReviewReport(CHANGE_ID, "RAT-2");

    assert.equal(result.report.reviewConclusion, "passed");
    assert.equal(result.report.gateStatus, "passed");
    assert.equal(result.report.p2Count, 0);
    assert.equal(result.report.legacyState, null);
  });

  it("settles prior open P0/P1 blockers only when frozen into the new attempt snapshot", () => {
    seedAttempt(db, { id: "RAT-1", attemptNo: 1, reviewStatus: "issues_found" });
    seedFinding(db, {
      id: "FND-OLD-P1",
      attemptId: "RAT-1",
      severity: "P1",
      findingVersion: 3,
    });

    seedAttempt(db, {
      id: "RAT-2",
      attemptNo: 2,
      reviewStatus: "passed",
      priorBlockingFindingIdsJson: JSON.stringify([]),
    });
    const clean = recomputeReviewReport(CHANGE_ID, "RAT-2").report;
    assert.equal(clean.gateStatus, "passed");
    assert.equal(clean.blockingP1, 0);
    assert.equal(clean.findingVersion, 1);

    seedAttempt(db, {
      id: "RAT-3",
      attemptNo: 3,
      reviewStatus: "passed",
      priorBlockingFindingIdsJson: JSON.stringify(["FND-OLD-P1"]),
    });
    const blocked = recomputeReviewReport(CHANGE_ID, "RAT-3").report;
    assert.equal(blocked.gateStatus, "blocked_p1");
    assert.equal(blocked.blockingP1, 1);
    assert.equal(blocked.findingVersion, 3);
  });

  it("keeps not_rechecked prior blockers open and blocks the report", () => {
    seedAttempt(db, { id: "RAT-1", attemptNo: 1, reviewStatus: "issues_found" });
    seedFinding(db, {
      id: "FND-OLD-P1",
      attemptId: "RAT-1",
      severity: "P1",
      findingVersion: 4,
    });
    seedAttempt(db, {
      id: "RAT-2",
      attemptNo: 2,
      reviewStatus: "issues_found",
      priorBlockingFindingIdsJson: JSON.stringify(["FND-OLD-P1"]),
    });
    seedPriorFindingReview(db, {
      id: "RPF-NOT-RECHECKED",
      attemptId: "RAT-2",
      priorFindingId: "FND-OLD-P1",
      verdict: "not_rechecked",
      evidence: null,
      requiredFix: null,
      reviewerNotes: "The reviewer omitted an explicit recheck, so the old blocker remains authoritative.",
    });

    const result = recomputeReviewReport(CHANGE_ID, "RAT-2");

    assert.equal(result.report.gateStatus, "blocked_p1");
    assert.equal(result.report.qaAllowed, 0);
    assert.equal(result.report.blockingP1, 1);
    assert.equal(db.select().from(schema.findings).where(eq(schema.findings.id, "FND-OLD-P1")).get()?.status, "open");
  });

  it("includes prior finding reviews in the DB deterministic report hash", () => {
    seedAttempt(db, { id: "RAT-1", attemptNo: 1, reviewStatus: "issues_found" });
    seedFinding(db, {
      id: "FND-OLD-P1",
      attemptId: "RAT-1",
      severity: "P1",
      findingVersion: 2,
    });
    seedAttempt(db, {
      id: "RAT-2",
      attemptNo: 2,
      reviewStatus: "passed",
      priorBlockingFindingIdsJson: JSON.stringify(["FND-OLD-P1"]),
    });
    seedPriorFindingReview(db, {
      id: "RPF-1",
      attemptId: "RAT-2",
      priorFindingId: "FND-OLD-P1",
      reviewerNotes: "first DB review note",
    });

    const first = recomputeReviewReport(CHANGE_ID, "RAT-2").report;
    db.update(schema.reviewPriorFindingReviews)
      .set({ reviewerNotes: "updated DB review note" })
      .where(eq(schema.reviewPriorFindingReviews.id, "RPF-1"))
      .run();
    const second = recomputeReviewReport(CHANGE_ID, "RAT-2").report;

    assert.notEqual(second.reportDbHash, first.reportDbHash);
    const reportFacts = JSON.parse(second.reportJson ?? "{}") as {
      priorFindingReviews?: Array<{ reviewerNotes: string | null }>;
    };
    assert.deepEqual(reportFacts.priorFindingReviews?.map((row) => row.reviewerNotes), [
      "updated DB review note",
    ]);
  });

  it("marks reports stale for source build changes, head drift, and version drift", () => {
    seedAttempt(db, { id: "RAT-1", attemptNo: 1, reviewStatus: "passed", sourceBuildRunId: "build-0", sourceHeadSha: "old-head" });
    seedBuild(db, { id: "BR-2", buildRunId: "build-2", headSha: "head-b", adoptedAt: "2026-06-29T02:00:00.000Z" });
    db.insert(schema.reviewState).values({
      changeId: CHANGE_ID,
      latestAttemptId: "RAT-1",
      latestAttemptNo: 1,
      findingVersion: 2,
      waiverVersion: 2,
      updatedAt: new Date().toISOString(),
    }).onConflictDoNothing().run();

    const result = recomputeReviewReport(CHANGE_ID, "RAT-1");
    const staleReasons = JSON.parse(result.report.staleReason ?? "[]") as string[];

    assert.equal(result.report.gateStatus, "stale");
    assert.equal(result.report.qaAllowed, 0);
    assert.ok(staleReasons.includes("source_build_changed"));
    assert.ok(staleReasons.includes("head_drift"));
    assert.ok(staleReasons.includes("finding_version_drift"));
    assert.ok(staleReasons.includes("waiver_version_drift"));
  });
});
