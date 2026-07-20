# SQLite Single-Writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove SQLite write contention between Next polling/build workers and the pipeline worker without weakening real recovery or persistence.

**Architecture:** GET routes become pure snapshot readers. Recovery moves to the pipeline worker. Database import becomes side-effect free and migrations run explicitly under the dev supervisor before children start.

**Tech Stack:** Next.js Route Handlers, TypeScript, better-sqlite3 WAL, Drizzle ORM, Node test runner.

---

### Task 1: Lock-contention regression

**Files:**
- Modify: `server/services/stale-provider-run-recovery-service.test.ts`

- [ ] Add a test that holds `BEGIN IMMEDIATE` on a second real connection and calls the real phases GET repeatedly.
- [ ] Assert every response is 200 and contains no SQLite error details.
- [ ] Run the focused test and record the existing 503 red failure.

### Task 2: Pure read routes

**Files:**
- Modify: `app/api/projects/[id]/changes/[changeId]/phases/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/gate/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/events/route.ts`
- Modify: `app/api/projects/[id]/changes/[changeId]/events/stream/route.ts`
- Modify relevant route/service tests.

- [ ] Replace execute-on-read recovery with observation-only status.
- [ ] Split action refresh and artifact mirror inspection into pure-read and explicit-refresh functions.
- [ ] Prove GET/SSE paths contain no database write boundary.
- [ ] Run focused route and recovery tests until green.

### Task 3: Worker-owned recovery

**Files:**
- Modify: `scripts/pipeline-worker.ts`
- Modify: `server/services/pipeline-job-runner-service.test.ts` or a focused worker test.

- [ ] Add bounded recovery before lease polling and on an idle interval with single-flight protection.
- [ ] Verify stale runs still reconcile without a frontend request.
- [ ] Verify recovery errors are logged and do not stop job leasing.

### Task 4: Side-effect-free database import

**Files:**
- Modify: `server/db/index.ts`
- Modify: `server/db/migrate.ts`
- Modify: `scripts/dev-supervisor.ts`
- Add or modify focused DB lifecycle tests.

- [ ] Add an import-only child-process test that fails if default DB files are touched.
- [ ] Separate normal connection opening from migration execution.
- [ ] Add explicit migration bootstrap before supervisor children start.
- [ ] Preserve isolated test handles and explicit close behavior.
- [ ] Run DB migration, lifecycle, and Next route tests.

### Task 5: Diagnostics and runtime acceptance

**Files:**
- Modify: `server/db/write-boundary.ts`
- Modify: `server/db/sqlite-lock-retry.test.ts`

- [ ] Preserve and log extended SQLite result codes.
- [ ] Run focused tests, full tests, lint, and build.
- [ ] Restart via the terminal supervisor.
- [ ] Confirm process tree has one supervisor, one Next server, and one pipeline worker.
- [ ] Execute a real Spec run while polling phase APIs and inspect logs for `SQLITE_BUSY`, 503, WAL growth, and listener warnings.
