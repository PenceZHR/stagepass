# Fix Iteration Limit 99 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the shared Fix iteration limit to 99 and recover CHG-004 at iteration 1 without deleting its existing artifacts.

**Architecture:** A single policy module owns the limit and error text. Both streamed and legacy Fix paths plus the status transition invariant consume that module; the existing action contract remains the entry point. Runtime state is changed only through the live SQLite database used by the backend, followed by a real Fix API request.

**Tech Stack:** TypeScript, Node test runner, Drizzle/SQLite, Next.js API, pipeline worker.

---

### Task 1: Prove the new boundary with a failing test

**Files:**
- Modify: `server/state-machine/transitions.test.ts`

- [x] Add assertions that entering `FIXING` with `fixIterations: 98` succeeds and with `fixIterations: 99` throws the canonical max-limit error.
- [x] Run `pnpm exec tsx --test server/state-machine/transitions.test.ts` and confirm the 98-case fails against the current hard-coded limit of 3.

### Task 2: Centralize the policy and update production gates

**Files:**
- Create: `server/state-machine/iteration-policy.ts`
- Modify: `server/state-machine/transitions.ts`
- Modify: `server/services/pipeline-build-stage-service.ts`
- Modify: `server/services/pipeline-service.ts`
- Modify: `docs/state-machine.md`
- Modify: `docs/data-model.md`

- [x] Export `MAX_FIX_ITERATIONS = 99` and `maxFixIterationsErrorMessage()` from the policy module.
- [x] Replace all three production checks and messages with the shared policy.
- [x] Update operator documentation to state the 99-iteration limit.

### Task 3: Verify code paths

**Files:**
- Test: `server/state-machine/transitions.test.ts`
- Test: `server/services/pipeline-build-stage-service.test.ts`
- Test: `server/services/pipeline-service.test.ts`

- [x] Run the focused state-machine and pipeline tests.
- [x] Run `git diff --check` and inspect only the intended files.

### Task 4: Recover CHG-004 and execute Fix

**Files:**
- Runtime only: `server/db/ship.db`

- [x] Update only CHG-004's `fix_iterations` from 3 to 1 using a transactional SQLite write.
- [x] Refresh the action contract through the API and queue `fix_blockers` with current gate/source hashes and an idempotency key.
- [x] Observe the worker job and verify it does not fail at the old max-3 guard.

### Task 5: Final verification

- [x] Verify CHG-004 counter, job status, run status, and worktree/artifact preservation.
- [x] Report any provider failure separately from iteration-limit behavior.
