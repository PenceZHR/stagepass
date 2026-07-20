import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { eq } from "drizzle-orm";
import fs from "fs";
import os from "os";
import path from "path";
import ts from "typescript";

import { db } from "../db/index.ts";
import {
  battleRounds,
  buildRunRecords,
  changes,
  artifacts,
  artifactMirrors,
  events,
  humanDecisions,
  mergeBlockers,
  mergeDecisions,
  mergeReadiness,
  blueGapReviews,
  briefingQuestions,
  prdBriefings,
  prdDrafts,
  pipelineJobs,
  providerRunProcesses,
  projects,
  redFixClaims,
  requiredValidationCommands,
  requirementGaps,
  reviewAttempts,
  runs,
  stageActions,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
  testplanCoverageItems,
  testplanRiskMappings,
  testplanSnapshots,
  warReports,
} from "../db/schema.ts";
import { getActions } from "./action-contract-service.ts";
import { ActionContractDriftError } from "./job-dispatch-service.ts";
import { assertActionAllowed, PreflightBlockedError } from "./preflight-service.ts";
import { computeSourceDbHash } from "./stage-authority-service.ts";
import { completePrdDraft } from "./prd-briefing-service.ts";
import { writeBuildRun, type BuildRunFile } from "./build-workspace-service.ts";
import {
  setBuildProviderLivenessForTest,
  setBuildStaleRunClockForTest,
} from "./build-stale-run-recovery-service.ts";

const ROUTE_ROOT = path.join(
  process.cwd(),
  "app",
  "api",
  "projects",
  "[id]",
  "changes",
  "[changeId]"
);

const RUNTIME_PROJECT_ID = "PRJ-PIPELINE-ROUTE-T15";
const RUNTIME_CHANGE_ID = "CHG-PIPELINE-ROUTE-T15";

function cleanupRuntimeRows() {
  db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(providerRunProcesses).where(eq(providerRunProcesses.changeId, RUNTIME_CHANGE_ID)).run();
  const readinessRows = db
    .select()
    .from(mergeReadiness)
    .where(eq(mergeReadiness.changeId, RUNTIME_CHANGE_ID))
    .all();
  for (const readiness of readinessRows) {
    db.delete(mergeBlockers).where(eq(mergeBlockers.mergeReadinessId, readiness.id)).run();
    db.delete(mergeDecisions).where(eq(mergeDecisions.readinessId, readiness.id)).run();
  }
  db.delete(mergeReadiness).where(eq(mergeReadiness.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(stageActions).where(eq(stageActions.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(stageReports).where(eq(stageReports.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(stageGates).where(eq(stageGates.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(requiredValidationCommands)
    .where(eq(requiredValidationCommands.changeId, RUNTIME_CHANGE_ID))
    .run();
  const snapshots = db
    .select({ id: testplanSnapshots.id })
    .from(testplanSnapshots)
    .where(eq(testplanSnapshots.changeId, RUNTIME_CHANGE_ID))
    .all();
  for (const snapshot of snapshots) {
    db.delete(testplanRiskMappings).where(eq(testplanRiskMappings.testplanSnapshotId, snapshot.id)).run();
    db.delete(testplanCoverageItems).where(eq(testplanCoverageItems.testplanSnapshotId, snapshot.id)).run();
  }
  db.delete(testplanSnapshots).where(eq(testplanSnapshots.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(humanDecisions).where(eq(humanDecisions.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(buildRunRecords).where(eq(buildRunRecords.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(reviewAttempts).where(eq(reviewAttempts.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(warReports).where(eq(warReports.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(artifactMirrors).where(eq(artifactMirrors.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(redFixClaims).where(eq(redFixClaims.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(blueGapReviews).where(eq(blueGapReviews.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(requirementGaps).where(eq(requirementGaps.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(battleRounds).where(eq(battleRounds.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(prdDrafts).where(eq(prdDrafts.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(briefingQuestions).where(eq(briefingQuestions.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(prdBriefings).where(eq(prdBriefings.changeId, RUNTIME_CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, RUNTIME_CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, RUNTIME_PROJECT_ID)).run();
}

function seedRuntimeChange(input: { status: string; gateState: string | null }) {
  const now = "2026-06-29T15:00:00.000Z";
  const repoPath = path.join(os.tmpdir(), `pipeline-route-runtime-${Date.now()}-${Math.random()}`);
  cleanupRuntimeRows();
  db.insert(projects).values({
    id: RUNTIME_PROJECT_ID,
    name: "Pipeline route runtime",
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
    id: RUNTIME_CHANGE_ID,
    projectId: RUNTIME_PROJECT_ID,
    title: "Pipeline route runtime",
    status: input.status,
    provider: "codex",
    codexThreadId: null,
    fixIterations: 0,
    blockedPhase: null,
    reworkFromPhase: null,
    suspendedByPrd: 0,
    preSuspendStatus: null,
    gitBranch: null,
    gateState: input.gateState,
    docsComplete: 0,
    retroDone: 0,
    createdAt: now,
    updatedAt: now,
  }).run();
  return repoPath;
}

function initRuntimeGitRepo(repoPath: string) {
  fs.mkdirSync(repoPath, { recursive: true });
  execSync("git init -b main", { cwd: repoPath, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: repoPath });
  execSync("git config user.name 'Test User'", { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# runtime route fixture\n");
  execSync("git add .", { cwd: repoPath });
  execSync("git commit -m init", { cwd: repoPath, stdio: "ignore" });
}

function seedRuntimeStageGate(input: {
  id: string;
  phase: string;
  sourceDbHash: string;
  gateVersion: number;
  status?: string;
  blockers?: Array<{ id: string; severity: "P0" | "P1" | "P2"; title: string }>;
}) {
  const sourceRunId = `${input.id}-SOURCE`;
  db.insert(stageRuns).values({
    id: sourceRunId,
    changeId: RUNTIME_CHANGE_ID,
    phase: input.phase,
    attemptNo: input.gateVersion,
    status: "completed",
    idempotencyKey: null,
    inputDbHash: null,
    outputDbHash: input.sourceDbHash,
    sourceLineageJson: "{}",
    errorCode: null,
    startedAt: "2026-06-29T14:59:00.000Z",
    completedAt: "2026-06-29T15:00:00.000Z",
  }).run();
  if (input.phase !== "PRD") {
    const businessRunId = `${input.id}-BUSINESS-RUN`;
    const businessPhase: Record<string, string> = {
      Spec: "spec", TechSpec: "tech_spec", Plan: "generate_plan", TestPlan: "test_plan",
      Build: "implement", Review: "review", QA: "local_check", Merge: "release",
    };
    db.insert(runs).values({
      id: businessRunId,
      changeId: RUNTIME_CHANGE_ID,
      phase: businessPhase[input.phase] ?? input.phase.toLowerCase(),
      status: "completed",
      startedAt: "2026-06-29T14:59:00.000Z",
      endedAt: "2026-06-29T15:00:00.000Z",
      summary: null,
      attemptNo: input.gateVersion,
    }).run();
    db.insert(artifacts).values({
      id: `${input.id}-ARTIFACT`,
      changeId: RUNTIME_CHANGE_ID,
      runId: businessRunId,
      type: `${input.phase.toLowerCase()}_authority`,
      path: `/fixture/${input.id}.json`,
      createdAt: "2026-06-29T15:00:00.000Z",
    }).run();
  }
  db.insert(stageGates).values({
    id: input.id,
    changeId: RUNTIME_CHANGE_ID,
    phase: input.phase,
    status: input.status ?? "passed",
    blockersJson: JSON.stringify(input.blockers ?? []),
    freshnessJson: JSON.stringify({ fresh: true }),
    requiredActionsJson: "[]",
    sourceDbHash: input.sourceDbHash,
    gateVersion: input.gateVersion,
    computedAt: "2026-06-29T15:00:00.000Z",
  }).run();
}

function runtimeRepoPath(): string {
  const project = db.select().from(projects).where(eq(projects.id, RUNTIME_PROJECT_ID)).get();
  assert.ok(project, "runtime project should exist");
  return project.repoPath;
}

function seedRuntimeRunningImplementRun(input: { startedAt: string }) {
  db.insert(runs).values({
    id: "RUN-PIPELINE-ROUTE-T15-BUILD-RUNNING",
    changeId: RUNTIME_CHANGE_ID,
    phase: "implement",
    status: "running",
    startedAt: input.startedAt,
    endedAt: null,
    summary: null,
  }).run();
}

function seedRuntimeBuildRunFile(input: {
  runNumber: number;
  status: BuildRunFile["status"];
  updatedAt: string;
}) {
  const repoPath = runtimeRepoPath();
  writeBuildRun(repoPath, {
    changeId: RUNTIME_CHANGE_ID,
    runNumber: input.runNumber,
    status: input.status,
    purpose: "build",
    baseHeadSha: "a".repeat(40),
    baseCommit: "a".repeat(40),
    workspacePath: path.join(repoPath, ".route-build-workspace", `build-${input.runNumber}`),
    branchName: `stagepass/build/${RUNTIME_CHANGE_ID}/build-${input.runNumber}`,
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

function seedRuntimeLockedPrdAuthority() {
  const now = "2026-06-29T15:00:00.000Z";
  const briefing = {
    id: "PBR-PIPELINE-ROUTE-T15",
    changeId: RUNTIME_CHANGE_ID,
    status: "locked",
    intentText: "Runtime route locked PRD.",
    finalReviewJson: JSON.stringify({
      verdict: "ready",
      blockingQuestionIds: [],
      riskSummary: "No route blockers.",
      recommendedNextAction: "lock_prd",
    }),
    sourceHashesJson: JSON.stringify({
      currentInputHash: "route-prd-input",
      draftInputHash: "route-prd-input",
      finalReviewInputHash: "route-prd-input",
      finalReviewDraftHash: "route-prd-draft",
    }),
    lockedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const question = {
    id: "BQ-PIPELINE-ROUTE-T15",
    changeId: RUNTIME_CHANGE_ID,
    category: "scope",
    severity: "important",
    question: "Who owns route replay?",
    whyItMatters: "Ownership affects acceptance.",
    suggestedDefault: "Project owner.",
    status: "deferred",
    answer: "Route fixture owner.",
    source: "ai_blue",
    createdAt: now,
    updatedAt: now,
  };
  const draft = {
    id: "PDR-PIPELINE-ROUTE-T15",
    changeId: RUNTIME_CHANGE_ID,
    version: 1,
    markdown: "# Runtime Route PRD\n\nFixture PRD.\n",
    sourceQuestionIdsJson: JSON.stringify([question.id]),
    unresolvedQuestionIdsJson: JSON.stringify([question.id]),
    draftHash: "route-prd-draft",
    createdAt: now,
  };
  db.insert(prdBriefings).values(briefing).run();
  db.insert(briefingQuestions).values(question).run();
  db.insert(prdDrafts).values(draft).run();
  const sourceDbHash = computeSourceDbHash({
    changeId: RUNTIME_CHANGE_ID,
    phase: "PRD",
    rows: [
      { table: "prd_briefings", row: briefing },
      { table: "briefing_questions", rows: [question] },
      { table: "prd_drafts.latest", row: draft },
    ],
  });
  seedRuntimeStageGate({
    id: "STG-GATE-PIPELINE-ROUTE-T15-PRD-LOCKED",
    phase: "PRD",
    sourceDbHash,
    gateVersion: 4,
  });
}

function seedRuntimePendingApprovalTestPlanSnapshot() {
  const now = "2026-06-29T15:00:00.000Z";
  const snapshotId = "TPS-PIPELINE-ROUTE-T15-PENDING";
  db.insert(testplanSnapshots).values({
    id: snapshotId,
    changeId: RUNTIME_CHANGE_ID,
    status: "draft",
    testIntent: "legacy route TestPlan awaiting approval",
    schemaVersion: "testplan/v1",
    approvalState: "pending",
    approvedAt: null,
    approvalDecisionId: null,
    snapshotDbHash: "route-testplan-pending-hash",
    createdAt: now,
  }).run();
  db.insert(testplanCoverageItems).values({
    id: "TPC-PIPELINE-ROUTE-T15-1",
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
    id: "TPR-PIPELINE-ROUTE-T15-1",
    testplanSnapshotId: snapshotId,
    coverageItemKey: "coverage-1",
    riskRef: "RISK-1",
    severity: "P1",
    mitigation: "Run the required test command",
    createdAt: now,
  }).run();
  db.insert(requiredValidationCommands).values({
    id: "RVC-PIPELINE-ROUTE-T15-TESTPLAN",
    changeId: RUNTIME_CHANGE_ID,
    phase: "TestPlan",
    sourceSnapshotId: snapshotId,
    command: "npm test",
    commandOrder: 1,
    required: 1,
    createdAt: now,
  }).run();
}

function seedRuntimeSpecBattleRound(status: string) {
  const now = "2026-06-29T15:00:00.000Z";
  db.insert(battleRounds).values({
    id: `BRD-PIPELINE-ROUTE-T15-${status}`,
    changeId: RUNTIME_CHANGE_ID,
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

function seedRuntimeBuildGate() {
  const now = "2026-06-29T15:00:00.000Z";
  const repoPath = path.join(os.tmpdir(), `pipeline-route-t15-${Date.now()}-${Math.random()}`);
  fs.mkdirSync(repoPath, { recursive: true });
  execSync("git init -q", { cwd: repoPath });
  cleanupRuntimeRows();
  db.insert(projects).values({
    id: RUNTIME_PROJECT_ID,
    name: "Pipeline route Task 15",
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
    id: RUNTIME_CHANGE_ID,
    projectId: RUNTIME_PROJECT_ID,
    title: "Reject build stale contract",
    status: "IMPLEMENTING",
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
  db.insert(stageGates).values({
    id: "STG-GATE-PIPELINE-ROUTE-T15-BUILD",
    changeId: RUNTIME_CHANGE_ID,
    phase: "Build",
    status: "passed",
    blockersJson: "[]",
    freshnessJson: JSON.stringify({ fresh: true }),
    requiredActionsJson: "[]",
    sourceDbHash: "build-source-hash",
    gateVersion: 3,
    computedAt: now,
  }).run();
  db.insert(stageStates).values({
    id: "STG-STATE-PIPELINE-ROUTE-T15-BUILD",
    changeId: RUNTIME_CHANGE_ID,
    phase: "Build",
    status: "passed",
    latestRunId: null,
    latestReportId: null,
    latestGateId: "STG-GATE-PIPELINE-ROUTE-T15-BUILD",
    latestValidReportId: null,
    dbHash: "build-source-hash",
    version: 1,
    updatedAt: now,
  }).run();
  db.insert(buildRunRecords).values({
    id: "BRR-PIPELINE-ROUTE-T15-BUILD",
    changeId: RUNTIME_CHANGE_ID,
    runId: null,
    buildRunId: "build-route-t15",
    status: "awaiting_human",
    headSha: null,
    baseHeadSha: null,
    baseCommit: null,
    patchHash: "build-source",
    changedFilesHash: "hash",
    adoptedHeadSha: null,
    adoptionDecisionId: null,
    adoptedAt: null,
    artifactHash: "build-source-hash",
    source: "test",
    createdAt: now,
    updatedAt: now,
  }).run();
}

afterEach(() => {
  cleanupRuntimeRows();
});

describe("v2 pipeline stage routes", () => {
  const routes = [
    { segment: "spec", phase: "spec" },
    { segment: "tech-spec", phase: "tech_spec" },
    { segment: "test-plan", phase: "test_plan" },
    { segment: "release", phase: "release" },
    { segment: "retro", phase: "retro" },
  ];

  for (const route of routes) {
    it(`${route.segment} POST validates before enqueueing a pipeline job`, () => {
      const routePath = path.join(ROUTE_ROOT, route.segment, "route.ts");

      assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
      const content = fs.readFileSync(routePath, "utf-8");

      assert.match(content, /enqueueProviderActionAtomically/);
      assert.match(content, /export async function POST/);
      assert.match(content, /const \{ id: projectId, changeId \} = await params/);
      assert.match(content, /requireProjectChange\(projectId, changeId\)/);
      assert.match(content, new RegExp(`phase: "${route.phase}"`));
      assert.match(content, /jobId: job\.id/);
      assert.match(content, /status: "queued"/);
      assert.match(content, /status: 202/);
      assert.doesNotMatch(content, /setImmediate/);
    });
  }

  it("spec POST preflights run_spec and retry_spec action contracts before async start", () => {
    const routePath = path.join(ROUTE_ROOT, "spec", "route.ts");
    const content = fs.readFileSync(routePath, "utf-8");
    const normalizedContent = content.replace(/\s+/g, " ");

    assert.match(content, /readActionPayload/);
    assert.match(content, /assertRequestActionAllowed/);
    assert.match(content, /actionPreflightErrorResponse/);
    assert.match(content, /function specActionId/);
    assert.match(content, /actionId must be run_spec or retry_spec/);
    assert.match(content, /return "retry_spec"/);
    assert.match(content, /return "run_spec"/);
    assert.match(
      normalizedContent,
      /assertRequestActionAllowed\(\{ changeId, actionId, payload, request \}\); const idempotencyKey = .* enqueueProviderActionAtomically/,
    );
    assert.match(content, /enqueueProviderActionAtomically\(\{/);
    assert.match(content, /phase: "spec"/);
    assert.match(content, /jobId: job\.id/);
    assert.match(content, /status: "queued"/);
    assert.doesNotMatch(content, /runSpec\(/);
    assert.match(content, /status: 202/);
  });

  it("spec POST rejects a drifted preflight contract before starting Spec", async () => {
    seedRuntimeChange({ status: "INTAKE_READY", gateState: "intake" });
    // A bare PRD gate is not enough: the served contract reflects enqueue
    // authority, which requires the locked-briefing PRD source behind the gate.
    seedRuntimeLockedPrdAuthority();
    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "run_spec",
    );
    assert.ok(action);
    assert.equal(action.enabled, true);

    let scheduledSpec = false;
    const originalSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((callback: (...args: unknown[]) => void) => {
      assert.equal(typeof callback, "function");
      scheduledSpec = true;
      return {} as NodeJS.Immediate;
    }) as typeof setImmediate;
    try {
      const { POST } = await import(
        "../../app/api/projects/[id]/changes/[changeId]/spec/route.ts"
      );
      const response = await POST(
        new Request("http://localhost/api/projects/project/changes/change/spec", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionId: "run_spec",
            expectedGateVersion: `${Number(action.gateVersion) - 1}`,
            expectedSourceDbHash: action.sourceDbHash,
            idempotencyKey: "run-spec-drift-route-test",
          }),
        }),
        { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
      );

      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.error, "action_not_allowed");
      assert.equal(body.reasonCode, "gate_version_drift");
      assert.equal(scheduledSpec, false);
    } finally {
      globalThis.setImmediate = originalSetImmediate;
    }
  });

  it("spec POST accepts a valid run_spec payload and reports the queued job", async () => {
    seedRuntimeChange({ status: "INTAKE_READY", gateState: "intake" });
    seedRuntimeLockedPrdAuthority();
    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "run_spec",
    );
    assert.ok(action);
    assert.equal(action.enabled, true);

    const { POST } = await import(
      "../../app/api/projects/[id]/changes/[changeId]/spec/route.ts"
    );
    const response = await POST(
        new Request("http://localhost/api/projects/project/changes/change/spec", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionId: "run_spec",
            expectedGateVersion: action.gateVersion,
            expectedSourceDbHash: action.sourceDbHash,
            idempotencyKey: "run-spec-valid-route-test",
          }),
        }),
        { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
      );

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, true);
    assert.equal(body.status, "queued");
    assert.equal(typeof body.jobId, "string");
    const job = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, body.jobId)).get();
    assert.ok(job);
    assert.equal(job.changeId, RUNTIME_CHANGE_ID);
    assert.equal(job.phase, "spec");
    assert.equal(job.actionId, "run_spec");
    assert.equal(job.idempotencyKey, "run-spec-valid-route-test");
    assert.equal(job.status, "queued");
  });

  it("spec POST uses the header idempotency key to deduplicate queued work", async () => {
    seedRuntimeChange({ status: "INTAKE_READY", gateState: "intake" });
    seedRuntimeLockedPrdAuthority();
    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "run_spec",
    );
    assert.ok(action);
    assert.equal(action.enabled, true);

    const { POST } = await import(
      "../../app/api/projects/[id]/changes/[changeId]/spec/route.ts"
    );
    for (let index = 0; index < 2; index += 1) {
        const response = await POST(
          new Request("http://localhost/api/projects/project/changes/change/spec", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "idempotency-key": "route-header-replay-key",
            },
            body: JSON.stringify({
              actionId: "run_spec",
              expectedGateVersion: action.gateVersion,
              expectedSourceDbHash: action.sourceDbHash,
            }),
          }),
          { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
        );
        assert.equal(response.status, 202);
        const body = await response.json();
        assert.equal(body.accepted, true);
        assert.equal(body.status, "queued");
    }

    const jobs = db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, RUNTIME_CHANGE_ID)).all();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.phase, "spec");
    assert.equal(jobs[0]?.actionId, "run_spec");
    assert.equal(jobs[0]?.idempotencyKey, "route-header-replay-key");
    assert.equal(jobs[0]?.status, "queued");
  });

  it("review POST preflights run_review and retry_review action contracts before starting Review", () => {
    const routePath = path.join(ROUTE_ROOT, "review", "route.ts");
    const content = fs.readFileSync(routePath, "utf-8");
    const requireIndex = content.indexOf("requireProjectChange(projectId, changeId)");
    const readPayloadIndex = content.indexOf("readActionPayload(request)");
    const resolveActionIndex = content.indexOf("reviewActionId(payload.actionId)");
    const assertIndex = content.indexOf("assertRequestActionAllowed({ changeId, actionId, payload, request })");
    const preflightIndex = content.indexOf("preflightReviewRun(changeId)");
    const enqueueIndex = content.indexOf("enqueueProviderActionAtomically({");

    assert.match(content, /import \{ preflightReviewRun \}/);
    assert.match(content, /readActionPayload/);
    assert.match(content, /assertRequestActionAllowed/);
    assert.match(content, /actionPreflightErrorResponse/);
    assert.match(content, /function reviewActionId/);
    assert.match(content, /value === "run_review" \|\| value === "retry_review"/);
    assert.match(content, /actionId must be run_review or retry_review/);
    assert.match(content, /return "run_review"/);
    assert.match(content, /enqueueProviderActionAtomically/);
    assert.match(content, /export async function POST/);
    assert.match(content, /const \{ id: projectId, changeId \} = await params/);
    assert.match(content, /requireProjectChange\(projectId, changeId\)/);
    assert.match(content, /resolveRequestIdempotencyKey/);
    assert.match(content, /idempotencyKey/);
    assert.doesNotMatch(content, /randomUUID/);
    assert.doesNotMatch(content, /function bodyIdempotencyKey/);
    assert.notEqual(requireIndex, -1);
    assert.notEqual(readPayloadIndex, -1);
    assert.notEqual(resolveActionIndex, -1);
    assert.notEqual(assertIndex, -1);
    assert.notEqual(preflightIndex, -1);
    assert.notEqual(enqueueIndex, -1);
    assert.ok(requireIndex < readPayloadIndex);
    assert.ok(readPayloadIndex < resolveActionIndex);
    assert.ok(resolveActionIndex < assertIndex);
    assert.ok(assertIndex < preflightIndex);
    assert.ok(assertIndex < enqueueIndex);
    assert.ok(preflightIndex < enqueueIndex);
    assert.match(content, /preflightReviewRun\(changeId\)/);
    assert.match(content, /phase: "review"/);
    assert.match(content, /jobId: job\.id/);
    assert.match(content, /status: "queued"/);
    assert.match(content, /status: 202/);
    assert.doesNotMatch(content, /startReviewRun/);
    assert.doesNotMatch(content, /runReview\(/);
  });

  it("review POST rejects a disabled run_review contract before creating a review attempt", async () => {
    seedRuntimeChange({ status: "IMPLEMENTED", gateState: null });

    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "run_review",
    );
    assert.ok(action);
    assert.equal(action.enabled, false);
    assert.equal(action.reasonCode, "review_build_adoption_incomplete");

    const { POST } = await import(
      "../../app/api/projects/[id]/changes/[changeId]/review/route.ts"
    );
    const response = await POST(
      new Request("http://localhost/api/projects/project/changes/change/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: "run_review",
          expectedGateVersion: action.gateVersion,
          expectedSourceDbHash: action.sourceDbHash,
          idempotencyKey: "run-review-disabled-route-test",
        }),
      }),
      { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
    );

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "action_not_allowed");
    assert.equal(body.reasonCode, "review_build_adoption_incomplete");
    assert.equal(body.action.actionId, "run_review");
    const attempts = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, RUNTIME_CHANGE_ID))
      .all();
    assert.equal(attempts.length, 0);
  });

  it("maps an atomic Review action-contract drift to a diagnostic 409 response", async () => {
    const { actionPreflightErrorResponse } = await import(
      "../../app/api/projects/[id]/changes/[changeId]/action-preflight.ts"
    );
    const response = actionPreflightErrorResponse(new ActionContractDriftError());
    assert.ok(response);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "action_contract_drift: persisted action contract changed before enqueue",
      reasonCode: "action_contract_drift",
    });
  });

  it("tech-spec POST preflights the TechSpec run action contract before reporting started", () => {
    const routePath = path.join(ROUTE_ROOT, "tech-spec", "route.ts");
    const content = fs.readFileSync(routePath, "utf-8");
    const normalizedContent = content.replace(/\s+/g, " ");

    assert.match(content, /assertActionAllowed/);
    assert.match(content, /PreflightBlockedError/);
    assert.match(content, /PreflightValidationError/);
    assert.match(content, /getSpecBattleState/);
    assert.match(content, /requireProjectChange\(projectId, changeId\)/);
    assert.match(content, /if \(guard\.response\) return guard\.response;/);
    assert.match(content, /const change = guard\.change/);
    assert.match(content, /function techSpecActionId/);
    assert.match(content, /value === "run_tech_spec" \|\| value === "retry_tech_spec"/);
    assert.match(content, /expectedGateVersion/);
    assert.match(content, /expectedSourceDbHash/);
    assert.match(content, /idempotencyKey/);
    assert.match(content, /request\.headers\.get\("idempotency-key"\)/);
    assert.match(content, /request\.headers\.get\("x-idempotency-key"\)/);
    assert.match(normalizedContent, /await assertActionAllowedAsync\(\{ changeId, actionId,/);
    assert.match(normalizedContent, /const battle = getSpecBattleState\(changeId\); if \(change\.gateState !== "spec" \|\| battle\.latestRound\?\.status !== "closed"\)/);
    assert.match(content, /Spec gate is not approved/);
    assert.match(content, /spec_gate_unapproved/);
    assert.match(content, /spec_battle_not_closed/);
    assert.match(normalizedContent, /assertActionAllowedAsync\([\s\S]*enqueueProviderActionAtomically\(\{/);
    assert.match(content, /phase: "tech_spec"/);
    assert.match(content, /jobId: job\.id/);
    assert.doesNotMatch(content, /runTechSpec\(/);
    assert.match(content, /NextResponse\.json\(err\.envelope, \{ status: err\.status \}\)/);
    assert.match(content, /status:\s*422/);
    assert.match(content, /status:\s*202/);
  });

  it("tech-spec POST rejects a run contract when the Spec Battle is not closed", async () => {
    seedRuntimeChange({ status: "SPEC_READY", gateState: "spec" });
    seedRuntimeStageGate({
      id: "STG-GATE-PIPELINE-ROUTE-T15-SPEC",
      phase: "Spec",
      sourceDbHash: "spec-source-hash",
      gateVersion: 4,
    });
    seedRuntimeSpecBattleRound("report_ready");

    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "run_tech_spec"
    );
    assert.ok(action);
    assert.equal(action.enabled, false);
    assert.equal(action.reasonCode, "spec_battle_not_closed");

    const { POST } = await import(
      "../../app/api/projects/[id]/changes/[changeId]/tech-spec/route.ts"
    );
    const response = await POST(
      new Request("http://localhost/api/projects/project/changes/change/tech-spec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: "run_tech_spec",
          expectedGateVersion: action.gateVersion,
          expectedSourceDbHash: action.sourceDbHash,
          idempotencyKey: "run-tech-spec-route-test",
        }),
      }),
      { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) }
    );

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "action_not_allowed");
    assert.equal(body.reasonCode, "spec_battle_not_closed");
  });

  it("approve-plan POST uses Preflight contract and idempotency before approving", () => {
    const routePath = path.join(ROUTE_ROOT, "approve-plan", "route.ts");
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /assertActionAllowed/);
    assert.match(content, /PreflightBlockedError/);
    assert.match(content, /PreflightValidationError/);
    assert.match(content, /actionId:\s*"approve_plan"/);
    assert.match(content, /normalizePreflightField/);
    assert.match(content, /typeof value === "number"/);
    assert.match(content, /String\(value\)/);
    assert.match(content, /expectedGateVersion/);
    assert.match(content, /expectedSourceDbHash/);
    assert.match(content, /idempotencyKey/);
    assert.match(content, /request\.headers\.get\("idempotency-key"\)/);
    assert.match(content, /request\.headers\.get\("x-idempotency-key"\)/);
    assert.match(content, /p1_waivers_must_use_plan_decision/);
    assert.match(content, /reasonCode:\s*"p1_waivers_must_use_plan_decision"/);
    assert.match(content, /status:\s*422/);
    assert.match(content, /status:\s*err\.status/);
    assert.match(content, /NextResponse\.json\(err\.envelope/);
    assert.match(content.replace(/\s+/g, " "), /await assertActionAllowedAsync\(\{ changeId, actionId: "approve_plan"/);
    assert.match(content.replace(/\s+/g, " "), /assertActionAllowedAsync\([\s\S]*await approvePlan\(changeId, \{ source: "route_preflight" \}\)/);
    assert.doesNotMatch(content, /waivePlanRisk/);
    assert.doesNotMatch(content, /regeneratePlanReport/);
  });

  it("approve-plan POST rejects inline P1 waivers before action preflight side effects", async () => {
    seedRuntimeChange({ status: "PLAN_READY", gateState: null });

    const { POST } = await import(
      "../../app/api/projects/[id]/changes/[changeId]/approve-plan/route.ts"
    );
    const response = await POST(
      new Request("http://localhost/api/projects/project/changes/change/approve-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p1Waivers: [] }),
      }),
      { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) }
    );

    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.reasonCode, "p1_waivers_must_use_plan_decision");
    const actions = db
      .select()
      .from(stageActions)
      .where(eq(stageActions.changeId, RUNTIME_CHANGE_ID))
      .all();
    assert.equal(actions.length, 0);
  });

  it("release POST preflights Merge readiness and action contract before async start", () => {
    const routePath = path.join(ROUTE_ROOT, "release", "route.ts");
    const content = fs.readFileSync(routePath, "utf-8");
    const normalizedContent = content.replace(/\s+/g, " ");

    assert.match(content, /assertActionAllowed/);
    assert.match(content, /assertCanMerge/);
    assert.match(content, /MergeReadinessError/);
    assert.match(content, /PreflightBlockedError/);
    assert.match(content, /PreflightValidationError/);
    assert.match(content, /actionNotAllowedEnvelope/);
    assert.match(content, /actionId:\s*"merge"/);
    assert.match(content, /normalizePreflightField/);
    assert.match(content, /expectedGateVersion/);
    assert.match(content, /expectedSourceDbHash/);
    assert.match(content, /expectedHeadSha/);
    assert.match(content, /idempotencyKey/);
    assert.match(content, /request\.headers\.get\("idempotency-key"\)/);
    assert.match(content, /request\.headers\.get\("x-idempotency-key"\)/);
    assert.match(normalizedContent, /const actionContract = await assertActionAllowedAsync\(\{ changeId, actionId: "merge"/);
    assert.match(normalizedContent, /assertCanMerge\(\{ changeId, expectedHeadSha \}\); const \{ job \} = enqueueProviderActionAtomically/);
    assert.match(content, /phase: "release"/);
    assert.match(content, /jobId: job\.id/);
    assert.doesNotMatch(content, /runRelease\(/);
    assert.match(content, /NextResponse\.json\(err\.envelope, \{ status: err\.status \}\)/);
    assert.match(content, /err instanceof MergeReadinessError/);
    assert.match(content, /reasonCode = err\.readiness\.blockers\[0\]\?\.reasonCode/);
    assert.match(content, /actionNotAllowedEnvelope\(changeId, "merge"/);
    assert.match(content, /status:\s*409/);
    assert.match(content, /status:\s*422/);
    assert.match(content, /Invalid JSON body/);
  });

  it("test-plan POST preflights run_test_plan and retry_test_plan before async start", () => {
    const testPlanContent = fs.readFileSync(path.join(ROUTE_ROOT, "test-plan", "route.ts"), "utf-8");
    const normalizedContent = testPlanContent.replace(/\s+/g, " ");
    const requireIndex = testPlanContent.indexOf("requireProjectChange(projectId, changeId)");
    const readPayloadIndex = testPlanContent.indexOf("readActionPayload(request)");
    const resolveActionIndex = testPlanContent.indexOf("testPlanActionId(payload.actionId)");
    const assertIndex = testPlanContent.indexOf("assertRequestActionAllowed({ changeId, actionId, payload, request })");
    const enqueueIndex = testPlanContent.indexOf("enqueueProviderActionAtomically({");

    assert.match(testPlanContent, /readActionPayload/);
    assert.match(testPlanContent, /assertRequestActionAllowed/);
    assert.match(testPlanContent, /actionPreflightErrorResponse/);
    assert.match(testPlanContent, /function testPlanActionId/);
    assert.match(testPlanContent, /value === "run_test_plan" \|\| value === "retry_test_plan"/);
    assert.match(testPlanContent, /actionId must be run_test_plan or retry_test_plan/);
    assert.match(testPlanContent, /return "run_test_plan"/);
    assert.match(testPlanContent, /"retry_test_plan"/);
    assert.match(testPlanContent, /enqueueProviderActionAtomically/);
    assert.match(testPlanContent, /phase: "test_plan"/);
    assert.match(testPlanContent, /jobId: job\.id/);
    assert.match(testPlanContent, /status: "queued"/);
    assert.doesNotMatch(testPlanContent, /setImmediate/);
    assert.doesNotMatch(testPlanContent, /runTestPlan\(/);
    assert.match(testPlanContent, /status: 202/);
    assert.match(testPlanContent, /status: 400/);
    assert.doesNotMatch(testPlanContent, /TestPlan requires PLAN_APPROVED/);
    assert.notEqual(requireIndex, -1);
    assert.notEqual(readPayloadIndex, -1);
    assert.notEqual(resolveActionIndex, -1);
    assert.notEqual(assertIndex, -1);
    assert.notEqual(enqueueIndex, -1);
    assert.ok(requireIndex < readPayloadIndex);
    assert.ok(readPayloadIndex < resolveActionIndex);
    assert.ok(resolveActionIndex < assertIndex);
    assert.ok(assertIndex < enqueueIndex);
    assert.match(normalizedContent, /assertRequestActionAllowed\(\{ changeId, actionId, payload, request \}\); const idempotencyKey = .* enqueueProviderActionAtomically/);
  });

  it("test-plan POST rejects a drifted retry_test_plan contract before starting TestPlan", async () => {
    seedRuntimeChange({ status: "PLAN_APPROVED", gateState: null });
    seedRuntimeStageGate({
      id: "STG-GATE-PIPELINE-ROUTE-T15-PLAN-TESTPLAN",
      phase: "Plan",
      sourceDbHash: "plan-source-hash",
      gateVersion: 5,
    });
    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "retry_test_plan",
    );
    assert.ok(action);
    assert.equal(action.enabled, true);

    let scheduledTestPlan = false;
    const originalSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((callback: (...args: unknown[]) => void) => {
      assert.equal(typeof callback, "function");
      scheduledTestPlan = true;
      return {} as NodeJS.Immediate;
    }) as typeof setImmediate;
    try {
      const { POST } = await import(
        "../../app/api/projects/[id]/changes/[changeId]/test-plan/route.ts"
      );
      const response = await POST(
        new Request("http://localhost/api/projects/project/changes/change/test-plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionId: "retry_test_plan",
            expectedGateVersion: `${Number(action.gateVersion) - 1}`,
            expectedSourceDbHash: action.sourceDbHash,
            idempotencyKey: "retry-test-plan-drift-route-test",
          }),
        }),
        { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
      );

      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.error, "action_not_allowed");
      assert.equal(body.reasonCode, "gate_version_drift");
      assert.equal(body.action.actionId, "retry_test_plan");
      assert.equal(scheduledTestPlan, false);
    } finally {
      globalThis.setImmediate = originalSetImmediate;
    }
  });

  it("test-plan POST rejects missing idempotency before starting TestPlan", async () => {
    seedRuntimeChange({ status: "PLAN_APPROVED", gateState: null });
    seedRuntimeStageGate({
      id: "STG-GATE-PIPELINE-ROUTE-T15-PLAN-TESTPLAN-IDEMPOTENCY",
      phase: "Plan",
      sourceDbHash: "plan-source-hash",
      gateVersion: 5,
    });
    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "run_test_plan",
    );
    assert.ok(action);
    assert.equal(action.enabled, true);

    let scheduledTestPlan = false;
    const originalSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((callback: (...args: unknown[]) => void) => {
      assert.equal(typeof callback, "function");
      scheduledTestPlan = true;
      return {} as NodeJS.Immediate;
    }) as typeof setImmediate;
    try {
      const { POST } = await import(
        "../../app/api/projects/[id]/changes/[changeId]/test-plan/route.ts"
      );
      const response = await POST(
        new Request("http://localhost/api/projects/project/changes/change/test-plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionId: "run_test_plan",
            expectedGateVersion: action.gateVersion,
            expectedSourceDbHash: action.sourceDbHash,
          }),
        }),
        { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
      );

      assert.equal(response.status, 422);
      const body = await response.json();
      assert.equal(body.reasonCode, "missing_idempotency_key");
      assert.equal(scheduledTestPlan, false);
    } finally {
      globalThis.setImmediate = originalSetImmediate;
    }
  });

  it("implement POST routes reject illegal statuses before async start", () => {
    const implementContent = fs.readFileSync(path.join(ROUTE_ROOT, "implement", "route.ts"), "utf-8");

    assert.match(implementContent, /requireProjectChange/);
    assert.match(implementContent, /readActionPayload/);
    assert.match(implementContent, /assertRequestActionAllowed/);
    assert.match(implementContent, /actionPreflightErrorResponse/);
    assert.match(implementContent, /function implementActionId/);
    assert.match(implementContent, /actionId must be run_build or retry_build/);
    assert.match(implementContent, /return "run_build"/);
    assert.match(implementContent, /"retry_build"/);
    assert.doesNotMatch(implementContent, /BUILD_START_STATUSES/);
    assert.doesNotMatch(implementContent, /change\.status !== "PLAN_APPROVED"/);
    assert.doesNotMatch(implementContent, /Build requires PLAN_APPROVED or TESTPLAN_DONE/);
    assert.match(implementContent, /status: 409/);
    assert.match(implementContent, /checkGitBaseCamp/);
    assert.match(implementContent, /changeArtifactIgnoredPrefixes\(changeId\)/);
    assert.match(implementContent, /Build workspace base camp blocked/);
    assert.doesNotMatch(implementContent, /baseCamp\.status !== "ready"/);
    assert.match(implementContent, /baseCamp\.blockers\.length > 0/);
    assert.match(implementContent, /!baseCamp\.headSha/);
    assert.match(implementContent, /baseCamp\.blockers/);
    assert.match(implementContent, /enqueueProviderActionAtomically/);
    assert.match(implementContent, /const actionId = implementActionId\(payload\.actionId\)/);
    assert.match(implementContent, /assertRetryBuildCanStart\(guard\.change\.status, changeId\)/);
    assert.match(implementContent, /phase: "implement"/);
    assert.match(implementContent, /jobId: job\.id/);
    assert.match(implementContent, /status: "queued"/);
    assert.doesNotMatch(implementContent, /runImplementStreamed|retryBuildStreamed|setImmediate/);
  });

  it("implement POST rejects a disabled run_build contract before checking base camp or starting Build", async () => {
    seedRuntimeChange({ status: "TESTPLAN_DONE", gateState: null });

    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "run_build",
    );
    assert.ok(action);
    assert.equal(action.enabled, false);
    assert.equal(action.reasonCode, "not_at_gate");

    const { POST } = await import(
      "../../app/api/projects/[id]/changes/[changeId]/implement/route.ts"
    );
    const response = await POST(
      new Request("http://localhost/api/projects/project/changes/change/implement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedGateVersion: action.gateVersion,
          expectedSourceDbHash: action.sourceDbHash,
          idempotencyKey: "run-build-disabled-route-test",
        }),
      }),
      { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
    );

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "action_not_allowed");
    assert.equal(body.reasonCode, "not_at_gate");
    assert.equal(body.action.actionId, "run_build");
    const implementRuns = db
      .select()
      .from(runs)
      .where(eq(runs.changeId, RUNTIME_CHANGE_ID))
      .all()
      .filter((run) => run.phase === "implement");
    assert.equal(implementRuns.length, 0);
  });

  it("implement POST rejects TESTPLAN_DONE even with a passed TestPlan contract", async () => {
    const repoPath = seedRuntimeChange({ status: "TESTPLAN_DONE", gateState: null });
    initRuntimeGitRepo(repoPath);
    seedRuntimeStageGate({
      id: "STG-GATE-PIPELINE-ROUTE-T15-TESTPLAN",
      phase: "TestPlan",
      sourceDbHash: "testplan-source-hash",
      gateVersion: 8,
    });

    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "run_build",
    );
    assert.ok(action);
    assert.equal(action.enabled, false);
    assert.equal(action.reasonCode, "not_at_gate");

    const originalSetImmediate = globalThis.setImmediate;
    let scheduledBuild = false;
    globalThis.setImmediate = ((callback: (...args: unknown[]) => void) => {
      assert.equal(typeof callback, "function");
      scheduledBuild = true;
      return {} as NodeJS.Immediate;
    }) as typeof setImmediate;
    try {
      const { POST } = await import(
        "../../app/api/projects/[id]/changes/[changeId]/implement/route.ts"
      );
      const response = await POST(
        new Request("http://localhost/api/projects/project/changes/change/implement", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedGateVersion: action.gateVersion,
            expectedSourceDbHash: action.sourceDbHash,
            idempotencyKey: "run-build-enabled-route-test",
          }),
        }),
        { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
      );

      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.error, "action_not_allowed");
      assert.equal(body.reasonCode, "not_at_gate");
      assert.equal(scheduledBuild, false);
    } finally {
      globalThis.setImmediate = originalSetImmediate;
    }
  });

  it("implement POST enqueues retry_build for worker execution", async () => {
    const repoPath = seedRuntimeChange({ status: "IMPLEMENTING", gateState: null });
    initRuntimeGitRepo(repoPath);
    seedRuntimeStageGate({
      id: "STG-GATE-BUILD-RETRY",
      phase: "TestPlan",
      sourceDbHash: "testplan-source-hash",
      gateVersion: 8,
    });
    seedRuntimeRunningImplementRun({ startedAt: "2026-07-07T16:11:18.181Z" });
    seedRuntimeBuildRunFile({
      runNumber: 1,
      status: "running",
      updatedAt: "2026-07-07T16:11:18.317Z",
    });
    const restoreClock = setBuildStaleRunClockForTest(() => new Date("2026-07-08T01:00:00.000Z"));
    const restoreLiveness = setBuildProviderLivenessForTest(() => false);
    const action = getActions(RUNTIME_CHANGE_ID).find((candidate) => candidate.actionId === "retry_build");
    assert.ok(action);
    assert.equal(action.enabled, true);

    try {
      const { POST } = await import(
        "../../app/api/projects/[id]/changes/[changeId]/implement/route.ts"
      );
      const response = await POST(
        new Request("http://localhost/api/projects/project/changes/change/implement", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionId: "retry_build",
            expectedGateVersion: action.gateVersion,
            expectedSourceDbHash: action.sourceDbHash,
            idempotencyKey: "retry-build-route-test",
          }),
        }),
        { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
      );

      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.accepted, true);
      assert.equal(body.status, "queued");
      const job = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, body.jobId)).get();
      assert.ok(job);
      assert.equal(job.phase, "implement");
      assert.equal(job.actionId, "retry_build");
      assert.equal(job.idempotencyKey, "retry-build-route-test");
      assert.equal(job.status, "queued");
    } finally {
      restoreLiveness();
      restoreClock();
    }
  });

  it("implement POST rejects retry_build before scheduling when an old Build still has a live provider", async () => {
    const repoPath = seedRuntimeChange({ status: "IMPLEMENTING", gateState: null });
    initRuntimeGitRepo(repoPath);
    seedRuntimeStageGate({
      id: "STG-GATE-BUILD-RETRY-ACTIVE",
      phase: "TestPlan",
      sourceDbHash: "testplan-source-hash",
      gateVersion: 8,
    });
    seedRuntimeRunningImplementRun({ startedAt: "2026-07-07T16:11:18.181Z" });
    seedRuntimeBuildRunFile({
      runNumber: 1,
      status: "running",
      updatedAt: "2026-07-07T16:11:18.317Z",
    });
    const restoreClock = setBuildStaleRunClockForTest(() => new Date("2026-07-08T01:00:00.000Z"));
    const restoreLiveness = setBuildProviderLivenessForTest(() => true);

    const action = getActions(RUNTIME_CHANGE_ID).find((candidate) => candidate.actionId === "retry_build");
    assert.ok(action);
    assert.equal(action.enabled, false);
    assert.equal(action.reasonCode, "build_run_running");

    let scheduled = false;
    const originalSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((callback: (...args: unknown[]) => void) => {
      assert.equal(typeof callback, "function");
      scheduled = true;
      return {} as NodeJS.Immediate;
    }) as typeof setImmediate;
    try {
      const { POST } = await import(
        "../../app/api/projects/[id]/changes/[changeId]/implement/route.ts"
      );
      const response = await POST(
        new Request("http://localhost/api/projects/project/changes/change/implement", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionId: "retry_build",
            expectedGateVersion: action.gateVersion,
            expectedSourceDbHash: action.sourceDbHash,
            idempotencyKey: "retry-build-active-route-test",
          }),
        }),
        { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
      );

      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.reasonCode, "build_run_running");
      assert.equal(scheduled, false);
    } finally {
      globalThis.setImmediate = originalSetImmediate;
      restoreLiveness();
      restoreClock();
    }
  });

  it("implement POST rejects legacy TESTPLAN_DONE TestPlan gates before Build", async () => {
    const repoPath = seedRuntimeChange({ status: "TESTPLAN_DONE", gateState: null });
    initRuntimeGitRepo(repoPath);
    seedRuntimePendingApprovalTestPlanSnapshot();
    seedRuntimeStageGate({
      id: "STG-GATE-PIPELINE-ROUTE-T15-TESTPLAN-PENDING",
      phase: "TestPlan",
      status: "blocked",
      blockers: [
        { id: "testplan_approval", severity: "P1", title: "TestPlan requires approval before QA" },
      ],
      sourceDbHash: "testplan-pending-approval-hash",
      gateVersion: 8,
    });

    const actions = getActions(RUNTIME_CHANGE_ID);
    const approvePlan = actions.find((candidate) => candidate.actionId === "approve_plan");
    const action = actions.find((candidate) => candidate.actionId === "run_build");
    assert.equal(approvePlan?.enabled, false);
    assert.ok(action);
    assert.equal(action.enabled, false);
    assert.equal(action.reasonCode, "not_at_gate");

    const originalSetImmediate = globalThis.setImmediate;
    let scheduledBuild = false;
    globalThis.setImmediate = ((callback: (...args: unknown[]) => void) => {
      assert.equal(typeof callback, "function");
      scheduledBuild = true;
      return {} as NodeJS.Immediate;
    }) as typeof setImmediate;
    try {
      const { POST } = await import(
        "../../app/api/projects/[id]/changes/[changeId]/implement/route.ts"
      );
      const response = await POST(
        new Request("http://localhost/api/projects/project/changes/change/implement", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedGateVersion: action.gateVersion,
            expectedSourceDbHash: action.sourceDbHash,
            idempotencyKey: "run-build-legacy-testplan-approval-route-test",
          }),
        }),
        { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
      );

      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.error, "action_not_allowed");
      assert.equal(body.reasonCode, "not_at_gate");
      assert.equal(scheduledBuild, false);
    } finally {
      globalThis.setImmediate = originalSetImmediate;
    }
  });

  it("implement POST rejects unknown action ids before async start", async () => {
    const repoPath = seedRuntimeChange({ status: "TESTPLAN_DONE", gateState: null });
    initRuntimeGitRepo(repoPath);
    seedRuntimeStageGate({
      id: "STG-GATE-PIPELINE-ROUTE-T15-TESTPLAN",
      phase: "TestPlan",
      sourceDbHash: "testplan-source-hash",
      gateVersion: 8,
    });
    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "run_build",
    );
    assert.ok(action);

    const { POST } = await import(
      "../../app/api/projects/[id]/changes/[changeId]/implement/route.ts"
    );
    const response = await POST(
      new Request("http://localhost/api/projects/project/changes/change/implement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: "approve_plan",
          expectedGateVersion: action.gateVersion,
          expectedSourceDbHash: action.sourceDbHash,
          idempotencyKey: "run-build-invalid-action-route-test",
        }),
      }),
      { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
    );

    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.reasonCode, "invalid_preflight_input");
    assert.match(body.error, /actionId must be run_build or retry_build/);
  });

  it("guards local check route with the Review QA gate before entering QA", () => {
    const content = fs.readFileSync(path.join(ROUTE_ROOT, "check", "route.ts"), "utf-8");

    assert.match(content, /assertActionAllowed/);
    assert.match(content, /actionPreflightErrorResponse/);
    assert.match(content, /assertCanRunCheck/);
    assert.match(content, /PreflightBlockedError/);
    assert.match(content, /PreflightValidationError/);
    assert.match(content, /function checkActionId/);
    assert.match(content, /const actionId = checkActionId\(payload\.actionId\)/);
    assert.match(content, /actionId,/);
    assert.match(content, /value === "run_qa" \|\| value === "retry_qa"/);
    assert.match(content, /normalizePreflightField/);
    assert.match(content, /expectedGateVersion/);
    assert.match(content, /expectedSourceDbHash/);
    assert.match(content, /expectedHeadSha/);
    assert.match(content, /idempotencyKey/);
    assert.match(content, /request\.headers\.get\("idempotency-key"\)/);
    assert.match(content, /request\.headers\.get\("x-idempotency-key"\)/);
    assert.match(content, /entrypoint:\s*"api_check_route"/);
    assert.match(content, /actor:\s*"human"/);
    assert.match(content.replace(/\s+/g, " "), /assertCanRunCheck\([\s\S]*enqueueProviderActionAtomically\(\{/);
    assert.match(content, /phase: "local_check"/);
    assert.match(content, /jobId: job\.id/);
    assert.match(content, /status: "queued"/);
    assert.doesNotMatch(content, /runCheck\(/);
    assert.doesNotMatch(content, /getReviewCenterState/);
    assert.match(content, /NextResponse\.json\(err\.envelope, \{ status: err\.status \}\)/);
    assert.match(content, /action_not_allowed/);
    assert.match(content, /status: 409/);
    assert.match(content, /status:\s*422/);
  });

  it("plan POST preflights run_plan and retry_plan before async start", () => {
    const content = fs.readFileSync(path.join(ROUTE_ROOT, "plan", "route.ts"), "utf-8");
    const normalizedContent = content.replace(/\s+/g, " ");
    const requireIndex = content.indexOf("requireProjectChange(projectId, changeId)");
    const readPayloadIndex = content.indexOf("readActionPayload(request)");
    const resolveActionIndex = content.indexOf("planActionId(payload.actionId)");
    const assertIndex = content.indexOf("assertRequestActionAllowed({ changeId, actionId, payload, request })");
    const enqueueIndex = content.indexOf("enqueueProviderActionAtomically({");

    assert.match(content, /readActionPayload/);
    assert.match(content, /assertRequestActionAllowed/);
    assert.match(content, /actionPreflightErrorResponse/);
    assert.match(content, /function planActionId/);
    assert.match(content, /value === "run_plan" \|\| value === "retry_plan"/);
    assert.match(content, /actionId must be run_plan or retry_plan/);
    assert.match(content, /return "run_plan"/);
    assert.match(content, /"retry_plan"/);
    assert.match(content, /enqueueProviderActionAtomically/);
    assert.match(content, /phase: "generate_plan"/);
    assert.match(content, /jobId: job\.id/);
    assert.match(content, /status: "queued"/);
    assert.doesNotMatch(content, /setImmediate|generatePlan\(/);
    assert.match(content, /status: 202/);
    assert.match(content, /status: 400/);
    assert.notEqual(requireIndex, -1);
    assert.notEqual(readPayloadIndex, -1);
    assert.notEqual(resolveActionIndex, -1);
    assert.notEqual(assertIndex, -1);
    assert.notEqual(enqueueIndex, -1);
    assert.ok(requireIndex < readPayloadIndex);
    assert.ok(readPayloadIndex < resolveActionIndex);
    assert.ok(resolveActionIndex < assertIndex);
    assert.ok(assertIndex < enqueueIndex);
    assert.match(normalizedContent, /assertRequestActionAllowed\(\{ changeId, actionId, payload, request \}\); const idempotencyKey = .* enqueueProviderActionAtomically/);
  });

  it("plan POST rejects missing idempotency before starting Plan", async () => {
    seedRuntimeChange({ status: "PLAN_READY", gateState: "tech_spec" });
    seedRuntimeStageGate({
      id: "STG-GATE-PIPELINE-ROUTE-T15-TECHSPEC-PLAN",
      phase: "TechSpec",
      sourceDbHash: "techspec-source-hash",
      gateVersion: 6,
    });
    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "retry_plan",
    );
    assert.ok(action);
    assert.equal(action.enabled, true);

    let scheduledPlan = false;
    const originalSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((callback: (...args: unknown[]) => void) => {
      assert.equal(typeof callback, "function");
      scheduledPlan = true;
      return {} as NodeJS.Immediate;
    }) as typeof setImmediate;
    try {
      const { POST } = await import(
        "../../app/api/projects/[id]/changes/[changeId]/plan/route.ts"
      );
      const response = await POST(
        new Request("http://localhost/api/projects/project/changes/change/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionId: "retry_plan",
            expectedGateVersion: action.gateVersion,
            expectedSourceDbHash: action.sourceDbHash,
          }),
        }),
        { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
      );

      assert.equal(response.status, 422);
      const body = await response.json();
      assert.equal(body.reasonCode, "missing_idempotency_key");
      assert.equal(scheduledPlan, false);
    } finally {
      globalThis.setImmediate = originalSetImmediate;
    }
  });

  it("plan POST rejects a drifted retry_plan contract before starting Plan", async () => {
    seedRuntimeChange({ status: "PLAN_READY", gateState: "tech_spec" });
    seedRuntimeStageGate({
      id: "STG-GATE-PIPELINE-ROUTE-T15-TECHSPEC-PLAN-DRIFT",
      phase: "TechSpec",
      sourceDbHash: "techspec-source-hash",
      gateVersion: 6,
    });
    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "retry_plan",
    );
    assert.ok(action);
    assert.equal(action.enabled, true);

    let scheduledPlan = false;
    const originalSetImmediate = globalThis.setImmediate;
    globalThis.setImmediate = ((callback: (...args: unknown[]) => void) => {
      assert.equal(typeof callback, "function");
      scheduledPlan = true;
      return {} as NodeJS.Immediate;
    }) as typeof setImmediate;
    try {
      const { POST } = await import(
        "../../app/api/projects/[id]/changes/[changeId]/plan/route.ts"
      );
      const response = await POST(
        new Request("http://localhost/api/projects/project/changes/change/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionId: "retry_plan",
            expectedGateVersion: `${Number(action.gateVersion) - 1}`,
            expectedSourceDbHash: action.sourceDbHash,
            idempotencyKey: "retry-plan-drift-route-test",
          }),
        }),
        { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
      );

      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.error, "action_not_allowed");
      assert.equal(body.reasonCode, "gate_version_drift");
      assert.equal(body.action.actionId, "retry_plan");
      assert.equal(scheduledPlan, false);
    } finally {
      globalThis.setImmediate = originalSetImmediate;
    }
  });

  /**
   * The served contract's own requiredStatus filter
   * (action-contract-decision-router) is a second enforcement point,
   * independent of the enqueue authority that provider-action-authority-service
   * applies. retry_plan declared no requiredStatus, so this filter never fired
   * and GET /gate reported the action enabled at statuses generatePlan rejects
   * outright -- the 202-then-"Invalid status" deadlock.
   */
  it("keeps retry_plan enabled for a change stranded at PLANNING", () => {
    seedRuntimeChange({ status: "PLANNING", gateState: "tech_spec" });
    seedRuntimeStageGate({
      id: "STG-GATE-PIPELINE-ROUTE-T15-TECHSPEC-PLAN-STRANDED",
      phase: "TechSpec",
      sourceDbHash: "techspec-source-hash",
      gateVersion: 6,
    });

    // PLANNING is where a killed Plan run leaves the change, so this is the one
    // status the contract must keep offering: generatePlan recovers it.
    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "retry_plan",
    );

    assert.ok(action);
    assert.equal(action.enabled, true);
  });

  for (const status of ["PLAN_APPROVED", "IMPLEMENTING"]) {
    it(`stops reporting retry_plan enabled at ${status}`, () => {
      seedRuntimeChange({ status, gateState: "tech_spec" });
      seedRuntimeStageGate({
        id: `STG-GATE-PIPELINE-ROUTE-T15-TECHSPEC-PLAN-${status}`,
        phase: "TechSpec",
        sourceDbHash: "techspec-source-hash",
        gateVersion: 6,
      });

      // The TechSpec gate this action snapshots is still passing here, so
      // without a requiredStatus of its own the contract happily reported it
      // enabled while generatePlan's assertStatus refused every dispatch.
      const action = getActions(RUNTIME_CHANGE_ID).find(
        (candidate) => candidate.actionId === "retry_plan",
      );

      assert.ok(action);
      assert.equal(action.enabled, false);
      assert.equal(action.reasonCode, "not_at_gate");
    });
  }

  /**
   * The same served-contract filter, failing the other way. retry_test_plan
   * pinned requiredStatus to PLAN_APPROVED alone, so GET /gate reported it
   * disabled at TESTPLANNING -- the one status where a killed TestPlan run
   * leaves the change and where runDocumentStage's recovery could actually
   * repair it. Both TestPlan buttons then read disabled with no path forward.
   */
  it("keeps retry_test_plan enabled for a change stranded at TESTPLANNING", () => {
    seedRuntimeChange({ status: "TESTPLANNING", gateState: null });
    seedRuntimeStageGate({
      id: "STG-GATE-PIPELINE-ROUTE-T15-PLAN-TESTPLAN-STRANDED",
      phase: "Plan",
      sourceDbHash: "plan-source-hash",
      gateVersion: 6,
    });

    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "retry_test_plan",
    );

    assert.ok(action);
    assert.equal(action.enabled, true);
  });

  for (const status of ["TESTPLAN_DONE", "IMPLEMENTING"]) {
    it(`stops reporting retry_test_plan enabled at ${status}`, () => {
      seedRuntimeChange({ status, gateState: null });
      seedRuntimeStageGate({
        id: `STG-GATE-PIPELINE-ROUTE-T15-PLAN-TESTPLAN-${status}`,
        phase: "Plan",
        sourceDbHash: "plan-source-hash",
        gateVersion: 6,
      });

      // The Plan gate this action snapshots is still passing here, so
      // decideAction's requiredStatus filter is the only thing standing between
      // the contract and the phantom button: drop it and this action is
      // advertised at every status again. Widening it to cover TESTPLANNING
      // must not widen it further.
      const action = getActions(RUNTIME_CHANGE_ID).find(
        (candidate) => candidate.actionId === "retry_test_plan",
      );

      assert.ok(action);
      assert.equal(action.enabled, false);
      assert.equal(action.reasonCode, "not_at_gate");
    });
  }

  it("intake POST preflights run_prd and retry_prd before enqueue", () => {
    const content = fs.readFileSync(path.join(ROUTE_ROOT, "intake", "route.ts"), "utf-8");
    const normalizedContent = content.replace(/\s+/g, " ");
    const requireIndex = content.indexOf("requireProjectChange(projectId, changeId)");
    const readPayloadIndex = content.indexOf("readActionPayload(request)");
    const resolveActionIndex = content.indexOf("intakeActionId(payload.actionId)");
    const assertIndex = content.indexOf("assertRequestActionAllowed({ changeId, actionId, payload, request })");
    const enqueueIndex = content.indexOf("enqueueProviderActionAtomically({");

    assert.match(content, /readActionPayload/);
    assert.match(content, /assertRequestActionAllowed/);
    assert.match(content, /actionPreflightErrorResponse/);
    assert.match(content, /function intakeActionId/);
    assert.match(content, /value === "run_prd" \|\| value === "retry_prd"/);
    assert.match(content, /actionId must be run_prd or retry_prd/);
    assert.match(content, /return "run_prd"/);
    assert.match(content, /"retry_prd"/);
    assert.match(content, /enqueueProviderActionAtomically/);
    assert.match(content, /phase: "intake"/);
    assert.doesNotMatch(content, /setImmediate|runIntake\(changeId\)|pipeline-service/);
    assert.match(content, /status: 202/);
    assert.match(content, /status: 400/);
    assert.notEqual(requireIndex, -1);
    assert.notEqual(readPayloadIndex, -1);
    assert.notEqual(resolveActionIndex, -1);
    assert.notEqual(assertIndex, -1);
    assert.notEqual(enqueueIndex, -1);
    assert.ok(requireIndex < readPayloadIndex);
    assert.ok(readPayloadIndex < resolveActionIndex);
    assert.ok(resolveActionIndex < assertIndex);
    assert.ok(assertIndex < enqueueIndex);
    assert.match(normalizedContent, /assertRequestActionAllowed\(\{ changeId, actionId, payload, request \}\); const idempotencyKey = .* enqueueProviderActionAtomically/);
  });

  it("intake POST accepts retry_prd on a new change with the missing-gate sentinel contract", async () => {
    seedRuntimeChange({ status: "INTAKE_PENDING", gateState: null });
    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "retry_prd",
    );
    assert.ok(action);
    assert.equal(action.enabled, true);
    assert.equal(action.gateVersion, "0");
    assert.equal(action.sourceDbHash, "__missing_gate__");

    const { POST } = await import(
      "../../app/api/projects/[id]/changes/[changeId]/intake/route.ts"
    );
    const response = await POST(
      new Request("http://localhost/api/projects/project/changes/change/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: "retry_prd",
          expectedGateVersion: action.gateVersion,
          expectedSourceDbHash: action.sourceDbHash,
          idempotencyKey: "retry-prd-new-change-route-test",
        }),
      }),
      { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
    );

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, true);
    assert.equal(body.status, "queued");
    const job = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, body.jobId)).get();
    assert.equal(job?.phase, "intake");
    assert.equal(job?.actionId, "retry_prd");
  });

  it("intake POST rejects missing idempotency before starting Intake", async () => {
    seedRuntimeChange({ status: "INTAKE_PENDING", gateState: null });
    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "run_prd",
    );
    assert.ok(action);
    assert.equal(action.enabled, true);
    assert.equal(action.gateVersion, "0");
    assert.equal(action.sourceDbHash, "__missing_gate__");

    const { POST } = await import(
      "../../app/api/projects/[id]/changes/[changeId]/intake/route.ts"
    );
    const response = await POST(
      new Request("http://localhost/api/projects/project/changes/change/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: "run_prd",
          expectedGateVersion: action.gateVersion,
          expectedSourceDbHash: action.sourceDbHash,
        }),
      }),
      { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
    );

    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.reasonCode, "missing_idempotency_key");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, RUNTIME_CHANGE_ID)).all().length, 0);
  });

  it("intake POST rejects a drifted run_prd sentinel contract before starting Intake", async () => {
    seedRuntimeChange({ status: "INTAKE_PENDING", gateState: null });
    const action = getActions(RUNTIME_CHANGE_ID).find(
      (candidate) => candidate.actionId === "run_prd",
    );
    assert.ok(action);
    assert.equal(action.enabled, true);
    assert.equal(action.gateVersion, "0");
    assert.equal(action.sourceDbHash, "__missing_gate__");

    const { POST } = await import(
      "../../app/api/projects/[id]/changes/[changeId]/intake/route.ts"
    );
    const response = await POST(
      new Request("http://localhost/api/projects/project/changes/change/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: "run_prd",
          expectedGateVersion: "1",
          expectedSourceDbHash: action.sourceDbHash,
          idempotencyKey: "run-prd-drift-route-test",
        }),
      }),
      { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
    );

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "action_not_allowed");
    assert.equal(body.reasonCode, "gate_version_drift");
    assert.equal(body.action.actionId, "run_prd");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, RUNTIME_CHANGE_ID)).all().length, 0);
  });

  it("phases GET includes DB-first stage DTO fields without raw filesystem paths", () => {
    const content = fs.readFileSync(path.join(ROUTE_ROOT, "phases", "route.ts"), "utf-8");

    assert.match(content, /stageStates/);
    assert.match(content, /stageGates/);
    assert.match(content, /stageReports/);
    assert.match(content, /computeActions/);
    assert.doesNotMatch(content, /getActions/);
    assert.match(content, /persistStatus:\s*false/);
    assert.match(content, /inspectArtifactMirrors/);
    assert.match(content, /mirrorWarnings/);
    assert.match(content, /legacyWarnings/);
    assert.match(content, /latestValidReports/);
    assert.match(content, /sourceArtifactHash/);
    assert.doesNotMatch(content, /\.\.\.review/);
    assert.match(content, /runs:\s*review\.selected\.runs\.map/);
    assert.doesNotMatch(content, /runs:\s*review\.selected\.runs,/);
    assert.doesNotMatch(content, /sourcePath:\s*legacyImport\.sourcePath/);
    assert.doesNotMatch(content, /path:\s*warning\.path/);
  });

  it("reject_build preflight returns a 409 action contract when gateVersion is stale", () => {
    seedRuntimeBuildGate();
    const rejectBuild = getActions(RUNTIME_CHANGE_ID).find((action) => action.actionId === "reject_build");

    assert.ok(rejectBuild);
    assert.throws(
      () =>
        assertActionAllowed({
          changeId: RUNTIME_CHANGE_ID,
          actionId: "reject_build",
          expectedGateVersion: "2",
          expectedSourceDbHash: "build-source:hash",
          idempotencyKey: "reject-build-stale",
        }),
      (error) => {
        assert.ok(error instanceof PreflightBlockedError);
        assert.equal(error.status, 409);
        assert.equal(error.envelope.error, "action_not_allowed");
        assert.equal(error.envelope.reasonCode, "gate_version_drift");
        assert.equal(error.envelope.action.actionId, "reject_build");
        assert.equal(error.envelope.action.enabled, false);
        assert.equal(error.envelope.action.gateVersion, "3");
        assert.equal(error.envelope.action.sourceDbHash, "build-source:hash");
        assert.ok(error.envelope.actions.some((action) => action.actionId === "reject_build"));
        return true;
      },
    );
  });

  it("GraphRunner passes the graph_runner entrypoint to local checks", () => {
    const content = fs.readFileSync(path.join(process.cwd(), "server", "services", "graph-runner.ts"), "utf-8");
    const normalizedContent = content.replace(/\s+/g, " ");

    assert.match(
      normalizedContent,
      /runCheck\(changeId, context, \{ entrypoint: "graph_runner", actor: "system" \}\)/
    );
    assert.match(content, /getStageAuthority\(changeId, "QA"\)\.latestGate/);
    assert.match(content, /Cannot mark LOCAL_READY before QA gate passes/);
  });

  it("build-workspace route exposes Build workspace state and actions", () => {
    const routePath = path.join(ROUTE_ROOT, "build-workspace", "route.ts");

    assert.equal(fs.existsSync(routePath), true, `${routePath} should exist`);
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /export async function GET/);
    assert.match(content, /export async function POST/);
    assert.match(content, /requireProjectChange\(projectId, changeId\)/);
    assert.match(content, /checkGitBaseCamp/);
    assert.match(content, /changeArtifactIgnoredPrefixes\(changeId\)/);
    assert.match(content, /readLatestBuildRun/);
    assert.match(content, /assertActionAllowed/);
    assert.match(content, /PreflightBlockedError/);
    assert.match(content, /PreflightValidationError/);
    assert.match(content, /actionNotAllowedEnvelope/);
    assert.match(content, /buildWorkspaceErrorActionId = buildRun\.purpose === "fix" \? "adopt_fix" : "adopt_build"/);
    assert.match(content, /actionId:\s*buildWorkspaceErrorActionId/);
    assert.match(content, /adopt_build/);
    assert.match(content, /adopt_fix/);
    assert.match(content, /normalizePreflightField/);
    assert.match(content, /expectedGateVersion/);
    assert.match(content, /expectedSourceDbHash/);
    assert.match(content, /idempotencyKey/);
    assert.match(content, /request\.headers\.get\("idempotency-key"\)/);
    assert.match(content, /request\.headers\.get\("x-idempotency-key"\)/);
    assert.match(content, /expectedHeadSha:\s*expectedHeadSha \?\? buildRun\.baseHeadSha \?\? buildRun\.baseCommit/);
    assert.match(content, /err instanceof BuildWorkspaceError/);
    assert.match(content, /buildWorkspaceContractReasonCode\(message\)/);
    assert.match(content, /git_worktree_dirty/);
    assert.match(content, /build_hash_drift/);
    assert.match(content, /NextResponse\.json\(err\.envelope/);
    assert.match(content, /NextResponse\.json\(envelope, \{ status: 409 \}\)/);
    assert.match(content, /approveBuildAbsorb/);
    assert.match(content, /approveBuildAbsorb\(changeId\)/);
    assert.match(content, /reject_build/);
    assert.match(content.replace(/\s+/g, " "), /await assertActionAllowedAsync\(\{ changeId, actionId: "reject_build"/);
    assert.match(content, /rejectBuildRun/);
    assert.match(content, /Unknown build workspace action/);
    assert.match(content, /Invalid JSON body/);
    assert.match(content, /JSON object body required/);
    assert.match(content, /body === null \|\| typeof body !== "object" \|\| Array\.isArray\(body\)/);
    assert.match(content, /BuildWorkspaceError/);
    assert.match(content, /buildWorkspacePostErrorStatus/);
    assert.match(content, /err instanceof BuildWorkspaceError/);
    assert.match(content, /return err\.statusCode/);
    assert.match(content, /\^\(Change\|Project\) not found/);
    assert.match(content, /return 404/);
    assert.match(content, /\^Invalid status:/);
    assert.match(content, /return 409/);
    assert.match(content, /status: 400/);
  });
});

describe("phase artifact edit route", () => {
  it("exposes a PUT handler that uses savePhaseArtifactContent", () => {
    const routePath = path.join(
      process.cwd(),
      "app",
      "api",
      "projects",
      "[id]",
      "changes",
      "[changeId]",
      "phase-artifacts",
      "route.ts"
    );
    const content = fs.readFileSync(routePath, "utf-8");
    const normalizedContent = content.replace(/\s+/g, " ");

    assert.match(content, /export async function PUT/);
    assert.match(content, /savePhaseArtifactContent/);
    assert.match(content, /canEditPhaseArtifacts/);
    assert.match(content, /latestRunStatus/);
    assert.match(content, /content field required/);
    assert.match(content, /path field required/);
    assert.match(
      content,
      /where\(\s*and\(\s*eq\(changes\.id,\s*changeId\),\s*eq\(changes\.projectId,\s*projectId\)\s*\)\s*\)/s
    );
    assert.match(content, /orderBy\(\s*desc\(runs\.startedAt\)\s*\)/);
    assert.match(
      normalizedContent,
      /const project = db\.select\(\)\.from\(projects\)\.where\(eq\(projects\.id, projectId\)\)\.get\(\);/
    );
    assert.match(
      normalizedContent,
      /canEditPhaseArtifacts\(\{ status: change\.status, latestRunStatus \}\)/
    );
    assert.match(
      normalizedContent,
      /if \(!canEditPhaseArtifacts\(\{ status: change\.status, latestRunStatus \}\)\) \{ return NextResponse\.json\( \{ error: "Editing is disabled while this change is running" \}, \{ status: 409 \} \); \}/
    );
    assert.match(
      normalizedContent,
      /Invalid JSON body/
    );
    assert.match(
      normalizedContent,
      /JSON object body required/
    );
    assert.match(
      normalizedContent,
      /if \(typeof payload\.path !== "string"\) \{ return NextResponse\.json\(\{ error: "path field required" \}, \{ status: 400 \}\); \}/
    );
    assert.match(
      normalizedContent,
      /if \(typeof payload\.content !== "string"\) \{ return NextResponse\.json\(\{ error: "content field required" \}, \{ status: 400 \}\); \}/
    );
    assert.match(
      normalizedContent,
      /savePhaseArtifactContent\(\{[^}]*repoPath: project\.repoPath,[^}]*changeId,[^}]*artifactPath: payload\.path,[^}]*content: payload\.content,[^}]*\}\)/
    );
    assert.match(
      normalizedContent,
      /catch \(err\) \{[^}]*return NextResponse\.json\(\{ error: message \}, \{ status: 400 \}\); \}/
    );
  });
});

describe("legacy artifact content edit route", () => {
  it("keeps raw stage output artifacts metadata-only in the content route", () => {
    const routePath = path.join(
      ROUTE_ROOT,
      "artifacts",
      "[artifactId]",
      "content",
      "route.ts"
    );
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /isMetadataOnlyArtifactType/);
    assert.match(content, /type === "stage_raw_output"/);
    assert.match(content, /Artifact content is metadata-only/);
    assert.match(
      content,
      /if \(isMetadataOnlyArtifactType\(artifact\.type\)\) \{[\s\S]*return NextResponse\.json\(\{ error: "Artifact content is metadata-only" \}, \{ status: 403 \}\);[\s\S]*\}/,
    );
  });

  it("reuses phase artifact write guards instead of direct file writes", () => {
    const routePath = path.join(
      ROUTE_ROOT,
      "artifacts",
      "[artifactId]",
      "content",
      "route.ts"
    );
    const content = fs.readFileSync(routePath, "utf-8");
    const putStart = content.indexOf("export async function PUT");
    assert.notEqual(putStart, -1);
    const putSource = content.slice(putStart);

    assert.match(content, /savePhaseArtifactContent/);
    assert.match(putSource, /savePhaseArtifactContent\(\{[\s\S]*repoPath: project\.repoPath,[\s\S]*changeId,[\s\S]*artifactPath: artifact\.path,[\s\S]*content: body\.content/);
    assert.doesNotMatch(putSource, /fs\.writeFileSync/);
  });
});

describe("plan approval route", () => {
  it("rejects inline plan sandbox waivers before approving the plan", () => {
    const routePath = path.join(ROUTE_ROOT, "approve-plan", "route.ts");
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /import \{ approvePlan \}/);
    assert.doesNotMatch(content, /regeneratePlanReport/);
    assert.doesNotMatch(content, /waivePlanRisk/);
    assert.match(content, /p1Waivers/);
    assert.match(content, /p1_waivers_must_use_plan_decision/);
    assert.match(
      content,
      /p1Waivers[\s\S]*p1_waivers_must_use_plan_decision[\s\S]*assertActionAllowed[\s\S]*await approvePlan\(changeId, \{ source: "route_preflight" \}\)/
    );
  });
});

describe("change detail route", () => {
  it("returns historical TestPlan completion for Build entry decisions", () => {
    const routePath = path.join(ROUTE_ROOT, "route.ts");
    const content = fs.readFileSync(routePath, "utf-8");

    assert.match(content, /const testPlanCompleted = db/);
    assert.match(content, /run\.phase === "test_plan" && run\.status === "completed"/);
    assert.match(content, /testPlanCompleted,/);
  });
});

function collectRoutePaths(root: string): string[] {
  const paths: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) paths.push(...collectRoutePaths(entryPath));
    if (entry.isFile() && entry.name === "route.ts") paths.push(entryPath);
  }
  return paths;
}

function isAiRunnerSymbol(symbol: string): boolean {
  return /^(?:run|retry)[A-Z]|^generatePlan$/.test(symbol);
}

type RouteContractEntry = { nodeKind: string; file: string; symbol: string };
type RouteContractViolation = RouteContractEntry & { reason: string };

const ROUTE_ASYNC_ALLOWLIST: readonly RouteContractEntry[] = [];
const PROHIBITED_RUNNER_MODULE = /(?:^|\/)(?:pipeline-service|prd-briefing-service|pipeline-.*-stage-service)(?:\.ts)?$/;

function routeFileLabel(fileName: string): string {
  return path.relative(process.cwd(), fileName).replaceAll(path.sep, "/");
}

function moduleNameFromImportNode(node: ts.Node): string | null {
  let current: ts.Node | undefined = node;
  while (current && !ts.isImportDeclaration(current)) current = current.parent;
  return current && ts.isStringLiteral(current.moduleSpecifier) ? current.moduleSpecifier.text : null;
}

function isProhibitedModuleName(value: string | null): boolean {
  return value !== null && PROHIBITED_RUNNER_MODULE.test(value);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAwaitExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function expressionComesFromRunnerModule(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  const value = unwrapExpression(expression);
  if (
    ts.isCallExpression(value)
    && value.expression.kind === ts.SyntaxKind.ImportKeyword
    && ts.isStringLiteral(value.arguments[0])
  ) {
    return isProhibitedModuleName(value.arguments[0].text);
  }
  if (!ts.isIdentifier(value)) return false;
  const symbol = checker.getSymbolAtLocation(value);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isNamespaceImport(declaration)) {
      return isProhibitedModuleName(moduleNameFromImportNode(declaration));
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      if (expressionComesFromRunnerModule(declaration.initializer, checker, seen)) return true;
    }
  }
  return false;
}

function resolveAiRunnerSymbol(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): string | null {
  const value = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(value)) {
    if (
      isAiRunnerSymbol(value.name.text)
      && expressionComesFromRunnerModule(value.expression, checker)
    ) return value.name.text;
    return null;
  }
  if (
    ts.isElementAccessExpression(value)
    && ts.isStringLiteral(value.argumentExpression)
    && isAiRunnerSymbol(value.argumentExpression.text)
    && expressionComesFromRunnerModule(value.expression, checker)
  ) return value.argumentExpression.text;
  if (!ts.isIdentifier(value)) return null;
  const symbol = checker.getSymbolAtLocation(value);
  if (!symbol || seen.has(symbol)) return null;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isImportSpecifier(declaration)) {
      const imported = declaration.propertyName?.text ?? declaration.name.text;
      if (isAiRunnerSymbol(imported) && isProhibitedModuleName(moduleNameFromImportNode(declaration))) {
        return imported;
      }
    }
    if (ts.isImportClause(declaration) && declaration.name) {
      if (isProhibitedModuleName(moduleNameFromImportNode(declaration))) return declaration.name.text;
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const resolved = resolveAiRunnerSymbol(declaration.initializer, checker, seen);
      if (resolved) return resolved;
    }
    if (ts.isBindingElement(declaration)) {
      const imported = declaration.propertyName?.getText() ?? declaration.name.getText();
      const variable = declaration.parent.parent;
      if (
        isAiRunnerSymbol(imported)
        && ts.isVariableDeclaration(variable)
        && variable.initializer
        && expressionComesFromRunnerModule(variable.initializer, checker)
      ) return imported;
    }
  }
  return null;
}

function resolveSchedulerSymbol(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): "setImmediate" | "setTimeout" | "queueMicrotask" | null {
  const value = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(value)) {
    if (
      ts.isIdentifier(value.expression)
      && value.expression.text === "globalThis"
      && ["setImmediate", "setTimeout", "queueMicrotask"].includes(value.name.text)
    ) return value.name.text as "setImmediate" | "setTimeout" | "queueMicrotask";
    return null;
  }
  if (!ts.isIdentifier(value)) return null;
  if (["setImmediate", "setTimeout", "queueMicrotask"].includes(value.text)) {
    return value.text as "setImmediate" | "setTimeout" | "queueMicrotask";
  }
  const symbol = checker.getSymbolAtLocation(value);
  if (!symbol || seen.has(symbol)) return null;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const resolved = resolveSchedulerSymbol(declaration.initializer, checker, seen);
      if (resolved) return resolved;
    }
  }
  return null;
}

function isPromiseLikeCall(node: ts.CallExpression, checker: ts.TypeChecker): boolean {
  return checker.getPropertyOfType(checker.getTypeAtLocation(node), "then") !== undefined;
}

function outerPromiseCall(node: ts.CallExpression): ts.CallExpression {
  let current = node;
  while (
    ts.isPropertyAccessExpression(current.parent)
    && current.parent.expression === current
    && ts.isCallExpression(current.parent.parent)
  ) current = current.parent.parent;
  return current;
}

function promiseIsControlled(node: ts.CallExpression): boolean {
  const text = node.expression.getText();
  if (/\.catch$/.test(text)) return node.arguments.length > 0;
  if (/\.then$/.test(text) && node.arguments.length > 1) return true;
  let current: ts.Node = node;
  while (current.parent) {
    if (ts.isAwaitExpression(current.parent) || ts.isReturnStatement(current.parent)) return true;
    if (ts.isArrowFunction(current.parent) && current.parent.body === current) return true;
    if (
      ts.isParenthesizedExpression(current.parent)
      || ts.isAsExpression(current.parent)
      || ts.isNonNullExpression(current.parent)
    ) {
      current = current.parent;
      continue;
    }
    break;
  }
  return false;
}

function scanRouteContracts(
  program: ts.Program,
  routePaths: readonly string[],
  allowlist: readonly RouteContractEntry[] = ROUTE_ASYNC_ALLOWLIST,
): RouteContractViolation[] {
  const checker = program.getTypeChecker();
  const violations: RouteContractViolation[] = [];
  const add = (node: ts.Node, file: string, symbol: string, reason: string) => {
    const entry = { nodeKind: ts.SyntaxKind[node.kind], file, symbol };
    if (!allowlist.some((item) => item.nodeKind === entry.nodeKind && item.file === file && item.symbol === symbol)) {
      violations.push({ ...entry, reason });
    }
  };

  for (const routePath of routePaths) {
    const sourceFile = program.getSourceFile(routePath);
    if (!sourceFile) throw new Error(`Route missing from TypeScript Program: ${routePath}`);
    const file = routeFileLabel(routePath);
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && isProhibitedModuleName(
        ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null,
      )) {
        const clause = node.importClause;
        if (clause?.name) add(clause, file, clause.name.text, "default AI runner import");
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const specifier of clause.namedBindings.elements) {
            const imported = specifier.propertyName?.text ?? specifier.name.text;
            if (isAiRunnerSymbol(imported)) add(specifier, file, imported, "named AI runner import");
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const scheduler = resolveSchedulerSymbol(node.expression, checker);
        if (scheduler === "setImmediate") {
          add(node, file, scheduler, "setImmediate is forbidden in routes");
        } else if (scheduler) {
          add(node, file, scheduler, "scheduler requires an exact allowlist entry");
        }

        const runner = resolveAiRunnerSymbol(node.expression, checker);
        if (runner) add(node, file, runner, "direct AI runner call");

        if (isPromiseLikeCall(node, checker) && outerPromiseCall(node) === node && !promiseIsControlled(node)) {
          add(node, file, runner ?? node.expression.getText(), "uncontrolled Promise");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

function createProjectProgram(): ts.Program {
  const configPath = path.join(process.cwd(), "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

function createRouteFixture(files: Record<string, string>): { program: ts.Program; paths: string[]; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task9-route-contract-"));
  const paths = Object.entries(files).map(([name, source]) => {
    const filePath = path.join(root, name);
    fs.writeFileSync(filePath, source);
    return filePath;
  });
  return {
    root,
    paths: paths.filter((filePath) => filePath.endsWith("route.ts")),
    program: ts.createProgram({
      rootNames: paths,
      options: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, strict: true },
    }),
  };
}

describe("Task 9 queued AI routes", { concurrency: false }, () => {
  it("uses AST contracts to reject setImmediate and direct AI runners in routes", () => {
    const apiRoot = path.join(process.cwd(), "app", "api");
    const routePaths = collectRoutePaths(apiRoot);
    assert.deepEqual(scanRouteContracts(createProjectProgram(), routePaths), []);
  });

  it("catches import aliases, namespace/default calls, dynamic aliases, and uncontrolled Promises", () => {
    const fixture = createRouteFixture({
      "pipeline-service.ts": `
        export async function runIntake(): Promise<void> {}
        export async function runReview(): Promise<void> {}
        export default async function execute(): Promise<void> {}
      `,
      "route.ts": `
        import execute from "./pipeline-service";
        import { runIntake as start } from "./pipeline-service";
        import * as pipeline from "./pipeline-service";
        async function localPromise(): Promise<void> {}
        export async function POST() {
          start();
          pipeline.runReview();
          pipeline["runIntake"]().catch(() => undefined);
          execute();
          globalThis.setImmediate(() => undefined);
          const scheduler = globalThis.setImmediate;
          scheduler(() => undefined);
          const schedulerAlias = scheduler;
          schedulerAlias(() => undefined);
          const modulePromise = import("./pipeline-service");
          const service = await modulePromise;
          const invoke = service.runIntake;
          invoke();
          localPromise();
        }
      `,
    });
    try {
      const violations = scanRouteContracts(fixture.program, fixture.paths);
      const symbols = new Set(violations.map((item) => item.symbol));
      for (const symbol of ["runIntake", "runReview", "execute", "localPromise"]) {
        assert.equal(symbols.has(symbol), true, `missing violation for ${symbol}`);
      }
      assert.equal(
        violations.filter((item) => item.symbol === "runIntake" && item.reason === "direct AI runner call").length >= 2,
        true,
        "named and element-access runIntake calls must both be rejected",
      );
      assert.equal(
        violations.filter((item) => item.symbol === "setImmediate").length >= 3,
        true,
        "globalThis.setImmediate and scheduler aliases must be rejected",
      );
      assert.equal(violations.some((item) => item.reason === "uncontrolled Promise"), true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts awaited, returned, and rejection-controlled Promises and exact allowlists", () => {
    const fixture = createRouteFixture({
      "route.ts": `
        async function localPromise(): Promise<void> {}
        export async function POST(mode: string) {
          await localPromise();
          if (mode === "return") return localPromise();
          localPromise().catch(() => undefined);
          queueMicrotask(() => undefined);
        }
      `,
    });
    try {
      const file = routeFileLabel(fixture.paths[0]);
      const allowlist = [{ nodeKind: "CallExpression", file, symbol: "queueMicrotask" }];
      assert.deepEqual(scanRouteContracts(fixture.program, fixture.paths, allowlist), []);
      assert.equal(scanRouteContracts(fixture.program, fixture.paths, [
        { nodeKind: "CallExpression", file, symbol: "setTimeout" },
      ]).some((item) => item.symbol === "queueMicrotask"), true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("enqueues Intake and all PRD briefing AI POSTs as queued jobs", async () => {
    const intakeRoute = await import(
      "../../app/api/projects/[id]/changes/[changeId]/intake/route.ts"
    );
    seedRuntimeChange({ status: "INTAKE_PENDING", gateState: null });
    const action = getActions(RUNTIME_CHANGE_ID).find((candidate) => candidate.actionId === "run_prd");
    assert.ok(action);
    const intakeResponse = await intakeRoute.POST(
      new Request("http://localhost/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: "run_prd",
          expectedGateVersion: action.gateVersion,
          expectedSourceDbHash: action.sourceDbHash,
          idempotencyKey: "task-9-intake",
        }),
      }),
      { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
    );
    assert.equal(intakeResponse.status, 202);
    assert.deepEqual(await intakeResponse.json(), {
      success: true,
      accepted: true,
      jobId: db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, RUNTIME_CHANGE_ID)).get()?.id,
      status: "queued",
    });
    assert.equal(db.select().from(runs).where(eq(runs.changeId, RUNTIME_CHANGE_ID)).all().length, 0);

    const cases = [
      {
        segment: "questions",
        phase: "prd_briefing_questions",
        actionId: "run_prd_briefing_questions",
      },
      { segment: "draft", phase: "prd_briefing_draft", actionId: "run_prd_briefing_draft" },
      {
        segment: "final-review",
        phase: "prd_briefing_final_review",
        actionId: "run_prd_briefing_final_review",
      },
    ] as const;

    for (const routeCase of cases) {
      seedRuntimeChange({ status: "INTAKE_PENDING", gateState: null });
      const now = "2026-07-10T00:00:00.000Z";
      db.insert(prdBriefings).values({
        id: `PBR-TASK-9-${routeCase.segment}`,
        changeId: RUNTIME_CHANGE_ID,
        status: "intent_captured",
        intentText: "Task 9 intent",
        finalReviewJson: null,
        sourceHashesJson: "{}",
        lockedAt: null,
        createdAt: now,
        updatedAt: now,
      }).run();
      if (routeCase.segment !== "questions") {
        db.insert(briefingQuestions).values({
          id: `BQ-TASK-9-${routeCase.segment}`,
          changeId: RUNTIME_CHANGE_ID,
          category: "scope",
          severity: "important",
          question: "Task 9 question?",
          whyItMatters: "It gates the draft.",
          suggestedDefault: "Queue it.",
          status: "answered",
          answer: "Queue it.",
          source: "ai_blue",
          createdAt: now,
          updatedAt: now,
        }).run();
      }
      if (routeCase.segment === "final-review") {
        await completePrdDraft({ changeId: RUNTIME_CHANGE_ID, markdown: "# Task 9 PRD" });
      }

      const route = await import(
        `../../app/api/projects/[id]/changes/[changeId]/prd-briefing/${routeCase.segment}/route.ts`
      );
      const response = await route.POST(
        new Request(`http://localhost/prd-briefing/${routeCase.segment}`, { method: "POST" }),
        { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
      );
      assert.equal(response.status, 202);
      const queued = db
        .select()
        .from(pipelineJobs)
        .where(eq(pipelineJobs.changeId, RUNTIME_CHANGE_ID))
        .get();
      assert.ok(queued);
      assert.equal(queued.phase, routeCase.phase);
      assert.equal(queued.actionId, routeCase.actionId);
      assert.equal(queued.status, "queued");
      assert.deepEqual(await response.json(), {
        success: true,
        accepted: true,
        jobId: queued.id,
        status: "queued",
      });
      assert.equal(db.select().from(runs).where(eq(runs.changeId, RUNTIME_CHANGE_ID)).all().length, 0);
      assert.equal(
        db.select().from(events).where(eq(events.changeId, RUNTIME_CHANGE_ID)).all()
          .filter((event) => event.type === "pipeline_job_queued").length,
        1,
      );
    }
  });
});
