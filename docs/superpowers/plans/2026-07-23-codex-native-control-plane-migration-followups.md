# Codex Native Control Plane — Deferred Follow-ups

## Task 4 follow-ups

These items were explicitly deferred to keep the Task 4 main execution path
moving. They are not part of the current Task 4 completion gate.

- Wire the production Spec critic through the frozen-input builder and persist
  an independent `spec_critic_review` artifact and decision.
- Carry the logical/start-attempt/execution fence through Build/Fix workspace
  mutation collection and patch-adoption CAS, including once-only crash tests.
- Add a minimal durable audit writer for rejected caller identity overrides.
- Upgrade the TypeScript caller inventory from symbol discovery to full
  call-site dataflow, argument-shape validation, and rollback-guard dominance.
- Emit `runStreamed` events from persisted normalized-state deltas only and
  prove terminal emission is once-only across reconnects.
- Expand the owner/lease/fence matrix with long-running PRD queue simulation,
  every dispatch crash window, visibility lag, owner takeover, and recovery
  epoch cases.

## Task 5 follow-ups

These were deferred so the unified Gateway and its first nine decision actions
could become the working migration spine immediately.

- Add the remaining explicit `*WithDb` ports for briefing, Spec Battle,
  Build/Fix adoption, Review waiver, QA, Merge override, and rework actions as
  those actions migrate in their numbered tasks.
- Add the Build/Fix patch-adoption outbox dispatcher and recovery
  reconciliation for the filesystem crash windows; the Task 5 UoW currently
  covers the DB-only atomic completion path and deduplicated outbox insertion.
- Persist external and canonical action ids in separate receipt/event columns;
  the current 0028 receipt schema has one `action` column, while the runtime
  alias resolver retains both identities in memory.
- Expand the focused transaction test into the five-point process-crash matrix
  after the recovery dispatcher exists.

## Task 16 follow-ups

The Task 16 production boundary and TypeScript build pass. The legacy
`phase-review.test.ts` source-shape suite still has 21 assertions that describe
the removed Web approval, waiver, stop, reason-dialog, and direct gate flows.
They are intentionally deferred until the post-migration test cleanup pass;
the operational runner and command suites pass.

## Task 17 follow-ups

- Extend the compiler-API Git consumer inventory from syntax-tree import,
  re-export, namespace, and `require` discovery to resolved-symbol/call-site
  dataflow before treating it as the final deletion authority.
- Re-run the DB-backed change, scope, and merge-readiness suites in isolated
  databases; the combined focused command shared a migrated SQLite fixture and
  reported setup-time `SQLITE_ERROR`s unrelated to the Git service split.
