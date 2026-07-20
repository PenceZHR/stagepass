# PRD Queue and Spec Start Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent PRD AI queue receipts from corrupting React state and allow a locked PRD gate with status `pass` to atomically enqueue Spec work.

**Architecture:** Separate state-returning HTTP commands from asynchronous queue commands in `PrdBriefingRoom`. Centralize the successful gate-status vocabulary in a pure provider-authority predicate and reuse it at the enqueue fence.

**Tech Stack:** Next.js 16, React 19, TypeScript, Node test runner, Drizzle/SQLite.

---

### Task 1: Protect PRD briefing state from queue receipts

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/prd-briefing-room.tsx`
- Test: `app/projects/[id]/changes/[changeId]/prd-briefing-room.test.ts`

- [ ] **Step 1: Write the failing source-contract test**

Create a test that reads `prd-briefing-room.tsx`, isolates `requestCommandJson`, and asserts that it does not call `normalizeState` or `syncState`; also assert that `startAiJob` calls `requestCommandJson` while `saveIntent` calls `requestStateJson`.

- [ ] **Step 2: Verify the test fails**

Run: `node --import tsx --test 'app/projects/[id]/changes/[changeId]/prd-briefing-room.test.ts'`

Expected: FAIL because `requestCommandJson` and `requestStateJson` do not exist.

- [ ] **Step 3: Implement the minimal split**

Rename the current state-mutating helper to `requestStateJson`. Add `requestCommandJson` that performs `fetch`, parses JSON, throws on non-2xx, validates `{ accepted: true, jobId: string }`, and never calls `syncState`. Use it only in `startAiJob`.

- [ ] **Step 4: Verify the focused test passes**

Run the same Node test command and expect all assertions to pass.

### Task 2: Accept canonical `pass` gates at the provider fence

**Files:**
- Modify: `server/services/provider-action-authority-service.ts`
- Test: `server/services/provider-action-authority-service.test.ts`

- [ ] **Step 1: Write the failing predicate test**

Import `isPassingGateStatus` and assert that `pass`, `passed`, and `approved` return true while `pending` and `blocked` return false.

- [ ] **Step 2: Verify the test fails**

Run: `node --import tsx --test server/services/provider-action-authority-service.test.ts`

Expected: FAIL because `isPassingGateStatus` is not exported.

- [ ] **Step 3: Implement and use the predicate**

Export `isPassingGateStatus(status: string): boolean` and replace the inline `passed`/`approved` check in `evaluateProviderActionAuthority` with it.

- [ ] **Step 4: Verify the focused test passes**

Run the same Node test command and expect all assertions to pass.

### Task 3: Verify integration and scope

**Files:**
- Verify all files changed by Tasks 1 and 2.

- [ ] **Step 1: Run related regression suites**

Run both focused tests plus `server/services/pipeline-routes.test.ts` and `app/projects/[id]/changes/[changeId]/phase-review.test.ts`.

- [ ] **Step 2: Run static and production verification**

Run `npx tsc --noEmit` and `npm run build`.

- [ ] **Step 3: Inspect the final diff**

Use `git diff --check` and a path-limited `git diff` to confirm that only the two fixes and their tests were changed.
