import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import * as dbSchema from "../db/schema.ts";
import {
  artifacts,
  buildRunRecords,
  changes,
  findings,
  humanDecisions,
  projects,
  reviewArtifactMirrors,
  reviewAttempts,
  reviewReports,
  reviewState,
  runs,
} from "../db/schema.ts";
import { writeBuildRun, type BuildRunFile } from "./build-workspace-service.ts";
import {
  getReviewCenterState,
  setReviewCenterServiceDbForTest,
  type ReviewCenterDb,
} from "./review-center-service.ts";

const PROJECT_ID = "PRJ-REVIEW-CENTER";
const CHANGE_ID = "CHG-REVIEW-CENTER";
const REVIEW_RUN_ID = "RUN-901001";

function cleanupRows() {
  db.delete(reviewArtifactMirrors).where(eq(reviewArtifactMirrors.changeId, CHANGE_ID)).run();
  db.delete(reviewState).where(eq(reviewState.changeId, CHANGE_ID)).run();
  db.delete(reviewReports).where(eq(reviewReports.changeId, CHANGE_ID)).run();
  db.delete(findings).where(eq(findings.changeId, CHANGE_ID)).run();
  db.delete(humanDecisions).where(eq(humanDecisions.changeId, CHANGE_ID)).run();
  db.delete(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
  db.delete(buildRunRecords).where(eq(buildRunRecords.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function tableColumns(tableName: string): Set<string> {
  return new Set(
    db.all(sql.raw(`PRAGMA table_info(${tableName})`)).map((row) => String(row.name)),
  );
}

function addColumnIfMissing(tableName: string, columnName: string, definition: string) {
  if (tableColumns(tableName).has(columnName)) return;
  db.run(sql.raw(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`));
}

function ensureReviewDbContractColumns() {
  addColumnIfMissing("review_reports", "review_conclusion", "review_conclusion TEXT");
  addColumnIfMissing("review_reports", "qa_allowed", "qa_allowed INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("review_reports", "source_build_run_id", "source_build_run_id TEXT");
  addColumnIfMissing("review_reports", "source_head_sha", "source_head_sha TEXT");
  addColumnIfMissing("review_reports", "finding_version", "finding_version INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing("review_reports", "waiver_version", "waiver_version INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing("review_reports", "blocking_p0", "blocking_p0 INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("review_reports", "blocking_p1", "blocking_p1 INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("review_reports", "waived_p1", "waived_p1 INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("review_reports", "p2_count", "p2_count INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("review_reports", "findings_db_hash", "findings_db_hash TEXT");
  addColumnIfMissing("review_reports", "stale_reason", "stale_reason TEXT");
  addColumnIfMissing("review_reports", "legacy_state", "legacy_state TEXT");

  addColumnIfMissing("review_state", "latest_attempt_no", "latest_attempt_no INTEGER");
  addColumnIfMissing("review_state", "latest_valid_review_report_id", "latest_valid_review_report_id TEXT");
  addColumnIfMissing("review_state", "latest_valid_attempt_no", "latest_valid_attempt_no INTEGER");
  addColumnIfMissing("review_state", "finding_version", "finding_version INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing("review_state", "waiver_version", "waiver_version INTEGER NOT NULL DEFAULT 1");

  addColumnIfMissing("review_artifact_mirrors", "artifact_id", "artifact_id TEXT");
  addColumnIfMissing("review_artifact_mirrors", "path", "path TEXT");
  addColumnIfMissing("review_artifact_mirrors", "schema_version", "schema_version TEXT");
  addColumnIfMissing("review_artifact_mirrors", "source_db_hash", "source_db_hash TEXT");
  addColumnIfMissing("review_artifact_mirrors", "content_hash", "content_hash TEXT");
  addColumnIfMissing("review_artifact_mirrors", "mirror_status", "mirror_status TEXT");
  addColumnIfMissing("review_artifact_mirrors", "last_checked_at", "last_checked_at TEXT");
  addColumnIfMissing("review_artifact_mirrors", "last_rebuilt_at", "last_rebuilt_at TEXT");
  addColumnIfMissing("review_artifact_mirrors", "error_code", "error_code TEXT");
  addColumnIfMissing("review_artifact_mirrors", "artifact_path", "artifact_path TEXT");
  addColumnIfMissing("review_artifact_mirrors", "artifact_hash", "artifact_hash TEXT");
}

function seedChange(repoPath: string) {
  const now = new Date().toISOString();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Review Center",
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
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Review center slice",
    status: "IMPLEMENTED",
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
    createdAt: now,
    updatedAt: now,
  }).run();
}

function reviewSummary(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    reviewStatus: "passed",
    provider: "codex",
    errorCode: null,
    errorMessage: null,
    sanitizedErrorSummary: null,
    sourceBuildRunId: "build-1",
    reportPath: null,
    findingsPath: null,
    rawOutputPath: null,
    findingCount: 0,
    summary: "review passed",
    ...overrides,
  });
}

function seedReviewRun({
  id = REVIEW_RUN_ID,
  status = "completed",
  summary = reviewSummary(),
}: {
  id?: string;
  status?: "running" | "completed" | "failed" | "stopped";
  summary?: string | null;
} = {}) {
  const now = new Date().toISOString();
  db.insert(runs).values({
    id,
    changeId: CHANGE_ID,
    phase: "review",
    status,
    startedAt: now,
    endedAt: status === "running" ? null : now,
    summary,
  }).run();
}

function seedFinding({
  id,
  runId = REVIEW_RUN_ID,
  reviewAttemptId = null,
  severity,
  status = "open",
  evidence = "evidence",
  requiredFix = "fix it",
  waiverDecisionId = null,
  file = "src/app.ts",
}: {
  id: string;
  runId?: string;
  reviewAttemptId?: string | null;
  severity: "P0" | "P1" | "P2";
  status?: "open" | "fixed" | "waived";
  evidence?: string | null;
  requiredFix?: string | null;
  waiverDecisionId?: string | null;
  file?: string | null;
}) {
  const now = new Date().toISOString();
  const shouldIgnoreCheck = sourceLegacyIncompleteNeedsCheckBypass(severity, evidence, requiredFix);
  if (shouldIgnoreCheck) db.run(sql`PRAGMA ignore_check_constraints = ON`);
  try {
    db.insert(findings).values({
      id,
      changeId: CHANGE_ID,
      runId,
      source: "review",
      severity,
      category: "logic",
      title: `${severity} finding`,
      file,
      line: null,
      evidence,
      requiredFix,
      status,
      reviewAttemptId,
      waivable: severity === "P1" ? 1 : 0,
      waivedBy: status === "waived" ? "human" : null,
      waivedAt: status === "waived" ? now : null,
      waiverDecisionId,
      createdAt: now,
      updatedAt: now,
    }).run();
  } finally {
    if (shouldIgnoreCheck) db.run(sql`PRAGMA ignore_check_constraints = OFF`);
  }
}

function sourceLegacyIncompleteNeedsCheckBypass(
  severity: "P0" | "P1" | "P2",
  evidence: string | null,
  requiredFix: string | null,
): boolean {
  return (
    (severity === "P0" || severity === "P1") &&
    (!evidence || evidence.trim().length === 0 || !requiredFix || requiredFix.trim().length === 0)
  );
}

function seedReviewAttempt({
  id,
  attemptNo,
  status = "completed",
  reviewStatus = "passed",
  rawOutputArtifactId = null,
  errorCode = null,
  sanitizedErrorSummary = null,
}: {
  id: string;
  attemptNo: number;
  status?: "running" | "completed" | "failed";
  reviewStatus:
    | "running"
    | "passed"
    | "issues_found"
    | "failed"
    | "invalid_output"
    | "data_inconsistent";
  rawOutputArtifactId?: string | null;
  errorCode?: string | null;
  sanitizedErrorSummary?: string | null;
}) {
  const now = new Date().toISOString();
  const runId = `RUN-DB-${attemptNo}`;
  db.insert(runs).values({
    id: runId,
    changeId: CHANGE_ID,
    phase: "review",
    status: status === "running" ? "running" : status === "failed" ? "failed" : "completed",
    startedAt: now,
    endedAt: status === "running" ? null : now,
    summary: null,
  }).onConflictDoNothing().run();
  db.insert(reviewAttempts).values({
    id,
    changeId: CHANGE_ID,
    runId,
    attemptNo,
    status,
    provider: "codex",
    reviewStatus,
    idempotencyKey: id,
    sourceBuildRunId: "build-1",
    sourceHeadSha: "a".repeat(40),
    priorBlockingFindingIdsJson: null,
    rawOutputArtifactId,
    errorCode,
    sanitizedErrorSummary,
    startedAt: now,
    endedAt: status === "running" ? null : now,
    completedAt: reviewStatus === "passed" || reviewStatus === "issues_found" ? now : null,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function seedArtifact({
  id,
  type,
  filePath,
}: {
  id: string;
  type: string;
  filePath: string;
}) {
  db.insert(artifacts).values({
    id,
    changeId: CHANGE_ID,
    runId: null,
    type,
    path: filePath,
    createdAt: new Date().toISOString(),
  }).run();
}

function seedHumanDecision({
  id,
  reason,
}: {
  id: string;
  reason: string | null;
}) {
  db.insert(humanDecisions).values({
    id,
    changeId: CHANGE_ID,
    roundId: null,
    gate: "review",
    action: "review_p1_waiver",
    targetType: "finding",
    targetId: "FND-WAIVED-P1",
    reason,
    reportHash: null,
    createdBy: "human",
    createdAt: new Date().toISOString(),
  }).run();
}

function seedReviewReport({
  id,
  attemptId,
  gateStatus,
  reviewConclusion = "passed",
  qaAllowed,
  blockingP0 = 0,
  blockingP1 = 0,
  waivedP1 = gateStatus === "passed_with_waived_p1" ? 1 : 0,
  p2Count = 0,
}: {
  id: string;
  attemptId: string;
  gateStatus: "passed" | "passed_with_waived_p1" | "blocked_p0" | "blocked_p1" | "stale";
  reviewConclusion?: "passed" | "issues_found";
  qaAllowed: boolean;
  blockingP0?: number;
  blockingP1?: number;
  waivedP1?: number;
  p2Count?: number;
}) {
  const now = new Date().toISOString();
  db.insert(reviewReports).values({
    id,
    attemptId,
    changeId: CHANGE_ID,
    reportVersion: 1,
    reviewConclusion,
    reportDbHash: `hash-${id}`,
    gateStatus,
    qaAllowed: qaAllowed ? 1 : 0,
    sourceBuildRunId: "build-1",
    sourceHeadSha: "a".repeat(40),
    findingVersion: 1,
    waiverVersion: 1,
    blockingP0,
    blockingP1,
    waivedP1,
    p2Count,
    findingsDbHash: `findings-${id}`,
    staleReason: null,
    legacyState: null,
    reportJson: null,
    generatedAt: now,
    createdAt: now,
  }).run();
}

function seedMirror({
  id,
  reportId,
  artifactId,
  kind,
  status,
  artifactHash = "hash-current",
}: {
  id: string;
  reportId: string;
  artifactId: string | null;
  kind: "review_report" | "review_findings";
  status: "ok" | "missing" | "mismatch" | "generation_failed";
  artifactHash?: string | null;
}) {
  const now = new Date().toISOString();
  if (artifactId) {
    db.insert(artifacts).values({
      id: artifactId,
      changeId: CHANGE_ID,
      runId: null,
      type: kind,
      path: `/fixture/${artifactId}.md`,
      createdAt: now,
    }).onConflictDoNothing().run();
  }
  db.insert(reviewArtifactMirrors).values({
    id,
    reportId,
    changeId: CHANGE_ID,
    artifactId,
    kind,
    path: "/absolute/secret/review-report.md",
    schemaVersion: "review-report/v1",
    sourceDbHash: "db-hash",
    contentHash: "content-hash",
    mirrorStatus: status,
    lastCheckedAt: now,
    lastRebuiltAt: null,
    errorCode: status === "ok" ? null : status,
    artifactPath: "/absolute/secret/review-report.md",
    artifactHash,
    createdAt: now,
  }).run();
}

function seedBuildRecord({
  id = "BR-DB-1",
  buildRunId = "build-1",
  status = "adopted",
  adoptedAt = "2026-06-29T01:00:00.000Z",
}: {
  id?: string;
  buildRunId?: string;
  status?: "adopted" | "completed" | "failed";
  adoptedAt?: string | null;
} = {}) {
  const now = new Date().toISOString();
  db.insert(buildRunRecords).values({
    id,
    changeId: CHANGE_ID,
    runId: null,
    buildRunId,
    status,
    headSha: "a".repeat(40),
    adoptedAt,
    artifactHash: null,
    source: "test",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().run();
}

function seedReviewState(overrides: Partial<typeof reviewState.$inferInsert>) {
  db.insert(reviewState).values({
    changeId: CHANGE_ID,
    latestAttemptId: null,
    latestAttemptNo: null,
    latestReportId: null,
    latestValidReviewReportId: null,
    latestValidAttemptNo: null,
    gateStatus: null,
    reviewStatus: null,
    sourceBuildRunId: null,
    sourceHeadSha: null,
    reportDbHash: null,
    findingVersion: 1,
    waiverVersion: 1,
    updatedAt: new Date().toISOString(),
    ...overrides,
  }).run();
}

function makeBuildRun(overrides: Partial<BuildRunFile> = {}): BuildRunFile {
  const now = new Date().toISOString();
  return {
    changeId: CHANGE_ID,
    runNumber: 1,
    status: "adopted",
    baseCommit: null,
    workspacePath: "/tmp/review-center-build",
    branchName: `stagepass/build/${CHANGE_ID}/build-1`,
    expectedFiles: [],
    forbiddenFiles: [],
    changedFiles: ["src/app.ts"],
    deviations: [],
    blockers: [],
    patchPath: null,
    patchSha256: null,
    adoptedHeadSha: "a".repeat(40),
    approvalPath: null,
    diffPath: null,
    auditPath: null,
    reportPath: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("review-center-service", { concurrency: false }, () => {
  let repoPath: string;

  beforeEach(() => {
    ensureReviewDbContractColumns();
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "review-center-"));
    seedChange(repoPath);
    writeBuildRun(repoPath, makeBuildRun({ runNumber: 1, status: "adopted" }));
    seedBuildRecord();
  });

  afterEach(() => {
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("reports not_started and blocks QA when no review run exists", () => {
    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.gate.status, "not_started");
    assert.equal(state.latestAttempt, null);
    assert.equal(state.latestValidReview, null);
    assert.deepEqual(state.findings, []);
    assert.equal(state.actions.canEnterQa, false);
  });

  it("reports running when the latest review run is running", () => {
    seedReviewRun({ id: REVIEW_RUN_ID, status: "completed" });
    seedReviewRun({ id: "RUN-901002", status: "running", summary: null });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.gate.status, "running");
    assert.equal(state.latestAttempt?.runId, "RUN-901002");
    assert.equal(state.latestAttempt?.runStatus, "running");
    assert.equal(state.latestValidReview?.runId, REVIEW_RUN_ID);
  });

  it("uses DB review_state and review_reports as the headline gate source before legacy run summaries", () => {
    seedBuildRecord();
    seedReviewRun({
      id: "RUN-LEGACY-PASSED",
      summary: reviewSummary({ reviewStatus: "passed", findingCount: 0 }),
    });
    seedReviewAttempt({ id: "RAT-DB-1", attemptNo: 1, reviewStatus: "passed" });
    seedReviewAttempt({ id: "RAT-DB-2", attemptNo: 2, status: "failed", reviewStatus: "invalid_output" });
    seedReviewReport({
      id: "RRP-DB-1",
      attemptId: "RAT-DB-1",
      gateStatus: "passed_with_waived_p1",
      qaAllowed: true,
    });
    seedReviewState({
      latestAttemptId: "RAT-DB-2",
      latestAttemptNo: 2,
      latestValidReviewReportId: "RRP-DB-1",
      latestValidAttemptNo: 1,
      gateStatus: "passed_with_waived_p1",
      reviewStatus: "passed",
      sourceBuildRunId: "build-1",
      sourceHeadSha: "a".repeat(40),
      reportDbHash: "hash-RRP-DB-1",
    });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.latestAttempt?.runId, "RUN-DB-2");
    assert.equal(state.latestAttempt?.reviewStatus, "invalid_output");
    assert.equal(state.latestValidReview?.runId, "RUN-DB-1");
    assert.equal(state.latestValidReview?.reviewStatus, "passed");
    assert.equal(state.gate.status, "passed");
    assert.equal(state.gate.canEnterQa, true);
    assert.equal(state.gate.reason, "P1 risk accepted with a fresh DB Review report.");
  });

  it("does not use an adopted .ship build mirror as ReviewCenter gate authority without a DB build record", () => {
    db.delete(buildRunRecords).where(eq(buildRunRecords.changeId, CHANGE_ID)).run();
    seedReviewAttempt({ id: "RAT-DB-1", attemptNo: 1, reviewStatus: "passed" });
    seedReviewReport({
      id: "RRP-DB-1",
      attemptId: "RAT-DB-1",
      gateStatus: "passed",
      qaAllowed: true,
    });
    seedReviewState({
      latestAttemptId: "RAT-DB-1",
      latestAttemptNo: 1,
      latestValidReviewReportId: "RRP-DB-1",
      latestValidAttemptNo: 1,
      gateStatus: "passed",
      reviewStatus: "passed",
      sourceBuildRunId: "build-1",
      sourceHeadSha: "a".repeat(40),
      reportDbHash: "hash-RRP-DB-1",
    });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.gate.status, "stale");
    assert.equal(state.gate.latestBuildRunId, null);
    assert.equal(state.gate.canEnterQa, false);
    assert.equal(state.actions.canRunReview, false);
    assert.equal(state.actions.canRetryReview, false);
    assert.equal(state.actions.run_review.reason, "Review requires an approved Build run before starting.");
  });

  it("does not select a valid DB report by generatedAt when review_state lacks latestValidReviewReportId", () => {
    seedBuildRecord();
    seedReviewAttempt({ id: "RAT-DB-1", attemptNo: 1, reviewStatus: "passed" });
    seedReviewAttempt({ id: "RAT-DB-2", attemptNo: 2, reviewStatus: "passed" });
    seedReviewReport({
      id: "RRP-OLD-LATE",
      attemptId: "RAT-DB-1",
      gateStatus: "passed",
      qaAllowed: true,
    });
    seedReviewReport({
      id: "RRP-NEW",
      attemptId: "RAT-DB-2",
      gateStatus: "passed",
      qaAllowed: true,
    });
    db.update(reviewReports)
      .set({ generatedAt: "2099-01-01T00:00:00.000Z" })
      .where(eq(reviewReports.id, "RRP-OLD-LATE"))
      .run();
    seedReviewState({
      latestAttemptId: "RAT-DB-2",
      latestAttemptNo: 2,
      latestValidReviewReportId: null,
      latestValidAttemptNo: null,
      gateStatus: null,
      reviewStatus: null,
      sourceBuildRunId: null,
      sourceHeadSha: null,
      reportDbHash: null,
    });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.latestValidReview, null);
    assert.equal(state.gate.status, "stale");
    assert.equal(state.gate.canEnterQa, false);
  });

  it("does not let a legacy passed run summary enter QA when DB Review state and report are missing", () => {
    seedBuildRecord();
    seedReviewRun({
      id: "RUN-LEGACY-PASSED",
      summary: reviewSummary({ reviewStatus: "passed", findingCount: 0 }),
    });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.latestAttempt?.runId, "RUN-LEGACY-PASSED");
    assert.equal(state.latestValidReview?.runId, "RUN-LEGACY-PASSED");
    assert.equal(state.gate.status, "stale");
    assert.equal(state.gate.canEnterQa, false);
  });

  it("reports failed for failed, data_inconsistent, and invalid review summaries", () => {
    seedReviewRun({ id: REVIEW_RUN_ID, status: "failed", summary: reviewSummary({ reviewStatus: "failed" }) });
    assert.equal(getReviewCenterState(CHANGE_ID).gate.status, "failed");

    cleanupRows();
    seedChange(repoPath);
    seedReviewRun({ id: REVIEW_RUN_ID, summary: reviewSummary({ reviewStatus: "data_inconsistent" }) });
    assert.equal(getReviewCenterState(CHANGE_ID).gate.status, "data_inconsistent");

    cleanupRows();
    seedChange(repoPath);
    seedReviewRun({ id: REVIEW_RUN_ID, summary: "not json" });
    assert.equal(getReviewCenterState(CHANGE_ID).gate.status, "failed");
  });

  it("blocks on open P0 review findings and does not allow waiver or QA", () => {
    seedReviewRun({ summary: reviewSummary({ reviewStatus: "issues_found", findingCount: 1 }) });
    seedFinding({ id: "FND-P0", severity: "P0" });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.gate.status, "blocked_p0");
    assert.equal(state.actions.canWaiveP1, false);
    assert.equal(state.actions.canEnterQa, false);
    assert.equal(state.findings[0]?.id, "FND-P0");
  });

  it("blocks on open P1 review findings and allows P1 waiver", () => {
    seedReviewRun({ summary: reviewSummary({ reviewStatus: "issues_found", findingCount: 1 }) });
    seedFinding({ id: "FND-P1", severity: "P1" });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.gate.status, "blocked_p1");
    assert.equal(state.actions.canWaiveP1, true);
    assert.equal(state.actions.canEnterQa, false);
  });

  it("marks the review stale and blocks QA when a latest valid P1 finding is waived", () => {
    seedReviewRun({ summary: reviewSummary({ reviewStatus: "issues_found", findingCount: 1 }) });
    seedFinding({ id: "FND-P1", severity: "P1", status: "waived" });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.gate.status, "stale");
    assert.equal(state.gate.reason, "P1 waiver requires a fresh Review run before QA.");
    assert.equal(state.actions.canWaiveP1, false);
    assert.equal(state.actions.canEnterQa, false);
    assert.equal(state.actions.canRetryReview, true);
  });

  it("shows legacy P2-only review data but does not allow QA without a DB Review report", () => {
    seedReviewRun({ summary: reviewSummary({ reviewStatus: "issues_found", findingCount: 1 }) });
    seedFinding({ id: "FND-P2", severity: "P2" });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.latestValidReview?.runId, REVIEW_RUN_ID);
    assert.equal(state.gate.status, "stale");
    assert.equal(state.actions.canEnterQa, false);
  });

  it("reports stale when review sourceBuildRunId does not match the latest adopted build run", () => {
    writeBuildRun(repoPath, makeBuildRun({ runNumber: 1 }));
    seedReviewRun({ summary: reviewSummary({ sourceBuildRunId: "build-0" }) });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.gate.status, "stale");
    assert.equal(state.actions.canEnterQa, false);
    assert.equal(state.gate.latestBuildRunId, "build-1");
  });

  it("reports stale when no latest Build run is adopted", () => {
    db.delete(buildRunRecords).where(eq(buildRunRecords.changeId, CHANGE_ID)).run();
    writeBuildRun(repoPath, makeBuildRun({ runNumber: 2, status: "failed" }));
    seedReviewRun({ summary: reviewSummary({ sourceBuildRunId: "build-1" }) });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.gate.status, "stale");
    assert.equal(state.gate.reason, "Review requires an approved Build run before QA.");
    assert.equal(state.gate.latestBuildRunId, null);
    assert.equal(state.actions.canEnterQa, false);
    assert.equal(state.actions.canRunReview, false);
    assert.equal(state.actions.canRetryReview, false);
    assert.equal(state.actions.retry_review.reason, "Review requires an approved Build run before starting.");
  });

  it("reports stale when the latest valid review is missing sourceBuildRunId", () => {
    seedReviewRun({ summary: reviewSummary({ sourceBuildRunId: null }) });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.gate.status, "stale");
    assert.equal(state.gate.reason, "Review is missing its source Build run.");
    assert.equal(state.gate.latestBuildRunId, "build-1");
    assert.equal(state.actions.canEnterQa, false);
  });

  for (const reviewStatus of ["failed", "invalid_output", "data_inconsistent"] as const) {
    it(`keeps latest ${reviewStatus} attempt separate from latest valid review`, () => {
      const suffix = reviewStatus === "failed" ? "101" : reviewStatus === "invalid_output" ? "102" : "103";
      const validRunId = `RUN-${suffix}0`;
      const latestRunId = `RUN-${suffix}1`;
      seedReviewRun({
        id: validRunId,
        status: "completed",
        summary: reviewSummary({
          reviewStatus: "issues_found",
          sourceBuildRunId: "build-1",
          findingCount: 1,
        }),
      });
      seedFinding({
        id: `FND-P1-${reviewStatus}`,
        runId: validRunId,
        severity: "P1",
        status: "open",
        requiredFix: "Fix the stale contract.",
      });
      seedReviewRun({
        id: latestRunId,
        status: "failed",
        summary: reviewSummary({
          reviewStatus,
          sourceBuildRunId: "build-1",
          rawOutputPath: reviewStatus === "invalid_output" ? "/tmp/raw-review-output.json" : null,
          errorCode: reviewStatus,
          errorMessage: `${reviewStatus} should not erase the valid review`,
          findingCount: 0,
        }),
      });

      const state = getReviewCenterState(CHANGE_ID);

      assert.equal(state.latestAttempt?.runId, latestRunId);
      assert.equal(state.latestAttempt?.reviewStatus, reviewStatus);
      assert.equal(state.latestValidReview?.runId, validRunId);
      assert.equal(state.gate.status, "blocked_p1");
      assert.equal(state.actions.canEnterQa, false);
    });
  }

  it("blocks on DB open P0 even when latest valid review summary passed", () => {
    seedReviewRun({
      summary: reviewSummary({ reviewStatus: "passed", findingCount: 1 }),
    });
    seedFinding({ id: "FND-P0-DB", severity: "P0" });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.latestValidReview?.runId, REVIEW_RUN_ID);
    assert.equal(state.latestValidReview?.reviewStatus, "passed");
    assert.equal(state.gate.status, "blocked_p0");
    assert.equal(state.actions.canEnterQa, false);
  });

  it("does not use missing mirrored review findings as authority over DB findings", () => {
    seedReviewRun({
      id: "RUN-VALID",
      summary: reviewSummary({
        reviewStatus: "passed",
        findingsPath: "/missing/review-findings.json",
        findingCount: 1,
      }),
    });
    seedFinding({
      id: "FND-P0-MIRROR-MISSING",
      runId: "RUN-VALID",
      severity: "P0",
      requiredFix: "Fix from DB.",
    });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.gate.status, "blocked_p0");
    assert.equal(state.findings.some((finding) => finding.id === "FND-P0-MIRROR-MISSING"), true);
  });

  it("treats a passed or issues_found summary as data_inconsistent when DB review finding count differs", () => {
    seedReviewRun({
      summary: reviewSummary({ reviewStatus: "issues_found", findingCount: 1 }),
    });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.latestAttempt?.runId, REVIEW_RUN_ID);
    assert.equal(state.latestValidReview, null);
    assert.equal(state.gate.status, "data_inconsistent");
    assert.equal(state.actions.canEnterQa, false);
  });

  it("rejects passed and issues_found summaries that omit findingCount", () => {
    seedReviewRun({
      summary: JSON.stringify({
        reviewStatus: "passed",
        provider: "codex",
        sourceBuildRunId: null,
      }),
    });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.latestAttempt?.runId, REVIEW_RUN_ID);
    assert.equal(state.latestAttempt?.reviewStatus, "failed");
    assert.equal(state.latestValidReview, null);
    assert.equal(state.gate.status, "failed");
    assert.equal(state.actions.canEnterQa, false);
  });

  it("keeps a latest finding count mismatch separate from the previous valid review", () => {
    seedReviewRun({
      id: "RUN-900000",
      summary: reviewSummary({ reviewStatus: "passed", findingCount: 0 }),
    });
    seedReviewRun({
      id: REVIEW_RUN_ID,
      summary: reviewSummary({ reviewStatus: "issues_found", findingCount: 1 }),
    });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.latestAttempt?.runId, REVIEW_RUN_ID);
    assert.equal(state.latestAttempt?.reviewStatus, "data_inconsistent");
    assert.equal(state.latestValidReview?.runId, "RUN-900000");
    assert.equal(state.gate.status, "stale");
    assert.equal(state.actions.canEnterQa, false);
  });

  it("blocks on DB open P1 even when latest valid review summary passed", () => {
    seedReviewRun({
      summary: reviewSummary({ reviewStatus: "passed", findingCount: 1 }),
    });
    seedFinding({ id: "FND-P1-DB", severity: "P1" });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.latestValidReview?.runId, REVIEW_RUN_ID);
    assert.equal(state.latestValidReview?.reviewStatus, "passed");
    assert.equal(state.gate.status, "blocked_p1");
    assert.equal(state.actions.canEnterQa, false);
  });

  it("reports stale when latest valid review sourceBuildRunId is older than latest adopted build run", () => {
    writeBuildRun(repoPath, makeBuildRun({ runNumber: 1, status: "adopted" }));
    writeBuildRun(repoPath, makeBuildRun({ runNumber: 2, status: "adopted" }));
    seedBuildRecord({
      id: "BR-DB-2",
      buildRunId: "build-2",
      adoptedAt: "2026-06-29T02:00:00.000Z",
    });
    seedReviewRun({
      summary: reviewSummary({ reviewStatus: "passed", sourceBuildRunId: "build-1" }),
    });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.gate.status, "stale");
    assert.equal(state.gate.sourceBuildRunId, "build-1");
    assert.equal(state.gate.latestBuildRunId, "build-2");
    assert.equal(state.actions.canEnterQa, false);
  });

  it("blocks on old open P1 findings that the latest valid review did not recheck", () => {
    seedReviewRun({
      id: "RUN-900000",
      summary: reviewSummary({ reviewStatus: "issues_found", findingCount: 1 }),
    });
    seedFinding({
      id: "FND-OLD-P1",
      runId: "RUN-900000",
      severity: "P1",
    });
    seedReviewRun({
      id: REVIEW_RUN_ID,
      summary: reviewSummary({ reviewStatus: "passed", findingCount: 0 }),
    });

    const state = getReviewCenterState(CHANGE_ID);
    const oldFinding = state.findings.find((finding) => finding.id === "FND-OLD-P1");

    assert.equal(state.latestValidReview?.runId, REVIEW_RUN_ID);
    assert.equal(state.gate.status, "blocked_p1");
    assert.equal(state.actions.canEnterQa, false);
    assert.equal(oldFinding?.isNotRechecked, true);
  });

  it("blocks on legacy incomplete open P1 findings and marks them in the view", () => {
    seedReviewRun({ summary: reviewSummary({ reviewStatus: "issues_found", findingCount: 1 }) });
    seedFinding({
      id: "FND-LEGACY-P1",
      severity: "P1",
      requiredFix: null,
    });

    const state = getReviewCenterState(CHANGE_ID);

    assert.equal(state.gate.status, "blocked_p1");
    assert.equal(state.actions.canEnterQa, false);
    assert.equal(state.findings[0]?.id, "FND-LEGACY-P1");
    assert.equal(state.findings[0]?.isLegacyIncomplete, true);
  });

  it("sanitizes absolute finding file paths in the public ReviewCenter DTO", () => {
    seedReviewRun({ summary: reviewSummary({ reviewStatus: "issues_found", findingCount: 2 }) });
    seedFinding({
      id: "FND-ABS-USER",
      severity: "P1",
      file: "/Users/alice/private/repo/src/secret.ts",
    });
    seedFinding({
      id: "FND-ABS-TMP",
      severity: "P2",
      file: "/tmp/review-output/private-log.txt",
    });

    const state = getReviewCenterState(CHANGE_ID);
    const userPathFinding = state.findings.find((finding) => finding.id === "FND-ABS-USER");
    const tmpPathFinding = state.findings.find((finding) => finding.id === "FND-ABS-TMP");
    const serialized = JSON.stringify(state.findings);

    assert.equal(userPathFinding?.file, "secret.ts");
    assert.equal(tmpPathFinding?.file, "private-log.txt");
    assert.doesNotMatch(serialized, /\/Users\//);
    assert.doesNotMatch(serialized, /\/tmp\//);
  });

  it("returns the public ReviewCenter DTO without default path or raw output leakage", () => {
    seedArtifact({
      id: "ART-RAW-1",
      type: "review_raw_output",
      filePath: "/absolute/private/raw-output.json",
    });
    seedReviewAttempt({
      id: "RAT-DB-1",
      attemptNo: 3,
      reviewStatus: "invalid_output",
      rawOutputArtifactId: "ART-RAW-1",
      errorCode: "provider_raw_error",
      sanitizedErrorSummary: "Provider failed after validation.",
    });
    seedReviewAttempt({ id: "RAT-DB-2", attemptNo: 2, reviewStatus: "passed" });
    seedReviewReport({
      id: "RRP-DB-2",
      attemptId: "RAT-DB-2",
      gateStatus: "passed",
      qaAllowed: true,
      p2Count: 1,
    });
    seedMirror({
      id: "RAM-1",
      reportId: "RRP-DB-2",
      artifactId: "ART-REPORT-1",
      kind: "review_report",
      status: "mismatch",
      artifactHash: "artifact-hash-1",
    });
    seedReviewState({
      latestAttemptId: "RAT-DB-1",
      latestAttemptNo: 3,
      latestValidReviewReportId: "RRP-DB-2",
      latestValidAttemptNo: 2,
      gateStatus: "passed",
      reviewStatus: "passed",
      sourceBuildRunId: "build-1",
      sourceHeadSha: "a".repeat(40),
      reportDbHash: "hash-RRP-DB-2",
    });

    const state = getReviewCenterState(CHANGE_ID);
    const serialized = JSON.stringify(state);

    assert.equal(state.headlineStatus, "passed");
    assert.equal(state.qaAllowed, true);
    assert.deepEqual(state.counts, { p0: 0, p1: 0, p2: 1, waived: 0 });
    assert.equal(state.latestAttempt?.reportPath, null);
    assert.equal(state.latestAttempt?.findingsPath, null);
    assert.equal(state.latestAttempt?.rawOutputPath, null);
    assert.equal(state.advancedDetails.latestAttempt?.rawOutputArtifact?.id, "ART-RAW-1");
    assert.equal(state.advancedDetails.latestAttempt?.rawOutputArtifact?.path, null);
    assert.equal(state.advancedDetails.latestAttempt?.sanitizedErrorSummary, "Provider failed after validation.");
    assert.equal(state.advancedDetails.latestValidReview?.reportArtifactId, "ART-REPORT-1");
    assert.equal("sourceHeadSha" in state.advancedDetails.latestAttempt!, false);
    assert.equal("sourceHeadSha" in state.advancedDetails.latestValidReview!, false);
    assert.equal(state.advancedDetails.latestValidReview?.reportDbHash, "hash-RRP-DB-2");
    assert.equal(state.advancedDetails.latestValidReview?.mirrors[0]?.status, "mismatch");
    assert.equal(state.advancedDetails.latestValidReview?.mirrors[0]?.path, null);
    assert.equal(state.advancedDetails.latestValidReview?.mirrors[0]?.contentHash, "content-hash");
    assert.equal(state.advancedDetails.latestValidReview?.mirrors[0]?.artifactHash, "artifact-hash-1");
    assert.deepEqual(state.mirrorWarnings, [
      {
        artifactId: "ART-REPORT-1",
        kind: "review_report",
        reason: "mismatch",
        status: "mismatch",
      },
    ]);
    assert.doesNotMatch(serialized, /\/absolute\/private/);
    assert.doesNotMatch(serialized, /\/absolute\/secret/);
    assert.doesNotMatch(serialized, /raw-output\.json/);
  });

  it("exposes stable ReviewCenter action ids with idempotency metadata while keeping legacy booleans", () => {
    seedReviewAttempt({ id: "RAT-DB-1", attemptNo: 1, reviewStatus: "passed" });
    seedReviewReport({
      id: "RRP-DB-1",
      attemptId: "RAT-DB-1",
      gateStatus: "passed",
      qaAllowed: true,
    });
    seedReviewState({
      latestAttemptId: "RAT-DB-1",
      latestAttemptNo: 1,
      latestValidReviewReportId: "RRP-DB-1",
      latestValidAttemptNo: 1,
      gateStatus: "passed",
      reviewStatus: "passed",
      sourceBuildRunId: "build-1",
      sourceHeadSha: "a".repeat(40),
      reportDbHash: "hash-RRP-DB-1",
    });

    const state = getReviewCenterState(CHANGE_ID);

    assert.deepEqual(Object.keys(state.actions).filter((key) => key.includes("_")).sort(), [
      "enter_qa",
      "fix_blockers",
      "rebuild_mirror",
      "recompute_report",
      "retry_review",
      "run_review",
      "stop_change",
      "waive_p1",
    ]);
    assert.equal(state.actions.run_review.id, "run_review");
    assert.equal(state.actions.run_review.idempotencyRequired, true);
    assert.equal(state.actions.recompute_report.enabled, true);
    assert.equal(state.actions.recompute_report.idempotencyRequired, true);
    assert.equal(state.actions.rebuild_mirror.enabled, true);
    assert.equal(state.actions.enter_qa.enabled, true);
    assert.equal(state.actions.canEnterQa, true);
  });

  it("lists waived P1 review findings with decision reason but without internal paths", () => {
    seedReviewAttempt({ id: "RAT-DB-1", attemptNo: 1, reviewStatus: "passed" });
    seedReviewReport({
      id: "RRP-DB-1",
      attemptId: "RAT-DB-1",
      gateStatus: "passed_with_waived_p1",
      qaAllowed: true,
      waivedP1: 1,
    });
    seedReviewState({
      latestAttemptId: "RAT-DB-1",
      latestAttemptNo: 1,
      latestValidReviewReportId: "RRP-DB-1",
      latestValidAttemptNo: 1,
      gateStatus: "passed_with_waived_p1",
      reviewStatus: "passed",
      sourceBuildRunId: "build-1",
      sourceHeadSha: "a".repeat(40),
      reportDbHash: "hash-RRP-DB-1",
    });
    seedHumanDecision({ id: "HD-WAIVER-1", reason: "Accepted for this release." });
    seedFinding({
      id: "FND-WAIVED-P1",
      runId: null,
      reviewAttemptId: "RAT-DB-1",
      severity: "P1",
      status: "waived",
      waiverDecisionId: "HD-WAIVER-1",
    });

    const state = getReviewCenterState(CHANGE_ID);

    assert.deepEqual(state.counts, { p0: 0, p1: 0, p2: 0, waived: 1 });
    assert.deepEqual(state.waivers, [
      {
        findingId: "FND-WAIVED-P1",
        title: "P1 finding",
        severity: "P1",
        reason: "Accepted for this release.",
        decisionId: "HD-WAIVER-1",
      },
    ]);
    assert.doesNotMatch(JSON.stringify(state.waivers), /\//);
  });
});

describe("review-center-service injectable connection", { concurrency: false }, () => {
  const SEAM_PROJECT_ID = "PRJ-REVIEW-CENTER-SEAM";
  const SEAM_CHANGE_ID = "CHG-REVIEW-CENTER-SEAM";

  function createTestDb(): ReviewCenterDb {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = OFF");
    runMigrations(sqlite);
    return drizzle(sqlite, { schema: dbSchema }) as unknown as ReviewCenterDb;
  }

  function seedSeamChange(database: ReviewCenterDb): void {
    const now = "2026-07-15T00:00:00.000Z";
    database
      .insert(projects)
      .values({
        id: SEAM_PROJECT_ID,
        name: "Review Center Seam",
        repoPath: "/tmp/review-center-seam",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    database
      .insert(changes)
      .values({
        id: SEAM_CHANGE_ID,
        projectId: SEAM_PROJECT_ID,
        title: "Review center seam",
        status: "IMPLEMENTED",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  it("reads Review center state from the injected db, not the global singleton", () => {
    const seamDb = createTestDb();
    seedSeamChange(seamDb);

    const restore = setReviewCenterServiceDbForTest(seamDb);
    try {
      // The change exists only in the injected db. Resolving the module-global
      // singleton -- which has no such change -- would throw "Change not found",
      // so a settled not_started state proves the read routed through the
      // injected connection.
      const state = getReviewCenterState(SEAM_CHANGE_ID);
      assert.equal(state.headlineStatus, "not_started");
      assert.equal(state.qaAllowed, false);
    } finally {
      restore();
    }

    // With the seam reverted, the same call reads the global singleton, where
    // SEAM_CHANGE_ID does not exist at all.
    assert.throws(() => getReviewCenterState(SEAM_CHANGE_ID), /Change not found/);
  });
});
