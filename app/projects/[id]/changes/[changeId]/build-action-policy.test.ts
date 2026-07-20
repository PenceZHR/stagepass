import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildActionErrorSignature,
  buildVisibleActionSlots,
  type BuildActionPolicyAction,
  type BuildActionPolicyRun,
} from "./build-action-policy";

function action(
  actionId: string,
  enabled: boolean,
  reasonCode: string | null = null,
): BuildActionPolicyAction {
  return { actionId, enabled, reasonCode };
}

function run(
  status: BuildActionPolicyRun["status"],
  purpose: BuildActionPolicyRun["purpose"] = "build",
): BuildActionPolicyRun {
  return { status, purpose };
}

describe("build action policy", () => {
  it("publishes only adopt while Build is approved for absorb", () => {
    const slots = buildVisibleActionSlots({
      buildRun: run("approved_for_absorb"),
      startAction: action("retry_build", false, "no_running_build_run"),
      adoptAction: action("adopt_build", true),
      rejectAction: action("reject_build", false, "build_not_rejectable"),
    });

    assert.deepEqual(slots.map((slot) => slot.id), ["build-adopt"]);
  });

  it("keeps reject visible for awaiting_human when the backend allows it", () => {
    const slots = buildVisibleActionSlots({
      buildRun: run("awaiting_human"),
      startAction: action("retry_build", false, "not_at_gate"),
      adoptAction: action("adopt_build", false, "build_not_approved_for_absorb"),
      rejectAction: action("reject_build", true),
    });

    assert.deepEqual(slots.map((slot) => slot.id), ["build-reject"]);
  });

  it("keeps the stale-running retry blocker visible", () => {
    const slots = buildVisibleActionSlots({
      buildRun: run("running"),
      startAction: action("retry_build", false, "build_run_running"),
      adoptAction: action("adopt_build", false, "build_not_awaiting_absorb"),
      rejectAction: action("reject_build", false, "build_not_rejectable"),
    });

    assert.deepEqual(slots.map((slot) => slot.id), ["build-start"]);
  });

  it("keeps a disabled Build start action visible so the gate reason can be shown", () => {
    const slots = buildVisibleActionSlots({
      buildRun: null,
      startAction: action("run_build", false, "not_at_gate"),
      adoptAction: action("adopt_build", false, "build_not_approved_for_absorb"),
      rejectAction: action("reject_build", false, "build_not_rejectable"),
    });

    assert.deepEqual(slots, [{ id: "build-start", sourceActionId: "run_build" }]);
  });

  it("does not change the stale-error signature for busy or enabled-only changes", () => {
    const before = buildActionErrorSignature({
      buildRun: run("approved_for_absorb"),
      slots: [{ id: "build-adopt", sourceActionId: "adopt_build" }],
    });
    const after = buildActionErrorSignature({
      buildRun: run("approved_for_absorb"),
      slots: [{ id: "build-adopt", sourceActionId: "adopt_build" }],
    });

    assert.equal(before, after);
  });

  it("changes the stale-error signature when retry/reject noise collapses to adopt only", () => {
    const before = buildActionErrorSignature({
      buildRun: run("running"),
      slots: [
        { id: "build-start", sourceActionId: "retry_build" },
        { id: "build-adopt", sourceActionId: "adopt_build" },
        { id: "build-reject", sourceActionId: "reject_build" },
      ],
    });
    const after = buildActionErrorSignature({
      buildRun: run("approved_for_absorb"),
      slots: [{ id: "build-adopt", sourceActionId: "adopt_build" }],
    });

    assert.notEqual(before, after);
  });
});
