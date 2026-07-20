import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";

import { db } from "../db";
import {
  artifacts,
  changeProviderSessions,
  changes,
  events,
  pipelineJobs,
  projects,
  providerRunProcesses,
  runs,
} from "../db/schema";
import type { AiRunLifecycleSink } from "./ai-engine-types";
import { ActiveProviderRegistry } from "./active-provider-registry";
import { StaleLeaseFenceError } from "./job-execution-context";
import {
  createProviderLifecycleSink,
  setPipelineEngineFactoryForTest,
} from "./pipeline-engine-service";
import type { ProcessIdentity } from "./process-identity-service";
import { runDocumentStage } from "./pipeline-document-stage-runner-service";
import * as documentStageModule from "./pipeline-document-stage-runner-service";
import * as planStageModule from "./pipeline-plan-stage-service";

const PROJECT_ID = "PRJ-PROVIDER-WORKER-PROTOCOL";
const CHANGE_ID = "CHG-PROVIDER-WORKER-PROTOCOL";
const RUN_ID = "RUN-PROVIDER-WORKER-PROTOCOL";

let repoPath: string | null = null;

function cleanupRows(): void {
  db.delete(changeProviderSessions).where(eq(changeProviderSessions.changeId, CHANGE_ID)).run();
  db.delete(providerRunProcesses).where(eq(providerRunProcesses.changeId, CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedRunningJob(): void {
  db.insert(pipelineJobs).values({
    id: "PJOB-PROVIDER-WORKER-PROTOCOL",
    changeId: CHANGE_ID,
    phase: "spec",
    actionId: "run_spec",
    idempotencyKey: "provider-worker-protocol",
    status: "running",
    leasedBy: "worker-provider-protocol",
    leaseExpiresAt: "2099-07-10T10:30:00.000Z",
    heartbeatAt: "2026-07-10T10:00:00.000Z",
    attemptNo: 3,
    errorCode: null,
    errorSummary: null,
    createdAt: "2026-07-10T09:59:00.000Z",
    startedAt: "2026-07-10T10:00:00.000Z",
    endedAt: null,
    leaseToken: "lease-provider-protocol",
    workerNonce: "worker-nonce-provider-protocol",
  }).run();
}

function executionContext() {
  return {
    jobId: "PJOB-PROVIDER-WORKER-PROTOCOL",
    workerId: "worker-provider-protocol",
    leaseToken: "lease-provider-protocol",
    attemptNo: 3,
  } as const;
}

function bindRunToRunningJob(runId = RUN_ID): void {
  db.update(runs)
    .set(executionContext())
    .where(eq(runs.id, runId))
    .run();
}

function seedChange(status = "INTAKE_READY", runId = RUN_ID): void {
  const now = "2026-07-10T10:00:00.000Z";
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "provider-worker-protocol-"));
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Provider worker protocol",
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
    title: "Provider worker protocol",
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
}

function readProviderEvent(type: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.changeId, CHANGE_ID), eq(events.type, type)))
    .get();
}

function countProviderEvents(type: string): number {
  return db
    .select()
    .from(events)
    .where(and(eq(events.changeId, CHANGE_ID), eq(events.type, type)))
    .all()
    .length;
}

function providerIdentity(pid: number): ProcessIdentity {
  return {
    pid,
    ppid: process.pid,
    pgid: process.pid,
    nonce: `provider-worker-protocol-${pid}`,
    processStartTime: "2026-07-10T10:00:00.000Z",
    cwd: process.cwd(),
    command: ["provider-worker-protocol", String(pid)],
  };
}

describe("provider worker protocol", { concurrency: false }, () => {
  beforeEach(() => {
    cleanupRows();
  });

  afterEach(() => {
    setPipelineEngineFactoryForTest(null);
    cleanupRows();
    if (repoPath) {
      fs.rmSync(repoPath, { recursive: true, force: true });
      repoPath = null;
    }
  });

  it("lifecycle sink starts, heartbeats, and fails provider runs", async () => {
    seedChange("SPECCING");
    seedRunningJob();
    bindRunToRunningJob();
    const sink = createProviderLifecycleSink({
      ...executionContext(),
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "spec",
      provider: "codex",
      roundId: "ROUND-1",
    });

    await sink.onProcessStarted({
      provider: "codex",
      pid: null,
      ppid: process.pid,
      externalRef: "thread-123",
      startedAt: "2026-07-10T10:01:00.000Z",
    });
    await sink.onHeartbeat({
      provider: "codex",
      pid: null,
      externalRef: "thread-123",
      observedAt: "2026-07-10T10:02:00.000Z",
    });
    await sink.onTerminal({
      provider: "codex",
      pid: null,
      status: "failed",
      summary: "provider failed visibly",
      endedAt: "2026-07-10T10:03:00.000Z",
    });

    const processRow = db
      .select()
      .from(providerRunProcesses)
      .where(eq(providerRunProcesses.runId, RUN_ID))
      .get();
    const businessRun = db.select().from(runs).where(eq(runs.id, RUN_ID)).get();
    assert.equal(processRow?.status, "failed");
    assert.equal(processRow?.phase, "spec");
    assert.equal(processRow?.lastHeartbeatAt, "2026-07-10T10:03:00.000Z");
    assert.equal(businessRun?.status, "failed");
    assert.ok(readProviderEvent("provider_process_started"));
    assert.ok(readProviderEvent("provider_process_failed"));
  });

  it("rejects a lifecycle event whose provider differs from the immutable run provider", async () => {
    seedChange("SPECCING");
    seedRunningJob();
    bindRunToRunningJob();
    const sink = createProviderLifecycleSink({
      ...executionContext(),
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "spec",
      provider: "codex",
    });

    assert.throws(
      () => sink.onProcessStarted({
        provider: "claude",
        pid: null,
        ppid: process.pid,
        startedAt: "2026-07-10T10:01:00.000Z",
      }),
      /provider_lifecycle_mismatch/,
    );
    assert.equal(db.select().from(providerRunProcesses).where(eq(providerRunProcesses.runId, RUN_ID)).get(), undefined);
  });

  it("rejects partial job execution identity instead of silently disabling lease semantics", () => {
    assert.throws(
      () => createProviderLifecycleSink({
        changeId: CHANGE_ID,
        runId: RUN_ID,
        phase: "spec",
        provider: "codex",
        jobId: "JOB-PARTIAL",
        workerId: "worker-partial",
      } as never),
      /complete JobExecutionContext/,
    );
  });

  it("fails closed when provider lifecycle has no job execution identity", () => {
    assert.throws(
      () => createProviderLifecycleSink({
        changeId: CHANGE_ID,
        runId: RUN_ID,
        phase: "spec",
        provider: "codex",
      } as never),
      /complete JobExecutionContext/,
    );
  });

  it("accepts the complete Task10 job execution context", () => {
    const sink = createProviderLifecycleSink({
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "spec",
      provider: "codex",
      jobId: "JOB-COMPLETE",
      workerId: "worker-complete",
      leaseToken: "lease-token-complete",
      attemptNo: 2,
    } as never);

    assert.equal(typeof sink.onProcessStarted, "function");
    assert.equal(typeof sink.onHeartbeat, "function");
    assert.equal(typeof sink.onTerminal, "function");
  });

  it("retries a stale provider start after its fence is restored exactly once", async () => {
    seedChange("SPECCING");
    seedRunningJob();
    bindRunToRunningJob();
    const sink = createProviderLifecycleSink({
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "spec",
      provider: "codex",
      jobId: "PJOB-PROVIDER-WORKER-PROTOCOL",
      workerId: "worker-provider-protocol",
      leaseToken: "lease-provider-protocol",
      attemptNo: 3,
    });
    db.update(pipelineJobs)
      .set({
        leasedBy: "worker-new-owner",
        leaseToken: "lease-new-owner",
        attemptNo: 4,
      })
      .where(eq(pipelineJobs.id, "PJOB-PROVIDER-WORKER-PROTOCOL"))
      .run();

    await assert.rejects(
      sink.onProcessStarted({
        provider: "codex",
        pid: null,
        ppid: process.pid,
        externalRef: "thread-stale-start",
        startedAt: "2026-07-10T10:01:00.000Z",
      }),
      (error: unknown) => {
        assert.ok(error instanceof StaleLeaseFenceError);
        return true;
      },
    );
    assert.equal(
      db.select().from(providerRunProcesses).where(eq(providerRunProcesses.runId, RUN_ID)).get(),
      undefined,
    );

    db.update(pipelineJobs)
      .set({
        leasedBy: "worker-provider-protocol",
        leaseToken: "lease-provider-protocol",
        attemptNo: 3,
      })
      .where(eq(pipelineJobs.id, "PJOB-PROVIDER-WORKER-PROTOCOL"))
      .run();

    await sink.onProcessStarted({
      provider: "codex",
      pid: null,
      ppid: process.pid,
      externalRef: "thread-stale-start",
      startedAt: "2026-07-10T10:01:00.000Z",
    });
    await sink.onProcessStarted({
      provider: "codex",
      pid: null,
      ppid: process.pid,
      externalRef: "thread-stale-start",
      startedAt: "2026-07-10T10:01:00.000Z",
    });

    assert.equal(
      db.select().from(providerRunProcesses).where(eq(providerRunProcesses.runId, RUN_ID)).all().length,
      1,
    );
    assert.equal(countProviderEvents("provider_process_started"), 1);
  });

  it("retries stale terminal persistence and unregisters only after success", async () => {
    seedChange("SPECCING");
    seedRunningJob();
    bindRunToRunningJob();
    const registry = new ActiveProviderRegistry();
    const sink = createProviderLifecycleSink({
      ...executionContext(),
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "spec",
      provider: "codex",
    }, registry);

    await sink.onProcessStarted({
      provider: "codex",
      pid: 4107,
      ppid: process.pid,
      identity: providerIdentity(4107),
      startedAt: "2026-07-10T10:01:00.000Z",
    });
    assert.equal(registry.size, 1);

    db.update(pipelineJobs)
      .set({
        leasedBy: "worker-new-owner",
        leaseToken: "lease-new-owner",
        attemptNo: 4,
      })
      .where(eq(pipelineJobs.id, "PJOB-PROVIDER-WORKER-PROTOCOL"))
      .run();

    await assert.rejects(
      sink.onTerminal({
        provider: "codex",
        pid: 4107,
        status: "completed",
        summary: "first terminal fence is stale",
        endedAt: "2026-07-10T10:02:00.000Z",
      }),
      StaleLeaseFenceError,
    );
    assert.equal(registry.size, 1);
    assert.equal(countProviderEvents("provider_process_ended"), 0);

    db.update(pipelineJobs)
      .set({
        leasedBy: "worker-provider-protocol",
        leaseToken: "lease-provider-protocol",
        attemptNo: 3,
      })
      .where(eq(pipelineJobs.id, "PJOB-PROVIDER-WORKER-PROTOCOL"))
      .run();

    const terminalEvent = {
      provider: "codex" as const,
      pid: 4107,
      status: "completed" as const,
      summary: "terminal retry persisted",
      endedAt: "2026-07-10T10:03:00.000Z",
    };
    await sink.onTerminal(terminalEvent);
    await sink.onTerminal(terminalEvent);

    const processRows = db
      .select()
      .from(providerRunProcesses)
      .where(eq(providerRunProcesses.runId, RUN_ID))
      .all();
    assert.equal(processRows.length, 1);
    assert.equal(processRows[0]?.status, "completed");
    assert.equal(countProviderEvents("provider_process_ended"), 1);
    assert.equal(registry.size, 0);
  });

  it("shares in-flight start and terminal promises without duplicate writes", async () => {
    seedChange("SPECCING");
    seedRunningJob();
    bindRunToRunningJob();
    const registry = new ActiveProviderRegistry();
    const sink = createProviderLifecycleSink({
      ...executionContext(),
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "spec",
      provider: "codex",
    }, registry);
    const startedEvent = {
      provider: "codex" as const,
      pid: 4108,
      ppid: process.pid,
      identity: providerIdentity(4108),
      startedAt: "2026-07-10T10:01:00.000Z",
    };

    const firstStart = sink.onProcessStarted(startedEvent);
    const secondStart = sink.onProcessStarted(startedEvent);
    assert.ok(firstStart instanceof Promise);
    assert.strictEqual(secondStart, firstStart);
    await sink.onHeartbeat({
      provider: "codex",
      pid: 4108,
      observedAt: "2026-07-10T10:01:30.000Z",
    });
    await firstStart;

    const terminalEvent = {
      provider: "codex" as const,
      pid: 4108,
      status: "completed" as const,
      summary: "concurrent terminal",
      endedAt: "2026-07-10T10:02:00.000Z",
    };
    const firstTerminal = sink.onTerminal(terminalEvent);
    const secondTerminal = sink.onTerminal(terminalEvent);
    assert.ok(firstTerminal instanceof Promise);
    assert.strictEqual(secondTerminal, firstTerminal);
    await firstTerminal;

    const processRows = db
      .select()
      .from(providerRunProcesses)
      .where(eq(providerRunProcesses.runId, RUN_ID))
      .all();
    assert.equal(processRows.length, 1);
    assert.equal(processRows[0]?.lastHeartbeatAt, terminalEvent.endedAt);
    assert.equal(countProviderEvents("provider_process_started"), 1);
    assert.equal(countProviderEvents("provider_process_ended"), 1);
    assert.equal(registry.size, 0);
  });

  it("fails heartbeat and terminal closed until start persistence succeeds", async () => {
    seedChange("SPECCING");
    seedRunningJob();
    bindRunToRunningJob();
    const sink = createProviderLifecycleSink({
      ...executionContext(),
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "spec",
      provider: "codex",
    });

    await sink.onHeartbeat({
      provider: "codex",
      pid: null,
      observedAt: "2026-07-10T10:00:30.000Z",
    });
    db.update(pipelineJobs)
      .set({
        leasedBy: "worker-new-owner",
        leaseToken: "lease-new-owner",
        attemptNo: 4,
      })
      .where(eq(pipelineJobs.id, "PJOB-PROVIDER-WORKER-PROTOCOL"))
      .run();

    const startError = await Promise.resolve(sink.onProcessStarted({
      provider: "codex",
      pid: null,
      ppid: process.pid,
      startedAt: "2026-07-10T10:01:00.000Z",
    })).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(startError instanceof StaleLeaseFenceError);

    await sink.onHeartbeat({
      provider: "codex",
      pid: null,
      observedAt: "2026-07-10T10:01:30.000Z",
    });
    await sink.onTerminal({
      provider: "codex",
      pid: null,
      status: "failed",
      summary: startError.message,
      endedAt: "2026-07-10T10:02:00.000Z",
    });

    assert.equal(
      db.select().from(providerRunProcesses).where(eq(providerRunProcesses.runId, RUN_ID)).get(),
      undefined,
    );
    assert.equal(countProviderEvents("provider_process_failed"), 0);
  });

  it("stage lifecycle sinks can avoid closing business runs before stage failure handling", async () => {
    seedChange("SPECCING");
    seedRunningJob();
    bindRunToRunningJob();
    const sink = createProviderLifecycleSink({
      ...executionContext(),
      changeId: CHANGE_ID,
      runId: RUN_ID,
      phase: "spec",
      provider: "codex",
      closeBusinessRunOnProviderFailure: false,
    });

    await sink.onProcessStarted({
      provider: "codex",
      pid: null,
      ppid: process.pid,
      externalRef: "thread-stage-failure",
      startedAt: "2026-07-10T10:04:00.000Z",
    });
    await sink.onTerminal({
      provider: "codex",
      pid: null,
      status: "failed",
      summary: "provider failed but stage still owns run status",
      endedAt: "2026-07-10T10:05:00.000Z",
    });

    const processRow = db
      .select()
      .from(providerRunProcesses)
      .where(eq(providerRunProcesses.runId, RUN_ID))
      .get();
    const businessRun = db.select().from(runs).where(eq(runs.id, RUN_ID)).get();
    assert.equal(processRow?.status, "failed");
    assert.equal(businessRun?.status, "running");
  });

  it("document stages bind the worker job identity to the provider lifecycle", async () => {
    seedChange("INTAKE_READY", "RUN-DOC-STAGE-LIFECYCLE");
    seedRunningJob();
    bindRunToRunningJob("RUN-DOC-STAGE-LIFECYCLE");
    let lifecycle: AiRunLifecycleSink | undefined;
    setPipelineEngineFactoryForTest(() => ({
      async run(input) {
        lifecycle = input.lifecycle;
        await lifecycle?.onProcessStarted({
          provider: "codex",
          pid: null,
          ppid: process.pid,
          externalRef: "thread-doc-stage",
          startedAt: "2026-07-10T10:01:00.000Z",
        });
        await lifecycle?.onHeartbeat({
          provider: "codex",
          pid: null,
          externalRef: "thread-doc-stage",
          observedAt: "2026-07-10T10:02:00.000Z",
        });
        await lifecycle?.onTerminal({
          provider: "codex",
          pid: null,
          status: "completed",
          summary: "document stage provider completed",
          endedAt: "2026-07-10T10:03:00.000Z",
        });
        return {
          threadId: "thread-doc-stage",
          runId: "provider-run-doc-stage",
          summary: "document stage ok",
          success: true,
          changedFiles: [],
          items: [],
        };
      },
      async *runStreamed() {},
    }));

    await runDocumentStage(
      CHANGE_ID,
      {
        phase: "spec",
        promptPhase: "spec",
        allowedStatuses: ["INTAKE_READY"],
        runningStatus: "SPECCING",
        successStatus: "SPECCING",
        failureStatus: "BLOCKED",
        artifactType: "prd_delta",
        artifactFileName: "prd-delta.md",
        successSummary: "Spec completed",
        runId: "RUN-DOC-STAGE-LIFECYCLE",
      },
      executionContext(),
    );

    assert.ok(lifecycle);
    const processRow = db
      .select()
      .from(providerRunProcesses)
      .where(eq(providerRunProcesses.runId, "RUN-DOC-STAGE-LIFECYCLE"))
      .get();
    assert.equal(processRow?.jobId, "PJOB-PROVIDER-WORKER-PROTOCOL");
    assert.equal(processRow?.workerId, "worker-provider-protocol");
    assert.equal(processRow?.leaseToken, "lease-provider-protocol");
    assert.equal(processRow?.attemptNo, 3);
  });

  it("rejects a document stage without a strict execution scope", async () => {
    await assert.rejects(
      () => runDocumentStage(CHANGE_ID, {
        phase: "spec",
        promptPhase: "spec",
        allowedStatuses: ["INTAKE_READY"],
        runningStatus: "SPECCING",
        successStatus: "SPECCING",
        failureStatus: "BLOCKED",
        artifactType: "prd_delta",
        artifactFileName: "prd-delta.md",
        successSummary: "Spec completed",
      }),
      /complete JobExecutionContext/,
    );
  });

  it("does not expose Task10 legacy provider lifecycle or stage entrypoints", () => {
    const engineSource = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "pipeline-engine-service.ts"),
      "utf8",
    );
    const documentSource = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "pipeline-document-stage-runner-service.ts"),
      "utf8",
    );
    const planSource = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "pipeline-plan-stage-service.ts"),
      "utf8",
    );

    assert.equal("runLegacyDocumentStage" in documentStageModule, false);
    assert.equal("generatePlanLegacy" in planStageModule, false);
    assert.doesNotMatch(engineSource, /export interface UnleasedProviderLifecycleContext/);
    assert.match(
      engineSource,
      /createProviderLifecycleSink\(\s*input: ProviderLifecycleContext,/,
    );
    assert.doesNotMatch(engineSource, /hasAnyExecutionContext|hasExecutionContext|unleased/);
    assert.doesNotMatch(documentSource, /JobExecutionContext \| null/);
    assert.doesNotMatch(documentSource, /runLegacyDocumentStage|withLegacyExecutionFence/);
    assert.doesNotMatch(planSource, /generatePlanLegacy|withLegacyExecutionFence/);
  });

  it("the pipeline worker heartbeats immediately and installs provider-first signal shutdown", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts", "pipeline-worker.ts"),
      "utf8",
    ).replace(/\s+/g, " ");

    assert.match(
      source,
      /heartbeatPipelineJob\(context\);.*const heartbeat = setInterval/,
    );
    assert.match(source, /installActiveProviderSignalHandlers/);
    assert.match(source, /await activeProviderRegistry\.handleSignal\(signal\).*stopping = true/);
  });
});
