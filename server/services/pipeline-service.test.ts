import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execSync } from "child_process";
import Database from "better-sqlite3";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import type { AiStreamEvent } from "./ai-engine-types";
// (test doubles below yield provider stream events, typed via AiStreamEvent)

import { db, sqlite } from "../db/index.ts";
import {
  artifacts,
  artifactMirrors,
  apiSnapshots,
  battleRounds,
  blueGapReviews,
  briefingQuestions,
  buildRunRecords,
  changes,
  changeProviderSessions,
  events,
  findings,
  humanDecisions,
  legacyImports,
  mergeApprovals,
  mergeBlockers,
  mergeDecisions,
  mergeReadiness,
  planApprovals,
  planRisks,
  planSnapshots,
  planSteps,
  prdBriefings,
  prdDrafts,
  pipelineJobs,
  providerRunProcesses,
  redFixClaims,
  projects,
  releaseNoteState,
  requiredValidationCommands,
  requirementGaps,
  runs,
  reviewAttempts,
  reviewArtifactMirrors,
  reviewReports,
  reviewPriorFindingReviews,
  reviewState,
  qaCommandResults,
  qaEvidence,
  qaFailures,
  qaRuns,
  warReports,
  stageActions,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
  techspecSnapshots,
  testplanCoverageItems,
  testplanManualChecks,
  testplanRiskMappings,
  testplanSnapshots,
} from "../db/schema.ts";
import type { ChangeStatus } from "../types/enums.ts";
import {
  runCheck,
  assertCanRunCheck,
  approvePlan,
  emitPrdBriefingAsyncFailureProgress,
  generatePlan,
  runImplement,
  runImplementStreamed,
  runIntake,
  runPrdBriefingDraft,
  runPrdBriefingFinalReview,
  runPrdBriefingQuestions,
  runDelivery,
  runRelease,
  runRetro,
  runReview,
  runSpec,
  runTechSpec,
  runTestPlan,
  runFix,
  runFixStreamed,
  approveBuildAbsorb,
  approveFixAbsorb,
  rejectBuildRun,
  retryBuildStreamed,
  resolveReviewTimeoutMs,
  documentStageTimeoutCleanupGraceMs,
  documentStageTimeoutMs,
  documentStageWatchdogTimeoutMs,
  MAX_DOCUMENT_STAGE_TIMEOUT_CLEANUP_GRACE_MS,
  MAX_NODE_TIMER_DELAY_MS,
  setDocumentStageTimeoutMsForTest,
  setDocumentStageTimeoutCleanupGraceMsForTest,
  setPipelineEngineFactoryForTest,
  setReviewTimeoutMsForTest,
} from "./pipeline-service.ts";
import {
  setBuildProviderLivenessForTest,
  setBuildStaleRunClockForTest,
} from "./build-stale-run-recovery-service.ts";
import { recordBuildRunFromWorkspaceFile } from "./build-run-record-service.ts";
import { approveGate, gateApprovalActionId, type GateName } from "./gate-service.ts";
import { computeActions, getActions } from "./action-contract-service.ts";
import { runStageWithLedger } from "./stage-orchestrator-service.ts";
import { StageBoundaryViolationError } from "./pipeline-run-ledger-service.ts";
import {
  computeSourceDbHash,
  recomputeStageGate,
  setStageAuthorityServiceDbForTest,
  type PipelinePhase,
} from "./stage-authority-service.ts";
import { setTechSpecApiSnapshotServiceDbForTest } from "./techspec-api-snapshot-service.ts";
import { regeneratePlanReport } from "./plan-sandbox-service.ts";
import {
  applyBriefingQuestionAction,
  completePrdDraft,
  completeQuestionGeneration,
  getPrdBriefingState,
  savePrdIntent,
} from "./prd-briefing-service.ts";
import { startSpecBattleRound } from "./spec-battle-service.ts";
import { getSpecReportFreshness } from "./spec-battle-report-service.ts";
import {
  approveBuildForAbsorb,
  readLatestBuildRun,
  writeBuildRun,
  type BuildRunFile,
  type BuildRunStatus,
} from "./build-workspace-service.ts";
import { readBuildRunByNumber } from "./build-workspace-run-store.ts";
import { PROJECT_RUBRIC_DELETE_PLAN } from "./rubric-service.ts";
import { computeMergeReadiness } from "./merge-readiness-service.ts";
import { hasUncommittedChanges } from "./git-service.ts";
import { getReviewCenterState } from "./review-center-service.ts";
import type { StageProgressEventPayload } from "./stage-ai-output-contract.ts";
import type { AiRunLifecycleSink } from "./ai-engine-types.ts";
import {
  StaleLeaseFenceError,
  type JobExecutionContext,
} from "./job-execution-context.ts";
import { runLedgerRepository } from "../repositories/run-ledger-repository.ts";
import { getPlanSandboxState } from "./plan-sandbox-service.ts";
import { ActionContractDriftError, enqueueProviderActionAtomically } from "./job-dispatch-service.ts";
import { evaluateProviderActionAuthority } from "./provider-action-authority-service.ts";

const PROJECT_ID = "PRJ-T27";
const CHANGE_ID = "CHG-T27";
const PLAN_APPROVAL_CONTEXT = { source: "route_preflight" } as const;
let testJobExecutionContextSequence = 0;

function makeTestJobExecutionContext(
  label: string,
  overrides: Partial<JobExecutionContext> = {},
): JobExecutionContext {
  testJobExecutionContextSequence += 1;
  const key = `${label}-${testJobExecutionContextSequence}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");
  const attemptNo = overrides.attemptNo ?? 1;

  const context = {
    jobId: overrides.jobId ?? `PJOB-T27-${key}`,
    workerId: overrides.workerId ?? `pipeline-worker-t27-${key}`,
    leaseToken: overrides.leaseToken ?? `lease-token-t27-${key}-attempt-${attemptNo}`,
    attemptNo,
  };

  const now = "2026-07-10T10:00:00.000Z";
  const phase = key.includes("prd-questions") ? "prd_briefing_questions"
    : key.includes("prd-draft") ? "prd_briefing_draft"
      : key.includes("prd-final") ? "prd_briefing_final_review"
        : key.includes("review") ? "review"
    : key.includes("fix") ? "fix_findings"
      : key.includes("build") || key.includes("implement") ? "implement"
        : key.includes("qa") || key.includes("check") ? "local_check"
          : key.includes("plan") ? "generate_plan"
            : key.includes("tech") ? "tech_spec"
              : key.includes("spec") ? "spec"
                : "intake";
  const actionId = phase === "prd_briefing_questions" ? "run_prd_briefing_questions"
    : phase === "prd_briefing_draft" ? "run_prd_briefing_draft"
      : phase === "prd_briefing_final_review" ? "run_prd_briefing_final_review"
        : phase === "review" ? "run_review"
    : phase === "fix_findings" ? "run_fix"
      : phase === "implement" ? "run_build"
        : phase === "local_check" ? "run_qa"
          : phase === "generate_plan" ? "run_plan"
            : phase === "tech_spec" ? "run_tech_spec"
              : phase === "spec" ? "run_spec"
                : "run_prd_briefing_questions";
  db.update(pipelineJobs).set({
    status: "succeeded",
    endedAt: now,
  }).where(and(
    eq(pipelineJobs.changeId, CHANGE_ID),
    eq(pipelineJobs.phase, phase),
    inArray(pipelineJobs.status, ["queued", "leased", "running"]),
  )).run();
  db.insert(pipelineJobs).values({
    id: context.jobId,
    changeId: CHANGE_ID,
    phase,
    actionId,
    idempotencyKey: context.jobId,
    status: "running",
    leasedBy: context.workerId,
    leaseExpiresAt: "2099-07-10T10:30:00.000Z",
    heartbeatAt: now,
    attemptNo: context.attemptNo,
    errorCode: null,
    errorSummary: null,
    createdAt: "2026-07-10T09:59:00.000Z",
    startedAt: now,
    endedAt: null,
    leaseToken: context.leaseToken,
    workerNonce: `worker-nonce-${key}`,
  }).run();

  const seededFence = db.select({
    status: pipelineJobs.status,
    leasedBy: pipelineJobs.leasedBy,
    leaseToken: pipelineJobs.leaseToken,
    attemptNo: pipelineJobs.attemptNo,
  }).from(pipelineJobs).where(eq(pipelineJobs.id, context.jobId)).get();
  assert.deepEqual(seededFence, {
    status: "running",
    leasedBy: context.workerId,
    leaseToken: context.leaseToken,
    attemptNo: context.attemptNo,
  });

  return context;
}

function settleTestPipelineJob(
  context: JobExecutionContext,
  status: "succeeded" | "failed" = "succeeded",
): void {
  db.update(pipelineJobs).set({
    status,
    endedAt: new Date().toISOString(),
    leaseExpiresAt: null,
  }).where(eq(pipelineJobs.id, context.jobId)).run();
}

function cleanupRows() {
  db.delete(apiSnapshots).where(eq(apiSnapshots.changeId, CHANGE_ID)).run();
  db.delete(techspecSnapshots).where(eq(techspecSnapshots.changeId, CHANGE_ID)).run();
  db.delete(stageActions).where(eq(stageActions.changeId, CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
  db.delete(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
  db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
  const planSnapshotIds = db
    .select({ id: planSnapshots.id })
    .from(planSnapshots)
    .where(eq(planSnapshots.changeId, CHANGE_ID))
    .all()
    .map((snapshot) => snapshot.id);
  for (const planSnapshotId of planSnapshotIds) {
    db.delete(planSteps).where(eq(planSteps.planSnapshotId, planSnapshotId)).run();
    db.delete(planRisks).where(eq(planRisks.planSnapshotId, planSnapshotId)).run();
    db.delete(planApprovals).where(eq(planApprovals.planSnapshotId, planSnapshotId)).run();
  }
  db.delete(requiredValidationCommands)
    .where(eq(requiredValidationCommands.changeId, CHANGE_ID))
    .run();
  const testplanSnapshotIds = db
    .select({ id: testplanSnapshots.id })
    .from(testplanSnapshots)
    .where(eq(testplanSnapshots.changeId, CHANGE_ID))
    .all()
    .map((snapshot) => snapshot.id);
  for (const snapshotId of testplanSnapshotIds) {
    db.delete(testplanManualChecks)
      .where(eq(testplanManualChecks.testplanSnapshotId, snapshotId))
      .run();
    db.delete(testplanRiskMappings)
      .where(eq(testplanRiskMappings.testplanSnapshotId, snapshotId))
      .run();
    db.delete(testplanCoverageItems)
      .where(eq(testplanCoverageItems.testplanSnapshotId, snapshotId))
      .run();
  }
  db.delete(testplanSnapshots).where(eq(testplanSnapshots.changeId, CHANGE_ID)).run();
  db.delete(planSnapshots).where(eq(planSnapshots.changeId, CHANGE_ID)).run();
  db.delete(legacyImports).where(eq(legacyImports.changeId, CHANGE_ID)).run();
  db.delete(buildRunRecords).where(eq(buildRunRecords.changeId, CHANGE_ID)).run();
  db.delete(warReports).where(eq(warReports.changeId, CHANGE_ID)).run();
  const mergeReadinessIds = db
    .select({ id: mergeReadiness.id })
    .from(mergeReadiness)
    .where(eq(mergeReadiness.changeId, CHANGE_ID))
    .all()
    .map((row) => row.id);
  for (const readinessId of mergeReadinessIds) {
    db.delete(mergeDecisions).where(eq(mergeDecisions.readinessId, readinessId)).run();
    db.delete(mergeBlockers).where(eq(mergeBlockers.mergeReadinessId, readinessId)).run();
  }
  db.delete(mergeDecisions).where(eq(mergeDecisions.changeId, CHANGE_ID)).run();
  db.delete(mergeApprovals).where(eq(mergeApprovals.changeId, CHANGE_ID)).run();
  db.delete(mergeReadiness).where(eq(mergeReadiness.changeId, CHANGE_ID)).run();
  db.delete(redFixClaims).where(eq(redFixClaims.changeId, CHANGE_ID)).run();
  db.delete(blueGapReviews).where(eq(blueGapReviews.changeId, CHANGE_ID)).run();
  db.delete(requirementGaps).where(eq(requirementGaps.changeId, CHANGE_ID)).run();
  db.delete(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).run();
  const attemptIds = db
    .select({ id: reviewAttempts.id })
    .from(reviewAttempts)
    .where(eq(reviewAttempts.changeId, CHANGE_ID))
    .all()
    .map((attempt) => attempt.id);
  for (const attemptId of attemptIds) {
    db.delete(reviewPriorFindingReviews)
      .where(eq(reviewPriorFindingReviews.attemptId, attemptId))
      .run();
  }
  const qaRunIds = db
    .select({ id: qaRuns.id })
    .from(qaRuns)
    .where(eq(qaRuns.changeId, CHANGE_ID))
    .all()
    .map((run) => run.id);
  for (const qaRunId of qaRunIds) {
    db.delete(qaEvidence).where(eq(qaEvidence.qaRunId, qaRunId)).run();
    db.delete(qaFailures).where(eq(qaFailures.qaRunId, qaRunId)).run();
    db.delete(qaCommandResults).where(eq(qaCommandResults.qaRunId, qaRunId)).run();
  }
  db.delete(qaRuns).where(eq(qaRuns.changeId, CHANGE_ID)).run();
  // Must follow the QA rows: qa_command_results.output_artifact_mirror_id and
  // qa_evidence.artifact_mirror_id now carry real FKs into artifact_mirrors.
  db.delete(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).run();
  db.delete(reviewArtifactMirrors).where(eq(reviewArtifactMirrors.changeId, CHANGE_ID)).run();
  db.delete(reviewState).where(eq(reviewState.changeId, CHANGE_ID)).run();
  db.delete(reviewReports).where(eq(reviewReports.changeId, CHANGE_ID)).run();
  db.delete(findings).where(eq(findings.changeId, CHANGE_ID)).run();
  db.delete(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).run();
  db.delete(humanDecisions).where(eq(humanDecisions.changeId, CHANGE_ID)).run();
  // Must precede artifacts/runs/changes: release_note_state FKs into all three.
  db.delete(releaseNoteState).where(eq(releaseNoteState.changeId, CHANGE_ID)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
  db.delete(providerRunProcesses).where(eq(providerRunProcesses.changeId, CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(changeProviderSessions).where(eq(changeProviderSessions.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).run();
  db.delete(prdDrafts).where(eq(prdDrafts.changeId, CHANGE_ID)).run();
  db.delete(briefingQuestions).where(eq(briefingQuestions.changeId, CHANGE_ID)).run();
  db.delete(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).run();
  // Batch 6: every stage that resolves a rubric now seeds this project's factory
  // rubrics. Must precede BOTH deletes below -- `rubric_assessments.change_id`
  // references `changes.id` and `rubrics.project_id` references `projects.id`,
  // so either one raises SQLITE_CONSTRAINT_FOREIGNKEY while these rows exist.
  // Reuses the very plan deleteProject runs rather than hand-listing the three
  // tables, so a future rubric table cannot go missing from one of the lists.
  for (const step of PROJECT_RUBRIC_DELETE_PLAN) {
    db.run(sql`DELETE FROM ${sql.identifier(step.table)} WHERE ${step.where(PROJECT_ID)}`);
  }
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function gatePhase(gate: GateName): PipelinePhase {
  if (gate === "intake") return "PRD";
  if (gate === "spec") return "Spec";
  if (gate === "tech_spec") return "TechSpec";
  return "Merge";
}

function seedApprovalStageGate(gate: GateName): void {
  const phase = gatePhase(gate);
  recomputeStageGate({
    changeId: CHANGE_ID,
    phase,
    status: "passed",
    blockers: [],
    freshness: { fresh: true },
    requiredActions: [],
    rows: [{ table: "changes", id: CHANGE_ID, phase }],
  });
}

function seedMergePrerequisiteStageGates(): void {
  for (const phase of ["PRD", "Spec", "Plan", "TestPlan", "Build", "Review", "QA"] as PipelinePhase[]) {
    recomputeStageGate({
      changeId: CHANGE_ID,
      phase,
      status: "passed",
      blockers: [],
      freshness: { fresh: true },
      requiredActions: [],
      rows: [{ table: "changes", id: CHANGE_ID, phase }],
    });
  }
}

function gateApprovalPreflight(gate: GateName) {
  const actionId = gateApprovalActionId(gate);
  const action = getActions(CHANGE_ID).find((candidate) => candidate.actionId === actionId);
  assert.ok(action, `${actionId} action should exist`);
  return {
    expectedGateVersion: action.gateVersion,
    expectedSourceDbHash: action.sourceDbHash,
    idempotencyKey: `${actionId}-pipeline-test`,
  };
}

async function waitForPipelineCondition(assertion: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (!assertion()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for pipeline condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function approveGateWithContract(gate: GateName): Promise<void> {
  await approveGate(CHANGE_ID, gate, gateApprovalPreflight(gate));
}

function seedChange(repoPath: string, status: ChangeStatus) {
  const now = new Date().toISOString();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Pipeline T2.7",
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
    title: "Pipeline stage",
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
  if (status !== "INTAKE_PENDING" && status !== "DRAFT") {
    seedLockedPrdAuthority(repoPath);
  }
  if (
    [
      "PLAN_APPROVED",
      "TESTPLAN_DONE",
      "IMPLEMENTING",
      "IMPLEMENTED",
      "CHECKING",
      "CHECK_FAILED",
      "SCOPE_FAILED",
      "MERGE_READY",
      "RETRO_PENDING",
      "DONE",
    ].includes(status)
  ) {
    seedDesignSnapshots();
  }
}

/**
 * Seeds the full post-release authority chain that resolveRetroActionAuthority
 * requires before runRetro may start: a passing Merge gate, exactly one
 * completed release run, and a release_note artifact whose DB path matches the
 * real on-disk run mirror and current mirror byte-for-byte.
 */
function seedRetroReleaseAuthority(repoPath: string): void {
  const now = new Date().toISOString();
  const releaseRunId = "RUN-RETRO-RELEASE";
  db.insert(stageGates).values({
    id: "GATE-RETRO-MERGE",
    changeId: CHANGE_ID,
    phase: "Merge",
    status: "passed",
    blockersJson: "[]",
    freshnessJson: "{\"fresh\":true}",
    requiredActionsJson: "[]",
    sourceDbHash: "retro-merge-source-hash",
    gateVersion: 1,
    computedAt: now,
  }).run();
  db.insert(runs).values({
    id: releaseRunId,
    changeId: CHANGE_ID,
    phase: "release",
    status: "completed",
    startedAt: now,
    endedAt: now,
    summary: "release completed for retro authority",
  }).run();
  const changeDir = path.join(path.resolve(repoPath), ".ship", "changes", CHANGE_ID);
  const runDir = path.join(changeDir, "runs", releaseRunId);
  fs.mkdirSync(runDir, { recursive: true });
  const releaseNote = "# Release note\n\nRetro authority fixture.\n";
  const runNotePath = path.join(runDir, "release-note.md");
  fs.writeFileSync(runNotePath, releaseNote);
  fs.writeFileSync(path.join(changeDir, "release-note.md"), releaseNote);
  db.insert(artifacts).values({
    id: "ART-RETRO-RELEASE-NOTE",
    changeId: CHANGE_ID,
    runId: releaseRunId,
    type: "release_note",
    path: runNotePath,
    createdAt: now,
  }).run();
  db.insert(releaseNoteState).values({
    id: "RNS-RETRO-RELEASE-NOTE",
    changeId: CHANGE_ID,
    runId: releaseRunId,
    artifactId: "ART-RETRO-RELEASE-NOTE",
    approvedContentHash: createHash("sha256").update(releaseNote).digest("hex"),
    createdAt: now,
  }).run();
}

function seedApprovedTestPlanSnapshot() {
  const now = new Date().toISOString();
  db.insert(testplanSnapshots).values({
    id: "TESTPLAN-PIPELINE",
    changeId: CHANGE_ID,
    status: "approved",
    testIntent: "Pipeline fixture TestPlan.",
    schemaVersion: "testplan/v1",
    approvalState: "approved",
    snapshotDbHash: "pipeline-testplan-db-hash",
    approvedAt: now,
    approvalDecisionId: null,
    createdAt: now,
  }).run();
  db.insert(requiredValidationCommands).values({
    id: "TESTPLAN-PIPELINE-CMD",
    changeId: CHANGE_ID,
    phase: "TestPlan",
    sourceSnapshotId: "TESTPLAN-PIPELINE",
    command: "node -e \"console.log('pipeline testplan command')\"",
    commandOrder: 1,
    required: 1,
    createdAt: now,
  }).run();
  recomputeStageGate({
    changeId: CHANGE_ID,
    phase: "TestPlan",
    status: "passed",
    blockers: [],
    freshness: { fresh: true },
    requiredActions: ["run_build"],
    sourceDbHash: "pipeline-testplan-db-hash",
  });
}

function refreshQaTestPlanGateFromRows() {
  const snapshot = db.select().from(testplanSnapshots)
    .where(eq(testplanSnapshots.changeId, CHANGE_ID)).get()!;
  const sourceDbHash = computeSourceDbHash({
    changeId: CHANGE_ID,
    phase: "TestPlan",
    rows: [
      snapshot,
      ...db.select().from(testplanCoverageItems)
        .where(eq(testplanCoverageItems.testplanSnapshotId, snapshot.id)).all(),
      ...db.select().from(testplanRiskMappings)
        .where(eq(testplanRiskMappings.testplanSnapshotId, snapshot.id)).all(),
      ...db.select().from(requiredValidationCommands)
        .where(eq(requiredValidationCommands.sourceSnapshotId, snapshot.id)).all(),
      ...db.select().from(testplanManualChecks)
        .where(eq(testplanManualChecks.testplanSnapshotId, snapshot.id)).all(),
    ],
  });
  recomputeStageGate({
    changeId: CHANGE_ID, phase: "TestPlan", status: "passed", blockers: [],
    freshness: { fresh: true }, requiredActions: ["run_build"], sourceDbHash,
  });
}

function seedLockedPrdAuthority(repoPath: string, idSuffix = "PIPELINE") {
  const existing = db.select().from(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).get();
  if (existing) return;
  const now = new Date().toISOString();
  const briefing = {
    id: `PBR-${idSuffix}`,
    changeId: CHANGE_ID,
    status: "locked",
    intentText: "Pipeline test locked PRD.",
    finalReviewJson: JSON.stringify({
      verdict: "ready",
      blockingQuestionIds: [],
      riskSummary: "No fixture blockers.",
      recommendedNextAction: "lock_prd",
    }),
    sourceHashesJson: JSON.stringify({
      currentInputHash: "pipeline-fixture-input",
      draftInputHash: "pipeline-fixture-input",
      finalReviewInputHash: "pipeline-fixture-input",
      finalReviewDraftHash: "pipeline-fixture-draft",
    }),
    lockedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const question = {
    id: `BQ-${idSuffix}`,
    changeId: CHANGE_ID,
    category: "scope",
    severity: "important",
    question: "What is the rollout owner?",
    whyItMatters: "Ownership affects acceptance.",
    suggestedDefault: "Project owner.",
    status: "deferred",
    answer: "Handled by pipeline fixture.",
    source: "ai_blue",
    createdAt: now,
    updatedAt: now,
  };
  const draft = {
    id: `PDR-${idSuffix}`,
    changeId: CHANGE_ID,
    version: 1,
    markdown: "# DB PRD Draft\n\nPipeline fixture PRD.\n",
    sourceQuestionIdsJson: JSON.stringify([question.id]),
    unresolvedQuestionIdsJson: JSON.stringify([question.id]),
    draftHash: "pipeline-fixture-draft",
    createdAt: now,
  };
  db.insert(prdBriefings).values(briefing).run();
  db.insert(briefingQuestions).values(question).run();
  db.insert(prdDrafts).values(draft).run();
  const sourceDbHash = computeSourceDbHash({
    changeId: CHANGE_ID,
    phase: "PRD",
    rows: [
      { table: "prd_briefings", row: briefing },
      { table: "briefing_questions", rows: [question] },
      { table: "prd_drafts.latest", row: draft },
    ],
  });
  recomputeStageGate({
    changeId: CHANGE_ID,
    phase: "PRD",
    status: "pass",
    blockers: [],
    freshness: { source: "db", lockedAt: now },
    requiredActions: [],
    sourceDbHash,
  });
  fs.mkdirSync(path.join(repoPath, ".ship", "changes", CHANGE_ID), { recursive: true });
}

function seedDesignSnapshots() {
  const existing = db
    .select()
    .from(techspecSnapshots)
    .where(eq(techspecSnapshots.changeId, CHANGE_ID))
    .get();
  if (existing) return;
  const now = new Date().toISOString();
  const content = {
    interfaces: [{ method: "GET", endpoint: "/api/projects/:id" }],
    dataContracts: [{ response: "ProjectResponse", requiredFields: ["actions"] }],
    migrationNotes: [],
    buildInputs: ["Preserve DB-first design contract."],
    reviewInputs: ["Verify DB-first design contract."],
  };
  const techHash = "pipeline-techspec-db-hash";
  const apiHash = "pipeline-api-db-hash";
  db.insert(techspecSnapshots).values({
    id: "TECHSPEC-PIPELINE",
    changeId: CHANGE_ID,
    status: "approved",
    sourceSpecHash: "pipeline-spec-hash",
    contentJson: `${JSON.stringify(content, null, 2)}\n`,
    contentDbHash: techHash,
    schemaVersion: "techspec/v1",
    reviewedAt: now,
    createdAt: now,
  }).run();
  db.insert(apiSnapshots).values({
    id: "API-PIPELINE",
    changeId: CHANGE_ID,
    status: "approved",
    sourceTechspecHash: techHash,
    contractJson: `${JSON.stringify(content, null, 2)}\n`,
    contractDbHash: apiHash,
    schemaVersion: "api/v1",
    reviewedAt: now,
    createdAt: now,
  }).run();
}

function currentStatus(): ChangeStatus {
  const row = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
  assert.ok(row);
  return row.status as ChangeStatus;
}

function seedRunningPipelineJob(
  phase: "intake" | "generate_plan" | "implement" | "review" | "local_check" | "fix_findings",
  actionId:
    | "run_prd_briefing_questions"
    | "run_prd_briefing_draft"
    | "run_prd_briefing_final_review"
    | "run_plan"
    | "run_build"
    | "run_review"
    | "run_qa"
    | "run_fix",
  context: JobExecutionContext,
): void {
  const now = "2026-07-10T10:00:00.000Z";
  db.insert(pipelineJobs).values({
    id: context.jobId,
    changeId: CHANGE_ID,
    phase,
    actionId,
    idempotencyKey: `${phase}-lifecycle-test`,
    status: "running",
    leasedBy: context.workerId,
    leaseExpiresAt: "2099-07-10T10:30:00.000Z",
    heartbeatAt: now,
    attemptNo: context.attemptNo,
    errorCode: null,
    errorSummary: null,
    createdAt: "2026-07-10T09:59:00.000Z",
    startedAt: now,
    endedAt: null,
    leaseToken: context.leaseToken,
    workerNonce: "worker-nonce-t27",
  }).run();
}

function takeOverPipelineJob(
  staleContext: JobExecutionContext,
  label: string,
): JobExecutionContext {
  const currentContext: JobExecutionContext = {
    jobId: staleContext.jobId,
    workerId: `pipeline-worker-t27-${label}-attempt-2`,
    leaseToken: `lease-token-t27-${label}-attempt-2`,
    attemptNo: staleContext.attemptNo + 1,
  };
  const result = db.update(pipelineJobs).set({
    leasedBy: currentContext.workerId,
    leaseToken: currentContext.leaseToken,
    attemptNo: currentContext.attemptNo,
    workerNonce: `worker-nonce-${label}-attempt-2`,
  }).where(eq(pipelineJobs.id, staleContext.jobId)).run();
  assert.equal(result.changes, 1);
  return currentContext;
}

async function emitProviderLifecycle(
  lifecycle: AiRunLifecycleSink | undefined,
  status: "completed" | "failed",
  label: string,
): Promise<void> {
  assert.ok(lifecycle);
  const started = {
    provider: "codex" as const,
    pid: null,
    ppid: process.pid,
    externalRef: `${label}-thread`,
    startedAt: "2026-07-10T10:01:00.000Z",
  };
  const terminal = {
    provider: "codex" as const,
    pid: null,
    status,
    summary: `${label} ${status}`,
    endedAt: "2026-07-10T10:03:00.000Z",
  };
  await lifecycle.onProcessStarted(started);
  await lifecycle.onProcessStarted(started);
  await lifecycle.onHeartbeat({
    provider: "codex",
    pid: null,
    externalRef: `${label}-thread`,
    observedAt: "2026-07-10T10:02:00.000Z",
  });
  await lifecycle.onTerminal(terminal);
  await lifecycle.onTerminal(terminal);
  await lifecycle.onHeartbeat({
    provider: "codex",
    pid: null,
    externalRef: `${label}-thread`,
    observedAt: "2026-07-10T10:04:00.000Z",
  });
}

function assertProviderLifecycle(
  phase: "intake" | "generate_plan" | "implement" | "review" | "fix_findings",
  terminalStatus: "completed" | "failed",
  context: JobExecutionContext,
): void {
  const run = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
    .filter((candidate) => candidate.phase === phase)
    .at(-1);
  assert.ok(run);
  assert.equal(run.jobId, context.jobId);
  assert.equal(run.workerId, context.workerId);
  assert.equal(run.leaseToken, context.leaseToken);
  assert.equal(run.attemptNo, context.attemptNo);
  const processRow = db.select().from(providerRunProcesses)
    .where(eq(providerRunProcesses.runId, run.id))
    .get();
  assert.equal(processRow?.status, terminalStatus);
  assert.equal(processRow?.jobId, context.jobId);
  assert.equal(processRow?.leaseToken, context.leaseToken);

  const providerEvents = db.select().from(events).where(eq(events.runId, run.id)).all();
  assert.equal(providerEvents.filter((event) => event.type === "provider_process_started").length, 1);
  assert.equal(
    providerEvents.filter((event) => [
      "provider_process_ended",
      "provider_process_failed",
      "provider_process_stopped",
      "provider_process_orphaned",
    ].includes(event.type)).length,
    1,
  );
  const job = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, context.jobId)).get();
  assert.equal(job?.heartbeatAt, "2026-07-10T10:02:00.000Z");
}

function currentChange() {
  const row = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
  assert.ok(row);
  return row;
}

function artifactExists(repoPath: string, fileName: string): boolean {
  return fs.existsSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, fileName));
}

function stageRawOutputRows() {
  return db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
    .filter((event) => event.type === "stage_raw_output" && event.rawJson);
}

function latestStageRawOutputPayload(): Record<string, unknown> {
  const row = stageRawOutputRows().at(-1);
  assert.ok(row?.rawJson);
  const parsed = JSON.parse(row.rawJson) as { stageRawOutput?: Record<string, unknown> };
  assert.ok(parsed.stageRawOutput);
  return parsed.stageRawOutput;
}

function latestSpecRunRawCapturePath(repoPath: string): string {
  const specRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
    .filter((run) => run.phase === "spec")
    .at(-1);
  assert.ok(specRun);
  return path.join(
    repoPath,
    ".ship",
    "changes",
    CHANGE_ID,
    "runs",
    specRun.id,
    "raw-ai-output.json",
  );
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function latestStageProgress(): StageProgressEventPayload | null {
  const row = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
    .filter((event) => event.type === "stage_progress" && event.rawJson)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  if (!row?.rawJson) return null;
  const parsed = JSON.parse(row.rawJson) as { stageProgress?: StageProgressEventPayload };
  return parsed.stageProgress ?? null;
}

function stageProgressEvents(): StageProgressEventPayload[] {
  return db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
    .filter((event) => event.type === "stage_progress" && event.rawJson)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .flatMap((event) => {
      const parsed = JSON.parse(event.rawJson ?? "{}") as { stageProgress?: StageProgressEventPayload };
      return parsed.stageProgress ? [parsed.stageProgress] : [];
    });
}

async function seedPrdDraftPrerequisites(): Promise<void> {
  await savePrdIntent({ changeId: CHANGE_ID, rawText: "构建一个 PRD briefing room。" });
  await completeQuestionGeneration({
    changeId: CHANGE_ID,
    questionsOutput: {
      questions: [
        {
          category: "goal",
          severity: "important",
          question: "成功标准是什么？",
          whyItMatters: "PRD draft requires an AI question round before drafting.",
          suggestedDefault: "用户可以锁定 PRD。",
        },
      ],
    },
  });
}

type StructuredPlan = {
  planName: string;
  expectedFiles: string[];
  forbiddenFiles: string[];
  implementationSteps: Array<{
    step: number;
    description: string;
    file: string;
    status: "pending" | "blocked" | "done";
  }>;
  testPlan: string[];
  validationCommands: string[];
  risks: string[];
};

function validStructuredPlan(overrides: Partial<StructuredPlan> = {}): StructuredPlan {
  return {
    planName: "Pipeline plan gate hardening",
    expectedFiles: ["server/services/pipeline-service.ts", "server/services/pipeline-service.test.ts"],
    forbiddenFiles: ["app/**"],
    implementationSteps: [
      {
        step: 1,
        description: "Harden the pipeline plan gate.",
        file: "server/services/pipeline-service.ts",
        status: "pending",
      },
      {
        step: 2,
        description: "Cover the gate behavior with tests.",
        file: "server/services/pipeline-service.test.ts",
        status: "blocked",
      },
    ],
    testPlan: ["npm test -- server/services/pipeline-service.test.ts"],
    validationCommands: ["npm test -- server/services/pipeline-service.test.ts"],
    risks: [],
    ...overrides,
  };
}

/**
 * Serializes a StructuredPlan into generate_plan line-protocol text: with the
 * plan stage on the line protocol, mocked engines speak protocol lines in
 * `summary` and stagepass assembles the JSON — model-authored structuredOutput
 * is not accepted.
 */
function planLineProtocolText(plan: StructuredPlan = validStructuredPlan()): string {
  const lines = [`PLAN: ${plan.planName}`];
  for (const file of plan.expectedFiles ?? []) lines.push(`EXPECT: ${file}`);
  for (const file of plan.forbiddenFiles ?? []) lines.push(`FORBID: ${file}`);
  for (const step of plan.implementationSteps ?? []) {
    lines.push(`STEP: ${step.step} | ${step.file} | ${step.status ?? "pending"} | ${step.description}`);
  }
  for (const item of plan.testPlan ?? []) lines.push(`TEST: ${item}`);
  for (const command of plan.validationCommands ?? []) lines.push(`COMMAND: ${command}`);
  for (const risk of plan.risks ?? []) lines.push(`RISK: ${risk}`);
  return lines.join("\n");
}

/**
 * Line-protocol form of validStructuredTestPlan: with the test_plan stage on
 * the line protocol, mocked engines speak protocol lines in `summary` and the
 * runner assembles the JSON — model-authored structuredOutput is not accepted.
 */
function validTestPlanLineProtocolText() {
  return [
    "INTENT: Verify pipeline QA uses DB TestPlan commands.",
    "COVERAGE: qa-db-commands | QA command list comes from required_validation_commands | Task 9 | integration | P0",
    "RISK: qa-db-commands | markdown-command-bypass | P0 | Required commands are persisted in DB order.",
    "COMMAND!: node -e \"console.log('testplan db command')\"",
    "MANUAL!: TestPlan mirror is informational only | Do not use Markdown to decide QA entry.",
  ].join("\n");
}

/**
 * Line-protocol form of the delivery (Done) reply. The delivery note's section
 * 4.1 is generated from the database and has no slot in this text on purpose.
 */
function validDeliveryLineProtocolText() {
  return [
    "HOW_TO_RUN<<",
    "在仓库根目录执行 `node src/app.ts`。",
    ">>HOW_TO_RUN",
    "WHAT_CHANGED<<",
    "更新了 app 的返回值；运行入口后应看到新的值。",
    ">>WHAT_CHANGED",
    "FILEMAP: src/app.ts | entry | 应用入口",
    "KNOWN_LIMITS<<",
    "本次没有明确排除的范围；没有踩到已知坑。",
    ">>KNOWN_LIMITS",
    "DELIVERY_DONE: true",
  ].join("\n");
}

/**
 * Line-protocol form of the tech_spec reply. tech_spec was the last document
 * stage still asking the model for a JSON object and the only one with no
 * outputSchema at all, so mocked engines used to return `structuredOutput`
 * directly; with the stage on the line protocol that is refused by
 * guardLineProtocolSchema and the protocol text in `summary` is the only input.
 *
 * `includeApi: false` writes no API_* line, which is the shape that exercises
 * deriveApiContractFromTechSpec -- the branch every real change has taken so
 * far (CHG-001's api_snapshots.contract_json is byte-identical to its
 * techspec_snapshots.content_json).
 */
function validTechSpecLineProtocolText({ includeApi = true }: { includeApi?: boolean } = {}) {
  const lines = [
    "INTERFACE: GET /api/projects/:id | http | Preserve the response shape and keep actions present",
    "CONTRACT: ProjectResponse | actions | actions 至少一项",
    "MIGRATION: No destructive migration required.",
    "BUILD: Use DB design snapshot.",
    "REVIEW: Review DB design snapshot.",
  ];
  if (includeApi) {
    lines.push(
      "API_INTERFACE: GET /api/projects/:id | http | Keep the actions response field",
      "API_CONTRACT: ProjectResponse | actions | actions 至少一项",
      "API_BUILD: Keep actions response field.",
      "API_REVIEW: Verify actions response field.",
    );
  }
  return lines.join("\n");
}

function validStructuredTestPlan() {
  return {
    testIntent: "Verify pipeline QA uses DB TestPlan commands.",
    coverageItems: [
      {
        itemKey: "qa-db-commands",
        title: "QA command list comes from required_validation_commands",
        requirementRef: "Task 9",
        testType: "integration",
        priority: "P0",
      },
    ],
    riskMappings: [
      {
        coverageItemKey: "qa-db-commands",
        riskRef: "markdown-command-bypass",
        severity: "P0",
        mitigation: "Required commands are persisted in DB order.",
      },
    ],
    requiredCommands: [
      {
        command: "node -e \"console.log('testplan db command')\"",
        required: true,
      },
    ],
    manualChecks: [
      {
        title: "TestPlan mirror is informational only",
        description: "Do not use Markdown to decide QA entry.",
        required: true,
      },
    ],
  };
}

function validReviewOutput(
  overrides: Partial<{
    approved: boolean;
    findings: unknown[];
    priorFindingReviews: unknown[];
    summary: string;
  }> = {},
) {
  return {
    approved: true,
    findings: [],
    priorFindingReviews: [],
    summary: "review passed",
    ...overrides,
  };
}

/**
 * Serializes a review output object into review line-protocol text: with the
 * review stage on the line protocol, mocked engines speak FINDING/PRIOR/
 * APPROVED lines plus a SUMMARY<< … >> block in `summary`, and stagepass
 * assembles the JSON — model-authored structuredOutput is not accepted.
 */
function reviewLineProtocolText(
  output: ReturnType<typeof validReviewOutput> = validReviewOutput(),
): string {
  const lines: string[] = [];
  for (const raw of output.findings) {
    const finding = raw as {
      severity: string;
      category: string;
      file?: string | null;
      line?: number | null;
      title?: string | null;
      evidence?: string | null;
      requiredFix?: string | null;
    };
    lines.push(
      `FINDING: ${finding.severity} | ${finding.category} | ${finding.file ?? "-"} | ${
        finding.line ?? "-"
      } | ${finding.title ?? "-"} | ${finding.evidence ?? "-"} | ${finding.requiredFix ?? "-"}`,
    );
  }
  for (const raw of output.priorFindingReviews) {
    const prior = raw as {
      priorFindingId: string;
      verdict: string;
      evidence?: string | null;
      requiredFix?: string | null;
      replacementFindingId?: string | null;
      reviewerNotes?: string | null;
    };
    lines.push(
      `PRIOR: ${prior.priorFindingId} | ${prior.verdict} | ${prior.evidence ?? "-"} | ${
        prior.requiredFix ?? "-"
      } | ${prior.replacementFindingId ?? "-"} | ${prior.reviewerNotes ?? "-"}`,
    );
  }
  lines.push(`APPROVED: ${output.approved}`);
  lines.push("SUMMARY<<");
  lines.push(output.summary);
  lines.push(">>SUMMARY");
  return lines.join("\n");
}

/**
 * Serializes PRD briefing payloads into their line-protocol text. With the
 * three briefing sub-stages on the protocol, mocked engines speak QUESTION /
 * MARKDOWN<< / VERDICT+BLOCKING+NEXT+RISK_SUMMARY<< in `summary` and stagepass
 * assembles the JSON -- model-authored structuredOutput is not accepted.
 * `unit`/`changeId`/`phase` are supplied by stagepass, so they never appear here.
 */
function briefingQuestionsLineProtocolText(
  questions: Array<{
    category: string;
    severity: string;
    question: string;
    whyItMatters: string;
    suggestedDefault?: string | null;
  }>,
): string {
  return questions
    .map(
      (item) =>
        `QUESTION: ${item.category} | ${item.severity} | ${item.question} | ${item.whyItMatters} | ${
          item.suggestedDefault ?? "-"
        }`,
    )
    .join("\n");
}

function prdDraftLineProtocolText(markdown: string): string {
  return `MARKDOWN<<\n${markdown}\n>>MARKDOWN`;
}

function finalReviewLineProtocolText(
  output: {
    verdict: string;
    blockingQuestionIds?: string[];
    riskSummary: string;
    recommendedNextAction: string;
  },
): string {
  return [
    `VERDICT: ${output.verdict}`,
    ...(output.blockingQuestionIds ?? []).map((id) => `BLOCKING: ${id}`),
    `NEXT: ${output.recommendedNextAction}`,
    "RISK_SUMMARY<<",
    output.riskSummary,
    ">>RISK_SUMMARY",
  ].join("\n");
}

function validBlueCritiqueOutput() {
  return {
    gapReviews: [],
    requirementGaps: [],
  };
}

/**
 * Serializes a red draft payload into spec-red line-protocol text.
 * With the Spec writer on the protocol, mocked engines speak one PRD_DELTA
 * block carrying the whole delta document, then FIXCLAIM lines, then the
 * required SPEC_DONE anchor -- all in `summary`, and stagepass assembles the
 * payload. Model-authored structuredOutput is not accepted, so a fixture that
 * returns prose (or the old JSON blob) is rejected as invalid_stage_output
 * rather than silently degrading to "whole reply is the delta, zero claims".
 */
function redSpecLineProtocolText(
  output: {
    markdown?: string;
    fixClaims?: unknown[];
  } = {},
): string {
  const lines: string[] = [
    "PRD_DELTA<<",
    output.markdown ?? "# PRD delta\n\n补齐状态矩阵与导出上限。",
    ">>PRD_DELTA",
  ];
  for (const raw of output.fixClaims ?? []) {
    const claim = raw as {
      canonicalGapId: string;
      claimStatus: string;
      claimSummary: string;
      evidence: string;
      artifactPath?: string | null;
    };
    lines.push(
      `FIXCLAIM: ${claim.canonicalGapId} | ${claim.claimStatus} | ${claim.claimSummary} | ${
        claim.evidence
      } | ${claim.artifactPath ?? "-"}`,
    );
  }
  lines.push("SPEC_DONE: true");
  return lines.join("\n");
}

/**
 * Serializes a blue critique payload into spec-critique line-protocol text.
 * With spec_critic on the protocol, mocked engines speak REVIEW/GAP/ARTIFACT
 * lines plus the required CRITIQUE_DONE anchor in `summary`, and stagepass
 * assembles the JSON -- model-authored structuredOutput is not accepted.
 * specBlocking/mergeBlocking are derived by stagepass, so they never appear here.
 */
function blueCritiqueLineProtocolText(
  output: {
    gapReviews?: unknown[];
    requirementGaps?: unknown[];
  } = validBlueCritiqueOutput(),
): string {
  const lines: string[] = [];
  for (const raw of output.gapReviews ?? []) {
    const review = raw as {
      canonicalGapId: string;
      verdict: string;
      reviewSummary: string;
      evidence: string;
      resolutionEvidence?: string | null;
      downgradedTo?: string | null;
    };
    lines.push(
      `REVIEW: ${review.canonicalGapId} | ${review.verdict} | ${review.reviewSummary} | ${review.evidence} | ${
        review.resolutionEvidence ?? "-"
      } | ${review.downgradedTo ?? "-"}`,
    );
  }
  for (const raw of output.requirementGaps ?? []) {
    const gap = raw as {
      canonicalGapId: string;
      title: string;
      category: string;
      severity: string;
      evidence: string;
      affectedArtifacts?: string[];
      proposedSpecPatch?: string | null;
    };
    lines.push(
      `GAP: ${gap.canonicalGapId} | ${gap.title} | ${gap.category} | ${gap.severity} | ${gap.evidence} | ${
        gap.proposedSpecPatch ?? "-"
      }`,
    );
    for (const artifact of gap.affectedArtifacts ?? []) {
      lines.push(`ARTIFACT: ${gap.canonicalGapId} | ${artifact}`);
    }
  }
  lines.push("CRITIQUE_DONE: true");
  return lines.join("\n");
}

function writeChangeFile(repoPath: string, fileName: string, content: string) {
  const filePath = path.join(repoPath, ".ship", "changes", CHANGE_ID, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writePlanArtifacts(repoPath: string, plan: StructuredPlan = validStructuredPlan()) {
  writeChangeFile(repoPath, "plan.json", `${JSON.stringify(plan, null, 2)}\n`);
  writeChangeFile(repoPath, "plan.md", "# Implementation Plan\n");
}

function writeBuildRunStatus(repoPath: string, status: BuildRunStatus) {
  const now = new Date().toISOString();
  writeBuildRun(repoPath, {
    changeId: CHANGE_ID,
    runNumber: 1,
    status,
    baseCommit: null,
    workspacePath: path.join(repoPath, ".stagepass-test-build-workspace"),
    branchName: `stagepass/build/${CHANGE_ID}/build-1`,
    expectedFiles: [],
    forbiddenFiles: [],
    changedFiles: ["src/app.ts"],
    deviations: [],
    blockers: [],
    patchPath: null,
    patchSha256: null,
    approvalPath: null,
    diffPath: null,
    auditPath: null,
    reportPath: null,
    createdAt: now,
    updatedAt: now,
  });
}

function seedClosedSpecBattle() {
  const now = new Date().toISOString();
  db.update(changes)
    .set({ gateState: "spec", status: "SPEC_READY", updatedAt: now })
    .where(eq(changes.id, CHANGE_ID))
    .run();
  db.insert(battleRounds).values({
    id: "BRD-T27-CLOSED",
    changeId: CHANGE_ID,
    phase: "spec",
    template: "red_blue",
    roundNo: 1,
    status: "closed",
    redUnit: "red",
    blueUnit: "blue",
    inputSnapshotJson: "{}",
    paramsJson: "{}",
    redArtifactPath: null,
    redArtifactHash: null,
    blueArtifactPath: null,
    blueArtifactHash: null,
    reportPath: null,
    supersededByRoundId: null,
    startedAt: now,
    endedAt: now,
    createdAt: now,
    updatedAt: now,
  }).run();
}

async function prepareAdoptedBuild(repoPath: string) {
  seedChange(repoPath, "PLAN_APPROVED");
  writePlanArtifacts(repoPath, {
    ...validStructuredPlan(),
    expectedFiles: ["src/app.ts"],
    forbiddenFiles: [],
  });
  initGitRepoWithApp(repoPath);
  await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("prepare-adopted-build"));
  await approveBuildAbsorb(CHANGE_ID);
  execSync("git add .", { cwd: repoPath });
  execSync("git commit -m 'adopt build fixture'", { cwd: repoPath, stdio: "ignore" });
  const adoptedRun = readLatestBuildRun(repoPath, CHANGE_ID);
  if (!adoptedRun) {
    throw new Error("Expected adopted build run after fixture build");
  }
  const committedHeadSha = execSync("git rev-parse HEAD", {
    cwd: repoPath,
    encoding: "utf-8",
  }).trim();
  const committedAdoptedRun = {
    ...adoptedRun,
    adoptedHeadSha: committedHeadSha,
    updatedAt: new Date().toISOString(),
  };
  writeBuildRun(repoPath, committedAdoptedRun);
  recordBuildRunFromWorkspaceFile(repoPath, CHANGE_ID, committedAdoptedRun);
  assert.equal(currentStatus(), "IMPLEMENTED");
}

function initGitRepoWithApp(repoPath: string) {
  execSync("git init -b main", { cwd: repoPath, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: repoPath });
  execSync("git config user.name 'Test User'", { cwd: repoPath });
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "src", "app.ts"), "export const value = 1;\n");
  execSync("git add .", { cwd: repoPath });
  execSync("git commit -m init", { cwd: repoPath, stdio: "ignore" });
}

function ignoreShipArtifacts(repoPath: string) {
  const gitignorePath = path.join(repoPath, ".gitignore");
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf-8") : "";
  if (!existing.split(/\r?\n/).includes(".ship/")) {
    fs.writeFileSync(gitignorePath, `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}.ship/\n`);
    execSync("git add .gitignore", { cwd: repoPath });
    execSync("git commit -m ignore-ship-artifacts", { cwd: repoPath, stdio: "ignore" });
  }
}

function seedOpenReviewFinding(id = "FND-FIX-P1") {
  const now = new Date().toISOString();
  db.insert(findings).values({
    id,
    changeId: CHANGE_ID,
    runId: null,
    source: "review",
    severity: "P1",
    category: "bug",
    title: "Fix the app value",
    file: "src/app.ts",
    line: 1,
    evidence: "Review found the app value still needs a fix.",
    requiredFix: "Update src/app.ts.",
    status: "open",
    createdAt: now,
    updatedAt: now,
    waivable: 1,
  }).run();
}

function seedQaReadyReviewState(repoPath: string): { headSha: string } {
  const now = new Date().toISOString();
  const headSha = execSync("git rev-parse HEAD", {
    cwd: repoPath,
    encoding: "utf-8",
  }).trim();
  writeBuildRun(repoPath, {
    changeId: CHANGE_ID,
    runNumber: 1,
    status: "adopted",
    purpose: "build",
    baseHeadSha: headSha,
    baseCommit: headSha,
    workspacePath: repoPath,
    branchName: `stagepass/build/${CHANGE_ID}/build-1`,
    expectedFiles: ["src/app.ts"],
    forbiddenFiles: [],
    changedFiles: ["src/app.ts"],
    deviations: [],
    blockers: [],
    patchPath: null,
    patchSha256: null,
    patchHash: "qa-ready-patch-hash",
    changedFilesHash: "qa-ready-changed-files-hash",
    adoptedHeadSha: headSha,
    adoptionDecisionId: "qa-ready-adoption",
    approvalPath: null,
    diffPath: null,
    auditPath: null,
    reportPath: null,
    createdAt: now,
    updatedAt: now,
  });
  db.insert(buildRunRecords).values({
    id: "BRR-QA-READY",
    changeId: CHANGE_ID,
    runId: null,
    buildRunId: "build-1",
    status: "adopted",
    headSha,
    baseHeadSha: headSha,
    baseCommit: headSha,
    patchHash: "qa-ready-patch-hash",
    changedFilesHash: "qa-ready-changed-files-hash",
    adoptedHeadSha: headSha,
    adoptionDecisionId: "qa-ready-adoption",
    adoptedAt: now,
    artifactHash: "qa-ready-artifact-hash",
    source: "test",
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(runs).values({
    id: "RUN-QA-READY-REVIEW",
    changeId: CHANGE_ID,
    phase: "review",
    status: "completed",
    startedAt: now,
    endedAt: now,
    summary: "review passed",
  }).run();
  db.insert(reviewAttempts).values({
    id: "RAT-QA-READY",
    changeId: CHANGE_ID,
    runId: "RUN-QA-READY-REVIEW",
    attemptNo: 1,
    status: "completed",
    provider: "codex",
    reviewStatus: "passed",
    idempotencyKey: "qa-ready-review",
    sourceBuildRunId: "build-1",
    sourceHeadSha: headSha,
    inputSourceDbHash: "qa-ready-review-input-hash",
    inputSourceLineageJson: null,
    priorBlockingFindingIdsJson: JSON.stringify([]),
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
    id: "RRP-QA-READY",
    attemptId: "RAT-QA-READY",
    changeId: CHANGE_ID,
    reportVersion: 1,
    reviewConclusion: "passed",
    reportDbHash: "qa-ready-report-hash",
    gateStatus: "passed",
    qaAllowed: 1,
      sourceBuildRunId: "build-1",
    sourceHeadSha: headSha,
    findingVersion: 1,
    waiverVersion: 1,
    blockingP0: 0,
    blockingP1: 0,
    waivedP1: 0,
    p2Count: 0,
    findingsDbHash: "qa-ready-findings-hash",
    staleReason: null,
    legacyState: null,
    reportJson: null,
    generatedAt: now,
    createdAt: now,
  }).run();
  db.insert(reviewState).values({
    changeId: CHANGE_ID,
    latestAttemptId: "RAT-QA-READY",
    latestAttemptNo: 1,
    latestReportId: "RRP-QA-READY",
    latestValidReviewReportId: "RRP-QA-READY",
    latestValidAttemptNo: 1,
    gateStatus: "passed",
    reviewStatus: "passed",
    sourceBuildRunId: "build-1",
    sourceHeadSha: headSha,
    reportDbHash: "qa-ready-report-hash",
    findingVersion: 1,
    waiverVersion: 1,
    updatedAt: now,
  }).run();
  return { headSha };
}

function seedReleaseReadyFacts(repoPath: string): void {
  const now = new Date().toISOString();
  let headSha: string;
  try {
    headSha = execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
  } catch {
    initGitRepoWithApp(repoPath);
    ignoreShipArtifacts(repoPath);
    headSha = execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
  }
  let latestRun = readLatestBuildRun(repoPath, CHANGE_ID);
  if (!latestRun) {
    latestRun = {
      changeId: CHANGE_ID,
      runNumber: 1,
      status: "adopted",
      purpose: "build",
      baseHeadSha: headSha,
      baseCommit: headSha,
      workspacePath: repoPath,
      branchName: `stagepass/build/${CHANGE_ID}/build-1`,
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
      changedFiles: ["src/app.ts"],
      deviations: [],
      blockers: [],
      patchPath: null,
      patchSha256: null,
      patchHash: "release-ready-patch-hash",
      changedFilesHash: "release-ready-changed-files-hash",
      adoptedHeadSha: headSha,
      adoptionDecisionId: "release-ready-adoption",
      approvalPath: null,
      diffPath: null,
      auditPath: null,
      reportPath: null,
      createdAt: now,
      updatedAt: now,
    };
    writeBuildRun(repoPath, latestRun);
  }
  const buildRunId = `build-${latestRun.runNumber}`;
  const buildRecord = db
    .select()
    .from(buildRunRecords)
    .where(eq(buildRunRecords.changeId, CHANGE_ID))
    .all()
    .find((record) => record.buildRunId === buildRunId);
  if (!buildRecord) {
    db.insert(buildRunRecords).values({
      id: "BRR-RELEASE-READY",
      changeId: CHANGE_ID,
      runId: null,
      buildRunId,
      status: latestRun.status,
      headSha: latestRun.status === "adopted" ? latestRun.adoptedHeadSha ?? headSha : null,
      baseHeadSha: latestRun.baseHeadSha ?? latestRun.baseCommit ?? headSha,
      baseCommit: latestRun.baseCommit ?? headSha,
      patchHash: latestRun.patchHash ?? latestRun.patchSha256 ?? "release-ready-patch-hash",
      changedFilesHash: latestRun.changedFilesHash ?? "release-ready-changed-files-hash",
      adoptedHeadSha: latestRun.status === "adopted" ? latestRun.adoptedHeadSha ?? headSha : null,
      adoptionDecisionId: latestRun.status === "adopted" ? latestRun.adoptionDecisionId ?? "release-ready-adoption" : null,
      adoptedAt: latestRun.status === "adopted" ? latestRun.updatedAt : null,
      artifactHash: latestRun.patchSha256 ?? "release-ready-artifact-hash",
      source: "test",
      createdAt: latestRun.createdAt,
      updatedAt: latestRun.updatedAt,
    }).run();
  }
  seedMergePrerequisiteStageGates();
  db.insert(runs).values({
    id: "RUN-RELEASE-READY-REVIEW",
    changeId: CHANGE_ID,
    phase: "review",
    status: "completed",
    startedAt: now,
    endedAt: now,
    summary: "release ready review",
  }).run();
  db.insert(reviewAttempts).values({
    id: "RAT-RELEASE-READY",
    changeId: CHANGE_ID,
    runId: "RUN-RELEASE-READY-REVIEW",
    attemptNo: 1,
    status: "completed",
    provider: "codex",
    reviewStatus: "passed",
    idempotencyKey: "release-ready-review",
    sourceBuildRunId: buildRunId,
    sourceHeadSha: latestRun.baseCommit ?? headSha,
    inputSourceDbHash: "release-ready-review-input-hash",
    inputSourceLineageJson: null,
    priorBlockingFindingIdsJson: JSON.stringify([]),
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
    id: "RRP-RELEASE-READY",
    attemptId: "RAT-RELEASE-READY",
    changeId: CHANGE_ID,
    reportVersion: 1,
    reviewConclusion: "passed",
    reportDbHash: "release-ready-report-hash",
    gateStatus: "passed",
    qaAllowed: 1,
    sourceBuildRunId: buildRunId,
    sourceHeadSha: latestRun.baseCommit ?? headSha,
    findingVersion: 1,
    waiverVersion: 1,
    blockingP0: 0,
    blockingP1: 0,
    waivedP1: 0,
    p2Count: 0,
    findingsDbHash: "release-ready-findings-hash",
    staleReason: null,
    legacyState: null,
    reportJson: null,
    generatedAt: now,
    createdAt: now,
  }).run();
  db.insert(reviewState).values({
    changeId: CHANGE_ID,
    latestAttemptId: "RAT-RELEASE-READY",
    latestAttemptNo: 1,
    latestReportId: "RRP-RELEASE-READY",
    latestValidReviewReportId: "RRP-RELEASE-READY",
    latestValidAttemptNo: 1,
    gateStatus: "passed",
    reviewStatus: "passed",
    sourceBuildRunId: buildRunId,
    sourceHeadSha: latestRun.baseCommit ?? headSha,
    reportDbHash: "release-ready-report-hash",
    findingVersion: 1,
    waiverVersion: 1,
    updatedAt: now,
  }).run();
  db.insert(qaRuns).values({
    id: "QA-RELEASE-READY",
    changeId: CHANGE_ID,
    sourceReviewReportId: "RRP-RELEASE-READY",
    sourceBuildRunId: buildRunId,
    sourceHeadSha: latestRun.baseCommit ?? headSha,
    status: "passed",
    startedAt: now,
    completedAt: now,
  }).run();
  db.insert(qaCommandResults).values({
    id: "QA-CMD-RELEASE-READY",
    qaRunId: "QA-RELEASE-READY",
    command: "node -e \"process.exit(0)\"",
    commandOrder: 1,
    status: "passed",
    exitCode: 0,
    durationMs: 1,
    outputArtifactMirrorId: null,
    completedAt: now,
  }).run();
  db.insert(humanDecisions).values({
    id: "HD-RELEASE-READY-MERGE",
    changeId: CHANGE_ID,
    roundId: null,
    gate: "merge",
    action: "approve_merge",
    targetType: "change",
    targetId: CHANGE_ID,
    reason: "release ready",
    reportHash: null,
    createdBy: "human",
    createdAt: now,
  }).run();
  db.insert(mergeApprovals).values({
    id: "MAP-RELEASE-READY",
    changeId: CHANGE_ID,
    decisionId: "HD-RELEASE-READY-MERGE",
    actor: "human",
    approvedAt: now,
  }).run();
}

/**
 * A failed fix run leaves a higher-numbered build-N.json on disk. It is never
 * approved, so the DB-side merge gate skips it -- but a filesystem reader that
 * picks the newest run by number sees it shadow the approved deliverable.
 */
function writeShadowingFailedFixRun(repoPath: string, runNumber: number): void {
  const now = new Date().toISOString();
  writeBuildRun(repoPath, {
    changeId: CHANGE_ID,
    runNumber,
    status: "failed",
    purpose: "fix",
    baseHeadSha: null,
    baseCommit: null,
    workspacePath: path.join(repoPath, ".ship", "changes", CHANGE_ID, "build", `run-${runNumber}`),
    branchName: `stagepass/fix/${CHANGE_ID}/build-${runNumber}`,
    expectedFiles: [],
    forbiddenFiles: [],
    changedFiles: [],
    deviations: [],
    blockers: ["fix run failed"],
    patchPath: null,
    patchSha256: null,
    approvalPath: null,
    diffPath: null,
    auditPath: null,
    reportPath: null,
    createdAt: now,
    updatedAt: now,
  });
}

function writeApprovedForAbsorbBuildRun(repoPath: string, headSha: string): void {
  const now = new Date().toISOString();
  writeBuildRun(repoPath, {
    changeId: CHANGE_ID,
    runNumber: 1,
    status: "approved_for_absorb",
    purpose: "build",
    baseHeadSha: headSha,
    baseCommit: headSha,
    workspacePath: repoPath,
    branchName: `stagepass/build/${CHANGE_ID}/build-1`,
    expectedFiles: ["src/app.ts"],
    forbiddenFiles: [],
    changedFiles: ["src/app.ts"],
    deviations: [],
    blockers: [],
    patchPath: null,
    patchSha256: null,
    patchHash: "shadowed-approved-patch-hash",
    changedFilesHash: "shadowed-approved-changed-files-hash",
    approvalPath: null,
    diffPath: null,
    auditPath: null,
    reportPath: null,
    createdAt: now,
    updatedAt: now,
  });
}

function readBuildRunFile(repoPath: string, runNumber: number): BuildRunFile {
  const runPath = path.join(
    repoPath, ".ship", "changes", CHANGE_ID, "build", "runs", `build-${runNumber}.json`
  );
  return JSON.parse(fs.readFileSync(runPath, "utf-8")) as BuildRunFile;
}

/**
 * Write a higher-numbered build-N.json on top of `base`, in both the workspace
 * and build_run_records, exactly as a 修复阻断项 attempt does. Whether it may
 * shadow the adopted build depends entirely on its status, which is the point.
 */
function writeShadowingBuildRun(
  repoPath: string,
  base: BuildRunFile,
  runNumber: number,
  status: BuildRunStatus,
): void {
  const shadowing: BuildRunFile = {
    ...base,
    runNumber,
    status,
    purpose: "fix",
    // A fix run that never adopted has its own workspace and no adoption facts.
    workspacePath: path.join(repoPath, ".ship", "changes", CHANGE_ID, "build", `run-${runNumber}`),
    branchName: `stagepass/fix/${CHANGE_ID}/build-${runNumber}`,
    adoptedHeadSha: null,
    adoptionDecisionId: null,
    blockers: status === "failed" ? ["Fix run produced no changes"] : [],
    updatedAt: new Date().toISOString(),
  };
  writeBuildRun(repoPath, shadowing);
  recordBuildRunFromWorkspaceFile(repoPath, CHANGE_ID, shadowing);
}

describe("pipeline-service v2 stages", () => {
  let repoPath: string;

  beforeEach(() => {
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-t27-"));
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.prompt.includes("REQUIREMENT_CRITIC")) {
          return {
            threadId: `${input.changeId}-thread`,
            runId: "ENGINE-RUN",
            summary: blueCritiqueLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        // Keyed on the stage banner, not on the words "interfaces"/
        // "dataContracts": those were section names in the old JSON-authoring
        // prompt, so rewording the template silently dropped every tech_spec
        // test into the generic free-text branch below.
        if (input.prompt.includes("当前阶段是 tech_spec")) {
          return {
            threadId: `${input.changeId}-thread`,
            runId: "ENGINE-RUN",
            summary: validTechSpecLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        if (input.prompt.includes("当前阶段是 test_plan")) {
          return {
            threadId: `${input.changeId}-thread`,
            runId: "ENGINE-RUN",
            summary: validTestPlanLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        // Keyed on the engine phase, not on a prompt substring: `spec` is the
        // red writer, `spec_critic` blue, `spec_verdict` the judge, and all
        // three assemble prompts that name both units. Red is the only one of
        // the three on this protocol, and phase is the stage identity itself.
        if (input.phase === "spec") {
          return {
            threadId: `${input.changeId}-thread`,
            runId: "ENGINE-RUN",
            summary: redSpecLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));
  });

  afterEach(() => {
    setPipelineEngineFactoryForTest(null);
    setDocumentStageTimeoutMsForTest(null);
    setDocumentStageTimeoutCleanupGraceMsForTest(null);
    setReviewTimeoutMsForTest(null);
    cleanupRows();
    fs.rmSync(path.join(path.dirname(repoPath), ".stagepass-workspaces", path.basename(repoPath), CHANGE_ID), {
      recursive: true,
      force: true,
    });
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  const stageCases: Array<{
    name: string;
    initialStatus: ChangeStatus;
    run: () => Promise<unknown>;
    expectedStatus: ChangeStatus;
    artifact: string;
  }> = [
    {
      name: "intake",
      initialStatus: "INTAKE_PENDING",
      run: () => runIntake(CHANGE_ID, makeTestJobExecutionContext("stage-case-intake")),
      expectedStatus: "INTAKE_READY",
      artifact: "change-request.md",
    },
    {
      name: "spec",
      initialStatus: "INTAKE_READY",
      run: () => runSpec(CHANGE_ID, makeTestJobExecutionContext("stage-case-spec")),
      expectedStatus: "SPEC_READY",
      artifact: "prd-delta.md",
    },
    {
      name: "tech-spec",
      initialStatus: "SPEC_READY",
      run: async () => {
        seedClosedSpecBattle();
        return runTechSpec(CHANGE_ID, makeTestJobExecutionContext("stage-case-tech-spec"));
      },
      expectedStatus: "TECHSPEC_READY",
      artifact: "tech-spec-delta.md",
    },
    {
      name: "test-plan",
      initialStatus: "PLAN_APPROVED",
      run: () => runTestPlan(CHANGE_ID, makeTestJobExecutionContext("stage-case-test-plan")),
      expectedStatus: "TESTPLAN_DONE",
      artifact: "test-plan-delta.md",
    },
    {
      name: "release",
      initialStatus: "MERGE_READY",
      run: () => runRelease(CHANGE_ID, makeTestJobExecutionContext("stage-case-release")),
      expectedStatus: "RETRO_PENDING",
      artifact: "release-note.md",
    },
    {
      name: "retro",
      initialStatus: "RETRO_PENDING",
      run: () => runRetro(CHANGE_ID, makeTestJobExecutionContext("stage-case-retro")),
      // Was DONE. Retro is no longer the last stage: design §3 put the delivery
      // stage between it and DONE, so a change that stops here has a retro and
      // no delivery note. Pinning DONE would pin "the pipeline may finish
      // without ever saying how to use what it built".
      expectedStatus: "DELIVERY_PENDING",
      artifact: "retro.md",
    },
  ];

  it("validates and caps the document-stage timeout cleanup grace", () => {
    assert.throws(
      () => setDocumentStageTimeoutCleanupGraceMsForTest(0),
      /positive finite number/,
    );
    assert.throws(
      () => setDocumentStageTimeoutCleanupGraceMsForTest(Number.NaN),
      /positive finite number/,
    );
    assert.throws(
      () => setDocumentStageTimeoutCleanupGraceMsForTest(1.5),
      /positive safe integer/,
    );
    setDocumentStageTimeoutCleanupGraceMsForTest(
      MAX_DOCUMENT_STAGE_TIMEOUT_CLEANUP_GRACE_MS + 1,
    );
    assert.equal(
      documentStageTimeoutCleanupGraceMs(),
      MAX_DOCUMENT_STAGE_TIMEOUT_CLEANUP_GRACE_MS,
    );
  });

  it("strictly parses the document-stage timeout cleanup grace environment value", () => {
    const envName = "STAGEPASS_DOCUMENT_STAGE_TIMEOUT_CLEANUP_GRACE_MS";
    const previous = process.env[envName];
    setDocumentStageTimeoutCleanupGraceMsForTest(null);
    try {
      for (const invalid of [
        "30abc",
        "1.5",
        "+30",
        "-30",
        " 30",
        "30 ",
        "0",
        "00",
        String(Number.MAX_SAFE_INTEGER + 1),
      ]) {
        process.env[envName] = invalid;
        assert.equal(
          documentStageTimeoutCleanupGraceMs(),
          30_000,
          `expected ${JSON.stringify(invalid)} to use the default`,
        );
      }

      process.env[envName] = "12345";
      assert.equal(documentStageTimeoutCleanupGraceMs(), 12_345);

      process.env[envName] = String(MAX_DOCUMENT_STAGE_TIMEOUT_CLEANUP_GRACE_MS + 1);
      assert.equal(
        documentStageTimeoutCleanupGraceMs(),
        MAX_DOCUMENT_STAGE_TIMEOUT_CLEANUP_GRACE_MS,
      );
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  it("strictly parses and bounds the base document-stage timeout environment values", () => {
    const documentEnv = "STAGEPASS_DOCUMENT_STAGE_TIMEOUT_MS";
    const testPlanEnv = "STAGEPASS_TEST_PLAN_TIMEOUT_MS";
    const previousDocument = process.env[documentEnv];
    const previousTestPlan = process.env[testPlanEnv];
    setDocumentStageTimeoutMsForTest(null);
    try {
      for (const invalid of [
        "30abc",
        "1.5",
        "+30",
        "-30",
        " 30",
        "30 ",
        "0",
        "00",
        String(Number.MAX_SAFE_INTEGER + 1),
        String(MAX_NODE_TIMER_DELAY_MS + 1),
      ]) {
        process.env[documentEnv] = invalid;
        process.env[testPlanEnv] = invalid;
        assert.equal(documentStageTimeoutMs(), 1_800_000, `document ${invalid}`);
        assert.equal(documentStageTimeoutMs("test_plan"), 1_800_000, `test plan ${invalid}`);
      }

      process.env[documentEnv] = String(MAX_NODE_TIMER_DELAY_MS);
      assert.equal(documentStageTimeoutMs(), 1_800_000);
      assert.ok(documentStageWatchdogTimeoutMs() > documentStageTimeoutMs());
      process.env[testPlanEnv] = "12345";
      assert.equal(documentStageTimeoutMs("test_plan"), 12_345);
    } finally {
      if (previousDocument === undefined) delete process.env[documentEnv];
      else process.env[documentEnv] = previousDocument;
      if (previousTestPlan === undefined) delete process.env[testPlanEnv];
      else process.env[testPlanEnv] = previousTestPlan;
    }
  });

  it("keeps test overrides and combined watchdog delays within the Node timer boundary", () => {
    assert.throws(() => setDocumentStageTimeoutMsForTest(1.5), /positive safe integer/);
    assert.throws(
      () => setDocumentStageTimeoutMsForTest(MAX_NODE_TIMER_DELAY_MS + 1),
      /Node timer maximum/,
    );
    setDocumentStageTimeoutMsForTest(MAX_NODE_TIMER_DELAY_MS - 10);
    setDocumentStageTimeoutCleanupGraceMsForTest(30);
    assert.equal(documentStageTimeoutMs(), 1_800_000);
    assert.equal(documentStageWatchdogTimeoutMs(), 1_800_030);
    assert.ok(documentStageWatchdogTimeoutMs() > documentStageTimeoutMs());
  });

  for (const stageCase of stageCases) {
    it(`runs ${stageCase.name} and writes its stage artifact`, async () => {
      seedChange(repoPath, stageCase.initialStatus);
      if (stageCase.name === "release") {
        seedReleaseReadyFacts(repoPath);
      }
      if (stageCase.name === "retro") {
        seedRetroReleaseAuthority(repoPath);
      }

      await stageCase.run();

      assert.equal(currentStatus(), stageCase.expectedStatus);
      assert.equal(artifactExists(repoPath, stageCase.artifact), true);
    });
  }

  it("keeps markdown-only document stages successful when artifact write ledger insert fails", async () => {
    seedChange(repoPath, "INTAKE_PENDING");

    const originalInsertArtifact = runLedgerRepository.insertArtifact;
    let injectedFailure = false;
    runLedgerRepository.insertArtifact = ((row) => {
      if (!injectedFailure && row.changeId === CHANGE_ID && row.type === "change_request") {
        injectedFailure = true;
        throw new Error("artifact insert failed after intake artifact write");
      }
      return originalInsertArtifact(row);
    }) as typeof runLedgerRepository.insertArtifact;

    try {
      await runIntake(CHANGE_ID, makeTestJobExecutionContext("intake-artifact-ledger-failure"));
    } finally {
      runLedgerRepository.insertArtifact = originalInsertArtifact;
    }

    assert.equal(injectedFailure, true);
    assert.equal(currentStatus(), "INTAKE_READY");
    assert.equal(artifactExists(repoPath, "change-request.md"), true);

    const run = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).get();
    assert.equal(run?.status, "completed");
    const postCommitEvent = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "document_stage_post_commit_side_effect_failed" &&
        event.runId === run?.id &&
        event.rawJson?.includes("\"phase\":\"intake\"") &&
        event.rawJson?.includes("\"artifactType\":\"change_request\"") &&
        event.rawJson?.includes("\"fileName\":\"change-request.md\"") &&
        event.rawJson?.includes("artifact insert failed after intake artifact write")
      );
    assert.ok(postCommitEvent);
  });

  it("runs intake from a BLOCKED intake recovery without an invalid-status error", async () => {
    seedChange(repoPath, "BLOCKED");

    await runIntake(CHANGE_ID, makeTestJobExecutionContext("intake-from-blocked"));

    // runDocumentStage transitions BLOCKED -> INTAKE_PENDING (runningStatus) at
    // run-start, so a recovered-then-BLOCKED change re-runs intake cleanly and
    // lands on INTAKE_READY instead of throwing "Invalid status: BLOCKED".
    assert.equal(currentStatus(), "INTAKE_READY");
    assert.equal(artifactExists(repoPath, "change-request.md"), true);
  });

  it("orchestrates document-stage ledger transitions around execution", async () => {
    seedChange(repoPath, "PLAN_APPROVED");

    const result = await runStageWithLedger({
      changeId: CHANGE_ID,
      phase: "test_plan",
      runningStatus: "TESTPLANNING",
      successStatus: "TESTPLAN_DONE",
      failureStatus: "PLAN_APPROVED",
      async execute({ runId }) {
        const run = db.select().from(runs).where(eq(runs.id, runId)).get();
        assert.equal(currentStatus(), "TESTPLANNING");
        assert.equal(run?.phase, "test_plan");
        assert.equal(run?.status, "running");
        return {
          result: { observedRunId: runId },
          successSummary: "Test plan completed",
        };
      },
    });

    const run = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).get();
    assert.deepEqual(result, { observedRunId: run?.id });
    assert.equal(run?.status, "completed");
    assert.equal(run?.summary, "Test plan completed");
    assert.equal(currentStatus(), "TESTPLAN_DONE");
  });

  it("does not convert stage boundary violations into document failure status", async () => {
    seedChange(repoPath, "PLAN_APPROVED");

    await assert.rejects(
      () => runStageWithLedger({
        changeId: CHANGE_ID,
        phase: "test_plan",
        runningStatus: "TESTPLANNING",
        successStatus: "TESTPLAN_DONE",
        failureStatus: "PLAN_APPROVED",
        async execute() {
          throw new StageBoundaryViolationError("stage boundary violation");
        },
      }),
      StageBoundaryViolationError,
    );

    const run = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).get();
    assert.equal(run?.status, "running");
    assert.equal(currentStatus(), "TESTPLANNING");
  });

  it("writes TechSpec/API DB snapshots before rendering mirrors", async () => {
    seedChange(repoPath, "INTAKE_READY");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.prompt.includes("REQUIREMENT_CRITIC")) {
          return {
            threadId: `${input.changeId}-thread`,
            runId: "ENGINE-RUN",
            summary: blueCritiqueLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          // No API_* line: this is the deriveApiContractFromTechSpec path, the
          // one every real change has taken.
          summary: validTechSpecLineProtocolText({ includeApi: false }),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    seedClosedSpecBattle();
    await runTechSpec(CHANGE_ID, makeTestJobExecutionContext("tech-spec-db-snapshots"));

    const techSpec = db.select().from(techspecSnapshots).where(eq(techspecSnapshots.changeId, CHANGE_ID)).get();
    const api = db.select().from(apiSnapshots).where(eq(apiSnapshots.changeId, CHANGE_ID)).get();
    assert.ok(techSpec?.contentJson);
    assert.ok(api?.contractJson);
    assert.match(techSpec.contentJson, /\/api\/projects\/:id/);
    assert.match(api.contractJson, /actions/);
    // With no API_* line the contract is derived from the tech spec, so the two
    // payloads must be identical -- exactly what production CHG-001 shows.
    assert.equal(api.contractJson, techSpec.contentJson);
    assert.equal(currentStatus(), "TECHSPEC_READY");
    assert.equal(artifactExists(repoPath, "tech-spec-delta.md"), true);
    assert.equal(artifactExists(repoPath, "api-spec-delta.md"), true);
    assert.equal(
      db.select().from(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).all().length,
      4,
    );
  });

  /**
   * CHG-015, live: a tech_spec run was killed mid-flight (machine sleep ->
   * dev-supervisor SIGTERM), the sweeper failed RUN-245 with
   * `stale_lease_fenced` but declined to roll the change back, and every retry
   * then died in assertStatus BEFORE the ledger could create a run -- so
   * nothing could ever roll it back either. Three dispatches, same error, no
   * path forward from the UI or the API.
   */
  function strandChangeAtTechspeccing(leftoverRunStatus: "failed" | "running") {
    seedChange(repoPath, "INTAKE_READY");
    seedClosedSpecBattle();
    const now = new Date().toISOString();
    db.insert(runs).values({
      id: "RUN-STRANDED-TECHSPEC",
      changeId: CHANGE_ID,
      phase: "tech_spec",
      status: leftoverRunStatus,
      startedAt: now,
      endedAt: leftoverRunStatus === "failed" ? now : null,
      summary: leftoverRunStatus === "failed" ? "stale_lease_fenced" : null,
    }).run();
    db.update(changes)
      .set({ status: "TECHSPECCING", updatedAt: now })
      .where(eq(changes.id, CHANGE_ID))
      .run();
  }

  it("retries tech spec to completion after a killed run stranded the change at TECHSPECCING", async () => {
    strandChangeAtTechspeccing("failed");

    // The retry must actually EXECUTE, not merely be offered: before this it
    // threw `Invalid status: TECHSPECCING. Expected: SPEC_READY` every time.
    await runTechSpec(CHANGE_ID, makeTestJobExecutionContext("tech-spec-stranded-retry"));

    assert.equal(currentStatus(), "TECHSPEC_READY");
    assert.equal(artifactExists(repoPath, "tech-spec-delta.md"), true);

    // The change genuinely passed back through SPEC_READY rather than the guard
    // being loosened to tolerate TECHSPECCING.
    const recovery = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "change_status_changed" &&
        event.rawJson?.includes("document_stage_stranded_status_recovery") &&
        event.rawJson?.includes("\"from\":\"TECHSPECCING\"") &&
        event.rawJson?.includes("\"to\":\"SPEC_READY\""));
    assert.ok(recovery, "the stranded TECHSPECCING status should be recorded as recovered");

    // A tech_spec run really ran, so the change is no longer holding the
    // project's single-active-change slot on a run that does not exist.
    const completed = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .filter((run) => run.phase === "tech_spec" && run.status === "completed");
    assert.equal(completed.length, 1);
  });

  it("refuses to hijack a tech spec run that is still in flight", async () => {
    strandChangeAtTechspeccing("running");

    // TECHSPECCING is only a lie when no run backs it. With a live run the
    // guard must still reject, otherwise the recovery becomes a way to start a
    // second concurrent tech_spec.
    await assert.rejects(
      () => runTechSpec(CHANGE_ID, makeTestJobExecutionContext("tech-spec-live-run")),
      /Invalid status: TECHSPECCING\. Expected: SPEC_READY/,
    );
    assert.equal(currentStatus(), "TECHSPECCING");
  });

  for (const status of ["IMPLEMENTING", "TECHSPEC_READY", "DONE"] as const) {
    it(`still refuses to run tech spec from ${status}`, async () => {
      seedChange(repoPath, "INTAKE_READY");
      seedClosedSpecBattle();
      db.update(changes)
        .set({ status, updatedAt: new Date().toISOString() })
        .where(eq(changes.id, CHANGE_ID))
        .run();

      // Only the stage's own running status is recoverable. Any other status is
      // a real violation and must stay a hard failure -- guarding against the
      // easy over-loosening fix of adding statuses to allowedStatuses.
      await assert.rejects(
        () => runTechSpec(CHANGE_ID, makeTestJobExecutionContext(`tech-spec-from-${status}`)),
        new RegExp(`Invalid status: ${status}\\. Expected: SPEC_READY`),
      );
      assert.equal(currentStatus(), status);
    });
  }

  it("does not enter TECHSPEC_READY when DB snapshot write fails", async () => {
    seedChange(repoPath, "INTAKE_READY");
    seedClosedSpecBattle();

    const brokenSnapshotDb = drizzle(new Database(":memory:"));
    const restoreSnapshotDb = setTechSpecApiSnapshotServiceDbForTest(brokenSnapshotDb as never);
    try {
      await assert.rejects(
        () => runTechSpec(CHANGE_ID, makeTestJobExecutionContext("tech-spec-db-write-failure")),
        /no such table: techspec_snapshots/,
      );
    } finally {
      restoreSnapshotDb();
    }

    assert.equal(currentStatus(), "SPEC_READY");
    assert.equal(
      db.select().from(techspecSnapshots).where(eq(techspecSnapshots.changeId, CHANGE_ID)).all().length,
      0,
    );
  });

  it("keeps TechSpec ready when post-commit run artifact write fails", async () => {
    seedChange(repoPath, "INTAKE_READY");
    seedClosedSpecBattle();

    const originalWriteFileSync = fs.writeFileSync;
    let injectedFailure = false;
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (
        !injectedFailure
        && typeof file === "string"
        && file.includes(`${path.sep}runs${path.sep}`)
        && file.endsWith("tech-spec-delta.md")
      ) {
        injectedFailure = true;
        throw new Error("run artifact write failed after TechSpec DB commit");
      }
      return originalWriteFileSync(file, data, options);
    }) as typeof fs.writeFileSync;

    try {
      await runTechSpec(CHANGE_ID, makeTestJobExecutionContext("tech-spec-artifact-write-failure"));
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.equal(injectedFailure, true);
    assert.equal(currentStatus(), "TECHSPEC_READY");
    assert.ok(db.select().from(techspecSnapshots).where(eq(techspecSnapshots.changeId, CHANGE_ID)).get());
    assert.ok(db.select().from(apiSnapshots).where(eq(apiSnapshots.changeId, CHANGE_ID)).get());

    const run = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).get();
    assert.equal(run?.status, "completed");
    assert.equal(run?.summary, "Tech spec completed");

    const postCommitEvent = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "document_stage_post_commit_side_effect_failed" &&
        event.runId === run?.id &&
        event.rawJson?.includes("\"phase\":\"tech_spec\"") &&
        event.rawJson?.includes("\"artifactType\":\"tech_spec_delta\"") &&
        event.rawJson?.includes("\"fileName\":\"tech-spec-delta.md\"") &&
        event.rawJson?.includes("run artifact write failed after TechSpec DB commit")
      );
    assert.ok(postCommitEvent);
  });

  it("requires rejecting the Spec gate before rerunning Spec", async () => {
    seedChange(repoPath, "SPEC_READY");

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-gate-required")),
      /Invalid status|gate/i,
    );

    assert.equal(currentStatus(), "SPEC_READY");
  });

  it("requires rejecting the TechSpec gate before rerunning TechSpec", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    seedClosedSpecBattle();
    db.update(changes)
      .set({ status: "TECHSPEC_READY", gateState: "spec" })
      .where(eq(changes.id, CHANGE_ID))
      .run();

    await assert.rejects(
      () => runTechSpec(CHANGE_ID, makeTestJobExecutionContext("tech-spec-gate-required")),
      /Invalid status|gate/i,
    );

    assert.equal(currentStatus(), "TECHSPEC_READY");
  });

  it("does not leave partial TechSpec snapshot when API contract validation fails", async () => {
    seedChange(repoPath, "INTAKE_READY");
    seedClosedSpecBattle();
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        return {
          threadId: `${CHANGE_ID}-thread`,
          runId: "ENGINE-RUN",
          summary: "invalid api contract candidate",
          success: true,
          changedFiles: [],
          structuredOutput: {
            techSpec: {
              interfaces: [{ endpoint: "/api/projects/:id" }],
              dataContracts: [{ response: "ProjectResponse" }],
              migrationNotes: [],
              buildInputs: ["Use DB design snapshot."],
              reviewInputs: ["Review DB design snapshot."],
            },
            apiContract: {
              interfaces: [{ endpoint: "/api/projects/:id" }],
            },
          },
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    // Before the line protocol this reached normalizeDesignSections and failed
    // with "Design snapshot missing section: dataContracts" -- i.e. the
    // model-authored apiContract was carried all the way to the DB door and
    // only rejected there, after the provider had gone terminal and with no raw
    // capture to diff against. It is now refused at the parser: the reply text
    // carries no protocol line, so there is no payload, and the model's JSON is
    // never consulted. Asserting the *absence* of the old message is the point
    // -- reaching it again would mean model-authored JSON had been readmitted.
    const rejection = await runTechSpec(
      CHANGE_ID,
      makeTestJobExecutionContext("tech-spec-invalid-api-contract"),
    ).then(() => null, (error: Error) => error);
    assert.ok(rejection);
    assert.match(rejection.message, /tech-spec line protocol rejected/);
    assert.doesNotMatch(rejection.message, /Design snapshot missing section/);
    assert.equal(currentStatus(), "SPEC_READY");
    assert.equal(
      db.select().from(techspecSnapshots).where(eq(techspecSnapshots.changeId, CHANGE_ID)).all()
        .length,
      0,
    );
    assert.equal(
      db.select().from(apiSnapshots).where(eq(apiSnapshots.changeId, CHANGE_ID)).all().length,
      0,
    );
  });

  /**
   * The defect this stage was migrated for: runTechSpec set no `outputSchema`,
   * so runDocumentStage skipped its whole `if (config.outputSchema)` block --
   * no ingestion, no schema check, and no raw capture. A reply that was not
   * parseable JSON therefore blew up inside normalizeDesignSections AFTER the
   * provider had gone terminal, and there was nothing on disk to diff the
   * drift against. Both halves are asserted here.
   */
  it("captures raw output when the TechSpec reply carries no protocol lines", async () => {
    seedChange(repoPath, "INTAKE_READY");
    seedClosedSpecBattle();
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.prompt.includes("REQUIREMENT_CRITIC")) {
          return {
            threadId: `${CHANGE_ID}-thread`,
            runId: "ENGINE-RUN",
            summary: blueCritiqueLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        return {
          threadId: `${CHANGE_ID}-thread`,
          runId: "ENGINE-RUN",
          summary: "这个改动我建议直接照着现有实现改，不需要额外的接口设计。",
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    const rejection = await runTechSpec(
      CHANGE_ID,
      makeTestJobExecutionContext("tech-spec-prose-reply"),
    ).then(() => null, (error: Error) => error);

    assert.ok(rejection);
    // The failure names the output contract, not a DB-door exception.
    assert.match(rejection.message, /tech-spec line protocol rejected/);
    assert.doesNotMatch(rejection.message, /Design snapshot candidate must be/);
    assert.equal(currentStatus(), "SPEC_READY");
    assert.equal(
      db.select().from(techspecSnapshots).where(eq(techspecSnapshots.changeId, CHANGE_ID)).all().length,
      0,
    );

    const run = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .find((row) => row.phase === "tech_spec");
    assert.equal(run?.status, "failed");
    const rawCaptureArtifact = db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all()
      .find((artifact) => artifact.type === "stage_raw_output" && artifact.runId === run?.id);
    assert.ok(rawCaptureArtifact, "tech_spec must write a stage_raw_output artifact");
    assert.equal(fs.existsSync(rawCaptureArtifact.path), true);
    const rawCapture = JSON.parse(fs.readFileSync(rawCaptureArtifact.path, "utf-8"));
    assert.equal(rawCapture.phase, "tech_spec");
    assert.equal(rawCapture.errorCode, "invalid_stage_output");
    // The reply the model actually wrote is recoverable verbatim -- that is the
    // whole point of the capture, and exactly what was missing before.
    assert.equal(
      rawCapture.rawText,
      "这个改动我建议直接照着现有实现改，不需要额外的接口设计。",
    );
    assert.equal(rawCapture.rawTextHash, sha256Text(rawCapture.rawText));

    const rawCaptureEvent = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "stage_raw_output"
        && event.runId === run?.id
        && event.rawJson?.includes("\"phase\":\"tech_spec\""));
    assert.ok(rawCaptureEvent);
  });

  it("takes TechSpec snapshots from the protocol lines, never from model-authored JSON", async () => {
    seedChange(repoPath, "INTAKE_READY");
    seedClosedSpecBattle();
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.prompt.includes("REQUIREMENT_CRITIC")) {
          return {
            threadId: `${CHANGE_ID}-thread`,
            runId: "ENGINE-RUN",
            summary: blueCritiqueLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        return {
          threadId: `${CHANGE_ID}-thread`,
          runId: "ENGINE-RUN",
          // Protocol lines AND a hand-authored JSON object that is itself
          // perfectly well-formed. Only the protocol lines may reach the DB.
          summary: [
            validTechSpecLineProtocolText({ includeApi: false }),
            "",
            "```json",
            JSON.stringify({
              techSpec: {
                interfaces: [{ name: "MODEL_AUTHORED", type: "http", change: "smuggled" }],
                dataContracts: [],
                migrationNotes: [],
                buildInputs: ["smuggled build input"],
                reviewInputs: ["smuggled review input"],
              },
            }),
            "```",
          ].join("\n"),
          success: true,
          changedFiles: [],
          structuredOutput: {
            techSpec: {
              interfaces: [{ name: "MODEL_AUTHORED", type: "http", change: "smuggled" }],
              dataContracts: [],
              migrationNotes: [],
              buildInputs: ["smuggled build input"],
              reviewInputs: ["smuggled review input"],
            },
          },
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runTechSpec(CHANGE_ID, makeTestJobExecutionContext("tech-spec-refuses-model-json"));

    const techSpec = db.select().from(techspecSnapshots).where(eq(techspecSnapshots.changeId, CHANGE_ID)).get();
    const api = db.select().from(apiSnapshots).where(eq(apiSnapshots.changeId, CHANGE_ID)).get();
    assert.ok(techSpec?.contentJson);
    assert.ok(api?.contractJson);
    // Neither the provider-native structuredOutput nor the fenced JSON in the
    // reply text may contribute a single byte.
    assert.doesNotMatch(techSpec.contentJson, /MODEL_AUTHORED|smuggled/);
    assert.doesNotMatch(api.contractJson, /MODEL_AUTHORED|smuggled/);
    assert.match(techSpec.contentJson, /Use DB design snapshot\./);
    assert.equal(currentStatus(), "TECHSPEC_READY");
  });

  it("blocks Build before workspace creation when DB design snapshots are missing", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    db.delete(apiSnapshots).where(eq(apiSnapshots.changeId, CHANGE_ID)).run();
    db.delete(techspecSnapshots).where(eq(techspecSnapshots.changeId, CHANGE_ID)).run();

    await assert.rejects(
      () => runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("build-missing-design-snapshot")),
      /missing_design_snapshot/,
    );
    assert.equal(currentStatus(), "PLAN_APPROVED");
    assert.equal(
      fs.existsSync(path.join(path.dirname(repoPath), ".stagepass-workspaces", path.basename(repoPath), CHANGE_ID)),
      false,
    );
  });

  it("blocks Review preflight when DB design snapshots are missing", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    db.delete(apiSnapshots).where(eq(apiSnapshots.changeId, CHANGE_ID)).run();

    await assert.rejects(() => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")), /missing_design_snapshot/);
    assert.equal(
      db.select().from(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).all().length,
      0,
    );
  });

  it("rejects spec from an invalid status", async () => {
    seedChange(repoPath, "DRAFT");

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-invalid-status")),
      /Invalid status/,
    );
  });

  it("keeps review findings visible to the fix stage", () => {
    const source = [
      "server/services/pipeline-service.ts",
      "server/services/pipeline-build-stage-service.ts",
    ].map((file) => fs.readFileSync(path.join(process.cwd(), file), "utf-8")).join("\n");

    // D2: open findings for the (non-streamed) Fix prompt come from the
    // `findings` DB table, matching the streamed Fix path just above it in the
    // same file -- not from findings.json/review-findings.json, which are
    // human-editable phase artifacts.
    assert.match(source, /\.from\(findings\)\s*\.where\(eq\(findings\.changeId, changeId\)\)/);
    assert.match(source, /\.filter\(\(finding\) => finding\.status === "open"\)/);
    assert.match(source, /includesReviewFindings\(openFindings\)/);
    assert.match(source, /awaiting absorb before Review rerun/);
    assert.match(source, /purpose: "fix"/);
  });

  it("routes streamed Fix ledger terminal and status writes through the fenced wrapper", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "server/services/pipeline-build-stage-service.ts"),
      "utf-8",
    );
    // Bound to the streamed-fix functions; the non-streamed implement/fix
    // orchestration (which legitimately owns its own ledger writes) follows.
    const runFixBody = source.slice(
      source.indexOf("export async function runFixStreamed"),
      source.indexOf("// --- Non-streamed implement/fix orchestration"),
    );
    const wrapperStart = source.indexOf("async function runFencedStreamedStageWithLedger");
    const wrapperEnd = source.indexOf("\nfunction getProject", wrapperStart);
    assert.notEqual(wrapperStart, -1);
    assert.notEqual(wrapperEnd, -1);
    const wrapperBody = source.slice(wrapperStart, wrapperEnd);

    assert.match(runFixBody, /runFencedStreamedStageWithLedger/);
    assert.doesNotMatch(runFixBody, /\bcreateRun\(/);
    assert.doesNotMatch(runFixBody, /\bendRun\(/);
    assert.doesNotMatch(runFixBody, /\bsetStatus\(/);
    // beginStageRun/endStageRun write the run row and the status it justifies
    // in one transaction (D6 audit Tier 1) -- the wrapper no longer calls
    // createRun/endRun/setStatus directly at all.
    assert.doesNotMatch(wrapperBody, /\bcreateRun\(/);
    assert.doesNotMatch(wrapperBody, /\bendRun\(/);
    assert.doesNotMatch(wrapperBody, /\bsetStatus\(/);
    assert.equal([...wrapperBody.matchAll(/\bbeginStageRun\(/g)].length, 1);
    assert.equal([...wrapperBody.matchAll(/\bendStageRun\(/g)].length, 2);
    assert.match(wrapperBody, /err instanceof StaleLeaseFenceError[\s\S]*throw err/);
    assert.match(
      wrapperBody,
      /assertCurrentExecutionFence\(input\.context, runId\)[\s\S]*endStageRun\(\{[\s\S]*runId/,
    );
  });

  it("runs streamed fixes in a new build workspace without modifying the main repo", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-build-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    db.update(changes).set({ status: "CHECK_FAILED" }).where(eq(changes.id, CHANGE_ID)).run();
    seedOpenReviewFinding();
    let streamedRepoPath: string | null = null;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        streamedRepoPath = input.repoPath;
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 3;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-fix-thread` } as unknown as AiStreamEvent;
      },
    }));

    await runFixStreamed(CHANGE_ID, makeTestJobExecutionContext("fix-new-workspace"));

    assert.equal(currentStatus(), "IMPLEMENTING");
    assert.notEqual(streamedRepoPath, repoPath);
    assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 2;\n");
    const buildRun = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.equal(buildRun?.status, "awaiting_human");
    assert.equal(buildRun?.runNumber, 2);
    assert.equal(buildRun?.purpose, "fix");
    assert.equal(buildRun?.workspacePath, streamedRepoPath);
    assert.equal(fs.readFileSync(path.join(buildRun?.workspacePath ?? "", "src", "app.ts"), "utf-8"), "export const value = 3;\n");
  });

  it("fails a gate-blocked streamed fix run and returns to CHECK_FAILED", async () => {
    seedChange(repoPath, "CHECK_FAILED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: ["infra/**"],
    });
    initGitRepoWithApp(repoPath);
    seedOpenReviewFinding();
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.mkdirSync(path.join(input.repoPath, "infra"), { recursive: true });
        fs.writeFileSync(path.join(input.repoPath, "infra", "main.tf"), "resource \"x\" \"y\" {}\n");
        yield { type: "thread.started", threadId: `${input.changeId}-fix-thread` } as unknown as AiStreamEvent;
      },
    }));

    await runFixStreamed(CHANGE_ID, makeTestJobExecutionContext("fix-gate-blocked"));

    assert.equal(currentStatus(), "CHECK_FAILED");
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "gate_blocked");
    const fixRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .filter((run) => run.phase === "fix_findings")
      .at(-1);
    assert.equal(fixRun?.status, "failed");
    assert.match(fixRun?.summary ?? "", /gate blockers/i);
  });

  it("restores the original fix status and fails the run when streamed fix throws", async () => {
    seedChange(repoPath, "SCOPE_FAILED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {
        throw new Error("fix exploded");
      },
    }));

    await assert.rejects(
      () => runFixStreamed(CHANGE_ID, makeTestJobExecutionContext("fix-engine-failure")),
      /fix exploded/,
    );

    assert.equal(currentStatus(), "SCOPE_FAILED");
    assert.equal(currentChange()?.fixIterations, 0);
    const fixRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .filter((run) => run.phase === "fix_findings")
      .at(-1);
    assert.equal(fixRun?.status, "failed");
    assert.equal(fixRun?.summary, "Error: fix exploded");
  });

  it("does not consume a fix iteration when the workspace produces no changes", async () => {
    seedChange(repoPath, "CHECK_FAILED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    seedOpenReviewFinding();
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        yield { type: "thread.started", threadId: `${input.changeId}-fix-thread` } as unknown as AiStreamEvent;
      },
    }));

    await assert.rejects(
      () => runFixStreamed(CHANGE_ID, makeTestJobExecutionContext("fix-no-changes")),
      /produced no changes/,
    );

    assert.equal(currentStatus(), "CHECK_FAILED");
    assert.equal(currentChange()?.fixIterations, 0);
  });

  /**
   * The 8ac5c4ec dead end at the Fix stage. The fix runs through
   * runFencedStreamedStageWithLedger, which neither runDocumentStage nor
   * generatePlan cover, so recoverStrandedRunningStatus had never reached it: a
   * fix run killed outside its own try/catch (sleep, SIGTERM, OOM) leaves the
   * change claiming FIXING with no run behind it, and every retry then dies in
   * assertStatus BEFORE the ledger can create a run -- so nothing can ever roll
   * the status back either. Permanent, and the contract agreed, reporting
   * fix_blockers not_at_gate ("Fix can only run from CHECK_FAILED or
   * SCOPE_FAILED") so the user had no button to press at all.
   */
  function strandChangeAtFixing(leftoverRunStatus: "failed" | "running") {
    const now = new Date().toISOString();
    db.insert(runs).values({
      id: `RUN-STRANDED-FIX-${leftoverRunStatus}`,
      changeId: CHANGE_ID,
      phase: "fix_findings",
      status: leftoverRunStatus,
      startedAt: now,
      endedAt: leftoverRunStatus === "failed" ? now : null,
      summary: leftoverRunStatus === "failed" ? "stale_lease_fenced" : null,
    }).run();
    db.update(changes)
      .set({ status: "FIXING", updatedAt: now })
      .where(eq(changes.id, CHANGE_ID))
      .run();
  }

  function stubStreamingEngine(value: number) {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), `export const value = ${value};\n`);
        yield { type: "thread.started", threadId: `${input.changeId}-fix-thread` } as unknown as AiStreamEvent;
      },
    }));
  }

  /** An adopted build sitting at CHECK_FAILED with an open P1 -- the state a fix runs from. */
  async function prepareFixableChange() {
    stubStreamingEngine(2);
    await prepareAdoptedBuild(repoPath);
    db.update(changes).set({ status: "CHECK_FAILED" }).where(eq(changes.id, CHANGE_ID)).run();
    seedOpenReviewFinding();
    stubStreamingEngine(3);
  }

  it("retries the fix to completion after a killed run stranded the change at FIXING", async () => {
    await prepareFixableChange();
    strandChangeAtFixing("failed");

    // The retry must EXECUTE, not merely be offered: before this it threw
    // `Invalid status: FIXING. Expected: CHECK_FAILED, SCOPE_FAILED` every
    // time, outside the ledger, so no run existed to roll the status back.
    await runFixStreamed(CHANGE_ID, makeTestJobExecutionContext("fix-stranded-retry"));

    assert.equal(currentStatus(), "IMPLEMENTING");

    // The change genuinely passed back through CHECK_FAILED -- the rollback
    // target the sweeper itself would have used
    // (fallbackStatusByProviderPhase.fix_findings) and a legal FIXING exit in
    // ALLOWED_TRANSITIONS -- rather than assertStatus being loosened to
    // tolerate FIXING.
    const recovery = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "change_status_changed" &&
        event.rawJson?.includes("fix_stage_stranded_status_recovery") &&
        event.rawJson?.includes("\"from\":\"FIXING\"") &&
        event.rawJson?.includes("\"to\":\"CHECK_FAILED\""));
    assert.ok(recovery, "the stranded FIXING status should be recorded as recovered");

    const completed = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .filter((run) => run.phase === "fix_findings" && run.status === "completed");
    assert.equal(completed.length, 1);
  });

  it("refuses to hijack a fix run that is still in flight", async () => {
    await prepareFixableChange();
    strandChangeAtFixing("running");

    // FIXING is only a lie when no run backs it. With a live run the guard must
    // still reject, otherwise the recovery becomes a way to start a second
    // concurrent fix against the same change -- which is also exactly what
    // would happen if anyone "fixed" this by adding FIXING to assertStatus.
    await assert.rejects(
      () => runFixStreamed(CHANGE_ID, makeTestJobExecutionContext("fix-live-run")),
      /Invalid status: FIXING\. Expected: CHECK_FAILED, SCOPE_FAILED/,
    );
    assert.equal(currentStatus(), "FIXING");
  });

  for (const status of ["IMPLEMENTED", "IMPLEMENTING", "DONE"] as const) {
    it(`still refuses to run a fix from ${status}`, async () => {
      seedChange(repoPath, status);
      stubStreamingEngine(3);

      // Only the stage's own running status is recoverable. Any other status is
      // a real violation and must stay a hard failure -- guarding against the
      // easy over-loosening fix of widening assertStatus.
      await assert.rejects(
        () => runFixStreamed(CHANGE_ID, makeTestJobExecutionContext(`fix-from-${status}`)),
        new RegExp(`Invalid status: ${status}\\. Expected: CHECK_FAILED, SCOPE_FAILED`),
      );
      assert.equal(currentStatus(), status);
      assert.equal(
        db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
          .filter((run) => run.phase === "fix_findings").length,
        0,
      );
    });
  }

  it("approves streamed fix workspaces without applying the fix patch to the main repo", async () => {
    seedChange(repoPath, "CHECK_FAILED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    seedOpenReviewFinding();
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-fix-thread` } as unknown as AiStreamEvent;
      },
    }));

    await runFixStreamed(CHANGE_ID, makeTestJobExecutionContext("fix-approve-absorb"));
    await approveFixAbsorb(CHANGE_ID);

    assert.equal(currentStatus(), "IMPLEMENTED");
    assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 1;\n");
    const buildRun = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.equal(buildRun?.status, "approved_for_absorb");
    assert.equal(buildRun?.purpose, "fix");
    const adoptedRecord = db
      .select()
      .from(buildRunRecords)
      .where(eq(buildRunRecords.changeId, CHANGE_ID))
      .get();
    assert.equal(adoptedRecord?.buildRunId, "build-1");
    assert.equal(adoptedRecord?.status, "approved_for_absorb");
    assert.equal(adoptedRecord?.adoptedHeadSha, null);
  });

  it("adopts a fix when previous Build files are uncommitted and the fix workspace emits change events", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: [
        "src/domain/todo.ts",
        "src/state/todo-store.ts",
        "src/ui/todo-list.tsx",
        "tests/todo.test.ts",
      ],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        if (input.phase === "implement") {
          fs.mkdirSync(path.join(input.repoPath, "src", "domain"), { recursive: true });
          fs.mkdirSync(path.join(input.repoPath, "src", "state"), { recursive: true });
          fs.mkdirSync(path.join(input.repoPath, "src", "ui"), { recursive: true });
          fs.mkdirSync(path.join(input.repoPath, "tests"), { recursive: true });
          fs.writeFileSync(path.join(input.repoPath, "src", "domain", "todo.ts"), "export type Todo = { id: string; text: string };\n");
          fs.writeFileSync(path.join(input.repoPath, "src", "state", "todo-store.ts"), "export const todos = [];\n");
          fs.writeFileSync(path.join(input.repoPath, "src", "ui", "todo-list.tsx"), "export function TodoList() { return null; }\n");
          fs.writeFileSync(path.join(input.repoPath, "tests", "todo.test.ts"), "import 'node:test';\n");
          return;
        }

        fs.mkdirSync(path.join(input.repoPath, ".ship", "changes", CHANGE_ID), { recursive: true });
        fs.writeFileSync(
          path.join(input.repoPath, ".ship", "changes", CHANGE_ID, "events.jsonl"),
          "{\"type\":\"fix\"}\n"
        );
        fs.mkdirSync(path.join(input.repoPath, "src", "state"), { recursive: true });
        fs.mkdirSync(path.join(input.repoPath, "src", "ui"), { recursive: true });
        fs.mkdirSync(path.join(input.repoPath, "tests"), { recursive: true });
        fs.writeFileSync(path.join(input.repoPath, "src", "state", "todo-store.ts"), "export const todos = ['fixed'];\n");
        fs.writeFileSync(path.join(input.repoPath, "src", "ui", "todo-list.tsx"), "export function TodoList() { return 'fixed'; }\n");
        fs.writeFileSync(path.join(input.repoPath, "tests", "todo.test.ts"), "import 'node:test';\nimport assert from 'node:assert/strict';\nassert.equal(1, 1);\n");
      },
    }));

    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("build-before-fix-adoption"));
    await approveBuildAbsorb(CHANGE_ID);

    const mainEventPath = path.join(repoPath, ".ship", "changes", CHANGE_ID, "events.jsonl");
    fs.mkdirSync(path.dirname(mainEventPath), { recursive: true });
    fs.writeFileSync(mainEventPath, "{\"type\":\"main\"}\n");
    db.update(changes).set({ status: "CHECK_FAILED" }).where(eq(changes.id, CHANGE_ID)).run();
    seedOpenReviewFinding();

    await runFixStreamed(CHANGE_ID, makeTestJobExecutionContext("fix-after-build-adoption"));
    const pendingFix = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.equal(pendingFix?.runNumber, 2);
    assert.equal(pendingFix?.purpose, "fix");
    assert.equal(pendingFix?.status, "awaiting_human");
    assert.equal(
      fs.existsSync(path.join(pendingFix?.workspacePath ?? "", ".ship", "changes", CHANGE_ID, "events.jsonl")),
      true
    );

    await approveFixAbsorb(CHANGE_ID);

    assert.equal(currentStatus(), "IMPLEMENTED");
    assert.equal(fs.existsSync(path.join(repoPath, "src", "state", "todo-store.ts")), true);
    assert.equal(fs.readFileSync(mainEventPath, "utf-8"), "{\"type\":\"main\"}\n");
    const adoptedFix = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.equal(adoptedFix?.status, "approved_for_absorb");
    assert.equal(adoptedFix?.purpose, "fix");
    const latestRecord = db
      .select()
      .from(buildRunRecords)
      .where(eq(buildRunRecords.changeId, CHANGE_ID))
      .all()
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))[0];
    assert.equal(latestRecord?.buildRunId, "build-2");
    assert.equal(latestRecord?.status, "approved_for_absorb");
  });

  it("runs QA without deleting Review findings and refreshes Merge readiness", async () => {
    seedChange(repoPath, "IMPLEMENTED");
    initGitRepoWithApp(repoPath);
    db.update(projects).set({ gitEnabled: 1 }).where(eq(projects.id, PROJECT_ID)).run();
    seedApprovedTestPlanSnapshot();
    const now = new Date().toISOString();
    const headSha = execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();

    db.insert(buildRunRecords).values({
      id: "BRR-QA-ADOPTED",
      changeId: CHANGE_ID,
      runId: null,
      buildRunId: "build-2",
      status: "adopted",
      headSha,
      baseHeadSha: headSha,
      baseCommit: headSha,
      patchHash: "qa-patch-hash",
      changedFilesHash: "qa-changed-files-hash",
      adoptedHeadSha: headSha,
      adoptionDecisionId: "qa-adoption",
      adoptedAt: now,
      artifactHash: "qa-artifact-hash",
      source: "test",
      createdAt: now,
      updatedAt: now,
    }).run();
    writeBuildRun(repoPath, {
      changeId: CHANGE_ID,
      runNumber: 2,
      status: "approved_for_absorb",
      baseCommit: headSha,
      workspacePath: repoPath,
      branchName: `stagepass/build/${CHANGE_ID}/build-2`,
      expectedFiles: [],
      forbiddenFiles: [],
      changedFiles: ["src/app.ts"],
      deviations: [],
      blockers: [],
      patchPath: null,
      patchSha256: null,
      approvalPath: null,
      diffPath: null,
      auditPath: null,
      reportPath: null,
      createdAt: now,
      updatedAt: now,
    });
    db.insert(runs).values({
      id: "RUN-QA-REVIEW",
      changeId: CHANGE_ID,
      phase: "review",
      status: "completed",
      startedAt: now,
      endedAt: now,
      summary: "review passed",
    }).run();
    db.insert(reviewAttempts).values({
      id: "RAT-QA-PASSED",
      changeId: CHANGE_ID,
      runId: "RUN-QA-REVIEW",
      attemptNo: 1,
      status: "completed",
      provider: "codex",
      reviewStatus: "passed",
      idempotencyKey: "qa-passed-review",
      sourceBuildRunId: "build-2",
      sourceHeadSha: headSha,
      inputSourceDbHash: "qa-review-input-hash",
      inputSourceLineageJson: null,
      priorBlockingFindingIdsJson: JSON.stringify(["FND-QA-OLD-P1"]),
      rawOutputArtifactId: null,
      errorCode: null,
      sanitizedErrorSummary: null,
      startedAt: now,
      endedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(findings).values({
      id: "FND-QA-OLD-P1",
      changeId: CHANGE_ID,
      runId: "RUN-QA-REVIEW",
      source: "review",
      severity: "P1",
      category: "bug",
      title: "Old Review blocker was fixed",
      file: "src/app.ts",
      line: 1,
      evidence: "The previous Review blocker was rechecked.",
      requiredFix: "Keep this historical finding linked.",
      status: "fixed",
      createdAt: now,
      updatedAt: now,
      reviewAttemptId: "RAT-QA-PASSED",
      sourceBuildRunId: "build-2",
      sourceHeadSha: headSha,
      waivable: 1,
      findingVersion: 1,
    }).run();
    db.insert(reviewPriorFindingReviews).values({
      id: "RPFR-QA-OLD-P1",
      attemptId: "RAT-QA-PASSED",
      priorFindingId: "FND-QA-OLD-P1",
      verdict: "fixed",
      evidence: "The blocker is fixed.",
      requiredFix: null,
      replacementFindingId: null,
      reviewerNotes: "Ready for QA.",
      createdAt: now,
    }).run();
    db.insert(reviewReports).values({
      id: "RRP-QA-PASSED",
      attemptId: "RAT-QA-PASSED",
      changeId: CHANGE_ID,
      reportVersion: 1,
      reviewConclusion: "passed",
      reportDbHash: "qa-report-hash",
      gateStatus: "passed",
      qaAllowed: 1,
      sourceBuildRunId: "build-2",
      sourceHeadSha: headSha,
      findingVersion: 1,
      waiverVersion: 1,
      blockingP0: 0,
      blockingP1: 0,
      waivedP1: 0,
      p2Count: 0,
      findingsDbHash: "qa-findings-hash",
      staleReason: null,
      legacyState: null,
      reportJson: null,
      generatedAt: now,
      createdAt: now,
    }).run();
    db.insert(reviewState).values({
      changeId: CHANGE_ID,
      latestAttemptId: "RAT-QA-PASSED",
      latestAttemptNo: 1,
      latestReportId: "RRP-QA-PASSED",
      latestValidReviewReportId: "RRP-QA-PASSED",
      latestValidAttemptNo: 1,
      gateStatus: "passed",
      reviewStatus: "passed",
      sourceBuildRunId: "build-2",
      sourceHeadSha: headSha,
      reportDbHash: "qa-report-hash",
      findingVersion: 1,
      waiverVersion: 1,
      updatedAt: now,
    }).run();

    const context = makeTestJobExecutionContext("qa-context-propagation");
    await runCheck(CHANGE_ID, context, {
      entrypoint: "api_check_route",
      actor: "human",
      expectedHeadSha: headSha,
    });

    assert.equal(currentStatus(), "MERGE_READY");
    const localCheckRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .filter((run) => run.phase === "local_check")
      .at(-1);
    assert.equal(localCheckRun?.jobId, context.jobId);
    assert.equal(localCheckRun?.workerId, context.workerId);
    assert.equal(localCheckRun?.leaseToken, context.leaseToken);
    assert.equal(localCheckRun?.attemptNo, context.attemptNo);
    const qaGate = db
      .select()
      .from(stageGates)
      .where(eq(stageGates.changeId, CHANGE_ID))
      .all()
      .filter((gate) => gate.phase === "QA")
      .at(-1);
    assert.equal(qaGate?.status, "passed");
    const mergeGate = db
      .select()
      .from(stageGates)
      .where(eq(stageGates.changeId, CHANGE_ID))
      .all()
      .filter((gate) => gate.phase === "Merge")
      .at(-1);
    assert.equal(mergeGate?.status, "blocked");
    const mergeBlockerCodes = JSON.parse(mergeGate?.blockersJson ?? "[]").map(
      (blocker: { reasonCode?: string }) => blocker.reasonCode,
    );
    assert.ok(mergeBlockerCodes.includes("merge_approval_missing"));
    assert.equal(mergeBlockerCodes.includes("qa_gate_failed"), false);
    assert.equal(mergeBlockerCodes.includes("qa_result_stale"), false);
    const qaRun = db.select().from(qaRuns).where(eq(qaRuns.changeId, CHANGE_ID)).get();
    assert.equal(qaRun?.sourceHeadSha, headSha);
    const deliveryEvidence = qaRun
      ? db
          .select()
          .from(qaEvidence)
          .where(eq(qaEvidence.qaRunId, qaRun.id))
          .all()
          .find((candidate) => candidate.evidenceType === "qa_delivery_head")
      : null;
    assert.equal(deliveryEvidence, undefined);

    // D2: every QA command log is mirrored, and its sha256 is the evidence hash.
    const qaMirrors = db.select().from(artifactMirrors)
      .where(eq(artifactMirrors.changeId, CHANGE_ID)).all()
      .filter((mirror) => mirror.phase === "QA");
    assert.ok(qaMirrors.length > 0, "QA command logs must be mirrored");
    for (const mirror of qaMirrors) {
      assert.equal(mirror.artifactType, "qa_log");
      assert.equal(mirror.mirrorStatus, "ok");
      assert.ok(mirror.sourceDbHash, "QA mirror must carry a source db hash");
      assert.equal(
        mirror.contentHash,
        createHash("sha256").update(fs.readFileSync(mirror.path, "utf-8")).digest("hex"),
        "QA mirror content_hash must be the sha256 of the log on disk",
      );
    }
    const mirrorIds = new Set(qaMirrors.map((mirror) => mirror.id));
    const mirrorHashById = new Map(qaMirrors.map((mirror) => [mirror.id, mirror.contentHash]));

    const qaCommands = db.select().from(qaCommandResults)
      .where(eq(qaCommandResults.qaRunId, qaRun!.id)).all();
    assert.ok(qaCommands.length > 0);
    for (const command of qaCommands) {
      assert.ok(
        command.outputArtifactMirrorId && mirrorIds.has(command.outputArtifactMirrorId),
        "each QA command result must reference its log mirror",
      );
    }

    const commandEvidence = db.select().from(qaEvidence)
      .where(eq(qaEvidence.qaRunId, qaRun!.id)).all()
      .filter((row) => row.evidenceType === "command_log");
    assert.ok(commandEvidence.length > 0);
    for (const evidence of commandEvidence) {
      assert.ok(
        evidence.artifactMirrorId && mirrorIds.has(evidence.artifactMirrorId),
        "each QA evidence row must reference its log mirror",
      );
      assert.match(evidence.contentHash ?? "", /^[0-9a-f]{64}$/);
      assert.equal(evidence.contentHash, mirrorHashById.get(evidence.artifactMirrorId!));
    }

    assert.ok(db.select().from(findings).where(eq(findings.id, "FND-QA-OLD-P1")).get());
    assert.ok(
      db
        .select()
        .from(reviewPriorFindingReviews)
        .where(eq(reviewPriorFindingReviews.id, "RPFR-QA-OLD-P1"))
        .get()
    );
  });

  it("runs QA against the adopted Build workspace after failed fix runs wrote newer build-N files", async () => {
    seedChange(repoPath, "IMPLEMENTED");
    initGitRepoWithApp(repoPath);
    db.update(projects).set({ gitEnabled: 1 }).where(eq(projects.id, PROJECT_ID)).run();
    seedApprovedTestPlanSnapshot();
    const { headSha } = seedQaReadyReviewState(repoPath);

    // A Review P1 was waived after the user clicked 修复阻断项 twice and both fix
    // runs failed. Each failed attempt still leaves a newer build-N.json behind;
    // none of them may shadow the adopted build-1 that Review actually approved.
    const adoptedRun = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.ok(adoptedRun);
    assert.equal(adoptedRun.runNumber, 1);
    assert.equal(adoptedRun.status, "adopted");
    for (const runNumber of [2, 3]) {
      const failedFixRun = {
        ...adoptedRun,
        runNumber,
        status: "failed" as BuildRunStatus,
        purpose: "fix" as const,
        // A failed fix run never adopts, and its workspace is not a QA target.
        workspacePath: path.join(repoPath, ".missing-fix-workspace", `build-${runNumber}`),
        branchName: `stagepass/build/${CHANGE_ID}/build-${runNumber}`,
        adoptedHeadSha: null,
        adoptionDecisionId: null,
        blockers: ["Fix run produced no changes"],
        updatedAt: new Date().toISOString(),
      };
      writeBuildRun(repoPath, failedFixRun);
      recordBuildRunFromWorkspaceFile(repoPath, CHANGE_ID, failedFixRun);
    }
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.runNumber, 3);

    await runCheck(CHANGE_ID, makeTestJobExecutionContext("qa-after-failed-fix-runs"), {
      entrypoint: "api_check_route",
      actor: "human",
      expectedHeadSha: headSha,
    });

    assert.equal(currentStatus(), "MERGE_READY");
    const qaRun = db.select().from(qaRuns).where(eq(qaRuns.changeId, CHANGE_ID)).get();
    assert.equal(
      qaRun?.sourceBuildRunId,
      "build-1",
      "QA must validate the adopted build Review approved, not the newest failed fix run",
    );
  });

  it("fails QA instead of falling back to the main repo when the approved workspace is missing", async () => {
    seedChange(repoPath, "IMPLEMENTED");
    initGitRepoWithApp(repoPath);
    db.update(projects).set({ gitEnabled: 1 }).where(eq(projects.id, PROJECT_ID)).run();
    seedApprovedTestPlanSnapshot();
    const { headSha } = seedQaReadyReviewState(repoPath);
    const buildRun = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.ok(buildRun);
    writeBuildRun(repoPath, {
      ...buildRun,
      workspacePath: path.join(repoPath, ".missing-approved-workspace"),
      updatedAt: new Date().toISOString(),
    });

    await assert.rejects(
      () => runCheck(CHANGE_ID, makeTestJobExecutionContext("qa-missing-workspace"), {
        entrypoint: "api_check_route",
        actor: "human",
        expectedHeadSha: headSha,
      }),
      /approved Build workspace is missing/,
    );

    const localCheckRuns = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .filter((run) => run.phase === "local_check");
    assert.equal(localCheckRuns.length, 0);
    assert.equal(currentStatus(), "IMPLEMENTED");
  });

  it("marks QA failed instead of leaving CHECKING when check execution throws after start", async () => {
    seedChange(repoPath, "IMPLEMENTED");
    initGitRepoWithApp(repoPath);
    db.update(projects).set({ gitEnabled: 1 }).where(eq(projects.id, PROJECT_ID)).run();
    seedApprovedTestPlanSnapshot();
    const { headSha } = seedQaReadyReviewState(repoPath);
    const runsPath = path.join(repoPath, ".ship", "changes", CHANGE_ID, "runs");
    fs.mkdirSync(path.dirname(runsPath), { recursive: true });
    fs.writeFileSync(runsPath, "not a directory\n");

    const failedQaContext = makeTestJobExecutionContext("qa-check-execution-failure");
    await assert.rejects(
      () => runCheck(CHANGE_ID, failedQaContext, {
        entrypoint: "api_check_route",
        actor: "human",
        expectedHeadSha: headSha,
      }),
      /ENOTDIR|not a directory/i
    );

    assert.equal(currentStatus(), "CHECK_FAILED");
    const latestRun = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .filter((run) => run.phase === "local_check")
      .at(-1);
    assert.equal(latestRun?.status, "failed");
    const qaRun = db
      .select()
      .from(qaRuns)
      .where(eq(qaRuns.changeId, CHANGE_ID))
      .get();
    assert.equal(qaRun?.status, "failed");
    const qaGate = db
      .select()
      .from(stageGates)
      .where(eq(stageGates.changeId, CHANGE_ID))
      .all()
      .filter((gate) => gate.phase === "QA")
      .at(-1);
    assert.equal(qaGate?.status, "failed");
    settleTestPipelineJob(failedQaContext, "failed");
  });

  it("does not record a main-repo delivery HEAD during QA", async () => {
    seedChange(repoPath, "IMPLEMENTED");
    initGitRepoWithApp(repoPath);
    db.update(projects).set({ gitEnabled: 1 }).where(eq(projects.id, PROJECT_ID)).run();
    seedApprovedTestPlanSnapshot();
    const { headSha } = seedQaReadyReviewState(repoPath);

    await runCheck(CHANGE_ID, makeTestJobExecutionContext("qa-no-main-delivery-head"), {
      entrypoint: "api_check_route",
      actor: "human",
      expectedHeadSha: headSha,
    });

    assert.equal(currentStatus(), "MERGE_READY");
    const qaRun = db.select().from(qaRuns).where(eq(qaRuns.changeId, CHANGE_ID)).get();
    assert.equal(qaRun?.status, "passed");
    const deliveryEvidence = qaRun
      ? db
          .select()
          .from(qaEvidence)
          .where(eq(qaEvidence.qaRunId, qaRun.id))
          .all()
          .find((candidate) => candidate.evidenceType === "qa_delivery_head")
      : null;
    assert.equal(deliveryEvidence, undefined);
  });

  it("blocks direct runCheck calls with the Review QA gate before creating a local check run", async () => {
    seedChange(repoPath, "IMPLEMENTED");

    await assert.rejects(
      () => runCheck(CHANGE_ID, makeTestJobExecutionContext("qa-review-gate-blocked")),
      (err) => {
        assert.equal((err as { status?: number }).status, 409);
        const envelope = (err as { envelope?: { error?: string; action?: { actionId?: string; enabled?: boolean; reasonCode?: string | null }; actions?: unknown[] } }).envelope;
        assert.equal(envelope?.error, "action_not_allowed");
        assert.equal(envelope?.action?.actionId, "enter_qa");
        assert.equal(envelope?.action?.enabled, false);
        assert.equal(envelope?.action?.reasonCode, "no_latest_valid_review");
        assert.ok(Array.isArray(envelope?.actions));
        return true;
      },
    );

    assert.equal(currentStatus(), "IMPLEMENTED");
    const localCheckRuns = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .filter((run) => run.phase === "local_check");
    assert.equal(localCheckRuns.length, 0);
  });

  it("blocks QA preflight with an action contract when TestPlan DB gate is not ready", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        return {
          threadId: `${CHANGE_ID}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${CHANGE_ID}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    await runReview(CHANGE_ID, makeTestJobExecutionContext("review-qa-action-contract"));
    db.delete(requiredValidationCommands)
      .where(eq(requiredValidationCommands.changeId, CHANGE_ID))
      .run();
    db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();

    assert.throws(
      () => assertCanRunCheck(CHANGE_ID, { entrypoint: "api_check_route", actor: "human" }),
      (err) => {
        assert.equal((err as { status?: number }).status, 409);
        const envelope = (err as { envelope?: { error?: string; action?: { actionId?: string; enabled?: boolean; reasonCode?: string | null } } }).envelope;
        assert.equal(envelope?.error, "action_not_allowed");
        assert.equal(envelope?.action?.actionId, "enter_qa");
        assert.equal(envelope?.action?.enabled, false);
        return true;
      },
    );

    const localCheckRuns = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .filter((run) => run.phase === "local_check");
    assert.equal(localCheckRuns.length, 0);
  });

  it("allows Review reruns from CHECK_FAILED while open Review blockers need re-review", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        return {
          threadId: `${CHANGE_ID}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(validReviewOutput({
            priorFindingReviews: [
              {
                priorFindingId: "FND-RERUN-P1",
                verdict: "fixed",
                evidence: "The prior blocker is no longer valid under the Review scope.",
                requiredFix: null,
                replacementFindingId: null,
                reviewerNotes: "System metadata is excluded from Review scope.",
              },
            ],
          })),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${CHANGE_ID}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    seedOpenReviewFinding("FND-RERUN-P1");
    db.update(changes).set({ status: "CHECK_FAILED" }).where(eq(changes.id, CHANGE_ID)).run();

    const result = await runReview(CHANGE_ID, makeTestJobExecutionContext("review-rerun-check-failed"));

    assert.equal(result.approved, true);
    assert.equal(currentStatus(), "IMPLEMENTED");
    assert.equal(db.select().from(findings).where(eq(findings.id, "FND-RERUN-P1")).get()?.status, "fixed");
  });

  it("rejects plan generation from DRAFT before starting a run", async () => {
    seedChange(repoPath, "DRAFT");

    await assert.rejects(
      () => generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-invalid-status")),
      /Invalid status/,
    );

    assert.equal(currentStatus(), "DRAFT");
    assert.equal(db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all().length, 0);
  });

  /**
   * The 8ac5c4ec dead end (TechSpec) with the Plan stage's own shape, which that
   * commit named as the highest remaining priority: a generate_plan run killed
   * mid-flight leaves the change claiming PLANNING with no run behind it, and
   * every retry then dies in assertStatus BEFORE the ledger can create a run --
   * so nothing can ever roll the status back either. The contract made it worse
   * by advertising retry_plan at every status, so GET /gate reported it enabled
   * and POST returned 202 while every dispatch failed with `Invalid status:
   * PLANNING. Expected: PLAN_READY, TECHSPEC_READY`.
   *
   * Plan does not run through runDocumentStage (pipeline-job-runner-service
   * dispatches generate_plan straight to generatePlan), so the recovery
   * 8ac5c4ec added to that runner never reached this stage.
   */
  function strandChangeAtPlanning(leftoverRunStatus: "failed" | "running") {
    seedChange(repoPath, "TECHSPEC_READY");
    const now = new Date().toISOString();
    db.insert(runs).values({
      id: "RUN-STRANDED-PLAN",
      changeId: CHANGE_ID,
      phase: "generate_plan",
      status: leftoverRunStatus,
      startedAt: now,
      endedAt: leftoverRunStatus === "failed" ? now : null,
      summary: leftoverRunStatus === "failed" ? "stale_lease_fenced" : null,
    }).run();
    db.update(changes)
      .set({ status: "PLANNING", updatedAt: now })
      .where(eq(changes.id, CHANGE_ID))
      .run();
  }

  function stubPlanEngine(plan = validStructuredPlan()) {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: planLineProtocolText(plan),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));
  }

  it("retries plan generation to completion after a killed run stranded the change at PLANNING", async () => {
    strandChangeAtPlanning("failed");
    stubPlanEngine();

    // The retry must actually EXECUTE, not merely be offered: before this it
    // threw `Invalid status: PLANNING. Expected: PLAN_READY, TECHSPEC_READY`
    // every time.
    await generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-stranded-retry"));

    assert.equal(currentStatus(), "PLAN_READY");
    assert.equal(artifactExists(repoPath, "plan.json"), true);

    // The change genuinely passed back through TECHSPEC_READY -- the rollback
    // target the sweeper itself would have used
    // (fallbackStatusByProviderPhase.generate_plan) and the only non-BLOCKED
    // exit ALLOWED_TRANSITIONS grants PLANNING besides PLAN_READY -- rather
    // than assertStatus being loosened to tolerate PLANNING.
    const recovery = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "change_status_changed" &&
        event.rawJson?.includes("plan_stage_stranded_status_recovery") &&
        event.rawJson?.includes("\"from\":\"PLANNING\"") &&
        event.rawJson?.includes("\"to\":\"TECHSPEC_READY\""));
    assert.ok(recovery, "the stranded PLANNING status should be recorded as recovered");

    // A generate_plan run really ran, so the change is no longer holding the
    // project's single-active-change slot on a run that does not exist.
    const completed = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .filter((run) => run.phase === "generate_plan" && run.status === "completed");
    assert.equal(completed.length, 1);
  });

  it("refuses to hijack a plan run that is still in flight", async () => {
    strandChangeAtPlanning("running");
    stubPlanEngine();

    // PLANNING is only a lie when no run backs it. With a live run the guard
    // must still reject, otherwise the recovery becomes a way to start a second
    // concurrent generate_plan -- which is also what would happen if anyone
    // "fixed" this by adding PLANNING to assertStatus's allowed list.
    await assert.rejects(
      () => generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-live-run")),
      /Invalid status: PLANNING\. Expected: PLAN_READY, TECHSPEC_READY/,
    );
    assert.equal(currentStatus(), "PLANNING");
  });

  for (const status of ["PLAN_APPROVED", "IMPLEMENTING", "DONE"] as const) {
    it(`still refuses to generate a plan from ${status}`, async () => {
      seedChange(repoPath, status);
      stubPlanEngine();

      // Only the stage's own running status is recoverable. Any other status is
      // a real violation and must stay a hard failure -- guarding against the
      // easy over-loosening fix of widening assertStatus.
      await assert.rejects(
        () => generatePlan(CHANGE_ID, makeTestJobExecutionContext(`plan-from-${status}`)),
        new RegExp(`Invalid status: ${status}\\. Expected: PLAN_READY, TECHSPEC_READY`),
      );
      assert.equal(currentStatus(), status);
      assert.equal(db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all().length, 0);
    });
  }

  it("assembles the plan deterministically from line-protocol summary lines", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    const context = makeTestJobExecutionContext("plan-lifecycle-success");
    const plan = validStructuredPlan();
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        await emitProviderLifecycle(input.lifecycle, "completed", "plan-success");
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: planLineProtocolText(plan),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    const result = await generatePlan(CHANGE_ID, context);

    assert.equal(currentStatus(), "PLAN_READY");
    assertProviderLifecycle("generate_plan", "completed", context);
    assert.deepEqual(result.structuredOutput, plan);
    assert.equal(artifactExists(repoPath, "plan.json"), true);
    assert.equal(artifactExists(repoPath, "plan.md"), true);
    assert.equal(
      db.select().from(planSnapshots).where(eq(planSnapshots.changeId, CHANGE_ID)).all().length,
      1
    );
  });

  it("rejects plan generation when structuredOutput is missing and summary is not parseable", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "Generated a plan, but not JSON.",
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-unparseable-output")),
      /invalid_stage_output/i,
    );

    assert.equal(currentStatus(), "TECHSPEC_READY");
    assert.equal(artifactExists(repoPath, "plan.json"), false);
    assert.equal(artifactExists(repoPath, "plan.md"), false);
    assert.equal(
      db.select().from(planSnapshots).where(eq(planSnapshots.changeId, CHANGE_ID)).all().length,
      0
    );
    assert.equal(stageRawOutputRows().length, 1);
    assert.equal(
      db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all()
        .filter((artifact) => artifact.type === "stage_raw_output").length,
      1
    );
    await assert.rejects(() => approvePlan(CHANGE_ID, PLAN_APPROVAL_CONTEXT), /Invalid status|Plan cannot be approved/);
  });

  it("treats Plan provider failure as failed even if the summary looks structured, preserving raw capture", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    const plan = validStructuredPlan();
    const rawSummary = JSON.stringify(plan);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: rawSummary,
          success: false,
          changedFiles: [],
          structuredOutput: plan,
          providerErrorCode: "provider_unavailable",
          providerErrorDetail: "backend unavailable",
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-provider-failure")),
      /provider_unavailable|backend unavailable|invalid_stage_output/,
    );

    assert.equal(currentStatus(), "TECHSPEC_READY");
    assert.equal(
      db.select().from(planSnapshots).where(eq(planSnapshots.changeId, CHANGE_ID)).all().length,
      0
    );
    const rawCapture = stageRawOutputRows()[0];
    assert.ok(rawCapture);
    const payload = JSON.parse(rawCapture.rawJson ?? "{}") as {
      stageRawOutput?: {
        rawTextHash?: string;
        providerErrorCode?: string | null;
        sanitizedErrorSummary?: string;
      };
    };
    const sanitizedRawText = "provider_run_failed: backend unavailable";
    assert.equal(payload.stageRawOutput?.rawTextHash, sha256Text(sanitizedRawText));
    assert.equal(payload.stageRawOutput?.providerErrorCode, "provider_unavailable");
    assert.match(payload.stageRawOutput?.sanitizedErrorSummary ?? "", /backend unavailable/);
  });

  it("refuses to resurrect model-authored plan JSON when protocol lines are absent", async () => {
    // Mirrors the test_plan resurrection guard: even a schema-valid JSON
    // payload (declared or in prose) must not become a plan snapshot — the
    // line protocol is the only accepted source.
    seedChange(repoPath, "TECHSPEC_READY");
    const plan = validStructuredPlan();
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `没有协议行，但这里有 JSON：\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``,
          success: true,
          changedFiles: [],
          structuredOutput: plan,
          structuredOutputSource: "provider_native",
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-json-resurrection")),
      /line protocol|invalid_stage_output/i,
    );

    assert.equal(currentStatus(), "TECHSPEC_READY");
    assert.equal(artifactExists(repoPath, "plan.json"), false);
    assert.equal(artifactExists(repoPath, "plan.md"), false);
    assert.equal(
      db.select().from(planSnapshots).where(eq(planSnapshots.changeId, CHANGE_ID)).all().length,
      0
    );
  });

  it("rejects plan generation when the PLAN line is missing", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    const plan = validStructuredPlan();
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: planLineProtocolText(plan).split("\n").filter((line) => !line.startsWith("PLAN:")).join("\n"),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-missing-name")),
      /exactly 1 PLAN line/,
    );

    assert.equal(currentStatus(), "TECHSPEC_READY");
    assert.equal(artifactExists(repoPath, "plan.json"), false);
    assert.equal(artifactExists(repoPath, "plan.md"), false);
  });

  it("rejects plan generation when a STEP line omits the status field", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: [
            "PLAN: 缺状态的计划",
            "EXPECT: src/app.ts",
            "STEP: 1 | src/app.ts | 修改 app 值",
          ].join("\n"),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-step-missing-status")),
      /STEP needs 4/,
    );

    assert.equal(currentStatus(), "TECHSPEC_READY");
    assert.equal(artifactExists(repoPath, "plan.json"), false);
    assert.equal(artifactExists(repoPath, "plan.md"), false);
  });

  it("rejects plan generation when a STEP status value is invalid", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: [
            "PLAN: 状态非法的计划",
            "EXPECT: src/app.ts",
            "STEP: 1 | src/app.ts | later | 修改 app 值",
          ].join("\n"),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-summary-step-missing-status")),
      /status must be pending\/blocked\/done/,
    );

    assert.equal(currentStatus(), "TECHSPEC_READY");
    assert.equal(artifactExists(repoPath, "plan.json"), false);
    assert.equal(artifactExists(repoPath, "plan.md"), false);
  });

  it("requests expectedFiles instead of legacy allowedFiles for new Plan structured output", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    let planSchema: unknown = null;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        planSchema = input.outputSchema;
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: planLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-expected-files-schema"));

    // Line-protocol stage: the JSON schema stays server-side (second gate);
    // the engine must not receive it, and expectedFiles arrive via EXPECT
    // lines assembled by stagepass, not model-authored JSON.
    assert.equal(planSchema, undefined);
    const snapshot = db
      .select()
      .from(planSnapshots)
      .where(eq(planSnapshots.changeId, CHANGE_ID))
      .get();
    assert.ok(snapshot);
    assert.deepEqual(JSON.parse(snapshot.expectedFilesJson ?? "[]"), [
      "server/services/pipeline-service.ts",
      "server/services/pipeline-service.test.ts",
    ]);
  });

  it("writes plan artifacts and a fresh plan report before marking the plan ready", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: planLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-artifacts-and-report"));

    assert.equal(currentStatus(), "PLAN_READY");
    assert.equal(artifactExists(repoPath, "plan.json"), true);
    assert.equal(artifactExists(repoPath, "plan.md"), true);
    const snapshot = db
      .select()
      .from(planSnapshots)
      .where(eq(planSnapshots.changeId, CHANGE_ID))
      .get();
    assert.ok(snapshot);
    assert.equal(snapshot.status, "ready");
    assert.equal(
      db.select().from(planSteps).where(eq(planSteps.planSnapshotId, snapshot.id)).all().length,
      2
    );
    assert.deepEqual(
      db.select()
        .from(requiredValidationCommands)
        .where(eq(requiredValidationCommands.sourceSnapshotId, snapshot.id))
        .all()
        .map((command) => command.command),
      ["npm test -- server/services/pipeline-service.test.ts"]
    );
    const planMarkdown = fs.readFileSync(
      path.join(repoPath, ".ship", "changes", CHANGE_ID, "plan.md"),
      "utf-8"
    );
    assert.match(planMarkdown, /^# Pipeline plan gate hardening/m);
    assert.match(planMarkdown, /Status: pending/);
    assert.match(planMarkdown, /Status: blocked/);
    assert.equal(artifactExists(repoPath, path.join("reports", "plan-report.md")), true);
    const report = fs.readFileSync(
      path.join(repoPath, ".ship", "changes", CHANGE_ID, "reports", "plan-report.md"),
      "utf-8"
    );
    assert.match(report, /Verdict: can_approve/);
  });

  it("keeps DB Plan ready when post-commit mirror writing fails", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: planLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));
    const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
    fs.mkdirSync(changeDir, { recursive: true });
    fs.symlinkSync(path.join(repoPath, "outside-plan.json"), path.join(changeDir, "plan.json"));

    await generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-mirror-write-failure"));

    assert.equal(currentStatus(), "PLAN_READY");
    const snapshot = db
      .select()
      .from(planSnapshots)
      .where(eq(planSnapshots.changeId, CHANGE_ID))
      .get();
    assert.ok(snapshot);
    assert.equal(snapshot.status, "ready");
    const run = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .find((row) => row.phase === "generate_plan");
    assert.equal(run?.status, "completed");
    const sideEffectEvent = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) => event.type === "stage_post_commit_side_effect_failed");
    assert.ok(sideEffectEvent);
    assert.match(sideEffectEvent.rawJson ?? "", /plan_mirror_write/);
  });

  it("generates Plan report from DB snapshot without carrying stale critique risks", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    writeChangeFile(
      repoPath,
      "plan-critique.json",
      `${JSON.stringify({
        risks: [
          {
            id: "stale-risk",
            severity: "P1",
            category: "scope",
            title: "Old critique should not block a fresh generated plan",
            evidence: "Previous Plan round risk.",
            requiredPlanChange: "Regenerate the plan.",
            affectedStepNumbers: [1],
            status: "open",
            waiverReason: null,
          },
        ],
      }, null, 2)}\n`
    );
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: planLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-ignore-stale-risks"));

    const report = fs.readFileSync(
      path.join(repoPath, ".ship", "changes", CHANGE_ID, "reports", "plan-report.md"),
      "utf-8"
    );
    assert.match(report, /Verdict: can_approve/);
    assert.doesNotMatch(report, /Old critique should not block/);
    const gate = db.select().from(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).all()
      .find((row) => row.phase === "Plan");
    assert.equal(gate?.status, "passed");
    const state = getPlanSandboxState(CHANGE_ID);
    assert.equal(state.gate.canApprove, true);
    assert.equal(state.status, "report_ready");
    assert.equal(state.risks.length, 0);
  });

  it("keeps DB Plan ready when post-commit report writing fails", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: planLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));
    const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
    fs.mkdirSync(changeDir, { recursive: true });
    fs.symlinkSync(path.join(repoPath, "external-reports"), path.join(changeDir, "reports"));

    await generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-report-write-failure"));

    assert.equal(currentStatus(), "PLAN_READY");
    const snapshot = db
      .select()
      .from(planSnapshots)
      .where(eq(planSnapshots.changeId, CHANGE_ID))
      .get();
    assert.ok(snapshot);
    assert.equal(snapshot.status, "ready");
    assert.equal(artifactExists(repoPath, "plan.json"), true);
    assert.equal(artifactExists(repoPath, "plan.md"), true);
    const run = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .find((row) => row.phase === "generate_plan");
    assert.equal(run?.status, "completed");
    const sideEffectEvent = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "stage_post_commit_side_effect_failed" &&
        event.rawJson?.includes("plan_report_write")
    );
    assert.ok(sideEffectEvent);
  });

  it("refreshes Plan stage authority when reusing an unchanged generated snapshot", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    const plan = validStructuredPlan();
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: planLineProtocolText(plan),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-authority-first-run"));
    const firstSnapshot = db
      .select()
      .from(planSnapshots)
      .where(eq(planSnapshots.changeId, CHANGE_ID))
      .get();
    assert.ok(firstSnapshot);

    db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
    db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
    db.delete(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).run();
    db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();

    await generatePlan(CHANGE_ID, makeTestJobExecutionContext("plan-authority-second-run"));

    const snapshots = db
      .select()
      .from(planSnapshots)
      .where(eq(planSnapshots.changeId, CHANGE_ID))
      .all();
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.id, firstSnapshot.id);
    const gate = db.select().from(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).all()
      .find((row) => row.phase === "Plan");
    const state = db.select().from(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).all()
      .find((row) => row.phase === "Plan");
    const run = db.select().from(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).all()
      .find((row) => row.phase === "Plan");
    const report = db.select().from(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).all()
      .find((row) => row.phase === "Plan");
    assert.equal(gate?.status, "passed");
    assert.equal(gate?.sourceDbHash, firstSnapshot.snapshotDbHash);
    assert.equal(state?.latestRunId, run?.id);
    assert.equal(state?.latestReportId, report?.id);
    assert.equal(state?.latestGateId, gate?.id);
    assert.equal(state?.latestValidReportId, report?.id);
    assert.equal(state?.dbHash, firstSnapshot.snapshotDbHash);
    const approvePlanAction = getActions(CHANGE_ID).find((action) => action.actionId === "approve_plan");
    assert.equal(approvePlanAction?.enabled, true);
    assert.equal(approvePlanAction?.sourceDbHash, firstSnapshot.snapshotDbHash);
  });

  it("rejects plan approval when plan.md is missing", async () => {
    seedChange(repoPath, "PLAN_READY");
    writeChangeFile(repoPath, "plan.json", `${JSON.stringify(validStructuredPlan(), null, 2)}\n`);

    await assert.rejects(() => approvePlan(CHANGE_ID, PLAN_APPROVAL_CONTEXT), /plan\.md|Plan cannot be approved/);

    assert.equal(currentStatus(), "PLAN_READY");
  });

  it("rejects service-layer plan approval without explicit preflight context", async () => {
    seedChange(repoPath, "PLAN_READY");
    writePlanArtifacts(repoPath);

    await assert.rejects(() => approvePlan(CHANGE_ID), /preflight/i);

    assert.equal(currentStatus(), "PLAN_READY");
  });

  it("rejects plan approval when a blocker risk remains open", async () => {
    seedChange(repoPath, "PLAN_READY");
    writePlanArtifacts(repoPath);
    writeChangeFile(
      repoPath,
      "plan-critique.json",
      `${JSON.stringify({
        risks: [
          {
            id: "risk-p1",
            severity: "P1",
            category: "scope",
            title: "Scope can drift",
            evidence: "The plan allows extra files.",
            requiredPlanChange: "Restrict the allowed files.",
            affectedStepNumbers: [1],
            status: "open",
            waiverReason: null,
          },
        ],
      }, null, 2)}\n`
    );
    regeneratePlanReport(CHANGE_ID);

    await assert.rejects(() => approvePlan(CHANGE_ID, PLAN_APPROVAL_CONTEXT), /blockingP1|Plan cannot be approved/);

    assert.equal(currentStatus(), "PLAN_READY");
  });

  it("keeps test planning separate from implementation", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    initGitRepoWithApp(repoPath);

    const testPlanContext = makeTestJobExecutionContext("test-plan-separate-from-build");
    await runTestPlan(CHANGE_ID, testPlanContext);
    settleTestPipelineJob(testPlanContext);

    assert.equal(currentStatus(), "TESTPLAN_DONE");
    assert.equal(artifactExists(repoPath, "test-plan-delta.md"), true);
    const snapshot = db
      .select()
      .from(testplanSnapshots)
      .where(eq(testplanSnapshots.changeId, CHANGE_ID))
      .get();
    assert.ok(snapshot);
    const commands = db
      .select()
      .from(requiredValidationCommands)
      .where(eq(requiredValidationCommands.changeId, CHANGE_ID))
      .all()
      .filter((command) => command.phase === "TestPlan")
      .sort((left, right) => left.commandOrder - right.commandOrder);
    assert.deepEqual(commands.map((command) => command.command), [
      "node -e \"console.log('testplan db command')\"",
    ]);
    const actions = getActions(CHANGE_ID);
    const runBuild = actions.find((action) => action.actionId === "run_build");
    const approvePlanAction = actions.find((action) => action.actionId === "approve_plan");
    assert.equal(runBuild?.enabled, false);
    assert.equal(runBuild?.reasonCode, "not_at_gate");
    assert.equal(approvePlanAction?.enabled, true);
    assert.equal(artifactExists(repoPath, "implement-summary.md"), false);
    const implementRuns = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .filter((run) => run.phase === "implement");
    assert.equal(implementRuns.length, 0);
  });

  it("runs TestPlan with the test_plan engine phase and document-stage timeout", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    setDocumentStageTimeoutMsForTest(5432);
    let observedPhase: string | undefined;
    let observedTimeoutMs: number | undefined;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        observedPhase = input.phase;
        observedTimeoutMs = input.timeoutMs;
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: validTestPlanLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runTestPlan(CHANGE_ID, makeTestJobExecutionContext("test-plan-engine-phase"));

    assert.equal(observedPhase, "test_plan");
    assert.equal(observedTimeoutMs, 5432);
    assert.equal(currentStatus(), "TESTPLAN_DONE");
  });

  /**
   * The 8ac5c4ec dead end read backwards. TestPlan runs through
   * runDocumentStage, so it has had recoverStrandedRunningStatus since that
   * commit and CAN repair a change stranded at TESTPLANNING -- but
   * retry_test_plan's contract pinned requiredStatus to PLAN_APPROVED alone, so
   * nothing could ever enqueue the retry that performs the repair. The mirror of
   * the a9a953f2 phantom: not a button whose job always fails, but a working
   * recovery no button can reach.
   *
   * These pin the runner half that the contract now advertises. Without a run
   * that actually completes from TESTPLANNING, widening the contract would just
   * move the dead end one layer out.
   */
  function strandChangeAtTestPlanning(leftoverRunStatus: "failed" | "running") {
    seedChange(repoPath, "PLAN_APPROVED");
    const now = new Date().toISOString();
    db.insert(runs).values({
      id: "RUN-STRANDED-TESTPLAN",
      changeId: CHANGE_ID,
      phase: "test_plan",
      status: leftoverRunStatus,
      startedAt: now,
      endedAt: leftoverRunStatus === "failed" ? now : null,
      summary: leftoverRunStatus === "failed" ? "stale_lease_fenced" : null,
    }).run();
    db.update(changes)
      .set({ status: "TESTPLANNING", updatedAt: now })
      .where(eq(changes.id, CHANGE_ID))
      .run();
  }

  function stubTestPlanEngine() {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: validTestPlanLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));
  }

  it("retries the test plan to completion after a killed run stranded the change at TESTPLANNING", async () => {
    strandChangeAtTestPlanning("failed");
    stubTestPlanEngine();

    // The retry must EXECUTE, not merely be offered. runDocumentStage repairs
    // the stranded claim before assertStatus reads it, so this reaches a real
    // run instead of throwing `Invalid status: TESTPLANNING. Expected:
    // PLAN_APPROVED` outside the ledger.
    await runTestPlan(CHANGE_ID, makeTestJobExecutionContext("test-plan-stranded-retry"));

    assert.equal(currentStatus(), "TESTPLAN_DONE");
    assert.equal(artifactExists(repoPath, "test-plan-delta.md"), true);

    // It genuinely passed back through PLAN_APPROVED -- the stage's own
    // failureStatus and the sweeper's rollback target for this phase
    // (fallbackStatusByProviderPhase.test_plan) agree on it -- rather than
    // assertStatus being loosened to tolerate TESTPLANNING.
    const recovery = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "change_status_changed" &&
        event.rawJson?.includes("document_stage_stranded_status_recovery") &&
        event.rawJson?.includes("\"phase\":\"test_plan\"") &&
        event.rawJson?.includes("\"from\":\"TESTPLANNING\""));
    assert.ok(recovery, "the stranded TESTPLANNING status should be recorded as recovered");

    const completed = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .filter((run) => run.phase === "test_plan" && run.status === "completed");
    assert.equal(completed.length, 1);
  });

  it("refuses to hijack a test plan run that is still in flight", async () => {
    strandChangeAtTestPlanning("running");
    stubTestPlanEngine();

    // TESTPLANNING is only a lie when no run backs it. With a live run the
    // guard must still reject, otherwise the recovery becomes a way to start a
    // second concurrent test_plan -- which is exactly what would happen if
    // anyone "fixed" this by adding TESTPLANNING to allowedStatuses instead.
    await assert.rejects(
      () => runTestPlan(CHANGE_ID, makeTestJobExecutionContext("test-plan-live-run")),
      /Invalid status: TESTPLANNING\. Expected: PLAN_APPROVED/,
    );
    assert.equal(currentStatus(), "TESTPLANNING");
  });

  for (const status of ["PLAN_READY", "IMPLEMENTING", "DONE"] as const) {
    it(`still refuses to run a test plan from ${status}`, async () => {
      seedChange(repoPath, status);
      stubTestPlanEngine();

      // Only the stage's own running status is recoverable. Everything else is
      // a real violation and stays a hard failure.
      await assert.rejects(
        () => runTestPlan(CHANGE_ID, makeTestJobExecutionContext(`test-plan-from-${status}`)),
        new RegExp(`Invalid status: ${status}\\. Expected: PLAN_APPROVED`),
      );
      assert.equal(currentStatus(), status);
      assert.equal(db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all().length, 0);
    });
  }

  it("rejects outputSchema document stages when structuredOutput is missing and summary is not parseable", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "I drafted a test plan in prose only.",
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          structuredOutputSource: "none",
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runTestPlan(CHANGE_ID, makeTestJobExecutionContext("test-plan-missing-structured-output")),
      /structuredOutput|structured output|invalid_stage_output/i,
    );

    assert.equal(currentStatus(), "PLAN_APPROVED");
    assert.equal(db.select().from(testplanSnapshots).where(eq(testplanSnapshots.changeId, CHANGE_ID)).all().length, 0);

    const run = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).get();
    assert.equal(run?.status, "failed");
    const rawCaptureEvent = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "stage_raw_output" &&
        event.runId === run?.id &&
        event.rawJson?.includes("\"phase\":\"test_plan\"") &&
        event.rawJson?.includes("\"structuredOutputSource\":\"none\"") &&
        event.rawJson?.includes("\"errorCode\":\"invalid_stage_output\"")
      );
    assert.ok(rawCaptureEvent);
  });

  it("refuses to resurrect model-authored testplan JSON when protocol lines are absent", async () => {
    // The line protocol is authoritative for test_plan: even a perfectly
    // schema-valid JSON block in the model's prose must NOT be extracted or
    // repaired into the snapshot — that resurrection path is exactly how the
    // observed `},{`/`js1024` command corruption reached QA.
    seedChange(repoPath, "PLAN_APPROVED");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `没有协议行，但这里有一段 JSON：\n\`\`\`json\n${JSON.stringify(validStructuredTestPlan())}\n\`\`\``,
          success: true,
          changedFiles: [],
          structuredOutput: validStructuredTestPlan(),
          structuredOutputSource: "provider_native",
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runTestPlan(CHANGE_ID, makeTestJobExecutionContext("test-plan-json-resurrection")),
      /line protocol|invalid_stage_output|structured/i,
    );

    assert.equal(currentStatus(), "PLAN_APPROVED");
    assert.equal(db.select().from(testplanSnapshots).where(eq(testplanSnapshots.changeId, CHANGE_ID)).all().length, 0);
  });

  it("captures raw output for outputSchema document-stage provider failure", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "provider crashed before structured output",
          success: false,
          changedFiles: [],
          providerErrorCode: "provider_run_failed",
          providerErrorDetail: "backend unavailable",
          structuredOutput: validStructuredTestPlan(),
          structuredOutputSource: "provider_native",
          schemaDelivery: "provider_native",
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runTestPlan(CHANGE_ID, makeTestJobExecutionContext("test-plan-provider-failure")),
      (error: unknown) => {
        assert.match(String(error), /provider_run_failed|backend unavailable/);
        return true;
      },
    );

    assert.equal(currentStatus(), "PLAN_APPROVED");
    assert.equal(db.select().from(testplanSnapshots).where(eq(testplanSnapshots.changeId, CHANGE_ID)).all().length, 0);

    const run = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).get();
    assert.equal(run?.phase, "test_plan");
    assert.equal(run?.status, "failed");
    assert.match(run?.summary ?? "", /provider_run_failed: backend unavailable/);
    const rawCaptureEvent = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "stage_raw_output" &&
        event.runId === run?.id &&
        event.rawJson?.includes("\"phase\":\"test_plan\"") &&
        event.rawJson?.includes("\"errorCode\":\"provider_run_failed\"") &&
        event.rawJson?.includes("\"providerErrorCode\":\"provider_run_failed\"")
      );
    assert.ok(rawCaptureEvent);
    const rawCaptureArtifact = db.select().from(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).all()
      .find((artifact) => artifact.type === "stage_raw_output" && artifact.runId === run?.id);
    assert.ok(rawCaptureArtifact);
    assert.equal(fs.existsSync(rawCaptureArtifact.path), true);
    const rawCapture = JSON.parse(fs.readFileSync(rawCaptureArtifact.path, "utf-8"));
    assert.equal(rawCapture.errorCode, "provider_run_failed");
    assert.equal(rawCapture.providerErrorCode, "provider_run_failed");
    assert.equal(rawCapture.rawText, "provider_run_failed: backend unavailable");
    assert.equal(rawCapture.rawTextHash, sha256Text(rawCapture.rawText));
    assert.match(rawCapture.sanitizedErrorSummary ?? "", /backend unavailable/);
  });

  it("uses the shared thirty minute default timeout for TestPlan document-stage runs", async () => {
    const previousTimeout = process.env.STAGEPASS_TEST_PLAN_TIMEOUT_MS;
    delete process.env.STAGEPASS_TEST_PLAN_TIMEOUT_MS;
    seedChange(repoPath, "PLAN_APPROVED");
    let observedTimeoutMs: number | undefined;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        observedTimeoutMs = input.timeoutMs;
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: validTestPlanLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    try {
      await runTestPlan(CHANGE_ID, makeTestJobExecutionContext("test-plan-default-timeout"));
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.STAGEPASS_TEST_PLAN_TIMEOUT_MS;
      } else {
        process.env.STAGEPASS_TEST_PLAN_TIMEOUT_MS = previousTimeout;
      }
    }

    assert.equal(observedTimeoutMs, 30 * 60 * 1000);
  });

  it("keeps the claimed Spec run under one strict execution identity through terminal completion", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const context = makeTestJobExecutionContext("spec-strict-fence");

    await runSpec(CHANGE_ID, context);

    const specRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .find((candidate) => candidate.phase === "spec");
    assert.ok(specRun);
    assert.equal(specRun.jobId, context.jobId);
    assert.equal(specRun.workerId, context.workerId);
    assert.equal(specRun.leaseToken, context.leaseToken);
    assert.equal(specRun.attemptNo, context.attemptNo);
    assert.equal(specRun.status, "completed");
    assert.equal(currentStatus(), "SPEC_READY");
    assert.equal(artifactExists(repoPath, path.join("rounds", "spec-round-01-red.md")), true);
    assert.equal(artifactExists(repoPath, path.join("rounds", "spec-round-01-blue.json")), true);
    assert.equal(artifactExists(repoPath, path.join("reports", "spec-report.md")), true);
  });

  it("does not let a stale Spec attempt compensate after the Red provider returns", async () => {
    let markRedStarted: (() => void) | null = null;
    let releaseRed: (() => void) | null = null;
    const redStarted = new Promise<void>((resolve) => {
      markRedStarted = resolve;
    });
    const redRelease = new Promise<void>((resolve) => {
      releaseRed = resolve;
    });
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.phase === "spec") {
          markRedStarted?.();
          await redRelease;
        }
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-SPEC-RED-STALE",
          summary: redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));
    seedChange(repoPath, "INTAKE_READY");
    const staleContext = makeTestJobExecutionContext("spec-red-strict-fence");

    const specPromise = runSpec(CHANGE_ID, staleContext);
    await redStarted;
    const specRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .find((candidate) => candidate.phase === "spec");
    assert.ok(specRun);
    assert.equal(specRun.jobId, staleContext.jobId);
    assert.equal(specRun.leaseToken, staleContext.leaseToken);

    takeOverPipelineJob(staleContext, "spec-red-strict-fence");
    db.update(changes).set({ status: "INTAKE_READY" }).where(eq(changes.id, CHANGE_ID)).run();
    releaseRed?.();

    await assert.rejects(specPromise, (error: unknown) => {
      assert.ok(error instanceof StaleLeaseFenceError);
      return true;
    });
    assert.equal(currentStatus(), "INTAKE_READY");
    assert.equal(
      db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get()?.status,
      "red_running",
    );
    assert.equal(db.select().from(runs).where(eq(runs.id, specRun.id)).get()?.status, "running");
    assert.equal(db.select().from(redFixClaims).where(eq(redFixClaims.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(blueGapReviews).where(eq(blueGapReviews.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(warReports).where(eq(warReports.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(artifactExists(repoPath, path.join("rounds", "spec-round-01-red.md")), false);
    assert.equal(artifactExists(repoPath, path.join("rounds", "spec-round-01-blue.json")), false);
    assert.equal(artifactExists(repoPath, path.join("reports", "spec-report.md")), false);
  });

  it("does not let a stale Spec attempt write Blue results, reports, or final status", async () => {
    let markBlueStarted: (() => void) | null = null;
    let releaseBlue: (() => void) | null = null;
    const blueStarted = new Promise<void>((resolve) => {
      markBlueStarted = resolve;
    });
    const blueRelease = new Promise<void>((resolve) => {
      releaseBlue = resolve;
    });
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.phase === "spec_critic") {
          markBlueStarted?.();
          await blueRelease;
          return {
            threadId: `${input.changeId}-thread`,
            runId: "ENGINE-SPEC-BLUE-STALE",
            summary: blueCritiqueLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-SPEC-RED-CURRENT",
          summary: redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));
    seedChange(repoPath, "INTAKE_READY");
    const staleContext = makeTestJobExecutionContext("spec-blue-strict-fence");

    const specPromise = runSpec(CHANGE_ID, staleContext);
    await blueStarted;
    const specRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .find((candidate) => candidate.phase === "spec");
    assert.ok(specRun);
    assert.equal(
      db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get()?.status,
      "blue_running",
    );

    takeOverPipelineJob(staleContext, "spec-blue-strict-fence");
    db.update(changes).set({ status: "INTAKE_READY" }).where(eq(changes.id, CHANGE_ID)).run();
    releaseBlue?.();

    await assert.rejects(specPromise, (error: unknown) => {
      assert.ok(error instanceof StaleLeaseFenceError);
      return true;
    });
    assert.equal(currentStatus(), "INTAKE_READY");
    assert.equal(
      db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get()?.status,
      "blue_running",
    );
    assert.equal(db.select().from(blueGapReviews).where(eq(blueGapReviews.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(warReports).where(eq(warReports.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(artifactExists(repoPath, path.join("rounds", "spec-round-01-blue.json")), false);
    assert.equal(artifactExists(repoPath, path.join("reports", "spec-report.md")), false);
  });

  it("fences a stale Review attempt before findings, status, or terminal writes", async () => {
    let markReviewStarted: (() => void) | null = null;
    let releaseReview: (() => void) | null = null;
    const reviewStarted = new Promise<void>((resolve) => {
      markReviewStarted = resolve;
    });
    const reviewRelease = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        markReviewStarted?.();
        await reviewRelease;
        return {
          threadId: `${input.changeId}-review-thread`,
          runId: "ENGINE-REVIEW-STALE",
          summary: reviewLineProtocolText(validReviewOutput({
            approved: false,
            findings: [{
              severity: "P1",
              category: "correctness",
              file: "src/app.ts",
              line: 1,
              title: "Stale review finding",
              evidence: "This finding belongs to the stale attempt.",
              requiredFix: "Do not persist this stale finding.",
            }],
          })),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-build-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    const staleContext = makeTestJobExecutionContext("review-strict-fence");

    const reviewPromise = runReview(CHANGE_ID, staleContext);
    await reviewStarted;
    const reviewRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .find((candidate) => candidate.phase === "review");
    assert.ok(reviewRun);
    assert.equal(reviewRun.jobId, staleContext.jobId);
    assert.equal(reviewRun.workerId, staleContext.workerId);
    assert.equal(reviewRun.leaseToken, staleContext.leaseToken);
    assert.equal(reviewRun.attemptNo, staleContext.attemptNo);

    const currentContext = takeOverPipelineJob(staleContext, "review-strict-fence");
    db.update(changes).set({ status: "IMPLEMENTED" }).where(eq(changes.id, CHANGE_ID)).run();
    releaseReview?.();

    await assert.rejects(reviewPromise, (error: unknown) => {
      assert.ok(error instanceof StaleLeaseFenceError);
      return true;
    });
    assert.equal(currentStatus(), "IMPLEMENTED");
    assert.equal(
      db.select().from(findings).where(eq(findings.changeId, CHANGE_ID)).all().length,
      0,
    );
    assert.equal(
      db.select().from(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).get()?.status,
      "running",
    );
    assert.equal(
      db.select().from(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).get()?.reviewStatus,
      "running",
    );
    const staleReviewRun = db.select().from(runs).where(eq(runs.id, reviewRun.id)).get();
    assert.equal(staleReviewRun?.status, "running");
    assert.equal(staleReviewRun?.endedAt, null);
    assert.equal(staleReviewRun?.summary, null);
    assert.equal(staleReviewRun?.jobId, staleContext.jobId);
    assert.equal(staleReviewRun?.workerId, staleContext.workerId);
    assert.equal(staleReviewRun?.leaseToken, staleContext.leaseToken);
    assert.equal(staleReviewRun?.attemptNo, staleContext.attemptNo);
    assert.equal(
      db.select().from(artifacts).where(eq(artifacts.runId, reviewRun.id)).all().length,
      0,
    );
    const currentJob = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, staleContext.jobId)).get();
    assert.equal(currentJob?.status, "running");
    assert.equal(currentJob?.leasedBy, currentContext.workerId);
    assert.equal(currentJob?.leaseToken, currentContext.leaseToken);
    assert.equal(currentJob?.attemptNo, currentContext.attemptNo);
  });

  it("fences a stale non-streamed Fix attempt before business or terminal writes", async () => {
    let markFixStarted: (() => void) | null = null;
    let releaseFix: (() => void) | null = null;
    const fixStarted = new Promise<void>((resolve) => {
      markFixStarted = resolve;
    });
    const fixRelease = new Promise<void>((resolve) => {
      releaseFix = resolve;
    });
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        markFixStarted?.();
        await fixRelease;
        return {
          threadId: `${input.changeId}-stale-fix-thread`,
          runId: "ENGINE-FIX-STALE",
          summary: "stale fix completed",
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));
    seedChange(repoPath, "CHECK_FAILED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    const staleContext = makeTestJobExecutionContext("fix-strict-fence");

    const fixPromise = runFix(CHANGE_ID, staleContext);
    await fixStarted;
    const fixRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .find((candidate) => candidate.phase === "fix_findings");
    assert.ok(fixRun);

    const currentContext = takeOverPipelineJob(staleContext, "fix-strict-fence");
    db.update(changes).set({
      status: "SCOPE_FAILED",
      codexThreadId: "current-attempt-thread",
      fixIterations: 0,
    }).where(eq(changes.id, CHANGE_ID)).run();
    releaseFix?.();

    const error = await fixPromise.then(() => null, (cause: unknown) => cause);
    const current = currentChange();
    assert.equal(current.status, "SCOPE_FAILED");
    assert.equal(current.codexThreadId, "current-attempt-thread");
    assert.equal(current.fixIterations, 0);
    assert.ok(error instanceof StaleLeaseFenceError);

    const staleFixRun = db.select().from(runs).where(eq(runs.id, fixRun.id)).get();
    assert.equal(staleFixRun?.status, "running");
    assert.equal(staleFixRun?.endedAt, null);
    assert.equal(staleFixRun?.summary, null);
    assert.equal(staleFixRun?.jobId, staleContext.jobId);
    assert.equal(staleFixRun?.workerId, staleContext.workerId);
    assert.equal(staleFixRun?.leaseToken, staleContext.leaseToken);
    assert.equal(staleFixRun?.attemptNo, staleContext.attemptNo);
    assert.equal(
      db.select().from(artifacts).where(eq(artifacts.runId, fixRun.id)).all().length,
      0,
    );

    const currentJob = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, staleContext.jobId)).get();
    assert.equal(currentJob?.status, "running");
    assert.equal(currentJob?.leasedBy, currentContext.workerId);
    assert.equal(currentJob?.leaseToken, currentContext.leaseToken);
    assert.equal(currentJob?.attemptNo, currentContext.attemptNo);
  });

  it("records one started event, heartbeats, and one terminal event for a successful streamed Build", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    const context = makeTestJobExecutionContext("build-lifecycle-success");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("Build lifecycle test uses the streamed engine");
      },
      async *runStreamed(input) {
        await emitProviderLifecycle(input.lifecycle, "completed", "build-success");
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: "build-success-thread" } as unknown as AiStreamEvent;
      },
    }));

    await runImplementStreamed(CHANGE_ID, context);

    assertProviderLifecycle("implement", "completed", context);
  });

  it("does not double-write streamed Build lifecycle events when the provider fails", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    const context = makeTestJobExecutionContext("build-lifecycle-failure");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("Build lifecycle test uses the streamed engine");
      },
      async *runStreamed(input) {
        await emitProviderLifecycle(input.lifecycle, "failed", "build-failure");
        throw new Error("streamed Build provider failed");
      },
    }));

    await assert.rejects(
      () => runImplementStreamed(CHANGE_ID, context),
      /streamed Build provider failed/,
    );

    assertProviderLifecycle("implement", "failed", context);
  });

  it("records one started event, heartbeats, and one terminal event for a successful streamed Fix", async () => {
    seedChange(repoPath, "CHECK_FAILED");
    const context = makeTestJobExecutionContext("fix-lifecycle-success");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("Fix lifecycle test uses the streamed engine");
      },
      async *runStreamed(input) {
        await emitProviderLifecycle(input.lifecycle, "completed", "fix-success");
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: "fix-success-thread" } as unknown as AiStreamEvent;
      },
    }));

    await runFixStreamed(CHANGE_ID, context);

    assertProviderLifecycle("fix_findings", "completed", context);
  });

  it("does not double-write streamed Fix lifecycle events when the provider fails", async () => {
    seedChange(repoPath, "SCOPE_FAILED");
    const context = makeTestJobExecutionContext("fix-lifecycle-failure");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("Fix lifecycle test uses the streamed engine");
      },
      async *runStreamed(input) {
        await emitProviderLifecycle(input.lifecycle, "failed", "fix-failure");
        throw new Error("streamed Fix provider failed");
      },
    }));

    await assert.rejects(
      () => runFixStreamed(CHANGE_ID, context),
      /streamed Fix provider failed/,
    );

    assertProviderLifecycle("fix_findings", "failed", context);
  });

  it("does not let a stale streamed Build lifecycle overwrite the current provider attempt", async () => {
    const staleContext: JobExecutionContext = {
      jobId: "PJOB-T27-build-lifecycle-stale",
      workerId: "pipeline-worker-t27-build-lifecycle-stale",
      leaseToken: "lease-token-t27-build-lifecycle-stale-attempt-1",
      attemptNo: 1,
    };
    const currentContext: JobExecutionContext = {
      jobId: staleContext.jobId,
      workerId: "pipeline-worker-t27-build-lifecycle-current",
      leaseToken: "lease-token-t27-build-lifecycle-current-attempt-2",
      attemptNo: 2,
    };
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    seedRunningPipelineJob("implement", "run_build", staleContext);
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("Build stale-fence test uses the streamed engine");
      },
      async *runStreamed(input) {
        assert.ok(input.lifecycle);
        await input.lifecycle.onProcessStarted({
          provider: "codex",
          pid: null,
          ppid: process.pid,
          externalRef: "stale-build-thread",
          startedAt: "2026-07-10T10:01:00.000Z",
        });
        const processRow = db.select().from(providerRunProcesses)
          .where(eq(providerRunProcesses.changeId, CHANGE_ID))
          .get();
        assert.ok(processRow);
        db.update(pipelineJobs).set({
          leasedBy: currentContext.workerId,
          leaseToken: currentContext.leaseToken,
          attemptNo: currentContext.attemptNo,
        }).where(eq(pipelineJobs.id, staleContext.jobId)).run();
        db.update(providerRunProcesses).set({
          workerId: currentContext.workerId,
          leaseToken: currentContext.leaseToken,
          attemptNo: currentContext.attemptNo,
          externalRef: "current-build-thread",
          startedAt: "2026-07-10T10:02:00.000Z",
          lastHeartbeatAt: "2026-07-10T10:02:00.000Z",
        }).where(eq(providerRunProcesses.id, processRow.id)).run();

        await assert.rejects(
          () => input.lifecycle?.onHeartbeat({
            provider: "codex",
            pid: null,
            externalRef: "stale-build-thread",
            observedAt: "2026-07-10T10:03:00.000Z",
          }),
          /Stale lease fence/,
        );
        await assert.rejects(
          () => input.lifecycle?.onTerminal({
            provider: "codex",
            pid: null,
            status: "failed",
            summary: "stale attempt must not win",
            endedAt: "2026-07-10T10:04:00.000Z",
          }),
          /Stale lease fence/,
        );
        throw new Error("stale Build lifecycle fenced");
      },
    }));

    await assert.rejects(
      () => runImplementStreamed(CHANGE_ID, staleContext),
      /Stale lease fence/,
    );

    const processRow = db.select().from(providerRunProcesses)
      .where(eq(providerRunProcesses.changeId, CHANGE_ID))
      .get();
    assert.equal(processRow?.status, "running");
    assert.equal(processRow?.attemptNo, currentContext.attemptNo);
    assert.equal(processRow?.leaseToken, currentContext.leaseToken);
    assert.equal(processRow?.externalRef, "current-build-thread");
    assert.equal(processRow?.lastHeartbeatAt, "2026-07-10T10:02:00.000Z");
    const terminalEvents = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .filter((event) => [
        "provider_process_ended",
        "provider_process_failed",
        "provider_process_stopped",
        "provider_process_orphaned",
      ].includes(event.type));
    assert.equal(terminalEvents.length, 0);
  });

  it("fences streamed Build business writes after provider terminal when a newer attempt takes over", async () => {
    const staleContext: JobExecutionContext = {
      jobId: "PJOB-T10-build-post-terminal-stale",
      workerId: "pipeline-worker-t10-build-post-terminal-stale",
      leaseToken: "lease-token-t10-build-post-terminal-stale-attempt-1",
      attemptNo: 1,
    };
    let currentContext: JobExecutionContext | null = null;
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    seedRunningPipelineJob("implement", "run_build", staleContext);
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("Build post-terminal fence test uses the streamed engine");
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: "stale-build-business-thread" } as unknown as AiStreamEvent;
        await emitProviderLifecycle(input.lifecycle, "completed", "build-post-terminal-stale");
        currentContext = takeOverPipelineJob(staleContext, "build-post-terminal-stale");
        db.update(changes).set({
          status: "PLAN_APPROVED",
          codexThreadId: "current-build-business-thread",
          fixIterations: 2,
        }).where(eq(changes.id, CHANGE_ID)).run();
      },
    }));

    const error = await runImplementStreamed(CHANGE_ID, staleContext).then(
      () => null,
      (cause: unknown) => cause,
    );

    assert.ok(error instanceof StaleLeaseFenceError);
    assert.ok(currentContext);
    const current = currentChange();
    assert.equal(current.status, "PLAN_APPROVED");
    assert.equal(current.codexThreadId, "current-build-business-thread");
    assert.equal(current.fixIterations, 2);
    const staleBusinessRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .find((candidate) => candidate.phase === "implement");
    assert.ok(staleBusinessRun);
    assert.equal(staleBusinessRun.status, "running");
    assert.equal(staleBusinessRun.endedAt, null);
    assert.equal(staleBusinessRun.summary, null);
    assert.equal(db.select().from(artifacts).where(eq(artifacts.runId, staleBusinessRun.id)).all().length, 0);
    const latestBuildRun = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.ok(latestBuildRun);
    assert.equal(latestBuildRun.status, "running");
    assert.equal(latestBuildRun.patchPath, null);
    assert.equal(latestBuildRun.diffPath, null);
    assert.equal(latestBuildRun.auditPath, null);
    assert.equal(latestBuildRun.reportPath, null);
    const buildRecord = db.select().from(buildRunRecords)
      .where(eq(buildRunRecords.changeId, CHANGE_ID)).get();
    assert.equal(buildRecord?.status, "running");
    assert.equal(buildRecord?.artifactHash, null);
    assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 1;\n");
    const currentJob = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, staleContext.jobId)).get();
    assert.equal(currentJob?.status, "running");
    assert.equal(currentJob?.leasedBy, currentContext.workerId);
    assert.equal(currentJob?.leaseToken, currentContext.leaseToken);
    assert.equal(currentJob?.attemptNo, currentContext.attemptNo);
  });

  it("fences streamed Fix business writes after provider terminal when a newer attempt takes over", async () => {
    const staleContext: JobExecutionContext = {
      jobId: "PJOB-T10-fix-post-terminal-stale",
      workerId: "pipeline-worker-t10-fix-post-terminal-stale",
      leaseToken: "lease-token-t10-fix-post-terminal-stale-attempt-1",
      attemptNo: 1,
    };
    let currentContext: JobExecutionContext | null = null;
    seedChange(repoPath, "CHECK_FAILED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    seedRunningPipelineJob("fix_findings", "run_fix", staleContext);
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("Fix post-terminal fence test uses the streamed engine");
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: "stale-fix-business-thread" } as unknown as AiStreamEvent;
        await emitProviderLifecycle(input.lifecycle, "completed", "fix-post-terminal-stale");
        currentContext = takeOverPipelineJob(staleContext, "fix-post-terminal-stale");
        db.update(changes).set({
          status: "SCOPE_FAILED",
          codexThreadId: "current-fix-business-thread",
          fixIterations: 2,
        }).where(eq(changes.id, CHANGE_ID)).run();
      },
    }));

    const error = await runFixStreamed(CHANGE_ID, staleContext).then(
      () => null,
      (cause: unknown) => cause,
    );

    assert.ok(error instanceof StaleLeaseFenceError);
    assert.ok(currentContext);
    const current = currentChange();
    assert.equal(current.status, "SCOPE_FAILED");
    assert.equal(current.codexThreadId, "current-fix-business-thread");
    assert.equal(current.fixIterations, 2);
    const staleBusinessRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .find((candidate) => candidate.phase === "fix_findings");
    assert.ok(staleBusinessRun);
    assert.equal(staleBusinessRun.status, "running");
    assert.equal(staleBusinessRun.endedAt, null);
    assert.equal(staleBusinessRun.summary, null);
    assert.equal(db.select().from(artifacts).where(eq(artifacts.runId, staleBusinessRun.id)).all().length, 0);
    const latestBuildRun = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.ok(latestBuildRun);
    assert.equal(latestBuildRun.status, "created");
    assert.equal(latestBuildRun.patchPath, null);
    assert.equal(latestBuildRun.diffPath, null);
    assert.equal(latestBuildRun.auditPath, null);
    assert.equal(latestBuildRun.reportPath, null);
    const buildRecord = db.select().from(buildRunRecords)
      .where(eq(buildRunRecords.changeId, CHANGE_ID)).get();
    assert.equal(buildRecord?.status, "created");
    assert.equal(buildRecord?.artifactHash, null);
    assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 1;\n");
    const currentJob = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, staleContext.jobId)).get();
    assert.equal(currentJob?.status, "running");
    assert.equal(currentJob?.leasedBy, currentContext.workerId);
    assert.equal(currentJob?.leaseToken, currentContext.leaseToken);
    assert.equal(currentJob?.attemptNo, currentContext.attemptNo);
  });

  it("rejects Build directly after TestPlan completes until TestPlan is reconciled", async () => {
    seedChange(repoPath, "TESTPLAN_DONE");
    seedApprovedTestPlanSnapshot();
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);

    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));

    await assert.rejects(
      () => runImplement(CHANGE_ID, makeTestJobExecutionContext("build-before-test-plan-reconcile")),
      /Invalid status/,
    );

    assert.equal(currentStatus(), "TESTPLAN_DONE");
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID), null);
  });

  it("fails Build startup instead of leaving a created workspace run missing from action contract", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    seedApprovedTestPlanSnapshot();
    // Align the TestPlan gate's sourceDbHash with the content the enqueue
    // authority recomputes from the snapshot rows, so run_build's authority
    // overlay resolves the TestPlan snapshot source instead of denying with
    // authority_source_ambiguous once Build fails back to PLAN_APPROVED.
    refreshQaTestPlanGateFromRows();
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);

    const previousTimeout = process.env.STAGEPASS_BUILD_STREAM_START_TIMEOUT_MS;
    process.env.STAGEPASS_BUILD_STREAM_START_TIMEOUT_MS = "20";
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      runStreamed() {
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          next() {
            return new Promise<IteratorResult<AiStreamEvent>>(() => {});
          },
          return() {
            return Promise.resolve({ done: true, value: undefined });
          },
        } as AsyncGenerator<AiStreamEvent>;
      },
    }));

    try {
      const buildContext = makeTestJobExecutionContext("build-action-contract-startup-failure");
      const outcome = await Promise.race([
        runImplementStreamed(
          CHANGE_ID,
          buildContext,
        ).then(
          () => ({ status: "resolved", message: "" }),
          (err) => ({
            status: "rejected",
            message: err instanceof Error ? err.message : String(err),
          }),
        ),
        new Promise<{ status: string; message: string }>((resolve) =>
          setTimeout(() => resolve({ status: "test_timeout", message: "test timed out" }), 250)
        ),
      ]);

      assert.equal(outcome.status, "rejected");
      assert.match(outcome.message, /Build stream start timed out/);
      settleTestPipelineJob(buildContext, "failed");
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.STAGEPASS_BUILD_STREAM_START_TIMEOUT_MS;
      } else {
        process.env.STAGEPASS_BUILD_STREAM_START_TIMEOUT_MS = previousTimeout;
      }
    }

    assert.equal(currentStatus(), "PLAN_APPROVED");
    const buildRun = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.equal(buildRun?.status, "failed");
    assert.match(buildRun?.blockers.join("\n") ?? "", /Build stream start timed out/);
    const buildRecord = db
      .select()
      .from(buildRunRecords)
      .where(eq(buildRunRecords.changeId, CHANGE_ID))
      .all()
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))[0];
    assert.equal(buildRecord?.status, "failed");
    const implementRun = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .filter((run) => run.phase === "implement")
      .at(-1);
    assert.equal(implementRun?.status, "failed");
    assert.match(implementRun?.summary ?? "", /Build stream start timed out/);

    const actions = getActions(CHANGE_ID);
    const runBuild = actions.find((action) => action.actionId === "run_build");
    const adoptBuild = actions.find((action) => action.actionId === "adopt_build");
    const rejectBuild = actions.find((action) => action.actionId === "reject_build");
    assert.equal(runBuild?.enabled, true);
    assert.equal(adoptBuild?.enabled, false);
    assert.equal(adoptBuild?.reason, "Build run is failed");
    assert.equal(rejectBuild?.enabled, false);
    assert.equal(rejectBuild?.reason, "Build run is failed");
  });

  it("runs Build Runner in a worktree and leaves main workspace unchanged before absorb", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    fs.mkdirSync(path.join(repoPath, ".ship", "prompts"), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, ".ship", "prompts", "implement.md"),
      "Implement in repo: {repoPath}\n"
    );
    initGitRepoWithApp(repoPath);

    let streamedRepoPath: string | null = null;
    let streamedPrompt: string | null = null;
    let streamedTimeoutMs: number | undefined;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        streamedRepoPath = input.repoPath;
        streamedPrompt = input.prompt;
        streamedTimeoutMs = input.timeoutMs;
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));

    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("build-worktree"));

    assert.equal(currentStatus(), "IMPLEMENTING");
    assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 1;\n");
    const buildRun = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.equal(buildRun?.status, "awaiting_human");
    assert.equal(streamedRepoPath, buildRun?.workspacePath);
    assert.equal(streamedTimeoutMs, 30 * 60 * 1000);
    assert.notEqual(streamedRepoPath, repoPath);
    assert.ok(buildRun?.workspacePath);
    assert.match(streamedPrompt ?? "", new RegExp(buildRun.workspacePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(streamedPrompt ?? "", /Implement in repo:/);
    assert.doesNotMatch(streamedPrompt ?? "", new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("assembles Build prompt only from DB snapshots and Git facts, not .ship mirrors or baseline docs", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    writeChangeFile(repoPath, "spec.md", "FORBIDDEN_SPEC_MIRROR\n");
    writeChangeFile(repoPath, "plan.md", "FORBIDDEN_PLAN_MARKDOWN_MIRROR\n");
    writeChangeFile(repoPath, "plan.json", `${JSON.stringify({
      expectedFiles: ["secrets.env"],
      forbiddenFiles: [],
      sentinel: "FORBIDDEN_PLAN_JSON_MIRROR",
    })}\n`);
    fs.mkdirSync(path.join(repoPath, ".ship"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, ".ship", "architecture.md"), "FORBIDDEN_ARCH_BASELINE\n");
    fs.writeFileSync(path.join(repoPath, ".ship", "coding-rules.md"), "FORBIDDEN_RULES_BASELINE\n");
    const now = new Date().toISOString();
    db.insert(testplanSnapshots).values({
      id: "TESTPLAN-BUILD-PROMPT",
      changeId: CHANGE_ID,
      status: "approved",
      testIntent: "DB TestPlan prompt authority",
      schemaVersion: "testplan/v1",
      approvalState: "approved",
      snapshotDbHash: "testplan-db-hash",
      approvedAt: now,
      approvalDecisionId: null,
      createdAt: now,
    }).run();
    db.insert(testplanCoverageItems).values({
      id: "TESTPLAN-BUILD-PROMPT-COV",
      testplanSnapshotId: "TESTPLAN-BUILD-PROMPT",
      itemKey: "build-prompt",
      title: "DB_TESTPLAN_COVERAGE_SENTINEL",
      requirementRef: "Task 10",
      testType: "integration",
      priority: "P0",
      status: "planned",
      createdAt: now,
    }).run();
    db.insert(requiredValidationCommands).values({
      id: "TESTPLAN-BUILD-PROMPT-CMD",
      changeId: CHANGE_ID,
      phase: "TestPlan",
      sourceSnapshotId: "TESTPLAN-BUILD-PROMPT",
      command: "node -e \"console.log('DB_TESTPLAN_COMMAND_SENTINEL')\"",
      commandOrder: 1,
      required: 1,
      createdAt: now,
    }).run();
    initGitRepoWithApp(repoPath);

    let streamedPrompt: string | null = null;
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("Build prompt test uses streamed engine");
      },
      async *runStreamed(input) {
        streamedPrompt = input.prompt;
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-build-thread` } as unknown as AiStreamEvent;
      },
    }));

    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("build-db-prompt"));

    assert.match(streamedPrompt ?? "", /DB Plan Scope \(authoritative\)/);
    assert.match(streamedPrompt ?? "", /DB Design Snapshot Authority/);
    assert.match(streamedPrompt ?? "", /DB TestPlan Snapshot Authority/);
    assert.match(streamedPrompt ?? "", /DB_TESTPLAN_COMMAND_SENTINEL/);
    assert.match(streamedPrompt ?? "", /Git facts/);
    assert.doesNotMatch(streamedPrompt ?? "", /FORBIDDEN_SPEC_MIRROR/);
    assert.doesNotMatch(streamedPrompt ?? "", /FORBIDDEN_PLAN_MARKDOWN_MIRROR/);
    assert.doesNotMatch(streamedPrompt ?? "", /FORBIDDEN_PLAN_JSON_MIRROR/);
    assert.doesNotMatch(streamedPrompt ?? "", /FORBIDDEN_ARCH_BASELINE/);
    assert.doesNotMatch(streamedPrompt ?? "", /FORBIDDEN_RULES_BASELINE/);
  });

  it("keeps the legacy implement entry on the Build workspace path", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);

    let streamedRepoPath: string | null = null;
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("Legacy implement must not write the main workspace directly");
      },
      async *runStreamed(input) {
        streamedRepoPath = input.repoPath;
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-build-thread` } as unknown as AiStreamEvent;
      },
    }));

    const result = await runImplement(
      CHANGE_ID,
      makeTestJobExecutionContext("legacy-build-entry"),
    );

    assert.equal(result.success, true);
    assert.equal(currentStatus(), "IMPLEMENTING");
    assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 1;\n");
    const buildRun = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.equal(buildRun?.status, "awaiting_human");
    assert.equal(streamedRepoPath, buildRun?.workspacePath);
    assert.notEqual(streamedRepoPath, repoPath);
  });

  it("fails a gate-blocked Build run, returns to PLAN_APPROVED, and can rerun", async () => {
    const firstAttemptContext: JobExecutionContext = {
      jobId: "PJOB-T27-build-gate-blocked",
      workerId: "pipeline-worker-t27-build-gate-blocked",
      leaseToken: "lease-token-t27-build-gate-blocked-attempt-1",
      attemptNo: 1,
    };
    const retryContext: JobExecutionContext = {
      jobId: firstAttemptContext.jobId,
      workerId: "pipeline-worker-t27-build-gate-blocked-retry",
      leaseToken: "lease-token-t27-build-gate-blocked-attempt-2",
      attemptNo: 2,
    };
    seedChange(repoPath, "PLAN_APPROVED");
    seedRunningPipelineJob("implement", "run_build", firstAttemptContext);
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: ["infra/**"],
    });
    initGitRepoWithApp(repoPath);

    let streamedRuns = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        streamedRuns += 1;
        if (streamedRuns === 1) {
          fs.mkdirSync(path.join(input.repoPath, "infra"), { recursive: true });
          fs.writeFileSync(path.join(input.repoPath, "infra", "main.tf"), "resource \"x\" \"y\" {}\n");
        } else {
          fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        }
        yield { type: "thread.started", threadId: `${input.changeId}-thread-${streamedRuns}` } as unknown as AiStreamEvent;
      },
    }));

    await runImplementStreamed(CHANGE_ID, firstAttemptContext);

    assert.equal(currentStatus(), "PLAN_APPROVED");
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "gate_blocked");
    const firstImplementRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .filter((run) => run.phase === "implement")
      .at(-1);
    assert.equal(firstImplementRun?.status, "failed");
    assert.match(firstImplementRun?.summary ?? "", /gate blockers/i);

    db.update(pipelineJobs).set({
      leasedBy: retryContext.workerId,
      leaseToken: retryContext.leaseToken,
      attemptNo: retryContext.attemptNo,
    }).where(eq(pipelineJobs.id, firstAttemptContext.jobId)).run();
    await runImplementStreamed(CHANGE_ID, retryContext);

    assert.equal(streamedRuns, 2);
    assert.equal(currentStatus(), "IMPLEMENTING");
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "awaiting_human");
  });

  it("recovers a stale running Build before retrying and starts the next Build run", async () => {
    seedChange(repoPath, "IMPLEMENTING");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    const staleStartedAt = "2026-07-07T16:11:18.181Z";
    const staleUpdatedAt = "2026-07-07T16:11:18.317Z";
    const staleRunId = "RUN-T27-STALE-BUILD";
    db.insert(runs).values({
      id: staleRunId,
      changeId: CHANGE_ID,
      phase: "implement",
      status: "running",
      startedAt: staleStartedAt,
      endedAt: null,
      summary: null,
    }).run();
    writeBuildRun(repoPath, {
      changeId: CHANGE_ID,
      runNumber: 1,
      status: "running",
      purpose: "build",
      baseHeadSha: "a".repeat(40),
      baseCommit: "a".repeat(40),
      workspacePath: path.join(repoPath, ".stale-build-1"),
      branchName: `stagepass/build/${CHANGE_ID}/build-1`,
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
      createdAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
    });
    recordBuildRunFromWorkspaceFile(repoPath, CHANGE_ID, 1);

    let streamedRuns = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("Build retry behavior test uses streamed engine");
      },
      async *runStreamed(input) {
        streamedRuns += 1;
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-retry-build-thread` } as unknown as AiStreamEvent;
      },
    }));
    const restoreClock = setBuildStaleRunClockForTest(() => new Date("2026-07-08T01:00:00.000Z"));
    const restoreLiveness = setBuildProviderLivenessForTest(() => false);
    try {
      await retryBuildStreamed(
        CHANGE_ID,
        makeTestJobExecutionContext("build-stale-run-retry", { attemptNo: 2 }),
      );
    } finally {
      restoreLiveness();
      restoreClock();
    }

    const previousRun = db.select().from(runs).where(eq(runs.id, staleRunId)).get();
    const previousBuildRun = db
      .select()
      .from(buildRunRecords)
      .where(eq(buildRunRecords.changeId, CHANGE_ID))
      .all()
      .find((record) => record.buildRunId === "build-1");
    const latestRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .filter((run) => run.phase === "implement")
      .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""))[0];

    assert.equal(streamedRuns, 1);
    assert.equal(previousRun?.status, "failed");
    assert.equal(previousBuildRun?.status, "failed");
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.runNumber, 2);
    assert.equal(latestRun?.phase, "implement");
  });

  /**
   * The same retry one step later in the corpse's life. Once the stale-provider
   * sweeper has reconciled the run itself, the run row is already `failed`, so
   * recoverStaleBuildRun's `latestRunningImplementRun` found nothing and
   * retryBuildStreamed threw `Build retry did not recover a stale running run:
   * no_running_implement_run` -- forever, because reject_build and adopt_build
   * both refuse a workspace file still claiming `running` too.
   */
  it("retries a Build the stale-provider sweeper already reconciled", async () => {
    seedChange(repoPath, "IMPLEMENTING");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    const sweptUpdatedAt = "2026-07-07T16:11:18.317Z";
    const sweptRunId = "RUN-T27-SWEPT-BUILD";
    db.insert(runs).values({
      id: sweptRunId,
      changeId: CHANGE_ID,
      phase: "implement",
      // What the sweeper leaves: the run terminal, the change status untouched.
      status: "failed",
      startedAt: "2026-07-07T16:11:18.181Z",
      endedAt: sweptUpdatedAt,
      summary: "stale_lease_fenced",
    }).run();
    writeBuildRun(repoPath, {
      changeId: CHANGE_ID,
      runNumber: 1,
      // No recovery path writes build-N.json, so it still claims running.
      status: "running",
      purpose: "build",
      baseHeadSha: "a".repeat(40),
      baseCommit: "a".repeat(40),
      workspacePath: path.join(repoPath, ".swept-build-1"),
      branchName: `stagepass/build/${CHANGE_ID}/build-1`,
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
      createdAt: sweptUpdatedAt,
      updatedAt: sweptUpdatedAt,
    });
    recordBuildRunFromWorkspaceFile(repoPath, CHANGE_ID, 1);

    let streamedRuns = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("Build retry behavior test uses streamed engine");
      },
      async *runStreamed(input) {
        streamedRuns += 1;
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-swept-build-thread` } as unknown as AiStreamEvent;
      },
    }));
    const restoreClock = setBuildStaleRunClockForTest(() => new Date("2026-07-08T01:00:00.000Z"));
    const restoreLiveness = setBuildProviderLivenessForTest(() => false);
    try {
      await retryBuildStreamed(
        CHANGE_ID,
        makeTestJobExecutionContext("build-swept-run-retry", { attemptNo: 2 }),
      );
    } finally {
      restoreLiveness();
      restoreClock();
    }

    assert.equal(streamedRuns, 1);
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.runNumber, 2);
    // The abandoned workspace file stops claiming running, so the next
    // inspection cannot classify the same corpse as stranded again.
    assert.equal(readBuildRunByNumber(repoPath, CHANGE_ID, 1)?.status, "failed");
    // The run row the sweeper already finished is left exactly as it was.
    assert.equal(db.select().from(runs).where(eq(runs.id, sweptRunId)).get()?.status, "failed");
    const recovery = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "change_status_changed" &&
        event.rawJson?.includes("build_stage_stranded_status_recovery") &&
        event.rawJson?.includes("\"from\":\"IMPLEMENTING\""));
    assert.ok(recovery, "the stranded IMPLEMENTING claim should be recorded as recovered");
  });

  it("refuses to retry a Build parked awaiting human adoption", async () => {
    seedChange(repoPath, "IMPLEMENTING");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    const doneUpdatedAt = "2026-07-07T16:11:18.317Z";
    db.insert(runs).values({
      id: "RUN-T27-AWAITING-BUILD",
      changeId: CHANGE_ID,
      phase: "implement",
      status: "completed",
      startedAt: "2026-07-07T16:11:18.181Z",
      endedAt: doneUpdatedAt,
      summary: "Build completed and awaits human absorb",
    }).run();
    writeBuildRun(repoPath, {
      changeId: CHANGE_ID,
      runNumber: 1,
      // A SUCCESSFUL build: runImplementStreamed completes into IMPLEMENTING and
      // parks here until adopt_build. "No running implement run" is therefore
      // its normal resting state, not a stranding -- treating it as one would
      // silently discard a finished deliverable nobody has ruled on.
      status: "awaiting_human",
      purpose: "build",
      baseHeadSha: "a".repeat(40),
      baseCommit: "a".repeat(40),
      workspacePath: path.join(repoPath, ".awaiting-build-1"),
      branchName: `stagepass/build/${CHANGE_ID}/build-1`,
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
      createdAt: doneUpdatedAt,
      updatedAt: doneUpdatedAt,
    });
    recordBuildRunFromWorkspaceFile(repoPath, CHANGE_ID, 1);

    let streamedRuns = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("Build retry behavior test uses streamed engine");
      },
      async *runStreamed() {
        streamedRuns += 1;
      },
    }));
    const restoreClock = setBuildStaleRunClockForTest(() => new Date("2026-07-08T01:00:00.000Z"));
    // A dead process proves nothing here: the build finished, so of course
    // nothing holds the workspace.
    const restoreLiveness = setBuildProviderLivenessForTest(() => false);
    try {
      await assert.rejects(
        () => retryBuildStreamed(
          CHANGE_ID,
          makeTestJobExecutionContext("build-awaiting-retry", { attemptNo: 2 }),
        ),
        /did not recover a stale running run: no_running_implement_run/,
      );
    } finally {
      restoreLiveness();
      restoreClock();
    }

    assert.equal(streamedRuns, 0);
    assert.equal(currentStatus(), "IMPLEMENTING");
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "awaiting_human");
  });

  it("approves and atomically adopts an awaiting human Build patch into the main repo", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));

    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("build-awaiting-absorb"));
    await approveBuildAbsorb(CHANGE_ID);

    assert.equal(currentStatus(), "IMPLEMENTED");
    assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 2;\n");
    const adopted = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.equal(adopted?.status, "adopted");
    assert.ok(adopted?.adoptedHeadSha);
    assert.ok(adopted?.adoptionDecisionId);
  });

  it("atomically queues Review from the same adopted Build authority returned by GET actions", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(), expectedFiles: ["src/app.ts"], forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`, runId: "ENGINE-RUN", summary: "done",
          success: true, changedFiles: [], structuredOutput: undefined, items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    const buildContext = makeTestJobExecutionContext("review-atomic-build-authority");
    await runImplementStreamed(CHANGE_ID, buildContext);
    settleTestPipelineJob(buildContext);
    await approveBuildAbsorb(CHANGE_ID);
    const contract = getActions(CHANGE_ID).find((action) => action.actionId === "run_review")!;
    assert.equal(contract.enabled, true, JSON.stringify(contract));
    const atomic = evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID, phase: "review", actionId: "run_review",
    });
    assert.equal(atomic.enabled, true);
    assert.equal(atomic.gateVersion, contract.gateVersion);
    assert.equal(atomic.sourceDbHash, contract.sourceDbHash);

    const result = enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "review", actionId: "run_review",
      idempotencyKey: "review-adopted-build-authority",
    }, contract);
    assert.equal(result.created, true);
    assert.equal(result.job.phase, "review");
  });

  it("rejects stale, ambiguous, and non-adopted Build authority without creating a Review job", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(), expectedFiles: ["src/app.ts"], forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`, runId: "ENGINE-RUN", summary: "done",
          success: true, changedFiles: [], structuredOutput: undefined, items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    const buildContext = makeTestJobExecutionContext("review-negative-build-authority");
    await runImplementStreamed(CHANGE_ID, buildContext);
    settleTestPipelineJob(buildContext);
    await approveBuildAbsorb(CHANGE_ID);
    const contract = getActions(CHANGE_ID).find((action) => action.actionId === "run_review")!;
    assert.equal(contract.enabled, true, JSON.stringify(contract));

    // .ship authority flip (Site 1): run_review read-time authority is DB-authoritative,
    // so a post-adoption working-tree edit no longer drifts the gate (re-caught at execution).
    fs.writeFileSync(path.join(repoPath, "src", "app.ts"), "export const value = 3;\n");
    assert.equal(evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID, phase: "review", actionId: "run_review",
    }).enabled, true);

    fs.writeFileSync(path.join(repoPath, "src", "app.ts"), "export const value = 2;\n");
    const adopted = db.select().from(buildRunRecords)
      .where(eq(buildRunRecords.changeId, CHANGE_ID)).get()!;
    db.insert(buildRunRecords).values({
      ...adopted,
      id: `${adopted.id}-AMBIGUOUS`,
    }).run();
    assert.equal(evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID, phase: "review", actionId: "run_review",
    }).reasonCode, "review_build_authority_invalid");
    db.delete(buildRunRecords).where(eq(buildRunRecords.id, `${adopted.id}-AMBIGUOUS`)).run();

    db.update(buildRunRecords).set({ status: "approved_for_absorb" })
      .where(eq(buildRunRecords.id, adopted.id)).run();
    assert.equal(evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID, phase: "review", actionId: "run_review",
    }).reasonCode, "review_build_authority_invalid");
    assert.equal(db.select().from(pipelineJobs).where(and(
      eq(pipelineJobs.changeId, CHANGE_ID),
      eq(pipelineJobs.idempotencyKey, "review-stale-build-authority"),
    )).all().length, 0);
  });

  it("recovers when adopted metadata persisted but the Change status is still IMPLEMENTING", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`, runId: "ENGINE-RUN", summary: "done",
          success: true, changedFiles: [], structuredOutput: undefined, items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("build-adoption-status-recovery"));
    await approveBuildAbsorb(CHANGE_ID);
    const firstAdopted = readLatestBuildRun(repoPath, CHANGE_ID);
    db.update(changes).set({ status: "IMPLEMENTING" }).where(eq(changes.id, CHANGE_ID)).run();

    await approveBuildAbsorb(CHANGE_ID);

    const recovered = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.equal(currentStatus(), "IMPLEMENTED");
    assert.equal(recovered?.status, "adopted");
    assert.equal(recovered?.adoptedHeadSha, firstAdopted?.adoptedHeadSha);
    assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 2;\n");
  });

  it("recovers a legacy IMPLEMENTED change whose latest Build run is only approved_for_absorb", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(), expectedFiles: ["src/app.ts"], forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`, runId: "ENGINE-RUN", summary: "done",
          success: true, changedFiles: [], structuredOutput: undefined, items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("legacy-approved-absorb-recovery"));
    approveBuildForAbsorb({ repoPath, changeId: CHANGE_ID });
    db.update(changes).set({ status: "IMPLEMENTED" }).where(eq(changes.id, CHANGE_ID)).run();

    await approveBuildAbsorb(CHANGE_ID);

    const recovered = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.equal(currentStatus(), "IMPLEMENTED");
    assert.equal(recovered?.status, "adopted");
    assert.ok(recovered?.adoptedHeadSha);
    assert.ok(recovered?.adoptionDecisionId);
    assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 2;\n");
  });

  it("rejects IMPLEMENTED absorb recovery for awaiting_human, rejected, or missing Build runs", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(), expectedFiles: ["src/app.ts"], forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`, runId: "ENGINE-RUN", summary: "done",
          success: true, changedFiles: [], structuredOutput: undefined, items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("invalid-implemented-absorb-recovery"));
    db.update(changes).set({ status: "IMPLEMENTED" }).where(eq(changes.id, CHANGE_ID)).run();

    await assert.rejects(() => approveBuildAbsorb(CHANGE_ID), /requires an approved_for_absorb or adopted latest run/);
    const awaiting = readLatestBuildRun(repoPath, CHANGE_ID)!;
    writeBuildRun(repoPath, { ...awaiting, status: "rejected", updatedAt: new Date().toISOString() });
    await assert.rejects(() => approveBuildAbsorb(CHANGE_ID), /current status is rejected/);
    fs.rmSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "build"), { recursive: true, force: true });
    await assert.rejects(() => approveBuildAbsorb(CHANGE_ID), /current status is missing/);
    assert.equal(currentStatus(), "IMPLEMENTED");
    assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 1;\n");
  });

  it("does not report Build absorb success or advance status while the main repo is dirty", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));

    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("build-dirty-main-repo"));
    fs.writeFileSync(path.join(repoPath, "src", "dirty.ts"), "export const dirty = true;\n");

    await assert.rejects(() => approveBuildAbsorb(CHANGE_ID), /dirty workspace/i);

    assert.equal(currentStatus(), "IMPLEMENTING");
    assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 1;\n");
    assert.equal(fs.readFileSync(path.join(repoPath, "src", "dirty.ts"), "utf-8"), "export const dirty = true;\n");
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "approved_for_absorb");
  });

  it("rejects an awaiting-human Build run and returns to PLAN_APPROVED for rebuild", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));

    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("build-reject-awaiting-human"));

    assert.equal(currentStatus(), "IMPLEMENTING");
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "awaiting_human");
    const recordBeforeReject = db
      .select()
      .from(buildRunRecords)
      .where(eq(buildRunRecords.changeId, CHANGE_ID))
      .all()
      .at(-1);
    assert.equal(recordBeforeReject?.status, "awaiting_human");

    const rejected = await rejectBuildRun(CHANGE_ID);

    assert.equal(rejected.status, "rejected");
    assert.equal(currentStatus(), "PLAN_APPROVED");
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "rejected");
    const recordAfterReject = db
      .select()
      .from(buildRunRecords)
      .where(eq(buildRunRecords.changeId, CHANGE_ID))
      .all()
      .at(-1);
    assert.equal(recordAfterReject?.status, "rejected");
    const actions = getActions(CHANGE_ID);
    const adoptBuild = actions.find((action) => action.actionId === "adopt_build");
    const rejectBuild = actions.find((action) => action.actionId === "reject_build");
    assert.equal(adoptBuild?.enabled, false);
    assert.equal(adoptBuild?.reasonCode, "build_not_awaiting_absorb");
    assert.equal(adoptBuild?.reason, "Build run is rejected");
    assert.equal(rejectBuild?.enabled, false);
    assert.equal(rejectBuild?.reasonCode, "build_terminal");
  });

  it("rejects Review when an implemented change has no adopted Build run", async () => {
    seedChange(repoPath, "IMPLEMENTED");

    await assert.rejects(() => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")), /Build must be approved before Review/);

    assert.equal(currentStatus(), "IMPLEMENTED");
    const attempts = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .all();
    assert.equal(attempts.length, 0);
  });

  it("rejects Review when the latest Build run is not adopted", async () => {
    seedChange(repoPath, "IMPLEMENTED");
    writeBuildRunStatus(repoPath, "awaiting_human");

    await assert.rejects(() => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")), /Build must be approved before Review/);

    assert.equal(currentStatus(), "IMPLEMENTED");
  });

  it("runs Review against the adopted Build workspace after failed fix runs wrote newer build-N files", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        assert.match(input.prompt, /independent code reviewer/);
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    const adopted = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.ok(adopted);
    assert.equal(adopted.runNumber, 1);

    // Two 修复阻断项 attempts that failed. Each still wrote a higher-numbered
    // build-N.json, and neither may shadow the adopted build-1 the change
    // carries -- otherwise re-Review dead-ends with no way out through the UI.
    writeShadowingBuildRun(repoPath, adopted, 2, "failed");
    writeShadowingBuildRun(repoPath, adopted, 3, "failed");
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.runNumber, 3);

    await runReview(CHANGE_ID, makeTestJobExecutionContext("review-after-failed-fix-runs"));

    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(
      attempt?.sourceBuildRunId,
      "build-1",
      "Review must read the adopted build, not the newest failed fix run",
    );
  });

  it("refuses Review while a newer Build run is still live or undecided", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    const adopted = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.ok(adopted);

    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("Review must not start while a newer Build run is unresolved");
      },
      async *runStreamed() {},
    }));

    // Skipping a newer run is only safe once that run is dead. A run still in
    // flight, or one parked on a human decision, may yet become the deliverable:
    // reviewing build-1 now would validate a workspace about to be superseded.
    for (const status of ["running", "awaiting_human", "gate_blocked", "created"] as const) {
      writeShadowingBuildRun(repoPath, adopted, 2, status);
      await assert.rejects(
        () => runReview(CHANGE_ID, makeTestJobExecutionContext(`review-newer-${status}`)),
        (error: Error) => {
          assert.match(error.message, /Build must be approved before Review/);
          assert.match(error.message, new RegExp(`build-2 is ${status}`));
          return true;
        },
        `a newer ${status} BuildRun must still block Review`,
      );
      fs.rmSync(
        path.join(repoPath, ".ship", "changes", CHANGE_ID, "build", "runs", "build-2.json"),
        { force: true },
      );
    }

    assert.equal(currentStatus(), "IMPLEMENTED");
    assert.equal(
      db.select().from(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).all().length,
      0,
    );
  });

  it("keeps run_review/retry_review authority when failed fix runs shadow the adopted build", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "done",
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    const adopted = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.ok(adopted);

    writeShadowingBuildRun(repoPath, adopted, 2, "failed");
    writeShadowingBuildRun(repoPath, adopted, 3, "failed");

    // The gate offered 重新反方审查 and the POST was accepted, but read-time
    // authority resolved the newest run on disk and silently withheld it.
    for (const actionId of ["run_review", "retry_review"] as const) {
      const authority = evaluateProviderActionAuthority(db, {
        changeId: CHANGE_ID, phase: "review", actionId,
      });
      assert.equal(authority.enabled, true, `${actionId}: ${JSON.stringify(authority)}`);
      assert.ok(authority.sourceDbHash);
    }

    // ...and it must go back to withholding it the moment a newer run is live.
    writeShadowingBuildRun(repoPath, adopted, 4, "awaiting_human");
    for (const actionId of ["run_review", "retry_review"] as const) {
      const authority = evaluateProviderActionAuthority(db, {
        changeId: CHANGE_ID, phase: "review", actionId,
      });
      assert.equal(authority.enabled, false, `${actionId}: ${JSON.stringify(authority)}`);
      assert.equal(authority.reasonCode, "review_build_authority_invalid");
    }
  });

  it("allows Review after a streamed Build run is adopted into the main workspace", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        assert.match(input.prompt, /independent code reviewer/);
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));

    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("build-review-old-open-p1"));
    await approveBuildAbsorb(CHANGE_ID);
    await runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct"));

    assert.equal(currentStatus(), "IMPLEMENTED");

    // D2: settling a Review materializes its mirrors, with the artifact id
    // resolved and the on-disk bytes hashed — not an empty table.
    const settledReport = db.select().from(reviewReports)
      .where(eq(reviewReports.changeId, CHANGE_ID)).get();
    assert.ok(settledReport, "review settlement must produce a report");
    const reviewMirrors = db.select().from(reviewArtifactMirrors)
      .where(eq(reviewArtifactMirrors.reportId, settledReport.id)).all();
    assert.deepEqual(
      reviewMirrors.map((mirror) => mirror.kind).sort(),
      ["review_findings", "review_report"],
      "both review mirrors must exist",
    );
    for (const mirror of reviewMirrors) {
      assert.equal(mirror.mirrorStatus, "ok");
      assert.ok(mirror.artifactId, "review mirror must resolve its artifact id");
      assert.ok(
        db.select().from(artifacts).where(eq(artifacts.id, mirror.artifactId!)).get(),
        "review mirror artifact id must resolve to a real artifact",
      );
      const onDisk = createHash("sha256")
        .update(fs.readFileSync(mirror.path!, "utf-8")).digest("hex");
      // content_hash is what the DB expects; artifact_hash is what is on disk.
      assert.equal(mirror.contentHash, onDisk);
      assert.equal(mirror.artifactHash, onDisk);
    }

    // The mirrors must not clobber the Review stage's own post-commit findings
    // file, which the Fix stage reads and keys off sourceReviewRunId.
    const postCommitFindings = JSON.parse(fs.readFileSync(
      path.join(repoPath, ".ship", "changes", CHANGE_ID, "review-findings.json"), "utf-8",
    )) as Array<{ sourceReviewRunId?: string }>;
    assert.ok(
      postCommitFindings.every((finding) => typeof finding.sourceReviewRunId === "string"),
      "post-commit review findings must keep sourceReviewRunId for the Fix stage",
    );
  });

  it("uses the change provider for Review instead of forcing codex changes to claude", async () => {
    let reviewProvider: string | null = null;
    setPipelineEngineFactoryForTest((provider) => ({
      async run(input) {
        reviewProvider = provider;
        assert.match(input.prompt, /independent code reviewer/);
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct"));

    assert.equal(reviewProvider, "codex");
    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    const reviewRun = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .find((run) => run.phase === "review");
    assert.equal(attempt?.status, "completed");
    assert.equal(attempt?.reviewStatus, "passed");
    assert.equal(attempt?.runId, reviewRun?.id);
  });

  it("keeps the Review output schema server-side and teaches the line protocol instead", async () => {
    let reviewSchema: unknown = "unset";
    let reviewPrompt = "";
    let reviewPhase = "";
    let reviewTimeoutMs: number | undefined;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        reviewSchema = input.outputSchema;
        reviewPrompt = input.prompt;
        reviewPhase = input.phase;
        reviewTimeoutMs = input.timeoutMs;
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct"));

    // Line-protocol stage: REVIEW_OUTPUT_SCHEMA stays server-side as the second
    // gate over the payload stagepass assembles from FINDING/PRIOR/APPROVED/
    // SUMMARY lines. Handing the schema to the engine is what invites the model
    // to author JSON by hand — the failure class this protocol removes.
    assert.equal(reviewSchema, undefined);

    // The prompt must teach the protocol and forbid JSON outright.
    assert.match(reviewPrompt, /FINDING: severity \| category \| file \| line \| title \| evidence \| requiredFix/);
    assert.match(
      reviewPrompt,
      /PRIOR: priorFindingId \| verdict \| evidence \| requiredFix \| replacementFindingId \| reviewerNotes/,
    );
    assert.match(reviewPrompt, /APPROVED: true/);
    assert.match(reviewPrompt, /SUMMARY<</);
    assert.match(reviewPrompt, /Do not output any JSON, code fences, or brace structures/);
    // The verdict vocabulary the parser accepts must reach the model.
    assert.match(reviewPrompt, /still_open \/ fixed \/ downgraded \/ not_reviewable \/ not_rechecked/);
    // requiredFix, never suggestion — the Review contract the schema still guards.
    assert.match(reviewPrompt, /requiredFix/);

    assert.match(reviewPrompt, /Review only the adopted Build product files/);
    assert.match(reviewPrompt, /\.ship\/\*\*/);
    assert.match(reviewPrompt, /\.codex\/agents\/\*\*/);
    assert.match(reviewPrompt, /Do not use raw git status/);
    assert.match(reviewPrompt, /You are a code reviewer/);
    assert.doesNotMatch(reviewPrompt, /严格按计划执行的实现者/);
    assert.doesNotMatch(reviewPrompt, /当前阶段是 implement/);
    assert.doesNotMatch(reviewPrompt, /按 plan 逐步实现代码变更/);
    assert.equal(reviewPhase, "review");
    assert.equal(reviewTimeoutMs, 30 * 60 * 1000);
  });

  it("resolves Review timeout from env and test override", () => {
    const previous = process.env.STAGEPASS_REVIEW_TIMEOUT_MS;
    try {
      delete process.env.STAGEPASS_REVIEW_TIMEOUT_MS;
      assert.equal(resolveReviewTimeoutMs(), 30 * 60 * 1000);

      process.env.STAGEPASS_REVIEW_TIMEOUT_MS = "1200000";
      assert.equal(resolveReviewTimeoutMs(), 1_200_000);

      process.env.STAGEPASS_REVIEW_TIMEOUT_MS = "not-a-number";
      assert.equal(resolveReviewTimeoutMs(), 30 * 60 * 1000);

      setReviewTimeoutMsForTest(42);
      assert.equal(resolveReviewTimeoutMs(), 42);
    } finally {
      setReviewTimeoutMsForTest(null);
      if (previous === undefined) {
        delete process.env.STAGEPASS_REVIEW_TIMEOUT_MS;
      } else {
        process.env.STAGEPASS_REVIEW_TIMEOUT_MS = previous;
      }
    }
  });

  it("declares requiredFix rather than suggestion in the Review structured output schema", () => {
    // The Review output schema now lives in pipeline-review-stage-service.ts.
    const source = fs.readFileSync(path.join(process.cwd(), "server/services/pipeline-review-stage-service.ts"), "utf-8");
    const schemaStart = source.indexOf("const REVIEW_OUTPUT_SCHEMA");
    const schemaEnd = source.indexOf("export function preflightReviewRun", schemaStart);
    const schemaBlock = source.slice(schemaStart, schemaEnd);

    assert.match(schemaBlock, /requiredFix/);
    assert.doesNotMatch(schemaBlock, /suggestion/);
    assert.match(
      schemaBlock,
      /required: \["severity", "category", "file", "line", "title", "evidence", "requiredFix"\]/
    );
    assert.match(schemaBlock, /priorFindingReviews/);
    assert.match(schemaBlock, /"still_open", "fixed", "downgraded", "not_reviewable", "not_rechecked"/);
  });

  it("persists Review P1 requiredFix from structured output and does not require suggestion", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        return {
          threadId: `${CHANGE_ID}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(validReviewOutput({
            approved: false,
            findings: [
              {
                severity: "P1",
                category: "bug",
                file: "server/services/pipeline-service.ts",
                line: 1455,
                title: "Review output contract still uses suggestion",
                evidence: "The output schema exposes suggestion while the Review contract requires requiredFix.",
                requiredFix: "Replace suggestion with requiredFix in Review output schema and prompt.",
              },
            ],
            priorFindingReviews: [],
            summary: "One blocking Review contract issue.",
          })),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${CHANGE_ID}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct"));

    const reviewFinding = db
      .select()
      .from(findings)
      .where(eq(findings.changeId, CHANGE_ID))
      .all()
      .find((finding) => finding.source === "review");
    assert.equal(reviewFinding?.requiredFix, "Replace suggestion with requiredFix in Review output schema and prompt.");
    const reviewRun = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .find((run) => run.phase === "review");
    const summary = JSON.parse(reviewRun?.summary ?? "{}") as { findingCount?: number; findingsPath?: string | null };
    assert.equal(summary.findingCount, 1);
    assert.ok(summary.findingsPath);
    assert.equal(fs.existsSync(summary.findingsPath), true);
    fs.unlinkSync(summary.findingsPath);

    const reviewCenter = getReviewCenterState(CHANGE_ID);
    assert.equal(reviewCenter.gate.status, "blocked_p1");
    assert.equal(reviewCenter.findings.some((finding) => finding.id === reviewFinding?.id), true);
  });

  it("requires a DB adopted build and records source trace when rerunning with an old open Review P1", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        return {
          threadId: `${CHANGE_ID}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(validReviewOutput({
            approved: true,
            findings: [
              {
                severity: "P2",
                category: "maintainability",
                file: "src/app.ts",
                line: 1,
                title: "New non-blocking follow-up",
                evidence: "src/app.ts still uses a placeholder export.",
                requiredFix: null,
              },
            ],
            priorFindingReviews: [
              {
                priorFindingId: "FND-OLD-P1",
                verdict: "still_open",
                evidence: "The previous Review finding still needs follow-up.",
                requiredFix: "The next implementation must explicitly fix this issue.",
                reviewerNotes: "Still open after recheck.",
              },
            ],
            summary: "No new blocking findings.",
          })),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${CHANGE_ID}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    const adoptedRecord = db
      .select()
      .from(buildRunRecords)
      .where(eq(buildRunRecords.changeId, CHANGE_ID))
      .get();
    assert.ok(adoptedRecord?.buildRunId);
    const approvedSourceHead = adoptedRecord?.adoptedHeadSha;
    assert.ok(approvedSourceHead);

    const now = new Date().toISOString();
    db.insert(runs).values({
      id: "RUN-OLD-REVIEW",
      changeId: CHANGE_ID,
      phase: "review",
      status: "completed",
      startedAt: now,
      endedAt: now,
      summary: JSON.stringify({
        reviewStatus: "issues_found",
        sourceBuildRunId: "build-1",
        findingCount: 1,
      }),
    }).run();
    db.insert(findings).values({
      id: "FND-OLD-P1",
      changeId: CHANGE_ID,
      runId: "RUN-OLD-REVIEW",
      source: "review",
      severity: "P1",
      category: "bug",
      title: "Old P1 must be rechecked",
      file: null,
      line: null,
      evidence: "The previous Review found this issue.",
      requiredFix: "The next Review must explicitly recheck this issue.",
      status: "open",
      createdAt: now,
      updatedAt: now,
    }).run();

    await runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct"));

    const oldFinding = db.select().from(findings).where(eq(findings.id, "FND-OLD-P1")).get();
    assert.equal(oldFinding?.status, "open");
    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(attempt?.sourceBuildRunId, adoptedRecord.buildRunId);
    assert.equal(attempt?.sourceHeadSha, approvedSourceHead);
    const newFinding = db
      .select()
      .from(findings)
      .where(eq(findings.changeId, CHANGE_ID))
      .all()
      .find((finding) => finding.title === "New non-blocking follow-up");
    assert.equal(newFinding?.sourceBuildRunId, adoptedRecord.buildRunId);
    assert.equal(newFinding?.sourceHeadSha, approvedSourceHead);
    const newReviewRun = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .filter((run) => run.phase === "review" && run.id !== "RUN-OLD-REVIEW")
      .at(-1);
    const summary = JSON.parse(newReviewRun?.summary ?? "{}") as {
      sourceBuildRunId?: string | null;
      sourceHeadSha?: string | null;
    };
    assert.equal(summary.sourceBuildRunId, adoptedRecord.buildRunId);
    assert.equal(summary.sourceHeadSha, approvedSourceHead);
  });

  it("records raw output artifact for provider failure without leaking secrets or creating a false pass", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary:
            "Failed to authenticate with API key sk-live-secret-token Authorization: Bearer bearer-secret HTTP 403",
          success: false,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(() => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")), /provider_auth_failed/);

    assert.equal(currentStatus(), "IMPLEMENTED");
    const reviewRuns = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .filter((run) => run.phase === "review");
    assert.equal(reviewRuns.length, 1);
    assert.equal(reviewRuns[0].status, "failed");
    assert.match(reviewRuns[0].summary ?? "", /provider_auth_failed/);
    assert.doesNotMatch(reviewRuns[0].summary ?? "", /sk-live-secret-token|bearer-secret/i);
    const reviewFindings = db
      .select()
      .from(findings)
      .where(eq(findings.changeId, CHANGE_ID))
      .all()
      .filter((finding) => finding.source === "review");
    assert.equal(reviewFindings.length, 0);
    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(attempt?.status, "failed");
    assert.equal(attempt?.reviewStatus, "failed");
    assert.equal(attempt?.errorCode, "provider_auth_failed");
    assert.match(attempt?.sanitizedErrorSummary ?? "", /provider_auth_failed/);
    assert.doesNotMatch(attempt?.sanitizedErrorSummary ?? "", /sk-live-secret-token|bearer-secret/i);
    assert.ok(attempt?.rawOutputArtifactId);
    const errorArtifact = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, attempt.rawOutputArtifactId))
      .get();
    assert.equal(errorArtifact?.type, "stage_raw_output");
    const errorEnvelope = fs.readFileSync(errorArtifact?.path ?? "", "utf-8");
    assert.match(errorEnvelope, /provider_auth_failed/);
    assert.match(errorEnvelope, /codex/);
    assert.match(errorEnvelope, new RegExp(`"runId": "${reviewRuns[0].id}"`));
    assert.match(errorEnvelope, /"phase": "review"/);
    assert.doesNotMatch(errorEnvelope, /sk-live-secret-token|bearer-secret/i);
    const rawCapture = latestStageRawOutputPayload();
    assert.equal(rawCapture.phase, "review");
    assert.equal(rawCapture.structuredOutputSource, "none");
    assert.equal(rawCapture.errorCode, "provider_run_failed");
    assert.equal(rawCapture.providerErrorCode, "provider_auth_failed");
  });

  it("fails Review provider failure even when summary and structured output look valid", async () => {
    const providerSummary = JSON.stringify(validReviewOutput({
      summary: "This JSON-looking provider failure must not become approval.",
    }));
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: providerSummary,
          success: false,
          providerErrorCode: "provider_auth_failed",
          providerErrorDetail: "backend unavailable",
          changedFiles: [],
          structuredOutput: validReviewOutput({
            summary: "structured output on failed provider must be ignored",
          }),
          structuredOutputSource: "provider_native",
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(() => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")), /provider_auth_failed|provider_run_failed/);

    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(attempt?.status, "failed");
    assert.equal(attempt?.reviewStatus, "failed");
    assert.ok(attempt?.rawOutputArtifactId);
    assert.equal(
      db.select().from(findings).where(eq(findings.changeId, CHANGE_ID)).all()
        .filter((finding) => finding.source === "review").length,
      0,
    );
    const rawArtifact = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, attempt.rawOutputArtifactId))
      .get();
    assert.equal(rawArtifact?.type, "stage_raw_output");
    const rawCapture = JSON.parse(fs.readFileSync(rawArtifact?.path ?? "", "utf-8")) as {
      rawText?: string;
      rawTextHash?: string;
      sanitizedErrorSummary?: string;
      structuredOutputSource?: string;
      errorCode?: string | null;
      providerErrorCode?: string | null;
    };
    assert.match(rawCapture.rawText ?? "", /provider_auth_failed: backend unavailable/);
    assert.notEqual(rawCapture.rawText, providerSummary);
    assert.equal(rawCapture.rawTextHash, sha256Text(rawCapture.rawText ?? ""));
    assert.match(rawCapture.sanitizedErrorSummary ?? "", /backend unavailable/);
    assert.equal(rawCapture.structuredOutputSource, "none");
    assert.equal(rawCapture.errorCode, "provider_run_failed");
    assert.equal(rawCapture.providerErrorCode, "provider_auth_failed");
  });

  /**
   * The killed-run shape at the Review call site. Review keeps its own raw-capture
   * envelope path, which pinned everything except a timeout to provider_run_failed
   * -- so the one artifact a post-mortem reads first said "the run failed" when the
   * engine had already determined the more useful "nothing ever came back, and the
   * process was signalled". The user-facing attempt row must carry the same code.
   */
  it("keeps the empty-response code and process forensics in the Review raw capture", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "Codex run failed: codex produced no assistant message (exit null, signal SIGTERM)",
          success: false,
          providerErrorCode: "provider_empty_response",
          providerErrorDetail: "codex produced no assistant message (exit null, signal SIGTERM)",
          exitCode: null,
          signal: "SIGTERM",
          changedFiles: [],
          items: [{ type: "reasoning", text: "thought about it, then the machine slept" }],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 3;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(
      () => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")),
      /provider_empty_response/,
    );

    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(attempt?.reviewStatus, "failed", "a non-delivery is a failure, not invalid output");
    assert.equal(attempt?.errorCode, "provider_empty_response");
    // The model is never named as the cause of a reply it did not send.
    assert.doesNotMatch(attempt?.sanitizedErrorSummary ?? "", /invalid_review_output|MARKDOWN/);

    const rawArtifact = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, attempt?.rawOutputArtifactId ?? ""))
      .get();
    const rawCapture = JSON.parse(fs.readFileSync(rawArtifact?.path ?? "", "utf-8")) as {
      errorCode?: string | null;
      providerErrorCode?: string | null;
      providerSignal?: string | null;
      providerExitCode?: number | null;
    };
    assert.equal(rawCapture.errorCode, "provider_empty_response");
    assert.equal(rawCapture.providerErrorCode, "provider_empty_response");
    // Forensics reach the review artifact too: signalled, not merely quiet.
    assert.equal(rawCapture.providerSignal, "SIGTERM");
    assert.equal(rawCapture.providerExitCode, null);
  });

  it("classifies aborted Review provider runs as timeout failures and keeps retry available", async () => {
    setReviewTimeoutMsForTest(42);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "Codex run failed: The operation was aborted",
          success: false,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(
      () => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")),
      /provider_timeout: Review provider timed out or was aborted after 42 ms/,
    );

    assert.equal(currentStatus(), "IMPLEMENTED");
    const reviewRun = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .filter((run) => run.phase === "review")
      .at(-1);
    assert.equal(reviewRun?.status, "failed");
    assert.match(reviewRun?.summary ?? "", /provider_timeout/);
    assert.match(reviewRun?.summary ?? "", /after 42 ms/);

    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(attempt?.status, "failed");
    assert.equal(attempt?.reviewStatus, "failed");
    assert.equal(attempt?.errorCode, "provider_timeout");
    assert.match(attempt?.sanitizedErrorSummary ?? "", /Review provider timed out or was aborted after 42 ms/);
    assert.ok(attempt?.rawOutputArtifactId);

    const reviewCenter = getReviewCenterState(CHANGE_ID);
    assert.equal(reviewCenter.actions.retry_review.enabled, true);
  });

  it("records raw output artifact for successful Review", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    seedApprovedTestPlanSnapshot();
    db.update(requiredValidationCommands).set({ command: "node -e \"process.exit(1)\"" })
      .where(eq(requiredValidationCommands.changeId, CHANGE_ID)).run();
    refreshQaTestPlanGateFromRows();

    await runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct"));

    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(attempt?.status, "completed");
    assert.equal(attempt?.reviewStatus, "passed");
    assert.ok(attempt?.rawOutputArtifactId);
    const rawArtifact = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, attempt.rawOutputArtifactId))
      .get();
    assert.equal(rawArtifact?.type, "stage_raw_output");
    const rawOutput = fs.readFileSync(rawArtifact?.path ?? "", "utf-8");
    assert.match(rawOutput, /review passed/);
    assert.match(rawOutput, /"findings": \[\]/);
    // Assembled by stagepass from the protocol lines, not authored by the model.
    assert.match(rawOutput, /"structuredOutputSource": "line_protocol"/);

    const enterQa = getActions(CHANGE_ID).find((action) => action.actionId === "enter_qa")!;
    assert.equal(enterQa.enabled, true, JSON.stringify(enterQa));
    const atomicEnterQa = evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID, phase: "local_check", actionId: "enter_qa",
    });
    assert.equal(atomicEnterQa.enabled, true, JSON.stringify(atomicEnterQa));
    assert.equal(atomicEnterQa.gateVersion, enterQa.gateVersion);
    assert.equal(atomicEnterQa.sourceDbHash, enterQa.sourceDbHash);
    const queued = enqueueProviderActionAtomically({
      changeId: CHANGE_ID,
      phase: "local_check",
      actionId: "enter_qa",
      idempotencyKey: "enter-qa-review-report-authority",
    }, enterQa);
    assert.equal(queued.created, true);
    db.update(pipelineJobs).set({ status: "succeeded", endedAt: new Date().toISOString() })
      .where(eq(pipelineJobs.id, queued.job.id)).run();
    const runQa = getActions(CHANGE_ID).find((action) => action.actionId === "run_qa")!;
    assert.equal(runQa.enabled, true, JSON.stringify(runQa));
    const queuedRunQa = enqueueProviderActionAtomically({
      changeId: CHANGE_ID,
      phase: "local_check",
      actionId: "run_qa",
      idempotencyKey: "run-qa-review-report-authority",
    }, runQa);
    assert.equal(queuedRunQa.created, true);
    db.update(pipelineJobs).set({ status: "succeeded", endedAt: new Date().toISOString() })
      .where(eq(pipelineJobs.id, queuedRunQa.job.id)).run();

    const failedQaContext = makeTestJobExecutionContext("qa-real-review-retry-authority");
    await runCheck(CHANGE_ID, failedQaContext, {
      entrypoint: "api_check_route", actor: "human", expectedHeadSha: attempt!.sourceHeadSha ?? undefined,
    });
    settleTestPipelineJob(failedQaContext, "failed");
    assert.equal(currentStatus(), "CHECK_FAILED");
    const retryQa = getActions(CHANGE_ID).find((action) => action.actionId === "retry_qa")!;
    assert.equal(retryQa.enabled, true, JSON.stringify(retryQa));
    const queuedRetryQa = enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "local_check", actionId: "retry_qa",
      idempotencyKey: "retry-qa-current-authority",
    }, retryQa);
    assert.equal(queuedRetryQa.created, true);
    db.update(pipelineJobs).set({ status: "succeeded", endedAt: new Date().toISOString() })
      .where(eq(pipelineJobs.id, queuedRetryQa.job.id)).run();

    db.update(requiredValidationCommands).set({ command: "node -e \"console.log('tampered')\"" })
      .where(eq(requiredValidationCommands.changeId, CHANGE_ID)).run();
    for (const [actionId, fence] of [
      ["enter_qa", enterQa], ["run_qa", runQa], ["retry_qa", retryQa],
    ] as const) {
      const idempotencyKey = `${actionId}-command-text-drift`;
      assert.throws(() => enqueueProviderActionAtomically({
        changeId: CHANGE_ID, phase: "local_check", actionId, idempotencyKey,
      }, fence), ActionContractDriftError);
      assert.equal(db.select().from(pipelineJobs).where(and(
        eq(pipelineJobs.changeId, CHANGE_ID), eq(pipelineJobs.idempotencyKey, idempotencyKey),
      )).all().length, 0);
    }
    db.update(requiredValidationCommands).set({ command: "node -e \"process.exit(1)\"" })
      .where(eq(requiredValidationCommands.changeId, CHANGE_ID)).run();

    const report = db.select().from(reviewReports).where(eq(reviewReports.changeId, CHANGE_ID)).get()!;
    const adoptedRecord = db.select().from(buildRunRecords)
      .where(eq(buildRunRecords.changeId, CHANGE_ID)).get()!;
    const assertQaDrift = (idempotencyKey: string) => {
      assert.throws(() => enqueueProviderActionAtomically({
        changeId: CHANGE_ID, phase: "local_check", actionId: "enter_qa", idempotencyKey,
      }, enterQa), ActionContractDriftError);
      assert.equal(db.select().from(pipelineJobs).where(and(
        eq(pipelineJobs.changeId, CHANGE_ID), eq(pipelineJobs.idempotencyKey, idempotencyKey),
      )).all().length, 0);
    };

    db.update(reviewAttempts).set({ inputSourceDbHash: "forged-review-lineage" })
      .where(eq(reviewAttempts.id, attempt!.id)).run();
    assertQaDrift("enter-qa-lineage-drift");
    db.update(reviewAttempts).set({ inputSourceDbHash: attempt!.inputSourceDbHash })
      .where(eq(reviewAttempts.id, attempt!.id)).run();

    // .ship authority flip (Site 1): enter_qa read-time authority is DB-authoritative; a
    // post-adoption working-tree edit no longer drifts the gate (re-caught at execution/merge).
    fs.writeFileSync(path.join(repoPath, "src", "app.ts"), "export const value = 3;\n");
    assert.equal(evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID, phase: "local_check", actionId: "enter_qa",
    }).enabled, true);
    fs.writeFileSync(path.join(repoPath, "src", "app.ts"), "export const value = 2;\n");

    db.update(buildRunRecords).set({ status: "approved_for_absorb" })
      .where(eq(buildRunRecords.id, adoptedRecord.id)).run();
    assertQaDrift("enter-qa-nonadopted-build");
    db.update(buildRunRecords).set({ status: "adopted" })
      .where(eq(buildRunRecords.id, adoptedRecord.id)).run();

    db.delete(buildRunRecords).where(eq(buildRunRecords.id, adoptedRecord.id)).run();
    assertQaDrift("enter-qa-missing-build");
    db.insert(buildRunRecords).values(adoptedRecord).run();

    db.insert(buildRunRecords).values({
      ...adoptedRecord,
      id: `${adoptedRecord.id}-NEWER`,
      adoptedAt: "2099-01-01T00:00:00.000Z",
      updatedAt: "2099-01-01T00:00:00.000Z",
    }).run();
    assertQaDrift("enter-qa-newer-build");
    db.delete(buildRunRecords).where(eq(buildRunRecords.id, `${adoptedRecord.id}-NEWER`)).run();

    db.insert(findings).values({
      id: "FND-QA-AUTHORITY-TAMPER", changeId: CHANGE_ID, runId: attempt!.runId,
      source: "review", severity: "P2", category: "test", title: "tampered finding",
      evidence: "tampered evidence", requiredFix: null, status: "open",
      createdAt: new Date().toISOString(), reviewAttemptId: attempt!.id,
      sourceBuildRunId: attempt!.sourceBuildRunId, sourceHeadSha: attempt!.sourceHeadSha,
      waivable: 0, findingVersion: 1,
    }).run();
    assertQaDrift("enter-qa-findings-drift");
    db.delete(findings).where(eq(findings.id, "FND-QA-AUTHORITY-TAMPER")).run();

    db.update(testplanSnapshots).set({ approvalState: "rejected" })
      .where(eq(testplanSnapshots.changeId, CHANGE_ID)).run();
    assertQaDrift("enter-qa-testplan-drift");
    db.update(testplanSnapshots).set({ approvalState: "approved" })
      .where(eq(testplanSnapshots.changeId, CHANGE_ID)).run();
    const testPlanSnapshot = db.select().from(testplanSnapshots)
      .where(eq(testplanSnapshots.changeId, CHANGE_ID)).get()!;
    db.insert(testplanSnapshots).values({
      ...testPlanSnapshot,
      id: `${testPlanSnapshot.id}-AMBIGUOUS`,
    }).run();
    assertQaDrift("enter-qa-ambiguous-testplan");
    db.delete(testplanSnapshots).where(eq(testplanSnapshots.id, `${testPlanSnapshot.id}-AMBIGUOUS`)).run();

    db.update(reviewReports).set({ gateStatus: "blocked_p1", qaAllowed: 0 })
      .where(eq(reviewReports.id, report.id)).run();
    assertQaDrift("enter-qa-blocked-report-columns");
    db.update(reviewReports).set({ gateStatus: report.gateStatus, qaAllowed: report.qaAllowed })
      .where(eq(reviewReports.id, report.id)).run();

  });

  /**
   * D2 (docs/state-projection-audit-2026-07-14.md §4): trustedLatestReviewReportSource
   * used to re-hash the mirror file off disk and disable enter_qa/run_qa if it
   * was missing or didn't match -- even though the DB row it had just checked
   * (mirrorStatus="ok", artifactHash===contentHash) already says the mirror is
   * fine. The DB is now authoritative: a missing or tampered file on disk no
   * longer disables the action as long as the DB row is internally consistent.
   *
   * getActions() (display) doesn't exercise this -- it reads the persisted
   * gate, not the mirror file. trustedLatestReviewReportSource is only
   * consulted by evaluateProviderActionAuthority, the atomic/enqueue-time
   * recheck (provider-action-authority-service.ts's DIRECT_ACTION_AUTHORITY_
   * RESOLVERS.enter_qa/run_qa), so that's what this asserts against.
   */
  it("keeps the atomic enter_qa authority enabled when the review mirror file is missing from disk", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        return {
          threadId: `${CHANGE_ID}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${CHANGE_ID}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    seedApprovedTestPlanSnapshot();
    db.update(requiredValidationCommands).set({ command: "node -e \"process.exit(1)\"" })
      .where(eq(requiredValidationCommands.changeId, CHANGE_ID)).run();
    refreshQaTestPlanGateFromRows();

    await runReview(CHANGE_ID, makeTestJobExecutionContext("review-mirror-missing"));

    const atomicBefore = evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID, phase: "local_check", actionId: "enter_qa",
    });
    assert.equal(atomicBefore.enabled, true, JSON.stringify(atomicBefore));

    const report = db.select().from(reviewReports).where(eq(reviewReports.changeId, CHANGE_ID)).get()!;
    const reportMirror = db.select().from(reviewArtifactMirrors)
      .where(and(eq(reviewArtifactMirrors.reportId, report.id), eq(reviewArtifactMirrors.kind, "review_report")))
      .get();
    assert.ok(reportMirror?.path, "expected a review_report mirror to exist");
    assert.equal(reportMirror.mirrorStatus, "ok");
    assert.equal(fs.existsSync(reportMirror.path!), true, "the mirror file should exist before deletion");
    fs.rmSync(reportMirror.path!);

    const atomicAfter = evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID, phase: "local_check", actionId: "enter_qa",
    });
    assert.equal(
      atomicAfter.enabled,
      true,
      "the atomic enter_qa authority should stay enabled when the DB mirror row is consistent, " +
        "even if the file on disk is gone -- " + JSON.stringify(atomicAfter),
    );
  });

  it("keeps a completed Review attempt completed when secondary artifact mirroring fails", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(validReviewOutput({
            approved: true,
            findings: [
              {
                severity: "P2",
                category: "maintainability",
                file: "src/app.ts",
                line: 1,
                title: "Non-blocking cleanup remains",
                evidence: "src/app.ts still uses a placeholder export.",
                requiredFix: null,
              },
            ],
            priorFindingReviews: [
              {
                priorFindingId: "FND-OLD-P1",
                verdict: "fixed",
                evidence: "The old P1 no longer reproduces on the adopted build.",
                requiredFix: null,
                reviewerNotes: "Closed by explicit recheck.",
              },
            ],
            summary: "DB Review completion succeeded.",
          })),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${CHANGE_ID}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    const now = new Date().toISOString();
    db.insert(findings).values({
      id: "FND-OLD-P1",
      changeId: CHANGE_ID,
      runId: null,
      source: "review",
      severity: "P1",
      category: "bug",
      title: "Old P1 should close",
      file: "src/app.ts",
      line: 1,
      evidence: "Previous valid Review found this blocker.",
      requiredFix: "Fix the old blocker.",
      status: "open",
      createdAt: now,
      updatedAt: now,
      waivable: 1,
    }).run();

    const originalWriteFileSync = fs.writeFileSync;
    const fsWithWritableSync = fs as typeof fs & { writeFileSync: typeof fs.writeFileSync };
    fsWithWritableSync.writeFileSync = ((file, data, options) => {
      if (typeof file === "string" && file.endsWith("review-findings.json")) {
        throw new Error("forced secondary mirror write failure");
      }
      return originalWriteFileSync(file, data, options as never);
    }) as typeof fs.writeFileSync;
    try {
      const result = await runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct"));
      assert.equal(result.approved, true);
    } finally {
      fsWithWritableSync.writeFileSync = originalWriteFileSync;
    }

    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(attempt?.status, "completed");
    assert.equal(attempt?.reviewStatus, "passed");
    assert.equal(attempt?.errorCode, null);
    assert.equal(attempt?.sanitizedErrorSummary, null);
    assert.ok(attempt?.rawOutputArtifactId);
    assert.equal(db.select().from(findings).where(eq(findings.id, "FND-OLD-P1")).get()?.status, "fixed");
    const newFinding = db
      .select()
      .from(findings)
      .where(eq(findings.reviewAttemptId, attempt?.id ?? ""))
      .get();
    assert.equal(newFinding?.title, "Non-blocking cleanup remains");
    assert.equal(newFinding?.status, "open");
    assert.equal(
      db
        .select()
        .from(reviewPriorFindingReviews)
        .where(eq(reviewPriorFindingReviews.attemptId, attempt?.id ?? ""))
        .get()?.verdict,
      "fixed",
    );
    const reviewRun = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .find((run) => run.phase === "review");
    const summary = JSON.parse(reviewRun?.summary ?? "{}") as { reviewStatus?: string; errorCode?: string };
    assert.equal(reviewRun?.status, "completed");
    assert.equal(summary.reviewStatus, "passed");
    assert.equal(summary.errorCode, "secondary_artifact_write_failed");
    const sideEffectEvent = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "stage_post_commit_side_effect_failed" &&
        (event.rawJson ?? "").includes("review_findings_write")
      );
    assert.ok(sideEffectEvent);
  });

  it("fails Review when structured output is missing instead of treating empty findings as approval", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "review completed without JSON",
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(() => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")), /invalid_review_output/);

    assert.equal(currentStatus(), "IMPLEMENTED");
    const reviewRun = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .find((run) => run.phase === "review");
    assert.equal(reviewRun?.status, "failed");
    assert.match(reviewRun?.summary ?? "", /invalid_review_output/);
  });

  it("refuses to resurrect model-authored review JSON when protocol lines are absent", async () => {
    // Mirrors the plan/test_plan resurrection guards: even a schema-valid JSON
    // payload (declared or in prose) must not settle a Review — the line
    // protocol is the only accepted source.
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `没有协议行，但这里有 JSON：\n\`\`\`json\n${JSON.stringify(validReviewOutput())}\n\`\`\``,
          success: true,
          changedFiles: [],
          structuredOutput: validReviewOutput(),
          structuredOutputSource: "provider_native",
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(
      () => runReview(CHANGE_ID, makeTestJobExecutionContext("review-json-resurrection")),
      /invalid_review_output|line protocol/,
    );

    assert.equal(currentStatus(), "IMPLEMENTED");
    assert.equal(
      db.select().from(findings).where(eq(findings.changeId, CHANGE_ID)).all()
        .filter((finding) => finding.source === "review").length,
      0,
    );
    const reviewRun = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .find((run) => run.phase === "review");
    assert.equal(reviewRun?.status, "failed");
  });

  it("records raw output artifact for invalid Review output when a P1 finding lacks requiredFix", async () => {
    const invalidReviewText = reviewLineProtocolText(validReviewOutput({
      approved: false,
      summary: "Invalid Review payload.",
      findings: [
        {
          severity: "P1",
          category: "bug",
          file: null,
          line: null,
          title: "Missing required fix",
          evidence: "P1 has evidence but no requiredFix.",
          requiredFix: null,
        },
      ],
    }));
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: invalidReviewText,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${CHANGE_ID}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(() => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")), /invalid_review_output/);

    const reviewRun = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .find((run) => run.phase === "review");
    assert.equal(reviewRun?.status, "failed");
    const summary = JSON.parse(reviewRun?.summary ?? "{}") as {
      reviewStatus?: string;
      rawOutputPath?: string | null;
      reportPath?: string | null;
      errorCode?: string | null;
      findingCount?: number;
    };
    assert.equal(summary.reviewStatus, "invalid_output");
    assert.equal(summary.errorCode, "invalid_review_output");
    assert.equal(summary.findingCount, 0);
    assert.ok(summary.reportPath);
    assert.equal(fs.existsSync(summary.reportPath), true);
    assert.ok(summary.rawOutputPath);
    assert.equal(fs.existsSync(summary.rawOutputPath), true);
    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(attempt?.status, "failed");
    assert.equal(attempt?.reviewStatus, "invalid_output");
    assert.equal(attempt?.errorCode, "invalid_review_output");
    assert.ok(attempt?.rawOutputArtifactId);
    const rawArtifact = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, attempt.rawOutputArtifactId))
      .get();
    assert.equal(rawArtifact?.type, "stage_raw_output");
    const rawOutput = fs.readFileSync(rawArtifact?.path ?? "", "utf-8");
    assert.match(rawOutput, /"errorCode": "invalid_review_output"/);
    assert.match(rawOutput, /P1 FINDING requires a non-empty requiredFix/);
    assert.match(rawOutput, /Missing required fix/);
    assert.match(rawOutput, new RegExp(`"rawTextHash": "${sha256Text(invalidReviewText)}"`));
    assert.doesNotMatch(rawOutput, /"normalizedPayload"/);
  });

  it("rejects provider timeout even when a fresh file candidate exists and keeps rawOutputArtifactId non-empty", async () => {
    setReviewTimeoutMsForTest(42);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        const candidatePath = path.join(
          input.repoPath,
          ".ship",
          "changes",
          input.changeId,
          "review-output.json",
        );
        fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
        fs.writeFileSync(candidatePath, `${JSON.stringify(validReviewOutput({
          summary: "review recovered from candidate file",
        }), null, 2)}\n`);
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "provider timed out after writing candidate",
          success: false,
          providerErrorCode: "provider_timeout",
          changedFiles: [`.ship/changes/${input.changeId}/review-output.json`],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(
      () => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")),
      /provider_timeout/,
    );
    assert.equal(currentStatus(), "IMPLEMENTED");
    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(attempt?.status, "failed");
    assert.equal(attempt?.reviewStatus, "failed");
    assert.equal(attempt?.errorCode, "provider_timeout");
    assert.ok(attempt?.rawOutputArtifactId);
    const rawArtifact = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, attempt.rawOutputArtifactId))
      .get();
    assert.equal(rawArtifact?.type, "stage_raw_output");
    const rawOutput = fs.readFileSync(rawArtifact?.path ?? "", "utf-8");
    assert.match(rawOutput, /provider_timeout/);
    assert.doesNotMatch(rawOutput, /provider_timeout_recovered_from_file/);
    const rawEnvelope = JSON.parse(rawOutput) as { candidateAudit?: Record<string, unknown>; normalizedPayload?: unknown };
    assert.deepEqual(rawEnvelope.candidateAudit, {
      path: `.ship/changes/${CHANGE_ID}/review-output.json`,
      sha256: rawEnvelope.candidateAudit?.sha256,
      sizeBytes: rawEnvelope.candidateAudit?.sizeBytes,
      changed: true,
      freshness: "fresh",
      symlinkDisposition: "not_symlink",
      reportedByProvider: true,
      rejectionReason: "candidate_missing_run_bound_authorship",
    });
    assert.match(String(rawEnvelope.candidateAudit?.sha256), /^[0-9a-f]{64}$/);
    assert.equal(typeof rawEnvelope.candidateAudit?.sizeBytes, "number");
    assert.equal("normalizedPayload" in rawEnvelope, false);
    assert.doesNotMatch(rawOutput, /review recovered from candidate file/);
  });

  it("does not recover non-timeout Review provider failures from a fresh review-output candidate", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        const candidatePath = path.join(
          input.repoPath,
          ".ship",
          "changes",
          input.changeId,
          "review-output.json",
        );
        fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
        fs.writeFileSync(candidatePath, `${JSON.stringify(validReviewOutput({
          summary: "auth failure candidate must not pass review",
        }), null, 2)}\n`);
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "provider auth failed after writing candidate",
          success: false,
          providerErrorCode: "provider_auth_failed",
          providerErrorDetail: "403 auth failed",
          changedFiles: [`.ship/changes/${input.changeId}/review-output.json`],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(() => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")), /provider_auth_failed/);

    assert.equal(currentStatus(), "IMPLEMENTED");
    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(attempt?.status, "failed");
    assert.equal(attempt?.reviewStatus, "failed");
    assert.equal(attempt?.errorCode, "provider_auth_failed");
    assert.ok(attempt?.rawOutputArtifactId);
    const rawArtifact = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, attempt.rawOutputArtifactId))
      .get();
    const rawOutput = fs.readFileSync(rawArtifact?.path ?? "", "utf-8");
    assert.match(rawOutput, /provider_auth_failed/);
    assert.doesNotMatch(rawOutput, /provider_timeout_recovered_from_file/);
    assert.doesNotMatch(rawOutput, /auth failure candidate must not pass review/);
  });

  it("bounds raw output capture and rejects a provider timeout even when its candidate is valid", async () => {
    setReviewTimeoutMsForTest(42);
    const largeRawText = `${"provider raw text ".repeat(2500)} timed out`;
    const largeRawResult = { transcript: "provider raw result ".repeat(2500) };
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        const candidatePath = path.join(
          input.repoPath,
          ".ship",
          "changes",
          input.changeId,
          "review-output.json",
        );
        fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
        fs.writeFileSync(candidatePath, `${JSON.stringify(validReviewOutput({
          summary: "large raw normalized payload survived",
        }), null, 2)}\n`);
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: largeRawText,
          success: false,
          providerErrorCode: "provider_timeout",
          changedFiles: [`.ship/changes/${input.changeId}/review-output.json`],
          rawProviderResult: largeRawResult,
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(
      () => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")),
      /provider_timeout/,
    );
    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.ok(attempt?.rawOutputArtifactId);
    const rawArtifact = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, attempt.rawOutputArtifactId))
      .get();
    const rawOutput = fs.readFileSync(rawArtifact?.path ?? "", "utf-8");
    assert.match(rawOutput, /provider_timeout/);
    assert.ok(rawOutput.length < largeRawText.length + JSON.stringify(largeRawResult).length);
    assert.doesNotMatch(rawOutput, /"normalizedPayload": \{/);
  });

  it("rejects provider timeout from an unreported fresh file candidate", async () => {
    setReviewTimeoutMsForTest(42);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        const candidatePath = path.join(
          input.repoPath,
          ".ship",
          "changes",
          input.changeId,
          "review-output.json",
        );
        fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
        fs.writeFileSync(candidatePath, `${JSON.stringify(validReviewOutput({
          summary: "review recovered from changed candidate state",
        }), null, 2)}\n`);
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "provider wrote unreported candidate before adapter failure",
          success: false,
          providerErrorCode: "provider_timeout",
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(
      () => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")),
      /provider_timeout/,
    );
    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(attempt?.status, "failed");
    assert.ok(attempt?.rawOutputArtifactId);
    const rawArtifact = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, attempt.rawOutputArtifactId))
      .get();
    const rawOutput = fs.readFileSync(rawArtifact?.path ?? "", "utf-8");
    assert.match(rawOutput, /provider_timeout/);
    assert.doesNotMatch(rawOutput, /provider_timeout_recovered_from_file/);
    const rawEnvelope = JSON.parse(rawOutput) as { candidateAudit?: Record<string, unknown>; normalizedPayload?: unknown };
    assert.equal(rawEnvelope.candidateAudit?.freshness, "fresh");
    assert.equal(rawEnvelope.candidateAudit?.reportedByProvider, false);
    assert.equal(rawEnvelope.candidateAudit?.rejectionReason, "candidate_unreported_by_provider");
    assert.match(String(rawEnvelope.candidateAudit?.sha256), /^[0-9a-f]{64}$/);
    assert.equal("normalizedPayload" in rawEnvelope, false);
  });

  it("does not recover provider timeout from an unchanged stale review-output candidate", async () => {
    setReviewTimeoutMsForTest(42);
    const staleCandidatePath = path.join(
      repoPath,
      ".ship",
      "changes",
      CHANGE_ID,
      "review-output.json",
    );
    fs.mkdirSync(path.dirname(staleCandidatePath), { recursive: true });
    fs.writeFileSync(staleCandidatePath, `${JSON.stringify(validReviewOutput({
      summary: "stale candidate must not be recovered",
    }), null, 2)}\n`);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "provider timed out without writing a fresh candidate",
          success: false,
          providerErrorCode: "provider_timeout",
          changedFiles: [`.ship/changes/${input.changeId}/review-output.json`],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(
      () => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")),
      /provider_timeout: Review provider timed out or was aborted after 42 ms/,
    );

    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(attempt?.status, "failed");
    assert.equal(attempt?.reviewStatus, "failed");
    assert.equal(attempt?.errorCode, "provider_timeout");
    assert.ok(attempt?.rawOutputArtifactId);
    const rawArtifact = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, attempt.rawOutputArtifactId))
      .get();
    const rawOutput = fs.readFileSync(rawArtifact?.path ?? "", "utf-8");
    assert.doesNotMatch(rawOutput, /provider_timeout_recovered_from_file/);
    assert.doesNotMatch(rawOutput, /stale candidate must not be recovered/);
    const rawEnvelope = JSON.parse(rawOutput) as { candidateAudit?: Record<string, unknown>; normalizedPayload?: unknown };
    assert.equal(rawEnvelope.candidateAudit?.freshness, "stale");
    assert.equal(rawEnvelope.candidateAudit?.changed, false);
    assert.equal(rawEnvelope.candidateAudit?.rejectionReason, "candidate_stale");
    assert.equal("normalizedPayload" in rawEnvelope, false);
  });

  it("does not recover provider timeout from a symlinked review-output candidate", async () => {
    setReviewTimeoutMsForTest(42);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        const candidatePath = path.join(
          input.repoPath,
          ".ship",
          "changes",
          input.changeId,
          "review-output.json",
        );
        const outsidePath = path.join(input.repoPath, "outside-review-output.json");
        fs.writeFileSync(outsidePath, `${JSON.stringify(validReviewOutput({
          summary: "symlink target must not be recovered",
        }), null, 2)}\n`);
        fs.rmSync(candidatePath, { force: true });
        fs.symlinkSync(outsidePath, candidatePath);
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "provider timed out after writing symlinked candidate",
          success: false,
          providerErrorCode: "provider_timeout",
          changedFiles: [`.ship/changes/${input.changeId}/review-output.json`],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(
      () => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")),
      /provider_timeout: Review provider timed out or was aborted after 42 ms/,
    );

    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(attempt?.status, "failed");
    assert.equal(attempt?.errorCode, "provider_timeout");
    assert.ok(attempt?.rawOutputArtifactId);
    const rawArtifact = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, attempt.rawOutputArtifactId))
      .get();
    const rawOutput = fs.readFileSync(rawArtifact?.path ?? "", "utf-8");
    assert.doesNotMatch(rawOutput, /provider_timeout_recovered_from_file/);
    assert.doesNotMatch(rawOutput, /symlink target must not be recovered/);
    const rawEnvelope = JSON.parse(rawOutput) as { candidateAudit?: Record<string, unknown>; normalizedPayload?: unknown };
    assert.equal(rawEnvelope.candidateAudit?.freshness, "unsafe");
    assert.equal(rawEnvelope.candidateAudit?.symlinkDisposition, "rejected_symlink");
    assert.equal(rawEnvelope.candidateAudit?.sha256, null);
    assert.equal(rawEnvelope.candidateAudit?.rejectionReason, "candidate_symlink_rejected");
    assert.equal("normalizedPayload" in rawEnvelope, false);
  });

  it("does not half-write findings or settle prior reviews when a later P1 is invalid", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(validReviewOutput({
            approved: false,
            findings: [
              {
                severity: "P2",
                category: "maintainability",
                file: "src/app.ts",
                line: 1,
                title: "Legal non-blocking finding",
                evidence: "The first finding has evidence.",
                requiredFix: null,
              },
              {
                severity: "P1",
                category: "bug",
                file: "src/app.ts",
                line: 2,
                title: "Legal blocking finding",
                evidence: "The second finding has evidence.",
                requiredFix: "Fix the second finding.",
              },
              {
                severity: "P1",
                category: "bug",
                file: "src/app.ts",
                line: 3,
                title: "Invalid blocking finding",
                evidence: "The third finding has evidence but no required fix.",
                requiredFix: null,
              },
            ],
            priorFindingReviews: [
              {
                priorFindingId: "FND-OLD-P1",
                verdict: "fixed",
                evidence: "The old P1 appears fixed in the latest build.",
                requiredFix: null,
                reviewerNotes: "Would close if the whole payload were valid.",
              },
            ],
            summary: "Invalid Review payload.",
          })),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${CHANGE_ID}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    const now = new Date().toISOString();
    db.insert(findings).values({
      id: "FND-OLD-P1",
      changeId: CHANGE_ID,
      runId: null,
      source: "review",
      severity: "P1",
      category: "bug",
      title: "Old P1 stays authoritative",
      file: "src/app.ts",
      line: 1,
      evidence: "Previous valid Review found this blocker.",
      requiredFix: "Fix the old blocker.",
      status: "open",
      createdAt: now,
      updatedAt: now,
      waivable: 1,
    }).run();

    await assert.rejects(() => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")), /invalid_review_output/);

    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .get();
    assert.equal(attempt?.reviewStatus, "invalid_output");
    assert.ok(attempt?.rawOutputArtifactId);
    assert.equal(db.select().from(findings).where(eq(findings.reviewAttemptId, attempt?.id ?? "")).all().length, 0);
    assert.equal(db.select().from(findings).where(eq(findings.id, "FND-OLD-P1")).get()?.status, "open");
    assert.equal(
      db
        .select()
        .from(reviewPriorFindingReviews)
        .where(eq(reviewPriorFindingReviews.attemptId, attempt?.id ?? ""))
        .get()?.verdict,
      "pending",
    );
  });

  it("records invalid_output and raw output when a P2 finding lacks evidence", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(validReviewOutput({
            approved: false,
            findings: [
              {
                severity: "P2",
                category: "maintainability",
                file: null,
                line: null,
                title: "Missing evidence",
                evidence: null,
                requiredFix: null,
              },
            ],
            priorFindingReviews: [],
            summary: "Invalid Review payload.",
          })),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${CHANGE_ID}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(() => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")), /invalid_review_output/);

    const reviewRun = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .find((run) => run.phase === "review");
    assert.equal(reviewRun?.status, "failed");
    const summary = JSON.parse(reviewRun?.summary ?? "{}") as {
      reviewStatus?: string;
      rawOutputPath?: string | null;
      reportPath?: string | null;
      errorCode?: string | null;
      findingCount?: number;
    };
    assert.equal(summary.reviewStatus, "invalid_output");
    assert.equal(summary.errorCode, "invalid_review_output");
    assert.equal(summary.findingCount, 0);
    assert.ok(summary.reportPath);
    assert.equal(fs.existsSync(summary.reportPath), true);
    assert.ok(summary.rawOutputPath);
    assert.equal(fs.existsSync(summary.rawOutputPath), true);
  });

  it("records invalid_output when a new P1 finding has suggestion but no requiredFix", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(validReviewOutput({
            approved: false,
            findings: [
              {
                severity: "P1",
                category: "bug",
                file: null,
                line: null,
                title: "Legacy field is not a required fix",
                evidence: "The new Review contract requires requiredFix.",
                requiredFix: null,
              },
            ],
            priorFindingReviews: [],
            summary: "Invalid Review payload.",
          })),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${CHANGE_ID}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(() => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")), /invalid_review_output/);

    const reviewRun = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .all()
      .find((run) => run.phase === "review");
    assert.equal(reviewRun?.status, "failed");
    const summary = JSON.parse(reviewRun?.summary ?? "{}") as {
      reviewStatus?: string;
      errorCode?: string | null;
      findingCount?: number;
      rawOutputPath?: string | null;
    };
    assert.equal(summary.reviewStatus, "invalid_output");
    assert.equal(summary.errorCode, "invalid_review_output");
    assert.equal(summary.findingCount, 0);
    assert.ok(summary.rawOutputPath);
    assert.equal(fs.existsSync(summary.rawOutputPath), true);

    const reviewFindings = db
      .select()
      .from(findings)
      .where(eq(findings.changeId, CHANGE_ID))
      .all()
      .filter((finding) => finding.source === "review");
    assert.equal(reviewFindings.length, 0);
  });

  it("fails Review when a blocking finding is not actionable", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: reviewLineProtocolText(validReviewOutput({
            approved: false,
            summary: "Review in progress.",
            findings: [
              {
                severity: "P1",
                category: "review",
                file: null,
                line: null,
                title: "Review in progress",
                evidence: "Still checking edge cases.",
                requiredFix: null,
              },
            ],
          })),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    await assert.rejects(() => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")), /P1 FINDING requires a non-empty requiredFix/);

    assert.equal(currentStatus(), "IMPLEMENTED");
    const reviewFindings = db
      .select()
      .from(findings)
      .where(eq(findings.changeId, CHANGE_ID))
      .all()
      .filter((finding) => finding.source === "review");
    assert.equal(reviewFindings.length, 0);
  });

  it("rejects Review when the approved workspace file is missing even if DB source trace remains", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);

    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        assert.match(input.prompt, /independent code reviewer/);
        return {
          threadId: `${input.changeId}-review-thread`,
          runId: "ENGINE-REVIEW",
          summary: "review found a non-blocking issue",
          success: true,
          changedFiles: [],
          structuredOutput: {
            approved: true,
            findings: [
              {
                severity: "P2",
                category: "maintainability",
                file: "src/app.ts",
                line: 1,
                title: "Consider a clearer value name",
                evidence: "src/app.ts exports a generic value constant.",
                requiredFix: null,
              },
            ],
            priorFindingReviews: [],
            summary: "review found a non-blocking issue",
          },
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-build-thread` } as unknown as AiStreamEvent;
      },
    }));

    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("build-preserve-source-trace"));
    await approveBuildAbsorb(CHANGE_ID);
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "adopted");
    const adoptedRecord = db
      .select()
      .from(buildRunRecords)
      .where(eq(buildRunRecords.changeId, CHANGE_ID))
      .get();
    assert.equal(adoptedRecord?.buildRunId, "build-1");
    const approvedSourceHead = adoptedRecord?.baseCommit ?? adoptedRecord?.baseHeadSha;
    assert.ok(approvedSourceHead);
    assert.equal(currentStatus(), "IMPLEMENTED");
    fs.rmSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "build"), {
      recursive: true,
      force: true,
    });

    await assert.rejects(
      () => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")),
      /Build must be approved before Review/,
    );

    assert.equal(currentStatus(), "IMPLEMENTED");
    const attempts = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .all();
    assert.equal(attempts.length, 0);
  });

  it("rejects Review when .ship is adopted but DB has no adopted build record", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-build-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "adopted");
    db.delete(buildRunRecords).where(eq(buildRunRecords.changeId, CHANGE_ID)).run();
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("Review runner should not start without a DB build record");
      },
      async *runStreamed() {},
    }));

    await assert.rejects(() => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")), /Build must be approved before Review/);

    assert.equal(currentStatus(), "IMPLEMENTED");
    const attempts = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .all();
    assert.equal(attempts.length, 0);
  });

  it("uses the adopted source even when a legacy headSha field differs", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-build-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "adopted");
    db.update(buildRunRecords)
      .set({ headSha: "f".repeat(40) })
      .where(eq(buildRunRecords.changeId, CHANGE_ID))
      .run();
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-review-thread`,
          runId: "ENGINE-REVIEW",
          summary: reviewLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct"));

    assert.equal(currentStatus(), "IMPLEMENTED");
    const attempts = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .all();
    assert.equal(attempts.length, 1);
    const approvedRecord = db
      .select()
      .from(buildRunRecords)
      .where(eq(buildRunRecords.changeId, CHANGE_ID))
      .get();
    assert.equal(attempts[0]?.sourceHeadSha, approvedRecord?.adoptedHeadSha);
  });

  it("rejects Review when the adopted main repo HEAD drifts", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    let reviewRepoPath: string | null = null;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        reviewRepoPath = input.repoPath;
        return {
          threadId: `${input.changeId}-review-thread`,
          runId: "ENGINE-REVIEW",
          summary: reviewLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-build-thread` } as unknown as AiStreamEvent;
      },
    }));

    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("build-review-head-drift"));
    await approveBuildAbsorb(CHANGE_ID);
    const approvedRun = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.equal(approvedRun?.status, "adopted");

    fs.writeFileSync(path.join(repoPath, "src", "extra.ts"), "export const extra = true;\n");
    execSync("git add src/extra.ts", { cwd: repoPath });
    execSync("git commit -m committed-drift", { cwd: repoPath, stdio: "ignore" });

    await assert.rejects(
      () => runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct")),
      /HEAD drifted after adoption/i,
    );

    assert.equal(currentStatus(), "IMPLEMENTED");
    assert.equal(reviewRepoPath, null);
    const attempts = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, CHANGE_ID))
      .all();
    assert.equal(attempts.length, 0);
  });

  it("keeps failed spec battle visible and blocked for recovery when red fails", async () => {
    seedChange(repoPath, "INTAKE_READY");
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("mock engine failed");
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-red-provider-failure")),
      /mock engine failed/,
    );

    assert.equal(currentStatus(), "BLOCKED");
    assert.equal(currentChange().blockedPhase, "spec");
    const specRuns = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .filter((run) => run.phase === "spec");
    assert.equal(specRuns.length, 1);
    assert.equal(specRuns[0].status, "failed");
    const round = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get();
    assert.equal(round?.status, "failed");

    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.prompt.includes("REQUIREMENT_CRITIC")) {
          return {
            threadId: `${input.changeId}-thread`,
            runId: "ENGINE-RUN",
            summary: blueCritiqueLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-red-timeout"));
    assert.equal(currentStatus(), "SPEC_READY");
  });

  it("times out a stalled spec red draft and marks the battle round failed", async () => {
    seedChange(repoPath, "INTAKE_READY");
    setDocumentStageTimeoutMsForTest(10);
    setDocumentStageTimeoutCleanupGraceMsForTest(10);
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        return new Promise(() => {});
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-red-timeout-rejection")),
      /timed out/,
    );

    assert.equal(currentStatus(), "BLOCKED");
    assert.equal(currentChange().blockedPhase, "spec");
    const specRuns = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .filter((run) => run.phase === "spec");
    assert.equal(specRuns.length, 1);
    assert.equal(specRuns[0].status, "failed");
    assert.match(specRuns[0].summary ?? "", /timed out/);
    const round = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get();
    assert.equal(round?.status, "failed");
  });

  it("waits for the provider timeout result during the bounded cleanup grace", async () => {
    seedChange(repoPath, "INTAKE_READY");
    setDocumentStageTimeoutMsForTest(10);
    setDocumentStageTimeoutCleanupGraceMsForTest(40);
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          threadId: "red-timeout-session",
          runId: "ENGINE-RED-TIMEOUT",
          summary: "provider_timeout: provider cleanup completed",
          success: false,
          changedFiles: [],
          structuredOutput: undefined,
          providerErrorCode: "provider_timeout",
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    const startedAt = Date.now();
    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-red-cleanup-grace")),
      /provider_timeout: provider cleanup completed/,
    );

    assert.ok(Date.now() - startedAt >= 18);
    const specRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .find((run) => run.phase === "spec");
    assert.match(specRun?.summary ?? "", /provider_timeout: provider cleanup completed/);
  });

  it("retries a timed-out Red writer in its real provider session without affecting Blue", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const observedRuns: Array<{ phase: string; threadId: string | undefined }> = [];
    let redAttempts = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        observedRuns.push({ phase: input.phase, threadId: input.threadId });
        if (input.phase === "spec") {
          redAttempts += 1;
          if (redAttempts === 1) {
            return {
              threadId: "  real-red-timeout-session  ",
              runId: "ENGINE-RED-TIMEOUT",
              summary: "provider_timeout: timed out after 300000ms",
              success: false,
              changedFiles: [],
              structuredOutput: undefined,
              providerErrorCode: "provider_timeout",
              items: [],
            };
          }
          return {
            threadId: "real-red-timeout-session",
            runId: "ENGINE-RED-RESUMED",
            summary: redSpecLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        return {
          threadId: "fresh-blue-session",
          runId: "ENGINE-BLUE",
          summary: blueCritiqueLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          structuredOutputSource: "provider_native",
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-red-timeout-first")),
      /provider_timeout/,
    );
    const failedRound = db.select().from(battleRounds)
      .where(eq(battleRounds.changeId, CHANGE_ID)).get();
    const retrySessionEvent = db.select().from(events)
      .where(and(
        eq(events.changeId, CHANGE_ID),
        eq(events.type, "spec_writer_retry_session"),
      )).get();
    assert.ok(failedRound);
    assert.ok(retrySessionEvent);
    assert.match(retrySessionEvent.rawJson ?? "", /"threadId":"real-red-timeout-session"/);
    db.update(events).set({ createdAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(events.id, retrySessionEvent.id)).run();
    const adversarialWriterSessions = [
      { id: "ZZZZ-red-malformed", rawJson: "{not-json" },
      { id: "ZZZY-red-wrong-schema", rawJson: JSON.stringify({ specWriterRetrySession: { schemaVersion: "spec_writer_retry_session/v0", roundId: failedRound.id, provider: "codex", threadId: "wrong-schema", errorCode: "provider_timeout" } }) },
      { id: "ZZZX-red-wrong-provider", rawJson: JSON.stringify({ specWriterRetrySession: { schemaVersion: "spec_writer_retry_session/v1", roundId: failedRound.id, provider: "claude", threadId: "wrong-provider", errorCode: "provider_timeout" } }) },
      { id: "ZZZW-red-wrong-round", rawJson: JSON.stringify({ specWriterRetrySession: { schemaVersion: "spec_writer_retry_session/v1", roundId: "wrong-round", provider: "codex", threadId: "wrong-round", errorCode: "provider_timeout" } }) },
    ];
    for (const candidate of adversarialWriterSessions) {
      db.insert(events).values({
        id: candidate.id,
        changeId: CHANGE_ID,
        runId: null,
        type: "spec_writer_retry_session",
        message: "adversarial writer retry session",
        rawJson: candidate.rawJson,
        createdAt: "2026-01-01T00:00:00.000Z",
      }).run();
    }
    await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-red-timeout-retry"));

    // CHANGED in batch 6: `spec_verdict` appended. Spec now ships factory
    // verdict criteria, and a non-empty verdict rubric is what makes
    // runSpecVerdictRubric call a provider -- §2.3's third agent. The
    // retry/resume property each case pins is unchanged.
    assert.deepEqual(observedRuns, [
      { phase: "spec", threadId: undefined },
      { phase: "spec", threadId: "real-red-timeout-session" },
      { phase: "spec_critic", threadId: undefined },
      { phase: "spec_verdict", threadId: undefined },
    ]);
  });

  it("does not resume a non-timeout Red writer failure", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const observedRedThreadIds: Array<string | undefined> = [];
    let redAttempts = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.phase === "spec") {
          observedRedThreadIds.push(input.threadId);
          redAttempts += 1;
          if (redAttempts === 1) {
            return {
              threadId: "must-not-resume-red",
              runId: "ENGINE-RED-FAILED",
              summary: "provider rejected request; model text mentions SIGTERM and code 143",
              success: false,
              changedFiles: [],
              structuredOutput: undefined,
              providerErrorCode: "provider_run_failed",
              items: [],
            };
          }
          return {
            threadId: "fresh-red",
            runId: "ENGINE-RED-FRESH",
            summary: redSpecLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        return {
          threadId: "fresh-blue",
          runId: "ENGINE-BLUE",
          summary: blueCritiqueLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          structuredOutputSource: "provider_native",
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-red-nontimeout-first")),
      /provider rejected request/,
    );
    const failedRound = db.select().from(battleRounds)
      .where(eq(battleRounds.changeId, CHANGE_ID)).get();
    assert.ok(failedRound);
    db.insert(events).values({
      id: "EVT-older-red-timeout",
      changeId: CHANGE_ID,
      runId: null,
      type: "spec_writer_retry_session",
      message: "older timeout must not outlive a newer non-timeout failure",
      rawJson: JSON.stringify({ specWriterRetrySession: {
        schemaVersion: "spec_writer_retry_session/v1",
        roundId: failedRound.id,
        provider: "codex",
        threadId: "older-timeout-session",
        errorCode: "provider_timeout",
      } }),
      createdAt: "2000-01-01T00:00:00.000Z",
    }).run();
    await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-red-nontimeout-retry"));

    assert.deepEqual(observedRedThreadIds, [undefined, undefined]);
    const writerFailureEvents = db.select().from(events).where(and(
      eq(events.changeId, CHANGE_ID),
      eq(events.type, "spec_writer_retry_session"),
    )).all();
    assert.equal(writerFailureEvents.length, 2);
    assert.equal(writerFailureEvents.some((event) =>
      (event.rawJson ?? "").includes('"errorCode":"provider_run_failed"')), true);
  });

  it("starts a fresh Red writer when the timeout session id is unknown", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const observedRedThreadIds: Array<string | undefined> = [];
    let redAttempts = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.phase === "spec") {
          observedRedThreadIds.push(input.threadId);
          redAttempts += 1;
          return redAttempts === 1
            ? { threadId: " unknown ", runId: "ENGINE-RED-UNKNOWN", summary: "provider_timeout", success: false, changedFiles: [], structuredOutput: undefined, providerErrorCode: "provider_timeout", items: [] }
            : { threadId: "fresh-red", runId: "ENGINE-RED-FRESH", summary: redSpecLineProtocolText(), success: true, changedFiles: [], structuredOutput: undefined, items: [] };
        }
        return { threadId: "fresh-blue", runId: "ENGINE-BLUE", summary: blueCritiqueLineProtocolText(), success: true, changedFiles: [], structuredOutput: undefined, items: [] };
      },
      async *runStreamed() {},
    }));
    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-red-unknown-first")),
      /provider_timeout/,
    );
    await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-red-unknown-retry"));
    assert.deepEqual(observedRedThreadIds, [undefined, undefined]);
  });

  it("uses DB insertion order when a Red timeout is followed by a same-ms unknown tombstone", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const observedRedThreadIds: Array<string | undefined> = [];
    let redAttempts = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.phase === "spec") {
          observedRedThreadIds.push(input.threadId);
          redAttempts += 1;
          if (redAttempts === 1) return { threadId: "old-red-timeout", runId: "RED-1", summary: "provider_timeout", success: false, changedFiles: [], structuredOutput: undefined, providerErrorCode: "provider_timeout", items: [] };
          if (redAttempts === 2) return { threadId: " unknown ", runId: "RED-2", summary: "provider_timeout unknown", success: false, changedFiles: [], structuredOutput: undefined, providerErrorCode: "provider_timeout", items: [] };
          return { threadId: "fresh-red", runId: "RED-3", summary: redSpecLineProtocolText(), success: true, changedFiles: [], structuredOutput: undefined, items: [] };
        }
        return { threadId: "blue", runId: "BLUE", summary: blueCritiqueLineProtocolText(), success: true, changedFiles: [], structuredOutput: undefined, items: [] };
      },
      async *runStreamed() {},
    }));
    await assert.rejects(() => runSpec(CHANGE_ID, makeTestJobExecutionContext("red-timeout-then-unknown-1")), /provider_timeout/);
    await assert.rejects(() => runSpec(CHANGE_ID, makeTestJobExecutionContext("red-timeout-then-unknown-2")), /provider_timeout unknown/);
    db.update(events).set({ createdAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(events.type, "spec_writer_retry_session")).run();
    await runSpec(CHANGE_ID, makeTestJobExecutionContext("red-timeout-then-unknown-3"));
    assert.deepEqual(observedRedThreadIds, [undefined, "old-red-timeout", undefined]);
  });

  it("does not resurrect an old Red timeout when a newer tombstone cannot be persisted", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const observedRedThreadIds: Array<string | undefined> = [];
    let redAttempts = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.phase === "spec") {
          observedRedThreadIds.push(input.threadId);
          redAttempts += 1;
          if (redAttempts === 1) {
            return { threadId: "old-red-timeout", runId: "ENGINE-RED-TIMEOUT", summary: "provider_timeout: red timed out", success: false, changedFiles: [], structuredOutput: undefined, providerErrorCode: "provider_timeout", items: [] };
          }
          if (redAttempts === 2) {
            return { threadId: "new-red-nontimeout", runId: "ENGINE-RED-NONTIMEOUT", summary: "provider rejected retry", success: false, changedFiles: [], structuredOutput: undefined, providerErrorCode: "provider_run_failed", items: [] };
          }
          return { threadId: "fresh-red", runId: "ENGINE-RED-FRESH", summary: redSpecLineProtocolText(), success: true, changedFiles: [], structuredOutput: undefined, items: [] };
        }
        return { threadId: "fresh-blue", runId: "ENGINE-BLUE", summary: blueCritiqueLineProtocolText(), success: true, changedFiles: [], structuredOutput: undefined, items: [] };
      },
      async *runStreamed() {},
    }));
    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-red-old-timeout")),
      /provider_timeout: red timed out/,
    );
    sqlite.exec(`
      CREATE TRIGGER fail_spec_writer_retry_session_insert
      BEFORE INSERT ON events
      WHEN NEW.type = 'spec_writer_retry_session'
      BEGIN
        SELECT RAISE(ABORT, 'forced writer retry-session persistence failure');
      END;
    `);
    try {
      await assert.rejects(
        () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-red-tombstone-persistence-failure")),
        /provider rejected retry/,
      );
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS fail_spec_writer_retry_session_insert");
    }
    await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-red-after-missing-tombstone"));
    assert.deepEqual(observedRedThreadIds, [undefined, "old-red-timeout", undefined]);
    assert.equal(db.select().from(events).where(and(
      eq(events.changeId, CHANGE_ID),
      eq(events.type, "spec_writer_retry_session"),
    )).all().length, 1);
  });

  it("keeps the last valid Red timeout session across a service SIGTERM interruption", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const observedRedThreadIds: Array<string | undefined> = [];
    let redAttempts = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.phase === "spec") {
          observedRedThreadIds.push(input.threadId);
          redAttempts += 1;
          if (redAttempts === 1) return { threadId: "durable-red-timeout", runId: "RED-TIMEOUT", summary: "provider_timeout", success: false, changedFiles: [], structuredOutput: undefined, providerErrorCode: "provider_timeout", items: [] };
          if (redAttempts === 2) {
            assert.ok(input.lifecycle);
            await input.lifecycle.onProcessStarted({ provider: "codex", pid: null, ppid: process.pid, externalRef: "durable-red-timeout", startedAt: new Date().toISOString() });
            await input.lifecycle.onTerminal({ provider: "codex", pid: null, status: "stopped", signal: "SIGTERM", summary: "Provider stopped after parent received SIGTERM", endedAt: new Date().toISOString() });
            return { threadId: "durable-red-timeout", runId: "RED-SIGTERM", summary: "Claude SDK run failed: Claude SDK exited with code 143:", success: false, changedFiles: [], structuredOutput: undefined, providerErrorCode: "provider_run_failed", items: [] };
          }
          return { threadId: "durable-red-timeout", runId: "RED-RESUMED", summary: redSpecLineProtocolText(), success: true, changedFiles: [], structuredOutput: undefined, items: [] };
        }
        return { threadId: "fresh-blue", runId: "BLUE", summary: blueCritiqueLineProtocolText(), success: true, changedFiles: [], structuredOutput: undefined, items: [] };
      },
      async *runStreamed() {},
    }));
    await assert.rejects(() => runSpec(CHANGE_ID, makeTestJobExecutionContext("red-sigterm-1")), /provider_timeout/);
    await assert.rejects(() => runSpec(CHANGE_ID, makeTestJobExecutionContext("red-sigterm-2")), /exited with code 143/);
    await runSpec(CHANGE_ID, makeTestJobExecutionContext("red-sigterm-3"));
    assert.deepEqual(observedRedThreadIds, [undefined, "durable-red-timeout", "durable-red-timeout"]);
  });

  it("treats a newer completed Spec run as a fresh-session barrier", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const observedRedThreadIds: Array<string | undefined> = [];
    let redAttempts = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.phase === "spec") {
          observedRedThreadIds.push(input.threadId);
          redAttempts += 1;
          return redAttempts === 1
            ? { threadId: "old-timeout-before-success", runId: "RED-TIMEOUT", summary: "provider_timeout", success: false, changedFiles: [], structuredOutput: undefined, providerErrorCode: "provider_timeout", items: [] }
            : { threadId: "fresh-after-success", runId: "RED-FRESH", summary: redSpecLineProtocolText(), success: true, changedFiles: [], structuredOutput: undefined, items: [] };
        }
        return { threadId: "blue", runId: "BLUE", summary: blueCritiqueLineProtocolText(), success: true, changedFiles: [], structuredOutput: undefined, items: [] };
      },
      async *runStreamed() {},
    }));
    await assert.rejects(() => runSpec(CHANGE_ID, makeTestJobExecutionContext("red-success-barrier-1")), /provider_timeout/);
    db.insert(runs).values({ id: "RUN-SUCCESS-BARRIER", changeId: CHANGE_ID, phase: "spec", status: "completed", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), summary: "later successful Spec" }).run();
    await runSpec(CHANGE_ID, makeTestJobExecutionContext("red-success-barrier-2"));
    assert.deepEqual(observedRedThreadIds, [undefined, undefined]);
  });

  it("finds the valid timeout session beyond more than fifty structured SIGTERM interruptions", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const observedRedThreadIds: Array<string | undefined> = [];
    let redAttempts = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.phase === "spec") {
          observedRedThreadIds.push(input.threadId);
          redAttempts += 1;
          return redAttempts === 1
            ? { threadId: "deep-red-timeout", runId: "RED-TIMEOUT", summary: "provider_timeout", success: false, changedFiles: [], structuredOutput: undefined, providerErrorCode: "provider_timeout", items: [] }
            : { threadId: "deep-red-timeout", runId: "RED-RESUMED", summary: redSpecLineProtocolText(), success: true, changedFiles: [], structuredOutput: undefined, items: [] };
        }
        return { threadId: "blue", runId: "BLUE", summary: blueCritiqueLineProtocolText(), success: true, changedFiles: [], structuredOutput: undefined, items: [] };
      },
      async *runStreamed() {},
    }));
    await assert.rejects(() => runSpec(CHANGE_ID, makeTestJobExecutionContext("red-deep-interruption-1")), /provider_timeout/);
    const round = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get();
    assert.ok(round);
    for (let index = 0; index < 51; index += 1) {
      const runId = `RUN-SIGTERM-${index}`;
      db.insert(runs).values({ id: runId, changeId: CHANGE_ID, phase: "spec", status: "failed", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), summary: "opaque infrastructure interruption" }).run();
      db.insert(events).values({ id: `EVT-SIGTERM-${index}`, changeId: CHANGE_ID, runId, type: "spec_writer_retry_session", message: "interrupted continuity marker", rawJson: JSON.stringify({ specWriterRetrySession: { schemaVersion: "spec_writer_retry_session/v1", roundId: round.id, provider: "codex", threadId: "deep-red-timeout", errorCode: "provider_run_failed" } }), createdAt: new Date().toISOString() }).run();
      db.insert(providerRunProcesses).values({ id: `PRP-SIGTERM-${index}`, changeId: CHANGE_ID, runId, phase: "spec", provider: "codex", pid: null, ppid: process.pid, roundId: round.id, status: "stopped", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), signal: "SIGTERM" }).run();
    }
    await runSpec(CHANGE_ID, makeTestJobExecutionContext("red-deep-interruption-2"));
    assert.deepEqual(observedRedThreadIds, [undefined, "deep-red-timeout"]);
  });

  it("propagates a fast inner provider rejection without waiting for the watchdog", async () => {
    seedChange(repoPath, "INTAKE_READY");
    setDocumentStageTimeoutMsForTest(200);
    setDocumentStageTimeoutCleanupGraceMsForTest(200);
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        throw new Error("fast inner provider rejection");
      },
      async *runStreamed() {},
    }));

    const startedAt = Date.now();
    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-fast-inner-rejection")),
      /fast inner provider rejection/,
    );
    assert.ok(Date.now() - startedAt < 200);
  });

  it("gives both sequential Spec providers a full timeout plus bounded cleanup grace", async () => {
    seedChange(repoPath, "INTAKE_READY");
    setDocumentStageTimeoutMsForTest(10);
    setDocumentStageTimeoutCleanupGraceMsForTest(40);
    const observed: Array<{ phase: string; timeoutMs: number | undefined }> = [];
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        observed.push({ phase: input.phase, timeoutMs: input.timeoutMs });
        await new Promise((resolve) => setTimeout(resolve, 15));
        const isBlue = input.phase === "spec_critic";
        return {
          threadId: isBlue ? "blue-session" : "red-session",
          runId: isBlue ? "ENGINE-BLUE" : "ENGINE-RED",
          summary: isBlue
            ? blueCritiqueLineProtocolText()
            : redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    const startedAt = Date.now();
    await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-composite-timeout-budget"));

    assert.ok(Date.now() - startedAt >= 28);
    // CHANGED in batch 6: `spec_verdict` appended -- Spec ships factory verdict
    // criteria now, so §2.3's third agent runs and gets its own full timeout.
    // That IS the property under test: each sequential provider is budgeted
    // independently rather than sharing one, and it now covers three of them.
    assert.deepEqual(observed, [
      { phase: "spec", timeoutMs: 10 },
      { phase: "spec_critic", timeoutMs: 10 },
      { phase: "spec_verdict", timeoutMs: 10 },
    ]);
    assert.equal(currentStatus(), "SPEC_READY");
  });

  it("bounds a Spec Blue adapter that never settles after its provider timeout", async () => {
    seedChange(repoPath, "INTAKE_READY");
    setDocumentStageTimeoutMsForTest(10);
    setDocumentStageTimeoutCleanupGraceMsForTest(10);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.phase === "spec_critic") {
          return new Promise(() => {});
        }
        return {
          threadId: "red-session",
          runId: "ENGINE-RED",
          summary: redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-blue-watchdog")),
      /spec_critic stage watchdog timed out after 20ms/,
    );

    assert.equal(currentStatus(), "BLOCKED");
    const round = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get();
    assert.equal(round?.status, "failed");
  });

  it("passes the document-stage timeout into the spec red draft engine run", async () => {
    seedChange(repoPath, "INTAKE_READY");
    setDocumentStageTimeoutMsForTest(4321);
    let observedTimeoutMs: number | undefined;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        observedTimeoutMs = input.timeoutMs;
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: input.prompt.includes("REQUIREMENT_CRITIC")
            ? blueCritiqueLineProtocolText()
            : redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-timeout-forwarding"));

    assert.equal(observedTimeoutMs, 4321);
  });

  it("does not let a stopped in-flight spec run advance when the AI returns", async () => {
    seedChange(repoPath, "INTAKE_READY");
    let markEngineStarted: (() => void) | null = null;
    let resolveEngineRun: ((value: {
      threadId: string;
      runId: string;
      summary: string;
      success: boolean;
      changedFiles: string[];
      structuredOutput: undefined;
      items: [];
    }) => void) | null = null;
    const engineStarted = new Promise<void>((resolve) => {
      markEngineStarted = resolve;
    });

    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        markEngineStarted?.();
        return new Promise((resolve) => {
          resolveEngineRun = resolve;
        }).then(() => ({
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        }));
      },
      async *runStreamed() {},
    }));

    const specRun = runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-stopped-in-flight"));
    await engineStarted;

    const now = new Date().toISOString();
    db.update(runs)
      .set({ status: "stopped", endedAt: now })
      .where(eq(runs.changeId, CHANGE_ID))
      .run();
    db.update(changes)
      .set({ status: "BLOCKED", blockedPhase: "spec", updatedAt: now })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    resolveEngineRun?.({
      threadId: `${CHANGE_ID}-thread`,
      runId: "ENGINE-RUN",
      summary: `summary for ${CHANGE_ID}`,
      success: true,
      changedFiles: [],
      structuredOutput: undefined,
      items: [],
    });

    await assert.rejects(specRun, /stopped|blocked/);
    assert.equal(currentStatus(), "BLOCKED");
    assert.equal(currentChange().blockedPhase, "spec");
    const round = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get();
    assert.equal(round?.status, "failed");
  });

  it("refuses to resurrect fenced JSON from the blue critic and keeps the schema server-side", async () => {
    // This stage used to extract a fenced JSON block out of the critic's prose.
    // That extraction path is exactly how a hand-typed payload reached the DB,
    // so under the line protocol it must be refused, not repaired.
    seedChange(repoPath, "INTAKE_READY");
    let blueOutputSchema: unknown = "unset";
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.prompt.includes("REQUIREMENT_CRITIC")) {
          blueOutputSchema = input.outputSchema;
          return {
            threadId: `${input.changeId}-thread`,
            runId: "ENGINE-BLUE-FENCED",
            summary: [
              "I reviewed the spec. Structured payload follows.",
              "```json",
              JSON.stringify(validBlueCritiqueOutput()),
              "```",
            ].join("\n"),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RED",
          summary: redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-blue-fenced-json")),
      /line protocol|CRITIQUE_DONE|invalid_stage_output|Spec critic output invalid/,
    );

    // The engine is handed no schema: that request is the invitation to author
    // JSON. BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA stays the server-side second gate.
    assert.equal(blueOutputSchema, undefined);
    assert.notEqual(currentStatus(), "SPEC_READY");
  });

  it("refuses provider-native structured output from the blue critic", async () => {
    seedChange(repoPath, "INTAKE_READY");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.prompt.includes("REQUIREMENT_CRITIC")) {
          return {
            threadId: `${input.changeId}-thread`,
            runId: "ENGINE-BLUE-NATIVE",
            summary: "provider returned native structured output",
            success: true,
            changedFiles: [],
            structuredOutput: validBlueCritiqueOutput(),
            structuredOutputSource: "provider_native",
            schemaDelivery: "provider_native",
            items: [],
          };
        }
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RED",
          summary: redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-blue-structured-output")),
      /line protocol|CRITIQUE_DONE|invalid_stage_output|Spec critic output invalid/,
    );

    assert.notEqual(currentStatus(), "SPEC_READY");
  });

  it("keeps the shared Spec run active through Blue provider startup", async () => {
    seedChange(repoPath, "INTAKE_READY");
    let blueRunStatusBeforeStart: string | null = null;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        const isBlue = input.prompt.includes("REQUIREMENT_CRITIC");
        if (isBlue) {
          blueRunStatusBeforeStart = db.select({ status: runs.status })
            .from(runs)
            .where(eq(runs.changeId, CHANGE_ID))
            .get()?.status ?? null;
        }
        await emitProviderLifecycle(
          input.lifecycle,
          "completed",
          isBlue ? "spec-blue-shared-run" : "spec-red-shared-run",
        );
        return {
          threadId: `${input.changeId}-thread`,
          runId: isBlue ? "ENGINE-BLUE" : "ENGINE-RED",
          summary: isBlue
            ? blueCritiqueLineProtocolText()
            : redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-shared-run-blue-start"));

    assert.equal(blueRunStatusBeforeStart, "running");
    const specRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).get();
    assert.equal(specRun?.status, "completed");
  });

  it("runs Spec Red and Blue in fresh provider threads", async () => {
    seedChange(repoPath, "INTAKE_READY");
    db.update(changes)
      .set({ codexThreadId: "oversized-change-thread" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    const observedThreadIds: Array<{
      phase: string;
      threadId: string | undefined;
    }> = [];
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        observedThreadIds.push({ phase: input.phase, threadId: input.threadId });
        const isBlue = input.phase === "spec_critic";
        return {
          threadId: isBlue ? "fresh-blue-thread" : "fresh-red-thread",
          runId: isBlue ? "ENGINE-BLUE-FRESH" : "ENGINE-RED-FRESH",
          summary: isBlue
            ? blueCritiqueLineProtocolText()
            : redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-fresh-provider-threads"));

    // CHANGED in batch 6: `spec_verdict` joined the list. Spec now ships factory
    // verdict criteria, and a non-empty verdict rubric is exactly what makes
    // runSpecVerdictRubric call a provider -- §2.3's third agent, which the user
    // asked for by name. The property under test (each half opens a FRESH
    // thread, threadId undefined) is unchanged and now covers the third call too.
    assert.deepEqual(observedThreadIds, [
      { phase: "spec", threadId: undefined },
      { phase: "spec_critic", threadId: undefined },
      { phase: "spec_verdict", threadId: undefined },
    ]);
  });

  it("retries a timed-out Blue critic in its real provider session without rerunning Red", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const observedRuns: Array<{ phase: string; threadId: string | undefined }> = [];
    let blueAttempts = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        observedRuns.push({ phase: input.phase, threadId: input.threadId });
        if (input.phase === "spec_critic") {
          blueAttempts += 1;
          if (blueAttempts === 1) {
            return {
              threadId: "  real-blue-timeout-session  ",
              runId: "ENGINE-BLUE-TIMEOUT",
              summary: "provider_timeout: timed out after 300000ms",
              success: false,
              changedFiles: [],
              structuredOutput: undefined,
              structuredOutputSource: "none",
              providerErrorCode: "provider_timeout",
              items: [],
            };
          }
          return {
            threadId: "real-blue-timeout-session",
            runId: "ENGINE-BLUE-RESUMED",
            summary: blueCritiqueLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            structuredOutputSource: "provider_native",
            items: [],
          };
        }
        return {
          threadId: "real-red-session",
          runId: "ENGINE-RED",
          summary: redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-blue-timeout-first")),
      /provider_timeout/,
    );
    const failedRound = db.select().from(battleRounds)
      .where(eq(battleRounds.changeId, CHANGE_ID)).get();
    assert.equal(failedRound?.status, "failed");
    assert.ok(failedRound?.redArtifactPath);
    const retrySessionEvent = db.select().from(events)
      .where(and(
        eq(events.changeId, CHANGE_ID),
        eq(events.type, "spec_critic_retry_session"),
      )).get();
    assert.match(retrySessionEvent?.rawJson ?? "", /"threadId":"real-blue-timeout-session"/);
    assert.ok(retrySessionEvent);
    const adversarialSessions = [
      {
        id: "ZZZ-wrong-schema",
        payload: { schemaVersion: "spec_critic_retry_session/v0", roundId: failedRound?.id, provider: "codex", threadId: "wrong-schema", errorCode: "provider_timeout" },
      },
      {
        id: "ZZY-wrong-provider",
        payload: { schemaVersion: "spec_critic_retry_session/v1", roundId: failedRound?.id, provider: "claude", threadId: "wrong-provider", errorCode: "provider_timeout" },
      },
      {
        id: "ZZX-wrong-round",
        payload: { schemaVersion: "spec_critic_retry_session/v1", roundId: "other-round", provider: "codex", threadId: "wrong-round", errorCode: "provider_timeout" },
      },
    ];
    db.update(events).set({ createdAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(events.id, retrySessionEvent.id)).run();
    db.insert(events).values({
      id: "ZZZZ-malformed-json",
      changeId: CHANGE_ID,
      runId: null,
      type: "spec_critic_retry_session",
      message: "malformed adversarial retry session",
      rawJson: "{not-json",
      createdAt: "2026-01-01T00:00:00.000Z",
    }).run();
    for (const candidate of adversarialSessions) {
      db.insert(events).values({
        id: candidate.id,
        changeId: CHANGE_ID,
        runId: null,
        type: "spec_critic_retry_session",
        message: "adversarial retry session",
        rawJson: JSON.stringify({ specCriticRetrySession: candidate.payload }),
        createdAt: "2026-01-01T00:00:00.000Z",
      }).run();
    }

    await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-blue-timeout-retry"));

    assert.equal(currentStatus(), "SPEC_READY");
    // CHANGED in batch 6: `spec_verdict` appended. Spec now ships factory
    // verdict criteria, and a non-empty verdict rubric is what makes
    // runSpecVerdictRubric call a provider -- §2.3's third agent. The
    // retry/resume property each case pins is unchanged.
    assert.deepEqual(observedRuns, [
      { phase: "spec", threadId: undefined },
      { phase: "spec_critic", threadId: undefined },
      { phase: "spec_critic", threadId: "real-blue-timeout-session" },
      { phase: "spec_verdict", threadId: undefined },
    ]);
  });

  it("does not resume a non-timeout Blue failure but still preserves successful Red work", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const observedRuns: Array<{ phase: string; threadId: string | undefined }> = [];
    let blueAttempts = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        observedRuns.push({ phase: input.phase, threadId: input.threadId });
        if (input.phase === "spec_critic") {
          blueAttempts += 1;
          if (blueAttempts === 1) {
            return {
              threadId: "must-not-resume-this-session",
              runId: "ENGINE-BLUE-FAILED",
              summary: "provider rejected request",
              success: false,
              changedFiles: [],
              structuredOutput: undefined,
              structuredOutputSource: "none",
              providerErrorCode: "provider_run_failed",
              items: [],
            };
          }
          return {
            threadId: "fresh-blue-session",
            runId: "ENGINE-BLUE-FRESH",
            summary: blueCritiqueLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            structuredOutputSource: "provider_native",
            items: [],
          };
        }
        return {
          threadId: "real-red-session",
          runId: "ENGINE-RED",
          summary: redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-blue-provider-failure")),
      /provider rejected request/,
    );
    const criticFailureEvents = db.select().from(events)
      .where(and(
        eq(events.changeId, CHANGE_ID),
        eq(events.type, "spec_critic_retry_session"),
      )).all();
    assert.equal(criticFailureEvents.length, 1);
    assert.match(criticFailureEvents[0].rawJson ?? "", /"errorCode":"provider_run_failed"/);
    await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-blue-provider-failure-retry"));

    // CHANGED in batch 6: `spec_verdict` appended. Spec now ships factory
    // verdict criteria, and a non-empty verdict rubric is what makes
    // runSpecVerdictRubric call a provider -- §2.3's third agent. The
    // retry/resume property each case pins is unchanged.
    // CHANGED in batch 6: `spec_verdict` appended -- Spec now ships factory
    // verdict criteria, so §2.3's third agent runs. The property pinned here
    // (a non-timeout Blue failure is NOT resumed in its old session) is unchanged.
    assert.deepEqual(observedRuns, [
      { phase: "spec", threadId: undefined },
      { phase: "spec_critic", threadId: undefined },
      { phase: "spec_critic", threadId: undefined },
      { phase: "spec_verdict", threadId: undefined },
    ]);
  });

  it("uses DB insertion order when a Blue timeout is followed by a same-ms non-timeout tombstone", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const observedBlueThreadIds: Array<string | undefined> = [];
    let blueAttempts = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.phase === "spec_critic") {
          observedBlueThreadIds.push(input.threadId);
          blueAttempts += 1;
          if (blueAttempts === 1) return { threadId: "old-blue-timeout", runId: "BLUE-1", summary: "provider_timeout", success: false, changedFiles: [], structuredOutput: undefined, providerErrorCode: "provider_timeout", items: [] };
          if (blueAttempts === 2) return { threadId: "blue-nontimeout", runId: "BLUE-2", summary: "blue rejected retry", success: false, changedFiles: [], structuredOutput: undefined, providerErrorCode: "provider_run_failed", items: [] };
          return { threadId: "fresh-blue", runId: "BLUE-3", summary: blueCritiqueLineProtocolText(), success: true, changedFiles: [], structuredOutput: undefined, items: [] };
        }
        return { threadId: "red", runId: "RED", summary: redSpecLineProtocolText(), success: true, changedFiles: [], structuredOutput: undefined, items: [] };
      },
      async *runStreamed() {},
    }));
    await assert.rejects(() => runSpec(CHANGE_ID, makeTestJobExecutionContext("blue-timeout-then-tombstone-1")), /provider_timeout/);
    await assert.rejects(() => runSpec(CHANGE_ID, makeTestJobExecutionContext("blue-timeout-then-tombstone-2")), /blue rejected retry/);
    db.update(events).set({ createdAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(events.type, "spec_critic_retry_session")).run();
    await runSpec(CHANGE_ID, makeTestJobExecutionContext("blue-timeout-then-tombstone-3"));
    assert.deepEqual(observedBlueThreadIds, [undefined, "old-blue-timeout", undefined]);
  });

  it("preserves the provider timeout and raw capture when retry-session persistence fails", async () => {
    seedChange(repoPath, "INTAKE_READY");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.phase === "spec_critic") {
          return {
            threadId: "real-blue-session-that-cannot-be-persisted",
            runId: "ENGINE-BLUE-TIMEOUT-PERSISTENCE-FAILURE",
            summary: "provider_timeout: timed out after 300000ms",
            success: false,
            changedFiles: [],
            structuredOutput: undefined,
            structuredOutputSource: "none",
            providerErrorCode: "provider_timeout",
            items: [],
          };
        }
        return {
          threadId: "red-session",
          runId: "ENGINE-RED",
          summary: redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));
    sqlite.exec(`
      CREATE TRIGGER fail_spec_critic_retry_session_insert
      BEFORE INSERT ON events
      WHEN NEW.type = 'spec_critic_retry_session'
      BEGIN
        SELECT RAISE(ABORT, 'forced retry-session persistence failure');
      END;
    `);
    try {
      await assert.rejects(
        () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-blue-timeout-persistence-failure")),
        /provider_timeout/,
      );
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS fail_spec_critic_retry_session_insert");
    }

    assert.equal(currentStatus(), "BLOCKED");
    const rawCapturePath = latestSpecRunRawCapturePath(repoPath);
    assert.equal(fs.existsSync(rawCapturePath), true);
    const rawCapture = JSON.parse(fs.readFileSync(rawCapturePath, "utf-8"));
    assert.equal(rawCapture.errorCode, "provider_timeout");
  });

  it("fails spec through ingestion and raw-captures when the blue critic does not return JSON", async () => {
    seedChange(repoPath, "INTAKE_READY");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: input.prompt.includes("REQUIREMENT_CRITIC") ? "not json" : redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-blue-invalid-json")),
      (error: unknown) => {
        assert.match(String(error), /invalid_stage_output/);
        assert.doesNotMatch(String(error), /structured JSON/);
        return true;
      },
    );
    assert.equal(currentStatus(), "BLOCKED");
    assert.equal(currentChange().blockedPhase, "spec");
    const round = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get();
    assert.equal(round?.status, "failed");
    const rawCapturePath = latestSpecRunRawCapturePath(repoPath);
    assert.equal(fs.existsSync(rawCapturePath), true);
    const rawCapture = JSON.parse(fs.readFileSync(rawCapturePath, "utf-8"));
    assert.equal(rawCapture.phase, "spec_critic");
    assert.equal(rawCapture.provider, "codex");
    assert.equal(rawCapture.errorCode, "invalid_stage_output");
  });

  it("does not recover the blue critic from a stale blue artifact file", async () => {
    seedChange(repoPath, "INTAKE_READY");
    writeChangeFile(
      repoPath,
      path.join("rounds", "spec-round-01-blue.json"),
      `${JSON.stringify(validBlueCritiqueOutput(), null, 2)}\n`,
    );
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: input.prompt.includes("REQUIREMENT_CRITIC") ? "not json" : redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-blue-stale-artifact")),
      /invalid_stage_output/,
    );

    assert.equal(currentStatus(), "BLOCKED");
    assert.equal(currentChange().blockedPhase, "spec");
    const round = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get();
    assert.equal(round?.status, "failed");
  });

  it("fails spec with the blue critic provider failure instead of a structured JSON error", async () => {
    seedChange(repoPath, "INTAKE_READY");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.prompt.includes("REQUIREMENT_CRITIC")) {
          return {
            threadId: `${input.changeId}-thread`,
            runId: "ENGINE-RUN",
            summary: "provider_timeout: Claude SDK timed out after 10ms",
            success: false,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-blue-provider-timeout")),
      (error: unknown) => {
        assert.match(String(error), /provider_timeout/);
        assert.doesNotMatch(String(error), /structured JSON/);
        return true;
      },
    );
    assert.equal(currentStatus(), "BLOCKED");
    assert.equal(currentChange().blockedPhase, "spec");
    const round = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get();
    assert.equal(round?.status, "failed");
  });

  it("fails spec on blue critic provider failure even with valid structured output", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const originalProviderSummary = [
      "ORIGINAL PROVIDER SUMMARY / TRANSCRIPT",
      blueCritiqueLineProtocolText(),
      "This text must be preserved in raw capture.",
    ].join("\n");
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.prompt.includes("REQUIREMENT_CRITIC")) {
          return {
            threadId: `${input.changeId}-thread`,
            runId: "ENGINE-RUN",
            summary: originalProviderSummary,
            success: false,
            changedFiles: [],
            providerErrorCode: "provider_run_failed",
            providerErrorDetail: "backend unavailable",
            structuredOutput: undefined,
            structuredOutputSource: "provider_native",
            schemaDelivery: "provider_native",
            items: [],
          };
        }
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-blue-provider-failure")),
      (error: unknown) => {
        assert.match(String(error), /provider_run_failed|backend unavailable|Spec critic provider failed/);
        assert.doesNotMatch(String(error), /\{"gapReviews":\[\],"requirementGaps":\[\]\}/);
        return true;
      },
    );

    assert.equal(currentStatus(), "BLOCKED");
    assert.equal(currentChange().blockedPhase, "spec");
    const failedSpecRun = db.select().from(runs)
      .where(eq(runs.changeId, CHANGE_ID))
      .get();
    assert.equal(failedSpecRun?.status, "failed");
    assert.match(failedSpecRun?.summary ?? "", /backend unavailable/);
    const round = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get();
    assert.equal(round?.status, "failed");
    assert.equal(artifactExists(repoPath, path.join("reports", "spec-report.md")), false);
    const rawCapturePath = latestSpecRunRawCapturePath(repoPath);
    assert.equal(fs.existsSync(rawCapturePath), true);
    const rawCapture = JSON.parse(fs.readFileSync(rawCapturePath, "utf-8"));
    assert.equal(rawCapture.phase, "spec_critic");
    assert.equal(rawCapture.provider, "codex");
    assert.equal(rawCapture.structuredOutputSource, "none");
    assert.equal(rawCapture.providerErrorCode, "provider_run_failed");
    assert.equal(rawCapture.errorCode, "provider_run_failed");
    assert.equal(rawCapture.rawText, "provider_run_failed: backend unavailable");
    assert.equal(rawCapture.rawTextHash, sha256Text(rawCapture.rawText));
    assert.notEqual(rawCapture.rawText, originalProviderSummary);
    assert.match(rawCapture.sanitizedErrorSummary ?? "", /backend unavailable/);
  });

  it("runs spec battle and writes red, blue, and report artifacts", async () => {
    seedChange(repoPath, "INTAKE_READY");

    await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-battle-artifacts"));

    assert.equal(currentStatus(), "SPEC_READY");
    assert.equal(artifactExists(repoPath, "prd-delta.md"), true);
    assert.equal(artifactExists(repoPath, path.join("rounds", "spec-round-01-red.md")), true);
    assert.equal(artifactExists(repoPath, path.join("rounds", "spec-round-01-blue.json")), true);
    assert.equal(artifactExists(repoPath, path.join("reports", "spec-report.md")), true);
  });

  it("keeps runSpec ready when the document-stage default artifact write fails", async () => {
    seedChange(repoPath, "INTAKE_READY");

    const originalWriteFileSync = fs.writeFileSync;
    let injectedFailure = false;
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (
        !injectedFailure
        && typeof file === "string"
        && file.endsWith(path.join(".ship", "changes", CHANGE_ID, "prd-delta.md"))
      ) {
        injectedFailure = true;
        throw new Error("default prd artifact write failed after Red output");
      }
      return originalWriteFileSync(file, data, options);
    }) as typeof fs.writeFileSync;

    try {
      await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-default-artifact-failure"));
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.equal(injectedFailure, true);
    assert.equal(currentStatus(), "SPEC_READY");
    assert.equal(artifactExists(repoPath, path.join("rounds", "spec-round-01-red.md")), true);

    const redRun = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .find((run) => run.phase === "spec");
    assert.equal(redRun?.status, "completed");
    const postCommitEvent = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "document_stage_post_commit_side_effect_failed" &&
        event.runId === redRun?.id &&
        event.rawJson?.includes("\"phase\":\"spec\"") &&
        event.rawJson?.includes("\"artifactType\":\"prd_delta\"") &&
        event.rawJson?.includes("\"fileName\":\"prd-delta.md\"") &&
        event.rawJson?.includes("default prd artifact write failed after Red output")
      );
    assert.ok(postCommitEvent);
  });

  it("keeps runSpec ready when a Red post-commit artifact write fails", async () => {
    seedChange(repoPath, "INTAKE_READY");

    const originalWriteFileSync = fs.writeFileSync;
    let injectedFailure = false;
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (!injectedFailure && typeof file === "string" && file.endsWith("spec-round-01-red.md")) {
        injectedFailure = true;
        throw new Error("red artifact write failed after commit");
      }
      return originalWriteFileSync(file, data, options);
    }) as typeof fs.writeFileSync;

    try {
      await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-red-artifact-failure"));
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.equal(injectedFailure, true);
    assert.equal(currentStatus(), "SPEC_READY");
    assert.equal(currentChange().blockedPhase, null);

    const round = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get();
    assert.equal(round?.status, "report_ready");
    assert.match(round?.redArtifactPath ?? "", /spec-round-01-red\.md$/);
    assert.equal(typeof round?.redArtifactHash, "string");
    assert.equal(artifactExists(repoPath, path.join("rounds", "spec-round-01-blue.json")), true);
    assert.equal(artifactExists(repoPath, path.join("reports", "spec-report.md")), true);

    const postCommitEvent = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "spec_post_commit_side_effect_failed" &&
        event.rawJson?.includes("\"sideEffect\":\"red_artifact_write\"")
      );
    assert.ok(postCommitEvent);
  });

  it("keeps runSpec ready when a Blue post-commit stage authority sync fails", async () => {
    seedChange(repoPath, "INTAKE_READY");

    const originalWriteFileSync = fs.writeFileSync;
    let restoreStageAuthorityDb: (() => void) | null = null;
    let injectedFailure = false;
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (!injectedFailure && typeof file === "string" && file.endsWith("spec-round-01-blue.json")) {
        injectedFailure = true;
        const brokenStageAuthorityDb = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop === "transaction") {
              return () => {
                restoreStageAuthorityDb?.();
                restoreStageAuthorityDb = null;
                throw new Error("sync stage authority failed after Blue commit");
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        restoreStageAuthorityDb = setStageAuthorityServiceDbForTest(brokenStageAuthorityDb as never);
      }
      return originalWriteFileSync(file, data, options);
    }) as typeof fs.writeFileSync;

    try {
      await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-blue-authority-failure"));
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      restoreStageAuthorityDb?.();
    }

    assert.equal(injectedFailure, true);
    assert.equal(currentStatus(), "SPEC_READY");
    assert.equal(currentChange().blockedPhase, null);

    const round = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get();
    assert.equal(round?.status, "report_ready");
    assert.match(round?.blueArtifactPath ?? "", /spec-round-01-blue\.json$/);

    const specReport = db.select().from(warReports).where(eq(warReports.changeId, CHANGE_ID)).all()
      .find((report) => report.type === "phase_report");
    assert.equal(specReport?.status, "generated");

    const postCommitEvent = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((event) =>
        event.type === "spec_post_commit_side_effect_failed" &&
        event.rawJson?.includes("\"sideEffect\":\"sync_spec_stage_authority\"")
      );
    assert.ok(postCommitEvent);
  });

  it("claims only one no-round spec battle start for concurrent different idempotency keys", async () => {
    seedChange(repoPath, "INTAKE_READY");
    let redProviderCalls = 0;
    const redResolvers: Array<() => void> = [];
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (input.prompt.includes("REQUIREMENT_CRITIC")) {
          return {
            threadId: `${input.changeId}-blue-thread`,
            runId: "ENGINE-BLUE",
            summary: blueCritiqueLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        redProviderCalls += 1;
        await new Promise<void>((resolve) => redResolvers.push(resolve));
        return {
          threadId: `${input.changeId}-red-thread`,
          runId: "ENGINE-RED",
          summary: redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    const firstContext = makeTestJobExecutionContext("spec-concurrent-a");
    const secondContext = firstContext;
    const first = runSpec(CHANGE_ID, firstContext, { idempotencyKey: "no-round-concurrent-a" });
    const second = runSpec(CHANGE_ID, secondContext, { idempotencyKey: "no-round-concurrent-b" });
    await waitForPipelineCondition(() => redProviderCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (const resolve of redResolvers) resolve();
    const results = await Promise.allSettled([first, second]);

    assert.equal(results.filter((result) => result.status === "rejected").length, 0);
    const rounds = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).all();
    const specRuns = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
      .filter((run) => run.phase === "spec");
    assert.equal(rounds.length, 1);
    assert.equal(specRuns.length, 1);
    assert.equal(redProviderCalls, 1);
  });

  it("runs PRD briefing stages through stage AI output ingestion", async () => {
    seedChange(repoPath, "INTAKE_PENDING");
    const contexts = [
      makeTestJobExecutionContext("prd-questions-lifecycle"),
      makeTestJobExecutionContext("prd-draft-lifecycle"),
      makeTestJobExecutionContext("prd-final-review-lifecycle"),
    ];
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "构建一个 PRD briefing room。" });
    const prompts: string[] = [];
    const outputModes: Array<unknown> = [];
    const outputSchemas: Array<unknown> = [];
    let providerRunIndex = 0;

    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        await emitProviderLifecycle(
          input.lifecycle,
          "completed",
          `prd-stage-${providerRunIndex + 1}`,
        );
        providerRunIndex += 1;
        prompts.push(input.prompt);
        outputModes.push(input.outputMode);
        outputSchemas.push(input.outputSchema);
        assert.equal(input.sandboxMode, "read-only");
        if (input.prompt.includes("最后一次 PRD 质询")) {
          return {
            threadId: `${input.changeId}-thread`,
            runId: "ENGINE-RUN",
            summary: finalReviewLineProtocolText({
              verdict: "ready",
              blockingQuestionIds: [],
              riskSummary: "可以进入 Spec Battle。",
              recommendedNextAction: "lock_prd",
            }),
            structuredOutput: undefined,
            success: true,
            changedFiles: [],
            items: [],
          };
        }
        if (input.prompt.includes("PRD 起草 Agent")) {
          return {
            threadId: `${input.changeId}-thread`,
            runId: "ENGINE-RUN",
            summary: prdDraftLineProtocolText("# PRD\n\n## 目标\n构建 PRD briefing room。"),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: briefingQuestionsLineProtocolText([
            {
              category: "goal",
              severity: "important",
              question: "成功标准是什么？",
              whyItMatters: "缺少成功标准会让 PRD 无法验收。",
              suggestedDefault: "以用户能锁定 PRD 为成功。",
            },
          ]),
          structuredOutput: undefined,
          success: true,
          changedFiles: [],
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runPrdBriefingQuestions(CHANGE_ID, contexts[0]);
    assertProviderLifecycle("intake", "completed", contexts[0]);
    await runPrdBriefingDraft(CHANGE_ID, contexts[1]);
    assertProviderLifecycle("intake", "completed", contexts[1]);
    await runPrdBriefingFinalReview(CHANGE_ID, contexts[2]);
    assertProviderLifecycle("intake", "completed", contexts[2]);

    assert.equal(currentStatus(), "INTAKE_PENDING");
    const state = getPrdBriefingState(CHANGE_ID);
    assert.equal(state.questions.length, 1);
    assert.equal(state.latestDraft?.markdown, "# PRD\n\n## 目标\n构建 PRD briefing room。");
    assert.equal(state.finalReview?.verdict, "ready");
    // All three sub-stages are line-protocol stages: the prompts teach the
    // protocol, and the engine is handed no schema (the JSON schemas stay
    // server-side as the second gate over the payload stagepass assembles).
    assert.match(prompts[0], /QUESTION: category \| severity \| question \| whyItMatters \| suggestedDefault/);
    assert.match(prompts[1], /MARKDOWN<</);
    assert.match(prompts[2], /VERDICT: ready 或 needs_answer 或 risky_but_allowed/);
    assert.ok(prompts.every((prompt) => prompt.includes(".ship/changes/CHG-T27/prd-intent.md")));
    assert.deepEqual(outputModes, ["json_schema", "markdown", "json_schema"]);
    assert.deepEqual(outputSchemas, [undefined, undefined, undefined]);
    assert.equal(latestStageProgress()?.status, "completed");
  });

  it("resumes a PRD briefing sub-step from BLOCKED intake by self-unblocking at run-start", async () => {
    // A change that was doing PRD briefing at INTAKE_PENDING and then got BLOCKED
    // (blockedPhase "intake") must be able to re-run a briefing sub-step. The stage
    // has to transition BLOCKED -> INTAKE_PENDING at run-start; otherwise the later
    // assertChangeNotBlocked check throws PipelineRunStoppedError mid-flight, exactly
    // as it did before the beginStageRun self-unblock landed.
    seedChange(repoPath, "INTAKE_PENDING");
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "构建一个 PRD briefing room。" });
    db.update(changes)
      .set({ status: "BLOCKED", blockedPhase: "intake" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    assert.equal(currentStatus(), "BLOCKED");
    assert.equal(currentChange().blockedPhase, "intake");

    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        await emitProviderLifecycle(input.lifecycle, "completed", "prd-questions-from-blocked");
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: briefingQuestionsLineProtocolText([
            {
              category: "goal",
              severity: "important",
              question: "成功标准是什么？",
              whyItMatters: "缺少成功标准会让 PRD 无法验收。",
              suggestedDefault: "以用户能锁定 PRD 为成功。",
            },
          ]),
          structuredOutput: undefined,
          success: true,
          changedFiles: [],
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    // Pre-fix this rejected with PipelineRunStoppedError ("intake stage stopped
    // because change is blocked") because the stage never left BLOCKED before the
    // post-AI assertChangeNotBlocked fired.
    await runPrdBriefingQuestions(
      CHANGE_ID,
      makeTestJobExecutionContext("prd-questions-from-blocked"),
    );

    assert.equal(currentStatus(), "INTAKE_PENDING");
    assert.equal(currentChange().blockedPhase, null);
    assert.equal(getPrdBriefingState(CHANGE_ID).questions.length, 1);
  });

  it("rejects duplicate PRD briefing AI jobs while an intake run is already running", async () => {
    seedChange(repoPath, "INTAKE_PENDING");
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "构建一个 PRD briefing room。" });
    db.insert(runs).values({
      id: "RUN-PRD-BRIEFING-RUNNING",
      changeId: CHANGE_ID,
      phase: "intake",
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      summary: null,
    }).run();

    await assert.rejects(() => runPrdBriefingQuestions(CHANGE_ID, makeTestJobExecutionContext("prd-questions-duplicate")), /already running/);
    await assert.rejects(() => runPrdBriefingDraft(CHANGE_ID, makeTestJobExecutionContext("prd-draft-duplicate")), /already running/);
    await assert.rejects(() => runPrdBriefingFinalReview(CHANGE_ID, makeTestJobExecutionContext("prd-final-review-duplicate")), /already running/);
  });

  it("passes the document-stage timeout to PRD briefing AI jobs", async () => {
    seedChange(repoPath, "INTAKE_PENDING");
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "构建一个 PRD briefing room。" });
    setDocumentStageTimeoutMsForTest(1234);
    let observedTimeoutMs: number | undefined;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        observedTimeoutMs = input.timeoutMs;
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: briefingQuestionsLineProtocolText([
            {
              category: "goal",
              severity: "important",
              question: "成功标准是什么？",
              whyItMatters: "缺少成功标准会让 PRD 无法验收。",
              suggestedDefault: null,
            },
          ]),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runPrdBriefingQuestions(CHANGE_ID, makeTestJobExecutionContext("prd-questions-timeout"));

    assert.equal(observedTimeoutMs, 1234);
  });

  it("rejects PRD briefing runners outside INTAKE_PENDING", async () => {
    seedChange(repoPath, "INTAKE_READY");

    await assert.rejects(() => runPrdBriefingQuestions(CHANGE_ID, makeTestJobExecutionContext("prd-questions-invalid-status")), /Invalid status/);
    await assert.rejects(() => runPrdBriefingDraft(CHANGE_ID, makeTestJobExecutionContext("prd-draft-invalid-status")), /Invalid status/);
    await assert.rejects(() => runPrdBriefingFinalReview(CHANGE_ID, makeTestJobExecutionContext("prd-final-review-invalid-status")), /Invalid status/);
  });

  it("lets PRD briefing runners start from a BLOCKED intake recovery without an invalid-status error", async () => {
    seedChange(repoPath, "BLOCKED");

    // The assertStatus gate (the only thing this edit changed) runs first and must
    // accept BLOCKED now. The run still stops later for a *different*,
    // non-invalid-status reason (assertChangeNotBlocked, since the briefing stage
    // never transitions out of BLOCKED itself) -- so we assert only that the
    // intake-status gate no longer rejects a BLOCKED recovery.
    for (const [runner, key] of [
      [runPrdBriefingQuestions, "prd-questions-from-blocked"],
      [runPrdBriefingDraft, "prd-draft-from-blocked"],
      [runPrdBriefingFinalReview, "prd-final-review-from-blocked"],
    ] as const) {
      let caught: unknown;
      try {
        await runner(CHANGE_ID, makeTestJobExecutionContext(key));
      } catch (error) {
        caught = error;
      }
      assert.ok(
        !(caught instanceof Error && /Invalid status/.test(caught.message)),
        `${key} should not fail the intake-status gate at BLOCKED (got: ${caught instanceof Error ? caught.message : String(caught)})`,
      );
    }
  });

  it("records invalid stage progress for malformed PRD briefing output", async () => {
    seedChange(repoPath, "INTAKE_PENDING");
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "构建一个 PRD briefing room。" });
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "not json",
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(() => runPrdBriefingQuestions(CHANGE_ID, makeTestJobExecutionContext("prd-questions-invalid-output")), /invalid_stage_output|file_candidate_invalid/);

    assert.equal(currentStatus(), "INTAKE_PENDING");
    const progress = latestStageProgress();
    assert.ok(progress);
    assert.equal(progress.schemaVersion, "stage_progress/v1");
    assert.equal(progress.phase, "prd_briefing_questions");
    assert.match(progress.status, /failed|invalid_output/);
    assert.equal(progress.source, "none");
    assert.match(progress.message ?? "", /invalid_stage_output|file_candidate_invalid/);
  });

  it("records current-run failed PRD briefing progress after historical invalid output", async () => {
    seedChange(repoPath, "INTAKE_PENDING");
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "构建一个 PRD briefing room。" });
    db.insert(runs).values({
      id: "RUN-PRD-HISTORICAL",
      changeId: CHANGE_ID,
      phase: "intake",
      status: "failed",
      startedAt: "2000-01-01T00:00:00.000Z",
      endedAt: "2000-01-01T00:00:01.000Z",
      summary: "historical invalid output",
    }).run();
    db.insert(events).values({
      id: "EVT-PRD-HISTORICAL-INVALID",
      changeId: CHANGE_ID,
      runId: "RUN-PRD-HISTORICAL",
      type: "stage_progress",
      message: "historical invalid output",
      rawJson: JSON.stringify({
        stageProgress: {
          schemaVersion: "stage_progress/v1",
          phase: "prd_briefing_questions",
          runId: "RUN-PRD-HISTORICAL",
          status: "invalid_output",
          source: "none",
          message: "historical invalid output",
        },
      }),
      createdAt: "2000-01-01T00:00:00.000Z",
    }).run();
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "provider crashed during retry",
          success: false,
          providerErrorCode: "provider_run_failed",
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(() => runPrdBriefingQuestions(CHANGE_ID, makeTestJobExecutionContext("prd-questions-provider-failure")), /provider_run_failed|provider crashed/);

    const progresses = stageProgressEvents();
    const latest = progresses.at(-1);
    assert.ok(latest);
    assert.equal(latest.phase, "prd_briefing_questions");
    assert.equal(latest.status, "failed");
    assert.notEqual(latest.runId, "RUN-PRD-HISTORICAL");
    assert.match(latest.message ?? "", /provider_run_failed|provider crashed/);
    assert.ok(progresses.some((progress) => (
      progress.runId === latest.runId && progress.status === "provider_running"
    )));
  });

  it("refuses to resurrect model-authored PRD briefing JSON when protocol lines are absent", async () => {
    // Mirrors the plan/test_plan/review resurrection guards: even a
    // schema-valid payload (declared or fenced in prose) must not settle a
    // briefing sub-step -- the line protocol is the only accepted source.
    seedChange(repoPath, "INTAKE_PENDING");
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "构建一个 PRD briefing room。" });
    const modelAuthored = {
      unit: "PRD_BLUE_INTERROGATOR",
      changeId: CHANGE_ID,
      phase: "PRD",
      questions: [
        {
          category: "goal",
          severity: "important",
          question: "成功标准是什么？",
          whyItMatters: "缺少成功标准会让 PRD 无法验收。",
          suggestedDefault: null,
        },
      ],
    };
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `没有协议行，但这里有一段 JSON：\n\`\`\`json\n${JSON.stringify(modelAuthored)}\n\`\`\``,
          success: true,
          changedFiles: [],
          structuredOutput: modelAuthored,
          structuredOutputSource: "provider_native",
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runPrdBriefingQuestions(CHANGE_ID, makeTestJobExecutionContext("prd-questions-json-resurrection")),
      /invalid_stage_output|line protocol|QUESTION/,
    );

    assert.equal(currentStatus(), "INTAKE_PENDING");
    assert.equal(getPrdBriefingState(CHANGE_ID).questions.length, 0);
  });

  it("refuses to resurrect a model-authored PRD draft markdown envelope without a MARKDOWN block", async () => {
    seedChange(repoPath, "INTAKE_PENDING");
    await seedPrdDraftPrerequisites();
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          // Prose markdown with no MARKDOWN<< block: before the protocol this
          // whole summary was silently adopted as the draft body.
          summary: "# PRD\n\n## 目标\n随手写的正文，没有用协议块。",
          success: true,
          changedFiles: [],
          structuredOutput: { markdown: "# PRD\n\n## 目标\n模型手写的 JSON 信封。" },
          structuredOutputSource: "provider_native",
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runPrdBriefingDraft(CHANGE_ID, makeTestJobExecutionContext("prd-draft-json-resurrection")),
      /invalid_stage_output|line protocol|MARKDOWN/,
    );

    assert.equal(getPrdBriefingState(CHANGE_ID).latestDraft, null);
  });

  it("rejects a final-review candidate file whose blocking id names no real question", async () => {
    // Defense in depth for the provider-failure recovery path, which reads a
    // candidate file straight into the schema and skips the parser (where the
    // known-id cross-check lives). A phantom blocking id is a permanent blocker,
    // so validateBusiness must catch it on this path too -- not just on success.
    seedChange(repoPath, "INTAKE_PENDING");
    await seedPrdDraftPrerequisites();
    await completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD\n\n## 目标\nready draft." });
    const realIds = getPrdBriefingState(CHANGE_ID).questions.map((question) => question.id);
    assert.ok(realIds.length > 0);

    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        const reviewPath = path.join(
          input.repoPath, ".ship", "changes", input.changeId, "prd-final-review.json",
        );
        fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
        fs.writeFileSync(reviewPath, JSON.stringify({
          unit: "PRD_BLUE_INTERROGATOR",
          verdict: "needs_answer",
          blockingQuestionIds: ["BQ-phantom-does-not-exist"],
          riskSummary: "phantom blocker smuggled in via candidate file",
          recommendedNextAction: "answer_questions",
        }));
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "provider failed after writing candidate",
          success: false,
          providerErrorCode: "provider_run_failed",
          changedFiles: [`.ship/changes/${input.changeId}/prd-final-review.json`],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runPrdBriefingFinalReview(CHANGE_ID, makeTestJobExecutionContext("prd-final-review-phantom")),
      /provider_run_failed|unknown question id|invalid_stage_output/,
    );

    const state = getPrdBriefingState(CHANGE_ID);
    assert.equal(state.finalReview, null, "the phantom-id review must not settle");
    assert.deepEqual(realIds, getPrdBriefingState(CHANGE_ID).questions.map((q) => q.id));
  });

  it("refuses to adopt the stale PRD draft mirror when the provider run fails", async () => {
    // The production shape the old candidate-file recovery contract could never
    // actually see: sandboxMode is "read-only", so the provider cannot write
    // prd-draft.md. The only file living at that path is stagepass's OWN DB
    // mirror, left by refreshPrdBriefingMirrors -- and the answer recorded below
    // moves the input hash past it, making it stale. Adopting it would launder a
    // draft that never saw the new answer.
    seedChange(repoPath, "INTAKE_PENDING");
    await seedPrdDraftPrerequisites();
    await completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD\n\n## 目标\ndraft at input A." });
    const [question] = getPrdBriefingState(CHANGE_ID).questions;
    assert.ok(question);
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId: question.id,
      action: "answer",
      value: "草稿必须覆盖这个新答案。",
    });

    const stale = getPrdBriefingState(CHANGE_ID);
    assert.equal(stale.gate.draftFresh, false, "draft must be stale before the failed run");
    const mirrorPath = path.join(repoPath, ".ship", "changes", CHANGE_ID, "prd-draft.md");
    assert.ok(fs.existsSync(mirrorPath), "the stale mirror must be on disk for this test to mean anything");

    setPipelineEngineFactoryForTest(() => ({
      // Writes nothing: a read-only sandbox forbids it.
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "provider timed out",
          success: false,
          providerErrorCode: "provider_timeout",
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runPrdBriefingDraft(CHANGE_ID, makeTestJobExecutionContext("prd-draft-stale-mirror")),
      /provider_timeout|provider_run_failed|invalid_stage_output/,
    );

    const after = getPrdBriefingState(CHANGE_ID);
    assert.equal(after.latestDraft?.markdown, "# PRD\n\n## 目标\ndraft at input A.");
    assert.equal(after.latestDraft?.version, stale.latestDraft?.version, "no new draft version may be minted");
    const progress = latestStageProgress();
    assert.ok(progress);
    assert.equal(progress.phase, "prd_briefing_draft");
    assert.notEqual(progress.status, "completed");
    assert.notEqual(progress.source, "file_candidate");
  });

  it("does not re-stamp draftInputHash when a failed run finds the stale draft mirror", async () => {
    // completePrdDraft stamps draftInputHash, so adopting the mirror would
    // re-stamp it against the NEW inputs and silently clear the "PRD draft is
    // stale" blocker -- the PRD would advance on content that predates the answer.
    seedChange(repoPath, "INTAKE_PENDING");
    await seedPrdDraftPrerequisites();
    await completePrdDraft({ changeId: CHANGE_ID, markdown: "# PRD\n\n## 目标\ndraft at input A." });
    const [question] = getPrdBriefingState(CHANGE_ID).questions;
    assert.ok(question);
    await applyBriefingQuestionAction({
      changeId: CHANGE_ID,
      questionId: question.id,
      action: "answer",
      value: "新的答案让草稿过期。",
    });
    assert.equal(getPrdBriefingState(CHANGE_ID).gate.draftFresh, false);

    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "provider failed",
          success: false,
          providerErrorCode: "provider_run_failed",
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    // Deliberately NOT assert.rejects: the guarantee under test is the hash, not
    // the throw. Swallowing the failure keeps this test failing for its own
    // distinct reason (a re-stamped draftInputHash) rather than dying at the
    // same assertion as the test above.
    await runPrdBriefingDraft(CHANGE_ID, makeTestJobExecutionContext("prd-draft-hash-restamp"))
      .catch(() => undefined);

    assert.equal(
      getPrdBriefingState(CHANGE_ID).gate.draftFresh,
      false,
      "a failed run must not re-stamp draftInputHash and clear the staleness blocker",
    );
    // ...and the user-visible blocker on the PRD stage gate must survive it too.
    const prdGate = db
      .select()
      .from(stageGates)
      .where(eq(stageGates.changeId, CHANGE_ID))
      .all()
      .filter((gate) => gate.phase === "PRD")
      .at(-1);
    const blockerTitles = (
      JSON.parse(prdGate?.blockersJson ?? "[]") as Array<{ title?: string }>
    ).map((blocker) => blocker.title ?? "");
    assert.ok(
      blockerTitles.some((title) => /stale/i.test(title)),
      `the "PRD draft is stale" blocker must survive the failed run, got ${JSON.stringify(blockerTitles)}`,
    );
  });

  it("records PRD briefing async failure progress after a newer provider-running event", async () => {
    seedChange(repoPath, "INTAKE_PENDING");
    await savePrdIntent({ changeId: CHANGE_ID, rawText: "构建一个 PRD briefing room。" });
    db.insert(runs).values([
      {
        id: "RUN-PRD-HISTORICAL-ASYNC",
        changeId: CHANGE_ID,
        phase: "intake",
        status: "failed",
        startedAt: "2000-01-01T00:00:00.000Z",
        endedAt: "2000-01-01T00:00:01.000Z",
        summary: "historical invalid output",
      },
      {
        id: "RUN-PRD-ASYNC-NEW",
        changeId: CHANGE_ID,
        phase: "intake",
        status: "running",
        startedAt: "2000-01-01T00:01:00.000Z",
        endedAt: null,
        summary: null,
      },
    ]).run();
    db.insert(events).values([
      {
        id: "EVT-PRD-HISTORICAL-ASYNC",
        changeId: CHANGE_ID,
        runId: "RUN-PRD-HISTORICAL-ASYNC",
        type: "stage_progress",
        message: "historical invalid output",
        rawJson: JSON.stringify({
          stageProgress: {
            schemaVersion: "stage_progress/v1",
            phase: "prd_briefing_questions",
            runId: "RUN-PRD-HISTORICAL-ASYNC",
            status: "invalid_output",
            source: "none",
            message: "historical invalid output",
          },
        }),
        createdAt: "2000-01-01T00:00:00.000Z",
      },
      {
        id: "EVT-PRD-ASYNC-PROVIDER-RUNNING",
        changeId: CHANGE_ID,
        runId: "RUN-PRD-ASYNC-NEW",
        type: "stage_progress",
        message: "provider running",
        rawJson: JSON.stringify({
          stageProgress: {
            schemaVersion: "stage_progress/v1",
            phase: "prd_briefing_questions",
            runId: "RUN-PRD-ASYNC-NEW",
            status: "provider_running",
            source: "none",
            message: "provider running",
          },
        }),
        createdAt: "2000-01-01T00:01:00.000Z",
      },
    ]).run();

    await emitPrdBriefingAsyncFailureProgress({
      changeId: CHANGE_ID,
      phase: "prd_briefing_questions",
      message: "route catch exploded",
    });

    const progress = latestStageProgress();
    assert.ok(progress);
    assert.equal(progress.runId, "RUN-PRD-ASYNC-NEW");
    assert.equal(progress.status, "failed");
    assert.match(progress.message ?? "", /route catch exploded/);
  });

  it("resumes an existing running spec battle round instead of leaving it stuck", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const started = await startSpecBattleRound(CHANGE_ID);

    await runSpec(
      CHANGE_ID,
      makeTestJobExecutionContext("spec-resume-existing-round"),
      { idempotencyKey: "start-existing-not-started" },
    );

    assert.equal(currentStatus(), "SPEC_READY");
    const rounds = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).all();
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].id, started.roundId);
    assert.equal(rounds[0].status, "report_ready");
    assert.equal(artifactExists(repoPath, path.join("rounds", "spec-round-01-red.md")), true);
    assert.equal(artifactExists(repoPath, path.join("rounds", "spec-round-01-blue.json")), true);
  });

  it("claims a not_started spec battle round only after creating a run ledger row", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const started = await startSpecBattleRound(CHANGE_ID);
    let observedStatusDuringProvider = "";
    let observedSpecRunCountDuringProvider = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (!input.prompt.includes("REQUIREMENT_CRITIC")) {
          const round = db.select().from(battleRounds).where(eq(battleRounds.id, started.roundId)).get();
          observedStatusDuringProvider = round?.status ?? "";
          observedSpecRunCountDuringProvider = db.select().from(runs).where(eq(runs.changeId, CHANGE_ID)).all()
            .filter((run) => run.phase === "spec").length;
        }
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: input.prompt.includes("REQUIREMENT_CRITIC")
            ? blueCritiqueLineProtocolText()
            : redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runSpec(
      CHANGE_ID,
      makeTestJobExecutionContext("spec-claim-not-started-round"),
      { idempotencyKey: "claim-not-started-ledger" },
    );

    assert.equal(observedStatusDuringProvider, "red_running");
    assert.equal(observedSpecRunCountDuringProvider, 1);
  });

  it("does not start another red provider when the latest spec round is already red_running", async () => {
    seedChange(repoPath, "SPECCING");
    const now = new Date().toISOString();
    db.insert(battleRounds).values({
      id: "BRD-T27-ALREADY-RED",
      changeId: CHANGE_ID,
      phase: "Spec",
      template: "SPEC_BATTLE_MVP",
      roundNo: 1,
      status: "red_running",
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
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    let providerCalls = 0;
    setPipelineEngineFactoryForTest(() => ({
      async run() {
        providerCalls += 1;
        throw new Error("provider should not start for red_running");
      },
      async *runStreamed() {},
    }));

    const result = await runSpec(
      CHANGE_ID,
      makeTestJobExecutionContext("spec-red-running-replay"),
      { idempotencyKey: "red-running-replay" },
    );

    assert.equal(result.success, true);
    assert.equal(result.summary, "spec_round_running");
    assert.equal(providerCalls, 0);
  });

  it("retries a failed spec battle round without creating an extra round", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const started = await startSpecBattleRound(CHANGE_ID);
    db.update(battleRounds)
      .set({ status: "failed", endedAt: new Date().toISOString() })
      .where(eq(battleRounds.id, started.roundId))
      .run();
    db.update(changes)
      .set({ status: "BLOCKED", blockedPhase: "spec" })
      .where(eq(changes.id, CHANGE_ID))
      .run();

    await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-failed-round-retry", { attemptNo: 2 }));

    assert.equal(currentStatus(), "SPEC_READY");
    const rounds = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).all();
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].id, started.roundId);
    assert.equal(rounds[0].roundNo, 1);
    assert.equal(rounds[0].status, "report_ready");
    assert.equal(artifactExists(repoPath, path.join("rounds", "spec-round-01-red.md")), true);
    assert.equal(artifactExists(repoPath, path.join("rounds", "spec-round-01-blue.json")), true);
  });

  it("marks the stale report before retrying a failed spec battle round", async () => {
    seedChange(repoPath, "INTAKE_READY");
    const firstAttemptContext = makeTestJobExecutionContext("spec-stale-report", {
      jobId: "PJOB-T27-spec-stale-report",
      attemptNo: 1,
    });
    await runSpec(CHANGE_ID, firstAttemptContext);
    const reportBeforeRetry = getSpecReportFreshness(CHANGE_ID);
    assert.equal(reportBeforeRetry.reportFresh, true);

    const round = db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get();
    assert.ok(round);
    db.update(battleRounds)
      .set({ status: "failed", endedAt: new Date().toISOString() })
      .where(eq(battleRounds.id, round.id))
      .run();
    db.update(changes)
      .set({ status: "BLOCKED", blockedPhase: "spec" })
      .where(eq(changes.id, CHANGE_ID))
      .run();

    const observedFreshnessDuringRetry: ReturnType<typeof getSpecReportFreshness>[] = [];
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        if (!input.prompt.includes("REQUIREMENT_CRITIC")) {
          observedFreshnessDuringRetry.push(getSpecReportFreshness(CHANGE_ID));
        }
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: input.prompt.includes("REQUIREMENT_CRITIC")
            ? blueCritiqueLineProtocolText()
            : redSpecLineProtocolText(),
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    const retryContext: JobExecutionContext = {
      jobId: firstAttemptContext.jobId,
      workerId: "pipeline-worker-t27-spec-stale-report-retry",
      leaseToken: "lease-token-t27-spec-stale-report-attempt-2",
      attemptNo: 2,
    };
    db.update(pipelineJobs).set({
      leasedBy: retryContext.workerId,
      leaseToken: retryContext.leaseToken,
      attemptNo: retryContext.attemptNo,
    }).where(eq(pipelineJobs.id, firstAttemptContext.jobId)).run();
    await runSpec(CHANGE_ID, retryContext);

    assert.equal(observedFreshnessDuringRetry[0]?.reportFresh, false);
    assert.equal(observedFreshnessDuringRetry[0]?.staleReason, "report_stale");
  });

  it("rejects tech-spec until Spec Battle gate is approved", async () => {
    seedChange(repoPath, "INTAKE_READY");
    await runSpec(CHANGE_ID, makeTestJobExecutionContext("spec-gate-first-attempt"));

    await assert.rejects(
      () => runTechSpec(CHANGE_ID, makeTestJobExecutionContext("tech-spec-before-spec-approval")),
      /Spec gate is not approved/,
    );
  });

  it("appends retro debt items to baseline backlog", async () => {
    seedChange(repoPath, "RETRO_PENDING");
    seedRetroReleaseAuthority(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `# Retro

## 技术债务
- 补齐 Retro 回流验收
- 沉淀 merge gate 失败恢复策略
`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runRetro(CHANGE_ID, makeTestJobExecutionContext("retro-baseline-backlog"));

    const backlogPath = path.join(repoPath, ".ship", "baseline", "backlog.md");
    const backlog = fs.readFileSync(backlogPath, "utf-8");
    assert.match(backlog, /CHG-T27/);
    assert.match(backlog, /补齐 Retro 回流验收/);
    assert.match(backlog, /沉淀 merge gate 失败恢复策略/);
  });

  it("runs Retro in a fresh thread instead of resuming the long change thread", async () => {
    seedChange(repoPath, "RETRO_PENDING");
    seedRetroReleaseAuthority(repoPath);
    db.update(changes)
      .set({ codexThreadId: "long-build-review-fix-thread" })
      .where(eq(changes.id, CHANGE_ID))
      .run();

    let observedThreadId: string | undefined | null = "not-called";
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        observedThreadId = input.threadId;
        return {
          threadId: `${input.changeId}-retro-thread`,
          runId: "ENGINE-RUN",
          summary: "# Retro\n\n## 技术债务\n- 复盘上下文保持精简\n",
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runRetro(CHANGE_ID, makeTestJobExecutionContext("retro-fresh-thread"));

    assert.equal(observedThreadId, undefined);
  });

  // A provider killed mid-flight returns success:true with an empty summary
  // (macOS sleep -> supervisor SIGTERM -> codex emits reasoning items but no
  // agent_message). Every other document stage catches that shape on its
  // outputSchema; Retro is the one with a rubric and no schema, so nothing
  // inspects the reply at all. The rubric harvest is skipped -- deliberately,
  // because blaming a model that never spoke is false provenance -- the whole
  // ingest/validate block is gated on outputSchema, and no guard stands between
  // an empty summary and the artifact write. The change reached DONE carrying an
  // empty retro.md with zero of its six criteria judged.
  //
  // The runner has to be the one to refuse it: `applyLineProtocol` documents
  // that callers already handle the empty case, and that contract is only
  // honoured by callers who set an outputSchema. Nothing enforces the pairing.
  it("refuses an empty reply instead of finishing the stage on silence", async () => {
    seedChange(repoPath, "RETRO_PENDING");
    seedRetroReleaseAuthority(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "",
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await assert.rejects(
      () => runRetro(CHANGE_ID, makeTestJobExecutionContext("retro-empty-reply")),
      /empty|空/i,
    );
    assert.notEqual(currentStatus(), "DONE");
    assert.equal(artifactExists(repoPath, "retro.md"), false);
  });

  it("appends release notes to baseline changelog", async () => {
    seedChange(repoPath, "MERGE_READY");
    seedReleaseReadyFacts(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `# Release Note

## 用户可见变化
- 发布 T4.1 changelog 自动化
`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runRelease(CHANGE_ID, makeTestJobExecutionContext("release-baseline-changelog"));

    const changelogPath = path.join(repoPath, ".ship", "baseline", "changelog.md");
    const changelog = fs.readFileSync(changelogPath, "utf-8");
    assert.match(changelog, /CHG-T27/);
    assert.match(changelog, /发布 T4\.1 changelog 自动化/);
  });

  it("writes the generated release note content during release", async () => {
    seedChange(repoPath, "MERGE_READY");
    seedReleaseReadyFacts(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `# Release Note

## 用户可见变化
- 生成人工门闭环发布说明

## 已知风险
- 仍需人工确认 rollout 窗口
`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runRelease(CHANGE_ID, makeTestJobExecutionContext("release-generated-content"));

    const releaseNotePath = path.join(repoPath, ".ship", "changes", CHANGE_ID, "release-note.md");
    const releaseNote = fs.readFileSync(releaseNotePath, "utf-8");
    assert.match(releaseNote, /生成人工门闭环发布说明/);
    assert.match(releaseNote, /仍需人工确认 rollout 窗口/);
  });

  it("applies an approved Build patch during release", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    initGitRepoWithApp(repoPath);
    ignoreShipArtifacts(repoPath);
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-release-thread`,
          runId: "ENGINE-RELEASE",
          summary: "# Release Note\n\n## 用户可见变化\n- Build patch merged\n",
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-build-thread` } as unknown as AiStreamEvent;
      },
    }));

    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("build-before-release"));
    await approveBuildAbsorb(CHANGE_ID);
    assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 2;\n");
    db.update(changes).set({ status: "MERGE_READY" }).where(eq(changes.id, CHANGE_ID)).run();
    seedReleaseReadyFacts(repoPath);

    await runRelease(CHANGE_ID, makeTestJobExecutionContext("release-approved-build-patch"));

    assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 2;\n");
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "adopted");
  });

  it("merges the adopted BuildRun when newer failed fix runs shadow it on disk", async () => {
    seedChange(repoPath, "MERGE_READY");
    seedReleaseReadyFacts(repoPath);
    // The merge gate reads build_run_records filtered to approved/adopted, so it
    // resolves build-1. Release read the filesystem newest-first and resolved
    // build-3 instead: the gate promised an action the worker then refused.
    writeShadowingFailedFixRun(repoPath, 2);
    writeShadowingFailedFixRun(repoPath, 3);
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "failed");

    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "# Release Note\n\n## 用户可见变化\n- 合并被失败 fix run 遮蔽的已采纳构建\n",
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runRelease(CHANGE_ID, makeTestJobExecutionContext("release-shadowed-adopted-build"));

    assert.equal(currentChange().status, "RETRO_PENDING");
    assert.equal(readBuildRunFile(repoPath, 1).status, "adopted");
    assert.equal(readBuildRunFile(repoPath, 3).status, "failed");
  });

  it("clears the dirty-worktree Merge blocker when a failed fix run shadows the adopted build", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "done",
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-build-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);

    // A repo that does not gitignore .ship/ -- the live E2E shape. stagepass keeps
    // writing its own artifacts after adoption, so `git status --porcelain` is
    // never empty and merge readiness always takes the dirty-worktree branch.
    fs.mkdirSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "reports"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "reports", "qa-log.md"), "passed\n");
    assert.equal(hasUncommittedChanges(repoPath), true);
    const adopted = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.ok(adopted);
    assert.equal(adopted.runNumber, 1);

    // The escape hatch that keeps a legitimately dirty worktree mergeable holds
    // while build-1 is the newest run on disk...
    assert.equal(
      computeMergeReadiness({ changeId: CHANGE_ID, requireApproval: false, persist: false })
        .blockers.some((item) => item.reasonCode === "git_worktree_dirty"),
      false,
    );

    // ...and a failed fix attempt must not take it away. The merge gate resolves
    // build-1 from build_run_records, which it filters to approved/adopted; the
    // filesystem side re-resolved build-2 and raised a P1 that blocks a merge the
    // adopted workspace fully supports.
    writeShadowingBuildRun(repoPath, adopted, 2, "failed");
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "failed");
    assert.deepEqual(
      db.select().from(buildRunRecords).where(eq(buildRunRecords.changeId, CHANGE_ID)).all()
        .filter((record) => record.status === "adopted" || record.status === "approved_for_absorb")
        .map((record) => record.buildRunId),
      ["build-1"],
    );

    const readiness = computeMergeReadiness({
      changeId: CHANGE_ID, requireApproval: false, persist: false,
    });

    assert.equal(
      readiness.blockers.some((item) => item.reasonCode === "git_worktree_dirty"),
      false,
      `dirty-worktree blocker survived a failed fix run: ${JSON.stringify(readiness.blockers)}`,
    );
  });

  it("keeps the dirty-worktree Merge blocker when the worktree carries changes outside the adopted patch", async () => {
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: "done",
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-build-thread` } as unknown as AiStreamEvent;
      },
    }));
    await prepareAdoptedBuild(repoPath);
    const adopted = readLatestBuildRun(repoPath, CHANGE_ID);
    assert.ok(adopted);
    writeShadowingBuildRun(repoPath, adopted, 2, "failed");

    // Pinning the assert to the DB-approved run must not turn it into a rubber
    // stamp. This file is outside the adopted patch and outside the ignored .ship
    // prefixes, so the worktree is genuinely untrustworthy and merge must stop.
    fs.writeFileSync(path.join(repoPath, "src", "rogue.ts"), "export const rogue = true;\n");
    assert.equal(hasUncommittedChanges(repoPath), true);

    const readiness = computeMergeReadiness({
      changeId: CHANGE_ID, requireApproval: false, persist: false,
    });

    assert.equal(
      readiness.blockers.some((item) => item.reasonCode === "git_worktree_dirty"),
      true,
      `untrusted dirty worktree lost its blocker: ${JSON.stringify(readiness.blockers)}`,
    );
  });

  it("refuses to absorb an approved BuildRun shadowed by a newer unapproved run", async () => {
    seedChange(repoPath, "MERGE_READY");
    initGitRepoWithApp(repoPath);
    ignoreShipArtifacts(repoPath);
    const headSha = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();
    writeApprovedForAbsorbBuildRun(repoPath, headSha);
    seedReleaseReadyFacts(repoPath);
    writeShadowingFailedFixRun(repoPath, 2);

    // absorbBuildPatch/adoptFixPatch re-resolve the workspace themselves via the
    // unfiltered newest-by-number reader, so release must not hand them an absorb
    // it decided against a different run. Fail loudly, naming both runs.
    await assert.rejects(
      () => runRelease(CHANGE_ID, makeTestJobExecutionContext("release-shadowed-approved-build")),
      (error: Error) => {
        assert.match(error.message, /build-1/);
        assert.match(error.message, /build-2/);
        return true;
      },
    );

    assert.equal(readBuildRunFile(repoPath, 1).status, "approved_for_absorb");
    assert.equal(currentChange().status, "MERGE_READY");
  });

  it("keeps the adopted Build patch when Merge readiness is not reached", async () => {
    seedChange(repoPath, "PLAN_APPROVED");
    writePlanArtifacts(repoPath, {
      ...validStructuredPlan(),
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });
    initGitRepoWithApp(repoPath);
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-build-thread` } as unknown as AiStreamEvent;
      },
    }));

    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("build-before-merge-ready"));
    await approveBuildAbsorb(CHANGE_ID);

    await assert.rejects(
      () => runRelease(CHANGE_ID, makeTestJobExecutionContext("release-before-merge-ready")),
      /Invalid status: IMPLEMENTED/,
    );

    assert.equal(fs.readFileSync(path.join(repoPath, "src", "app.ts"), "utf-8"), "export const value = 2;\n");
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "adopted");
  });

  it("runs the complete plan-approved pipeline from intake to done", async () => {
    seedChange(repoPath, "INTAKE_PENDING");
    initGitRepoWithApp(repoPath);
    fs.writeFileSync(path.join(repoPath, ".gitignore"), ".ship/\n");
    execSync("git add .gitignore", { cwd: repoPath });
    execSync("git commit -m ignore-ship-artifacts", { cwd: repoPath, stdio: "ignore" });
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        const isReview = input.prompt.includes("independent code reviewer");
        if (input.prompt.includes("REQUIREMENT_CRITIC")) {
          return {
            threadId: `${input.changeId}-thread`,
            runId: "ENGINE-RUN",
            summary: blueCritiqueLineProtocolText(),
            success: true,
            changedFiles: [],
            structuredOutput: undefined,
            items: [],
          };
        }
        const isDesignSnapshotPrompt =
          input.prompt.includes("当前阶段是 tech_spec") ||
          input.prompt.includes("DB snapshot 候选");
        const isTestPlanPrompt =
          input.prompt.includes("当前阶段是 test_plan") ||
          input.prompt.includes("coverageItems");
        const isPlanPrompt = input.prompt.includes("当前阶段是 generate_plan");
        // Red is the Spec battle's producer and the only one of the three Spec
        // agents on the red line protocol: blue (spec_critic) already returned
        // above, and the verdict (spec_verdict) is rubric-only. Keyed on the
        // engine phase, which is the stage identity itself.
        const isSpecRed = input.phase === "spec";
        const isDelivery = input.phase === "delivery";
        return {
          threadId: `${input.changeId}-thread`,
          runId: "ENGINE-RUN",
          summary: isDelivery
            ? validDeliveryLineProtocolText()
            : isDesignSnapshotPrompt
            ? validTechSpecLineProtocolText()
            : isTestPlanPrompt
            ? validTestPlanLineProtocolText()
            : isPlanPrompt
            ? planLineProtocolText(validStructuredPlan({
              expectedFiles: ["src/app.ts"],
              forbiddenFiles: [],
              implementationSteps: [
                {
                  step: 1,
                  description: "Update the app value.",
                  file: "src/app.ts",
                  status: "pending",
                },
              ],
            }))
            : isReview
            ? reviewLineProtocolText()
            : isSpecRed
            ? redSpecLineProtocolText()
            : `summary for ${input.changeId}`,
          success: true,
          changedFiles: [],
          // tech_spec is on the line protocol: the payload comes from the
          // protocol lines in `summary`, never from model-authored JSON.
          structuredOutput: undefined,
          items: [],
        };
      },
      async *runStreamed(input) {
        fs.writeFileSync(path.join(input.repoPath, "src", "app.ts"), "export const value = 2;\n");
        yield { type: "thread.started", threadId: `${input.changeId}-thread` } as unknown as AiStreamEvent;
      },
    }));

    await runIntake(CHANGE_ID, makeTestJobExecutionContext("complete-pipeline-intake"));
    assert.equal(currentStatus(), "INTAKE_READY");
    seedApprovalStageGate("intake");
    await approveGateWithContract("intake");
    seedLockedPrdAuthority(repoPath);

    await runSpec(CHANGE_ID, makeTestJobExecutionContext("complete-pipeline-spec"));
    assert.equal(currentStatus(), "SPEC_READY");
    seedApprovalStageGate("spec");
    await approveGateWithContract("spec");
    seedApprovalStageGate("spec");

    await runTechSpec(CHANGE_ID, makeTestJobExecutionContext("complete-pipeline-tech-spec"));
    assert.equal(currentStatus(), "TECHSPEC_READY");
    seedApprovalStageGate("tech_spec");
    await approveGateWithContract("tech_spec");

    await generatePlan(CHANGE_ID, makeTestJobExecutionContext("complete-pipeline-plan"));
    assert.equal(currentStatus(), "PLAN_READY");

    await approvePlan(CHANGE_ID, PLAN_APPROVAL_CONTEXT);
    assert.equal(currentStatus(), "PLAN_APPROVED");

    await runTestPlan(CHANGE_ID, makeTestJobExecutionContext("complete-pipeline-test-plan"));
    assert.equal(currentStatus(), "TESTPLAN_DONE");

    await approvePlan(CHANGE_ID, PLAN_APPROVAL_CONTEXT);
    assert.equal(currentStatus(), "PLAN_APPROVED");

    await runImplementStreamed(CHANGE_ID, makeTestJobExecutionContext("complete-pipeline-build"));
    assert.equal(currentStatus(), "IMPLEMENTING");

    await approveBuildAbsorb(CHANGE_ID);
    assert.equal(currentStatus(), "IMPLEMENTED");

    await runReview(CHANGE_ID, makeTestJobExecutionContext("review-direct"));
    assert.equal(currentStatus(), "IMPLEMENTED");

    const realTestPlanEnterQa = getActions(CHANGE_ID)
      .find((action) => action.actionId === "enter_qa")!;
    const realTestPlanQaJob = enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "local_check", actionId: "enter_qa",
      idempotencyKey: "complete-pipeline-enter-qa-authority",
    }, realTestPlanEnterQa);
    assert.equal(realTestPlanQaJob.created, true);
    db.update(pipelineJobs).set({ status: "succeeded", endedAt: new Date().toISOString() })
      .where(eq(pipelineJobs.id, realTestPlanQaJob.job.id)).run();

    await runCheck(CHANGE_ID, makeTestJobExecutionContext("complete-pipeline-qa"));
    assert.equal(currentStatus(), "MERGE_READY");

    seedMergePrerequisiteStageGates();
    seedApprovalStageGate("merge");
    await approveGateWithContract("merge");
    const mergeContract = getActions(CHANGE_ID).find((action) => action.actionId === "merge")!;
    assert.equal(mergeContract.enabled, true, JSON.stringify(mergeContract));
    const mergeJob = enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "release", actionId: "merge",
      idempotencyKey: "complete-pipeline-merge-authority",
    }, mergeContract);
    assert.equal(mergeJob.created, true);
    db.update(pipelineJobs).set({ status: "succeeded", endedAt: new Date().toISOString() })
      .where(eq(pipelineJobs.id, mergeJob.job.id)).run();
    const assertMergeDrift = (idempotencyKey: string) => {
      assert.throws(() => enqueueProviderActionAtomically({
        changeId: CHANGE_ID, phase: "release", actionId: "merge", idempotencyKey,
      }, mergeContract), ActionContractDriftError);
      assert.equal(db.select().from(pipelineJobs).where(and(
        eq(pipelineJobs.changeId, CHANGE_ID), eq(pipelineJobs.idempotencyKey, idempotencyKey),
      )).all().length, 0);
    };
    const mergeGates = db.select().from(stageGates).where(and(
      eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Merge"),
    )).all();
    db.update(stageGates).set({ sourceDbHash: "stale-merge-readiness-hash" })
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Merge"))).run();
    assertMergeDrift("merge-stale-passing-gate");
    for (const gate of mergeGates) {
      db.update(stageGates).set({ sourceDbHash: gate.sourceDbHash })
        .where(eq(stageGates.id, gate.id)).run();
    }
    for (const phase of ["Build", "Review"] as const) {
      const removedGates = db.select().from(stageGates).where(and(
        eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, phase),
      )).all();
      db.delete(stageGates).where(and(
        eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, phase),
      )).run();
      const readOnlySnapshot = () => JSON.stringify({
        stageGates: db.select().from(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).all(),
        mergeReadiness: db.select().from(mergeReadiness)
          .where(eq(mergeReadiness.changeId, CHANGE_ID)).all(),
        stageActions: db.select().from(stageActions).where(eq(stageActions.changeId, CHANGE_ID)).all(),
      });
      const beforeReadOnlyEvaluation = readOnlySnapshot();
      assert.equal(evaluateProviderActionAuthority(db, {
        changeId: CHANGE_ID, phase: "release", actionId: "merge",
      }).enabled, false);
      assertMergeDrift(`merge-missing-${phase.toLowerCase()}-gate`);
      assert.equal(readOnlySnapshot(), beforeReadOnlyEvaluation);
      for (const gate of removedGates) db.insert(stageGates).values(gate).run();
    }
    const approval = db.select().from(mergeApprovals).where(eq(mergeApprovals.changeId, CHANGE_ID)).get()!;
    db.delete(mergeApprovals).where(eq(mergeApprovals.id, approval.id)).run();
    assertMergeDrift("merge-approval-drift");
    db.insert(mergeApprovals).values(approval).run();
    const qaRecord = db.select().from(qaRuns).where(eq(qaRuns.changeId, CHANGE_ID)).get()!;
    db.update(qaRuns).set({ status: "failed" }).where(eq(qaRuns.id, qaRecord.id)).run();
    assertMergeDrift("merge-qa-drift");
    db.update(qaRuns).set({ status: qaRecord.status }).where(eq(qaRuns.id, qaRecord.id)).run();
    const mergeBuild = db.select().from(buildRunRecords).where(eq(buildRunRecords.changeId, CHANGE_ID)).get()!;
    db.update(buildRunRecords).set({ status: "approved_for_absorb" })
      .where(eq(buildRunRecords.id, mergeBuild.id)).run();
    assertMergeDrift("merge-build-drift");
    db.update(buildRunRecords).set({ status: mergeBuild.status })
      .where(eq(buildRunRecords.id, mergeBuild.id)).run();
    db.insert(buildRunRecords).values({
      ...mergeBuild,
      id: `${mergeBuild.id}-AMBIGUOUS`,
      adoptedAt: "2099-01-01T00:00:00.000Z",
      updatedAt: "2099-01-01T00:00:00.000Z",
    }).run();
    assertMergeDrift("merge-build-ambiguity");
    db.delete(buildRunRecords).where(eq(buildRunRecords.id, `${mergeBuild.id}-AMBIGUOUS`)).run();
    fs.writeFileSync(path.join(repoPath, "src", "app.ts"), "export const value = 3;\n");
    assertMergeDrift("merge-workspace-drift");
    fs.writeFileSync(path.join(repoPath, "src", "app.ts"), "export const value = 2;\n");
    await runRelease(CHANGE_ID, makeTestJobExecutionContext("complete-pipeline-release"));
    assert.equal(currentStatus(), "RETRO_PENDING");

    // A page renders before any POST does, and GET /gate serves computeActions.
    // This has to be measured FIRST: leading with getActions primes the very
    // persisted merge readiness the read path reads back, which is exactly how
    // the "first click on 运行 Retro is always 409" defect stayed invisible here.
    const renderedRetro = computeActions(CHANGE_ID).find((action) => action.actionId === "run_retro")!;

    const retroContracts = [getActions(CHANGE_ID), computeActions(CHANGE_ID), getActions(CHANGE_ID)]
      .map((actions) => actions.find((action) => action.actionId === "run_retro")!);
    const retroContract = retroContracts[0]!;
    assert.equal(retroContract.enabled, true, JSON.stringify(retroContract));
    assert.deepEqual(
      retroContracts.map((contract) => contract.sourceDbHash),
      [retroContract.sourceDbHash, retroContract.sourceDbHash, retroContract.sourceDbHash],
      "repeated self-healing GET action computation must preserve the Retro authority hash",
    );
    assert.deepEqual(
      [renderedRetro.enabled, renderedRetro.gateVersion, renderedRetro.sourceDbHash],
      [true, retroContract.gateVersion, retroContract.sourceDbHash],
      "the Retro contract GET /gate renders must be the one the next POST preflight compares against",
    );
    const retroJob = enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "retro", actionId: "run_retro",
      idempotencyKey: "complete-pipeline-retro-authority",
    }, retroContract);
    assert.equal(retroJob.created, true);
    db.update(pipelineJobs).set({ status: "succeeded", endedAt: new Date().toISOString() })
      .where(eq(pipelineJobs.id, retroJob.job.id)).run();
    const assertRetroDrift = (idempotencyKey: string) => {
      assert.throws(() => enqueueProviderActionAtomically({
        changeId: CHANGE_ID, phase: "retro", actionId: "run_retro", idempotencyKey,
      }, retroContract), ActionContractDriftError);
      assert.equal(db.select().from(pipelineJobs).where(and(
        eq(pipelineJobs.changeId, CHANGE_ID), eq(pipelineJobs.idempotencyKey, idempotencyKey),
      )).all().length, 0);
    };
    const retroMergeGates = db.select().from(stageGates).where(and(
      eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Merge"),
    )).all();
    db.update(stageGates).set({ sourceDbHash: "retro-stale-merge-source" })
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Merge"))).run();
    assertRetroDrift("retro-merge-gate-drift");
    for (const gate of retroMergeGates) {
      db.update(stageGates).set({ sourceDbHash: gate.sourceDbHash }).where(eq(stageGates.id, gate.id)).run();
    }
    const completedRelease = db.select().from(runs).where(and(
      eq(runs.changeId, CHANGE_ID), eq(runs.phase, "release"),
    )).get()!;
    db.update(runs).set({ status: "failed" }).where(eq(runs.id, completedRelease.id)).run();
    assertRetroDrift("retro-release-run-drift");
    db.update(runs).set({ status: completedRelease.status }).where(eq(runs.id, completedRelease.id)).run();
    const releaseArtifact = db.select().from(artifacts).where(and(
      eq(artifacts.changeId, CHANGE_ID), eq(artifacts.runId, completedRelease.id),
      eq(artifacts.type, "release_note"),
    )).get()!;
    // runRelease persisted the immutable approved-content hash here; capture it so the
    // artifact-drift teardown can respect the release_note_state -> artifacts FK.
    const releaseNoteStateRow = db.select().from(releaseNoteState).where(and(
      eq(releaseNoteState.changeId, CHANGE_ID), eq(releaseNoteState.runId, completedRelease.id),
      eq(releaseNoteState.artifactId, releaseArtifact.id),
    )).get()!;
    db.delete(releaseNoteState).where(eq(releaseNoteState.id, releaseNoteStateRow.id)).run();
    db.delete(artifacts).where(eq(artifacts.id, releaseArtifact.id)).run();
    assertRetroDrift("retro-release-artifact-drift");
    db.insert(artifacts).values(releaseArtifact).run();
    db.insert(releaseNoteState).values(releaseNoteStateRow).run();

    // The immutable approved-content hash now lives in release_note_state, so tampering
    // it (or removing the row) is the Retro drift signal -- not the run-copy file bytes.
    db.update(releaseNoteState)
      .set({ approvedContentHash: `${releaseNoteStateRow.approvedContentHash}-tampered` })
      .where(eq(releaseNoteState.id, releaseNoteStateRow.id)).run();
    assertRetroDrift("retro-release-note-state-hash-drift");
    db.update(releaseNoteState).set({ approvedContentHash: releaseNoteStateRow.approvedContentHash })
      .where(eq(releaseNoteState.id, releaseNoteStateRow.id)).run();
    db.delete(releaseNoteState).where(eq(releaseNoteState.id, releaseNoteStateRow.id)).run();
    assertRetroDrift("retro-release-note-state-missing");
    db.insert(releaseNoteState).values(releaseNoteStateRow).run();

    const releaseArtifactPath = releaseArtifact.path;
    const currentReleasePath = path.join(repoPath, ".ship", "changes", CHANGE_ID, "release-note.md");
    const originalReleaseBytes = fs.readFileSync(releaseArtifactPath);
    // The run-scoped copy's bytes are no longer the content authority: tampering it while
    // the DB hash and current copy stay intact must NOT churn or drift the Retro fence.
    fs.writeFileSync(releaseArtifactPath, Buffer.concat([originalReleaseBytes, Buffer.from("\nretro drift\n")]));
    assert.equal(
      getActions(CHANGE_ID).find((action) => action.actionId === "run_retro")?.sourceDbHash,
      retroContract.sourceDbHash,
      "run-copy content tampering must not churn the Retro fence (approved hash lives in the DB)",
    );
    fs.writeFileSync(releaseArtifactPath, originalReleaseBytes);

    const alternateReleasePath = path.join(path.dirname(releaseArtifactPath), "release-note-alternate.md");
    fs.writeFileSync(alternateReleasePath, originalReleaseBytes);
    db.update(artifacts).set({ path: alternateReleasePath }).where(eq(artifacts.id, releaseArtifact.id)).run();
    assertRetroDrift("retro-release-artifact-path-drift");
    db.update(artifacts).set({ path: releaseArtifactPath }).where(eq(artifacts.id, releaseArtifact.id)).run();
    fs.rmSync(alternateReleasePath);

    const symlinkTarget = path.join(path.dirname(releaseArtifactPath), "release-note-symlink-target.md");
    fs.writeFileSync(symlinkTarget, originalReleaseBytes);
    fs.rmSync(releaseArtifactPath);
    fs.symlinkSync(symlinkTarget, releaseArtifactPath);
    assertRetroDrift("retro-release-artifact-symlink-drift");
    fs.rmSync(releaseArtifactPath);
    fs.writeFileSync(releaseArtifactPath, originalReleaseBytes);
    fs.rmSync(symlinkTarget);

    fs.writeFileSync(currentReleasePath, Buffer.concat([originalReleaseBytes, Buffer.from("\ncurrent drift\n")]));
    assertRetroDrift("retro-current-release-bytes-drift");
    await assert.rejects(
      runRetro(CHANGE_ID, makeTestJobExecutionContext("retro-execution-fence-drift")),
      /authority is unavailable or has drifted/,
    );
    fs.writeFileSync(currentReleasePath, originalReleaseBytes);

    fs.rmSync(currentReleasePath);
    fs.symlinkSync(releaseArtifactPath, currentReleasePath);
    assertRetroDrift("retro-current-release-symlink-drift");
    fs.rmSync(currentReleasePath);
    fs.writeFileSync(currentReleasePath, originalReleaseBytes);

    const outsideReleasePath = path.join(repoPath, "outside-release-note.md");
    fs.writeFileSync(outsideReleasePath, originalReleaseBytes);
    db.update(artifacts).set({ path: outsideReleasePath }).where(eq(artifacts.id, releaseArtifact.id)).run();
    assertRetroDrift("retro-release-artifact-outside-root");
    db.update(artifacts).set({ path: releaseArtifactPath }).where(eq(artifacts.id, releaseArtifact.id)).run();
    fs.rmSync(outsideReleasePath);

    db.update(artifacts).set({ path: `${path.dirname(releaseArtifactPath)}${path.sep}..${path.sep}` +
      `${completedRelease.id}${path.sep}release-note.md` }).where(eq(artifacts.id, releaseArtifact.id)).run();
    assertRetroDrift("retro-release-artifact-traversal-path");
    db.update(artifacts).set({ path: releaseArtifactPath }).where(eq(artifacts.id, releaseArtifact.id)).run();

    db.update(artifacts).set({ path: path.dirname(releaseArtifactPath) })
      .where(eq(artifacts.id, releaseArtifact.id)).run();
    assertRetroDrift("retro-release-artifact-directory-path");
    db.update(artifacts).set({ path: releaseArtifactPath }).where(eq(artifacts.id, releaseArtifact.id)).run();

    fs.rmSync(releaseArtifactPath);
    assertRetroDrift("retro-release-artifact-file-missing");
    fs.writeFileSync(releaseArtifactPath, originalReleaseBytes);
    fs.rmSync(currentReleasePath);
    assertRetroDrift("retro-current-release-file-missing");
    fs.writeFileSync(currentReleasePath, originalReleaseBytes);

    const releaseRunsDir = path.dirname(path.dirname(releaseArtifactPath));
    const realReleaseRunsDir = `${releaseRunsDir}-real`;
    fs.renameSync(releaseRunsDir, realReleaseRunsDir);
    fs.symlinkSync(realReleaseRunsDir, releaseRunsDir);
    assertRetroDrift("retro-release-artifact-ancestor-symlink");
    fs.rmSync(releaseRunsDir);
    fs.renameSync(realReleaseRunsDir, releaseRunsDir);

    db.update(runs).set({ jobId: "retro-lineage-drift" }).where(eq(runs.id, completedRelease.id)).run();
    assertRetroDrift("retro-release-lineage-drift");
    db.update(runs).set({ jobId: completedRelease.jobId }).where(eq(runs.id, completedRelease.id)).run();
    db.update(artifacts).set({ createdAt: "2099-01-01T00:00:00.000Z" })
      .where(eq(artifacts.id, releaseArtifact.id)).run();
    assert.equal(
      getActions(CHANGE_ID).find((action) => action.actionId === "run_retro")?.sourceDbHash,
      retroContract.sourceDbHash,
      "non-authoritative artifact timestamps must not churn the Retro fence",
    );
    db.update(artifacts).set({ createdAt: releaseArtifact.createdAt })
      .where(eq(artifacts.id, releaseArtifact.id)).run();

    const replacementRunId = `${completedRelease.id}-NEWER`;
    const replacementRunPath = path.join(repoPath, ".ship", "changes", CHANGE_ID, "runs",
      replacementRunId, "release-note.md");
    fs.mkdirSync(path.dirname(replacementRunPath), { recursive: true });
    fs.writeFileSync(replacementRunPath, originalReleaseBytes);
    db.insert(runs).values({ ...completedRelease, id: replacementRunId,
      endedAt: "2099-01-01T00:00:00.000Z" }).run();
    db.insert(artifacts).values({ ...releaseArtifact, id: `${releaseArtifact.id}-NEWER`,
      runId: replacementRunId, path: replacementRunPath }).run();
    assertRetroDrift("retro-newer-release-authority");
    db.delete(artifacts).where(eq(artifacts.id, `${releaseArtifact.id}-NEWER`)).run();
    db.delete(runs).where(eq(runs.id, replacementRunId)).run();
    fs.rmSync(path.dirname(replacementRunPath), { recursive: true });

    await runRetro(CHANGE_ID, makeTestJobExecutionContext("complete-pipeline-retro"));
    // Retro hands over to the Done stage rather than ending the pipeline: this
    // used to assert DONE here, which is exactly the gap design §3 closed --
    // a change could finish with nothing saying how to use what it built.
    assert.equal(currentStatus(), "DELIVERY_PENDING");

    await runDelivery(CHANGE_ID, makeTestJobExecutionContext("complete-pipeline-delivery"));
    assert.equal(currentStatus(), "DONE");

    for (const fileName of [
      "change-request.md",
      "prd-delta.md",
      "tech-spec-delta.md",
      "test-plan-delta.md",
      "plan.json",
      "plan.md",
      path.join("reports", "plan-report.md"),
      path.join("reports", "build-1-report.md"),
      "release-note.md",
      "retro.md",
      "delivery.md",
    ]) {
      assert.equal(artifactExists(repoPath, fileName), true, `${fileName} should exist`);
    }
  });
});
