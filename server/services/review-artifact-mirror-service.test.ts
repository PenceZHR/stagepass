import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as schema from "../db/schema.ts";
import {
  inspectReviewMirrors,
  rebuildReviewMirrors,
  recordReviewMirrorFailure,
  setReviewArtifactMirrorServiceDbForTest,
} from "./review-artifact-mirror-service.ts";
import {
  assertCanEnterQa,
  setReviewQaGateDbForTest,
  setReviewQaGateHeadProbeForTest,
} from "./review-qa-gate-service.ts";

const PROJECT_ID = "PRJ-MIRROR";
const CHANGE_ID = "CHG-MIRROR";
const REPORT_ID = "RRP-1";
const ATTEMPT_ID = "RAT-1";
const HEAD = "a".repeat(40);

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
    CREATE TABLE runs (
      id TEXT PRIMARY KEY NOT NULL,
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
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT NOT NULL,
      run_id TEXT,
      type TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
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
  `);
  return drizzle(sqlite, { schema });
}

function nowISO(): string {
  return new Date().toISOString();
}

function seedAllowedReview(db: ReturnType<typeof createTestDb>, repoPath: string) {
  const now = nowISO();
  db.insert(schema.projects).values({
    id: PROJECT_ID,
    name: "Mirror",
    repoPath,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(schema.changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Mirror review",
    status: "IMPLEMENTED",
    provider: "codex",
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(schema.runs).values({
    id: "RUN-1",
    changeId: CHANGE_ID,
    phase: "review",
    status: "completed",
    startedAt: now,
    endedAt: now,
    summary: "review",
  }).run();
  db.insert(schema.artifacts).values({
    id: "ART-RAW",
    changeId: CHANGE_ID,
    runId: "RUN-1",
    type: "raw_review_output",
    path: path.join(repoPath, ".ship", "changes", CHANGE_ID, "runs", "RUN-1", "raw-review-output.json"),
    createdAt: now,
  }).run();
  db.insert(schema.buildRunRecords).values({
    id: "BR-1",
    changeId: CHANGE_ID,
    runId: null,
    buildRunId: "build-1",
    status: "adopted",
    headSha: HEAD,
    adoptedAt: "2026-06-29T01:00:00.000Z",
    artifactHash: null,
    source: "test",
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(schema.reviewAttempts).values({
    id: ATTEMPT_ID,
    changeId: CHANGE_ID,
    runId: "RUN-1",
    attemptNo: 1,
    status: "completed",
    provider: "codex",
    reviewStatus: "passed",
    idempotencyKey: "review-1",
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD,
    priorBlockingFindingIdsJson: JSON.stringify([]),
    rawOutputArtifactId: "ART-RAW",
    startedAt: now,
    endedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(schema.reviewReports).values({
    id: REPORT_ID,
    attemptId: ATTEMPT_ID,
    changeId: CHANGE_ID,
    reportVersion: 1,
    reviewConclusion: "passed",
    reportDbHash: "report-db-hash",
    gateStatus: "passed",
    qaAllowed: 1,
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD,
    findingVersion: 1,
    waiverVersion: 1,
    blockingP0: 0,
    blockingP1: 0,
    waivedP1: 0,
    p2Count: 0,
    findingsDbHash: "findings-db-hash",
    staleReason: null,
    legacyState: null,
    reportJson: null,
    generatedAt: now,
    createdAt: now,
  }).run();
  db.insert(schema.reviewState).values({
    changeId: CHANGE_ID,
    latestAttemptId: ATTEMPT_ID,
    latestAttemptNo: 1,
    latestReportId: REPORT_ID,
    latestValidReviewReportId: REPORT_ID,
    latestValidAttemptNo: 1,
    gateStatus: "passed",
    reviewStatus: "passed",
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD,
    reportDbHash: "report-db-hash",
    findingVersion: 1,
    waiverVersion: 1,
    updatedAt: now,
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

describe("review-artifact-mirror-service", { concurrency: false }, () => {
  let db: ReturnType<typeof createTestDb>;
  let repoPath: string;
  let restoreMirrorDb: (() => void) | null = null;
  let restoreGateDb: (() => void) | null = null;
  let restoreHeadProbe: (() => void) | null = null;

  beforeEach(() => {
    try {
      db = createTestDb();
      repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "review-mirror-"));
      seedAllowedReview(db, repoPath);
    } catch (error) {
      throw new Error(`review mirror fixture setup failed: ${(error as Error).message}`);
    }
    restoreMirrorDb = setReviewArtifactMirrorServiceDbForTest(db);
    restoreGateDb = setReviewQaGateDbForTest(db);
    restoreHeadProbe = setReviewQaGateHeadProbeForTest(() => HEAD);
  });

  afterEach(() => {
    restoreHeadProbe?.();
    restoreHeadProbe = null;
    restoreGateDb?.();
    restoreGateDb = null;
    restoreMirrorDb?.();
    restoreMirrorDb = null;
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("reports missing mirrors as advanced warnings without blocking QA", () => {
    const inspection = inspectReviewMirrors(REPORT_ID);
    const gate = assertCanEnterQa(gateInput());

    assert.equal(gate.allowed, true);
    assert.deepEqual(
      inspection.mirrors.map((mirror) => [mirror.kind, mirror.status]),
      [
        ["review_report", "missing"],
        ["review_findings", "missing"],
      ],
    );
    assert.ok(inspection.warnings.includes("review_report:mirror_row_missing"));
    assert.equal(inspection.rawOutputArtifact?.id, "ART-RAW");
    assert.doesNotMatch(JSON.stringify(inspection.rawOutputArtifact), /raw-review-output content/);
  });

  it("detects mismatched mirror files and rebuilds them from DB without changing gate state", () => {
    const rebuilt = rebuildReviewMirrors(REPORT_ID);
    assert.deepEqual(rebuilt.mirrors.map((mirror) => mirror.status), ["ok", "ok"]);

    // Mirrors live in their own directory, apart from the Review stage's
    // post-commit artifacts that share these file names.
    const reportPath = path.join(repoPath, ".ship", "changes", CHANGE_ID, "mirrors", "review-report.md");
    fs.writeFileSync(reportPath, "# tampered\n", "utf-8");

    const mismatch = inspectReviewMirrors(REPORT_ID);
    assert.equal(assertCanEnterQa(gateInput()).allowed, true);
    assert.equal(mismatch.mirrors.find((mirror) => mirror.kind === "review_report")?.status, "mismatch");

    const beforeAttempt = db.select().from(schema.reviewAttempts).where(eq(schema.reviewAttempts.id, ATTEMPT_ID)).get();
    const beforeReport = db.select().from(schema.reviewReports).where(eq(schema.reviewReports.id, REPORT_ID)).get();
    const fixed = rebuildReviewMirrors(REPORT_ID);
    const afterAttempt = db.select().from(schema.reviewAttempts).where(eq(schema.reviewAttempts.id, ATTEMPT_ID)).get();
    const afterReport = db.select().from(schema.reviewReports).where(eq(schema.reviewReports.id, REPORT_ID)).get();

    assert.deepEqual(fixed.mirrors.map((mirror) => mirror.status), ["ok", "ok"]);
    assert.deepEqual(afterAttempt, beforeAttempt);
    assert.deepEqual(afterReport, beforeReport);
  });

  it("keeps generation_failed mirror status non-blocking", () => {
    recordReviewMirrorFailure(REPORT_ID, "review_report", new Error("disk_full"));

    const inspection = inspectReviewMirrors(REPORT_ID);
    const mirror = db
      .select()
      .from(schema.reviewArtifactMirrors)
      .where(eq(schema.reviewArtifactMirrors.kind, "review_report"))
      .get();

    assert.equal(mirror?.mirrorStatus, "generation_failed");
    assert.equal(inspection.mirrors.find((item) => item.kind === "review_report")?.status, "generation_failed");
    assert.equal(assertCanEnterQa(gateInput()).allowed, true);
  });
});
