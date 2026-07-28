import {
  advancesTo,
  sendsToFix,
  FIRST_PHASE,
  TERMINAL_PHASE,
  type Phase,
} from "./phase";

/**
 * Where a Change is, and what may happen to it next.
 *
 * ## Why one status vocabulary instead of per-phase statuses
 *
 * The tree this replaces spelled the same four ideas differently in every
 * phase: `INTAKE_PENDING` / `SPECCING` / `TECHSPECCING` / `IMPLEMENTING` all
 * mean "a turn is running", and `INTAKE_READY` / `SPEC_READY` / `PLAN_READY` /
 * `TESTPLAN_DONE` all mean "there is a result and a human has to look at it".
 * Twenty-odd names for five ideas, each needing its own branch, each a place
 * for the branches to disagree.
 *
 * Here a Change is `(phase, status)`. The phase says where; the status says
 * what may happen next, and it means the same thing in every phase.
 *
 * ## This module is pure
 *
 * No database, no clock, no IO. Every legal and illegal transition can be
 * enumerated and proved offline, which is what L0 has to deliver before
 * anything is allowed to be built on top of it.
 */

export const PHASE_STATUSES = [
  /** Nothing has run in this phase yet. */
  "pending",
  /** A turn is executing. */
  "running",
  /** A turn produced a result and a human has to decide. */
  "settled",
  /** The turn failed. Nothing advances until someone retries. */
  "blocked",
  /** The terminal phase was approved. The Change is finished; nothing follows. */
  "closed",
] as const;

export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export const CHANGE_ACTIONS = [
  "start",
  "settle",
  "fail",
  "retry",
  "approve",
  "reject",
] as const;

export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

export interface ChangeState {
  readonly phase: Phase;
  readonly status: PhaseStatus;
  /**
   * Where leaving Fix returns to.
   *
   * Set when Review or QA sends work back, cleared on the way out. Non-null
   * only while `phase` is `Fix` -- `assertStateValid` enforces that, because a
   * stale return target is how a QA failure ends up back in Review.
   */
  readonly returnPhase: Phase | null;
}

/**
 * The only actions each status accepts. This table IS the state machine; the
 * transition function below decides where an accepted action lands, never
 * whether it was allowed.
 */
const ACCEPTS: Readonly<Record<PhaseStatus, readonly ChangeAction[]>> = {
  pending: ["start"],
  running: ["settle", "fail"],
  settled: ["approve", "reject"],
  blocked: ["retry"],
  closed: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly state: ChangeState,
    readonly action: ChangeAction,
  ) {
    super(
      `${action} is not legal in ${state.phase}/${state.status}`
      + ` (accepts: ${ACCEPTS[state.status].join(", ") || "nothing"})`,
    );
    this.name = "IllegalTransitionError";
  }
}

export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateError";
  }
}

export const INITIAL_STATE: ChangeState = {
  phase: FIRST_PHASE,
  status: "pending",
  returnPhase: null,
};

export function accepts(status: PhaseStatus): readonly ChangeAction[] {
  return ACCEPTS[status];
}

export function isLegal(state: ChangeState, action: ChangeAction): boolean {
  return ACCEPTS[state.status].includes(action);
}

/**
 * A state that could never have been produced by `transition` must not be
 * accepted back into it -- otherwise a corrupted row becomes a legal starting
 * point and the machine's guarantees stop meaning anything.
 */
export function assertStateValid(state: ChangeState): void {
  if (state.returnPhase !== null && state.phase !== "Fix") {
    throw new InvalidStateError(
      `returnPhase is set on ${state.phase}; only Fix may carry one`,
    );
  }
  if (state.phase === "Fix" && state.returnPhase === null) {
    throw new InvalidStateError(
      "Fix has no returnPhase, so nothing can say where approving it leads",
    );
  }
  // Terminal by name, not by "has no outgoing edge". Fix also has no entry in
  // ADVANCES_TO -- it leaves via its return target -- so deriving terminality
  // from that map would make `Fix/closed` a representable state, and a Change
  // stranded there could never be touched again.
  if (state.status === "closed" && state.phase !== TERMINAL_PHASE) {
    throw new InvalidStateError(
      `${state.phase} is closed but ${TERMINAL_PHASE} is the only terminal phase`,
    );
  }
}

/**
 * The next state, or a throw. Total over legal input, and the single place
 * where a Change's position may change.
 */
export function transition(
  state: ChangeState,
  action: ChangeAction,
): ChangeState {
  assertStateValid(state);
  if (!isLegal(state, action)) throw new IllegalTransitionError(state, action);

  switch (action) {
    case "start":
    case "retry":
      return { ...state, status: "running" };
    case "settle":
      return { ...state, status: "settled" };
    case "fail":
      return { ...state, status: "blocked" };
    case "reject":
      // Rejecting a design phase means "run another round here". Rejecting
      // Review or QA means the code is wrong, which is Fix's job -- and Fix has
      // to remember which of the two to return to.
      return sendsToFix(state.phase)
        ? { phase: "Fix", status: "pending", returnPhase: state.phase }
        : { ...state, status: "pending" };
    case "approve":
      if (state.phase === "Fix") {
        return {
          phase: state.returnPhase!,
          status: "pending",
          returnPhase: null,
        };
      }
      {
        const next = advancesTo(state.phase);
        return next === null
          ? { ...state, status: "closed" }
          : { phase: next, status: "pending", returnPhase: null };
      }
  }
}
