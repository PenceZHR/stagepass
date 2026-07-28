import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  changes,
  codexInteractions,
  codexThreadBindings,
  events,
  pipelineCommandReceipts,
  pipelineJobs,
  projects,
} from "../db/schema";
import {
  enqueuePipelineJob,
  ensurePipelineJobsTable,
} from "./job-dispatch-service";
import {
  completePipelineJob,
  failPipelineJob,
  heartbeatPipelineJob,
  leaseNextPipelineJob,
} from "./pipeline-job-lease-service";
import type { JobExecutionContext } from "./job-execution-context";

const PROJECT_ID = "PRJ-JOB-LEASE";
const CHANGE_ID = "CHG-JOB-LEASE";

function cleanupRows(): void {
  ensurePipelineJobsTable();
  db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).run();
  db.delete(pipelineCommandReceipts)
    .where(eq(pipelineCommandReceipts.changeId, CHANGE_ID)).run();
  db.delete(codexInteractions)
    .where(eq(codexInteractions.changeId, CHANGE_ID)).run();
  db.delete(codexThreadBindings)
    .where(eq(codexThreadBindings.changeId, CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(): void {
  const now = "2026-07-10T00:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Job lease",
    repoPath: process.cwd(),
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
    title: "Lease job",
    status: "INTAKE_READY",
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

function enqueue() {
  const job = enqueuePipelineJob({
    changeId: CHANGE_ID,
    phase: "generate_plan",
    actionId: "run_plan",
    idempotencyKey: "lease-key",
  }).job;
  db.update(pipelineJobs)
    .set({ createdAt: "1970-01-01T00:00:00.000Z" })
    .where(eq(pipelineJobs.id, job.id))
    .run();
  return db.select().from(pipelineJobs).where(eq(pipelineJobs.id, job.id)).get() ?? job;
}

describe("pipeline-job-lease-service", { concurrency: false }, () => {
  beforeEach(() => {
    cleanupRows();
    seedChange();
  });

  afterEach(() => {
    cleanupRows();
  });

  it("leases the oldest queued job and heartbeats it", () => {
    const queued = enqueue();
    const leased = leaseNextPipelineJob({
      workerId: "worker-1",
      workerNonce: "worker-nonce-1",
      now: new Date("2026-07-10T00:01:00.000Z"),
      leaseMs: 10_000,
    });

    assert.equal(leased?.job.id, queued.id);
    assert.equal(leased?.job.status, "running");
    assert.equal(leased?.job.leasedBy, "worker-1");
    assert.equal(leased?.job.workerNonce, "worker-nonce-1");
    assert.ok(leased?.job.leaseToken);
    assert.equal(leased?.job.attemptNo, 1);
    assert.equal(leased?.job.startedAt, "2026-07-10T00:01:00.000Z");

    const context: JobExecutionContext = {
      jobId: leased!.job.id,
      workerId: leased!.job.leasedBy!,
      leaseToken: leased!.job.leaseToken!,
      attemptNo: leased!.job.attemptNo,
    };

    const heartbeat = heartbeatPipelineJob({
      ...context,
      now: new Date("2026-07-10T00:01:05.000Z"),
      leaseMs: 20_000,
    });
    assert.equal(heartbeat?.heartbeatAt, "2026-07-10T00:01:05.000Z");
    assert.equal(heartbeat?.leaseExpiresAt, "2026-07-10T00:01:25.000Z");
  });

  it("leases a typed interaction wakeup without parsing it as a stage action", () => {
    const now = "2026-07-10T00:00:00.000Z";
    const deadline = "2026-07-10T01:00:00.000Z";
    db.insert(codexThreadBindings).values({
      bindingId: "BIND-JOB-LEASE-WAKE",
      scopeKind: "change",
      scopeId: CHANGE_ID,
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      threadId: "THREAD-JOB-LEASE-WAKE",
      title: "Wake task",
      status: "waiting_human",
      bridgeProtocolVersion: "v1",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(codexInteractions).values({
      id: "INT-JOB-LEASE-WAKE",
      changeId: CHANGE_ID,
      bindingId: "BIND-JOB-LEASE-WAKE",
      codexThreadId: "THREAD-JOB-LEASE-WAKE",
      phase: "intake",
      kind: "requirement_choice",
      gateVersion: 0,
      sourceDbHash: "wake-source",
      payloadJson: "{}",
      status: "completed",
      idempotencyKey: "wake-interaction",
      requestHash: "wake-source",
      completedAt: now,
      expiresAt: deadline,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(pipelineCommandReceipts).values({
      commandId: "CMD-JOB-LEASE-WAKE",
      changeId: CHANGE_ID,
      interactionId: "INT-JOB-LEASE-WAKE",
      codexThreadId: "THREAD-JOB-LEASE-WAKE",
      action: "record_stagepass_choice",
      actorKind: "human",
      actorSurface: "codex_mcp_app",
      idempotencyKey: "wake-command",
      requestHash: "wake-source",
      status: "completed",
      resultJson: "{}",
      createdAt: now,
      completedAt: now,
    }).run();
    db.insert(pipelineJobs).values({
      id: "PJOB-WAKE-CMD-JOB-LEASE-WAKE",
      changeId: CHANGE_ID,
      phase: "intake",
      actionId: "continue_stagepass_interaction",
      idempotencyKey: "interaction-wakeup:CMD-JOB-LEASE-WAKE",
      status: "queued",
      attemptNo: 1,
      provider: "codex",
      jobKind: "interaction_wakeup",
      effectType: "interaction_wakeup",
      interactionId: "INT-JOB-LEASE-WAKE",
      commandId: "CMD-JOB-LEASE-WAKE",
      effectSchemaVersion: "stagepass.pipeline-effect/v1",
      effectPayloadJson: JSON.stringify({
        schemaVersion: "stagepass.pipeline-effect/v1",
        kind: "interaction_wakeup",
        interactionId: "INT-JOB-LEASE-WAKE",
        commandId: "CMD-JOB-LEASE-WAKE",
      }),
      effectDeadlineAt: deadline,
      createdAt: "1970-01-01T00:00:00.000Z",
    }).run();

    const leased = leaseNextPipelineJob({
      workerId: "worker-wake",
      workerNonce: "worker-wake-nonce",
      now: new Date("2026-07-10T00:01:00.000Z"),
    });

    const effectJob = leased?.job as typeof leased.job & {
      jobKind?: string;
      interactionId?: string | null;
    };
    assert.equal(effectJob.id, "PJOB-WAKE-CMD-JOB-LEASE-WAKE");
    assert.equal(effectJob.jobKind, "interaction_wakeup");
    assert.equal(effectJob.interactionId, "INT-JOB-LEASE-WAKE");
  });

  it("marks a leased job succeeded", () => {
    enqueue();
    const leased = leaseNextPipelineJob({
      workerId: "worker-1",
      workerNonce: "worker-nonce-1",
      now: new Date("2026-07-10T00:01:00.000Z"),
    });

    const completed = completePipelineJob({
      jobId: leased!.job.id,
      workerId: leased!.job.leasedBy!,
      leaseToken: leased!.job.leaseToken!,
      attemptNo: leased!.job.attemptNo,
      now: new Date("2026-07-10T00:02:00.000Z"),
    });

    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.endedAt, "2026-07-10T00:02:00.000Z");
    assert.equal(completed?.leasedBy, "worker-1");
    assert.equal(completed?.leaseToken, leased?.job.leaseToken);
    assert.equal(completed?.leaseExpiresAt, null);
  });

  it("marks a leased job failed with sanitized error fields", () => {
    enqueue();
    const leased = leaseNextPipelineJob({
      workerId: "worker-1",
      workerNonce: "worker-nonce-1",
      now: new Date("2026-07-10T00:01:00.000Z"),
    });

    const failed = failPipelineJob({
      jobId: leased!.job.id,
      workerId: leased!.job.leasedBy!,
      leaseToken: leased!.job.leaseToken!,
      attemptNo: leased!.job.attemptNo,
      errorCode: "pipeline_job_failed",
      errorSummary: "boom",
      now: new Date("2026-07-10T00:02:00.000Z"),
    });

    assert.equal(failed?.status, "failed");
    assert.equal(failed?.errorCode, "pipeline_job_failed");
    assert.equal(failed?.errorSummary, "boom");
    assert.equal(failed?.leasedBy, "worker-1");
    assert.equal(failed?.leaseToken, leased?.job.leaseToken);
    assert.equal(failed?.leaseExpiresAt, null);
  });

  it("fences every write from an expired attempt after another worker re-leases the job", () => {
    enqueue();
    const oldLease = leaseNextPipelineJob({
      workerId: "worker-old",
      workerNonce: "nonce-old",
      now: new Date("2026-07-10T00:01:00.000Z"),
      leaseMs: 1_000,
    })!;
    const newLease = leaseNextPipelineJob({
      workerId: "worker-new",
      workerNonce: "nonce-new",
      now: new Date("2026-07-10T00:02:00.000Z"),
      leaseMs: 30_000,
    })!;
    const oldContext: JobExecutionContext = {
      jobId: oldLease.job.id,
      workerId: oldLease.job.leasedBy!,
      leaseToken: oldLease.job.leaseToken!,
      attemptNo: oldLease.job.attemptNo,
    };

    assert.notEqual(newLease.job.leaseToken, oldLease.job.leaseToken);
    assert.equal(newLease.job.attemptNo, oldLease.job.attemptNo + 1);
    for (const write of [
      () => heartbeatPipelineJob(oldContext),
      () => completePipelineJob(oldContext),
      () => failPipelineJob({
        ...oldContext,
        errorCode: "late_failure",
        errorSummary: "old worker must be fenced",
      }),
    ]) {
      assert.throws(write, (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "stale_lease_fence");
        return true;
      });
    }

    const persisted = db
      .select()
      .from(pipelineJobs)
      .where(eq(pipelineJobs.id, newLease.job.id))
      .get();
    assert.equal(persisted?.status, "running");
    assert.equal(persisted?.leasedBy, "worker-new");
    assert.equal(persisted?.leaseToken, newLease.job.leaseToken);
    assert.equal(persisted?.attemptNo, newLease.job.attemptNo);
  });
});
