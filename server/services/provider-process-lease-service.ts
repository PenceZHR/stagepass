import { randomUUID } from "node:crypto";

import { insertEventWithRetry } from "../repositories/run-ledger-repository";
import { heartbeatPipelineJob } from "./pipeline-job-lease-service";
import type { JobExecutionContext } from "./job-execution-context";
import {
  processIdentityProbe,
  type ProcessIdentity,
} from "./process-identity-service";
import {
  finishProviderRun,
  heartbeatProviderRun,
  readProviderRunProcessForRun,
  startProviderRun,
  type ProviderRunPhase,
  type ProviderRunProvider,
  type ProviderRunTerminalStatus,
} from "./provider-run-lifecycle-service";

export interface ProviderProcessLeaseInput extends JobExecutionContext {
  changeId: string;
  runId: string;
  phase: ProviderRunPhase;
  provider: ProviderRunProvider;
  pid: number | null;
  ppid?: number | null;
  identity?: ProcessIdentity | null;
  externalRef?: string | null;
  leasedAt?: Date;
}

export interface HeartbeatProviderLeaseInput extends JobExecutionContext {
  runId: string;
  observedAt?: Date;
}

export interface ReleaseProviderLeaseInput extends JobExecutionContext {
  runId: string;
  status: ProviderRunTerminalStatus;
  summary?: string;
  releasedAt?: Date;
}

function iso(date: Date): string {
  return date.toISOString();
}

function leaseEventId(type: string, jobId: string): string {
  return `EVT-${type}-${jobId}-${randomUUID()}`;
}

function insertLeaseEvent(input: {
  type: string;
  changeId: string;
  runId: string;
  jobId: string;
  workerId?: string | null;
  leaseToken?: string | null;
  attemptNo?: number | null;
  phase: string;
  provider: string;
  pid: number | null;
  externalRef?: string | null;
  status?: string;
  createdAt: string;
}): void {
  insertEventWithRetry({
    id: leaseEventId(input.type, input.jobId),
    changeId: input.changeId,
    runId: input.runId,
    type: input.type,
    message: `Provider process lease ${input.type}`,
    rawJson: JSON.stringify({
      providerProcessLease: {
        schemaVersion: "provider_process_lease/v1",
        jobId: input.jobId,
        workerId: input.workerId ?? null,
        leaseToken: input.leaseToken ?? null,
        attemptNo: input.attemptNo ?? null,
        runId: input.runId,
        phase: input.phase,
        provider: input.provider,
        pid: input.pid,
        externalRef: input.externalRef ?? null,
        status: input.status ?? null,
        observedAt: input.createdAt,
      },
    }),
    createdAt: input.createdAt,
  });
}

function executionContext(input: JobExecutionContext): JobExecutionContext {
  return {
    jobId: input.jobId,
    workerId: input.workerId,
    leaseToken: input.leaseToken,
    attemptNo: input.attemptNo,
  };
}

export async function leaseProviderProcess(input: ProviderProcessLeaseInput) {
  const leasedAt = input.leasedAt ?? new Date();
  const processIdentity = input.identity ?? (input.pid === null
    ? null
    : await processIdentityProbe.capture(input.pid, {
        ppid: input.ppid ?? undefined,
      }));
  const summaryParts = [
    `jobId=${input.jobId}`,
    `workerId=${input.workerId}`,
    input.externalRef ? `externalRef=${input.externalRef}` : null,
  ].filter(Boolean);
  const providerProcess = startProviderRun({
    changeId: input.changeId,
    runId: input.runId,
    phase: input.phase,
    provider: input.provider,
    pid: input.pid,
    ppid: input.ppid ?? processIdentity?.ppid ?? globalThis.process.pid,
    idempotencyKey: [
      "lease",
      input.jobId,
      input.runId,
      input.phase,
      "attempt",
      input.attemptNo,
      "lease",
      input.leaseToken,
    ].join("-"),
    executionContext: executionContext(input),
    externalRef: input.externalRef ?? null,
    processIdentity,
    summary: summaryParts.join(" "),
    startedAt: leasedAt,
  });

  insertLeaseEvent({
    type: "provider_process_leased",
    changeId: input.changeId,
    runId: input.runId,
    jobId: input.jobId,
    workerId: input.workerId,
    leaseToken: input.leaseToken,
    attemptNo: input.attemptNo,
    phase: input.phase,
    provider: input.provider,
    pid: input.pid,
    externalRef: input.externalRef ?? null,
    createdAt: iso(leasedAt),
  });

  return providerProcess;
}

export function heartbeatProviderLease(input: HeartbeatProviderLeaseInput) {
  const observedAt = input.observedAt ?? new Date();
  const providerProcesses = heartbeatProviderRun({
    runId: input.runId,
    executionContext: executionContext(input),
    observedAt,
  });
  const pipelineJob = heartbeatPipelineJob({
    ...executionContext(input),
    now: observedAt,
  });
  return { providerProcesses, pipelineJob };
}

export function releaseProviderLease(input: ReleaseProviderLeaseInput) {
  const process = readProviderRunProcessForRun(input.runId);
  if (!process) {
    throw new Error(`Provider process lease not found for run ${input.runId}`);
  }
  const releasedAt = input.releasedAt ?? new Date();
  const summary = input.summary ?? `Provider process lease ${input.status} for job ${input.jobId}`;
  const finished = finishProviderRun({
    runId: input.runId,
    phase: process.phase as ProviderRunPhase,
    status: input.status,
    pid: process.pid,
    summary,
    executionContext: executionContext(input),
    endedAt: releasedAt,
  });
  insertLeaseEvent({
    type: "provider_process_lease_released",
    changeId: finished.changeId,
    runId: input.runId,
    jobId: input.jobId,
    workerId: input.workerId,
    leaseToken: input.leaseToken,
    attemptNo: input.attemptNo,
    phase: finished.phase,
    provider: finished.provider,
    pid: finished.pid,
    status: input.status,
    createdAt: iso(releasedAt),
  });
  return finished;
}
