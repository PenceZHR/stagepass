import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DECISION_ACTIONS } from "./design-gate-decision-presenter";
import { requireActionDefinition } from "./action-contract-registry-service";
import {
  DesignDecisionPayloads,
  isHumanDecisionAction,
  PrdInteractionPayloads,
} from "./pipeline-command-gateway";
import { decisionPayload } from "./stage-approval-command-service";

/**
 * Every option on a gate decision card must survive the click.
 *
 * Two whole classes of button were on these cards and could not be executed by
 * anything, in both cases because the card list and the thing that executes it
 * were edited independently:
 *
 *  - `request_tech_spec_changes`, `request_plan_changes`,
 *    `request_test_plan_changes` had contract entries and labels but were never
 *    added to `HUMAN_DECISION_ACTIONS`, so `assertActorAllowed` refused them as
 *    `actor_surface_forbidden` for the only surface that records these clicks.
 *  - `waive_spec_p1` and `waive_plan_p1` demand `{gapId, reason}` and
 *    `{riskId, reason}`, which a single click cannot supply, so they would fail
 *    `invalid_pipeline_command` on a payload the card had no field for.
 *
 * Neither was findable by testing the card, the contract or the gateway alone --
 * each was internally consistent. The invariant only exists ACROSS them, so this
 * asserts it across them: for every action a card may offer, the recording
 * surface accepts it and the payload builder produces something its schema
 * takes.
 */

const PAYLOAD_SCHEMAS: Record<string, { safeParse(value: unknown): { success: boolean; error?: unknown } }> = {
  ...PrdInteractionPayloads,
  ...DesignDecisionPayloads,
};

const everyOfferedAction = Object.entries(DECISION_ACTIONS).flatMap(
  ([phase, actionIds]) => actionIds.map((actionId) => ({ phase, actionId })),
);

describe("every gate decision card option is executable", () => {
  for (const { phase, actionId } of everyOfferedAction) {
    it(`${phase}/${actionId} is accepted by the recording surface`, () => {
      assert.ok(
        isHumanDecisionAction(actionId),
        `${actionId} is offered on the ${phase} card but is not a human decision `
        + "action, so stagepass_web_emergency refuses it as actor_surface_forbidden "
        + "-- the click cannot ever succeed",
      );
    });

    it(`${phase}/${actionId} has a payload the card can actually build`, () => {
      const schema = PAYLOAD_SCHEMAS[actionId];
      if (!schema) return; // No schema means the payload passes through.
      const built = decisionPayload(actionId, "打回理由");
      assert.ok(
        schema.safeParse(built).success,
        `${actionId} demands fields a one-click card has no way to supply `
        + `(built ${JSON.stringify(built)}). Either the card must ask which one, `
        + "or the action does not belong on it.",
      );
    });

    it(`${phase}/${actionId} has a label to render`, () => {
      // `openGateDecisionCard` reads labels from this registry and throws
      // without one, so a missing entry breaks the card at open time.
      assert.ok(requireActionDefinition(actionId).label);
    });
  }

  /**
   * The plugin refuses a question with fewer than two options
   * (`invalid_options`), so a phase offering one action opens a card that cannot
   * render. TestPlan is currently in exactly that state on purpose -- its only
   * approval id is an alias for `approve_plan`, whose label names the wrong
   * phase -- and the presenter skips it rather than opening a card that fails.
   */
  it("names the phases that cannot yet open a card", () => {
    const tooFew = Object.entries(DECISION_ACTIONS)
      .filter(([, actionIds]) => actionIds.length < 2)
      .map(([phase]) => phase);
    assert.deepEqual(
      tooFew,
      ["TestPlan"],
      "a phase with fewer than two options opens no card; if this list changed, "
      + "either a phase silently lost its decision surface or TestPlan gained one",
    );
  });
});
