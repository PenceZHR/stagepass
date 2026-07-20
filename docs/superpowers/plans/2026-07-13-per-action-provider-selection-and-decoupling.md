# Per-Action Provider Selection and Pipeline Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the user to choose Codex or Claude independently before each provider-backed action on each page, without hot-switching an in-flight run, while making the selected provider immutable from enqueue through execution and keeping the existing Change/project defaults as fallbacks only.

**Architecture:** Add one shared provider-selection contract at the action boundary, persist the resolved provider on every queued AI job and run, and pass it explicitly through the worker into stage services. Keep human/local actions provider-free. Add provider-scoped model sessions so a Codex thread is never resumed by Claude (or vice versa). The page owns ephemeral selection state; the database Change default is not mutated by an action click.

**Tech Stack:** Next.js App Router, React/TypeScript, Drizzle ORM, SQLite, `pipeline_jobs` worker, Codex/Claude `AiEngine` adapters, Vitest/Node test runner, Playwright/browser tests.

---

## Scope and invariants

### In scope

- Per-click provider choice for PRD/intake, PRD briefing AI actions, Spec, Tech Spec, Plan, Test Plan, Build, Review, Fix, Release/Merge (release-note generation), Retro, and Refine chat.
- Provider propagation through API preflight, queue, worker, stage service, provider lifecycle, run ledger, artifacts, and audit events.
- Provider-specific session continuity and migration of the legacy `changes.codex_thread_id` field.
- One shared UI selector and action metadata so pages do not maintain provider action allowlists independently.

### Out of scope

- Hot-switching a provider after a job has started.
- Automatically changing `changes.provider`, `projects.context_provider`, or `projects.prd_provider` when a one-off action is run.
- Adding a provider to local QA (`check`), human approvals/waivers/stops, or other non-AI transitions.
- Making an AI response from one vendor look semantically identical to another vendor.

### Required invariants

1. The provider is resolved once, transactionally, at enqueue time and is immutable for that job.
2. A worker never re-reads mutable `changes.provider` to decide how an already queued job runs.
3. A request that omits `provider` remains backward compatible and falls back to the Change default; a supplied value must be exactly `codex` or `claude`.
4. Reusing an idempotency key with a different provider is a conflict, never a silent replay of the old provider.
5. A Codex session identifier is never passed to the Claude adapter, and vice versa.
6. Provider choice does not alter gate/source hashes; it is execution metadata, not readiness state.

## Current-code findings

- `changes.provider` is written at creation (`server/services/change-service.ts`, `server/db/schema.ts`) but there is no per-action override path.
- `pipeline_jobs`, `stage_runs`, and `runs` do not carry provider; only `provider_run_processes` does. `server/services/job-dispatch-service.ts` therefore queues work without an immutable provider.
- The worker (`scripts/pipeline-worker.ts` -> `server/services/pipeline-job-runner-service.ts`) calls stage services that mostly resolve `change.provider` again (`pipeline-document-stage-runner-service.ts`, `pipeline-plan-stage-service.ts`, `pipeline-build-stage-service.ts`, `pipeline-prd-briefing-stage-service.ts`, `pipeline-service.ts`).
- `app/projects/[id]/changes/[changeId]/use-pipeline-actions.ts` and `createPipelinePreflightPayload` do not send provider. `StageActionBar` has no picker; custom Spec, briefing, Build, Review, and chat callbacks bypass the generic hook.
- `refine-service.ts` and pipeline stage runners reuse the single `changes.codex_thread_id` field for both vendors, which can cross-contaminate sessions.
- PRD editor requests currently send `saveAsDefault: true`; this must become an explicit opt-in rather than an accidental side effect of choosing a provider.

## Dependency order

```text
shared provider/action policy
        ↓
DB migration + provider session repository
        ↓
API parser + enqueue conflict semantics
        ↓
worker/job/stage provider propagation
        ↓
page state + shared picker + custom action wiring
        ↓
backend/API/worker/UI regression matrix
```

## Implementation tasks

### 1. Define the shared provider and action policy

- [ ] Create or reuse a shared `AiProvider` type/validator and a `ProviderSelection` helper (recommended location: `server/services/provider-selection-service.ts`; export a browser-safe type/metadata module if needed).
- [ ] Extend the action definition returned by `server/services/action-contract-registry-service.ts` with `requiresProvider`/`providerSelectable` metadata. Mark provider-backed actions explicitly: PRD run/retry, the three PRD briefing AI actions, Spec run/retry, Tech Spec run/retry, Plan run/retry, Test Plan run/retry, Build run/retry, Review run/retry, Fix blockers, Merge/release, and Retro. Mark QA/check and human actions as provider-free.
- [ ] Make `app/projects/[id]/changes/[changeId]/pipeline-action-contract.ts` consume the shared metadata instead of maintaining a second action-id blacklist. Include the runtime default provider for display only.
- [ ] Add unit tests for policy classification, valid/invalid provider parsing, omitted-provider fallback, and rejection of a provider on a local/human action.

**Acceptance:** Every action has one authoritative provider policy; frontend and backend agree on the same provider-backed set; no gate hash includes provider.

### 2. Persist immutable provider and provider-scoped sessions

- [ ] Add a migration after the current migration head (expected `0019`): `pipeline_jobs.provider` (non-null with a compatibility default/backfill), `runs.provider` (nullable only where historical rows cannot be reconstructed), an auditable `stage_runs.provider` (nullable for historical rows), and a `change_provider_sessions` table keyed by `(change_id, provider, session_kind)` with external session id, last run id, and timestamps.
- [ ] Update `server/db/schema.ts`, migration metadata/snapshots, test fixtures, and typed job/run records. Backfill legacy jobs/runs from `changes.provider` only as a documented historical migration; new rows must always be explicit.
- [ ] Add `server/services/provider-session-service.ts` to resolve/record sessions under the existing execution fence. Backfill `changes.codex_thread_id` only into the Codex/general session; keep the legacy column read-only during compatibility.
- [ ] Update Codex/Claude stage calls to request a session for their own provider and session kind. A provider switch starts a new session when that provider has none; it may resume only that provider's prior session.
- [ ] Add migration and session-isolation tests, including Codex-to-Claude and Claude-to-Codex switches.

**Acceptance:** Database inspection shows the selected provider on queued and run records; a vendor session id is never shared across providers; old data remains readable.

### 3. Extend action preflight and enqueue semantics

- [ ] Extend `app/api/projects/[id]/changes/[changeId]/action-preflight.ts` with an optional `provider` field and one parser returning `invalid_provider` for any other value.
- [ ] Extend `EnqueuePipelineJobInput` and `enqueueProviderActionAtomically` in `server/services/job-dispatch-service.ts` with an optional requested provider. Resolve `requested ?? changes.provider` inside the same transaction that checks action authority and inserts the job. The provider-backed route matrix must cover `/intake`, `/prd-briefing/questions`, `/prd-briefing/draft`, `/prd-briefing/final-review`, `/spec`, `/tech-spec`, `/plan`, `/test-plan`, `/implement`, `/review`, `/fix`, `/release`, and `/retro`; `/check` and human command routes stay provider-free.
- [ ] Store the resolved provider in `pipeline_jobs`, include it in queue/audit event JSON, and return it in the API response and job record.
- [ ] Define conflicts: same idempotency key + same provider replays; same key + different provider returns `409 provider_selection_conflict`; an active same-phase job with another provider also returns a conflict rather than being reused.
- [ ] Keep old clients working when provider is omitted; reject provider on non-provider actions with `provider_not_applicable` (or ignore only where an existing compatibility contract requires it, with a test documenting that exception).
- [ ] Add focused dispatch tests for fallback, explicit override, idempotency replay/conflict, active-job conflict, and transaction rollback.

**Acceptance:** A queued Claude job remains Claude even if `changes.provider` is changed to Codex before leasing; no duplicate or silent cross-provider replay occurs.

### 4. Propagate provider through worker and all AI stage services

- [ ] Add provider to `PipelineJobRecord`/selection and pass `job.provider` from `scripts/pipeline-worker.ts` through `server/services/pipeline-job-runner-service.ts`; keep lease/fence fields separate from provider.
- [ ] Add an explicit provider/options parameter to the provider-backed stage entry points in `pipeline-service.ts`, `pipeline-document-stage-runner-service.ts`, `pipeline-plan-stage-service.ts`, `pipeline-design-stage-service.ts`, `pipeline-build-stage-service.ts`, `pipeline-release-retro-stage-service.ts`, and `pipeline-prd-briefing-stage-service.ts`.
- [ ] Replace every execution-time `getPipelineEngine(change.provider)` and lifecycle/ingestion provider read with the passed immutable provider. Ensure Spec red/blue writers and critic use the same selected provider for the round, while run/process/event records carry the provider.
- [ ] Add provider to run-ledger creation and review/spec composite run metadata. Keep `provider_run_processes.provider` aligned and add assertions for mismatch.
- [ ] Leave `runCheck`/local QA provider-free and explicitly classify `release:merge` as provider-backed because it generates release notes. Confirm this classification from `pipeline-release-retro-stage-service.ts` and `pipeline-qa-stage-service.ts` in tests so a future implementation change cannot silently diverge from the action metadata.
- [ ] Add worker integration tests that enqueue one provider, mutate Change default, then assert engine/lifecycle/ingestion/process all used the queued provider.

**Acceptance:** No provider-backed worker path consults `changes.provider` after queue insertion; artifacts and run/process audit identify the actual provider.

### 5. Wire the frontend as an ephemeral per-click selection

- [ ] Add a reusable `ProviderPicker` component under `app/projects/[id]/changes/[changeId]/` with Codex/Claude options, `data-provider`, accessible label, and disabled state while an action is running.
- [ ] Let `ChangeDetailPage` own `selectedProvider`, initialize it from `change.provider`, and do not persist it. Rename the header badge to distinguish “Change 默认 Provider” from “本次运行 Provider”.
- [ ] Extend `usePipelineActions.handleAction` and `createPipelinePreflightPayload` to include provider only for provider-backed actions. Disable the picker from click through terminal job state.
- [ ] Thread the selection through `StageActionBar`, `StageFrame`, `PhaseStageShell`, and all generic visible actions. Human/local actions must not render or send provider.
- [ ] Wire custom callbacks: Spec battle start and chained gate action in `page.tsx`, BuildSandbox, ReviewReportCenter, PRD briefing start, Refine chat, release/retro, and any direct `fetch` action. Chained actions must inherit the provider selected for the initiating click.
- [ ] Change PRD editor `saveAsDefault` to an explicit “记为默认” control (default false); choosing a provider for a turn must not update project defaults unless the user checks it.
- [ ] Add component/hook tests for defaulting, switching between clicks, disabled-while-running, no persistence, and payload contents.

**Acceptance:** The user can run consecutive actions with different providers without reload; a reload returns to the Change default; no one-off click mutates Change/project defaults.

### 6. Harden Refine/chat and session-aware custom flows

- [ ] Add optional provider to `/chat` request validation and `refineTurn`; use the provider-session service rather than `changes.codex_thread_id` directly.
- [ ] Add the shared picker to `RefineChatPanel`; send the selected provider and lock it while the turn is running.
- [ ] Add provider payloads to PRD briefing questions/draft/final-review routes and `PrdBriefingRoom.startAiJob`; keep `lock_prd` provider-free.
- [ ] Add API tests proving custom routes use the same parser, enqueue semantics, and provider audit as generic pipeline routes.

**Acceptance:** Refine and briefing actions obey the same provider/session rules as queued pipeline actions.

### 7. Verification and rollout

- [ ] Run the complete API matrix: each provider-backed action once with Codex, once with Claude, omitted-provider compatibility, invalid provider, and provider switch between consecutive actions. Assert real job/run rows and artifact files.
- [ ] Run failure/retry cases: timeout/unavailable provider, retry with another provider, gate-version drift retry, active duplicate click, and worker restart. Assert no stale provider/session leakage.
- [ ] Run frontend/browser tests for picker visibility, payloads, action locking, and provider-free human/local actions.
- [ ] Run `pnpm test`, `pnpm lint`, and `pnpm build`; treat repo-wide `pnpm exec tsc --noEmit` TS5097 test-extension noise separately and do not use it as the sole gate.
- [ ] Add a short migration/rollback note documenting the compatibility default, how to inspect `pipeline_jobs.provider`, and how to disable per-click overrides if needed.

**Definition of done:** A real end-to-end run can choose Codex for one action and Claude for the next, each job executes with the chosen provider, files are durably written, sessions remain isolated, and all existing provider-omitting clients and human actions continue to work.

## Review checkpoints

1. Review this plan against the current source before implementation; block if any provider-backed route or direct callback is missing.
2. After Tasks 1–3, review schema/contract compatibility and idempotency semantics before worker changes.
3. After Tasks 4–6, review that no execution path re-reads `changes.provider` and that picker state is ephemeral.
4. Only after all checkpoints pass, execute the plan with tests and real artifact verification.
