# Build Retry Stale Run Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Build retry reliable when a previous Build run is stale, so clicking "重新开始 Build" either starts a new Claude-backed Build run or reports an accurate blocker before returning success.

**Architecture:** Add an explicit stale Build recovery path that closes only proven-stale `implement/running` ledger rows and matching Build workspace metadata before a retry starts a new Build run. Keep the first-run `run_build` path strict (`PLAN_APPROVED` only), and make `retry_build` state-aware instead of sharing the same opaque fire-and-forget behavior. Update action contracts so the UI cannot advertise a retry that the backend will reject after returning `202`.

**Tech Stack:** Next.js App Router, TypeScript, Drizzle ORM over SQLite, existing pipeline ledger services, existing Build workspace JSON store, Node test runner with `tsx`.

---

## Current Failure

Observed state for `CHG-001`:

- `changes.status = IMPLEMENTING`
- latest run `RUN-009` is `phase=implement`, `status=running`, `ended_at=null`
- latest Build workspace file is `build-1.json`, `status=running`
- no Claude process is running in `<home>/Desktop/.cc-ai-workspaces/某个本地项目/CHG-001/build-1`
- `retry_build` is enabled by action contract, but `/implement` still calls `runImplementStreamed(changeId)`, which requires `PLAN_APPROVED`

Root cause:

1. The old run is stale but still persisted as running.
2. `retry_build` is enabled without checking whether the latest Build is truly retryable.
3. `/implement` returns `202` before the async status assertion can fail.
4. `runImplementStreamed()` only accepts `PLAN_APPROVED`, so an `IMPLEMENTING` retry fails before Claude is launched.

## Files And Responsibilities

- `server/services/build-stale-run-recovery-service.ts`
  - New focused service for detecting and closing stale Build runs.
  - Owns DB/Build workspace consistency for stale recovery.
- `server/services/build-stale-run-recovery-service.test.ts`
  - Unit tests for detection, no-op behavior, and safe recovery.
- `server/services/pipeline-build-stage-service.ts`
  - Add a public `retryBuildStreamed(changeId)` entrypoint.
  - Keep `runImplementStreamed(changeId)` strict for initial Build.
- `app/api/projects/[id]/changes/[changeId]/implement/route.ts`
  - Dispatch `run_build` versus `retry_build`.
  - Perform synchronous preflight for retry before returning `202`.
- `server/services/action-contract-build-policy.ts`
  - Add Build retry decision helpers using latest ledger/build-run state.
- `server/services/action-contract-service.ts`
  - Route `retry_build` through the Build retry policy instead of generic gate-only logic.
- `server/services/action-contract-service.test.ts`
  - Prove `retry_build` is disabled for active running Build, enabled for stale retryable Build, and still blocked by base camp blockers.
- `server/services/pipeline-routes.test.ts`
  - Prove the route does not return a fake start when status is invalid and dispatches the retry entrypoint for `retry_build`.
- `server/services/pipeline-service.test.ts` or `server/services/pipeline-build-stage-service.test.ts`
  - Prove retry recovery closes stale metadata and creates the next Build run.

## Definitions

Use these status meanings consistently:

- **active running Build:** latest `runs` row for `phase='implement'` is `running` and has a live associated provider process or has not exceeded the stale threshold.
- **stale running Build:** latest `runs` row is `running`, latest Build workspace JSON is `running`, and it is older than `BUILD_STALE_RUN_MS` with no live provider evidence.
- **retryable Build:** either change is `PLAN_APPROVED` with a passed TestPlan authority, or change is `IMPLEMENTING` with a stale running Build that can be safely recovered before starting the next Build.

Do not rely on process-name matching alone. A live process check may be unavailable in tests and in sandboxed environments. Use age-based stale detection with an injectable clock and optional process probe, then keep the process probe conservative:

```ts
export interface BuildStaleRunRecoveryOptions {
  now?: () => Date;
  staleAfterMs?: number;
  hasLiveProviderProcess?: (input: {
    changeId: string;
    workspacePath: string;
    runId: string;
  }) => boolean | "unknown";
}
```

Default threshold:

```ts
export const DEFAULT_BUILD_STALE_RUN_MS = 30 * 60 * 1000;
```

Export a process-independent predicate for action contracts:

```ts
export function buildRetryStartDecisionFromInspection(
  changeStatus: string,
  inspection: StaleBuildInspection,
): { canStart: boolean; reasonCode: string | null; reason: string | null } {
  if (changeStatus === "PLAN_APPROVED") {
    return { canStart: true, reasonCode: null, reason: null };
  }
  if (changeStatus !== "IMPLEMENTING") {
    return {
      canStart: false,
      reasonCode: "not_at_gate",
      reason: "not_at_gate",
    };
  }
  if (inspection.kind === "active") {
    return {
      canStart: false,
      reasonCode: "build_run_running",
      reason: "Build run is running",
    };
  }
  if (inspection.kind === "none") {
    return {
      canStart: false,
      reasonCode: "no_running_build_run",
      reason: "No running Build run is available to recover before retry",
    };
  }
  return { canStart: true, reasonCode: null, reason: null };
}
```

## Task 1: Add Stale Build Recovery Service

**Files:**
- Create: `server/services/build-stale-run-recovery-service.ts`
- Test: `server/services/build-stale-run-recovery-service.test.ts`

- [ ] **Step 1: Write failing tests for stale detection**

Add tests covering:

```ts
it("reports not stale when no running implement run exists", () => {
  const result = inspectStaleBuildRun("CHG-001", { now: () => new Date("2026-07-08T01:00:00.000Z") });
  assert.equal(result.kind, "none");
});

it("reports active when the running Build is younger than the stale threshold", () => {
  seedChange({ status: "IMPLEMENTING" });
  seedRun({ id: "RUN-009", phase: "implement", status: "running", startedAt: "2026-07-08T00:55:00.000Z" });
  seedBuildRunFile({ runNumber: 1, status: "running", updatedAt: "2026-07-08T00:55:00.000Z" });

  const result = inspectStaleBuildRun("CHG-001", { now: () => new Date("2026-07-08T01:00:00.000Z") });

  assert.equal(result.kind, "active");
});

it("reports stale when the running Build is older than threshold and no live provider exists", () => {
  seedChange({ status: "IMPLEMENTING" });
  seedRun({ id: "RUN-009", phase: "implement", status: "running", startedAt: "2026-07-07T16:11:18.181Z" });
  seedBuildRunFile({ runNumber: 1, status: "running", updatedAt: "2026-07-07T16:11:18.317Z" });

  const result = inspectStaleBuildRun("CHG-001", {
    now: () => new Date("2026-07-08T01:00:00.000Z"),
    hasLiveProviderProcess: () => false,
  });

  assert.equal(result.kind, "stale");
  assert.equal(result.runId, "RUN-009");
  assert.equal(result.buildRun?.runNumber, 1);
});
```

Run:

```bash
pnpm exec tsx --test server/services/build-stale-run-recovery-service.test.ts
```

Expected: tests fail because the service does not exist.

- [ ] **Step 2: Implement read-only inspection**

Create:

```ts
export type StaleBuildInspection =
  | { kind: "none"; reason: "no_running_implement_run" | "change_not_found" | "project_not_found" }
  | { kind: "active"; runId: string; ageMs: number; reason: "below_threshold" | "live_provider_process" | "liveness_unknown" }
  | { kind: "stale"; runId: string; ageMs: number; buildRun: BuildRunFile | null };

export function inspectStaleBuildRun(
  changeId: string,
  options: BuildStaleRunRecoveryOptions = {},
): StaleBuildInspection {
  const now = options.now ?? clockForTest ?? (() => new Date());
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_BUILD_STALE_RUN_MS;
  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  if (!change) return { kind: "none", reason: "change_not_found" };
  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
  if (!project) return { kind: "none", reason: "project_not_found" };
  const runningRun = latestRunningImplementRun(changeId);
  if (!runningRun) return { kind: "none", reason: "no_running_implement_run" };

  const startedAt = new Date(runningRun.startedAt).getTime();
  const ageMs = now().getTime() - startedAt;
  const buildRun = readLatestBuildRun(project.repoPath, changeId);
  if (ageMs < staleAfterMs) {
    return { kind: "active", runId: runningRun.id, ageMs, reason: "below_threshold" };
  }
  const hasLiveProviderProcess = options.hasLiveProviderProcess ?? defaultHasLiveProviderProcess;
  const liveness = buildRun?.workspacePath
    ? hasLiveProviderProcess({ changeId, workspacePath: buildRun.workspacePath, runId: runningRun.id })
    : "unknown";
  if (liveness === "unknown") {
    return { kind: "active", runId: runningRun.id, ageMs, reason: "liveness_unknown" };
  }
  if (
    buildRun?.workspacePath &&
    liveness === true
  ) {
    return { kind: "active", runId: runningRun.id, ageMs, reason: "live_provider_process" };
  }
  return { kind: "stale", runId: runningRun.id, ageMs, buildRun };
}
```

Implement `defaultHasLiveProviderProcess()` conservatively:

```ts
type ProviderLiveness = boolean | "unknown";
let clockForTest: (() => Date) | null = null;
let providerLivenessForTest:
  | ((input: { changeId: string; workspacePath: string; runId: string }) => ProviderLiveness)
  | null = null;

function defaultHasLiveProviderProcess(input: {
  changeId: string;
  workspacePath: string;
  runId: string;
}): ProviderLiveness {
  if (providerLivenessForTest) return providerLivenessForTest(input);
  try {
    const output = execFileSync("lsof", ["-nP"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return output.includes(input.workspacePath);
  } catch {
    return "unknown";
  }
}
```

If the liveness probe cannot run, the service must fail closed by returning `active/liveness_unknown`; recovery and retry are blocked instead of marking a potentially active Build failed.

Also export:

```ts
export function assertRetryBuildCanStart(
  changeStatus: string,
  changeId: string,
  options: BuildStaleRunRecoveryOptions = {},
): void {
  const inspection = inspectStaleBuildRun(changeId, options);
  const decision = buildRetryStartDecisionFromInspection(changeStatus, inspection);
  if (!decision.canStart) {
    throw new PreflightValidationError(
      decision.reasonCode ?? "build_retry_not_allowed",
      decision.reason ?? "Build retry cannot start",
    );
  }
}
```

- [ ] **Step 3: Add recovery tests**

Add tests covering:

```ts
it("marks a stale running Build as failed and returns the change to PLAN_APPROVED", async () => {
  seedChange({ status: "IMPLEMENTING" });
  seedRun({ id: "RUN-009", phase: "implement", status: "running", startedAt: "2026-07-07T16:11:18.181Z" });
  seedBuildRunFile({ runNumber: 1, status: "running", blockers: [] });

  const result = await recoverStaleBuildRun("CHG-001", {
    now: () => new Date("2026-07-08T01:00:00.000Z"),
    hasLiveProviderProcess: () => false,
  });

  assert.equal(result.recovered, true);
  assert.equal(db.select().from(runs).where(eq(runs.id, "RUN-009")).get()?.status, "failed");
  assert.equal(db.select().from(changes).where(eq(changes.id, "CHG-001")).get()?.status, "PLAN_APPROVED");
  assert.equal(readLatestBuildRun(repoPath, "CHG-001")?.status, "failed");
  const buildRecord = db
    .select()
    .from(buildRunRecords)
    .where(and(eq(buildRunRecords.changeId, "CHG-001"), eq(buildRunRecords.buildRunId, "build-1")))
    .get();
  assert.equal(buildRecord?.status, "failed");
});

it("refuses to recover an active running Build", async () => {
  seedChange({ status: "IMPLEMENTING" });
  seedRun({ id: "RUN-009", phase: "implement", status: "running", startedAt: "2026-07-08T00:59:00.000Z" });
  seedBuildRunFile({ runNumber: 1, status: "running" });

  await assert.rejects(
    () => recoverStaleBuildRun("CHG-001", { now: () => new Date("2026-07-08T01:00:00.000Z") }),
    /Build run is still active/,
  );
});

it("refuses to recover an old Build when the provider process is still live", async () => {
  seedChange({ status: "IMPLEMENTING" });
  seedRun({ id: "RUN-009", phase: "implement", status: "running", startedAt: "2026-07-07T16:11:18.181Z" });
  seedBuildRunFile({ runNumber: 1, status: "running" });

  await assert.rejects(
    () => recoverStaleBuildRun("CHG-001", {
      now: () => new Date("2026-07-08T01:00:00.000Z"),
      hasLiveProviderProcess: () => true,
    }),
    /Build run is still active: live_provider_process/,
  );
});

it("refuses to recover an old Build when liveness cannot be checked", async () => {
  seedChange({ status: "IMPLEMENTING" });
  seedRun({ id: "RUN-009", phase: "implement", status: "running", startedAt: "2026-07-07T16:11:18.181Z" });
  seedBuildRunFile({ runNumber: 1, status: "running" });

  await assert.rejects(
    () => recoverStaleBuildRun("CHG-001", {
      now: () => new Date("2026-07-08T01:00:00.000Z"),
      hasLiveProviderProcess: () => "unknown",
    }),
    /Build run is still active: liveness_unknown/,
  );
});
```

- [ ] **Step 4: Implement recovery**

Add:

```ts
export async function recoverStaleBuildRun(
  changeId: string,
  options: BuildStaleRunRecoveryOptions = {},
): Promise<{ recovered: boolean; runId?: string; buildRunNumber?: number; reason: string }> {
  const inspection = inspectStaleBuildRun(changeId, options);
  if (inspection.kind === "none") return { recovered: false, reason: inspection.reason };
  if (inspection.kind === "active") {
    throw new Error(`Build run is still active: ${inspection.reason}`);
  }

  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  if (!change) throw new Error(`Change not found: ${changeId}`);
  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
  if (!project) throw new Error(`Project not found: ${change.projectId}`);

  endRun(inspection.runId, "Build stale recovery: previous provider process exited before completion", false);
  if (inspection.buildRun?.status === "running") {
    markBuildRunFailed({
      repoPath: project.repoPath,
      changeId,
      run: inspection.buildRun,
      reason: "Build stale recovery: previous provider process exited before completion",
    });
  }
  await setStatus(changeId, "PLAN_APPROVED");
  return {
    recovered: true,
    runId: inspection.runId,
    buildRunNumber: inspection.buildRun?.runNumber,
    reason: "stale_build_run_recovered",
  };
}
```

Run:

```bash
pnpm exec tsx --test server/services/build-stale-run-recovery-service.test.ts
```

Expected: all tests pass.

## Task 2: Add Retry Build Entrypoint

**Files:**
- Modify: `server/services/pipeline-build-stage-service.ts`
- Test: `server/services/pipeline-build-stage-service.test.ts`

- [ ] **Step 1: Write failing source contract test**

Add:

```ts
describe("retryBuildStreamed source contract", () => {
  it("recovers stale Build state before starting a new Build", () => {
    const source = readFileSync(
      join(process.cwd(), "server/services/pipeline-build-stage-service.ts"),
      "utf8",
    );

    assert.match(source, /export async function retryBuildStreamed/);
    assert.match(source, /recoverStaleBuildRun\(changeId/);
    assert.match(source, /runImplementStreamed\(changeId\)/);
  });
});
```

Run:

```bash
pnpm exec tsx --test server/services/pipeline-build-stage-service.test.ts
```

Expected: fail because `retryBuildStreamed` does not exist.

- [ ] **Step 2: Implement retry entrypoint**

Add to `server/services/pipeline-build-stage-service.ts`:

```ts
import { recoverStaleBuildRun } from "./build-stale-run-recovery-service";

export async function retryBuildStreamed(changeId: string): Promise<void> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);

  if (change.status === "IMPLEMENTING") {
    const recovery = await recoverStaleBuildRun(changeId);
    if (!recovery.recovered) {
      throw new Error(`Build retry did not recover a stale running run: ${recovery.reason}`);
    }
  }

  const recoveredChange = getChange(changeId);
  if (recoveredChange?.status !== "PLAN_APPROVED") {
    throw new Error(`Build retry recovery left invalid status: ${recoveredChange?.status ?? "missing"}`);
  }
  await runImplementStreamed(changeId);
}
```

Keep `runImplementStreamed()` unchanged except for any extracted helper needed by tests. It should still assert `PLAN_APPROVED` at the start after recovery.

- [ ] **Step 3: Add behavior test for stale retry**

Add a behavior test that seeds a stale `IMPLEMENTING` run and verifies retry starts the next run. Use existing test helpers in `pipeline-service.test.ts` if they already mock the pipeline engine more completely than `pipeline-build-stage-service.test.ts`.

Required assertions:

```ts
assert.equal(previousRun.status, "failed");
assert.equal(previousBuildRun.status, "failed");
assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.runNumber, 2);
assert.equal(latestRun.phase, "implement");
```

Run:

```bash
pnpm exec tsx --test server/services/pipeline-build-stage-service.test.ts server/services/pipeline-service.test.ts
```

Expected: relevant tests pass.

## Task 3: Make Implement Route Action-Aware Before 202

**Files:**
- Modify: `app/api/projects/[id]/changes/[changeId]/implement/route.ts`
- Test: `server/services/pipeline-routes.test.ts`

- [ ] **Step 1: Update route tests**

Replace the source assertion that only matches `runImplementStreamed(changeId)` with assertions for an action-aware dispatch:

```ts
assert.match(implementContent, /const actionId = implementActionId\(payload\.actionId\)/);
assert.match(implementContent, /assertRetryBuildCanStart\(guard\.change\.status, changeId\)/);
assert.match(implementContent, /const runnerName = actionId === "retry_build" \? "retryBuildStreamed" : "runImplementStreamed"/);
assert.match(implementContent, /then\(\(pipeline\) => pipeline\[runnerName\]\(changeId\)\)/);
```

Add a route test:

```ts
it("implement POST dispatches retry_build to retryBuildStreamed", async () => {
  seedRuntimeChange({ status: "IMPLEMENTING", gateState: null });
  seedRuntimeStageGate({
    id: "STG-GATE-BUILD-RETRY",
    phase: "TestPlan",
    sourceDbHash: "testplan-source-hash",
    gateVersion: 8,
  });
  seedRuntimeRunningImplementRun({ startedAt: "2026-07-07T16:11:18.181Z" });
  seedRuntimeBuildRunFile({ runNumber: 1, status: "running", updatedAt: "2026-07-07T16:11:18.317Z" });
  const restoreClock = setBuildStaleRunClockForTest(() => new Date("2026-07-08T01:00:00.000Z"));
  const restoreLiveness = setBuildProviderLivenessForTest(() => false);
  const action = getActions(RUNTIME_CHANGE_ID).find((candidate) => candidate.actionId === "retry_build");
  assert.ok(action);
  assert.equal(action.enabled, true);

  let scheduled = false;
  const originalSetImmediate = globalThis.setImmediate;
  globalThis.setImmediate = ((callback: (...args: unknown[]) => void) => {
    scheduled = true;
    return {} as NodeJS.Immediate;
  }) as typeof setImmediate;
  try {
    const { POST } = await import("../../app/api/projects/[id]/changes/[changeId]/implement/route.ts");
    const response = await POST(
      new Request("http://localhost/api/projects/project/changes/change/implement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: "retry_build",
          expectedGateVersion: action.gateVersion,
          expectedSourceDbHash: action.sourceDbHash,
          idempotencyKey: "retry-build-route-test",
        }),
      }),
      { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
    );

    assert.equal(response.status, 202);
    assert.equal(scheduled, true);
  } finally {
    globalThis.setImmediate = originalSetImmediate;
    restoreLiveness();
    restoreClock();
  }
});
```

Add a route test that proves no fake `202` is returned when the retry is still active:

```ts
it("implement POST rejects retry_build before scheduling when an old Build still has a live provider", async () => {
  seedRuntimeChange({ status: "IMPLEMENTING", gateState: null });
  seedRuntimeStageGate({
    id: "STG-GATE-BUILD-RETRY-ACTIVE",
    phase: "TestPlan",
    sourceDbHash: "testplan-source-hash",
    gateVersion: 8,
  });
  seedRuntimeRunningImplementRun({ startedAt: "2026-07-07T16:11:18.181Z" });
  seedRuntimeBuildRunFile({ runNumber: 1, status: "running", updatedAt: "2026-07-07T16:11:18.317Z" });
  const restoreClock = setBuildStaleRunClockForTest(() => new Date("2026-07-08T01:00:00.000Z"));
  const restoreLiveness = setBuildProviderLivenessForTest(() => true);

  const action = getActions(RUNTIME_CHANGE_ID).find((candidate) => candidate.actionId === "retry_build");
  assert.ok(action);
  assert.equal(action.enabled, false);
  assert.equal(action.reasonCode, "build_run_running");

  try {
    const { POST } = await import("../../app/api/projects/[id]/changes/[changeId]/implement/route.ts");
    const response = await POST(
      new Request("http://localhost/api/projects/project/changes/change/implement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: "retry_build",
          expectedGateVersion: action.gateVersion,
          expectedSourceDbHash: action.sourceDbHash,
          idempotencyKey: "retry-build-active-route-test",
        }),
      }),
      { params: Promise.resolve({ id: RUNTIME_PROJECT_ID, changeId: RUNTIME_CHANGE_ID }) },
    );

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.reasonCode, "build_run_running");
  } finally {
    restoreLiveness();
    restoreClock();
  }
});
```

- [ ] **Step 2: Implement action-aware dispatch**

Import `assertRetryBuildCanStart`:

```ts
import { assertRetryBuildCanStart } from "@/server/services/build-stale-run-recovery-service";
```

Before `setImmediate`, add the synchronous retry preflight:

```ts
if (actionId === "retry_build") {
  assertRetryBuildCanStart(guard.change.status, changeId);
}
```

Change the async block:

```ts
const runnerName = actionId === "retry_build" ? "retryBuildStreamed" : "runImplementStreamed";
setImmediate(() => {
  import("@/server/services/pipeline-service")
    .then((pipeline) => pipeline[runnerName](changeId))
    .catch((err) => {
      log.error({ changeId, actionId, err: String(err) }, "Implement streaming failed");
    });
});
```

Ensure `server/services/pipeline-service.ts` re-exports `retryBuildStreamed`.

Run:

```bash
pnpm exec tsx --test server/services/pipeline-routes.test.ts
```

Expected: route tests pass.

## Task 4: Fix `retry_build` Action Contract

**Files:**
- Modify: `server/services/action-contract-build-policy.ts`
- Modify: `server/services/action-contract-service.ts`
- Test: `server/services/action-contract-service.test.ts`

- [ ] **Step 1: Add action contract tests**

Add tests:

```ts
it("disables retry_build when a Build run is actively running", () => {
  initCleanGitRepo(repoPath);
  db.update(changes).set({ status: "IMPLEMENTING" }).where(eq(changes.id, CHANGE_ID)).run();
  seedStageGate("TestPlan", "passed", "testplan-source-hash");
  seedRunningImplementRun({ startedAt: new Date().toISOString() });
  seedBuildRunRecord({ status: "running", updatedAt: new Date().toISOString() });

  const retryBuild = getActions(CHANGE_ID).find((action) => action.actionId === "retry_build");

  assert.equal(retryBuild?.enabled, false);
  assert.equal(retryBuild?.reasonCode, "build_run_running");
});

it("disables retry_build when an old running Build still has a live provider", () => {
  initCleanGitRepo(repoPath);
  db.update(changes).set({ status: "IMPLEMENTING" }).where(eq(changes.id, CHANGE_ID)).run();
  seedStageGate("TestPlan", "passed", "testplan-source-hash");
  seedRunningImplementRun({ startedAt: "2026-07-07T16:11:18.181Z" });
  seedBuildRunFile({ runNumber: 1, status: "running", updatedAt: "2026-07-07T16:11:18.317Z" });
  seedBuildRunRecord({ status: "running", updatedAt: "2026-07-07T16:11:18.317Z" });
  const restoreClock = setBuildStaleRunClockForTest(() => new Date("2026-07-08T01:00:00.000Z"));
  const restoreLiveness = setBuildProviderLivenessForTest(() => true);

  try {
    const retryBuild = getActions(CHANGE_ID).find((action) => action.actionId === "retry_build");

    assert.equal(retryBuild?.enabled, false);
    assert.equal(retryBuild?.reasonCode, "build_run_running");
  } finally {
    restoreLiveness();
    restoreClock();
  }
});

it("enables retry_build when IMPLEMENTING has a stale running Build", () => {
  initCleanGitRepo(repoPath);
  db.update(changes).set({ status: "IMPLEMENTING" }).where(eq(changes.id, CHANGE_ID)).run();
  seedStageGate("TestPlan", "passed", "testplan-source-hash");
  seedRunningImplementRun({ startedAt: "2026-07-07T16:11:18.181Z" });
  seedBuildRunFile({ runNumber: 1, status: "running", updatedAt: "2026-07-07T16:11:18.317Z" });
  seedBuildRunRecord({ status: "running", updatedAt: "2026-07-07T16:11:18.317Z" });

  const restoreClock = setBuildStaleRunClockForTest(() => new Date("2026-07-08T01:00:00.000Z"));
  const restoreLiveness = setBuildProviderLivenessForTest(() => false);
  try {
    const retryBuild = getActions(CHANGE_ID).find((action) => action.actionId === "retry_build");

    assert.equal(retryBuild?.enabled, true);
    assert.equal(retryBuild?.reasonCode, null);
  } finally {
    restoreLiveness();
    restoreClock();
  }
});
```

Inject the clock at policy helper level for tests rather than introducing global mutable time. Do this by exporting a test-only setter from `build-stale-run-recovery-service.ts`:

```ts
export function setBuildStaleRunClockForTest(clock: (() => Date) | null): () => void {
  const previous = clockForTest;
  clockForTest = clock;
  return () => {
    clockForTest = previous;
  };
}

export function setBuildProviderLivenessForTest(
  probe: ((input: { changeId: string; workspacePath: string; runId: string }) => boolean | "unknown") | null,
): () => void {
  const previous = providerLivenessForTest;
  providerLivenessForTest = probe;
  return () => {
    providerLivenessForTest = previous;
  };
}
```

- [ ] **Step 2: Implement retry policy**

Add:

```ts
import { buildRetryStartDecisionFromInspection, inspectStaleBuildRun } from "./build-stale-run-recovery-service";

export function retryBuildDecision(
  db: ActionContractDb,
  changeId: string,
  changeStatus: string,
  baseGate: ActionDecision,
): ActionDecision {
  if (changeStatus === "PLAN_APPROVED") return baseGate;
  if (changeStatus !== "IMPLEMENTING") {
    return {
      enabled: false,
      reasonCode: "not_at_gate",
      reason: "not_at_gate",
      blockers: [],
    };
  }
  const retryStart = buildRetryStartDecisionFromInspection(changeStatus, inspectStaleBuildRun(changeId));
  if (!retryStart.canStart) {
    return {
      enabled: false,
      reasonCode: retryStart.reasonCode,
      reason: retryStart.reason,
      blockers: [],
    };
  }
  return baseGate.enabled
    ? baseGate
    : {
        enabled: false,
        reasonCode: baseGate.reasonCode,
        reason: baseGate.reason,
        blockers: baseGate.blockers,
      };
}
```

Then wire `retry_build` separately in `action-contract-service.ts`:

```ts
if (definition.actionId === "run_build") {
  const gate = options.selfHeal
    ? selfHealLegacyTestPlanApprovalForBuild(changeId, changeStatus, base)
    : base;
  return buildBaseCampDecision(changeId, repoPath, gate);
}
if (definition.actionId === "retry_build") {
  const gate = options.selfHeal
    ? selfHealLegacyTestPlanApprovalForBuild(changeId, changeStatus, base)
    : base;
  return buildBaseCampDecision(
    changeId,
    repoPath,
    retryBuildDecision(getActionContractDb(), changeId, changeStatus, gate),
  );
}
```

Do not let the generic retry-output override re-enable `retry_build`. `retry_build` has its own stateful policy, so change the final decision assembly in `action-contract-service.ts`:

```ts
const retryPhase = retryOutputPhase(definition.actionId);
const retrySignal = retryPhase ? signalFor(retryPhase) : null;
const decision = retryPhase && definition.actionId !== "retry_build"
  ? applyStageOutputRetry(baseDecision, retrySignal, snapshot)
  : baseDecision;
```

Add regression tests:

```ts
it("keeps retry_build disabled for active running Build even when prior Build output is retryable", () => {
  initCleanGitRepo(repoPath);
  db.update(changes).set({ status: "IMPLEMENTING" }).where(eq(changes.id, CHANGE_ID)).run();
  seedStageGate("TestPlan", "passed", "testplan-source-hash");
  seedRunningImplementRun({ startedAt: new Date().toISOString() });
  seedBuildRunRecord({ status: "running", updatedAt: new Date().toISOString() });
  seedRetryableStageOutputSignal({ phase: "Build", errorCode: "provider_timeout" });

  const retryBuild = getActions(CHANGE_ID).find((action) => action.actionId === "retry_build");

  assert.equal(retryBuild?.enabled, false);
  assert.equal(retryBuild?.reasonCode, "build_run_running");
});

it("keeps retry_build disabled outside the Build gate even when prior Build output is retryable", () => {
  initCleanGitRepo(repoPath);
  db.update(changes).set({ status: "TESTPLAN_DONE" }).where(eq(changes.id, CHANGE_ID)).run();
  seedStageGate("TestPlan", "passed", "testplan-source-hash");
  seedRetryableStageOutputSignal({ phase: "Build", errorCode: "provider_timeout" });

  const retryBuild = getActions(CHANGE_ID).find((action) => action.actionId === "retry_build");

  assert.equal(retryBuild?.enabled, false);
  assert.equal(retryBuild?.reasonCode, "not_at_gate");
});

it("keeps retry_build disabled when base camp is blocked even when prior Build output is retryable", () => {
  db.update(changes).set({ status: "PLAN_APPROVED" }).where(eq(changes.id, CHANGE_ID)).run();
  seedStageGate("TestPlan", "passed", "testplan-source-hash");
  seedRetryableStageOutputSignal({ phase: "Build", errorCode: "provider_timeout" });

  const retryBuild = getActions(CHANGE_ID).find((action) => action.actionId === "retry_build");

  assert.equal(retryBuild?.enabled, false);
  assert.equal(retryBuild?.reasonCode, "build_base_camp_blocked");
});
```

This keeps `retry_build` enabled only when the same inspection service says the current state is safe to retry. The route still calls `assertRetryBuildCanStart(guard.change.status, changeId)` immediately before scheduling so a stale-to-active race becomes a `409`, not a fake `202`.

Run:

```bash
pnpm exec tsx --test server/services/action-contract-service.test.ts
```

Expected: action contract tests pass and no existing Build gate tests regress.

## Task 5: Make Build UI Reflect Retry Blockers

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/build-sandbox.tsx`
- Test: `app/projects/[id]/changes/[changeId]/build-sandbox.test.ts`

- [ ] **Step 1: Show accurate active-running UI state**

When `retry_build` is disabled with `build_run_running`, the Build page should show:

```tsx
<p className="text-xs text-muted-foreground">
  Build run is still recorded as running. Recovery is required before retry.
</p>
```

Do not show "重新开始 Build" as enabled unless the backend can actually dispatch a retry.

- [ ] **Step 2: Test UI source contract**

Add a test asserting the Build page exposes the disabled reason and does not call `/implement` when `retry_build` is disabled.

Run:

```bash
pnpm exec tsx --test server/services/pipeline-routes.test.ts app/projects/[id]/changes/[changeId]/build-sandbox.test.ts
```

Expected: tests pass.

## Task 6: One-Time Recovery Procedure For Current CHG-001

**Files:**
- No committed code file.
- Use `retry_build` after Tasks 1-5 are merged; it will recover stale `RUN-009` and then start `build-2`.

- [ ] **Step 1: Confirm no active Build provider process**

Run:

```bash
ps -axo pid,ppid,lstart,etime,command | rg -i 'claude|CHG-001|build-1|cc-ai'
lsof -c claude | rg -i 'CHG-001|build-1|某个本地项目|cc-ai'
```

Expected for recovery: no Claude process has cwd/open files under `<home>/Desktop/.cc-ai-workspaces/某个本地项目/CHG-001/build-1`.

- [ ] **Step 2: Invoke recovery**

Use `retry_build` from the Build page or POST `/implement` with `actionId: "retry_build"`. Expected intermediate recovery result in logs or event details:

```json
{
  "recovered": true,
  "runId": "RUN-009",
  "buildRunNumber": 1,
  "reason": "stale_build_run_recovered"
}
```

- [ ] **Step 3: Verify DB and workspace state**

Run:

```bash
sqlite3 server/db/ship.db "select id, phase, status, ended_at, summary from runs where id='RUN-009'; select id, status from changes where id='CHG-001';"
```

Expected:

```text
RUN-009|implement|failed|<non-null>|Build stale recovery: previous provider process exited before completion
CHG-001|PLAN_APPROVED
```

Also verify:

```bash
cat '<a local project>/.ship/changes/CHG-001/build/runs/build-1.json'
```

Expected: `"status": "failed"` and blocker text contains `Build stale recovery`.

## Verification Checklist

Run these before considering the fix ready:

```bash
pnpm exec tsx --test server/services/build-stale-run-recovery-service.test.ts
pnpm exec tsx --test server/services/pipeline-build-stage-service.test.ts
pnpm exec tsx --test server/services/action-contract-service.test.ts
pnpm exec tsx --test server/services/pipeline-routes.test.ts
pnpm exec tsx --test app/projects/[id]/changes/[changeId]/build-sandbox.test.ts
pnpm exec tsc --noEmit
```

Manual acceptance:

1. Open `http://localhost:3000/projects/PRJ-001/changes/CHG-001`.
2. If Build is active, retry must be disabled with `build_run_running`.
3. If Build is stale, retry must be enabled.
4. Clicking Build retry must close `RUN-009`, mark `build-1` failed, and create `build-2`.
5. A Claude process or provider stream must be visible for the new Build run.
6. The route must not return `202` when it already knows the action cannot start.

## Rollback Plan

If recovery behavior is wrong:

1. Do not delete workspace directories.
2. Revert only the recovery service/route/action-contract code changes from this plan.
3. Restore `CHG-001` by DB backup if the one-time recovery was run incorrectly.
4. Leave `RUN-009` failed rather than running unless a real provider process is confirmed.

## Reviewer Checklist

- `retry_build` is not enabled for active running Build state.
- `retry_build` is enabled for stale running Build state.
- `/implement` re-checks retry start safety before returning `202`.
- Stale recovery changes both ledger `runs` and Build workspace JSON/DB record.
- Recovery returns `CHG-001` to `PLAN_APPROVED` before calling `runImplementStreamed()`.
- The next retry creates `build-2`; it does not reuse or overwrite `build-1`.
- No test requires a real Claude process.
