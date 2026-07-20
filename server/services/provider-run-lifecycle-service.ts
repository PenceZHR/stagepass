import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import { db } from "../db";
import { events, pipelineJobs, providerRunProcesses, runs } from "../db/schema";
import { withSqliteWriteRetry } from "../db/write-boundary";
import { insertEventWithRetry } from "../repositories/run-ledger-repository";
import {
  StaleLeaseFenceError,
  type JobExecutionContext,
} from "./job-execution-context";
import type { ProcessIdentity } from "./process-identity-service";

/**
 * The default (singleton) connection, or an injected test connection. This
 * service owns provider_run_processes and fences against pipeline_jobs / runs;
 * routing every read and transaction through the seam lets a test point this
 * service and the JobStore at one connection so the fence reads see the same
 * rows (the JobStore / ProviderLifecycle boundary becomes real, not fictional).
 */
export type ProviderRunLifecycleDb = typeof db;

let providerRunLifecycleDbForTest: ProviderRunLifecycleDb | null = null;

export function setProviderRunLifecycleDbForTest(nextDb: ProviderRunLifecycleDb): () => void {
  const previous = providerRunLifecycleDbForTest;
  providerRunLifecycleDbForTest = nextDb;
  return () => {
    providerRunLifecycleDbForTest = previous;
  };
}

function getProviderRunLifecycleDb(): ProviderRunLifecycleDb {
  return providerRunLifecycleDbForTest ?? db;
}

export type ProviderRunPhase =
  | "refine"
  | "intake"
  | "spec"
  | "spec_critic"
  | "tech_spec"
  | "generate_plan"
  | "test_plan"
  | "implement"
  | "review"
  | "local_check"
  | "fix_findings"
  | "release"
  | "retro";

export type ProviderRunProvider = "codex" | "claude";
export type ProviderRunTerminalStatus = "completed" | "failed" | "stopped" | "orphaned";

export interface ProviderRunStartInput {
  changeId: string;
  runId: string;
  phase: ProviderRunPhase;
  provider: ProviderRunProvider;
  pid: number | null;
  ppid: number;
  roundId?: string | null;
  idempotencyKey?: string | null;
  executionContext?: JobExecutionContext;
  externalRef?: string | null;
  processIdentity?: ProcessIdentity | null;
  summary?: string | null;
  startedAt?: Date;
}

export interface ProviderRunHeartbeatInput {
  runId: string;
  pid?: number | null;
  executionContext?: JobExecutionContext;
  observedAt?: Date;
}

export interface ProviderRunTerminalInput {
  runId: string;
  phase: ProviderRunPhase;
  status: ProviderRunTerminalStatus;
  pid?: number | null;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  summary: string;
  executionContext?: JobExecutionContext;
  endedAt?: Date;
  closeBusinessRun?: boolean;
}

export type ProviderRunProcess = typeof providerRunProcesses.$inferSelect;
export type ProcessKiller = (pid: number, signal: 0) => boolean;

const terminalEventTypes: Record<ProviderRunTerminalStatus, string> = {
  completed: "provider_process_ended",
  failed: "provider_process_failed",
  stopped: "provider_process_stopped",
  orphaned: "provider_process_orphaned",
};

const terminalStatuses = new Set<ProviderRunTerminalStatus>([
  "completed",
  "failed",
  "stopped",
  "orphaned",
]);

const providerFailureRunStatuses: Partial<Record<ProviderRunTerminalStatus, "failed" | "stopped">> = {
  failed: "failed",
  orphaned: "failed",
  stopped: "stopped",
};

function iso(date: Date): string {
  return date.toISOString();
}

function providerProcessId(
  input: Pick<
    ProviderRunStartInput,
    "runId" | "phase" | "idempotencyKey" | "executionContext"
  >,
): string {
  const key = input.idempotencyKey?.trim();
  const base = key ?? input.runId;
  const context = input.executionContext;
  if (!context) {
    return key ? `PRP-${key}` : `PRP-${input.runId}-${input.phase}`;
  }
  return [
    "PRP",
    base,
    input.phase,
    "attempt",
    context.attemptNo,
    "lease",
    context.leaseToken,
  ].join("-");
}

function nextProviderProcessEventId(type: string, runId: string): string {
  return `EVT-${type}-${runId}-${randomUUID()}`;
}

function jobFenceConditions(context: JobExecutionContext) {
  return and(
    eq(pipelineJobs.id, context.jobId),
    eq(pipelineJobs.leasedBy, context.workerId),
    eq(pipelineJobs.leaseToken, context.leaseToken),
    eq(pipelineJobs.attemptNo, context.attemptNo),
    eq(pipelineJobs.status, "running"),
  );
}

function businessRunFenceConditions(runId: string, context: JobExecutionContext) {
  return and(
    eq(runs.id, runId),
    eq(runs.jobId, context.jobId),
    eq(runs.workerId, context.workerId),
    eq(runs.leaseToken, context.leaseToken),
    eq(runs.attemptNo, context.attemptNo),
    eq(runs.status, "running"),
  );
}

function providerFenceConditions(context: JobExecutionContext) {
  return and(
    eq(providerRunProcesses.jobId, context.jobId),
    eq(providerRunProcesses.workerId, context.workerId),
    eq(providerRunProcesses.leaseToken, context.leaseToken),
    eq(providerRunProcesses.attemptNo, context.attemptNo),
  )!;
}

function processMatchesFence(
  process: ProviderRunProcess,
  context: JobExecutionContext,
): boolean {
  return process.jobId === context.jobId
    && process.workerId === context.workerId
    && process.leaseToken === context.leaseToken
    && process.attemptNo === context.attemptNo;
}

function executionContextForProcess(
  process: ProviderRunProcess,
): JobExecutionContext | null {
  if (
    process.jobId === null
    || process.workerId === null
    || process.leaseToken === null
    || process.attemptNo === null
  ) {
    return null;
  }
  return {
    jobId: process.jobId,
    workerId: process.workerId,
    leaseToken: process.leaseToken,
    attemptNo: process.attemptNo,
  };
}

function readLatestProviderRunProcess(
  runId: string,
  phase?: ProviderRunPhase,
  context?: JobExecutionContext,
): ProviderRunProcess | null {
  const conditions = [eq(providerRunProcesses.runId, runId)];
  if (phase) conditions.push(eq(providerRunProcesses.phase, phase));
  if (context) conditions.push(providerFenceConditions(context));
  return (
    getProviderRunLifecycleDb()
      .select()
      .from(providerRunProcesses)
      .where(and(...conditions))
      .orderBy(desc(providerRunProcesses.startedAt))
      .get() ?? null
  );
}

function insertProviderProcessEvent(input: {
  id?: string;
  changeId: string | null;
  runId: string;
  type: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}): void {
  insertEventWithRetry({
    id: input.id ?? nextProviderProcessEventId(input.type, input.runId),
    changeId: input.changeId,
    runId: input.runId,
    type: input.type,
    message: input.message,
    rawJson: JSON.stringify({
      providerProcess: {
        schemaVersion: "provider_process/v1",
        ...input.payload,
      },
    }),
    createdAt: input.createdAt,
  });
}

function providerProcessEventExists(input: {
  processId: string;
  runId: string;
  type: string;
  leaseToken: string | null;
  attemptNo: number | null;
}): boolean {
  const rows = getProviderRunLifecycleDb()
    .select({ rawJson: events.rawJson })
    .from(events)
    .where(and(eq(events.runId, input.runId), eq(events.type, input.type)))
    .all();

  return rows.some((row) => {
    try {
      const parsed = JSON.parse(row.rawJson ?? "{}") as {
        providerProcess?: {
          processId?: unknown;
          leaseToken?: unknown;
          attemptNo?: unknown;
        };
      };
      return parsed.providerProcess?.processId === input.processId
        && (parsed.providerProcess.leaseToken ?? null) === input.leaseToken
        && (parsed.providerProcess.attemptNo ?? null) === input.attemptNo;
    } catch {
      return false;
    }
  });
}

function terminalProviderProcessEventId(
  process: ProviderRunProcess,
  type: string,
): string {
  return [
    "EVT",
    type,
    process.id,
    process.attemptNo ?? "legacy",
    process.leaseToken ?? "unfenced",
  ].join("-");
}

function startedProviderProcessEventId(process: ProviderRunProcess): string {
  return [
    "EVT",
    "provider_process_started",
    process.id,
    process.attemptNo ?? "legacy",
    process.leaseToken ?? "unfenced",
  ].join("-");
}

function isSqliteConstraintError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && String(error.code).startsWith("SQLITE_CONSTRAINT"),
  );
}

function ensureTerminalProviderProcessEvent(process: ProviderRunProcess): void {
  const status = process.status as ProviderRunTerminalStatus;
  const type = terminalEventTypes[status];
  if (!type) return;
  const eventIdentity = {
    processId: process.id,
    runId: process.runId,
    type,
    leaseToken: process.leaseToken,
    attemptNo: process.attemptNo,
  };
  if (providerProcessEventExists(eventIdentity)) {
    return;
  }

  const endedAt = process.endedAt ?? new Date().toISOString();
  try {
    insertProviderProcessEvent({
      id: terminalProviderProcessEventId(process, type),
      changeId: process.changeId,
      runId: process.runId,
      type,
      message: `Provider process ${status} for ${process.phase}`,
      payload: {
        processId: process.id,
        changeId: process.changeId,
        runId: process.runId,
        phase: process.phase,
        provider: process.provider,
        pid: process.pid,
        ppid: process.ppid,
        roundId: process.roundId,
        jobId: process.jobId,
        workerId: process.workerId,
        leaseToken: process.leaseToken,
        attemptNo: process.attemptNo,
        status,
        exitCode: process.exitCode,
        signal: process.signal,
        summary: process.summary,
        startedAt: process.startedAt,
        endedAt,
      },
      createdAt: endedAt,
    });
  } catch (error) {
    if (!isSqliteConstraintError(error) || !providerProcessEventExists(eventIdentity)) {
      throw error;
    }
  }
}

function ensureStartedProviderProcessEvent(
  process: ProviderRunProcess,
  idempotencyKey: string | null,
): void {
  const type = "provider_process_started";
  const eventIdentity = {
    processId: process.id,
    runId: process.runId,
    type,
    leaseToken: process.leaseToken,
    attemptNo: process.attemptNo,
  };
  if (providerProcessEventExists(eventIdentity)) {
    return;
  }

  try {
    insertProviderProcessEvent({
      id: startedProviderProcessEventId(process),
      changeId: process.changeId,
      runId: process.runId,
      type,
      message: `Provider process started for ${process.phase}`,
      payload: {
        processId: process.id,
        changeId: process.changeId,
        runId: process.runId,
        phase: process.phase,
        provider: process.provider,
        pid: process.pid,
        ppid: process.ppid,
        roundId: process.roundId,
        idempotencyKey,
        jobId: process.jobId,
        workerId: process.workerId,
        leaseToken: process.leaseToken,
        attemptNo: process.attemptNo,
        externalRef: process.externalRef,
        processNonce: process.processNonce,
        processStartTime: process.processStartTime,
        processPpid: process.processPpid,
        processPgid: process.processPgid,
        processCwd: process.processCwd,
        processCommandJson: process.processCommandJson,
        startedAt: process.startedAt,
      },
      createdAt: process.startedAt,
    });
  } catch (error) {
    if (!isSqliteConstraintError(error) || !providerProcessEventExists(eventIdentity)) {
      throw error;
    }
  }
}

function processIsUnfenced(process: ProviderRunProcess): boolean {
  return process.jobId === null
    && process.workerId === null
    && process.leaseToken === null
    && process.attemptNo === null;
}

export function startProviderRun(input: ProviderRunStartInput): ProviderRunProcess {
  const startedAt = iso(input.startedAt ?? new Date());
  const context = input.executionContext;
  const identity = input.processIdentity ?? null;
  const row = {
    id: providerProcessId(input),
    changeId: input.changeId,
    runId: input.runId,
    phase: input.phase,
    provider: input.provider,
    pid: input.pid,
    ppid: input.ppid,
    roundId: input.roundId ?? null,
    status: "running",
    startedAt,
    lastHeartbeatAt: startedAt,
    endedAt: null,
    exitCode: null,
    signal: null,
    summary: input.summary ?? null,
    jobId: context?.jobId ?? null,
    workerId: context?.workerId ?? null,
    leaseToken: context?.leaseToken ?? null,
    attemptNo: context?.attemptNo ?? null,
    externalRef: input.externalRef ?? null,
    processNonce: identity?.nonce ?? null,
    processStartTime: identity?.processStartTime ?? null,
    processPpid: identity?.ppid ?? null,
    processPgid: identity?.pgid ?? null,
    processCwd: identity?.cwd ?? null,
    processCommandJson: identity ? JSON.stringify(identity.command) : null,
  };

  withSqliteWriteRetry("provider-run.start", () => {
    getProviderRunLifecycleDb().transaction((tx) => {
      if (context) {
        const currentJob = tx
          .select({ id: pipelineJobs.id })
          .from(pipelineJobs)
          .where(jobFenceConditions(context))
          .get();
        if (!currentJob) throw new StaleLeaseFenceError(context);
        const currentRun = tx
          .select({ id: runs.id })
          .from(runs)
          .where(businessRunFenceConditions(input.runId, context))
          .get();
        if (!currentRun) throw new StaleLeaseFenceError(context);
      }

      const existing = tx
        .select()
        .from(providerRunProcesses)
        .where(eq(providerRunProcesses.id, row.id))
        .get();
      if (!existing) {
        tx.insert(providerRunProcesses).values(row).run();
        return;
      }

      if (context ? processMatchesFence(existing, context) : processIsUnfenced(existing)) {
        return;
      }

      if (
        context
        && existing.jobId === context.jobId
        && existing.attemptNo !== null
        && existing.attemptNo < context.attemptNo
      ) {
        throw new StaleLeaseFenceError(context);
      }

      if (context) throw new StaleLeaseFenceError(context);
      throw new Error(`Provider run process is owned by a fenced execution: ${row.id}`);
    });
  });

  const persisted = getProviderRunLifecycleDb()
    .select()
    .from(providerRunProcesses)
    .where(eq(providerRunProcesses.id, row.id))
    .get();
  if (!persisted) {
    throw new Error(`Provider run process was not persisted: ${row.id}`);
  }
  ensureStartedProviderProcessEvent(persisted, input.idempotencyKey ?? null);
  return persisted;
}

export function heartbeatProviderRun(input: ProviderRunHeartbeatInput): ProviderRunProcess[] {
  const observedAt = iso(input.observedAt ?? new Date());
  const context = input.executionContext;
  const conditions = [
    eq(providerRunProcesses.runId, input.runId),
    eq(providerRunProcesses.status, "running"),
  ];
  if (typeof input.pid === "number") {
    conditions.push(eq(providerRunProcesses.pid, input.pid));
  }
  if (context) {
    conditions.push(providerFenceConditions(context));
  } else {
    conditions.push(
      isNull(providerRunProcesses.jobId),
      isNull(providerRunProcesses.workerId),
      isNull(providerRunProcesses.leaseToken),
      isNull(providerRunProcesses.attemptNo),
    );
  }

  withSqliteWriteRetry("provider-run.heartbeat", () => {
    getProviderRunLifecycleDb().transaction((tx) => {
      if (context) {
        const currentJob = tx
          .select({ id: pipelineJobs.id })
          .from(pipelineJobs)
          .where(jobFenceConditions(context))
          .get();
        if (!currentJob) throw new StaleLeaseFenceError(context);
      } else {
        const fencedProcess = tx
          .select()
          .from(providerRunProcesses)
          .where(
            and(
              eq(providerRunProcesses.runId, input.runId),
              eq(providerRunProcesses.status, "running"),
              isNotNull(providerRunProcesses.jobId),
              isNotNull(providerRunProcesses.workerId),
              isNotNull(providerRunProcesses.leaseToken),
              isNotNull(providerRunProcesses.attemptNo),
              typeof input.pid === "number"
                ? eq(providerRunProcesses.pid, input.pid)
                : undefined,
            ),
          )
          .get();
        const fencedContext = fencedProcess
          ? executionContextForProcess(fencedProcess)
          : null;
        if (fencedContext) throw new StaleLeaseFenceError(fencedContext);
      }
      const result = tx
        .update(providerRunProcesses)
        .set({ lastHeartbeatAt: observedAt })
        .where(and(...conditions))
        .run();
      if (context && result.changes !== 1) {
        throw new StaleLeaseFenceError(context);
      }
    });
  });

  return getProviderRunLifecycleDb()
    .select()
    .from(providerRunProcesses)
    .where(eq(providerRunProcesses.runId, input.runId))
    .all();
}

export function finishProviderRun(input: ProviderRunTerminalInput): ProviderRunProcess {
  const context = input.executionContext;
  const existing = readLatestProviderRunProcess(input.runId, input.phase, context);
  if (!existing) {
    throw new Error(`Provider run process not found for run ${input.runId} phase ${input.phase}`);
  }

  const persistedContext = executionContextForProcess(existing);
  if (context && !processMatchesFence(existing, context)) {
    throw new StaleLeaseFenceError(context);
  }
  if (!context && persistedContext) {
    throw new StaleLeaseFenceError(persistedContext);
  }

  if (terminalStatuses.has(existing.status as ProviderRunTerminalStatus)) {
    if (context) {
      const currentJob = getProviderRunLifecycleDb()
        .select({ id: pipelineJobs.id })
        .from(pipelineJobs)
        .where(jobFenceConditions(context))
        .get();
      if (!currentJob) throw new StaleLeaseFenceError(context);
    }
    ensureTerminalProviderProcessEvent(existing);
    return existing;
  }

  const endedAt = iso(input.endedAt ?? new Date());
  const pid = input.pid ?? existing.pid;
  const signal = input.signal ?? null;
  withSqliteWriteRetry("provider-run.finish", () => {
    getProviderRunLifecycleDb().transaction((tx) => {
      if (context) {
        const currentJob = tx
          .select({ id: pipelineJobs.id })
          .from(pipelineJobs)
          .where(jobFenceConditions(context))
          .get();
        if (!currentJob) throw new StaleLeaseFenceError(context);
      }
      const processConditions = [
        eq(providerRunProcesses.id, existing.id),
        eq(providerRunProcesses.status, "running"),
      ];
      if (context) processConditions.push(providerFenceConditions(context));
      const result = tx
        .update(providerRunProcesses)
        .set({
          pid,
          status: input.status,
          endedAt,
          exitCode: input.exitCode ?? null,
          signal,
          summary: input.summary,
          lastHeartbeatAt: endedAt,
        })
        .where(and(...processConditions))
        .run();
      if (result.changes !== 1) {
        if (context) throw new StaleLeaseFenceError(context);
        return;
      }

      const runStatus = input.closeBusinessRun === false
        ? undefined
        : providerFailureRunStatuses[input.status];
      if (runStatus) {
        const runResult = tx.update(runs)
          .set({
            status: runStatus,
            endedAt,
            summary: input.summary,
          })
          .where(
            context
              ? businessRunFenceConditions(input.runId, context)
              : and(
                  eq(runs.id, input.runId),
                  eq(runs.status, "running"),
                  isNull(runs.jobId),
                  isNull(runs.workerId),
                  isNull(runs.leaseToken),
                  isNull(runs.attemptNo),
                ),
          )
          .run();
        if (runResult.changes !== 1) {
          if (context) throw new StaleLeaseFenceError(context);
          throw new Error(`Business run fence changed while finishing provider run ${input.runId}`);
        }
      }
    });
  });

  const updated = getProviderRunLifecycleDb()
    .select()
    .from(providerRunProcesses)
    .where(eq(providerRunProcesses.id, existing.id))
    .get();
  if (!updated) {
    throw new Error(`Provider run process disappeared after finish: ${existing.id}`);
  }
  ensureTerminalProviderProcessEvent(updated);
  return updated;
}

export function isPidAlive(pid: number, killer: ProcessKiller = process.kill): boolean {
  try {
    killer(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = String(error.code);
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
    }
    throw error;
  }
}

export async function withProviderRun<T>(
  startInput: ProviderRunStartInput,
  fn: () => Promise<T>,
): Promise<T> {
  startProviderRun(startInput);
  try {
    const result = await fn();
    finishProviderRun({
      runId: startInput.runId,
      phase: startInput.phase,
      status: "completed",
      pid: startInput.pid,
      summary: "Provider run completed",
      executionContext: startInput.executionContext,
    });
    return result;
  } catch (error) {
    const summary = error instanceof Error ? error.message : "Provider run failed";
    finishProviderRun({
      runId: startInput.runId,
      phase: startInput.phase,
      status: "failed",
      pid: startInput.pid,
      summary,
      executionContext: startInput.executionContext,
    });
    throw error;
  }
}

export function readProviderRunProcessForRun(
  runId: string,
  phase?: ProviderRunPhase,
): ProviderRunProcess | null {
  return readLatestProviderRunProcess(runId, phase);
}
