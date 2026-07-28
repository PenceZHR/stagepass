import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GateDecisionCardError,
  type GateDecisionCard,
} from "../../../../../server/services/gate-decision-card-service";
import { handleGateDecisionCardOpen } from "./route";

function card(): GateDecisionCard {
  return {
    schemaVersion: "stagepass.gate-decision-card/v1",
    interactionId: "INT-1",
    logicalTurnId: "LT-1",
    projectId: "PRJ-1",
    changeId: "CHG-1",
    threadId: "THREAD-1",
    stage: "Spec",
    batchTitle: "Spec 对抗已出结果，请裁决",
    helperText: "第 2 轮已结算，没有阻断项。",
    questions: [{
      id: "stagepass_gate_decision",
      question: "Spec 对抗已出结果，请裁决",
      selectionMode: "single",
      options: [
        { id: "approve_spec", label: "批准 Spec" },
        { id: "reject_spec", label: "打回 Spec" },
      ],
    }],
  };
}

describe("gate decision card route", () => {
  /**
   * The plugin feeds these four fields straight into the receipt, which is
   * verified against them. If the route ever stopped returning one, the card
   * would render and every click would then fail verification.
   */
  it("returns the identifiers the receipt is verified against", async () => {
    const response = await handleGateDecisionCardOpen("INT-1", {
      open: () => card(),
    });
    assert.equal(response.status, 200);
    const json = await response.json() as Record<string, unknown>;
    for (const field of ["logicalTurnId", "projectId", "changeId", "threadId"]) {
      assert.ok(json[field], `${field} is missing from the card`);
    }
  });

  /**
   * The plugin turns any non-2xx into an error string it shows the user, so the
   * status and the code both have to survive. A refused card reported as a bare
   * 500 is what made the previous round of this path unreadable.
   */
  it("keeps the card service's own status and code", async () => {
    const response = await handleGateDecisionCardOpen("INT-NOPE", {
      open: () => {
        throw new GateDecisionCardError("gate_decision_card_not_found", 404);
      },
    });
    assert.equal(response.status, 404);
    assert.equal(
      (await response.json() as { error: string }).error,
      "gate_decision_card_not_found",
    );
  });

  /**
   * `presented` is the record that a human was shown this decision, so a page
   * in a browser must not be able to write it about a card nobody saw.
   */
  it("refuses a request carrying a browser origin", async () => {
    let opened = 0;
    const response = await handleGateDecisionCardOpen(
      "INT-1",
      { open: () => { opened += 1; return card(); } },
      new Request("http://stagepass.test/api/interactions/INT-1/card", {
        method: "POST",
        headers: { origin: "http://evil.test" },
      }),
    );
    assert.equal(response.status, 403);
    assert.equal(
      (await response.json() as { error: string }).error,
      "gate_decision_card_browser_origin_forbidden",
    );
    assert.equal(opened, 0, "the card must not be opened before the check");
  });

  it("names an unclassified failure instead of swallowing it", async () => {
    const response = await handleGateDecisionCardOpen("INT-1", {
      open: () => {
        throw new Error("sqlite is on fire");
      },
    });
    assert.equal(response.status, 500);
    const json = await response.json() as { error: string; detail: string };
    assert.equal(json.error, "gate_decision_card_open_failed");
    assert.match(json.detail, /sqlite is on fire/);
  });
});
