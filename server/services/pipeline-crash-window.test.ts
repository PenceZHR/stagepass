import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "../db/index.ts";
import {
  changes,
  events,
  pipelineJobs,
  projects,
  providerRunProcesses,
  runs,
} from "../db/schema.ts";
import { leaseNextPipelineJob } from "./pipeline-job-lease-service.ts";
import { beginStageRun, endStageRun } from "./pipeline-run-ledger-service.ts";

/**
 * Both windows below are states a crash actually leaves behind, seeded directly
 * rather than by killing a process. See docs/state-projection-audit-2026-07-14.md.
 *
 * They share one root cause: recovery only ever looks at changes that have a
 * *running* run row (stale-provider-run-recovery-service.ts:267). A crash that
 * leaves no run row, or leaves the run row already terminal, is invisible to it.
 */

const PROJECT_ID = "PRJ-CRASH-WINDOW";
const CHANGE_ID = "CHG-CRASH-WINDOW";
const JOB_ID = "JOB-CRASH-WINDOW";
const RUN_ID = "RUN-CRASH-WINDOW";

const NOW = "2026-07-14T00:00:00.000Z";
// Sorts before any other job the suite may have left behind, so the lease scan
// reaches this job first and the test cannot go green by picking someone else's.
const EPOCH = "1970-01-01T00:00:00.000Z";
const LEASE_EXPIRED_AT = "2026-07-14T00:00:30.000Z";
const AFTER_LEASE_EXPIRY = new Date("2026-07-14T00:05:00.000Z");

function cleanupRows(): void {
  db.delete(providerRunProcesses).where(eq(providerRunProcesses.changeId, CHANGE_ID)).run();
  db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).run();
  // The status transition writes an event, and events reference both runs and changes.
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(status: string): void {
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Crash window",
    repoPath: process.cwd(),
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
    title: "Crash window",
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

beforeEach(cleanupRows);
afterEach(cleanupRows);

describe("crash window: run completed, job not closed", () => {
  /**
   * endRun() commits, then the process dies before completePipelineJob() commits.
   * The job is left `running` with a lease that will expire.
   */
  function seedCompletedRunWithOpenJob(): void {
    seedChange("IMPLEMENTING");
    db.insert(pipelineJobs).values({
      id: JOB_ID,
      changeId: CHANGE_ID,
      phase: "implement",
      actionId: "run_build",
      idempotencyKey: "crash-window-run-build",
      status: "running",
      leasedBy: "worker-crashed",
      leaseExpiresAt: LEASE_EXPIRED_AT,
      heartbeatAt: NOW,
      attemptNo: 1,
      createdAt: EPOCH,
      startedAt: NOW,
      leaseToken: "LEASE-TOKEN-1",
      workerNonce: "nonce-crashed",
      provider: "codex",
    }).run();
    // The business run already finished successfully — the work is done.
    db.insert(runs).values({
      id: RUN_ID,
      changeId: CHANGE_ID,
      phase: "implement",
      status: "completed",
      startedAt: NOW,
      endedAt: NOW,
      summary: "build finished",
      jobId: JOB_ID,
      workerId: "worker-crashed",
      leaseToken: "LEASE-TOKEN-1",
      attemptNo: 1,
      provider: "codex",
    }).run();
  }

  it("does not re-dispatch a job whose run already completed", () => {
    seedCompletedRunWithOpenJob();

    const leased = leaseNextPipelineJob({
      workerId: "worker-fresh",
      workerNonce: "nonce-fresh",
      now: AFTER_LEASE_EXPIRY,
    });

    assert.notEqual(
      leased?.job.id,
      JOB_ID,
      "the lease scan handed out a job whose business run is already completed -- the finished " +
        "action would run a second time",
    );

    const job = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, JOB_ID)).get();
    assert.notEqual(job?.status, "running", "the orphaned job was left running");
    assert.equal(job?.attemptNo, 1, "the completed action was re-attempted");
  });
});

describe("crash window: status advanced, run row never created", () => {
  /**
   * The orchestrator used to set the status and create the run in two separate
   * transactions. A crash in between advanced changes.status with no run row
   * behind it -- and since recovery selects candidates from `runs`, the change
   * was invisible to it and stuck for good, with both the forward action and the
   * retry action gated off.
   *
   * The fix is prevention, not compensation: the two writes now share one
   * transaction, so the state cannot be produced. This asserts the rollback --
   * a colliding run id makes the insert fail after the status transition has
   * already been applied inside the transaction.
   */
  it("rolls the status back when the run row cannot be written", () => {
    seedChange("PLAN_APPROVED");
    db.insert(runs).values({
      id: RUN_ID,
      changeId: CHANGE_ID,
      phase: "implement",
      status: "completed",
      startedAt: NOW,
      endedAt: NOW,
      summary: "occupies the run id",
      provider: "codex",
    }).run();

    assert.throws(() => beginStageRun({
      changeId: CHANGE_ID,
      phase: "implement",
      runningStatus: "IMPLEMENTING",
      runId: RUN_ID,
    }));

    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    assert.equal(
      change?.status,
      "PLAN_APPROVED",
      "the status advanced without a run row landing -- recovery selects candidates from `runs`, " +
        "so this change would be invisible to it and stuck for good",
    );
  });

  it("writes the status and the run row together", () => {
    seedChange("PLAN_APPROVED");

    const runId = beginStageRun({
      changeId: CHANGE_ID,
      phase: "implement",
      runningStatus: "IMPLEMENTING",
    });

    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    assert.equal(change?.status, "IMPLEMENTING");
    assert.equal(run?.status, "running");
    assert.equal(run?.changeId, CHANGE_ID);
  });
});

describe("crash window: run ends, status never advances (D6 Tier 1 exit-side gap)", () => {
  /**
   * stage-orchestrator-service.ts's three helpers used to call endRun() and
   * setStatus() as two separate transactions on every exit path. A crash in
   * between left the run terminal with the status stuck at the running phase --
   * the same dead end beginStageRun closes on entry, just on exit. endStageRun
   * closes it the same way: one transaction, both writes, or neither.
   */
  function seedRunningRun(): void {
    seedChange("IMPLEMENTING");
    db.insert(runs).values({
      id: RUN_ID,
      changeId: CHANGE_ID,
      phase: "implement",
      status: "running",
      startedAt: NOW,
      endedAt: null,
      summary: null,
      provider: "codex",
    }).run();
  }

  it("writes the run end and the status together", () => {
    seedRunningRun();

    endStageRun({
      changeId: CHANGE_ID,
      runId: RUN_ID,
      status: "IMPLEMENTED",
      summary: "build finished",
      success: true,
    });

    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    const run = db.select().from(runs).where(eq(runs.id, RUN_ID)).get();
    assert.equal(change?.status, "IMPLEMENTED");
    assert.equal(run?.status, "completed");
  });

  it("leaves the run running when the paired status transition is illegal", () => {
    seedRunningRun();

    assert.throws(() => endStageRun({
      changeId: CHANGE_ID,
      runId: RUN_ID,
      status: "DONE", // not a legal target from IMPLEMENTING
      summary: "not a legal target",
      success: true,
    }));

    const run = db.select().from(runs).where(eq(runs.id, RUN_ID)).get();
    assert.equal(
      run?.status,
      "running",
      "the run must not end up terminal when the status write it's paired with fails -- otherwise " +
        "recovery, which only selects candidates with a running run, would never see this change again",
    );
  });
});
