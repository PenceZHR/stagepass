# PRD: Regenerate an Existing PRD

## Problem and audience

This change is for a StagePass user responsible for a Change that is still in
the PRD stage. When the current PRD is unusable, stale, or based on requirements
that have since changed, that user has no explicit, safe way to request a fresh
PRD while preserving the decision trail. They must be able to obtain a new
current PRD without recreating the Change, accidentally starting duplicate
runs, losing the prior result, or mistaking an approval of the old snapshot for
approval of the new one.

## Required product outcomes

### PRD-REQ-1 — Discover and intentionally start regeneration

An eligible user can find a control labelled **Regenerate PRD** on the product
surface that displays the current PRD and can intentionally start one new PRD
attempt for the same Change.

Acceptance criteria:

1. Given an eligible Change with a current PRD and no active PRD attempt, the
   surface displaying that PRD shows exactly one enabled control labelled
   **Regenerate PRD**.
2. Activating the control shows a confirmation step before any attempt is
   created.
3. Cancelling confirmation creates zero attempts and leaves the current PRD
   unchanged.
4. Confirming once creates exactly one new PRD attempt associated with the same
   Change.

### PRD-REQ-2 — Prevent ineligible and duplicate runs

The user cannot start regeneration when the Change is not eligible or while
another PRD attempt for that Change is active.

Acceptance criteria:

1. For every Change state declared in the approved eligibility policy as
   ineligible, **Regenerate PRD** cannot be invoked from the UI.
2. While one PRD attempt is active, repeated activation produces no additional
   attempt; the stored count of active PRD attempts for the Change remains one.
3. A direct execution request is rejected under the same eligibility rule used
   by the UI and creates zero attempts.
4. While regeneration is active, the UI visibly identifies the attempt as
   running and exposes no enabled action that can launch a second attempt.

### PRD-REQ-3 — Produce a fresh, attributable result

The confirmed attempt uses the approved regeneration input policy and records
the inputs needed to identify what the new PRD was generated from.

Acceptance criteria:

1. The attempt record identifies the Change, attempt ID, start time, terminal
   status, and the immutable input snapshot or input-version identifiers
   required by the approved regeneration input policy.
2. A successful attempt creates a new PRD artifact with an artifact/version ID
   different from the prior PRD.
3. The successful artifact becomes the sole current PRD for the Change, and the
   user can see it on the same product surface without leaving and reopening
   the Change.
4. The audit history shows both the prior and new artifact/attempt identifiers
   in chronological order.

### PRD-REQ-4 — Preserve the last successful result on failure or cancellation

A failed or cancelled regeneration does not destroy or supersede the PRD the
user was relying on.

Acceptance criteria:

1. When an attempt terminates as failed or cancelled, no new artifact becomes
   current and the artifact that was current immediately before the attempt
   remains current.
2. The prior artifact remains retrievable by its original artifact/version ID.
3. The attempt is recorded with the terminal status `failed` or `cancelled`,
   respectively, and the UI visibly distinguishes that outcome from success.
4. Failure or cancellation never deletes an earlier artifact, attempt,
   decision, or audit record.

### PRD-REQ-5 — Do not carry stale decisions across snapshots

The user cannot mistake a decision or downstream evidence bound to the old PRD
snapshot for validation of the regenerated PRD.

Acceptance criteria:

1. After a successful regeneration, each approval, gate decision, gap,
   evidence item, and downstream artifact covered by the approved invalidation
   policy is visibly marked non-current or otherwise excluded from evaluation
   of the new PRD snapshot.
2. No approval or gate decision whose bound snapshot differs from the new
   current PRD snapshot can open the PRD gate.
3. The Change visibly returns to the review state prescribed by the approved
   invalidation policy before it can advance.
4. The audit history identifies the old and new snapshot IDs and the resulting
   invalidation/state transition.

## Out of scope

- Editing PRD content inline.
- Comparing, merging, diffing, or selectively accepting sections from PRD
  versions.
- Regenerating Spec, Tech Spec, Plan, Test Plan, or another phase.
- Changing the PRD prompt, model, provider, or general generation quality.
- Automatically approving the regenerated PRD or advancing the Change.
- Deleting prior artifacts, attempts, decisions, evidence, or audit history.
- Redesigning the stage orbit, terminal, or overall navigation.
- Adding a retry path that bypasses the Change state machine, snapshot fence,
  eligibility rule, or single-active-attempt rule.

## Preconditions that can invalidate this PRD

The product requirement is not implementation-ready unless all of the following
are true:

1. StagePass has or will establish one authoritative product surface capable of
   displaying the current PRD and hosting the regeneration interaction. If
   human actions are restricted to the Codex TUI and no such interaction can be
   hosted there, PRD-REQ-1 is not achievable.
2. Product owners approve an exact regeneration input policy defining whether
   the attempt reuses the original request, accumulated PRD-stage conversation,
   latest persisted requirements, or a fresh thread. Without it, “fresh PRD”
   has no stable meaning and PRD-REQ-3 cannot be verified.
3. Product owners approve the exact eligible Change states and invalidation
   policy for approvals, gaps, evidence, and downstream artifacts. Without
   these, PRD-REQ-2 and PRD-REQ-5 cannot be evaluated consistently.
4. The persistence model can retain multiple immutable PRD artifacts and bind
   attempts and decisions to snapshot/version IDs. If it cannot, preservation
   and stale-decision isolation are impossible.

## Open product blockers

### PRD-REGEN-001 — P1 — Owning interaction surface is undefined

The request does not identify whether **Regenerate PRD** belongs to a StagePass
control, the embedded Codex TUI, or another surface. This blocks an unambiguous
user flow and the acceptance test for PRD-REQ-1.

### PRD-REGEN-002 — P1 — Regeneration inputs are undefined

The request does not decide which original, accumulated, and current inputs are
included or whether regeneration starts a fresh thread. This blocks a
deterministic definition and verification of the output in PRD-REQ-3.

### PRD-REGEN-003 — P1 — Eligibility and invalidation policies are undefined

The request does not enumerate eligible Change states or which approvals, gaps,
evidence, and downstream artifacts become non-current. This blocks objective
verification of PRD-REQ-2 and PRD-REQ-5.
