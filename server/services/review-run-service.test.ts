import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";

import { runMigrations } from "../db/migrate.ts";
import * as schema from "../db/schema.ts";
import {
  artifacts,
  apiSnapshots,
  buildRunRecords,
  changes,
  findings,
  planSnapshots,
  projects,
  requiredValidationCommands,
  reviewAttempts,
  reviewPriorFindingReviews,
  techspecSnapshots,
  testplanSnapshots,
} from "../db/schema.ts";
import {
  buildReviewInputSnapshot,
  completeReviewAttempt,
  failReviewAttempt,
  recordInvalidReviewOutput,
  setReviewRunServiceDbForTest,
  startReviewRun,
} from "./review-run-service.ts";

const PROJECT_ID = "PRJ-RUN-SERVICE";
const CHANGE_ID = "CHG-RUN-SERVICE";

function seedChange(db: ReturnType<typeof drizzle>) {
  const now = "2026-06-29T00:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Review run service",
    repoPath: "/tmp/review-run-service",
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
    title: "Review attempt lifecycle",
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

function writeTamperedReviewMirrors(repoPath: string) {
  const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
  fs.mkdirSync(path.join(changeDir, "runs", "RUN-TAMPER"), { recursive: true });
  fs.writeFileSync(path.join(changeDir, "tech-spec-delta.md"), "TAMPERED TECHSPEC MIRROR\n");
  fs.writeFileSync(path.join(changeDir, "api-spec-delta.md"), "TAMPERED API MIRROR\n");
  fs.writeFileSync(path.join(changeDir, "review-report.md"), "# Review Passed\n\nTAMPERED\n");
  fs.writeFileSync(path.join(changeDir, "review-findings.json"), "[]\n");
  fs.writeFileSync(path.join(changeDir, "runs", "RUN-TAMPER", "review-report.md"), "TAMPERED RUN REPORT\n");
}

function insertReviewFinding(
  db: ReturnType<typeof drizzle>,
  values: { id: string; severity: string; status?: string; source?: string },
) {
  const now = "2026-06-29T00:00:00.000Z";
  db.insert(findings).values({
    id: values.id,
    changeId: CHANGE_ID,
    runId: null,
    source: values.source ?? "review",
    severity: values.severity,
    category: "bug",
    title: values.id,
    file: null,
    line: null,
    evidence: "Existing blocker evidence.",
    requiredFix: "Fix the existing blocker.",
    status: values.status ?? "open",
    createdAt: now,
    updatedAt: now,
  }).run();
}

function seedReviewInputDbSnapshots(db: ReturnType<typeof drizzle>) {
  const now = "2026-06-29T00:00:00.000Z";
  db.insert(buildRunRecords).values({
    id: "BR-OLD",
    changeId: CHANGE_ID,
    runId: null,
    buildRunId: "build-old",
    status: "adopted",
    headSha: "old-head",
    baseHeadSha: "base-old",
    baseCommit: "base-old",
    patchHash: "patch-old",
    changedFilesHash: "files-old",
    adoptedHeadSha: "old-head",
    adoptionDecisionId: "DEC-OLD",
    adoptedAt: "2026-06-29T00:30:00.000Z",
    artifactHash: "artifact-old",
    source: "test",
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(buildRunRecords).values({
    id: "BR-LATEST",
    changeId: CHANGE_ID,
    runId: null,
    buildRunId: "build-latest",
    status: "adopted",
    headSha: "latest-head",
    baseHeadSha: "base-latest",
    baseCommit: "base-latest",
    patchHash: "patch-latest",
    changedFilesHash: "files-latest",
    adoptedHeadSha: "latest-head",
    adoptionDecisionId: "DEC-LATEST",
    adoptedAt: "2026-06-29T01:00:00.000Z",
    artifactHash: "artifact-latest",
    source: "test",
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(planSnapshots).values({
    id: "PLAN-SNAP-1",
    changeId: CHANGE_ID,
    status: "approved",
    planName: "DB plan",
    sourceSpecHash: "spec-hash",
    expectedFilesJson: JSON.stringify(["server/app.ts"]),
    forbiddenFilesJson: JSON.stringify([".env"]),
    validationPolicyHash: "validation-hash",
    approvedAt: "2026-06-29T00:10:00.000Z",
    approvalDecisionId: null,
    snapshotDbHash: "plan-db-hash",
    createdAt: now,
  }).run();
  db.insert(requiredValidationCommands).values({
    id: "VAL-CMD-1",
    changeId: CHANGE_ID,
    phase: "Plan",
    sourceSnapshotId: "PLAN-SNAP-1",
    command: "npm test",
    commandOrder: 1,
    required: 1,
    createdAt: now,
  }).run();
  db.insert(testplanSnapshots).values({
    id: "TPL-SNAP-1",
    changeId: CHANGE_ID,
    status: "approved",
    testIntent: "Exercise DB-first review inputs",
    schemaVersion: "testplan/v1",
    approvalState: "approved",
    approvedAt: "2026-06-29T00:20:00.000Z",
    approvalDecisionId: null,
    snapshotDbHash: "testplan-db-hash",
    createdAt: now,
  }).run();
  db.insert(requiredValidationCommands).values({
    id: "VAL-CMD-2",
    changeId: CHANGE_ID,
    phase: "TestPlan",
    sourceSnapshotId: "TPL-SNAP-1",
    command: "tsx --test server/services/review-run-service.test.ts",
    commandOrder: 1,
    required: 1,
    createdAt: now,
  }).run();
  db.insert(techspecSnapshots).values({
    id: "TECHSPEC-1",
    changeId: CHANGE_ID,
    status: "approved",
    sourceSpecHash: "spec-hash",
    contentJson: JSON.stringify({
      interfaces: [],
      dataContracts: [],
      migrationNotes: [],
      buildInputs: [],
      reviewInputs: [{ source: "db" }],
    }),
    contentDbHash: "techspec-db-hash",
    schemaVersion: "techspec/v1",
    reviewedAt: now,
    createdAt: now,
  }).run();
  db.insert(apiSnapshots).values({
    id: "API-1",
    changeId: CHANGE_ID,
    status: "approved",
    sourceTechspecHash: "techspec-db-hash",
    contractJson: JSON.stringify({
      interfaces: [],
      dataContracts: [],
      migrationNotes: [],
      buildInputs: [],
      reviewInputs: [{ source: "db-api" }],
    }),
    contractDbHash: "api-db-hash",
    schemaVersion: "api/v1",
    reviewedAt: now,
    createdAt: now,
  }).run();
}

describe("review-run-service", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;
  let restoreDb: (() => void) | null = null;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrations(sqlite);
    db = drizzle(sqlite, { schema });
    restoreDb = setReviewRunServiceDbForTest(db);
    seedChange(db);
  });

  afterEach(() => {
    restoreDb?.();
    sqlite.close();
  });

  it("creates review attempts with incrementing attempt numbers", () => {
    const first = startReviewRun({ changeId: CHANGE_ID, idempotencyKey: "key-1" });
    completeReviewAttempt({ attemptId: first.attempt.id, reviewStatus: "passed" });

    const second = startReviewRun({ changeId: CHANGE_ID, idempotencyKey: "key-2" });

    assert.equal(first.started, true);
    assert.equal(first.attempt.attemptNo, 1);
    assert.equal(second.started, true);
    assert.equal(second.attempt.attemptNo, 2);
  });

  it("returns the same running attempt for a repeated idempotency key", () => {
    const first = startReviewRun({ changeId: CHANGE_ID, idempotencyKey: "repeat-key" });
    const second = startReviewRun({ changeId: CHANGE_ID, idempotencyKey: "repeat-key" });

    assert.equal(second.started, false);
    assert.equal(second.resumed, true);
    assert.equal(second.attempt.id, first.attempt.id);
    assert.equal(db.select().from(reviewAttempts).all().length, 1);
  });

  it("does not create a second running attempt for a different idempotency key", () => {
    const first = startReviewRun({ changeId: CHANGE_ID, idempotencyKey: "key-1" });
    const second = startReviewRun({ changeId: CHANGE_ID, idempotencyKey: "key-2" });

    assert.equal(second.started, false);
    assert.equal(second.conflict, true);
    assert.equal(second.attempt.id, first.attempt.id);
    assert.equal(db.select().from(reviewAttempts).all().length, 1);
  });

  it("records provider failures on the running attempt", () => {
    const { attempt } = startReviewRun({ changeId: CHANGE_ID, idempotencyKey: "failure-key" });

    failReviewAttempt({
      attemptId: attempt.id,
      errorCode: "provider_auth_failed",
      sanitizedErrorSummary: "provider_auth_failed: [REDACTED]",
    });

    const row = db.select().from(reviewAttempts).where(eq(reviewAttempts.id, attempt.id)).get();
    assert.equal(row?.status, "failed");
    assert.equal(row?.reviewStatus, "failed");
    assert.equal(row?.errorCode, "provider_auth_failed");
    assert.equal(row?.sanitizedErrorSummary, "provider_auth_failed: [REDACTED]");
    assert.ok(row?.endedAt);
  });

  it("records invalid output with a raw output artifact reference", () => {
    const { attempt } = startReviewRun({ changeId: CHANGE_ID, idempotencyKey: "invalid-key" });
    db.insert(artifacts).values({
      id: "ART-RAW",
      changeId: CHANGE_ID,
      runId: null,
      type: "review_raw_output",
      path: "/tmp/raw-review-output.json",
      createdAt: "2026-06-29T00:00:00.000Z",
    }).run();

    recordInvalidReviewOutput({
      attemptId: attempt.id,
      rawOutputArtifactId: "ART-RAW",
      sanitizedErrorSummary: "invalid_review_output: missing structuredOutput",
    });

    const row = db.select().from(reviewAttempts).where(eq(reviewAttempts.id, attempt.id)).get();
    assert.equal(row?.status, "failed");
    assert.equal(row?.reviewStatus, "invalid_output");
    assert.equal(row?.errorCode, "invalid_review_output");
    assert.equal(row?.rawOutputArtifactId, "ART-RAW");
    assert.ok(row?.endedAt);
  });

  it("freezes open P0/P1 review blockers and creates pending prior reviews", () => {
    insertReviewFinding(db, { id: "FND-P0", severity: "P0" });
    insertReviewFinding(db, { id: "FND-P1", severity: "P1" });
    insertReviewFinding(db, { id: "FND-P2", severity: "P2" });
    insertReviewFinding(db, { id: "FND-CLOSED", severity: "P1", status: "fixed" });
    insertReviewFinding(db, { id: "FND-SCOPE", severity: "P1", source: "scope" });

    const { attempt } = startReviewRun({ changeId: CHANGE_ID, idempotencyKey: "blockers-key" });

    assert.deepEqual(JSON.parse(attempt.priorBlockingFindingIdsJson ?? "[]"), ["FND-P0", "FND-P1"]);
    const priorReviews = db
      .select()
      .from(reviewPriorFindingReviews)
      .where(eq(reviewPriorFindingReviews.attemptId, attempt.id))
      .all();
    assert.deepEqual(
      priorReviews.map((row) => ({ priorFindingId: row.priorFindingId, verdict: row.verdict })),
      [
        { priorFindingId: "FND-P0", verdict: "pending" },
        { priorFindingId: "FND-P1", verdict: "pending" },
      ],
    );
  });

  it("freezes a DB-only review input hash from latest adopted build and DB snapshots", () => {
    seedReviewInputDbSnapshots(db);
    insertReviewFinding(db, { id: "FND-P1", severity: "P1" });

    const first = startReviewRun({
      changeId: CHANGE_ID,
      idempotencyKey: "db-input-key",
      sourceBuildRunId: "caller-stale-build",
      sourceHeadSha: "caller-stale-head",
    }).attempt;

    completeReviewAttempt({ attemptId: first.id, reviewStatus: "issues_found" });
    const second = startReviewRun({
      changeId: CHANGE_ID,
      idempotencyKey: "db-input-key-2",
      sourceBuildRunId: "caller-stale-build-2",
      sourceHeadSha: "caller-stale-head-2",
    }).attempt;

    assert.equal(first.sourceBuildRunId, "build-latest");
    assert.equal(first.sourceHeadSha, "latest-head");
    assert.match(first.inputSourceDbHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(second.inputSourceDbHash, first.inputSourceDbHash);
    assert.deepEqual(JSON.parse(first.inputSourceLineageJson ?? "{}"), {
      latestApprovedBuildRun: {
        id: "BR-LATEST",
        buildRunId: "build-latest",
        headSha: "latest-head",
        patchHash: "patch-latest",
        changedFilesHash: "files-latest",
        adoptedHeadSha: "latest-head",
        adoptedAt: "2026-06-29T01:00:00.000Z",
        baseCommit: "base-latest",
        status: "adopted",
      },
      planSnapshot: { id: "PLAN-SNAP-1", snapshotDbHash: "plan-db-hash" },
      testPlanSnapshot: { id: "TPL-SNAP-1", snapshotDbHash: "testplan-db-hash" },
      techSpecSnapshot: { id: "TECHSPEC-1", contentDbHash: "techspec-db-hash" },
      apiSnapshot: { id: "API-1", contractDbHash: "api-db-hash" },
      historicalFindingIds: ["FND-P1"],
    });
  });

  it("keeps the review input hash stable when .ship review and design mirrors are tampered", () => {
    seedReviewInputDbSnapshots(db);
    insertReviewFinding(db, { id: "FND-P1", severity: "P1" });
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "review-run-mirror-tamper-"));
    db.update(projects).set({ repoPath }).where(eq(projects.id, PROJECT_ID)).run();

    const first = startReviewRun({
      changeId: CHANGE_ID,
      idempotencyKey: "mirror-tamper-before",
    }).attempt;
    completeReviewAttempt({ attemptId: first.id, reviewStatus: "issues_found" });

    try {
      writeTamperedReviewMirrors(repoPath);

      const second = startReviewRun({
        changeId: CHANGE_ID,
        idempotencyKey: "mirror-tamper-after",
      }).attempt;

      assert.equal(second.inputSourceDbHash, first.inputSourceDbHash);
      assert.doesNotMatch(second.inputSourceLineageJson ?? "", /TAMPERED/);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("keeps the frozen review input hash stable when settlement updates prior findings and adds output findings", () => {
    seedReviewInputDbSnapshots(db);
    insertReviewFinding(db, { id: "FND-P1", severity: "P1" });

    const before = buildReviewInputSnapshot(db, CHANGE_ID, ["FND-P1"]);

    db.update(findings)
      .set({
        status: "fixed",
        updatedAt: "2026-06-29T02:00:00.000Z",
      })
      .where(eq(findings.id, "FND-P1"))
      .run();
    insertReviewFinding(db, { id: "FND-P2-OUTPUT", severity: "P2" });

    const after = buildReviewInputSnapshot(db, CHANGE_ID, ["FND-P1"]);

    assert.equal(after.inputSourceDbHash, before.inputSourceDbHash);
  });

  it("rolls back the running attempt when pending prior reviews cannot be inserted", () => {
    insertReviewFinding(db, { id: "FND-P1", severity: "P1" });
    sqlite.exec(`
      CREATE TRIGGER fail_pending_prior_review
      BEFORE INSERT ON review_prior_finding_reviews
      WHEN NEW.prior_finding_id = 'FND-P1'
      BEGIN
        SELECT RAISE(ABORT, 'forced pending prior review insert failure');
      END;
    `);

    assert.throws(
      () => startReviewRun({ changeId: CHANGE_ID, idempotencyKey: "rollback-key" }),
      /forced pending prior review insert failure/,
    );

    assert.equal(
      db.select().from(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).all().length,
      0,
    );
    assert.equal(db.select().from(reviewPriorFindingReviews).all().length, 0);
  });
});
