# Spec Composite Run Lifecycle Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the shared Spec business run active across Red and Blue, then close it exactly once when the complete battle succeeds or fails.

**Architecture:** Add an explicit document-stage option that leaves a caller-supplied run open. `runSpec` opts into that mode for Red and becomes the single owner of the shared run's terminal transition; every other document stage keeps the existing default behavior.

**Tech Stack:** TypeScript, Node test runner, Drizzle ORM, SQLite.

---

### Task 1: Reproduce the Red-to-Blue lifecycle failure

**Files:**
- Modify: `server/services/pipeline-service.test.ts`

- [ ] **Step 1: Write the failing regression test**

Add a Spec test whose fake engine invokes `lifecycle.onStart` and `lifecycle.onExit` for both `spec` and `spec_critic`. At Blue start, read the reserved `runs` row and assert its status is `running`; after `runSpec` resolves, assert it is `completed`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test --test-name-pattern='keeps the shared Spec run active through Blue' server/services/pipeline-service.test.ts`

Expected: FAIL with a stale lease fence at Blue provider start because Red already ended the reserved run.

### Task 2: Move terminal ownership to the Spec orchestrator

**Files:**
- Modify: `server/services/pipeline-document-stage-runner-service.ts`
- Modify: `server/services/stage-orchestrator-service.ts`
- Modify: `server/services/pipeline-service.ts`

- [ ] **Step 1: Add an explicit deferred-completion option**

Add `deferRunCompletion?: boolean` to the document-stage config and `RunStageWithLedgerInput`. When true, `runStageWithLedger` returns after `execute` without ending the run or applying the success status; the default remains false.

- [ ] **Step 2: Make `runSpec` own completion**

Pass `deferRunCompletion: true` for the Red stage. After Blue and both reports succeed, call `endRun(round.runId, "Spec battle completed", true)` before setting `SPEC_READY`. In the ordinary error path, end the still-current run as failed before blocking the round. Keep `StaleLeaseFenceError` as a no-write escape path.

- [ ] **Step 3: Run the focused test and verify GREEN**

Run the command from Task 1.

Expected: PASS; Blue observes a running run and the final row is completed.

### Task 3: Cover failure semantics and verify regression scope

**Files:**
- Modify: `server/services/pipeline-service.test.ts`
- Test: `server/services/stage-orchestrator-service.test.ts` if present, otherwise the existing orchestrator coverage in `pipeline-service.test.ts`

- [ ] **Step 1: Add a Blue-failure assertion**

Extend the existing Blue provider failure test to assert the reserved run is `failed` and the round/change remain failed/blocked.

- [ ] **Step 2: Run focused suites**

Run: `node --import tsx --test server/services/pipeline-service.test.ts server/services/provider-run-lifecycle-service.test.ts`

Expected: all tests pass.

- [ ] **Step 3: Run static and production verification**

Run: `npx tsc --noEmit`

Run: `npm run build`

Expected: both commands exit 0.

- [ ] **Step 4: Inspect scope**

Run: `git diff --check`

Confirm the lifecycle fix is limited to the Spec orchestration, document-stage lifecycle option, and regression tests.
