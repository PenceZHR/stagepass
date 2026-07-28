/**
 * The twelve phases a Change moves through, and where approval leads.
 *
 * ## One phase, one name
 *
 * These identifiers are the ONLY names for these phases anywhere in the tree --
 * in code, in the database, in a card, in a log line. No aliases, no casing
 * variants, no per-layer vocabulary.
 *
 * The tree this replaces had three names for the first phase alone: the stage
 * was `intake`, its gate was `PRD`, and the decision allowlist called it
 * `Intake`. A receipt carrying one of them was compared against a binding
 * holding another, and the comparison could never succeed -- that was the first
 * structurally-impossible check found on 2026-07-28, and it cost a day.
 *
 * It also disagreed with itself about how many phases exist: `CONTENT_PHASES`
 * listed thirteen (including `Implement` and `Check`), while `PipelinePhase`
 * declared nine. Neither matched the product definition. This list does.
 */
export const PHASES = [
  "PRD",
  "Spec",
  "TechSpec",
  "Plan",
  "TestPlan",
  "Build",
  "Review",
  "Fix",
  "QA",
  "Merge",
  "Retro",
  "Done",
] as const;

export type Phase = (typeof PHASES)[number];

const PHASE_SET: ReadonlySet<string> = new Set(PHASES);

export function isPhase(value: string): value is Phase {
  return PHASE_SET.has(value);
}

/**
 * Where an approval moves the Change.
 *
 * `Fix` is deliberately absent from this map. It is not a step in the line: it
 * is entered when Review or QA sends work back, and leaving it returns to
 * whichever of the two sent it. That target is state, not a constant, so it
 * lives on the Change (`returnPhase`) rather than here. Encoding it as a fixed
 * edge would silently send every QA failure back through Review.
 */
const ADVANCES_TO: Readonly<Record<Phase, Phase | null>> = {
  PRD: "Spec",
  Spec: "TechSpec",
  TechSpec: "Plan",
  Plan: "TestPlan",
  TestPlan: "Build",
  Build: "Review",
  Review: "QA",
  Fix: null,
  QA: "Merge",
  Merge: "Retro",
  Retro: "Done",
  Done: null,
};

export function advancesTo(phase: Phase): Phase | null {
  return ADVANCES_TO[phase];
}

/**
 * The phases that send work to Fix instead of simply reopening themselves.
 *
 * Rejecting a design phase means "run another round here". Rejecting Review or
 * QA means the code is wrong, which is a different phase's job.
 */
const SENDS_TO_FIX: ReadonlySet<Phase> = new Set<Phase>(["Review", "QA"]);

export function sendsToFix(phase: Phase): boolean {
  return SENDS_TO_FIX.has(phase);
}

/** The phase every Change starts in. */
export const FIRST_PHASE: Phase = "PRD";

/** The phase a Change ends in. Nothing leaves it. */
export const TERMINAL_PHASE: Phase = "Done";
