import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { db } from "../db/index.ts";
import {
  artifacts,
  battleRounds,
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
  requiredValidationCommands,
  releaseNoteState,
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
import { getActions } from "./action-contract-service.ts";
import { assertActionAllowed, PreflightBlockedError } from "./preflight-service.ts";
import { setReviewQaGateHeadProbeForTest } from "./review-qa-gate-service.ts";
import { setMergeReadinessHeadProbeForTest } from "./merge-readiness-service.ts";
import { computeSourceDbHash, type PipelinePhase } from "./stage-authority-service.ts";
import { recomputeReviewReport } from "./review-report-service.ts";
import { buildReviewInputSnapshot } from "./review-run-service.ts";
import { ACTION_DEFINITIONS } from "./action-contract-registry-service.ts";

const PROJECT_ID = "PRJ-QA-RETRY-STATUS";
const CHANGE_ID = "CHG-QA-RETRY-STATUS";
const HEAD_SHA = "c".repeat(40);
const QA_SOURCE_HASH = "qa-retry-status-source-hash";

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
    name: "QA retry status",
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
    title: "QA retry status change",
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

function seedStageGate(
  phase: PipelinePhase,
  status = "passed",
  sourceDbHash = `${phase}-hash`,
  blockers: Array<{ id: string; severity: "P0" | "P1" | "P2"; title: string }> = [],
) {
  const gateId = `STG-GATE-QA-RETRY-STATUS-${phase}`;
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
    id: `STG-STATE-QA-RETRY-STATUS-${phase}`,
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
 * The completed work the enqueue authority traces behind a seeded gate: a
 * unique stage run holding the gate's source hash plus the paired completed
 * business run and artifact (the legacy attempt-pairing path).
 */
function seedAuthorityBackedStageSource(
  phase: PipelinePhase,
  businessPhase: string,
  sourceDbHash: string,
) {
  const now = "2026-06-29T00:01:00.000Z";
  db.insert(stageRuns).values({
    id: `STG-RUN-QA-RETRY-STATUS-${phase}`,
    changeId: CHANGE_ID,
    phase,
    attemptNo: 1,
    status: "passed",
    idempotencyKey: `stage-run-qa-retry-${phase}`,
    inputDbHash: sourceDbHash,
    outputDbHash: sourceDbHash,
    sourceLineageJson: null,
    errorCode: null,
    startedAt: now,
    completedAt: now,
  }).run();
  db.insert(runs).values({
    id: `RUN-QA-RETRY-STATUS-AUTH-${phase}`,
    changeId: CHANGE_ID,
    phase: businessPhase,
    status: "completed",
    startedAt: now,
    endedAt: now,
    summary: `${businessPhase} completed`,
    attemptNo: 1,
  }).run();
  db.insert(artifacts).values({
    id: `ART-QA-RETRY-STATUS-AUTH-${phase}`,
    changeId: CHANGE_ID,
    runId: `RUN-QA-RETRY-STATUS-AUTH-${phase}`,
    type: "stage_output",
    path: `/tmp/qa-retry-status-auth-${phase}.json`,
    createdAt: now,
  }).run();
}

function seedPassedReview() {
  const now = "2026-06-29T00:02:00.000Z";
  db.insert(buildRunRecords).values({
    id: "BRR-QA-RETRY-STATUS",
    changeId: CHANGE_ID,
    runId: null,
    buildRunId: "build-qa-retry",
    status: "adopted",
    headSha: HEAD_SHA,
    adoptedAt: now,
    artifactHash: null,
    source: "test",
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(runs).values({
    id: "RUN-QA-RETRY-STATUS",
    changeId: CHANGE_ID,
    phase: "review",
    status: "completed",
    startedAt: now,
    endedAt: now,
    summary: "{}",
  }).run();
  db.insert(reviewAttempts).values({
    id: "RAT-QA-RETRY-STATUS",
    changeId: CHANGE_ID,
    runId: "RUN-QA-RETRY-STATUS",
    attemptNo: 1,
    status: "completed",
    provider: "codex",
    reviewStatus: "passed",
    idempotencyKey: "review-qa-retry-status",
    sourceBuildRunId: "build-qa-retry",
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
    id: "RRP-QA-RETRY-STATUS",
    attemptId: "RAT-QA-RETRY-STATUS",
    changeId: CHANGE_ID,
    reportVersion: 1,
    reviewConclusion: "passed",
    reportDbHash: "review-report-hash-qa-retry",
    gateStatus: "passed",
    qaAllowed: 1,
    sourceBuildRunId: "build-qa-retry",
    sourceHeadSha: HEAD_SHA,
    findingVersion: 1,
    waiverVersion: 1,
    blockingP0: 0,
    blockingP1: 0,
    waivedP1: 0,
    p2Count: 0,
    findingsDbHash: "findings-hash-qa-retry",
    staleReason: null,
    legacyState: null,
    reportJson: null,
    generatedAt: now,
    createdAt: now,
  }).run();
  db.insert(reviewState).values({
    changeId: CHANGE_ID,
    latestAttemptId: "RAT-QA-RETRY-STATUS",
    latestAttemptNo: 1,
    latestReportId: "RRP-QA-RETRY-STATUS",
    latestValidReviewReportId: "RRP-QA-RETRY-STATUS",
    latestValidAttemptNo: 1,
    gateStatus: "passed",
    reviewStatus: "passed",
    sourceBuildRunId: "build-qa-retry",
    sourceHeadSha: HEAD_SHA,
    reportDbHash: "review-report-hash-qa-retry",
    findingVersion: 1,
    waiverVersion: 1,
    updatedAt: now,
  }).run();
}

function seedApprovedTestPlanForQa() {
  const now = "2026-06-29T00:03:00.000Z";
  db.insert(testplanSnapshots).values({
    id: "TPS-QA-RETRY-STATUS",
    changeId: CHANGE_ID,
    status: "approved",
    testIntent: "QA retry coverage",
    schemaVersion: "testplan/v1",
    approvalState: "approved",
    approvedAt: now,
    approvalDecisionId: null,
    snapshotDbHash: "testplan-source-hash",
    createdAt: now,
  }).run();
  db.insert(requiredValidationCommands).values({
    id: "RVC-QA-RETRY-STATUS",
    changeId: CHANGE_ID,
    phase: "TestPlan",
    sourceSnapshotId: "TPS-QA-RETRY-STATUS",
    command: "npm test",
    commandOrder: 1,
    required: 1,
    createdAt: now,
  }).run();
  // hasCurrentQaTestPlanPrerequisite compares the TestPlan gate's sourceDbHash
  // against the content hash over the approved snapshot plus its required
  // commands, so the gate must carry that computed hash or a retry_qa POST
  // would 409 on authority grounds rather than on the status question here.
  const snapshotRow = db
    .select()
    .from(testplanSnapshots)
    .where(eq(testplanSnapshots.id, "TPS-QA-RETRY-STATUS"))
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
    .filter((command) => command.sourceSnapshotId === "TPS-QA-RETRY-STATUS");
  const testplanSourceHash = computeSourceDbHash({
    changeId: CHANGE_ID,
    phase: "TestPlan",
    rows: [snapshotRow, ...commandRows],
  });
  seedStageGate("TestPlan", "passed", testplanSourceHash);
}

/**
 * Promotes the seeded review rows into the fully trusted chain the enqueue
 * authority walks for retry_qa. Call LAST so every recomputed hash reflects
 * the state the authority evaluates.
 */
function settleTrustedReviewAuthority() {
  const now = "2026-06-29T00:03:30.000Z";
  db.update(buildRunRecords)
    .set({
      headSha: HEAD_SHA,
      adoptedHeadSha: HEAD_SHA,
      adoptionDecisionId: "ADN-QA-RETRY-STATUS",
      adoptedAt: now,
      baseHeadSha: HEAD_SHA,
      baseCommit: HEAD_SHA,
      patchHash: "qa-retry-patch-hash",
      changedFilesHash: "qa-retry-files-hash",
      artifactHash: "qa-retry-artifact-hash",
    })
    .where(eq(buildRunRecords.id, "BRR-QA-RETRY-STATUS"))
    .run();
  const inputSnapshot = buildReviewInputSnapshot(db as never, CHANGE_ID, []);
  db.update(reviewAttempts)
    .set({
      inputSourceDbHash: inputSnapshot.inputSourceDbHash,
      priorBlockingFindingIdsJson: "[]",
    })
    .where(eq(reviewAttempts.id, "RAT-QA-RETRY-STATUS"))
    .run();
  return recomputeReviewReport(CHANGE_ID, "RAT-QA-RETRY-STATUS");
}

/**
 * The state a QA run leaves behind when its checks fail: the QA stage gate is
 * settled "failed" (qa-run-service) and every QA prerequisite still holds, so
 * the only thing left deciding whether the retry is offered is change.status.
 */
function seedFailedQaScenario(status: string) {
  db.update(changes).set({ status }).where(eq(changes.id, CHANGE_ID)).run();
  seedPassedReview();
  seedApprovedTestPlanForQa();
  seedStageGate("QA", "failed", QA_SOURCE_HASH, [
    { id: "QA-FAIL-QA-RETRY-STATUS", severity: "P1", title: "npm test failed" },
  ]);
  seedAuthorityBackedStageSource("QA", "local_check", QA_SOURCE_HASH);
  settleTrustedReviewAuthority();
}

function retryQaAction() {
  return getActions(CHANGE_ID).find((action) => action.actionId === "retry_qa");
}

/**
 * §3.7. The registry's requiredStatus for retry_qa is the authority on which
 * change statuses may retry a failed QA run: it is what the enqueue fence
 * (evaluateProviderActionAuthority) rejects on with change_status_mismatch,
 * and the retry_qa POST route reaches that fence only after clearing the
 * served contract (check/route.ts -> assertActionAllowedAsync). The policy
 * that computes the contract used to hard-code CHECK_FAILED, dropping
 * SCOPE_FAILED -- the status a QA run lands on when the scope check and the
 * local commands fail in the same run (pipeline-qa-stage-service prefers
 * SCOPE_FAILED when both fail, while qa-run-service still settles the gate as
 * "failed"). That combination stranded the change: the retry button was dead
 * and the POST 409'd on the one action that could move it forward.
 */
describe("retry_qa availability across change statuses after a failed QA gate", () => {
  let repoPath: string;
  let restoreHeadProbe: (() => void) | null = null;
  let restoreMergeHeadProbe: (() => void) | null = null;

  beforeEach(() => {
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "qa-retry-status-"));
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

  // CHECKING is the registry's third retryable status but is deliberately
  // excluded here: retryQaDecision short-circuits it as qa_running, and the
  // stuck-CHECKING case is self-healed into CHECK_FAILED before the status
  // question is ever asked (action-contract-self-heal-service).
  for (const status of ["CHECK_FAILED", "SCOPE_FAILED"] as const) {
    it(`offers retry_qa from ${status} and accepts the POST`, () => {
      seedFailedQaScenario(status);

      const retryQa = retryQaAction();

      assert.equal(retryQa?.enabled, true, JSON.stringify(retryQa));
      assert.equal(retryQa?.reasonCode, null);
      assert.equal(retryQa?.sourceDbHash, QA_SOURCE_HASH);

      const allowed = assertActionAllowed({
        changeId: CHANGE_ID,
        actionId: "retry_qa",
        expectedGateVersion: retryQa?.gateVersion ?? "",
        expectedSourceDbHash: retryQa?.sourceDbHash ?? "",
        idempotencyKey: `retry-qa-${status}`,
      });
      assert.equal(allowed.actionId, "retry_qa");
      assert.equal(allowed.enabled, true);
    });
  }

  // BLOCKED is the sibling outcome of the same QA run (a scope check that
  // reports *blocked* rather than merely failed); IMPLEMENTED and REVIEWING
  // are pre-QA statuses. None appear in retry_qa's requiredStatus, so the
  // enqueue fence would 409 them with change_status_mismatch and the contract
  // must not advertise them. The refusal has to come from the registry-derived
  // filter in decideOneAction (not_at_gate) rather than from a status list
  // restated inside the QA policy -- that restatement is what this suite
  // exists to keep out. Widening the registry entry alone must be enough to
  // move these, which is what makes the policy genuinely derived.
  for (const status of ["BLOCKED", "IMPLEMENTED", "REVIEWING"] as const) {
    it(`refuses retry_qa from ${status}, which the registry does not list`, () => {
      seedFailedQaScenario(status);

      const retryQa = retryQaAction();

      assert.equal(retryQa?.enabled, false, JSON.stringify(retryQa));
      assert.equal(
        retryQa?.reasonCode,
        "not_at_gate",
        `expected the registry-derived refusal, got ${retryQa?.reasonCode}`,
      );
      assert.throws(
        () =>
          assertActionAllowed({
            changeId: CHANGE_ID,
            actionId: "retry_qa",
            expectedGateVersion: retryQa?.gateVersion ?? "",
            expectedSourceDbHash: retryQa?.sourceDbHash ?? "",
            idempotencyKey: `retry-qa-${status}`,
          }),
        PreflightBlockedError,
      );
    });
  }

  // The other half of the predicate: retry_qa answers a *failed* QA gate. A
  // stale gate is a different repair (recompute the gate) and the enqueue
  // fence refuses it -- retryingFailedQa only exempts status "failed", so a
  // stale gate falls through to gate_not_passed. The contract must say so in
  // its own words (qa_stale) instead of advertising the retry and letting the
  // overlay retract it, which is what the user would see as a button that
  // explains nothing.
  it("refuses retry_qa from CHECK_FAILED when the QA gate is stale rather than failed", () => {
    db.update(changes).set({ status: "CHECK_FAILED" }).where(eq(changes.id, CHANGE_ID)).run();
    seedPassedReview();
    seedApprovedTestPlanForQa();
    seedStageGate("QA", "stale", QA_SOURCE_HASH);
    seedAuthorityBackedStageSource("QA", "local_check", QA_SOURCE_HASH);
    settleTrustedReviewAuthority();

    const retryQa = retryQaAction();

    assert.equal(retryQa?.enabled, false, JSON.stringify(retryQa));
    assert.equal(
      retryQa?.reasonCode,
      "qa_stale",
      `expected the gate-state refusal, got ${retryQa?.reasonCode}`,
    );
  });

  it("keeps the registry as the single authority on retryable statuses", () => {
    const definition = ACTION_DEFINITIONS.find((entry) => entry.actionId === "retry_qa");
    assert.deepEqual(definition?.requiredStatus, ["CHECKING", "CHECK_FAILED", "SCOPE_FAILED"]);
  });
});
