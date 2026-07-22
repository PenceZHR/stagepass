import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import { db } from "../db/index.ts";
import { changes, pipelineJobs, prdBriefings, projects } from "../db/schema.ts";
import { getActions } from "./action-contract-service.ts";
import { enqueuePipelineJob } from "./job-dispatch-service.ts";
import { ACTION_DEFINITIONS } from "./action-contract-registry-service.ts";
import { pipelineJobSelectionForAction } from "./pipeline-job-types.ts";

/**
 * Guards the single rule "an action whose pipeline job phase is already active
 * must be reported disabled" against the way it kept drifting: the mapping from
 * action -> job phase lived in two places (PIPELINE_JOB_ACTIONS_BY_PHASE, the
 * table the dispatcher enqueues from, and a hand-written map in
 * action-contract-stage-signal-policy), and the hand-written copy silently
 * omitted the three PRD briefing sub-steps.
 *
 * The tests below pin the user-visible symptom (contract says enabled while a
 * job for that very phase sits queued; the second POST then merges into the
 * existing job and reports success without doing anything), not the shape of
 * whichever function resolves the phase.
 */

const PROJECT_ID = "PRJ-JOB-PHASE-COVERAGE";
const CHANGE_ID = "CHG-JOB-PHASE-COVERAGE";
const NOW = "2026-07-01T00:00:00.000Z";

/**
 * Deletes every row this fixture can reach by introspection rather than by a
 * hand-listed table order. Dozens of tables FK into `changes`, and any one of
 * them left behind turns the next `beforeEach` into an opaque
 * SQLITE_CONSTRAINT_FOREIGNKEY. The FK pragma is lifted only for the sweep, so
 * ordering between child tables stops mattering.
 */
function cleanupRows() {
  db.run(sql`PRAGMA foreign_keys = OFF`);
  try {
    const tables = db
      .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map((row) => row.name);
    for (const table of tables) {
      const columns = db
        .all<{ name: string }>(sql.raw(`PRAGMA table_info('${table}')`))
        .map((row) => row.name);
      if (columns.includes("change_id")) {
        db.run(sql.raw(`DELETE FROM '${table}' WHERE change_id = '${CHANGE_ID}'`));
      }
    }
    db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
    db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
  } finally {
    db.run(sql`PRAGMA foreign_keys = ON`);
  }
}

function initCleanGitRepo(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
  execSync("git init -b main", { cwd: targetPath, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: targetPath, stdio: "ignore" });
  execSync("git config user.name 'Test User'", { cwd: targetPath, stdio: "ignore" });
  fs.writeFileSync(path.join(targetPath, "README.md"), "# job phase coverage fixture\n");
  execSync("git add .", { cwd: targetPath, stdio: "ignore" });
  execSync("git commit -m init", { cwd: targetPath, stdio: "ignore" });
}

function seedChange(repoPath: string, status: string) {
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Job phase coverage",
    repoPath,
    contextStatus: "ready",
    contextProvider: "codex",
    prdStatus: "ready",
    prdProvider: "codex",
    prdJson: null,
    prdMarkdown: null,
    gitEnabled: 0,
    gitDefaultBranch: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Job phase coverage change",
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
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

/** An open briefing with intent captured: every sub-step's own precondition met. */
function seedOpenBriefing() {
  db.insert(prdBriefings).values({
    id: "PBR-JOB-PHASE-COVERAGE",
    changeId: CHANGE_ID,
    status: "draft",
    intentText: "Ship the job phase coverage guard.",
    finalReviewJson: null,
    sourceHashesJson: "{}",
    lockedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

function insertQueuedJob(phase: string, actionId: string, id = `JOB-${phase}`) {
  db.insert(pipelineJobs).values({
    id,
    changeId: CHANGE_ID,
    phase,
    actionId,
    idempotencyKey: null,
    status: "queued",
    leasedBy: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptNo: 1,
    errorCode: null,
    errorSummary: null,
    createdAt: NOW,
    startedAt: null,
    endedAt: null,
    leaseToken: null,
    workerNonce: null,
  }).run();
}

function actionById(actionId: string) {
  return getActions(CHANGE_ID).find((entry) => entry.actionId === actionId);
}

describe("action contract pipeline job phase coverage", () => {
  let repoPath: string;

  beforeEach(() => {
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "job-phase-coverage-"));
    initCleanGitRepo(repoPath);
  });

  afterEach(() => {
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  /**
   * The reported symptom. A queued briefing job is invisible to the contract,
   * so the button stays live and the user clicks it again.
   */
  it("disables a PRD briefing sub-step while its own job is queued", () => {
    seedChange(repoPath, "INTAKE_PENDING");
    seedOpenBriefing();

    // Baseline: without a job the step really is offered. If this ever stops
    // holding, the test below would pass for the wrong reason.
    const before = actionById("run_prd_briefing_questions");
    assert.equal(before?.enabled, true, "baseline: the step must be offered before any job exists");

    insertQueuedJob("prd_briefing_questions", "run_prd_briefing_questions");

    const after = actionById("run_prd_briefing_questions");
    assert.equal(after?.enabled, false, "a queued briefing job must disable its own action");
    assert.equal(after?.reasonCode, "provider_job_running");
  });

  /**
   * The other half of the same symptom: the contract advertises the action, the
   * POST is accepted, and the unique index quietly folds it into the job that
   * was already queued -- success reported, nothing enqueued.
   */
  it("never advertises a briefing step whose second enqueue would merge into the queued job", () => {
    seedChange(repoPath, "INTAKE_PENDING");
    seedOpenBriefing();

    const first = enqueuePipelineJob({
      changeId: CHANGE_ID,
      phase: "prd_briefing_questions",
      actionId: "run_prd_briefing_questions",
    });
    assert.equal(first.created, true, "the first enqueue must create a job");

    const second = enqueuePipelineJob({
      changeId: CHANGE_ID,
      phase: "prd_briefing_questions",
      actionId: "run_prd_briefing_questions",
    });
    // This is the "202 but nothing happened" the user sees: the dispatcher is
    // behaving correctly, it is the contract that must not have offered the
    // second click.
    assert.equal(second.created, false, "the second enqueue merges into the active job");
    assert.equal(second.job.id, first.job.id);

    const action = actionById("run_prd_briefing_questions");
    assert.equal(
      action?.enabled,
      false,
      "the contract must not advertise an action whose POST would be a no-op merge",
    );
  });

  /**
   * Anti-regression for the whole family, derived from the dispatcher's own
   * table rather than from a second hand-written list. Seeding a job in an
   * action's enqueue phase must disable that action whatever else the change
   * state says -- the job fence outranks the policy verdict.
   */
  it("disables every registered action whose enqueue phase has an active job", () => {
    seedChange(repoPath, "INTAKE_PENDING");
    seedOpenBriefing();

    const guarded = ACTION_DEFINITIONS
      .map((definition) => pipelineJobSelectionForAction(definition.actionId))
      .filter((selection): selection is NonNullable<typeof selection> => selection !== null);

    // Scanner-effectiveness guard. Without it, a rename that made every lookup
    // return null would leave this test asserting over an empty list and
    // passing silently. 24 is what the registry and the dispatcher table agree
    // on today; adding provider-backed actions may raise it, never lower it.
    assert.ok(
      guarded.length >= 24,
      `expected at least 24 job-backed actions to scan, found ${guarded.length}`,
    );
    for (const actionId of [
      "run_prd_briefing_questions",
      "run_prd_briefing_draft",
      "run_prd_briefing_final_review",
    ]) {
      assert.ok(
        guarded.some((selection) => selection.actionId === actionId),
        `${actionId} must be part of the scanned set`,
      );
    }

    for (const selection of guarded) {
      db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).run();
      insertQueuedJob(selection.phase, selection.actionId, `JOB-SCAN-${selection.phase}`);

      const action = actionById(selection.actionId);
      assert.equal(
        action?.enabled,
        false,
        `${selection.actionId} must be disabled while a ${selection.phase} job is active`,
      );
      assert.equal(
        action?.reasonCode,
        "provider_job_running",
        `${selection.actionId} must report provider_job_running for phase ${selection.phase}`,
      );
    }
  });

  /**
   * The opposite edge of the same rule. Human decisions, waivers and local
   * controls never become pipeline jobs, so no queued job may ever explain why
   * one of them is unavailable. Without this, widening the action -> phase
   * lookup to answer for every action would read as a pure win: the tests above
   * would all still pass while approvals silently went dark whenever any job
   * was in flight.
   */
  it("never blames a queued job for an action that is not job-backed", () => {
    seedChange(repoPath, "INTAKE_PENDING");
    seedOpenBriefing();
    insertQueuedJob("intake", "run_prd", "JOB-NON-BACKED");

    const nonJobActionIds = ACTION_DEFINITIONS
      .map((definition) => definition.actionId)
      .filter((actionId) => pipelineJobSelectionForAction(actionId) === null);

    // Scanner-effectiveness guard, same reasoning as above: if the lookup ever
    // starts answering for everything, this list empties and the loop below
    // would assert nothing at all.
    assert.ok(
      nonJobActionIds.length >= 15,
      `expected at least 15 non-job actions to scan, found ${nonJobActionIds.length}`,
    );

    const actions = getActions(CHANGE_ID);
    for (const actionId of nonJobActionIds) {
      const action = actions.find((entry) => entry.actionId === actionId);
      assert.notEqual(
        action?.reasonCode,
        "provider_job_running",
        `${actionId} never enqueues a job, so a queued job cannot be its reason`,
      );
    }
  });
});
