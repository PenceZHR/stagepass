# PRD Queue Receipt and Spec Start Repair

## Problem

Two regressions block the PRD-to-Spec workflow:

1. The PRD Briefing UI treats every successful JSON response as a complete `PrdBriefingState`. The asynchronous questions, draft, and final-review endpoints now return a `202` queue receipt instead, so clicking one of those actions replaces the page state with an object that has no `questions`, causing the next render to throw.
2. The persisted PRD gate uses the canonical status `pass`. The provider-action authority fence only accepts `passed` and `approved`, so `run_spec` is shown as enabled by the action contract but rejected during atomic enqueue with `gate_not_passed`.

## Chosen Design

### Separate state responses from command receipts

Keep the existing state-loading request responsible for calling `syncState`. Change the PRD AI command path so it only validates the successful queue receipt and then begins polling. It must not normalize or persist the receipt as `PrdBriefingState`.

The intent-saving and PRD-locking paths continue to use their current state-oriented behavior because those endpoints return page state and require immediate UI synchronization.

### Align gate status vocabulary at the authority fence

Treat `pass`, `passed`, and `approved` as successful persisted gate statuses in the provider-action authority check. This matches the status currently written by the PRD gate service while retaining compatibility with existing records.

No database migration or historical data rewrite is required.

## Error Handling

- A non-2xx PRD AI command response remains visible through the existing component error state.
- A malformed but successful queue receipt must be rejected as a command-response error without corrupting the current page state.
- Spec enqueue continues to use the existing action-contract fence, source hash, gate version, and idempotency checks; only the accepted successful gate vocabulary changes.

## Tests

1. Add a frontend regression test proving a `202` queue receipt is not passed to `syncState`, while state-returning commands still are.
2. Add an authority-fence regression test proving a PRD gate with status `pass` enables atomic `run_spec` enqueue.
3. Run the focused frontend and backend tests, TypeScript checking, and the production build.

## Scope

Only the PRD Briefing command-response boundary, provider-action gate-status predicate, and their focused tests are in scope. No schema migration, unrelated refactor, or workflow redesign is included.

## Follow-up: Composite Spec Run Ownership

The Spec battle is one business run containing the Red writer, Blue critic, and report generation. The Red document-stage helper must not end the reserved battle run when Red finishes. The outer `runSpec` orchestration owns the terminal transition instead:

- keep the reserved run `running` while Red hands off to Blue;
- end it as `completed` only after Blue, the Spec report, and the war report succeed;
- end it as `failed` when an ordinary battle error blocks the round;
- preserve stale-fence behavior by not mutating a run whose lease is no longer current.

The generic document-stage path retains its existing self-managed lifecycle by default. Only the composite Spec call opts out, preventing behavior changes in PRD, Tech Spec, Plan, and Test Plan stages.

### Follow-up Tests

1. Run the real provider lifecycle callbacks in the Spec service test so Red completing cannot hide a closed business run behind an engine mock.
2. Assert the reserved run remains `running` when Blue starts and becomes `completed` only after the whole battle succeeds.
3. Assert a Blue failure closes the reserved run as `failed` without weakening job or provider fencing.

## Follow-up: Spec Agent Thread Isolation

The Red writer and Blue critic are separate adversarial units. Neither unit should resume the change-wide provider thread, which currently accumulates PRD questions, drafting, final review, prior Spec attempts, and the opposing unit's output. Reusing that thread makes context size grow across retries and caused the Blue critic to fail with `The model has reached its context window limit`.

The Spec orchestration therefore starts both provider calls without a `threadId`:

- Red uses the document-stage `resumeThread: false` option on every initial run and retry.
- Blue passes no thread ID directly to the provider engine.
- Blue still receives the current Red result through DB-authoritative Spec context and `prd-delta.md`; it does not depend on hidden chat history.
- Provider lifecycle rows retain the newly returned external reference for observability, but the next Spec unit does not resume it.

Only Spec is changed. Other phases keep their existing thread policy. Provider-side compaction is not used because it is provider-specific and does not guarantee enough capacity. Isolating only Blue is insufficient because a later Red retry would still resume the oversized change-wide thread.

### Thread Isolation Tests

1. Seed a change with an existing long provider thread and assert both `spec` and `spec_critic` engine inputs receive `threadId: undefined`.
2. Keep the existing lifecycle, fencing, structured-output, retry, and artifact tests unchanged.
