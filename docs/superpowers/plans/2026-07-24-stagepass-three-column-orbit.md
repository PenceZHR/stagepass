# Stagepass Three-Column Orbit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Change landing surface as a `Projects 20% / Changes 20% / Stage Orbit 60%` control plane with geometrically aligned, more expressive orbit motion.

**Architecture:** Keep the existing Change detail route as the authority for gate data and stage actions. Add a focused workspace-navigation hook that loads Projects and the selected Project’s Changes; selecting either column navigates to the canonical Change URL, so the third column remounts with authoritative data. Keep orbit rendering presentational and derive node coordinates from one shared center/radius.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Tailwind CSS v4, existing Stagepass REST routes, Node test runner, Codex in-app browser.

---

## File Map

- Create `app/projects/[id]/changes/[changeId]/use-workspace-navigation.ts`: load Projects and per-Project Changes, expose loading/error/selection state and canonical navigation targets.
- Create `app/projects/[id]/changes/[changeId]/workspace-navigation-columns.tsx`: render the independent Project and Change columns.
- Modify `app/projects/[id]/changes/[changeId]/pipeline-page-shell.tsx`: compose the `2 : 2 : 6` grid and keep detail mode compatible.
- Modify `app/projects/[id]/changes/[changeId]/stage-orbit.tsx`: use exact trigonometric positions and support Change-keyed entrance motion.
- Modify `app/globals.css`: size the three-column shell and implement layered orbit animation with reduced-motion fallbacks.
- Modify `app/projects/[id]/changes/[changeId]/stage-orbit.test.ts`: pin layout, geometry, navigation, and accessibility contracts.

### Task 1: Navigation model

**Files:**
- Create: `app/projects/[id]/changes/[changeId]/use-workspace-navigation.ts`
- Test: `app/projects/[id]/changes/[changeId]/stage-orbit.test.ts`

- [ ] **Step 1: Write the failing navigation source-contract test**

Add assertions that the hook calls `/api/projects`, calls `/api/projects/${projectId}/changes`, sorts Changes by `updatedAt`, and exposes the current `projectId` and `changeId`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --import tsx scripts/run-tests-isolated.ts 'app/projects/[id]/changes/[changeId]/stage-orbit.test.ts'
```

Expected: FAIL because `use-workspace-navigation.ts` does not exist.

- [ ] **Step 3: Implement the minimal navigation hook**

Define:

```ts
export interface WorkspaceProject {
  id: string;
  name: string;
  repoPath: string;
}

export interface WorkspaceChange {
  id: string;
  projectId: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export function useWorkspaceNavigation(projectId: string, changeId: string) {
  // Load projects once.
  // Reload changes whenever projectId changes.
  // Return projects, changes, loading, error and selected ids.
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: PASS.

### Task 2: Independent Project and Change columns

**Files:**
- Create: `app/projects/[id]/changes/[changeId]/workspace-navigation-columns.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/pipeline-page-shell.tsx`
- Test: `app/projects/[id]/changes/[changeId]/stage-orbit.test.ts`

- [ ] **Step 1: Write failing assertions for three-column composition**

Assert that the shell contains `data-workspace-projects`, `data-workspace-changes`, `data-workspace-orbit`, and the desktop grid token `lg:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,6fr)]`.

- [ ] **Step 2: Run the focused test and verify RED**

Expected: FAIL because the navigation columns and grid do not exist.

- [ ] **Step 3: Implement the columns**

Render semantic `<aside>` regions with headings, counts, loading skeletons, error states, and `<button>` rows. A Project click chooses its most recently updated unfinished Change, falling back to its most recently updated Change. A Change click calls:

```ts
router.push(`/projects/${project.id}/changes/${change.id}`);
```

The active Project and Change must use `aria-current="page"` and visible text state, not color alone.

- [ ] **Step 4: Compose the desktop `2 : 2 : 6` grid**

Keep the topbar outside the grid. In orbit mode, render the two navigation asides and StageOrbit as three siblings. In detail mode, preserve the same two navigation columns and render the selected stage detail in the `6fr` region.

- [ ] **Step 5: Run the focused test and verify GREEN**

Expected: all navigation and layout assertions pass.

### Task 3: Exact orbit geometry

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/stage-orbit.tsx`
- Modify: `app/globals.css`
- Test: `app/projects/[id]/changes/[changeId]/stage-orbit.test.ts`

- [ ] **Step 1: Write the failing geometry contract**

Assert that every node derives:

```ts
const radians = ((index * 360) / orbitStages.length - 90) * (Math.PI / 180);
const x = 50 + Math.cos(radians) * ORBIT_RADIUS_PERCENT;
const y = 50 + Math.sin(radians) * ORBIT_RADIUS_PERCENT;
```

and assigns `left: ${x}%` and `top: ${y}%`.

- [ ] **Step 2: Run the focused test and verify RED**

Expected: FAIL because the current orbit uses wrapper rotation transforms.

- [ ] **Step 3: Implement the shared coordinate system**

Use `ORBIT_RADIUS_PERCENT = 42.5`. Make the orbit border radius exactly `42.5%` of the orbit box so the border centerline, node anchors and central Gate share one coordinate system. Remove `--stage-angle` and wrapper rotation transforms.

- [ ] **Step 4: Run the focused test and verify GREEN**

Expected: geometry assertions pass.

### Task 4: Rich but controlled motion

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/stage-orbit.tsx`
- Modify: `app/globals.css`
- Test: `app/projects/[id]/changes/[changeId]/stage-orbit.test.ts`

- [ ] **Step 1: Add failing motion assertions**

Assert that the orbit contains `stage-orbit-aurora`, `stage-orbit-inner-track`, per-node `--stage-delay`, and keyframes for outer sweep, inner counter-sweep, aurora breathing and node relay.

- [ ] **Step 2: Run the focused test and verify RED**

Expected: FAIL because the new layers and keyframes are absent.

- [ ] **Step 3: Implement the motion layers**

Add decorative, pointer-inert layers:

```tsx
<span className="stage-orbit-aurora" aria-hidden="true" />
<span className="stage-orbit-inner-track" aria-hidden="true" />
```

Use 14–18s outer sweep, 18–24s counter-sweep, 5–8s aurora breathing, and 8–12s sequential node relay. Keep saturation within the confirmed sand/terracotta/mauve/slate-blue palette.

- [ ] **Step 4: Preserve reduced motion**

Inside `@media (prefers-reduced-motion: reduce)`, disable every new animation and retain all static borders and state semantics.

- [ ] **Step 5: Run the focused test and verify GREEN**

Expected: motion and reduced-motion assertions pass.

### Task 5: Verification and delivery

**Files:**
- Modify only files required by failures found during verification.

- [ ] **Step 1: Run focused and related tests**

```bash
node --import tsx scripts/run-tests-isolated.ts \
  'app/projects/[id]/changes/[changeId]/stage-orbit.test.ts' \
  'app/projects/[id]/changes/[changeId]/pipeline-ui-model.test.ts' \
  'app/projects/[id]/changes/[changeId]/stage-frame.test.ts' \
  'app/projects/[id]/changes/[changeId]/prd-briefing-room.test.ts'
```

Expected: zero failures.

- [ ] **Step 2: Run static verification**

```bash
pnpm exec tsc --noEmit
pnpm lint
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Run the production build**

```bash
pnpm run build
```

Expected: Next.js production build exits 0.

- [ ] **Step 4: Browser acceptance**

At desktop width, verify the first screen is exactly three columns at `2 : 2 : 6`; click a Project and confirm the Change column updates; click a Change and confirm the URL and orbit update; click a stage and return; confirm zero console errors. At narrow width, verify the Project and Change selectors move above the complete orbit without reducing it to a vertical stage list.

- [ ] **Step 5: Commit**

```bash
git add app/globals.css \
  'app/projects/[id]/changes/[changeId]/pipeline-page-shell.tsx' \
  'app/projects/[id]/changes/[changeId]/stage-orbit.tsx' \
  'app/projects/[id]/changes/[changeId]/stage-orbit.test.ts' \
  'app/projects/[id]/changes/[changeId]/use-workspace-navigation.ts' \
  'app/projects/[id]/changes/[changeId]/workspace-navigation-columns.tsx' \
  docs/superpowers/specs/2026-07-24-stagepass-abstract-cloud-sea-visual-design.md \
  docs/superpowers/plans/2026-07-24-stagepass-three-column-orbit.md
git commit -m "feat(ui): add three-column project change orbit"
```
