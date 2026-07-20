# Build Onwards Blocker Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock `pnpm build` and repair the Build/Fix/Review/QA pipeline self-lock caused by ambiguous `IMPLEMENTING` semantics and unsafe legacy status repair.

**Architecture:** Use the smallest compatible state model change: keep `CHECK_FAILED` as the short-term canonical status for Review blockers, keep `IMPLEMENTING` only for active/awaiting-human Build/Fix work, and make UI/action contracts derive availability from the same backend preflight rules. Treat Build stage authority as a verification task after the main state loop is fixed, with `build_run_records` as the short-term factual source.

**Tech Stack:** Next.js 16, TypeScript, Node test runner, Drizzle ORM, SQLite, React client components.

---

## Source Context

Primary diagnosis: `docs/build-onwards-blocker-root-cause-report-2026-07-06.md`

Default decisions from the report:

- Short term: `CHECK_FAILED` remains the canonical Review blocker state.
- This repair does not introduce `REVIEW_BLOCKED`.
- Build factual state comes from `build_run_records` until P1 verification proves stage authority is fully synchronized.
- Scripts/tests must not be part of production `next build` type checking.

## File Map

- Modify `tsconfig.json`: exclude scripts, tests, temp artifacts, archived scratch files from production Next build type checking.
- Modify `scripts/e2e-test-chg-002.ts`: import Playwright from the declared `@playwright/test` package.
- Modify `server/services/pipeline-state-transition-service.ts`: make Review transition helpers match the short-term canonical state model; make legacy repair diagnostic-only or remove its ability to direct-update statuses.
- Modify or create `server/scripts/repair-stuck-review-blockers.ts`: provide an audited recovery path for records already polluted to `IMPLEMENTING`.
- Modify `scripts/test-and-fix-chg-002.ts`: stop mutating DB through `fixLegacyCheckFailedStates()`.
- Modify tests in `server/state-machine/transitions.test.ts` and/or create `server/services/pipeline-state-transition-service.test.ts`: lock down illegal `CHECK_FAILED -> IMPLEMENTING` and canonical Review status behavior.
- Modify `server/services/action-contract-review-policy.ts`: include status compatibility in `fix_blockers` availability.
- Modify `server/services/action-contract-service.test.ts`: verify `fix_blockers` is disabled when current status cannot run Fix.
- Modify `app/projects/[id]/changes/[changeId]/change-phase-map.ts`: add explicit awaiting-human helper that does not rely only on `latestRun.phase === "implement"`.
- Modify `app/projects/[id]/changes/[changeId]/page.tsx`: prioritize BuildSandbox when an awaiting-human Build/Fix run needs absorb/reject.
- Modify `app/projects/[id]/changes/[changeId]/build-sandbox.tsx`: refresh workspace state when parent data changes or the component is visible after a background run.
- Modify `app/projects/[id]/changes/[changeId]/build-sandbox.test.ts`: lock down the UI visibility/refresh contract.
- Optionally modify `server/services/build-workspace-service.ts` or `server/services/stage-authority-service.ts` after verification in Task 7 if Build stage authority is stale in real read paths.

---

## Task 1: Fix Production Build Type Boundary

**Files:**
- Modify: `tsconfig.json`
- Modify: `scripts/e2e-test-chg-002.ts`

- [ ] **Step 1: Confirm current build failure**

Run:

```bash
pnpm build
```

Expected before implementation:

```text
Type error: Cannot find module 'playwright' or its corresponding type declarations.
```

If sandbox blocks Turbopack with `Operation not permitted`, rerun outside sandbox or treat the prior report's verified failure as the baseline.

- [ ] **Step 2: Exclude non-production TypeScript from Next build**

Change `tsconfig.json` from:

```json
"exclude": ["node_modules"]
```

to:

```json
"exclude": [
  "node_modules",
  "scripts/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "tmp-*",
  "docs/archive/**"
]
```

Rationale: `next build` should type-check production app/server modules, not one-off scripts or test fixtures.

- [ ] **Step 3: Use the declared Playwright package in the script**

Change `scripts/e2e-test-chg-002.ts`:

```ts
import { chromium, type Browser, type Page } from "playwright";
```

to:

```ts
import { chromium, type Browser, type Page } from "@playwright/test";
```

Rationale: `package.json` declares `@playwright/test`, not `playwright`.

- [ ] **Step 4: Verify production build progresses past the previous failure**

Run:

```bash
pnpm build
```

Expected after implementation:

```text
✓ Compiled successfully
```

and no `Cannot find module 'playwright'` error. If a later unrelated TypeScript error appears, record it separately; do not widen this task unless the error is caused by the type boundary change.

- [ ] **Step 5: Verify app tests still run through the existing script**

Run:

```bash
pnpm test
```

Expected: existing test suite runs. If failures pre-exist or are unrelated to this task, capture exact failing test names and continue only after confirming Task 1 did not cause them.

- [ ] **Step 6: Commit Task 1**

```bash
git add tsconfig.json scripts/e2e-test-chg-002.ts
git commit -m "fix: narrow production build type scope"
```

---

## Task 2: Stop Unsafe Legacy Status Repair

**Files:**
- Modify: `server/services/pipeline-state-transition-service.ts`
- Modify: `scripts/test-and-fix-chg-002.ts`
- Test: `server/state-machine/transitions.test.ts`
- Test: create `server/services/pipeline-state-transition-service.test.ts` if direct service coverage is clearer than extending existing tests.

- [ ] **Step 1: Add a state-machine regression test for illegal `CHECK_FAILED -> IMPLEMENTING`**

Append to `server/state-machine/transitions.test.ts`:

```ts
it("rejects direct CHECK_FAILED to IMPLEMENTING repair transitions", () => {
  assert.throws(
    () => assertLegalTransition("CHECK_FAILED", "IMPLEMENTING"),
    IllegalTransitionError,
  );
});
```

- [ ] **Step 2: Run the state-machine regression**

Run:

```bash
pnpm exec tsx --test server/state-machine/transitions.test.ts
```

Expected: PASS. This confirms the transition is already illegal and documents why direct DB repair is forbidden.

- [ ] **Step 3: Change `fixLegacyCheckFailedStates()` into diagnostic-only output**

Replace the mutating body in `server/services/pipeline-state-transition-service.ts` with a diagnostic result. Use this shape:

```ts
export interface LegacyCheckFailedDiagnostic {
  changeId: string;
  reviewGate: string;
  currentStatus: ChangeStatus;
  recommendedStatus: ChangeStatus;
  reason: string;
}

export function findLegacyCheckFailedStates(): {
  candidates: LegacyCheckFailedDiagnostic[];
  total: number;
} {
  const checkFailedChanges = db
    .select()
    .from(changes)
    .where(eq(changes.status, "CHECK_FAILED"))
    .all();

  const candidates: LegacyCheckFailedDiagnostic[] = [];
  for (const change of checkFailedChanges) {
    const reviewState = getReviewCenterState(change.id);
    if (reviewState.gate === "blocked_p0" || reviewState.gate === "blocked_p1") {
      candidates.push({
        changeId: change.id,
        reviewGate: reviewState.gate,
        currentStatus: "CHECK_FAILED",
        recommendedStatus: "CHECK_FAILED",
        reason: "Review blockers should remain CHECK_FAILED until Fix starts.",
      });
    }
  }

  return { candidates, total: checkFailedChanges.length };
}

export function fixLegacyCheckFailedStates() {
  const diagnostics = findLegacyCheckFailedStates();
  log.warn(
    { candidates: diagnostics.candidates.length, total: diagnostics.total },
    "Legacy CHECK_FAILED repair is diagnostic-only; no statuses were changed",
  );
  return {
    fixed: 0,
    total: diagnostics.total,
    candidates: diagnostics.candidates,
  };
}
```

Important: Do not call `db.update(changes)` in this function.

- [ ] **Step 4: Update `statusAfterReview()` to match the short-term canonical state**

In `server/services/pipeline-state-transition-service.ts`, update `statusAfterReview()` cases:

```ts
case "blocked_p0":
case "blocked_p1":
  log.info({ changeId, gate: reviewState.gate }, "Review has blockers, transitioning to CHECK_FAILED");
  return "CHECK_FAILED";

case "stale":
  return "CHECK_FAILED";

case "passed":
  log.info({ changeId }, "Review passed, ready for Check");
  return "IMPLEMENTED";
```

Keep `"not_started"`/`"running"` returning `"REVIEWING"` and `"failed"` returning `"BLOCKED"`.

- [ ] **Step 5: Update `getDisplayPhase()` for Review blockers**

In `server/services/pipeline-state-transition-service.ts`, change the `CHECK_FAILED` case from the old QA-only copy to Review-aware display:

```ts
case "CHECK_FAILED":
  if (reviewState.gate === "blocked_p0" || reviewState.gate === "blocked_p1") {
    return "Fix";
  }
  return "Check Failed";
```

Remove comments that say `CHECK_FAILED` should only happen after QA failure. Short term, `CHECK_FAILED` is also the Review blocker state.

- [ ] **Step 6: Update the script so it cannot mutate DB**

Change `scripts/test-and-fix-chg-002.ts` from:

```ts
import { statusAfterReview, canEnterCheck, fixLegacyCheckFailedStates } from "../server/services/pipeline-state-transition-service";
```

to:

```ts
import { statusAfterReview, canEnterCheck, findLegacyCheckFailedStates } from "../server/services/pipeline-state-transition-service";
```

Replace:

```ts
console.log("\n=== Fix Legacy States ===\n");

const fixResult = fixLegacyCheckFailedStates();
console.log(`Fixed ${fixResult.fixed} of ${fixResult.total} CHECK_FAILED changes`);
```

with:

```ts
console.log("\n=== Legacy CHECK_FAILED Diagnostics ===\n");

const diagnostics = findLegacyCheckFailedStates();
console.log(`Found ${diagnostics.candidates.length} candidate(s) out of ${diagnostics.total} CHECK_FAILED changes`);
for (const candidate of diagnostics.candidates) {
  console.log(`  ${candidate.changeId}: ${candidate.currentStatus} remains ${candidate.recommendedStatus} (${candidate.reviewGate})`);
}
```

- [ ] **Step 7: Add service-level tests for canonical Review status and display**

Create `server/services/pipeline-state-transition-service.test.ts` with a lightweight source-level assertion if full DB seeding is too heavy:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.join(process.cwd(), "server/services/pipeline-state-transition-service.ts"),
  "utf-8",
);

describe("pipeline state transition service source contract", () => {
  it("does not direct-update CHECK_FAILED changes to IMPLEMENTING", () => {
    assert.doesNotMatch(source, /\.set\(\{\s*status:\s*"IMPLEMENTING"/);
    assert.match(source, /findLegacyCheckFailedStates/);
    assert.match(source, /diagnostic-only/);
  });

  it("keeps Review blocker and passed statuses aligned with production Review service", () => {
    assert.match(source, /case "blocked_p0":[\s\S]*return "CHECK_FAILED"/);
    assert.match(source, /case "blocked_p1":[\s\S]*return "CHECK_FAILED"/);
    assert.match(source, /case "passed":[\s\S]*return "IMPLEMENTED"/);
  });

  it("displays CHECK_FAILED Review blockers as Fix instead of QA failure", () => {
    assert.match(source, /case "CHECK_FAILED":[\s\S]*reviewState\.gate === "blocked_p0"[\s\S]*return "Fix"/);
    assert.doesNotMatch(source, /CHECK_FAILED is for QA failures, NOT Review blockers/);
  });
});
```

- [ ] **Step 8: Run Task 2 tests**

Run:

```bash
pnpm exec tsx --test server/state-machine/transitions.test.ts server/services/pipeline-state-transition-service.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add server/state-machine/transitions.test.ts server/services/pipeline-state-transition-service.ts server/services/pipeline-state-transition-service.test.ts scripts/test-and-fix-chg-002.ts
git commit -m "fix: make legacy check-failed repair diagnostic only"
```

---

## Task 3: Add Audited Recovery for Already-Polluted Statuses

**Files:**
- Create: `server/scripts/repair-stuck-review-blockers.ts`
- Test: `server/state-machine/transitions.test.ts`
- Test: `server/services/pipeline-state-transition-service.test.ts`

This task handles records that were already changed to `IMPLEMENTING` by the unsafe legacy repair. Because `IMPLEMENTING -> CHECK_FAILED` is not a legal transition, recovery must use a legal two-step transition:

```text
IMPLEMENTING -> BLOCKED -> CHECK_FAILED
```

Both steps must go through `transitionChangeStatus()` so the event ledger records the recovery.

- [ ] **Step 1: Add a transition regression for the legal recovery path**

Append to `server/state-machine/transitions.test.ts`:

```ts
it("allows audited recovery from polluted IMPLEMENTING through BLOCKED to CHECK_FAILED", () => {
  assert.doesNotThrow(() => assertLegalTransition("IMPLEMENTING", "BLOCKED"));
  assert.doesNotThrow(() => assertLegalTransition("BLOCKED", "CHECK_FAILED"));
  assert.throws(
    () => assertLegalTransition("IMPLEMENTING", "CHECK_FAILED"),
    IllegalTransitionError,
  );
});
```

- [ ] **Step 2: Create a dry-run-first repair script**

Create `server/scripts/repair-stuck-review-blockers.ts`:

```ts
#!/usr/bin/env tsx
import { and, desc, eq } from "drizzle-orm";

import { db } from "../db";
import { buildRunRecords, changes, runs } from "../db/schema";
import { transitionChangeStatus } from "../services/change-status-service";
import { getReviewCenterState } from "../services/review-center-state-service";

const apply = process.argv.includes("--apply");

function latestBuildRecord(changeId: string) {
  return db
    .select()
    .from(buildRunRecords)
    .where(eq(buildRunRecords.changeId, changeId))
    .orderBy(desc(buildRunRecords.updatedAt))
    .limit(1)
    .get();
}

function hasRunningRun(changeId: string): boolean {
  return Boolean(
    db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.changeId, changeId), eq(runs.status, "running")))
      .limit(1)
      .get(),
  );
}

function isAwaitingHumanBuildOrFix(changeId: string): boolean {
  const latestBuild = latestBuildRecord(changeId);
  return latestBuild?.status === "awaiting_human" || latestBuild?.status === "approved_for_absorb";
}

const candidates = db
  .select()
  .from(changes)
  .where(eq(changes.status, "IMPLEMENTING"))
  .all()
  .filter((change) => {
    const reviewState = getReviewCenterState(change.id);
    return (
      (reviewState.gate === "blocked_p0" || reviewState.gate === "blocked_p1") &&
      !hasRunningRun(change.id) &&
      !isAwaitingHumanBuildOrFix(change.id)
    );
  });

console.log(`Found ${candidates.length} polluted IMPLEMENTING review blocker candidate(s).`);

for (const change of candidates) {
  const reviewState = getReviewCenterState(change.id);
  console.log(`${apply ? "Repairing" : "Would repair"} ${change.id}: review gate ${reviewState.gate}`);
  if (!apply) continue;

  transitionChangeStatus({
    changeId: change.id,
    to: "BLOCKED",
    blockedPhase: "review",
    message: "Recovery: polluted IMPLEMENTING review blocker marked BLOCKED before canonical CHECK_FAILED restore",
    rawJson: { recovery: "polluted_implementing_review_blocker", reviewGate: reviewState.gate },
  });
  transitionChangeStatus({
    changeId: change.id,
    to: "CHECK_FAILED",
    message: "Recovery: restored Review blocker to canonical CHECK_FAILED",
    rawJson: { recovery: "polluted_implementing_review_blocker", reviewGate: reviewState.gate },
  });
}

if (!apply) {
  console.log("Dry run only. Re-run with --apply to write audited status transitions.");
}
```

This script must remain dry-run by default.

- [ ] **Step 3: Add a source contract test for the recovery script**

Extend `server/services/pipeline-state-transition-service.test.ts` or create `server/scripts/repair-stuck-review-blockers.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.join(process.cwd(), "server/scripts/repair-stuck-review-blockers.ts"),
  "utf-8",
);

describe("repair-stuck-review-blockers script", () => {
  it("uses audited legal transitions and defaults to dry run", () => {
    assert.match(source, /const apply = process\.argv\.includes\("--apply"\)/);
    assert.match(source, /to: "BLOCKED"/);
    assert.match(source, /to: "CHECK_FAILED"/);
    assert.match(source, /transitionChangeStatus/);
    assert.doesNotMatch(source, /\.update\(changes\)/);
  });

  it("does not repair active or awaiting-human Build\/Fix work", () => {
    assert.match(source, /hasRunningRun/);
    assert.match(source, /isAwaitingHumanBuildOrFix/);
    assert.match(source, /awaiting_human/);
    assert.match(source, /approved_for_absorb/);
  });
});
```

- [ ] **Step 4: Run recovery script in dry-run mode**

Run:

```bash
pnpm exec tsx server/scripts/repair-stuck-review-blockers.ts
```

Expected: prints candidate count and `Dry run only`. It must not change DB rows.

- [ ] **Step 5: Apply recovery only after reviewing candidates**

If the dry run lists `CHG-002` or other expected polluted records, run:

```bash
pnpm exec tsx server/scripts/repair-stuck-review-blockers.ts --apply
```

Expected: each repaired change gets two `change_status_changed` events:

- `IMPLEMENTING -> BLOCKED`
- `BLOCKED -> CHECK_FAILED`

Do not apply if the candidate has an active running run or an awaiting-human build/fix record.

- [ ] **Step 6: Run Task 3 tests**

Run:

```bash
pnpm exec tsx --test server/state-machine/transitions.test.ts server/services/pipeline-state-transition-service.test.ts server/scripts/repair-stuck-review-blockers.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add server/state-machine/transitions.test.ts server/scripts/repair-stuck-review-blockers.ts server/scripts/repair-stuck-review-blockers.test.ts server/services/pipeline-state-transition-service.test.ts
git commit -m "fix: add audited recovery for stuck review blockers"
```

---

## Task 4: Align Action Contract With Fix/Review Preconditions

**Files:**
- Modify: `server/services/action-contract-review-policy.ts`
- Modify: `server/services/action-contract-service.ts` only if current status is not available to review policy yet.
- Test: `server/services/action-contract-service.test.ts`

- [ ] **Step 1: Add a failing action-contract test for `fix_blockers` at `IMPLEMENTING`**

In `server/services/action-contract-service.test.ts`, add a test near existing Review action tests:

```ts
it("disables fix_blockers when Review blockers exist but the change status cannot run Fix", () => {
  seedReviewWithOpenP0();
  db.update(changes)
    .set({ status: "IMPLEMENTING" })
    .where(eq(changes.id, CHANGE_ID))
    .run();

  const actions = getActions(CHANGE_ID);
  const fixBlockers = actions.find((action) => action.actionId === "fix_blockers");

  assert.equal(fixBlockers?.enabled, false);
  assert.equal(fixBlockers?.reasonCode, "not_at_gate");
  assert.equal(fixBlockers?.reason, "Fix can only run from CHECK_FAILED or SCOPE_FAILED.");
});
```

This test should fail before implementation because `reviewControlDecision()` currently enables `fix_blockers` based only on blocker count.

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm exec tsx --test server/services/action-contract-service.test.ts
```

Expected before implementation: the new test FAILS because `fix_blockers.enabled` is `true`.

- [ ] **Step 3: Pass current status into Review control decision**

In `server/services/action-contract-service.ts`, change the call:

```ts
return reviewControlDecision(getActionContractDb(), changeId, definition.actionId);
```

to:

```ts
return reviewControlDecision(getActionContractDb(), changeId, definition.actionId, changeStatus);
```

Then update the function signature in `server/services/action-contract-review-policy.ts`:

```ts
export function reviewControlDecision(
  db: ActionContractDb,
  changeId: string,
  actionId: string,
  changeStatus?: string,
): ActionDecision {
```

- [ ] **Step 4: Gate `fix_blockers` by actual Fix service allowed statuses**

In `server/services/action-contract-review-policy.ts`, update the `fix_blockers` branch:

```ts
if (actionId === "fix_blockers") {
  const blockers = reviewFindingBlockers(db, changeId);
  if (blockers.length === 0) {
    return {
      enabled: false,
      reasonCode: "no_review_blockers",
      reason: "No open P0/P1 blockers need a fix command.",
      blockers,
      ...source,
    };
  }
  if (changeStatus && changeStatus !== "CHECK_FAILED" && changeStatus !== "SCOPE_FAILED") {
    return {
      enabled: false,
      reasonCode: "not_at_gate",
      reason: "Fix can only run from CHECK_FAILED or SCOPE_FAILED.",
      blockers,
      ...source,
    };
  }
  return {
    enabled: true,
    reasonCode: null,
    reason: null,
    blockers,
    ...source,
  };
}
```

- [ ] **Step 5: Verify Review action contract behavior**

Run:

```bash
pnpm exec tsx --test server/services/action-contract-service.test.ts
```

Expected: PASS, including the new `fix_blockers` status gate.

- [ ] **Step 6: Verify route source still uses action contract preflight**

Run:

```bash
pnpm exec tsx --test server/services/pipeline-routes.test.ts
```

Expected: PASS. If unrelated route tests fail, record exact failures and confirm no regression in `fix`, `review`, or `check` route preflight tests.

- [ ] **Step 7: Commit Task 4**

```bash
git add server/services/action-contract-service.ts server/services/action-contract-review-policy.ts server/services/action-contract-service.test.ts
git commit -m "fix: align review fix action with service preflight"
```

---

## Task 5: Make Build/Fix Awaiting-Human UI Explicit

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/change-phase-map.ts`
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/build-sandbox.tsx`
- Test: `app/projects/[id]/changes/[changeId]/build-sandbox.test.ts`

- [ ] **Step 1: Add source-level regression tests for awaiting-human routing**

In `app/projects/[id]/changes/[changeId]/build-sandbox.test.ts`, replace the old assertions that expect broad `change.status === "IMPLEMENTING"` BuildSandbox routing and `Build 待收编` copy with the explicit helper contract below.

Remove or update assertions matching:

```ts
assert.match(pageSource, /const showingBuildSandbox = activeSelectedPhase === "Build" \|\|[\s\S]*change\.status === "IMPLEMENTING";/);
assert.match(phaseMapSource, /Build 待收编/);
```

Add:

```ts
it("prioritizes BuildSandbox when a Build or Fix run awaits human absorption", () => {
  assert.match(phaseMapSource, /function isBuildOrFixAwaitingHuman\(change: ChangeDetail\)/);
  assert.match(phaseMapSource, /change\.latestRun\?\.phase === "implement" \|\| change\.latestRun\?\.phase === "fix_findings"/);
  assert.match(phaseMapSource, /change\.latestRun\.status === "completed"/);
  assert.match(pageSource, /const buildOrFixAwaitingHuman = isBuildOrFixAwaitingHuman\(change\)/);
  assert.match(pageSource, /const showingBuildSandbox = activeSelectedPhase === "Build" \|\| buildOrFixAwaitingHuman/);
});

it("refreshes BuildSandbox when parent change data changes", () => {
  assert.match(componentSource, /refreshToken\?: string | number | null/);
  assert.match(componentSource, /useEffect\(\(\) => \{[\s\S]*void load\(\)[\s\S]*\}, \[load, refreshToken\]\)/);
});
```

Expected before implementation: FAIL.

- [ ] **Step 2: Run the failing UI source tests**

Run:

```bash
pnpm exec tsx --test 'app/projects/[id]/changes/[changeId]/build-sandbox.test.ts'
```

Expected before implementation: FAIL on the two new assertions.

- [ ] **Step 3: Replace the narrow awaiting helper**

In `change-phase-map.ts`, replace:

```ts
export function isBuildAwaitingHuman(change: ChangeDetail): boolean {
  return change.status === "IMPLEMENTING" &&
    change.latestRun?.phase === "implement" &&
    change.latestRun.status === "completed";
}
```

with:

```ts
export function isBuildOrFixAwaitingHuman(change: ChangeDetail): boolean {
  return change.status === "IMPLEMENTING" &&
    (change.latestRun?.phase === "implement" || change.latestRun?.phase === "fix_findings") &&
    change.latestRun.status === "completed";
}
```

Update `visibleChangeStatus()`:

```ts
if (isBuildOrFixAwaitingHuman(change)) return "Build/Fix 待收编";
```

Remove or keep `isBuildAwaitingHuman()` only as a wrapper if other call sites still use it:

```ts
export function isBuildAwaitingHuman(change: ChangeDetail): boolean {
  return isBuildOrFixAwaitingHuman(change);
}
```

- [ ] **Step 4: Map failed Fix runs to the Fix phase**

In `change-phase-map.ts`, update `getReviewPhaseForRunPhase()` from:

```ts
if (phase === "fix") return "Fix";
```

to:

```ts
if (phase === "fix" || phase === "fix_findings") return "Fix";
```

This keeps failed Fix runs from falling back to the wrong phase.

- [ ] **Step 5: Route awaiting-human changes to BuildSandbox**

In `page.tsx`, import the helper:

```ts
import {
  getDefaultReviewPhaseForChange,
  getReviewPhaseForRunPhase,
  isBuildOrFixAwaitingHuman,
  shouldPollChangeDetailParent,
  visibleChangeStatus,
  type ReviewPhase,
} from "./change-phase-map";
```

Near `activeSelectedPhase`, add:

```ts
const buildOrFixAwaitingHuman = isBuildOrFixAwaitingHuman(change);
```

Change:

```ts
const showingBuildSandbox = activeSelectedPhase === "Build";
```

to:

```ts
const showingBuildSandbox = activeSelectedPhase === "Build" || buildOrFixAwaitingHuman;
```

Do not route `IMPLEMENTED` to BuildSandbox; the existing Review actions must remain visible after absorb.

- [ ] **Step 6: Give BuildSandbox a parent refresh token**

In `build-sandbox.tsx`, add an optional prop:

```ts
refreshToken?: string | number | null;
```

Use it in the effect that loads workspace state:

```ts
useEffect(() => {
  void load();
}, [load, refreshToken]);
```

If `load` is not already stable, wrap it in `useCallback` first:

```ts
const load = useCallback(async (options?: { preserveError?: boolean }) => {
  // existing load body, unchanged
}, [projectId, changeId]);
```

- [ ] **Step 7: Pass the refresh token from the page**

In `page.tsx`, pass a stable token based on data that changes after background runs:

```tsx
<BuildSandbox
  projectId={projectId}
  changeId={changeId}
  actions={pipelineActions}
  refreshToken={`${change.status}:${change.latestRun?.id ?? "none"}:${change.latestRun?.status ?? "none"}:${change.updatedAt ?? ""}`}
  onChanged={handleBuildSandboxChanged}
/>
```

If `ChangeDetail` does not expose `updatedAt`, omit it from the token:

```tsx
refreshToken={`${change.status}:${change.latestRun?.id ?? "none"}:${change.latestRun?.status ?? "none"}`}
```

- [ ] **Step 8: Verify UI source tests**

Run:

```bash
pnpm exec tsx --test 'app/projects/[id]/changes/[changeId]/build-sandbox.test.ts'
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

```bash
git add 'app/projects/[id]/changes/[changeId]/change-phase-map.ts' 'app/projects/[id]/changes/[changeId]/page.tsx' 'app/projects/[id]/changes/[changeId]/build-sandbox.tsx' 'app/projects/[id]/changes/[changeId]/build-sandbox.test.ts'
git commit -m "fix: surface awaiting build and fix absorption"
```

---

## Task 6: Verify the End-to-End Review/Fix/Review State Loop

**Files:**
- Modify: `server/services/pipeline-service.test.ts` if an existing review/fix state-loop test is available.
- Modify: `server/services/action-contract-service.test.ts`
- Modify: `server/services/pipeline-state-transition-service.test.ts`

- [ ] **Step 1: Add or extend a service-level scenario for Review blockers**

Use the existing DB seeding helpers in `server/services/action-contract-service.test.ts` to assert this sequence:

```ts
it("keeps Review blockers in CHECK_FAILED so Fix and retry Review can proceed", () => {
  seedReviewWithOpenP0();
  db.update(changes)
    .set({ status: "CHECK_FAILED" })
    .where(eq(changes.id, CHANGE_ID))
    .run();

  const actions = getActions(CHANGE_ID);
  const fixBlockers = actions.find((action) => action.actionId === "fix_blockers");
  const retryReview = actions.find((action) => action.actionId === "retry_review");

  assert.equal(fixBlockers?.enabled, true);
  assert.equal(fixBlockers?.reasonCode, null);
  assert.equal(retryReview?.enabled, true);
});
```

If `retry_review` is intentionally disabled while blockers are open, replace the final assertion with the intended disabled reason and add an explicit note in the test name. The critical invariant is: `fix_blockers` must be enabled from `CHECK_FAILED`.

- [ ] **Step 2: Verify Fix service still rejects illegal status**

Add a source-level assertion to `server/services/pipeline-build-stage-service.test.ts`:

```ts
it("keeps Fix service limited to CHECK_FAILED and SCOPE_FAILED", () => {
  const source = readFileSync(
    join(process.cwd(), "server/services/pipeline-build-stage-service.ts"),
    "utf-8",
  );
  assert.match(source, /assertStatus\(change, "CHECK_FAILED", "SCOPE_FAILED"\)/);
});
```

Add imports if needed:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
```

- [ ] **Step 3: Run focused state/action tests**

Run:

```bash
pnpm exec tsx --test server/services/action-contract-service.test.ts server/services/pipeline-build-stage-service.test.ts server/services/pipeline-state-transition-service.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run pipeline route tests**

Run:

```bash
pnpm exec tsx --test server/services/pipeline-routes.test.ts
```

Expected: PASS. Pay special attention to `review`, `fix`, and `check` route preflight tests.

- [ ] **Step 5: Commit Task 6**

```bash
git add server/services/action-contract-service.test.ts server/services/pipeline-build-stage-service.test.ts server/services/pipeline-state-transition-service.test.ts
git commit -m "test: cover build review fix state loop"
```

---

## Task 7: Verify Build Stage Authority Read Paths

**Files:**
- Inspect: `server/services/merge-readiness-service.ts`
- Inspect: `server/services/action-contract-service.ts`
- Inspect: `server/services/change-phase-service.ts`
- Modify only if tests prove stale Build gate is still read.
- Test: `server/services/merge-readiness-service.test.ts`
- Test: `server/services/action-contract-service.test.ts`
- Test: `server/services/change-phase-service.test.ts`

- [ ] **Step 1: Preserve the existing Merge readiness self-heal test**

`server/services/merge-readiness-service.test.ts` already has this coverage:

```ts
it("self-heals missing Build and Review gates from current DB facts before Merge approval", () => {
  seedHappyPath(repoPath);
  db.delete(mergeApprovals).where(eq(mergeApprovals.changeId, CHANGE_ID)).run();
  db.delete(stageGates)
    .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Build")))
    .run();
  db.delete(stageGates)
    .where(and(eq(stageGates.changeId, CHANGE_ID), eq(stageGates.phase, "Review")))
    .run();

  const readiness = computeMergeReadiness(CHANGE_ID);
  const actions = getActions(CHANGE_ID);
  const approveMerge = actions.find((candidate) => candidate.actionId === "approve_merge");
  const merge = actions.find((candidate) => candidate.actionId === "merge");
  const blockers = readiness.blockers.map((blocker) => blocker.reasonCode);
  const healedGates = db
    .select()
    .from(stageGates)
    .where(eq(stageGates.changeId, CHANGE_ID))
    .all();

  assert.deepEqual(blockers, ["merge_approval_missing"]);
  assert.equal(approveMerge?.enabled, true);
  assert.equal(approveMerge?.reasonCode, null);
  assert.equal(merge?.enabled, false);
  assert.equal(merge?.reasonCode, "merge_approval_missing");
  assert.equal(healedGates.some((gate) => gate.phase === "Build" && gate.status === "passed"), true);
  assert.equal(healedGates.some((gate) => gate.phase === "Review" && gate.status === "passed"), true);
});
```

Do not replace this with a weaker test. Task 7 should only add more tests if another read path is proven stale.

- [ ] **Step 2: Verify phase overview source for Build**

Inspect `server/services/change-phase-service.ts` and identify how Build phase status is derived:

```bash
rg -n "Build|buildRunRecords|stageGates|stageStates" server/services/change-phase-service.ts server/services/action-contract-service.ts server/services/merge-readiness-service.ts
```

Expected:

- If Build phase status reads only artifacts/runs and not stale `stage_gates`, no code change is required.
- If Build phase status reads stale `stage_gates`, add a test that seeds an adopted build record with no Build gate and expects Build phase to show a non-blocked/adopted state.

- [ ] **Step 3: Choose one synchronization strategy only if tests prove drift**

If tests expose stale Build stage authority, implement one of these:

Strategy A, refresh stage gate after collect/adopt:

```ts
recomputeStageGate({
  changeId,
  phase: "Build",
  status: adopted.status === "adopted" ? "passed" : "blocked",
  blockers: [],
  freshness: {
    fresh: true,
    sourceBuildRunId: adopted.buildRunId ?? adopted.id,
    sourceHeadSha: adopted.adoptedHeadSha ?? adopted.headSha,
  },
  requiredActions: [],
  rows: [{
    table: "build_run_records",
    id: adopted.id,
    buildRunId: adopted.buildRunId ?? adopted.id,
    status: adopted.status,
  }],
  computedAt: new Date().toISOString(),
});
```

Strategy B, make the read path explicitly use `build_run_records` and ignore stale Build stage gates for Build status.

Do not implement both.

- [ ] **Step 4: Run stage-authority related tests**

Run:

```bash
pnpm exec tsx --test server/services/merge-readiness-service.test.ts server/services/action-contract-service.test.ts server/services/change-phase-service.test.ts
```

Expected: PASS. If Task 7 made no code changes, document that current self-heal/read paths are sufficient.

- [ ] **Step 5: Commit Task 7**

If code changed:

```bash
git add server/services/merge-readiness-service.test.ts server/services/action-contract-service.test.ts server/services/change-phase-service.test.ts server/services/build-workspace-service.ts server/services/stage-authority-service.ts
git commit -m "fix: align build stage authority with adopted build records"
```

If only tests/docs changed:

```bash
git add server/services/merge-readiness-service.test.ts server/services/action-contract-service.test.ts server/services/change-phase-service.test.ts
git commit -m "test: verify build stage authority read paths"
```

---

## Final Verification

- [ ] **Run the focused test suite**

```bash
pnpm exec tsx --test \
  server/state-machine/transitions.test.ts \
  server/scripts/repair-stuck-review-blockers.test.ts \
  server/services/pipeline-state-transition-service.test.ts \
  server/services/action-contract-service.test.ts \
  server/services/pipeline-build-stage-service.test.ts \
  server/services/pipeline-routes.test.ts \
  'app/projects/[id]/changes/[changeId]/build-sandbox.test.ts'
```

Expected: PASS.

- [ ] **Run the package test suite**

```bash
pnpm test
```

Expected: PASS, or only documented unrelated failures.

- [ ] **Run production build**

```bash
pnpm build
```

Expected:

```text
✓ Compiled successfully
```

No `Cannot find module 'playwright'` error.

- [ ] **Manual smoke check for `CHG-002`**

Start the app:

```bash
pnpm dev
```

Open the affected change page. Verify:

- If Review blockers exist, visible status is `CHECK_FAILED` or equivalent blocker copy, not a silent `IMPLEMENTING`.
- `fix_blockers` is available only when `POST /fix` can actually pass service status preflight.
- If a Build/Fix workspace awaits absorb, BuildSandbox is visible without manually selecting the Build tab.
- After absorb, Review actions are visible and `retry_review` reaches route preflight.

---

## Self-Review

Spec coverage:

- Build failure fixed by Task 1.
- Unsafe legacy repair fixed by Task 2.
- Review blocker canonical state fixed by Tasks 2, 3, and 6.
- Action contract/preflight mismatch fixed by Task 4.
- BuildSandbox visibility/refresh fixed by Task 5.
- Stage authority risk verified by Task 7.

Placeholder scan:

- No task uses "TBD" or "implement later" as an executable instruction.
- Task 7 contains a conditional branch because the source report marks stage authority as a待验证风险; both allowed strategies and verification commands are specified.

Type consistency:

- `CHECK_FAILED` remains the short-term Review blocker state.
- `IMPLEMENTED` remains Review-passed / ready-for-QA state.
- `IMPLEMENTING` remains active or awaiting-human Build/Fix state only.
