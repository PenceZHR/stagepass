# SQLite Single-Writer Design

## Problem

The Next control plane, its route-analysis workers, and the pipeline worker all open the same SQLite database. Polling GET routes also execute recovery, action refresh, merge-readiness recomputation, and artifact-mirror persistence. Under a real provider run this creates repeated `SQLITE_BUSY`, 503 responses, a growing WAL, and request/socket accumulation.

## Required behavior

1. GET and SSE read surfaces must not mutate durable state.
2. Stale-provider recovery and derived-state persistence must execute outside request polling, under the pipeline worker.
3. Importing the database module must not open, create, migrate, or otherwise touch the production database.
4. Migrations must have one explicit owner before runtime processes accept work.
5. A real worker write transaction must not make phase polling return 503.
6. SQLite errors must preserve extended result codes for diagnosis.

## Architecture

### Read surfaces

Route handlers obtain stored snapshots only. Recovery status may be observed but not executed. Action and artifact APIs expose persisted state without self-healing writes. Commands and the worker remain responsible for producing new durable state.

### Recovery owner

The pipeline worker runs bounded recovery before leasing work and periodically while idle. Recovery failures are logged by the worker and do not turn a GET request into a write transaction.

### Database lifecycle

Database module import is side-effect free. Runtime access lazily opens a normal connection without migrations. The supervisor executes an explicit migration command once before spawning Next and the pipeline worker. Test and one-off callers can still create isolated handles explicitly.

### Failure handling

Normal concurrent reads continue under WAL while one writer owns the transaction. Unexpected write contention is retried at command/worker boundaries and logs the original extended SQLite code. Read APIs never translate write contention into `RECOVERY_INCOMPLETE`.

## Verification

- An import-only child process does not change `ship.db`, `ship.db-wal`, or `ship.db-shm` and does not retain a database handle.
- A real second connection holding `BEGIN IMMEDIATE` does not make repeated phase GET calls fail.
- Recovery still reconciles a stale provider run when invoked by the worker.
- Targeted tests, the full test suite, lint, and build pass.
- After terminal restart, a real Spec run and concurrent browser polling produce no sustained `SQLITE_BUSY`, no phase 503 responses, and no Next build-worker handles on the production database.
