import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import * as dbSchema from "../db/schema.ts";
import {
  battleRounds,
  artifacts,
  briefingQuestions,
  buildRunRecords,
  changes,
  events,
  findings,
  humanDecisions,
  mergeApprovals,
  mergeBlockers,
  mergeDecisions,
  mergeReadiness,
  pipelineJobs,
  prdBriefings,
  prdDrafts,
  projects,
  qaCommandResults,
  qaEvidence,
  qaFailures,
  qaRuns,
  releaseNoteState,
  requiredValidationCommands,
  reviewAttempts,
  reviewReports,
  reviewState,
  runs,
  stageActions,
  stageGates,
  stageRuns,
  stageStates,
  testplanCoverageItems,
  testplanManualChecks,
  testplanRiskMappings,
  testplanSnapshots,
} from "../db/schema.ts";
import {
  actionContractRepository,
  setActionContractRepositoryDbForTest,
} from "../repositories/action-contract-repository.ts";
import { computeActions, getActions } from "./action-contract-service.ts";
import { stageProgressRawJson } from "./stage-progress-service.ts";
import { resolveRetroActionAuthority } from "./provider-action-authority-service.ts";
import { prdBriefingInputHash } from "./prd-briefing-ledger.ts";
import {
  assertCanStartPrdBriefingFinalReview,
  assertCanStartPrdBriefingQuestions,
  PrdBriefingError,
} from "./prd-briefing-service.ts";
import {
  setMergeReadinessDirtyProbeForTest,
  setMergeReadinessHeadProbeForTest,
} from "./merge-readiness-service.ts";
import { assertActionAllowed, PreflightBlockedError } from "./preflight-service.ts";
import { setReviewQaGateHeadProbeForTest } from "./review-qa-gate-service.ts";
import { writeBuildRun, type BuildRunFile } from "./build-workspace-service.ts";
import {
  setBuildProviderLivenessForTest,
  setBuildStaleRunClockForTest,
} from "./build-stale-run-recovery-service.ts";
import type { PipelinePhase } from "./stage-authority-service.ts";
import { computeSourceDbHash } from "./stage-authority-service.ts";
import { recomputeReviewReport } from "./review-report-service.ts";
import { buildReviewInputSnapshot } from "./review-run-service.ts";
import type { StageAiOutputErrorCode, StageProgressStatus } from "./stage-ai-output-contract.ts";
import { latestStageOutputSignal } from "./action-contract-stage-signal-policy.ts";

const PROJECT_ID = "PRJ-ACTION-CONTRACT-T3";
const CHANGE_ID = "CHG-ACTION-CONTRACT-T3";
const HEAD_SHA = "b".repeat(40);

function createActionContractRepositoryTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  runMigrations(sqlite);
  return drizzle(sqlite, { schema: dbSchema });
}

function cleanupRows() {
  const readinessRows = db
    .select()
    .from(mergeReadiness)
    .where(eq(mergeReadiness.changeId, CHANGE_ID))
    .all();
  for (const readiness of readinessRows) {
    db.delete(mergeBlockers).where(eq(mergeBlockers.mergeReadinessId, readiness.id)).run();
    db.delete(mergeDecisions).where(eq(mergeDecisions.readinessId, readiness.id)).run();
  }
  db.delete(mergeReadiness).where(eq(mergeReadiness.changeId, CHANGE_ID)).run();
  db.delete(mergeApprovals).where(eq(mergeApprovals.changeId, CHANGE_ID)).run();
  db.delete(stageActions).where(eq(stageActions.changeId, CHANGE_ID)).run();
  db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).run();
  db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
  const qaRunRows = db
    .select({ id: qaRuns.id })
    .from(qaRuns)
    .where(eq(qaRuns.changeId, CHANGE_ID))
    .all();
  for (const qaRun of qaRunRows) {
    db.delete(qaEvidence).where(eq(qaEvidence.qaRunId, qaRun.id)).run();
    db.delete(qaFailures).where(eq(qaFailures.qaRunId, qaRun.id)).run();
    db.delete(qaCommandResults).where(eq(qaCommandResults.qaRunId, qaRun.id)).run();
  }
  db.delete(qaRuns).where(eq(qaRuns.changeId, CHANGE_ID)).run();
  db.delete(requiredValidationCommands)
    .where(eq(requiredValidationCommands.changeId, CHANGE_ID))
    .run();
  const snapshots = db
    .select({ id: testplanSnapshots.id })
    .from(testplanSnapshots)
    .where(eq(testplanSnapshots.changeId, CHANGE_ID))
    .all();
  for (const snapshot of snapshots) {
    db.delete(testplanManualChecks).where(eq(testplanManualChecks.testplanSnapshotId, snapshot.id)).run();
    db.delete(testplanRiskMappings).where(eq(testplanRiskMappings.testplanSnapshotId, snapshot.id)).run();
    db.delete(testplanCoverageItems).where(eq(testplanCoverageItems.testplanSnapshotId, snapshot.id)).run();
  }
  db.delete(testplanSnapshots).where(eq(testplanSnapshots.changeId, CHANGE_ID)).run();
  db.delete(humanDecisions).where(eq(humanDecisions.changeId, CHANGE_ID)).run();
  db.delete(prdDrafts).where(eq(prdDrafts.changeId, CHANGE_ID)).run();
  db.delete(briefingQuestions).where(eq(briefingQuestions.changeId, CHANGE_ID)).run();
  db.delete(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).run();
  db.delete(buildRunRecords).where(eq(buildRunRecords.changeId, CHANGE_ID)).run();
  db.delete(reviewState).where(eq(reviewState.changeId, CHANGE_ID)).run();
  db.delete(reviewReports).where(eq(reviewReports.changeId, CHANGE_ID)).run();
  db.delete(findings).where(eq(findings.changeId, CHANGE_ID)).run();
  db.delete(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).run();
  // Must precede artifacts/runs/changes: release_note_state FKs into all three.
  db.delete(releaseNoteState).where(eq(releaseNoteState.changeId, CHANGE_ID)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(repoPath: string) {
  const now = "2026-06-29T00:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Action contract T3",
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
    title: "Action contract change",
    status: "REVIEWING",
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

function initCleanGitRepo(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
  execSync("git init -b main", { cwd: targetPath, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: targetPath, stdio: "ignore" });
  execSync("git config user.name 'Test User'", { cwd: targetPath, stdio: "ignore" });
  fs.writeFileSync(path.join(targetPath, "README.md"), "# action contract fixture\n");
  execSync("git add .", { cwd: targetPath, stdio: "ignore" });
  execSync("git commit -m init", { cwd: targetPath, stdio: "ignore" });
}

function seedStageGate(
  phase: PipelinePhase,
  status = "passed",
  sourceDbHash = `${phase}-hash`,
  blockers: Array<{ id: string; severity: "P0" | "P1" | "P2"; title: string }> = [],
) {
  const gateId = `STG-GATE-ACTION-CONTRACT-T3-${phase}`;
  db.insert(stageGates).values({
    id: gateId,
    changeId: CHANGE_ID,
    phase,
    status,
    blockersJson: JSON.stringify(blockers),
    freshnessJson: JSON.stringify({ fresh: true }),
    requiredActionsJson: "[]",
    gateVersion: 7,
    sourceDbHash,
    computedAt: "2026-06-29T00:01:00.000Z",
  }).run();
  db.insert(stageStates).values({
    id: `STG-STATE-ACTION-CONTRACT-T3-${phase}`,
    changeId: CHANGE_ID,
    phase,
    status,
    latestRunId: null,
    latestReportId: null,
    latestGateId: gateId,
    latestValidReportId: null,
    dbHash: sourceDbHash,
    version: 1,
    updatedAt: "2026-06-29T00:01:00.000Z",
  }).run();
}

/**
 * Backs a seeded stage gate with the completed work the enqueue authority
 * traces: a unique stage run holding the gate's source hash, plus the paired
 * completed business run with an artifact (the legacy attempt-pairing path).
 */
function seedAuthorityBackedStageSource(
  phase: PipelinePhase,
  businessPhase: string,
  sourceDbHash: string,
) {
  const now = "2026-06-29T00:01:00.000Z";
  db.insert(stageRuns).values({
    id: `STG-RUN-ACTION-CONTRACT-T3-AUTH-${phase}`,
    changeId: CHANGE_ID,
    phase,
    attemptNo: 1,
    status: "passed",
    idempotencyKey: `stage-run-auth-${phase}`,
    inputDbHash: sourceDbHash,
    outputDbHash: sourceDbHash,
    sourceLineageJson: null,
    errorCode: null,
    startedAt: now,
    completedAt: now,
  }).run();
  db.insert(runs).values({
    id: `RUN-ACTION-CONTRACT-T3-AUTH-${phase}`,
    changeId: CHANGE_ID,
    phase: businessPhase,
    status: "completed",
    startedAt: now,
    endedAt: now,
    summary: `${businessPhase} completed`,
    attemptNo: 1,
  }).run();
  db.insert(artifacts).values({
    id: `ART-ACTION-CONTRACT-T3-AUTH-${phase}`,
    changeId: CHANGE_ID,
    runId: `RUN-ACTION-CONTRACT-T3-AUTH-${phase}`,
    type: "stage_output",
    path: `/tmp/action-contract-auth-${phase}.json`,
    createdAt: now,
  }).run();
}

/**
 * The PRD source behind a passing PRD gate: enqueue authority for Spec-phase
 * runs requires the briefing to be locked with a draft on record.
 */
function seedLockedPrdBriefingAuthority() {
  const now = "2026-06-29T00:01:00.000Z";
  db.insert(prdBriefings).values({
    id: "PBR-ACTION-CONTRACT-T3",
    changeId: CHANGE_ID,
    status: "locked",
    intentText: "Action contract locked PRD.",
    finalReviewJson: null,
    sourceHashesJson: "{}",
    lockedAt: now,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(prdDrafts).values({
    id: "PDR-ACTION-CONTRACT-T3",
    changeId: CHANGE_ID,
    version: 1,
    markdown: "# Action contract PRD\n",
    sourceQuestionIdsJson: "[]",
    unresolvedQuestionIdsJson: "[]",
    draftHash: "action-contract-prd-draft-hash",
    createdAt: now,
  }).run();
}

/**
 * A briefing mid-flight: intent captured, two non-critical questions still open,
 * a draft on record that is FRESH against those inputs, nothing locked. This is
 * the state in which every briefing sub-step is legitimately runnable -- a POST
 * to any of the three is accepted here -- including the final review, whose
 * whole job is to produce the PRD gate verdict.
 *
 * The freshness stamp and the open question status are both load-bearing, and
 * both mirror a real dispatch precondition: assertFreshDraft rejects a draft
 * whose recorded draftInputHash no longer matches the briefing's inputs, and
 * assertQuestionsCanBeReplaced refuses to regenerate cards once any has been
 * acted on. Seeding `sourceHashesJson: "{}"` or an answered question would make
 * this a state where /gate must report steps DISABLED, which is the opposite of
 * what the callers of this helper are pinning.
 *
 * TWO cards, not one, and their ORDER is load-bearing. A one-card briefing makes
 * every row ordering identical, which is exactly how a 100%-reproduction bug hid
 * behind a full green suite: the write path hashed rows sorted by (createdAt,
 * id) while the read path hashed a bare `.all()` in rowid order, and with one
 * card the two agreed by construction. So this reproduces the production shape:
 * both cards share one `createdAt` -- the writer hoists a single timestamp for
 * the whole insert loop -- which forces the tie-break onto ids that in
 * production end in random bytes. `ALSO-OPEN` is inserted SECOND but sorts
 * FIRST, so rowid order and sorted order disagree, and any caller-side ordering
 * assumption shows up as a stale-draft phantom instead of hiding.
 */
function seedOpenPrdBriefingWithDraft(options: { withDraft?: boolean } = {}) {
  const now = "2026-06-29T00:01:00.000Z";
  const intentText = "Action contract open PRD briefing.";
  const question = {
    id: "BQ-ACTION-CONTRACT-OPEN",
    changeId: CHANGE_ID,
    category: "scope",
    severity: "normal",
    question: "Confirm briefing scope?",
    whyItMatters: "keeps the briefing bounded",
    suggestedDefault: null,
    status: "open",
    answer: null,
    source: "ai_blue",
    createdAt: now,
    updatedAt: now,
  };
  // Inserted second, sorts first: same createdAt, and "ALSO" < "OPEN".
  const alsoQuestion = {
    ...question,
    id: "BQ-ACTION-CONTRACT-ALSO-OPEN",
    question: "Confirm the briefing's non-goals?",
    whyItMatters: "keeps the briefing honest about what it excludes",
  };
  db.insert(prdBriefings).values({
    id: "PBR-ACTION-CONTRACT-T3-OPEN",
    changeId: CHANGE_ID,
    status: "draft",
    intentText,
    finalReviewJson: null,
    // Stamped the way the WRITE path stamps: prd-briefing-service hashes
    // getQuestions(), which is sorted by (createdAt, id). Written as a literal
    // in sorted order rather than re-deriving it, so this stays a fixed
    // reference point even if the comparator under test is wrong.
    sourceHashesJson: options.withDraft === false
      ? "{}"
      : JSON.stringify({
          draftInputHash: prdBriefingInputHash({ intentText }, [alsoQuestion, question]),
        }),
    lockedAt: null,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(briefingQuestions).values(question).run();
  db.insert(briefingQuestions).values(alsoQuestion).run();
  if (options.withDraft === false) return;
  db.insert(prdDrafts).values({
    id: "PDR-ACTION-CONTRACT-T3-OPEN",
    changeId: CHANGE_ID,
    version: 1,
    markdown: "# Action contract open PRD\n",
    sourceQuestionIdsJson: "[]",
    unresolvedQuestionIdsJson: "[]",
    draftHash: "action-contract-open-draft-hash",
    createdAt: now,
  }).run();
}

function seedStageRunSignal(input: {
  phase: PipelinePhase;
  status: string;
  errorCode?: StageAiOutputErrorCode | null;
  sourceLineageErrorCode?: StageAiOutputErrorCode | null;
  inputDbHash?: string | null;
  outputDbHash?: string | null;
  startedAt?: string;
  completedAt?: string | null;
}) {
  const startedAt = input.startedAt ?? "2026-06-29T00:02:00.000Z";
  const sourceLineage =
    input.sourceLineageErrorCode === undefined
      ? null
      : {
          schemaVersion: "stage_source_lineage/v1",
          sourceDbHashes: {},
          inputDbHash: input.inputDbHash ?? null,
          legacyRunId: `RUN-ACTION-CONTRACT-${input.phase}`,
          stageRunId: `STG-RUN-ACTION-CONTRACT-${input.phase}`,
          attemptNo: 1,
          aiOutput: {
            rawCaptureId: null,
            provider: "codex",
            aiOutputMode: "json_schema",
            schemaDelivery: "provider_native",
            structuredOutputSource: "none",
          },
          errorCode: input.sourceLineageErrorCode,
        };
  db.insert(stageRuns).values({
    id: `STG-RUN-ACTION-CONTRACT-${input.phase}`,
    changeId: CHANGE_ID,
    phase: input.phase,
    attemptNo: 1,
    status: input.status,
    idempotencyKey: `stage-run-${input.phase}`,
    inputDbHash: input.inputDbHash ?? `${input.phase}-input-hash`,
    outputDbHash: input.outputDbHash ?? null,
    sourceLineageJson: sourceLineage ? JSON.stringify(sourceLineage) : null,
    errorCode: input.errorCode ?? null,
    startedAt,
    completedAt: input.completedAt ?? startedAt,
  }).run();
}

function seedStageProgress(input: {
  phase: string;
  status: StageProgressStatus;
  message?: string;
  runId?: string;
  createdAt?: string;
}) {
  const runId = input.runId ?? `RUN-ACTION-CONTRACT-${input.phase}-PROGRESS`;
  db.insert(runs).values({
    id: runId,
    changeId: CHANGE_ID,
    phase: input.phase.toLowerCase(),
    status: input.status === "completed" ? "completed" : "failed",
    startedAt: input.createdAt ?? "2026-06-29T00:02:00.000Z",
    endedAt: input.createdAt ?? "2026-06-29T00:02:00.000Z",
    summary: input.message ?? input.status,
  }).run();
  db.insert(events).values({
    id: `EVT-ACTION-CONTRACT-${input.phase}-${input.status}`,
    changeId: CHANGE_ID,
    runId,
    type: "stage_progress",
    message: input.message ?? input.status,
    rawJson: stageProgressRawJson({
      schemaVersion: "stage_progress/v1",
      phase: input.phase,
      runId,
      status: input.status,
      message: input.message,
      source: "stage_authority",
    }),
    createdAt: input.createdAt ?? "2026-06-29T00:02:00.000Z",
  }).run();
}

function seedRunningImplementRun(input: { startedAt: string }) {
  db.insert(runs).values({
    id: "RUN-ACTION-CONTRACT-BUILD-RUNNING",
    changeId: CHANGE_ID,
    phase: "implement",
    status: "running",
    startedAt: input.startedAt,
    endedAt: null,
    summary: null,
  }).run();
}

function seedBuildRunFile(input: {
  repoPath: string;
  runNumber: number;
  status: BuildRunFile["status"];
  updatedAt: string;
}) {
  writeBuildRun(input.repoPath, {
    changeId: CHANGE_ID,
    runNumber: input.runNumber,
    status: input.status,
    purpose: "build",
    baseHeadSha: HEAD_SHA,
    baseCommit: HEAD_SHA,
    workspacePath: path.join(input.repoPath, ".action-contract-build-workspace", `build-${input.runNumber}`),
    branchName: `stagepass/build/${CHANGE_ID}/build-${input.runNumber}`,
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
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  });
}

/**
 * Writes the on-disk build-run file the enqueue authority traces for
 * run_review / retry_review (resolveBuildSnapshotSource): it must be an
 * `adopted` run whose adoption fields mirror the adopted build_run_records row.
 */
function writeAdoptedBuildRunFile(input: {
  repoPath: string;
  runNumber: number;
  adoptedHeadSha: string;
  adoptionDecisionId: string;
  patchSha256: string;
  changedFilesHash: string;
  baseHeadSha: string;
  baseCommit: string;
  updatedAt?: string;
}) {
  const stamp = input.updatedAt ?? "2026-06-29T00:01:00.000Z";
  writeBuildRun(input.repoPath, {
    changeId: CHANGE_ID,
    runNumber: input.runNumber,
    status: "adopted",
    purpose: "build",
    baseHeadSha: input.baseHeadSha,
    baseCommit: input.baseCommit,
    workspacePath: path.join(input.repoPath, ".action-contract-build-workspace", `build-${input.runNumber}`),
    branchName: `stagepass/build/${CHANGE_ID}/build-${input.runNumber}`,
    expectedFiles: [],
    forbiddenFiles: [],
    changedFiles: [],
    deviations: [],
    blockers: [],
    patchPath: null,
    patchSha256: input.patchSha256,
    changedFilesHash: input.changedFilesHash,
    adoptedHeadSha: input.adoptedHeadSha,
    adoptionDecisionId: input.adoptionDecisionId,
    approvalPath: null,
    diffPath: null,
    auditPath: null,
    reportPath: null,
    createdAt: stamp,
    updatedAt: stamp,
  });
}

function seedBuildRunRecord(input: { status: string; updatedAt: string }) {
  db.insert(buildRunRecords).values({
    id: `BRR-ACTION-CONTRACT-${input.status}-${input.updatedAt.replace(/[^0-9]/g, "")}`,
    changeId: CHANGE_ID,
    runId: null,
    buildRunId: "build-1",
    status: input.status,
    headSha: null,
    baseHeadSha: HEAD_SHA,
    baseCommit: HEAD_SHA,
    patchHash: "build-patch-hash",
    changedFilesHash: "build-files-hash",
    adoptedHeadSha: null,
    adoptionDecisionId: null,
    adoptedAt: null,
    artifactHash: "build-artifact-hash",
    source: "test",
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  }).run();
}

function seedRetryableStageOutputSignal(input: { phase: PipelinePhase; errorCode: StageAiOutputErrorCode }) {
  seedStageRunSignal({
    phase: input.phase,
    status: "failed",
    errorCode: input.errorCode,
    inputDbHash: `${input.phase}-retry-input-hash`,
  });
}

function seedSpecBattleRound(status: string) {
  const now = "2026-06-29T00:02:00.000Z";
  db.insert(battleRounds).values({
    id: `BRD-ACTION-CONTRACT-T3-${status}`,
    changeId: CHANGE_ID,
    phase: "Spec",
    template: "SPEC_BATTLE_MVP",
    roundNo: 1,
    status,
    redUnit: "SPEC_WRITER",
    blueUnit: "REQUIREMENT_CRITIC",
    inputSnapshotJson: "{}",
    paramsJson: "{}",
    redArtifactPath: null,
    redArtifactHash: null,
    blueArtifactPath: null,
    blueArtifactHash: null,
    reportPath: null,
    supersededByRoundId: null,
    startedAt: now,
    endedAt: status === "closed" ? now : null,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function seedReviewWithOpenP0() {
  const now = "2026-06-29T00:02:00.000Z";
  db.insert(buildRunRecords).values({
    id: "BRR-ACTION-CONTRACT-T3",
    changeId: CHANGE_ID,
    runId: null,
    buildRunId: "build-1",
    status: "adopted",
    headSha: HEAD_SHA,
    adoptedAt: now,
    artifactHash: null,
    source: "test",
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(runs).values({
    id: "RUN-ACTION-CONTRACT-T3",
    changeId: CHANGE_ID,
    phase: "review",
    status: "completed",
    startedAt: now,
    endedAt: now,
    summary: "{}",
  }).run();
  db.insert(reviewAttempts).values({
    id: "RAT-ACTION-CONTRACT-T3",
    changeId: CHANGE_ID,
    runId: "RUN-ACTION-CONTRACT-T3",
    attemptNo: 1,
    status: "completed",
    provider: "codex",
    reviewStatus: "passed",
    idempotencyKey: "review-action-contract",
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD_SHA,
    priorBlockingFindingIdsJson: null,
    rawOutputArtifactId: null,
    errorCode: null,
    sanitizedErrorSummary: null,
    startedAt: now,
    endedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(reviewReports).values({
    id: "RRP-ACTION-CONTRACT-T3",
    attemptId: "RAT-ACTION-CONTRACT-T3",
    changeId: CHANGE_ID,
    reportVersion: 1,
    reviewConclusion: "passed",
    reportDbHash: "review-report-hash-t3",
    gateStatus: "passed",
    qaAllowed: 1,
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD_SHA,
    findingVersion: 1,
    waiverVersion: 1,
    blockingP0: 0,
    blockingP1: 0,
    waivedP1: 0,
    p2Count: 0,
    findingsDbHash: "findings-hash-t3",
    staleReason: null,
    legacyState: null,
    reportJson: null,
    generatedAt: now,
    createdAt: now,
  }).run();
  db.insert(reviewState).values({
    changeId: CHANGE_ID,
    latestAttemptId: "RAT-ACTION-CONTRACT-T3",
    latestAttemptNo: 1,
    latestReportId: "RRP-ACTION-CONTRACT-T3",
    latestValidReviewReportId: "RRP-ACTION-CONTRACT-T3",
    latestValidAttemptNo: 1,
    gateStatus: "passed",
    reviewStatus: "passed",
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD_SHA,
    reportDbHash: "review-report-hash-t3",
    findingVersion: 1,
    waiverVersion: 1,
    updatedAt: now,
  }).run();
  db.insert(findings).values({
    id: "FND-ACTION-CONTRACT-P0",
    changeId: CHANGE_ID,
    runId: "RUN-ACTION-CONTRACT-T3",
    source: "review",
    severity: "P0",
    category: "logic",
    title: "review blocker",
    file: "src/app.ts",
    line: null,
    evidence: "review evidence",
    requiredFix: "fix the blocker",
    status: "open",
    reviewAttemptId: "RAT-ACTION-CONTRACT-T3",
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD_SHA,
    createdAt: now,
  }).run();
}

/**
 * Promotes the raw seedReviewWithOpenP0 rows into the fully trusted chain the
 * enqueue authority (trustedLatestReviewReportSource) walks for enter_qa /
 * run_qa / retry_qa: a complete adopted build record, an attempt whose
 * inputSourceDbHash equals the recomputed review input snapshot, and a
 * report/state pair re-settled by the production recomputeReviewReport.
 * Call it LAST in a test's seed sequence (after testplan seeds and finding
 * tweaks) so every recomputed hash reflects the state the authority evaluates.
 */
function settleTrustedReviewAuthority() {
  const now = "2026-06-29T00:03:30.000Z";
  db.update(buildRunRecords)
    .set({
      headSha: HEAD_SHA,
      adoptedHeadSha: HEAD_SHA,
      adoptionDecisionId: "ADN-ACTION-CONTRACT-T3",
      adoptedAt: now,
      baseHeadSha: HEAD_SHA,
      baseCommit: HEAD_SHA,
      patchHash: "review-authority-patch-hash",
      changedFilesHash: "review-authority-files-hash",
      artifactHash: "review-authority-artifact-hash",
    })
    .where(eq(buildRunRecords.id, "BRR-ACTION-CONTRACT-T3"))
    .run();
  const inputSnapshot = buildReviewInputSnapshot(db as never, CHANGE_ID, []);
  db.update(reviewAttempts)
    .set({
      inputSourceDbHash: inputSnapshot.inputSourceDbHash,
      priorBlockingFindingIdsJson: "[]",
    })
    .where(eq(reviewAttempts.id, "RAT-ACTION-CONTRACT-T3"))
    .run();
  return recomputeReviewReport(CHANGE_ID, "RAT-ACTION-CONTRACT-T3");
}

function seedApprovedTestPlanForQa() {
  const now = "2026-06-29T00:03:00.000Z";
  db.insert(testplanSnapshots).values({
    id: "TPS-ACTION-CONTRACT-QA",
    changeId: CHANGE_ID,
    status: "approved",
    testIntent: "QA handoff coverage",
    schemaVersion: "testplan/v1",
    approvalState: "approved",
    approvedAt: now,
    approvalDecisionId: null,
    snapshotDbHash: "testplan-source-hash",
    createdAt: now,
  }).run();
  db.insert(requiredValidationCommands).values({
    id: "RVC-ACTION-CONTRACT-QA",
    changeId: CHANGE_ID,
    phase: "TestPlan",
    sourceSnapshotId: "TPS-ACTION-CONTRACT-QA",
    command: "npm test",
    commandOrder: 1,
    required: 1,
    createdAt: now,
  }).run();
  // The QA enqueue authority (hasCurrentQaTestPlanPrerequisite ->
  // hasUniqueTestPlanSnapshotSource) requires the TestPlan gate's sourceDbHash
  // to equal the content hash computed over the approved snapshot + its required
  // commands, not an arbitrary literal. Seed the gate with that computed hash so
  // enter_qa / retry_qa are authority-consistent (a POST would otherwise 409).
  const snapshotRow = db
    .select()
    .from(testplanSnapshots)
    .where(eq(testplanSnapshots.id, "TPS-ACTION-CONTRACT-QA"))
    .get();
  const commandRows = db
    .select()
    .from(requiredValidationCommands)
    .where(
      and(
        eq(requiredValidationCommands.changeId, CHANGE_ID),
        eq(requiredValidationCommands.phase, "TestPlan"),
      ),
    )
    .all()
    .filter((command) => command.sourceSnapshotId === "TPS-ACTION-CONTRACT-QA");
  const testplanSourceHash = computeSourceDbHash({
    changeId: CHANGE_ID,
    phase: "TestPlan",
    rows: [snapshotRow, ...commandRows],
  });
  seedStageGate("TestPlan", "passed", testplanSourceHash);
}

function seedPendingApprovalTestPlanSnapshot(snapshotId = "TPS-ACTION-CONTRACT-PENDING") {
  const now = "2026-06-29T00:03:00.000Z";
  db.insert(testplanSnapshots).values({
    id: snapshotId,
    changeId: CHANGE_ID,
    status: "draft",
    testIntent: "legacy TestPlan awaiting approval",
    schemaVersion: "testplan/v1",
    approvalState: "pending",
    approvedAt: null,
    approvalDecisionId: null,
    snapshotDbHash: `${snapshotId}-hash`,
    createdAt: now,
  }).run();
  db.insert(testplanCoverageItems).values({
    id: `${snapshotId}-COV-1`,
    testplanSnapshotId: snapshotId,
    itemKey: "coverage-1",
    title: "Critical behavior coverage",
    requirementRef: "REQ-1",
    testType: "automated",
    priority: "P1",
    status: "planned",
    createdAt: now,
  }).run();
  db.insert(testplanRiskMappings).values({
    id: `${snapshotId}-RISK-1`,
    testplanSnapshotId: snapshotId,
    coverageItemKey: "coverage-1",
    riskRef: "RISK-1",
    severity: "P1",
    mitigation: "Run the required test command",
    createdAt: now,
  }).run();
  db.insert(requiredValidationCommands).values({
    id: `${snapshotId}-CMD-1`,
    changeId: CHANGE_ID,
    phase: "TestPlan",
    sourceSnapshotId: snapshotId,
    command: "npm test",
    commandOrder: 1,
    required: 1,
    createdAt: now,
  }).run();
}

function seedMergeReadyExceptApproval() {
  const now = "2026-06-29T00:06:00.000Z";
  for (const phase of ["PRD", "Spec", "Plan", "TestPlan", "Build", "Review", "QA"] as PipelinePhase[]) {
    seedStageGate(phase, "passed", `${phase}-merge-source-hash`);
  }
  db.insert(buildRunRecords).values({
    id: "BRR-ACTION-CONTRACT-MERGE",
    changeId: CHANGE_ID,
    runId: null,
    buildRunId: "build-merge-ready",
    status: "adopted",
    headSha: HEAD_SHA,
    baseHeadSha: HEAD_SHA,
    baseCommit: HEAD_SHA,
    patchHash: "merge-patch-hash",
    changedFilesHash: "merge-files-hash",
    adoptedHeadSha: HEAD_SHA,
    adoptionDecisionId: "HD-ACTION-CONTRACT-MERGE-ADOPT",
    adoptedAt: now,
    artifactHash: "merge-artifact-hash",
    source: "test",
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(runs).values({
    id: "RUN-ACTION-CONTRACT-MERGE-REVIEW",
    changeId: CHANGE_ID,
    phase: "review",
    status: "completed",
    startedAt: now,
    endedAt: now,
    summary: "{}",
  }).run();
  db.insert(reviewAttempts).values({
    id: "RAT-ACTION-CONTRACT-MERGE",
    changeId: CHANGE_ID,
    runId: "RUN-ACTION-CONTRACT-MERGE-REVIEW",
    attemptNo: 1,
    status: "completed",
    provider: "codex",
    reviewStatus: "passed",
    idempotencyKey: "review-merge-ready",
    sourceBuildRunId: "build-merge-ready",
    sourceHeadSha: HEAD_SHA,
    priorBlockingFindingIdsJson: null,
    rawOutputArtifactId: null,
    errorCode: null,
    sanitizedErrorSummary: null,
    startedAt: now,
    endedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(reviewReports).values({
    id: "RRP-ACTION-CONTRACT-MERGE",
    attemptId: "RAT-ACTION-CONTRACT-MERGE",
    changeId: CHANGE_ID,
    reportVersion: 1,
    reviewConclusion: "passed",
    reportDbHash: "merge-review-report-hash",
    gateStatus: "passed",
    qaAllowed: 1,
    sourceBuildRunId: "build-merge-ready",
    sourceHeadSha: HEAD_SHA,
    findingVersion: 1,
    waiverVersion: 1,
    blockingP0: 0,
    blockingP1: 0,
    waivedP1: 0,
    p2Count: 0,
    findingsDbHash: "merge-findings-hash",
    staleReason: null,
    legacyState: null,
    reportJson: null,
    generatedAt: now,
    createdAt: now,
  }).run();
  db.insert(reviewState).values({
    changeId: CHANGE_ID,
    latestAttemptId: "RAT-ACTION-CONTRACT-MERGE",
    latestAttemptNo: 1,
    latestReportId: "RRP-ACTION-CONTRACT-MERGE",
    latestValidReviewReportId: "RRP-ACTION-CONTRACT-MERGE",
    latestValidAttemptNo: 1,
    gateStatus: "passed",
    reviewStatus: "passed",
    sourceBuildRunId: "build-merge-ready",
    sourceHeadSha: HEAD_SHA,
    reportDbHash: "merge-review-report-hash",
    findingVersion: 1,
    waiverVersion: 1,
    updatedAt: now,
  }).run();
  db.insert(qaRuns).values({
    id: "QA-RUN-ACTION-CONTRACT-MERGE",
    changeId: CHANGE_ID,
    sourceReviewReportId: "RRP-ACTION-CONTRACT-MERGE",
    sourceBuildRunId: "build-merge-ready",
    sourceHeadSha: HEAD_SHA,
    status: "passed",
    startedAt: now,
    completedAt: now,
  }).run();
  db.insert(qaEvidence).values({
    id: "QA-EVD-ACTION-CONTRACT-MERGE-HEAD",
    qaRunId: "QA-RUN-ACTION-CONTRACT-MERGE",
    evidenceType: "qa_delivery_head",
    artifactMirrorId: null,
    contentHash: HEAD_SHA,
    createdAt: now,
  }).run();
}

/**
 * A change parked at RETRO_PENDING with a trusted Release authority behind it:
 * merge approved, Merge gate passed, one completed release run, and a
 * release note whose on-disk copy matches the approved-content hash.
 * Returns that hash so callers can tamper with it.
 */
function seedRetroPendingRelease(repoPath: string): string {
  const now = new Date().toISOString();
  initCleanGitRepo(repoPath);
  seedMergeReadyExceptApproval();
  db.insert(humanDecisions).values({
    id: "HD-RETRO-MERGE", changeId: CHANGE_ID, gate: "Merge", action: "approve_merge",
    targetType: "change", targetId: CHANGE_ID, reason: "release ready", reportHash: null,
    createdBy: "human", createdAt: now,
  }).run();
  db.insert(mergeApprovals).values({
    id: "MAP-RETRO-MERGE", changeId: CHANGE_ID, decisionId: "HD-RETRO-MERGE",
    actor: "human", approvedAt: now,
  }).run();
  db.update(changes)
    .set({ status: "RETRO_PENDING" })
    .where(eq(changes.id, CHANGE_ID))
    .run();
  db.insert(stageGates).values({
    id: "SG-RETRO-MERGE", changeId: CHANGE_ID, phase: "Merge", status: "passed",
    blockersJson: "[]", freshnessJson: "{}", requiredActionsJson: "[]",
    sourceDbHash: "merge-retro-source", gateVersion: 1, computedAt: now,
  }).run();
  db.insert(runs).values({
    id: "RUN-RETRO-RELEASE", changeId: CHANGE_ID, phase: "release", status: "completed",
    startedAt: now, endedAt: now, summary: "release complete",
  }).run();
  const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
  const runDir = path.join(changeDir, "runs", "RUN-RETRO-RELEASE");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, "release-note.md"), "# Release\n");
  const runPath = path.join(runDir, "release-note.md");
  fs.writeFileSync(runPath, "# Release\n");
  db.insert(artifacts).values({
    id: "ART-RETRO-RELEASE", changeId: CHANGE_ID, runId: "RUN-RETRO-RELEASE",
    type: "release_note", path: runPath, createdAt: now,
  }).run();
  const approvedReleaseHash = createHash("sha256").update("# Release\n").digest("hex");
  db.insert(releaseNoteState).values({
    id: "RNS-RETRO-RELEASE", changeId: CHANGE_ID, runId: "RUN-RETRO-RELEASE",
    artifactId: "ART-RETRO-RELEASE", approvedContentHash: approvedReleaseHash, createdAt: now,
  }).run();
  return approvedReleaseHash;
}

describe("action-contract repository wrapper", () => {
  it("uses the injected test DB when upserting and reading stage action contracts", () => {
    const testDb = createActionContractRepositoryTestDb();
    const restoreRepositoryDb = setActionContractRepositoryDbForTest(testDb);
    try {
      const baseAction = {
        actionId: "run_prd",
        phase: "PRD" as const,
        label: "Run PRD",
        enabled: true,
        reasonCode: null,
        reason: null,
        blockers: [],
        warnings: [],
        gateVersion: "2",
        sourceDbHash: "source-hash-1",
        requiresIdempotencyKey: true,
      };

      actionContractRepository.persistStageActionContract(
        "CHG-REPOSITORY-TEST",
        baseAction,
        "2026-07-01T00:00:00.000Z",
      );
      actionContractRepository.persistStageActionContract(
        "CHG-REPOSITORY-TEST",
        {
          ...baseAction,
          enabled: false,
          reasonCode: "gate_blocked",
          reason: "Gate blocked",
          blockers: [{ id: "BLK-1", severity: "P1", title: "Blocking issue" }],
          gateVersion: "3",
          sourceDbHash: "source-hash-2",
        },
        "2026-07-01T00:01:00.000Z",
      );

      const row = actionContractRepository.findStageAction(
        "CHG-REPOSITORY-TEST",
        "PRD",
        "run_prd",
      );
      const rows = testDb
        .select()
        .from(stageActions)
        .where(eq(stageActions.changeId, "CHG-REPOSITORY-TEST"))
        .all();

      assert.equal(rows.length, 1);
      assert.equal(row?.id, rows[0]?.id);
      assert.equal(row?.enabled, 0);
      assert.equal(row?.reasonCode, "gate_blocked");
      assert.equal(row?.reason, "Gate blocked");
      assert.equal(
        row?.blockersJson,
        JSON.stringify([{ id: "BLK-1", severity: "P1", title: "Blocking issue" }]),
      );
      assert.equal(row?.gateVersion, 3);
      assert.equal(row?.sourceDbHash, "source-hash-2");
      assert.equal(row?.requiresIdempotencyKey, 1);
      assert.equal(row?.computedAt, "2026-07-01T00:01:00.000Z");
    } finally {
      restoreRepositoryDb();
    }
  });
});

describe("action-contract-service", () => {
  let repoPath: string;
  let restoreHeadProbe: (() => void) | null = null;
  let restoreMergeHeadProbe: (() => void) | null = null;

  beforeEach(() => {
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "action-contract-t3-"));
    restoreHeadProbe = setReviewQaGateHeadProbeForTest(() => HEAD_SHA);
    restoreMergeHeadProbe = setMergeReadinessHeadProbeForTest(() => HEAD_SHA);
    seedChange(repoPath);
  });

  afterEach(() => {
    restoreHeadProbe?.();
    restoreHeadProbe = null;
    restoreMergeHeadProbe?.();
    restoreMergeHeadProbe = null;
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("computes actions without writing stage action contracts", () => {
    seedStageGate("PRD", "passed", "prd-source-hash");

    const actions = computeActions(CHANGE_ID);
    const auditRows = db
      .select()
      .from(stageActions)
      .where(eq(stageActions.changeId, CHANGE_ID))
      .all();

    assert.ok(actions.length > 0);
    assert.equal(actions.find((action) => action.actionId === "run_spec")?.sourceDbHash, "prd-source-hash");
    assert.equal(auditRows.length, 0);
  });

  it("keeps approve_merge enabled in read-only computation when only merge approval is missing", () => {
    initCleanGitRepo(repoPath);
    db.update(changes)
      .set({ status: "MERGE_READY" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedMergeReadyExceptApproval();

    const refreshedActions = getActions(CHANGE_ID);
    const refreshedApproveMerge = refreshedActions.find((action) => action.actionId === "approve_merge");
    const refreshedMerge = refreshedActions.find((action) => action.actionId === "merge");
    const computedActions = computeActions(CHANGE_ID);
    const computedApproveMerge = computedActions.find((action) => action.actionId === "approve_merge");
    const computedMerge = computedActions.find((action) => action.actionId === "merge");

    assert.equal(refreshedApproveMerge?.enabled, true);
    assert.equal(refreshedApproveMerge?.reasonCode, null);
    assert.equal(refreshedMerge?.enabled, false);
    assert.equal(refreshedMerge?.reasonCode, "merge_approval_missing");
    assert.equal(computedApproveMerge?.enabled, true);
    assert.equal(computedApproveMerge?.reasonCode, null);
    assert.equal(computedMerge?.enabled, false);
    assert.equal(computedMerge?.reasonCode, "merge_approval_missing");
    assert.equal(computedApproveMerge?.sourceDbHash, refreshedApproveMerge?.sourceDbHash);
    assert.equal(computedMerge?.sourceDbHash, refreshedMerge?.sourceDbHash);
  });

  it("returns enter_qa disabled with the same Review P0 reason preflight will use", () => {
    seedStageGate("Review", "passed", "review-source-hash");
    seedReviewWithOpenP0();

    const actions = getActions(CHANGE_ID);
    const enterQa = actions.find((action) => action.actionId === "enter_qa");

    assert.equal(enterQa?.enabled, false);
    assert.equal(enterQa?.reasonCode, "review_open_p0");
    assert.equal(enterQa?.reason, "Review has open P0 blockers");
    assert.deepEqual(enterQa?.blockers, [
      { id: "FND-ACTION-CONTRACT-P0", severity: "P0", title: "review blocker" },
    ]);
    assert.equal(enterQa?.gateVersion, "7");
    assert.equal(enterQa?.sourceDbHash, "review-source-hash");

    const audit = db
      .select()
      .from(stageActions)
      .where(eq(stageActions.changeId, CHANGE_ID))
      .all()
      .find((row) => row.actionId === "enter_qa");
    assert.equal(audit?.enabled, 0);
    assert.equal(audit?.reasonCode, "review_open_p0");
    assert.equal(audit?.sourceDbHash, "review-source-hash");
    assert.equal(audit?.gateVersion, 7);
  });

  it("disables fix_blockers with Review blockers when the change is not at a Fix gate", () => {
    seedReviewWithOpenP0();
    db.update(changes)
      .set({ status: "IMPLEMENTING" })
      .where(eq(changes.id, CHANGE_ID))
      .run();

    const actions = getActions(CHANGE_ID);
    const fixBlockers = actions.find((action) => action.actionId === "fix_blockers");

    assert.equal(fixBlockers?.enabled, false);
    assert.equal(fixBlockers?.reasonCode, "not_at_gate");
    assert.equal(fixBlockers?.reason, "Fix can only run from CHECK_FAILED or SCOPE_FAILED.");
  });

  it("enables fix_blockers from CHECK_FAILED while retry_review remains available with open Review blockers", () => {
    seedReviewWithOpenP0();
    // retry_review's enqueue authority (resolveBuildSnapshotSource) needs a fully
    // adopted build record whose adoption fields mirror the on-disk build run;
    // seedReviewWithOpenP0 only seeds the bare adopted row.
    db.update(buildRunRecords)
      .set({
        baseHeadSha: HEAD_SHA,
        baseCommit: HEAD_SHA,
        patchHash: "review-patch-hash",
        changedFilesHash: "review-files-hash",
        adoptedHeadSha: HEAD_SHA,
        adoptionDecisionId: "review-adoption",
        artifactHash: "review-artifact-hash",
      })
      .where(eq(buildRunRecords.id, "BRR-ACTION-CONTRACT-T3"))
      .run();
    writeAdoptedBuildRunFile({
      repoPath,
      runNumber: 1,
      adoptedHeadSha: HEAD_SHA,
      adoptionDecisionId: "review-adoption",
      patchSha256: "review-patch-hash",
      changedFilesHash: "review-files-hash",
      baseHeadSha: HEAD_SHA,
      baseCommit: HEAD_SHA,
    });
    db.update(changes)
      .set({ status: "CHECK_FAILED" })
      .where(eq(changes.id, CHANGE_ID))
      .run();

    const actions = getActions(CHANGE_ID);
    const fixBlockers = actions.find((action) => action.actionId === "fix_blockers");
    const retryReview = actions.find((action) => action.actionId === "retry_review");

    assert.equal(fixBlockers?.enabled, true);
    assert.equal(fixBlockers?.reasonCode, null);
    assert.equal(retryReview?.enabled, true);
    assert.equal(retryReview?.reasonCode, null);
  });

  it("enables fix_blockers from SCOPE_FAILED with open Review blockers", () => {
    seedReviewWithOpenP0();
    db.update(changes)
      .set({ status: "SCOPE_FAILED" })
      .where(eq(changes.id, CHANGE_ID))
      .run();

    const fixBlockers = getActions(CHANGE_ID).find((action) => action.actionId === "fix_blockers");

    assert.equal(fixBlockers?.enabled, true);
    assert.equal(fixBlockers?.reasonCode, null);
  });

  /**
   * The mirror half of the stranded-FIXING dead end. A fix run killed
   * mid-flight leaves the change claiming FIXING; runFixStreamed now repairs
   * that claim (recoverStrandedRunningStatus) and reruns, but this policy
   * hard-coded "CHECK_FAILED or SCOPE_FAILED" and reported the one action that
   * performs the repair as not_at_gate -- so the user got no button at all,
   * which is worse than a failing one.
   *
   * Advertising it at FIXING cannot start a second concurrent fix: the enqueue
   * authority refuses any non-retry_ action while a run of the phase is still
   * `running` (provider_run_running), and the runner refuses too -- the
   * recovery declines when a run is in flight and assertStatus then throws.
   */
  it("enables fix_blockers for a change stranded at FIXING", () => {
    seedReviewWithOpenP0();
    db.update(changes)
      .set({ status: "FIXING" })
      .where(eq(changes.id, CHANGE_ID))
      .run();

    const fixBlockers = getActions(CHANGE_ID).find((action) => action.actionId === "fix_blockers");

    assert.equal(fixBlockers?.enabled, true);
    assert.equal(fixBlockers?.reasonCode, null);
  });

  for (const status of ["IMPLEMENTED", "REVIEWING", "CHECKING"]) {
    it(`still disables fix_blockers at ${status}`, () => {
      seedReviewWithOpenP0();
      db.update(changes)
        .set({ status })
        .where(eq(changes.id, CHANGE_ID))
        .run();

      // runFixStreamed rejects all of these and the recovery does not apply
      // (it only repairs the stage's own running status), so the contract must
      // keep refusing them rather than widening to "any status with blockers".
      const fixBlockers = getActions(CHANGE_ID).find((action) => action.actionId === "fix_blockers");

      assert.equal(fixBlockers?.enabled, false);
      assert.equal(fixBlockers?.reasonCode, "not_at_gate");
    });
  }

  it("enables enter_qa from the DB Review report without requiring a legacy Review gate snapshot", () => {
    seedReviewWithOpenP0();
    db.delete(findings).where(eq(findings.id, "FND-ACTION-CONTRACT-P0")).run();
    seedApprovedTestPlanForQa();
    const settled = settleTrustedReviewAuthority();

    const actions = getActions(CHANGE_ID);
    const enterQa = actions.find((action) => action.actionId === "enter_qa");

    assert.equal(enterQa?.enabled, true, JSON.stringify(enterQa));
    assert.equal(enterQa?.reasonCode, null);
    assert.equal(enterQa?.gateVersion, String(settled.report.reportVersion));
    assert.equal(enterQa?.sourceDbHash, settled.report.reportDbHash);
    assert.equal(actions.find((action) => action.actionId === "fix_blockers")?.reasonCode, "no_review_blockers");
    assert.equal(actions.find((action) => action.actionId === "waive_review_p1")?.reasonCode, "no_waivable_review_p1");
    assert.equal(actions.find((action) => action.actionId === "recompute_report")?.enabled, true);
    assert.equal(actions.find((action) => action.actionId === "rebuild_mirror")?.enabled, true);
    assert.equal(actions.find((action) => action.actionId === "stop_change")?.enabled, true);
    assert.equal(actions.find((action) => action.actionId === "recompute_report")?.requiresIdempotencyKey, true);
    assert.equal(actions.find((action) => action.actionId === "rebuild_mirror")?.requiresIdempotencyKey, true);
    for (const actionId of [
      "fix_blockers",
      "waive_review_p1",
      "recompute_report",
      "rebuild_mirror",
      "stop_change",
      "enter_qa",
    ]) {
      assert.notEqual(actions.find((action) => action.actionId === actionId)?.reasonCode, "review_gate_missing");
    }

    const audit = db
      .select()
      .from(stageActions)
      .where(eq(stageActions.changeId, CHANGE_ID))
      .all()
      .find((row) => row.actionId === "enter_qa");
    assert.equal(audit?.enabled, 1);
    assert.equal(audit?.sourceDbHash, settled.report.reportDbHash);
    assert.equal(audit?.gateVersion, settled.report.reportVersion);
  });

  it("enables enter_qa for a waived-P1 settlement (passed_with_waived_p1 review)", () => {
    // A sanctioned waive_review_p1 leaves the attempt's own conclusion at
    // "issues_found" while the settled report carries passed_with_waived_p1 /
    // qaAllowed=1 — the state the QA gate service accepts. The enqueue
    // authority must accept it too, or every waived-P1 change strands at the
    // QA door (observed live in e2e round 1b, CHG-005/FND-064).
    seedReviewWithOpenP0();
    const now = "2026-06-29T00:03:10.000Z";
    db.update(findings)
      .set({
        severity: "P1",
        status: "waived",
        waivable: 1,
        waivedBy: "red-team-human",
        waivedAt: now,
      })
      .where(eq(findings.id, "FND-ACTION-CONTRACT-P0"))
      .run();
    db.update(reviewAttempts)
      .set({ reviewStatus: "issues_found" })
      .where(eq(reviewAttempts.id, "RAT-ACTION-CONTRACT-T3"))
      .run();
    seedApprovedTestPlanForQa();
    const settled = settleTrustedReviewAuthority();

    assert.equal(settled.report.gateStatus, "passed_with_waived_p1");
    assert.equal(settled.report.qaAllowed, 1);

    const enterQa = getActions(CHANGE_ID).find((action) => action.actionId === "enter_qa");

    assert.equal(enterQa?.enabled, true, JSON.stringify(enterQa));
    assert.equal(enterQa?.reasonCode, null);
    assert.equal(enterQa?.sourceDbHash, settled.report.reportDbHash);
  });

  it("enables retry_qa from CHECK_FAILED when QA failed and prerequisites still pass", () => {
    db.update(changes)
      .set({ status: "CHECK_FAILED" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedReviewWithOpenP0();
    db.delete(findings).where(eq(findings.id, "FND-ACTION-CONTRACT-P0")).run();
    seedApprovedTestPlanForQa();
    seedStageGate("QA", "failed", "qa-failed-source-hash", [
      { id: "QA-FAL-ACTION-CONTRACT", severity: "P1", title: "npm test failed" },
    ]);
    // No qa_runs rows here, so the QA snapshot resolver falls back to the legacy
    // stage-run/business-run pairing the enqueue authority requires.
    seedAuthorityBackedStageSource("QA", "local_check", "qa-failed-source-hash");
    settleTrustedReviewAuthority();

    const actions = getActions(CHANGE_ID);
    const retryQa = actions.find((action) => action.actionId === "retry_qa");

    assert.equal(retryQa?.enabled, true, JSON.stringify(retryQa));
    assert.equal(retryQa?.reasonCode, null);
    assert.equal(retryQa?.sourceDbHash, "qa-failed-source-hash");
    assert.equal(retryQa?.gateVersion, "7");

    const allowed = assertActionAllowed({
      changeId: CHANGE_ID,
      actionId: "retry_qa",
      expectedGateVersion: retryQa?.gateVersion ?? "",
      expectedSourceDbHash: retryQa?.sourceDbHash ?? "",
      idempotencyKey: "retry-qa-action-contract",
    });
    assert.equal(allowed.actionId, "retry_qa");
    assert.equal(allowed.enabled, true);
  });

  it("self-heals stuck CHECKING with failed local check into CHECK_FAILED and enables retry_qa", () => {
    const startedAt = "2026-06-29T00:04:00.000Z";
    const endedAt = "2026-06-29T00:05:00.000Z";
    db.update(changes)
      .set({ status: "CHECKING" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedReviewWithOpenP0();
    db.delete(findings).where(eq(findings.id, "FND-ACTION-CONTRACT-P0")).run();
    seedApprovedTestPlanForQa();
    db.insert(runs).values({
      id: "RUN-ACTION-CONTRACT-QA-FAILED",
      changeId: CHANGE_ID,
      phase: "local_check",
      status: "failed",
      startedAt,
      endedAt,
      summary: "SqliteError: FOREIGN KEY constraint failed",
    }).run();
    db.insert(qaRuns).values({
      id: "QA-RUN-ACTION-CONTRACT-STUCK",
      changeId: CHANGE_ID,
      sourceReviewReportId: "RRP-ACTION-CONTRACT-T3",
      sourceBuildRunId: "build-1",
      sourceHeadSha: HEAD_SHA,
      status: "running",
      startedAt,
      completedAt: null,
    }).run();
    db.insert(qaCommandResults).values({
      id: "QA-CMD-ACTION-CONTRACT-PASSED",
      qaRunId: "QA-RUN-ACTION-CONTRACT-STUCK",
      command: "npm test",
      commandOrder: 1,
      status: "passed",
      exitCode: 0,
      durationMs: 25,
      outputArtifactMirrorId: null,
      completedAt: endedAt,
    }).run();
    settleTrustedReviewAuthority();

    const computedRetryQa = computeActions(CHANGE_ID).find((action) => action.actionId === "retry_qa");
    const notHealedChange = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    const notHealedQaRun = db.select().from(qaRuns).where(eq(qaRuns.id, "QA-RUN-ACTION-CONTRACT-STUCK")).get();

    assert.equal(notHealedChange?.status, "CHECKING");
    assert.equal(notHealedQaRun?.status, "running");
    assert.equal(computedRetryQa?.enabled, false);

    const actions = getActions(CHANGE_ID);
    const retryQa = actions.find((action) => action.actionId === "retry_qa");
    const healedChange = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    const healedQaRun = db.select().from(qaRuns).where(eq(qaRuns.id, "QA-RUN-ACTION-CONTRACT-STUCK")).get();
    const qaGate = db
      .select()
      .from(stageGates)
      .where(eq(stageGates.changeId, CHANGE_ID))
      .all()
      .filter((gate) => gate.phase === "QA")
      .sort((left, right) => right.computedAt.localeCompare(left.computedAt))[0];

    assert.equal(healedChange?.status, "CHECK_FAILED");
    assert.equal(healedChange?.blockedPhase, null);
    assert.equal(healedQaRun?.status, "failed");
    assert.equal(qaGate?.status, "failed");
    assert.equal(retryQa?.enabled, true);
    assert.equal(retryQa?.reasonCode, null);
    assert.equal(retryQa?.sourceDbHash, qaGate?.sourceDbHash);

    const allowed = assertActionAllowed({
      changeId: CHANGE_ID,
      actionId: "retry_qa",
      expectedGateVersion: retryQa?.gateVersion ?? "",
      expectedSourceDbHash: retryQa?.sourceDbHash ?? "",
      idempotencyKey: "retry-qa-self-healed",
    });
    assert.equal(allowed.enabled, true);
  });

  it("does not self-heal CHECKING while local check is still running", () => {
    const startedAt = "2026-06-29T00:04:00.000Z";
    db.update(changes)
      .set({ status: "CHECKING" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedReviewWithOpenP0();
    db.delete(findings).where(eq(findings.id, "FND-ACTION-CONTRACT-P0")).run();
    seedApprovedTestPlanForQa();
    db.insert(runs).values({
      id: "RUN-ACTION-CONTRACT-QA-ACTIVE",
      changeId: CHANGE_ID,
      phase: "local_check",
      status: "running",
      startedAt,
      endedAt: null,
      summary: null,
    }).run();
    db.insert(qaRuns).values({
      id: "QA-RUN-ACTION-CONTRACT-ACTIVE",
      changeId: CHANGE_ID,
      sourceReviewReportId: "RRP-ACTION-CONTRACT-T3",
      sourceBuildRunId: "build-1",
      sourceHeadSha: HEAD_SHA,
      status: "running",
      startedAt,
      completedAt: null,
    }).run();

    const retryQa = getActions(CHANGE_ID).find((action) => action.actionId === "retry_qa");
    const currentChange = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    const qaGate = db
      .select()
      .from(stageGates)
      .where(eq(stageGates.changeId, CHANGE_ID))
      .all()
      .find((gate) => gate.phase === "QA");

    assert.equal(currentChange?.status, "CHECKING");
    assert.equal(qaGate, undefined);
    assert.equal(retryQa?.enabled, false);
    assert.equal(retryQa?.reasonCode, "qa_running");
  });

  it("keeps retry_qa disabled while a local check run is still running", () => {
    const now = "2026-06-29T00:04:00.000Z";
    db.update(changes)
      .set({ status: "CHECK_FAILED" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedReviewWithOpenP0();
    db.delete(findings).where(eq(findings.id, "FND-ACTION-CONTRACT-P0")).run();
    seedApprovedTestPlanForQa();
    seedStageGate("QA", "failed", "qa-failed-source-hash", [
      { id: "QA-FAL-ACTION-CONTRACT", severity: "P1", title: "npm test failed" },
    ]);
    db.insert(runs).values({
      id: "RUN-ACTION-CONTRACT-QA-RUNNING",
      changeId: CHANGE_ID,
      phase: "local_check",
      status: "running",
      startedAt: now,
      endedAt: null,
      summary: null,
    }).run();

    const retryQa = getActions(CHANGE_ID).find((action) => action.actionId === "retry_qa");

    assert.equal(retryQa?.enabled, false);
    assert.equal(retryQa?.reasonCode, "qa_running");
    assert.equal(retryQa?.reason, "QA is already running");
    assert.throws(
      () =>
        assertActionAllowed({
          changeId: CHANGE_ID,
          actionId: "retry_qa",
          expectedGateVersion: retryQa?.gateVersion ?? "",
          expectedSourceDbHash: retryQa?.sourceDbHash ?? "",
          idempotencyKey: "retry-qa-running",
        }),
      (error) => {
        assert.ok(error instanceof PreflightBlockedError);
        assert.equal(error.envelope.reasonCode, "qa_running");
        assert.equal(error.envelope.action.actionId, "retry_qa");
        return true;
      },
    );
  });

  it("keeps retry_qa disabled when CHECK_FAILED prerequisites no longer pass", () => {
    db.update(changes)
      .set({ status: "CHECK_FAILED" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedApprovedTestPlanForQa();
    seedStageGate("QA", "failed", "qa-failed-source-hash", [
      { id: "QA-FAL-ACTION-CONTRACT", severity: "P1", title: "npm test failed" },
    ]);

    const retryQa = getActions(CHANGE_ID).find((action) => action.actionId === "retry_qa");

    assert.equal(retryQa?.enabled, false);
    assert.equal(retryQa?.reasonCode, "no_latest_valid_review");
    assert.throws(
      () =>
        assertActionAllowed({
          changeId: CHANGE_ID,
          actionId: "retry_qa",
          expectedGateVersion: retryQa?.gateVersion ?? "",
          expectedSourceDbHash: retryQa?.sourceDbHash ?? "",
          idempotencyKey: "retry-qa-missing-review",
        }),
      (error) => {
        assert.ok(error instanceof PreflightBlockedError);
        assert.equal(error.envelope.reasonCode, "no_latest_valid_review");
        assert.equal(error.envelope.action.actionId, "retry_qa");
        return true;
      },
    );
  });

  it("derives run_plan from the approved TechSpec stage contract", () => {
    db.update(changes)
      .set({ status: "TECHSPEC_READY", gateState: "tech_spec" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("TechSpec", "passed", "techspec-source-hash");
    // Enqueue authority needs the gate's source to trace to real completed
    // work; without it the served contract is authority-denied.
    seedAuthorityBackedStageSource("TechSpec", "tech_spec", "techspec-source-hash");

    const runPlan = getActions(CHANGE_ID).find((action) => action.actionId === "run_plan");

    assert.equal(runPlan?.enabled, true);
    assert.equal(runPlan?.sourceDbHash, "techspec-source-hash");
    assert.equal(runPlan?.gateVersion, "7");
  });

  it("derives Spec run actions from the approved PRD gate while Intake is ready", () => {
    db.update(changes)
      .set({ status: "INTAKE_READY", gateState: "intake" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", "passed", "prd-source-hash");
    seedLockedPrdBriefingAuthority();

    const actions = getActions(CHANGE_ID);
    const runSpec = actions.find((action) => action.actionId === "run_spec");
    const retrySpec = actions.find((action) => action.actionId === "retry_spec");

    assert.equal(runSpec?.enabled, true);
    assert.equal(runSpec?.phase, "Spec");
    assert.equal(runSpec?.sourceDbHash, "prd-source-hash");
    assert.equal(runSpec?.gateVersion, "7");
    assert.equal(runSpec?.requiresIdempotencyKey, true);
    assert.equal(retrySpec?.enabled, false);
    assert.equal(retrySpec?.reasonCode, "spec_round_not_failed");
    assert.equal(retrySpec?.sourceDbHash, "prd-source-hash");
    assert.equal(retrySpec?.gateVersion, "7");
    assert.notEqual(runSpec?.reasonCode, "spec_gate_missing");
    assert.notEqual(retrySpec?.reasonCode, "spec_gate_missing");
  });

  it("applies action-specific Spec Battle run and retry availability by latest round status", () => {
    seedLockedPrdBriefingAuthority();
    const cases = [
      { status: null, changeStatus: "INTAKE_READY", runEnabled: true, runReason: null, retryEnabled: false, retryReason: "spec_round_not_failed" },
      { status: "not_started", changeStatus: "SPECCING", runEnabled: true, runReason: null, retryEnabled: false, retryReason: "spec_round_not_failed" },
      { status: "red_running", changeStatus: "SPECCING", runEnabled: false, runReason: "spec_round_running", retryEnabled: false, retryReason: "spec_round_running" },
      { status: "blue_running", changeStatus: "SPECCING", runEnabled: false, runReason: "spec_round_running", retryEnabled: false, retryReason: "spec_round_running" },
      { status: "failed", changeStatus: "BLOCKED", runEnabled: false, runReason: "spec_round_failed_retry_required", retryEnabled: true, retryReason: null },
      { status: "report_ready", changeStatus: "SPEC_READY", runEnabled: false, runReason: "spec_battle_human_decision_required", retryEnabled: false, retryReason: "spec_round_not_failed" },
      { status: "closed", changeStatus: "SPEC_READY", runEnabled: false, runReason: "spec_battle_closed", retryEnabled: false, retryReason: "spec_round_not_failed" },
      { status: "superseded", changeStatus: "SPECCING", runEnabled: false, runReason: "spec_round_superseded", retryEnabled: false, retryReason: "spec_round_not_failed" },
    ] as const;

    for (const testCase of cases) {
      db.delete(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).run();
      db.delete(stageStates).where(and(eq(stageStates.changeId, CHANGE_ID), eq(stageStates.phase, "PRD"))).run();
      db.delete(stageGates).where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "PRD"))).run();
      db.update(changes)
        .set({ status: testCase.changeStatus, gateState: "intake", blockedPhase: testCase.changeStatus === "BLOCKED" ? "spec" : null })
        .where(eq(changes.id, CHANGE_ID))
        .run();
      if (testCase.status) seedSpecBattleRound(testCase.status);
      seedStageGate("PRD", "passed", `prd-source-hash-${testCase.status ?? "none"}`);

      const actions = getActions(CHANGE_ID);
      const runSpec = actions.find((action) => action.actionId === "run_spec");
      const retrySpec = actions.find((action) => action.actionId === "retry_spec");

      assert.equal(runSpec?.enabled, testCase.runEnabled, `run_spec enabled for ${testCase.status ?? "no round"}`);
      assert.equal(runSpec?.reasonCode, testCase.runReason, `run_spec reason for ${testCase.status ?? "no round"}`);
      assert.equal(retrySpec?.enabled, testCase.retryEnabled, `retry_spec enabled for ${testCase.status ?? "no round"}`);
      assert.equal(retrySpec?.reasonCode, testCase.retryReason, `retry_spec reason for ${testCase.status ?? "no round"}`);
      assert.notEqual(runSpec?.reasonCode, "not_at_gate", `run_spec should not use not_at_gate for ${testCase.status ?? "no round"}`);
      assert.notEqual(retrySpec?.reasonCode, "not_at_gate", `retry_spec should not use not_at_gate for ${testCase.status ?? "no round"}`);
    }
  });

  it("enables PRD run actions for a new change using the missing-gate sentinel contract", () => {
    db.update(changes)
      .set({ status: "INTAKE_PENDING", gateState: null })
      .where(eq(changes.id, CHANGE_ID))
      .run();

    const actions = getActions(CHANGE_ID);
    const runPrd = actions.find((action) => action.actionId === "run_prd");
    const retryPrd = actions.find((action) => action.actionId === "retry_prd");

    for (const action of [runPrd, retryPrd]) {
      assert.ok(action);
      assert.equal(action.enabled, true);
      assert.equal(action.reasonCode, null);
      assert.equal(action.gateVersion, "0");
      assert.equal(action.sourceDbHash, "__missing_gate__");
      assert.equal(action.requiresIdempotencyKey, true);

      const allowed = assertActionAllowed({
        changeId: CHANGE_ID,
        actionId: action.actionId,
        expectedGateVersion: action.gateVersion,
        expectedSourceDbHash: action.sourceDbHash,
        idempotencyKey: `${action.actionId}-new-change-action-contract`,
      });
      assert.equal(allowed.enabled, true);
      assert.equal(allowed.actionId, action.actionId);
    }
  });

  it("keeps PRD run actions disabled outside intake pending when the PRD gate is missing", () => {
    db.update(changes)
      .set({ status: "INTAKE_READY", gateState: null })
      .where(eq(changes.id, CHANGE_ID))
      .run();

    const actions = getActions(CHANGE_ID);
    const runPrd = actions.find((action) => action.actionId === "run_prd");
    const retryPrd = actions.find((action) => action.actionId === "retry_prd");

    for (const action of [runPrd, retryPrd]) {
      assert.ok(action);
      assert.equal(action.enabled, false);
      assert.equal(action.reasonCode, "not_at_gate");
      assert.equal(action.gateVersion, "0");
      assert.equal(action.sourceDbHash, "__missing_gate__");
      assert.throws(
        () =>
          assertActionAllowed({
            changeId: CHANGE_ID,
            actionId: action.actionId,
            expectedGateVersion: action.gateVersion,
            expectedSourceDbHash: action.sourceDbHash,
            idempotencyKey: `${action.actionId}-non-intake-action-contract`,
          }),
        (error) => {
          assert.ok(error instanceof PreflightBlockedError);
          assert.equal(error.envelope.status, 409);
          assert.equal(error.envelope.reasonCode, "not_at_gate");
          assert.equal(error.envelope.action.actionId, action.actionId);
          return true;
        },
      );
    }
  });

  it("offers retry when stage output is invalid", () => {
    db.update(changes)
      .set({ status: "INTAKE_READY", gateState: null })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageRunSignal({
      phase: "PRD",
      status: "invalid_output",
      errorCode: "invalid_stage_output",
      inputDbHash: "prd-invalid-input-hash",
    });

    const retryPrd = getActions(CHANGE_ID).find((action) => action.actionId === "retry_prd");

    assert.equal(retryPrd?.enabled, true);
    assert.equal(retryPrd?.reasonCode, null);
    assert.equal(retryPrd?.blockers.length, 0);
    // No PRD gate exists, so the enqueue authority (which owns the served
    // sourceDbHash once it approves) carries the missing-gate sentinel -- the
    // only value a retry_prd POST would actually accept here.
    assert.equal(retryPrd?.sourceDbHash, "__missing_gate__");
    assert.equal(retryPrd?.warnings.length, 0);
  });

  /**
   * A run that never landed is the most retryable failure there is -- nothing
   * about the change or the prompt is wrong. If the new provider-side codes are
   * missing from the retryable set the signal silently downgrades them to a
   * generic code (or drops the retry affordance entirely on paths that have no
   * status fallback), leaving the user staring at a failed stage with no way
   * forward.
   */
  it("keeps transport and empty-response failures retryable under their own codes", () => {
    for (const errorCode of ["provider_transport_error", "provider_empty_response"] as const) {
      db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
      db.update(changes)
        .set({ status: "INTAKE_READY", gateState: null })
        .where(eq(changes.id, CHANGE_ID))
        .run();
      seedStageRunSignal({
        phase: "PRD",
        status: "failed",
        errorCode,
        inputDbHash: `prd-${errorCode}-input-hash`,
      });

      const signal = latestStageOutputSignal(db, CHANGE_ID, "PRD");
      assert.equal(
        signal.retryableErrorCode,
        errorCode,
        `${errorCode} must stay retryable under its own name, not be flattened`,
      );

      const retryPrd = getActions(CHANGE_ID).find((action) => action.actionId === "retry_prd");
      assert.equal(retryPrd?.enabled, true, `${errorCode} must still offer Retry`);
    }
  });

  it("offers retry when PRD briefing stage progress reports invalid output", () => {
    db.update(changes)
      .set({ status: "INTAKE_READY", gateState: null })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageProgress({
      phase: "prd_briefing_questions",
      status: "invalid_output",
      message: "invalid_stage_output: schema mismatch",
      runId: "RUN-ACTION-CONTRACT-PRD-BRIEFING-INVALID",
    });

    const retryPrd = getActions(CHANGE_ID).find((action) => action.actionId === "retry_prd");

    assert.equal(retryPrd?.enabled, true);
    assert.equal(retryPrd?.reasonCode, null);
    assert.equal(retryPrd?.blockers.length, 0);
    // Authority approves with the missing-gate sentinel (no PRD gate), which is
    // the served/POST-accepted sourceDbHash regardless of the progress runId.
    assert.equal(retryPrd?.sourceDbHash, "__missing_gate__");
  });

  it("offers retry when provider timed out", () => {
    const now = "2026-06-29T00:02:00.000Z";
    db.update(changes)
      .set({ status: "IMPLEMENTED" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    db.insert(runs).values({
      id: "RUN-ACTION-CONTRACT-REVIEW-TIMEOUT",
      changeId: CHANGE_ID,
      phase: "review",
      status: "failed",
      startedAt: now,
      endedAt: now,
      summary: "provider_timeout: Review provider timed out",
    }).run();
    db.insert(reviewAttempts).values({
      id: "RAT-ACTION-CONTRACT-REVIEW-TIMEOUT",
      changeId: CHANGE_ID,
      runId: "RUN-ACTION-CONTRACT-REVIEW-TIMEOUT",
      attemptNo: 1,
      status: "failed",
      provider: "codex",
      reviewStatus: "failed",
      idempotencyKey: "review-timeout-action-contract",
      sourceBuildRunId: "build-1",
      sourceHeadSha: HEAD_SHA,
      inputSourceDbHash: "review-timeout-source-hash",
      inputSourceLineageJson: null,
      priorBlockingFindingIdsJson: null,
      rawOutputArtifactId: null,
      errorCode: "provider_timeout",
      sanitizedErrorSummary: "provider_timeout: Review provider timed out",
      startedAt: now,
      endedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    // retry_review can only be enqueued against an adopted build to re-review; the
    // authority (and policy) now derive the served sourceDbHash from that build.
    db.insert(buildRunRecords).values({
      id: "BRR-ACTION-CONTRACT-REVIEW-TIMEOUT",
      changeId: CHANGE_ID,
      runId: null,
      buildRunId: "build-1",
      status: "adopted",
      headSha: HEAD_SHA,
      baseHeadSha: HEAD_SHA,
      baseCommit: HEAD_SHA,
      patchHash: "review-timeout-patch-hash",
      changedFilesHash: "review-timeout-files-hash",
      adoptedHeadSha: HEAD_SHA,
      adoptionDecisionId: "review-timeout-adoption",
      adoptedAt: now,
      artifactHash: "review-timeout-artifact-hash",
      source: "test",
      createdAt: now,
      updatedAt: now,
    }).run();
    writeAdoptedBuildRunFile({
      repoPath,
      runNumber: 1,
      adoptedHeadSha: HEAD_SHA,
      adoptionDecisionId: "review-timeout-adoption",
      patchSha256: "review-timeout-patch-hash",
      changedFilesHash: "review-timeout-files-hash",
      baseHeadSha: HEAD_SHA,
      baseCommit: HEAD_SHA,
    });

    const retryReview = getActions(CHANGE_ID).find((action) => action.actionId === "retry_review");

    assert.equal(retryReview?.enabled, true);
    assert.equal(retryReview?.reasonCode, null);
    assert.equal(retryReview?.blockers.length, 0);
    // The served sourceDbHash is the adopted-build review source the enqueue
    // authority validates, not the timed-out attempt's input hash.
    assert.equal(
      retryReview?.sourceDbHash,
      `review-timeout-patch-hash:review-timeout-files-hash:${HEAD_SHA}`,
    );
  });

  it("keeps the adopted Build authority fence when retrying a failed Review", () => {
    const now = "2026-06-29T00:02:00.000Z";
    db.update(changes)
      .set({ status: "IMPLEMENTED" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    db.insert(buildRunRecords).values({
      id: "BRR-ACTION-CONTRACT-REVIEW-RETRY",
      changeId: CHANGE_ID,
      runId: null,
      // buildRunId must be build-<runNumber> so the enqueue authority can match
      // the DB record to the on-disk build run file.
      buildRunId: "build-1",
      status: "adopted",
      headSha: HEAD_SHA,
      baseHeadSha: HEAD_SHA,
      baseCommit: HEAD_SHA,
      patchHash: "review-retry-patch-hash",
      changedFilesHash: "review-retry-files-hash",
      adoptedHeadSha: HEAD_SHA,
      adoptionDecisionId: "review-retry-adoption",
      adoptedAt: now,
      artifactHash: "review-retry-artifact-hash",
      source: "test",
      createdAt: now,
      updatedAt: now,
    }).run();
    writeAdoptedBuildRunFile({
      repoPath,
      runNumber: 1,
      adoptedHeadSha: HEAD_SHA,
      adoptionDecisionId: "review-retry-adoption",
      patchSha256: "review-retry-patch-hash",
      changedFilesHash: "review-retry-files-hash",
      baseHeadSha: HEAD_SHA,
      baseCommit: HEAD_SHA,
    });
    seedStageRunSignal({
      phase: "Review",
      status: "failed",
      errorCode: "provider_run_failed",
      inputDbHash: "RUN-ACTION-CONTRACT-REVIEW-ORPHANED",
    });

    const retryReview = getActions(CHANGE_ID).find((action) => action.actionId === "retry_review");

    assert.equal(retryReview?.enabled, true);
    assert.equal(retryReview?.gateVersion, "0");
    assert.equal(
      retryReview?.sourceDbHash,
      `review-retry-patch-hash:review-retry-files-hash:${HEAD_SHA}`,
    );
  });

  it("shows recovered warning when provider timeout recovered from file", () => {
    db.update(changes)
      .set({ status: "INTAKE_READY", gateState: "intake" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", "passed", "prd-recovered-source-hash");
    // run_spec's enqueue authority (PRD phase) requires a locked briefing + draft
    // behind the passing PRD gate.
    seedLockedPrdBriefingAuthority();
    seedStageRunSignal({
      phase: "PRD",
      status: "passed",
      sourceLineageErrorCode: "provider_timeout_recovered_from_file",
      inputDbHash: "prd-recovered-input-hash",
      outputDbHash: "prd-recovered-output-hash",
    });

    const runSpec = getActions(CHANGE_ID).find((action) => action.actionId === "run_spec");

    assert.equal(runSpec?.enabled, true);
    assert.equal(runSpec?.reasonCode, null);
    assert.deepEqual(runSpec?.warnings, [
      {
        id: "provider_timeout_recovered_from_file",
        severity: "warning",
        title: "Provider timed out, but output was recovered from file.",
      },
    ]);
  });

  it("does not treat recovered timeout text as a retryable provider timeout", () => {
    db.update(changes)
      .set({ status: "INTAKE_READY", gateState: "intake" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", "passed", "prd-recovered-source-hash");
    seedStageProgress({
      phase: "prd_briefing_questions",
      status: "completed",
      message: "provider_timeout_recovered_from_file: recovered from candidate file",
      runId: "RUN-ACTION-CONTRACT-PRD-BRIEFING-RECOVERED",
    });

    const actions = getActions(CHANGE_ID);
    const retryPrd = actions.find((action) => action.actionId === "retry_prd");
    const runSpec = actions.find((action) => action.actionId === "run_spec");

    assert.equal(retryPrd?.enabled, false);
    assert.equal(retryPrd?.reasonCode, "not_at_gate");
    assert.deepEqual(runSpec?.warnings, [
      {
        id: "provider_timeout_recovered_from_file",
        severity: "warning",
        title: "Provider timed out, but output was recovered from file.",
      },
    ]);
  });

  it("does not block when mirror write fails after DB persistence", () => {
    db.update(changes)
      .set({ status: "INTAKE_READY", gateState: "intake" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", "passed", "prd-mirror-degraded-source-hash");
    // run_spec's enqueue authority (PRD phase) requires a locked briefing + draft.
    seedLockedPrdBriefingAuthority();
    seedStageProgress({
      phase: "PRD",
      status: "mirror_write_failed",
      message: "mirror_write_failed: DB state persisted, but mirror write failed",
    });

    const runSpec = getActions(CHANGE_ID).find((action) => action.actionId === "run_spec");

    assert.equal(runSpec?.enabled, true);
    assert.equal(runSpec?.reasonCode, null);
    assert.deepEqual(runSpec?.warnings, [
      {
        id: "mirror_write_failed",
        severity: "warning",
        title: "Mirror write failed after DB persistence.",
      },
    ]);
  });

  it("keeps retry_spec available for a blocked failed Spec round", () => {
    db.update(changes)
      .set({ status: "BLOCKED", blockedPhase: "spec", gateState: "intake" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", "passed", "prd-source-hash");
    // retry_spec's enqueue authority (PRD phase) requires a locked briefing + draft.
    seedLockedPrdBriefingAuthority();
    seedSpecBattleRound("failed");

    const actions = getActions(CHANGE_ID);
    const runSpec = actions.find((action) => action.actionId === "run_spec");
    const retrySpec = actions.find((action) => action.actionId === "retry_spec");

    assert.equal(runSpec?.enabled, false);
    assert.equal(runSpec?.reasonCode, "spec_round_failed_retry_required");
    assert.equal(retrySpec?.enabled, true);
    assert.equal(retrySpec?.sourceDbHash, "prd-source-hash");
    assert.equal(retrySpec?.gateVersion, "7");
  });

  it("keeps retry_prd available for a BLOCKED intake recovery while a locked briefing bars every sub-step", () => {
    db.update(changes)
      .set({ status: "BLOCKED", blockedPhase: "intake", gateState: "intake" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", "passed", "prd-source-hash");
    // A passing PRD gate is only enqueue-authority-valid when it is backed by a
    // locked briefing + draft (what retry_prd traces). Seed a non-critical
    // answered question so the draft/final-review briefing steps also trace to a
    // consistent briefing source.
    seedLockedPrdBriefingAuthority();
    db.insert(briefingQuestions).values({
      id: "BQ-ACTION-CONTRACT-RECOVERY",
      changeId: CHANGE_ID,
      category: "scope",
      severity: "normal",
      question: "Confirm recovery scope?",
      whyItMatters: "keeps intake recovery bounded",
      suggestedDefault: null,
      status: "answered",
      answer: "yes",
      source: "ai_blue",
      createdAt: "2026-06-29T00:01:00.000Z",
      updatedAt: "2026-06-29T00:01:00.000Z",
    }).run();

    const actions = getActions(CHANGE_ID);
    const retryPrd = actions.find((entry) => entry.actionId === "retry_prd");
    assert.ok(retryPrd, "retry_prd should be present");
    assert.equal(retryPrd.enabled, true, "retry_prd should be enabled at BLOCKED");
    assert.equal(retryPrd.reasonCode, null, "retry_prd should carry no blocking reason at BLOCKED");

    // With the briefing locked behind the passing PRD gate, NO briefing sub-step
    // is enqueue-authority-valid: assertMutable rejects a locked briefing, and
    // all three POSTs reach it (questions and draft via assertIntentCaptured,
    // the final review via assertFreshDraft). Each would 409 with
    // prd_briefing_locked, so each must surface as disabled rather than a
    // phantom. The UI reads the same rule -- canAskQuestions, canDraft and
    // canFinalReview all end in `&& !isLocked`.
    for (const actionId of [
      "run_prd_briefing_questions",
      "run_prd_briefing_draft",
      "run_prd_briefing_final_review",
    ] as const) {
      const action = actions.find((entry) => entry.actionId === actionId);
      assert.ok(action, `${actionId} should be present`);
      assert.equal(action.enabled, false, `${actionId} cannot run against a locked briefing`);
      assert.equal(action.reasonCode, "prd_briefing_locked", `${actionId} should report the lock`);
    }
  });

  it("keeps PRD briefing sub-steps enabled while the PRD gate they produce is blocked", () => {
    db.update(changes)
      .set({ status: "INTAKE_PENDING", gateState: null })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    // The live shape of the phantom-blocker defect: the PRD gate is blocked
    // *because* no fresh final review exists. The briefing sub-steps produce
    // that gate, so the gate must not be their precondition -- most sharply on
    // the final review, the action that exists to clear this very blocker.
    seedStageGate("PRD", "blocked", "prd-blocked-hash", [
      { id: "final-review", severity: "P1", title: "Fresh PRD final review is missing" },
    ]);
    seedOpenPrdBriefingWithDraft();

    const actions = getActions(CHANGE_ID);
    for (const actionId of [
      "run_prd_briefing_questions",
      "run_prd_briefing_draft",
      "run_prd_briefing_final_review",
    ] as const) {
      const action = actions.find((entry) => entry.actionId === actionId);
      assert.ok(action, `${actionId} should be present`);
      assert.equal(action.enabled, true, `${actionId} must not consume the PRD gate it produces`);
      assert.equal(action.reasonCode, null, `${actionId} should carry no blocking reason`);
      assert.deepEqual(action.blockers, [], `${actionId} must not inherit the PRD gate's blockers`);
      // Identity must trace the briefing (draft version + draft hash), not the
      // PRD stage gate (version 7 / prd-blocked-hash): an API client echoing
      // these tokens back must carry the lineage the action actually acted on.
      assert.equal(action.gateVersion, "1", `${actionId} should carry the draft version`);
      assert.equal(
        action.sourceDbHash,
        "action-contract-open-draft-hash",
        `${actionId} should carry the draft hash`,
      );
    }

    // The same blocked gate must still bite where it is genuinely a
    // precondition: retry_prd consumes the PRD gate rather than producing it.
    // This pins the blocker as intact -- the fix narrows who it applies to, it
    // does not remove it.
    const retryPrd = actions.find((entry) => entry.actionId === "retry_prd");
    assert.ok(retryPrd);
    assert.equal(retryPrd.enabled, false);
    assert.equal(retryPrd.reasonCode, "prd_blocked");
    assert.deepEqual(retryPrd.blockers, [
      { id: "final-review", severity: "P1", title: "Fresh PRD final review is missing" },
    ]);
  });

  it("disables a PRD briefing sub-step on its own authority, with briefing identity", () => {
    db.update(changes)
      .set({ status: "INTAKE_PENDING", gateState: null })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", "blocked", "prd-blocked-hash", [
      { id: "final-review", severity: "P1", title: "Fresh PRD final review is missing" },
    ]);
    // No draft yet: the final review is genuinely unavailable, but for the
    // briefing's own reason -- not the PRD gate's.
    seedOpenPrdBriefingWithDraft({ withDraft: false });

    const actions = getActions(CHANGE_ID);
    const finalReview = actions.find((entry) => entry.actionId === "run_prd_briefing_final_review");
    assert.ok(finalReview);
    assert.equal(finalReview.enabled, false);
    assert.equal(finalReview.reasonCode, "prd_draft_missing");
    assert.deepEqual(finalReview.blockers, []);
    // A disabled decision must not fall back to the PRD stage gate's identity.
    assert.equal(finalReview.gateVersion, "0");
    assert.equal(finalReview.sourceDbHash, "__missing_gate__");

    // Generating the draft is exactly what unblocks it, and stays available.
    const draft = actions.find((entry) => entry.actionId === "run_prd_briefing_draft");
    assert.ok(draft);
    assert.equal(draft.enabled, true);
    assert.equal(draft.reasonCode, null);
  });

  /**
   * The phantom-ENABLED direction of the same rule b77c0b2d fixed the other way
   * round. assertCanStartPrdBriefingFinalReview requires a FRESH draft, not
   * merely an existing one: answering one more question moves the briefing's
   * input hash and the recorded draftInputHash goes stale, after which a POST
   * fails closed with fresh_prd_draft_required. /gate reporting enabled=true
   * there promises an action that cannot be dispatched.
   *
   * Both sides are asserted together, because agreement between them -- not the
   * literal reason string -- is the contract.
   */
  it("disables the PRD final review once its draft goes stale, matching the POST", () => {
    db.update(changes)
      .set({ status: "INTAKE_PENDING", gateState: null })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", "blocked", "prd-blocked-hash");
    seedOpenPrdBriefingWithDraft();
    // The production shape: the draft was generated at input A, then the human
    // answered another question. The draft is now stale against input B.
    db.update(briefingQuestions)
      .set({ status: "answered", answer: "yes" })
      .where(eq(briefingQuestions.id, "BQ-ACTION-CONTRACT-OPEN"))
      .run();

    const finalReview = getActions(CHANGE_ID)
      .find((entry) => entry.actionId === "run_prd_briefing_final_review");
    assert.ok(finalReview);
    assert.equal(finalReview.enabled, false, "a stale draft cannot be sent to final review");
    assert.equal(finalReview.reasonCode, "prd_draft_stale");
    // Not the PRD gate's identity, and not the gate's blockers.
    assert.deepEqual(finalReview.blockers, []);
    assert.equal(finalReview.sourceDbHash, "__missing_gate__");

    assert.throws(
      () => assertCanStartPrdBriefingFinalReview(CHANGE_ID),
      (error: unknown) =>
        error instanceof PrdBriefingError && error.code === "fresh_prd_draft_required",
      "the dispatch path must refuse the same state /gate reported disabled",
    );
  });

  /**
   * The staleness test above, in the direction that regressed: a draft that is
   * genuinely FRESH must be reported fresh by BOTH paths, whatever order the
   * question rows arrive in.
   *
   * This was a 100% blocker in production, not an edge case. The two callers of
   * prdBriefingInputHash ordered rows differently -- the write path sorted by
   * (createdAt, id), the read path passed a bare `.all()` in rowid order -- so
   * the same cards hashed to two different digests and NO stored value could
   * satisfy both. assertFreshDraft demanded the sorted digest, the dispatcher
   * demanded the rowid one; every briefing reported prd_draft_stale forever and
   * PRD could never reach canLock. The suite missed it only because the seed
   * had a single card, where all orderings coincide.
   *
   * So this asserts agreement, not a reason string: /gate says enabled and the
   * dispatch precondition accepts, over a card set whose rowid order and sorted
   * order deliberately disagree.
   */
  it("keeps the PRD final review enabled when rows arrive unsorted, matching the POST", () => {
    db.update(changes)
      .set({ status: "INTAKE_PENDING", gateState: null })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", "blocked", "prd-blocked-hash");
    seedOpenPrdBriefingWithDraft();

    // Guard the premise: if these ever coincide the test proves nothing, since
    // a caller-ordered hash would then agree with a normalized one by accident.
    const rowidOrder = db.select().from(briefingQuestions)
      .where(eq(briefingQuestions.changeId, CHANGE_ID)).all();
    const sortedOrder = [...rowidOrder]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    assert.equal(rowidOrder.length, 2, "the ordering premise needs at least two cards");
    assert.deepEqual(
      [...new Set(rowidOrder.map((row) => row.createdAt))].length,
      1,
      "both cards must share one createdAt so the sort falls through to id",
    );
    assert.notDeepEqual(
      rowidOrder.map((row) => row.id),
      sortedOrder.map((row) => row.id),
      "rowid order and sorted order must disagree, or this test is vacuous",
    );

    // Ordering is a property of the hash, not of whoever calls it.
    assert.equal(
      prdBriefingInputHash({ intentText: "Action contract open PRD briefing." }, rowidOrder),
      prdBriefingInputHash({ intentText: "Action contract open PRD briefing." }, sortedOrder),
      "the same cards in a different order must hash identically",
    );

    const finalReview = getActions(CHANGE_ID)
      .find((entry) => entry.actionId === "run_prd_briefing_final_review");
    assert.ok(finalReview);
    assert.equal(finalReview.enabled, true, "a fresh draft must not read as stale");
    assert.equal(finalReview.reasonCode, null);

    assert.doesNotThrow(
      () => assertCanStartPrdBriefingFinalReview(CHANGE_ID),
      "the dispatch path must accept the same state /gate reported enabled",
    );
  });

  /**
   * Same class, opposite verdict since rounds landed. /gate used to disable the
   * questions step with prd_questions_have_human_actions once any card carried
   * a recorded action, mirroring assertQuestionsCanBeReplaced: regeneration
   * replaced the card set, so it would have destroyed those answers.
   *
   * Generation appends a round now. Nothing is overwritten, the dispatch path
   * accepts, and a /gate that still reported the step disabled would be the
   * phantom-DISABLED defect -- it would tell the user the interrogation is over
   * when a POST would happily open another round. Asserts the agreement, not
   * the reason string, in both directions.
   *
   * Deliberately asserts the questions step only, so it stands on its own cause
   * rather than sharing one with the staleness test above: re-running the DRAFT
   * is legitimate in this state too, and is asserted to stay enabled.
   */
  it("keeps briefing question rounds available once a card has a human action", () => {
    db.update(changes)
      .set({ status: "INTAKE_PENDING", gateState: null })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", "blocked", "prd-blocked-hash");
    seedOpenPrdBriefingWithDraft({ withDraft: false });
    db.update(briefingQuestions)
      .set({ status: "answered", answer: "yes" })
      .where(eq(briefingQuestions.id, "BQ-ACTION-CONTRACT-OPEN"))
      .run();

    const actions = getActions(CHANGE_ID);
    const questions = actions.find((entry) => entry.actionId === "run_prd_briefing_questions");
    assert.ok(questions);
    assert.equal(questions.enabled, true, "an answered card must not end the interrogation");
    assert.equal(questions.reasonCode, null);
    assert.deepEqual(questions.blockers, []);

    assert.doesNotThrow(
      () => assertCanStartPrdBriefingQuestions(CHANGE_ID),
      "the dispatch path must accept the same state /gate reported enabled",
    );

    // The answered card does not disable the rest of the briefing.
    const draft = actions.find((entry) => entry.actionId === "run_prd_briefing_draft");
    assert.ok(draft);
    assert.equal(draft.enabled, true);
    assert.equal(draft.reasonCode, null);
  });

  it("keeps Spec run actions disabled until the Intake gate is approved", () => {
    db.update(changes)
      .set({ status: "INTAKE_READY", gateState: null })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", "passed", "prd-source-hash");

    for (const gateState of [null, "spec"]) {
      db.update(changes)
        .set({ gateState })
        .where(eq(changes.id, CHANGE_ID))
        .run();

      const actions = getActions(CHANGE_ID);
      const runSpec = actions.find((action) => action.actionId === "run_spec");
      const retrySpec = actions.find((action) => action.actionId === "retry_spec");

      assert.equal(runSpec?.enabled, false);
      assert.equal(runSpec?.reasonCode, "intake_gate_unapproved");
      assert.equal(runSpec?.reason, "Intake gate must be approved before Spec generation");
      assert.equal(retrySpec?.enabled, false);
      assert.equal(retrySpec?.reasonCode, "intake_gate_unapproved");
      assert.equal(retrySpec?.reason, "Intake gate must be approved before Spec generation");
    }
  });

  it("derives TechSpec run actions from the approved Spec stage contract", () => {
    db.update(changes)
      .set({ status: "SPEC_READY", gateState: "spec" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("Spec", "passed", "spec-source-hash");
    // TechSpec run/retry trace the Spec gate; back it with the passing Spec stage
    // run the enqueue authority requires.
    seedAuthorityBackedStageSource("Spec", "spec", "spec-source-hash");
    seedSpecBattleRound("closed");

    const actions = getActions(CHANGE_ID);
    const runTechSpec = actions.find((action) => action.actionId === "run_tech_spec");
    const retryTechSpec = actions.find((action) => action.actionId === "retry_tech_spec");

    assert.equal(runTechSpec?.enabled, true);
    assert.equal(runTechSpec?.phase, "Plan");
    assert.equal(runTechSpec?.sourceDbHash, "spec-source-hash");
    assert.equal(runTechSpec?.gateVersion, "7");
    assert.equal(runTechSpec?.requiresIdempotencyKey, true);
    assert.equal(retryTechSpec?.enabled, true);
    assert.equal(retryTechSpec?.sourceDbHash, "spec-source-hash");
    assert.notEqual(runTechSpec?.reasonCode, "tech_spec_gate_missing");
    assert.notEqual(retryTechSpec?.reasonCode, "tech_spec_gate_missing");
  });

  it("keeps TechSpec run actions disabled until the Spec battle round is closed", () => {
    db.update(changes)
      .set({ status: "SPEC_READY", gateState: "spec" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("Spec", "passed", "spec-source-hash");
    seedSpecBattleRound("report_ready");

    const actions = getActions(CHANGE_ID);
    const runTechSpec = actions.find((action) => action.actionId === "run_tech_spec");
    const retryTechSpec = actions.find((action) => action.actionId === "retry_tech_spec");

    assert.equal(runTechSpec?.enabled, false);
    assert.equal(runTechSpec?.reasonCode, "spec_battle_not_closed");
    assert.equal(runTechSpec?.sourceDbHash, "spec-source-hash");
    assert.equal(runTechSpec?.gateVersion, "7");
    assert.equal(retryTechSpec?.enabled, false);
    assert.equal(retryTechSpec?.reasonCode, "spec_battle_not_closed");
  });

  it("unlocks TestPlan from Plan and Build from TestPlan contracts in order", () => {
    initCleanGitRepo(repoPath);
    db.update(changes)
      .set({ status: "PLAN_APPROVED" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("Plan", "passed", "plan-source-hash");
    // run_test_plan traces the Plan gate; with no plan_snapshots rows the authority
    // uses the legacy stage-run/business-run pairing.
    seedAuthorityBackedStageSource("Plan", "generate_plan", "plan-source-hash");

    let actions = getActions(CHANGE_ID);
    const runTestPlan = actions.find((action) => action.actionId === "run_test_plan");
    const runBuildBeforeTestPlan = actions.find((action) => action.actionId === "run_build");
    assert.equal(runTestPlan?.enabled, true);
    assert.equal(runTestPlan?.sourceDbHash, "plan-source-hash");
    assert.equal(runBuildBeforeTestPlan?.enabled, false);
    assert.equal(runBuildBeforeTestPlan?.reasonCode, "build_gate_missing");

    seedStageGate("TestPlan", "passed", "testplan-source-hash");
    // run_build traces the TestPlan gate; back it via the legacy pairing path.
    seedAuthorityBackedStageSource("TestPlan", "test_plan", "testplan-source-hash");
    db.update(changes)
      .set({ status: "TESTPLAN_DONE" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    actions = getActions(CHANGE_ID);
    const runBuildAfterTestPlan = actions.find((action) => action.actionId === "run_build");
    const retryBuildAfterTestPlan = actions.find((action) => action.actionId === "retry_build");
    const approvePlanAfterTestPlan = actions.find((action) => action.actionId === "approve_plan");
    assert.equal(runBuildAfterTestPlan?.enabled, false);
    assert.equal(runBuildAfterTestPlan?.reasonCode, "not_at_gate");
    assert.equal(retryBuildAfterTestPlan?.enabled, false);
    assert.equal(retryBuildAfterTestPlan?.reasonCode, "not_at_gate");
    assert.equal(approvePlanAfterTestPlan?.enabled, true);
    assert.equal(approvePlanAfterTestPlan?.sourceDbHash, "testplan-source-hash");

    db.update(changes)
      .set({ status: "PLAN_APPROVED" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    actions = getActions(CHANGE_ID);
    const runBuildAfterConfirm = actions.find((action) => action.actionId === "run_build");
    const retryBuildAfterConfirm = actions.find((action) => action.actionId === "retry_build");
    assert.equal(runBuildAfterConfirm?.enabled, true);
    assert.equal(runBuildAfterConfirm?.sourceDbHash, "testplan-source-hash");
    assert.equal(retryBuildAfterConfirm?.enabled, true);
    assert.equal(retryBuildAfterConfirm?.sourceDbHash, "testplan-source-hash");
  });

  it("disables Build actions when the project repo is not a git repository", () => {
    db.update(changes)
      .set({ status: "PLAN_APPROVED" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("TestPlan", "passed", "testplan-source-hash");

    const actions = getActions(CHANGE_ID);
    const runBuild = actions.find((action) => action.actionId === "run_build");
    const retryBuild = actions.find((action) => action.actionId === "retry_build");

    assert.equal(runBuild?.enabled, false);
    assert.equal(runBuild?.reasonCode, "build_base_camp_blocked");
    assert.equal(runBuild?.reason, "Build workspace base camp blocked: Path is not a git repository.");
    assert.deepEqual(runBuild?.blockers, [
      { id: "build_base_camp_1", severity: "P1", title: "Path is not a git repository." },
    ]);
    assert.equal(retryBuild?.enabled, false);
    assert.equal(retryBuild?.reasonCode, "build_base_camp_blocked");
  });

  /**
   * The git actions. Before they existed the contract held zero of them, so the
   * two facts below were invisible to the pipeline: "this path is not a git
   * repository" was something only run_build consulted, and only to refuse
   * itself, and "there is uncommitted work" was not represented at all -- the Git
   * tool panel beside the pipeline could see it, the gate could not.
   */
  it("offers init_git_repo as the escape from the same stall that blocks Build on a non-repository", () => {
    db.update(changes).set({ status: "PLAN_APPROVED" }).where(eq(changes.id, CHANGE_ID)).run();
    seedStageGate("TestPlan", "passed", "testplan-source-hash");

    const actions = getActions(CHANGE_ID);
    const runBuild = actions.find((action) => action.actionId === "run_build");
    const initGitRepo = actions.find((action) => action.actionId === "init_git_repo");
    const commitChanges = actions.find((action) => action.actionId === "commit_changes");

    // The stall and its exit are served by the same contract, in the same read.
    assert.equal(runBuild?.enabled, false);
    assert.equal(runBuild?.reasonCode, "build_base_camp_blocked");

    assert.equal(initGitRepo?.enabled, true);
    assert.equal(initGitRepo?.reasonCode, null);
    assert.deepEqual(initGitRepo?.blockers, []);

    assert.equal(commitChanges?.enabled, false);
    assert.equal(commitChanges?.reasonCode, "git_repo_missing");
    assert.equal(commitChanges?.reason, "Cannot commit: Path is not a git repository.");
    // Same wording run_build's base camp blocker uses -- one fault, one name.
    assert.deepEqual(commitChanges?.blockers, [
      { id: "git_repo_missing", severity: "P1", title: "Path is not a git repository." },
    ]);
  });

  it("closes init_git_repo and opens commit_changes once the tree carries uncommitted work", () => {
    initCleanGitRepo(repoPath);
    seedStageGate("Build", "passed", "build-source-hash");

    const cleanActions = getActions(CHANGE_ID);
    const cleanInit = cleanActions.find((action) => action.actionId === "init_git_repo");
    const cleanCommit = cleanActions.find((action) => action.actionId === "commit_changes");

    assert.equal(cleanInit?.enabled, false);
    assert.equal(cleanInit?.reasonCode, "git_repo_already_initialized");
    assert.deepEqual(cleanInit?.blockers, []);
    assert.equal(cleanCommit?.enabled, false);
    assert.equal(cleanCommit?.reasonCode, "git_worktree_clean");
    // A clean tree is not a fault, so it must not manufacture a blocker: this is
    // the steady state of every healthy change.
    assert.deepEqual(cleanCommit?.blockers, []);

    fs.writeFileSync(path.join(repoPath, "src.ts"), "export const x = 1;\n");

    const dirtyCommit = getActions(CHANGE_ID).find((action) => action.actionId === "commit_changes");
    assert.equal(dirtyCommit?.enabled, true);
    assert.equal(dirtyCommit?.reasonCode, null);
    assert.deepEqual(dirtyCommit?.blockers, []);
  });

  it("does not report the change's own pipeline artifact churn as uncommitted work", () => {
    initCleanGitRepo(repoPath);
    const changeArtifactDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
    fs.mkdirSync(changeArtifactDir, { recursive: true });
    fs.writeFileSync(path.join(changeArtifactDir, "plan.json"), "{}\n");
    fs.mkdirSync(path.join(repoPath, ".ship", "prompts"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, ".ship", "prompts", "build.md"), "# prompt\n");
    seedStageGate("Build", "passed", "build-source-hash");

    const artifactOnly = getActions(CHANGE_ID).find((action) => action.actionId === "commit_changes");

    // Every stage writes into .ship on every run. Counting those as "work to
    // commit" would leave the action permanently enabled and permanently
    // meaningless, so it reads the same exclusion list the Build base camp does.
    assert.equal(artifactOnly?.enabled, false);
    assert.equal(artifactOnly?.reasonCode, "git_worktree_clean");

    fs.writeFileSync(path.join(repoPath, "src.ts"), "export const x = 1;\n");
    const withRealWork = getActions(CHANGE_ID).find((action) => action.actionId === "commit_changes");
    assert.equal(withRealWork?.enabled, true);
  });

  it("enables the initial commit on a repository that has no commits yet", () => {
    // Exactly the state init_git_repo leaves behind, so the two actions have to
    // hand off cleanly: HEAD does not resolve, and every file is committable.
    fs.mkdirSync(repoPath, { recursive: true });
    execSync("git init -b main", { cwd: repoPath, stdio: "ignore" });
    fs.writeFileSync(path.join(repoPath, "README.md"), "# unborn\n");
    seedStageGate("Build", "passed", "build-source-hash");

    const commitChanges = getActions(CHANGE_ID).find((action) => action.actionId === "commit_changes");

    assert.equal(commitChanges?.enabled, true);
    assert.equal(commitChanges?.sourceDbHash, "git_head:unborn");
  });

  /**
   * The git actions are stamped with their own identity instead of the Build
   * gate's, and this is why.
   *
   * GET /gate serves computeActions (no self-heal, no persist) while preflight
   * runs getActions (self-heals, persists, and bumps stage gate versions), so an
   * action that borrows the stage gate's version can be handed out by a render
   * and then refused by the very next POST with gate_version_drift. Pinning
   * gateVersion to a constant and sourceDbHash to HEAD takes these two out of
   * that race: the value the page renders is the value preflight compares
   * against, whichever entry point produced it.
   */
  it("issues git actions with a gate-independent identity that preflight accepts", () => {
    initCleanGitRepo(repoPath);
    fs.writeFileSync(path.join(repoPath, "src.ts"), "export const x = 1;\n");
    seedStageGate("Build", "passed", "build-source-hash");
    const headSha = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();

    const rendered = computeActions(CHANGE_ID).find((action) => action.actionId === "commit_changes");
    assert.equal(rendered?.enabled, true);
    assert.equal(rendered?.gateVersion, "0");
    assert.equal(rendered?.sourceDbHash, `git_head:${headSha}`);
    // NOT the Build gate's 7/build-source-hash, which self-heal is free to move.
    assert.notEqual(rendered?.gateVersion, "7");
    assert.notEqual(rendered?.sourceDbHash, "build-source-hash");

    const refreshed = getActions(CHANGE_ID).find((action) => action.actionId === "commit_changes");
    assert.equal(refreshed?.gateVersion, rendered?.gateVersion);
    assert.equal(refreshed?.sourceDbHash, rendered?.sourceDbHash);

    // The contract the page rendered survives the self-healing preflight path.
    const allowed = assertActionAllowed({
      changeId: CHANGE_ID,
      actionId: "commit_changes",
      expectedGateVersion: rendered!.gateVersion,
      expectedSourceDbHash: rendered!.sourceDbHash,
    });
    assert.equal(allowed.actionId, "commit_changes");
  });

  it("refuses a commit whose contract was issued against a HEAD that has since moved", () => {
    initCleanGitRepo(repoPath);
    fs.writeFileSync(path.join(repoPath, "src.ts"), "export const x = 1;\n");
    seedStageGate("Build", "passed", "build-source-hash");
    const stale = computeActions(CHANGE_ID).find((action) => action.actionId === "commit_changes");
    assert.equal(stale?.enabled, true);

    // Something else lands a commit -- in the double-submit case, this action's
    // own first POST. HEAD is what makes the second one refusable even though
    // the tree is dirty again.
    execSync("git add -A", { cwd: repoPath, stdio: "ignore" });
    execSync("git commit -m other", { cwd: repoPath, stdio: "ignore" });
    fs.writeFileSync(path.join(repoPath, "other.ts"), "export const y = 2;\n");

    const current = computeActions(CHANGE_ID).find((action) => action.actionId === "commit_changes");
    assert.equal(current?.enabled, true);
    assert.notEqual(current?.sourceDbHash, stale?.sourceDbHash);

    assert.throws(
      () =>
        assertActionAllowed({
          changeId: CHANGE_ID,
          actionId: "commit_changes",
          expectedGateVersion: stale!.gateVersion,
          expectedSourceDbHash: stale!.sourceDbHash,
        }),
      (error: unknown) =>
        error instanceof PreflightBlockedError &&
        error.envelope.reasonCode === "source_db_hash_drift",
    );
  });

  it("allows Build actions when base camp is dirty with warnings but no blockers", () => {
    initCleanGitRepo(repoPath);
    fs.writeFileSync(path.join(repoPath, "README.md"), "# dirty action contract fixture\n");
    db.update(changes)
      .set({ status: "PLAN_APPROVED" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("TestPlan", "passed", "testplan-source-hash");
    // Build run/retry trace the TestPlan gate; back it via the legacy pairing path.
    seedAuthorityBackedStageSource("TestPlan", "test_plan", "testplan-source-hash");

    const actions = getActions(CHANGE_ID);
    const runBuild = actions.find((action) => action.actionId === "run_build");
    const retryBuild = actions.find((action) => action.actionId === "retry_build");

    assert.equal(runBuild?.enabled, true);
    assert.equal(retryBuild?.enabled, true);
    assert.notEqual(runBuild?.reasonCode, "build_base_camp_blocked");
    assert.notEqual(retryBuild?.reasonCode, "build_base_camp_blocked");
  });

  it("disables retry_build when a Build run is actively running", () => {
    initCleanGitRepo(repoPath);
    db.update(changes).set({ status: "IMPLEMENTING" }).where(eq(changes.id, CHANGE_ID)).run();
    seedStageGate("TestPlan", "passed", "testplan-source-hash");
    seedRunningImplementRun({ startedAt: new Date().toISOString() });
    seedBuildRunRecord({ status: "running", updatedAt: new Date().toISOString() });

    const retryBuild = getActions(CHANGE_ID).find((action) => action.actionId === "retry_build");

    assert.equal(retryBuild?.enabled, false);
    assert.equal(retryBuild?.reasonCode, "build_run_running");
  });

  for (const status of ["queued", "leased", "running"] as const) {
    it(`disables duplicate Build actions for an active ${status} implement job while PLAN_APPROVED`, () => {
      initCleanGitRepo(repoPath);
      db.update(changes).set({ status: "PLAN_APPROVED" }).where(eq(changes.id, CHANGE_ID)).run();
      seedStageGate("TestPlan", "passed", "testplan-source-hash");
      const now = new Date().toISOString();
      db.insert(pipelineJobs).values({
        id: `JOB-ACTION-BUILD-${status}`,
        changeId: CHANGE_ID,
        phase: "implement",
        actionId: "run_build",
        idempotencyKey: `build-${status}`,
        status,
        leasedBy: status === "queued" ? null : "worker-1",
        leaseExpiresAt: status === "queued" ? null : new Date(Date.now() + 60_000).toISOString(),
        heartbeatAt: status === "running" ? now : null,
        attemptNo: 1,
        errorCode: null,
        errorSummary: null,
        createdAt: now,
        startedAt: status === "running" ? now : null,
        endedAt: null,
        leaseToken: status === "queued" ? null : "lease-build",
        workerNonce: status === "queued" ? null : "worker-nonce",
      }).run();

      const actions = getActions(CHANGE_ID);
      for (const actionId of ["run_build", "retry_build"] as const) {
        const action = actions.find((candidate) => candidate.actionId === actionId);
        assert.equal(action?.enabled, false);
        assert.equal(action?.reasonCode, "provider_job_running");
      }
    });
  }

  it("guards every provider-backed action with its active pipeline job phase", () => {
    const cases = [
      ["intake", "run_prd"],
      ["spec", "run_spec"],
      ["tech_spec", "run_tech_spec"],
      ["generate_plan", "run_plan"],
      ["test_plan", "run_test_plan"],
      ["implement", "run_build"],
      ["review", "run_review"],
      ["fix_findings", "fix_blockers"],
      ["local_check", "run_qa"],
      ["release", "merge"],
      ["retro", "run_retro"],
    ] as const;
    const now = new Date().toISOString();

    for (const [phase, actionId] of cases) {
      db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).run();
      db.insert(pipelineJobs).values({
        id: `JOB-ACTION-MAP-${phase}`,
        changeId: CHANGE_ID,
        phase,
        actionId,
        idempotencyKey: `map-${phase}`,
        status: "queued",
        leasedBy: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        attemptNo: 1,
        errorCode: null,
        errorSummary: null,
        createdAt: now,
        startedAt: null,
        endedAt: null,
        leaseToken: null,
        workerNonce: null,
      }).run();

      const action = getActions(CHANGE_ID).find((candidate) => candidate.actionId === actionId);
      assert.equal(action?.enabled, false, `${actionId} must be guarded by ${phase}`);
      assert.equal(action?.reasonCode, "provider_job_running", `${actionId} must map to ${phase}`);
    }
  });

  it("disables retry_build when an old running Build still has a live provider", () => {
    initCleanGitRepo(repoPath);
    db.update(changes).set({ status: "IMPLEMENTING" }).where(eq(changes.id, CHANGE_ID)).run();
    seedStageGate("TestPlan", "passed", "testplan-source-hash");
    seedRunningImplementRun({ startedAt: "2026-07-07T16:11:18.181Z" });
    seedBuildRunFile({
      repoPath,
      runNumber: 1,
      status: "running",
      updatedAt: "2026-07-07T16:11:18.317Z",
    });
    seedBuildRunRecord({ status: "running", updatedAt: "2026-07-07T16:11:18.317Z" });
    const restoreClock = setBuildStaleRunClockForTest(() => new Date("2026-07-08T01:00:00.000Z"));
    const restoreLiveness = setBuildProviderLivenessForTest(() => true);

    try {
      const retryBuild = getActions(CHANGE_ID).find((action) => action.actionId === "retry_build");

      assert.equal(retryBuild?.enabled, false);
      assert.equal(retryBuild?.reasonCode, "build_run_running");
    } finally {
      restoreLiveness();
      restoreClock();
    }
  });

  it("enables retry_build when IMPLEMENTING has a stale running Build", () => {
    initCleanGitRepo(repoPath);
    db.update(changes).set({ status: "IMPLEMENTING" }).where(eq(changes.id, CHANGE_ID)).run();
    seedStageGate("TestPlan", "passed", "testplan-source-hash");
    seedRunningImplementRun({ startedAt: "2026-07-07T16:11:18.181Z" });
    seedBuildRunFile({
      repoPath,
      runNumber: 1,
      status: "running",
      updatedAt: "2026-07-07T16:11:18.317Z",
    });
    seedBuildRunRecord({ status: "running", updatedAt: "2026-07-07T16:11:18.317Z" });
    // retry_build traces the TestPlan gate; back it via the legacy pairing path so
    // the stale-run recovery contract stays enqueue-authority-consistent.
    seedAuthorityBackedStageSource("TestPlan", "test_plan", "testplan-source-hash");

    const restoreClock = setBuildStaleRunClockForTest(() => new Date("2026-07-08T01:00:00.000Z"));
    const restoreLiveness = setBuildProviderLivenessForTest(() => false);
    try {
      const retryBuild = getActions(CHANGE_ID).find((action) => action.actionId === "retry_build");

      assert.equal(retryBuild?.enabled, true);
      assert.equal(retryBuild?.reasonCode, null);
    } finally {
      restoreLiveness();
      restoreClock();
    }
  });

  it("keeps retry_build disabled for active running Build even when prior Build output is retryable", () => {
    initCleanGitRepo(repoPath);
    db.update(changes).set({ status: "IMPLEMENTING" }).where(eq(changes.id, CHANGE_ID)).run();
    seedStageGate("TestPlan", "passed", "testplan-source-hash");
    seedRunningImplementRun({ startedAt: new Date().toISOString() });
    seedBuildRunRecord({ status: "running", updatedAt: new Date().toISOString() });
    seedRetryableStageOutputSignal({ phase: "Build", errorCode: "provider_timeout" });

    const retryBuild = getActions(CHANGE_ID).find((action) => action.actionId === "retry_build");

    assert.equal(retryBuild?.enabled, false);
    assert.equal(retryBuild?.reasonCode, "build_run_running");
  });

  it("keeps retry_build disabled outside the Build gate even when prior Build output is retryable", () => {
    initCleanGitRepo(repoPath);
    db.update(changes).set({ status: "TESTPLAN_DONE" }).where(eq(changes.id, CHANGE_ID)).run();
    seedStageGate("TestPlan", "passed", "testplan-source-hash");
    seedRetryableStageOutputSignal({ phase: "Build", errorCode: "provider_timeout" });

    const retryBuild = getActions(CHANGE_ID).find((action) => action.actionId === "retry_build");

    assert.equal(retryBuild?.enabled, false);
    assert.equal(retryBuild?.reasonCode, "not_at_gate");
  });

  it("keeps retry_build disabled when base camp is blocked even when prior Build output is retryable", () => {
    db.update(changes).set({ status: "PLAN_APPROVED" }).where(eq(changes.id, CHANGE_ID)).run();
    seedStageGate("TestPlan", "passed", "testplan-source-hash");
    seedRetryableStageOutputSignal({ phase: "Build", errorCode: "provider_timeout" });

    const retryBuild = getActions(CHANGE_ID).find((action) => action.actionId === "retry_build");

    assert.equal(retryBuild?.enabled, false);
    assert.equal(retryBuild?.reasonCode, "build_base_camp_blocked");
  });

  it("uses approve_plan to confirm TestPlan after TestPlan is done", () => {
    db.update(changes)
      .set({ status: "TESTPLAN_DONE" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("TestPlan", "passed", "testplan-approval-hash");

    const approvePlan = getActions(CHANGE_ID).find((action) => action.actionId === "approve_plan");

    assert.equal(approvePlan?.enabled, true);
    assert.equal(approvePlan?.sourceDbHash, "testplan-approval-hash");
  });

  it("self-heals legacy TestPlan approval blockers without re-enabling plan approval", () => {
    initCleanGitRepo(repoPath);
    db.update(changes)
      .set({ status: "PLAN_APPROVED" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedPendingApprovalTestPlanSnapshot();
    seedStageGate("TestPlan", "blocked", "testplan-pending-approval-hash", [
      { id: "testplan_approval", severity: "P1", title: "TestPlan requires approval before QA" },
    ]);

    const actions = getActions(CHANGE_ID);
    const approvePlan = actions.find((action) => action.actionId === "approve_plan");
    const runBuild = actions.find((action) => action.actionId === "run_build");
    const retryBuild = actions.find((action) => action.actionId === "retry_build");
    const snapshot = db.select().from(testplanSnapshots).where(eq(testplanSnapshots.id, "TPS-ACTION-CONTRACT-PENDING")).get();
    const gate = db
      .select()
      .from(stageGates)
      .where(eq(stageGates.changeId, CHANGE_ID))
      .all()
      .filter((candidate) => candidate.phase === "TestPlan")
      .sort((a, b) => b.computedAt.localeCompare(a.computedAt))[0];

    assert.equal(approvePlan?.enabled, false);
    assert.equal(approvePlan?.reasonCode, "not_at_gate");
    assert.equal(runBuild?.enabled, true);
    assert.equal(retryBuild?.enabled, true);
    assert.equal(snapshot?.approvalState, "approved");
    assert.equal(gate?.status, "passed");
  });

  it("enables Build absorb actions from the latest awaiting BuildRun record", () => {
    initCleanGitRepo(repoPath);
    const now = "2026-06-29T00:04:00.000Z";
    db.update(changes)
      .set({ status: "IMPLEMENTING" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    db.insert(buildRunRecords).values({
      id: "BRR-ACTION-CONTRACT-AWAITING",
      changeId: CHANGE_ID,
      runId: null,
      buildRunId: "build-1",
      status: "awaiting_human",
      headSha: null,
      baseHeadSha: HEAD_SHA,
      baseCommit: HEAD_SHA,
      patchHash: "patch-hash",
      changedFilesHash: "changed-files-hash",
      adoptedHeadSha: null,
      adoptionDecisionId: null,
      adoptedAt: null,
      artifactHash: "artifact-hash",
      source: "test",
      createdAt: now,
      updatedAt: now,
    }).run();

    const actions = getActions(CHANGE_ID);
    const adoptBuild = actions.find((action) => action.actionId === "adopt_build");
    const rejectBuild = actions.find((action) => action.actionId === "reject_build");

    assert.equal(adoptBuild?.enabled, true);
    assert.equal(adoptBuild?.sourceDbHash, "patch-hash:changed-files-hash");
    assert.equal(rejectBuild?.enabled, true);
    assert.equal(rejectBuild?.sourceDbHash, "patch-hash:changed-files-hash");
  });

  it("keeps Build absorb actions enabled when base camp is dirty with warnings", () => {
    initCleanGitRepo(repoPath);
    fs.writeFileSync(path.join(repoPath, "README.md"), "# dirty absorb fixture\n");
    const now = "2026-06-29T00:04:00.000Z";
    db.update(changes)
      .set({ status: "IMPLEMENTING" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    db.insert(buildRunRecords).values({
      id: "BRR-ACTION-CONTRACT-ABSORB-DIRTY",
      changeId: CHANGE_ID,
      runId: null,
      buildRunId: "build-dirty",
      status: "approved_for_absorb",
      headSha: null,
      baseHeadSha: HEAD_SHA,
      baseCommit: HEAD_SHA,
      patchHash: "patch-hash",
      changedFilesHash: "changed-files-hash",
      adoptedHeadSha: null,
      adoptionDecisionId: null,
      adoptedAt: null,
      artifactHash: "artifact-hash",
      source: "test",
      createdAt: now,
      updatedAt: now,
    }).run();

    const actions = getActions(CHANGE_ID);
    const adoptBuild = actions.find((action) => action.actionId === "adopt_build");

    assert.equal(adoptBuild?.enabled, true);
    assert.equal(adoptBuild?.reasonCode, null);
    assert.equal(adoptBuild?.reason, null);
  });

  it("applies reject_build policy boundaries for failed and gate-blocked BuildRun records", () => {
    db.update(changes)
      .set({ status: "IMPLEMENTING" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    db.insert(buildRunRecords).values({
      id: "BRR-ACTION-CONTRACT-FAILED",
      changeId: CHANGE_ID,
      runId: null,
      buildRunId: "build-failed",
      status: "failed",
      headSha: null,
      baseHeadSha: HEAD_SHA,
      baseCommit: HEAD_SHA,
      patchHash: "failed-patch-hash",
      changedFilesHash: "failed-changed-files-hash",
      adoptedHeadSha: null,
      adoptionDecisionId: null,
      adoptedAt: null,
      artifactHash: "failed-artifact-hash",
      source: "test",
      createdAt: "2026-06-29T00:04:00.000Z",
      updatedAt: "2026-06-29T00:04:00.000Z",
    }).run();

    let rejectBuild = getActions(CHANGE_ID).find((action) => action.actionId === "reject_build");

    assert.equal(rejectBuild?.enabled, false);
    assert.equal(rejectBuild?.reasonCode, "build_not_rejectable");
    assert.equal(rejectBuild?.reason, "Build run is failed");

    db.insert(buildRunRecords).values({
      id: "BRR-ACTION-CONTRACT-GATE-BLOCKED",
      changeId: CHANGE_ID,
      runId: null,
      buildRunId: "build-gate-blocked",
      status: "gate_blocked",
      headSha: null,
      baseHeadSha: HEAD_SHA,
      baseCommit: HEAD_SHA,
      patchHash: "gate-blocked-patch-hash",
      changedFilesHash: "gate-blocked-changed-files-hash",
      adoptedHeadSha: null,
      adoptionDecisionId: null,
      adoptedAt: null,
      artifactHash: "gate-blocked-artifact-hash",
      source: "test",
      createdAt: "2026-06-29T00:05:00.000Z",
      updatedAt: "2026-06-29T00:05:00.000Z",
    }).run();

    rejectBuild = getActions(CHANGE_ID).find((action) => action.actionId === "reject_build");

    assert.equal(rejectBuild?.enabled, true);
    assert.equal(rejectBuild?.sourceDbHash, "gate-blocked-patch-hash:gate-blocked-changed-files-hash");
  });

  it("disables enter_qa when only an old TestPlan snapshot has required commands", () => {
    seedStageGate("Review", "passed", "review-source-hash");
    seedStageGate("TestPlan", "passed", "testplan-source-hash");
    seedReviewWithOpenP0();
    db.delete(findings).where(eq(findings.id, "FND-ACTION-CONTRACT-P0")).run();
    db.insert(testplanSnapshots).values({
      id: "TPS-ACTION-CONTRACT-OLD",
      changeId: CHANGE_ID,
      status: "approved",
      testIntent: "old testplan",
      schemaVersion: "testplan/v1",
      approvalState: "approved",
      approvedAt: "2026-06-29T00:02:00.000Z",
      approvalDecisionId: null,
      snapshotDbHash: "old-testplan-hash",
      createdAt: "2026-06-29T00:02:00.000Z",
    }).run();
    db.insert(requiredValidationCommands).values({
      id: "RVC-ACTION-CONTRACT-OLD",
      changeId: CHANGE_ID,
      phase: "TestPlan",
      sourceSnapshotId: "TPS-ACTION-CONTRACT-OLD",
      command: "npm test",
      commandOrder: 1,
      required: 1,
      createdAt: "2026-06-29T00:02:01.000Z",
    }).run();
    db.insert(testplanSnapshots).values({
      id: "TPS-ACTION-CONTRACT-LATEST",
      changeId: CHANGE_ID,
      status: "approved",
      testIntent: "latest testplan without commands",
      schemaVersion: "testplan/v1",
      approvalState: "approved",
      approvedAt: "2026-06-29T00:03:00.000Z",
      approvalDecisionId: null,
      snapshotDbHash: "latest-testplan-hash",
      createdAt: "2026-06-29T00:03:00.000Z",
    }).run();

    const enterQa = getActions(CHANGE_ID).find((action) => action.actionId === "enter_qa");

    assert.equal(enterQa?.enabled, false);
    assert.equal(enterQa?.reasonCode, "test_plan_commands_missing");
    assert.equal(enterQa?.reason, "TestPlan required commands are missing");
  });

  it("marks every side-effect action as requiring an idempotency key", () => {
    seedStageGate("PRD", "passed", "prd-source-hash");

    const actions = getActions(CHANGE_ID);
    const sideEffectActions = actions.filter(
      (action) =>
        action.actionId.startsWith("run_") ||
        action.actionId.startsWith("retry_") ||
        action.actionId.startsWith("adopt_") ||
        action.actionId.startsWith("waive_") ||
        action.actionId.startsWith("approve_") ||
        action.actionId === "enter_qa" ||
        action.actionId === "merge",
    );

    assert.ok(sideEffectActions.length > 0);
    assert.equal(sideEffectActions.every((action) => action.requiresIdempotencyKey), true);
  });

  it("disables Review actions when the latest adopted BuildRun is missing adoption freshness fields", () => {
    const now = "2026-06-29T00:03:00.000Z";
    seedStageGate("Review", "passed", "review-source-hash");
    db.update(changes)
      .set({ status: "IMPLEMENTED" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    db.insert(buildRunRecords).values({
      id: "BRR-ACTION-CONTRACT-INCOMPLETE-BUILD",
      changeId: CHANGE_ID,
      runId: null,
      buildRunId: "build-1",
      status: "adopted",
      headSha: HEAD_SHA,
      baseHeadSha: null,
      baseCommit: null,
      patchHash: null,
      changedFilesHash: null,
      adoptedHeadSha: null,
      adoptionDecisionId: null,
      adoptedAt: now,
      artifactHash: null,
      source: "test",
      createdAt: now,
      updatedAt: now,
    }).run();

    const actions = getActions(CHANGE_ID);
    const runReview = actions.find((action) => action.actionId === "run_review");

    assert.equal(runReview?.enabled, false);
    assert.equal(runReview?.reasonCode, "review_build_adoption_incomplete");
    assert.match(runReview?.reason ?? "", /adoption fields/i);
  });

  it("enables Review from a complete adopted BuildRun even before a Review gate exists", () => {
    const now = "2026-06-29T00:05:00.000Z";
    db.update(changes)
      .set({ status: "IMPLEMENTED" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    db.insert(buildRunRecords).values({
      id: "BRR-ACTION-CONTRACT-ADOPTED",
      changeId: CHANGE_ID,
      runId: null,
      buildRunId: "build-1",
      status: "adopted",
      // headSha must equal adoptedHeadSha for assertBuildRecordFresh (the enqueue
      // authority's freshness fence) to pass.
      headSha: "c".repeat(40),
      baseHeadSha: HEAD_SHA,
      baseCommit: HEAD_SHA,
      patchHash: "review-patch-hash",
      changedFilesHash: "review-changed-files-hash",
      adoptedHeadSha: "c".repeat(40),
      adoptionDecisionId: "HD-ACTION-CONTRACT-ADOPT",
      adoptedAt: now,
      artifactHash: "artifact-hash",
      source: "test",
      createdAt: now,
      updatedAt: now,
    }).run();
    writeAdoptedBuildRunFile({
      repoPath,
      runNumber: 1,
      adoptedHeadSha: "c".repeat(40),
      adoptionDecisionId: "HD-ACTION-CONTRACT-ADOPT",
      patchSha256: "review-patch-hash",
      changedFilesHash: "review-changed-files-hash",
      baseHeadSha: HEAD_SHA,
      baseCommit: HEAD_SHA,
    });

    const runReview = getActions(CHANGE_ID).find((action) => action.actionId === "run_review");

    assert.equal(runReview?.enabled, true);
    assert.equal(runReview?.sourceDbHash, `review-patch-hash:review-changed-files-hash:${"c".repeat(40)}`);
  });

  it("enables Retro and hides stale Review or QA actions while RETRO_PENDING", () => {
    const approvedReleaseHash = seedRetroPendingRelease(repoPath);
    assert.ok(resolveRetroActionAuthority(db, CHANGE_ID), "real Release authority fixture must be trusted");

    // release_note_state is the immutable approved-content authority for Retro: with no
    // row, or a stored hash that no longer matches the live current copy, Retro is denied
    // -- even though both on-disk copies remain byte-identical (proves the DB is the anchor).
    db.delete(releaseNoteState).where(eq(releaseNoteState.changeId, CHANGE_ID)).run();
    assert.equal(resolveRetroActionAuthority(db, CHANGE_ID), null,
      "missing release_note_state row must deny Retro authority");
    db.insert(releaseNoteState).values({
      id: "RNS-RETRO-RELEASE", changeId: CHANGE_ID, runId: "RUN-RETRO-RELEASE",
      artifactId: "ART-RETRO-RELEASE", approvedContentHash: `${approvedReleaseHash}-tampered`,
      createdAt: new Date().toISOString(),
    }).run();
    assert.equal(resolveRetroActionAuthority(db, CHANGE_ID), null,
      "release_note_state hash drift from the current copy must deny Retro authority");
    db.update(releaseNoteState).set({ approvedContentHash: approvedReleaseHash })
      .where(eq(releaseNoteState.changeId, CHANGE_ID)).run();
    assert.ok(resolveRetroActionAuthority(db, CHANGE_ID),
      "restoring the approved-content hash must re-trust Retro authority");

    const actions = computeActions(CHANGE_ID);
    const actionById = new Map(actions.map((action) => [action.actionId, action]));

    assert.equal(actionById.get("run_retro")?.enabled, true, JSON.stringify(actionById.get("run_retro")));
    assert.equal(actionById.get("run_retro")?.reasonCode, null);
    for (const actionId of ["run_review", "retry_review", "run_qa", "retry_qa"]) {
      assert.equal(actionById.get(actionId)?.enabled, false, `${actionId} should be disabled`);
      assert.equal(actionById.get(actionId)?.reasonCode, "not_at_gate");
    }
  });

  /**
   * The first click on 运行 Retro used to be refused, every time, and only a
   * page reload made the second one work.
   *
   * run_retro is stamped with the Merge stage gate's (gateVersion,
   * sourceDbHash), and that gate is a cache of merge readiness that only the
   * write path refreshes. GET /gate serves computeActions -- no self-heal, no
   * persist, no readiness recompute -- so it renders whatever was last written.
   * The POST preflight runs getActions, recomputes readiness with persist:true,
   * writes a corrected stage_gates row, and refuses the click against *that*
   * version. runRelease now refreshes the contract before it hands the change
   * over at RETRO_PENDING (pipeline-release-retro-stage-service), which is what
   * closes the window; the end-to-end proof is in pipeline-service.test.ts.
   *
   * What this pins is the other half of that invariant: once the cache is
   * current, serving the contract must not move it again. A getActions that
   * bumped the gate on every call -- or a computeActions that read a different
   * row than getActions writes -- would reopen the defect immediately, and both
   * are cheap regressions to make.
   *
   * The dirty probe is stubbed because this fixture writes the release note
   * straight into an otherwise clean repo: real releases reach RETRO_PENDING
   * with the merge gate passing (pipeline-service.test.ts drives that for
   * real), and a git_worktree_dirty blocker here would be measuring the
   * fixture, not the contract.
   */
  it("does not move the Retro contract when serving it, once the release-time refresh has run", () => {
    const restoreDirtyProbe = setMergeReadinessDirtyProbeForTest(() => false);
    try {
      seedRetroPendingRelease(repoPath);
      // What runRelease does before it hands the change to the user.
      getActions(CHANGE_ID);

      const rendered = computeActions(CHANGE_ID).find((action) => action.actionId === "run_retro");
      assert.equal(rendered?.enabled, true, JSON.stringify(rendered));

      const allowed = assertActionAllowed({
        changeId: CHANGE_ID,
        actionId: "run_retro",
        expectedGateVersion: rendered!.gateVersion,
        expectedSourceDbHash: rendered!.sourceDbHash,
        idempotencyKey: "retro-first-click",
      });

      assert.equal(allowed.actionId, "run_retro");
    } finally {
      restoreDirtyProbe();
    }
  });

  /**
   * The fence still has to bite. Retro is authorized against the approved
   * release note, so a contract issued before that note was replaced must be
   * refused -- "the first click stops 409ing" must never become "any contract
   * is accepted".
   */
  it("still refuses a Retro contract whose release note changed after it was issued", () => {
    const restoreDirtyProbe = setMergeReadinessDirtyProbeForTest(() => false);
    try {
      seedRetroPendingRelease(repoPath);
      getActions(CHANGE_ID);
      const stale = computeActions(CHANGE_ID).find((action) => action.actionId === "run_retro");
      assert.equal(stale?.enabled, true, JSON.stringify(stale));

      // The release note is re-approved with different content. What the user
      // was looking at when they were handed `stale` no longer exists.
      const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
      const runDir = path.join(changeDir, "runs", "RUN-RETRO-RELEASE");
      fs.writeFileSync(path.join(changeDir, "release-note.md"), "# Release v2\n");
      fs.writeFileSync(path.join(runDir, "release-note.md"), "# Release v2\n");
      db.update(releaseNoteState)
        .set({ approvedContentHash: createHash("sha256").update("# Release v2\n").digest("hex") })
        .where(eq(releaseNoteState.changeId, CHANGE_ID))
        .run();

      const current = computeActions(CHANGE_ID).find((action) => action.actionId === "run_retro");
      assert.equal(current?.enabled, true, "the action is still available, just against different facts");
      assert.notEqual(current?.sourceDbHash, stale?.sourceDbHash);

      assert.throws(
        () =>
          assertActionAllowed({
            changeId: CHANGE_ID,
            actionId: "run_retro",
            expectedGateVersion: stale!.gateVersion,
            expectedSourceDbHash: stale!.sourceDbHash,
            idempotencyKey: "retro-stale-click",
          }),
        (error: unknown) =>
          error instanceof PreflightBlockedError &&
          ["gate_version_drift", "source_db_hash_drift"].includes(error.envelope.reasonCode ?? ""),
      );
    } finally {
      restoreDirtyProbe();
    }
  });
});
