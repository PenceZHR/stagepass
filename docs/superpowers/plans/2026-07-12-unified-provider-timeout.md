# Unified Provider Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every AI-backed stage default to a 30-minute provider timeout while retaining valid environment overrides.

**Architecture:** Add a small timeout-policy module that owns the shared default and strict environment parsing. Existing pipeline, PRD, context, and Review timeout readers consume it; the document-stage watchdog continues adding its cleanup grace.

**Tech Stack:** TypeScript, Node.js test runner, Next.js, pnpm.

---

### Task 1: Lock the timeout contract with failing tests

**Files:**
- Modify: `server/services/pipeline-service.test.ts`
- Modify: `server/services/context-init-service.test.ts`
- Modify: `server/services/prd-service.test.ts`

- [x] Change document, TestPlan, context, PRD, and Review default/fallback assertions to `1_800_000`.
- [x] Add/retain assertions that valid environment overrides still win and the document watchdog is greater than its provider timeout.
- [x] Run `pnpm test server/services/pipeline-service.test.ts server/services/context-init-service.test.ts server/services/prd-service.test.ts` and verify failure values expose the existing 300000/600000/900000 defaults.

### Task 2: Introduce the shared AI timeout policy

**Files:**
- Create: `server/services/ai-timeout-policy.ts`
- Create: `server/services/ai-timeout-policy.test.ts`

- [x] Export `DEFAULT_AI_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000` and a strict positive safe Node-timer environment resolver.
- [x] Test valid override, missing value, malformed value, zero, negative, decimal, unsafe integer, and Node timer overflow.
- [x] Run `pnpm test server/services/ai-timeout-policy.test.ts` and verify it passes.

### Task 3: Route every AI-stage default through the policy

**Files:**
- Modify: `server/services/pipeline-engine-service.ts`
- Modify: `server/services/context-init-service.ts`
- Modify: `server/services/prd-service.ts`

- [x] Replace document, TestPlan, Review, context, and PRD default constants with the shared 30-minute constant.
- [x] Preserve `CC_AI_DOCUMENT_STAGE_TIMEOUT_MS`, `CC_AI_TEST_PLAN_TIMEOUT_MS`, `CC_AI_REVIEW_TIMEOUT_MS`, `CC_AI_CONTEXT_TIMEOUT_MS`, and `CC_AI_PRD_TIMEOUT_MS` overrides through strict parsing.
- [x] Run the Task 1 and Task 2 test files and verify all pass.

### Task 4: Verify and activate

**Files:**
- Verify only: affected services and runtime logs.

- [x] Run the focused timeout and pipeline regression suite.
- [x] Run `pnpm run build` and require a zero exit code.
- [x] Stop the existing Terminal-launched supervisor and restart `cd <repo> && pnpm dev` in macOS Terminal.
- [x] Verify `/api/health` returns 200 and the new supervisor, Next, and worker process tree is healthy.

No commit is planned because the shared worktree already contains unrelated user changes.
