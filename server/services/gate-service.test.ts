import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "node:child_process";

import { db } from "../db/index.ts";
import {
  artifacts,
  artifactMirrors,
  battleRounds,
  blueGapReviews,
  buildRunRecords,
  changes,
  events,
  findings,
  humanDecisions,
  legacyImports,
  mergeApprovals,
  mergeBlockers,
  mergeDecisions,
  mergeReadiness,
  projects,
  redFixClaims,
  briefingQuestions,
  prdBriefings,
  prdDrafts,
  qaCommandResults,
  qaEvidence,
  qaFailures,
  qaRuns,
  requirementGaps,
  reviewArtifactMirrors,
  reviewAttempts,
  reviewPriorFindingReviews,
  reviewReports,
  reviewState,
  runs,
  stageActions,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
  warReports,
} from "../db/schema.ts";
import type { ChangeStatus } from "../types/enums.ts";
import {
  approveGate,
  canMerge,
  gateApprovalActionId,
  getGateStatus,
  rejectGate,
  type GateName,
} from "./gate-service.ts";
import { getActions } from "./action-contract-service.ts";
import { computeSourceDbHash, recomputeStageGate, type PipelinePhase } from "./stage-authority-service.ts";
import { setReviewQaGateHeadProbeForTest } from "./review-qa-gate-service.ts";
import { setMergeReadinessHeadProbeForTest } from "./merge-readiness-service.ts";
import { generateSpecReport } from "./spec-battle-report-service.ts";
import {
  applySpecBattleDecision,
  claimSpecBattleRedRun,
  completeBlueCritique,
  completeRedSpecRound,
  startSpecBattleRound,
} from "./spec-battle-service.ts";
import { writeBuildRun, type BuildRunFile } from "./build-workspace-service.ts";

const PROJECT_ID = "PRJ-T31";
const CHANGE_ID = "CHG-T31";

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
  db.delete(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).run();
  db.delete(stageActions).where(eq(stageActions.changeId, CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
  db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
  db.delete(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
  db.delete(warReports).where(eq(warReports.changeId, CHANGE_ID)).run();
  db.delete(redFixClaims).where(eq(redFixClaims.changeId, CHANGE_ID)).run();
  db.delete(blueGapReviews).where(eq(blueGapReviews.changeId, CHANGE_ID)).run();
  db.delete(requirementGaps).where(eq(requirementGaps.changeId, CHANGE_ID)).run();
  db.delete(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).run();
  const reviewAttemptIds = db
    .select({ id: reviewAttempts.id })
    .from(reviewAttempts)
    .where(eq(reviewAttempts.changeId, CHANGE_ID))
    .all()
    .map((row) => row.id);
  for (const attemptId of reviewAttemptIds) {
    db.delete(reviewPriorFindingReviews)
      .where(eq(reviewPriorFindingReviews.attemptId, attemptId))
      .run();
  }
  db.delete(reviewArtifactMirrors).where(eq(reviewArtifactMirrors.changeId, CHANGE_ID)).run();
  db.delete(reviewState).where(eq(reviewState.changeId, CHANGE_ID)).run();
  db.delete(reviewReports).where(eq(reviewReports.changeId, CHANGE_ID)).run();
  db.delete(findings).where(eq(findings.changeId, CHANGE_ID)).run();
  db.delete(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).run();
  db.delete(buildRunRecords).where(eq(buildRunRecords.changeId, CHANGE_ID)).run();
  db.delete(humanDecisions).where(eq(humanDecisions.changeId, CHANGE_ID)).run();
  db.delete(legacyImports).where(eq(legacyImports.changeId, CHANGE_ID)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(prdDrafts).where(eq(prdDrafts.changeId, CHANGE_ID)).run();
  db.delete(briefingQuestions).where(eq(briefingQuestions.changeId, CHANGE_ID)).run();
  db.delete(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(repoPath: string, status: ChangeStatus) {
  const now = new Date().toISOString();
  fs.mkdirSync(repoPath, { recursive: true });
  fs.writeFileSync(path.join(repoPath, ".gitignore"), ".ship/\n");
  execSync("git init -q && git add .gitignore && git -c user.email=test@example.com -c user.name=Test commit -qm init", {
    cwd: repoPath,
  });
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Gate T3.1",
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
    title: "Gate change",
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

function writeChangeFile(repoPath: string, fileName: string) {
  const filePath = path.join(repoPath, ".ship", "changes", CHANGE_ID, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `# ${fileName}\n`);
}

function makeBuildRun(overrides: Partial<BuildRunFile> = {}): BuildRunFile {
  const now = new Date().toISOString();
  return {
    changeId: CHANGE_ID,
    runNumber: 1,
    status: "adopted",
    baseCommit: null,
    workspacePath: "/tmp/gate-build",
    branchName: `stagepass/build/${CHANGE_ID}/build-1`,
    expectedFiles: [],
    forbiddenFiles: [],
    changedFiles: ["src/app.ts"],
    deviations: [],
    blockers: [],
    patchPath: null,
    patchSha256: null,
    adoptedHeadSha: "b".repeat(40),
    approvalPath: null,
    diffPath: null,
    auditPath: null,
    reportPath: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function seedAdoptedBuild(repoPath: string) {
  const run = makeBuildRun();
  writeBuildRun(repoPath, run);
  const now = new Date().toISOString();
  db.insert(buildRunRecords).values({
    id: "BRR-T31-1",
    changeId: CHANGE_ID,
    runId: null,
    buildRunId: "build-1",
    status: "adopted",
    headSha: run.adoptedHeadSha,
    baseHeadSha: "a".repeat(40),
    baseCommit: "a".repeat(40),
    patchHash: "patch-hash-t31",
    changedFilesHash: "changed-files-hash-t31",
    adoptedHeadSha: run.adoptedHeadSha,
    adoptionDecisionId: "HD-T31-BUILD",
    adoptedAt: run.updatedAt,
    artifactHash: run.patchSha256,
    source: "test",
    createdAt: now,
    updatedAt: now,
  }).run();
}

function seedQaPassed() {
  const now = new Date().toISOString();
  db.insert(qaRuns).values({
    id: "QA-T31",
    changeId: CHANGE_ID,
    sourceReviewReportId: "RRP-T31",
    sourceBuildRunId: "build-1",
    sourceHeadSha: "b".repeat(40),
    status: "passed",
    startedAt: now,
    completedAt: now,
  }).run();
  db.insert(qaCommandResults).values({
    id: "QA-CMD-T31",
    qaRunId: "QA-T31",
    command: "npm test",
    commandOrder: 1,
    status: "passed",
    exitCode: 0,
    durationMs: 10,
    outputArtifactMirrorId: null,
    completedAt: now,
  }).run();
}

function seedMergeApproval() {
  const now = new Date().toISOString();
  db.insert(humanDecisions).values({
    id: "HD-T31-MERGE",
    changeId: CHANGE_ID,
    roundId: null,
    gate: "merge",
    action: "approve_merge",
    targetType: "change",
    targetId: CHANGE_ID,
    reason: "ship",
    reportHash: null,
    createdBy: "human",
    createdAt: now,
  }).run();
  db.insert(mergeApprovals).values({
    id: "MAP-T31",
    changeId: CHANGE_ID,
    decisionId: "HD-T31-MERGE",
    actor: "human",
    approvedAt: now,
  }).run();
}

function seedStageGate(phase: PipelinePhase, status = "passed") {
  recomputeStageGate({
    changeId: CHANGE_ID,
    phase,
    status,
    blockers: [],
    freshness: { fresh: true },
    requiredActions: [],
    rows: [{ table: "changes", id: CHANGE_ID, phase }],
  });
}

function seedRequiredMergeGates(overrides: Partial<Record<PipelinePhase, string>> = {}) {
  for (const phase of ["PRD", "Spec", "Plan", "TestPlan", "Build", "Review", "QA"] as PipelinePhase[]) {
    seedStageGate(phase, overrides[phase] ?? "passed");
  }
}

function seedMergeReadyFacts(repoPath: string) {
  seedRequiredMergeGates();
  seedAdoptedBuild(repoPath);
  seedReviewRun();
  seedQaPassed();
  seedMergeApproval();
}

function seedLockedPrdBaseline() {
  const now = new Date().toISOString();
  const briefing = {
    id: "PBR-T31",
    changeId: CHANGE_ID,
    status: "locked",
    intentText: "Gate service locked PRD.",
    finalReviewJson: JSON.stringify({ verdict: "ready" }),
    sourceHashesJson: JSON.stringify({ input: "gate-t31" }),
    lockedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const question = {
    id: "BQ-T31",
    changeId: CHANGE_ID,
    category: "scope",
    severity: "important",
    question: "What is the release owner?",
    whyItMatters: "Ownership affects merge approval.",
    suggestedDefault: "Project owner.",
    status: "deferred",
    answer: "Project owner.",
    source: "ai_blue",
    createdAt: now,
    updatedAt: now,
  };
  const draft = {
    id: "PDR-T31",
    changeId: CHANGE_ID,
    version: 1,
    markdown: "# PRD\n\nGate service fixture.\n",
    sourceQuestionIdsJson: JSON.stringify([question.id]),
    unresolvedQuestionIdsJson: JSON.stringify([question.id]),
    draftHash: "prd-draft-t31",
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
    status: "passed",
    blockers: [],
    freshness: { fresh: true },
    requiredActions: [],
    sourceDbHash,
    rows: [
      { table: "prd_briefings", row: briefing },
      { table: "briefing_questions", rows: [question] },
      { table: "prd_drafts.latest", row: draft },
    ],
  });
}

function currentStatus(): ChangeStatus {
  const row = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
  assert.ok(row);
  return row.status as ChangeStatus;
}

function approvalPreflight(gate: GateName) {
  const actionId = gateApprovalActionId(gate);
  const action = getActions(CHANGE_ID).find((candidate) => candidate.actionId === actionId);
  assert.ok(action, `${actionId} action should exist`);
  return {
    expectedGateVersion: action.gateVersion,
    expectedSourceDbHash: action.sourceDbHash,
    idempotencyKey: `${actionId}-test-key`,
  };
}

async function approveGateWithContract(gate: GateName) {
  await approveGate(CHANGE_ID, gate, approvalPreflight(gate));
}

function seedOpenReviewP0() {
  seedReviewRun("RUN-T31", "passed", 1);
  db.insert(findings).values({
    id: "FND-T31",
    changeId: CHANGE_ID,
    runId: "RUN-T31",
    source: "review",
    severity: "P0",
    category: "logic",
    title: "review blocker",
    file: "src/app.ts",
    line: null,
    evidence: "review evidence",
    requiredFix: "fix the P0",
    status: "open",
    reviewAttemptId: "RAT-T31",
    sourceBuildRunId: "build-1",
    sourceHeadSha: "b".repeat(40),
    createdAt: new Date().toISOString(),
  }).run();
}

function seedReviewRun(runId = "RUN-T31", reviewStatus = "passed", findingCount = 0) {
  const now = new Date().toISOString();
  db.insert(runs).values({
    id: runId,
    changeId: CHANGE_ID,
    phase: "review",
    status: reviewStatus === "failed" || reviewStatus === "data_inconsistent" ? "failed" : "completed",
    startedAt: now,
    endedAt: now,
    summary: JSON.stringify({
      reviewStatus,
      provider: "codex",
      errorCode: reviewStatus === "passed" ? null : reviewStatus,
      sanitizedErrorSummary: null,
      sourceBuildRunId: "build-1",
      reportPath: null,
      findingsPath: null,
      rawOutputPath: null,
      errorMessage: null,
      findingCount,
      summary: "seeded review",
    }),
  }).run();
  db.insert(reviewAttempts).values({
    id: "RAT-T31",
    changeId: CHANGE_ID,
    runId,
    attemptNo: 1,
    status: reviewStatus === "running" ? "running" : "completed",
    provider: "codex",
    reviewStatus,
    idempotencyKey: "seed-review",
    sourceBuildRunId: "build-1",
    sourceHeadSha: "b".repeat(40),
    priorBlockingFindingIdsJson: null,
    rawOutputArtifactId: null,
    errorCode: null,
    sanitizedErrorSummary: null,
    startedAt: now,
    endedAt: reviewStatus === "running" ? null : now,
    completedAt: reviewStatus === "passed" || reviewStatus === "issues_found" ? now : null,
    createdAt: now,
    updatedAt: now,
  }).run();
  const gateStatus =
    reviewStatus === "passed"
      ? "passed"
      : reviewStatus === "issues_found" && findingCount === 0
        ? "passed"
        : reviewStatus === "issues_found"
          ? "blocked_p1"
          : reviewStatus;
  const qaAllowed = gateStatus === "passed" || gateStatus === "passed_with_waived_p1";
  db.insert(reviewReports).values({
    id: "RRP-T31",
    attemptId: "RAT-T31",
    changeId: CHANGE_ID,
    reportVersion: 1,
    reviewConclusion: reviewStatus === "passed" ? "passed" : "issues_found",
    reportDbHash: "review-hash-t31",
    gateStatus,
    qaAllowed: qaAllowed ? 1 : 0,
    sourceBuildRunId: "build-1",
    sourceHeadSha: "b".repeat(40),
    findingVersion: 1,
    waiverVersion: 1,
    blockingP0: 0,
    blockingP1: gateStatus === "blocked_p1" ? 1 : 0,
    waivedP1: 0,
    p2Count: 0,
    findingsDbHash: "findings-hash-t31",
    staleReason: null,
    legacyState: null,
    reportJson: null,
    generatedAt: now,
    createdAt: now,
  }).run();
  db.insert(reviewState).values({
    changeId: CHANGE_ID,
    latestAttemptId: "RAT-T31",
    latestAttemptNo: 1,
    latestReportId: "RRP-T31",
    latestValidReviewReportId: qaAllowed || gateStatus === "blocked_p1" ? "RRP-T31" : null,
    latestValidAttemptNo: qaAllowed || gateStatus === "blocked_p1" ? 1 : null,
    gateStatus,
    reviewStatus,
    sourceBuildRunId: "build-1",
    sourceHeadSha: "b".repeat(40),
    reportDbHash: "review-hash-t31",
    findingVersion: 1,
    waiverVersion: 1,
    updatedAt: now,
  }).run();
}

function seedOpenReviewP1() {
  seedReviewRun("RUN-T31", "issues_found", 1);
  db.insert(findings).values({
    id: "FND-T31-P1",
    changeId: CHANGE_ID,
    runId: "RUN-T31",
    source: "review",
    severity: "P1",
    category: "logic",
    title: "review warning",
    file: "src/app.ts",
    line: null,
    evidence: "review evidence",
    requiredFix: "fix the P1",
    status: "open",
    reviewAttemptId: "RAT-T31",
    sourceBuildRunId: "build-1",
    sourceHeadSha: "b".repeat(40),
    createdAt: new Date().toISOString(),
  }).run();
}

function seedWaivedReviewP1() {
  seedReviewRun("RUN-T31", "issues_found", 1);
  const now = new Date().toISOString();
  db.insert(humanDecisions).values({
    id: "HD-T31-WAIVE",
    changeId: CHANGE_ID,
    roundId: null,
    gate: "review",
    action: "review_p1_waiver",
    targetType: "finding",
    targetId: "FND-T31-P1-WAIVED",
    reason: "accept risk for release",
    reportHash: null,
    createdBy: "human",
    createdAt: now,
  }).run();
  db.insert(findings).values({
    id: "FND-T31-P1-WAIVED",
    changeId: CHANGE_ID,
    runId: "RUN-T31",
    reviewAttemptId: "RAT-T31",
    sourceBuildRunId: "build-1",
    sourceHeadSha: "b".repeat(40),
    source: "review",
    severity: "P1",
    category: "logic",
    title: "accepted review warning",
    file: "src/app.ts",
    line: null,
    evidence: "review evidence",
    requiredFix: "accepted risk",
    status: "waived",
    waivable: 1,
    waivedBy: "human",
    waivedAt: now,
    waiverDecisionId: "HD-T31-WAIVE",
    createdAt: now,
  }).run();
  db.update(reviewReports)
    .set({ gateStatus: "passed_with_waived_p1", qaAllowed: 1, blockingP1: 0, waivedP1: 1 })
    .where(eq(reviewReports.id, "RRP-T31"))
    .run();
  db.update(reviewState)
    .set({ gateStatus: "passed_with_waived_p1" })
    .where(eq(reviewState.changeId, CHANGE_ID))
    .run();
}

function blueJson(severity: "P0" | "P1" | "P2", id = `gap-${severity}`) {
  return JSON.stringify({
    gapReviews: [],
    requirementGaps: [
      {
        canonicalGapId: id,
        title: `${severity} requirement gap`,
        category: "acceptance",
        severity,
        evidence: "missing acceptance",
        affectedArtifacts: ["prd-delta.md"],
        proposedSpecPatch: "add acceptance",
        specBlocking: severity === "P0" || severity === "P1",
        mergeBlocking: severity === "P0" || severity === "P1",
      },
    ],
  });
}

async function seedSpecBattle(severity: "P0" | "P1" | "P2", id = `gap-${severity}`) {
  seedLockedPrdBaseline();
  const round = await startSpecBattleRound(CHANGE_ID);
  claimSpecBattleRedRun({ changeId: CHANGE_ID, idempotencyKey: `gate-test-${round.roundId}` });
  await completeRedSpecRound({ changeId: CHANGE_ID, roundId: round.roundId, markdown: "# Red Spec\n" });
  await completeBlueCritique({ changeId: CHANGE_ID, roundId: round.roundId, blueJson: blueJson(severity, id) });
  await generateSpecReport(CHANGE_ID);
  return round.roundId;
}

describe("gate-service", () => {
  let repoPath: string;
  let restoreHeadProbe: (() => void) | null = null;
  let restoreMergeHeadProbe: (() => void) | null = null;

  beforeEach(() => {
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "gate-t31-"));
    restoreHeadProbe = setReviewQaGateHeadProbeForTest(() => "b".repeat(40));
    restoreMergeHeadProbe = setMergeReadinessHeadProbeForTest(() => "b".repeat(40));
  });

  afterEach(() => {
    restoreMergeHeadProbe?.();
    restoreHeadProbe?.();
    restoreMergeHeadProbe = null;
    restoreHeadProbe = null;
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("reports the current gate and pending artifact", () => {
    seedChange(repoPath, "SPEC_READY");

    const status = getGateStatus(CHANGE_ID);

    assert.equal(status.atGate, true);
    assert.equal(status.gate, "spec");
    assert.equal(status.status, "SPEC_READY");
    assert.match(status.pendingArtifact ?? "", /prd-delta\.md$/);
  });

  it("does not show spec approval as available when no battle round exists", () => {
    seedChange(repoPath, "SPEC_READY");

    const status = getGateStatus(CHANGE_ID);

    assert.equal(status.specBattle?.roundId, null);
    assert.equal(status.specBattle?.actions.approve.available, false);
    assert.equal(status.specBattle?.actions.approve.reason, "not_applicable");
  });

  it("approves intake without leaving the T2.7 stage entry status", async () => {
    seedChange(repoPath, "INTAKE_READY");
    seedStageGate("PRD");

    await approveGateWithContract("intake");

    assert.equal(currentStatus(), "INTAKE_READY");
  });

  it("blocks approval when the DB stage gate is missing", async () => {
    seedChange(repoPath, "INTAKE_READY");

    await assert.rejects(() => approveGate(CHANGE_ID, "intake", approvalPreflight("intake")), {
      name: "PreflightBlockedError",
    });
  });

  it("reports legacy-only gate actions as not authoritative", () => {
    seedChange(repoPath, "INTAKE_READY");
    db.insert(legacyImports).values({
      id: "LEGACY-T31-PRD",
      changeId: CHANGE_ID,
      phase: "PRD",
      sourcePath: path.join(repoPath, ".ship", "changes", CHANGE_ID, "prd-gate.json"),
      sourceArtifactHash: "legacy-prd-hash",
      schemaVersion: "legacy-prd/v1",
      importStatus: "legacy_candidate",
      importResultJson: JSON.stringify({ sourceLineage: { oldRunId: "RUN-OLD" } }),
      importedAt: new Date().toISOString(),
    }).run();

    const status = getGateStatus(CHANGE_ID);
    const approve = status.actions?.find((action) => action.actionId === "approve_intake");

    assert.equal(approve?.enabled, false);
    assert.equal(approve?.reasonCode, "legacy_not_authoritative");
    assert.equal(status.stageAuthority?.latestValidReportId, null);
  });

  it("blocks TechSpec approval when the DB stage gate is missing", async () => {
    seedChange(repoPath, "TECHSPEC_READY");

    await assert.rejects(
      () => approveGate(CHANGE_ID, "tech_spec", approvalPreflight("tech_spec")),
      { name: "PreflightBlockedError" },
    );
  });

  it("blocks TechSpec approval when the DB stage gate is blocked", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    seedStageGate("TechSpec", "blocked");

    await assert.rejects(
      () => approveGate(CHANGE_ID, "tech_spec", approvalPreflight("tech_spec")),
      { name: "PreflightBlockedError" },
    );
  });

  it("allows TechSpec approval only when the DB stage gate passed", async () => {
    seedChange(repoPath, "TECHSPEC_READY");
    seedStageGate("TechSpec");

    await approveGateWithContract("tech_spec");

    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    assert.equal(change?.gateState, "tech_spec");
  });

  it("rejects spec back to the T2.7 spec entry status", async () => {
    seedChange(repoPath, "SPEC_READY");

    await rejectGate(CHANGE_ID, "spec", "needs revision");

    assert.equal(currentStatus(), "INTAKE_READY");
  });

  it("rolls back status and gateState when rejectGate event writing fails", async () => {
    seedChange(repoPath, "SPEC_READY");
    db.update(changes)
      .set({ gateState: "spec" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    db.run(sql`
      CREATE TRIGGER reject_gate_event_fail
      BEFORE INSERT ON events
      WHEN NEW.raw_json LIKE '%reject_gate_test_failure%'
      BEGIN
        SELECT RAISE(ABORT, 'reject gate event failure');
      END;
    `);

    try {
      await assert.rejects(
        () => rejectGate(CHANGE_ID, "spec", "reject_gate_test_failure"),
        /reject gate event failure/,
      );
    } finally {
      db.run(sql`DROP TRIGGER IF EXISTS reject_gate_event_fail`);
    }

    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    assert.equal(change?.status, "SPEC_READY");
    assert.equal(change?.gateState, "spec");
  });

  it("rejects approve outside the requested gate", async () => {
    seedChange(repoPath, "DRAFT");

    seedStageGate("Spec");

    await assert.rejects(
      () => approveGate(CHANGE_ID, "spec", approvalPreflight("spec")),
      { name: "PreflightBlockedError" },
    );
  });

  it("allows merge when QA, review, and docs are complete", () => {
    seedChange(repoPath, "MERGE_READY");
    seedMergeReadyFacts(repoPath);
    writeChangeFile(repoPath, "prd-delta.md");
    writeChangeFile(repoPath, "tech-spec-delta.md");
    writeChangeFile(repoPath, "test-plan-delta.md");

    const checks = canMerge(CHANGE_ID);

    assert.equal(checks.qaPassed, true);
    assert.equal(checks.reviewPassed, true);
    assert.equal(checks.docsComplete, true);
    assert.equal(checks.canMerge, true, JSON.stringify(checks));
    assert.deepEqual(checks.missing, []);
  });

  it("approves merge by writing human approval, merge approval, and merge decision rows", async () => {
    seedChange(repoPath, "MERGE_READY");
    seedRequiredMergeGates();
    seedAdoptedBuild(repoPath);
    seedReviewRun();
    seedQaPassed();

    const approveAction = getActions(CHANGE_ID).find((action) => action.actionId === "approve_merge");
    assert.equal(approveAction?.enabled, true, JSON.stringify(approveAction));

    await approveGateWithContract("merge");

    const approval = db.select().from(mergeApprovals).where(eq(mergeApprovals.changeId, CHANGE_ID)).get();
    const decision = db.select().from(mergeDecisions).where(eq(mergeDecisions.changeId, CHANGE_ID)).get();
    const humanDecision = approval
      ? db.select().from(humanDecisions).where(eq(humanDecisions.id, approval.decisionId)).get()
      : null;
    const mergeAction = getActions(CHANGE_ID).find((action) => action.actionId === "merge");

    assert.ok(approval);
    assert.ok(decision?.readinessId);
    assert.equal(humanDecision?.action, "approve_merge");
    assert.equal(mergeAction?.enabled, true);
  });

  it("blocks merge when a required DB stage gate is missing", () => {
    seedChange(repoPath, "MERGE_READY");
    seedRequiredMergeGates({ QA: "missing" });
    db.delete(stageGates)
      .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "QA")))
      .run();
    seedAdoptedBuild(repoPath);
    seedReviewRun();
    seedQaPassed();
    seedMergeApproval();

    const checks = canMerge(CHANGE_ID);

    assert.equal(checks.canMerge, false);
    assert.equal(checks.missing.includes("qa_gate_missing"), true);
  });

  it("does not use missing .ship docs as merge authority", () => {
    seedChange(repoPath, "MERGE_READY");
    seedMergeReadyFacts(repoPath);

    const checks = canMerge(CHANGE_ID);

    assert.equal(checks.docsComplete, true);
    assert.equal(checks.canMerge, true, JSON.stringify(checks));
    assert.equal(checks.missing.includes("test-plan-delta.md"), false);
  });

  it("blocks merge when an open P0 review finding exists", () => {
    seedChange(repoPath, "MERGE_READY");
    seedRequiredMergeGates();
    seedAdoptedBuild(repoPath);
    seedOpenReviewP0();
    seedQaPassed();
    seedMergeApproval();

    const checks = canMerge(CHANGE_ID);

    assert.equal(checks.reviewPassed, false);
    assert.equal(checks.canMerge, false);
    assert.equal(checks.missing.includes("review_open_p0"), true);
  });

  it("blocks merge when an open P1 review finding exists", () => {
    seedChange(repoPath, "MERGE_READY");
    seedRequiredMergeGates();
    seedAdoptedBuild(repoPath);
    seedOpenReviewP1();
    seedQaPassed();
    seedMergeApproval();

    const checks = canMerge(CHANGE_ID);

    assert.equal(checks.reviewPassed, false);
    assert.equal(checks.canMerge, false);
    assert.equal(checks.missing.includes("review_open_p1"), true);
  });

  it("allows merge from a fresh waived P1 DB gate while preserving the waived risk count", () => {
    seedChange(repoPath, "MERGE_READY");
    seedRequiredMergeGates();
    seedAdoptedBuild(repoPath);
    seedWaivedReviewP1();
    seedQaPassed();
    seedMergeApproval();

    const checks = canMerge(CHANGE_ID);

    assert.equal(checks.reviewPassed, true);
    assert.equal(checks.reviewStatus, "passed");
    assert.equal(checks.canMerge, true, JSON.stringify(checks));
  });

  it("requires merge checks before approving merge", async () => {
    seedChange(repoPath, "MERGE_READY");
    seedStageGate("Merge");

    await assert.rejects(
      () => approveGate(CHANGE_ID, "merge" as GateName, approvalPreflight("merge")),
      { name: "PreflightBlockedError" },
    );
  });

  it("rejects spec approval when the spec report is stale", async () => {
    seedChange(repoPath, "INTAKE_READY");
    seedStageGate("Spec");
    await seedSpecBattle("P1", "waivable-gap");
    await applySpecBattleDecision({
      changeId: CHANGE_ID,
      action: "waive_p1",
      targetType: "requirement_gap",
      targetId: "waivable-gap",
      reason: "accept risk",
    });

    await assert.rejects(
      () => approveGate(CHANGE_ID, "spec", approvalPreflight("spec")),
      { name: "PreflightBlockedError" },
    );
  });

  it("blocks spec approval when an open P0 requirement gap exists", async () => {
    seedChange(repoPath, "INTAKE_READY");
    seedStageGate("Spec");
    await seedSpecBattle("P0");

    await assert.rejects(
      () => approveGate(CHANGE_ID, "spec", approvalPreflight("spec")),
      { name: "PreflightBlockedError" },
    );
  });

  it("allows spec approval with only P2 and does not start TechSpec", async () => {
    seedChange(repoPath, "INTAKE_READY");
    seedStageGate("Spec");
    await seedSpecBattle("P2");

    await approveGateWithContract("spec");

    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    assert.equal(change?.gateState, "spec");
    assert.equal(change?.status, "SPEC_READY");
  });

  it("blocks merge when merge-blocking requirement gaps exist", async () => {
    seedChange(repoPath, "INTAKE_READY");
    seedStageGate("Spec");
    await seedSpecBattle("P0");
    db.update(changes).set({ status: "MERGE_READY" }).where(eq(changes.id, CHANGE_ID)).run();
    seedRequiredMergeGates();
    seedAdoptedBuild(repoPath);
    seedReviewRun();
    seedQaPassed();
    seedMergeApproval();

    const checks = canMerge(CHANGE_ID);

    assert.equal(checks.requirementGapsPassed, false);
    assert.equal(checks.mergeBlockingRequirementGaps, 1);
    assert.equal(checks.canMerge, false);
    assert.equal(checks.missing.includes("requirement_gap_blocker"), true);
  });

  it("allows overridden P0 through Spec but blocks it at Merge", async () => {
    seedChange(repoPath, "INTAKE_READY");
    seedStageGate("Spec");
    await seedSpecBattle("P0", "overridden-gap");
    db.update(requirementGaps)
      .set({ status: "overridden", specBlocking: 0, mergeBlocking: 1, overrideReason: "phase override" })
      .where(eq(requirementGaps.canonicalGapId, "overridden-gap"))
      .run();
    await generateSpecReport(CHANGE_ID);

    await approveGateWithContract("spec");
    db.update(changes).set({ status: "MERGE_READY" }).where(eq(changes.id, CHANGE_ID)).run();
    seedRequiredMergeGates();
    seedAdoptedBuild(repoPath);
    seedReviewRun();
    seedQaPassed();
    seedMergeApproval();

    const checks = canMerge(CHANGE_ID);

    assert.equal(checks.requirementGapsPassed, false);
    assert.equal(checks.canMerge, false);
  });
});
