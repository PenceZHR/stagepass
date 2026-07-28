import { PHASES } from "../domain/phase";
import { CHANGE_ACTIONS, PHASE_STATUSES } from "../domain/change-state";

/**
 * The L0 schema, with the ledger invariant enforced by the database itself.
 *
 * ## Why the enum lists are generated
 *
 * A `CHECK (phase IN (...))` written by hand is a second copy of the phase
 * list, and a second copy is a place for the two to disagree. They are built
 * from the domain constants instead, so adding a phase cannot leave the
 * database refusing it.
 *
 * ## Why a trigger and not a convention
 *
 * "Every state change is recorded" is only true if it cannot be skipped. A rule
 * that lives in one function is a rule that holds until the second caller
 * appears. `ck_changes_ledger` makes SQLite refuse any update to `changes`
 * that does not have a matching ledger row -- so a bypass is not a missing
 * audit entry discovered later, it is an immediate abort at the moment of the
 * write, with a stack trace pointing at the code that tried.
 */

const quoted = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(",");

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS changes (
  id            TEXT PRIMARY KEY,
  phase         TEXT NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  status        TEXT NOT NULL CHECK (status IN (${quoted(PHASE_STATUSES)})),
  return_phase  TEXT     NULL CHECK (return_phase IS NULL OR return_phase IN (${quoted(PHASES)})),
  seq           INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- The same two invariants the domain enforces, restated where the data lives.
  -- A row that could not have come from transition() must not be storable.
  CHECK ((phase = 'Fix') = (return_phase IS NOT NULL)),
  CHECK (status <> 'closed' OR phase = 'Done')
);

CREATE TABLE IF NOT EXISTS change_events (
  change_id   TEXT NOT NULL REFERENCES changes(id),
  seq         INTEGER NOT NULL,
  action      TEXT NOT NULL CHECK (action IN (${quoted(CHANGE_ACTIONS)},'create')),
  from_phase  TEXT     NULL,
  from_status TEXT     NULL,
  to_phase    TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  at          TEXT NOT NULL,
  PRIMARY KEY (change_id, seq)
);

-- The ledger is not optional. An update to a Change that is not accompanied by
-- its ledger row aborts the transaction that attempted it.
CREATE TRIGGER IF NOT EXISTS ck_changes_ledger
AFTER UPDATE ON changes
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM change_events
  WHERE change_id = NEW.id AND seq = NEW.seq
)
BEGIN
  SELECT RAISE(ABORT, 'change_updated_without_ledger_entry');
END;

-- Sequence numbers are dense and monotonic, so "the ledger is complete" is
-- checkable by arithmetic rather than by reading every row.
CREATE TRIGGER IF NOT EXISTS ck_changes_seq_advances
AFTER UPDATE ON changes
FOR EACH ROW
WHEN NEW.seq <> OLD.seq + 1
BEGIN
  SELECT RAISE(ABORT, 'change_seq_must_advance_by_one');
END;
`;
