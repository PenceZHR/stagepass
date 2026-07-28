import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  approvalDecisionFromAnswers,
  STAGE_APPROVAL_ACTIONS,
} from "./stage-approval-command-service";
import { STAGE_APPROVAL_QUESTION_ID } from "./stage-convergence-service";

function answer(labels: string[], ids = ["A"]) {
  return [{
    questionId: STAGE_APPROVAL_QUESTION_ID,
    question: "是否批准本阶段？",
    selectedOptionIds: ids,
    selectedLabels: labels,
  }];
}

describe("stage approval decision", () => {
  it("reads an approval by its option id, not by prose", () => {
    assert.deepEqual(
      approvalDecisionFromAnswers("prd", answer(["批准"], ["A"])),
      { actionId: "approve_intake" },
    );
  });

  it("reads a rejection", () => {
    assert.deepEqual(
      approvalDecisionFromAnswers("prd", answer(["打回"], ["B"])),
      { actionId: "reject_intake" },
    );
  });

  // A batch of real questions must never be mistaken for the go-ahead.
  it("ignores a batch that is not the approval question", () => {
    assert.equal(
      approvalDecisionFromAnswers("prd", [{
        questionId: "session_duration",
        question: "单局多长？",
        selectedOptionIds: ["A"],
        selectedLabels: ["3 分钟"],
      }]),
      null,
    );
  });

  it("ignores an approval answer for a phase with no gate action", () => {
    assert.equal(approvalDecisionFromAnswers("retro", answer(["批准"])), null);
  });

  // An option id outside the declared pair is not a decision this can guess at.
  it("refuses an unrecognized option", () => {
    assert.equal(
      approvalDecisionFromAnswers("prd", answer(["随便"], ["C"])),
      null,
    );
  });

  it("declares an approve and a reject action for every gated phase", () => {
    for (const [phase, actions] of Object.entries(STAGE_APPROVAL_ACTIONS)) {
      assert.ok(actions.approve, `${phase} approve`);
      assert.ok(actions.reject, `${phase} reject`);
    }
  });
});
