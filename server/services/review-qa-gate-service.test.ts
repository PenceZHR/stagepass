import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import * as schema from "../db/schema.ts";
import {
  assertCanEnterQa,
  ReviewQaGateError,
  setReviewQaGateDbForTest,
  setReviewQaGateHeadProbeForTest,
} from "./review-qa-gate-service.ts";

const PROJECT_ID = "PRJ-QA-GATE";
const CHANGE_ID = "CHG-QA-GATE";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

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
    CREATE TABLE review_artifact_mirrors (
      id TEXT PRIMARY KEY NOT NULL,
      report_id TEXT NOT NULL,
      change_id TEXT NOT NULL,
      artifact_id TEXT,
      kind TEXT NOT NULL,
      path TEXT,
      schema_version TEXT,
      source_db_hash TEXT,
      content_hash TEXT,
      mirror_status TEXT,
      last_checked_at TEXT,
      last_rebuilt_at TEXT,
      error_code TEXT,
      artifact_path TEXT,
      artifact_hash TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return drizzle(sqlite, { schema });
}

function nowISO(): string {
  return new Date().toISOString();
}

function seedProjectAndChange(db: ReturnType<typeof createTestDb>, repoPath: string) {
  const now = nowISO();
  db.insert(schema.projects).values({
    id: PROJECT_ID,
    name: "QA gate",
    repoPath,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(schema.changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "QA gate change",
    status: "IMPLEMENTED",
    provider: "codex",
    createdAt: now,
    updatedAt: now,
  }).run();
}

function seedBuild(
  db: ReturnType<typeof createTestDb>,
  { id = "BR-1", buildRunId = "build-1", headSha = HEAD_A, adoptedAt = "2026-06-29T01:00:00.000Z" } = {},
) {
  const now = nowISO();
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
    id = "RAT-1",
    attemptNo = 1,
    status = "completed",
    reviewStatus = "passed",
    sourceBuildRunId = "build-1",
    sourceHeadSha = HEAD_A,
    priorBlockingFindingIdsJson = null,
  }: Partial<typeof schema.reviewAttempts.$inferInsert> & { attemptNo?: number } = {},
) {
  const now = nowISO();
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
    completedAt: status === "running" ? null : now,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function seedReportAndState(
  db: ReturnType<typeof createTestDb>,
  {
    id = "RRP-1",
    attemptId = "RAT-1",
    gateStatus = "passed",
    qaAllowed = 1,
    sourceBuildRunId = "build-1",
    sourceHeadSha = HEAD_A,
    blockingP0 = 0,
    blockingP1 = 0,
    waivedP1 = 0,
    p2Count = 0,
    findingVersion = 1,
    waiverVersion = 1,
    legacyState = null,
    latestAttemptNo = 1,
  }: Partial<typeof schema.reviewReports.$inferInsert> & { latestAttemptNo?: number } = {},
) {
  const now = nowISO();
  db.insert(schema.reviewReports).values({
    id,
    attemptId,
    changeId: CHANGE_ID,
    reportVersion: 1,
    reviewConclusion: gateStatus === "passed" ? "passed" : "issues_found",
    reportDbHash: `hash-${id}`,
    gateStatus,
    qaAllowed,
    sourceBuildRunId,
    sourceHeadSha,
    findingVersion,
    waiverVersion,
    blockingP0,
    blockingP1,
    waivedP1,
    p2Count,
    findingsDbHash: `findings-${id}`,
    staleReason: null,
    legacyState,
    reportJson: null,
    generatedAt: now,
    createdAt: now,
  }).run();
  db.insert(schema.reviewState).values({
    changeId: CHANGE_ID,
    latestAttemptId: attemptId,
    latestAttemptNo,
    latestReportId: id,
    latestValidReviewReportId: id,
    latestValidAttemptNo: latestAttemptNo,
    gateStatus,
    reviewStatus: gateStatus === "passed" ? "passed" : "issues_found",
    sourceBuildRunId,
    sourceHeadSha,
    reportDbHash: `hash-${id}`,
    findingVersion,
    waiverVersion,
    updatedAt: now,
  }).run();
}

function seedAllowedReview(db: ReturnType<typeof createTestDb>) {
  seedBuild(db);
  seedAttempt(db);
  seedReportAndState(db);
}

function seedReviewFinding(
  db: ReturnType<typeof createTestDb>,
  {
    id,
    severity,
    attemptId = "RAT-1",
    status = "open",
    evidence = "review evidence",
    requiredFix = severity === "P2" ? null : "fix it",
    waivable = severity === "P1",
    waiverDecisionId = null,
    legacyState = null,
    findingVersion = 1,
  }: {
    id: string;
    severity: "P0" | "P1" | "P2";
    attemptId?: string;
    status?: "open" | "fixed" | "waived";
    evidence?: string | null;
    requiredFix?: string | null;
    waivable?: boolean;
    waiverDecisionId?: string | null;
    legacyState?: string | null;
    findingVersion?: number;
  },
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
    evidence,
    requiredFix,
    status,
    createdAt: now,
    updatedAt: now,
    reviewAttemptId: attemptId,
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD_A,
    waivable: waivable ? 1 : 0,
    waivedBy: status === "waived" ? "human" : null,
    waivedAt: status === "waived" ? now : null,
    waiverDecisionId,
    legacyState,
    findingVersion,
  }).run();
}

function gateInput() {
  return {
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    entrypoint: "api_check_route" as const,
    actor: "human" as const,
  };
}

function assertGateCode(code: string) {
  return (err: unknown) => {
    assert.ok(err instanceof ReviewQaGateError);
    assert.equal(err.code, code);
    assert.equal(err.status, 409);
    return true;
  };
}

describe("review-qa-gate-service", { concurrency: false }, () => {
  let db: ReturnType<typeof createTestDb>;
  let repoPath: string;
  let restoreDb: (() => void) | null = null;
  let restoreHeadProbe: (() => void) | null = null;

  beforeEach(() => {
    db = createTestDb();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "review-qa-gate-"));
    seedProjectAndChange(db, repoPath);
    restoreDb = setReviewQaGateDbForTest(db);
    restoreHeadProbe = setReviewQaGateHeadProbeForTest(() => HEAD_A);
  });

  afterEach(() => {
    restoreHeadProbe?.();
    restoreHeadProbe = null;
    restoreDb?.();
    restoreDb = null;
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("blocks DB open P0/P1 even when the .ship review mirror says passed and empty", () => {
    seedAllowedReview(db);
    seedReviewFinding(db, { id: "FND-P0", severity: "P0" });
    seedReviewFinding(db, { id: "FND-P1", severity: "P1" });
    const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
    fs.mkdirSync(changeDir, { recursive: true });
    fs.writeFileSync(path.join(changeDir, "review-report.md"), "# Review passed\n");
    fs.writeFileSync(path.join(changeDir, "review-findings.json"), "[]\n");

    assert.throws(() => assertCanEnterQa(gateInput()), (err) => {
      assert.ok(err instanceof ReviewQaGateError);
      assert.equal(err.code, "review_blockers");
      assert.equal(err.details.counts.blockingP0, 1);
      assert.equal(err.details.counts.blockingP1, 1);
      return true;
    });
  });

  it("blocks when there is no latest valid review", () => {
    seedBuild(db);

    assert.throws(() => assertCanEnterQa(gateInput()), assertGateCode("no_latest_valid_review"));
  });

  it("blocks while the latest review attempt is running", () => {
    seedAllowedReview(db);
    seedAttempt(db, { id: "RAT-2", attemptNo: 2, status: "running", reviewStatus: "running" });
    db.update(schema.reviewState)
      .set({ latestAttemptId: "RAT-2", latestAttemptNo: 2 })
      .where(eq(schema.reviewState.changeId, CHANGE_ID))
      .run();

    assert.throws(() => assertCanEnterQa(gateInput()), assertGateCode("latest_attempt_running"));
  });

  it("blocks when the DB latest attempt is running even if review_state still points at an older valid attempt", () => {
    seedAllowedReview(db);
    seedAttempt(db, { id: "RAT-2", attemptNo: 2, status: "running", reviewStatus: "running" });

    assert.throws(() => assertCanEnterQa(gateInput()), assertGateCode("latest_attempt_running"));
  });

  it("blocks when the source build is stale", () => {
    seedAllowedReview(db);
    seedBuild(db, {
      id: "BR-2",
      buildRunId: "build-2",
      headSha: HEAD_A,
      adoptedAt: "2026-06-29T02:00:00.000Z",
    });

    assert.throws(() => assertCanEnterQa(gateInput()), assertGateCode("source_build_stale"));
  });

  it("keeps QA tied to the approved Build workspace when main HEAD drifts", () => {
    seedAllowedReview(db);
    restoreHeadProbe?.();
    restoreHeadProbe = setReviewQaGateHeadProbeForTest(() => HEAD_B);

    assert.equal(assertCanEnterQa(gateInput()).allowed, true);
  });

  it("allows approved-workspace QA when main git HEAD cannot be probed", () => {
    seedAllowedReview(db);
    restoreHeadProbe?.();
    restoreHeadProbe = setReviewQaGateHeadProbeForTest(() => null);

    const gate = assertCanEnterQa(gateInput());
    assert.equal(gate.allowed, true);
    assert.ok(gate.warnings.includes("git_head_unavailable"));
  });

  it("blocks legacy incomplete review data", () => {
    seedAllowedReview(db);
    seedReviewFinding(db, {
      id: "FND-LEGACY",
      severity: "P1",
      requiredFix: null,
      legacyState: "legacy_incomplete",
    });

    assert.throws(() => assertCanEnterQa(gateInput()), assertGateCode("legacy_incomplete"));
  });

  it("allows QA when only old attempts have P2 or legacy incomplete findings", () => {
    seedBuild(db);
    seedAttempt(db, { id: "RAT-1", attemptNo: 1, reviewStatus: "issues_found" });
    seedReviewFinding(db, {
      id: "FND-OLD-P2",
      severity: "P2",
      attemptId: "RAT-1",
      findingVersion: 7,
    });
    seedReviewFinding(db, {
      id: "FND-OLD-LEGACY",
      severity: "P2",
      attemptId: "RAT-1",
      evidence: null,
      findingVersion: 8,
    });
    seedAttempt(db, {
      id: "RAT-2",
      attemptNo: 2,
      reviewStatus: "passed",
      priorBlockingFindingIdsJson: JSON.stringify([]),
    });
    seedReportAndState(db, {
      attemptId: "RAT-2",
      latestAttemptNo: 2,
      gateStatus: "passed",
      qaAllowed: 1,
      findingVersion: 1,
      p2Count: 0,
      legacyState: null,
    });

    const result = assertCanEnterQa(gateInput());

    assert.equal(result.allowed, true);
    assert.deepEqual(result.counts, { blockingP0: 0, blockingP1: 0, waivedP1: 0, p2Count: 0 });
  });

  it("allows QA when old open P0/P1 findings are not in the latest attempt prior snapshot", () => {
    seedBuild(db);
    seedAttempt(db, { id: "RAT-1", attemptNo: 1, reviewStatus: "issues_found" });
    seedReviewFinding(db, {
      id: "FND-OLD-P0",
      severity: "P0",
      attemptId: "RAT-1",
      findingVersion: 6,
    });
    seedReviewFinding(db, {
      id: "FND-OLD-P1",
      severity: "P1",
      attemptId: "RAT-1",
      findingVersion: 7,
    });
    seedAttempt(db, {
      id: "RAT-2",
      attemptNo: 2,
      reviewStatus: "passed",
      priorBlockingFindingIdsJson: JSON.stringify(["FND-NOT-THIS-ONE"]),
    });
    seedReportAndState(db, {
      attemptId: "RAT-2",
      latestAttemptNo: 2,
      gateStatus: "passed",
      qaAllowed: 1,
      findingVersion: 1,
    });

    const result = assertCanEnterQa(gateInput());

    assert.equal(result.allowed, true);
    assert.deepEqual(result.counts, { blockingP0: 0, blockingP1: 0, waivedP1: 0, p2Count: 0 });
  });

  it("blocks QA when an old open P0/P1 finding is frozen into the latest attempt prior snapshot", () => {
    seedBuild(db);
    seedAttempt(db, { id: "RAT-1", attemptNo: 1, reviewStatus: "issues_found" });
    seedReviewFinding(db, {
      id: "FND-OLD-P1",
      severity: "P1",
      attemptId: "RAT-1",
      findingVersion: 4,
    });
    seedAttempt(db, {
      id: "RAT-2",
      attemptNo: 2,
      reviewStatus: "passed",
      priorBlockingFindingIdsJson: JSON.stringify(["FND-OLD-P1"]),
    });
    seedReportAndState(db, {
      attemptId: "RAT-2",
      latestAttemptNo: 2,
      gateStatus: "passed",
      qaAllowed: 1,
      findingVersion: 4,
    });

    assert.throws(() => assertCanEnterQa(gateInput()), (err) => {
      assert.ok(err instanceof ReviewQaGateError);
      assert.equal(err.code, "review_blockers");
      assert.equal(err.details.counts.blockingP0, 0);
      assert.equal(err.details.counts.blockingP1, 1);
      return true;
    });
  });

  it("allows QA when review mirrors are missing or generation_failed", () => {
    seedAllowedReview(db);
    const first = assertCanEnterQa(gateInput());
    assert.equal(first.allowed, true);

    db.insert(schema.reviewArtifactMirrors).values({
      id: "RAM-1",
      reportId: "RRP-1",
      changeId: CHANGE_ID,
      artifactId: null,
      kind: "report",
      path: null,
      schemaVersion: "1",
      sourceDbHash: "hash-RRP-1",
      contentHash: null,
      mirrorStatus: "generation_failed",
      lastCheckedAt: nowISO(),
      lastRebuiltAt: null,
      errorCode: "disk_full",
      artifactPath: null,
      artifactHash: null,
      createdAt: nowISO(),
    }).run();

    const second = assertCanEnterQa(gateInput());
    assert.equal(second.allowed, true);
  });

  it("allows a fresh waived P1 review while preserving waived count and reason", () => {
    seedBuild(db);
    seedAttempt(db);
    const now = nowISO();
    db.insert(schema.humanDecisions).values({
      id: "HD-1",
      changeId: CHANGE_ID,
      roundId: null,
      gate: "review",
      action: "review_p1_waiver",
      targetType: "finding",
      targetId: "FND-P1-WAIVED",
      reason: "accepted temporary migration risk",
      reportHash: null,
      createdBy: "human",
      createdAt: now,
    }).run();
    seedReviewFinding(db, {
      id: "FND-P1-WAIVED",
      severity: "P1",
      status: "waived",
      waiverDecisionId: "HD-1",
    });
    seedReportAndState(db, {
      gateStatus: "passed_with_waived_p1",
      qaAllowed: 1,
      reviewConclusion: "issues_found",
      waivedP1: 1,
    });

    const result = assertCanEnterQa(gateInput());

    assert.equal(result.allowed, true);
    assert.equal(result.status, "passed_with_waived_p1");
    assert.equal(result.counts.waivedP1, 1);
    assert.deepEqual(result.waivedP1.reasons, [
      { findingId: "FND-P1-WAIVED", reason: "accepted temporary migration risk" },
    ]);
  });
});
