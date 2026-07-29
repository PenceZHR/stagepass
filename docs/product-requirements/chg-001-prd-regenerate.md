# Product Requirement: Regenerate the PRD

## Who it is for

This change is for a StagePass user who is working on a Change in the PRD
stage and has received a PRD result that is unusable or needs to be generated
again. The user needs an explicit, discoverable way to request another PRD
generation without leaving the Change or manually recreating it.

## Required outcome

The PRD experience must expose a clearly labelled **Regenerate** action when a
PRD has already been generated and the Change is still eligible for PRD work.

When the user invokes the action:

- StagePass must ask for confirmation before starting, because regeneration can
  supersede the document on which later decisions are based.
- The action must start a new PRD generation attempt for the same Change, using
  the Change's current requirements and the latest applicable PRD-stage
  context.
- The existing PRD artifact and its attempt/audit history must remain
  recoverable. The new result must be recorded as a new version or attempt,
  never silently overwrite the only copy of the previous result.
- While generation is running, the action must be disabled and its visible
  state must make duplicate submission impossible.
- On success, the newly generated PRD must become the current PRD result and
  the UI must show that result without requiring the user to leave the Change.
- On failure or cancellation, the prior successful PRD must remain current and
  usable, and the UI must show a clear failure or cancellation outcome.
- Any approval, gate decision, or downstream evidence bound to an older PRD
  snapshot must not silently remain valid. StagePass must apply its existing
  snapshot/fence rules and visibly return the Change to the state required for
  review of the new PRD.
- The action must be unavailable when the Change is not allowed to regenerate
  PRD, including while another PRD run is active. The UI and execution path
  must enforce the same eligibility rule.

Success means an eligible user can intentionally produce a fresh, auditable
PRD result in one flow, cannot accidentally launch duplicate generations, and
cannot mistake approvals or evidence from the previous PRD for approval of the
new one.

## Out of scope

- Editing PRD content inline.
- Comparing, merging, or selectively accepting sections from multiple PRD
  versions.
- Regenerating Spec, Tech Spec, Plan, Test Plan, or any other phase.
- Changing the PRD-generation prompt, model, provider, or generation quality.
- Automatically approving the regenerated PRD or advancing the Change to the
  next phase.
- Deleting old PRD artifacts, attempts, decisions, or audit history.
- Redesigning the StagePass stage orbit, terminal, or overall navigation.
- Adding an unrestricted retry that bypasses the normal Change state machine,
  snapshot fence, or single-live-process rule.

## Product blockers

### PRD-REGEN-001 — P1 — The target “PRD page” is not defined

The current web product exposes a PRD stage inside the shared terminal panel,
not a separate PRD document page. Product/design must identify the exact
surface that owns the action and specify whether it is a StagePass control or
an action performed inside the Codex TUI. This matters because the standing
product rule says human decisions occur inside the Codex TUI and the panel does
not interpret terminal output.

### PRD-REGEN-002 — P1 — Regeneration inputs are not defined

The request does not say whether regeneration reuses the original prompt,
includes answers and conversation accumulated in the existing PRD thread, or
starts a fresh PRD thread from persisted artifacts. The choice changes both the
result and whether the snapshot fence covers every input.

### PRD-REGEN-003 — P1 — Eligibility and invalidation policy are not defined

The request does not define which Change states permit regeneration or exactly
which existing PRD approval, evidence, open gaps, and downstream artifacts must
be invalidated. Implementation must not proceed until the state transition and
fence behavior are specified.
