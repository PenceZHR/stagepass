import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { changes, events, pipelineJobs, projects, providerRunProcesses, runs } from "../db/schema";
import { enqueuePipelineJob, ensurePipelineJobsTable } from "./job-dispatch-service";
import { leaseNextPipelineJob } from "./pipeline-job-lease-service";
import type { JobExecutionContext } from "./job-execution-context";
import type { ProcessIdentity } from "./process-identity-service";
import {
  heartbeatProviderLease,
  leaseProviderProcess,
  releaseProviderLease,
} from "./provider-process-lease-service";

const PROJECT_ID = "PRJ-PROVIDER-LEASE";
const CHANGE_ID = "CHG-PROVIDER-LEASE";
const RUN_ID = "RUN-PROVIDER-LEASE";
const WORKER_ID = "worker-provider-lease";

function cleanupRows(): void {
  ensurePipelineJobsTable();
  db.delete(providerRunProcesses).where(eq(providerRunProcesses.changeId, CHANGE_ID)).run();
  db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedRun(): void {
  const now = "2026-07-10T00:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Provider lease",
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
    title: "Provider lease",
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
  db.insert(runs).values({
    id: RUN_ID,
    changeId: CHANGE_ID,
    phase: "implement",
    status: "running",
    startedAt: now,
    endedAt: null,
    summary: null,
  }).run();
}

function runningJob(input: {
  workerId?: string;
  workerNonce?: string;
  now?: Date;
  leaseMs?: number;
} = {}) {
  enqueuePipelineJob({
    changeId: CHANGE_ID,
    phase: "implement",
    actionId: "run_build",
    idempotencyKey: "provider-lease",
  });
  const leased = leaseNextPipelineJob({
    workerId: input.workerId ?? WORKER_ID,
    workerNonce: input.workerNonce ?? "worker-provider-nonce",
    now: input.now ?? new Date("2026-07-10T00:01:00.000Z"),
    leaseMs: input.leaseMs,
  })!;
  db.update(runs)
    .set({
      jobId: leased.job.id,
      workerId: leased.job.leasedBy,
      leaseToken: leased.job.leaseToken,
      attemptNo: leased.job.attemptNo,
    })
    .where(eq(runs.id, RUN_ID))
    .run();
  return leased;
}

function contextFor(job: ReturnType<typeof runningJob>): JobExecutionContext {
  return {
    jobId: job.job.id,
    workerId: job.job.leasedBy!,
    leaseToken: job.job.leaseToken!,
    attemptNo: job.job.attemptNo,
  };
}

function readEvent(type: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.changeId, CHANGE_ID), eq(events.type, type)))
    .get();
}

function readEvents(type: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.changeId, CHANGE_ID), eq(events.type, type)))
    .all();
}

describe("provider-process-lease-service", { concurrency: false }, () => {
  beforeEach(() => {
    cleanupRows();
    seedRun();
  });

  afterEach(() => {
    cleanupRows();
  });

  it("leases a provider process and persists matching execution and process identity", async () => {
    const job = runningJob();
    const context = contextFor(job);

    const providerProcess = await leaseProviderProcess({
      ...context,
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "implement",
      provider: "codex",
      pid: globalThis.process.pid,
      ppid: globalThis.process.ppid,
      externalRef: "codex-thread-1",
      leasedAt: new Date("2026-07-10T00:02:00.000Z"),
    });

    assert.equal(providerProcess?.status, "running");
    assert.equal(providerProcess?.jobId, context.jobId);
    assert.equal(providerProcess?.workerId, context.workerId);
    assert.equal(providerProcess?.leaseToken, context.leaseToken);
    assert.equal(providerProcess?.attemptNo, context.attemptNo);
    assert.equal(providerProcess?.externalRef, "codex-thread-1");
    assert.equal(providerProcess?.processPpid, globalThis.process.ppid);
    assert.ok(providerProcess?.processNonce);
    assert.ok(providerProcess?.processStartTime);
    assert.equal(providerProcess?.processCwd, globalThis.process.cwd());
    assert.ok(providerProcess?.processCommandJson);
    const event = readEvent("provider_process_leased");
    assert.ok(event);
    const payload = JSON.parse(event.rawJson ?? "{}").providerProcessLease;
    assert.equal(payload.jobId, context.jobId);
    assert.equal(payload.workerId, WORKER_ID);
    assert.equal(payload.leaseToken, context.leaseToken);
    assert.equal(payload.attemptNo, context.attemptNo);
    assert.equal(payload.externalRef, "codex-thread-1");
  });

  it("persists a captured provider identity without capturing the pid again", async () => {
    const job = runningJob();
    const context = contextFor(job);
    const identity: ProcessIdentity = {
      pid: 2_147_483_647,
      ppid: globalThis.process.pid,
      pgid: globalThis.process.pid,
      nonce: "claude-captured-identity",
      processStartTime: "2026-07-10T00:01:30.000Z",
      cwd: globalThis.process.cwd(),
      command: ["claude", "--print"],
    };

    const providerProcess = await leaseProviderProcess({
      ...context,
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "implement",
      provider: "claude",
      pid: identity.pid,
      ppid: identity.ppid,
      identity,
      leasedAt: new Date("2026-07-10T00:02:00.000Z"),
    });

    assert.equal(providerProcess.processNonce, identity.nonce);
    assert.equal(providerProcess.processStartTime, identity.processStartTime);
    assert.equal(providerProcess.processPpid, identity.ppid);
    assert.equal(providerProcess.processPgid, identity.pgid);
    assert.equal(providerProcess.processCwd, identity.cwd);
    assert.equal(providerProcess.processCommandJson, JSON.stringify(identity.command));

    const repeated = await leaseProviderProcess({
      ...context,
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "implement",
      provider: "claude",
      pid: identity.pid,
      ppid: identity.ppid,
      identity,
      externalRef: "must-not-replace",
      leasedAt: new Date("2026-07-10T00:03:00.000Z"),
    });

    assert.deepEqual(repeated, providerProcess);
    assert.equal(
      db.select().from(events).where(and(
        eq(events.changeId, CHANGE_ID),
        eq(events.type, "provider_process_started"),
      )).all().length,
      1,
    );
    const [started] = readEvents("provider_process_started");
    const startedPayload = JSON.parse(started.rawJson ?? "{}").providerProcess;
    assert.equal(
      startedPayload.idempotencyKey,
      `lease-${context.jobId}-${RUN_ID}-implement-attempt-${context.attemptNo}-lease-${context.leaseToken}`,
    );
  });

  it("isolates sequential spec and spec_critic provider rows and events for one attempt", async () => {
    const context = contextFor(runningJob());
    const phases = ["spec", "spec_critic"] as const;

    for (const [index, phase] of phases.entries()) {
      const input = {
        ...context,
        changeId: CHANGE_ID,
        runId: RUN_ID,
        phase,
        provider: "codex" as const,
        pid: null,
        ppid: globalThis.process.pid,
        leasedAt: new Date(`2026-07-10T00:0${index + 2}:00.000Z`),
      };
      const first = await leaseProviderProcess(input);
      const repeated = await leaseProviderProcess(input);
      assert.deepEqual(repeated, first);

      const terminal = releaseProviderLease({
        ...context,
        runId: RUN_ID,
        status: "completed",
        releasedAt: new Date(`2026-07-10T00:0${index + 4}:00.000Z`),
      });
      const repeatedTerminal = releaseProviderLease({
        ...context,
        runId: RUN_ID,
        status: "completed",
        releasedAt: new Date(`2026-07-10T00:0${index + 6}:00.000Z`),
      });
      assert.deepEqual(repeatedTerminal, terminal);
    }

    const providerRows = db
      .select()
      .from(providerRunProcesses)
      .where(eq(providerRunProcesses.runId, RUN_ID))
      .all();
    assert.equal(providerRows.length, 2);
    assert.deepEqual(
      providerRows.map((row) => row.phase).sort(),
      ["spec", "spec_critic"],
    );
    assert.equal(new Set(providerRows.map((row) => row.id)).size, 2);

    for (const eventType of ["provider_process_started", "provider_process_ended"]) {
      const payloads = readEvents(eventType).map((event) =>
        JSON.parse(event.rawJson ?? "{}").providerProcess
      );
      assert.equal(payloads.length, 2);
      assert.deepEqual(
        payloads.map((payload) => payload.phase).sort(),
        ["spec", "spec_critic"],
      );
      if (eventType === "provider_process_started") {
        assert.deepEqual(
          payloads.map((payload) => payload.idempotencyKey).sort(),
          phases.map((phase) =>
            `lease-${context.jobId}-${RUN_ID}-${phase}-attempt-${context.attemptNo}-lease-${context.leaseToken}`
          ).sort(),
        );
      }
      assert.deepEqual(
        new Set(payloads.map((payload) => payload.processId)),
        new Set(providerRows.map((row) => row.id)),
      );
    }
  });

  it("uses distinct full lease idempotency keys for higher attempts of the same phase", async () => {
    const firstContext = contextFor(runningJob({
      workerId: "worker-attempt-1",
      workerNonce: "nonce-attempt-1",
      leaseMs: 1_000,
    }));
    await leaseProviderProcess({
      ...firstContext,
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "implement",
      provider: "codex",
      pid: null,
      ppid: globalThis.process.pid,
      leasedAt: new Date("2026-07-10T00:01:10.000Z"),
    });
    releaseProviderLease({
      ...firstContext,
      runId: RUN_ID,
      status: "completed",
      releasedAt: new Date("2026-07-10T00:01:20.000Z"),
    });

    const secondContext = contextFor(runningJob({
      workerId: "worker-attempt-2",
      workerNonce: "nonce-attempt-2",
      now: new Date("2026-07-10T00:02:00.000Z"),
    }));
    await leaseProviderProcess({
      ...secondContext,
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "implement",
      provider: "codex",
      pid: null,
      ppid: globalThis.process.pid,
      leasedAt: new Date("2026-07-10T00:02:10.000Z"),
    });
    await leaseProviderProcess({
      ...secondContext,
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "implement",
      provider: "codex",
      pid: null,
      ppid: globalThis.process.pid,
      leasedAt: new Date("2026-07-10T00:02:20.000Z"),
    });

    assert.equal(secondContext.attemptNo, firstContext.attemptNo + 1);
    const providerRows = db
      .select()
      .from(providerRunProcesses)
      .where(eq(providerRunProcesses.runId, RUN_ID))
      .all();
    assert.equal(providerRows.length, 2);
    assert.deepEqual(
      providerRows.map((row) => row.attemptNo).sort(),
      [firstContext.attemptNo, secondContext.attemptNo],
    );

    const startedPayloads = readEvents("provider_process_started").map((event) =>
      JSON.parse(event.rawJson ?? "{}").providerProcess
    );
    assert.equal(startedPayloads.length, 2);
    assert.equal(new Set(startedPayloads.map((payload) => payload.idempotencyKey)).size, 2);
    assert.deepEqual(
      startedPayloads.map((payload) => payload.idempotencyKey).sort(),
      [firstContext, secondContext].map((attempt) =>
        `lease-${attempt.jobId}-${RUN_ID}-implement-attempt-${attempt.attemptNo}-lease-${attempt.leaseToken}`
      ).sort(),
    );
  });

  it("heartbeats provider lifecycle and the matching pipeline job", async () => {
    const job = runningJob();
    const context = contextFor(job);
    await leaseProviderProcess({
      ...context,
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "implement",
      provider: "codex",
      pid: null,
      ppid: globalThis.process.pid,
    });

    const result = heartbeatProviderLease({
      ...context,
      runId: RUN_ID,
      observedAt: new Date("2026-07-10T00:03:00.000Z"),
    });

    assert.equal(result.providerProcesses[0].lastHeartbeatAt, "2026-07-10T00:03:00.000Z");
    assert.equal(result.pipelineJob?.heartbeatAt, "2026-07-10T00:03:00.000Z");
  });

  it("releases a provider process lease by finishing the lifecycle row", async () => {
    const job = runningJob();
    const context = contextFor(job);
    await leaseProviderProcess({
      ...context,
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "implement",
      provider: "codex",
      pid: null,
      ppid: globalThis.process.pid,
    });

    const released = releaseProviderLease({
      ...context,
      runId: RUN_ID,
      status: "completed",
      releasedAt: new Date("2026-07-10T00:04:00.000Z"),
    });

    assert.equal(released.status, "completed");
    assert.equal(released.endedAt, "2026-07-10T00:04:00.000Z");
    assert.ok(readEvent("provider_process_ended"));
    assert.ok(readEvent("provider_process_lease_released"));
  });

  it("rejects old-attempt provider heartbeat and terminal writes after re-lease", async () => {
    const oldLease = runningJob({
      workerId: "worker-old",
      workerNonce: "nonce-old",
      leaseMs: 1_000,
    });
    const oldContext = contextFor(oldLease);
    await leaseProviderProcess({
      ...oldContext,
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "implement",
      provider: "codex",
      pid: null,
      ppid: globalThis.process.pid,
    });
    const newLease = runningJob({
      workerId: "worker-new",
      workerNonce: "nonce-new",
      now: new Date("2026-07-10T00:02:00.000Z"),
    });

    for (const write of [
      () => heartbeatProviderLease({ ...oldContext, runId: RUN_ID }),
      () => releaseProviderLease({
        ...oldContext,
        runId: RUN_ID,
        status: "completed" as const,
      }),
    ]) {
      assert.throws(write, (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "stale_lease_fence");
        return true;
      });
    }

    const persisted = db
      .select()
      .from(providerRunProcesses)
      .where(eq(providerRunProcesses.runId, RUN_ID))
      .get();
    assert.equal(persisted?.status, "running");
    assert.equal(newLease.job.attemptNo, oldLease.job.attemptNo + 1);
  });
});
