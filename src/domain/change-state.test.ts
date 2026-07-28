import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advancesTo,
  isPhase,
  PHASES,
  TERMINAL_PHASE,
  type Phase,
} from "./phase";
import {
  accepts,
  assertStateValid,
  CHANGE_ACTIONS,
  IllegalTransitionError,
  INITIAL_STATE,
  InvalidStateError,
  isLegal,
  PHASE_STATUSES,
  transition,
  type ChangeState,
} from "./change-state";

/**
 * L0's acceptance evidence.
 *
 * Every assertion here runs with no database, no clock, no network and no
 * model. That is the whole point of the layer: if the foundation cannot be
 * proved without the things built on top of it, then nothing built on top can
 * be trusted to have a foundation.
 */

/** A state to probe from. Fix is the one phase that requires a return target. */
function probe(phase: Phase, status: (typeof PHASE_STATUSES)[number]): ChangeState {
  return {
    phase,
    status,
    returnPhase: phase === "Fix" ? "Review" : null,
  };
}

function representable(state: ChangeState): boolean {
  try {
    assertStateValid(state);
    return true;
  } catch {
    return false;
  }
}

describe("L0 · the state machine is exhaustively decided", () => {
  /**
   * The headline: every (phase, status, action) triple has a decided outcome,
   * and no triple is left to chance. A machine that is only tested on its happy
   * path is a machine whose illegal transitions are undefined behaviour.
   */
  it("decides every phase x status x action triple", () => {
    let legal = 0;
    let rejected = 0;
    let unrepresentable = 0;

    for (const phase of PHASES) {
      for (const status of PHASE_STATUSES) {
        const state = probe(phase, status);
        if (!representable(state)) {
          unrepresentable += 1;
          continue;
        }
        for (const action of CHANGE_ACTIONS) {
          if (isLegal(state, action)) {
            const next = transition(state, action);
            // Whatever comes out must itself be a state the machine would
            // accept back. Without this, one transition can strand the Change
            // somewhere no further transition can leave.
            assert.doesNotThrow(
              () => assertStateValid(next),
              `${phase}/${status} --${action}--> produced an invalid state`,
            );
            assert.ok(isPhase(next.phase));
            legal += 1;
          } else {
            assert.throws(
              () => transition(state, action),
              IllegalTransitionError,
              `${phase}/${status} must refuse ${action}`,
            );
            rejected += 1;
          }
        }
      }
    }

    // Stated so a shrinking machine is visible rather than silent: if a future
    // edit removes a phase, a status or an action, these numbers move and the
    // test says so instead of quietly covering less.
    assert.equal(
      legal + rejected + unrepresentable * CHANGE_ACTIONS.length,
      PHASES.length * PHASE_STATUSES.length * CHANGE_ACTIONS.length,
    );
    // 12 phases x 4 representable statuses, at 1/2/2/1 accepted actions each.
    assert.equal(legal, 12 * (1 + 2 + 2 + 1));
    // `closed` is representable only on Done, so 11 phases contribute no state.
    assert.equal(unrepresentable, PHASES.length - 1);
    assert.equal(rejected, 222);
  });

  it("accepts nothing at all once closed", () => {
    assert.deepEqual(accepts("closed"), []);
    for (const action of CHANGE_ACTIONS) {
      assert.throws(
        () => transition(
          { phase: TERMINAL_PHASE, status: "closed", returnPhase: null },
          action,
        ),
        IllegalTransitionError,
      );
    }
  });
});

describe("L0 · every phase is reachable and Done is the only exit", () => {
  /** Breadth-first over the whole machine from the state a Change is created in. */
  function explore(): Map<string, ChangeState> {
    const seen = new Map<string, ChangeState>();
    const queue: ChangeState[] = [INITIAL_STATE];
    const key = (state: ChangeState) =>
      `${state.phase}/${state.status}/${state.returnPhase ?? "-"}`;
    seen.set(key(INITIAL_STATE), INITIAL_STATE);
    while (queue.length > 0) {
      const state = queue.shift()!;
      for (const action of CHANGE_ACTIONS) {
        if (!isLegal(state, action)) continue;
        const next = transition(state, action);
        if (seen.has(key(next))) continue;
        seen.set(key(next), next);
        queue.push(next);
      }
    }
    return seen;
  }

  /**
   * A phase no walk can reach is a phase that exists only in the list. That is
   * exactly the shape of the thing this rebuild is removing: something that
   * looks implemented and is not.
   */
  it("reaches all twelve phases from a fresh Change", () => {
    const reached = new Set(
      [...explore().values()].map((state) => state.phase),
    );
    assert.deepEqual([...reached].sort(), [...PHASES].sort());
  });

  it("has exactly one state that nothing leaves", () => {
    const dead = [...explore().values()].filter(
      (state) => !CHANGE_ACTIONS.some((action) => isLegal(state, action)),
    );
    assert.deepEqual(dead, [
      { phase: TERMINAL_PHASE, status: "closed", returnPhase: null },
    ]);
  });

  it("only the terminal phase can close", () => {
    for (const phase of PHASES) {
      const terminal = advancesTo(phase) === null && phase !== "Fix";
      assert.equal(
        terminal,
        phase === TERMINAL_PHASE,
        `${phase} disagrees with the terminal definition`,
      );
    }
  });
});

describe("L0 · Fix returns to whoever sent it", () => {
  function settled(phase: Phase): ChangeState {
    return { phase, status: "settled", returnPhase: null };
  }

  /**
   * The bug this forbids: encoding Fix's exit as a constant edge, which sends
   * every QA failure back through Review.
   */
  for (const origin of ["Review", "QA"] as const) {
    it(`${origin} rejection goes to Fix and comes back to ${origin}`, () => {
      const toFix = transition(settled(origin), "reject");
      assert.deepEqual(toFix, {
        phase: "Fix",
        status: "pending",
        returnPhase: origin,
      });

      const fixed = transition(
        transition(transition(toFix, "start"), "settle"),
        "approve",
      );
      assert.deepEqual(fixed, {
        phase: origin,
        status: "pending",
        returnPhase: null,
      });
    });
  }

  it("reopens a design phase in place rather than sending it to Fix", () => {
    for (const phase of ["PRD", "Spec", "TechSpec", "Plan", "TestPlan"] as const) {
      assert.deepEqual(transition(settled(phase), "reject"), {
        phase,
        status: "pending",
        returnPhase: null,
      });
    }
  });

  it("reopens Fix in place when its own result is rejected", () => {
    assert.deepEqual(
      transition(
        { phase: "Fix", status: "settled", returnPhase: "QA" },
        "reject",
      ),
      { phase: "Fix", status: "pending", returnPhase: "QA" },
    );
  });
});

describe("L0 · a corrupted state cannot re-enter the machine", () => {
  it("refuses a return target outside Fix", () => {
    assert.throws(
      () => transition(
        { phase: "Spec", status: "settled", returnPhase: "Review" },
        "approve",
      ),
      InvalidStateError,
    );
  });

  it("refuses Fix without a return target", () => {
    assert.throws(
      () => transition(
        { phase: "Fix", status: "settled", returnPhase: null },
        "approve",
      ),
      InvalidStateError,
    );
  });

  it("refuses a closed status on a non-terminal phase", () => {
    assert.throws(
      () => transition(
        { phase: "Spec", status: "closed", returnPhase: null },
        "start",
      ),
      InvalidStateError,
    );
  });
});

describe("L0 · the walk a real Change takes", () => {
  it("goes from a fresh Change to closed with no illegal step", () => {
    let state = INITIAL_STATE;
    const visited: string[] = [state.phase];
    // Approve straight through: every phase runs once, settles once, passes.
    for (let guard = 0; guard < 100; guard += 1) {
      if (state.status === "closed") break;
      state = transition(state, "start");
      state = transition(state, "settle");
      state = transition(state, "approve");
      if (state.phase !== visited[visited.length - 1]) visited.push(state.phase);
    }
    assert.equal(state.status, "closed");
    assert.equal(state.phase, TERMINAL_PHASE);
    // Fix is absent: nothing was rejected, so nothing was sent back.
    assert.deepEqual(visited, [
      "PRD", "Spec", "TechSpec", "Plan", "TestPlan",
      "Build", "Review", "QA", "Merge", "Retro", "Done",
    ]);
  });
});
