import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";

import { db } from "../db/index.ts";
import {
  artifactMirrors,
  changes,
  projects,
  qaCommandResults,
  qaEvidence,
  qaFailures,
  qaRuns,
  requiredValidationCommands,
  stageActions,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
  planSnapshots,
  testplanSnapshots,
} from "../db/schema.ts";
import {
  recordQaCommandResult,
  recomputeQaGate,
  startQaRun,
} from "./qa-run-service.ts";

const PROJECT_ID = "PRJ-QA-RUN-T12";
const CHANGE_ID = "CHG-QA-RUN-T12";

function nowISO(): string {
  return new Date().toISOString();
}

function cleanupRows() {
  const runIds = db
    .select({ id: qaRuns.id })
    .from(qaRuns)
    .where(eq(qaRuns.changeId, CHANGE_ID))
    .all()
    .map((row) => row.id);
  for (const runId of runIds) {
    db.delete(qaEvidence).where(eq(qaEvidence.qaRunId, runId)).run();
    db.delete(qaFailures).where(eq(qaFailures.qaRunId, runId)).run();
    db.delete(qaCommandResults).where(eq(qaCommandResults.qaRunId, runId)).run();
  }
  db.delete(qaRuns).where(eq(qaRuns.changeId, CHANGE_ID)).run();
  db.delete(stageActions).where(eq(stageActions.changeId, CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
  db.delete(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
  db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
  db.delete(artifactMirrors).where(eq(artifactMirrors.changeId, CHANGE_ID)).run();
  db.delete(requiredValidationCommands).where(eq(requiredValidationCommands.changeId, CHANGE_ID)).run();
  db.delete(testplanSnapshots).where(eq(testplanSnapshots.changeId, CHANGE_ID)).run();
  db.delete(planSnapshots).where(eq(planSnapshots.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(repoPath: string) {
  const now = nowISO();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "QA run Task 12",
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
    title: "QA run DB authority",
    status: "IMPLEMENTED",
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

function seedRequiredCommand(command: string) {
  const now = nowISO();
  db.insert(testplanSnapshots).values({
    id: "TESTPLAN-QA-RUN-T12",
    changeId: CHANGE_ID,
    status: "approved",
    testIntent: "QA command DB authority",
    schemaVersion: "testplan/v1",
    approvalState: "approved",
    snapshotDbHash: "testplan-qa-run-hash",
    approvedAt: now,
    approvalDecisionId: null,
    createdAt: now,
  }).run();
  db.insert(requiredValidationCommands).values({
    id: "REQ-QA-RUN-T12",
    changeId: CHANGE_ID,
    phase: "TestPlan",
    sourceSnapshotId: "TESTPLAN-QA-RUN-T12",
    command,
    commandOrder: 1,
    required: 1,
    createdAt: now,
  }).run();
}

/** What plan-snapshot-service writes when a Plan declares validationCommands. */
function seedPlanDeclaredCommand(command: string) {
  const now = nowISO();
  db.insert(planSnapshots).values({
    id: "PLAN-QA-RUN-T12",
    changeId: CHANGE_ID,
    status: "approved",
    schemaVersion: "plan/v1",
    snapshotDbHash: "plan-qa-run-hash",
    approvedAt: now,
    createdAt: now,
  }).run();
  db.insert(requiredValidationCommands).values({
    id: `REQ-PLAN-QA-RUN-T12-${command.replace(/\W+/g, "-")}`,
    changeId: CHANGE_ID,
    phase: "Plan",
    sourceSnapshotId: "PLAN-QA-RUN-T12",
    command,
    commandOrder: 1,
    required: 1,
    createdAt: now,
  }).run();
}

describe("qa-run-service", { concurrency: false }, () => {
  let repoPath: string;

  beforeEach(() => {
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "qa-run-t12-"));
    seedChange(repoPath);
  });

  afterEach(() => {
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  /**
   * QA's required set is TestPlan-only, so a command the Plan stage declared as
   * required was dropped without a word. Measured in the shipped database: 21
   * Plan-declared commands across three changes (5 / 7 / 9) and QA ran exactly
   * one on each -- `git diff --check` -- then reported MERGE_READY.
   *
   * The gate names them rather than running them. Plan's list mixes real checks
   * with human steps (`open -a "Google Chrome" index.html` is one of the 21),
   * and QA executes through execSync, so adopting them wholesale would launch a
   * browser mid-QA and fail outright anywhere headless.
   */
  it("refuses the QA gate while a Plan-declared command is uncovered, naming it", () => {
    seedRequiredCommand("node -e \"process.exit(0)\"");
    const run = startQaRun({ changeId: CHANGE_ID });
    recordQaCommandResult({
      qaRunId: run.id,
      commandOrder: 1,
      command: "node -e \"process.exit(0)\"",
      status: "passed",
      exitCode: 0,
      durationMs: 5,
      evidence: "passed",
    });

    // Baseline first: every TestPlan-required command passed, so this run is
    // genuinely green. Asserting it here is what makes the second half mean
    // something -- otherwise "not passed" could be true for some unrelated
    // reason and the test would pass with the gate change removed.
    const before = recomputeQaGate(CHANGE_ID);
    assert.equal(before.status, "passed", before.blockersJson ?? "null");

    // The only thing that changes between the two recomputes.
    seedPlanDeclaredCommand("pnpm test");
    const after = recomputeQaGate(CHANGE_ID);

    assert.notEqual(after.status, "passed");
    const blockers = JSON.parse(after.blockersJson ?? "[]") as Array<{ title: string }>;
    const uncovered = blockers.filter((blocker) => blocker.title.includes("pnpm test"));
    assert.equal(uncovered.length, 1, after.blockersJson ?? "null");
    assert.match(uncovered[0].title, /TestPlan does not cover it/);
  });

  it("passes the QA gate once the TestPlan covers the Plan-declared command", () => {
    // The other direction: this must be a gate on an actual gap, not a
    // permanent block on every change whose Plan declared anything.
    seedRequiredCommand("pnpm test");
    seedPlanDeclaredCommand("pnpm test");

    const run = startQaRun({ changeId: CHANGE_ID });
    recordQaCommandResult({
      qaRunId: run.id,
      commandOrder: 1,
      command: "pnpm test",
      status: "passed",
      exitCode: 0,
      durationMs: 5,
      evidence: "passed",
    });

    const gate = recomputeQaGate(CHANGE_ID);

    assert.equal(gate.status, "passed", gate.blockersJson ?? "null");
    const blockers = JSON.parse(gate.blockersJson ?? "[]") as Array<{ title: string }>;
    assert.equal(blockers.filter((b) => b.title.includes("does not cover")).length, 0);
  });

  it("starts QA from DB required_validation_commands and ignores Markdown test logs", () => {
    seedRequiredCommand("node -e \"console.log('DB_QA_COMMAND')\"");
    const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
    fs.mkdirSync(changeDir, { recursive: true });
    fs.writeFileSync(path.join(changeDir, "test-plan-delta.md"), "node -e \"console.log('MARKDOWN_COMMAND')\"\n");
    fs.writeFileSync(path.join(changeDir, "qa-log.md"), "passed\n");

    const run = startQaRun({
      changeId: CHANGE_ID,
      sourceReviewReportId: null,
      sourceBuildRunId: "build-qa-run-t12",
      sourceHeadSha: "h".repeat(40),
      idempotencyKey: "qa-run-db-command",
    });

    const commandRows = db
      .select()
      .from(qaCommandResults)
      .where(eq(qaCommandResults.qaRunId, run.id))
      .all();
    assert.deepEqual(commandRows.map((row) => row.command), [
      "node -e \"console.log('DB_QA_COMMAND')\"",
    ]);
    assert.equal(commandRows[0]?.status, "pending");
  });

  it("writes command results, evidence, failures, retries, and the QA stage gate to DB", () => {
    seedRequiredCommand("node -e \"process.exit(1)\"");

    const failedRun = startQaRun({
      changeId: CHANGE_ID,
      sourceReviewReportId: null,
      sourceBuildRunId: "build-qa-run-t12",
      sourceHeadSha: "h".repeat(40),
      idempotencyKey: "qa-run-failed",
    });
    recordQaCommandResult({
      qaRunId: failedRun.id,
      commandOrder: 1,
      command: "node -e \"process.exit(1)\"",
      status: "failed",
      exitCode: 1,
      durationMs: 12,
      evidence: "exit 1",
      requiredFix: "Make the command pass",
    });
    const failedGate = recomputeQaGate(CHANGE_ID);
    assert.equal(failedGate.phase, "QA");
    assert.equal(failedGate.status, "failed");

    const retryRun = startQaRun({
      changeId: CHANGE_ID,
      sourceReviewReportId: null,
      sourceBuildRunId: "build-qa-run-t12",
      sourceHeadSha: "h".repeat(40),
      idempotencyKey: "qa-run-retry",
    });
    recordQaCommandResult({
      qaRunId: retryRun.id,
      commandOrder: 1,
      command: "node -e \"process.exit(1)\"",
      status: "passed",
      exitCode: 0,
      durationMs: 8,
      evidence: "passed on retry",
    });
    const passedGate = recomputeQaGate(CHANGE_ID);

    assert.equal(passedGate.status, "passed");
    assert.equal(db.select().from(qaRuns).where(eq(qaRuns.changeId, CHANGE_ID)).all().length, 2);
    assert.equal(
      db.select().from(qaFailures).where(eq(qaFailures.qaRunId, failedRun.id)).all().length,
      1,
    );
    assert.equal(
      db.select().from(qaEvidence).where(eq(qaEvidence.qaRunId, retryRun.id)).all().length,
      1,
    );
  });

  it("stores a sha256 in qa_evidence.content_hash and never the raw evidence text", () => {
    seedRequiredCommand("node -e \"process.exit(0)\"");
    const mirrorHash = "a".repeat(64);

    const run = startQaRun({
      changeId: CHANGE_ID,
      sourceReviewReportId: null,
      sourceBuildRunId: "build-qa-hash",
      sourceHeadSha: "h".repeat(40),
      idempotencyKey: "qa-run-hash",
    });

    // Evidence summary only: the column is a hash, so it must stay null rather
    // than fall back to the summary text (the historical D2 bug wrote "passed").
    recordQaCommandResult({
      qaRunId: run.id,
      commandOrder: 1,
      command: "node -e \"process.exit(0)\"",
      status: "passed",
      exitCode: 0,
      durationMs: 5,
      evidence: "passed",
    });

    // A real mirror hash is persisted verbatim.
    recordQaCommandResult({
      qaRunId: run.id,
      commandOrder: 2,
      command: "node -e \"process.exit(0)\"",
      status: "passed",
      exitCode: 0,
      durationMs: 6,
      evidence: "passed",
      evidenceContentHash: mirrorHash,
    });

    // Anything that is not a sha256 is rejected, not persisted as a fake hash.
    recordQaCommandResult({
      qaRunId: run.id,
      commandOrder: 3,
      command: "node -e \"process.exit(0)\"",
      status: "passed",
      exitCode: 0,
      durationMs: 7,
      evidence: "passed",
      evidenceContentHash: "not-a-hash",
    });

    const hashes = db
      .select()
      .from(qaEvidence)
      .where(eq(qaEvidence.qaRunId, run.id))
      .all()
      .map((row) => row.contentHash);

    assert.equal(hashes.length, 3);
    assert.deepEqual(hashes, [null, mirrorHash, null]);
    for (const hash of hashes) {
      assert.notEqual(hash, "passed", "raw evidence text must never land in content_hash");
      if (hash !== null) assert.match(hash, /^[0-9a-f]{64}$/);
    }
  });

  it("keeps QA gate freshness tied to the QA source HEAD without delivery HEAD evidence", () => {
    seedRequiredCommand("node -e \"process.exit(0)\"");
    const qaInputHead = "h".repeat(40);
    const run = startQaRun({
      changeId: CHANGE_ID,
      sourceReviewReportId: null,
      sourceBuildRunId: "build-qa-run-t12",
      sourceHeadSha: qaInputHead,
      idempotencyKey: "qa-run-delivery-head",
    });
    recordQaCommandResult({
      qaRunId: run.id,
      commandOrder: 1,
      command: "node -e \"process.exit(0)\"",
      status: "passed",
      exitCode: 0,
      durationMs: 8,
      evidence: "passed before delivery commit",
    });
    const passedGate = recomputeQaGate(CHANGE_ID);
    const persistedRun = db.select().from(qaRuns).where(eq(qaRuns.id, run.id)).get();
    const gate = db
      .select()
      .from(stageGates)
      .where(eq(stageGates.changeId, CHANGE_ID))
      .all()
      .filter((candidate) => candidate.phase === "QA")
      .sort((left, right) => {
        const time = Date.parse(right.computedAt) - Date.parse(left.computedAt);
        if (Number.isFinite(time) && time !== 0) return time;
        return right.id.localeCompare(left.id);
      })[0];
    const freshness = JSON.parse(gate?.freshnessJson ?? "{}") as {
      sourceHeadSha?: string;
      deliveryHeadSha?: string;
      deliveryEvidenceId?: string;
    };

    assert.equal(passedGate.status, "passed");
    assert.equal(persistedRun?.sourceHeadSha, qaInputHead);
    assert.equal(freshness.sourceHeadSha, qaInputHead);
    assert.equal(
      db
        .select()
        .from(qaEvidence)
        .where(eq(qaEvidence.qaRunId, run.id))
        .all()
        .some((candidate) => candidate.evidenceType === "qa_delivery_head"),
      false,
    );
    assert.equal(freshness.deliveryHeadSha, undefined);
    assert.equal(freshness.deliveryEvidenceId, undefined);
  });

  it("does not pass the QA gate from a Markdown log that says passed", () => {
    const changeDir = path.join(repoPath, ".ship", "changes", CHANGE_ID);
    fs.mkdirSync(changeDir, { recursive: true });
    fs.writeFileSync(path.join(changeDir, "qa-log.md"), "# QA\npassed\n");

    const gate = recomputeQaGate(CHANGE_ID);

    assert.notEqual(gate.status, "passed");
    assert.equal(db.select().from(qaRuns).where(eq(qaRuns.changeId, CHANGE_ID)).all().length, 0);
  });
});
