import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import * as dbSchema from "../db/schema.ts";
import {
  battleRounds,
  buildRunRecords,
  changes,
  findings,
  mergeApprovals,
  mergeBlockers,
  mergeDecisions,
  mergeReadiness,
  prdBriefings,
  prdDrafts,
  projects,
  reviewAttempts,
  reviewReports,
  reviewState,
  runs,
  stageActions,
  stageGates,
  stageRuns,
  stageStates,
} from "../db/schema.ts";
import { getActions } from "./action-contract-service.ts";
import {
  assertActionAllowed,
  assertActionAllowedAsync,
  PreflightBlockedError,
  PreflightValidationError,
  setPreflightHeadProbeForTest,
  setPreflightServiceDbForTest,
} from "./preflight-service.ts";
import { setReviewQaGateHeadProbeForTest } from "./review-qa-gate-service.ts";
import type { PipelinePhase } from "./stage-authority-service.ts";

const PROJECT_ID = "PRJ-PREFLIGHT-T3";
const CHANGE_ID = "CHG-PREFLIGHT-T3";
const HEAD_SHA = "c".repeat(40);

function createPreflightRepositoryTestDb() {
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
  db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
  db.delete(prdDrafts).where(eq(prdDrafts.changeId, CHANGE_ID)).run();
  db.delete(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).run();
  db.delete(buildRunRecords).where(eq(buildRunRecords.changeId, CHANGE_ID)).run();
  db.delete(reviewState).where(eq(reviewState.changeId, CHANGE_ID)).run();
  db.delete(reviewReports).where(eq(reviewReports.changeId, CHANGE_ID)).run();
  db.delete(findings).where(eq(findings.changeId, CHANGE_ID)).run();
  db.delete(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(repoPath: string) {
  const now = "2026-06-29T00:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Preflight T3",
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
    title: "Preflight change",
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

function seedInjectedPreflightChange(
  testDb: ReturnType<typeof createPreflightRepositoryTestDb>,
  repoPath: string,
) {
  const now = "2026-06-29T00:00:00.000Z";
  testDb.insert(projects).values({
    id: PROJECT_ID,
    name: "Injected preflight project",
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
  testDb.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Injected preflight change",
    status: "INTAKE_PENDING",
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
  options: { status?: string; sourceDbHash?: string; gateVersion?: number } = {},
) {
  const status = options.status ?? "passed";
  const sourceDbHash = options.sourceDbHash ?? `${phase}-hash`;
  const gateVersion = options.gateVersion ?? 3;
  const gateId = `STG-GATE-PREFLIGHT-T3-${phase}`;
  db.insert(stageGates).values({
    id: gateId,
    changeId: CHANGE_ID,
    phase,
    status,
    blockersJson: "[]",
    freshnessJson: JSON.stringify({ fresh: true }),
    requiredActionsJson: "[]",
    gateVersion,
    sourceDbHash,
    computedAt: "2026-06-29T00:01:00.000Z",
  }).run();
  db.insert(stageStates).values({
    id: `STG-STATE-PREFLIGHT-T3-${phase}`,
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

// The PRD source behind a passing PRD gate: enqueue authority for a PRD-phase
// run requires a locked briefing with a draft on record, otherwise the served
// contract flips to prd_authority_incomplete.
function seedLockedPrdBriefingAuthority() {
  const now = "2026-06-29T00:01:00.000Z";
  db.insert(prdBriefings).values({
    id: "PBR-PREFLIGHT-T3",
    changeId: CHANGE_ID,
    status: "locked",
    intentText: "Preflight locked PRD.",
    finalReviewJson: null,
    sourceHashesJson: "{}",
    lockedAt: now,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(prdDrafts).values({
    id: "PDR-PREFLIGHT-T3",
    changeId: CHANGE_ID,
    version: 1,
    markdown: "# Preflight PRD\n",
    sourceQuestionIdsJson: "[]",
    unresolvedQuestionIdsJson: "[]",
    draftHash: "preflight-prd-draft-hash",
    createdAt: now,
  }).run();
}

// A Spec governance run backing a passing Spec gate: enqueue authority for a
// Spec-snapshot action (run_tech_spec) resolves through the legacy stage-run
// pairing, which for Spec only requires one matching passing stage run.
function seedSpecStageRunSource(sourceDbHash: string) {
  const now = "2026-06-29T00:01:30.000Z";
  db.insert(stageRuns).values({
    id: "STG-RUN-PREFLIGHT-T3-SPEC",
    changeId: CHANGE_ID,
    phase: "Spec",
    attemptNo: 1,
    status: "passed",
    idempotencyKey: "stage-run-preflight-spec",
    inputDbHash: sourceDbHash,
    outputDbHash: sourceDbHash,
    sourceLineageJson: null,
    errorCode: null,
    startedAt: now,
    completedAt: now,
  }).run();
}

function seedSpecBattleRound(status: string) {
  const now = "2026-06-29T00:02:00.000Z";
  db.insert(battleRounds).values({
    id: `BRD-PREFLIGHT-T3-${status}`,
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
    id: "BRR-PREFLIGHT-T3",
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
    id: "RUN-PREFLIGHT-T3",
    changeId: CHANGE_ID,
    phase: "review",
    status: "completed",
    startedAt: now,
    endedAt: now,
    summary: "{}",
  }).run();
  db.insert(reviewAttempts).values({
    id: "RAT-PREFLIGHT-T3",
    changeId: CHANGE_ID,
    runId: "RUN-PREFLIGHT-T3",
    attemptNo: 1,
    status: "completed",
    provider: "codex",
    reviewStatus: "passed",
    idempotencyKey: "review-preflight",
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
    id: "RRP-PREFLIGHT-T3",
    attemptId: "RAT-PREFLIGHT-T3",
    changeId: CHANGE_ID,
    reportVersion: 1,
    reviewConclusion: "passed",
    reportDbHash: "review-report-hash-preflight",
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
    findingsDbHash: "findings-hash-preflight",
    staleReason: null,
    legacyState: null,
    reportJson: null,
    generatedAt: now,
    createdAt: now,
  }).run();
  db.insert(reviewState).values({
    changeId: CHANGE_ID,
    latestAttemptId: "RAT-PREFLIGHT-T3",
    latestAttemptNo: 1,
    latestReportId: "RRP-PREFLIGHT-T3",
    latestValidReviewReportId: "RRP-PREFLIGHT-T3",
    latestValidAttemptNo: 1,
    gateStatus: "passed",
    reviewStatus: "passed",
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD_SHA,
    reportDbHash: "review-report-hash-preflight",
    findingVersion: 1,
    waiverVersion: 1,
    updatedAt: now,
  }).run();
  db.insert(findings).values({
    id: "FND-PREFLIGHT-P0",
    changeId: CHANGE_ID,
    runId: "RUN-PREFLIGHT-T3",
    source: "review",
    severity: "P0",
    category: "logic",
    title: "review blocker",
    file: "src/app.ts",
    line: null,
    evidence: "review evidence",
    requiredFix: "fix the blocker",
    status: "open",
    reviewAttemptId: "RAT-PREFLIGHT-T3",
    sourceBuildRunId: "build-1",
    sourceHeadSha: HEAD_SHA,
    createdAt: now,
  }).run();
}

describe("preflight-service", () => {
  let repoPath: string;
  let restoreHeadProbe: (() => void) | null = null;

  beforeEach(() => {
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-t3-"));
    restoreHeadProbe = setReviewQaGateHeadProbeForTest(() => HEAD_SHA);
    seedChange(repoPath);
  });

  afterEach(() => {
    restoreHeadProbe?.();
    restoreHeadProbe = null;
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("returns 409 plus a fresh action contract for blocked side-effect actions", () => {
    seedStageGate("Review", { sourceDbHash: "review-source-hash" });
    seedReviewWithOpenP0();
    const enterQa = getActions(CHANGE_ID).find((action) => action.actionId === "enter_qa");
    assert.ok(enterQa);

    assert.throws(
      () =>
        assertActionAllowed({
          changeId: CHANGE_ID,
          actionId: "enter_qa",
          expectedGateVersion: enterQa.gateVersion,
          expectedSourceDbHash: enterQa.sourceDbHash,
          idempotencyKey: "enter-qa-key",
        }),
      (error) => {
        assert.ok(error instanceof PreflightBlockedError);
        assert.equal(error.status, 409);
        assert.equal(error.envelope.error, "action_not_allowed");
        assert.equal(error.envelope.reasonCode, "review_open_p0");
        assert.equal(error.envelope.action.enabled, false);
        assert.equal(error.envelope.action.reason, enterQa.reason);
        assert.ok(error.envelope.actions.some((action) => action.actionId === "enter_qa"));
        return true;
      },
    );
  });

  it("returns 422 only for a missing required idempotency key", () => {
    seedStageGate("PRD", { sourceDbHash: "prd-source-hash", gateVersion: 3 });

    assert.throws(
      () =>
        assertActionAllowed({
          changeId: CHANGE_ID,
          actionId: "run_prd",
          expectedGateVersion: "3",
          expectedSourceDbHash: "prd-source-hash",
        }),
      (error) => {
        assert.ok(error instanceof PreflightValidationError);
        assert.equal(error.status, 422);
        assert.equal(error.reasonCode, "missing_idempotency_key");
        return true;
      },
    );
  });

  it("allows PRD run preflight for a new change with the missing-gate sentinel contract", () => {
    db.update(changes)
      .set({ status: "INTAKE_PENDING", gateState: null })
      .where(eq(changes.id, CHANGE_ID))
      .run();

    const runPrd = getActions(CHANGE_ID).find((action) => action.actionId === "run_prd");
    const retryPrd = getActions(CHANGE_ID).find((action) => action.actionId === "retry_prd");

    for (const action of [runPrd, retryPrd]) {
      assert.ok(action);
      assert.equal(action.enabled, true);
      assert.equal(action.reasonCode, null);
      assert.equal(action.gateVersion, "0");
      assert.equal(action.sourceDbHash, "__missing_gate__");

      const allowed = assertActionAllowed({
        changeId: CHANGE_ID,
        actionId: action.actionId,
        expectedGateVersion: action.gateVersion,
        expectedSourceDbHash: action.sourceDbHash,
        idempotencyKey: `${action.actionId}-missing-gate`,
      });
      assert.equal(allowed.actionId, action.actionId);
      assert.equal(allowed.enabled, true);
    }
  });

  it("blocks PRD run preflight outside intake pending when the PRD gate is missing", () => {
    db.update(changes)
      .set({ status: "INTAKE_READY", gateState: null })
      .where(eq(changes.id, CHANGE_ID))
      .run();

    const retryPrd = getActions(CHANGE_ID).find((action) => action.actionId === "retry_prd");
    assert.ok(retryPrd);
    assert.equal(retryPrd.enabled, false);
    assert.equal(retryPrd.reasonCode, "not_at_gate");
    assert.equal(retryPrd.gateVersion, "0");
    assert.equal(retryPrd.sourceDbHash, "__missing_gate__");

    assert.throws(
      () =>
        assertActionAllowed({
          changeId: CHANGE_ID,
          actionId: "retry_prd",
          expectedGateVersion: retryPrd.gateVersion,
          expectedSourceDbHash: retryPrd.sourceDbHash,
          idempotencyKey: "retry-prd-non-intake",
        }),
      (error) => {
        assert.ok(error instanceof PreflightBlockedError);
        assert.equal(error.envelope.status, 409);
        assert.equal(error.envelope.reasonCode, "not_at_gate");
        assert.equal(error.envelope.action.actionId, "retry_prd");
        return true;
      },
    );
  });

  it("allows retry_prd preflight for a BLOCKED intake recovery with the missing-gate sentinel", () => {
    db.update(changes)
      .set({ status: "BLOCKED", blockedPhase: "intake", gateState: null })
      .where(eq(changes.id, CHANGE_ID))
      .run();

    const retryPrd = getActions(CHANGE_ID).find((action) => action.actionId === "retry_prd");
    assert.ok(retryPrd);
    assert.equal(retryPrd.enabled, true);
    assert.equal(retryPrd.reasonCode, null);
    assert.equal(retryPrd.gateVersion, "0");
    assert.equal(retryPrd.sourceDbHash, "__missing_gate__");

    const allowed = assertActionAllowed({
      changeId: CHANGE_ID,
      actionId: "retry_prd",
      expectedGateVersion: retryPrd.gateVersion,
      expectedSourceDbHash: retryPrd.sourceDbHash,
      idempotencyKey: "retry-prd-blocked-recovery",
    });
    assert.equal(allowed.enabled, true);
    assert.equal(allowed.actionId, "retry_prd");
  });

  it("returns 409 for a missing latest valid Review report when enter_qa is checked", () => {
    const enterQa = getActions(CHANGE_ID).find((action) => action.actionId === "enter_qa");
    assert.ok(enterQa);
    assert.equal(enterQa.reasonCode, "no_latest_valid_review");

    assert.throws(
      () =>
        assertActionAllowed({
          changeId: CHANGE_ID,
          actionId: "enter_qa",
          expectedGateVersion: enterQa.gateVersion,
          expectedSourceDbHash: enterQa.sourceDbHash,
          idempotencyKey: "enter-qa-missing-gate",
        }),
      (error) => {
        assert.ok(error instanceof PreflightBlockedError);
        assert.equal(error.envelope.status, 409);
        assert.equal(error.envelope.reasonCode, "no_latest_valid_review");
        return true;
      },
    );
  });

  it("returns 409 plus refreshed contract when the gate version drifts", () => {
    db.update(changes)
      .set({ status: "INTAKE_PENDING" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", { sourceDbHash: "prd-source-hash", gateVersion: 3 });
    seedLockedPrdBriefingAuthority();

    assert.throws(
      () =>
        assertActionAllowed({
          changeId: CHANGE_ID,
          actionId: "run_prd",
          expectedGateVersion: "2",
          expectedSourceDbHash: "prd-source-hash",
          idempotencyKey: "run-prd-key",
        }),
      (error) => {
        assert.ok(error instanceof PreflightBlockedError);
        assert.equal(error.envelope.status, 409);
        assert.equal(error.envelope.reasonCode, "gate_version_drift");
        assert.equal(error.envelope.action.enabled, false);
        assert.equal(error.envelope.action.gateVersion, "3");
        const audit = db
          .select()
          .from(stageActions)
          .where(eq(stageActions.changeId, CHANGE_ID))
          .all()
          .find((row) => row.actionId === "run_prd");
        assert.equal(audit?.reasonCode, "gate_version_drift");
        assert.equal(audit?.enabled, 0);
        return true;
      },
    );
  });

  it("returns 409 plus refreshed contract when the source DB hash drifts", () => {
    db.update(changes)
      .set({ status: "INTAKE_PENDING" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", { sourceDbHash: "prd-source-hash", gateVersion: 3 });
    seedLockedPrdBriefingAuthority();

    assert.throws(
      () =>
        assertActionAllowed({
          changeId: CHANGE_ID,
          actionId: "run_prd",
          expectedGateVersion: "3",
          expectedSourceDbHash: "stale-source-hash",
          idempotencyKey: "run-prd-key",
        }),
      (error) => {
        assert.ok(error instanceof PreflightBlockedError);
        assert.equal(error.envelope.status, 409);
        assert.equal(error.envelope.reasonCode, "source_db_hash_drift");
        assert.equal(error.envelope.action.enabled, false);
        assert.equal(error.envelope.action.sourceDbHash, "prd-source-hash");
        const audit = db
          .select()
          .from(stageActions)
          .where(eq(stageActions.changeId, CHANGE_ID))
          .all()
          .find((row) => row.actionId === "run_prd");
        assert.equal(audit?.reasonCode, "source_db_hash_drift");
        assert.equal(audit?.enabled, 0);
        return true;
      },
    );
  });

  it("allows a side-effect action with matching contract and idempotency key", () => {
    db.update(changes)
      .set({ status: "INTAKE_PENDING" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", { sourceDbHash: "prd-source-hash", gateVersion: 3 });
    seedLockedPrdBriefingAuthority();

    const action = assertActionAllowed({
      changeId: CHANGE_ID,
      actionId: "run_prd",
      expectedGateVersion: "3",
      expectedSourceDbHash: "prd-source-hash",
      idempotencyKey: "run-prd-key",
    });

    assert.equal(action.actionId, "run_prd");
    assert.equal(action.enabled, true);
  });

  it("uses the injected preflight DB for expected HEAD repo path lookup", () => {
    db.update(changes)
      .set({ status: "INTAKE_PENDING" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("PRD", { sourceDbHash: "prd-source-hash", gateVersion: 3 });
    seedLockedPrdBriefingAuthority();

    const injectedRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-injected-repo-"));
    const injectedDb = createPreflightRepositoryTestDb();
    seedInjectedPreflightChange(injectedDb, injectedRepoPath);
    const restorePreflightDb = setPreflightServiceDbForTest(injectedDb);
    let probedRepoPath: string | null = null;
    const restoreHeadProbe = setPreflightHeadProbeForTest((repoPath) => {
      probedRepoPath = repoPath;
      return HEAD_SHA;
    });
    try {
      const action = assertActionAllowed({
        changeId: CHANGE_ID,
        actionId: "run_prd",
        expectedGateVersion: "3",
        expectedSourceDbHash: "prd-source-hash",
        idempotencyKey: "run-prd-key",
        expectedHeadSha: HEAD_SHA,
      });

      assert.equal(action.actionId, "run_prd");
      assert.equal(probedRepoPath, injectedRepoPath);
    } finally {
      restoreHeadProbe();
      restorePreflightDb();
      fs.rmSync(injectedRepoPath, { recursive: true, force: true });
    }
  });

  it("uses a bounded asynchronous git probe without execSync", async () => {
    db.update(changes).set({ status: "INTAKE_PENDING" }).where(eq(changes.id, CHANGE_ID)).run();
    seedStageGate("PRD", { sourceDbHash: "prd-source-hash", gateVersion: 3 });
    seedLockedPrdBriefingAuthority();
    const source = fs.readFileSync(path.join(process.cwd(), "server/services/preflight-service.ts"), "utf8");
    assert.doesNotMatch(source, /execSync|spawnSync/);
    assert.match(source, /GIT_COMMAND_TIMEOUT_MS = 1_000/);
    assert.match(source, /GIT_OUTPUT_CAP_BYTES/);
    assert.match(source, /SIGKILL/);

    const startedAt = Date.now();
    await assert.rejects(
      () => assertActionAllowedAsync({
        changeId: CHANGE_ID,
        actionId: "run_prd",
        expectedGateVersion: "3",
        expectedSourceDbHash: "prd-source-hash",
        idempotencyKey: "async-head-probe",
        expectedHeadSha: HEAD_SHA,
      }),
      (error: unknown) => error instanceof PreflightBlockedError
        && error.envelope.reasonCode === "git_head_unavailable",
    );
    assert.ok(Date.now() - startedAt < 1_500);
  });

  it("allows TechSpec run preflight from the approved Spec contract", () => {
    db.update(changes)
      .set({ status: "SPEC_READY", gateState: "spec" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("Spec", { sourceDbHash: "spec-source-hash", gateVersion: 4 });
    seedSpecBattleRound("closed");
    seedSpecStageRunSource("spec-source-hash");

    const contract = getActions(CHANGE_ID).find((action) => action.actionId === "run_tech_spec");
    assert.ok(contract);

    const action = assertActionAllowed({
      changeId: CHANGE_ID,
      actionId: "run_tech_spec",
      expectedGateVersion: "4",
      expectedSourceDbHash: "spec-source-hash",
      idempotencyKey: "run-tech-spec-key",
    });

    assert.equal(action.actionId, "run_tech_spec");
    assert.equal(action.enabled, true);
    assert.equal(action.sourceDbHash, "spec-source-hash");
  });

  it("blocks TechSpec run preflight until the Spec battle round is closed", () => {
    db.update(changes)
      .set({ status: "SPEC_READY", gateState: "spec" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    seedStageGate("Spec", { sourceDbHash: "spec-source-hash", gateVersion: 4 });
    seedSpecBattleRound("report_ready");

    const contract = getActions(CHANGE_ID).find((action) => action.actionId === "run_tech_spec");
    assert.ok(contract);
    assert.equal(contract.enabled, false);
    assert.equal(contract.reasonCode, "spec_battle_not_closed");

    assert.throws(
      () =>
        assertActionAllowed({
          changeId: CHANGE_ID,
          actionId: "run_tech_spec",
          expectedGateVersion: "4",
          expectedSourceDbHash: "spec-source-hash",
          idempotencyKey: "run-tech-spec-key",
        }),
      (error) => {
        assert.ok(error instanceof PreflightBlockedError);
        assert.equal(error.envelope.status, 409);
        assert.equal(error.envelope.reasonCode, "spec_battle_not_closed");
        assert.equal(error.envelope.action.enabled, false);
        return true;
      },
    );
  });
});
