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

-- ---------------------------------------------------------------------------
-- L1
-- ---------------------------------------------------------------------------

-- What a phase produced, and what is still wrong with it. The gate reads only
-- this; it never reads a model's opinion of how the phase went.
CREATE TABLE IF NOT EXISTS change_evidence (
  change_id     TEXT NOT NULL REFERENCES changes(id),
  phase         TEXT NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  artifact_ids  TEXT NOT NULL,
  blockers      TEXT NOT NULL,
  waived_ids    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (change_id, phase)
);

-- Applied commands, keyed by the caller's idempotency key.
--
-- Only COMPLETED commands are stored. A refusal is not a durable outcome: the
-- gate that refused it may open, and a caller that retries then must not be
-- handed back the old "no".
CREATE TABLE IF NOT EXISTS commands (
  idempotency_key   TEXT PRIMARY KEY,
  change_id         TEXT NOT NULL REFERENCES changes(id),
  action            TEXT NOT NULL CHECK (action IN (${quoted(CHANGE_ACTIONS)})),
  request_hash      TEXT NOT NULL,
  expected_snapshot TEXT NOT NULL,
  result_seq        INTEGER NOT NULL,
  result_phase      TEXT NOT NULL CHECK (result_phase IN (${quoted(PHASES)})),
  result_status     TEXT NOT NULL CHECK (result_status IN (${quoted(PHASE_STATUSES)})),
  at                TEXT NOT NULL
);

-- Long-running work and who owns it.
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  change_id     TEXT NOT NULL REFERENCES changes(id),
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempt       INTEGER NOT NULL,
  max_attempts  INTEGER NOT NULL,
  owner         TEXT NULL,
  token         TEXT NULL,
  expires_at    INTEGER NULL,
  deadline_at   INTEGER NOT NULL,
  error         TEXT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- A running job has an owner; a job that is not running has none. Without
  -- this, "running with nobody on it" is a representable row -- which is the
  -- exact state where work looks alive forever and nothing tells anyone.
  CHECK ((status = 'running') = (owner IS NOT NULL AND token IS NOT NULL AND expires_at IS NOT NULL)),
  -- A terminal job states why. A failed job with no reason is the shape that
  -- let the old tree report failures as though they were nothing at all.
  CHECK (status <> 'failed' OR error IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_jobs_claimable ON jobs (status, created_at);

-- ---------------------------------------------------------------------------
-- L2
-- ---------------------------------------------------------------------------

-- One Change, one persistent Codex thread.
--
-- The uniqueness is the point: a second thread for the same Change means two
-- conversations that each know half the story, which is what the old tree's
-- "do not create a second user-visible task" rule was fighting.
CREATE TABLE IF NOT EXISTS change_bindings (
  change_id   TEXT PRIMARY KEY REFERENCES changes(id),
  thread_id   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('bound','detached')),
  bound_at    TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_change_bindings_thread
  ON change_bindings (thread_id) WHERE status = 'bound';

-- Every turn StagePass asks for, written down BEFORE it is dispatched.
--
-- Recording it first is what makes a lost response survivable: on restart the
-- turn is there, in the dispatched state, and can be reconciled. A turn written
-- dispatch is a turn that, if the process dies in between, never existed --
-- and the work silently happened twice.
CREATE TABLE IF NOT EXISTS turns (
  id            TEXT PRIMARY KEY,
  change_id     TEXT NOT NULL REFERENCES changes(id),
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  phase         TEXT NOT NULL CHECK (phase IN (${quoted(PHASES)})),
  request_hash  TEXT NOT NULL,
  prompt        TEXT NOT NULL CHECK (length(trim(prompt)) > 0),
  status        TEXT NOT NULL CHECK (status IN ('pending','dispatched','completed','failed')),
  thread_id     TEXT NULL,
  response      TEXT NULL,
  error         TEXT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- A completed turn has what came back; a failed one says why. Neither may be
  -- silent about its own outcome.
  CHECK (status <> 'completed' OR response IS NOT NULL),
  CHECK (status <> 'failed' OR error IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_turns_job ON turns (job_id, created_at);
`;
