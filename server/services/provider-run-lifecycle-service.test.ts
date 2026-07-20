import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { db } from "../db";
import { runMigrations } from "../db/migrate";
import * as dbSchema from "../db/schema";
import {
  changes,
  events,
  pipelineJobs,
  projects,
  providerRunProcesses,
  runs,
} from "../db/schema";
import type { JobExecutionContext } from "./job-execution-context";
import {
  finishProviderRun,
  heartbeatProviderRun,
  isPidAlive,
  readProviderRunProcessForRun,
  setProviderRunLifecycleDbForTest,
  startProviderRun,
  withProviderRun,
  type ProviderRunLifecycleDb,
} from "./provider-run-lifecycle-service";

const PROJECT_ID = "PRJ-PROVIDER-LIFECYCLE";
const CHANGE_ID = "CHG-PROVIDER-LIFECYCLE";

function cleanupRows(): void {
  db.delete(providerRunProcesses).where(eq(providerRunProcesses.changeId, CHANGE_ID)).run();
  db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function bindRunToContext(runId: string, context: JobExecutionContext): void {
  db.update(runs)
    .set({
      jobId: context.jobId,
      workerId: context.workerId,
      leaseToken: context.leaseToken,
      attemptNo: context.attemptNo,
    })
    .where(eq(runs.id, runId))
    .run();
}

function seedRunningJob(
  context: JobExecutionContext,
  options: { bindRun?: boolean } = {},
): void {
  const now = "2026-07-10T00:00:00.000Z";
  db.insert(pipelineJobs).values({
    id: context.jobId,
    changeId: CHANGE_ID,
    phase: "spec",
    actionId: "run_spec",
    idempotencyKey: "provider-lifecycle-fence",
    status: "running",
    leasedBy: context.workerId,
    leaseExpiresAt: "2026-07-10T00:10:00.000Z",
    heartbeatAt: now,
    attemptNo: context.attemptNo,
    errorCode: null,
    errorSummary: null,
    createdAt: now,
    startedAt: now,
    endedAt: null,
    leaseToken: context.leaseToken,
    workerNonce: `nonce-${context.workerId}`,
  }).run();
  if (options.bindRun !== false) {
    db.update(runs)
      .set({
        jobId: context.jobId,
        workerId: context.workerId,
        leaseToken: context.leaseToken,
        attemptNo: context.attemptNo,
      })
      .where(and(eq(runs.changeId, CHANGE_ID), eq(runs.status, "running")))
      .run();
  }
}

function seedRun(runId = "RUN-PROVIDER-LIFECYCLE"): string {
  const now = "2026-07-10T00:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Provider lifecycle",
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
    title: "Provider lifecycle",
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
    id: runId,
    changeId: CHANGE_ID,
    phase: "spec",
    status: "running",
    startedAt: now,
    endedAt: null,
    summary: null,
  }).run();
  return runId;
}

function readEvents(type: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.changeId, CHANGE_ID), eq(events.type, type)))
    .all();
}

function startInput(runId: string) {
  return {
    changeId: CHANGE_ID,
    runId,
    phase: "spec" as const,
    provider: "codex" as const,
    pid: 1234,
    ppid: 42,
    roundId: "ROUND-1",
    startedAt: new Date("2026-07-10T00:01:00.000Z"),
  };
}

describe("provider-run-lifecycle-service", { concurrency: false }, () => {
  beforeEach(() => {
    cleanupRows();
  });

  afterEach(() => {
    cleanupRows();
  });

  it("starts a provider run as running and writes provider_process_started", () => {
    const runId = seedRun();

    const process = startProviderRun(startInput(runId));

    assert.equal(process.status, "running");
    assert.equal(process.changeId, CHANGE_ID);
    assert.equal(process.runId, runId);
    assert.equal(process.phase, "spec");
    assert.equal(process.provider, "codex");
    assert.equal(process.pid, 1234);
    assert.equal(process.lastHeartbeatAt, "2026-07-10T00:01:00.000Z");
    const [event] = readEvents("provider_process_started");
    assert.ok(event);
    const payload = JSON.parse(event.rawJson ?? "{}").providerProcess;
    assert.equal(payload.runId, runId);
    assert.equal(payload.pid, 1234);
  });

  it("preserves the legacy unfenced id for a custom idempotency key", () => {
    const runId = seedRun();

    const process = startProviderRun({
      ...startInput(runId),
      idempotencyKey: "provider-unfenced-idempotent",
    });

    assert.equal(process.id, "PRP-provider-unfenced-idempotent");
  });

  it("returns the original running row and emits one deterministic started event for the same fence", () => {
    const runId = seedRun();
    const context: JobExecutionContext = {
      jobId: "PJOB-PROVIDER-START-IDEMPOTENT",
      workerId: "worker-idempotent",
      leaseToken: "lease-idempotent",
      attemptNo: 1,
    };
    seedRunningJob(context);
    const input = {
      ...startInput(runId),
      idempotencyKey: "provider-start-idempotent",
      executionContext: context,
    };

    const first = startProviderRun(input);
    const repeated = startProviderRun({
      ...input,
      pid: 5678,
      summary: "must not replace the first start",
      startedAt: new Date("2026-07-10T00:02:00.000Z"),
    });

    assert.deepEqual(repeated, first);
    const startedEvents = readEvents("provider_process_started");
    assert.equal(startedEvents.length, 1);
    assert.equal(
      startedEvents[0].id,
      `EVT-provider_process_started-${first.id}-1-lease-idempotent`,
    );
  });

  it("keeps a same-fence terminal row closed and preserves it when a higher attempt starts", () => {
    const runId = seedRun();
    const firstContext: JobExecutionContext = {
      jobId: "PJOB-PROVIDER-START-TERMINAL",
      workerId: "worker-first",
      leaseToken: "lease-first",
      attemptNo: 1,
    };
    const secondContext: JobExecutionContext = {
      ...firstContext,
      workerId: "worker-second",
      leaseToken: "lease-second",
      attemptNo: 2,
    };
    seedRunningJob(firstContext);
    const input = {
      ...startInput(runId),
      idempotencyKey: "provider-start-terminal",
      executionContext: firstContext,
    };
    startProviderRun(input);
    const terminal = finishProviderRun({
      runId,
      phase: "spec",
      status: "completed",
      summary: "first attempt completed",
      endedAt: new Date("2026-07-10T00:02:00.000Z"),
      executionContext: firstContext,
    });

    const repeated = startProviderRun({
      ...input,
      startedAt: new Date("2026-07-10T00:03:00.000Z"),
    });
    assert.deepEqual(repeated, terminal);
    assert.equal(readEvents("provider_process_started").length, 1);

    db.update(pipelineJobs)
      .set({
        leasedBy: secondContext.workerId,
        leaseToken: secondContext.leaseToken,
        attemptNo: secondContext.attemptNo,
      })
      .where(eq(pipelineJobs.id, secondContext.jobId))
      .run();
    bindRunToContext(runId, secondContext);
    const replacement = startProviderRun({
      ...input,
      executionContext: secondContext,
      startedAt: new Date("2026-07-10T00:00:30.000Z"),
    });

    assert.equal(replacement.status, "running");
    assert.equal(replacement.attemptNo, 2);
    assert.equal(replacement.leaseToken, "lease-second");
    const secondTerminal = finishProviderRun({
      runId,
      phase: "spec",
      status: "completed",
      summary: "second attempt completed despite an earlier start clock",
      executionContext: secondContext,
    });
    assert.equal(secondTerminal.id, replacement.id);
    assert.equal(secondTerminal.status, "completed");
    const persistedAttempts = db
      .select()
      .from(providerRunProcesses)
      .where(eq(providerRunProcesses.runId, runId))
      .all();
    assert.equal(persistedAttempts.length, 2);
    assert.deepEqual(
      persistedAttempts.map((process) => process.attemptNo).sort(),
      [1, 2],
    );
    assert.equal(readEvents("provider_process_started").length, 2);
  });

  it("rejects provider start when the business run identity is mismatched or unbound", () => {
    const runId = seedRun();
    const context: JobExecutionContext = {
      jobId: "PJOB-PROVIDER-RUN-IDENTITY",
      workerId: "worker-bound",
      leaseToken: "lease-bound",
      attemptNo: 4,
    };
    seedRunningJob(context);

    const mismatches = [
      { workerId: "worker-replaced" },
      { leaseToken: "lease-replaced" },
      { attemptNo: 5 },
      { jobId: null, workerId: null, leaseToken: null, attemptNo: null },
    ];

    for (const mismatch of mismatches) {
      bindRunToContext(runId, context);
      db.update(runs).set(mismatch).where(eq(runs.id, runId)).run();

      assert.throws(
        () => startProviderRun({
          ...startInput(runId),
          idempotencyKey: "provider-run-identity",
          executionContext: context,
        }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, "stale_lease_fence");
          return true;
        },
      );
      assert.equal(
        db.select().from(providerRunProcesses).where(eq(providerRunProcesses.runId, runId)).all().length,
        0,
      );
      assert.equal(readEvents("provider_process_started").length, 0);
    }
  });

  it("heartbeats running provider processes by run and optional pid", () => {
    const runId = seedRun();
    startProviderRun(startInput(runId));

    const [updated] = heartbeatProviderRun({
      runId,
      pid: 1234,
      observedAt: new Date("2026-07-10T00:02:00.000Z"),
    });

    assert.equal(updated.lastHeartbeatAt, "2026-07-10T00:02:00.000Z");
    assert.equal(readEvents("provider_process_heartbeat").length, 0);
  });

  it("finishes completed, failed, stopped, and orphaned runs with matching events", () => {
    const cases = [
      ["completed", "provider_process_ended"],
      ["failed", "provider_process_failed"],
      ["stopped", "provider_process_stopped"],
      ["orphaned", "provider_process_orphaned"],
    ] as const;

    for (const [status, eventType] of cases) {
      cleanupRows();
      const runId = seedRun(`RUN-PROVIDER-${status}`);
      startProviderRun(startInput(runId));

      const finished = finishProviderRun({
        runId,
        phase: "spec",
        status,
        exitCode: status === "failed" ? 1 : 0,
        signal: status === "stopped" ? "SIGTERM" : null,
        summary: `${status} summary`,
        endedAt: new Date("2026-07-10T00:03:00.000Z"),
      });

      assert.equal(finished.status, status);
      assert.equal(finished.summary, `${status} summary`);
      assert.equal(finished.endedAt, "2026-07-10T00:03:00.000Z");
      assert.equal(readEvents(eventType).length, 1);
    }
  });

  it("does not emit duplicate terminal events for repeated finish calls", () => {
    const runId = seedRun();
    startProviderRun(startInput(runId));

    finishProviderRun({
      runId,
      phase: "spec",
      status: "completed",
      summary: "done",
      endedAt: new Date("2026-07-10T00:04:00.000Z"),
    });
    const repeated = finishProviderRun({
      runId,
      phase: "spec",
      status: "failed",
      summary: "late failure",
      endedAt: new Date("2026-07-10T00:05:00.000Z"),
    });

    assert.equal(repeated.status, "completed");
    assert.equal(readEvents("provider_process_ended").length, 1);
    assert.equal(readEvents("provider_process_failed").length, 0);
  });

  it("repairs a missing terminal event when finish is retried after terminal state persisted", () => {
    const runId = seedRun();
    startProviderRun(startInput(runId));
    finishProviderRun({
      runId,
      phase: "spec",
      status: "failed",
      summary: "failed before event retry",
      endedAt: new Date("2026-07-10T00:04:00.000Z"),
    });
    db.delete(events)
      .where(and(eq(events.changeId, CHANGE_ID), eq(events.type, "provider_process_failed")))
      .run();

    const repeated = finishProviderRun({
      runId,
      phase: "spec",
      status: "failed",
      summary: "retry should repair event",
      endedAt: new Date("2026-07-10T00:05:00.000Z"),
    });

    assert.equal(repeated.status, "failed");
    assert.equal(repeated.summary, "failed before event retry");
    assert.equal(readEvents("provider_process_failed").length, 1);
  });

  it("fences stale lifecycle writes and keeps terminal effects exactly once", () => {
    const runId = seedRun();
    const oldContext: JobExecutionContext = {
      jobId: "PJOB-PROVIDER-LIFECYCLE-FENCE",
      workerId: "worker-old",
      leaseToken: "lease-old",
      attemptNo: 1,
    };
    const newContext: JobExecutionContext = {
      ...oldContext,
      workerId: "worker-new",
      leaseToken: "lease-new",
      attemptNo: 2,
    };
    seedRunningJob(oldContext);
    startProviderRun({
      ...startInput(runId),
      idempotencyKey: "provider-lifecycle-fence",
      executionContext: oldContext,
    });
    db.update(pipelineJobs)
      .set({
        leasedBy: newContext.workerId,
        leaseToken: newContext.leaseToken,
        attemptNo: newContext.attemptNo,
      })
      .where(eq(pipelineJobs.id, newContext.jobId))
      .run();
    bindRunToContext(runId, newContext);
    startProviderRun({
      ...startInput(runId),
      idempotencyKey: "provider-lifecycle-fence",
      executionContext: newContext,
      startedAt: new Date("2026-07-10T00:02:00.000Z"),
    });

    for (const write of [
      () => heartbeatProviderRun({
        runId,
        observedAt: new Date("2026-07-10T00:03:00.000Z"),
        executionContext: oldContext,
      }),
      () => finishProviderRun({
        runId,
        phase: "spec",
        status: "failed" as const,
        summary: "late old-attempt failure",
        executionContext: oldContext,
      }),
    ]) {
      assert.throws(write, (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "stale_lease_fence");
        return true;
      });
    }

    finishProviderRun({
      runId,
      phase: "spec",
      status: "completed",
      summary: "new attempt completed",
      endedAt: new Date("2026-07-10T00:04:00.000Z"),
      executionContext: newContext,
    });
    const repeated = finishProviderRun({
      runId,
      phase: "spec",
      status: "failed",
      summary: "late duplicate failure",
      endedAt: new Date("2026-07-10T00:05:00.000Z"),
      executionContext: newContext,
    });

    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    assert.equal(repeated.status, "completed");
    assert.equal(repeated.summary, "new attempt completed");
    assert.equal(readEvents("provider_process_ended").length, 1);
    assert.equal(readEvents("provider_process_failed").length, 0);
    assert.equal(run?.status, "running");
  });

  it("emits exactly one terminal event for each fenced attempt", () => {
    const runId = seedRun();
    const firstContext: JobExecutionContext = {
      jobId: "PJOB-PROVIDER-TERMINAL-ATTEMPTS",
      workerId: "worker-first",
      leaseToken: "lease-first",
      attemptNo: 1,
    };
    const secondContext: JobExecutionContext = {
      ...firstContext,
      workerId: "worker-second",
      leaseToken: "lease-second",
      attemptNo: 2,
    };
    seedRunningJob(firstContext);
    startProviderRun({
      ...startInput(runId),
      idempotencyKey: "provider-terminal-attempts",
      executionContext: firstContext,
    });
    for (let index = 0; index < 2; index += 1) {
      finishProviderRun({
        runId,
        phase: "spec",
        status: "completed",
        summary: "first attempt completed",
        executionContext: firstContext,
      });
    }
    db.update(pipelineJobs)
      .set({
        leasedBy: secondContext.workerId,
        leaseToken: secondContext.leaseToken,
        attemptNo: secondContext.attemptNo,
      })
      .where(eq(pipelineJobs.id, secondContext.jobId))
      .run();
    bindRunToContext(runId, secondContext);
    startProviderRun({
      ...startInput(runId),
      idempotencyKey: "provider-terminal-attempts",
      executionContext: secondContext,
      startedAt: new Date("2026-07-10T00:02:00.000Z"),
    });
    for (let index = 0; index < 2; index += 1) {
      finishProviderRun({
        runId,
        phase: "spec",
        status: "completed",
        summary: "second attempt completed",
        executionContext: secondContext,
      });
    }

    const terminalPayloads = readEvents("provider_process_ended").map((event) =>
      JSON.parse(event.rawJson ?? "{}").providerProcess
    );
    assert.equal(terminalPayloads.length, 2);
    assert.deepEqual(
      terminalPayloads.map((payload) => payload.attemptNo).sort(),
      [1, 2],
    );
  });

  it("rolls back provider terminal state when the business run identity was replaced", () => {
    const runId = seedRun();
    const context: JobExecutionContext = {
      jobId: "PJOB-PROVIDER-FINISH-RUN-IDENTITY",
      workerId: "worker-old",
      leaseToken: "lease-old",
      attemptNo: 1,
    };
    seedRunningJob(context);
    const started = startProviderRun({
      ...startInput(runId),
      idempotencyKey: "provider-finish-run-identity",
      executionContext: context,
    });
    db.update(runs)
      .set({
        workerId: "worker-new",
        leaseToken: "lease-new",
        attemptNo: 2,
      })
      .where(eq(runs.id, runId))
      .run();

    assert.throws(
      () => finishProviderRun({
        runId,
        phase: "spec",
        status: "failed",
        summary: "late old-attempt failure",
        executionContext: context,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "stale_lease_fence");
        return true;
      },
    );

    const providerProcess = db
      .select()
      .from(providerRunProcesses)
      .where(eq(providerRunProcesses.id, started.id))
      .get();
    const businessRun = db.select().from(runs).where(eq(runs.id, runId)).get();
    assert.equal(providerProcess?.status, "running");
    assert.equal(providerProcess?.endedAt, null);
    assert.equal(businessRun?.status, "running");
    assert.equal(businessRun?.leaseToken, "lease-new");
    assert.equal(readEvents("provider_process_failed").length, 0);
  });

  it("withProviderRun finishes failed and rethrows when the provider function throws", async () => {
    const runId = seedRun();

    await assert.rejects(
      withProviderRun(startInput(runId), async () => {
        throw new Error("provider exploded");
      }),
      /provider exploded/,
    );

    const process = db
      .select()
      .from(providerRunProcesses)
      .where(eq(providerRunProcesses.runId, runId))
      .get();
    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    assert.equal(process?.status, "failed");
    assert.equal(process?.summary, "provider exploded");
    assert.equal(run?.status, "failed");
    assert.ok(run?.endedAt);
    assert.equal(readEvents("provider_process_failed").length, 1);
  });

  it("marks orphaned provider runs as failed business runs", () => {
    const runId = seedRun();
    startProviderRun(startInput(runId));

    finishProviderRun({
      runId,
      phase: "spec",
      status: "orphaned",
      summary: "provider pid disappeared",
      endedAt: new Date("2026-07-10T00:06:00.000Z"),
    });

    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    assert.equal(run?.status, "failed");
    assert.equal(run?.endedAt, "2026-07-10T00:06:00.000Z");
    assert.equal(run?.summary, "provider pid disappeared");
  });

  it("withProviderRun finishes completed when the provider function succeeds", async () => {
    const runId = seedRun();

    const result = await withProviderRun(startInput(runId), async () => "ok");

    assert.equal(result, "ok");
    const process = db
      .select()
      .from(providerRunProcesses)
      .where(eq(providerRunProcesses.runId, runId))
      .get();
    assert.equal(process?.status, "completed");
    assert.equal(readEvents("provider_process_ended").length, 1);
  });

  it("detects pid liveness with injectable process killer semantics", () => {
    assert.equal(isPidAlive(100, () => true), true);
    assert.equal(
      isPidAlive(100, () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }),
      false,
    );
    assert.equal(
      isPidAlive(100, () => {
        const error = new Error("denied") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }),
      true,
    );
  });
});

describe("provider-run-lifecycle-service injectable connection", { concurrency: false }, () => {
  function createLifecycleTestDb(): ProviderRunLifecycleDb {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = OFF");
    runMigrations(sqlite);
    return drizzle(sqlite, { schema: dbSchema }) as unknown as ProviderRunLifecycleDb;
  }

  function seedProcess(database: ProviderRunLifecycleDb, id: string, runId: string): void {
    const now = "2026-07-10T00:00:00.000Z";
    database
      .insert(providerRunProcesses)
      .values({
        id,
        changeId: CHANGE_ID,
        runId,
        phase: "spec",
        provider: "codex",
        ppid: 7,
        status: "running",
        startedAt: now,
        lastHeartbeatAt: now,
      })
      .run();
  }

  it("routes reads through the injected db and switches when the connection is swapped", () => {
    const seamDb = createLifecycleTestDb();
    seedProcess(seamDb, "PRP-SEAM-A", "RUN-SEAM-A");

    const restore = setProviderRunLifecycleDbForTest(seamDb);
    try {
      // The module-global singleton was never seeded with RUN-SEAM-A, so a hit
      // proves readProviderRunProcessForRun read the injected connection.
      assert.equal(readProviderRunProcessForRun("RUN-SEAM-A", "spec")?.id, "PRP-SEAM-A");
      assert.equal(readProviderRunProcessForRun("RUN-SEAM-B", "spec"), null);
    } finally {
      restore();
    }

    // Injecting a different db switches the read source, proving the seam is live.
    const otherDb = createLifecycleTestDb();
    seedProcess(otherDb, "PRP-SEAM-B", "RUN-SEAM-B");
    const restoreOther = setProviderRunLifecycleDbForTest(otherDb);
    try {
      assert.equal(readProviderRunProcessForRun("RUN-SEAM-B", "spec")?.id, "PRP-SEAM-B");
      assert.equal(readProviderRunProcessForRun("RUN-SEAM-A", "spec"), null);
    } finally {
      restoreOther();
    }
  });
});
