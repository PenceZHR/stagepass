import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { pipelineJobs, runs } from "../db/schema";
import {
  withSqliteWriteRetry,
  type SqliteWriteRetryOptions,
} from "../db/write-boundary";
import {
  StaleLeaseFenceError,
  type JobExecutionContext,
} from "./job-execution-context";

type ExecutionFenceScope =
  | { mode: "strict"; context: JobExecutionContext }
  | { mode: "legacy" };

const executionFenceStorage = new AsyncLocalStorage<ExecutionFenceScope>();

export function assertCompleteExecutionContext(
  context: JobExecutionContext,
): void {
  if (
    !context.jobId
    || !context.workerId
    || !context.leaseToken
    || !Number.isInteger(context.attemptNo)
    || context.attemptNo < 1
  ) {
    throw new Error("Pipeline action requires a complete JobExecutionContext");
  }
}

export function currentExecutionFenceContext(): JobExecutionContext | null {
  const scope = executionFenceStorage.getStore();
  return scope?.mode === "strict" ? scope.context : null;
}

export function hasLegacyExecutionFence(): boolean {
  return executionFenceStorage.getStore()?.mode === "legacy";
}

export function assertCurrentExecutionFence(
  context: JobExecutionContext,
  runId?: string,
): void {
  assertCurrentExecutionFenceWithDb(db, context, runId);
}

type ExecutionFenceDb = Pick<typeof db, "select">;

export function assertCurrentExecutionFenceWithDb(
  fenceDb: ExecutionFenceDb,
  context: JobExecutionContext,
  runId?: string,
): void {
  assertCompleteExecutionContext(context);
  const job = fenceDb.select({ id: pipelineJobs.id })
    .from(pipelineJobs)
    .where(and(
      eq(pipelineJobs.id, context.jobId),
      eq(pipelineJobs.leasedBy, context.workerId),
      eq(pipelineJobs.leaseToken, context.leaseToken),
      eq(pipelineJobs.attemptNo, context.attemptNo),
      eq(pipelineJobs.status, "running"),
    ))
    .get();
  if (!job) throw new StaleLeaseFenceError(context);

  if (runId === undefined) return;
  const run = fenceDb.select({ id: runs.id })
    .from(runs)
    .where(and(
      eq(runs.id, runId),
      eq(runs.jobId, context.jobId),
      eq(runs.workerId, context.workerId),
      eq(runs.leaseToken, context.leaseToken),
      eq(runs.attemptNo, context.attemptNo),
    ))
    .get();
  if (!run) throw new StaleLeaseFenceError(context);
}

export function withCurrentExecutionFenceWrite<T>(
  label: string,
  runId: string | undefined,
  operation: (transaction: typeof db) => T,
  retryOptions?: SqliteWriteRetryOptions,
): T {
  return withSqliteWriteRetry(label, () =>
    db.transaction((transaction) => {
      const transactionDb = transaction as unknown as typeof db;
      const context = currentExecutionFenceContext();
      if (context) assertCurrentExecutionFenceWithDb(transactionDb, context, runId);
      return operation(transactionDb);
    }), retryOptions);
}

export async function withExecutionFence<T>(
  context: JobExecutionContext,
  operation: () => Promise<T>,
): Promise<T> {
  assertCurrentExecutionFence(context);
  return executionFenceStorage.run({ mode: "strict", context }, operation);
}

export function withLegacyExecutionFence<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return executionFenceStorage.run({ mode: "legacy" }, operation);
}
