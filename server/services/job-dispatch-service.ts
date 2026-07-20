import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db";
import { changes, events, pipelineJobs, stageActions } from "../db/schema";
import { withSqliteWriteRetry } from "../db/write-boundary";
import type {
  EnqueuePipelineJobInput,
  PipelineJobPayload,
} from "./pipeline-job-types";
import { parsePipelineJobPayload } from "./pipeline-job-types";
import { evaluateProviderActionAuthority } from "./provider-action-authority-service";
import {
  assertProviderApplicable,
  parseRequestedProvider,
  resolveProviderSelection,
  type Provider,
} from "./provider-selection-service";

/**
 * The default (singleton) connection, or an injected test connection. This
 * service owns pipeline_jobs; routing every read, DDL and transaction through
 * the seam is what lets a test point the JobStore and the ProviderLifecycle
 * store at one connection, making that boundary real instead of fictional.
 */
export type JobDispatchDb = typeof db;

let jobDispatchDbForTest: JobDispatchDb | null = null;

export function setJobDispatchDbForTest(nextDb: JobDispatchDb): () => void {
  const previous = jobDispatchDbForTest;
  jobDispatchDbForTest = nextDb;
  return () => {
    jobDispatchDbForTest = previous;
  };
}

function getJobDispatchDb(): JobDispatchDb {
  return jobDispatchDbForTest ?? db;
}

export type PipelineJobStatus =
  | "queued"
  | "leased"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export interface EnqueueActionContractFence {
  actionId: string;
  enabled: boolean;
  gateVersion: string;
  sourceDbHash: string;
}

export class ActionContractDriftError extends Error {
  public readonly code = "action_contract_drift";

  constructor() {
    super("action_contract_drift: persisted action contract changed before enqueue");
    this.name = "ActionContractDriftError";
  }
}

export class ProviderSelectionConflictError extends Error {
  public readonly code = "provider_selection_conflict";
  public readonly status = 409;

  constructor(message = "provider selection conflicts with an existing job") {
    super(message);
    this.name = "ProviderSelectionConflictError";
  }
}

export class PipelineJobConflictError extends Error {
  public readonly code = "pipeline_job_conflict";
  public readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "PipelineJobConflictError";
  }
}

let pipelineJobsTableEnsured = false;

export function ensurePipelineJobsTable(): void {
  if (pipelineJobsTableEnsured) return;
  withSqliteWriteRetry("pipeline-job.ensure-table", () => {
    const database = getJobDispatchDb();
    database.run(sql`
      CREATE TABLE IF NOT EXISTS pipeline_jobs (
        id text PRIMARY KEY NOT NULL,
        change_id text NOT NULL,
        phase text NOT NULL,
        action_id text NOT NULL,
        idempotency_key text,
        status text NOT NULL,
        leased_by text,
        lease_expires_at text,
        heartbeat_at text,
        attempt_no integer NOT NULL DEFAULT 1,
        error_code text,
        error_summary text,
        created_at text NOT NULL,
        started_at text,
        ended_at text,
        provider text NOT NULL DEFAULT 'codex',
        FOREIGN KEY (change_id) REFERENCES changes(id) ON UPDATE no action ON DELETE no action
      )
    `);
    // Test databases and databases created before migration 0019 may arrive here
    // without the immutable provider column.
    const columns = database.all<{ name: string }>(sql`PRAGMA table_info(pipeline_jobs)`);
    if (!columns.some((column) => column.name === "provider")) {
      database.run(sql`ALTER TABLE pipeline_jobs ADD COLUMN provider text NOT NULL DEFAULT 'codex'`);
      database.run(sql`UPDATE pipeline_jobs SET provider = COALESCE((SELECT provider FROM changes WHERE changes.id = pipeline_jobs.change_id), 'codex')`);
    }
    database.run(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_jobs_change_action_idempotency
      ON pipeline_jobs (change_id, action_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);
    database.run(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_jobs_one_active_change_phase
      ON pipeline_jobs (change_id, phase)
      WHERE status IN ('queued', 'leased', 'running')
    `);
    database.run(sql`
      CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_status_lease
      ON pipeline_jobs (status, lease_expires_at, created_at)
    `);
    database.run(sql`
      CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_change_created
      ON pipeline_jobs (change_id, created_at)
    `);
  });
  pipelineJobsTableEnsured = true;
}

function nowISO(): string {
  return new Date().toISOString();
}

function nextPipelineJobId(): string {
  return `PJOB-${randomUUID()}`;
}

function nextPipelineJobEventId(jobId: string): string {
  return `EVT-pipeline-job-${jobId}-${Date.now().toString(36)}`;
}

function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function pipelineJobPayload(
  job: typeof pipelineJobs.$inferSelect,
  created: boolean,
): PipelineJobPayload {
  return parsePipelineJobPayload({ job, created });
}

function assertIdempotencyMatch(
  payload: PipelineJobPayload,
  input: EnqueuePipelineJobInput,
  idempotencyKey: string,
): PipelineJobPayload {
  if (payload.job.phase !== input.phase || payload.job.actionId !== input.actionId) {
    throw new PipelineJobConflictError(`Pipeline job idempotency conflict: ${idempotencyKey}`);
  }
  if (input.provider !== undefined && payload.job.provider !== input.provider) {
    throw new ProviderSelectionConflictError(
      `idempotency key ${idempotencyKey} is already bound to provider ${payload.job.provider}`,
    );
  }
  return payload;
}

function findExistingJob(input: Pick<EnqueuePipelineJobInput, "changeId"> & {
  idempotencyKey: string;
}): typeof pipelineJobs.$inferSelect | null {
  return getJobDispatchDb()
    .select()
    .from(pipelineJobs)
    .where(
      and(
        eq(pipelineJobs.changeId, input.changeId),
        eq(pipelineJobs.idempotencyKey, input.idempotencyKey),
      ),
    )
    .get() ?? null;
}

function findExistingJobInTransaction(
  tx: Pick<typeof db, "select">,
  input: Pick<EnqueuePipelineJobInput, "changeId"> & { idempotencyKey: string },
): typeof pipelineJobs.$inferSelect | null {
  return tx
    .select()
    .from(pipelineJobs)
    .where(
      and(
        eq(pipelineJobs.changeId, input.changeId),
        eq(pipelineJobs.idempotencyKey, input.idempotencyKey),
      ),
    )
    .get() ?? null;
}

export function findPipelineJobByIdempotency(
  changeId: string,
  idempotencyKey: string,
): typeof pipelineJobs.$inferSelect | null {
  ensurePipelineJobsTable();
  return findExistingJob({ changeId, idempotencyKey });
}

function findActivePhaseJobInTransaction(
  tx: Pick<typeof db, "select">,
  input: Pick<EnqueuePipelineJobInput, "changeId" | "phase">,
) {
  return tx.select().from(pipelineJobs).where(and(
    eq(pipelineJobs.changeId, input.changeId),
    eq(pipelineJobs.phase, input.phase),
    sql`${pipelineJobs.status} IN ('queued', 'leased', 'running')`,
  )).get() ?? null;
}

function assertPersistedActionFence(
  tx: Pick<typeof db, "select">,
  input: EnqueuePipelineJobInput,
  fence: EnqueueActionContractFence,
): void {
  const persisted = tx.select().from(stageActions).where(and(
    eq(stageActions.changeId, input.changeId),
    eq(stageActions.actionId, input.actionId),
  )).get();
  if (
    !persisted
    || fence.actionId !== input.actionId
    || !fence.enabled
    || persisted.enabled !== 1
    || String(persisted.gateVersion) !== fence.gateVersion
    || (persisted.sourceDbHash ?? "") !== fence.sourceDbHash
  ) {
    throw new ActionContractDriftError();
  }
}

function assertCurrentProviderAuthority(
  tx: Pick<typeof db, "select">,
  input: EnqueuePipelineJobInput,
  fence?: EnqueueActionContractFence,
): void {
  const current = evaluateProviderActionAuthority(tx, input);
  if (!current.enabled || current.actionId !== input.actionId) throw new ActionContractDriftError();
  if (fence && (
    !fence.enabled
    || fence.actionId !== current.actionId
    || fence.gateVersion !== current.gateVersion
    || fence.sourceDbHash !== current.sourceDbHash
  )) throw new ActionContractDriftError();
}

function changeDefaultProvider(
  tx: Pick<typeof db, "select">,
  changeId: string,
): Provider {
  const change = tx.select({ provider: changes.provider }).from(changes)
    .where(eq(changes.id, changeId)).get();
  if (!change) throw new Error(`Change not found: ${changeId}`);
  return resolveProviderSelection(undefined, change.provider === "claude" ? "claude" : "codex");
}

function resolveAndValidateProvider(
  tx: Pick<typeof db, "select">,
  input: EnqueuePipelineJobInput,
): Provider {
  const requested = parseRequestedProvider(input.provider);
  assertProviderApplicable(input.actionId, requested);
  return resolveProviderSelection(requested, changeDefaultProvider(tx, input.changeId));
}

function enqueuePipelineJobInternal(
  input: EnqueuePipelineJobInput,
  fence?: EnqueueActionContractFence,
  requireCurrentAuthority = false,
): PipelineJobPayload {
  ensurePipelineJobsTable();
  // Validate malformed direct callers before any lookup or write.
  const requestedProvider = parseRequestedProvider(input.provider);
  assertProviderApplicable(input.actionId, requestedProvider);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

  const jobId = nextPipelineJobId();
  const createdAt = nowISO();
  try {
    return withSqliteWriteRetry("pipeline-job.enqueue", () => getJobDispatchDb().transaction((tx) => {
        // Resolve the Change default and perform the idempotency lookup from
        // the same SQLite snapshot that owns the insert. This prevents a
        // Change provider update between a pre-check and the enqueue write.
        const provider = resolveAndValidateProvider(tx, input);
        if (idempotencyKey) {
          const existing = findExistingJobInTransaction(tx, {
            changeId: input.changeId,
            idempotencyKey,
          });
          if (existing) {
            return assertIdempotencyMatch(
              pipelineJobPayload(existing, false),
              { ...input, provider },
              idempotencyKey,
            );
          }
        }
        if (requireCurrentAuthority) assertCurrentProviderAuthority(tx, input, fence);
        else if (fence) assertPersistedActionFence(tx, input, fence);
        tx.insert(pipelineJobs).values({
          id: jobId,
          changeId: input.changeId,
          phase: input.phase,
          actionId: input.actionId,
          provider,
          idempotencyKey,
          status: "queued",
          leasedBy: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          attemptNo: 1,
          errorCode: null,
          errorSummary: null,
          createdAt,
          startedAt: null,
          endedAt: null,
        }).run();
        tx.insert(events).values({
          id: nextPipelineJobEventId(jobId),
          changeId: input.changeId,
          runId: null,
          type: "pipeline_job_queued",
          message: `Pipeline job queued: ${input.actionId}`,
          rawJson: JSON.stringify({
            pipelineJob: {
              schemaVersion: "pipeline_job/v1",
              jobId,
              phase: input.phase,
              actionId: input.actionId,
              idempotencyKey,
              provider,
            },
          }),
          createdAt,
        }).run();
        const persisted = tx.select().from(pipelineJobs).where(eq(pipelineJobs.id, jobId)).get();
        if (!persisted) throw new Error(`Pipeline job was not persisted: ${jobId}`);
        return pipelineJobPayload(persisted, true);
      }));
  } catch (error) {
    // A concurrent enqueue can lose the unique-index race after its
    // transaction rolls back. Re-read idempotency and active-phase state in a
    // fresh transaction, resolving the omitted provider in that same snapshot.
    const recovered = withSqliteWriteRetry("pipeline-job.recover-conflict", () => getJobDispatchDb().transaction((tx) => {
      const provider = resolveAndValidateProvider(tx, input);
      if (idempotencyKey) {
        const existing = findExistingJobInTransaction(tx, {
          changeId: input.changeId,
          idempotencyKey,
        });
        if (existing) {
          return assertIdempotencyMatch(
            pipelineJobPayload(existing, false),
            { ...input, provider },
            idempotencyKey,
          );
        }
      }
      const active = findActivePhaseJobInTransaction(tx, input);
      if (!active) return null;
      if (active.actionId !== input.actionId) {
        throw new PipelineJobConflictError(
          `active ${input.phase} job already runs ${active.actionId}`,
        );
      }
      if (active.provider !== provider) {
        throw new ProviderSelectionConflictError(
          `active ${input.phase} job is already queued for provider ${active.provider}`,
        );
      }
      return pipelineJobPayload(active, false);
    }));
    if (recovered) return recovered;
    throw error;
  }
}

export function enqueuePipelineJob(input: EnqueuePipelineJobInput): PipelineJobPayload {
  return enqueuePipelineJobInternal(input);
}

export function enqueueProviderActionAtomically(
  input: EnqueuePipelineJobInput,
  fence?: EnqueueActionContractFence,
): PipelineJobPayload {
  return enqueuePipelineJobInternal(input, fence, true);
}
