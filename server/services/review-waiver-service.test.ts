import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "../db/schema.ts";
import {
  assertCanEnterQa,
  ReviewQaGateError,
  setReviewQaGateDbForTest,
  setReviewQaGateHeadProbeForTest,
} from "./review-qa-gate-service.ts";
import {
  recomputeReviewReport,
  setReviewReportServiceDbForTest,
} from "./review-report-service.ts";
import {
  ReviewWaiverError,
  setReviewWaiverServiceDbForTest,
  waiveReviewFinding,
} from "./review-waiver-service.ts";

const PROJECT_ID = "PRJ-WAIVER";
const CHANGE_ID = "CHG-WAIVER";
const HEAD_A = "a".repeat(40);

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
    CREATE TABLE human_decisions (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT NOT NULL,
      round_id TEXT,
      gate TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      reason TEXT,
      report_hash TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT,
      run_id TEXT,
      type TEXT NOT NULL,
      message TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL
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

function nowISO(): string {
  return new Date().toISOString();
}

function seedChange(db: ReturnType<typeof createTestDb>) {
  const now = nowISO();
  db.insert(schema.projects).values({
    id: PROJECT_ID,
    name: "Review waiver",
    repoPath: "/tmp/review-waiver",
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(schema.changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Review waiver",
    status: "IMPLEMENTED",
    provider: "codex",
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(schema.buildRunRecords).values({
    id: "BR-1",
    changeId: CHANGE_ID,
    runId: null,
    buildRunId: "build-1",
    status: "adopted",
    headSha: HEAD_A,
    adoptedAt: "2026-06-29T01:00:00.000Z",
    artifactHash: null,
    source: "test",
    createdAt: now,
    updatedAt: now,
  }).run();
}

function seedAttemptAndReport(db: ReturnType<typeof createTestDb>) {
  const now = nowISO();
  db.insert(schema.reviewAttempts).values({
    id: "RAT-1",
    changeId: CHANGE_ID,
    runId: "RUN-1",
    attemptNo: 1,
    status: "completed",
    provider: "codex",
    reviewStatus: "issues_found",
    idempotencyKey: "RAT-1",
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD_A,
    priorBlockingFindingIdsJson: null,
    startedAt: now,
    endedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(schema.reviewReports).values({
    id: "RRP-1",
    attemptId: "RAT-1",
    changeId: CHANGE_ID,
    reportVersion: 1,
    reviewConclusion: "issues_found",
    reportDbHash: "hash-RRP-1",
    gateStatus: "blocked_p1",
    qaAllowed: 0,
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD_A,
    findingVersion: 1,
    waiverVersion: 1,
    blockingP0: 0,
    blockingP1: 1,
    waivedP1: 0,
    p2Count: 0,
    findingsDbHash: "findings-RRP-1",
    staleReason: null,
    legacyState: null,
    reportJson: null,
    generatedAt: now,
    createdAt: now,
  }).run();
  db.insert(schema.reviewState).values({
    changeId: CHANGE_ID,
    latestAttemptId: "RAT-1",
    latestAttemptNo: 1,
    latestReportId: "RRP-1",
    latestValidReviewReportId: "RRP-1",
    latestValidAttemptNo: 1,
    gateStatus: "blocked_p1",
    reviewStatus: "issues_found",
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD_A,
    reportDbHash: "hash-RRP-1",
    findingVersion: 1,
    waiverVersion: 1,
    updatedAt: now,
  }).run();
}

function seedReviewFinding(
  db: ReturnType<typeof createTestDb>,
  { id, severity }: { id: string; severity: "P0" | "P1" },
) {
  const now = nowISO();
  db.insert(schema.findings).values({
    id,
    changeId: CHANGE_ID,
    runId: "RUN-1",
    source: "review",
    severity,
    category: "logic",
    title: `${severity} finding`,
    file: "src/app.ts",
    line: null,
    evidence: "evidence",
    requiredFix: "fix it",
    status: "open",
    createdAt: now,
    updatedAt: now,
    reviewAttemptId: "RAT-1",
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD_A,
    waivable: severity === "P1" ? 1 : 0,
    findingVersion: 1,
  }).run();
}

function assertWaiverError(status: 403 | 422) {
  return (err: unknown) => {
    assert.ok(err instanceof ReviewWaiverError);
    assert.equal(err.status, status);
    return true;
  };
}

describe("review-waiver-service", { concurrency: false }, () => {
  let db: ReturnType<typeof createTestDb>;
  let restoreWaiverDb: (() => void) | null = null;
  let restoreReportDb: (() => void) | null = null;
  let restoreQaDb: (() => void) | null = null;
  let restoreHeadProbe: (() => void) | null = null;

  beforeEach(() => {
    db = createTestDb();
    seedChange(db);
    seedAttemptAndReport(db);
    restoreWaiverDb = setReviewWaiverServiceDbForTest(db);
    restoreReportDb = setReviewReportServiceDbForTest(db);
    restoreQaDb = setReviewQaGateDbForTest(db);
    restoreHeadProbe = setReviewQaGateHeadProbeForTest(() => HEAD_A);
  });

  afterEach(() => {
    restoreHeadProbe?.();
    restoreHeadProbe = null;
    restoreQaDb?.();
    restoreQaDb = null;
    restoreReportDb?.();
    restoreReportDb = null;
    restoreWaiverDb?.();
    restoreWaiverDb = null;
  });

  it("rejects P0 review waivers without updating the finding", () => {
    seedReviewFinding(db, { id: "FND-P0", severity: "P0" });

    assert.throws(
      () =>
        waiveReviewFinding({
          changeId: CHANGE_ID,
          findingId: "FND-P0",
          reason: "accept",
          actor: "blue",
        }),
      assertWaiverError(403),
    );

    const finding = db.select().from(schema.findings).where(eq(schema.findings.id, "FND-P0")).get();
    assert.equal(finding?.status, "open");
    assert.equal(db.select().from(schema.humanDecisions).all().length, 0);
  });

  it("requires a non-empty reason for P1 review waivers", () => {
    seedReviewFinding(db, { id: "FND-P1", severity: "P1" });

    assert.throws(
      () => waiveReviewFinding({ changeId: CHANGE_ID, findingId: "FND-P1", reason: "   " }),
      assertWaiverError(422),
    );

    const finding = db.select().from(schema.findings).where(eq(schema.findings.id, "FND-P1")).get();
    const report = db.select().from(schema.reviewReports).where(eq(schema.reviewReports.id, "RRP-1")).get();
    assert.equal(finding?.status, "open");
    assert.equal(report?.gateStatus, "blocked_p1");
    assert.equal(report?.qaAllowed, 0);
    assert.equal(db.select().from(schema.humanDecisions).all().length, 0);
  });

  it("waives P1 review findings transactionally and blocks QA until recompute", () => {
    seedReviewFinding(db, { id: "FND-P1", severity: "P1" });

    const result = waiveReviewFinding({
      changeId: CHANGE_ID,
      findingId: "FND-P1",
      reason: "Accepted until the migration finishes.",
      actor: "blue",
    });

    assert.equal(result.findingId, "FND-P1");
    assert.equal(result.status, "waived");
    assert.equal(result.waiverVersion, 2);
    assert.equal(result.reportStale, true);

    const decision = db.select().from(schema.humanDecisions).where(eq(schema.humanDecisions.id, result.decisionId)).get();
    assert.equal(decision?.action, "review_p1_waiver");
    assert.equal(decision?.targetType, "finding");
    assert.equal(decision?.targetId, "FND-P1");
    assert.equal(decision?.reason, "Accepted until the migration finishes.");
    assert.equal(decision?.createdBy, "blue");

    const finding = db.select().from(schema.findings).where(eq(schema.findings.id, "FND-P1")).get();
    assert.equal(finding?.status, "waived");
    assert.equal(finding?.waivedBy, "blue");
    assert.equal(finding?.waiverDecisionId, result.decisionId);
    assert.equal(finding?.findingVersion, 2);

    const state = db.select().from(schema.reviewState).where(eq(schema.reviewState.changeId, CHANGE_ID)).get();
    const staleReport = db.select().from(schema.reviewReports).where(eq(schema.reviewReports.id, "RRP-1")).get();
    assert.equal(state?.waiverVersion, 2);
    assert.equal(state?.gateStatus, "stale");
    assert.equal(staleReport?.gateStatus, "stale");
    assert.equal(staleReport?.qaAllowed, 0);
    assert.match(staleReport?.staleReason ?? "", /p1_waiver_changed_findings/);

    const event = db.select().from(schema.events).where(eq(schema.events.type, "finding_waived")).get();
    const raw = JSON.parse(event?.rawJson ?? "{}") as Record<string, unknown>;
    assert.equal(raw.reason, "Accepted until the migration finishes.");
    assert.equal(raw.decisionId, result.decisionId);
    assert.equal(raw.reviewAttemptId, "RAT-1");
    assert.equal(raw.sourceBuildRunId, "build-1");

    assert.throws(() => assertCanEnterQa({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      entrypoint: "api_check_route",
      actor: "human",
    }), (err) => {
      assert.ok(err instanceof ReviewQaGateError);
      assert.equal(err.code, "review_not_allowed");
      return true;
    });

    const recomputed = recomputeReviewReport(CHANGE_ID, "RAT-1");
    assert.equal(recomputed.report.gateStatus, "passed_with_waived_p1");
    assert.equal(recomputed.report.qaAllowed, 1);
    assert.equal(recomputed.report.waivedP1, 1);

    const qa = assertCanEnterQa({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      entrypoint: "api_check_route",
      actor: "human",
    });
    assert.equal(qa.allowed, true);
    assert.deepEqual(qa.waivedP1.reasons, [
      { findingId: "FND-P1", reason: "Accepted until the migration finishes." },
    ]);
  });

  it("keeps waiverVersion aligned with waived finding versions for multiple P1 waivers", () => {
    seedReviewFinding(db, { id: "FND-P1-A", severity: "P1" });
    seedReviewFinding(db, { id: "FND-P1-B", severity: "P1" });

    const first = waiveReviewFinding({
      changeId: CHANGE_ID,
      findingId: "FND-P1-A",
      reason: "Accepted first risk.",
      actor: "blue",
    });
    const second = waiveReviewFinding({
      changeId: CHANGE_ID,
      findingId: "FND-P1-B",
      reason: "Accepted second risk.",
      actor: "blue",
    });

    assert.equal(first.waiverVersion, 2);
    assert.equal(second.waiverVersion, 2);

    const staleState = db.select().from(schema.reviewState).where(eq(schema.reviewState.changeId, CHANGE_ID)).get();
    assert.equal(staleState?.waiverVersion, 2);

    const recomputed = recomputeReviewReport(CHANGE_ID, "RAT-1");
    assert.equal(recomputed.report.gateStatus, "passed_with_waived_p1");
    assert.equal(recomputed.report.qaAllowed, 1);
    assert.equal(recomputed.report.waiverVersion, 2);
    assert.equal(recomputed.report.waivedP1, 2);

    const qa = assertCanEnterQa({
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      entrypoint: "api_check_route",
      actor: "human",
    });
    assert.equal(qa.allowed, true);
    assert.equal(qa.counts.waivedP1, 2);
    assert.equal(qa.waivedP1.count, 2);
  });

  it("does not mark unrelated historical reports stale when a P1 is waived", () => {
    const now = nowISO();
    db.insert(schema.reviewAttempts).values({
      id: "RAT-HIST",
      changeId: CHANGE_ID,
      runId: "RUN-HIST",
      attemptNo: 0,
      status: "completed",
      provider: "codex",
      reviewStatus: "passed",
      idempotencyKey: "RAT-HIST",
      sourceBuildRunId: "build-1",
      sourceHeadSha: HEAD_A,
      priorBlockingFindingIdsJson: null,
      startedAt: now,
      endedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(schema.reviewReports).values({
      id: "RRP-HIST",
      attemptId: "RAT-HIST",
      changeId: CHANGE_ID,
      reportVersion: 1,
      reviewConclusion: "passed",
      reportDbHash: "hash-RRP-HIST",
      gateStatus: "passed",
      qaAllowed: 1,
      sourceBuildRunId: "build-1",
      sourceHeadSha: HEAD_A,
      findingVersion: 1,
      waiverVersion: 1,
      blockingP0: 0,
      blockingP1: 0,
      waivedP1: 0,
      p2Count: 0,
      findingsDbHash: "findings-RRP-HIST",
      staleReason: null,
      legacyState: null,
      reportJson: null,
      generatedAt: now,
      createdAt: now,
    }).run();
    seedReviewFinding(db, { id: "FND-P1", severity: "P1" });

    waiveReviewFinding({
      changeId: CHANGE_ID,
      findingId: "FND-P1",
      reason: "Accepted latest risk.",
      actor: "blue",
    });

    const historical = db.select().from(schema.reviewReports).where(eq(schema.reviewReports.id, "RRP-HIST")).get();
    const latest = db.select().from(schema.reviewReports).where(eq(schema.reviewReports.id, "RRP-1")).get();
    assert.equal(historical?.gateStatus, "passed");
    assert.equal(historical?.qaAllowed, 1);
    assert.equal(historical?.staleReason, null);
    assert.equal(latest?.gateStatus, "stale");
  });

  it("rolls back all waiver writes when report stale marking fails", () => {
    seedReviewFinding(db, { id: "FND-P1", severity: "P1" });
    db.run(`
      CREATE TRIGGER fail_review_report_stale
      BEFORE UPDATE ON review_reports
      WHEN NEW.gate_status = 'stale'
      BEGIN
        SELECT RAISE(ABORT, 'report stale write failed');
      END
    `);

    assert.throws(
      () =>
        waiveReviewFinding({
          changeId: CHANGE_ID,
          findingId: "FND-P1",
          reason: "Accepted risk.",
        }),
      /report stale write failed/,
    );

    const finding = db.select().from(schema.findings).where(eq(schema.findings.id, "FND-P1")).get();
    const report = db.select().from(schema.reviewReports).where(eq(schema.reviewReports.id, "RRP-1")).get();
    const state = db.select().from(schema.reviewState).where(eq(schema.reviewState.changeId, CHANGE_ID)).get();
    assert.equal(finding?.status, "open");
    assert.equal(finding?.waiverDecisionId, null);
    assert.equal(report?.gateStatus, "blocked_p1");
    assert.equal(state?.waiverVersion, 1);
    assert.equal(db.select().from(schema.humanDecisions).all().length, 0);
    assert.equal(db.select().from(schema.events).all().length, 0);
  });
});
