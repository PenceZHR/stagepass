import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePipelineActionCommand } from "./pipeline-action-commands";

const OPERATIONAL_RUN_ACTION_IDS = [
  "run_prd",
  "retry_prd",
  "run_spec",
  "retry_spec",
  "run_tech_spec",
  "retry_tech_spec",
  "run_plan",
  "retry_plan",
  "run_test_plan",
  "retry_test_plan",
  "run_build",
  "retry_build",
  "run_review",
  "retry_review",
  "run_qa",
  "retry_qa",
  "run_retro",
  "run_delivery",
] as const;

describe("pipeline action command mapping", () => {
  it("resolves every operational run/retry action id to an endpoint", () => {
    for (const actionId of OPERATIONAL_RUN_ACTION_IDS) {
      assert.ok(resolvePipelineActionCommand(actionId)?.endpoint, `${actionId} should resolve`);
    }
  });

  it("keeps stable endpoint mappings for pipeline commands", () => {
    const expectedEndpoints: Record<string, string> = {
      run_prd: "intake",
      retry_prd: "intake",
      run_spec: "spec",
      retry_spec: "spec",
      run_tech_spec: "tech-spec",
      retry_tech_spec: "tech-spec",
      run_plan: "plan",
      retry_plan: "plan",
      run_test_plan: "test-plan",
      retry_test_plan: "test-plan",
      run_build: "implement",
      retry_build: "implement",
      run_review: "review",
      retry_review: "review",
      run_qa: "check",
      retry_qa: "check",
      run_retro: "retro",
      run_delivery: "delivery",
    };

    for (const [actionId, endpoint] of Object.entries(expectedEndpoints)) {
      assert.equal(resolvePipelineActionCommand(actionId)?.endpoint, endpoint);
    }
  });

  it("returns null for unknown action ids", () => {
    assert.equal(resolvePipelineActionCommand("missing_action"), null);
  });

  it("does not route business decisions from Web", () => {
    for (const actionId of [
      "approve_intake",
      "approve_plan",
      "enter_qa",
      "fix_blockers",
      "merge",
      "stop_change",
      "waive_plan_p1",
    ]) {
      assert.equal(resolvePipelineActionCommand(actionId), null);
    }
  });
});
