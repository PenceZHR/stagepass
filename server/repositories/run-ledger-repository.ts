import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { artifacts, changes, events, findings, releaseNoteState, runs } from "../db/schema";
import {
  SqliteWriteBusyError,
  type SqliteWriteRetryOptions,
} from "../db/write-boundary";
import {
  currentExecutionFenceContext,
  withCurrentExecutionFenceWrite,
} from "../services/execution-fence-service";

/** The default (singleton) connection, or a transaction handle a caller owns. */
export type RunLedgerDb = typeof db;

/**
 * nextRunLedgerId only reads, so it accepts any handle that can `select` --
 * the module singleton, an injected test db, or (crucially) the caller's
 * in-flight transaction handle so id allocation observes uncommitted rows.
 */
type RunLedgerReadConnection = Pick<RunLedgerDb, "select">;

let runLedgerDbForTest: RunLedgerDb | null = null;

export function setRunLedgerDbForTest(nextDb: RunLedgerDb): () => void {
  const previous = runLedgerDbForTest;
  runLedgerDbForTest = nextDb;
  return () => {
    runLedgerDbForTest = previous;
  };
}

function getRunLedgerDb(): RunLedgerDb {
  return runLedgerDbForTest ?? db;
}

type LedgerTablePrefix = "RUN" | "EVT" | "ART" | "FND";
type LedgerTable = typeof runs | typeof events | typeof artifacts | typeof findings;

export type RunLedgerRunRow = typeof runs.$inferInsert;
export type RunLedgerEventRow = typeof events.$inferInsert;
export type RunLedgerArtifactRow = typeof artifacts.$inferInsert;
export type RunLedgerReleaseNoteStateRow = typeof releaseNoteState.$inferInsert;
export type RunLedgerFindingRow = typeof findings.$inferInsert;
export type RunLedgerRunPatch = Partial<typeof runs.$inferInsert>;
/**
 * `status` is deliberately not patchable here: it is the state machine's to
 * write, and patchChange runs none of its checks (assertLegalTransition,
 * assertTransitionInvariants) and emits no change_status_changed event. Route
 * status changes through change-status-service.
 */
export type RunLedgerChangePatch = Omit<Partial<typeof changes.$inferInsert>, "status">;

export class RunLedgerEventInsertError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = "RunLedgerEventInsertError";
  }
}

export class RunLedgerMutationTargetMissingError extends Error {
  public readonly code = "run_ledger_mutation_target_missing";

  constructor(
    public readonly operation: string,
    public readonly target: string,
  ) {
    super(`Run ledger mutation target was not found: ${operation} ${target}`);
    this.name = "RunLedgerMutationTargetMissingError";
  }
}

function assertMutationAffected(
  result: { changes: number },
  operation: string,
  target: string,
): void {
  if (result.changes === 0) {
    throw new RunLedgerMutationTargetMissingError(operation, target);
  }
}

function legacyRetryOptions(
  options: { maxAttempts?: number; retryDelayMs?: number },
): SqliteWriteRetryOptions {
  if (options.retryDelayMs === undefined) {
    return { maxAttempts: options.maxAttempts };
  }
  const maxAttempts = options.maxAttempts ?? 3;
  return {
    maxAttempts,
    delaysMs: Array.from({ length: Math.max(0, maxAttempts - 1) }, () => options.retryDelayMs ?? 25),
  };
}

const ledgerTables: Record<LedgerTablePrefix, LedgerTable> = {
  RUN: runs,
  EVT: events,
  ART: artifacts,
  FND: findings,
};

function ledgerTableForPrefix(prefix: string): LedgerTable {
  const table = ledgerTables[prefix as LedgerTablePrefix];
  if (!table) {
    throw new Error(`Unsupported run ledger id prefix: ${prefix}`);
  }
  return table;
}

export function nextRunLedgerId(
  prefix: string,
  connection: RunLedgerReadConnection = getRunLedgerDb(),
): string {
  const table = ledgerTableForPrefix(prefix);
  const rows = connection.select({ id: table.id }).from(table).all();
  const used = new Set<string>();
  let maxNum = 0;
  for (const row of rows) {
    const id = row.id as string;
    used.add(id);
    const match = id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
  }

  let nextNum = maxNum + 1;
  let candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;
  while (used.has(candidate)) {
    nextNum += 1;
    candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;
  }
  return candidate;
}

/** Inserts the run row into a transaction the caller already owns. */
export function createRunWithDb(tx: RunLedgerDb, row: RunLedgerRunRow): void {
  const context = currentExecutionFenceContext();
  tx.insert(runs).values(context ? {
    ...row,
    jobId: context.jobId,
    workerId: context.workerId,
    leaseToken: context.leaseToken,
    attemptNo: context.attemptNo,
  } : row).run();
}

export function createRun(row: RunLedgerRunRow): void {
  withCurrentExecutionFenceWrite("run-ledger.create-run", undefined, (tx) => {
    createRunWithDb(tx, row);
  });
}

/** Ends the run inside a transaction the caller already owns. */
export function endRunWithDb(tx: RunLedgerDb, runId: string, patch: RunLedgerRunPatch): void {
  assertMutationAffected(
    tx.update(runs).set(patch).where(eq(runs.id, runId)).run(),
    "endRun",
    runId,
  );
}

export function endRun(runId: string, patch: RunLedgerRunPatch): void {
  withCurrentExecutionFenceWrite("run-ledger.end-run", runId, (tx) => {
    endRunWithDb(tx, runId, patch);
  });
}

export function patchChange(
  changeId: string,
  patch: RunLedgerChangePatch,
  options: { runId?: string } = {},
): void {
  withCurrentExecutionFenceWrite("run-ledger.patch-change", options.runId, (tx) => {
    assertMutationAffected(
      tx.update(changes).set(patch).where(eq(changes.id, changeId)).run(),
      "patchChange",
      changeId,
    );
  });
}

export function bindRunToCurrentExecution(runId: string): void {
  const context = currentExecutionFenceContext();
  if (!context) return;
  withCurrentExecutionFenceWrite("run-ledger.bind-run-execution", undefined, (tx) => {
    const result = tx.update(runs).set({
      jobId: context.jobId,
      workerId: context.workerId,
      leaseToken: context.leaseToken,
      attemptNo: context.attemptNo,
    }).where(eq(runs.id, runId)).run();
    assertMutationAffected(result, "bindRunToCurrentExecution", runId);
  });
}

/** Stops every running run for the change inside a transaction the caller already owns. */
export function stopActiveRunsWithDb(tx: RunLedgerDb, changeId: string, endedAt: string): void {
  const result = tx.update(runs)
    .set({ status: "stopped", endedAt })
    .where(and(eq(runs.changeId, changeId), eq(runs.status, "running")))
    .run();
  assertMutationAffected(result, "stopActiveRuns", changeId);
}

export function stopActiveRuns(changeId: string, endedAt: string): void {
  withCurrentExecutionFenceWrite("run-ledger.stop-active-runs", undefined, (tx) => {
    stopActiveRunsWithDb(tx, changeId, endedAt);
  });
}

export function insertEvent(row: RunLedgerEventRow): void {
  withCurrentExecutionFenceWrite("run-ledger.insert-event", row.runId ?? undefined, (tx) => {
    tx.insert(events).values(row).run();
  });
}

export function insertEventWithRetry(
  row: RunLedgerEventRow,
  options: { maxAttempts?: number; retryDelayMs?: number } = {},
): void {
  try {
    withCurrentExecutionFenceWrite(
      "run-ledger.insert-event",
      row.runId ?? undefined,
      (tx) => {
        tx.insert(events).values(row).run();
      },
      legacyRetryOptions(options),
    );
  } catch (error) {
    if (error instanceof SqliteWriteBusyError) {
      throw new RunLedgerEventInsertError(
        `Failed to insert run ledger event after ${error.attempts} attempts: ${row.type}`,
        error.cause,
        error.attempts,
      );
    }
    throw error;
  }
}

export function insertArtifact(row: RunLedgerArtifactRow): void {
  withCurrentExecutionFenceWrite("run-ledger.insert-artifact", row.runId ?? undefined, (tx) => {
    tx.insert(artifacts).values(row).run();
  });
}

export function insertReleaseNoteState(row: RunLedgerReleaseNoteStateRow): void {
  withCurrentExecutionFenceWrite("run-ledger.insert-release-note-state", row.runId, (tx) => {
    tx.insert(releaseNoteState).values(row).run();
  });
}

export function insertFinding(row: RunLedgerFindingRow): void {
  withCurrentExecutionFenceWrite("run-ledger.insert-finding", row.runId ?? undefined, (tx) => {
    tx.insert(findings).values(row).run();
  });
}

export function deleteFinding(findingId: string, runId?: string): void {
  withCurrentExecutionFenceWrite("run-ledger.delete-finding", runId, (tx) => {
    assertMutationAffected(
      tx.delete(findings).where(eq(findings.id, findingId)).run(),
      "deleteFinding",
      findingId,
    );
  });
}

export const runLedgerRepository = {
  nextRunLedgerId,
  createRun,
  createRunWithDb,
  endRun,
  endRunWithDb,
  patchChange,
  bindRunToCurrentExecution,
  stopActiveRuns,
  stopActiveRunsWithDb,
  insertEvent,
  insertEventWithRetry,
  insertArtifact,
  insertReleaseNoteState,
  insertFinding,
  deleteFinding,
};
