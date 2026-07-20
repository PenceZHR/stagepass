import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import fs from "fs";
import os from "os";
import path from "path";

import { db } from "../db/index.ts";
import {
  buildRunRecords,
  changes,
  events,
  findings,
  humanDecisions,
  mergeApprovals,
  mergeBlockers,
  mergeDecisions,
  mergeReadiness,
  projects,
  qaCommandResults,
  qaEvidence,
  qaFailures,
  qaRuns,
  reviewAttempts,
  reviewReports,
  reviewState,
  stageActions,
  stageGates,
  stageStates,
} from "../db/schema.ts";
import { getActions } from "./action-contract-service.ts";
import { assertActionAllowed } from "./preflight-service.ts";
import {
  assertCanMerge,
  computeMergeReadiness,
  setMergeReadinessDbForTest,
  setMergeReadinessDirtyProbeForTest,
  setMergeReadinessHeadProbeForTest,
} from "./merge-readiness-service.ts";
import { recomputeStageGate, type PipelinePhase } from "./stage-authority-service.ts";

const PROJECT_ID = "PRJ-MRG-13";
const CHANGE_ID = "CHG-MRG-13";
const HEAD = "c".repeat(40);
const STALE_HEAD = "d".repeat(40);
const QA_DELIVERY_HEAD = "e".repeat(40);
const EXTERNAL_DRIFT_HEAD = "f".repeat(40);

function nowISO(): string {
  return new Date().toISOString();
}

function cleanupRows() {
  const readinessIds = db
    .select({ id: mergeReadiness.id })
    .from(mergeReadiness)
    .where(eq(mergeReadiness.changeId, CHANGE_ID))
    .all()
    .map((row) => row.id);
  for (const readinessId of readinessIds) {
    db.delete(mergeBlockers).where(eq(mergeBlockers.mergeReadinessId, readinessId)).run();
  }
  db.delete(mergeDecisions).where(eq(mergeDecisions.changeId, CHANGE_ID)).run();
  db.delete(mergeApprovals).where(eq(mergeApprovals.changeId, CHANGE_ID)).run();
  db.delete(mergeReadiness).where(eq(mergeReadiness.changeId, CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();

  const qaRunIds = db
    .select({ id: qaRuns.id })
    .from(qaRuns)
    .where(eq(qaRuns.changeId, CHANGE_ID))
    .all()
    .map((row) => row.id);
  for (const qaRunId of qaRunIds) {
    db.delete(qaEvidence).where(eq(qaEvidence.qaRunId, qaRunId)).run();
    db.delete(qaFailures).where(eq(qaFailures.qaRunId, qaRunId)).run();
    db.delete(qaCommandResults).where(eq(qaCommandResults.qaRunId, qaRunId)).run();
  }
  db.delete(qaRuns).where(eq(qaRuns.changeId, CHANGE_ID)).run();

  db.delete(stageActions).where(eq(stageActions.changeId, CHANGE_ID)).run();
  db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
  db.delete(findings).where(eq(findings.changeId, CHANGE_ID)).run();
  db.delete(reviewState).where(eq(reviewState.changeId, CHANGE_ID)).run();
  db.delete(reviewReports).where(eq(reviewReports.changeId, CHANGE_ID)).run();
  db.delete(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).run();
  db.delete(buildRunRecords).where(eq(buildRunRecords.changeId, CHANGE_ID)).run();
  db.delete(humanDecisions).where(eq(humanDecisions.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(repoPath: string) {
  const now = nowISO();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Merge readiness T13",
    repoPath,
    contextStatus: "ready",
    contextProvider: "codex",
    prdStatus: "ready",
    prdProvider: "codex",
    prdJson: null,
    prdMarkdown: null,
    gitEnabled: 1,
    gitDefaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Merge readiness change",
    status: "MERGE_READY",
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

function seedStageGate(phase: PipelinePhase, status = "passed") {
  recomputeStageGate({
    changeId: CHANGE_ID,
    phase,
    status,
    blockers: status === "passed" ? [] : [{ id: `${phase}-stale`, severity: "P1", title: `${phase} stale` }],
    freshness: { fresh: status === "passed" },
    requiredActions: status === "passed" ? [] : [`retry_${phase.toLowerCase()}`],
    rows: [{ table: "stage_fixture", phase, status }],
  });
}

function seedRequiredStageGates(overrides: Partial<Record<PipelinePhase, string>> = {}) {
  for (const phase of ["PRD", "Spec", "Plan", "TestPlan", "Build", "Review", "QA"] as PipelinePhase[]) {
    seedStageGate(phase, overrides[phase] ?? "passed");
  }
}

function seedAdoptedBuild(overrides: Partial<typeof buildRunRecords.$inferInsert> = {}) {
  const now = nowISO();
  db.insert(buildRunRecords).values({
    id: "BRR-MRG-13",
    changeId: CHANGE_ID,
    runId: null,
    buildRunId: "build-13",
    status: "adopted",
    headSha: HEAD,
    baseHeadSha: "b".repeat(40),
    baseCommit: "b".repeat(40),
    patchHash: "patch-hash",
    changedFilesHash: "changed-files-hash",
    adoptedHeadSha: HEAD,
    adoptionDecisionId: "DEC-MRG-13-BUILD",
    adoptedAt: now,
    artifactHash: "artifact-hash",
    source: "test",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run();
}

function seedReviewPassed() {
  const now = nowISO();
  db.insert(reviewAttempts).values({
    id: "RAT-MRG-13",
    changeId: CHANGE_ID,
    runId: null,
    attemptNo: 1,
    status: "completed",
    provider: "codex",
    reviewStatus: "passed",
    idempotencyKey: "review-key",
    sourceBuildRunId: "build-13",
    sourceHeadSha: HEAD,
    inputSourceDbHash: "review-input",
    inputSourceLineageJson: "{}",
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
    id: "RRP-MRG-13",
    attemptId: "RAT-MRG-13",
    changeId: CHANGE_ID,
    reportVersion: 1,
    reviewConclusion: "passed",
    reportDbHash: "review-db-hash",
    gateStatus: "passed",
    qaAllowed: 1,
    sourceBuildRunId: "build-13",
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
  db.insert(reviewState).values({
    changeId: CHANGE_ID,
    latestAttemptId: "RAT-MRG-13",
    latestAttemptNo: 1,
    latestReportId: "RRP-MRG-13",
    latestValidReviewReportId: "RRP-MRG-13",
    latestValidAttemptNo: 1,
    gateStatus: "passed",
    reviewStatus: "passed",
    sourceBuildRunId: "build-13",
    sourceHeadSha: HEAD,
    reportDbHash: "review-db-hash",
    findingVersion: 1,
    waiverVersion: 1,
    updatedAt: now,
  }).run();
}

function seedQaPassed(overrides: Partial<typeof qaRuns.$inferInsert> = {}) {
  const now = nowISO();
  db.insert(qaRuns).values({
    id: "QA-MRG-13",
    changeId: CHANGE_ID,
    sourceReviewReportId: "RRP-MRG-13",
    sourceBuildRunId: "build-13",
    sourceHeadSha: HEAD,
    status: "passed",
    startedAt: now,
    completedAt: now,
    ...overrides,
  }).run();
  db.insert(qaCommandResults).values({
    id: "QA-CMD-MRG-13",
    qaRunId: "QA-MRG-13",
    command: "npm test",
    commandOrder: 1,
    status: "passed",
    exitCode: 0,
    durationMs: 10,
    outputArtifactMirrorId: null,
    completedAt: now,
  }).run();
}

function seedQaControlledDeliveryHead(sourceHeadSha: string) {
  db.insert(qaEvidence).values({
    id: `QA-EVD-DELIVERY-${sourceHeadSha.slice(0, 8)}`,
    qaRunId: "QA-MRG-13",
    evidenceType: "qa_delivery_head",
    artifactMirrorId: null,
    contentHash: sourceHeadSha,
    createdAt: nowISO(),
  }).run();
  const latestQaGate = db
    .select()
    .from(stageGates)
    .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "QA")))
    .get();
  if (latestQaGate) {
    db.update(stageGates)
      .set({ freshnessJson: JSON.stringify({ fresh: true, sourceHeadSha: HEAD, deliveryHeadSha: sourceHeadSha }) })
      .where(eq(stageGates.id, latestQaGate.id))
      .run();
  }
}

function seedMergeApproval() {
  const now = nowISO();
  db.insert(humanDecisions).values({
    id: "HD-MRG-13",
    changeId: CHANGE_ID,
    roundId: null,
    gate: "merge",
    action: "approve_merge",
    targetType: "change",
    targetId: CHANGE_ID,
    reason: "ship it",
    reportHash: null,
    createdBy: "human",
    createdAt: now,
  }).run();
  db.insert(mergeApprovals).values({
    id: "MAP-MRG-13",
    changeId: CHANGE_ID,
    decisionId: "HD-MRG-13",
    actor: "human",
    approvedAt: now,
  }).run();
}

function writeMisleadingMirrors(repoPath: string) {
  const reportDir = path.join(repoPath, ".ship", "changes", CHANGE_ID, "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "war-report.md"), "可以合并\n");
  fs.writeFileSync(path.join(reportDir, "review-report.md"), "passed\n");
  fs.writeFileSync(path.join(reportDir, "qa-log.md"), "passed\n");
}

function seedHappyPath(repoPath: string) {
  seedChange(repoPath);
  seedRequiredStageGates();
  seedAdoptedBuild();
  seedReviewPassed();
  seedQaPassed();
  seedMergeApproval();
  writeMisleadingMirrors(repoPath);
}

describe("merge-readiness-service", () => {
  let repoPath: string;
  let restoreDb: (() => void) | null = null;
  let restoreHeadProbe: (() => void) | null = null;
  let restoreDirtyProbe: (() => void) | null = null;

  beforeEach(() => {
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "merge-readiness-"));
    restoreDb = setMergeReadinessDbForTest(db);
    restoreHeadProbe = setMergeReadinessHeadProbeForTest(() => HEAD);
    restoreDirtyProbe = setMergeReadinessDirtyProbeForTest(() => false);
  });

  afterEach(() => {
    restoreDirtyProbe?.();
    restoreHeadProbe?.();
    restoreDb?.();
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("passes and writes merge readiness, blockers, and Merge stage gate from DB facts", () => {
    seedHappyPath(repoPath);

    const readiness = assertCanMerge({ changeId: CHANGE_ID });

    assert.equal(readiness.status, "ready");
    assert.equal(readiness.blockers.length, 0);
    assert.equal(readiness.sourceHeadSha, HEAD);
    assert.ok(readiness.sourceDbHash);
    assert.equal(db.select().from(mergeReadiness).where(eq(mergeReadiness.changeId, CHANGE_ID)).all().length, 1);
    assert.equal(
      db.select().from(mergeBlockers).where(eq(mergeBlockers.mergeReadinessId, readiness.id)).all().length,
      0,
    );
    assert.equal(
      db.select().from(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).all().some((gate) => gate.phase === "Merge" && gate.status === "passed"),
      true,
    );
  });

  it("accepts an approved Build artifact as Merge source before patch adoption", () => {
    seedHappyPath(repoPath);
    db.update(buildRunRecords)
      .set({
        status: "approved_for_absorb",
        headSha: null,
        baseHeadSha: HEAD,
        baseCommit: HEAD,
        adoptedHeadSha: null,
        adoptionDecisionId: null,
        adoptedAt: null,
      })
      .where(eq(buildRunRecords.changeId, CHANGE_ID))
      .run();

    const readiness = computeMergeReadiness({ changeId: CHANGE_ID, requireApproval: false });

    assert.equal(readiness.status, "ready");
    assert.equal(readiness.blockers.some((item) => item.reasonCode === "build_adoption_missing"), false);
    assert.equal(readiness.blockers.some((item) => item.reasonCode === "build_adoption_stale"), false);
  });

  it("blocks Merge readiness and action contract when the main worktree is dirty", () => {
    seedHappyPath(repoPath);
    restoreDirtyProbe?.();
    restoreDirtyProbe = setMergeReadinessDirtyProbeForTest(() => true);

    const readiness = computeMergeReadiness(CHANGE_ID);
    const merge = getActions(CHANGE_ID).find((candidate) => candidate.actionId === "merge");

    assert.equal(readiness.blockers.some((item) => item.reasonCode === "git_worktree_dirty"), true);
    assert.equal(merge?.enabled, false);
    assert.equal(merge?.reasonCode, "git_worktree_dirty");
  });

  it("self-heals missing Build and Review gates from current DB facts before Merge approval", () => {
    seedHappyPath(repoPath);
    db.delete(mergeApprovals).where(eq(mergeApprovals.changeId, CHANGE_ID)).run();
    db.delete(stageGates)
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Build")))
      .run();
    db.delete(stageGates)
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Review")))
      .run();

    const readiness = computeMergeReadiness(CHANGE_ID);
    const actions = getActions(CHANGE_ID);
    const approveMerge = actions.find((candidate) => candidate.actionId === "approve_merge");
    const merge = actions.find((candidate) => candidate.actionId === "merge");
    const blockers = readiness.blockers.map((blocker) => blocker.reasonCode);
    const healedGates = db
      .select()
      .from(stageGates)
      .where(eq(stageGates.changeId, CHANGE_ID))
      .all();

    assert.deepEqual(blockers, ["merge_approval_missing"]);
    assert.equal(approveMerge?.enabled, true);
    assert.equal(approveMerge?.reasonCode, null);
    assert.equal(merge?.enabled, false);
    assert.equal(merge?.reasonCode, "merge_approval_missing");
    assert.equal(healedGates.some((gate) => gate.phase === "Build" && gate.status === "passed"), true);
    assert.equal(healedGates.some((gate) => gate.phase === "Review" && gate.status === "passed"), true);
  });

  it("returns an approve_merge contract whose preflight passes after first-render Merge gate creation", () => {
    seedHappyPath(repoPath);
    db.delete(mergeApprovals).where(eq(mergeApprovals.changeId, CHANGE_ID)).run();
    for (const phase of ["Build", "Review", "Merge"] as PipelinePhase[]) {
      db.delete(stageGates)
        .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, phase)))
        .run();
    }

    const actions = getActions(CHANGE_ID);
    const approveMerge = actions.find((candidate) => candidate.actionId === "approve_merge");
    assert.equal(approveMerge?.enabled, true);
    assert.notEqual(approveMerge?.gateVersion, "0");

    const allowed = assertActionAllowed({
      changeId: CHANGE_ID,
      actionId: "approve_merge",
      expectedGateVersion: approveMerge?.gateVersion ?? "",
      expectedSourceDbHash: approveMerge?.sourceDbHash ?? "",
      idempotencyKey: "approve-merge-first-render",
    });
    assert.equal(allowed.actionId, "approve_merge");
    assert.equal(allowed.enabled, true);
  });

  it("does not synthesize Review gate when the latest Review report points at a stale BuildRun", () => {
    seedHappyPath(repoPath);
    db.delete(mergeApprovals).where(eq(mergeApprovals.changeId, CHANGE_ID)).run();
    db.delete(stageGates)
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Review")))
      .run();
    db.update(reviewReports)
      .set({ sourceBuildRunId: "build-12" })
      .where(eq(reviewReports.id, "RRP-MRG-13"))
      .run();

    const readiness = computeMergeReadiness(CHANGE_ID);
    const reviewGate = db
      .select()
      .from(stageGates)
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Review")))
      .get();

    assert.equal(readiness.blockers.some((blocker) => blocker.reasonCode === "review_gate_missing"), true);
    assert.equal(reviewGate, undefined);
  });

  it("does not overwrite an existing stale Review gate", () => {
    seedHappyPath(repoPath);
    seedStageGate("Review", "stale");

    const readiness = computeMergeReadiness(CHANGE_ID);
    const latestReviewGate = db
      .select()
      .from(stageGates)
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Review")))
      .all()
      .sort((left, right) => right.computedAt.localeCompare(left.computedAt))[0];

    assert.equal(readiness.blockers.some((blocker) => blocker.reasonCode === "review_stale"), true);
    assert.equal(latestReviewGate?.status, "stale");
  });

  it("does not let misleading war report, review report, or QA log files bypass an open DB P0", () => {
    seedHappyPath(repoPath);
    db.insert(findings).values({
      id: "FND-MRG-13-P0",
      changeId: CHANGE_ID,
      runId: null,
      source: "review",
      severity: "P0",
      category: "security",
      title: "open P0",
      file: "src/app.ts",
      line: null,
      evidence: "DB finding remains open",
      requiredFix: "fix before merge",
      status: "open",
      reviewAttemptId: "RAT-MRG-13",
      sourceBuildRunId: "build-13",
      sourceHeadSha: HEAD,
      createdAt: nowISO(),
    }).run();

    const readiness = computeMergeReadiness(CHANGE_ID);
    const action = getActions(CHANGE_ID).find((candidate) => candidate.actionId === "merge");

    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.blockers[0]?.reasonCode, "review_open_p0");
    assert.equal(action?.enabled, false);
    assert.equal(action?.reasonCode, "review_open_p0");
  });

  it("blocks merge when QA gate or QA run is stale even if QA log says passed", () => {
    seedHappyPath(repoPath);
    seedStageGate("QA", "stale");

    const readiness = computeMergeReadiness(CHANGE_ID);

    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.blockers.some((blocker) => blocker.reasonCode === "qa_stale"), true);
  });

  it("blocks merge when a passed required gate has stale freshness metadata", () => {
    seedHappyPath(repoPath);
    const qaGate = db
      .select()
      .from(stageGates)
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "QA")))
      .get();
    assert.ok(qaGate);
    db.update(stageGates)
      .set({ freshnessJson: JSON.stringify({ fresh: false, staleReason: "qa_inputs_changed" }) })
      .where(eq(stageGates.id, qaGate.id))
      .run();

    const readiness = computeMergeReadiness(CHANGE_ID);

    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.blockers.some((blocker) => blocker.reasonCode === "qa_stale"), true);
  });

  it("blocks merge when approval, build adoption freshness, or HEAD freshness is missing", () => {
    seedHappyPath(repoPath);
    db.delete(mergeApprovals).where(eq(mergeApprovals.changeId, CHANGE_ID)).run();
    db.update(buildRunRecords)
      .set({ adoptedHeadSha: STALE_HEAD })
      .where(eq(buildRunRecords.id, "BRR-MRG-13"))
      .run();
    restoreHeadProbe?.();
    restoreHeadProbe = setMergeReadinessHeadProbeForTest(() => "e".repeat(40));

    const readiness = computeMergeReadiness(CHANGE_ID);

    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.blockers.some((blocker) => blocker.reasonCode === "merge_approval_missing"), true);
    assert.equal(readiness.blockers.some((blocker) => blocker.reasonCode === "build_adoption_stale"), true);
    assert.equal(readiness.blockers.some((blocker) => blocker.reasonCode === "head_drift"), true);
  });

  it("blocks a QA delivery HEAD that differs from the approved Build base HEAD", () => {
    seedHappyPath(repoPath);
    db.delete(mergeApprovals).where(eq(mergeApprovals.changeId, CHANGE_ID)).run();
    seedQaControlledDeliveryHead(QA_DELIVERY_HEAD);
    restoreHeadProbe?.();
    restoreHeadProbe = setMergeReadinessHeadProbeForTest(() => QA_DELIVERY_HEAD);

    const readiness = computeMergeReadiness(CHANGE_ID);
    const blockerCodes = readiness.blockers.map((blocker) => blocker.reasonCode);

    assert.deepEqual(blockerCodes, ["merge_approval_missing", "head_drift"]);
    assert.equal(readiness.sourceHeadSha, QA_DELIVERY_HEAD);
  });

  it("blocks real HEAD drift after the QA controlled delivery commit", () => {
    seedHappyPath(repoPath);
    seedQaControlledDeliveryHead(QA_DELIVERY_HEAD);
    restoreHeadProbe?.();
    restoreHeadProbe = setMergeReadinessHeadProbeForTest(() => EXTERNAL_DRIFT_HEAD);

    const readiness = computeMergeReadiness(CHANGE_ID);
    const blockerCodes = readiness.blockers.map((blocker) => blocker.reasonCode);

    assert.equal(readiness.status, "blocked");
    assert.deepEqual(blockerCodes, ["head_drift"]);
  });

  it("blocks a legacy post-QA auto commit even when the git_commit event proves the current HEAD", () => {
    seedHappyPath(repoPath);
    db.delete(mergeApprovals).where(eq(mergeApprovals.changeId, CHANGE_ID)).run();
    db.insert(events).values({
      id: "EVT-MRG-13-LEGACY-QA-COMMIT",
      changeId: CHANGE_ID,
      runId: null,
      type: "git_commit",
      message: `[${CHANGE_ID}] chore: update files`,
      rawJson: JSON.stringify({ sha: QA_DELIVERY_HEAD }),
      createdAt: nowISO(),
    }).run();
    restoreHeadProbe?.();
    restoreHeadProbe = setMergeReadinessHeadProbeForTest(() => QA_DELIVERY_HEAD);

    const readiness = computeMergeReadiness(CHANGE_ID);
    const blockerCodes = readiness.blockers.map((blocker) => blocker.reasonCode);

    assert.deepEqual(blockerCodes, ["merge_approval_missing", "head_drift"]);
  });

  it("blocks a legacy post-QA auto commit when the event has a short SHA prefix of current HEAD", () => {
    seedHappyPath(repoPath);
    db.delete(mergeApprovals).where(eq(mergeApprovals.changeId, CHANGE_ID)).run();
    db.insert(events).values({
      id: "EVT-MRG-13-LEGACY-QA-SHORT-COMMIT",
      changeId: CHANGE_ID,
      runId: null,
      type: "git_commit",
      message: `[${CHANGE_ID}] chore: update files`,
      rawJson: JSON.stringify({ sha: QA_DELIVERY_HEAD.slice(0, 7) }),
      createdAt: nowISO(),
    }).run();
    restoreHeadProbe?.();
    restoreHeadProbe = setMergeReadinessHeadProbeForTest(() => QA_DELIVERY_HEAD);

    const readiness = computeMergeReadiness(CHANGE_ID);
    const blockerCodes = readiness.blockers.map((blocker) => blocker.reasonCode);

    assert.deepEqual(blockerCodes, ["merge_approval_missing", "head_drift"]);
  });

  it("rejects a legacy post-QA auto commit when the event short SHA does not match current HEAD", () => {
    seedHappyPath(repoPath);
    db.insert(events).values({
      id: "EVT-MRG-13-LEGACY-QA-WRONG-SHORT-COMMIT",
      changeId: CHANGE_ID,
      runId: null,
      type: "git_commit",
      message: `[${CHANGE_ID}] chore: update files`,
      rawJson: JSON.stringify({ sha: "abc1234" }),
      createdAt: nowISO(),
    }).run();
    restoreHeadProbe?.();
    restoreHeadProbe = setMergeReadinessHeadProbeForTest(() => QA_DELIVERY_HEAD);

    const readiness = computeMergeReadiness(CHANGE_ID);

    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.blockers.some((blocker) => blocker.reasonCode === "head_drift"), true);
  });

  it("rejects a legacy git_commit event created before QA completed", () => {
    seedHappyPath(repoPath);
    db.update(qaRuns)
      .set({
        startedAt: "2026-07-02T10:00:00.000Z",
        completedAt: "2026-07-02T10:10:00.000Z",
      })
      .where(eq(qaRuns.id, "QA-MRG-13"))
      .run();
    db.insert(events).values({
      id: "EVT-MRG-13-PRE-QA-COMPLETE-COMMIT",
      changeId: CHANGE_ID,
      runId: null,
      type: "git_commit",
      message: `[${CHANGE_ID}] chore: update files`,
      rawJson: JSON.stringify({ sha: QA_DELIVERY_HEAD }),
      createdAt: "2026-07-02T10:05:00.000Z",
    }).run();
    restoreHeadProbe?.();
    restoreHeadProbe = setMergeReadinessHeadProbeForTest(() => QA_DELIVERY_HEAD);

    const readiness = computeMergeReadiness(CHANGE_ID);

    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.blockers.some((blocker) => blocker.reasonCode === "head_drift"), true);
  });

  it("rejects a legacy git_commit event whose message is not scoped to the change", () => {
    seedHappyPath(repoPath);
    db.insert(events).values({
      id: "EVT-MRG-13-WRONG-MESSAGE-COMMIT",
      changeId: CHANGE_ID,
      runId: null,
      type: "git_commit",
      message: "chore: update files",
      rawJson: JSON.stringify({ sha: QA_DELIVERY_HEAD }),
      createdAt: nowISO(),
    }).run();
    restoreHeadProbe?.();
    restoreHeadProbe = setMergeReadinessHeadProbeForTest(() => QA_DELIVERY_HEAD);

    const readiness = computeMergeReadiness(CHANGE_ID);

    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.blockers.some((blocker) => blocker.reasonCode === "head_drift"), true);
  });

  it("blocks stale QA source HEAD even when current HEAD matches the QA delivery head", () => {
    seedHappyPath(repoPath);
    seedQaControlledDeliveryHead(QA_DELIVERY_HEAD);
    db.update(qaRuns)
      .set({ sourceHeadSha: STALE_HEAD })
      .where(eq(qaRuns.id, "QA-MRG-13"))
      .run();
    restoreHeadProbe?.();
    restoreHeadProbe = setMergeReadinessHeadProbeForTest(() => QA_DELIVERY_HEAD);

    const readiness = computeMergeReadiness(CHANGE_ID);

    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.blockers.some((blocker) => blocker.reasonCode === "head_drift"), true);
    assert.equal(readiness.blockers.some((blocker) => blocker.reasonCode === "qa_result_stale"), true);
  });

  /**
   * Every action-contract read recomputes merge readiness with persist: true --
   * once for display, again moments later as an approve/merge preflight
   * re-validates, with nothing having actually changed in between. Before
   * gateVersion incremented, writing a fresh row on every call was invisible.
   * Once it does, an unconditional rewrite bumps the Merge gate's version on
   * every read, and any caller that reads the fence once and compares it later
   * (job-dispatch-service.ts's assertCurrentProviderAuthority) sees spurious
   * drift on an action that never actually changed underneath it.
   */
  it("does not rewrite the Merge gate or bump gateVersion when nothing changed (ready)", () => {
    seedHappyPath(repoPath);
    const first = computeMergeReadiness(CHANGE_ID);
    assert.equal(first.status, "ready");
    const gateAfterFirst = db.select().from(stageGates)
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Merge")))
      .all();
    assert.equal(gateAfterFirst.length, 1, "the first call should write exactly one Merge gate");

    const second = computeMergeReadiness(CHANGE_ID);

    assert.equal(second.id, first.id, "recompute should reuse the existing readiness row, not write a new one");
    assert.equal(second.status, "ready");
    const gatesAfterSecond = db.select().from(stageGates)
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Merge")))
      .all();
    assert.equal(gatesAfterSecond.length, 1, "an unchanged recompute must not write a second Merge gate row");
    assert.equal(gatesAfterSecond[0].gateVersion, gateAfterFirst[0].gateVersion);
    const readinessRows = db.select().from(mergeReadiness).where(eq(mergeReadiness.changeId, CHANGE_ID)).all();
    assert.equal(readinessRows.length, 1, "an unchanged recompute must not write a second merge_readiness row");
  });

  it("does not rewrite the Merge gate or bump gateVersion when nothing changed (blocked)", () => {
    seedChange(repoPath);
    seedRequiredStageGates();
    const first = computeMergeReadiness(CHANGE_ID);
    assert.equal(first.status, "blocked");
    const gateAfterFirst = db.select().from(stageGates)
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Merge")))
      .all();
    assert.equal(gateAfterFirst.length, 1);

    const second = computeMergeReadiness(CHANGE_ID);

    assert.equal(second.id, first.id);
    assert.equal(second.status, "blocked");
    const gatesAfterSecond = db.select().from(stageGates)
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Merge")))
      .all();
    assert.equal(gatesAfterSecond.length, 1);
    assert.equal(gatesAfterSecond[0].gateVersion, gateAfterFirst[0].gateVersion);
  });

  it("does rewrite the Merge gate when the underlying facts actually change", () => {
    seedHappyPath(repoPath);
    const first = computeMergeReadiness(CHANGE_ID);
    assert.equal(first.status, "ready");

    db.insert(findings).values({
      id: "FND-MRG-GATEVER",
      changeId: CHANGE_ID,
      runId: null,
      source: "review",
      severity: "P0",
      category: "logic",
      title: "newly discovered blocker",
      file: "src/app.ts",
      line: null,
      status: "open",
      createdAt: nowISO(),
    }).run();

    const second = computeMergeReadiness(CHANGE_ID);

    assert.notEqual(second.id, first.id, "a real change must produce a new readiness row");
    assert.equal(second.status, "blocked");
    const gates = db.select().from(stageGates)
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Merge")))
      .all();
    assert.equal(gates.length, 2, "a real change must write a second Merge gate row");
  });
});
