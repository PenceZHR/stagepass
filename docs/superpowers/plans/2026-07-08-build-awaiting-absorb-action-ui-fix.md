# Build Awaiting Absorb Action UI Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Build run has completed and is waiting for human absorption, the Build page must present "收编 Build" as the only primary next action and must not surface stale retry/reject errors as if the Build were broken.

**Architecture:** Keep backend action contracts as the source of truth. Add a small frontend policy module that decides which Build/Fix actions should be published to the shared stage header and when stale action errors should be cleared. Start/retry actions are for not-started or stale-running Build states, absorb is for `approved_for_absorb` / awaiting absorption states, and reject follows the backend contract except that disabled reject is not shown in `approved_for_absorb`.

**Tech Stack:** Next.js App Router, React client components, existing `PipelineActionContract`, Node test assertions using `node:test`.

---

## Root Cause

Current observed state for `CHG-001`:

- Latest implement run `RUN-010` is `completed`.
- Latest Build workspace run `build-2` is `approved_for_absorb`.
- `adopt_build` is enabled.
- `retry_build` is disabled with `no_running_build_run`.
- `reject_build` is disabled with `Build run is approved_for_absorb`.

The UI still shows disabled retry/reject reasons and can preserve a prior `action_not_allowed` error, which makes a healthy "待收编" state look like a failure. The page should guide the user to the valid next action: `收编 Build`.

## Files

- Create: `app/projects/[id]/changes/[changeId]/build-action-policy.ts`
  - Own pure action visibility and stale-error signature helpers.
- Create: `app/projects/[id]/changes/[changeId]/build-action-policy.test.ts`
  - Directly test policy outcomes without relying on source regex.
- Modify: `app/projects/[id]/changes/[changeId]/build-sandbox.tsx`
  - Add Build-status-aware visibility for start/adopt/reject actions.
  - Clear stale action errors when the visible action set changes after refresh.
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
  - Keep disabled `fix_blockers` from taking the first primary slot during Fix awaiting absorption.
- Modify: `app/projects/[id]/changes/[changeId]/build-sandbox.test.ts`
  - Keep existing source-level integration assertions aligned with the new policy import.
- Optional modify: `app/projects/[id]/changes/[changeId]/stage-action-bar.tsx`
  - Only if hidden disabled actions still leak reasons through the shared action bar after BuildSandbox filtering.

## Non-Goals

- Do not change backend gate semantics.
- Do not allow `reject_build` for `approved_for_absorb` unless a separate product decision explicitly changes that state machine.
- Do not auto-adopt Build output.
- Do not start or stop any Claude process.
- Do not mutate existing `CHG-001` database state as part of implementation.

## Task 1: Add Build Action Visibility Policy

**Files:**
- Create: `app/projects/[id]/changes/[changeId]/build-action-policy.ts`
- Create: `app/projects/[id]/changes/[changeId]/build-action-policy.test.ts`
- Modify: `app/projects/[id]/changes/[changeId]/build-sandbox.tsx`
- Test: `app/projects/[id]/changes/[changeId]/build-sandbox.test.ts`

- [ ] **Step 1: Write the failing policy test**

Create `build-action-policy.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildVisibleActionSlots,
  type BuildActionPolicyAction,
  type BuildActionPolicyRun,
} from "./build-action-policy";

function action(
  actionId: string,
  enabled: boolean,
  reasonCode: string | null = null,
): BuildActionPolicyAction {
  return { actionId, enabled, reasonCode };
}

function run(status: BuildActionPolicyRun["status"], purpose: BuildActionPolicyRun["purpose"] = "build"): BuildActionPolicyRun {
  return { status, purpose };
}

describe("build action policy", () => {
  it("publishes only adopt while Build is approved for absorb", () => {
    const slots = buildVisibleActionSlots({
      buildRun: run("approved_for_absorb"),
      startAction: action("retry_build", false, "no_running_build_run"),
      adoptAction: action("adopt_build", true),
      rejectAction: action("reject_build", false, "build_not_rejectable"),
    });

    assert.deepEqual(slots.map((slot) => slot.id), ["build-adopt"]);
  });

  it("keeps reject visible for awaiting_human when the backend allows it", () => {
    const slots = buildVisibleActionSlots({
      buildRun: run("awaiting_human"),
      startAction: action("retry_build", false, "not_at_gate"),
      adoptAction: action("adopt_build", false, "build_not_approved_for_absorb"),
      rejectAction: action("reject_build", true),
    });

    assert.deepEqual(slots.map((slot) => slot.id), ["build-reject"]);
  });

  it("keeps the stale-running retry blocker visible", () => {
    const slots = buildVisibleActionSlots({
      buildRun: run("running"),
      startAction: action("retry_build", false, "build_run_running"),
      adoptAction: action("adopt_build", false, "build_not_awaiting_absorb"),
      rejectAction: action("reject_build", false, "build_not_rejectable"),
    });

    assert.deepEqual(slots.map((slot) => slot.id), ["build-start"]);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --import tsx -e "await import('./app/projects/[id]/changes/[changeId]/build-action-policy.test.ts')"
```

Expected: FAIL because `build-action-policy.ts` does not exist yet.

- [ ] **Step 3: Add the pure policy module**

Create `build-action-policy.ts`:

```ts
export type BuildActionPolicyRunStatus =
  | "created"
  | "running"
  | "gate_blocked"
  | "awaiting_human"
  | "approved_for_absorb"
  | "audit_ready"
  | "adopted"
  | "rejected"
  | "failed";

export interface BuildActionPolicyRun {
  status: BuildActionPolicyRunStatus;
  purpose?: "build" | "fix";
}

export interface BuildActionPolicyAction {
  actionId: string;
  enabled: boolean;
  reasonCode: string | null;
}

export interface BuildActionSlot {
  id: "build-start" | "build-adopt" | "build-reject";
}

export function isBuildApprovedForAbsorb(buildRun: BuildActionPolicyRun | null): boolean {
  return buildRun?.status === "approved_for_absorb";
}

export function shouldShowBuildStartAction(
  buildRun: BuildActionPolicyRun | null,
  action: BuildActionPolicyAction | null,
): boolean {
  if (!action) return false;
  if (buildRun?.status === "approved_for_absorb" || buildRun?.status === "awaiting_human") return false;
  return action.enabled || action.reasonCode === "build_run_running";
}

export function shouldShowBuildAdoptAction(
  buildRun: BuildActionPolicyRun | null,
  action: BuildActionPolicyAction | null,
): boolean {
  if (!action) return false;
  return action.enabled || isBuildApprovedForAbsorb(buildRun);
}

export function shouldShowBuildRejectAction(
  buildRun: BuildActionPolicyRun | null,
  action: BuildActionPolicyAction | null,
): boolean {
  if (!action) return false;
  if (isBuildApprovedForAbsorb(buildRun)) return false;
  return action.enabled;
}

export function buildVisibleActionSlots(input: {
  buildRun: BuildActionPolicyRun | null;
  startAction: BuildActionPolicyAction | null;
  adoptAction: BuildActionPolicyAction | null;
  rejectAction: BuildActionPolicyAction | null;
}): BuildActionSlot[] {
  const slots: BuildActionSlot[] = [];
  if (shouldShowBuildStartAction(input.buildRun, input.startAction)) slots.push({ id: "build-start" });
  if (shouldShowBuildAdoptAction(input.buildRun, input.adoptAction)) slots.push({ id: "build-adopt" });
  if (shouldShowBuildRejectAction(input.buildRun, input.rejectAction)) slots.push({ id: "build-reject" });
  return slots;
}
```

Rationale:

- Start/retry should disappear once there is a Build waiting to be absorbed.
- A stale-running blocker may still be visible because it explains why retry recovery is blocked.
- Reject should disappear in `approved_for_absorb` because the backend rejects it and the next valid action is absorb.
- Reject should remain visible in `awaiting_human` when the backend enables it.

- [ ] **Step 4: Import the policy and filter stage actions before publishing them**

In `build-sandbox.tsx`, add:

```tsx
import {
  shouldShowBuildAdoptAction,
  shouldShowBuildRejectAction,
  shouldShowBuildStartAction,
} from "./build-action-policy";
```

Replace the current `stageActions = useMemo<StageActionView[]>(() => [ ... ])` block with:

```tsx
const showStartBuildAction = shouldShowBuildStartAction(buildRun, startBuildAction ?? null);
const showApproveAbsorbAction = shouldShowBuildAdoptAction(buildRun, approveAbsorbAction ?? null);
const showRejectBuildAction = shouldShowBuildRejectAction(buildRun, rejectBuildAction ?? null);

const stageActions = useMemo<StageActionView[]>(() => {
  const nextActions: StageActionView[] = [];

  if (showStartBuildAction) {
    nextActions.push({
      id: "build-start",
      label: startBuildAction?.label ?? "开始 Build",
      role: "primary",
      enabled: !isBuildActionBusy && canStartBuild,
      busy: busyAction === "start_build",
      disabledReason: startBuildReason,
      sourceActionId: startBuildAction?.actionId,
      onAction: runBuildStart,
    });
  }

  if (showApproveAbsorbAction) {
    nextActions.push({
      id: "build-adopt",
      label: approveAbsorbAction?.label ?? "批准收编",
      role: "primary",
      enabled: !isBuildActionBusy && canApproveAbsorb,
      busy: busyAction === "approve_absorb",
      disabledReason: approveAbsorbReason,
      sourceActionId: approveAbsorbAction?.actionId,
      onAction: () => runBuildAction("approve_absorb"),
    });
  }

  if (showRejectBuildAction) {
    nextActions.push({
      id: "build-reject",
      label: rejectBuildAction?.label ?? "请求修改 / 拒绝本轮 Build",
      role: "destructive",
      enabled: !isBuildActionBusy && canRejectBuild,
      busy: busyAction === "reject_build",
      disabledReason: rejectBuildReason,
      sourceActionId: rejectBuildAction?.actionId,
      onAction: () => runBuildAction("reject_build"),
    });
  }

  return nextActions;
}, [
  showStartBuildAction,
  showApproveAbsorbAction,
  showRejectBuildAction,
  startBuildAction?.label,
  startBuildAction?.actionId,
  isBuildActionBusy,
  canStartBuild,
  busyAction,
  startBuildReason,
  runBuildStart,
  approveAbsorbAction?.label,
  approveAbsorbAction?.actionId,
  canApproveAbsorb,
  approveAbsorbReason,
  runBuildAction,
  rejectBuildAction?.label,
  rejectBuildAction?.actionId,
  canRejectBuild,
  rejectBuildReason,
]);
```

- [ ] **Step 5: Verify the test passes**

Run:

```bash
node --import tsx -e "await import('./app/projects/[id]/changes/[changeId]/build-action-policy.test.ts')"
```

Expected: PASS.

## Task 2: Clear Stale Build Action Errors After Real Action Set Changes

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/build-sandbox.tsx`
- Test: `app/projects/[id]/changes/[changeId]/build-action-policy.test.ts`

- [ ] **Step 1: Write the failing policy tests**

Add these tests to `build-action-policy.test.ts`:

```ts
it("does not change the stale-error signature for busy or enabled-only changes", () => {
  const before = buildActionErrorSignature({
    buildRun: run("approved_for_absorb"),
    slots: [{ id: "build-adopt", sourceActionId: "adopt_build" }],
  });
  const after = buildActionErrorSignature({
    buildRun: run("approved_for_absorb"),
    slots: [{ id: "build-adopt", sourceActionId: "adopt_build" }],
  });

  assert.equal(before, after);
});

it("changes the stale-error signature when retry/reject noise collapses to adopt only", () => {
  const before = buildActionErrorSignature({
    buildRun: run("running"),
    slots: [
      { id: "build-start", sourceActionId: "retry_build" },
      { id: "build-adopt", sourceActionId: "adopt_build" },
      { id: "build-reject", sourceActionId: "reject_build" },
    ],
  });
  const after = buildActionErrorSignature({
    buildRun: run("approved_for_absorb"),
    slots: [{ id: "build-adopt", sourceActionId: "adopt_build" }],
  });

  assert.notEqual(before, after);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --import tsx -e "await import('./app/projects/[id]/changes/[changeId]/build-action-policy.test.ts')"
```

Expected: FAIL because `buildActionErrorSignature` does not exist yet.

- [ ] **Step 3: Add `buildActionErrorSignature` to the policy module**

Append this function to `build-action-policy.ts`:

```ts
export function buildActionErrorSignature(input: {
  buildRun: BuildActionPolicyRun | null;
  slots: Array<{ id: string; sourceActionId?: string | null }>;
}): string {
  const status = input.buildRun?.status ?? "none";
  const purpose = input.buildRun?.purpose ?? "none";
  const slotSignature = input.slots
    .map((slot) => `${slot.id}:${slot.sourceActionId ?? ""}`)
    .join("|");
  return `${status}:${purpose}:${slotSignature}`;
}
```

- [ ] **Step 4: Add the stale-error clearing effect using the pure signature**

Add `buildActionErrorSignature` to the existing `build-action-policy` import in `build-sandbox.tsx`:

```tsx
import {
  buildActionErrorSignature,
  shouldShowBuildAdoptAction,
  shouldShowBuildRejectAction,
  shouldShowBuildStartAction,
} from "./build-action-policy";
```

In `build-sandbox.tsx`, after `stageActions` is defined and before `onStageActionsChange`, add:

```tsx
const stageActionSignature = useMemo(
  () => buildActionErrorSignature({ buildRun, slots: stageActions }),
  [buildRun, stageActions],
);

useEffect(() => {
  setError(null);
}, [stageActionSignature]);
```

Rationale: an `action_not_allowed` error from a previous invalid click should not survive after refresh changes the available action set to the correct "收编 Build" state. The signature intentionally excludes `busy` and effective `enabled` so a failed POST followed by `busyAction` changing back to `null` does not immediately clear the real error.

- [ ] **Step 5: Verify the test passes**

Run:

```bash
node --import tsx -e "await import('./app/projects/[id]/changes/[changeId]/build-action-policy.test.ts')"
```

Expected: PASS.

## Task 3: Prevent Fix-Stage `fix_blockers` From Masking Awaiting-Absorb Actions

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Test: `app/projects/[id]/changes/[changeId]/build-sandbox.test.ts`

- [ ] **Step 1: Write the failing source integration test**

Add to `build-sandbox.test.ts`:

```ts
it("does not prepend disabled fix_blockers ahead of BuildSandbox actions in Fix", () => {
  assert.match(pageSource, /const hasFixBlockerAction = disabledReason === null;/);
  assert.match(pageSource, /if \(!hasFixBlockerAction\) return buildStageActions;/);
  assert.doesNotMatch(pageSource, /return \[fixBlockersStageAction, \.\.\.buildStageActions\];/);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --import tsx -e "await import('./app/projects/[id]/changes/[changeId]/build-sandbox.test.ts')"
```

Expected: FAIL because `page.tsx` currently always prepends `fixBlockersStageAction` in Fix.

- [ ] **Step 3: Filter disabled `fix_blockers`**

In `page.tsx`, inside `buildOrFixStageActions`, after `const disabledReason = pipelineActionDisabledReason(fixBlockersAction);`, add:

```tsx
const hasFixBlockerAction = disabledReason === null;
if (!hasFixBlockerAction) return buildStageActions;
```

Keep the existing `fixBlockersStageAction` construction below that guard. This preserves backend authority: `fix_blockers` appears only when backend enables it.

- [ ] **Step 4: Verify the test passes**

Run:

```bash
node --import tsx -e "await import('./app/projects/[id]/changes/[changeId]/build-sandbox.test.ts')"
```

Expected: PASS.

## Task 4: End-to-End Manual Verification

**Files:**
- No code files beyond Tasks 1-3.

- [ ] **Step 1: Confirm current API state**

Run:

```bash
curl -s http://localhost:3000/api/projects/PRJ-001/changes/CHG-001/gate
curl -s http://localhost:3000/api/projects/PRJ-001/changes/CHG-001/build-workspace
```

Expected:

- `adopt_build.enabled` is `true`.
- `retry_build.enabled` is `false`.
- `buildRun.status` is `approved_for_absorb`.

- [ ] **Step 2: Open the Build page**

Manual check:

- The header action area shows `收编 Build`.
- The header action area does not show `重新开始 Build` while `buildRun.status` is `approved_for_absorb`.
- The header action area does not show disabled `拒绝本轮施工` while backend reports `build_not_rejectable`.
- There is no lingering red `action_not_allowed` after the page refreshes into the current state.

- [ ] **Step 3: Run full focused checks**

Run:

```bash
node --import tsx -e "await import('./app/projects/[id]/changes/[changeId]/build-action-policy.test.ts')"
node --import tsx -e "await import('./app/projects/[id]/changes/[changeId]/build-sandbox.test.ts')"
pnpm exec tsc --noEmit
```

Expected: both commands pass.

## Acceptance Criteria

- In `approved_for_absorb` Build/Fix states, the primary visible action is `收编 Build` / `收编 Fix`.
- In `awaiting_human`, `reject_build` remains visible when backend enables it.
- Disabled `retry_build` reason `no_running_build_run` is not shown during `approved_for_absorb` or `awaiting_human`.
- Disabled `reject_build` reason `Build run is approved_for_absorb` is not shown during `approved_for_absorb`.
- A previous `action_not_allowed` message is cleared once the action set refreshes to the correct state.
- A real failed POST error is not immediately cleared just because a busy state flips back.
- Disabled `fix_blockers` does not appear ahead of `收编 Fix`.
- Stale-running Build still shows the recovery-related retry blocker.
- Backend action contracts remain unchanged.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Hiding disabled actions may hide useful diagnostics | Medium | Keep `build_run_running` retry blocker visible; hide disabled reject only in `approved_for_absorb`, where the next action is unambiguous. |
| Clearing errors too aggressively could hide a real failed POST | Medium | Clear only when the action signature changes after refresh, not on every render. |
| Source tests may be brittle | Low | Put core behavior in `build-action-policy.test.ts`; keep source tests only for parent wiring. |

## Review Checklist

- [ ] Does the plan preserve backend state-machine authority?
- [ ] Does the plan address the exact screenshot state: completed Build awaiting absorption?
- [ ] Does it avoid changing process recovery or Claude lifecycle?
- [ ] Does it leave a clear path to verify the UI and TypeScript build?
