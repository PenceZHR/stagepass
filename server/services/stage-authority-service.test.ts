import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { db } from "../db/index.ts";
import {
  artifactMirrors,
  changes,
  projects,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
} from "../db/schema.ts";
import {
  completeStageRun,
  computeSourceDbHash,
  getStageAuthority,
  recomputeStageGate,
  startStageRun,
  type PipelinePhase,
  type StageRunStatus,
} from "./stage-authority-service.ts";

const PROJECT_ID = "PRJ-STAGE-AUTHORITY";
const CHANGE_ID = "CHG-STAGE-AUTHORITY";
const PHASE: PipelinePhase = "Build";

function cleanupRows() {
  db.delete(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).run();
  db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
  db.delete(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(repoPath: string) {
  const now = "2026-06-29T00:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Stage authority",
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
    title: "Stage authority change",
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
}

function completeAttempt(
  status: StageRunStatus | "passed_with_warnings",
  attemptNo?: number,
) {
  const run = startStageRun({
    changeId: CHANGE_ID,
    phase: PHASE,
    attemptNo,
    inputDbHash: `input-${attemptNo ?? "next"}`,
    startedAt: `2026-06-29T00:0${attemptNo ?? 1}:00.000Z`,
  });
  return completeStageRun({
    runId: run.id,
    status,
    reportDbHash: ["passed", "issues_found", "passed_with_warnings"].includes(status)
      ? `report-${run.attemptNo}`
      : null,
    counts: { attemptNo: run.attemptNo },
    completedAt: `2026-06-29T00:1${run.attemptNo}:00.000Z`,
    generatedAt: `2026-06-29T00:1${run.attemptNo}:00.000Z`,
  });
}

describe("stage-authority-service", () => {
  let repoPath: string;

  beforeEach(() => {
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "stage-authority-"));
    seedChange(repoPath);
  });

  afterEach(() => {
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("exports the planned public API types", () => {
    const phase: PipelinePhase = "QA";
    const status: StageRunStatus = "invalid_output";

    assert.equal(phase, "QA");
    assert.equal(status, "invalid_output");
  });

  it("does not expose legacy_incomplete through completeStageRun status", () => {
    if (false) {
      // @ts-expect-error legacy imports must not complete a stage run.
      completeStageRun({ runId: "STG-RUN-LEGACY", status: "legacy_incomplete" });
    }

    assert.equal(true, true);
  });

  it("keeps latestAttempt on the largest attemptNo while latestValidReport only accepts complete fresh valid reports", () => {
    const first = completeAttempt("passed", 1);
    const second = completeAttempt("failed", 2);

    const snapshot = getStageAuthority(CHANGE_ID, PHASE);

    assert.equal(snapshot.latestAttempt?.id, second.sourceRunId);
    assert.equal(snapshot.latestAttempt?.attemptNo, 2);
    assert.equal(snapshot.latestReport?.id, second.id);
    assert.equal(snapshot.latestValidReport?.id, first.id);
    assert.equal(snapshot.state?.latestValidReportId, first.id);
  });

  it("does not allow invalid, inconsistent, legacy, stale, or DB-incomplete reports to become latest valid", () => {
    const valid = completeAttempt("issues_found", 1);
    completeAttempt("invalid_output", 2);
    completeAttempt("data_inconsistent", 3);
    db.insert(stageReports).values({
      id: "SRP-LEGACY-INCOMPLETE",
      changeId: CHANGE_ID,
      phase: PHASE,
      sourceRunId: null,
      status: "legacy_incomplete",
      countsJson: null,
      isFresh: 1,
      staleReason: null,
      reportDbHash: "legacy-hash",
      generatedAt: "2026-06-29T00:40:00.000Z",
    }).run();
    db.insert(stageReports).values({
      id: "SRP-STALE",
      changeId: CHANGE_ID,
      phase: PHASE,
      sourceRunId: null,
      status: "passed",
      countsJson: null,
      isFresh: 0,
      staleReason: "source changed",
      reportDbHash: "stale-hash",
      generatedAt: "2026-06-29T00:41:00.000Z",
    }).run();
    db.insert(stageReports).values({
      id: "SRP-INCOMPLETE",
      changeId: CHANGE_ID,
      phase: PHASE,
      sourceRunId: null,
      status: "passed",
      countsJson: null,
      isFresh: 1,
      staleReason: null,
      reportDbHash: null,
      generatedAt: "2026-06-29T00:42:00.000Z",
    }).run();

    const gate = recomputeStageGate({
      changeId: CHANGE_ID,
      phase: PHASE,
      status: "blocked",
      blockers: [{ reason: "not relevant to latest valid selection" }],
      rows: [{ table: "stage_reports", id: "SRP-STALE" }],
      computedAt: "2026-06-29T00:43:00.000Z",
    });
    const snapshot = getStageAuthority(CHANGE_ID, PHASE);

    assert.equal(gate.status, "blocked");
    assert.equal(snapshot.latestValidReport?.id, valid.id);
    assert.equal(snapshot.state?.latestValidReportId, valid.id);
  });

  it("does not let an older attempt late recompute overwrite a newer valid report", () => {
    const older = completeAttempt("passed", 1);
    const newer = completeAttempt("passed", 2);
    db.insert(stageReports).values({
      id: "SRP-OLDER-LATE",
      changeId: CHANGE_ID,
      phase: PHASE,
      sourceRunId: older.sourceRunId,
      status: "passed",
      countsJson: null,
      isFresh: 1,
      staleReason: null,
      reportDbHash: "older-late-hash",
      generatedAt: "2026-06-29T00:59:00.000Z",
    }).run();

    const snapshot = getStageAuthority(CHANGE_ID, PHASE);

    assert.equal(snapshot.latestValidReport?.id, newer.id);
    assert.equal(snapshot.state?.latestValidReportId, newer.id);
  });

  it("ignores missing or mismatched artifact mirrors when selecting latest valid", () => {
    const report = completeAttempt("passed_with_warnings", 1);
    db.insert(artifactMirrors).values({
      id: "MIRROR-MISMATCH",
      changeId: CHANGE_ID,
      phase: PHASE,
      artifactType: "build_report",
      path: path.join(repoPath, ".ship", "changes", CHANGE_ID, "missing-report.md"),
      contentHash: "different",
      sourceDbHash: "different-source",
      schemaVersion: "test/v1",
      mirrorStatus: "mismatch",
      generatedAt: "2026-06-29T00:20:00.000Z",
    }).run();

    const snapshot = getStageAuthority(CHANGE_ID, PHASE);

    assert.equal(snapshot.latestValidReport?.id, report.id);
    assert.equal(snapshot.state?.latestValidReportId, report.id);
  });

  it("computes sourceDbHash deterministically from DB rows without reading .ship files", () => {
    const shipFile = path.join(repoPath, ".ship", "changes", CHANGE_ID, "plan.md");
    fs.mkdirSync(path.dirname(shipFile), { recursive: true });
    fs.writeFileSync(shipFile, "first");
    const rows = [
      { id: "b", values: { beta: 2, alpha: 1 } },
      { id: "a", values: ["z", "y"] },
    ];

    const before = computeSourceDbHash({ changeId: CHANGE_ID, phase: PHASE, rows });
    fs.writeFileSync(shipFile, "second");
    const after = computeSourceDbHash({
      phase: PHASE,
      changeId: CHANGE_ID,
      rows: [
        { values: { alpha: 1, beta: 2 }, id: "b" },
        { values: ["z", "y"], id: "a" },
      ],
    });

    assert.equal(after, before);
  });

  it("persists stage gates with a DB-derived source hash and updates authority state", () => {
    const gate = recomputeStageGate({
      changeId: CHANGE_ID,
      phase: PHASE,
      status: "passed",
      blockers: [],
      freshness: { fresh: true },
      requiredActions: [{ actionId: "continue", enabled: true }],
      rows: [{ table: "stage_reports", id: "SRP-1", status: "passed" }],
      computedAt: "2026-06-29T00:30:00.000Z",
    });
    const authority = getStageAuthority(CHANGE_ID, PHASE);

    assert.match(gate.sourceDbHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(authority.latestGate?.id, gate.id);
    assert.equal(authority.state?.latestGateId, gate.id);
  });

  it("rejects duplicate attempt numbers through the service entrypoint", () => {
    startStageRun({ changeId: CHANGE_ID, phase: PHASE, attemptNo: 1 });

    assert.throws(
      () => startStageRun({ changeId: CHANGE_ID, phase: PHASE, attemptNo: 1 }),
      /Stage run attempt already exists/,
    );
  });

  it("uses non-sequential generated run ids with sequential automatic attempt numbers", () => {
    const first = startStageRun({ changeId: CHANGE_ID, phase: PHASE });
    const second = startStageRun({ changeId: CHANGE_ID, phase: PHASE });

    assert.match(first.id, /^STG-RUN-/);
    assert.match(second.id, /^STG-RUN-/);
    assert.notEqual(first.id, second.id);
    assert.equal(first.attemptNo, 1);
    assert.equal(second.attemptNo, 2);
  });

  it("uses stable tie-breakers when timestamps match", () => {
    const sameTime = "2026-06-29T00:50:00.000Z";
    db.insert(stageRuns).values([
      {
        id: "STG-RUN-A",
        changeId: CHANGE_ID,
        phase: PHASE,
        attemptNo: 7,
        status: "passed",
        idempotencyKey: null,
        inputDbHash: null,
        outputDbHash: null,
        sourceLineageJson: null,
        errorCode: null,
        startedAt: sameTime,
        completedAt: sameTime,
      },
      {
        id: "STG-RUN-B",
        changeId: CHANGE_ID,
        phase: PHASE,
        attemptNo: 7,
        status: "passed",
        idempotencyKey: null,
        inputDbHash: null,
        outputDbHash: null,
        sourceLineageJson: null,
        errorCode: null,
        startedAt: sameTime,
        completedAt: sameTime,
      },
    ]).run();
    db.insert(stageReports).values([
      {
        id: "SRP-A",
        changeId: CHANGE_ID,
        phase: PHASE,
        sourceRunId: "STG-RUN-B",
        status: "passed",
        countsJson: null,
        isFresh: 1,
        staleReason: null,
        reportDbHash: "report-a",
        generatedAt: sameTime,
      },
      {
        id: "SRP-Z",
        changeId: CHANGE_ID,
        phase: PHASE,
        sourceRunId: "STG-RUN-B",
        status: "passed",
        countsJson: null,
        isFresh: 1,
        staleReason: null,
        reportDbHash: "report-z",
        generatedAt: sameTime,
      },
    ]).run();
    recomputeStageGate({
      id: "STG-GATE-A",
      changeId: CHANGE_ID,
      phase: PHASE,
      status: "blocked",
      gateVersion: 1,
      computedAt: sameTime,
    });
    recomputeStageGate({
      id: "STG-GATE-B",
      changeId: CHANGE_ID,
      phase: PHASE,
      status: "passed",
      gateVersion: 2,
      computedAt: sameTime,
    });

    const snapshot = getStageAuthority(CHANGE_ID, PHASE);

    assert.equal(snapshot.latestAttempt?.id, "STG-RUN-B");
    assert.equal(snapshot.latestReport?.id, "SRP-Z");
    assert.equal(snapshot.latestValidReport?.id, "SRP-Z");
    assert.equal(snapshot.latestGate?.id, "STG-GATE-B");
  });

  it("increments gateVersion by default instead of always writing 1", () => {
    const first = recomputeStageGate({ changeId: CHANGE_ID, phase: PHASE, status: "blocked" });
    const second = recomputeStageGate({ changeId: CHANGE_ID, phase: PHASE, status: "passed" });
    const third = recomputeStageGate({ changeId: CHANGE_ID, phase: PHASE, status: "passed" });

    assert.equal(first.gateVersion, 1);
    assert.equal(second.gateVersion, 2);
    assert.equal(third.gateVersion, 3);

    const latest = getStageAuthority(CHANGE_ID, PHASE);
    assert.equal(latest.latestGate?.id, third.id);
  });
});
