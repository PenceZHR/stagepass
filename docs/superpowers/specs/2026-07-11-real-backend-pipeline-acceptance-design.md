# Real Backend Pipeline Acceptance Design

**Date:** 2026-07-11

**Status:** Approved

## Objective

Prove and repair the complete cc-ai backend pipeline by operating it through public HTTP APIs exactly as a real client would, while using real provider models, the production SQLite database, real Git workspaces, and real `.ship` artifacts. The acceptance run must continue stage by stage until the Change reaches `DONE`, or stop with a documented unresolved blocker that cannot be safely repaired within the run.

## Non-negotiable constraints

- Do not use frontend clicks.
- Do not directly update SQLite to advance business state.
- Do not hand-write provider output, stage JSON, or `.ship` artifacts.
- Do not use mocks, fixtures, fake providers, or copied unit-test output as acceptance evidence.
- Do not skip failed stages.
- Do not mark a stage passed from a UI label or a single status field.
- Use the real Claude/Codex provider adapter selected for the acceptance Project.
- Preserve model output, database rows, generated files, logs, hashes, and Git evidence.
- The agents may supply realistic human decisions and question answers, but must submit them through public HTTP APIs.

## Isolation boundary

Create a dedicated real Git repository under `/private/tmp` by copying the selected source repository with its commit history. Register that path through `POST /api/projects`, then create a dedicated acceptance Change. The application continues to use its real configured SQLite database, real Supervisor, real Pipeline Worker, and real provider credentials. Acceptance entities use an explicit prefix so they can be distinguished from user-owned Projects and Changes.

The isolated repository protects existing source workspaces from Build/Fix mutations. The database records and generated acceptance artifacts are intentionally retained as evidence.

## Execution architecture

The primary driver is black-box HTTP. It reads the current public action contract, calls the same route a frontend client would call, waits for asynchronous work, and reads public state again. Direct service calls are permitted only for diagnosis; they cannot establish a passing result. After a repair, the stage must be rerun from its public HTTP entrypoint.

Each stage follows this loop:

1. Read current Change state, phase state, gate, and available actions.
2. Confirm the expected action is enabled and its preconditions are present.
3. Submit the public HTTP request with an idempotency key where supported.
4. Observe the queued `pipeline_jobs` row and Worker lease.
5. Observe the business `runs` row and `provider_run_processes` lifecycle.
6. Wait for a terminal job, run, provider, and stage outcome.
7. Verify authoritative domain tables.
8. Verify required `.ship` files, artifact mirrors, hashes, and raw captures.
9. Verify Git branch, worktree, head, patch, and adoption evidence where applicable.
10. Re-read public APIs and confirm state remains consistent.
11. Record pass or open an Issue Record and freeze downstream execution.

## Agent roles

### Main Agent

Owns the acceptance Change, stage ordering, write coordination, repair integration, service restarts, and final pass/fail decision. Only the Main Agent authorizes mutations to the shared acceptance Change.

### Flow Agent

Constructs and submits public HTTP requests for one assigned stage. It may propose realistic human answers and decisions, but cannot bypass APIs or declare a stage passed.

### Persistence Agent

Performs read-only SQLite, filesystem, hash, artifact mirror, and Git verification. It distinguishes DB authority from best-effort file mirrors and reports divergence.

### Runtime Agent

Observes Supervisor, Worker, job lease, provider PID/thread, heartbeat, timeout, terminal state, and residual processes. It verifies that an apparently successful business state has no running or orphaned execution.

### Debug Agent

Investigates one concrete failure using logs, state transitions, and data flow. It creates a falsifiable root-cause hypothesis and proposes the smallest repair.

### Review Agent

Independently reviews each repair and its evidence. It checks that the change addresses the root cause, does not weaken contracts, and has a valid red-green regression test.

Agents may investigate independent read-only domains concurrently. Mutations to the same Change, database authority, service process, or overlapping source files are serialized by the Main Agent.

## Stage scope

### 1. Environment preflight

Verify exactly one dev Supervisor tree, one Next server, and one Pipeline Worker; database migrations; `/api/health`; provider credentials; Git identity; writable isolated repository; and a minimal real provider connectivity probe. All worker and provider heartbeats must be within configured freshness windows. No acceptance Project is created until preflight passes.

### 2. Project initialization

Create the Project through `POST /api/projects`. Complete the project-context and project-level PRD workflow through public APIs until `prdStatus=ready`. Verify Project rows, `.ship` context/baseline documents, content hashes, and clean Git identity.

### 3. Change creation

Create a Change through `POST /api/projects/:projectId/changes`. Verify initial state, event history, suggested/created Change branch behavior, and `.ship/changes/:changeId` ownership.

### 4. Refine contract repair and acceptance

The current source creates Changes in `INTAKE_PENDING`, while Refine APIs require `REFINING` and no normal transition enters that state. The run must first prove this contract break through public APIs. Repair the state/action contract so a newly created Change can perform real model-backed refine chat and confirmation before Intake. Rerun from a newly created Change if the original state was irreversibly advanced.

### 5. PRD and Intake

Run real PRD/Intake generation. Execute PRD briefing questions, submit realistic answers through answer routes, generate a draft, run final review, lock the briefing, and approve the Intake gate. Verify briefing authority tables, generated markdown/JSON mirrors, run captures, and source hashes.

### 6. Spec battle

Run the real Spec Writer and Requirement Critic. Resolve P0/P1 gaps through additional rounds and public decisions until the Spec gate is approvable. Verify battle rounds, requirement gaps, red fix claims, blue reviews, PRD delta, raw provider captures, Spec report, War report, hashes, and closed battle state.

### 7. Tech Spec

Generate real TechSpec and API snapshots. Verify authoritative snapshot rows, DB hashes, source Spec hash, artifact mirror status, root files, run artifacts, stage report, and gate approval.

### 8. Plan

Generate the real Plan, steps, risks, expected/forbidden files, and required validation commands. Resolve or explicitly decide blocking risks through public APIs. Verify snapshot hash, report, mirrors, and Plan approval.

### 9. Test Plan

Generate the real TestPlan snapshot, coverage items, risk mappings, manual checks, and validation commands. Complete the public approval/confirmation behavior. If reuse of `approve_plan` makes the decision ambiguous or incorrect, repair the public contract before proceeding.

### 10. Build

Run the real provider in a dedicated Build worktree. Require actual source changes that satisfy the acceptance Change, real validation commands, and real patch/diff/audit output. Verify worktree path, branch, base commit, head, changed-file hash, patch hash, Build run JSON, `build_run_records`, and adoption through the public Build workspace API.

### 11. Review and Fix loop

Run a real provider Review against the adopted Build head. If P0/P1 findings exist, run the real Fix action in its worktree, adopt its patch through the public API, and rerun Review. Findings may be waived only when the public contract permits it and the acceptance rationale is recorded; they cannot be directly closed in SQLite.

### 12. QA

Execute the TestPlan validation commands in the approved Build workspace. Record real stdout, stderr, exit codes, duration, evidence, source Build run, source Review report, and source head. Repeat the supported Review/Fix/QA loop until `MERGE_READY` or an unresolved blocker is established.

### 13. Merge gate and Release

Approve the Merge gate through the public API, verify merge readiness and blockers, and execute the real Release action. Verify final patch adoption, release note, changelog update, merge decision/approval authority, stage records, and transition to `RETRO_PENDING`.

### 14. Retro and Done

Run the real Retro provider action. Verify `retro.md`, backlog debt append behavior, terminal run/job/provider state, `retroDone`, and final `DONE` status.

## Stage pass criteria

A stage passes only when all applicable criteria are true:

- The public API accepted the correct action and returned the documented response.
- The action contract was enabled from the observed pre-state.
- The queue job has a valid lease history and terminal status.
- The business run and provider lifecycle have consistent terminal statuses.
- The authoritative stage/domain tables contain valid, fresh records.
- Required `.ship` files exist, are non-empty, and contain real provider-derived content.
- DB hashes, source hashes, mirror hashes, and filesystem hashes agree.
- Git/worktree/head/patch/adoption evidence agrees for Build and Fix.
- No relevant `side_effect_failed`, stale-run, fence, or recovery error remains.
- No provider or worker child process remains orphaned.
- A fresh public API read returns the same coherent state.

An HTTP 2xx, a green UI badge, a Change status, or a generated file alone is insufficient.

## Failure handling

Downstream execution stops immediately when a stage fails. Create an Issue Record containing:

- stage, endpoint, action ID, request, response, and timestamps;
- Change status, job ID, run ID, provider process/thread, and lifecycle timeline;
- relevant logs and database snapshots;
- missing or divergent files and hashes;
- Git/worktree state;
- severity (`P0`, `P1`, or `P2`);
- reproduction steps, root cause, repair, and regression evidence.

Repairs follow this sequence:

1. Reproduce and trace the root cause.
2. Obtain independent Review Agent critique of the diagnosis.
3. Write the smallest failing regression test and observe RED.
4. Implement the smallest production repair.
5. Observe GREEN, run related tests, typecheck, and production build.
6. Restart the single Terminal-hosted service tree.
7. Retry through the public HTTP entrypoint.
8. Re-run persistence and runtime verification.

If the same problem survives three repair attempts, stop stacking patches and record it as an architectural blocker requiring a new design decision.

If a failed stage leaves state that cannot be safely retried through public APIs, delete only the dedicated acceptance entity through its public API and restart from a new acceptance Change. Direct DB correction is prohibited.

## Known risks that must be exercised

- Refine is disconnected from the normal Change state machine.
- `retry_prd` registry states and the Intake runner differ.
- Review retry declarations are wider than actual preflight behavior.
- Fix action names diverge across public registry and worker types.
- TestPlan reuses Plan approval semantics.
- Build uses a file/DB dual-authority path around `build-N.json`.
- Several document stages commit DB authority before best-effort file side effects.
- Codex streamed execution lacks a provider timeout/abort path.
- Codex provider lifecycle lacks a managed child PID.
- Startup recovery depends on health-route execution.
- A shared provider thread field can contaminate provider/stage sessions.
- Historical logs contain heartbeat/fence and duplicate-Supervisor failures.

These are not assumed failures. The real run must produce evidence and repair only behavior that actually fails or violates the approved contract.

## Evidence package

Store the acceptance documentation under `docs/reports/backend-pipeline-acceptance/<run-id>/`:

- `execution-log.md`: ordered stage and repair timeline;
- `api-evidence.jsonl`: sanitized request/response index;
- `database-evidence.md`: authoritative queries and results;
- `artifact-manifest.json`: file paths, sizes, and SHA-256 hashes;
- `git-evidence.md`: branches, worktrees, heads, patches, and adoption;
- `runtime-evidence.md`: Supervisor, Worker, provider, heartbeat, and terminal state;
- `issues.md`: discovered problems, severity, root causes, and repair evidence;
- `final-report.md`: stage matrix, unresolved risks, and final `DONE` determination.

Secrets, authorization tokens, provider auth files, and raw sensitive environment values must never be copied into the evidence package.

## Completion condition

The acceptance run completes only when the dedicated Change reaches `DONE` through public HTTP actions and every stage pass criterion has supporting evidence. If an external provider outage, missing authorization, or architectural blocker prevents completion, the run remains failed or blocked and the final report must identify the exact terminal stage and evidence. No partial run may be described as end-to-end passing.
