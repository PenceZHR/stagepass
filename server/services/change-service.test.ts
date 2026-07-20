import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "../db/index.ts";
import {
  artifactMirrors,
  artifacts,
  changeProviderSessions,
  changes,
  projects,
  qaCommandResults,
  qaEvidence,
  qaRuns,
  reviewArtifactMirrors,
  reviewAttempts,
  reviewReports,
  runs,
} from "../db/schema.ts";
import { deleteChange, deleteChangeRecords } from "./change-service.ts";

const PROJECT_ID = "PRJ-CHANGE-DELETE-SESSIONS";
const CHANGE_ID = "CHG-CHANGE-DELETE-SESSIONS";
const RUN_ID = "RUN-CHANGE-DELETE-SESSIONS";
const NOW = "2026-07-13T00:00:00.000Z";

const ARTIFACT_ID = "ART-CHANGE-DELETE-SESSIONS";
const ARTIFACT_MIRROR_ID = "AMR-CHANGE-DELETE-SESSIONS";
const REVIEW_ATTEMPT_ID = "RVA-CHANGE-DELETE-SESSIONS";
const REVIEW_REPORT_ID = "RVR-CHANGE-DELETE-SESSIONS";
const REVIEW_ARTIFACT_MIRROR_ID = "RAM-CHANGE-DELETE-SESSIONS";
const QA_RUN_ID = "QAR-CHANGE-DELETE-SESSIONS";

// Deletes every table the fixtures below touch, child rows before the rows they
// reference. Kept independent of change-service so a broken cascade fails the
// test it belongs to instead of poisoning the whole file's teardown.
function cleanupRows(): void {
  db.delete(reviewArtifactMirrors)
    .where(eq(reviewArtifactMirrors.changeId, CHANGE_ID))
    .run();
  db.delete(qaEvidence).where(eq(qaEvidence.qaRunId, QA_RUN_ID)).run();
  db.delete(qaCommandResults).where(eq(qaCommandResults.qaRunId, QA_RUN_ID)).run();
  db.delete(qaRuns).where(eq(qaRuns.changeId, CHANGE_ID)).run();
  db.delete(reviewReports).where(eq(reviewReports.changeId, CHANGE_ID)).run();
  db.delete(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).run();
  db.delete(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
  db.delete(changeProviderSessions)
    .where(eq(changeProviderSessions.changeId, CHANGE_ID))
    .run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(): void {
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Change deletion sessions",
    repoPath: process.cwd(),
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
    title: "Delete provider sessions with change",
    status: "DONE",
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

// Seeds the FK edges the hand-written cascade is most likely to trip over: the
// QA rows that point at artifact_mirrors, and the review mirror rows that point
// at review_reports and artifacts.
function seedFullyPopulatedChange(): void {
  db.insert(runs).values({
    id: RUN_ID,
    changeId: CHANGE_ID,
    phase: "review",
    status: "completed",
    startedAt: NOW,
    endedAt: NOW,
    provider: "codex",
  }).run();
  db.insert(artifacts).values({
    id: ARTIFACT_ID,
    changeId: CHANGE_ID,
    runId: RUN_ID,
    type: "stage_raw_output",
    path: ".ship/changes/CHG/raw.json",
    createdAt: NOW,
  }).run();
  db.insert(artifactMirrors).values({
    id: ARTIFACT_MIRROR_ID,
    changeId: CHANGE_ID,
    phase: "QA",
    artifactType: "qa_command_output",
    path: ".ship/changes/CHG/qa/cmd-1.log",
    contentHash: "sha256:qa-command-output",
    sourceDbHash: "qa-source-db-hash",
    schemaVersion: "qa/v1",
    mirrorStatus: "fresh",
    generatedAt: NOW,
  }).run();
  db.insert(reviewAttempts).values({
    id: REVIEW_ATTEMPT_ID,
    changeId: CHANGE_ID,
    runId: RUN_ID,
    attemptNo: 1,
    status: "completed",
    provider: "codex",
    reviewStatus: "passed",
    idempotencyKey: "review-1",
    rawOutputArtifactId: ARTIFACT_ID,
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(reviewReports).values({
    id: REVIEW_REPORT_ID,
    attemptId: REVIEW_ATTEMPT_ID,
    changeId: CHANGE_ID,
    reportVersion: 1,
    reportDbHash: "review-report-db-hash",
    gateStatus: "passed",
    qaAllowed: 1,
    generatedAt: NOW,
    createdAt: NOW,
  }).run();
  db.insert(reviewArtifactMirrors).values({
    id: REVIEW_ARTIFACT_MIRROR_ID,
    reportId: REVIEW_REPORT_ID,
    changeId: CHANGE_ID,
    artifactId: ARTIFACT_ID,
    kind: "review_report",
    path: ".ship/changes/CHG/review/report.json",
    createdAt: NOW,
  }).run();
  db.insert(qaRuns).values({
    id: QA_RUN_ID,
    changeId: CHANGE_ID,
    sourceReviewReportId: REVIEW_REPORT_ID,
    status: "passed",
    startedAt: NOW,
    completedAt: NOW,
  }).run();
  db.insert(qaCommandResults).values({
    id: "QAC-CHANGE-DELETE-SESSIONS",
    qaRunId: QA_RUN_ID,
    command: "pnpm test",
    commandOrder: 1,
    status: "passed",
    exitCode: 0,
    outputArtifactMirrorId: ARTIFACT_MIRROR_ID,
    completedAt: NOW,
  }).run();
  db.insert(qaEvidence).values({
    id: "QAE-CHANGE-DELETE-SESSIONS",
    qaRunId: QA_RUN_ID,
    evidenceType: "command_output",
    artifactMirrorId: ARTIFACT_MIRROR_ID,
    contentHash: "sha256:qa-command-output",
    createdAt: NOW,
  }).run();
}

beforeEach(() => {
  cleanupRows();
  seedChange();
});

afterEach(cleanupRows);

describe("change deletion provider sessions", () => {
  it("deletes provider sessions before their referenced runs", () => {
    db.insert(runs).values({
      id: RUN_ID,
      changeId: CHANGE_ID,
      phase: "spec",
      status: "failed",
      startedAt: NOW,
      endedAt: NOW,
      provider: "codex",
    }).run();
    db.insert(changeProviderSessions).values({
      changeId: CHANGE_ID,
      provider: "codex",
      sessionKind: "general",
      externalSessionId: "codex-session",
      lastRunId: RUN_ID,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();

    deleteChangeRecords(CHANGE_ID);

    assert.equal(
      db.select().from(changeProviderSessions).where(eq(changeProviderSessions.changeId, CHANGE_ID)).all().length,
      0,
    );
    assert.equal(db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all().length, 0);
  });

  it("deletes a change that has provider sessions", async () => {
    db.insert(changeProviderSessions).values({
      changeId: CHANGE_ID,
      provider: "claude",
      sessionKind: "general",
      externalSessionId: "claude-session",
      lastRunId: null,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();

    await deleteChange(CHANGE_ID);

    assert.equal(db.select().from(changeProviderSessions).where(eq(changeProviderSessions.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).all().length, 0);
  });
});

describe("change deletion cascade", () => {
  it("deletes a fully populated change without tripping a foreign key constraint", async () => {
    seedFullyPopulatedChange();

    await deleteChange(CHANGE_ID);

    assert.equal(db.select().from(qaEvidence).where(eq(qaEvidence.qaRunId, QA_RUN_ID)).all().length, 0);
    assert.equal(
      db.select().from(qaCommandResults).where(eq(qaCommandResults.qaRunId, QA_RUN_ID)).all().length,
      0,
    );
    assert.equal(db.select().from(qaRuns).where(eq(qaRuns.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(
      db.select().from(reviewArtifactMirrors).where(eq(reviewArtifactMirrors.changeId, CHANGE_ID)).all().length,
      0,
    );
    assert.equal(
      db.select().from(reviewReports).where(eq(reviewReports.changeId, CHANGE_ID)).all().length,
      0,
    );
    assert.equal(
      db.select().from(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).all().length,
      0,
    );
    assert.equal(
      db.select().from(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).all().length,
      0,
    );
    assert.equal(db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).all().length, 0);
  });
});
