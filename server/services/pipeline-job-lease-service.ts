import { randomUUID } from "node:crypto";

import { withSqliteWriteRetry } from "../db/write-boundary";
import {
  jobStoreRepository,
  withJobStoreTransaction,
  type PipelineJobRow,
} from "../repositories/job-store-repository";
import { ensurePipelineJobsTable } from "./job-dispatch-service";
import {
  StaleLeaseFenceError,
  type JobExecutionContext,
} from "./job-execution-context";
import {
  parsePipelineJobPayload,
  type PipelineJobPayload,
  type PipelineJobRecord,
} from "./pipeline-job-types";

const DEFAULT_LEASE_MS = 30_000;

export type PipelineJob = PipelineJobRow;
export interface LeasedPipelineJobPayload extends Omit<PipelineJobPayload, "job"> {
  job: PipelineJobRecord & Pick<PipelineJob, "leaseToken" | "workerNonce">;
}

export interface LeaseNextPipelineJobInput {
  workerId: string;
  workerNonce: string;
  now?: Date;
  leaseMs?: number;
}

export interface HeartbeatPipelineJobInput extends JobExecutionContext {
  now?: Date;
  leaseMs?: number;
}

export interface CompletePipelineJobInput extends JobExecutionContext {
  now?: Date;
}

export interface FailPipelineJobInput extends JobExecutionContext {
  errorCode: string;
  errorSummary: string;
  now?: Date;
}

function iso(date: Date): string {
  return date.toISOString();
}

function leaseExpiry(now: Date, leaseMs: number): string {
  return new Date(now.getTime() + leaseMs).toISOString();
}

function leasedPayload(job: PipelineJob): LeasedPipelineJobPayload {
  const payload = parsePipelineJobPayload({ job, created: false });
  return {
    ...payload,
    job: {
      ...payload.job,
      leaseToken: job.leaseToken,
      workerNonce: job.workerNonce,
    },
  };
}

function requireFenceUpdate(changes: number, context: JobExecutionContext): void {
  if (changes !== 1) throw new StaleLeaseFenceError(context);
}

export function leaseNextPipelineJob(
  input: LeaseNextPipelineJobInput,
): LeasedPipelineJobPayload | null {
  ensurePipelineJobsTable();
  const now = input.now ?? new Date();
  const nowText = iso(now);
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;

  const leasedId = withSqliteWriteRetry("pipeline-job.lease-next", () =>
    withJobStoreTransaction((repository) => {
      const candidates = repository.leaseCandidates(nowText);

      for (const candidate of candidates) {
        // The attempt's business run already reached a terminal status: the work
        // is done and the crash happened between endRun and completePipelineJob.
        // Re-leasing here would execute a finished action a second time.
        const settledRun = repository.settledRunForAttempt(candidate);
        if (settledRun) {
          repository.settleOrphanedJob({
            jobId: candidate.id,
            expectedStatus: candidate.status,
            expectedAttemptNo: candidate.attemptNo,
            settledRun,
            nowText,
          });
          continue;
        }

        const attemptNo = candidate.status === "queued"
          ? candidate.attemptNo
          : candidate.attemptNo + 1;
        const changed = repository.leaseJob({
          jobId: candidate.id,
          expectedStatus: candidate.status,
          expectedAttemptNo: candidate.attemptNo,
          workerId: input.workerId,
          workerNonce: input.workerNonce,
          leaseToken: randomUUID(),
          attemptNo,
          leaseExpiresAt: leaseExpiry(now, leaseMs),
          heartbeatAt: nowText,
          startedAt: candidate.startedAt ?? nowText,
        });
        return changed === 1 ? candidate.id : null;
      }
      return null;
    }),
  );

  const job = leasedId ? jobStoreRepository.readJob(leasedId) : null;
  return job ? leasedPayload(job) : null;
}

export function heartbeatPipelineJob(input: HeartbeatPipelineJobInput): PipelineJob | null {
  ensurePipelineJobsTable();
  const now = input.now ?? new Date();
  withSqliteWriteRetry("pipeline-job.heartbeat", () => {
    const changes = jobStoreRepository.heartbeat(
      input,
      iso(now),
      leaseExpiry(now, input.leaseMs ?? DEFAULT_LEASE_MS),
    );
    requireFenceUpdate(changes, input);
  });
  return jobStoreRepository.readJob(input.jobId);
}

export function completePipelineJob(input: CompletePipelineJobInput): PipelineJob | null {
  ensurePipelineJobsTable();
  const now = iso(input.now ?? new Date());
  withSqliteWriteRetry("pipeline-job.complete", () => {
    const changes = jobStoreRepository.close(input, {
      status: "succeeded",
      endedAt: now,
      heartbeatAt: now,
      errorCode: null,
      errorSummary: null,
    });
    requireFenceUpdate(changes, input);
  });
  return jobStoreRepository.readJob(input.jobId);
}

export function failPipelineJob(input: FailPipelineJobInput): PipelineJob | null {
  ensurePipelineJobsTable();
  const now = iso(input.now ?? new Date());
  withSqliteWriteRetry("pipeline-job.fail", () => {
    const changes = jobStoreRepository.close(input, {
      status: "failed",
      endedAt: now,
      heartbeatAt: now,
      errorCode: input.errorCode,
      errorSummary: input.errorSummary,
    });
    requireFenceUpdate(changes, input);
  });
  return jobStoreRepository.readJob(input.jobId);
}
