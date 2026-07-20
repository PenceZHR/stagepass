# Real Backend Pipeline Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive a dedicated Change from Project creation to `DONE` exclusively through real backend HTTP APIs, real provider calls, real SQLite writes, real `.ship` artifacts, and real Git workspaces, repairing every blocking backend defect encountered.

**Architecture:** A Main Agent serializes all writes to one acceptance Change. A Flow Agent drives public HTTP APIs; Persistence and Runtime Agents independently inspect DB/files/Git and process lifecycle. Every defect freezes the flow, enters a red-green repair loop, and is retried through the public API before downstream stages continue.

**Tech Stack:** Next.js Route Handlers, TypeScript, SQLite/Drizzle, `pipeline-worker.ts`, Claude Code CLI, OpenAI Codex SDK, Git worktrees, shell `curl`/`sqlite3`/`git` evidence commands.

**Design:** `docs/superpowers/specs/2026-07-11-real-backend-pipeline-acceptance-design.md`

**Live status convention:** Replace `[ ]` with `[x]` only after evidence is recorded. Add discovered Issue IDs beneath the failing step. Never edit a future step to hide a failure; append the changed route and rationale.

---

### Task 1: Establish the live acceptance ledger and environment preflight

**Files:**
- Create: `docs/reports/backend-pipeline-acceptance/<run-id>/execution-log.md`
- Create: `docs/reports/backend-pipeline-acceptance/<run-id>/api-evidence.jsonl`
- Create: `docs/reports/backend-pipeline-acceptance/<run-id>/database-evidence.md`
- Create: `docs/reports/backend-pipeline-acceptance/<run-id>/artifact-manifest.json`
- Create: `docs/reports/backend-pipeline-acceptance/<run-id>/git-evidence.md`
- Create: `docs/reports/backend-pipeline-acceptance/<run-id>/runtime-evidence.md`
- Create: `docs/reports/backend-pipeline-acceptance/<run-id>/issues.md`
- Create: `docs/reports/backend-pipeline-acceptance/<run-id>/final-report.md`

- [x] **Step 1: Allocate a UTC run ID and create the evidence skeleton with `apply_patch`**

Expected run ID format: `20260711T<HHMMSS>Z-real-backend-e2e`.

- [x] **Step 2: Prove there is one live service tree**

Run read-only host checks:

```bash
pgrep -af 'scripts/dev-supervisor.ts|scripts/pipeline-worker.ts|next/dist/bin/next dev'
lsof -nP -iTCP:3000 -sTCP:LISTEN
curl --noproxy '*' -fsS http://localhost:3000/api/health
```

Expected: one Supervisor process tree, one Worker, one Next listener, `ok=true`, fresh worker heartbeat, no crash loop, no stale running rows.

Live deviation: independent verification found stale provider lifecycle row `PRP-lease-PJOB-38d...` despite health reporting zero. `RBPA-001` blocks completion of this step until recovery repairs the real row.

- [x] **Step 3: Verify database and provider prerequisites without exposing secrets**

```bash
sqlite3 -readonly server/db/ship.db 'PRAGMA integrity_check; SELECT COUNT(*) FROM __migrations;'
git config user.name
git config user.email
test -x node_modules/@anthropic-ai/claude-code/bin/claude.exe
test -x /opt/homebrew/bin/codex
```

Expected: `integrity_check=ok`, migrations readable, Git identity non-empty, provider binaries executable. Record only presence, never auth content.

- [x] **Step 4: Run a minimal real provider connectivity probe through an existing backend entrypoint**

Do not call provider CLIs directly if a safe public project-level endpoint can establish the same proof. Record job/run/provider lifecycle and generated output. If no safe endpoint exists before Project creation, defer this proof to Task 3 and record the reason.

Decision: deferred to Task 3 because provider CLIs must not be invoked out of band and no disposable Project exists yet.

### Task 2: Create the isolated real Git repository

**Files:**
- Create outside repo: `/private/tmp/cc-ai-real-backend-e2e-<run-id>/`
- Update: `<run-dir>/git-evidence.md`

- [x] **Step 1: Copy the chosen source repository including `.git` into the isolated path**

Use a non-destructive copy command; do not copy `node_modules`, `.next`, logs, temporary DB files, or existing Build worktrees. Preserve tracked source and Git history.

- [x] **Step 2: Verify repository reality**

```bash
git -C <isolated-repo> rev-parse --is-inside-work-tree
git -C <isolated-repo> rev-parse HEAD
git -C <isolated-repo> status --short
```

Expected: real Git repository, valid HEAD, clean initial status.

- [x] **Step 3: Record initial `.ship` manifest and hashes**

Use `find`, `wc -c`, and `shasum -a 256`; do not create missing business artifacts manually.

### Task 3: Create and initialize a real Project through HTTP

**Files:**
- Update all evidence files under the current run directory.

- [x] **Step 1: Inspect the live `POST /api/projects` contract and construct a unique acceptance payload**

Name prefix: `E2E-REAL-BACKEND-<run-id>`. Provider selection must use a configured real provider.

- [x] **Step 2: POST the Project and record the complete sanitized request/response**

```bash
curl --noproxy '*' -fsS -X POST http://localhost:3000/api/projects \
  -H 'content-type: application/json' \
  --data-binary @<request-json>
```

- [x] **Step 3: Complete project context and project-level PRD through public APIs**

Call only routes under `/api/projects/<projectId>/context` and `/prd`. Poll public reads and worker state after each asynchronous action. Continue until `prdStatus=ready`.

- [x] **Step 4: Verify Project authority and real files**

Check `projects`, relevant events/runs/provider rows, `.ship` context docs, baseline files, sizes, hashes, and Git status. A Project row without files is a failure.

### Task 4: Create a real Change and repair the Refine entry contract

**Files:**
- Test and production files determined by the reproduced Refine defect.
- Update: run evidence and this live plan.

- [x] **Step 1: Create the Change through `POST /api/projects/<projectId>/changes`**

Use a concrete small feature that requires a real source change and can be validated automatically. Record the exact acceptance criteria before submitting.

- [x] **Step 2: Attempt the public Refine chat API from the observed initial state**

Expected from current investigation: a reproducible contract rejection because Change creation produces `INTAKE_PENDING` while Refine requires `REFINING`.

- [x] **Step 3: Open Issue RBPA-001 if reproduced and dispatch Debug Agent**

The Debug Agent must return root cause and a minimal failing test. The implementer follows TDD. Spec Reviewer then Code Quality Reviewer must both approve.

- [x] **Step 4: Restart the single Terminal-hosted service tree and retry Refine through HTTP**

Perform real model-backed chat turns, then confirm requirements through the public API. Verify DB, events, provider lifecycle, `spec.md`, artifacts, and transition into the Intake-compatible state.

### Task 5: Execute real PRD briefing and Intake

**Files:**
- Generated only by backend: `.ship/changes/<changeId>/prd-intent.md`, `briefing-questions.json`, `prd-draft.md`, `prd-gate.json`, `change-request.md`, and run captures.

- [x] **Step 1: Start briefing questions through the public API and wait for real provider completion**
- [x] **Step 2: Read questions from the public API and submit realistic answers one at a time**
- [x] **Step 3: Generate the real draft, run final review, and lock through public APIs**
- [x] **Step 4: Run Intake and approve its gate through public APIs**
- [x] **Step 5: Verify `prd_briefings`, `briefing_questions`, `prd_drafts`, jobs/runs/provider rows, events, files, artifacts, and hashes**

If `retry_prd` preflight and runner states diverge, open a dedicated Issue and repair before continuing.

### Task 6: Execute real Spec battle to an approved gate

**Files:**
- Generated only by backend: `prd-delta.md`, `requirement-gaps.json`, `red-fix-claims.json`, `blue-gap-reviews.json`, `reports/spec-report.md`, `reports/war-report.md`, round and run captures.

- [x] **Step 1: Start Spec through `POST .../spec` and observe Red and Blue as distinct real provider lifecycles**
- [x] **Step 2: Verify round 1 DB/file/hash evidence**
- [x] **Step 3: For P0/P1 gaps, submit the supported public retry/decision and run additional real rounds**
- [x] **Step 4: Approve the Spec gate only when action contract permits it**
- [x] **Step 5: Verify closed battle state, no unreconciled run, no provider timeout, and no orphan process**

### Task 7: Execute Tech Spec, Plan, and Test Plan

**Files:**
- Generated only by backend: TechSpec/API snapshots and mirrors, Plan snapshots/reports, TestPlan snapshots/mirrors.

- [x] **Step 1: Run Tech Spec, verify snapshot/hash/mirror authority, and approve gate**
- [x] **Step 2: Run Plan, verify steps/risks/validation commands, resolve public decisions, and approve**
- [x] **Step 3: Run Test Plan, verify coverage/risk/manual checks/commands, and complete public confirmation**
- [x] **Step 4: If TestPlan approval is ambiguous because it reuses `approve_plan`, reproduce and repair with TDD before continuing**

### Task 8: Execute real Build and adopt its patch

**Files:**
- Generated Build worktree, branch, `build-N.json`, patch, diff, audit, report, approval artifact, and `build_run_records`.

- [x] **Step 1: Start Build through `POST .../implement` and observe real provider work**
- [x] **Step 2: Verify the provider changed source files in the Build worktree and ran real validation commands**
- [x] **Step 3: Cross-check base commit, worktree head, changed files hash, patch hash, Build JSON, and DB record**
- [x] **Step 4: Adopt through the public Build workspace API; never apply the patch manually**
- [x] **Step 5: Verify adopted metadata and main isolated workspace diff**

### Task 9: Execute real Review/Fix cycles and QA

**Files:**
- Generated Review raw captures/findings/reports, Fix workspaces and patches, QA run/command/evidence files.

- [x] **Step 1: Run Review through HTTP and verify report source head equals adopted Build head**
- [x] **Step 2: If P0/P1 exists, run public Fix, verify/adopt its real patch, and rerun Review**
- [x] **Step 3: Repair any Review retry/action-contract mismatch exposed by the real cycle**
- [x] **Step 4: Run QA through `POST .../check` and execute all real required commands**
- [x] **Step 5: Verify `qa_runs`, command results, failures, evidence, files, source Build/Review/head lineage, and `MERGE_READY`**

### Task 10: Execute Merge approval, Release, Retro, and final `DONE`

**Files:**
- Generated release note, changelog update, Retro, backlog debt, merge/decision authority, and final evidence.

- [x] **Step 1: Read merge readiness and blockers; approve Merge gate through HTTP**
- [x] **Step 2: Run Release through HTTP and verify final patch adoption, release note, and changelog**
- [x] **Step 3: Run Retro through HTTP and verify `retro.md` and backlog append**
- [x] **Step 4: Prove final Change status is `DONE` with terminal job/run/provider and no stale/recovery errors**
- [x] **Step 5: Ask Persistence and Runtime Agents for independent final verdicts**

### Task 11: Final repair review and evidence report

**Files:**
- Modify: all current run evidence documents.
- Modify: this live plan to reflect actual completed/changed steps.

- [x] **Step 1: Run all regression tests added during the acceptance campaign**
- [x] **Step 2: Run the full isolated test suite, `npx tsc --noEmit`, and `npm run build`**
- [x] **Step 3: Dispatch final Spec Compliance Reviewer and Code Quality Reviewer over all repairs**
- [x] **Step 4: Reconcile every Issue Record with a fixed, open, or architectural-blocker status**
- [x] **Step 5: Write `final-report.md` with the exact terminal outcome; claim end-to-end pass only if the Change is truly `DONE`**
