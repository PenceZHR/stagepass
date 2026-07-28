# Codex-native Stage UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every duplicate stage-work control from StagePass Web and keep a single start/open bridge into the visible Codex task.

**Architecture:** Preserve `PipelinePageShell`, `WorkspaceNavigationColumns`, and
`StageOrbit`. Replace phase-specific workspaces with one shared read-only
`PhaseStageShell`; simplify `CodexTaskControl` to connection state plus one
start/open action; keep phase evidence read-only.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS, Node test runner.

---

### Task 1: Lock the Web/Codex boundary in tests

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/phase-review.test.ts`
- Modify: `app/projects/[id]/changes/[changeId]/codex-task-control.test.ts`
- Modify: `app/projects/[id]/changes/[changeId]/stage-frame.test.ts`

- [ ] **Step 1: Write failing source-boundary tests**

Assert that `page.tsx` mounts one shared stage shell and does not mount
`EmergencyInteractionPanel`, `PrdBriefingRoom`, `GatePanel`, `PlanSandbox`,
`TestPlanSandbox`, `BuildSandbox`, `ReviewReportCenter`, or
`OperationalPhasePanel`.

- [ ] **Step 2: Write failing control tests**

Assert that `CodexTaskControl` contains only the start/open buttons and does not
contain retry, interrupt, repair, model, reasoning-effort, settings, or
diagnostic controls.

- [ ] **Step 3: Write failing frame tests**

Assert that `StageFrame` does not import/render `StageActionBar` or
`RubricPanel`, while still rendering status, blockers, and read-only evidence.

- [ ] **Step 4: Run focused tests and confirm failure**

Run:

```bash
pnpm exec tsx --test \
  'app/projects/[id]/changes/[changeId]/phase-review.test.ts' \
  'app/projects/[id]/changes/[changeId]/codex-task-control.test.ts' \
  'app/projects/[id]/changes/[changeId]/stage-frame.test.ts'
```

Expected: failures naming the duplicate Web controls that still exist.

### Task 2: Reduce the Codex bridge control

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/codex-task-control.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`

- [ ] **Step 1: Remove secondary control props and local settings state**

Keep `control`, `health`, `busy`, `readOnly`, `onOpen`, and `onStart`. Remove
`onRetry`, `onInterrupt`, `onRepair`, and `onSaveSettings`.

- [ ] **Step 2: Render one primary action**

Bound task:

```tsx
<Button type="button" size="sm" disabled={busy} onClick={onOpen}>
  {stageStatus === "needs_input" ? "去 Codex 选择" : "打开 Codex"}
</Button>
```

Unbound current stage:

```tsx
<Button type="button" size="sm" disabled={busy} onClick={onStart}>
  开始本阶段
</Button>
```

- [ ] **Step 3: Remove obsolete callbacks at the page call site**

Pass only `onOpen` and `onStart` from `page.tsx`.

- [ ] **Step 4: Run the control test**

Run:

```bash
pnpm exec tsx --test 'app/projects/[id]/changes/[changeId]/codex-task-control.test.ts'
```

Expected: pass.

### Task 3: Replace phase-specific workspaces with one read-only stage surface

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/phase-stage-shell.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/stage-frame.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/phase-review-panel.tsx`

- [ ] **Step 1: Remove phase-specific imports, state, handlers, and JSX**

Delete all mounts of the PRD room, gate, planning sandboxes, build sandbox,
review center, operational panel, emergency panel, and failed-run action
surface.

- [ ] **Step 2: Render a shared Codex stage boundary**

For every selected stage, render a single `PhaseStageShell` containing:

```tsx
<section data-codex-stage-boundary>
  <p>本阶段在 Codex App 中完成。</p>
  <p>网页仅同步状态和结果；问题、选择、执行与修订都在同一个 Codex 任务中继续。</p>
</section>
```

- [ ] **Step 3: Make evidence read-only**

Always pass `readOnly` to `PhaseReviewPanel`; remove rework submission and
editable artifact behavior from this route.

- [ ] **Step 4: Remove rubric and action rendering from the shared frame**

Keep stage header, status, blockers, metadata, and evidence. Remove
`StageActionBar`, `actions`, `actionError`, and `rubric`.

- [ ] **Step 5: Run the three focused tests**

Run the Task 1 command. Expected: pass.

### Task 4: Verify the complete UI

**Files:**
- Verify only.

- [ ] **Step 1: Run relevant change-detail tests**

Run:

```bash
pnpm exec tsx --test 'app/projects/[id]/changes/[changeId]/*.test.ts'
```

- [ ] **Step 2: Run typecheck and lint**

Run:

```bash
pnpm exec tsc --noEmit
pnpm exec eslint 'app/projects/[id]/changes/[changeId]'
```

- [ ] **Step 3: Run production build**

Run:

```bash
pnpm run build
```

- [ ] **Step 4: Inspect in a real browser**

Confirm the three-column shell remains, every stage uses the same compact
Codex-native detail surface, and no duplicate work controls are present.
