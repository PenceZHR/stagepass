# System Blocker Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the blockers listed in `docs/system-blocker-audit-2026-07-06.md` so database, API routes, pipeline state, process management, and long-running streams fail predictably instead of crashing, hanging, or corrupting data.

**Architecture:** Apply the repairs in dependency order: first cap hangs and unsafe public mutations, then make write paths atomic, then centralize state transitions, then harden startup/migration/process cleanup. Each stage must keep behavior compatible with existing routes and services while adding regression tests around the exact failure mode from the audit.

**Tech Stack:** Next.js route handlers, TypeScript, better-sqlite3, Drizzle ORM, Node `child_process`, Node test runner via `tsx --test`, ESLint, SQLite migrations.

---

## Current Execution Status

The first emergency repair slice has been delegated to an implementation subagent and passed independent review:

- `server/db/index.ts`: add `busy_timeout = 5000`.
- `server/services/git-service.ts` and audited sync command callers: add timeouts.
- `app/api/projects/[id]/changes/[changeId]/route.ts`: block generic status PATCH mutation.
- `server/services/change-service.ts`: expand deletion protection for running states.
- `app/api/projects/[id]/changes/[changeId]/events/stream/route.ts`: catch interval errors and close streams.

Independent review result for Stage 0: no Critical or Important issues found. Minor follow-ups are tracked in the Stage 5 SSE lifecycle work and in the final test-quality cleanup notes. This document is the full follow-on plan for all audit findings. Stage 0 corresponds to the delegated emergency slice.

## File Responsibility Map

- `server/db/index.ts`: database connection pragmas and future lazy initialization boundary.
- `server/db/migrate.ts`: migration execution, idempotency, and failure recording.
- `server/db/schema.ts`: indexes and future schema support for atomic IDs or run uniqueness.
- `server/db/migrations/*.sql`: schema migrations for indexes, ID strategy, and uniqueness constraints.
- `server/services/git-service.ts`: command execution wrapper, git timeout defaults, and spawn error formatting.
- `server/services/commit-message-service.ts`: Claude CLI discovery and commit message generation timeout.
- `server/services/preflight-service.ts`, `merge-readiness-service.ts`, `review-qa-gate-service.ts`, `scope-check-service.ts`: audited direct git probes.
- `server/services/change-service.ts`: change creation/deletion, status updates, record cleanup, and filesystem coordination.
- `server/services/project-service.ts`: project deletion transaction boundary and post-commit filesystem cleanup.
- `server/services/graph-runner.ts`: event ID generation, stuck-run behavior, and top-level recovery.
- `server/services/pipeline-run-ledger-service.ts`: status CAS, transition guard entrypoint, and stage violation atomic writes.
- `server/services/gate-service.ts`: merge approval transaction and Plan gate integration point.
- `server/services/merge-readiness-service.ts`: atomic readiness and blocker persistence.
- `server/services/claude-engine.ts`, `server/services/codex-engine.ts`, `server/services/ai-engine-adapter.ts`: subprocess/stream timeout and API key validation.
- `app/api/projects/[id]/changes/[changeId]/route.ts`: generic change detail route; must not mutate status directly.
- `app/api/projects/[id]/changes/[changeId]/events/stream/route.ts`: SSE lifecycle and interval cleanup.
- `docs/state-machine.md`: update only after central transition guard is implemented.

## Stage 0: Emergency Crash and Hang Guards

**Audit items:** FATAL-2, FATAL-4, CRITICAL-2, CRITICAL-4, HIGH-5.

**Files:**
- Modify: `server/db/index.ts`
- Modify: `server/services/git-service.ts`
- Modify: `server/services/commit-message-service.ts`
- Modify: `server/services/preflight-service.ts`
- Modify: `server/services/merge-readiness-service.ts`
- Modify: `server/services/review-qa-gate-service.ts`
- Modify: `server/services/scope-check-service.ts`
- Modify: `server/services/change-service.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/events/stream/route.ts`
- Test: `server/services/change-route-guard.test.ts`
- Test: `server/services/prd-briefing-service.test.ts`

- [x] **Step 1: Add SQLite busy timeout**

Required code shape:

```typescript
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("foreign_keys = ON");
```

- [x] **Step 2: Add child-process timeouts**

Use these values consistently:

```typescript
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const AI_COMMAND_TIMEOUT_MS = 300_000;
```

Every audited `execSync` and `spawnSync` call must receive a `timeout` directly or through a local wrapper.

- [x] **Step 3: Block generic PATCH status mutation**

The generic change route must return a JSON error after verifying project/change ownership. It must not parse or accept a `status` field.

- [x] **Step 4: Protect all active running states from deletion**

`RUNNING_STATES` must include:

```typescript
[
  "SPECCING",
  "TECHSPECCING",
  "TESTPLANNING",
  "IMPLEMENTING",
  "REVIEWING",
  "CHECKING",
  "FIXING",
  "MERGING",
  "RETRO_PENDING",
]
```

- [x] **Step 5: Catch SSE interval failures**

Both event polling and keepalive intervals must catch exceptions, clear intervals, and close the stream idempotently.

- [x] **Step 6: Verify Stage 0**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/change-route-guard.test.ts server/services/prd-briefing-service.test.ts
npx tsx --test --test-concurrency=1 server/services/git-service.test.ts server/services/preflight-service.test.ts server/services/merge-readiness-service.test.ts server/services/review-qa-gate-service.test.ts
npx eslint app/api/projects/[id]/changes/[changeId]/route.ts app/api/projects/[id]/changes/[changeId]/events/stream/route.ts server/db/index.ts server/services/change-service.ts server/services/git-service.ts server/services/commit-message-service.ts server/services/preflight-service.ts server/services/merge-readiness-service.ts server/services/review-qa-gate-service.ts server/services/scope-check-service.ts server/services/change-route-guard.test.ts server/services/prd-briefing-service.test.ts
```

Observed on 2026-07-06:

- `npx tsx --test --test-concurrency=1 server/services/change-route-guard.test.ts server/services/prd-briefing-service.test.ts`: 23 tests passed.
- `npx tsx --test --test-concurrency=1 server/services/git-service.test.ts server/services/preflight-service.test.ts server/services/merge-readiness-service.test.ts server/services/review-qa-gate-service.test.ts`: 42 tests passed.
- Targeted `npx eslint ...`: passed.
- `npx tsc --noEmit`: failed on existing project-wide `.ts` import-extension diagnostics and unrelated test typing errors. This is not a Stage 0 regression, but it remains a separate repository health task before a full release gate can be green.

## Stage 1: Atomic IDs and Concurrent Run Exclusion

**Audit items:** CRITICAL-3, CRITICAL-5.

**Files:**
- Modify: `server/db/schema.ts`
- Create: `server/db/migrations/00XX_atomic_ids_and_running_runs.sql`
- Modify: `server/services/graph-runner.ts`
- Modify: `server/services/change-service.ts`
- Modify: `server/services/pipeline-run-ledger-service.ts`
- Test: `server/services/graph-runner.test.ts` or create `server/services/id-generation.test.ts`
- Test: `server/services/pipeline-run-ledger-service.test.ts`

- [ ] **Step 1: Replace read-then-write event IDs**

Preferred minimal repair: introduce an ID helper that uses UUID text IDs for newly created events and artifacts without changing existing row compatibility.

Code shape:

```typescript
import { randomUUID } from "node:crypto";

export function nextEventId(prefix = "EVT"): string {
  return `${prefix}-${randomUUID()}`;
}
```

Use the helper in `graph-runner.ts` and `change-service.ts`. Keep existing IDs readable by prefixing UUIDs.

- [ ] **Step 2: Add a collision regression test**

Create a test that calls event ID generation many times in the same tick and asserts uniqueness:

```typescript
const ids = new Set(Array.from({ length: 1000 }, () => nextEventId()));
assert.equal(ids.size, 1000);
```

- [ ] **Step 3: Add running-run uniqueness**

Add a migration for a partial unique index or equivalent SQLite-supported guard. If the existing `runs.status` values distinguish active runs, use:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_runs_one_running_per_change_phase
ON runs(change_id, phase)
WHERE status IN ('running', 'started', 'in_progress');
```

If actual status values differ, inspect `server/db/schema.ts` and all run insertions first, then use the concrete active values from the codebase.

- [ ] **Step 4: Add CAS status update path**

In `pipeline-run-ledger-service.ts`, add an expected-status update path:

```typescript
UPDATE changes
SET status = ?, updated_at = ?
WHERE id = ? AND status = ?
```

If affected rows are `0`, throw a typed conflict error that route handlers can return as `409`.

- [ ] **Step 5: Verify Stage 1**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/pipeline-run-ledger-service.test.ts server/services/pipeline-routes.test.ts
npx tsx --test --test-concurrency=1 server/services/db-migrations.test.ts
```

Expected: concurrent starts reject the second request deterministically and ID generation tests pass without primary-key collisions.

## Stage 2: Transactions for Multi-Table Writes and Deletes

**Audit items:** CRITICAL-1, CRITICAL-6, MEDIUM-3.

**Files:**
- Modify: `server/services/gate-service.ts`
- Modify: `server/services/change-service.ts`
- Modify: `server/services/project-service.ts`
- Modify: `server/services/pipeline-run-ledger-service.ts`
- Modify: `server/services/merge-readiness-service.ts`
- Test: existing matching `*.test.ts` files for each service

- [ ] **Step 1: Wrap `insertMergeApproval` in one transaction**

All writes for `humanDecisions`, `mergeApprovals`, `mergeReadiness`, `mergeBlockers`, and `mergeDecisions` must commit or roll back together.

- [ ] **Step 2: Split filesystem effects from DB transaction in `createChange`**

Create DB rows in a transaction. Perform filesystem and git branch actions in a controlled order with compensating cleanup on failure:

```typescript
try {
  fs.mkdirSync(changeDir, { recursive: true });
  // write spec and branch
  db.transaction(() => {
    db.insert(changes).values(change).run();
    db.insert(artifacts).values(...).run();
    db.insert(events).values(...).run();
  })();
} catch (err) {
  fs.rmSync(changeDir, { recursive: true, force: true });
  throw err;
}
```

- [ ] **Step 3: Wrap `deleteChangeRecords` with transaction support**

Expose an internal function that accepts a transaction DB handle, then call it from `deleteChange` and `deleteProject` inside their transaction.

- [ ] **Step 4: Move `deleteProject` filesystem cleanup after DB commit**

Delete DB records inside `db.transaction()`. Only after commit succeeds, remove `.ship` directories.

- [ ] **Step 5: Make `blockStageViolation` atomic**

Wrap `endRun`, finding insert, event insert, and status update in one transaction.

- [ ] **Step 6: Make merge readiness persistence atomic**

Persist `mergeReadiness` and all `mergeBlockers` inside one transaction. Tests must simulate a blocker insert failure and prove no partial readiness row remains.

- [ ] **Step 7: Verify Stage 2**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/gate-service.test.ts server/services/project-service.test.ts server/services/pipeline-run-ledger-service.test.ts server/services/merge-readiness-service.test.ts
```

Expected: transaction tests prove no half-written approval, deletion, stage violation, or readiness state remains after injected failure.

## Stage 3: Central State Transition Guard

**Audit items:** HIGH-3 and remaining CRITICAL-2/CRITICAL-3 hardening.

**Files:**
- Create: `server/services/change-state-machine.ts`
- Modify: `server/services/pipeline-run-ledger-service.ts`
- Modify: stage services that currently duplicate `assertStatus`
- Test: `server/services/state-machine-enums.test.ts`
- Test: create `server/services/change-state-machine.test.ts`

- [ ] **Step 1: Define allowed transitions**

Create a single transition table from the states already listed in `server/types/enums.ts` and `docs/state-machine.md`.

Code shape:

```typescript
export function assertAllowedTransition(from: ChangeStatus, to: ChangeStatus): void {
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new ChangeStateTransitionError(from, to);
  }
}
```

- [ ] **Step 2: Replace direct status writes**

`setStatus` and `updateChangeStatus` must call the central guard unless an explicit `bypassForRepair` option is passed from a named repair-only path.

- [ ] **Step 3: Remove duplicated `assertStatus` copies**

Replace duplicated stage-local status assertions with imports from `change-state-machine.ts`.

- [ ] **Step 4: Verify Stage 3**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/change-state-machine.test.ts server/services/state-machine-enums.test.ts server/services/pipeline-routes.test.ts
```

Expected: illegal transitions reject with a typed error, valid pipeline paths continue passing, and generic PATCH cannot bypass the guard.

## Stage 4: DB Initialization, Migrations, and Indexes

**Audit items:** FATAL-1, FATAL-3, MEDIUM-1, MEDIUM-5.

**Files:**
- Modify: `server/db/index.ts`
- Modify: `server/db/migrate.ts`
- Modify: `server/db/schema.ts`
- Create: `server/db/migrations/00XX_query_indexes.sql`
- Test: `server/services/db-migrations.test.ts`

- [ ] **Step 1: Introduce lazy DB getter**

Export `getDb()` and keep `db` compatibility only if all imports can remain safe. Initialization must catch connection and migration failures and throw a typed `DatabaseUnavailableError`.

- [ ] **Step 2: Resolve DB and migration paths from module location**

Replace raw `process.cwd()` dependency with a helper that resolves from the repository root or an explicit `SHIP_DB_PATH` env var.

- [ ] **Step 3: Harden migration execution**

For each migration entry, record started/failed/applied state or execute through `SAVEPOINT` with clear recovery behavior. On failure, include migration tag and statement index in the error.

- [ ] **Step 4: Add query indexes**

Migration must include:

```sql
CREATE INDEX IF NOT EXISTS idx_events_change_id ON events(change_id);
CREATE INDEX IF NOT EXISTS idx_changes_project_id ON changes(project_id);
CREATE INDEX IF NOT EXISTS idx_findings_change_id ON findings(change_id);
CREATE INDEX IF NOT EXISTS idx_runs_change_id ON runs(change_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_change_id ON artifacts(change_id);
```

- [ ] **Step 5: Verify Stage 4**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/db-migrations.test.ts
npm test
```

Expected: migrations are idempotent, failed migrations produce recoverable diagnostics, and indexed queries remain compatible with existing schema.

## Stage 5: Process Lifecycle, Streaming, and Recovery

**Audit items:** HIGH-2, HIGH-4, HIGH-6, HIGH-7, MEDIUM-2, MEDIUM-4.

**Files:**
- Modify: `server/services/claude-engine.ts`
- Modify: `server/services/codex-engine.ts`
- Modify: `server/services/ai-engine-adapter.ts`
- Modify: `server/services/graph-runner.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/events/stream/route.ts`
- Test: `server/services/claude-engine.test.ts`
- Test: `server/services/codex-engine.test.ts`
- Test: create or update GraphRunner recovery tests

- [ ] **Step 1: Resolve Claude binary portably**

Use `process.env.CLAUDE_BIN`, package binary resolution, then `claude` on PATH. Do not hardcode `claude.exe`.

- [ ] **Step 2: Validate provider configuration before state mutation**

Before changing a pipeline stage to a running state, validate the selected engine has the required binary/API key/config and return a typed error before DB status changes.

- [ ] **Step 3: Wire AbortSignal through Claude subprocesses**

When the request or pipeline controller aborts, send SIGTERM, then SIGKILL after the configured grace period. Tests should use a fake long-running command.

- [ ] **Step 4: Add `runStreamed` timeout**

Wrap Codex streamed execution with `AbortController` and the same timeout strategy as non-streamed `run()`.

- [ ] **Step 5: Add SSE disconnect detection**

Use request `signal` where available. On abort, clear intervals and close the stream. Keep Stage 0 error handling intact.

- [ ] **Step 6: Add stuck-run recovery**

Add a watchdog command/service that detects changes stuck in active states without a live run heartbeat and moves them to `BLOCKED` with a finding/event explaining the timeout.

- [ ] **Step 7: Verify Stage 5**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/claude-engine.test.ts server/services/codex-engine.test.ts
npx tsx --test --test-concurrency=1 server/services/pipeline-service.test.ts server/services/pipeline-routes.test.ts
```

Expected: aborted subprocesses terminate, streamed Codex calls time out, SSE disconnects release timers, and stuck runs become diagnosable instead of permanent running states.

## Stage 6: Dynamic Require and PLAN_READY Gate Integration

**Audit items:** HIGH-1, HIGH-8.

**Files:**
- Create: `server/db/db-provider.ts`
- Modify: services that currently use dynamic `require()` for schema/db access
- Modify: `server/services/gate-service.ts`
- Modify: `server/services/pipeline-plan-stage-service.ts`
- Test: `server/services/gate-service.test.ts`
- Test: `server/services/pipeline-routes.test.ts`

- [ ] **Step 1: Create a DB provider module**

Export `getDb()` and test override hooks from one place. Remove repeated `createRequire(import.meta.url)` wrappers from service files.

- [ ] **Step 2: Replace dynamic schema requires**

Convert dynamic `require("../db/schema")` use to static imports or the provider module. Verify Next.js route imports still load.

- [ ] **Step 3: Add Plan approval to gate freshness checks**

Either add `plan` to `GateName` or add an equivalent gate authority check before `PLAN_READY` approval. It must validate `expectedGateVersion` and `sourceDbHash`.

- [ ] **Step 4: Verify Stage 6**

Run:

```bash
npx tsx --test --test-concurrency=1 server/services/gate-service.test.ts server/services/pipeline-routes.test.ts
npm run build
```

Expected: no dynamic-require runtime dependency remains in pipeline services, and stale Plan approval is rejected.

## Final Release Gate

- [ ] Run all focused tests listed in Stages 0-6.
- [ ] Run `npm test`.
- [ ] Run `npm run lint`.
- [ ] Run `npx tsc --noEmit`; if it still fails on pre-existing import-extension issues, file a separate cleanup task and include exact diagnostics.
- [ ] Run `npm run build`.
- [ ] Review `git diff --stat` and split commits by stage.
- [ ] Update `docs/system-blocker-audit-2026-07-06.md` only after each audit item is fixed, verified, and reviewed.

## Audit Item Coverage Matrix

| Audit item | Stage | Verification signal |
|---|---:|---|
| FATAL-1 DB init crash | 4 | Lazy init tests and typed DB unavailable error |
| FATAL-2 sync git hang | 0 | No audited sync command without timeout |
| FATAL-3 half migration | 4 | Migration failure/idempotency tests |
| FATAL-4 missing busy timeout | 0 | `busy_timeout = 5000` in production DB init |
| CRITICAL-1 multi-table writes | 2 | Transaction rollback tests |
| CRITICAL-2 arbitrary PATCH status | 0, 3 | PATCH rejected; central transition guard |
| CRITICAL-3 duplicate run | 1, 3 | CAS/unique running-run tests |
| CRITICAL-4 delete running states | 0 | Newly protected state deletion test |
| CRITICAL-5 event ID TOCTOU | 1 | UUID/atomic ID uniqueness test |
| CRITICAL-6 deleteProject transaction | 2 | Project delete rollback test |
| HIGH-1 dynamic require | 6 | Static imports/provider tests and build |
| HIGH-2 subprocess cleanup | 5 | Abort terminates subprocess test |
| HIGH-3 transition guard | 3 | Invalid transition rejection test |
| HIGH-4 SSE disconnect | 5 | Abort releases timers test |
| HIGH-5 SSE interval errors | 0 | Interval errors close stream without throwing |
| HIGH-6 GraphRunner recovery | 5 | Stuck run becomes blocked with event/finding |
| HIGH-7 Codex streamed timeout | 5 | Stream timeout abort test |
| HIGH-8 PLAN_READY gate | 6 | Stale plan approval rejected |
| MEDIUM-1 cwd path assumption | 4 | DB path resolution test |
| MEDIUM-2 claude.exe path | 5 | Portable binary resolution test |
| MEDIUM-3 deleteChangeRecords transaction | 2 | Change delete rollback test |
| MEDIUM-4 API key late failure | 5 | Engine config preflight test |
| MEDIUM-5 missing indexes | 4 | Migration includes expected indexes |
