import type Database from "better-sqlite3";

import {
  assertRequestValid,
  requestHash,
  type TurnRequest,
} from "../domain/turn";
import type { Phase } from "../domain/phase";

/**
 * Every turn StagePass asks for, written down before it is sent.
 *
 * ## Record first, dispatch second
 *
 * If the process dies between sending a turn and hearing back, the turn still
 * exists here in `dispatched`, and recovery can decide what to do with it. Were
 * it recorded afterwards, that same crash would erase all trace of work that
 * had actually run -- and the retry would run it a second time.
 *
 * ## A turn states its own outcome
 *
 * `completed` carries what came back; `failed` carries why. The schema refuses
 * either without it, so "the turn ended, somehow" is not a storable state. The
 * old tree's signature failure was a green job above a Change that had never
 * moved; this is the same lesson one level down.
 */

export type TurnStatus = "pending" | "dispatched" | "completed" | "failed";

export interface TurnRecord {
  readonly id: string;
  readonly changeId: string;
  readonly jobId: string;
  readonly phase: Phase;
  readonly prompt: string;
  readonly requestHash: string;
  readonly status: TurnStatus;
  readonly threadId: string | null;
  readonly response: string | null;
  readonly error: string | null;
}

export class TurnNotFoundError extends Error {
  constructor(readonly turnId: string) {
    super(`No turn with id ${turnId}`);
    this.name = "TurnNotFoundError";
  }
}

/** Raised when a turn is moved from a state that move does not start in. */
export class TurnNotInStatusError extends Error {
  constructor(
    readonly turnId: string,
    readonly expected: TurnStatus,
    readonly actual: TurnStatus,
  ) {
    super(`Turn ${turnId} is ${actual}, not ${expected}`);
    this.name = "TurnNotInStatusError";
  }
}

interface TurnRow {
  id: string;
  change_id: string;
  job_id: string;
  phase: Phase;
  prompt: string;
  request_hash: string;
  status: TurnStatus;
  thread_id: string | null;
  response: string | null;
  error: string | null;
}

function toRecord(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    changeId: row.change_id,
    jobId: row.job_id,
    phase: row.phase,
    prompt: row.prompt,
    requestHash: row.request_hash,
    status: row.status,
    threadId: row.thread_id,
    response: row.response,
    error: row.error,
  };
}

export class TurnStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Write the turn down. Nothing has been sent yet.
   *
   * Idempotent on the turn id, so a worker that crashed after allocating and
   * before dispatching finds its own record rather than making a second one.
   */
  allocate(input: {
    id: string;
    jobId: string;
    request: TurnRequest;
  }): TurnRecord {
    assertRequestValid(input.request);
    const existing = this.find(input.id);
    if (existing) return existing;

    const at = this.now().toISOString();
    this.database.prepare(
      `INSERT INTO turns
         (id, change_id, job_id, phase, request_hash, prompt, status,
          thread_id, response, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`,
    ).run(
      input.id,
      input.request.changeId,
      input.jobId,
      input.request.phase,
      requestHash(input.request),
      input.request.prompt,
      at,
      at,
    );
    return this.read(input.id);
  }

  find(turnId: string): TurnRecord | null {
    const row = this.database.prepare("SELECT * FROM turns WHERE id = ?")
      .get(turnId) as TurnRow | undefined;
    return row ? toRecord(row) : null;
  }

  read(turnId: string): TurnRecord {
    const record = this.find(turnId);
    if (!record) throw new TurnNotFoundError(turnId);
    return record;
  }

  /** It is on its way. From here a crash is recoverable, not invisible. */
  markDispatched(turnId: string, threadId: string): TurnRecord {
    this.move(turnId, "pending", (id) => {
      this.database.prepare(
        "UPDATE turns SET status = 'dispatched', thread_id = ?, updated_at = ? WHERE id = ?",
      ).run(threadId, this.now().toISOString(), id);
    });
    return this.read(turnId);
  }

  markCompleted(turnId: string, response: string): TurnRecord {
    this.move(turnId, "dispatched", (id) => {
      this.database.prepare(
        "UPDATE turns SET status = 'completed', response = ?, updated_at = ? WHERE id = ?",
      ).run(response, this.now().toISOString(), id);
    });
    return this.read(turnId);
  }

  /**
   * Fail from wherever it got to. Unlike the other two this accepts any
   * non-terminal state: a turn can die before it is sent (no thread, no Codex)
   * as easily as after, and both have to be recordable.
   */
  markFailed(turnId: string, reason: string): TurnRecord {
    const current = this.read(turnId);
    if (current.status === "completed" || current.status === "failed") {
      throw new TurnNotInStatusError(turnId, "dispatched", current.status);
    }
    this.database.prepare(
      "UPDATE turns SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
    ).run(reason, this.now().toISOString(), turnId);
    return this.read(turnId);
  }

  /** Turns that were sent and never came back. Recovery's input. */
  inFlight(): TurnRecord[] {
    return (this.database.prepare(
      "SELECT * FROM turns WHERE status = 'dispatched' ORDER BY created_at",
    ).all() as TurnRow[]).map(toRecord);
  }

  private move(
    turnId: string,
    expected: TurnStatus,
    write: (turnId: string) => void,
  ): void {
    const current = this.read(turnId);
    if (current.status !== expected) {
      throw new TurnNotInStatusError(turnId, expected, current.status);
    }
    write(turnId);
  }
}
