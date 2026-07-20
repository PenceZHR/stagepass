# Fix Iteration Limit 99 Design

## Goal

Allow the pipeline to continue Fix work up to 99 completed Fix iterations, while resetting only CHG-004's current counter to 1 for the active recovery.

## Scope

- Replace every production Fix-iteration hard-coded limit of 3 with one shared policy constant.
- Keep provider/job attempt limits and SQLite write retries unchanged; they are not Fix iterations.
- Keep the existing action contract semantics, but ensure the runtime and state-machine gates use the same limit.
- Update tests and operator documentation from 3 to 99.
- Reset only `changes.fix_iterations` for CHG-004 from 3 to 1 through the live backend database boundary.

## Design

`server/state-machine/iteration-policy.ts` owns `MAX_FIX_ITERATIONS = 99` and the canonical error text. `pipeline-build-stage-service.ts`, the legacy `pipeline-service.ts` path, and `state-machine/transitions.ts` import that policy instead of embedding numeric literals. Tests assert that 98 is allowed and 99 is rejected.

The current CHG-004 review artifacts, findings, worktree patch, and run history remain intact. Only its counter is reset, then the existing Fix action is queued through the real API.

## Verification

- Focused state-machine and pipeline Fix tests pass.
- Existing CHG-004 files and review artifacts remain present.
- Database shows `fix_iterations = 1`.
- A real Fix job is queued and its final status is observed from the database/logs.
