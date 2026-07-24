import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DESIGN_INTERACTION_PHASES,
  INTERACTION_ACTION_ALIASES,
  projectInteractionPhase,
  resolvePipelineCommandAction,
} from "./pipeline-command-action-map";

describe("pipeline command action map", () => {
  it("retains the external id while resolving the immutable canonical id", () => {
    assert.deepEqual(resolvePipelineCommandAction("supply_spec_fact"), {
      externalActionId: "supply_spec_fact",
      canonicalActionId: "request_spec_changes",
    });
    assert.equal(
      INTERACTION_ACTION_ALIASES.approve_test_plan,
      "approve_plan",
    );
  });

  it("keeps canonical ids unchanged", () => {
    assert.deepEqual(resolvePipelineCommandAction("approve_intake"), {
      externalActionId: "approve_intake",
      canonicalActionId: "approve_intake",
    });
  });

  it("keeps the external QA identity while routing request_qa_fix to Review fix", () => {
    assert.equal(INTERACTION_ACTION_ALIASES.request_qa_fix, "fix_blockers");
    assert.deepEqual(resolvePipelineCommandAction("request_qa_fix"), {
      externalActionId: "request_qa_fix",
      canonicalActionId: "fix_blockers",
    });
    assert.equal(DESIGN_INTERACTION_PHASES.request_qa_fix, "QA");
    assert.equal(projectInteractionPhase("request_qa_fix"), "QA");
  });
});
