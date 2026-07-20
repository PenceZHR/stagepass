import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";

import { databasePath, db } from "../db";
import { changes, pipelineJobs, projects, runs } from "../db/schema";
import {
  RunLedgerMutationTargetMissingError,
  runLedgerRepository,
} from "../repositories/run-ledger-repository";
import type { JobExecutionContext } from "./job-execution-context";
import {
  assertCurrentExecutionFence,
  withCurrentExecutionFenceWrite,
  withExecutionFence,
} from "./execution-fence-service";

const PROJECT_ID = "PRJ-EXECUTION-FENCE";
const CHANGE_ID = "CHG-EXECUTION-FENCE";
const RUN_ID = "RUN-EXECUTION-FENCE";

const context: JobExecutionContext = {
  jobId: "PJOB-EXECUTION-FENCE",
  workerId: "worker-execution-fence",
  leaseToken: "lease-execution-fence-attempt-1",
  attemptNo: 1,
};

function cleanup(): void {
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedCurrentExecution(): void {
  const now = "2026-07-10T10:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Execution fence",
    repoPath: "/tmp/execution-fence",
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
    title: "Fence writes",
    status: "PLAN_READY",
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
  db.insert(pipelineJobs).values({
    id: context.jobId,
    changeId: CHANGE_ID,
    phase: "generate_plan",
    actionId: "run_plan",
    idempotencyKey: "execution-fence-attempt-1",
    status: "running",
    leasedBy: context.workerId,
    leaseExpiresAt: "2099-07-10T10:30:00.000Z",
    heartbeatAt: now,
    attemptNo: context.attemptNo,
    errorCode: null,
    errorSummary: null,
    createdAt: now,
    startedAt: now,
    endedAt: null,
    leaseToken: context.leaseToken,
    workerNonce: "worker-nonce-execution-fence",
  }).run();
}

describe("execution fence service", { concurrency: false }, () => {
  beforeEach(() => {
    cleanup();
    seedCurrentExecution();
  });

  afterEach(cleanup);

  it("persists execution identity on runs created in a current fence scope", async () => {
    await withExecutionFence(context, async () => {
      assertCurrentExecutionFence(context);
      runLedgerRepository.createRun({
        id: RUN_ID,
        changeId: CHANGE_ID,
        phase: "generate_plan",
        status: "running",
        startedAt: "2026-07-10T10:01:00.000Z",
        endedAt: null,
        summary: null,
      });
    });

    const row = db.select().from(runs).where(eq(runs.id, RUN_ID)).get();
    assert.equal(row?.jobId, context.jobId);
    assert.equal(row?.workerId, context.workerId);
    assert.equal(row?.leaseToken, context.leaseToken);
    assert.equal(row?.attemptNo, context.attemptNo);
  });

  it("rejects an old attempt before its terminal business write", async () => {
    await withExecutionFence(context, async () => {
      runLedgerRepository.createRun({
        id: RUN_ID,
        changeId: CHANGE_ID,
        phase: "generate_plan",
        status: "running",
        startedAt: "2026-07-10T10:01:00.000Z",
        endedAt: null,
        summary: null,
      });
    });
    db.update(pipelineJobs).set({
      leasedBy: "worker-execution-fence-attempt-2",
      leaseToken: "lease-execution-fence-attempt-2",
      attemptNo: 2,
    }).where(eq(pipelineJobs.id, context.jobId)).run();

    await assert.rejects(
      () => withExecutionFence(context, async () => {
        runLedgerRepository.endRun(RUN_ID, {
          status: "completed",
          endedAt: "2026-07-10T10:02:00.000Z",
          summary: "old attempt must not win",
        });
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "stale_lease_fence");
        return true;
      },
    );

    const row = db.select().from(runs).where(eq(runs.id, RUN_ID)).get();
    assert.equal(row?.status, "running");
    assert.equal(row?.endedAt, null);
  });

  it("rejects an old attempt before patching change metadata for its run", async () => {
    await withExecutionFence(context, async () => {
      runLedgerRepository.createRun({
        id: RUN_ID,
        changeId: CHANGE_ID,
        phase: "generate_plan",
        status: "running",
        startedAt: "2026-07-10T10:01:00.000Z",
        endedAt: null,
        summary: null,
      });
    });
    await withExecutionFence(context, async () => {
      db.update(pipelineJobs).set({
        leasedBy: "worker-execution-fence-attempt-2",
        leaseToken: "lease-execution-fence-attempt-2",
        attemptNo: 2,
      }).where(eq(pipelineJobs.id, context.jobId)).run();

      assert.throws(
        () => {
        runLedgerRepository.patchChange(CHANGE_ID, {
          codexThreadId: "stale-thread",
        }, { runId: RUN_ID });
        },
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "stale_lease_fence");
          return true;
        },
      );
    });

    const row = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    assert.equal(row?.codexThreadId, null);
  });

  it("holds the lease check and business mutation in one SQLite write transaction", async () => {
    const competitor = new Database(databasePath);
    competitor.pragma("busy_timeout = 0");
    try {
      await withExecutionFence(context, async () => {
        withCurrentExecutionFenceWrite("test.atomic-fence", undefined, (tx) => {
          tx.update(changes)
            .set({ gateState: "atomic-fence-held" })
            .where(eq(changes.id, CHANGE_ID))
            .run();

          assert.throws(
            () => competitor.prepare(
              "UPDATE pipeline_jobs SET lease_token = ? WHERE id = ?",
            ).run("lease-token-racing-attempt", context.jobId),
            (error: unknown) => {
              assert.match(String((error as Error).message), /locked|busy/i);
              return true;
            },
          );
        });
      });
    } finally {
      competitor.close();
    }

    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    const job = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, context.jobId)).get();
    assert.equal(change?.gateState, "atomic-fence-held");
    assert.equal(job?.leaseToken, context.leaseToken);
  });

  it("returns a typed error when an expected ledger mutation target is missing", () => {
    for (const mutate of [
      () => runLedgerRepository.endRun("RUN-MISSING", { status: "failed" }),
      () => runLedgerRepository.patchChange("CHG-MISSING", { status: "BLOCKED" }),
      () => runLedgerRepository.stopActiveRuns("CHG-MISSING", "2026-07-10T10:02:00.000Z"),
      () => runLedgerRepository.deleteFinding("FND-MISSING"),
    ]) {
      assert.throws(mutate, (error: unknown) => {
        assert.ok(error instanceof RunLedgerMutationTargetMissingError);
        assert.equal(error.code, "run_ledger_mutation_target_missing");
        return true;
      });
    }
  });
});
