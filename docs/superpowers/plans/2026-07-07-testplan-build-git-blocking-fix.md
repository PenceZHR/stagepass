# TestPlan Sandbox And Build Git Blocking Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TestPlan phase display real TestPlan snapshot data instead of Plan sandbox data, and allow Build to start when the git base camp is only dirty with non-strict warnings.

**Architecture:** Split TestPlan into its own read-only sandbox endpoint, client state, and UI component while leaving PlanSandbox scoped to Plan only. Align Build backend and frontend gates so non-strict dirty git state is warning-only across action contracts, the implement route, and the Build workspace UI.

**Tech Stack:** Next.js App Router, React client components, TypeScript, Drizzle SQLite services, Node test runner.

---

## Status

Review status: approved by subagent review; blockers resolved.

This document is a repair plan only. Do not modify functional code while reviewing this document.

Latest blocker review: the first subagent review found blocking issues in this document. This revision addresses them by requiring a read-only stage authority accessor, an explicit TestPlan status normalizer, consistent `run_build` and `retry_build` base camp predicates, and TypeScript-safe base camp warning rendering.

## Root Cause Summary

### TestPlan Shows Plan

The TestPlan phase currently enters the same rendering branch as Plan:

- `app/projects/[id]/changes/[changeId]/page.tsx` sets `showingPlanSandbox = activeSelectedPhase === "Plan" || activeSelectedPhase === "TestPlan"`.
- The render branch always mounts `PlanSandbox` and passes `planSandboxState`.
- `change-api-client.ts` loads `planSandboxState` from `/plan-sandbox`.
- `/plan-sandbox` returns `getPlanSandboxState(changeId)`.
- `getPlanSandboxState` reads the latest Plan snapshot.

The real TestPlan snapshot exists separately in `testplan_snapshots`, `testplan_coverage_items`, `testplan_risk_mappings`, `required_validation_commands`, and `testplan_manual_checks`.

### Build Is Blocked By Warning-Only Git State

`checkGitBaseCamp` treats dirty working trees as warnings when `strictClean` is false:

```ts
if (!clean) {
  const message = `Working tree has uncommitted changes: ${porcelain.join(", ")}`;
  if (options.strictClean) {
    blockers.push(message);
  } else {
    warnings.push(message);
  }
}
```

It then returns `status: "dirty"` with `blockers: []`.

Two later layers treat `status !== "ready"` as blocking:

- `action-contract-service.ts` disables `run_build` and builds a blank reason from `baseCamp.blockers.join("; ")`.
- `app/api/projects/[id]/changes/[changeId]/implement/route.ts` rejects Build for the same warning-only dirty state.

The frontend adds another issue:

```ts
findPipelineAction(actions, "run_build") ?? findPipelineAction(actions, "retry_build")
```

This selects disabled `run_build` before checking enabled `retry_build`.

## Non-Goals

- Do not change Plan generation, Plan approval, or PlanSandbox behavior for the Plan phase.
- Do not change TestPlan generation prompts or AI output parsing.
- Do not rewrite `RUN-008` run-only artifact in this repair. The 562 byte run artifact is confusing, but it is not the root cause of the TestPlan tab showing Plan content.
- Do not require users to clean unrelated uncommitted files before starting Build when `strictClean` is false.
- Do not weaken strict checks for merge, QA, or any stage that intentionally requires a clean tree.

## File Structure

### New Files

- `app/api/projects/[id]/changes/[changeId]/testplan-sandbox/route.ts`
  - Read-only API route for TestPlan sandbox state.
- `app/projects/[id]/changes/[changeId]/testplan-sandbox-types.ts`
  - Client-side TestPlan sandbox DTO types.
- `app/projects/[id]/changes/[changeId]/testplan-sandbox.tsx`
  - TestPlan-specific UI. Shows test intent, coverage items, risk mappings, required commands, manual checks, and gate summary.

### Modified Files

- `server/services/testplan-snapshot-service.ts`
  - Export a read-only `getTestPlanSnapshotState(changeId)` DTO builder.
  - Export or reuse a pure markdown renderer if needed by the DTO.
- `server/services/stage-authority-service.ts`
  - Export a read-only `peekStageAuthority(changeId, phase)` accessor that wraps the existing pure `computeSnapshot(changeId, phase)` helper without calling `upsertStageState` or writing `stage_states`.
- `app/projects/[id]/changes/[changeId]/change-api-client.ts`
  - Add `getTestPlanSandbox`.
- `app/projects/[id]/changes/[changeId]/use-change-detail-data.ts`
  - Add `testPlanSandboxState`, setter, and loader.
- `app/projects/[id]/changes/[changeId]/use-change-commands.ts`
  - Include `loadTestPlanSandboxState` in refresh paths after TestPlan/Plan approval commands that can affect the visible TestPlan stage.
- `app/projects/[id]/changes/[changeId]/page.tsx`
  - Split Plan and TestPlan render branches.
- `server/services/action-contract-service.ts`
  - Let warning-only dirty base camp pass for `run_build` and `retry_build`.
  - Keep real blockers blocked.
- `app/api/projects/[id]/changes/[changeId]/implement/route.ts`
  - Apply the same warning-only dirty policy as action contracts for both `run_build` and `retry_build`.
- `app/projects/[id]/changes/[changeId]/build-sandbox.tsx`
  - Select an enabled Build start action before falling back to disabled reasons.
  - Display base camp warnings as warnings, not as stable.

### Tests To Update Or Add

- `server/services/testplan-snapshot-service.test.ts`
- `server/services/plan-sandbox-routes.test.ts` or a new route test file matching the existing route test pattern
- `app/projects/[id]/changes/[changeId]/plan-sandbox.test.ts`
- `app/projects/[id]/changes/[changeId]/build-sandbox.test.ts`
- `server/services/action-contract-service.test.ts`
- `server/services/pipeline-routes.test.ts`

## Design Decisions

### Decision 1: TestPlan GET Must Be Read-Only

`getTestPlanSnapshotState(changeId)` must not call `getStageAuthority`, `recomputeContentGate`, `recomputeStageGate`, `approveTestPlan`, `completeStageRun`, or any function that inserts or updates DB rows.

Use these read-only sources:

- `latestSnapshot(changeId)`
- `loadSnapshotRows(snapshot.id)`
- `peekStageAuthority(changeId, "TestPlan").latestGate`
- `peekStageAuthority(changeId, "TestPlan").latestReport`

Add `peekStageAuthority` in `stage-authority-service.ts` as a pure reader. It must call the existing pure `computeSnapshot(changeId, phase)` helper directly and must not call `recomputeStageState`. Tests must prove that calling the TestPlan sandbox GET does not insert or update `stage_states`, `stage_gates`, `stage_reports`, or `stage_runs`.

When there is no snapshot, return a valid empty state instead of throwing.

### Decision 2: TestPlan Has Its Own UI

Do not reuse `PlanSandbox`. TestPlan does not have Plan concepts like `planName`, `implementationSteps`, or Plan adversarial risks. Its primary content is coverage, mappings, commands, and manual checks.

### Decision 3: Dirty Git Is Warning-Only For Build Base Camp When There Are No Blockers

For Build entry in non-strict mode, both `run_build` and `retry_build` use the same hard-block predicate:

- Block when there is no git repo, no commits, no head SHA, or `blockers.length > 0`.
- Allow when `status === "dirty"` and `blockers.length === 0`.
- Surface `warnings` in the UI and API diagnostics.

This intentionally changes the current `retry_build` behavior from "skip all base camp checks" to "skip warning-only dirty checks, but still block hard repository failures." That keeps the UI and `/implement` route consistent and prevents retry from advertising an action that the route rejects.

### Decision 4: Build Start Action Selection Must Prefer Enabled Actions

Select Build start actions in this order:

1. Enabled `run_build`
2. Enabled `retry_build`
3. Existing `run_build` for disabled reason
4. Existing `retry_build` for disabled reason
5. Missing action error

Use the same selection helper for the button disabled state and `runBuildStart`.

## Task 1: Add TestPlan Read-Only Service State

**Files:**
- Modify: `server/services/testplan-snapshot-service.ts`
- Modify: `server/services/stage-authority-service.ts`
- Test: `server/services/testplan-snapshot-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Add tests that seed a TestPlan snapshot with coverage items, risk mappings, required commands, and manual checks, then call `getTestPlanSnapshotState(changeId)`.

Expected assertions:

```ts
assert.equal(state.changeId, changeId);
assert.equal(state.snapshot?.id, "TPL-SNAP-001");
assert.equal(state.testIntent, "Verify command outcomes");
assert.equal(state.coverageItems.length, 1);
assert.equal(state.riskMappings.length, 1);
assert.equal(state.requiredCommands.length, 1);
assert.equal(state.manualChecks.length, 1);
assert.match(state.markdown, /## Coverage Items/);
assert.match(state.markdown, /ci-command-state-machine/);
```

Add a no-snapshot case:

```ts
assert.equal(state.snapshot, null);
assert.equal(state.coverageItems.length, 0);
assert.equal(state.status, "missing");
```

Add a read-only guard by counting all stage authority tables before and after the call:

```ts
const before = {
  states: countStageStates(db, changeId, "TestPlan"),
  gates: countStageGates(db, changeId, "TestPlan"),
  reports: countStageReports(db, changeId, "TestPlan"),
  runs: countStageRuns(db, changeId, "TestPlan"),
};
getTestPlanSnapshotState(changeId);
const after = {
  states: countStageStates(db, changeId, "TestPlan"),
  gates: countStageGates(db, changeId, "TestPlan"),
  reports: countStageReports(db, changeId, "TestPlan"),
  runs: countStageRuns(db, changeId, "TestPlan"),
};
assert.deepEqual(after, before);
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm exec tsx --test server/services/testplan-snapshot-service.test.ts
```

Expected: FAIL because `peekStageAuthority` and `getTestPlanSnapshotState` do not exist.

- [ ] **Step 3: Add a read-only stage authority accessor**

In `stage-authority-service.ts`, add `peekStageAuthority`. It should return the existing `StageAuthoritySnapshot` shape exactly:

```ts
{
  changeId: string;
  phase: PipelinePhase;
  state: StageStateRecord | null;
  latestAttempt: StageRunRecord | null;
  latestReport: StageReportRecord | null;
  latestValidReport: StageReportRecord | null;
  latestGate: StageGateRecord | null;
}
```

Implementation rules:

- Use the existing service DB handle.
- Reuse the existing pure `computeSnapshot(changeId, phase)` function, which already reads `stage_states`, `stage_gates`, `stage_reports`, and `stage_runs` and orders latest rows consistently.
- Do not call `recomputeStageState`.
- Do not call `upsertStageState`.
- Do not insert, update, or delete anything.

Implementation:

```ts
export function peekStageAuthority(changeId: string, phase: PipelinePhase): StageAuthoritySnapshot {
  return computeSnapshot(changeId, phase);
}
```

Do not introduce a parallel snapshot type unless `StageAuthoritySnapshot` itself changes. The executor should not use fields named `latestState` or `latestRun`; the existing field names are `state` and `latestAttempt`.

- [ ] **Step 4: Implement JSON helpers, status normalization, and the read-only DTO**

Add exported DTO interfaces near the existing `TestPlanSnapshot` type:

```ts
export interface TestPlanSandboxState {
  changeId: string;
  status: "missing" | "draft" | "approved" | "blocked";
  snapshot: {
    id: string;
    status: string;
    approvalState: string;
    approvedAt: string | null;
    snapshotDbHash: string;
    schemaVersion: string;
    createdAt: string;
  } | null;
  testIntent: string;
  coverageItems: Array<typeof testplanCoverageItems.$inferSelect>;
  riskMappings: Array<typeof testplanRiskMappings.$inferSelect>;
  requiredCommands: Array<typeof requiredValidationCommands.$inferSelect>;
  manualChecks: Array<typeof testplanManualChecks.$inferSelect>;
  gate: {
    status: string | null;
    sourceDbHash: string | null;
    blockers: unknown[];
    requiredActions: string[];
  };
  reportFresh: boolean;
  markdown: string;
}
```

Add local helper functions in `testplan-snapshot-service.ts`:

```ts
function readJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readJsonStringArray(value: string | null | undefined): string[] {
  return readJsonArray(value).filter((item): item is string => typeof item === "string");
}

function testPlanSandboxStatus(snapshot: TestPlanSnapshotRow | null): TestPlanSandboxState["status"] {
  if (!snapshot) return "missing";
  if (snapshot.approvalState === "approved") return "approved";
  if (snapshot.status === "draft" || snapshot.status === "approved" || snapshot.status === "blocked") {
    return snapshot.status;
  }
  return "blocked";
}
```

Implement:

```ts
export function getTestPlanSnapshotState(changeId: string): TestPlanSandboxState {
  const snapshot = latestSnapshot(changeId);
  const authority = peekStageAuthority(changeId, "TestPlan");
  const gate = authority.latestGate;
  const report = authority.latestReport;

  if (!snapshot) {
    return {
      changeId,
      status: "missing",
      snapshot: null,
      testIntent: "",
      coverageItems: [],
      riskMappings: [],
      requiredCommands: [],
      manualChecks: [],
      gate: {
        status: gate?.status ?? null,
        sourceDbHash: gate?.sourceDbHash ?? null,
        blockers: readJsonArray(gate?.blockersJson),
        requiredActions: readJsonStringArray(gate?.requiredActionsJson),
      },
      reportFresh: report?.isFresh === 1,
      markdown: "# TestPlan DB Snapshot\n\nNo TestPlan snapshot has been generated.\n",
    };
  }

  const rows = loadSnapshotRows(snapshot.id);
  const gateForMarkdown = testPlanMarkdownGate(gate);

  return {
    changeId,
    status: testPlanSandboxStatus(snapshot),
    snapshot: {
      id: snapshot.id,
      status: snapshot.status,
      approvalState: snapshot.approvalState,
      approvedAt: snapshot.approvedAt,
      snapshotDbHash: snapshot.snapshotDbHash,
      schemaVersion: snapshot.schemaVersion,
      createdAt: snapshot.createdAt,
    },
    testIntent: snapshot.testIntent,
    ...rows,
    gate: {
      status: gate?.status ?? null,
      sourceDbHash: gate?.sourceDbHash ?? null,
      blockers: readJsonArray(gate?.blockersJson),
      requiredActions: readJsonStringArray(gate?.requiredActionsJson),
    },
    reportFresh: report?.isFresh === 1,
    markdown: renderTestPlanMarkdown({
      snapshot,
      ...rows,
      gate: gateForMarkdown,
    }),
  };
}
```

Split `renderTestPlanMarkdown` so its gate parameter is a plain readonly view:

```ts
type TestPlanMarkdownGate = {
  status: string;
  sourceDbHash: string | null;
};
```

Then `testPlanMarkdownGate(gate)` can return `{ status: gate?.status ?? "missing", sourceDbHash: gate?.sourceDbHash ?? null }` without casting or synthesizing a `StageGateRecord`. Do not call `getStageAuthority` or `recomputeContentGate`.

- [ ] **Step 5: Run service tests**

Run:

```bash
pnpm exec tsx --test server/services/testplan-snapshot-service.test.ts
```

Expected: PASS.

## Task 2: Add TestPlan Sandbox API Route

**Files:**
- Create: `app/api/projects/[id]/changes/[changeId]/testplan-sandbox/route.ts`
- Test: `server/services/plan-sandbox-routes.test.ts` or a new route test file

- [ ] **Step 1: Write failing route test**

Add a route guard test following the existing `plan-sandbox` route pattern.

Expected source assertions:

```ts
assert.match(content, /getTestPlanSnapshotState/);
assert.match(content, /requireProjectChange\(projectId, changeId\)/);
assert.match(content, /NextResponse\.json\(getTestPlanSnapshotState\(changeId\)\)/);
```

Add an integration-style route assertion if the route test harness supports invoking GET directly:

```ts
const before = countAllStageAuthorityRows(db, changeId, "TestPlan");
const response = await GET(new Request("http://test.local"), {
  params: Promise.resolve({ id: projectId, changeId }),
});
assert.equal(response.status, 200);
const after = countAllStageAuthorityRows(db, changeId, "TestPlan");
assert.deepEqual(after, before);
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm exec tsx --test server/services/plan-sandbox-routes.test.ts
```

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Create the route**

Implement:

```ts
import { NextResponse } from "next/server";
import { getTestPlanSnapshotState } from "@/server/services/testplan-snapshot-service";
import { requireProjectChange } from "../route-guard";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> }
) {
  const { id: projectId, changeId } = await params;
  try {
    const guard = await requireProjectChange(projectId, changeId);
    if (guard.response) return guard.response;
    return NextResponse.json(getTestPlanSnapshotState(changeId));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

- [ ] **Step 4: Run route tests**

Run:

```bash
pnpm exec tsx --test server/services/plan-sandbox-routes.test.ts
```

Expected: PASS.

## Task 3: Add Client TestPlan State And UI

**Files:**
- Create: `app/projects/[id]/changes/[changeId]/testplan-sandbox-types.ts`
- Create: `app/projects/[id]/changes/[changeId]/testplan-sandbox.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/change-api-client.ts`
- Modify: `app/projects/[id]/changes/[changeId]/use-change-detail-data.ts`
- Modify: `app/projects/[id]/changes/[changeId]/use-change-commands.ts`
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Test: `app/projects/[id]/changes/[changeId]/plan-sandbox.test.ts`

- [ ] **Step 1: Update failing static tests**

Replace the current assertion that allows TestPlan to enter PlanSandbox:

```ts
assert.match(pageSource, /const showingPlanSandbox = activeSelectedPhase === "Plan" \|\| activeSelectedPhase === "TestPlan"/);
```

with assertions that enforce the split:

```ts
assert.match(pageSource, /const showingPlanSandbox = activeSelectedPhase === "Plan"/);
assert.match(pageSource, /const showingTestPlanSandbox = activeSelectedPhase === "TestPlan"/);
assert.match(pageSource, /<TestPlanSandbox/);
```

Add assertions that TestPlan has its own state:

```ts
assert.match(dataHookSource, /testPlanSandboxState/);
assert.match(dataHookSource, /loadTestPlanSandboxState/);
assert.match(clientSource, /getTestPlanSandbox/);
```

Add component source assertions:

```ts
assert.match(testPlanComponentSource, /export function TestPlanSandbox/);
assert.match(testPlanComponentSource, /Coverage Items/);
assert.match(testPlanComponentSource, /Required Commands/);
assert.doesNotMatch(testPlanComponentSource, /implementationSteps/);
assert.doesNotMatch(testPlanComponentSource, /planName/);
```

- [ ] **Step 2: Run the failing UI static test**

Run:

```bash
pnpm exec tsx --test app/projects/[id]/changes/[changeId]/plan-sandbox.test.ts
```

Expected: FAIL because TestPlan UI files and state do not exist yet.

- [ ] **Step 3: Add client DTO types**

Create `testplan-sandbox-types.ts`:

```ts
export interface TestPlanSnapshotSummary {
  id: string;
  status: string;
  approvalState: string;
  approvedAt: string | null;
  snapshotDbHash: string;
  schemaVersion: string;
  createdAt: string;
}

export interface TestPlanCoverageItem {
  id: string;
  testplanSnapshotId: string;
  itemKey: string;
  title: string;
  requirementRef: string | null;
  testType: string;
  priority: string;
  status: string;
  createdAt: string;
}

export interface TestPlanRiskMapping {
  id: string;
  testplanSnapshotId: string;
  coverageItemKey: string;
  riskRef: string;
  severity: string;
  mitigation: string;
  createdAt: string;
}

export interface TestPlanRequiredCommand {
  id: string;
  changeId: string;
  phase: string;
  command: string;
  required: number;
  commandOrder: number;
  sourceSnapshotId: string | null;
  createdAt: string;
}

export interface TestPlanManualCheck {
  id: string;
  testplanSnapshotId: string;
  title: string;
  description: string | null;
  required: number;
  createdAt: string;
}

export interface TestPlanSandboxState {
  changeId: string;
  status: "missing" | "draft" | "approved" | "blocked";
  snapshot: TestPlanSnapshotSummary | null;
  testIntent: string;
  coverageItems: TestPlanCoverageItem[];
  riskMappings: TestPlanRiskMapping[];
  requiredCommands: TestPlanRequiredCommand[];
  manualChecks: TestPlanManualCheck[];
  gate: {
    status: string | null;
    sourceDbHash: string | null;
    blockers: unknown[];
    requiredActions: string[];
  };
  reportFresh: boolean;
  markdown: string;
}
```

- [ ] **Step 4: Add API client and hook state**

In `change-api-client.ts`, import `TestPlanSandboxState` and add:

```ts
getTestPlanSandbox: async () =>
  readJson<TestPlanSandboxState>(
    await fetch(`${base}/testplan-sandbox`),
    "Failed to load TestPlan sandbox"
  ),
```

In `use-change-detail-data.ts`, add:

```ts
const [testPlanSandboxState, setTestPlanSandboxState] =
  useState<TestPlanSandboxState | null>(null);

const loadTestPlanSandboxState = useCallback(() => {
  return changeApi(projectId, changeId)
    .getTestPlanSandbox()
    .then((data) => {
      setTestPlanSandboxState(data);
      return data;
    })
    .catch(() => {
      setTestPlanSandboxState(null);
      return null;
    });
}, [projectId, changeId]);
```

Include `testPlanSandboxState`, `setTestPlanSandboxState`, and `loadTestPlanSandboxState` in the returned controller object. Add it to existing refresh paths that currently call `loadPlanSandboxState` after TestPlan-affecting actions.

In `use-change-commands.ts`, add `loadTestPlanSandboxState` to the command hook parameters and invoke it beside `loadPlanSandboxState` after approval or stage actions that can change TestPlan-visible state. This keeps the TestPlan tab fresh when the shared `handleApprovePlanSandbox` path is used.

- [ ] **Step 5: Add TestPlanSandbox component**

Create a compact component that renders:

- Empty state when `state` is null or `state.snapshot` is null.
- Snapshot metadata.
- Test intent.
- Coverage items grouped by priority.
- Risk mappings.
- Required commands.
- Manual checks.
- Gate status and blockers.

Use existing UI primitives from nearby components. Do not add action buttons inside this component; phase actions remain in the shared stage header.

- [ ] **Step 6: Split page rendering**

Change:

```ts
const showingPlanSandbox = activeSelectedPhase === "Plan" || activeSelectedPhase === "TestPlan";
```

to:

```ts
const showingPlanSandbox = activeSelectedPhase === "Plan";
const showingTestPlanSandbox = activeSelectedPhase === "TestPlan";
```

Add a render branch before the Plan branch or split the existing branch:

```tsx
{showingTestPlanSandbox ? (
  <PhaseStageShell
    phase="TestPlan"
    state={selectedStageState}
    statusLabel={stageStatusLabel}
    latestRunStatus={latestRunStatusLabel}
    actions={planStageActions}
    actionError={planStageActionError}
    records={renderPhaseRecords("TestPlan", "testplan-records")}
  >
    <TestPlanSandbox
      state={testPlanSandboxState}
      loading={gateLoading}
    />
  </PhaseStageShell>
) : showingPlanSandbox ? (
  ...
) : ...}
```

- [ ] **Step 7: Run UI static tests**

Run:

```bash
pnpm exec tsx --test app/projects/[id]/changes/[changeId]/plan-sandbox.test.ts
```

Expected: PASS.

## Task 4: Align Build Base Camp Policy In Action Contracts

**Files:**
- Modify: `server/services/action-contract-service.ts`
- Test: `server/services/action-contract-service.test.ts`

- [ ] **Step 1: Write failing action-contract tests**

Add or update tests so a non-strict dirty base camp with warnings and no blockers leaves both `run_build` and `retry_build` enabled when their other stage gates are satisfied.

Expected assertions:

```ts
const runBuild = actions.find((action) => action.actionId === "run_build");
const retryBuild = actions.find((action) => action.actionId === "retry_build");
assert.equal(runBuild?.enabled, true);
assert.equal(retryBuild?.enabled, true);
assert.notEqual(runBuild?.reasonCode, "build_base_camp_blocked");
assert.notEqual(retryBuild?.reasonCode, "build_base_camp_blocked");
```

Add a true blocker case:

```ts
assert.equal(runBuild?.enabled, false);
assert.equal(retryBuild?.enabled, false);
assert.equal(runBuild?.reasonCode, "build_base_camp_blocked");
assert.match(runBuild?.reason ?? "", /Path is not a git repository|Git repository has no commits|HEAD/);
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm exec tsx --test server/services/action-contract-service.test.ts
```

Expected: FAIL because `dirty` is currently treated as blocked for `run_build`, while `retry_build` currently skips base camp checks entirely.

- [ ] **Step 3: Implement a shared base camp blocker predicate**

In `action-contract-service.ts`, replace `baseCamp.status === "ready"` as the only passing state with a predicate and apply it to both `run_build` and `retry_build`:

```ts
function buildBaseCampHasBlockingProblem(baseCamp: GitBaseCampStatus): boolean {
  return !baseCamp.headSha || baseCamp.blockers.length > 0;
}
```

This covers "not a git repository" and "repository has no commits" because `checkGitBaseCamp` returns `headSha: null` plus a blocker for those cases.

Then remove the existing special case that returns early for `retry_build`, and use:

```ts
if (!buildBaseCampHasBlockingProblem(baseCamp)) return current;
```

For blocked reasons, use blockers first and fall back to status/head diagnostics:

```ts
const details =
  baseCamp.blockers.length > 0
    ? baseCamp.blockers.join("; ")
    : !baseCamp.headSha
      ? "Git HEAD is missing."
      : `Base camp status is ${baseCamp.status}.`;
```

Do not use `warnings` as blockers.

- [ ] **Step 4: Run action-contract tests**

Run:

```bash
pnpm exec tsx --test server/services/action-contract-service.test.ts
```

Expected: PASS.

## Task 5: Align Build Base Camp Policy In Implement Route

**Files:**
- Modify: `app/api/projects/[id]/changes/[changeId]/implement/route.ts`
- Test: `server/services/pipeline-routes.test.ts`

- [ ] **Step 1: Write failing implement route tests**

Add a route test that simulates warning-only dirty state and verifies both `run_build` and `retry_build` do not reject with `Build workspace base camp blocked`.

Expected assertions:

```ts
assert.notEqual(response.status, 409);
assert.doesNotMatch(body.error ?? "", /Build workspace base camp blocked/);
```

Add or update the source assertion so the route no longer gates on `baseCamp.status !== "ready"`:

```ts
assert.doesNotMatch(implementContent, /baseCamp\.status !== "ready"/);
assert.match(implementContent, /baseCamp\.blockers\.length > 0/);
```

Add a true blocker test for both action ids:

```ts
for (const actionId of ["run_build", "retry_build"] as const) {
  const response = await POST(requestFor(actionId), params);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error, /Build workspace base camp blocked/);
}
```

- [ ] **Step 2: Run the failing route test**

Run:

```bash
pnpm exec tsx --test server/services/pipeline-routes.test.ts
```

Expected: FAIL because the route currently rejects warning-only dirty state.

- [ ] **Step 3: Update route guard logic**

Replace the final base camp check:

```ts
if (baseCamp.status !== "ready") {
  return NextResponse.json(
    { error: `Build workspace base camp blocked: ${baseCamp.blockers.join("; ")}`, baseCamp },
    { status: 409 }
  );
}
```

with:

```ts
if (!baseCamp.headSha || baseCamp.blockers.length > 0) {
  const details =
    baseCamp.blockers.length > 0
      ? baseCamp.blockers.join("; ")
      : "Git HEAD is missing.";
  return NextResponse.json(
    { error: `Build workspace base camp blocked: ${details}`, baseCamp },
    { status: 409 }
  );
}
```

- [ ] **Step 4: Run route tests**

Run:

```bash
pnpm exec tsx --test server/services/pipeline-routes.test.ts
```

Expected: PASS.

## Task 6: Fix BuildSandbox Action Selection And Warning UI

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/build-sandbox.tsx`
- Test: `app/projects/[id]/changes/[changeId]/build-sandbox.test.ts`
- Test: `app/build-sandbox-task5.test.ts`

- [ ] **Step 1: Write failing BuildSandbox static tests**

Add source assertions for a helper that selects enabled Build start actions:

```ts
assert.match(source, /function selectBuildStartAction/);
assert.match(source, /findPipelineAction\(actions, "run_build"\)/);
assert.match(source, /findPipelineAction\(actions, "retry_build"\)/);
assert.doesNotMatch(source, /findPipelineAction\(actions, "run_build"\) \?\? findPipelineAction\(actions, "retry_build"\)/);
```

Add source assertions for warnings:

```ts
assert.match(source, /baseCamp\.warnings/);
assert.match(source, /Base Camp warning/);
```

- [ ] **Step 2: Run failing BuildSandbox tests**

Run:

```bash
pnpm exec tsx --test app/projects/[id]/changes/[changeId]/build-sandbox.test.ts app/build-sandbox-task5.test.ts
```

Expected: FAIL because the helper and warning UI do not exist.

- [ ] **Step 3: Add action selection helper**

Add a helper returning `null` instead of `undefined`, because existing preflight helpers accept `PipelineActionContract | null`:

```ts
function selectBuildStartAction(actions: PipelineActionContract[] | undefined): PipelineActionContract | null {
  const runBuild = findPipelineAction(actions, "run_build");
  const retryBuild = findPipelineAction(actions, "retry_build");
  if (runBuild?.enabled) return runBuild;
  if (retryBuild?.enabled) return retryBuild;
  return runBuild ?? retryBuild ?? null;
}
```

Use it in `runBuildStart`:

```ts
const contractAction = selectBuildStartAction(actions);
const disabledReason = pipelineActionDisabledReason(contractAction);
```

Use the same selected action when deriving button disabled state or tooltip, so UI and click behavior match.

- [ ] **Step 4: Display warning-only dirty state correctly**

Where the base camp panel currently shows stable when blockers are empty, add warning handling:

```tsx
{baseCamp.warnings.length > 0 ? (
  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
    <p className="font-medium">Base Camp warning</p>
    {baseCamp.warnings.map((warning) => (
      <p key={warning} className="mt-1 break-words font-mono text-xs">{warning}</p>
    ))}
  </div>
) : (
  <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900">
    Base Camp 稳定
  </div>
)}
```

Keep blockers visually stronger than warnings.

- [ ] **Step 5: Run BuildSandbox tests**

Run:

```bash
pnpm exec tsx --test app/projects/[id]/changes/[changeId]/build-sandbox.test.ts app/build-sandbox-task5.test.ts
```

Expected: PASS.

## Task 7: Final Verification

**Files:**
- No source changes beyond Tasks 1-6.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
pnpm exec tsx --test \
  server/services/testplan-snapshot-service.test.ts \
  server/services/plan-sandbox-routes.test.ts \
  app/projects/[id]/changes/[changeId]/plan-sandbox.test.ts \
  server/services/action-contract-service.test.ts \
  server/services/pipeline-routes.test.ts \
  app/projects/[id]/changes/[changeId]/build-sandbox.test.ts \
  app/build-sandbox-task5.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run the repository's standard test command:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 3: Manual UI verification**

With the dev server running:

1. Open `CHG-001`.
2. Click `Plan`.
3. Confirm the Plan phase still shows PlanSandbox fields such as plan name and implementation steps.
4. Click `TestPlan`.
5. Confirm the TestPlan phase shows test intent, coverage items, risk mappings, required commands, and manual checks.
6. Confirm TestPlan does not show Plan implementation steps.
7. Click `Build`.
8. Confirm dirty base camp warnings are visible as warnings.
9. Confirm `开始 Build` is available when dirty state has warnings but no blockers.
10. Confirm Build still blocks for true base camp blockers.

## Risk Controls

- The TestPlan endpoint is read-only. Tests must prove it does not create or update stage state, gate, report, or run records.
- The Build policy is not relaxed for strict-clean contexts; only Build base camp warning-only dirty state is allowed.
- The implement route and action contract must use the same blocking predicate for both `run_build` and `retry_build` to avoid UI/API mismatch.
- The Build UI must show warnings so users know why the base camp is not perfectly clean.
- Existing TestPlan completion semantics are preserved; this repair does not redefine `approve_plan`.

## Subagent Review Log

Initial review: BLOCKED.

Blocking findings addressed in this revision:

- Replaced `getStageAuthority` with a required read-only `peekStageAuthority` plan.
- Added no-write checks for `stage_states`, `stage_gates`, `stage_reports`, and `stage_runs`.
- Added explicit `testPlanSandboxStatus` normalizer for Drizzle string rows.
- Made `run_build` and `retry_build` use the same hard-block base camp predicate.
- Changed Build warning UI snippet from `state.baseCamp.warnings` to local `baseCamp.warnings`.
- Added JSON helper instructions and changed targeted test commands to `pnpm exec tsx --test`.

Second review: BLOCKED.

Blocking finding addressed after second review:

- Corrected `peekStageAuthority` to return the existing `StageAuthoritySnapshot` shape: `changeId`, `phase`, `state`, `latestAttempt`, `latestReport`, `latestValidReport`, and `latestGate`.

Third review: BLOCKED.

Blocking finding addressed after third review:

- Changed `selectBuildStartAction` plan to return `PipelineActionContract | null`, with `return runBuild ?? retryBuild ?? null;`, so it matches existing preflight helper contracts.

Non-blocking third-review suggestions incorporated:

- Added `use-change-commands.ts` to the TestPlan refresh scope.
- Added a route-level no-write assertion for `/testplan-sandbox` when the test harness supports direct GET invocation.

Fourth review: APPROVED.

Final blocker status: NONE.
