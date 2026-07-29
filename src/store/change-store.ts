import type Database from "better-sqlite3";

import {
  assertStateValid,
  INITIAL_STATE,
  transition,
  type ChangeAction,
  type ChangeState,
  type PhaseStatus,
} from "../domain/change-state";
import { isPhase, type Phase } from "../domain/phase";

/**
 * The only code in the tree that writes a Change's position.
 *
 * Every transition is applied by `transition()` -- the pure machine -- and
 * persisted together with its ledger row in one transaction. There is no
 * second path, and `ck_changes_ledger` makes the database refuse one.
 *
 * ## Why the state is re-validated on the way out of the database
 *
 * A row is not automatically a state the machine would have produced. It could
 * predate a schema change, or have been edited by hand. `assertStateValid`
 * runs on read so a state the machine could not have reached is a loud failure
 * at the moment it is loaded, not a silent input to the next transition.
 */

export class ChangeNotFoundError extends Error {
  constructor(readonly changeId: string) {
    super(`No Change with id ${changeId}`);
    this.name = "ChangeNotFoundError";
  }
}

export interface ChangeRecord {
  readonly id: string;
  /** The project it belongs to, or null. Nothing decidable reads this. */
  readonly projectId: string | null;
  /** What a person calls it, or null. Nothing decidable reads this either. */
  readonly title: string | null;
  readonly state: ChangeState;
  /** How many ledger entries this Change has. Its creation is entry 0. */
  readonly seq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LedgerEntry {
  readonly seq: number;
  readonly action: ChangeAction | "create";
  readonly from: ChangeState | null;
  readonly to: ChangeState;
  readonly at: string;
}

interface ChangeRow {
  id: string;
  project_id: string | null;
  title: string | null;
  phase: string;
  status: string;
  return_phase: string | null;
  seq: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  seq: number;
  action: string;
  from_phase: string | null;
  from_status: string | null;
  to_phase: string;
  to_status: string;
  at: string;
}

function toPhase(value: string): Phase {
  if (!isPhase(value)) throw new Error(`Unknown phase in database: ${value}`);
  return value;
}

function toState(row: {
  phase: string;
  status: string;
  return_phase: string | null;
}): ChangeState {
  const state: ChangeState = {
    phase: toPhase(row.phase),
    status: row.status as PhaseStatus,
    returnPhase: row.return_phase === null ? null : toPhase(row.return_phase),
  };
  assertStateValid(state);
  return state;
}

export interface ChangeStoreOptions {
  now?: () => Date;
}

export class ChangeStore {
  private readonly now: () => Date;

  constructor(
    private readonly database: Database.Database,
    options: ChangeStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Start a Change.
   *
   * `projectId` and `title` are optional because a Change is complete without
   * them: nothing in the state machine, the gate or the fence reads either.
   * They carry what a PERSON needs to recognise it, which is why they may be
   * absent everywhere the machinery is proved.
   */
  create(
    changeId: string,
    belonging: { projectId?: string; title?: string } = {},
  ): ChangeRecord {
    const at = this.now().toISOString();
    this.database.transaction(() => {
      this.database.prepare(
        `INSERT INTO changes
           (id, project_id, title, phase, status, return_phase, seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        changeId,
        belonging.projectId ?? null,
        belonging.title ?? null,
        INITIAL_STATE.phase,
        INITIAL_STATE.status,
        INITIAL_STATE.returnPhase,
        at,
        at,
      );
      // Entry 0 is the creation itself, so the ledger explains where a Change
      // started rather than only how it moved afterwards.
      this.database.prepare(
        `INSERT INTO change_events
           (change_id, seq, action, from_phase, from_status, to_phase, to_status, at)
         VALUES (?, 0, 'create', NULL, NULL, ?, ?, ?)`,
      ).run(changeId, INITIAL_STATE.phase, INITIAL_STATE.status, at);
    })();
    return this.read(changeId);
  }

  read(changeId: string): ChangeRecord {
    const row = this.database.prepare(
      "SELECT * FROM changes WHERE id = ?",
    ).get(changeId) as ChangeRow | undefined;
    if (!row) throw new ChangeNotFoundError(changeId);
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      state: toState(row),
      seq: row.seq,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Every Change, or every Change in one project. What a list column shows. */
  list(projectId?: string): ChangeRecord[] {
    const rows = (projectId === undefined
      ? this.database.prepare("SELECT * FROM changes ORDER BY created_at").all()
      : this.database.prepare(
          "SELECT * FROM changes WHERE project_id = ? ORDER BY created_at",
        ).all(projectId)) as ChangeRow[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      state: toState(row),
      seq: row.seq,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Apply an action. Throws `IllegalTransitionError` without touching the
   * database when the machine refuses it, so a rejected action leaves no trace
   * and no partial write.
   */
  apply(changeId: string, action: ChangeAction): ChangeRecord {
    const current = this.read(changeId);
    const next = transition(current.state, action);
    const at = this.now().toISOString();
    const seq = current.seq + 1;

    this.database.transaction(() => {
      // Ledger first: `ck_changes_ledger` looks for this row when the update
      // below fires, so writing it second would abort every legal transition.
      this.database.prepare(
        `INSERT INTO change_events
           (change_id, seq, action, from_phase, from_status, to_phase, to_status, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        changeId,
        seq,
        action,
        current.state.phase,
        current.state.status,
        next.phase,
        next.status,
        at,
      );
      const changed = this.database.prepare(
        `UPDATE changes
            SET phase = ?, status = ?, return_phase = ?, seq = ?, updated_at = ?
          WHERE id = ? AND seq = ?`,
      ).run(
        next.phase,
        next.status,
        next.returnPhase,
        seq,
        at,
        changeId,
        current.seq,
      ).changes;
      // Compare-and-set on seq: two workers applying an action to the same
      // Change cannot both win, and the loser fails loudly instead of
      // overwriting a transition it never saw.
      if (changed !== 1) {
        throw new Error(`change_seq_conflict:${changeId}`);
      }
    })();
    return this.read(changeId);
  }

  ledger(changeId: string): LedgerEntry[] {
    const rows = this.database.prepare(
      "SELECT * FROM change_events WHERE change_id = ? ORDER BY seq",
    ).all(changeId) as EventRow[];
    return rows.map((row) => ({
      seq: row.seq,
      action: row.action as ChangeAction | "create",
      from: row.from_phase === null || row.from_status === null
        ? null
        : {
            phase: toPhase(row.from_phase),
            status: row.from_status as PhaseStatus,
            returnPhase: null,
          },
      to: {
        phase: toPhase(row.to_phase),
        status: row.to_status as PhaseStatus,
        returnPhase: null,
      },
      at: row.at,
    }));
  }
}
