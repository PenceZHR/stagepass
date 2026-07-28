import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { stageJobNeedsFreshTask } from "./delegated-round-task-rotation.ts";
import { DELEGATED_ROUND_PHASES } from "./delegated-round-phases.ts";

// "spent" = this task has already hosted a round, so its sub-agents are burned.
const on = { delegatedRoundsEnabled: true, taskHasSpentSubAgents: true };
const onFresh = { delegatedRoundsEnabled: true, taskHasSpentSubAgents: false };
const off = { delegatedRoundsEnabled: false, taskHasSpentSubAgents: false };

describe("stage job task rotation", () => {
  /**
   * The bug this exists to stop, stated as a test.
   *
   * A round opened by 「继续对抗」 dispatches `run_*`, not `retry_*`. Under the
   * old rule (`actionId.startsWith("retry_")`) that reused the judge's Codex
   * task, so `spawn_agent` handed back the PREVIOUS round's sub-agents and the
   * attribution guard refused the round -- every single time. The human then saw
   * a failed round and a button offering to 「重新对抗」 something that had never
   * run.
   */
  for (const descriptor of DELEGATED_ROUND_PHASES) {
    it(`rotates ${descriptor.phase} when the task has already spent its sub-agents`, () => {
      assert.equal(
        stageJobNeedsFreshTask({
          actionId: `run_${descriptor.runPhase}`,
          phase: descriptor.runPhase,
          ...on,
        }),
        true,
        "reusing the task reuses the sub-agents, which the round guard refuses",
      );
    });

    it(`still rotates for ${descriptor.phase}'s retry once sub-agents are spent`, () => {
      assert.equal(
        stageJobNeedsFreshTask({
          actionId: `retry_${descriptor.runPhase}`,
          phase: descriptor.runPhase,
          ...on,
        }),
        true,
      );
    });

    /**
     * The regression this exists to stop. Rotating on every dispatch meant three
     * clicks on a failing round abandoned three Codex tasks -- and that task is
     * the only place the human can watch the adversarial round, so it went blank
     * each time. A round whose sub-agents never spawned has nothing to avoid.
     */
    it(`keeps ${descriptor.phase} on its task while the round has spent nothing`, () => {
      for (const actionId of [`run_${descriptor.runPhase}`, `retry_${descriptor.runPhase}`]) {
        assert.equal(
          stageJobNeedsFreshTask({ actionId, phase: descriptor.runPhase, ...onFresh }),
          false,
          `${actionId} threw away a clean task the human was reading`,
        );
      }
    });

    it(`does not rotate ${descriptor.phase} when the delegated form is off`, () => {
      assert.equal(
        stageJobNeedsFreshTask({
          actionId: `run_${descriptor.runPhase}`,
          phase: descriptor.runPhase,
          ...off,
        }),
        false,
        "a single-turn producer has no sub-agents, so a rotation buys nothing",
      );
    });
  }

  /**
   * Retry is the only way a human can walk away from a task holding unanswered
   * questions, so it rotates on every phase -- delegated or not, flag or no flag.
   */
  it("keeps retry rotating on phases that run no round", () => {
    assert.equal(stageJobNeedsFreshTask({ actionId: "retry_build", phase: "implement", ...on }), true);
    assert.equal(stageJobNeedsFreshTask({ actionId: "retry_review", phase: "review", ...off }), true);
  });

  it("leaves ordinary runs of other phases on their existing task", () => {
    for (const phase of ["implement", "review", "check", "retro", "delivery"]) {
      assert.equal(
        stageJobNeedsFreshTask({ actionId: `run_${phase}`, phase, ...on }),
        false,
        `${phase} has no delegated round, so it keeps the task the human is reading`,
      );
    }
  });
});
