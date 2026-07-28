---
name: stagepass-gate
description: Use when StagePass has a pending gate decision for a change - a design round has settled and a human must approve, reject, waive a P1, or ask for another adversarial round. Trigger on a StagePass interactionId, or when asked to show or record a StagePass gate decision.
---

# StagePass gate decisions

A StagePass design round (Spec, TechSpec, Plan, TestPlan) ends by producing a
decision only a human can make. StagePass's web UI deliberately does not route
approvals or waivers, so this is the surface where those decisions happen.

## Showing a decision

Call `present_stagepass_interaction` with the `interactionId`. It returns the
change, the phase, the blockers, the open gaps, and the options that are legal
**right now** — each option's availability is recomputed against the change's
action contract, not read off the card.

Show the options to the human and stop.

## What you must not do

- **Never choose.** Not even when the answer looks obvious, and not when only
  one option is available. The whole point of the round is that a human decided.
- **Never describe a decision as made.** A decision that exists only in chat has
  no receipt; StagePass has no record of it and the pipeline will not move.
- If the tool reports an option as unavailable, say so and say why. Do not
  retry it and do not substitute a different one.

## Recording a decision

Only after the human has said which option they want, call
`record_stagepass_gate_decision` with their `actionId` and, where the action
needs one, their `reason` in their own words.

The reason is not a formality: another adversarial round costs a full
red/blue/judge cycle, and a P1 waiver accepts a risk on the record. Write down
what the human said, not a tidier version of it.
