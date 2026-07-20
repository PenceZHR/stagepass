# Module Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the current core-module bloat by turning large orchestration files into stable facades backed by focused domain services, while preserving current behavior, route contracts, action IDs, gate freshness semantics, and browser flow stability.

**Architecture:** This plan uses incremental facade extraction. Existing public imports stay valid first; implementation moves behind them only after characterization tests lock behavior. The refactor follows current project boundaries: `action-contract`, `preflight`, `stage-authority`, DB-first stage records, Build worktree facts, and frontend `PipelineActionContract` remain the primary contracts.

**Tech Stack:** Next.js App Router, TypeScript, Drizzle ORM, SQLite, `tsx --test`, React client components, local Git/worktree services.

---

## Context

Current bloat audit: `docs/module-decoupling-bloat-audit-2026-07-01.md`

Largest production files today:

- `server/services/pipeline-service.ts`: 3,011 lines
- `app/projects/[id]/changes/[changeId]/page.tsx`: 2,714 lines
- `server/services/build-workspace-service.ts`: 1,535 lines
- `server/services/plan-sandbox-service.ts`: 1,375 lines
- `server/services/action-contract-service.ts`: 1,338 lines
- `server/services/review-run-service.ts`: 1,079 lines
- `server/services/review-center-service.ts`: 1,063 lines
- `server/services/spec-battle-service.ts`: 1,016 lines
- `server/db/schema.ts`: 1,001 lines

This plan intentionally does not start with `schema.ts`. The highest risk is not schema size; it is executable behavior concentrated in `pipeline-service.ts`, `page.tsx`, and `action-contract-service.ts`.

## Non-Negotiable Constraints

- Keep existing public exports from `server/services/pipeline-service.ts` until all routes and tests migrate deliberately.
- Keep the action registry as the only source of action IDs. During extraction, callers may read it through either `action-contract-service.ts` facade exports or `action-contract-registry-service.ts`; do not duplicate action arrays.
- Do not relax `assertActionAllowed()` drift checks.
- Do not move Build adoption safety checks into route code.
- Do not make frontend invent business gate decisions. UI consumes action contracts.
- Do not change DB schema or migrations during service extraction unless a task explicitly says so.
- Do not delete tests to reduce line count. Tests move only after the production module split is stable.
- After each task, run the listed focused tests and `git diff --check`.

## Target Structure

```text
server/services/
  pipeline-service.ts                       # facade with legacy public exports
  pipeline-engine-service.ts                # engine factory, timeouts
  pipeline-run-ledger-service.ts            # runs/events/artifacts/change status
  pipeline-artifact-writer-service.ts       # artifact path and write helpers
  pipeline-document-stage-runner-service.ts # shared AI document stage runner

  action-contract-service.ts                # facade/aggregator public API
  action-contract-types.ts                  # shared contract and decision types
  action-contract-registry-service.ts       # ACTION_DEFINITIONS only
  action-contract-persistence-service.ts    # stage_actions persistence
  action-contract-common-policy.ts          # gateDecision, shared helpers
  action-contract-self-heal-service.ts      # legacy TestPlan and stuck QA self-heal
  action-contract-spec-policy.ts
  action-contract-plan-policy.ts
  action-contract-build-policy.ts
  action-contract-review-policy.ts
  action-contract-qa-policy.ts
  action-contract-merge-policy.ts

  build-types.ts
  build-path-safety-service.ts
  build-gate-service.ts
  build-workspace-service.ts                # facade for current Build API

app/projects/[id]/changes/[changeId]/
  page.tsx                                  # container only
  change-detail-types.ts
  change-phase-map.ts
  change-api-client.ts
  use-change-detail-state.ts
  use-change-polling.ts
  use-pipeline-actions.ts
  phase-rail.tsx
  gate-command-panel.tsx
  operational-phase-panel.tsx
  failed-run-banner.tsx
  event-stream-panel.tsx
  findings-panel.tsx
  artifacts-panel.tsx
  changed-files-panel.tsx
```

## Success Metrics

- `server/services/pipeline-service.ts` under 900 lines after Phase 4.
- `app/projects/[id]/changes/[changeId]/page.tsx` under 800 lines after Phase 5.
- `server/services/action-contract-service.ts` under 650 lines after Phase 3.
- No route contract regressions: all side-effect route preflight tests pass.
- Browser flow remains stable from current known final state through Retro page.
- No large-file split changes user-visible behavior by itself.

## Reviewer Revisions Applied

The review agent flagged several plan-level risks that would have caused behavior drift if an implementation agent followed the earlier draft literally. This version treats those as hard constraints:

- DB injection for action contracts must remain testable through existing test override behavior. Persistence extraction may not import the global `db` directly unless the facade still owns DB resolution and test injection.
- Pipeline timeout parsing must preserve current `Number.parseInt(..., 10)` and comparison semantics exactly.
- Pipeline artifact and violation helpers must keep current signatures and return types exactly.
- The document-stage runner extraction must preserve the existing `runDocumentStage(changeId, config): Promise<CodexRunResult>` contract first; no redesigned input/result object in the first extraction.
- Frontend tests that currently inspect `page.tsx` must migrate to the extracted modules in the same task that moves helpers.
- Frontend API extraction is split into smaller slices: read-only loaders, generic action dispatch, gate approval flows, then specialized Spec/Plan/PRD workflows.
- Action policy splitting happens one domain at a time after common types and shared policy helpers are extracted.

---

## Task 1: Lock Current Characterization Baseline

**Description:** Add a small characterization test file that pins the current module-split assumptions before moving code. This task should not refactor production code.

**Files:**
- Create: `server/services/module-decoupling-baseline.test.ts`
- Modify: none

**Acceptance Criteria:**
- [ ] Test asserts that `pipeline-service.ts`, `action-contract-service.ts`, and `page.tsx` still expose the public seams this plan depends on.
- [ ] Test asserts route tests continue to expect the current preflight and pipeline facades during the first extraction phase.
- [ ] Test can fail if someone removes the public action registry/facade source without adding the planned registry module.

- [ ] **Step 1: Create baseline test**

Create `server/services/module-decoupling-baseline.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf-8");
}

test("pipeline-service keeps legacy public facade exports during decoupling", () => {
  const source = read("server/services/pipeline-service.ts");
  for (const name of [
    "runIntake",
    "runSpec",
    "runTechSpec",
    "generatePlan",
    "approvePlan",
    "runTestPlan",
    "runPrdBriefingQuestions",
    "runPrdBriefingDraft",
    "runPrdBriefingFinalReview",
    "runImplement",
    "runImplementStreamed",
    "approveBuildAbsorb",
    "approveFixAbsorb",
    "runReview",
    "preflightReviewRun",
    "runCheck",
    "runFixStreamed",
    "recoverCurrentBuildRun",
    "rejectBuildRun",
    "runRelease",
    "runRetro",
  ]) {
    assert.match(source, new RegExp(`export async function ${name}\\\\b`));
  }
});

test("action-contract-service remains the action id registry facade", () => {
  const source = read("server/services/action-contract-service.ts");
  assert.match(source, /ACTION_DEFINITIONS/);
  assert.match(source, /export function getActions\(changeId: string\): PipelineActionContract\[\]/);
  assert.match(source, /export function persistActionContract\(/);
});

test("change detail page still consumes PipelineActionContract through local helpers", () => {
  const source = read("app/projects/[id]/changes/[changeId]/page.tsx");
  assert.match(source, /createPipelinePreflightPayload/);
  assert.match(source, /findPipelineAction/);
  assert.match(source, /pipelineActionDisabledReason/);
});

test("route layer still depends on preflight and pipeline facades during phase one", () => {
  const route = read("app/api/projects/[id]/changes/[changeId]/check/route.ts");
  assert.match(route, /from "@\/server\/services\/pipeline-service"/);
  assert.match(route, /from "@\/server\/services\/preflight-service"/);
  assert.match(route, /assertActionAllowed/);
});
```

- [ ] **Step 2: Run baseline test**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 server/services/module-decoupling-baseline.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run diff check**

Run:

```bash
git diff --check
```

Expected: no output.

---

## Task 2: Extract Pipeline Engine and Timeout Helpers

**Description:** Move engine factory and timeout helpers out of `pipeline-service.ts` without changing behavior.

**Files:**
- Create: `server/services/pipeline-engine-service.ts`
- Modify: `server/services/pipeline-service.ts`
- Test: `server/services/module-decoupling-baseline.test.ts`
- Test: `server/services/pipeline-service.test.ts`

**Acceptance Criteria:**
- [ ] `setPipelineEngineFactoryForTest`, `setDocumentStageTimeoutMsForTest`, `setReviewTimeoutMsForTest`, `resolveReviewTimeoutMs`, and pipeline engine lookup still work from `pipeline-service.ts`.
- [ ] `pipeline-service.ts` re-exports or delegates to the new engine service.
- [ ] Review timeout tests continue to pass.

- [ ] **Step 1: Create engine service**

Create `server/services/pipeline-engine-service.ts`:

```ts
import type { ICodexEngine } from "./codex-engine";

export type EngineProvider = "codex" | "claude";
export type EngineFactory = (provider: EngineProvider) => ICodexEngine | Promise<ICodexEngine>;

export const DEFAULT_DOCUMENT_STAGE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_BUILD_STREAM_START_TIMEOUT_MS = 30 * 1000;
export const DEFAULT_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;

let pipelineEngineFactory: EngineFactory | null = null;
let documentStageTimeoutMsForTest: number | null = null;
let reviewTimeoutMsForTest: number | null = null;

export function setPipelineEngineFactoryForTest(factory: EngineFactory | null): void {
  pipelineEngineFactory = factory;
}

export function setDocumentStageTimeoutMsForTest(timeoutMs: number | null): void {
  documentStageTimeoutMsForTest = timeoutMs;
}

export function documentStageTimeoutMs(): number {
  return documentStageTimeoutMsForTest ?? DEFAULT_DOCUMENT_STAGE_TIMEOUT_MS;
}

export function buildStreamStartTimeoutMs(): number {
  const raw = process.env.CC_AI_BUILD_STREAM_START_TIMEOUT_MS;
  if (!raw) return DEFAULT_BUILD_STREAM_START_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BUILD_STREAM_START_TIMEOUT_MS;
}

export function setReviewTimeoutMsForTest(timeoutMs: number | null): void {
  reviewTimeoutMsForTest = timeoutMs;
}

export function resolveReviewTimeoutMs(): number {
  if (reviewTimeoutMsForTest !== null) return reviewTimeoutMsForTest;
  const raw = process.env.CC_AI_REVIEW_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REVIEW_TIMEOUT_MS;
}

export async function getPipelineEngine(provider: EngineProvider): Promise<ICodexEngine> {
  if (pipelineEngineFactory) return pipelineEngineFactory(provider);
  const { getEngine } = await import("./codex-engine");
  return getEngine(provider);
}
```

- [ ] **Step 2: Update pipeline facade imports**

Modify `server/services/pipeline-service.ts`:

```ts
import {
  buildStreamStartTimeoutMs,
  documentStageTimeoutMs,
  getPipelineEngine,
  resolveReviewTimeoutMs,
  setDocumentStageTimeoutMsForTest,
  setPipelineEngineFactoryForTest,
  setReviewTimeoutMsForTest,
  type EngineProvider,
} from "./pipeline-engine-service";

export {
  resolveReviewTimeoutMs,
  setDocumentStageTimeoutMsForTest,
  setPipelineEngineFactoryForTest,
  setReviewTimeoutMsForTest,
  type EngineProvider,
};
```

Remove the duplicate local definitions from `pipeline-service.ts`.

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 --test-name-pattern "resolves Review timeout|aborted Review|Build startup timeout|pipeline-service keeps legacy" server/services/pipeline-service.test.ts server/services/module-decoupling-baseline.test.ts
```

Expected: all matched tests pass.

- [ ] **Step 4: Run diff check**

Run:

```bash
git diff --check
```

Expected: no output.

---

## Task 3: Extract Pipeline Run Ledger

**Description:** Move shared run/event/artifact/status helpers out of `pipeline-service.ts`. This reduces the central service without changing any route or stage behavior.

**Files:**
- Create: `server/services/pipeline-run-ledger-service.ts`
- Modify: `server/services/pipeline-service.ts`
- Test: `server/services/pipeline-service.test.ts`
- Test: `server/services/change-phase-service.test.ts`

**Acceptance Criteria:**
- [ ] `createRun`, `endRun`, `insertArtifact`, `writeRunArtifact`, `writeRunOnlyArtifact`, `setStatus`, and `blockStageViolation` behavior remains identical.
- [ ] `pipeline-service.ts` still controls the order of stage orchestration.
- [ ] Event and artifact rows are still created with the same IDs and paths.

- [ ] **Step 1: Create ledger service with extracted helpers**

Create `server/services/pipeline-run-ledger-service.ts` using the exact helper bodies currently in `pipeline-service.ts`.

The exported surface should be:

```ts
import type { RunPhase, ChangeStatus } from "../types";
import type { StageViolationResult } from "./stage-guard-service";

export function nextRunLedgerId(
  table: typeof import("../db/schema").runs | typeof import("../db/schema").events | typeof import("../db/schema").artifacts | typeof import("../db/schema").findings,
  prefix: string,
): string;

export function nowISO(): string;

export function changeDir(repoPath: string, changeId: string): string;

export function runArtifactDir(repoPath: string, changeId: string, runId: string): string;

export async function insertArtifact(
  changeId: string,
  runId: string,
  type: string,
  filePath: string,
): Promise<void>;

export async function writeRunArtifact(
  repoPath: string,
  changeId: string,
  runId: string,
  type: string,
  fileName: string,
  content: string,
): Promise<{ currentPath: string; runPath: string }>;

export async function writeRunOnlyArtifact(
  repoPath: string,
  changeId: string,
  runId: string,
  type: string,
  fileName: string,
  content: string,
): Promise<{ runPath: string }>;

export async function setStatus(
  changeId: string,
  status: ChangeStatus,
  blockedPhase?: string | null,
): Promise<void>;

export function createRun(changeId: string, phase: string): string;

export function endRun(runId: string, summary: string, success: boolean): void;

export async function blockStageViolation(
  changeId: string,
  runId: string,
  violation: StageViolationResult,
): Promise<never>;
```

Use existing imports from `pipeline-service.ts`; do not invent new ID, timestamp, artifact path, or exception behavior. `blockStageViolation()` must still end the run, insert the finding, and throw; callers must not continue after it.

- [ ] **Step 2: Delegate from pipeline-service**

In `pipeline-service.ts`, replace local helper definitions with imports from `pipeline-run-ledger-service.ts`.

Do not rename call sites except where TypeScript requires an import rename.

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 --test-name-pattern "runs streamed fixes|runs QA without deleting Review findings|marks QA failed instead|runs the complete plan-approved pipeline|phase" server/services/pipeline-service.test.ts server/services/change-phase-service.test.ts
```

Expected: all matched tests pass.

- [ ] **Step 4: Run baseline and diff check**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 server/services/module-decoupling-baseline.test.ts
git diff --check
```

Expected: pass and no diff whitespace errors.

---

## Task 4: Extract Action Contract Registry and Persistence

**Description:** Move pure action definitions and `stage_actions` persistence out of `action-contract-service.ts`. Do not split policy yet. Preserve existing DB override/test injection behavior.

**Files:**
- Create: `server/services/action-contract-types.ts`
- Create: `server/services/action-contract-registry-service.ts`
- Create: `server/services/action-contract-persistence-service.ts`
- Modify: `server/services/action-contract-service.ts`
- Test: `server/services/action-contract-service.test.ts`
- Test: `server/services/preflight-service.test.ts`
- Test: `server/services/pipeline-routes.test.ts`

**Acceptance Criteria:**
- [ ] Shared action contract types live in `action-contract-types.ts`; registry and persistence do not import the facade.
- [ ] `ACTION_DEFINITIONS` remains the unique registry of action IDs, now exported from registry service.
- [ ] `persistActionContract()` public export remains available from `action-contract-service.ts`.
- [ ] Existing `getActionContractDb()` / `setActionContractServiceDbForTest()` behavior remains the only DB resolution path used by persistence.
- [ ] Preflight still reads the same contracts and rejects stale gate/source hashes.

- [ ] **Step 1: Create shared action contract types**

Create `server/services/action-contract-types.ts`:

```ts
export interface PipelineActionContract {
  actionId: string;
  phase: "PRD" | "Spec" | "Plan" | "TestPlan" | "Build" | "Review" | "QA" | "Merge";
  label: string;
  enabled: boolean;
  reasonCode: string | null;
  reason: string | null;
  blockers: Array<{ id: string; severity: "P0" | "P1" | "P2"; title: string }>;
  gateVersion: string;
  sourceDbHash: string;
  requiresIdempotencyKey: boolean;
}

export type ContractPhase = PipelineActionContract["phase"];
export type Blocker = PipelineActionContract["blockers"][number];

export interface ActionDecision {
  enabled: boolean;
  reasonCode: string | null;
  reason: string | null;
  blockers: Blocker[];
  gateVersion?: string;
  sourceDbHash?: string;
}

export interface ActionDefinition {
  actionId: string;
  phase: ContractPhase;
  label: string;
  snapshotPhase?: string;
  requiredStatus?: string | string[];
}
```

In `action-contract-service.ts`, remove the local duplicate type/interface definitions and import them from this file. Re-export `PipelineActionContract` from `action-contract-service.ts` so existing callers keep working:

```ts
export type { PipelineActionContract } from "./action-contract-types";
```

- [ ] **Step 2: Create registry service**

Create `server/services/action-contract-registry-service.ts`:

```ts
import type { ActionDefinition } from "./action-contract-types";

export const ACTION_DEFINITIONS: ActionDefinition[] = [
  { actionId: "approve_intake", phase: "PRD", label: "批准 Intake", requiredStatus: "INTAKE_READY" },
  { actionId: "reject_intake", phase: "PRD", label: "打回 Intake", requiredStatus: "INTAKE_READY" },
  { actionId: "run_prd", phase: "PRD", label: "生成 PRD" },
  { actionId: "retry_prd", phase: "PRD", label: "重新生成 PRD" },
  { actionId: "approve_spec", phase: "Spec", label: "批准 Spec", requiredStatus: "SPEC_READY" },
  { actionId: "reject_spec", phase: "Spec", label: "打回 Spec", requiredStatus: "SPEC_READY" },
  { actionId: "run_spec", phase: "Spec", label: "开始 Spec 对抗", snapshotPhase: "PRD", requiredStatus: ["INTAKE_READY", "SPEC_READY"] },
  { actionId: "retry_spec", phase: "Spec", label: "重新 Spec 对抗", snapshotPhase: "PRD", requiredStatus: ["INTAKE_READY", "SPEC_READY"] },
  { actionId: "waive_spec_p1", phase: "Spec", label: "接受 Spec P1 风险" },
  { actionId: "run_tech_spec", phase: "Plan", label: "生成 TechSpec", snapshotPhase: "Spec", requiredStatus: ["SPEC_READY", "TECHSPEC_READY"] },
  { actionId: "retry_tech_spec", phase: "Plan", label: "重新生成 TechSpec", snapshotPhase: "Spec", requiredStatus: ["SPEC_READY", "TECHSPEC_READY"] },
  {
    actionId: "approve_tech_spec",
    phase: "Plan",
    label: "批准 TechSpec",
    snapshotPhase: "TechSpec",
    requiredStatus: "TECHSPEC_READY",
  },
  {
    actionId: "reject_tech_spec",
    phase: "Plan",
    label: "打回 TechSpec",
    snapshotPhase: "TechSpec",
    requiredStatus: "TECHSPEC_READY",
  },
  { actionId: "approve_plan", phase: "Plan", label: "批准作战计划", requiredStatus: "PLAN_READY" },
  { actionId: "run_plan", phase: "Plan", label: "生成作战计划", snapshotPhase: "TechSpec", requiredStatus: ["TECHSPEC_READY", "PLAN_READY"] },
  { actionId: "retry_plan", phase: "Plan", label: "重新生成作战计划", snapshotPhase: "TechSpec", requiredStatus: ["TECHSPEC_READY", "PLAN_READY"] },
  { actionId: "regenerate_plan_report", phase: "Plan", label: "刷新 Plan 战报" },
  { actionId: "waive_plan_p1", phase: "Plan", label: "接受 Plan P1 风险" },
  { actionId: "run_test_plan", phase: "TestPlan", label: "执行测试计划", snapshotPhase: "Plan", requiredStatus: "PLAN_APPROVED" },
  { actionId: "retry_test_plan", phase: "TestPlan", label: "重新执行测试计划", snapshotPhase: "Plan", requiredStatus: "PLAN_APPROVED" },
  { actionId: "run_build", phase: "Build", label: "开始 Build", snapshotPhase: "TestPlan", requiredStatus: ["PLAN_APPROVED", "TESTPLAN_DONE"] },
  { actionId: "retry_build", phase: "Build", label: "重新开始 Build", snapshotPhase: "TestPlan", requiredStatus: ["PLAN_APPROVED", "TESTPLAN_DONE"] },
  { actionId: "adopt_build", phase: "Build", label: "收编 Build" },
  { actionId: "adopt_fix", phase: "Build", label: "收编 Fix" },
  { actionId: "reject_build", phase: "Build", label: "拒绝本轮施工" },
  { actionId: "run_review", phase: "Review", label: "开始反方审查" },
  { actionId: "retry_review", phase: "Review", label: "重新反方审查" },
  { actionId: "fix_blockers", phase: "Review", label: "修复阻断项" },
  { actionId: "waive_review_p1", phase: "Review", label: "接受 Review P1 风险" },
  { actionId: "recompute_report", phase: "Review", label: "重新结算战报" },
  { actionId: "rebuild_mirror", phase: "Review", label: "重建镜像" },
  { actionId: "stop_change", phase: "Review", label: "终止 Change" },
  { actionId: "enter_qa", phase: "Review", label: "进入 QA" },
  { actionId: "run_qa", phase: "QA", label: "执行 QA" },
  { actionId: "retry_qa", phase: "QA", label: "重新执行 QA" },
  { actionId: "approve_merge", phase: "Merge", label: "批准 Merge", requiredStatus: "MERGE_READY" },
  { actionId: "reject_merge", phase: "Merge", label: "打回 Merge", requiredStatus: "MERGE_READY" },
  { actionId: "merge", phase: "Merge", label: "合并", requiredStatus: "MERGE_READY" },
];
```

- [ ] **Step 3: Create persistence service**

Create `server/services/action-contract-persistence-service.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { stageActions } from "../db/schema";
import type { PipelineActionContract } from "./action-contract-types";

type ActionContractDb = typeof import("../db/index").db;

export function persistActionContract(
  db: ActionContractDb,
  changeId: string,
  action: PipelineActionContract,
  computedAt: string,
): void {
  const id = actionAuditId(changeId, action.phase, action.actionId);
  const existing = db
    .select()
    .from(stageActions)
    .where(
      and(
        eq(stageActions.changeId, changeId),
        eq(stageActions.phase, action.phase),
        eq(stageActions.actionId, action.actionId),
      ),
    )
    .get();

  const values = {
    changeId,
    phase: action.phase,
    actionId: action.actionId,
    enabled: action.enabled ? 1 : 0,
    reasonCode: action.reasonCode,
    reason: action.reason,
    blockersJson: JSON.stringify(action.blockers),
    gateVersion: action.gateVersion,
    sourceDbHash: action.sourceDbHash,
    requiresIdempotencyKey: action.requiresIdempotencyKey ? 1 : 0,
    computedAt,
  };

  if (existing) {
    db.update(stageActions).set(values).where(eq(stageActions.id, existing.id)).run();
    return;
  }

  db.insert(stageActions).values({ id, ...values }).run();
}
```

Move the existing `actionAuditId(changeId, phase, actionId)` helper into this persistence service and export it only if a test needs to assert exact IDs. Do not replace it with `${changeId}:${actionId}`; the persisted IDs must remain compatible with existing rows and tests.

- [ ] **Step 4: Keep facade exports**

Modify `action-contract-service.ts`:

```ts
import {
  ACTION_DEFINITIONS,
} from "./action-contract-registry-service";
import type { ActionDecision, ActionDefinition, ContractPhase, PipelineActionContract } from "./action-contract-types";
import { persistActionContract as persistActionContractRow } from "./action-contract-persistence-service";

export function persistActionContract(
  changeId: string,
  action: PipelineActionContract,
  computedAt = nowISO(),
): void {
  persistActionContractRow(getActionContractDb(), changeId, action, computedAt);
}
```

Then update internal `getActions()` to call the facade or persistence import consistently.

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 server/services/action-contract-service.test.ts server/services/preflight-service.test.ts server/services/pipeline-routes.test.ts server/services/module-decoupling-baseline.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Run diff check**

Run:

```bash
git diff --check
```

Expected: no output.

---

## Task 5: Extract Action Contract Self-Heal Service

**Description:** Move mutation-heavy self-heal logic out of policy decisions. This makes `getActions()` easier to reason about.

**Files:**
- Create: `server/services/action-contract-self-heal-service.ts`
- Modify: `server/services/action-contract-service.ts`
- Test: `server/services/action-contract-service.test.ts`

**Acceptance Criteria:**
- [ ] Legacy TestPlan approval self-heal remains idempotent.
- [ ] Stuck QA `CHECKING` self-heal remains idempotent and does not affect real running checks.
- [ ] Policy functions do not directly update QA run or change status.

- [ ] **Step 1: Create self-heal service**

Create `server/services/action-contract-self-heal-service.ts` with these exact exports:

```ts
import type { changes } from "../db/schema";
import type { ActionDecision } from "./action-contract-types";

export function selfHealLegacyTestPlanApprovalForBuild(
  changeId: string,
  changeStatus: string,
  current: ActionDecision,
): ActionDecision {
  // Move the current body here exactly.
  // Preserve existing DB writes, reason codes, and returned ActionDecision.
}

export function selfHealStuckCheckingQa(
  change: typeof changes.$inferSelect,
): typeof changes.$inferSelect {
  // Move the current body here exactly.
  // Preserve the running local_check guard.
}
```

When implementing, copy the exact existing bodies and imports from `action-contract-service.ts`.

- [ ] **Step 2: Replace local implementations**

In `action-contract-service.ts`, import:

```ts
import {
  selfHealLegacyTestPlanApprovalForBuild,
  selfHealStuckCheckingQa,
} from "./action-contract-self-heal-service";
```

Remove the local self-heal function bodies.

- [ ] **Step 3: Run self-heal focused tests**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 --test-name-pattern "self-heals legacy TestPlan|self-heals stuck CHECKING|does not self-heal CHECKING" server/services/action-contract-service.test.ts
```

Expected: all matched tests pass.

- [ ] **Step 4: Run diff check**

Run:

```bash
git diff --check
```

Expected: no output.

---

## Task 6: Extract Frontend Phase Map and Status Utilities

**Description:** Move pure frontend status mapping and failed-run summary helpers out of `page.tsx`.

**Files:**
- Create: `app/projects/[id]/changes/[changeId]/change-detail-types.ts`
- Create: `app/projects/[id]/changes/[changeId]/change-phase-map.ts`
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Test: `app/projects/[id]/changes/[changeId]/phase-review.test.ts`

**Acceptance Criteria:**
- [ ] `PHASES`, status-to-phase mapping, default phase selection, failed summary sanitization, and parent polling predicate are exported from `change-phase-map.ts`.
- [ ] `page.tsx` no longer defines these pure helpers inline.
- [ ] `phase-review.test.ts` is updated to import the extracted pure helpers from `change-phase-map.ts` instead of reading inline definitions from `page.tsx`.
- [ ] `RETRO_PENDING` remains non-running without active run.

- [ ] **Step 1: Create types file**

Create `app/projects/[id]/changes/[changeId]/change-detail-types.ts`:

```ts
import type { PipelineActionContract } from "./pipeline-action-contract";
import type { PlanSandboxState } from "./plan-sandbox-types";
import type { PrdBriefingState } from "./prd-briefing-types";
import type { ReviewCenterResponse } from "./review-report-center";
import type { SpecBattleState } from "./spec-battle-types";

export interface ChangeDetail {
  id: string;
  projectId: string;
  title: string;
  status: string;
  provider?: string;
  codexThreadId: string | null;
  fixIterations: number;
  blockedPhase?: string | null;
  reworkFromPhase?: string | null;
  gateState?: string | null;
  gitBranch?: string | null;
  createdAt: string;
  updatedAt: string;
  changedFiles?: string[];
  findingsSummary?: { open: number; total: number };
  latestRun?: { id: string; phase: string; status: string; summary?: string | null } | null;
  testPlanCompleted?: boolean;
  artifactCount?: number;
}

export type ReviewPhase =
  | "Intake"
  | "Spec"
  | "TechSpec"
  | "Plan"
  | "TestPlan"
  | "Build"
  | "Review"
  | "Check"
  | "Fix"
  | "Merge"
  | "Retro";

export interface ChangeDetailAuxiliaryState {
  gateBusy: boolean;
  running: boolean;
  specBattleState: SpecBattleState | null;
  planSandboxState: PlanSandboxState | null;
  prdBriefingState: PrdBriefingState | null;
  reviewCenterState: ReviewCenterResponse | null;
  actions: PipelineActionContract[];
}
```

Move existing compatible interfaces from `page.tsx` into this file. Do not change field names.

- [ ] **Step 2: Create phase map file**

Create `app/projects/[id]/changes/[changeId]/change-phase-map.ts` and move these existing functions/constants:

```ts
export const PHASES = [/* existing PHASES array */] as const;
export function getCurrentPhase(status: string): PhaseName { /* existing body */ }
export function toReviewPhase(phase: PhaseName): ReviewPhase | null { /* existing body */ }
export function getDefaultReviewPhase(status: string): ReviewPhase { /* existing body */ }
export function getReviewPhaseForRunPhase(phase?: string | null): ReviewPhase | null { /* existing body */ }
export function getDefaultReviewPhaseForChange(change: ChangeDetail): ReviewPhase { /* existing body */ }
export function hasFailedBuildRun(change: ChangeDetail): boolean { /* existing body */ }
export function isBuildAwaitingHuman(change: ChangeDetail): boolean { /* existing body */ }
export function visibleChangeStatus(change: ChangeDetail): string { /* existing body */ }
export function shouldPollChangeDetailParent(input: { /* existing input */ }): boolean { /* existing body */ }
export function summarizeFailedRunForBanner(run: ChangeDetail["latestRun"]): string { /* existing body */ }
```

Copy the exact existing bodies from `page.tsx`.

- [ ] **Step 3: Import helpers in page**

Modify `page.tsx`:

```ts
import type { ChangeDetail, ReviewPhase } from "./change-detail-types";
import {
  PHASES,
  getCurrentPhase,
  getDefaultReviewPhaseForChange,
  getReviewPhaseForRunPhase,
  shouldPollChangeDetailParent,
  summarizeFailedRunForBanner,
  visibleChangeStatus,
} from "./change-phase-map";
```

Remove duplicated local helper definitions from `page.tsx`.

- [ ] **Step 4: Migrate helper tests**

Update `app/projects/[id]/changes/[changeId]/phase-review.test.ts` so tests that currently parse/read `page.tsx` instead import and exercise:

```ts
import {
  getCurrentPhase,
  getDefaultReviewPhaseForChange,
  getReviewPhaseForRunPhase,
  shouldPollChangeDetailParent,
  summarizeFailedRunForBanner,
  visibleChangeStatus,
} from "./change-phase-map";
```

Do not weaken assertions while moving them. Any assertion that was tied to an inline implementation should become a behavioral assertion on the exported helper.

- [ ] **Step 5: Run UI tests**

Run:

```bash
pnpm exec tsx app/projects/\[id\]/changes/\[changeId\]/phase-review.test.ts
```

Expected: 37 or more tests pass.

- [ ] **Step 6: Run diff check**

Run:

```bash
git diff --check
```

Expected: no output.

---

## Task 7: Extract Frontend Read-Only API Client

**Description:** Move read-only loaders out of `page.tsx` first. Do not move action dispatch in this task.

**Files:**
- Create: `app/projects/[id]/changes/[changeId]/gate-types.ts`
- Create: `app/projects/[id]/changes/[changeId]/change-api-client.ts`
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Test: `app/projects/[id]/changes/[changeId]/phase-review.test.ts`

**Acceptance Criteria:**
- [ ] Gate DTOs move from `page.tsx` to `gate-types.ts`.
- [ ] Read-only Change detail API paths are centralized in `change-api-client.ts`.
- [ ] `page.tsx` still owns action dispatch after this task.
- [ ] No action endpoint, preflight payload, approve/reject, or gate mutation behavior changes in this task.

- [ ] **Step 1: Create gate type file**

Create `app/projects/[id]/changes/[changeId]/gate-types.ts`:

```ts
import type { PipelineActionContract } from "./pipeline-action-contract";
import type { SpecBattleGateState } from "./spec-battle-types";

export type GateName = "intake" | "spec" | "tech_spec" | "merge";

export interface MergeChecks {
  qaPassed: boolean;
  reviewPassed: boolean;
  docsComplete: boolean;
  requirementGapsPassed?: boolean;
  mergeBlockingRequirementGaps?: number;
  canMerge: boolean;
  missing: string[];
}

export interface GateStatus {
  atGate: boolean;
  gate: GateName | null;
  status: string;
  pendingArtifact: string | null;
  actions?: PipelineActionContract[];
  mergeChecks?: MergeChecks;
  specBattle?: SpecBattleGateState;
}
```

Remove `GateName`, `MergeChecks`, and `GateStatus` from `page.tsx` after importing them.

- [ ] **Step 2: Create API client**

Create `change-api-client.ts`:

```ts
import type { ChangeDetail } from "./change-detail-types";
import type { GateStatus } from "./gate-types";
import type { PlanSandboxState } from "./plan-sandbox-types";
import type { PrdBriefingState } from "./prd-briefing-types";
import type { ReviewCenterResponse } from "./review-report-center";
import type { SpecBattleState } from "./spec-battle-types";

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof data.error === "string" ? data.error : fallback;
    throw new Error(message);
  }
  return data as T;
}

export function changeApi(projectId: string, changeId: string) {
  const base = `/api/projects/${projectId}/changes/${changeId}`;
  return {
    getChange: async () => readJson<ChangeDetail>(await fetch(base), "Change not found"),
    getGate: async () => readJson<GateStatus>(await fetch(`${base}/gate`), "Failed to load gate"),
    getSpecBattle: async () => readJson<SpecBattleState>(await fetch(`${base}/spec-battle`), "Failed to load spec battle"),
    getPlanSandbox: async () => readJson<PlanSandboxState>(await fetch(`${base}/plan-sandbox`), "Failed to load Plan sandbox"),
    getPrdBriefing: async () => readJson<PrdBriefingState>(await fetch(`${base}/prd-briefing`), "Failed to load PRD briefing"),
    getReviewCenter: async () => readJson<ReviewCenterResponse>(await fetch(`${base}/review-center`), "Failed to load Review center"),
    deleteChange: async () =>
      readJson<unknown>(await fetch(base, { method: "DELETE" }), "删除失败"),
  };
}
```

- [ ] **Step 3: Use read-only client in page**

Replace loader functions in `page.tsx` with `changeApi(projectId, changeId).getChange()`, `.getGate()`, `.getSpecBattle()`, `.getPlanSandbox()`, `.getPrdBriefing()`, and `.getReviewCenter()`.

Do not move `ACTION_ENDPOINTS` or `handleAction()` yet.

- [ ] **Step 4: Run UI tests**

Run:

```bash
pnpm exec tsx app/projects/\[id\]/changes/\[changeId\]/phase-review.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Browser smoke**

If the dev server is running, open:

```text
http://localhost:3000/projects/PRJ-003/changes/CHG-001
```

Expected: page loads, current status displays, phase rail renders.

---

## Task 7A: Extract Generic Frontend Action Dispatch

**Description:** Move generic pipeline action endpoint mapping and preflight payload dispatch out of `page.tsx`. Keep gate approval flows and specialized Spec/Plan/PRD workflows in place.

**Files:**
- Create: `app/projects/[id]/changes/[changeId]/use-pipeline-actions.ts`
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Test: `app/projects/[id]/changes/[changeId]/phase-review.test.ts`

**Acceptance Criteria:**
- [ ] `ACTION_ENDPOINTS` and generic `handleAction(actionId)` live in `use-pipeline-actions.ts`.
- [ ] The hook still sends `createPipelinePreflightPayload(contractAction)` for every generic pipeline action.
- [ ] Specialized flows such as Spec Battle operations, Plan Sandbox operations, PRD briefing operations, and gate approval/rejection remain in `page.tsx` or their existing components.

- [ ] **Step 1: Create action hook**

Create `use-pipeline-actions.ts` by moving the current `ACTION_ENDPOINTS`, disabled-reason check, `running`, `actionError`, and generic dispatch body from `page.tsx`. Preserve endpoint names exactly.

- [ ] **Step 2: Use hook in page**

Replace only generic action dispatch in `page.tsx`. Preserve refresh behavior by passing a callback that reloads change, gate, SpecBattle, PlanSandbox, PRD Briefing, and ReviewCenter.

- [ ] **Step 3: Run UI tests**

Run:

```bash
pnpm exec tsx app/projects/\[id\]/changes/\[changeId\]/phase-review.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Browser smoke**

If the dev server is running, open:

```text
http://localhost:3000/projects/PRJ-003/changes/CHG-001
```

Expected: page loads, current status displays, phase rail renders.

---

## Task 8: Extract Build Types and Gate Logic

**Description:** Reduce `build-workspace-service.ts` by extracting pure types and gate evaluation first.

**Files:**
- Create: `server/services/build-types.ts`
- Create: `server/services/build-gate-service.ts`
- Modify: `server/services/build-workspace-service.ts`
- Test: `server/services/build-workspace-service.test.ts`
- Test: `server/services/build-run-record-service.test.ts`

**Acceptance Criteria:**
- [ ] `BuildRunFile`, `BuildRunStatus`, and related interfaces live in `build-types.ts`.
- [ ] `evaluateBuildGate()` and deviation helpers live in `build-gate-service.ts`.
- [ ] Existing imports from `build-workspace-service.ts` still work during migration via re-export.

- [ ] **Step 1: Create build types**

Create `server/services/build-types.ts` and move current type/interface declarations:

```ts
import type { PolicyScope, WorkspaceMutation } from "./stage-guard-service";

export type BuildRunStatus =
  | "created"
  | "running"
  | "gate_blocked"
  | "awaiting_human"
  | "approved_for_absorb"
  | "audit_ready"
  | "adopted"
  | "rejected"
  | "failed";

export interface BuildRunFile {
  changeId: string;
  runNumber: number;
  status: BuildRunStatus;
  purpose?: "build" | "fix";
  baseHeadSha?: string | null;
  baseCommit: string | null;
  workspacePath: string;
  branchName: string;
  expectedFiles: string[];
  forbiddenFiles: string[];
  changedFiles: string[];
  deviations: BuildDeviation[];
  blockers: string[];
  patchPath: string | null;
  patchSha256: string | null;
  patchHash?: string | null;
  changedFilesHash?: string | null;
  designSourceDbHash?: string | null;
  adoptedHeadSha?: string | null;
  adoptionDecisionId?: string | null;
  approvalPath: string | null;
  diffPath: string | null;
  auditPath: string | null;
  reportPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuildPatchApprovalFile {
  changeId: string;
  runNumber: number;
  baseCommit: string;
  patchPath: string;
  patchSha256: string;
  approvedAt: string;
}

export type BuildDeviationReason =
  | "outside_expected_files"
  | "dependency"
  | "lockfile"
  | "migration"
  | "generated_file";

export type BuildDeviationSeverityHint = "P1" | "P2";

export interface BuildDeviation {
  file: string;
  reason: BuildDeviationReason;
  severityHint: BuildDeviationSeverityHint;
}

export interface BuildPlanScope {
  expectedFiles?: string[];
  allowedFiles?: string[];
  forbiddenFiles?: string[];
}

export interface BuildGateInput {
  mutations: WorkspaceMutation[];
  plan: BuildPlanScope;
  policy: PolicyScope;
}

export interface BuildGateResult {
  blocked: boolean;
  blockingFiles: string[];
  deviations: BuildDeviation[];
}
```

- [ ] **Step 2: Create build gate service**

Create `server/services/build-gate-service.ts` and move:

```ts
export function evaluateBuildGate(input: BuildGateInput): BuildGateResult {
  // Existing body from build-workspace-service.ts
}
```

Also move helper functions used only by `evaluateBuildGate`: `matchesAnyPattern`, `isShipArtifact`, `hasPathEscape`, `deviationReason`, `severityHint`, `uniqueDeviations`.

- [ ] **Step 3: Re-export from build workspace facade**

In `build-workspace-service.ts`:

```ts
export type {
  BuildRunStatus,
  BuildRunFile,
  BuildPatchApprovalFile,
  BuildDeviationReason,
  BuildDeviationSeverityHint,
  BuildDeviation,
  BuildPlanScope,
  BuildGateInput,
  BuildGateResult,
} from "./build-types";
export { evaluateBuildGate } from "./build-gate-service";
```

Remove duplicate local type and gate definitions.

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 server/services/build-workspace-service.test.ts server/services/build-run-record-service.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run diff check**

Run:

```bash
git diff --check
```

Expected: no output.

---

## Task 9: Extract Pipeline Document Stage Runner

**Description:** Move the existing common AI document-stage execution out of `pipeline-service.ts` without redesigning its API. Leave phase-specific persistence and public stage functions in `pipeline-service.ts`.

**Files:**
- Create: `server/services/pipeline-document-stage-runner-service.ts`
- Modify: `server/services/pipeline-service.ts`
- Test: `server/services/pipeline-service.test.ts`

**Acceptance Criteria:**
- [ ] Shared timeout, prompt assembly, engine run, artifact write, and stage guard flow moves to a runner service.
- [ ] `runIntake`, `runSpec`, `generatePlan`, `runTestPlan`, and `runRetro` still return identical `CodexRunResult` shapes.
- [ ] The extracted runner keeps the current `runDocumentStage(changeId: string, config: DocumentStageConfig): Promise<CodexRunResult>` shape.
- [ ] Spec structured output failure behavior remains unchanged.

- [ ] **Step 1: Create runner interface**

Create `server/services/pipeline-document-stage-runner-service.ts` by moving the current `DocumentStageConfig` type and `runDocumentStage()` function body exactly:

```ts
import type { CodexRunResult } from "./codex-engine";
import type { PromptPhase } from "./prompt-service";
import type { ChangeStatus, RunPhase } from "../types";

export interface DocumentStageConfig {
  phase: RunPhase;
  promptPhase: PromptPhase;
  allowedStatuses: ChangeStatus[];
  runningStatus: ChangeStatus;
  successStatus: ChangeStatus;
  failureStatus: ChangeStatus;
  artifactType: string;
  artifactFileName: string;
  successSummary: string;
  additionalPromptFileName?: string;
  outputSchema?: Record<string, unknown>;
  afterSuccessfulResult?: (input: {
    changeId: string;
    project: NonNullable<ReturnType<typeof getProject>>;
    runId: string;
    result: CodexRunResult;
  }) => Promise<{ skipDefaultArtifactWrite?: boolean } | void>;
}

export async function runDocumentStage(
  changeId: string,
  config: DocumentStageConfig,
): Promise<CodexRunResult> {
  // Move the current runDocumentStage body here exactly.
  // Preserve run creation, status updates, thread ID updates, afterSuccessfulResult,
  // artifact writes, stage violation blocking, and final endRun behavior.
}
```

Also move or import the existing `getProject` dependency required by the `afterSuccessfulResult` callback type. The key requirement is zero call-site contract change in the first extraction: copy the current local interface verbatim from `pipeline-service.ts` at implementation time.

- [ ] **Step 2: Replace local runner**

In `pipeline-service.ts`, remove the local `runDocumentStage` function and import the new one.

- [ ] **Step 3: Run document-stage tests**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 --test-name-pattern "runIntake|runSpec|runTechSpec|runTestPlan|runRetro|structured JSON|timed out" server/services/pipeline-service.test.ts
```

Expected: all matched tests pass.

---

## Task 10: Extract Action Contract Common Policy Helpers

**Description:** Create the shared policy helper layer before moving any domain decisions. This prevents each domain policy from re-implementing blockers, gate decisions, or reason helpers.

**Files:**
- Create: `server/services/action-contract-common-policy.ts`
- Modify: `server/services/action-contract-service.ts`
- Test: `server/services/action-contract-service.test.ts`
- Test: `server/services/preflight-service.test.ts`

**Acceptance Criteria:**
- [ ] `gateDecision()`, blocker normalization, phase reason prefix, and shared ActionDecision helpers move to `action-contract-common-policy.ts`.
- [ ] `action-contract-service.ts` still owns `decideAction()`, `getActions()`, and persistence.
- [ ] No domain decision logic moves in this task.

- [ ] **Step 1: Create common policy module**

Create `action-contract-common-policy.ts` and move shared pure helpers from `action-contract-service.ts`:

```ts
import type { ActionDecision, Blocker, ContractPhase } from "./action-contract-types";
import type { StageAuthoritySnapshot } from "./stage-authority-service";

export function phaseReasonPrefix(phase: ContractPhase): string {
  // Move current body.
}

export function normalizeSeverity(value: unknown): Blocker["severity"] {
  // Move current body.
}

export function normalizeBlockers(raw: unknown): Blocker[] {
  // Move current body.
}

export function gateDecision(phase: ContractPhase, snapshot: StageAuthoritySnapshot): ActionDecision {
  // Move current body.
}
```

- [ ] **Step 2: Import helpers in aggregator**

Modify `action-contract-service.ts` to import those helpers. Keep all domain decision functions in place.

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 server/services/action-contract-service.test.ts server/services/preflight-service.test.ts
```

Expected: all tests pass.

---

## Task 10A: Extract Build Action Policy

**Description:** Move only Build action decisions out of `action-contract-service.ts`.

**Files:**
- Create: `server/services/action-contract-build-policy.ts`
- Modify: `server/services/action-contract-service.ts`
- Test: `server/services/action-contract-service.test.ts`
- Test: `server/services/preflight-service.test.ts`

**Acceptance Criteria:**
- [ ] Build decision functions are imported from `action-contract-build-policy.ts`.
- [ ] Build policy does not call `persistActionContract()`.
- [ ] `getActions()` remains the only aggregator/persistence caller.

- [ ] **Step 1: Extract Build policy**

Create `action-contract-build-policy.ts`:

```ts
import type { ActionDecision } from "./action-contract-types";

export function adoptBuildRunDecision(changeId: string): ActionDecision {
  // Move current body.
}

export function rejectBuildRunDecision(changeId: string): ActionDecision {
  // Move current body.
}

export function reviewBuildAdoptionDecision(changeId: string, current: ActionDecision): ActionDecision {
  // Move current body.
}
```

Import `ActionDecision` from `action-contract-types.ts` and shared helpers from `action-contract-common-policy.ts`.

- [ ] **Step 2: Wire imports in aggregator**

Modify `decideAction()` in `action-contract-service.ts` to call imported Build policy functions for Build action IDs only.

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 --test-name-pattern "Build|adopt|reject|preflight" server/services/action-contract-service.test.ts server/services/preflight-service.test.ts
```

Expected: all matched tests pass.

---

## Task 10B: Extract Review Action Policy

**Description:** Move only Review action decisions out of `action-contract-service.ts`.

**Files:**
- Create: `server/services/action-contract-review-policy.ts`
- Modify: `server/services/action-contract-service.ts`
- Test: `server/services/action-contract-service.test.ts`
- Test: `server/services/preflight-service.test.ts`

**Acceptance Criteria:**
- [ ] Review decision functions are imported from `action-contract-review-policy.ts`.
- [ ] Review policy does not call `persistActionContract()`.
- [ ] Build policy remains unchanged.

- [ ] **Step 1: Extract Review policy**

Create `action-contract-review-policy.ts`:

```ts
export function reviewControlDecision(changeId: string, actionId: string): ActionDecision {
  // Move current body.
}

export function hasWaivableOpenReviewP1(changeId: string): boolean {
  // Move current body if only used by review policy.
}
```

- [ ] **Step 2: Wire imports and run tests**

Modify Review action branches only, then run:

```bash
pnpm exec tsx --test --test-concurrency=1 --test-name-pattern "Review|waive_review|enter_qa|preflight" server/services/action-contract-service.test.ts server/services/preflight-service.test.ts
```

---

## Task 10C: Extract QA Action Policy

**Description:** Move only QA action decisions out of `action-contract-service.ts`.

**Files:**
- Create: `server/services/action-contract-qa-policy.ts`
- Modify: `server/services/action-contract-service.ts`
- Test: `server/services/action-contract-service.test.ts`
- Test: `server/services/preflight-service.test.ts`

**Acceptance Criteria:**
- [ ] QA decision functions are imported from `action-contract-qa-policy.ts`.
- [ ] QA policy does not call `persistActionContract()`.
- [ ] Self-heal remains in `action-contract-self-heal-service.ts`.

- [ ] **Step 1: Extract QA policy**

Create `action-contract-qa-policy.ts`:

```ts
export function enterQaDecision(changeId: string): ActionDecision | null {
  // Move current body.
}

export function retryQaDecision(changeId: string): ActionDecision {
  // Move current body.
}
```

- [ ] **Step 2: Wire imports and run tests**

Modify QA action branches only, then run:

```bash
pnpm exec tsx --test --test-concurrency=1 --test-name-pattern "QA|CHECKING|retry_qa|run_qa|preflight" server/services/action-contract-service.test.ts server/services/preflight-service.test.ts
```

---

## Task 10D: Extract Merge Action Policy

**Description:** Move only Merge action decisions out of `action-contract-service.ts`.

**Files:**
- Create: `server/services/action-contract-merge-policy.ts`
- Modify: `server/services/action-contract-service.ts`
- Test: `server/services/action-contract-service.test.ts`
- Test: `server/services/preflight-service.test.ts`

**Acceptance Criteria:**
- [ ] Merge decision functions are imported from `action-contract-merge-policy.ts`.
- [ ] Merge policy does not call `persistActionContract()`.
- [ ] `getActions()` remains the only aggregator/persistence caller.

- [ ] **Step 1: Extract Merge policy**

Create `action-contract-merge-policy.ts`:

```ts
export function approveMergeDecision(changeId: string): ActionDecision {
  // Move current body.
}

export function mergeDecision(changeId: string, requireApproval: boolean): ActionDecision {
  // Move current body.
}
```

- [ ] **Step 2: Wire imports and run tests**

Modify Merge action branches only, then run:


```bash
pnpm exec tsx --test --test-concurrency=1 --test-name-pattern "Merge|approve_merge|reject_merge|preflight" server/services/action-contract-service.test.ts server/services/preflight-service.test.ts
```

Expected: all matched tests pass.

---

## Task 11: Extract Operational Phase Panel and Phase Rail

**Description:** Remove rendering-heavy components from `page.tsx` after pure helpers and API hooks are extracted.

**Files:**
- Create: `app/projects/[id]/changes/[changeId]/phase-rail.tsx`
- Create: `app/projects/[id]/changes/[changeId]/operational-phase-panel.tsx`
- Create: `app/projects/[id]/changes/[changeId]/failed-run-banner.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Test: `app/projects/[id]/changes/[changeId]/phase-review.test.ts`

**Acceptance Criteria:**
- [ ] `PhaseBar` and `VerticalPhaseRail` move to `phase-rail.tsx`.
- [ ] QA/Merge action summary section moves to `operational-phase-panel.tsx`.
- [ ] Failed run banner moves to `failed-run-banner.tsx`.
- [ ] `page.tsx` contains orchestration and layout, not large component bodies.

- [ ] **Step 1: Move phase rail components**

Create `phase-rail.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import type { ReviewPhase } from "./change-detail-types";
import { PHASES, getCurrentPhase } from "./change-phase-map";

export function PhaseBar(props: {
  status: string;
  selectedPhase: ReviewPhase;
  phaseOverviews: PhaseOverview[] | undefined;
  onSelectPhase: (phase: ReviewPhase) => void;
}) {
  // Move existing body from page.tsx.
}

export function VerticalPhaseRail(props: {
  status: string;
  selectedPhase: ReviewPhase;
  phaseOverviews: PhaseOverview[] | undefined;
  isRunning: boolean;
  onSelectPhase: (phase: ReviewPhase) => void;
}) {
  // Move existing body from page.tsx.
}
```

Move `PhaseOverview` type to `change-detail-types.ts` if needed.

- [ ] **Step 2: Move operational phase panel**

Create `operational-phase-panel.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import type { PipelineActionContract } from "./pipeline-action-contract";
import { pipelineActionDisabledReason } from "./pipeline-action-contract";

export function OperationalPhasePanel(props: {
  phase: "Check" | "Merge";
  statusLabel: string;
  latestRunStatus: string | null;
  actions: PipelineActionContract[];
  running: boolean;
  onAction: (actionId: string) => void;
  children: React.ReactNode;
}) {
  // Move current QA/Merge action summary rendering here.
}
```

- [ ] **Step 3: Move failed banner**

Create `failed-run-banner.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import type { ChangeDetail, ReviewPhase } from "./change-detail-types";
import { summarizeFailedRunForBanner } from "./change-phase-map";

export function FailedRunBanner(props: {
  run: NonNullable<ChangeDetail["latestRun"]>;
  phase: ReviewPhase | null;
  explicitSelectedPhase: ReviewPhase | null;
  onSelectPhase: (phase: ReviewPhase) => void;
  changeId: string;
}) {
  // Move existing banner JSX here.
}
```

- [ ] **Step 4: Update page imports and render calls**

Replace local component definitions and JSX blocks in `page.tsx` with imports.

- [ ] **Step 5: Run UI tests**

Run:

```bash
pnpm exec tsx app/projects/\[id\]/changes/\[changeId\]/phase-review.test.ts
```

Expected: all tests pass.

---

## Task 12: First Size Checkpoint and Browser Smoke

**Description:** Verify that the first wave of extraction reduced bloat without behavior regressions.

**Files:**
- Modify: none unless tests reveal a regression.

**Acceptance Criteria:**
- [ ] `pipeline-service.ts` line count is lower than before.
- [ ] `action-contract-service.ts` line count is lower than before.
- [ ] `page.tsx` line count is lower than before.
- [ ] Focused test suites pass.
- [ ] Browser can load the Change detail page.

- [ ] **Step 1: Measure line counts**

Run:

```bash
wc -l server/services/pipeline-service.ts server/services/action-contract-service.ts 'app/projects/[id]/changes/[changeId]/page.tsx'
```

Expected: all three are lower than the baseline in this plan.

- [ ] **Step 2: Run focused tests**

Run:

```bash
pnpm exec tsx --test --test-concurrency=1 server/services/action-contract-service.test.ts server/services/preflight-service.test.ts server/services/build-workspace-service.test.ts server/services/pipeline-routes.test.ts server/services/merge-readiness-service.test.ts server/services/qa-run-service.test.ts
pnpm exec tsx app/projects/\[id\]/changes/\[changeId\]/phase-review.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run final diff check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 4: Browser smoke**

Start server if needed:

```bash
pnpm dev
```

Open:

```text
http://localhost:3000/projects/PRJ-003/changes/CHG-001
```

Expected:

- Page renders without console errors.
- Status is visible.
- Phase rail renders.
- Existing final Retro state does not show `Pipeline Running` unless a run is actually running.

---

## Later Phases Not Included in First Execution Batch

These are intentionally deferred until Tasks 1-12 are complete and reviewed:

1. Split `plan-sandbox-service.ts` into `plan-types`, `plan-safe-file-service`, `plan-glob-policy-service`, `plan-snapshot-service`, `plan-report-service`, `plan-approval-service`.
2. Split Build path safety and adoption. Adoption should be last because it owns patch/hash/HEAD/dirty safety.
3. Split Review run parser and lineage services.
4. Split `spec-battle-service.ts`.
5. Mechanically split `server/db/schema.ts` into domain schema modules.

## Review Checklist for Each Task

- [ ] Did the task preserve public imports?
- [ ] Did it avoid changing route URLs, action IDs, reason codes, or gate hash semantics?
- [ ] Did it keep DB writes in the same order?
- [ ] Did it avoid moving safety checks into UI or route code?
- [ ] Did focused tests pass?
- [ ] Did `git diff --check` pass?

## Rollback Strategy

Each task is designed as a small extraction. If a task fails:

1. Revert only that task's files.
2. Keep previous completed extraction tasks.
3. Re-run the focused suite from the last checkpoint.
4. Do not continue to the next task until the behavior baseline is restored.

## Final Acceptance

The first execution batch is complete when:

- [ ] Tasks 1-12 are checked off.
- [ ] `pipeline-service.ts` is measurably smaller.
- [ ] `action-contract-service.ts` is measurably smaller.
- [ ] `page.tsx` is measurably smaller.
- [ ] All listed focused tests pass.
- [ ] Browser smoke passes.
- [ ] A review agent confirms no route/action/preflight behavior regression.
