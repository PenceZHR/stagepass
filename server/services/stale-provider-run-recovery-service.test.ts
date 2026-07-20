import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { and, eq, sql } from "drizzle-orm";

import { databasePath, db, sqlite } from "../db";
import {
  apiSnapshots,
  artifacts,
  artifactMirrors,
  battleRounds,
  blueGapReviews,
  briefingQuestions,
  buildRunRecords,
  changes,
  events,
  findings,
  humanDecisions,
  mergeBlockers,
  mergeReadiness,
  pipelineJobs,
  projects,
  prdBriefings,
  prdDrafts,
  providerRunProcesses,
  redFixClaims,
  requirementGaps,
  reviewAttempts,
  reviewReports,
  reviewState,
  runs,
  stageActions,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
  techspecSnapshots,
  warReports,
} from "../db/schema";
import type { ProcessIdentity, ProcessIdentityProbe } from "./process-identity-service";
import { computeActions, getActions } from "./action-contract-service";
import { createRun } from "./pipeline-run-ledger-service";
import { writeRunOnlyArtifact } from "./pipeline-run-ledger-service";
import {
  businessEvidenceForCompletedProvider,
  captureEvidenceDbSnapshot,
} from "./recovery-business-evidence";
import { DEFAULT_MAX_REVIEW_FINDINGS } from "./recovery-types";
import {
  createTechSpecAndApiSnapshots,
  setTechSpecApiSnapshotServiceDbForTest,
} from "./techspec-api-snapshot-service";
import { recomputeStageGate } from "./stage-authority-service";
import { completeBlueCritique, completeRedSpecRound } from "./spec-battle-service";
import { generateSpecReport } from "./spec-battle-report-service";
import {
  recomputeReviewReport,
  setReviewReportServiceDbForTest,
} from "./review-report-service";
import {
  hashBuildChangedFiles,
  recordBuildRunRecord,
  setBuildRunRecordDbForTest,
} from "./build-run-record-service";
import { writeBuildRun, type BuildRunFile } from "./build-workspace-service";
import { renderDesignSnapshotMarkdown } from "./pipeline-design-stage-service";
import { renderMirrorsFromDb } from "./artifact-mirror-service";
import { parseRepairCliArguments, repairCliExitCode } from "../scripts/repair-stale-provider-runs";
import {
  ABSOLUTE_MAX_ARTIFACT_BYTES,
  ABSOLUTE_MAX_RECOVERY_CANDIDATES,
  ABSOLUTE_MAX_RECOVERY_TIME_BUDGET_MS,
  ABSOLUTE_MAX_REVIEW_FINDINGS,
  RecoveryOptionValidationError,
  recoverStaleProviderRuns,
  recoverStaleProviderRunsBestEffort,
  resetRecoveryCursorsForTest,
  setBestEffortRecoveryOptionsForTest,
  type StaleProviderRunRecoveryOptions,
} from "./stale-provider-run-recovery-service";
import {
  resetStartupRecoveryForTest,
  setStartupRecoveryDependenciesForTest,
} from "./startup-recovery-service";

// Task 11 recovery coverage is intentionally table-driven below so every
// persisted boundary is asserted from the same observedAt snapshot.

const PROJECT_ID = "PRJ-STALE-PROVIDER";
const CHANGE_ID = "CHG-STALE-PROVIDER";
const OTHER_CHANGE_ID = "CHG-STALE-PROVIDER-OTHER";
const fixtureRepoPaths: string[] = [];

function cleanupRows(): void {
  db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, OTHER_CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, OTHER_CHANGE_ID)).run();
  const readinessIds = db
    .select({ id: mergeReadiness.id })
    .from(mergeReadiness)
    .where(eq(mergeReadiness.changeId, CHANGE_ID))
    .all();
  for (const row of readinessIds) {
    db.delete(mergeBlockers).where(eq(mergeBlockers.mergeReadinessId, row.id)).run();
  }
  db.delete(mergeReadiness).where(eq(mergeReadiness.changeId, CHANGE_ID)).run();
  db.delete(stageActions).where(eq(stageActions.changeId, CHANGE_ID)).run();
  db.delete(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).run();
  db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
  db.delete(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
  db.delete(providerRunProcesses).where(eq(providerRunProcesses.changeId, CHANGE_ID)).run();
  db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
  db.delete(reviewState).where(eq(reviewState.changeId, CHANGE_ID)).run();
  db.delete(findings).where(eq(findings.changeId, CHANGE_ID)).run();
  db.delete(reviewReports).where(eq(reviewReports.changeId, CHANGE_ID)).run();
  db.delete(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).run();
  db.delete(buildRunRecords).where(eq(buildRunRecords.changeId, CHANGE_ID)).run();
  db.delete(warReports).where(eq(warReports.changeId, CHANGE_ID)).run();
  db.delete(humanDecisions).where(eq(humanDecisions.changeId, CHANGE_ID)).run();
  db.delete(blueGapReviews).where(eq(blueGapReviews.changeId, CHANGE_ID)).run();
  db.delete(redFixClaims).where(eq(redFixClaims.changeId, CHANGE_ID)).run();
  db.delete(requirementGaps).where(eq(requirementGaps.changeId, CHANGE_ID)).run();
  db.delete(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
  db.delete(apiSnapshots).where(eq(apiSnapshots.changeId, CHANGE_ID)).run();
  db.delete(techspecSnapshots).where(eq(techspecSnapshots.changeId, CHANGE_ID)).run();
  db.delete(prdDrafts).where(eq(prdDrafts.changeId, CHANGE_ID)).run();
  db.delete(briefingQuestions).where(eq(briefingQuestions.changeId, CHANGE_ID)).run();
  db.delete(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedOtherChange(): void {
  const source = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
  assert.ok(source);
  db.insert(changes).values({
    ...source,
    id: OTHER_CHANGE_ID,
    title: "Ownership mismatch other change",
  }).run();
}

function createFixtureRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "task11-recovery-evidence-"));
  fixtureRepoPaths.push(repoPath);
  db.update(projects).set({ repoPath }).where(eq(projects.id, PROJECT_ID)).run();
  return repoPath;
}

function seedChange(status = "TECHSPECCING"): void {
  const now = "2026-07-10T00:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Stale provider",
    repoPath: process.cwd(),
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
    title: "Stale provider",
    status,
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

function seedRun(input: {
  runId?: string;
  phase?: string;
  providerPhase?: string;
  pid?: number | null;
  heartbeat?: string;
  runStartedAt?: string | null;
} = {}): string {
  const runId = input.runId ?? "RUN-STALE-PROVIDER";
  const phase = input.phase ?? "tech_spec";
  const providerPhase = input.providerPhase ?? phase;
  const startedAt = "2026-07-10T00:01:00.000Z";
  const identity = typeof input.pid === "number" ? expectedIdentity(input.pid) : null;
  db.insert(runs).values({
    id: runId,
    changeId: CHANGE_ID,
    phase,
    status: "running",
    startedAt: input.runStartedAt === undefined ? startedAt : input.runStartedAt,
    endedAt: null,
    summary: null,
    attemptNo: 1,
  }).run();
  db.insert(providerRunProcesses).values({
    id: `PRP-${runId}`,
    changeId: CHANGE_ID,
    runId,
    phase: providerPhase,
    provider: "claude",
    pid: input.pid ?? null,
    ppid: process.pid,
    roundId: null,
    status: "running",
    startedAt,
    lastHeartbeatAt: input.heartbeat ?? startedAt,
    endedAt: null,
    exitCode: null,
    signal: null,
    summary: null,
    attemptNo: 1,
    processNonce: identity?.nonce ?? null,
    processStartTime: identity?.processStartTime ?? null,
    processPpid: identity?.ppid ?? null,
    processPgid: identity?.pgid ?? null,
    processCwd: identity?.cwd ?? null,
    processCommandJson: identity ? JSON.stringify(identity.command) : null,
  }).run();
  return runId;
}

function seedStageRun(runId = "STG-RUN-STALE"): void {
  db.insert(stageRuns).values({
    id: runId,
    changeId: CHANGE_ID,
    phase: "TechSpec",
    attemptNo: 1,
    status: "running",
    idempotencyKey: null,
    inputDbHash: null,
    outputDbHash: null,
    sourceLineageJson: null,
    errorCode: null,
    startedAt: "2026-07-10T00:01:00.000Z",
    completedAt: null,
  }).run();
}

const RECOVERY_OBSERVED_AT = new Date("2026-07-10T00:02:00.000Z");

function expectedIdentity(pid = 424_242): ProcessIdentity {
  return {
    pid,
    ppid: process.pid,
    pgid: pid,
    nonce: `nonce-${pid}`,
    processStartTime: "2026-07-10T00:00:10.000Z",
    cwd: process.cwd(),
    command: ["node", "provider.js"],
  };
}

function identityProbeReturning(
  result: Awaited<ReturnType<ProcessIdentityProbe["validate"]>>,
): ProcessIdentityProbe {
  return {
    capture: async () => {
      if (result.ok) return result.observed;
      throw new Error("capture is not used by recovery tests");
    },
    validate: async () => result,
  };
}

function seedReconciliationFixture(input: {
  providerStatus?: string;
  jobStatus?: string;
  phase?: string;
  startedAt?: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  runAttemptNo?: number;
  jobAttemptNo?: number;
  providerAttemptNo?: number;
  runLeaseToken?: string;
  jobLeaseToken?: string;
  providerLeaseToken?: string;
  provider?: "claude" | "codex";
  pid?: number | null;
  externalRef?: string | null;
} = {}): void {
  const phase = input.phase ?? "tech_spec";
  const startedAt = input.startedAt ?? "2026-07-10T00:00:10.000Z";
  const runAttemptNo = input.runAttemptNo ?? 1;
  const jobAttemptNo = input.jobAttemptNo ?? runAttemptNo;
  const providerAttemptNo = input.providerAttemptNo ?? runAttemptNo;
  const runLeaseToken = input.runLeaseToken ?? "lease-1";
  const pid = input.pid === undefined ? expectedIdentity().pid : input.pid;
  const identity = typeof pid === "number" ? expectedIdentity(pid) : null;
  const changeStatus = phase === "implement"
    ? "IMPLEMENTING"
    : phase === "review"
      ? "REVIEWING"
      : phase === "spec"
        ? "SPECCING"
        : "TECHSPECCING";
  seedChange(changeStatus);
  db.insert(pipelineJobs).values({
    id: "JOB-MATRIX",
    changeId: CHANGE_ID,
    phase,
    actionId: phase === "implement" ? "run_build" : "run_tech_spec",
    idempotencyKey: "matrix",
    status: input.jobStatus ?? "running",
    leasedBy: "worker-1",
    leaseExpiresAt: input.leaseExpiresAt ?? "2026-07-10T00:10:00.000Z",
    heartbeatAt: input.heartbeatAt ?? "2026-07-10T00:01:55.000Z",
    attemptNo: jobAttemptNo,
    errorCode: null,
    errorSummary: null,
    createdAt: startedAt,
    startedAt,
    endedAt: null,
    leaseToken: input.jobLeaseToken ?? runLeaseToken,
    workerNonce: "worker-nonce",
  }).run();
  db.insert(runs).values({
    id: "RUN-MATRIX",
    changeId: CHANGE_ID,
    phase,
    status: "running",
    startedAt,
    endedAt: null,
    summary: null,
    jobId: "JOB-MATRIX",
    workerId: "worker-1",
    leaseToken: runLeaseToken,
    attemptNo: runAttemptNo,
  }).run();
  db.insert(providerRunProcesses).values({
    id: "PRP-MATRIX",
    changeId: CHANGE_ID,
    runId: "RUN-MATRIX",
    phase,
    provider: input.provider ?? "claude",
    pid,
    ppid: identity?.ppid ?? process.pid,
    roundId: null,
    status: input.providerStatus ?? "running",
    startedAt,
    lastHeartbeatAt: input.heartbeatAt ?? "2026-07-10T00:01:55.000Z",
    endedAt: input.providerStatus && input.providerStatus !== "running" ? "2026-07-10T00:01:00.000Z" : null,
    exitCode: input.providerStatus === "completed" ? 0 : null,
    signal: null,
    summary: input.providerStatus === "completed" ? "done" : null,
    jobId: "JOB-MATRIX",
    workerId: "worker-1",
    leaseToken: input.providerLeaseToken ?? runLeaseToken,
    attemptNo: providerAttemptNo,
    externalRef: input.externalRef ?? null,
    processNonce: identity?.nonce ?? null,
    processStartTime: identity?.processStartTime ?? null,
    processPpid: identity?.ppid ?? null,
    processPgid: identity?.pgid ?? null,
    processCwd: identity?.cwd ?? null,
    processCommandJson: identity ? JSON.stringify(identity.command) : null,
  }).run();
  db.insert(stageRuns).values({
    id: "STG-MATRIX",
    changeId: CHANGE_ID,
    phase: phase === "implement" || phase === "fix_findings"
      ? "Build"
      : phase === "review"
        ? "Review"
        : phase === "spec" || phase === "spec_critic"
          ? "Spec"
          : "TechSpec",
    attemptNo: runAttemptNo,
    status: "running",
    idempotencyKey: "matrix",
    inputDbHash: null,
    outputDbHash: null,
    sourceLineageJson: null,
    errorCode: null,
    startedAt,
    completedAt: null,
  }).run();
}

// --- Enqueue-authority source seeds -------------------------------------
// After the enqueue-authority overlay (action-contract-service.ts), a retry
// action is only served enabled when the SOURCE phase's authority chain is on
// record -- exactly what production has when the interrupted run was started.
// The recovery fixtures never seeded that chain (before the overlay it was not
// needed), so recovering into a "ready" state left the retry action denied.
// These helpers seed the authority-consistent source per retry action.

const SPEC_SOURCE_AUTHORITY_HASH = "spec-source-authority-hash";

// retry_tech_spec (snapshotPhase Spec): a passing Spec gate + the single Spec
// governance stage run holding that gate's source hash. Spec pairs no business
// run, so the matched stage run's own passing status is the authority.
function seedSpecSourceAuthority(): void {
  const now = "2026-07-10T00:00:05.000Z";
  db.insert(stageGates).values({
    id: "GATE-SPEC-SOURCE", changeId: CHANGE_ID, phase: "Spec", status: "passed",
    blockersJson: "[]", freshnessJson: JSON.stringify({ fresh: true }), requiredActionsJson: "[]",
    sourceDbHash: SPEC_SOURCE_AUTHORITY_HASH, gateVersion: 1, computedAt: now,
  }).run();
  db.insert(stageRuns).values({
    id: "STG-SPEC-SOURCE", changeId: CHANGE_ID, phase: "Spec", attemptNo: 1, status: "passed",
    idempotencyKey: "spec-source", inputDbHash: SPEC_SOURCE_AUTHORITY_HASH,
    outputDbHash: SPEC_SOURCE_AUTHORITY_HASH, sourceLineageJson: null, errorCode: null,
    startedAt: now, completedAt: now,
  }).run();
}

// retry_spec (snapshotPhase PRD): a passing PRD gate plus the locked briefing
// and draft the PRD authority branch requires.
function seedPrdSourceAuthority(): void {
  const now = "2026-07-10T00:00:05.000Z";
  db.insert(stageGates).values({
    id: "GATE-PRD-SOURCE", changeId: CHANGE_ID, phase: "PRD", status: "passed",
    blockersJson: "[]", freshnessJson: JSON.stringify({ fresh: true }), requiredActionsJson: "[]",
    sourceDbHash: "prd-source-authority-hash", gateVersion: 1, computedAt: now,
  }).run();
  db.insert(prdBriefings).values({
    id: "PBR-STALE-PROVIDER", changeId: CHANGE_ID, status: "locked",
    intentText: "Stale provider locked PRD.", finalReviewJson: null, sourceHashesJson: "{}",
    lockedAt: now, createdAt: now, updatedAt: now,
  }).run();
  db.insert(prdDrafts).values({
    id: "PDR-STALE-PROVIDER", changeId: CHANGE_ID, version: 1, markdown: "# PRD\n",
    sourceQuestionIdsJson: "[]", unresolvedQuestionIdsJson: "[]",
    draftHash: "stale-provider-prd-draft-hash", createdAt: now,
  }).run();
}

// retry_build (snapshotPhase TestPlan): a passing TestPlan gate is already
// seeded by the Build fixtures; this backs it via the legacy attempt-pairing
// path (one TestPlan stage run holding the gate hash + the paired completed
// test_plan business run with an artifact). No testplan snapshot rows exist, so
// the content resolver returns null and the authority falls back to pairing.
function seedTestPlanLegacySource(sourceDbHash: string): void {
  const now = "2026-07-10T00:00:05.000Z";
  db.insert(stageRuns).values({
    id: "STG-TESTPLAN-SOURCE", changeId: CHANGE_ID, phase: "TestPlan", attemptNo: 1,
    status: "completed", idempotencyKey: "testplan-source", inputDbHash: sourceDbHash,
    outputDbHash: sourceDbHash, sourceLineageJson: null, errorCode: null,
    startedAt: now, completedAt: now,
  }).run();
  db.insert(runs).values({
    id: "RUN-TESTPLAN-SOURCE", changeId: CHANGE_ID, phase: "test_plan", status: "completed",
    startedAt: now, endedAt: now, summary: "test_plan completed", attemptNo: 1,
  }).run();
  db.insert(artifacts).values({
    id: "ART-TESTPLAN-SOURCE", changeId: CHANGE_ID, runId: "RUN-TESTPLAN-SOURCE",
    type: "stage_output", path: "/tmp/testplan-source.json", createdAt: now,
  }).run();
}

// run_review / retry_review (resolveBuildSnapshotSource): an adopted build_run_
// records row whose full trust chain is complete, backed by the matching on-disk
// build-run file so readLatestBuildRun agrees field-for-field.
function seedAdoptedBuildDiskSource(input: {
  runNumber: number;
  adoptedHeadSha: string;
  patchHash: string;
  changedFilesHash: string;
  baseSha: string;
  adoptionDecisionId: string;
  adoptedAt: string;
}): void {
  const repoPath = createFixtureRepo();
  const createdAt = "2026-07-10T00:00:10.000Z";
  writeBuildRun(repoPath, {
    changeId: CHANGE_ID, runNumber: input.runNumber, status: "adopted", purpose: "build",
    baseHeadSha: input.baseSha, baseCommit: input.baseSha, workspacePath: repoPath,
    branchName: `build-${input.runNumber}`, expectedFiles: [], forbiddenFiles: [],
    changedFiles: [], deviations: [], blockers: [], patchPath: null,
    patchSha256: input.patchHash, patchHash: input.patchHash,
    changedFilesHash: input.changedFilesHash, adoptedHeadSha: input.adoptedHeadSha,
    adoptionDecisionId: input.adoptionDecisionId, approvalPath: null, diffPath: null,
    auditPath: null, reportPath: null, createdAt, updatedAt: input.adoptedAt,
  });
  const restore = setBuildRunRecordDbForTest(db);
  recordBuildRunRecord({
    changeId: CHANGE_ID, runId: null, buildRunId: `build-${input.runNumber}`, status: "adopted",
    headSha: input.adoptedHeadSha, baseHeadSha: input.baseSha, baseCommit: input.baseSha,
    patchHash: input.patchHash, changedFilesHash: input.changedFilesHash,
    artifactHash: input.patchHash, adoptedHeadSha: input.adoptedHeadSha,
    adoptionDecisionId: input.adoptionDecisionId, adoptedAt: input.adoptedAt,
    source: "workspace_file", createdAt, updatedAt: input.adoptedAt,
  });
  restore();
}

// fix_blockers (reviewControlDecision): the direct authority needs the latest
// valid review report source (gateVersion + sourceDbHash). Seeds the review
// attempt + report + state that a CHECK_FAILED change with open blockers has.
function seedFixBlockersReviewSource(): void {
  const now = "2026-07-10T00:00:30.000Z";
  db.insert(reviewAttempts).values({
    id: "REV-LEGACY-FIX", changeId: CHANGE_ID, runId: null, attemptNo: 1, status: "completed",
    provider: "claude", reviewStatus: "changes_requested", idempotencyKey: "legacy-fix-review",
    sourceBuildRunId: "build-legacy-fix", sourceHeadSha: "legacy-fix-head",
    startedAt: now, endedAt: now, completedAt: now, createdAt: now, updatedAt: now,
  }).run();
  db.insert(reviewReports).values({
    id: "RRP-LEGACY-FIX", attemptId: "REV-LEGACY-FIX", changeId: CHANGE_ID, reportVersion: 1,
    reviewConclusion: "changes_requested", reportDbHash: "legacy-fix-report-hash",
    gateStatus: "blocked", qaAllowed: 0, sourceBuildRunId: "build-legacy-fix",
    sourceHeadSha: "legacy-fix-head", findingVersion: 1, waiverVersion: 1,
    blockingP0: 0, blockingP1: 1, waivedP1: 0, p2Count: 0,
    findingsDbHash: "legacy-fix-findings-hash", staleReason: null, legacyState: null,
    reportJson: null, generatedAt: now, createdAt: now,
  }).run();
  db.insert(reviewState).values({
    changeId: CHANGE_ID, latestAttemptId: "REV-LEGACY-FIX", latestAttemptNo: 1,
    latestReportId: "RRP-LEGACY-FIX", latestValidReviewReportId: "RRP-LEGACY-FIX",
    latestValidAttemptNo: 1, gateStatus: "blocked", reviewStatus: "changes_requested",
    reportDbHash: "legacy-fix-report-hash", findingVersion: 1, waiverVersion: 1, updatedAt: now,
  }).run();
}

function seedMissingProviderCasFixture(): void {
  seedChange("TECHSPECCING");
  db.insert(pipelineJobs).values({
    id: "JOB-MISSING-CAS", changeId: CHANGE_ID, phase: "tech_spec", actionId: "run_tech_spec",
    idempotencyKey: "missing-cas", status: "running", leasedBy: "worker-cas",
    leaseExpiresAt: "2026-07-10T00:10:00.000Z", heartbeatAt: "2026-07-10T00:00:00.000Z",
    attemptNo: 1, errorCode: null, errorSummary: null, createdAt: "2026-07-10T00:00:00.000Z",
    startedAt: "2026-07-10T00:00:00.000Z", endedAt: null, leaseToken: "lease-cas",
    workerNonce: "nonce-cas",
  }).run();
  db.insert(runs).values({
    id: "RUN-MISSING-CAS", changeId: CHANGE_ID, phase: "tech_spec", status: "running",
    startedAt: "2026-07-10T00:00:00.000Z", endedAt: null, summary: null,
    jobId: "JOB-MISSING-CAS", workerId: "worker-cas", leaseToken: "lease-cas", attemptNo: 1,
  }).run();
  db.insert(stageRuns).values({
    id: "STG-MISSING-CAS", changeId: CHANGE_ID, phase: "TechSpec", attemptNo: 1,
    status: "running", idempotencyKey: "missing-cas", inputDbHash: null, outputDbHash: null,
    sourceLineageJson: null, errorCode: null, startedAt: "2026-07-10T00:00:00.000Z", completedAt: null,
  }).run();
}

function setFailingGlobalStartup(): void {
  setStartupRecoveryDependenciesForTest({
    logDir: process.cwd(),
    ensureLogs: () => {},
    checkDb: () => {},
    writeLog: () => {},
    recover: async () => ({
      recovered: [],
      failed: [{
        runId: "RUN-OTHER-CHANGE",
        changeId: "CHG-OTHER-CHANGE",
        phase: "spec",
        code: "recovery_failed",
        error: "sensitive sqlite /absolute/path detail",
      }],
      observed: [],
      observedAt: RECOVERY_OBSERVED_AT.toISOString(),
    }),
  });
}

type CompletedEvidencePhase = "tech_spec" | "spec" | "review" | "implement";

async function seedCompletedProviderFixture(
  phase: CompletedEvidencePhase,
  evidenceComplete: boolean,
): Promise<void> {
  seedReconciliationFixture({ providerStatus: "completed", phase });
  const now = "2026-07-10T00:01:00.000Z";
  if (phase === "tech_spec" && evidenceComplete) {
    const repoPath = createFixtureRepo();
    const restore = setTechSpecApiSnapshotServiceDbForTest(db);
    const content = { interfaces: [], dataContracts: [], migrationNotes: [], buildInputs: [], reviewInputs: [] };
    const snapshots = createTechSpecAndApiSnapshots({
      changeId: CHANGE_ID,
      status: "approved",
      sourceSpecHash: "RUN-MATRIX",
      techSpecContent: content,
      apiContract: content,
      reviewedAt: now,
      createdAt: now,
    });
    restore();
    recomputeStageGate({
      changeId: CHANGE_ID,
      phase: "TechSpec",
      status: "passed",
      blockers: [],
      freshness: { fresh: true },
      requiredActions: [],
      rows: [
        { table: "techspec_snapshots", id: snapshots.techSpec.id, contentDbHash: snapshots.techSpec.contentDbHash },
        { table: "api_snapshots", id: snapshots.api.id, contractDbHash: snapshots.api.contractDbHash },
      ],
    });
    const techSpecMarkdown = renderDesignSnapshotMarkdown("TechSpec DB Snapshot", snapshots.techSpec);
    const apiMarkdown = renderDesignSnapshotMarkdown("API DB Snapshot", snapshots.api);
    renderMirrorsFromDb({
      repoPath,
      changeId: CHANGE_ID,
      generatedAt: now,
      mirrors: [
        {
          phase: "TechSpec", artifactType: "tech_spec_delta", fileName: "tech-spec-delta.md",
          schemaVersion: snapshots.techSpec.schemaVersion,
          sourceDbHash: snapshots.techSpec.contentDbHash,
          content: techSpecMarkdown,
        },
        {
          phase: "TechSpec", artifactType: "api_spec_delta", fileName: "api-spec-delta.md",
          schemaVersion: snapshots.api.schemaVersion,
          sourceDbHash: snapshots.api.contractDbHash,
          content: apiMarkdown,
        },
      ],
    });
    await writeRunOnlyArtifact(repoPath, CHANGE_ID, "RUN-MATRIX", "tech_spec_delta", "tech-spec-delta.md", techSpecMarkdown);
    await writeRunOnlyArtifact(repoPath, CHANGE_ID, "RUN-MATRIX", "api_spec_delta", "api-spec-delta.md", apiMarkdown);
  }
  if (phase === "spec") {
    db.insert(battleRounds).values({
      id: "ROUND-COMPLETED-PROVIDER", changeId: CHANGE_ID, phase: "Spec", template: "SPEC_BATTLE_MVP",
      roundNo: 1, status: "red_running", redUnit: "SPEC_WRITER", blueUnit: "REQUIREMENT_CRITIC",
      inputSnapshotJson: "{}", paramsJson: "{}",
      redArtifactPath: null, redArtifactHash: null, blueArtifactPath: null, blueArtifactHash: null,
      reportPath: null,
      supersededByRoundId: null, startedAt: "2026-07-10T00:00:10.000Z",
      endedAt: null, createdAt: "2026-07-10T00:00:10.000Z", updatedAt: now,
    }).run();
    db.update(providerRunProcesses).set({ roundId: "ROUND-COMPLETED-PROVIDER" })
      .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
    if (evidenceComplete) {
      createFixtureRepo();
      await completeRedSpecRound({
        changeId: CHANGE_ID,
        roundId: "ROUND-COMPLETED-PROVIDER",
        markdown: JSON.stringify({ prdDeltaMarkdown: "# Red Spec\n", fixClaims: [] }),
      });
      await completeBlueCritique({
        changeId: CHANGE_ID,
        roundId: "ROUND-COMPLETED-PROVIDER",
        blueJson: JSON.stringify({ gapReviews: [], requirementGaps: [] }),
      });
      await generateSpecReport(CHANGE_ID);
    }
  }
  if (phase === "review") {
    if (evidenceComplete) {
      // Disk-backed adopted build (buildRunId "build-1"): the review evidence
      // check requires attempt/report/latest-build to agree on the build id,
      // and the retry_review enqueue authority additionally traces the
      // matching on-disk build-run file (resolveBuildSnapshotSource), whose
      // id must have the `build-<runNumber>` shape.
      seedAdoptedBuildDiskSource({
        runNumber: 1, adoptedHeadSha: "review-head", patchHash: "review-patch",
        changedFilesHash: "review-files", baseSha: "review-base",
        adoptionDecisionId: "build-review-adoption", adoptedAt: now,
      });
    }
    db.insert(reviewAttempts).values({
      id: "REV-COMPLETED-PROVIDER", changeId: CHANGE_ID, runId: "RUN-MATRIX", attemptNo: 1,
      status: evidenceComplete ? "completed" : "running", provider: "claude",
      reviewStatus: evidenceComplete ? "passed" : "running", idempotencyKey: "review-1",
      sourceBuildRunId: evidenceComplete ? "build-1" : null,
      sourceHeadSha: evidenceComplete ? "review-head" : null,
      startedAt: "2026-07-10T00:00:10.000Z", endedAt: evidenceComplete ? now : null,
      completedAt: evidenceComplete ? now : null, createdAt: "2026-07-10T00:00:10.000Z", updatedAt: now,
    }).run();
    if (evidenceComplete) {
      const restoreReviewDb = setReviewReportServiceDbForTest(db);
      recomputeReviewReport(CHANGE_ID, "REV-COMPLETED-PROVIDER");
      restoreReviewDb();
    } else {
      db.insert(reviewState).values({
        changeId: CHANGE_ID, latestAttemptId: "REV-COMPLETED-PROVIDER", latestAttemptNo: 1,
        latestReportId: null, latestValidReviewReportId: null, latestValidAttemptNo: null,
        gateStatus: "running", reviewStatus: "running", reportDbHash: null,
        findingVersion: 1, waiverVersion: 1, updatedAt: now,
      }).run();
    }
  }
  if (phase === "implement") {
    if (evidenceComplete) {
      const repoPath = createFixtureRepo();
      execFileSync("git", ["init", "-q"], { cwd: repoPath });
      execFileSync("git", ["config", "user.email", "task11@example.test"], { cwd: repoPath });
      execFileSync("git", ["config", "user.name", "Task11"], { cwd: repoPath });
      const sourcePath = path.join(repoPath, "src", "a.ts");
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, "export const value = 1;\n");
      execFileSync("git", ["add", "src/a.ts"], { cwd: repoPath });
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repoPath });
      const baseHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();
      fs.writeFileSync(sourcePath, "export const value = 2;\n");
      const patchPath = path.join(repoPath, ".ship", "changes", CHANGE_ID, "build", "runs", "build-1.patch");
      fs.mkdirSync(path.dirname(patchPath), { recursive: true });
      const patch = execFileSync("git", ["diff", "--binary"], { cwd: repoPath, encoding: "utf8" });
      fs.writeFileSync(patchPath, patch);
      const patchHash = createHash("sha256").update(patch).digest("hex");
      const changedFiles = ["src/a.ts"];
      const changedFilesHash = hashBuildChangedFiles(changedFiles);
      execFileSync("git", ["add", "src/a.ts"], { cwd: repoPath });
      execFileSync("git", ["commit", "-q", "-m", "adopt patch"], { cwd: repoPath });
      const adoptedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();
      const buildRun: BuildRunFile = {
        changeId: CHANGE_ID, runNumber: 1, status: "adopted", purpose: "build",
        baseHeadSha: baseHead, baseCommit: baseHead, workspacePath: repoPath,
        branchName: "build-1", expectedFiles: changedFiles, forbiddenFiles: [], changedFiles,
        deviations: [], blockers: [], patchPath, patchSha256: patchHash, patchHash, changedFilesHash,
        adoptedHeadSha: adoptedHead, adoptionDecisionId: "build-1-adoption",
        approvalPath: null, diffPath: null, auditPath: null, reportPath: null,
        createdAt: "2026-07-10T00:00:10.000Z", updatedAt: now,
      };
      writeBuildRun(repoPath, buildRun);
      const restoreBuildDb = setBuildRunRecordDbForTest(db);
      recordBuildRunRecord({
        changeId: CHANGE_ID, runId: "RUN-MATRIX", buildRunId: "build-1", status: "adopted",
        headSha: adoptedHead, baseHeadSha: baseHead, baseCommit: baseHead,
        patchHash, changedFilesHash, adoptedHeadSha: adoptedHead,
        adoptionDecisionId: "build-1-adoption", adoptedAt: now, artifactHash: patchHash,
        source: "workspace_file", createdAt: "2026-07-10T00:00:10.000Z", updatedAt: now,
      });
      restoreBuildDb();
    } else {
      db.insert(buildRunRecords).values({
        id: "BLD-COMPLETED-PROVIDER", changeId: CHANGE_ID, runId: "RUN-MATRIX",
        buildRunId: "build-1", status: "running", source: "pipeline",
        createdAt: "2026-07-10T00:00:10.000Z", updatedAt: now,
      }).run();
    }
    db.insert(stageGates).values({
      id: "GATE-COMPLETED-BUILD-PREREQ", changeId: CHANGE_ID, phase: "TestPlan", status: "passed",
      blockersJson: "[]", freshnessJson: JSON.stringify({ fresh: true }), requiredActionsJson: "[]",
      sourceDbHash: "testplan-source-hash", gateVersion: 1, computedAt: now,
    }).run();
  }
}

type IntakeActionId =
  | "run_prd"
  | "retry_prd"
  | "run_prd_briefing_questions"
  | "run_prd_briefing_draft"
  | "run_prd_briefing_final_review";

// pipelineJobs.phase for the new 3-step PRD briefing flow is the specific
// sub-step ("prd_briefing_questions" etc.), never "intake" -- only runs.phase
// and provider_run_processes.phase are "intake" for every one of these
// actionIds. See server/services/pipeline-job-types.ts and the enqueue call
// sites under app/api/.../prd-briefing/*/route.ts.
const INTAKE_JOB_PHASE_BY_ACTION: Record<IntakeActionId, string> = {
  run_prd: "intake",
  retry_prd: "intake",
  run_prd_briefing_questions: "prd_briefing_questions",
  run_prd_briefing_draft: "prd_briefing_draft",
  run_prd_briefing_final_review: "prd_briefing_final_review",
};

/**
 * Seeds a completed "intake"-phase provider run (job + run + provider_run_
 * process, deliberately with NO stageRuns row -- documentStagePhases has no
 * "intake" entry, so production never writes one for this phase) and returns
 * the run/provider rows read back from the DB so tests can call
 * businessEvidenceForCompletedProvider/captureEvidenceDbSnapshot directly.
 *
 * Omitting `actionId` seeds no pipelineJobs row at all, so provider.jobId is
 * null -- the "fail closed" case.
 */
function seedIntakeProviderFixture(
  input: { actionId?: IntakeActionId; providerJobId?: string | null } = {},
): { run: typeof runs.$inferSelect; provider: ProviderRunProcess } {
  seedChange("INTAKE_PENDING");
  const startedAt = "2026-07-10T00:00:10.000Z";
  const jobId = input.actionId ? "JOB-INTAKE" : null;
  if (input.actionId && jobId) {
    db.insert(pipelineJobs).values({
      id: jobId,
      changeId: CHANGE_ID,
      phase: INTAKE_JOB_PHASE_BY_ACTION[input.actionId],
      actionId: input.actionId,
      idempotencyKey: "intake-fixture",
      status: "running",
      leasedBy: "worker-intake",
      leaseExpiresAt: "2026-07-10T00:10:00.000Z",
      heartbeatAt: "2026-07-10T00:01:55.000Z",
      attemptNo: 1,
      errorCode: null,
      errorSummary: null,
      createdAt: startedAt,
      startedAt,
      endedAt: null,
      leaseToken: "lease-intake",
      workerNonce: "worker-intake-nonce",
    }).run();
  }
  db.insert(runs).values({
    id: "RUN-INTAKE",
    changeId: CHANGE_ID,
    phase: "intake",
    status: "running",
    startedAt,
    endedAt: null,
    summary: null,
    jobId,
    workerId: jobId ? "worker-intake" : null,
    leaseToken: jobId ? "lease-intake" : null,
    attemptNo: 1,
  }).run();
  const providerJobId = input.providerJobId === undefined ? jobId : input.providerJobId;
  db.insert(providerRunProcesses).values({
    id: "PRP-INTAKE",
    changeId: CHANGE_ID,
    runId: "RUN-INTAKE",
    phase: "intake",
    provider: "claude",
    pid: null,
    ppid: process.pid,
    roundId: null,
    status: "completed",
    startedAt,
    lastHeartbeatAt: startedAt,
    endedAt: "2026-07-10T00:01:00.000Z",
    exitCode: 0,
    signal: null,
    summary: "done",
    jobId: providerJobId,
    workerId: jobId ? "worker-intake" : null,
    leaseToken: jobId ? "lease-intake" : null,
    attemptNo: 1,
    externalRef: null,
    processNonce: null,
    processStartTime: null,
    processPpid: null,
    processPgid: null,
    processCwd: null,
    processCommandJson: null,
  }).run();
  const run = db.select().from(runs).where(eq(runs.id, "RUN-INTAKE")).get();
  const provider = db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-INTAKE")).get();
  assert.ok(run);
  assert.ok(provider);
  return { run, provider };
}

function insertOwnershipJob(input: {
  id: string;
  createdAt: string;
  attemptNo: number;
  leaseToken: string;
  status?: string;
  phase?: string;
}): void {
  const status = input.status ?? "succeeded";
  db.insert(pipelineJobs).values({
    id: input.id,
    changeId: CHANGE_ID,
    phase: input.phase ?? "tech_spec",
    actionId: "ownership-test",
    idempotencyKey: input.id,
    status,
    leasedBy: status === "queued" ? null : "worker-ownership",
    leaseExpiresAt: status === "leased" || status === "running"
      ? "2026-07-10T00:20:00.000Z"
      : null,
    heartbeatAt: status === "running" ? input.createdAt : null,
    attemptNo: input.attemptNo,
    errorCode: status === "failed" ? "new-attempt-failed" : null,
    errorSummary: status === "failed" ? "new-attempt-failed" : null,
    createdAt: input.createdAt,
    startedAt: status === "queued" ? null : input.createdAt,
    endedAt: ["succeeded", "failed"].includes(status) ? input.createdAt : null,
    leaseToken: status === "queued" ? null : input.leaseToken,
    workerNonce: status === "queued" ? null : "worker-ownership-nonce",
  }).run();
}

async function recoverTechSpecWithPostCommitJobMutation(
  mutateAfterCommit: () => void,
  options: Pick<StaleProviderRunRecoveryOptions, "terminateProcess"> = {},
): Promise<void> {
  await seedCompletedProviderFixture("tech_spec", true);
  const artifact = db.select().from(artifacts).where(and(
    eq(artifacts.runId, "RUN-MATRIX"), eq(artifacts.type, "tech_spec_delta"),
  )).get();
  assert.ok(artifact);
  const originalTransaction = db.transaction.bind(db);
  let drifted = false;
  (db as unknown as { transaction: typeof db.transaction }).transaction = ((callback: (tx: typeof db) => unknown, config?: unknown) => {
    const result = originalTransaction(callback, config as never);
    const committedRun = db.select({ status: runs.status }).from(runs)
      .where(eq(runs.id, "RUN-MATRIX")).get();
    if (!drifted && committedRun?.status === "completed") {
      drifted = true;
      fs.rmSync(artifact.path);
      mutateAfterCommit();
    }
    return result;
  }) as typeof db.transaction;
  try {
    await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      ...options,
    });
  } finally {
    (db as unknown as { transaction: typeof db.transaction }).transaction = originalTransaction as typeof db.transaction;
  }
}

function seedMissingOwnershipFixture(jobPhase = "tech_spec"): void {
  seedChange("TECHSPECCING");
  insertOwnershipJob({
    id: "JOB-MISSING-OWNERSHIP-CURRENT",
    createdAt: "2026-07-10T00:00:10.000Z",
    attemptNo: 1,
    leaseToken: "lease-missing-ownership",
    status: "running",
    phase: jobPhase,
  });
  db.insert(runs).values({
    id: "RUN-MISSING-OWNERSHIP-CURRENT", changeId: CHANGE_ID, phase: "tech_spec",
    status: "running", startedAt: "2026-07-10T00:00:10.000Z", endedAt: null,
    summary: null, jobId: "JOB-MISSING-OWNERSHIP-CURRENT", workerId: "worker-ownership",
    leaseToken: "lease-missing-ownership", attemptNo: 1,
  }).run();
  db.insert(stageRuns).values({
    id: "STG-MISSING-OWNERSHIP-CURRENT", changeId: CHANGE_ID, phase: "TechSpec", attemptNo: 1,
    status: "running", idempotencyKey: null, inputDbHash: null, outputDbHash: null,
    sourceLineageJson: null, errorCode: null, startedAt: "2026-07-10T00:00:10.000Z",
    completedAt: null,
  }).run();
}

function providerOwnershipState() {
  return {
    provider: db.select().from(providerRunProcesses)
      .where(eq(providerRunProcesses.id, "PRP-MATRIX")).get(),
    job: db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get(),
    run: db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get(),
    stage: db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get(),
    change: db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get(),
    events: db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all(),
    actions: computeActions(CHANGE_ID, { selfHeal: true }),
  };
}

function providerOwnershipProtectedState() {
  const state = providerOwnershipState();
  return {
    job: state.job,
    run: state.run,
    stage: state.stage,
    change: state.change,
    events: state.events,
    actions: state.actions,
  };
}

function assertProviderOwnershipMismatch(
  result: Awaited<ReturnType<typeof recoverStaleProviderRuns>>,
  before: ReturnType<typeof providerOwnershipState>,
): void {
  assert.equal(result.recovered.length, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(result.observed[0]?.reasonCode, "ownership_mismatch");
  assert.deepEqual(providerOwnershipState(), before);
}

async function assertTask11RouteActionUiClosure(
  expectedReason: string,
  expectedActionId: string,
  expectedUiStage: "tech_spec" | "build",
  expectedUiState: "failed",
): Promise<void> {
  setStartupRecoveryDependenciesForTest({
    logDir: process.cwd(),
    ensureLogs: () => {},
    checkDb: () => {},
    writeLog: () => {},
    recover: async () => ({ recovered: [], failed: [], observed: [], observedAt: RECOVERY_OBSERVED_AT.toISOString() }),
  });
  const context = { params: Promise.resolve({ id: PROJECT_ID, changeId: CHANGE_ID }) };
  const detailRoute = await import("../../app/api/projects/[id]/changes/[changeId]/route");
  const eventsRoute = await import("../../app/api/projects/[id]/changes/[changeId]/events/route");
  const streamRoute = await import("../../app/api/projects/[id]/changes/[changeId]/events/stream/route");
  const gateRoute = await import("../../app/api/projects/[id]/changes/[changeId]/gate/route");
  const { buildUiPipelineState } = await import("../../app/projects/[id]/changes/[changeId]/pipeline-ui-model");

  const detailResponse = await detailRoute.GET(new Request("http://localhost/detail"), context);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.notEqual(detail.latestRun?.status, "running");
  const actionResponse = await gateRoute.GET(new Request("http://localhost/gate"), context);
  assert.equal(actionResponse.status, 200);
  const actionModel = await actionResponse.json();
  assert.equal(actionModel.actions.some((action: { actionId: string; enabled: boolean }) =>
    action.actionId === expectedActionId && action.enabled), true);

  const eventsResponse = await eventsRoute.GET(new Request("http://localhost/events"), context);
  assert.equal(eventsResponse.status, 200);
  assert.match(await eventsResponse.text(), new RegExp(expectedReason));

  const streamResponse = await streamRoute.GET(new Request("http://localhost/events/stream"), context);
  assert.equal(streamResponse.status, 200);
  const reader = streamResponse.body?.getReader();
  assert.ok(reader);
  const first = await reader.read();
  await reader.cancel();
  const initial = new TextDecoder().decode(first.value);
  assert.match(initial, new RegExp(expectedReason));
  assert.doesNotMatch(initial, /\"status\":\"running\"/);

  const ui = buildUiPipelineState({ change: detail });
  assert.equal(ui.activeStage.id, expectedUiStage);
  assert.equal(ui.activeStage.state, expectedUiState);
}

describe("stale-provider-run-recovery-service", { concurrency: false, timeout: 30_000 }, () => {
  beforeEach(() => {
    cleanupRows();
    resetRecoveryCursorsForTest();
  });

  afterEach(() => {
    resetRecoveryCursorsForTest();
    resetStartupRecoveryForTest();
    cleanupRows();
    for (const repoPath of fixtureRepoPaths.splice(0)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("dry-runs stale pid-less provider runs without mutating state", async () => {
    seedChange();
    const runId = seedRun();

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: false,
      providerHeartbeatStaleMs: 45_000,
      now: () => new Date("2026-07-10T00:01:20.000Z"),
    });

    assert.equal(result.observed[0]?.kind, "stale");
    assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, "running");
    assert.equal(
      db.select().from(providerRunProcesses).where(eq(providerRunProcesses.runId, runId)).get()
        ?.status,
      "running",
    );
  });

  it("keeps provider runs active while the recorded pid is alive", async () => {
    seedChange();
    seedRun({ pid: process.pid });

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      providerHeartbeatStaleMs: 45_000,
      now: () => new Date("2026-07-10T00:01:20.000Z"),
      processIdentityProbe: identityProbeReturning({ ok: true, observed: expectedIdentity(process.pid) }),
    });

    assert.equal(result.observed[0]?.kind, "active");
    assert.equal(result.observed[0]?.reason, "identity_valid");
  });

  it("reconciles a running provider after its business run and job already failed", async () => {
    seedReconciliationFixture({ jobStatus: "failed" });
    db.update(runs).set({
      status: "failed",
      endedAt: "2026-07-10T00:01:30.000Z",
      summary: "provider_failed",
    }).where(eq(runs.id, "RUN-MATRIX")).run();

    const observed = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: false,
      observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: identityProbeReturning({ ok: false, reason: "pid_missing" }),
    });

    assert.equal(observed.observed[0]?.kind, "stale");
    assert.equal(observed.observed[0]?.reasonCode, "business_run_reconciled");

    const recovered = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: identityProbeReturning({ ok: false, reason: "pid_missing" }),
    });

    assert.equal(recovered.recovered[0]?.reasonCode, "business_run_reconciled");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "failed");
  });

  for (const runStatus of ["failed", "completed"] as const) {
    for (const jobState of ["running", "missing"] as const) {
      it(`discovers and provider-only reconciles a ${runStatus} business run with a ${jobState} job`, async () => {
      seedReconciliationFixture();
      db.update(runs).set({
        status: runStatus,
        endedAt: "2026-07-10T00:01:30.000Z",
        summary: runStatus === "failed" ? "provider_failed" : "completed",
      }).where(eq(runs.id, "RUN-MATRIX")).run();
      if (jobState === "missing") {
        db.delete(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
      }
      const beforeChange = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
      const beforeStage = db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get();

      const observed = await recoverStaleProviderRuns({
        changeId: CHANGE_ID,
        execute: false,
        observedAt: RECOVERY_OBSERVED_AT,
        processIdentityProbe: identityProbeReturning({ ok: false, reason: "pid_missing" }),
      });
      assert.equal(observed.observed[0]?.kind, "stale");

      const recovered = await recoverStaleProviderRuns({
        changeId: CHANGE_ID,
        execute: true,
        observedAt: RECOVERY_OBSERVED_AT,
        processIdentityProbe: identityProbeReturning({ ok: false, reason: "pid_missing" }),
      });
      assert.equal(recovered.recovered.length, 1);
      assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, runStatus);
      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, runStatus);
      assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, jobState === "running" ? "running" : undefined);
      assert.deepEqual(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get(), beforeChange);
      assert.deepEqual(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get(), beforeStage);
      });
    }
  }

  for (const runStatus of ["failed", "completed"] as const) {
    for (const jobState of ["running", "missing"] as const) {
      it(`prioritizes a ${runStatus} business run over a live fresh provider with a ${jobState} job`, async () => {
        seedReconciliationFixture({ heartbeatAt: "2026-07-10T00:01:59.000Z" });
        db.update(runs).set({
          status: runStatus,
          endedAt: "2026-07-10T00:01:30.000Z",
          summary: runStatus,
        }).where(eq(runs.id, "RUN-MATRIX")).run();
        if (jobState === "missing") {
          db.delete(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
        }
        const aliveProbe = identityProbeReturning({ ok: true, observed: expectedIdentity() });

        const observed = await recoverStaleProviderRuns({
          changeId: CHANGE_ID,
          execute: false,
          observedAt: RECOVERY_OBSERVED_AT,
          processIdentityProbe: aliveProbe,
        });
        assert.equal(observed.observed[0]?.kind, "stale");
        assert.equal(observed.observed[0]?.reasonCode, "business_run_reconciled");

        const recovered = await recoverStaleProviderRuns({
          changeId: CHANGE_ID,
          execute: true,
          observedAt: RECOVERY_OBSERVED_AT,
          processIdentityProbe: aliveProbe,
        });
        assert.equal(recovered.recovered[0]?.reasonCode, "business_run_reconciled");
        assert.equal(
          db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status,
          runStatus,
        );
        assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, runStatus);
        assert.equal(
          db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status,
          jobState === "running" ? "running" : undefined,
        );
      });
    }
  }

  it("does not provider-only reconcile a terminal run after a newer attempt takes ownership", async () => {
    seedReconciliationFixture();
    db.update(runs).set({ status: "failed", endedAt: "2026-07-10T00:01:30.000Z" })
      .where(eq(runs.id, "RUN-MATRIX")).run();
    db.update(pipelineJobs).set({
      status: "failed",
      leaseExpiresAt: null,
      endedAt: "2026-07-10T00:01:30.000Z",
    }).where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
    insertOwnershipJob({
      id: "JOB-NEW-OWNER",
      createdAt: "2026-07-10T00:02:00.000Z",
      attemptNo: 2,
      leaseToken: "lease-new-owner",
      status: "running",
    });

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: identityProbeReturning({ ok: false, reason: "pid_missing" }),
    });

    assert.equal(result.recovered.length, 0);
    assert.equal(result.observed[0]?.reasonCode, "newer_attempt_owner");
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "running");
  });

  it("provider-only reconciles when every newer retry job is already terminal", async () => {
    seedReconciliationFixture();
    db.update(runs).set({ status: "failed", endedAt: "2026-07-10T00:01:30.000Z" })
      .where(eq(runs.id, "RUN-MATRIX")).run();
    db.update(pipelineJobs).set({
      status: "failed",
      leaseExpiresAt: null,
      endedAt: "2026-07-10T00:01:30.000Z",
    }).where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
    insertOwnershipJob({
      id: "JOB-NEW-TERMINAL-2",
      createdAt: "2026-07-10T00:02:00.000Z",
      attemptNo: 2,
      leaseToken: "lease-terminal-2",
      status: "failed",
    });
    insertOwnershipJob({
      id: "JOB-NEW-TERMINAL-3",
      createdAt: "2026-07-10T00:03:00.000Z",
      attemptNo: 3,
      leaseToken: "lease-terminal-3",
      status: "succeeded",
    });

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
    });

    assert.equal(result.recovered[0]?.reasonCode, "business_run_reconciled");
    assert.equal(db.select().from(providerRunProcesses)
      .where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(pipelineJobs)
      .where(eq(pipelineJobs.id, "JOB-NEW-TERMINAL-2")).get()?.status, "failed");
    assert.equal(db.select().from(pipelineJobs)
      .where(eq(pipelineJobs.id, "JOB-NEW-TERMINAL-3")).get()?.status, "succeeded");
  });

  it("skips provider-only recovery for an active different job with a lexically early invalid createdAt", async () => {
    seedReconciliationFixture();
    db.update(runs).set({ status: "failed", endedAt: "2026-07-10T00:01:30.000Z" })
      .where(eq(runs.id, "RUN-MATRIX")).run();
    db.update(pipelineJobs).set({
      status: "failed",
      leaseExpiresAt: null,
      endedAt: "2026-07-10T00:01:30.000Z",
    }).where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
    insertOwnershipJob({
      id: "JOB-INVALID-EARLY-ACTIVE",
      createdAt: "!invalid-early",
      attemptNo: 2,
      leaseToken: "lease-invalid-early",
      status: "running",
    });

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
    });

    assert.equal(result.recovered.length, 0);
    assert.equal(result.observed[0]?.reasonCode, "newer_attempt_owner");
    assert.equal(db.select().from(providerRunProcesses)
      .where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(events).where(and(
      eq(events.changeId, CHANGE_ID),
      eq(events.type, "business_run_reconciled"),
    )).all().length, 0);
  });

  it("recovers stale TechSpec provider runs and rolls the change back to SPEC_READY", async () => {
    seedChange("TECHSPECCING");
    const runId = seedRun({ pid: 999_999 });
    seedStageRun();

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      staleAfterMs: 1,
      now: () => new Date("2026-07-10T00:20:00.000Z"),
      processIdentityProbe: identityProbeReturning({ ok: false, reason: "pid_missing" }),
    });

    assert.equal(result.recovered[0]?.kind, "recovered");
    assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, "failed");
    assert.equal(
      db.select().from(providerRunProcesses).where(eq(providerRunProcesses.runId, runId)).get()
        ?.status,
      "orphaned",
    );
    assert.equal(
      db.select().from(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).get()?.status,
      "failed",
    );
    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    assert.equal(change?.status, "SPEC_READY");
    assert.equal(
      db
        .select()
        .from(events)
        .where(and(eq(events.changeId, CHANGE_ID), eq(events.type, "provider_process_orphaned")))
        .all().length,
      1,
    );
  });

  it("recovers stale Spec blue runs without requiring a red-process-specific API", async () => {
    seedChange("SPECCING");
    const runId = seedRun({
      runId: "RUN-SPEC-BLUE",
      phase: "spec",
      providerPhase: "spec_critic",
      pid: 999_998,
    });
    db.insert(battleRounds).values({
      id: "ROUND-SPEC-BLUE",
      changeId: CHANGE_ID,
      phase: "spec",
      template: "default",
      roundNo: 1,
      status: "blue_running",
      redUnit: "red",
      blueUnit: "blue",
      inputSnapshotJson: "{}",
      paramsJson: "{}",
      redArtifactPath: ".ship/red.md",
      redArtifactHash: "red-hash",
      blueArtifactPath: null,
      blueArtifactHash: null,
      reportPath: null,
      supersededByRoundId: null,
      startedAt: "2026-07-10T00:01:00.000Z",
      endedAt: null,
      createdAt: "2026-07-10T00:01:00.000Z",
      updatedAt: "2026-07-10T00:01:00.000Z",
    }).run();

    await recoverStaleProviderRunsBestEffort(CHANGE_ID);
    await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      staleAfterMs: 1,
      now: () => new Date("2026-07-10T00:20:00.000Z"),
      processIdentityProbe: identityProbeReturning({ ok: false, reason: "pid_missing" }),
    });

    assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, "failed");
    assert.equal(
      db.select().from(battleRounds).where(eq(battleRounds.id, "ROUND-SPEC-BLUE")).get()?.status,
      "failed",
    );
    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    assert.equal(change?.status, "BLOCKED");
    assert.equal(change?.blockedPhase, "spec");
  });

  it("recovers stale intake runs to BLOCKED so a compensated failure is distinguishable from success", async () => {
    seedChange("INTAKE_PENDING");
    const runId = seedRun({
      runId: "RUN-INTAKE-STALE",
      phase: "intake",
      pid: 999_997,
    });

    await recoverStaleProviderRunsBestEffort(CHANGE_ID);
    await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      staleAfterMs: 1,
      now: () => new Date("2026-07-10T00:20:00.000Z"),
      processIdentityProbe: identityProbeReturning({ ok: false, reason: "pid_missing" }),
    });

    assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, "failed");
    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    // Before the fix the intake fallback equalled the completed status
    // ("INTAKE_READY"), so a compensated failure was indistinguishable from a
    // genuine success. It must now land on BLOCKED, mirroring the Spec/Review
    // precedent.
    assert.equal(change?.status, "BLOCKED");
    assert.equal(change?.blockedPhase, "intake");
  });

  it("keeps best-effort recovery from throwing on missing changes", async () => {
    await assert.doesNotReject(() => recoverStaleProviderRunsBestEffort("CHG-DOES-NOT-EXIST"));
  });

  it("scans a running business run with no provider row after the 30 second start grace", async () => {
    seedChange("TECHSPECCING");
    db.insert(pipelineJobs).values({
      id: "JOB-NO-START",
      changeId: CHANGE_ID,
      phase: "tech_spec",
      actionId: "run_tech_spec",
      idempotencyKey: "no-start",
      status: "running",
      leasedBy: "worker-1",
      leaseExpiresAt: "2026-07-10T00:10:00.000Z",
      heartbeatAt: "2026-07-10T00:00:20.000Z",
      attemptNo: 1,
      errorCode: null,
      errorSummary: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      startedAt: "2026-07-10T00:00:20.000Z",
      endedAt: null,
      leaseToken: "lease-no-start",
      workerNonce: "worker-nonce",
    }).run();
    db.insert(runs).values({
      id: "RUN-NO-START",
      changeId: CHANGE_ID,
      phase: "tech_spec",
      status: "running",
      startedAt: "2026-07-10T00:00:20.000Z",
      endedAt: null,
      summary: null,
      jobId: "JOB-NO-START",
      workerId: "worker-1",
      leaseToken: "lease-no-start",
      attemptNo: 1,
    }).run();
    db.insert(stageRuns).values({
      id: "STG-NO-START",
      changeId: CHANGE_ID,
      phase: "TechSpec",
      attemptNo: 1,
      status: "running",
      idempotencyKey: "no-start",
      inputDbHash: null,
      outputDbHash: null,
      sourceLineageJson: null,
      errorCode: null,
      startedAt: "2026-07-10T00:00:20.000Z",
      completedAt: null,
    }).run();
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.runId, "RUN-NO-START")).all().length, 0);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-NO-START")).get()?.status, "running");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-NO-START")).get()?.status, "running");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-NO-START")).get()?.status, "running");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
    assert.equal(db.select().from(events).where(eq(events.type, "provider_start_missing")).all().length, 0);
    assert.equal(computeActions(CHANGE_ID, { selfHeal: true }).find((action) => action.actionId === "retry_tech_spec")?.enabled, false);
    // Spec source production always has behind a running tech_spec run; seeded
    // after the pre-recovery (disabled) assertion so recovery can re-open retry.
    seedSpecSourceAuthority();
    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: new Date("2026-07-10T00:00:51.000Z"),
    });

    assert.equal(result.recovered.length, 1);
    assert.equal(result.failed.length, 0);
    assert.equal(result.recovered[0]?.reasonCode, "provider_start_missing");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-NO-START")).get()?.status, "failed");
    assert.equal(
      db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-NO-START")).get()?.status,
      "failed",
    );
    const provider = db
      .select()
      .from(providerRunProcesses)
      .where(eq(providerRunProcesses.runId, "RUN-NO-START"))
      .get();
    assert.equal(provider?.status, "orphaned");
    assert.equal(provider?.summary, "provider_start_missing");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-NO-START")).get()?.status, "failed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "SPEC_READY");
    assert.equal(
      computeActions(CHANGE_ID, { selfHeal: true })
        .some((action) => action.actionId === "retry_tech_spec" && action.enabled),
      true,
    );
    assert.equal(
      db.select().from(events).where(and(
        eq(events.changeId, CHANGE_ID),
        eq(events.type, "provider_start_missing"),
      )).all().length,
      1,
    );
    await assertTask11RouteActionUiClosure("provider_start_missing", "retry_tech_spec", "tech_spec", "failed");
  });

  const matrixScenarios: Array<{
    name: string;
    seed: Parameters<typeof seedReconciliationFixture>[0];
    validation: Awaited<ReturnType<ProcessIdentityProbe["validate"]>>;
    expectedReason: string;
    expectedRunStatus?: string;
    expectedProviderStatus?: string;
    expectedJobStatus?: string;
    expectedSignals?: number;
    expectedChangeStatus?: string;
    expectedActionId?: string;
    expectedDisabledActionId?: string;
  }> = [
    {
      name: "row 2 fails a completed provider when business evidence is incomplete",
      seed: { providerStatus: "completed" },
      validation: { ok: true, observed: expectedIdentity() },
      expectedReason: "business_run_reconciled",
      expectedRunStatus: "failed",
      expectedProviderStatus: "completed",
      expectedJobStatus: "failed",
      expectedChangeStatus: "SPEC_READY",
      expectedActionId: "retry_tech_spec",
    },
    {
      name: "row 2 maps a stopped provider to failed business state",
      seed: { providerStatus: "stopped" },
      validation: { ok: true, observed: expectedIdentity() },
      expectedReason: "business_run_reconciled",
      expectedRunStatus: "failed",
      expectedProviderStatus: "stopped",
      expectedJobStatus: "failed",
      expectedChangeStatus: "SPEC_READY",
      expectedActionId: "retry_tech_spec",
    },
    {
      name: "row 2 maps an orphaned provider to failed business state",
      seed: { providerStatus: "orphaned" },
      validation: { ok: true, observed: expectedIdentity() },
      expectedReason: "business_run_reconciled",
      expectedRunStatus: "failed",
      expectedProviderStatus: "orphaned",
      expectedJobStatus: "failed",
      expectedChangeStatus: "SPEC_READY",
      expectedActionId: "retry_tech_spec",
    },
    {
      name: "row 4 recovers pid_missing after the provider heartbeat grace expires",
      seed: { heartbeatAt: "2026-07-10T00:01:00.000Z" },
      validation: { ok: false, reason: "pid_missing" },
      expectedReason: "provider_process_orphaned",
    },
    {
      name: "row 5 fails closed on a reused pid and never signals it",
      seed: {},
      validation: { ok: false, reason: "pid_reused", observed: expectedIdentity(424_243) },
      expectedReason: "provider_identity_mismatch",
      expectedSignals: 0,
    },
    // A completed probe that disagreed with the persisted identity is a fact
    // about the process and must keep reporting as a mismatch -- separating the
    // probe-infrastructure failures below must not launder these into "we could
    // not tell".
    {
      name: "row 5 reports a cwd mismatch as an identity mismatch",
      seed: {},
      validation: {
        ok: false,
        reason: "cwd_mismatch",
        observed: { ...expectedIdentity(), cwd: "/somewhere/else" },
      },
      expectedReason: "provider_identity_mismatch",
      expectedSignals: 0,
    },
    {
      name: "row 5 reports a command mismatch as an identity mismatch",
      seed: {},
      validation: {
        ok: false,
        reason: "command_mismatch",
        observed: { ...expectedIdentity(), command: ["node", "something-else.js"] },
      },
      expectedReason: "provider_identity_mismatch",
      expectedSignals: 0,
    },
    // The probe shells out to `ps` (and `lsof` on darwin) under a 750ms budget.
    // Blowing that budget, the output limit, or failing to run at all says
    // nothing whatsoever about the process, so none of these may be reported as
    // an identity fact.
    {
      name: "row 5b reports a probe timeout as a probe failure, not an identity mismatch",
      seed: {},
      validation: { ok: false, reason: "probe_timeout" },
      expectedReason: "provider_identity_probe_failed",
      expectedSignals: 0,
    },
    {
      name: "row 5b reports a probe output-limit overflow as a probe failure",
      seed: {},
      validation: { ok: false, reason: "probe_output_limit" },
      expectedReason: "provider_identity_probe_failed",
      expectedSignals: 0,
    },
    {
      name: "row 5b reports a failed probe as a probe failure",
      seed: {},
      validation: { ok: false, reason: "probe_failed" },
      expectedReason: "provider_identity_probe_failed",
      expectedSignals: 0,
    },
    {
      name: "row 6a defers cleanup when ppid_dead also changes another strong field",
      seed: {},
      validation: { ok: false, reason: "ppid_dead", observed: { ...expectedIdentity(), ppid: 1, cwd: "/other" } },
      expectedReason: "provider_parent_missing",
      expectedSignals: 0,
    },
    {
      name: "row 6b recovers ppid_mismatch and never signals observed parent or child",
      seed: {},
      validation: {
        ok: false,
        reason: "ppid_mismatch",
        observed: { ...expectedIdentity(), ppid: process.pid + 1000 },
      },
      expectedReason: "provider_parent_mismatch",
      expectedSignals: 0,
    },
    {
      name: "row 7 recovers a provider heartbeat older than 45 seconds",
      seed: { heartbeatAt: "2026-07-10T00:01:14.000Z" },
      validation: { ok: true, observed: expectedIdentity() },
      expectedReason: "provider_heartbeat_stale",
      expectedSignals: 1,
    },
    // Row 8 used to collapse both of these into stale_lease_fenced. They are
    // different diagnoses: the first is a run that stopped renewing while it
    // still owned the fence (a stall), the second is a slot somebody else
    // already owns.
    {
      name: "row 8a reports an expired lease with an intact fence as a lease expiry",
      seed: { leaseExpiresAt: "2026-07-10T00:01:59.000Z" },
      validation: { ok: true, observed: expectedIdentity() },
      expectedReason: "provider_lease_expired",
      expectedProviderStatus: "stopped",
      expectedSignals: 0,
    },
    {
      name: "row 8b reverse-reconciles a terminal job while provider and business run remain running",
      seed: { jobStatus: "failed" },
      validation: { ok: true, observed: expectedIdentity() },
      expectedReason: "stale_lease_fenced",
      expectedProviderStatus: "stopped",
      expectedJobStatus: "failed",
      expectedSignals: 0,
    },
    {
      name: "row 8b reports a superseded fence as fenced even when the lease also expired",
      seed: { leaseExpiresAt: "2026-07-10T00:01:59.000Z", jobStatus: "failed" },
      validation: { ok: true, observed: expectedIdentity() },
      expectedReason: "stale_lease_fenced",
      expectedProviderStatus: "stopped",
      expectedJobStatus: "failed",
      expectedSignals: 0,
    },
  ];

  it("defers pid_missing recovery while provider and job heartbeats are still fresh", async () => {
    seedReconciliationFixture({ heartbeatAt: "2026-07-10T00:01:55.000Z" });

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: identityProbeReturning({ ok: false, reason: "pid_missing" }),
      terminateProcess: async () => assert.fail("an already exited process must not be signaled"),
    });

    assert.equal(result.recovered.length, 0);
    assert.equal(result.observed[0]?.kind, "active");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(events).where(eq(events.type, "provider_process_orphaned")).all().length, 0);
  });

  for (const scenario of matrixScenarios) {
    it(scenario.name, async () => {
      seedReconciliationFixture(scenario.seed);
      const signaled: ProcessIdentity[] = [];

      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
      assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, scenario.seed.providerStatus ?? "running");
      assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, scenario.seed.jobStatus ?? "running");
      assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "running");
      assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
      assert.equal(db.select().from(events).where(eq(events.type, scenario.expectedReason)).all().length, 0);
      assert.equal(
        computeActions(CHANGE_ID, { selfHeal: true })
          .some((action) => action.actionId === "retry_tech_spec" && action.enabled),
        false,
      );

      // Model the Spec source that production always has behind a running
      // tech_spec run. Seeded after the pre-recovery assertion so that check
      // still observes retry_tech_spec disabled (its running/terminal job or the
      // missing gate keeps it closed); recovery then re-opens retry_tech_spec.
      seedSpecSourceAuthority();

      const result = await recoverStaleProviderRuns({
        changeId: CHANGE_ID,
        execute: true,
        observedAt: RECOVERY_OBSERVED_AT,
        processIdentityProbe: identityProbeReturning(scenario.validation),
        terminateProcess: async (identity) => {
          signaled.push(identity);
        },
      });

      assert.equal(result.failed.length, 0);
      assert.equal(result.recovered.length, 1);
      assert.equal(result.recovered[0]?.reasonCode, scenario.expectedReason);
      assert.equal(
        db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status,
        scenario.expectedRunStatus ?? "failed",
      );
      assert.equal(
        db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status,
        scenario.expectedProviderStatus ?? "orphaned",
      );
      assert.equal(
        db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status,
        scenario.expectedJobStatus ?? "failed",
      );
      assert.equal(
        db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status,
        scenario.expectedRunStatus === "completed" ? "completed" : "failed",
      );
      assert.equal(
        db.select().from(events).where(and(
          eq(events.changeId, CHANGE_ID),
          eq(events.type, scenario.expectedReason),
        )).all().length,
        1,
      );
      if (["completed", "failed", "stopped", "orphaned"].includes(scenario.seed.providerStatus ?? "")) {
        const event = db.select().from(events).where(and(
          eq(events.changeId, CHANGE_ID),
          eq(events.type, scenario.expectedReason),
        )).get();
        assert.equal(JSON.parse(event?.rawJson ?? "{}").providerTerminal, scenario.seed.providerStatus);
      }
      assert.equal(
        db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status,
        scenario.expectedChangeStatus ?? "SPEC_READY",
      );
      const actions = computeActions(CHANGE_ID, { selfHeal: true });
      if (scenario.expectedDisabledActionId) {
        assert.equal(
          actions.find((action) => action.actionId === scenario.expectedDisabledActionId)?.enabled,
          false,
        );
      } else {
        const expectedActionId = scenario.expectedActionId ?? "retry_tech_spec";
        assert.equal(
          actions.some((action) => action.actionId === expectedActionId && action.enabled),
          true,
        );
      }
      assert.equal(signaled.length, scenario.expectedSignals ?? 0);
      if (scenario.expectedReason === "provider_parent_missing") {
        assert.match(
          db.select().from(providerRunProcesses)
            .where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.summary ?? "",
          /cleanup_deferred/,
        );
      }
      await assertTask11RouteActionUiClosure(
        scenario.expectedReason,
        scenario.expectedActionId ?? "retry_tech_spec",
        "tech_spec",
        "failed",
      );
    });
  }

  it("records the probe reason and heartbeat ages on the recovery event", async () => {
    seedReconciliationFixture({});
    seedSpecSourceAuthority();

    await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: identityProbeReturning({ ok: false, reason: "probe_timeout" }),
    });

    const event = db.select().from(events).where(and(
      eq(events.changeId, CHANGE_ID),
      eq(events.type, "provider_identity_probe_failed"),
    )).get();
    const raw = JSON.parse(event?.rawJson ?? "{}") as { observation?: Record<string, unknown> };
    // The exact discriminator and the ages it was judged against, so a
    // post-mortem reads them here instead of re-deriving them from logs.
    assert.deepEqual(raw.observation, {
      providerHeartbeatAgeMs: 5_000,
      jobHeartbeatAgeMs: 5_000,
      heartbeatStaleMs: 45_000,
      jobStatus: "running",
      identityValidation: "probe_timeout",
    });
  });

  it("reports an expired lease with an intact fence when the provider row is missing", async () => {
    seedChange("TECHSPECCING");
    db.insert(pipelineJobs).values({
      id: "JOB-MISSING-PROVIDER-LEASE-EXPIRED",
      changeId: CHANGE_ID,
      phase: "tech_spec",
      actionId: "run_tech_spec",
      idempotencyKey: "lease-expired",
      status: "running",
      leasedBy: "worker-1",
      leaseExpiresAt: "2026-07-10T00:01:59.000Z",
      heartbeatAt: "2026-07-10T00:01:59.000Z",
      attemptNo: 1,
      errorCode: null,
      errorSummary: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      startedAt: "2026-07-10T00:00:00.000Z",
      endedAt: null,
      leaseToken: "lease-expired",
      workerNonce: "worker-nonce",
    }).run();
    // Started half a second before observedAt, so the run is still well inside
    // the start-grace window: only the expired lease can trigger recovery here.
    db.insert(runs).values({
      id: "RUN-MISSING-PROVIDER-LEASE-EXPIRED",
      changeId: CHANGE_ID,
      phase: "tech_spec",
      status: "running",
      startedAt: "2026-07-10T00:01:59.500Z",
      endedAt: null,
      summary: null,
      jobId: "JOB-MISSING-PROVIDER-LEASE-EXPIRED",
      workerId: "worker-1",
      leaseToken: "lease-expired",
      attemptNo: 1,
    }).run();

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
    });

    assert.equal(result.failed.length, 0);
    assert.equal(result.recovered[0]?.reasonCode, "provider_lease_expired");
    assert.equal(
      db.select().from(runs).where(eq(runs.id, "RUN-MISSING-PROVIDER-LEASE-EXPIRED")).get()?.status,
      "failed",
    );
    assert.equal(
      db.select().from(pipelineJobs)
        .where(eq(pipelineJobs.id, "JOB-MISSING-PROVIDER-LEASE-EXPIRED")).get()?.status,
      "failed",
    );
    // A lease outcome parks the synthetic provider row as stopped, not orphaned.
    assert.equal(
      db.select().from(providerRunProcesses)
        .where(eq(providerRunProcesses.runId, "RUN-MISSING-PROVIDER-LEASE-EXPIRED")).get()?.status,
      "stopped",
    );
    assert.equal(
      db.select().from(events).where(eq(events.type, "stale_lease_fenced")).all().length,
      0,
    );
    const event = db.select().from(events).where(and(
      eq(events.changeId, CHANGE_ID),
      eq(events.type, "provider_lease_expired"),
    )).get();
    const raw = JSON.parse(event?.rawJson ?? "{}") as { observation?: Record<string, unknown> };
    assert.deepEqual(raw.observation, {
      jobHeartbeatAgeMs: 1_000,
      runAgeMs: 500,
      heartbeatStaleMs: 45_000,
      jobStatus: "running",
      leaseExpired: true,
      fenceInvalid: false,
    });
  });

  it("row 6a recaptures a reparented child and performs exactly one controlled termination", async () => {
    seedReconciliationFixture({ heartbeatAt: "2026-07-10T00:01:55.000Z" });
    const original = expectedIdentity();
    const recaptured = { ...original, ppid: 1, nonce: "nonce-after-reparent" };
    const captureExpected: Array<Partial<ProcessIdentity> | undefined> = [];
    const terminated: ProcessIdentity[] = [];
    const probe: ProcessIdentityProbe = {
      capture: async (_pid, expected) => {
        captureExpected.push(expected);
        return recaptured;
      },
      validate: async () => ({ ok: false, reason: "ppid_dead", observed: { ...original, ppid: 1 } }),
    };

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: probe,
      terminateProcess: async (identity) => { terminated.push(identity); },
    });

    assert.equal(result.recovered[0]?.reasonCode, "provider_parent_missing");
    assert.equal(captureExpected.length, 1);
    assert.equal(captureExpected[0]?.ppid, undefined);
    assert.equal(captureExpected[0]?.nonce, undefined);
    assert.deepEqual(terminated, [recaptured]);
    assert.doesNotMatch(
      db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.summary ?? "",
      /cleanup_deferred/,
    );
  });

  it("row 6a leaves a reparented child unmanaged when recapture changes another strong field", async () => {
    seedReconciliationFixture();
    const original = expectedIdentity();
    const terminated: ProcessIdentity[] = [];
    const probe: ProcessIdentityProbe = {
      capture: async () => ({ ...original, ppid: 1, nonce: "nonce-after-reparent", cwd: "/other" }),
      validate: async () => ({ ok: false, reason: "ppid_dead", observed: { ...original, ppid: 1 } }),
    };

    await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: probe,
      terminateProcess: async (identity) => { terminated.push(identity); },
    });

    assert.equal(terminated.length, 0);
    assert.match(
      db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.summary ?? "",
      /cleanup_deferred_unmanaged/,
    );
  });

  it("keeps a fresh Codex thread lifecycle active when pid is null", async () => {
    seedReconciliationFixture({
      provider: "codex", pid: null, externalRef: "thread-fresh", heartbeatAt: "2026-07-10T00:01:30.000Z",
    });
    const signaled: ProcessIdentity[] = [];
    const before = {
      run: db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get(),
      provider: db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get(),
      job: db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get(),
      change: db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get(),
    };

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: identityProbeReturning({ ok: false, reason: "pid_missing" }),
      terminateProcess: async (identity) => { signaled.push(identity); },
    });

    assert.equal(result.observed[0]?.kind, "active");
    assert.equal(result.observed[0]?.reason, "external_ref_heartbeat_fresh");
    assert.deepEqual(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get(), before.run);
    assert.deepEqual(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get(), before.provider);
    assert.deepEqual(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get(), before.job);
    assert.deepEqual(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get(), before.change);
    assert.equal(signaled.length, 0);
    assert.equal(db.select().from(events).where(eq(events.type, "provider_process_orphaned")).all().length, 0);
  });

  it("recovers a stale Codex thread lifecycle only after its heartbeat threshold", async () => {
    seedReconciliationFixture({
      provider: "codex", pid: null, externalRef: "thread-stale", heartbeatAt: "2026-07-10T00:01:14.000Z",
    });

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      terminateProcess: async () => assert.fail("pid-less Codex lifecycle must never be signaled"),
    });

    assert.equal(result.recovered[0]?.reasonCode, "provider_heartbeat_stale");
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "orphaned");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(events).where(eq(events.type, "provider_heartbeat_stale")).all().length, 1);
  });

  it("keeps a fresh pid-less Codex lifecycle active while its externalRef is pending", async () => {
    seedReconciliationFixture({ provider: "codex", pid: null, externalRef: null });

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
    });

    assert.equal(result.recovered.length, 0);
    assert.equal(result.observed[0]?.kind, "active");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(events).where(eq(events.type, "provider_protocol_invalid")).all().length, 0);
  });

  it("treats a stale pid-less Codex lifecycle without a valid externalRef as a protocol error", async () => {
    seedReconciliationFixture({
      provider: "codex", pid: null, externalRef: "   ", heartbeatAt: "2026-07-10T00:01:00.000Z",
    });

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
    });

    assert.equal(result.recovered[0]?.reasonCode, "provider_protocol_invalid");
    assert.equal(db.select().from(events).where(eq(events.type, "provider_protocol_invalid")).all().length, 1);
  });

  it("row 3 waits 60 seconds before recovering Build/Fix runs with no lifecycle", async () => {
    seedChange("IMPLEMENTING");
    db.insert(pipelineJobs).values({
      id: "JOB-LEGACY-BUILD",
      changeId: CHANGE_ID,
      phase: "implement",
      actionId: "run_build",
      idempotencyKey: "legacy-build",
      status: "running",
      leasedBy: "worker-legacy",
      leaseExpiresAt: "2026-07-10T00:10:00.000Z",
      heartbeatAt: "2026-07-10T00:01:59.000Z",
      attemptNo: 1,
      errorCode: null,
      errorSummary: null,
      createdAt: "2026-07-10T00:01:00.000Z",
      startedAt: "2026-07-10T00:01:00.000Z",
      endedAt: null,
      leaseToken: "lease-legacy-build",
      workerNonce: "nonce-legacy-build",
    }).run();
    db.insert(runs).values({
      id: "RUN-LEGACY-BUILD",
      changeId: CHANGE_ID,
      phase: "implement",
      status: "running",
      startedAt: "2026-07-10T00:01:00.000Z",
      endedAt: null,
      summary: null,
      jobId: "JOB-LEGACY-BUILD",
      workerId: "worker-legacy",
      leaseToken: "lease-legacy-build",
      attemptNo: 1,
    }).run();
    db.insert(stageRuns).values({
      id: "STG-LEGACY-BUILD",
      changeId: CHANGE_ID,
      phase: "Build",
      attemptNo: 1,
      status: "running",
      idempotencyKey: "legacy-build",
      inputDbHash: null,
      outputDbHash: null,
      sourceLineageJson: null,
      errorCode: null,
      startedAt: "2026-07-10T00:01:00.000Z",
      completedAt: null,
    }).run();
    db.insert(buildRunRecords).values({
      id: "BLD-LEGACY-BUILD",
      changeId: CHANGE_ID,
      runId: "RUN-LEGACY-BUILD",
      buildRunId: "build-legacy",
      status: "running",
      headSha: null,
      baseHeadSha: null,
      baseCommit: null,
      patchHash: null,
      changedFilesHash: null,
      adoptedHeadSha: null,
      adoptionDecisionId: null,
      adoptedAt: null,
      artifactHash: null,
      source: "pipeline",
      createdAt: "2026-07-10T00:01:00.000Z",
      updatedAt: "2026-07-10T00:01:00.000Z",
    }).run();
    db.insert(stageGates).values({
      id: "GATE-LEGACY-TESTPLAN",
      changeId: CHANGE_ID,
      phase: "TestPlan",
      status: "passed",
      blockersJson: "[]",
      freshnessJson: JSON.stringify({ fresh: true }),
      requiredActionsJson: "[]",
      sourceDbHash: "testplan-ready",
      gateVersion: 1,
      computedAt: "2026-07-10T00:00:59.000Z",
    }).run();
    // Back the TestPlan gate with the source retry_build's enqueue authority
    // traces; the running Build job keeps retry_build disabled until recovery.
    seedTestPlanLegacySource("testplan-ready");
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.runId, "RUN-LEGACY-BUILD")).all().length, 0);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-LEGACY-BUILD")).get()?.status, "running");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-LEGACY-BUILD")).get()?.status, "running");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-LEGACY-BUILD")).get()?.status, "running");
    assert.equal(db.select().from(buildRunRecords).where(eq(buildRunRecords.id, "BLD-LEGACY-BUILD")).get()?.status, "running");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "IMPLEMENTING");
    assert.equal(db.select().from(events).where(eq(events.type, "legacy_lifecycle_missing")).all().length, 0);
    assert.equal(computeActions(CHANGE_ID, { selfHeal: true }).find((action) => action.actionId === "retry_build")?.enabled, false);

    const withinGrace = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: new Date("2026-07-10T00:01:59.999Z"),
    });
    assert.equal(withinGrace.recovered.length, 0);

    const expired = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: new Date("2026-07-10T00:02:00.000Z"),
    });
    assert.equal(expired.recovered[0]?.reasonCode, "legacy_lifecycle_missing");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-LEGACY-BUILD")).get()?.status, "failed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-LEGACY-BUILD")).get()?.status, "failed");
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.runId, "RUN-LEGACY-BUILD")).get()?.status, "orphaned");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-LEGACY-BUILD")).get()?.status, "failed");
    assert.equal(db.select().from(buildRunRecords).where(eq(buildRunRecords.id, "BLD-LEGACY-BUILD")).get()?.status, "failed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "PLAN_APPROVED");
    assert.equal(
      db.select().from(events).where(and(
        eq(events.changeId, CHANGE_ID),
        eq(events.type, "legacy_lifecycle_missing"),
      )).all().length,
      1,
    );
    assert.equal(
      computeActions(CHANGE_ID, { selfHeal: true })
        .some((action) => action.actionId === "retry_build" && action.enabled),
      true,
    );
    await assertTask11RouteActionUiClosure("legacy_lifecycle_missing", "retry_build", "build", "failed");
  });

  it("row 3 independently reconciles a legacy fix_findings run and Build adjunct", async () => {
    seedChange("FIXING");
    db.insert(pipelineJobs).values({
      id: "JOB-LEGACY-FIX", changeId: CHANGE_ID, phase: "fix_findings", actionId: "retry_fix",
      idempotencyKey: "legacy-fix", status: "running", leasedBy: "worker-fix",
      leaseExpiresAt: "2026-07-10T00:10:00.000Z", heartbeatAt: "2026-07-10T00:01:00.000Z",
      attemptNo: 1, errorCode: null, errorSummary: null, createdAt: "2026-07-10T00:01:00.000Z",
      startedAt: "2026-07-10T00:01:00.000Z", endedAt: null, leaseToken: "lease-fix",
      workerNonce: "worker-fix-nonce",
    }).run();
    db.insert(runs).values({
      id: "RUN-LEGACY-FIX", changeId: CHANGE_ID, phase: "fix_findings", status: "running",
      startedAt: "2026-07-10T00:01:00.000Z", endedAt: null, summary: null,
      jobId: "JOB-LEGACY-FIX", workerId: "worker-fix", leaseToken: "lease-fix", attemptNo: 1,
    }).run();
    db.insert(stageRuns).values({
      id: "STG-LEGACY-FIX", changeId: CHANGE_ID, phase: "Build", attemptNo: 1,
      status: "running", idempotencyKey: "legacy-fix", inputDbHash: null, outputDbHash: null,
      sourceLineageJson: null, errorCode: null, startedAt: "2026-07-10T00:01:00.000Z", completedAt: null,
    }).run();
    db.insert(buildRunRecords).values({
      id: "BLD-LEGACY-FIX", changeId: CHANGE_ID, runId: "RUN-LEGACY-FIX",
      buildRunId: "build-fix", status: "running", headSha: null, baseHeadSha: null,
      baseCommit: null, patchHash: null, changedFilesHash: null, adoptedHeadSha: null,
      adoptionDecisionId: null, adoptedAt: null, artifactHash: null, source: "pipeline",
      createdAt: "2026-07-10T00:01:00.000Z", updatedAt: "2026-07-10T00:01:00.000Z",
    }).run();
    db.insert(findings).values({
      id: "FND-LEGACY-FIX", changeId: CHANGE_ID, runId: null, roundId: null,
      phase: "Review", source: "review", severity: "P1", category: "correctness",
      title: "Blocking review finding", evidence: "review evidence", requiredFix: "apply required fix",
      status: "open", createdAt: "2026-07-10T00:00:30.000Z", updatedAt: null,
      reviewAttemptId: null, sourceBuildRunId: null, sourceHeadSha: null, waivable: 0,
      waivedBy: null, waivedAt: null, waiverDecisionId: null, legacyState: null,
      legacyFindingKey: null, findingVersion: 1,
    }).run();
    // fix_blockers' enqueue authority (reviewControlDecision) requires the latest
    // valid review report source; a CHECK_FAILED change with open blockers always
    // has one in production. The active fix job keeps fix_blockers disabled until
    // recovery fails the legacy run back to CHECK_FAILED.
    seedFixBlockersReviewSource();
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.runId, "RUN-LEGACY-FIX")).all().length, 0);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-LEGACY-FIX")).get()?.status, "running");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-LEGACY-FIX")).get()?.status, "running");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-LEGACY-FIX")).get()?.status, "running");
    assert.equal(db.select().from(buildRunRecords).where(eq(buildRunRecords.id, "BLD-LEGACY-FIX")).get()?.status, "running");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "FIXING");
    assert.equal(db.select().from(events).where(eq(events.type, "legacy_lifecycle_missing")).all().length, 0);
    assert.equal(computeActions(CHANGE_ID, { selfHeal: true }).find((action) => action.actionId === "fix_blockers")?.enabled, false);

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
    });

    assert.equal(result.recovered[0]?.reasonCode, "legacy_lifecycle_missing");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-LEGACY-FIX")).get()?.status, "failed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-LEGACY-FIX")).get()?.status, "failed");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-LEGACY-FIX")).get()?.status, "failed");
    assert.equal(db.select().from(buildRunRecords).where(eq(buildRunRecords.id, "BLD-LEGACY-FIX")).get()?.status, "failed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "CHECK_FAILED");
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.runId, "RUN-LEGACY-FIX")).get()?.status, "orphaned");
    assert.equal(db.select().from(events).where(eq(events.type, "legacy_lifecycle_missing")).all().length, 1);
    const fixAction = computeActions(CHANGE_ID, { selfHeal: true }).find((action) => action.actionId === "fix_blockers");
    assert.equal(fixAction?.enabled, true);
    assert.equal(fixAction?.reasonCode, null);
  });

  it("uses CAS so concurrent recovery emits one terminal event and reports already_reconciled", async () => {
    seedReconciliationFixture({ heartbeatAt: "2026-07-10T00:01:14.000Z" });
    let validations = 0;
    let releaseValidation!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const probe: ProcessIdentityProbe = {
      capture: async () => expectedIdentity(),
      validate: async () => {
        validations += 1;
        if (validations === 2) releaseValidation();
        await bothEntered;
        return { ok: true, observed: expectedIdentity() };
      },
    };

    const [left, right] = await Promise.all([
      recoverStaleProviderRuns({
        changeId: CHANGE_ID,
        execute: true,
        observedAt: RECOVERY_OBSERVED_AT,
        processIdentityProbe: probe,
      }),
      recoverStaleProviderRuns({
        changeId: CHANGE_ID,
        execute: true,
        observedAt: RECOVERY_OBSERVED_AT,
        processIdentityProbe: probe,
      }),
    ]);

    assert.equal(left.recovered.length + right.recovered.length, 1);
    assert.equal(
      [...left.observed, ...right.observed].filter((item) => item.reasonCode === "already_reconciled").length,
      1,
    );
    assert.equal(
      db.select().from(events).where(and(
        eq(events.changeId, CHANGE_ID),
        eq(events.type, "provider_heartbeat_stale"),
      )).all().length,
      1,
    );
  });

  it("does not overwrite a newer job attempt or roll back its change status", async () => {
    seedReconciliationFixture({
      runAttemptNo: 1,
      providerAttemptNo: 1,
      jobAttemptNo: 2,
      runLeaseToken: "lease-old",
      providerLeaseToken: "lease-old",
      jobLeaseToken: "lease-new",
    });
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.attemptNo, 2);
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
    assert.equal(db.select().from(events).where(eq(events.type, "stale_lease_fenced")).all().length, 0);
    const newAttemptActionBefore = computeActions(CHANGE_ID, { selfHeal: true })
      .find((action) => action.actionId === "retry_tech_spec")?.enabled;

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: identityProbeReturning({ ok: true, observed: expectedIdentity() }),
    });

    assert.equal(result.recovered[0]?.reasonCode, "stale_lease_fenced");
    const job = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get();
    assert.equal(job?.status, "running");
    assert.equal(job?.attemptNo, 2);
    assert.equal(job?.leaseToken, "lease-new");
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "stopped");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(events).where(eq(events.type, "stale_lease_fenced")).all().length, 1);
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
    assert.equal(
      computeActions(CHANGE_ID, { selfHeal: true }).find((action) => action.actionId === "retry_tech_spec")?.enabled,
      newAttemptActionBefore,
    );
  });

  it("applies lease fencing before no-start grace when the provider row is missing", async () => {
    seedChange("TECHSPECCING");
    db.insert(pipelineJobs).values({
      id: "JOB-MISSING-PROVIDER-NEW-ATTEMPT",
      changeId: CHANGE_ID,
      phase: "tech_spec",
      actionId: "run_tech_spec",
      idempotencyKey: "new-attempt",
      status: "running",
      leasedBy: "worker-new",
      leaseExpiresAt: "2026-07-10T00:10:00.000Z",
      heartbeatAt: "2026-07-10T00:01:59.000Z",
      attemptNo: 2,
      errorCode: null,
      errorSummary: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      startedAt: "2026-07-10T00:00:00.000Z",
      endedAt: null,
      leaseToken: "lease-new",
      workerNonce: "nonce-new",
    }).run();
    db.insert(runs).values({
      id: "RUN-MISSING-PROVIDER-OLD-ATTEMPT",
      changeId: CHANGE_ID,
      phase: "tech_spec",
      status: "running",
      startedAt: "2026-07-10T00:01:59.500Z",
      endedAt: null,
      summary: null,
      jobId: "JOB-MISSING-PROVIDER-NEW-ATTEMPT",
      workerId: "worker-old",
      leaseToken: "lease-old",
      attemptNo: 1,
    }).run();

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
    });

    assert.equal(result.recovered[0]?.reasonCode, "stale_lease_fenced");
    const job = db.select().from(pipelineJobs)
      .where(eq(pipelineJobs.id, "JOB-MISSING-PROVIDER-NEW-ATTEMPT")).get();
    assert.equal(job?.status, "running");
    assert.equal(job?.attemptNo, 2);
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
  });

  it("isolates each run transaction so one write failure does not block the next run", async () => {
    seedChange("TECHSPECCING");
    for (const runId of ["RUN-FAILS", "RUN-RECOVERS"]) {
      db.insert(runs).values({
        id: runId,
        changeId: CHANGE_ID,
        phase: "tech_spec",
        status: "running",
        startedAt: "2026-07-10T00:00:00.000Z",
        endedAt: null,
        summary: null,
      }).run();
    }
    db.run(sql.raw(`
      CREATE TRIGGER task11_fail_first_run
      BEFORE UPDATE ON runs
      WHEN OLD.id = 'RUN-FAILS'
      BEGIN
        SELECT RAISE(ABORT, 'task11 injected run failure');
      END
    `));
    try {
      const result = await recoverStaleProviderRuns({
        changeId: CHANGE_ID,
        execute: true,
        observedAt: RECOVERY_OBSERVED_AT,
      });

      assert.deepEqual(result.failed.map((item) => item.runId), ["RUN-FAILS"]);
      assert.deepEqual(result.recovered.map((item) => item.runId), ["RUN-RECOVERS"]);
      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-FAILS")).get()?.status, "running");
      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-RECOVERS")).get()?.status, "failed");
      assert.equal(
        db.select().from(events).where(and(
          eq(events.runId, "RUN-FAILS"),
          eq(events.type, "stale_provider_run_recovery_failed"),
        )).all().length,
        1,
      );
    } finally {
      db.run(sql.raw("DROP TRIGGER IF EXISTS task11_fail_first_run"));
    }
  });

  for (const target of ["pipeline_jobs", "stage_runs"] as const) {
    it(`rolls back the whole run when required ${target} CAS changes is zero`, async () => {
      seedReconciliationFixture({ heartbeatAt: "2026-07-10T00:01:14.000Z" });
      const trigger = `task11_ignore_${target}`;
      const rowId = target === "pipeline_jobs" ? "JOB-MATRIX" : "STG-MATRIX";
      db.run(sql.raw(`
        CREATE TRIGGER ${trigger}
        BEFORE UPDATE ON ${target}
        WHEN OLD.id = '${rowId}'
        BEGIN
          SELECT RAISE(IGNORE);
        END
      `));
      try {
        const result = await recoverStaleProviderRuns({
          changeId: CHANGE_ID,
          execute: true,
          observedAt: RECOVERY_OBSERVED_AT,
          processIdentityProbe: identityProbeReturning({ ok: true, observed: expectedIdentity() }),
          terminateProcess: async () => {},
        });

        assert.equal(result.recovered.length, 0);
        assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
        assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
        assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "running");
        assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
        assert.equal(db.select().from(events).where(eq(events.type, "provider_heartbeat_stale")).all().length, 0);
      } finally {
        db.run(sql.raw(`DROP TRIGGER IF EXISTS ${trigger}`));
      }
    });
  }

  for (const target of ["pipeline_jobs", "stage_runs"] as const) {
    it(`rolls back missing-provider recovery when required ${target} CAS changes is zero`, async () => {
      seedMissingProviderCasFixture();
      const trigger = `task11_ignore_missing_${target}`;
      const rowId = target === "pipeline_jobs" ? "JOB-MISSING-CAS" : "STG-MISSING-CAS";
      db.run(sql.raw(`
        CREATE TRIGGER ${trigger}
        BEFORE UPDATE ON ${target}
        WHEN OLD.id = '${rowId}'
        BEGIN
          SELECT RAISE(IGNORE);
        END
      `));
      try {
        const result = await recoverStaleProviderRuns({
          changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
        });
        assert.equal(result.recovered.length, 0);
        assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
        assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MISSING-CAS")).get()?.status, "running");
        assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MISSING-CAS")).get()?.status, "running");
        assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MISSING-CAS")).get()?.status, "running");
        assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.runId, "RUN-MISSING-CAS")).all().length, 0);
        assert.equal(db.select().from(events).where(eq(events.type, "provider_start_missing")).all().length, 0);
        assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
      } finally {
        db.run(sql.raw(`DROP TRIGGER IF EXISTS ${trigger}`));
      }
    });
  }

  it("re-reads the job fence in the transaction when a newer attempt takes over during probing", async () => {
    seedReconciliationFixture({ heartbeatAt: "2026-07-10T00:01:14.000Z" });
    const probe: ProcessIdentityProbe = {
      capture: async () => expectedIdentity(),
      validate: async () => {
        db.update(pipelineJobs).set({
          attemptNo: 2,
          leaseToken: "lease-new-during-probe",
          leasedBy: "worker-new",
          leaseExpiresAt: "2026-07-10T00:10:00.000Z",
        }).where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
        return { ok: true, observed: expectedIdentity() };
      },
    };

    await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: probe,
      terminateProcess: async () => {},
    });

    const job = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get();
    assert.equal(job?.attemptNo, 2);
    assert.equal(job?.status, "running");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
  });

  it("does not recover a provider when heartbeat and lease refresh with the same fence during validate", async () => {
    seedReconciliationFixture({ heartbeatAt: "2026-07-10T00:01:00.000Z" });
    const signaled: ProcessIdentity[] = [];
    const probe: ProcessIdentityProbe = {
      capture: async () => expectedIdentity(),
      validate: async () => {
        db.update(providerRunProcesses).set({ lastHeartbeatAt: "2026-07-10T00:02:00.000Z" })
          .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
        db.update(pipelineJobs).set({
          heartbeatAt: "2026-07-10T00:02:00.000Z",
          leaseExpiresAt: "2026-07-10T00:12:00.000Z",
        }).where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
        return { ok: true, observed: expectedIdentity() };
      },
    };

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: probe, terminateProcess: async (identity) => { signaled.push(identity); },
    });

    assert.equal(result.recovered.length, 0);
    assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.endedAt, null);
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.endedAt, null);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.endedAt, null);
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
    assert.equal(db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(signaled.length, 0);
  });

  it("does not recover a pid-less Codex run when its heartbeat and lease refresh before the write transaction", async () => {
    seedReconciliationFixture({
      provider: "codex", pid: null, externalRef: "thread-live",
      heartbeatAt: "2026-07-10T00:01:00.000Z",
    });
    const originalTransaction = db.transaction.bind(db);
    let refreshed = false;
    (db as unknown as { transaction: typeof db.transaction }).transaction = ((callback: (tx: typeof db) => unknown, config?: unknown) =>
      originalTransaction((tx) => {
        if (!refreshed) {
          refreshed = true;
          tx.update(providerRunProcesses).set({ lastHeartbeatAt: "2026-07-10T00:02:00.000Z" })
            .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
          tx.update(pipelineJobs).set({
            heartbeatAt: "2026-07-10T00:02:00.000Z",
            leaseExpiresAt: "2026-07-10T00:12:00.000Z",
          }).where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
        }
        return callback(tx as unknown as typeof db);
      }, config as never)) as typeof db.transaction;
    try {
      const result = await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
        terminateProcess: async () => assert.fail("fresh pid-less Codex run must not be signaled"),
      });
      assert.equal(result.recovered.length, 0);
      assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
    } finally {
      (db as unknown as { transaction: typeof db.transaction }).transaction = originalTransaction as typeof db.transaction;
    }
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.endedAt, null);
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.endedAt, null);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.endedAt, null);
    assert.equal(db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all().length, 0);
  });

  it("derives a synthetic provider from the Codex change instead of hard-coding Claude", async () => {
    seedChange("TECHSPECCING");
    db.update(changes).set({ provider: "codex" }).where(eq(changes.id, CHANGE_ID)).run();
    db.insert(runs).values({
      id: "RUN-CODEX-NO-START",
      changeId: CHANGE_ID,
      phase: "tech_spec",
      status: "running",
      startedAt: "2026-07-10T00:00:00.000Z",
      endedAt: null,
      summary: null,
    }).run();

    await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
    });

    assert.equal(
      db.select().from(providerRunProcesses)
        .where(eq(providerRunProcesses.runId, "RUN-CODEX-NO-START")).get()?.provider,
      "codex",
    );
  });

  for (const phase of ["tech_spec", "spec", "review", "implement"] as const) {
    it(`fails completed ${phase} when post-provider business evidence is incomplete`, async () => {
      await seedCompletedProviderFixture(phase, false);
      // The failed run recovers into a "ready" state whose retry action the
      // enqueue-authority overlay only serves when the SOURCE phase authority is
      // on record. seedCompletedProviderFixture(*, false) intentionally omits the
      // CURRENT run's evidence, but the prior phase's source is always present in
      // production, so seed it here to model the authority-consistent state.
      if (phase === "tech_spec") seedSpecSourceAuthority();
      else if (phase === "spec") seedPrdSourceAuthority();
      else if (phase === "implement") seedTestPlanLegacySource("testplan-source-hash");
      else if (phase === "review") seedAdoptedBuildDiskSource({
        runNumber: 1, adoptedHeadSha: "review-head", patchHash: "review-patch",
        changedFilesHash: "review-files", baseSha: "review-base",
        adoptionDecisionId: "build-review-adoption", adoptedAt: "2026-07-10T00:01:00.000Z",
      });
      const artifactCountBefore = db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all().length;
      if (phase === "spec") {
        assert.equal(
          db.select().from(battleRounds).where(eq(battleRounds.id, "ROUND-COMPLETED-PROVIDER")).get()?.reportPath,
          null,
        );
      }

      await recoverStaleProviderRuns({ changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT });

      assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "completed");
      assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
      assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "failed");
      const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
      assert.ok(event);
      const raw = JSON.parse(event.rawJson ?? "{}") as { providerTerminal?: string; businessEvidenceComplete?: boolean; missingEvidence?: string[] };
      assert.equal(raw.providerTerminal, "completed");
      assert.equal(raw.businessEvidenceComplete, false);
      assert.ok((raw.missingEvidence?.length ?? 0) > 0);
      assert.equal(db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all().length, artifactCountBefore);
      if (phase === "spec") assert.equal(db.select().from(battleRounds).where(eq(battleRounds.id, "ROUND-COMPLETED-PROVIDER")).get()?.status, "failed");
      if (phase === "review") assert.equal(db.select().from(reviewAttempts).where(eq(reviewAttempts.id, "REV-COMPLETED-PROVIDER")).get()?.status, "failed");
      if (phase === "implement") assert.equal(db.select().from(buildRunRecords).where(eq(buildRunRecords.id, "BLD-COMPLETED-PROVIDER")).get()?.status, "failed");
      const expectedChange = phase === "tech_spec" ? "SPEC_READY" : phase === "spec" ? "BLOCKED" : phase === "review" ? "IMPLEMENTED" : "PLAN_APPROVED";
      assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, expectedChange);
      const retryAction = phase === "tech_spec" ? "retry_tech_spec" : phase === "spec" ? "retry_spec" : phase === "review" ? "retry_review" : "retry_build";
      assert.equal(computeActions(CHANGE_ID, { selfHeal: true }).find((action) => action.actionId === retryAction)?.enabled, true);
    });

    it(`keeps completed ${phase} successful when all persisted business evidence is complete`, async () => {
      await seedCompletedProviderFixture(phase, true);
      const artifactCountBefore = db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all().length;

      await recoverStaleProviderRuns({ changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT });

      const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
      const raw = JSON.parse(event?.rawJson ?? "{}") as { providerTerminal?: string; businessEvidenceComplete?: boolean; missingEvidence?: string[] };
      assert.equal(
        db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status,
        "succeeded",
        JSON.stringify(raw),
      );
      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "completed");
      assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "completed");
      assert.equal(raw.providerTerminal, "completed");
      assert.equal(raw.businessEvidenceComplete, true);
      assert.deepEqual(raw.missingEvidence, []);
      assert.equal(db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all().length, artifactCountBefore);
      if (phase === "spec") assert.equal(db.select().from(battleRounds).where(eq(battleRounds.id, "ROUND-COMPLETED-PROVIDER")).get()?.status, "report_ready");
      if (phase === "review") assert.ok(db.select().from(reviewState).where(eq(reviewState.changeId, CHANGE_ID)).get()?.latestValidReviewReportId);
      if (phase === "implement") assert.equal(db.select().from(buildRunRecords).where(eq(buildRunRecords.runId, "RUN-MATRIX")).get()?.status, "adopted");
      const expectedChange = phase === "tech_spec" ? "TECHSPEC_READY" : phase === "spec" ? "SPEC_READY" : "IMPLEMENTED";
      assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, expectedChange);
    });
  }

  for (const phase of ["tech_spec", "spec", "review", "implement"] as const) {
    it(`rejects forged or hash-mismatched completed ${phase} evidence`, async () => {
      await seedCompletedProviderFixture(phase, true);
      if (phase === "tech_spec") {
        db.update(techspecSnapshots).set({ contentDbHash: "forged-techspec-hash" })
          .where(eq(techspecSnapshots.changeId, CHANGE_ID)).run();
        db.update(apiSnapshots).set({ sourceTechspecHash: "forged-techspec-hash" })
          .where(eq(apiSnapshots.changeId, CHANGE_ID)).run();
      } else if (phase === "spec") {
        db.update(battleRounds).set({ redArtifactHash: "forged-red-hash" })
          .where(eq(battleRounds.id, "ROUND-COMPLETED-PROVIDER")).run();
      } else if (phase === "review") {
        db.update(reviewReports).set({ reportJson: JSON.stringify({ forged: true }) })
          .where(eq(reviewReports.changeId, CHANGE_ID)).run();
      } else {
        db.update(buildRunRecords).set({ changedFilesHash: "forged-changed-files-hash" })
          .where(eq(buildRunRecords.runId, "RUN-MATRIX")).run();
      }

      await recoverStaleProviderRuns({ changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT });

      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
      const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
      const raw = JSON.parse(event?.rawJson ?? "{}") as { businessEvidenceComplete?: boolean; missingEvidence?: string[] };
      assert.equal(raw.businessEvidenceComplete, false);
      assert.ok((raw.missingEvidence?.length ?? 0) > 0);
    });
  }

  it("does not accept an older run's TechSpec artifacts as current-run evidence", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    db.update(artifacts).set({ runId: null }).where(eq(artifacts.runId, "RUN-MATRIX")).run();

    await recoverStaleProviderRuns({ changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT });

    const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
    const raw = JSON.parse(event?.rawJson ?? "{}") as { businessEvidenceComplete?: boolean; missingEvidence?: string[] };
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(raw.businessEvidenceComplete, false);
    assert.ok(raw.missingEvidence?.includes("tech_spec_delta_run_artifact"));
    assert.ok(raw.missingEvidence?.includes("api_spec_delta_run_artifact"));
  });

  for (const content of ["", "arbitrary content"] as const) {
    it(`rejects ${content ? "arbitrary" : "empty"} current-run artifacts backed by an old snapshot with the same externalRef`, async () => {
      await seedCompletedProviderFixture("tech_spec", true);
      db.update(providerRunProcesses).set({ externalRef: "thread-reused" })
        .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
      db.update(techspecSnapshots).set({
        sourceSpecHash: "thread-reused",
        createdAt: "2026-07-09T23:59:00.000Z",
      }).where(eq(techspecSnapshots.changeId, CHANGE_ID)).run();
      db.update(apiSnapshots).set({ createdAt: "2026-07-09T23:59:00.000Z" })
        .where(eq(apiSnapshots.changeId, CHANGE_ID)).run();
      for (const artifact of db.select().from(artifacts).where(eq(artifacts.runId, "RUN-MATRIX")).all()) {
        fs.writeFileSync(artifact.path, content);
      }

      await recoverStaleProviderRuns({ changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT });

      const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
      const raw = JSON.parse(event?.rawJson ?? "{}") as { businessEvidenceComplete?: boolean; missingEvidence?: string[] };
      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
      assert.equal(raw.businessEvidenceComplete, false);
      assert.ok(raw.missingEvidence?.some((item) => item.includes("run_artifact")));
    });
  }

  it("rejects a repo-contained symlink used as a TechSpec run artifact", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    const artifact = db.select().from(artifacts).where(and(
      eq(artifacts.runId, "RUN-MATRIX"), eq(artifacts.type, "tech_spec_delta"),
    )).get();
    assert.ok(artifact);
    const original = fs.readFileSync(artifact.path);
    const target = `${artifact.path}.target`;
    fs.writeFileSync(target, original);
    fs.rmSync(artifact.path);
    fs.symlinkSync(target, artifact.path);

    await recoverStaleProviderRuns({ changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT });

    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
    const raw = JSON.parse(event?.rawJson ?? "{}") as { missingEvidence?: string[] };
    assert.ok(raw.missingEvidence?.includes("tech_spec_delta_run_artifact"));
  });

  it("performs filesystem evidence probing outside the SQLite write transaction", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    const originalRealpath = fs.realpathSync;
    let probedInsideTransaction = false;
    fs.realpathSync = ((target: fs.PathLike) => {
      probedInsideTransaction ||= Boolean((db as unknown as { $client?: { inTransaction?: boolean } }).$client?.inTransaction);
      return originalRealpath(target);
    }) as typeof fs.realpathSync;
    try {
      await recoverStaleProviderRuns({ changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT });
    } finally {
      fs.realpathSync = originalRealpath;
    }

    assert.equal(probedInsideTransaction, false);
  });

  it("reports Build filesystem and Git evidence probes outside the SQLite write transaction", async () => {
    await seedCompletedProviderFixture("implement", true);
    const observedKinds: string[] = [];
    const options = {
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      onEvidenceProbe: (kind: string) => {
        assert.equal(
          Boolean((db as unknown as { $client?: { inTransaction?: boolean } }).$client?.inTransaction),
          false,
          `${kind} evidence probe must run before the write transaction`,
        );
        observedKinds.push(kind);
      },
    };

    await recoverStaleProviderRuns(options);

    assert.ok(observedKinds.includes("fs"));
    assert.ok(observedKinds.includes("git"));
  });

  it("uses fixed transaction witness query bounds independent of accumulated history", async () => {
    const queryBounds = {
      tech_spec: 9,
      spec: 8,
      review: 7,
      implement: 3,
    } as const;

    for (const phase of Object.keys(queryBounds) as Array<keyof typeof queryBounds>) {
      cleanupRows();
      await seedCompletedProviderFixture(phase, true);
      for (let index = 0; index < 250; index += 1) {
        db.insert(artifacts).values({
          id: `ART-HISTORY-${phase}-${index}`,
          changeId: CHANGE_ID,
          runId: null,
          type: "historical_evidence",
          path: `/historical/${phase}/${index}`,
          createdAt: `2026-07-09T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
        }).run();
        db.insert(buildRunRecords).values({
          id: `BLD-HISTORY-${phase}-${index}`,
          changeId: CHANGE_ID,
          runId: null,
          buildRunId: `historical-${phase}-${index}`,
          status: "failed",
          source: "pipeline",
          createdAt: "2026-07-09T00:00:00.000Z",
          updatedAt: "2026-07-09T00:00:00.000Z",
        }).run();
      }

      let transactionQueries = 0;
      await recoverStaleProviderRuns({
        changeId: CHANGE_ID,
        execute: true,
        observedAt: RECOVERY_OBSERVED_AT,
        onEvidenceDbQuery: (_phase, scope) => {
          if (scope === "transaction") transactionQueries += 1;
        },
      });

      assert.ok(transactionQueries > 0, `${phase} must revalidate its DB witness`);
      assert.equal(transactionQueries, queryBounds[phase]);
    }

    // captureEvidenceDbSnapshot now lives in recovery-business-evidence.ts.
    const evidenceSource = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "recovery-business-evidence.ts"),
      "utf8",
    );
    const witnessSource = evidenceSource.slice(
      evidenceSource.indexOf("function captureEvidenceDbSnapshot"),
    );
    assert.match(witnessSource, /limit\(maxReviewFindings \+ 1\)\.all\(\)/);
  });

  it("rejects an evidence observation when its authoritative snapshot changes before the write transaction", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    const originalTransaction = db.transaction.bind(db);
    let replaced = false;
    (db as unknown as { transaction: typeof db.transaction }).transaction = ((callback: (tx: typeof db) => unknown, config?: unknown) =>
      originalTransaction((tx) => {
        if (!replaced) {
          replaced = true;
          tx.update(techspecSnapshots).set({ contentDbHash: "replacement-hash" })
            .where(eq(techspecSnapshots.changeId, CHANGE_ID)).run();
        }
        return callback(tx as unknown as typeof db);
      }, config as never)) as typeof db.transaction;
    try {
      const result = await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      });
      assert.equal(result.recovered.length, 0);
      assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
    } finally {
      (db as unknown as { transaction: typeof db.transaction }).transaction = originalTransaction as typeof db.transaction;
    }

    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(events).where(eq(events.type, "business_run_reconciled")).all().length, 0);
  });

  for (const witnessCase of [
    {
      name: "TechSpec contentJson",
      phase: "tech_spec" as const,
      mutate: (tx: typeof db) => tx.update(techspecSnapshots).set({ contentJson: "{}" })
        .where(eq(techspecSnapshots.changeId, CHANGE_ID)).run(),
    },
    {
      name: "API contractJson",
      phase: "tech_spec" as const,
      mutate: (tx: typeof db) => tx.update(apiSnapshots).set({ contractJson: "{}" })
        .where(eq(apiSnapshots.changeId, CHANGE_ID)).run(),
    },
    {
      name: "Review reportJson",
      phase: "review" as const,
      mutate: (tx: typeof db) => tx.update(reviewReports).set({ reportJson: "{}" })
        .where(eq(reviewReports.changeId, CHANGE_ID)).run(),
    },
    {
      name: "Review settlement finding",
      phase: "review" as const,
      mutate: (tx: typeof db) => tx.update(findings).set({ title: "changed before recovery commit" })
        .where(and(eq(findings.changeId, CHANGE_ID), eq(findings.source, "review"))).run(),
    },
  ]) {
    it(`rejects ${witnessCase.name} changed before the recovery transaction writes`, async () => {
      await seedCompletedProviderFixture(witnessCase.phase, true);
      if (witnessCase.name === "Review settlement finding") {
        db.insert(findings).values({
          id: "FND-WITNESS-SETTLEMENT", changeId: CHANGE_ID, runId: "RUN-MATRIX", roundId: null,
          phase: "Review", source: "review", severity: "P2", category: "correctness",
          title: "canonical finding", evidence: "bounded evidence", requiredFix: "none",
          status: "resolved", createdAt: "2026-07-10T00:00:20.000Z", updatedAt: null,
          reviewAttemptId: "REV-COMPLETED-PROVIDER", sourceBuildRunId: "build-1",
          sourceHeadSha: "review-head", waivable: 0, waivedBy: null, waivedAt: null,
          waiverDecisionId: null, legacyState: null, legacyFindingKey: null, findingVersion: 1,
        }).run();
        const restoreReviewDb = setReviewReportServiceDbForTest(db);
        recomputeReviewReport(CHANGE_ID, "REV-COMPLETED-PROVIDER");
        restoreReviewDb();
      }
      const originalTransaction = db.transaction.bind(db);
      let mutated = false;
      (db as unknown as { transaction: typeof db.transaction }).transaction = ((callback: (tx: typeof db) => unknown, config?: unknown) =>
        originalTransaction((tx) => {
          if (!mutated) {
            mutated = true;
            witnessCase.mutate(tx as unknown as typeof db);
          }
          return callback(tx as unknown as typeof db);
        }, config as never)) as typeof db.transaction;
      try {
        const result = await recoverStaleProviderRuns({
          changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
        });
        assert.equal(result.recovered.length, 0);
        assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
      } finally {
        (db as unknown as { transaction: typeof db.transaction }).transaction = originalTransaction as typeof db.transaction;
      }
      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
      assert.equal(db.select().from(events).where(eq(events.type, "business_run_reconciled")).all().length, 0);
    });
  }

  it("rejects completed evidence when an observed artifact is deleted before the write transaction", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    const artifact = db.select().from(artifacts).where(and(
      eq(artifacts.runId, "RUN-MATRIX"), eq(artifacts.type, "tech_spec_delta"),
    )).get();
    assert.ok(artifact);
    const originalTransaction = db.transaction.bind(db);
    const signaled: ProcessIdentity[] = [];
    let deleted = false;
    (db as unknown as { transaction: typeof db.transaction }).transaction = ((callback: (tx: typeof db) => unknown, config?: unknown) => {
      if (!deleted) {
        deleted = true;
        fs.rmSync(artifact.path);
      }
      return originalTransaction(callback, config as never);
    }) as typeof db.transaction;
    try {
      const result = await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
        terminateProcess: async (identity) => { signaled.push(identity); },
      });
      assert.equal(result.recovered.length, 1);
      assert.equal(result.observed[0]?.reasonCode, "business_run_reconciled");
    } finally {
      (db as unknown as { transaction: typeof db.transaction }).transaction = originalTransaction as typeof db.transaction;
    }

    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
    const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
    assert.ok(event);
    const raw = JSON.parse(event.rawJson ?? "{}") as { businessEvidenceComplete?: boolean; missingEvidence?: string[] };
    assert.equal(raw.businessEvidenceComplete, false);
    assert.ok(raw.missingEvidence?.includes("business_evidence_changed_after_commit"));
    assert.equal(signaled.length, 0);
    assert.equal(db.select().from(events).where(eq(events.type, "business_run_reconciled")).all().length, 1);
  });

  it("compensates post-commit file drift without overwriting a newer job attempt", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    const artifact = db.select().from(artifacts).where(and(
      eq(artifacts.runId, "RUN-MATRIX"), eq(artifacts.type, "tech_spec_delta"),
    )).get();
    assert.ok(artifact);
    const originalTransaction = db.transaction.bind(db);
    let drifted = false;
    (db as unknown as { transaction: typeof db.transaction }).transaction = ((callback: (tx: typeof db) => unknown, config?: unknown) => {
      const result = originalTransaction(callback, config as never);
      if (!drifted) {
        drifted = true;
        fs.rmSync(artifact.path);
        db.update(pipelineJobs).set({
          status: "running",
          attemptNo: 2,
          leaseToken: "lease-new-after-commit",
          leasedBy: "worker-new",
          heartbeatAt: "2026-07-10T00:02:00.000Z",
          leaseExpiresAt: "2026-07-10T00:12:00.000Z",
          endedAt: null,
          errorCode: null,
          errorSummary: null,
        }).where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
      }
      return result;
    }) as typeof db.transaction;
    try {
      await recoverStaleProviderRuns({
        changeId: CHANGE_ID,
        execute: true,
        observedAt: RECOVERY_OBSERVED_AT,
      });
    } finally {
      (db as unknown as { transaction: typeof db.transaction }).transaction = originalTransaction as typeof db.transaction;
    }

    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    const job = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get();
    assert.equal(job?.status, "running");
    assert.equal(job?.attemptNo, 2);
    assert.equal(job?.leaseToken, "lease-new-after-commit");
    const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
    const raw = JSON.parse(event?.rawJson ?? "{}") as { businessEvidenceComplete?: boolean };
    assert.equal(raw.businessEvidenceComplete, false);
  });

  it("compensates post-commit drift when same-fence terminal metadata changes", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    const artifact = db.select().from(artifacts).where(and(
      eq(artifacts.runId, "RUN-MATRIX"), eq(artifacts.type, "tech_spec_delta"),
    )).get();
    assert.ok(artifact);
    const originalTransaction = db.transaction.bind(db);
    let drifted = false;
    (db as unknown as { transaction: typeof db.transaction }).transaction = ((callback: (tx: typeof db) => unknown, config?: unknown) => {
      const result = originalTransaction(callback, config as never);
      if (!drifted) {
        drifted = true;
        fs.rmSync(artifact.path);
        db.update(pipelineJobs).set({ endedAt: "2026-07-10T00:02:00.001Z" })
          .where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
      }
      return result;
    }) as typeof db.transaction;
    try {
      await recoverStaleProviderRuns({
        changeId: CHANGE_ID,
        execute: true,
        observedAt: RECOVERY_OBSERVED_AT,
      });
    } finally {
      (db as unknown as { transaction: typeof db.transaction }).transaction = originalTransaction as typeof db.transaction;
    }

    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
    const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
    const raw = JSON.parse(event?.rawJson ?? "{}") as { businessEvidenceComplete?: boolean };
    assert.equal(raw.businessEvidenceComplete, false);
  });

  it("compensates a post-commit Spec artifact drift across round, action, and GET", async () => {
    await seedCompletedProviderFixture("spec", true);
    // retry_spec (snapshotPhase PRD) needs the locked-PRD source the enqueue
    // authority traces once the drifted Spec run is failed back to BLOCKED.
    seedPrdSourceAuthority();
    // Seeding the PRD gate changes reportSourceHashes (prdStageSourceDbHash),
    // which would mark the fixture's spec report stale and flip the FIRST
    // evidence check to incomplete — sending recovery down the plain-failure
    // path that never flips a report_ready round. Regenerate the report so the
    // recorded source hashes include the PRD gate and the drift-compensation
    // path under test stays reachable.
    await generateSpecReport(CHANGE_ID);
    const roundBefore = db.select().from(battleRounds)
      .where(eq(battleRounds.id, "ROUND-COMPLETED-PROVIDER")).get();
    assert.equal(roundBefore?.status, "report_ready");
    assert.ok(roundBefore?.redArtifactPath);
    const originalTransaction = db.transaction.bind(db);
    let drifted = false;
    (db as unknown as { transaction: typeof db.transaction }).transaction = ((callback: (tx: typeof db) => unknown, config?: unknown) => {
      const result = originalTransaction(callback, config as never);
      const committedRun = db.select({ status: runs.status }).from(runs)
        .where(eq(runs.id, "RUN-MATRIX")).get();
      if (!drifted && committedRun?.status === "completed") {
        drifted = true;
        fs.rmSync(roundBefore.redArtifactPath!);
      }
      return result;
    }) as typeof db.transaction;
    let recovery: Awaited<ReturnType<typeof recoverStaleProviderRuns>> | null = null;
    try {
      recovery = await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      });
    } finally {
      (db as unknown as { transaction: typeof db.transaction }).transaction = originalTransaction as typeof db.transaction;
    }

    assert.equal(recovery?.failed.length, 0, JSON.stringify(recovery?.failed));
    assert.equal(recovery?.recovered.length, 1, JSON.stringify(recovery?.observed));
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "completed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(battleRounds).where(eq(battleRounds.id, "ROUND-COMPLETED-PROVIDER")).get()?.status, "failed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "BLOCKED");
    const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
    const raw = JSON.parse(event?.rawJson ?? "{}") as { businessEvidenceComplete?: boolean };
    assert.equal(raw.businessEvidenceComplete, false);
    assert.equal(computeActions(CHANGE_ID, { selfHeal: true }).find((action) => action.actionId === "retry_spec")?.enabled, true);

    setStartupRecoveryDependenciesForTest({
      logDir: process.cwd(), ensureLogs: () => {}, checkDb: () => {}, writeLog: () => {},
      recover: async () => ({ recovered: [], failed: [], observed: [], observedAt: RECOVERY_OBSERVED_AT.toISOString() }),
    });
    const detailRoute = await import("../../app/api/projects/[id]/changes/[changeId]/route");
    const response = await detailRoute.GET(new Request("http://localhost/detail"), {
      params: Promise.resolve({ id: PROJECT_ID, changeId: CHANGE_ID }),
    });
    const detail = await response.json();
    assert.equal(response.status, 200);
    assert.equal(detail.status, "BLOCKED");
    assert.equal(detail.latestRun.status, "failed");
  });

  it("compensates a post-commit Build artifact drift across build record, action, and GET", async () => {
    await seedCompletedProviderFixture("implement", true);
    // retry_build (snapshotPhase TestPlan) needs the TestPlan source behind the
    // already-seeded TestPlan gate once the drifted Build run fails to PLAN_APPROVED.
    seedTestPlanLegacySource("testplan-source-hash");
    const project = db.select().from(projects).where(eq(projects.id, PROJECT_ID)).get();
    assert.ok(project);
    const patchPath = path.join(
      project.repoPath, ".ship", "changes", CHANGE_ID, "build", "runs", "build-1.patch",
    );
    assert.equal(db.select().from(buildRunRecords).where(eq(buildRunRecords.runId, "RUN-MATRIX")).get()?.status, "adopted");
    const originalTransaction = db.transaction.bind(db);
    let drifted = false;
    (db as unknown as { transaction: typeof db.transaction }).transaction = ((callback: (tx: typeof db) => unknown, config?: unknown) => {
      const result = originalTransaction(callback, config as never);
      const committedRun = db.select({ status: runs.status }).from(runs)
        .where(eq(runs.id, "RUN-MATRIX")).get();
      if (!drifted && committedRun?.status === "completed") {
        drifted = true;
        fs.rmSync(patchPath);
      }
      return result;
    }) as typeof db.transaction;
    try {
      await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      });
    } finally {
      (db as unknown as { transaction: typeof db.transaction }).transaction = originalTransaction as typeof db.transaction;
    }

    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "completed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(buildRunRecords).where(eq(buildRunRecords.runId, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "PLAN_APPROVED");
    const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
    const raw = JSON.parse(event?.rawJson ?? "{}") as { businessEvidenceComplete?: boolean };
    assert.equal(raw.businessEvidenceComplete, false);
    assert.equal(computeActions(CHANGE_ID, { selfHeal: true }).find((action) => action.actionId === "retry_build")?.enabled, true);

    setStartupRecoveryDependenciesForTest({
      logDir: process.cwd(), ensureLogs: () => {}, checkDb: () => {}, writeLog: () => {},
      recover: async () => ({ recovered: [], failed: [], observed: [], observedAt: RECOVERY_OBSERVED_AT.toISOString() }),
    });
    const detailRoute = await import("../../app/api/projects/[id]/changes/[changeId]/route");
    const response = await detailRoute.GET(new Request("http://localhost/detail"), {
      params: Promise.resolve({ id: PROJECT_ID, changeId: CHANGE_ID }),
    });
    const detail = await response.json();
    assert.equal(response.status, 200);
    assert.equal(detail.status, "PLAN_APPROVED");
    assert.equal(detail.latestRun.status, "failed");
  });

  it("compensates completed Review attempt, state, and report authority after post-commit drift", async () => {
    // The review fixture itself seeds the disk-backed adopted "build-1" the
    // evidence check and the retry_review enqueue authority both trace.
    await seedCompletedProviderFixture("review", true);
    const stateBefore = db.select().from(reviewState).where(eq(reviewState.changeId, CHANGE_ID)).get();
    assert.ok(stateBefore?.latestValidReviewReportId);

    await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      evidenceDriftAfterCommitForTest: () => true,
    });

    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "completed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "failed");
    const attempt = db.select().from(reviewAttempts).where(eq(reviewAttempts.id, "REV-COMPLETED-PROVIDER")).get();
    assert.equal(attempt?.status, "failed");
    assert.equal(attempt?.reviewStatus, "failed");
    assert.equal(attempt?.errorCode, "business_evidence_changed_after_commit");
    const state = db.select().from(reviewState).where(eq(reviewState.changeId, CHANGE_ID)).get();
    assert.equal(state?.gateStatus, "blocked");
    assert.equal(state?.reviewStatus, "failed");
    assert.equal(state?.latestValidReviewReportId, null);
    assert.equal(state?.reportDbHash, null);
    const report = db.select().from(reviewReports).where(eq(reviewReports.id, stateBefore.latestValidReviewReportId)).get();
    assert.equal(report?.staleReason, "business_evidence_changed_after_commit");
    const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
    const raw = JSON.parse(event?.rawJson ?? "{}") as { businessEvidenceComplete?: boolean };
    assert.equal(raw.businessEvidenceComplete, false);
    assert.equal(computeActions(CHANGE_ID, { selfHeal: true }).find((action) => action.actionId === "retry_review")?.enabled, true);
  });

  it("rolls back drift compensation when any expected-success adjunct CAS returns zero", async () => {
    const targets = [
      { label: "job", phase: "tech_spec", table: "pipeline_jobs", where: "OLD.id = 'JOB-MATRIX' AND OLD.status = 'succeeded'" },
      { label: "stage", phase: "tech_spec", table: "stage_runs", where: "OLD.id = 'STG-MATRIX' AND OLD.status = 'completed'" },
      { label: "Spec round", phase: "spec", table: "battle_rounds", where: "OLD.id = 'ROUND-COMPLETED-PROVIDER' AND OLD.status IN ('report_ready', 'closed')" },
      { label: "Build record", phase: "implement", table: "build_run_records", where: "OLD.run_id = 'RUN-MATRIX' AND OLD.status IN ('adopted', 'approved_for_absorb', 'awaiting_human')" },
      { label: "Review attempt", phase: "review", table: "review_attempts", where: "OLD.id = 'REV-COMPLETED-PROVIDER' AND OLD.status = 'completed'" },
      { label: "Review report", phase: "review", table: "review_reports", where: "OLD.attempt_id = 'REV-COMPLETED-PROVIDER' AND OLD.stale_reason IS NULL" },
      { label: "Review state", phase: "review", table: "review_state", where: `OLD.change_id = '${CHANGE_ID}' AND OLD.gate_status != 'blocked'` },
    ] as const;

    for (const [index, target] of targets.entries()) {
      cleanupRows();
      await seedCompletedProviderFixture(target.phase, true);
      const trigger = `task11_ignore_compensation_${index}`;
      db.run(sql.raw(`
        CREATE TRIGGER ${trigger}
        BEFORE UPDATE ON ${target.table}
        WHEN ${target.where}
        BEGIN
          SELECT RAISE(IGNORE);
        END
      `));
      try {
        const result = await recoverStaleProviderRuns({
          changeId: CHANGE_ID,
          execute: true,
          observedAt: RECOVERY_OBSERVED_AT,
          evidenceDriftAfterCommitForTest: () => true,
        });

        assert.equal(result.recovered.length, 0, target.label);
        assert.equal(result.failed.length, 1, target.label);
        assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "completed", target.label);
        assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "succeeded", target.label);
        assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "completed", target.label);
        const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
        assert.equal(JSON.parse(event?.rawJson ?? "{}").businessEvidenceComplete, true, target.label);
        if (target.phase === "spec") {
          assert.notEqual(db.select().from(battleRounds)
            .where(eq(battleRounds.id, "ROUND-COMPLETED-PROVIDER")).get()?.status, "failed", target.label);
        }
        if (target.phase === "implement") {
          assert.notEqual(db.select().from(buildRunRecords)
            .where(eq(buildRunRecords.runId, "RUN-MATRIX")).get()?.status, "failed", target.label);
        }
        if (target.phase === "review") {
          assert.equal(db.select().from(reviewAttempts)
            .where(eq(reviewAttempts.id, "REV-COMPLETED-PROVIDER")).get()?.status, "completed", target.label);
          assert.notEqual(db.select().from(reviewState)
            .where(eq(reviewState.changeId, CHANGE_ID)).get()?.gateStatus, "blocked", target.label);
        }
      } finally {
        db.run(sql.raw(`DROP TRIGGER IF EXISTS ${trigger}`));
      }
    }
  });

  it("protects a succeeded new fence and its change ownership from old drift compensation", async () => {
    await seedCompletedProviderFixture("implement", true);
    const project = db.select().from(projects).where(eq(projects.id, PROJECT_ID)).get();
    assert.ok(project);
    const patchPath = path.join(
      project.repoPath, ".ship", "changes", CHANGE_ID, "build", "runs", "build-1.patch",
    );
    const originalTransaction = db.transaction.bind(db);
    let advanced = false;
    (db as unknown as { transaction: typeof db.transaction }).transaction = ((callback: (tx: typeof db) => unknown, config?: unknown) => {
      const result = originalTransaction(callback, config as never);
      const committedRun = db.select({ status: runs.status }).from(runs)
        .where(eq(runs.id, "RUN-MATRIX")).get();
      if (!advanced && committedRun?.status === "completed") {
        advanced = true;
        fs.rmSync(patchPath);
        db.update(pipelineJobs).set({
          status: "succeeded",
          attemptNo: 2,
          leaseToken: "lease-new-terminal",
          leasedBy: "worker-new",
          heartbeatAt: "2026-07-10T00:02:01.000Z",
          leaseExpiresAt: null,
          endedAt: "2026-07-10T00:02:01.000Z",
        }).where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
        db.insert(stageRuns).values({
          id: "STG-MATRIX-NEW", changeId: CHANGE_ID, phase: "Build", attemptNo: 2,
          status: "completed", idempotencyKey: "new-stage", inputDbHash: "new-input",
          outputDbHash: "new-output", sourceLineageJson: "{}", errorCode: null,
          startedAt: "2026-07-10T00:02:00.000Z", completedAt: "2026-07-10T00:02:01.000Z",
        }).run();
        db.insert(buildRunRecords).values({
          id: "BLD-MATRIX-NEW", changeId: CHANGE_ID, runId: null, buildRunId: "build-2",
          status: "adopted", source: "workspace_file", headSha: "new-head",
          baseHeadSha: "new-base", baseCommit: "new-base", patchHash: "new-patch",
          changedFilesHash: "new-files", artifactHash: "new-patch",
          adoptedHeadSha: "new-head", adoptedAt: "2026-07-10T00:02:01.000Z",
          adoptionDecisionId: "new-adoption",
          createdAt: "2026-07-10T00:02:00.000Z", updatedAt: "2026-07-10T00:02:01.000Z",
        }).run();
        // The new fence's adopted build must have a matching on-disk build-run
        // file so run_review's resolveBuildSnapshotSource resolves against it
        // (readLatestBuildRun picks the highest build-N.json).
        writeBuildRun(project.repoPath, {
          changeId: CHANGE_ID, runNumber: 2, status: "adopted", purpose: "build",
          baseHeadSha: "new-base", baseCommit: "new-base", workspacePath: project.repoPath,
          branchName: "build-2", expectedFiles: [], forbiddenFiles: [], changedFiles: [],
          deviations: [], blockers: [], patchPath: null, patchSha256: "new-patch",
          patchHash: "new-patch", changedFilesHash: "new-files", adoptedHeadSha: "new-head",
          adoptionDecisionId: "new-adoption", approvalPath: null, diffPath: null,
          auditPath: null, reportPath: null,
          createdAt: "2026-07-10T00:02:00.000Z", updatedAt: "2026-07-10T00:02:01.000Z",
        });
        db.update(changes).set({ status: "IMPLEMENTED", updatedAt: "2026-07-10T00:02:01.000Z" })
          .where(eq(changes.id, CHANGE_ID)).run();
      }
      return result;
    }) as typeof db.transaction;
    try {
      await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      });
    } finally {
      (db as unknown as { transaction: typeof db.transaction }).transaction = originalTransaction as typeof db.transaction;
    }

    const newJob = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get();
    assert.equal(newJob?.status, "succeeded");
    assert.equal(newJob?.attemptNo, 2);
    assert.equal(newJob?.leaseToken, "lease-new-terminal");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX-NEW")).get()?.status, "completed");
    assert.equal(db.select().from(buildRunRecords).where(eq(buildRunRecords.id, "BLD-MATRIX-NEW")).get()?.status, "adopted");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(buildRunRecords).where(eq(buildRunRecords.runId, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "IMPLEMENTED");
    const runReview = computeActions(CHANGE_ID, { selfHeal: true })
      .find((action) => action.actionId === "run_review");
    assert.equal(runReview?.enabled, true, JSON.stringify(runReview));
  });

  it("fails the old job while protecting a different new job for the same change", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    const artifact = db.select().from(artifacts).where(and(
      eq(artifacts.runId, "RUN-MATRIX"), eq(artifacts.type, "tech_spec_delta"),
    )).get();
    assert.ok(artifact);
    const originalTransaction = db.transaction.bind(db);
    let advanced = false;
    (db as unknown as { transaction: typeof db.transaction }).transaction = ((callback: (tx: typeof db) => unknown, config?: unknown) => {
      const result = originalTransaction(callback, config as never);
      const committedRun = db.select({ status: runs.status }).from(runs)
        .where(eq(runs.id, "RUN-MATRIX")).get();
      if (!advanced && committedRun?.status === "completed") {
        advanced = true;
        fs.rmSync(artifact.path);
        db.insert(pipelineJobs).values({
          id: "JOB-MATRIX-NEW", changeId: CHANGE_ID, phase: "generate_plan",
          actionId: "run_plan", idempotencyKey: "new-plan", status: "succeeded",
          leasedBy: "worker-new", leaseExpiresAt: null,
          heartbeatAt: "2026-07-10T00:02:01.000Z", attemptNo: 2,
          errorCode: null, errorSummary: null, createdAt: "2026-07-10T00:02:00.000Z",
          startedAt: "2026-07-10T00:02:00.000Z", endedAt: "2026-07-10T00:02:01.000Z",
          leaseToken: "lease-plan-new", workerNonce: "worker-new-nonce",
        }).run();
        db.update(changes).set({ status: "PLANNING", updatedAt: "2026-07-10T00:02:01.000Z" })
          .where(eq(changes.id, CHANGE_ID)).run();
      }
      return result;
    }) as typeof db.transaction;
    try {
      await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      });
    } finally {
      (db as unknown as { transaction: typeof db.transaction }).transaction = originalTransaction as typeof db.transaction;
    }

    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX-NEW")).get()?.status, "succeeded");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "PLANNING");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
  });

  it("ignores an earlier different job even when its attemptNo is higher during post-commit compensation", async () => {
    await recoverTechSpecWithPostCommitJobMutation(() => {
      insertOwnershipJob({
        id: "JOB-HISTORICAL-ATTEMPT-3",
        createdAt: "2026-07-10T00:00:00.000Z",
        attemptNo: 3,
        leaseToken: "lease-historical",
      });
    });

    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-HISTORICAL-ATTEMPT-3")).get()?.status, "succeeded");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "SPEC_READY");
  });

  it("protects a later different job for every active or terminal status", async () => {
    for (const status of ["queued", "running", "succeeded", "failed"] as const) {
      cleanupRows();
      await recoverTechSpecWithPostCommitJobMutation(() => {
        insertOwnershipJob({
          id: `JOB-LATER-${status}`,
          createdAt: "2026-07-10T00:00:11.000Z",
          attemptNo: 1,
          leaseToken: `lease-later-${status}`,
          status,
        });
        db.update(changes).set({ status: "PLANNING", updatedAt: "2026-07-10T00:00:11.000Z" })
          .where(eq(changes.id, CHANGE_ID)).run();
      });

      assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, `JOB-LATER-${status}`)).get()?.status, status);
      assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "PLANNING");
    }
  });

  it("fails closed when a different job has the same createdAt regardless of random id order", async () => {
    await recoverTechSpecWithPostCommitJobMutation(() => {
      insertOwnershipJob({
        id: "AAA-RANDOM-UUID-ORDER",
        createdAt: "2026-07-10T00:00:10.000Z",
        attemptNo: 1,
        leaseToken: "lease-equal-time",
      });
      db.update(changes).set({ status: "PLANNING" }).where(eq(changes.id, CHANGE_ID)).run();
    });

    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "PLANNING");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "AAA-RANDOM-UUID-ORDER")).get()?.status, "succeeded");
  });

  it("ignores an earlier high-attempt job during main reconciliation", async () => {
    seedReconciliationFixture({ providerStatus: "failed", jobAttemptNo: 1, runAttemptNo: 1 });
    insertOwnershipJob({
      id: "JOB-HISTORICAL-MAIN",
      createdAt: "2026-07-10T00:00:00.000Z",
      attemptNo: 3,
      leaseToken: "lease-historical-main",
    });

    await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
    });

    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "SPEC_READY");
  });

  it("ignores an earlier high-attempt job during missing-provider recovery", async () => {
    seedChange("TECHSPECCING");
    insertOwnershipJob({
      id: "JOB-CURRENT-MISSING-PROVIDER",
      createdAt: "2026-07-10T00:00:10.000Z",
      attemptNo: 1,
      leaseToken: "lease-current-missing",
      status: "running",
    });
    insertOwnershipJob({
      id: "JOB-HISTORICAL-MISSING-PROVIDER",
      createdAt: "2026-07-10T00:00:00.000Z",
      attemptNo: 3,
      leaseToken: "lease-historical-missing",
    });
    db.insert(runs).values({
      id: "RUN-MISSING-OWNERSHIP", changeId: CHANGE_ID, phase: "tech_spec",
      status: "running", startedAt: "2026-07-10T00:00:10.000Z", endedAt: null,
      summary: null, jobId: "JOB-CURRENT-MISSING-PROVIDER", workerId: "worker-ownership",
      leaseToken: "lease-current-missing", attemptNo: 1,
    }).run();
    db.insert(stageRuns).values({
      id: "STG-MISSING-OWNERSHIP", changeId: CHANGE_ID, phase: "TechSpec", attemptNo: 1,
      status: "running", idempotencyKey: null, inputDbHash: null, outputDbHash: null,
      sourceLineageJson: null, errorCode: null, startedAt: "2026-07-10T00:00:10.000Z",
      completedAt: null,
    }).run();

    await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
    });

    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MISSING-OWNERSHIP")).get()?.status, "failed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-CURRENT-MISSING-PROVIDER")).get()?.status, "failed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "SPEC_READY");
  });

  it("rejects a terminal provider paired to a run from another change without writes", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    seedOtherChange();
    const otherChangeBefore = db.select().from(changes).where(eq(changes.id, OTHER_CHANGE_ID)).get();
    db.update(providerRunProcesses).set({ changeId: OTHER_CHANGE_ID })
      .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
    const before = providerOwnershipState();

    try {
      const result = await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      });

      assertProviderOwnershipMismatch(result, before);
      assert.deepEqual(
        db.select().from(changes).where(eq(changes.id, OTHER_CHANGE_ID)).get(),
        otherChangeBefore,
      );
    } finally {
      db.update(providerRunProcesses).set({ changeId: CHANGE_ID })
        .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
    }
  });

  it("rejects a terminal provider with a different canonical phase without stage writes", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    db.update(providerRunProcesses).set({ phase: "review" })
      .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
    const before = providerOwnershipState();

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
    });

    assertProviderOwnershipMismatch(result, before);
  });

  it("rejects a terminal provider linked to a different job without touching either job", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    insertOwnershipJob({
      id: "JOB-PROVIDER-WRONG",
      createdAt: "2026-07-10T00:00:11.000Z",
      attemptNo: 1,
      leaseToken: "lease-provider-wrong-job",
      status: "failed",
    });
    db.update(providerRunProcesses).set({ jobId: "JOB-PROVIDER-WRONG" })
      .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
    const before = providerOwnershipState();
    const wrongJobBefore = db.select().from(pipelineJobs)
      .where(eq(pipelineJobs.id, "JOB-PROVIDER-WRONG")).get();

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
    });

    assertProviderOwnershipMismatch(result, before);
    assert.deepEqual(
      db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-PROVIDER-WRONG")).get(),
      wrongJobBefore,
    );
  });

  it("rejects a terminal provider whose redundant fence differs from its run", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    db.update(providerRunProcesses).set({ leaseToken: "lease-provider-wrong", attemptNo: 2 })
      .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
    const before = providerOwnershipState();

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
    });

    assertProviderOwnershipMismatch(result, before);
  });

  it("rejects a running ownership mismatch before probing or signaling its real identity", async () => {
    seedReconciliationFixture({
      providerStatus: "running",
      heartbeatAt: "2026-07-10T00:00:00.000Z",
    });
    db.update(providerRunProcesses).set({ phase: "review" })
      .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
    const before = providerOwnershipState();
    let probeCalls = 0;
    let signalCalls = 0;
    const probe: ProcessIdentityProbe = {
      capture: async () => {
        probeCalls += 1;
        return expectedIdentity();
      },
      validate: async () => {
        probeCalls += 1;
        return { ok: true, observed: expectedIdentity() };
      },
    };

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: probe,
      terminateProcess: async () => {
        signalCalls += 1;
      },
    });

    assertProviderOwnershipMismatch(result, before);
    assert.equal(probeCalls, 0);
    assert.equal(signalCalls, 0);
  });

  it("accepts canonical spec_critic and spec ownership aliases", async () => {
    seedReconciliationFixture({ providerStatus: "failed", phase: "spec" });
    db.update(providerRunProcesses).set({ phase: "spec_critic" })
      .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
    });

    assert.equal(result.recovered.length, 1);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "BLOCKED");
  });

  it("revalidates provider phase changed during process identity probing before transaction writes", async () => {
    seedReconciliationFixture({ providerStatus: "running", heartbeatAt: "2026-07-10T00:01:00.000Z" });
    const before = providerOwnershipProtectedState();
    let signals = 0;

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: {
        capture: async () => assert.fail("capture must not be used for pid_missing"),
        validate: async () => {
          db.update(providerRunProcesses).set({ phase: "review" })
            .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
          return { ok: false, reason: "pid_missing" };
        },
      },
      terminateProcess: async () => { signals += 1; },
    });

    assert.equal(result.recovered.length, 0);
    assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
    assert.equal(db.select().from(providerRunProcesses)
      .where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.phase, "review");
    assert.deepEqual(providerOwnershipProtectedState(), before);
    assert.equal(signals, 0);
  });

  it("revalidates provider change changed during process identity probing before transaction writes", async () => {
    seedReconciliationFixture({ providerStatus: "running", heartbeatAt: "2026-07-10T00:01:00.000Z" });
    seedOtherChange();
    const before = providerOwnershipProtectedState();
    const otherBefore = db.select().from(changes).where(eq(changes.id, OTHER_CHANGE_ID)).get();
    let signals = 0;

    try {
      const result = await recoverStaleProviderRuns({
        changeId: CHANGE_ID,
        execute: true,
        observedAt: RECOVERY_OBSERVED_AT,
        processIdentityProbe: {
          capture: async () => assert.fail("capture must not be used for pid_missing"),
          validate: async () => {
            db.update(providerRunProcesses).set({ changeId: OTHER_CHANGE_ID })
              .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
            return { ok: false, reason: "pid_missing" };
          },
        },
        terminateProcess: async () => { signals += 1; },
      });

      assert.equal(result.recovered.length, 0);
      assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
      assert.deepEqual(providerOwnershipProtectedState(), before);
      assert.deepEqual(db.select().from(changes).where(eq(changes.id, OTHER_CHANGE_ID)).get(), otherBefore);
      assert.equal(signals, 0);
    } finally {
      db.update(providerRunProcesses).set({ changeId: CHANGE_ID })
        .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
    }
  });

  it("revalidates terminal provider phase changed during evidence probing before transaction writes", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    const before = providerOwnershipProtectedState();
    let mutated = false;

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      onEvidenceProbe: () => {
        if (mutated) return;
        mutated = true;
        db.update(providerRunProcesses).set({ phase: "review" })
          .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
      },
      terminateProcess: async () => assert.fail("terminal provider must not signal"),
    });

    assert.equal(mutated, true);
    assert.equal(result.recovered.length, 0);
    assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
    assert.equal(db.select().from(providerRunProcesses)
      .where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.phase, "review");
    assert.deepEqual(providerOwnershipProtectedState(), before);
  });

  it("revalidates terminal provider change changed during evidence probing before transaction writes", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    seedOtherChange();
    const before = providerOwnershipProtectedState();
    const otherBefore = db.select().from(changes).where(eq(changes.id, OTHER_CHANGE_ID)).get();
    let mutated = false;

    try {
      const result = await recoverStaleProviderRuns({
        changeId: CHANGE_ID,
        execute: true,
        observedAt: RECOVERY_OBSERVED_AT,
        onEvidenceProbe: () => {
          if (mutated) return;
          mutated = true;
          db.update(providerRunProcesses).set({ changeId: OTHER_CHANGE_ID })
            .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
        },
        terminateProcess: async () => assert.fail("terminal provider must not signal"),
      });

      assert.equal(mutated, true);
      assert.equal(result.recovered.length, 0);
      assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
      assert.deepEqual(providerOwnershipProtectedState(), before);
      assert.deepEqual(db.select().from(changes).where(eq(changes.id, OTHER_CHANGE_ID)).get(), otherBefore);
    } finally {
      db.update(providerRunProcesses).set({ changeId: CHANGE_ID })
        .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
    }
  });

  it("revalidates provider phase and identity after commit before signaling", async () => {
    seedReconciliationFixture({ providerStatus: "running" });
    let signals = 0;

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: {
        capture: async () => expectedIdentity(),
        validate: async () => ({
          ok: false,
          reason: "ppid_dead",
          observed: { ...expectedIdentity(), ppid: 1 },
        }),
      },
      beforeTerminateOwnershipCheckForTest: () => {
        db.update(providerRunProcesses).set({ phase: "review" })
          .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
      },
      terminateProcess: async () => { signals += 1; },
    });

    assert.equal(result.recovered.length, 1);
    assert.equal(db.select().from(providerRunProcesses)
      .where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.phase, "review");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "SPEC_READY");
    assert.equal(db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all().length, 2);
    assert.equal(signals, 0);
  });

  it("revalidates provider change and identity after commit before signaling", async () => {
    seedReconciliationFixture({ providerStatus: "running" });
    seedOtherChange();
    const otherBefore = db.select().from(changes).where(eq(changes.id, OTHER_CHANGE_ID)).get();
    let signals = 0;

    try {
      const result = await recoverStaleProviderRuns({
        changeId: CHANGE_ID,
        execute: true,
        observedAt: RECOVERY_OBSERVED_AT,
        processIdentityProbe: {
          capture: async () => expectedIdentity(),
          validate: async () => ({
            ok: false,
            reason: "ppid_dead",
            observed: { ...expectedIdentity(), ppid: 1 },
          }),
        },
        beforeTerminateOwnershipCheckForTest: () => {
          db.update(providerRunProcesses).set({ changeId: OTHER_CHANGE_ID })
            .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
        },
        terminateProcess: async () => { signals += 1; },
      });

      assert.equal(result.recovered.length, 1);
      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
      assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
      assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "failed");
      assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "SPEC_READY");
      assert.deepEqual(db.select().from(changes).where(eq(changes.id, OTHER_CHANGE_ID)).get(), otherBefore);
      assert.equal(db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all().length, 2);
      assert.equal(signals, 0);
    } finally {
      db.update(providerRunProcesses).set({ changeId: CHANGE_ID })
        .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();
    }
  });

  it("revalidates the complete current job contract after commit before signaling", async () => {
    const mutations: Array<[string, () => void]> = [
      ["change", () => {
        seedOtherChange();
        db.update(pipelineJobs).set({ changeId: OTHER_CHANGE_ID })
          .where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
      }],
      ["phase", () => {
        db.update(pipelineJobs).set({ phase: "review" })
          .where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
      }],
      ["lease token", () => {
        db.update(pipelineJobs).set({ leaseToken: "lease-signal-drift" })
          .where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
      }],
      ["attempt", () => {
        db.update(pipelineJobs).set({ attemptNo: 2 })
          .where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
      }],
      ["status", () => {
        db.update(pipelineJobs).set({ status: "succeeded" })
          .where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
      }],
      ["lease expiry", () => {
        db.update(pipelineJobs).set({ leaseExpiresAt: "2026-07-10T00:30:00.000Z" })
          .where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
      }],
      ["different newer job", () => {
        insertOwnershipJob({
          id: "JOB-SIGNAL-NEW",
          createdAt: "2026-07-10T00:00:11.000Z",
          attemptNo: 1,
          leaseToken: "lease-signal-new",
          status: "queued",
        });
      }],
    ];

    for (const [label, mutate] of mutations) {
      cleanupRows();
      seedReconciliationFixture({ providerStatus: "running" });
      let signals = 0;
      const result = await recoverStaleProviderRuns({
        changeId: CHANGE_ID,
        execute: true,
        observedAt: RECOVERY_OBSERVED_AT,
        processIdentityProbe: {
          capture: async () => expectedIdentity(),
          validate: async () => ({
            ok: false,
            reason: "ppid_dead",
            observed: { ...expectedIdentity(), ppid: 1 },
          }),
        },
        beforeTerminateOwnershipCheckForTest: mutate,
        terminateProcess: async () => { signals += 1; },
      });

      assert.equal(result.recovered.length, 1, label);
      assert.equal(signals, 0, label);
      if (label === "change") {
        db.update(pipelineJobs).set({ changeId: CHANGE_ID })
          .where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
      }
    }
  });

  it("bounds candidate recovery and continues remaining running rows on the next call", async () => {
    seedChange("TECHSPECCING");
    for (let index = 0; index < 5; index += 1) {
      seedRun({ runId: `RUN-BOUNDED-${index}`, pid: null });
    }

    const first = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      maxCandidates: 2,
      timeBudgetMs: 10_000,
    });

    assert.equal(first.processedCandidates, 2);
    assert.equal(first.truncated, true);
    assert.equal(first.deferred.some((item) => item.reason === "candidate_limit"), true);
    assert.deepEqual(first.failed, [], "budget deferral is not an execution failure");
    assert.deepEqual(
      db.select({ id: runs.id }).from(runs)
        .where(and(eq(runs.status, "failed"), eq(runs.changeId, CHANGE_ID)))
        .orderBy(runs.id).all().map((row) => row.id),
      ["RUN-BOUNDED-0", "RUN-BOUNDED-1"],
    );

    const second = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      maxCandidates: 2,
      timeBudgetMs: 10_000,
    });
    assert.equal(second.processedCandidates, 2);
    assert.deepEqual(
      db.select({ id: runs.id }).from(runs)
        .where(and(eq(runs.status, "failed"), eq(runs.changeId, CHANGE_ID)))
        .orderBy(runs.id).all().map((row) => row.id),
      ["RUN-BOUNDED-0", "RUN-BOUNDED-1", "RUN-BOUNDED-2", "RUN-BOUNDED-3"],
    );
  });

  it("loads any candidate batch with at most three candidate DB queries", async () => {
    seedChange("TECHSPECCING");
    for (let index = 0; index < 8; index += 1) {
      seedRun({ runId: `RUN-QUERY-${index}`, pid: null });
    }
    const queryCounts: number[] = [];
    for (const maxCandidates of [1, 4, 8]) {
      let candidateQueries = 0;
      await recoverStaleProviderRuns({
        changeId: CHANGE_ID,
        execute: false,
        observedAt: RECOVERY_OBSERVED_AT,
        maxCandidates,
        timeBudgetMs: 10_000,
        onCandidateDbQuery: () => { candidateQueries += 1; },
      });
      queryCounts.push(candidateQueries);
    }

    assert.deepEqual(queryCounts, [2, 2, 2], "fixtures without jobs need one run and one provider query");
  });

  it("rejects invalid or over-limit recovery budgets before any observable work", async () => {
    const optionCaps = [
      ["maxCandidates", ABSOLUTE_MAX_RECOVERY_CANDIDATES],
      ["timeBudgetMs", ABSOLUTE_MAX_RECOVERY_TIME_BUDGET_MS],
      ["maxReviewFindings", ABSOLUTE_MAX_REVIEW_FINDINGS],
      ["maxArtifactBytes", ABSOLUTE_MAX_ARTIFACT_BYTES],
    ] as const;

    for (const [option, cap] of optionCaps) {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, cap + 1]) {
        let observableWork = 0;
        await assert.rejects(
          () => recoverStaleProviderRuns({
            [option]: value,
            now: () => { observableWork += 1; return RECOVERY_OBSERVED_AT; },
            monotonicNowForTest: () => { observableWork += 1; return 0; },
            onCandidateDbQuery: () => { observableWork += 1; },
            onEvidenceProbe: () => { observableWork += 1; },
          }),
          (error: unknown) => error instanceof RecoveryOptionValidationError
            && error.code === "invalid_recovery_option"
            && error.option === option,
        );
        assert.equal(observableWork, 0, `${option}=${String(value)} must fail before work`);
      }
    }
  });

  it("loads all nonempty candidate job ids in one third query", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    let candidateQueries = 0;

    await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: false, observedAt: RECOVERY_OBSERVED_AT,
      maxCandidates: 16, timeBudgetMs: 10_000,
      onCandidateDbQuery: () => { candidateQueries += 1; },
    });

    assert.equal(candidateQueries, 3);
  });

  it("prefetches only the latest provider row per run despite large lifecycle history", async () => {
    seedChange("TECHSPECCING");
    seedRun({ runId: "RUN-PROVIDER-HISTORY", pid: null });
    for (let index = 0; index < 200; index += 1) {
      db.insert(providerRunProcesses).values({
        id: `PRP-HISTORY-${String(index).padStart(3, "0")}`,
        changeId: CHANGE_ID, runId: "RUN-PROVIDER-HISTORY", phase: "tech_spec",
        provider: "claude", pid: null, ppid: process.pid, roundId: null,
        status: "stopped", startedAt: "2026-07-10T00:00:00.000Z",
        lastHeartbeatAt: "2026-07-10T00:00:00.000Z", endedAt: "2026-07-10T00:00:01.000Z",
        exitCode: null, signal: null, summary: "historical", attemptNo: 0,
      }).run();
    }
    let loadedProviderRows = -1;

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: false, observedAt: RECOVERY_OBSERVED_AT,
      maxCandidates: 1, timeBudgetMs: 10_000,
      onCandidateRowsLoadedForTest: (table, count) => {
        if (table === "providers") loadedProviderRows = count;
      },
    });

    assert.equal(loadedProviderRows, 1);
    assert.equal(result.observed[0]?.processId, "PRP-RUN-PROVIDER-HISTORY");
    assert.equal(result.deferred.some((item) => item.reason === "provider_prefetch_limit"), false);
  });

  it("continues after active rows by the stable startedAt and id cursor", async () => {
    seedChange("TECHSPECCING");
    for (let index = 0; index < 4; index += 1) {
      seedRun({
        runId: `RUN-ACTIVE-${index}`,
        pid: 430_000 + index,
        heartbeat: "2026-07-10T00:01:59.000Z",
      });
    }
    seedRun({ runId: "RUN-STALE-AFTER-ACTIVE", pid: null });
    const probe = {
      capture: async () => assert.fail("capture is not used"),
      validate: async (identity: ProcessIdentity) => ({ ok: true as const, identity }),
    };

    const first = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      maxCandidates: 4, timeBudgetMs: 10_000, processIdentityProbe: probe,
    });
    assert.equal(first.recovered.length, 0);
    assert.deepEqual(first.nextCursor, {
      startedAt: "2026-07-10T00:01:00.000Z",
      id: "RUN-ACTIVE-3",
    });

    const second = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      maxCandidates: 4, timeBudgetMs: 10_000, processIdentityProbe: probe,
      cursor: first.nextCursor ?? undefined,
    });
    assert.equal(second.recovered.some((item) => item.runId === "RUN-STALE-AFTER-ACTIVE"), true);
    assert.equal(second.nextCursor, null, "a complete wrapped round clears the cursor");
  });

  it("best-effort recovery retains a cursor per scope until the round completes", async () => {
    seedChange("TECHSPECCING");
    for (let index = 0; index < 4; index += 1) {
      seedRun({
        runId: `RUN-BEST-EFFORT-ACTIVE-${index}`,
        pid: 431_000 + index,
        heartbeat: "2026-07-10T00:01:59.000Z",
      });
    }
    seedRun({ runId: "RUN-BEST-EFFORT-STALE", pid: null });
    setBestEffortRecoveryOptionsForTest({
      maxCandidates: 4,
      timeBudgetMs: 10_000,
      observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: {
        capture: async () => assert.fail("capture is not used"),
        validate: async (identity) => ({ ok: true, identity }),
      },
    });

    const first = await recoverStaleProviderRunsBestEffort(CHANGE_ID);
    assert.equal(first.truncated, true);
    const second = await recoverStaleProviderRunsBestEffort(CHANGE_ID);
    assert.equal(second.recovered.some((item) => item.runId === "RUN-BEST-EFFORT-STALE"), true);
    assert.equal(second.nextCursor, null);
  });

  it("does not let active null-time runs starve a later stale run across cursor rounds", async () => {
    seedChange("TECHSPECCING");
    for (let index = 0; index < 4; index += 1) {
      seedRun({
        runId: `RUN-NULL-ACTIVE-${index}`,
        runStartedAt: null,
        pid: 432_000 + index,
        heartbeat: "2026-07-10T00:01:59.000Z",
      });
    }
    seedRun({ runId: "RUN-AFTER-NULL-ACTIVE", pid: null });
    setBestEffortRecoveryOptionsForTest({
      maxCandidates: 2,
      timeBudgetMs: 10_000,
      observedAt: RECOVERY_OBSERVED_AT,
      processIdentityProbe: {
        capture: async () => assert.fail("capture is not used"),
        validate: async (identity) => ({ ok: true, identity }),
      },
    });

    const first = await recoverStaleProviderRunsBestEffort(CHANGE_ID);
    assert.deepEqual(first.nextCursor, { startedAt: null, id: "RUN-NULL-ACTIVE-1" });
    assert.equal(first.cursorResetReason, undefined);
    const second = await recoverStaleProviderRunsBestEffort(CHANGE_ID);
    assert.deepEqual(second.nextCursor, { startedAt: null, id: "RUN-NULL-ACTIVE-3" });
    assert.equal(second.cursorResetReason, undefined);
    const third = await recoverStaleProviderRunsBestEffort(CHANGE_ID);

    assert.equal(third.recovered.some((item) => item.runId === "RUN-AFTER-NULL-ACTIVE"), true);
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-AFTER-NULL-ACTIVE")).get()?.status, "failed");
  });

  it("resets and reports an invalid recovery cursor without guessing order", async () => {
    seedChange("TECHSPECCING");
    seedRun({ runId: "RUN-CURSOR-RESET", pid: null });

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: false, observedAt: RECOVERY_OBSERVED_AT,
      cursor: { startedAt: "not-a-time", id: "RUN-WHATEVER" },
    });

    assert.equal(result.cursorResetReason, "invalid_cursor");
    assert.equal(result.observed[0]?.runId, "RUN-CURSOR-RESET");
  });

  it("rejects malformed null-time cursor ids while accepting null as an ordering value", async () => {
    seedChange("TECHSPECCING");
    seedRun({ runId: "RUN-NULL-CURSOR", runStartedAt: null, pid: null });

    const invalid = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: false, observedAt: RECOVERY_OBSERVED_AT,
      cursor: { startedAt: null, id: "" },
    });
    assert.equal(invalid.cursorResetReason, "invalid_cursor");

    const valid = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: false, observedAt: RECOVERY_OBSERVED_AT,
      cursor: { startedAt: null, id: "RUN-BEFORE-NULL-CURSOR" },
    });
    assert.equal(valid.cursorResetReason, undefined);
    assert.equal(valid.observed[0]?.runId, "RUN-NULL-CURSOR");
  });

  it("defers remaining candidates without writes after the first probe exhausts the deadline", async () => {
    seedChange("TECHSPECCING");
    for (let index = 0; index < 3; index += 1) {
      seedRun({ runId: `RUN-DEADLINE-${index}`, pid: 424_242 + index });
    }
    const ticks = [0, 0, 0, 0, 6];
    let probeCalls = 0;

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      maxCandidates: 3,
      timeBudgetMs: 5,
      monotonicNowForTest: () => ticks.shift() ?? 6,
      processIdentityProbe: {
        capture: async () => assert.fail("pid_missing does not recapture"),
        validate: async () => {
          probeCalls += 1;
          return { ok: false, reason: "pid_missing" };
        },
      },
    });

    assert.equal(result.processedCandidates, 1);
    assert.equal(result.deferred.some((item) => item.reason === "time_budget"), true);
    assert.deepEqual(result.failed, [], "deadline deferral is not an execution failure");
    assert.equal(probeCalls, 1);
    assert.equal(db.select().from(runs).where(and(
      eq(runs.status, "running"), eq(runs.changeId, CHANGE_ID),
    )).all().length, 3);
  });

  it("defers with zero writes when candidate prefetch exhausts the deadline", async () => {
    seedChange("TECHSPECCING");
    seedRun({ runId: "RUN-PREFETCH-DEADLINE", pid: null });
    let clock = 0;

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      timeBudgetMs: 5, monotonicNowForTest: () => clock,
      onCandidateDbQuery: (table) => { if (table === "providers") clock = 5; },
    });

    assert.equal(result.processedCandidates, 0);
    assert.equal(result.deferred.some((item) => item.reason === "time_budget"), true);
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-PREFETCH-DEADLINE")).get()?.status, "running");
  });

  it("does not query candidates when the deadline is exhausted before prefetch", async () => {
    seedChange("TECHSPECCING");
    seedRun({ runId: "RUN-BEFORE-PREFETCH-DEADLINE", pid: null });
    const ticks = [0, 5];
    let candidateQueries = 0;

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      timeBudgetMs: 5, monotonicNowForTest: () => ticks.shift() ?? 5,
      onCandidateDbQuery: () => { candidateQueries += 1; },
    });

    assert.equal(candidateQueries, 0);
    assert.equal(result.deferred.some((item) => item.reason === "time_budget"), true);
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-BEFORE-PREFETCH-DEADLINE")).get()?.status, "running");
  });

  it("defers with zero writes when identity probing exhausts the deadline", async () => {
    seedChange("TECHSPECCING");
    seedRun({ runId: "RUN-PROBE-DEADLINE", pid: 440_001 });
    let clock = 0;

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      timeBudgetMs: 5, monotonicNowForTest: () => clock,
      processIdentityProbe: {
        capture: async () => assert.fail("capture is not used"),
        validate: async () => {
          clock = 5;
          return { ok: false, reason: "pid_missing" };
        },
      },
    });

    assert.equal(result.deferred.some((item) => item.reason === "time_budget"), true);
    assert.deepEqual(result.failed, []);
    assert.equal(result.nextCursor, null, "a deferred candidate is not acknowledged by the cursor");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-PROBE-DEADLINE")).get()?.status, "running");

    const retry = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      timeBudgetMs: 5, monotonicNowForTest: () => 0,
      cursor: result.nextCursor ?? undefined,
      processIdentityProbe: {
        capture: async () => assert.fail("capture is not used"),
        validate: async () => ({ ok: false, reason: "pid_missing" }),
      },
    });
    assert.equal(retry.recovered.some((item) => item.runId === "RUN-PROBE-DEADLINE"), true);
  });

  it("defers with zero writes when business evidence exhausts the deadline", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    let clock = 0;

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      timeBudgetMs: 5, monotonicNowForTest: () => clock,
      onEvidenceProbe: () => { clock = 5; },
    });

    assert.equal(result.deferred.some((item) => item.reason === "time_budget"), true);
    assert.deepEqual(result.failed, []);
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(events).where(eq(events.type, "business_run_reconciled")).all().length, 0);
  });

  it("rejects oversized artifact evidence before reading the file body", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    const originalReadFileSync = fs.readFileSync;
    let fdReads = 0;
    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (typeof args[0] === "number") fdReads += 1;
      return originalReadFileSync(...args as [never]);
    }) as typeof fs.readFileSync;
    try {
      const result = await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
        timeBudgetMs: 10_000, maxArtifactBytes: 1,
      });
      assert.equal(result.recovered[0]?.reasonCode, "business_run_reconciled");
      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
      assert.equal(fdReads, 0, "oversized artifacts must not be read into memory");
    } finally {
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = originalReadFileSync;
    }
  });

  it("stops SQLite lock retries at the deadline without recording a recovery failure", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    db.run(sql.raw(`
      CREATE TRIGGER task11_retry_deadline
      BEFORE UPDATE ON runs WHEN OLD.id = 'RUN-MATRIX'
      BEGIN SELECT RAISE(ABORT, 'database is locked'); END
    `));
    let clockCalls = 0;
    try {
      const result = await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
        timeBudgetMs: 5,
        monotonicNowForTest: () => (++clockCalls >= 8 ? 5 : 0),
      });
      assert.equal(result.deferred.some((item) => item.reason === "time_budget"), true);
      assert.deepEqual(result.failed, []);
      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    } finally {
      db.run(sql.raw("DROP TRIGGER IF EXISTS task11_retry_deadline"));
    }
  });

  it("rolls back all transaction writes when the final commit guard reaches the deadline", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    let clock = 0;

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      timeBudgetMs: 5, monotonicNowForTest: () => clock,
      onEvidenceDbQuery: (_phase, scope) => { if (scope === "transaction") clock = 5; },
    });

    assert.equal(result.deferred.some((item) => item.reason === "time_budget"), true);
    assert.deepEqual(result.failed, []);
    assert.equal(result.nextCursor, null);
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(events).where(eq(events.type, "business_run_reconciled")).all().length, 0);
  });

  it("rolls back missing-provider recovery when its final commit guard reaches the deadline", async () => {
    seedChange("TECHSPECCING");
    db.insert(runs).values({
      id: "RUN-MISSING-COMMIT-DEADLINE", changeId: CHANGE_ID, phase: "tech_spec",
      status: "running", startedAt: "2026-07-10T00:00:00.000Z", attemptNo: 1,
    }).run();
    let clock = 0;

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      timeBudgetMs: 5, monotonicNowForTest: () => clock,
      beforeRecoveryCommitForTest: () => { clock = 5; },
    });

    assert.equal(result.deferred.some((item) => item.reason === "time_budget"), true);
    assert.equal(result.nextCursor, null);
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MISSING-COMMIT-DEADLINE")).get()?.status, "running");
    assert.equal(db.select().from(providerRunProcesses)
      .where(eq(providerRunProcesses.runId, "RUN-MISSING-COMMIT-DEADLINE")).get(), undefined);
  });

  it("finishes post-commit compensation atomically but reports partial when its deadline expires", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    let clock = 0;

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      timeBudgetMs: 5, monotonicNowForTest: () => clock,
      evidenceDriftAfterCommitForTest: () => {
        clock = 5;
        return true;
      },
    });

    assert.equal(result.deferred.some((item) => item.reason === "time_budget"), true);
    assert.equal(result.truncated, true);
    assert.equal(result.nextCursor, null);
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
    const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
    assert.ok(event);
    assert.equal(JSON.parse(event.rawJson ?? "{}").businessEvidenceComplete, false);
  });

  it("fails closed when canonical Review findings exceed the configured witness cap", async () => {
    await seedCompletedProviderFixture("review", true);
    for (let index = 0; index < 3; index += 1) {
      db.insert(findings).values({
        id: `FND-REVIEW-CAP-${index}`, changeId: CHANGE_ID, runId: "RUN-MATRIX", roundId: null,
        phase: "Review", source: "review", severity: "P2", category: "correctness",
        title: `Review cap ${index}`, evidence: "bounded evidence", requiredFix: "none",
        status: "resolved", createdAt: `2026-07-10T00:00:2${index}.000Z`, updatedAt: null,
        reviewAttemptId: "REV-COMPLETED-PROVIDER", sourceBuildRunId: "build-1",
        sourceHeadSha: "review-head", waivable: 0, waivedBy: null, waivedAt: null,
        waiverDecisionId: null, legacyState: null, legacyFindingKey: null, findingVersion: 1,
      }).run();
    }
    const restore = setReviewReportServiceDbForTest(db);
    recomputeReviewReport(CHANGE_ID, "REV-COMPLETED-PROVIDER");
    restore();

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID,
      execute: true,
      observedAt: RECOVERY_OBSERVED_AT,
      maxReviewFindings: 2,
    });

    assert.equal(result.recovered.length, 0);
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(result.deferred.some((item) => item.reason === "review_findings_limit"), true);
    const recoveryEvent = db.select().from(events).where(eq(events.runId, "RUN-MATRIX"))
      .all().find((event) => event.type === "business_run_reconciled");
    assert.equal(recoveryEvent, undefined);
  });

  it("defers huge prior finding JSON before constructing an inArray query", async () => {
    await seedCompletedProviderFixture("review", true);
    const hugePriorIds = Array.from({ length: 40_000 }, (_, index) => `FND-HUGE-${index}`);
    db.update(reviewAttempts).set({ priorBlockingFindingIdsJson: JSON.stringify(hugePriorIds) })
      .where(eq(reviewAttempts.id, "REV-COMPLETED-PROVIDER")).run();

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      maxReviewFindings: 50, timeBudgetMs: 10_000,
    });

    assert.equal(result.deferred.some((item) =>
      item.reason === "review_findings_limit" && item.runId === "RUN-MATRIX"), true);
    assert.deepEqual(result.failed, []);
    assert.equal(result.nextCursor, null);
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(events).where(eq(events.type, "business_run_reconciled")).all().length, 0);
  });

  it("uses one shared createdAt ownership helper in all three recovery paths", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "stale-provider-run-recovery-service.ts"),
      "utf8",
    );
    // Pure predicates live in recovery-predicates.ts; the ownership helper and the
    // transactional write executors live in recovery-executors.ts.
    const predicatesSource = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "recovery-predicates.ts"),
      "utf8",
    );
    const executorsSource = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "recovery-executors.ts"),
      "utf8",
    );
    assert.equal((executorsSource.match(/function determineRecoveryOwnership/g) ?? []).length, 1);
    assert.equal((source.match(/function determineRecoveryOwnership/g) ?? []).length, 0);
    assert.equal((predicatesSource.match(/function isCanonicalUtcIsoTimestamp/g) ?? []).length, 1);
    assert.equal((predicatesSource.match(/function providerOwnershipMatchesRun/g) ?? []).length, 1);
    assert.match(source, /from "\.\/recovery-predicates"/);
    assert.doesNotMatch(source, /latestChangeJob/);
    assert.doesNotMatch(source, /orderBy\(desc\(pipelineJobs\.attemptNo\)/);
    // recoverMissingProvider is the next function after the ownership helper in
    // recovery-executors.ts.
    const ownershipSource = executorsSource.slice(
      executorsSource.indexOf("function determineRecoveryOwnership"),
      executorsSource.indexOf("function recoverMissingProvider"),
    );
    assert.doesNotMatch(ownershipSource, /\.all\s*\(/);
    assert.doesNotMatch(ownershipSource, /updatedAt/);
    assert.match(ownershipSource, /invalidDifferentJobExists/);
    assert.match(ownershipSource, /currentJob\.changeId !== run\.changeId/);
    assert.match(ownershipSource, /canonicalOwnershipPhase/);
    assert.ok(
      ownershipSource.indexOf("currentJob.changeId !== run.changeId")
        < ownershipSource.indexOf("sameJobFenceChanged"),
      "ownership identity must be checked before fence comparison",
    );
    const recoveryLoopSource = source.slice(
      source.indexOf("for (let index = 0; index < candidateBatch.candidates.length"),
      source.indexOf("return report;", source.indexOf("for (let index = 0; index < candidateBatch.candidates.length")),
    );
    const providerOwnershipCheck = recoveryLoopSource.indexOf("providerOwnershipMatchesRun(provider, run)");
    assert.ok(providerOwnershipCheck >= 0, "provider/run ownership must be checked in the recovery loop");
    assert.ok(
      providerOwnershipCheck < recoveryLoopSource.indexOf("decideProviderRecovery"),
      "provider/run ownership must be checked before process probing",
    );
    assert.ok(
      providerOwnershipCheck < recoveryLoopSource.indexOf("businessEvidenceForCompletedProvider"),
      "provider/run ownership must be checked before evidence and file IO",
    );
    assert.ok(
      providerOwnershipCheck < recoveryLoopSource.indexOf("recoverExistingProvider({"),
      "effective provider phase must only be used after provider/run ownership validation",
    );
    const freshnessSource = predicatesSource.slice(
      predicatesSource.indexOf("function providerFreshnessMatches"),
      predicatesSource.indexOf("function jobFreshnessMatches"),
    );
    assert.match(freshnessSource, /current\.changeId === expected\.changeId/);
    assert.match(freshnessSource, /canonicalOwnershipPhase\(current\.phase\)/);
    // recoverExistingProvider now lives in recovery-executors.ts; recoverProviderAfterTerminalRun
    // is the next function after it there.
    const reconcileSource = executorsSource.slice(
      executorsSource.indexOf("function recoverExistingProvider"),
      executorsSource.indexOf("function recoverProviderAfterTerminalRun"),
    );
    const transactionOwnershipCheck = reconcileSource.indexOf(
      "providerOwnershipMatchesRun(currentProvider, currentRunSnapshot)",
    );
    assert.ok(transactionOwnershipCheck >= 0, "transaction must revalidate current provider/run ownership");
    assert.ok(
      transactionOwnershipCheck < reconcileSource.indexOf("const runCas"),
      "transaction ownership revalidation must precede every recovery write",
    );
    const signalOwnershipCheck = recoveryLoopSource.indexOf(
      "providerOwnershipAndIdentityMatchCurrentState",
    );
    assert.ok(signalOwnershipCheck >= 0, "signal path must revalidate provider ownership and identity");
    assert.ok(
      signalOwnershipCheck < recoveryLoopSource.indexOf("await terminateProcess"),
      "signal ownership revalidation must happen immediately before termination",
    );
    const candidatesSource = source.slice(
      source.indexOf("function recoveryCandidates"),
      source.indexOf("function providerOwnershipAndIdentityMatchCurrentState"),
    );
    assert.match(candidatesSource, /orderBy\(/);
    assert.match(candidatesSource, /limit\(maxCandidates \+ 1\)/);
    assert.equal((candidatesSource.match(/\.all\(\)/g) ?? []).length, 3);
    assert.match(candidatesSource, /inArray\(providerRunProcesses\.runId/);
    assert.match(candidatesSource, /inArray\(pipelineJobs\.id/);
    assert.ok(
      candidatesSource.indexOf("limit(maxCandidates + 1)") < candidatesSource.indexOf(".all()"),
      "the only candidate .all() must be bounded by maxCandidates + 1",
    );
    // Phase-specific evidence gathering moved to recovery-business-evidence.ts.
    const evidenceSource = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "recovery-business-evidence.ts"),
      "utf8",
    );
    const reviewEvidenceSource = evidenceSource.slice(
      evidenceSource.indexOf('provider.phase === "review"'),
      evidenceSource.indexOf('provider.phase === "implement"', evidenceSource.indexOf('provider.phase === "review"')),
    );
    assert.match(reviewEvidenceSource, /limit\(maxReviewFindings \+ 1\)/);
  });

  for (const [label, invalidCreatedAt] of [
    ["lexically late junk", "zzzz-invalid"],
    ["lexically early junk", "0000-invalid"],
    ["timezone-less timestamp", "2026-07-10T00:00:10"],
    ["overflow date", "2026-02-30T00:00:10.000Z"],
  ] as const) {
    it(`fails closed for a current job with ${label}`, async () => {
      seedReconciliationFixture({ providerStatus: "failed" });
      db.update(pipelineJobs).set({ createdAt: invalidCreatedAt })
        .where(eq(pipelineJobs.id, "JOB-MATRIX")).run();

      await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      });

      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
      assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
    });
  }

  it("fails closed when any different candidate job has a non-canonical createdAt", async () => {
    for (const [index, invalidCreatedAt] of [
      "0000-invalid",
      "zzzz-invalid",
      "2026-07-10T00:00:11",
      "2026-02-30T00:00:11.000Z",
      "2026-07-10T00:00:11Z",
      "prefix-2026-07-10T00:00:11.000Z",
    ].entries()) {
      cleanupRows();
      seedReconciliationFixture({ providerStatus: "failed" });
      insertOwnershipJob({
        id: `JOB-INVALID-CANDIDATE-${index}`,
        createdAt: invalidCreatedAt,
        attemptNo: 1,
        leaseToken: `lease-invalid-${index}`,
      });

      await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      });

      assert.equal(
        db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status,
        "TECHSPECCING",
        invalidCreatedAt,
      );
    }
  });

  it("fails closed for a jobless run with a non-canonical startedAt", async () => {
    seedChange("TECHSPECCING");
    db.insert(runs).values({
      id: "RUN-JOBLESS-INVALID-TIME", changeId: CHANGE_ID, phase: "tech_spec",
      status: "running", startedAt: "0000-invalid", endedAt: null, summary: null,
      jobId: null, workerId: null, leaseToken: null, attemptNo: 1,
    }).run();

    await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
    });

    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-JOBLESS-INVALID-TIME")).get()?.status, "failed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
  });

  it("main reconciliation rejects a current job owned by another change without writes", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    seedOtherChange();
    db.update(pipelineJobs).set({ changeId: OTHER_CHANGE_ID })
      .where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
    const actionsBefore = computeActions(CHANGE_ID, { selfHeal: true });
    const signaled: ProcessIdentity[] = [];

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      terminateProcess: async (identity) => { signaled.push(identity); },
    });

    assert.equal(result.recovered.length, 0);
    assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
    assert.equal(db.select().from(changes).where(eq(changes.id, OTHER_CHANGE_ID)).get()?.status, "TECHSPECCING");
    assert.deepEqual(computeActions(CHANGE_ID, { selfHeal: true }), actionsBefore);
    assert.equal(db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(signaled.length, 0);
  });

  it("missing-provider recovery rejects a current job owned by another change without writes", async () => {
    seedMissingOwnershipFixture();
    seedOtherChange();
    db.update(pipelineJobs).set({ changeId: OTHER_CHANGE_ID })
      .where(eq(pipelineJobs.id, "JOB-MISSING-OWNERSHIP-CURRENT")).run();
    const actionsBefore = computeActions(CHANGE_ID, { selfHeal: true });

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      terminateProcess: async () => assert.fail("ownership mismatch must not signal"),
    });

    assert.equal(result.recovered.length, 0);
    assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MISSING-OWNERSHIP-CURRENT")).get()?.status, "running");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MISSING-OWNERSHIP-CURRENT")).get()?.status, "running");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MISSING-OWNERSHIP-CURRENT")).get()?.status, "running");
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.runId, "RUN-MISSING-OWNERSHIP-CURRENT")).all().length, 0);
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
    assert.deepEqual(computeActions(CHANGE_ID, { selfHeal: true }), actionsBefore);
  });

  it("post-commit compensation rejects a current job moved to another change", async () => {
    let actionsAfterMain: ReturnType<typeof computeActions> | null = null;
    await recoverTechSpecWithPostCommitJobMutation(() => {
      seedOtherChange();
      db.update(pipelineJobs).set({ changeId: OTHER_CHANGE_ID })
        .where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
      actionsAfterMain = computeActions(CHANGE_ID, { selfHeal: true });
    }, {
      terminateProcess: async () => assert.fail("completed provider must not signal"),
    });

    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "succeeded");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "completed");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "completed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPEC_READY");
    assert.equal(db.select().from(changes).where(eq(changes.id, OTHER_CHANGE_ID)).get()?.status, "TECHSPEC_READY");
    assert.deepEqual(computeActions(CHANGE_ID, { selfHeal: true }), actionsAfterMain);
  });

  it("main reconciliation rejects a same-change job with the wrong semantic phase", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    db.update(pipelineJobs).set({ phase: "review" }).where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
    const actionsBefore = computeActions(CHANGE_ID, { selfHeal: true });

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      terminateProcess: async () => assert.fail("ownership mismatch must not signal"),
    });

    assert.equal(result.recovered.length, 0);
    assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
    assert.deepEqual(computeActions(CHANGE_ID, { selfHeal: true }), actionsBefore);
  });

  it("missing-provider recovery rejects a same-change job with the wrong semantic phase", async () => {
    seedMissingOwnershipFixture("review");

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      terminateProcess: async () => assert.fail("ownership mismatch must not signal"),
    });

    assert.equal(result.recovered.length, 0);
    assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MISSING-OWNERSHIP-CURRENT")).get()?.status, "running");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MISSING-OWNERSHIP-CURRENT")).get()?.status, "running");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MISSING-OWNERSHIP-CURRENT")).get()?.status, "running");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPECCING");
  });

  it("post-commit compensation rejects a same-change job whose phase changed", async () => {
    let actionsAfterMain: ReturnType<typeof computeActions> | null = null;
    await recoverTechSpecWithPostCommitJobMutation(() => {
      db.update(pipelineJobs).set({ phase: "review" }).where(eq(pipelineJobs.id, "JOB-MATRIX")).run();
      actionsAfterMain = computeActions(CHANGE_ID, { selfHeal: true });
    });

    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "succeeded");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "completed");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "completed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "TECHSPEC_READY");
    assert.deepEqual(computeActions(CHANGE_ID, { selfHeal: true }), actionsAfterMain);
  });

  it("accepts the spec_critic run alias for a canonical spec job", async () => {
    seedReconciliationFixture({ providerStatus: "failed", phase: "spec" });
    db.update(runs).set({ phase: "spec_critic" }).where(eq(runs.id, "RUN-MATRIX")).run();
    db.update(providerRunProcesses).set({ phase: "spec_critic" })
      .where(eq(providerRunProcesses.id, "PRP-MATRIX")).run();

    const result = await recoverStaleProviderRuns({
      changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
    });

    assert.equal(result.recovered.length, 1);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "BLOCKED");
  });

  it("compensates a stage that was already completed with an earlier completedAt", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    db.update(stageRuns).set({
      status: "completed",
      completedAt: "2026-07-10T00:01:30.000Z",
      outputDbHash: "precompleted-output",
      sourceLineageJson: JSON.stringify({ source: "precompleted" }),
    }).where(eq(stageRuns.id, "STG-MATRIX")).run();
    const artifact = db.select().from(artifacts).where(and(
      eq(artifacts.runId, "RUN-MATRIX"), eq(artifacts.type, "tech_spec_delta"),
    )).get();
    assert.ok(artifact);
    const originalTransaction = db.transaction.bind(db);
    let drifted = false;
    (db as unknown as { transaction: typeof db.transaction }).transaction = ((callback: (tx: typeof db) => unknown, config?: unknown) => {
      const result = originalTransaction(callback, config as never);
      const committedRun = db.select({ status: runs.status }).from(runs)
        .where(eq(runs.id, "RUN-MATRIX")).get();
      if (!drifted && committedRun?.status === "completed") {
        drifted = true;
        fs.rmSync(artifact.path);
      }
      return result;
    }) as typeof db.transaction;
    try {
      await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      });
    } finally {
      (db as unknown as { transaction: typeof db.transaction }).transaction = originalTransaction as typeof db.transaction;
    }

    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.id, "PRP-MATRIX")).get()?.status, "completed");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "failed");
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "failed");
    const stage = db.select().from(stageRuns).where(eq(stageRuns.id, "STG-MATRIX")).get();
    assert.equal(stage?.status, "failed");
    assert.equal(stage?.completedAt, "2026-07-10T00:01:30.000Z");
    assert.equal(stage?.errorCode, "business_evidence_changed_after_commit");
    const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
    const raw = JSON.parse(event?.rawJson ?? "{}") as { businessEvidenceComplete?: boolean };
    assert.equal(raw.businessEvidenceComplete, false);
  });

  it("uses status-independent newer-attempt ownership naming in every recovery path", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "stale-provider-run-recovery-service.ts"),
      "utf8",
    );
    // Ownership determination now lives in recovery-executors.ts.
    const executorsSource = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "recovery-executors.ts"),
      "utf8",
    );
    assert.doesNotMatch(source, /newerAttemptActive/);
    assert.doesNotMatch(executorsSource, /newerAttemptActive/);
    assert.match(executorsSource, /newerAttemptExists/);
    assert.match(executorsSource, /ownsChange/);
  });

  it("revalidates file identity after SQLITE_BUSY instead of reusing the old observation", async () => {
    await seedCompletedProviderFixture("tech_spec", true);
    const artifact = db.select().from(artifacts).where(and(
      eq(artifacts.runId, "RUN-MATRIX"), eq(artifacts.type, "tech_spec_delta"),
    )).get();
    assert.ok(artifact);
    const originalContent = fs.readFileSync(artifact.path);
    const originalTransaction = db.transaction.bind(db);
    let attempts = 0;
    (db as unknown as { transaction: typeof db.transaction }).transaction = ((callback: (tx: typeof db) => unknown, config?: unknown) => {
      attempts += 1;
      if (attempts === 1) {
        const replacement = `${artifact.path}.replacement`;
        fs.writeFileSync(replacement, originalContent);
        fs.renameSync(replacement, artifact.path);
        const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        throw busy;
      }
      return originalTransaction(callback, config as never);
    }) as typeof db.transaction;
    try {
      const result = await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      });
      assert.equal(attempts, 1, "the retry must stop before opening a second write transaction");
      assert.equal(result.recovered.length, 0);
      assert.equal(result.observed[0]?.reasonCode, "already_reconciled");
    } finally {
      (db as unknown as { transaction: typeof db.transaction }).transaction = originalTransaction as typeof db.transaction;
    }

    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get()?.status, "running");
    assert.equal(db.select().from(events).where(eq(events.type, "business_run_reconciled")).all().length, 0);
  });

  it("allocates a fresh immutable run id for every pipeline attempt", () => {
    seedChange("TECHSPECCING");
    const first = createRun(CHANGE_ID, "tech_spec");
    const second = createRun(CHANGE_ID, "tech_spec");
    assert.notEqual(first, second);
    assert.equal(db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all().length, 2);
    assert.throws(() => db.insert(runs).values({
      id: first, changeId: CHANGE_ID, phase: "tech_spec", status: "running",
    }).run(), /UNIQUE|constraint/i);
  });

  it("repair CLI rejects ambiguous or unsafe execution arguments", () => {
    assert.throws(() => parseRepairCliArguments(["--change"]), /requires a value/);
    assert.throws(() => parseRepairCliArguments(["--unknown"]), /unknown argument/);
    assert.throws(() => parseRepairCliArguments(["--execute", "--dry-run"]), /mutually exclusive/);
    assert.throws(() => parseRepairCliArguments(["--execute"]), /explicit --all/);
    assert.throws(() => parseRepairCliArguments(["--execute", "--all", "--change", CHANGE_ID]), /cannot be combined/);
    const targeted = parseRepairCliArguments(["--execute", "--change", CHANGE_ID]);
    assert.equal(targeted.options.changeId, CHANGE_ID);
    assert.equal(targeted.options.execute, true);
  });

  it("treats deferred repair work as a partial nonzero CLI result", () => {
    const report = {
      recovered: [], failed: [], observed: [], observedAt: RECOVERY_OBSERVED_AT.toISOString(),
      processedCandidates: 1, truncated: true,
      deferred: [{ reason: "candidate_limit" as const, count: 1, atLeast: true }],
    };
    assert.equal(repairCliExitCode(report), 2);
    assert.equal(repairCliExitCode({ ...report, truncated: false, deferred: [] }), 0);
    assert.equal(repairCliExitCode({
      ...report,
      failed: [{
        runId: "RUN-FAILED", changeId: CHANGE_ID, phase: "spec",
        code: "recovery_failed" as const, error: "write failed",
      }],
    }), 1);
  });

  it("repair CLI exits nonzero before touching recovery for invalid arguments", () => {
    const executable = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    const script = path.join(process.cwd(), "server", "scripts", "repair-stale-provider-runs.ts");
    const result = spawnSync(executable, [script, "--execute", "--dry-run"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mutually exclusive/);
  });

  it("real Change GET, Events GET, and SSE initial snapshot never reconcile provider state", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    setStartupRecoveryDependenciesForTest({
      logDir: process.cwd(),
      ensureLogs: () => {},
      checkDb: () => {},
      writeLog: () => {},
      recover: async () => ({
        recovered: [],
        failed: [],
        observed: [],
        observedAt: RECOVERY_OBSERVED_AT.toISOString(),
      }),
    });
    const detailRoute = await import("../../app/api/projects/[id]/changes/[changeId]/route");
    const eventsRoute = await import("../../app/api/projects/[id]/changes/[changeId]/events/route");
    const streamRoute = await import("../../app/api/projects/[id]/changes/[changeId]/events/stream/route");
    const context = { params: Promise.resolve({ id: PROJECT_ID, changeId: CHANGE_ID }) };

    const detailResponse = await detailRoute.GET(new Request("http://localhost/detail"), context);
    const detail = await detailResponse.json();
    assert.equal(detailResponse.status, 200);
    assert.equal(detail.latestRun.status, "running");

    const actions = computeActions(CHANGE_ID);
    assert.equal(actions.some((action) => action.actionId === "retry_tech_spec" && action.enabled), false);

    const eventsResponse = await eventsRoute.GET(new Request("http://localhost/events"), context);
    const eventRows = await eventsResponse.json();
    assert.equal(eventRows.filter((event: { type: string }) => event.type === "business_run_reconciled").length, 0);

    const streamResponse = await streamRoute.GET(new Request("http://localhost/events/stream"), context);
    const reader = streamResponse.body?.getReader();
    assert.ok(reader);
    await reader.cancel();
  });

  it("keeps synchronous getActions free of fire-and-forget recovery writes", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });

    getActions(CHANGE_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(
      db.select().from(events).where(and(
        eq(events.changeId, CHANGE_ID),
        eq(events.type, "business_run_reconciled"),
      )).all().length,
      0,
    );
  });

  it("Change GET remains available when global startup fails for another change", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    setFailingGlobalStartup();
    const detailRoute = await import("../../app/api/projects/[id]/changes/[changeId]/route");

    const response = await detailRoute.GET(
      new Request("http://localhost/detail"),
      { params: Promise.resolve({ id: PROJECT_ID, changeId: CHANGE_ID }) },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.latestRun.status, "running");
    assert.doesNotMatch(JSON.stringify(body), /sqlite|absolute\/path/i);
  });

  it("Events GET and SSE remain change-scoped when global startup partially fails", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    setFailingGlobalStartup();
    const eventsRoute = await import("../../app/api/projects/[id]/changes/[changeId]/events/route");
    const streamRoute = await import("../../app/api/projects/[id]/changes/[changeId]/events/stream/route");
    const context = { params: Promise.resolve({ id: PROJECT_ID, changeId: CHANGE_ID }) };

    const eventsResponse = await eventsRoute.GET(new Request("http://localhost/events"), context);
    assert.equal(eventsResponse.status, 200);
    assert.doesNotMatch(await eventsResponse.text(), /business_run_reconciled/);

    const streamResponse = await streamRoute.GET(new Request("http://localhost/events/stream"), context);
    assert.equal(streamResponse.status, 200);
    const reader = streamResponse.body?.getReader();
    assert.ok(reader);
    await reader.cancel();
  });

  it("all scoped read routes remain available when a recovery write would fail", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    setStartupRecoveryDependenciesForTest({
      logDir: process.cwd(), ensureLogs: () => {}, checkDb: () => {}, writeLog: () => {},
      recover: async () => ({ recovered: [], failed: [], observed: [], observedAt: RECOVERY_OBSERVED_AT.toISOString() }),
    });
    db.run(sql.raw(`
      CREATE TRIGGER task11_route_recovery_failure
      BEFORE UPDATE ON runs
      WHEN OLD.id = 'RUN-MATRIX'
      BEGIN
        SELECT RAISE(ABORT, 'sensitive sqlite /absolute/path trigger');
      END
    `));
    const context = { params: Promise.resolve({ id: PROJECT_ID, changeId: CHANGE_ID }) };
    try {
      const routeCalls = [
        async () => (await import("../../app/api/projects/[id]/changes/[changeId]/route")).GET(new Request("http://localhost/detail"), context),
        async () => (await import("../../app/api/projects/[id]/changes/[changeId]/events/route")).GET(new Request("http://localhost/events"), context),
        async () => (await import("../../app/api/projects/[id]/changes/[changeId]/gate/route")).GET(new Request("http://localhost/gate"), context),
        async () => (await import("../../app/api/projects/[id]/changes/[changeId]/phases/route")).GET(new Request("http://localhost/phases?phase=TechSpec"), context),
      ];
      for (const callRoute of routeCalls) {
        const response = await callRoute();
        const body = await response.text();
        assert.equal(response.status, 200, body);
        assert.doesNotMatch(body, /RECOVERY_INCOMPLETE/);
        assert.doesNotMatch(body, /sqlite|trigger|absolute\/path|cc-ai/i);
      }
      const streamRoute = await import("../../app/api/projects/[id]/changes/[changeId]/events/stream/route");
      const streamResponse = await streamRoute.GET(new Request("http://localhost/events/stream"), context);
      assert.equal(streamResponse.status, 200);
      await streamResponse.body?.cancel();
    } finally {
      db.run(sql.raw("DROP TRIGGER IF EXISTS task11_route_recovery_failure"));
    }
    const eventsRoute = await import("../../app/api/projects/[id]/changes/[changeId]/events/route");
    const recoveredResponse = await eventsRoute.GET(new Request("http://localhost/events"), context);
    const recoveredBody = await recoveredResponse.text();
    assert.equal(recoveredResponse.status, 200);
    assert.doesNotMatch(recoveredBody, /sqlite|trigger|absolute\/path|cc-ai/i);
  });

  it("scoped routes do not consume an injected recovery budget or write", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    setFailingGlobalStartup();
    let clock = 0;
    setBestEffortRecoveryOptionsForTest({
      timeBudgetMs: 1_000,
      monotonicNowForTest: () => clock,
      onCandidateDbQuery: (table) => { if (table === "providers") clock = 1_000; },
    });
    const detailRoute = await import("../../app/api/projects/[id]/changes/[changeId]/route");

    const response = await detailRoute.GET(
      new Request("http://localhost/detail"),
      { params: Promise.resolve({ id: PROJECT_ID, changeId: CHANGE_ID }) },
    );

    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /RECOVERY_INCOMPLETE/);
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
  });

  it("Gate GET reports the stored snapshot without scoped recovery", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    setFailingGlobalStartup();
    const gateRoute = await import("../../app/api/projects/[id]/changes/[changeId]/gate/route");

    const response = await gateRoute.GET(
      new Request("http://localhost/gate"),
      { params: Promise.resolve({ id: PROJECT_ID, changeId: CHANGE_ID }) },
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get()?.status, "running");
    assert.equal(body.status, "TECHSPECCING");
    assert.equal(
      body.actions.some((action: { actionId: string; enabled: boolean }) =>
        action.actionId === "retry_tech_spec" && action.enabled),
      false,
    );
    assert.doesNotMatch(JSON.stringify(body), /\"status\":\"running\"/);
  });

  it("Phases GET returns the stored run without executing recovery", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    setFailingGlobalStartup();
    const phasesRoute = await import("../../app/api/projects/[id]/changes/[changeId]/phases/route");

    const response = await phasesRoute.GET(
      new Request("http://localhost/phases?phase=TechSpec"),
      { params: Promise.resolve({ id: PROJECT_ID, changeId: CHANGE_ID }) },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.selected.runs.some((run: { status: string }) => run.status === "running"), true);
    assert.equal(
      body.actions.some((action: { actionId: string; enabled: boolean }) =>
        action.actionId === "retry_tech_spec" && action.enabled),
      false,
    );
  });

  it("all polling reads remain immutable and available while the pipeline worker owns a SQLite write transaction", async () => {
    seedReconciliationFixture({ providerStatus: "failed" });
    db.update(changes)
      .set({ status: "MERGE_READY" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    setFailingGlobalStartup();
    const previousBusyTimeout = sqlite.pragma("busy_timeout", { simple: true }) as number;
    const workerConnection = new Database(databasePath);
    workerConnection.pragma("journal_mode = WAL");
    workerConnection.pragma("busy_timeout = 0");
    sqlite.pragma("busy_timeout = 0");
    workerConnection.exec("BEGIN IMMEDIATE");
    workerConnection.prepare(
      "UPDATE pipeline_jobs SET heartbeat_at = ? WHERE id = ?",
    ).run("2026-07-10T00:01:59.000Z", "JOB-MATRIX");

    const context = { params: Promise.resolve({ id: PROJECT_ID, changeId: CHANGE_ID }) };
    const snapshot = () => ({
      run: db.select().from(runs).where(eq(runs.id, "RUN-MATRIX")).get(),
      job: db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-MATRIX")).get(),
      events: db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all(),
      states: db.select().from(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).all(),
      actions: db.select().from(stageActions).where(eq(stageActions.changeId, CHANGE_ID)).all(),
      mirrors: db.select().from(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).all(),
    });
    const before = snapshot();
    try {
      const phasesRoute = await import("../../app/api/projects/[id]/changes/[changeId]/phases/route");
      const detailRoute = await import("../../app/api/projects/[id]/changes/[changeId]/route");
      const gateRoute = await import("../../app/api/projects/[id]/changes/[changeId]/gate/route");
      const eventsRoute = await import("../../app/api/projects/[id]/changes/[changeId]/events/route");
      const streamRoute = await import("../../app/api/projects/[id]/changes/[changeId]/events/stream/route");
      const healthRoute = await import("../../app/api/health/route");
      for (let poll = 0; poll < 3; poll += 1) {
        const responses = [
          await phasesRoute.GET(new Request("http://localhost/phases?phase=TechSpec"), context),
          await detailRoute.GET(new Request("http://localhost/detail"), context),
          await gateRoute.GET(new Request("http://localhost/gate"), context),
          await eventsRoute.GET(new Request("http://localhost/events"), context),
          await healthRoute.GET(),
        ];
        for (const response of responses) {
          const body = await response.text();
          assert.equal(response.status, 200, body);
          assert.doesNotMatch(body, /SQLITE_(?:BUSY|LOCKED)|database is locked|server\/db\/ship\.db/i);
        }
        const streamResponse = await streamRoute.GET(new Request("http://localhost/events/stream"), context);
        assert.equal(streamResponse.status, 200);
        await streamResponse.body?.cancel();
      }
      assert.deepEqual(snapshot(), before);
    } finally {
      workerConnection.exec("ROLLBACK");
      workerConnection.close();
      sqlite.pragma(`busy_timeout = ${previousBusyTimeout}`);
    }

    const phasesRoute = await import("../../app/api/projects/[id]/changes/[changeId]/phases/route");
    const afterRelease = await phasesRoute.GET(
      new Request("http://localhost/phases?phase=TechSpec"),
      context,
    );
    assert.equal(afterRelease.status, 200, await afterRelease.text());
  });

  describe("PRD intake business evidence", () => {
    it("flags a missing legacy intake artifact (run_prd) as incomplete", () => {
      const { run, provider } = seedIntakeProviderFixture({ actionId: "run_prd" });

      const observation = businessEvidenceForCompletedProvider(db, run, provider, DEFAULT_MAX_REVIEW_FINDINGS);

      assert.equal(observation.complete, false);
      assert.deepEqual(observation.missingEvidence, ["intake_artifact_missing"]);
    });

    it("flags a missing legacy intake artifact (retry_prd) as incomplete", () => {
      const { run, provider } = seedIntakeProviderFixture({ actionId: "retry_prd" });

      const observation = businessEvidenceForCompletedProvider(db, run, provider, DEFAULT_MAX_REVIEW_FINDINGS);

      assert.equal(observation.complete, false);
      assert.deepEqual(observation.missingEvidence, ["intake_artifact_missing"]);
    });

    it("treats a present legacy intake artifact as complete evidence", () => {
      const { run, provider } = seedIntakeProviderFixture({ actionId: "run_prd" });
      db.insert(artifacts).values({
        id: "ART-INTAKE-LEGACY", changeId: CHANGE_ID, runId: run.id, type: "change_request",
        path: "/tmp/change-request.md", createdAt: "2026-07-10T00:00:30.000Z",
      }).run();

      const observation = businessEvidenceForCompletedProvider(db, run, provider, DEFAULT_MAX_REVIEW_FINDINGS);

      assert.deepEqual(observation.missingEvidence, []);
      assert.equal(observation.complete, true);
    });

    it("flags missing briefing questions (run_prd_briefing_questions) as incomplete", () => {
      const { run, provider } = seedIntakeProviderFixture({ actionId: "run_prd_briefing_questions" });

      const observation = businessEvidenceForCompletedProvider(db, run, provider, DEFAULT_MAX_REVIEW_FINDINGS);

      assert.equal(observation.complete, false);
      assert.deepEqual(observation.missingEvidence, ["intake_questions_missing"]);
    });

    it("treats persisted briefing questions as complete evidence", () => {
      const { run, provider } = seedIntakeProviderFixture({ actionId: "run_prd_briefing_questions" });
      db.insert(briefingQuestions).values({
        id: "BQ-INTAKE-1", changeId: CHANGE_ID, category: "scope", severity: "P1",
        question: "What is in scope?", whyItMatters: "Defines boundaries", suggestedDefault: null,
        status: "open", answer: null, source: "ai_blue",
        createdAt: "2026-07-10T00:00:30.000Z", updatedAt: "2026-07-10T00:00:30.000Z",
      }).run();

      const observation = businessEvidenceForCompletedProvider(db, run, provider, DEFAULT_MAX_REVIEW_FINDINGS);

      assert.deepEqual(observation.missingEvidence, []);
      assert.equal(observation.complete, true);
    });

    it("flags a missing PRD draft (run_prd_briefing_draft) as incomplete", () => {
      const { run, provider } = seedIntakeProviderFixture({ actionId: "run_prd_briefing_draft" });

      const observation = businessEvidenceForCompletedProvider(db, run, provider, DEFAULT_MAX_REVIEW_FINDINGS);

      assert.equal(observation.complete, false);
      assert.deepEqual(observation.missingEvidence, ["intake_draft_missing"]);
    });

    it("treats a persisted PRD draft as complete evidence", () => {
      const { run, provider } = seedIntakeProviderFixture({ actionId: "run_prd_briefing_draft" });
      db.insert(prdDrafts).values({
        id: "DRAFT-INTAKE-1", changeId: CHANGE_ID, version: 1, markdown: "# Draft\n",
        sourceQuestionIdsJson: "[]", unresolvedQuestionIdsJson: "[]", draftHash: "hash-1",
        createdAt: "2026-07-10T00:00:30.000Z",
      }).run();

      const observation = businessEvidenceForCompletedProvider(db, run, provider, DEFAULT_MAX_REVIEW_FINDINGS);

      assert.deepEqual(observation.missingEvidence, []);
      assert.equal(observation.complete, true);
    });

    it("flags a missing final review (run_prd_briefing_final_review) as incomplete", () => {
      const { run, provider } = seedIntakeProviderFixture({ actionId: "run_prd_briefing_final_review" });

      const observation = businessEvidenceForCompletedProvider(db, run, provider, DEFAULT_MAX_REVIEW_FINDINGS);

      assert.equal(observation.complete, false);
      assert.deepEqual(observation.missingEvidence, ["intake_final_review_missing"]);
    });

    it("treats a persisted final review as complete evidence", () => {
      const { run, provider } = seedIntakeProviderFixture({ actionId: "run_prd_briefing_final_review" });
      db.insert(prdBriefings).values({
        id: "PRDB-INTAKE-1", changeId: CHANGE_ID, status: "final_review_complete",
        intentText: "intent", finalReviewJson: JSON.stringify({ approved: true }),
        sourceHashesJson: "{}", lockedAt: null,
        createdAt: "2026-07-10T00:00:10.000Z", updatedAt: "2026-07-10T00:00:30.000Z",
      }).run();

      const observation = businessEvidenceForCompletedProvider(db, run, provider, DEFAULT_MAX_REVIEW_FINDINGS);

      assert.deepEqual(observation.missingEvidence, []);
      assert.equal(observation.complete, true);
    });

    it("fails closed with intake_action_unresolved when the provider has no jobId", () => {
      const { run, provider } = seedIntakeProviderFixture();
      assert.equal(provider.jobId, null);

      const observation = businessEvidenceForCompletedProvider(db, run, provider, DEFAULT_MAX_REVIEW_FINDINGS);

      assert.equal(observation.complete, false);
      assert.deepEqual(observation.missingEvidence, ["intake_action_unresolved"]);
    });

    it("fails closed with intake_action_unresolved when jobId points at a deleted job row", () => {
      const { run, provider } = seedIntakeProviderFixture({ actionId: "run_prd" });
      db.delete(pipelineJobs).where(eq(pipelineJobs.id, "JOB-INTAKE")).run();

      const observation = businessEvidenceForCompletedProvider(db, run, provider, DEFAULT_MAX_REVIEW_FINDINGS);

      assert.equal(observation.complete, false);
      assert.deepEqual(observation.missingEvidence, ["intake_action_unresolved"]);
    });

    it("captures a drift-sensitive snapshot for a PRD draft mutated between observation and re-check", () => {
      const { run, provider } = seedIntakeProviderFixture({ actionId: "run_prd_briefing_draft" });
      db.insert(prdDrafts).values({
        id: "DRAFT-DRIFT-1", changeId: CHANGE_ID, version: 1, markdown: "# Original draft\n",
        sourceQuestionIdsJson: "[]", unresolvedQuestionIdsJson: "[]", draftHash: "hash-original",
        createdAt: "2026-07-10T00:00:30.000Z",
      }).run();

      const observedSnapshot = captureEvidenceDbSnapshot(
        db, run, provider, undefined, "observation", DEFAULT_MAX_REVIEW_FINDINGS,
      );
      db.update(prdDrafts).set({ markdown: "# Mutated draft\n" }).where(eq(prdDrafts.id, "DRAFT-DRIFT-1")).run();
      const transactionSnapshot = captureEvidenceDbSnapshot(
        db, run, provider, undefined, "transaction", DEFAULT_MAX_REVIEW_FINDINGS,
      );

      assert.notEqual(observedSnapshot, transactionSnapshot);
    });

    it("recovers a stale legacy intake provider end-to-end via recoverStaleProviderRuns", async () => {
      const { run } = seedIntakeProviderFixture({ actionId: "run_prd" });
      db.insert(artifacts).values({
        id: "ART-INTAKE-E2E", changeId: CHANGE_ID, runId: run.id, type: "change_request",
        path: "/tmp/change-request-e2e.md", createdAt: "2026-07-10T00:00:30.000Z",
      }).run();

      await recoverStaleProviderRuns({ changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT });

      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-INTAKE")).get()?.status, "completed");
      assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-INTAKE")).get()?.status, "succeeded");
      const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
      assert.ok(event);
      const raw = JSON.parse(event.rawJson ?? "{}") as { businessEvidenceComplete?: boolean; missingEvidence?: string[] };
      assert.equal(raw.businessEvidenceComplete, true);
      assert.deepEqual(raw.missingEvidence, []);
    });

    it("recovers a stale legacy intake provider as failed end-to-end when evidence is incomplete", async () => {
      seedIntakeProviderFixture({ actionId: "run_prd" });

      await recoverStaleProviderRuns({ changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT });

      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-INTAKE")).get()?.status, "failed");
      assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-INTAKE")).get()?.status, "failed");
      const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
      assert.ok(event);
      const raw = JSON.parse(event.rawJson ?? "{}") as { businessEvidenceComplete?: boolean; missingEvidence?: string[] };
      assert.equal(raw.businessEvidenceComplete, false);
      assert.deepEqual(raw.missingEvidence, ["intake_artifact_missing"]);
    });

    // Regression guard for the ownership gate on the 3-step PRD briefing flow.
    // pipelineJobs.phase is the sub-step ("prd_briefing_draft") while runs.phase
    // and provider.phase are "intake". Unless the canonical ownership map maps
    // prd_briefing_* -> "intake", determineRecoveryOwnership sees a phase
    // mismatch, recoverExistingProvider aborts with zero writes, and the crashed
    // run stalls at "running" forever while every sweep reports "already_reconciled".
    it("recovers a stale prd_briefing_draft provider end-to-end via recoverStaleProviderRuns", async () => {
      seedIntakeProviderFixture({ actionId: "run_prd_briefing_draft" });
      db.insert(prdDrafts).values({
        id: "DRAFT-INTAKE-E2E", changeId: CHANGE_ID, version: 1, markdown: "# Draft\n",
        sourceQuestionIdsJson: "[]", unresolvedQuestionIdsJson: "[]", draftHash: "hash-e2e",
        createdAt: "2026-07-10T00:00:30.000Z",
      }).run();

      const result = await recoverStaleProviderRuns({
        changeId: CHANGE_ID, execute: true, observedAt: RECOVERY_OBSERVED_AT,
      });

      assert.equal(result.recovered.length, 1);
      assert.equal(result.recovered[0]?.reasonCode, "business_run_reconciled");
      assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-INTAKE")).get()?.status, "completed");
      assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, "JOB-INTAKE")).get()?.status, "succeeded");
      const event = db.select().from(events).where(eq(events.type, "business_run_reconciled")).get();
      assert.ok(event);
      const raw = JSON.parse(event.rawJson ?? "{}") as { businessEvidenceComplete?: boolean; missingEvidence?: string[] };
      assert.equal(raw.businessEvidenceComplete, true);
      assert.deepEqual(raw.missingEvidence, []);
    });
  });
});
