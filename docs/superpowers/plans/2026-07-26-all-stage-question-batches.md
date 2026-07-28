# All-stage Codex Question Batches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the concrete 1–10 question StagePass card loop to every canonical stage and expose the same rule in each stage's compact Web view.

**Architecture:** Add one framework-neutral stage clarification registry under `lib/`. Pass the persisted logical phase into `createCodexDesktopRunContext`, resolve its policy, and append stage-specific blocking guidance to every Codex stage turn. Render the selected policy in the existing shared Web stage shell without changing the three-column page structure.

**Tech Stack:** TypeScript, React 19, Next.js 16, Node test runner, Codex Desktop follower bridge.

---

### Task 1: Lock the shared all-stage policy contract

**Files:**
- Create: `lib/stage-clarification-policy.test.ts`
- Create: `lib/stage-clarification-policy.ts`

- [ ] **Step 1: Write the failing coverage test**

Assert that the registry contains exactly:

```ts
[
  "prd",
  "spec",
  "tech_spec",
  "plan",
  "test_plan",
  "build",
  "review",
  "fix",
  "qa",
  "merge",
  "retro",
  "done",
]
```

For every entry, require a label, objective, Web summary, completion rule, at
least three concrete example questions, and aliases that resolve the persisted
backend phase.

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm exec tsx --test lib/stage-clarification-policy.test.ts
```

Expected: fail because the registry does not exist.

- [ ] **Step 3: Implement the registry and alias resolver**

Export:

```ts
export const STAGE_CLARIFICATION_ORDER = [
  "prd", "spec", "tech_spec", "plan", "test_plan", "build",
  "review", "fix", "qa", "merge", "retro", "done",
] as const;

export function resolveStageClarificationPolicy(
  phase: string,
): StageClarificationPolicy;
```

Unknown phases must resolve to a safe generic policy that still requires
concrete questions, a maximum of ten questions, and convergence before output.

- [ ] **Step 4: Run the policy test**

Run the Task 1 command. Expected: pass.

### Task 2: Inject the correct policy into every Codex stage turn

**Files:**
- Modify: `server/services/codex-desktop-run-context.ts`
- Modify: `server/services/codex-desktop-run-context.test.ts`
- Modify: `server/services/codex-desktop-engine.ts`

- [ ] **Step 1: Write failing backend tests**

For every canonical policy, build a Codex run context with its persisted phase
alias and assert that the prompt includes:

```text
stageClarificationPolicy=<stage id>
one to ten concrete requirement questions
formal stage result only when no execution blocker remains
```

Also assert that each policy contributes at least one stage-specific concrete
question example.

- [ ] **Step 2: Run the backend test and verify it fails**

Run:

```bash
pnpm exec tsx --test server/services/codex-desktop-run-context.test.ts
```

Expected: fail because run context has no phase-specific policy.

- [ ] **Step 3: Pass the persisted phase into run context**

Add `phase: string` to `CodexDesktopRunContextInput` and call it with
`logical.phase` from the production desktop bridge.

- [ ] **Step 4: Append stage-specific convergence instructions**

The generated prompt must tell Codex to use the current policy only as
specificity guidance, ask only unresolved blockers, present at most ten
questions per batch, summarize confirmed answers, repeat in the same task, and
withhold formal output until convergence.

- [ ] **Step 5: Run the backend test**

Run the Task 2 command. Expected: pass.

### Task 3: Apply the same policy to every Web stage view

**Files:**
- Create: `app/projects/[id]/changes/[changeId]/stage-codex-workspace.tsx`
- Create: `app/projects/[id]/changes/[changeId]/stage-codex-workspace.test.ts`
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/codex-task-control.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/codex-task-control.test.ts`
- Modify: `app/projects/[id]/changes/[changeId]/phase-review.test.ts`

- [ ] **Step 1: Write failing component and source-boundary tests**

Render every canonical stage and assert that it shows the selected stage label,
`每批最多 10 个具体问题`, and the stage-specific Web summary. Assert that the
change page still mounts one shared stage shell and no phase-specific Web
workspace.

- [ ] **Step 2: Run the UI tests and verify they fail**

Run:

```bash
pnpm exec tsx \
  'app/projects/[id]/changes/[changeId]/stage-codex-workspace.test.ts'
pnpm exec tsx \
  'app/projects/[id]/changes/[changeId]/codex-task-control.test.ts'
pnpm exec tsx \
  'app/projects/[id]/changes/[changeId]/phase-review.test.ts'
```

Expected: the new shared workspace test fails because the component is absent.

- [ ] **Step 3: Implement the compact shared stage workspace**

The component receives the selected `UiStageId`, Codex state, and the existing
`CodexTaskControl`. It renders no forms or stage actions; it only explains the
iterative card loop and shows the one start/open bridge.

- [ ] **Step 4: Fix bridge action semantics**

When a task is already bound, always render an open-task action. Render the
start/retry action only when the selected current stage has an enabled pipeline
run action. Do not expose model settings, approval forms, editing, interrupt,
or emergency controls.

- [ ] **Step 5: Run the UI tests**

Run the Task 3 commands. Expected: pass.

### Task 4: Verify all stages and reinstall the plugin

**Files:**
- Verify: `.stagepass/plugin-development/stagepass-card/`
- Verify: all files changed by Tasks 1–3.

- [ ] **Step 1: Run focused all-stage tests**

Run:

```bash
pnpm exec tsx --test lib/stage-clarification-policy.test.ts
pnpm exec tsx --test server/services/codex-desktop-run-context.test.ts
node --test .stagepass/plugin-development/stagepass-card/scripts/server.test.mjs
```

- [ ] **Step 2: Run typecheck and diff hygiene**

Run:

```bash
pnpm exec tsc --noEmit
git diff --check
```

- [ ] **Step 3: Validate and reinstall the plugin**

Use the plugin cachebuster helper, validate the development source, sync it to
the personal source, reinstall `stagepass-card@personal`, and validate the
installed cache.

- [ ] **Step 4: Restart StagePass and inspect the real page**

Confirm `/api/health` reports a healthy worker and `/api/codex/health` reports
`ready`. In the browser, click every stage in the rail and verify that the
three-column shell is unchanged while each stage shows the shared compact
Codex question-batch workspace.
