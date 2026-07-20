import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePipelineActionCommand } from "./pipeline-action-commands";

const TASK_14_ACTION_IDS = [
  "run_prd",
  "retry_prd",
  "run_spec",
  "retry_spec",
  "run_tech_spec",
  "retry_tech_spec",
  "run_plan",
  "retry_plan",
  "approve_plan",
  "run_test_plan",
  "retry_test_plan",
  "run_build",
  "retry_build",
  "run_review",
  "retry_review",
  "run_qa",
  "retry_qa",
  "fix_blockers",
  "merge",
  "run_retro",
  "regenerate_plan_report",
  "waive_plan_p1",
  "approve_intake",
  "enter_qa",
  "stop_change",
] as const;

describe("pipeline action command mapping", () => {
  it("resolves every Task 14 action id to an endpoint", () => {
    for (const actionId of TASK_14_ACTION_IDS) {
      assert.ok(resolvePipelineActionCommand(actionId)?.endpoint, `${actionId} should resolve`);
    }
  });

  it("keeps stable endpoint mappings for pipeline commands", () => {
    const expectedEndpoints: Record<string, string> = {
      run_prd: "intake",
      retry_prd: "intake",
      approve_intake: "intake",
      run_spec: "spec",
      retry_spec: "spec",
      run_tech_spec: "tech-spec",
      retry_tech_spec: "tech-spec",
      run_plan: "plan",
      retry_plan: "plan",
      approve_plan: "approve-plan",
      run_test_plan: "test-plan",
      retry_test_plan: "test-plan",
      run_build: "implement",
      retry_build: "implement",
      run_review: "review",
      retry_review: "review",
      enter_qa: "check",
      run_qa: "check",
      retry_qa: "check",
      fix_blockers: "fix",
      merge: "release",
      run_retro: "retro",
      regenerate_plan_report: "plan-sandbox/report",
      waive_plan_p1: "plan-sandbox/decision",
    };

    for (const [actionId, endpoint] of Object.entries(expectedEndpoints)) {
      assert.equal(resolvePipelineActionCommand(actionId)?.endpoint, endpoint);
    }
  });

  it("returns null for unknown action ids", () => {
    assert.equal(resolvePipelineActionCommand("missing_action"), null);
  });
});
