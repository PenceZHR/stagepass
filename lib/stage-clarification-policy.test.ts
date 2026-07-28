import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  STAGE_CLARIFICATION_ORDER,
  STAGE_CLARIFICATION_POLICIES,
  resolveStageClarificationPolicy,
} from "./stage-clarification-policy";

const EXPECTED_STAGE_ORDER = [
  "prd",
  "spec",
  "tech_spec",
  "plan",
  "test_plan",
  "build",
  "review",
  "fix",
  "qa",
  "merge",
  "retro",
  "done",
] as const;

describe("all-stage clarification policy", () => {
  it("covers every canonical StagePass stage exactly once", () => {
    assert.deepEqual(STAGE_CLARIFICATION_ORDER, EXPECTED_STAGE_ORDER);
    assert.deepEqual(
      Object.keys(STAGE_CLARIFICATION_POLICIES),
      EXPECTED_STAGE_ORDER,
    );
  });

  it("gives every stage concrete question guidance and one convergence rule", () => {
    for (const stageId of STAGE_CLARIFICATION_ORDER) {
      const policy = STAGE_CLARIFICATION_POLICIES[stageId];
      assert.equal(policy.id, stageId);
      assert.ok(policy.label.length > 0, stageId);
      assert.ok(policy.objective.length > 0, stageId);
      assert.ok(policy.webSummary.length > 0, stageId);
      assert.ok(policy.completionRule.length > 0, stageId);
      assert.equal(policy.maxQuestionsPerBatch, 10, stageId);
      assert.ok(policy.exampleQuestions.length >= 3, stageId);
      assert.ok(
        policy.exampleQuestions.every((question) => question.endsWith("？")),
        `${stageId} examples must be concrete questions`,
      );
    }
  });

  it("resolves every persisted backend phase alias to its canonical stage", () => {
    for (const stageId of STAGE_CLARIFICATION_ORDER) {
      const policy = STAGE_CLARIFICATION_POLICIES[stageId];
      assert.ok(policy.phaseAliases.length > 0, stageId);
      for (const alias of policy.phaseAliases) {
        assert.equal(resolveStageClarificationPolicy(alias).id, stageId, alias);
      }
    }

    const fallback = resolveStageClarificationPolicy("unregistered-phase");
    assert.equal(fallback.id, "generic");
    assert.equal(fallback.maxQuestionsPerBatch, 10);
    assert.ok(fallback.completionRule.length > 0);
  });
});
