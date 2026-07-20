# Spec Agent Thread Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Spec Red and Blue provider calls from inheriting an oversized change-wide conversation.

**Architecture:** Reuse the existing `resumeThread: false` document-stage option for Red and omit `threadId` for the direct Blue engine call. All business context continues to come from the assembled prompt and DB-backed Spec artifacts.

**Tech Stack:** TypeScript, Node test runner, Claude provider adapter.

---

### Task 1: Prove both Spec units receive fresh threads

**Files:**
- Modify: `server/services/pipeline-service.test.ts`

- [ ] **Step 1: Write the failing regression test**

Seed `changes.codexThreadId` with `oversized-change-thread`, capture `input.threadId` for `spec` and `spec_critic`, run `runSpec`, and assert both captured values are `undefined`.

- [ ] **Step 2: Verify RED**

Run: `node --import tsx --test --test-name-pattern='runs Spec Red and Blue in fresh provider threads' server/services/pipeline-service.test.ts`

Expected: FAIL because both provider calls currently receive the seeded thread ID.

### Task 2: Isolate Red and Blue provider sessions

**Files:**
- Modify: `server/services/pipeline-service.ts`

- [ ] **Step 1: Disable Red thread resumption**

Set `resumeThread: false` in the Red `runDocumentStage` configuration used by `runSpec`.

- [ ] **Step 2: Disable Blue thread resumption**

Set the `threadId` passed by `runSpecCritic` to `undefined` instead of `change.codexThreadId`.

- [ ] **Step 3: Verify GREEN**

Run the focused command from Task 1 and expect the test to pass.

### Task 3: Verify integration and restart

**Files:**
- Verify: `server/services/pipeline-service.ts`
- Verify: `server/services/pipeline-service.test.ts`

- [ ] **Step 1: Run the complete pipeline service suite**

Run: `node --import tsx --test server/services/pipeline-service.test.ts`

Expected: all tests pass while the live worker is stopped.

- [ ] **Step 2: Run static and production verification**

Run: `npx tsc --noEmit`

Run: `npm run build`

Expected: both commands exit 0.

- [ ] **Step 3: Restart and check health**

Start `npm run dev`, then call `GET /api/health`. Expect `ok: true`, a healthy external worker, no crash loop, and no stale running jobs.
