import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { answerFromChoices } from "./panel-view";

const QUESTION = {
  fields: [
    { id: "G-01", options: ["同意", "不同意", "先接受风险", "我自己说"] },
    { id: "G-02", options: ["同意", "不同意", "先接受风险", "我自己说"] },
  ],
};

describe("Choices the browser sends back", () => {
  it("maps a position to the option text, so nobody retypes the wording", () => {
    // 长措辞一旦要被谁抄一遍就迟早抄歪，而抄歪之后落进库里的是一个看起来合法的错答案。
    assert.deepEqual(answerFromChoices(QUESTION, { "G-01": "0", "G-02": "2" }), {
      "G-01": "同意", "G-02": "先接受风险",
    });
  });

  it("refuses a half-filled form rather than booking part of it", () => {
    assert.equal(answerFromChoices(QUESTION, { "G-01": "0" }), null);
  });

  it("refuses a position that is not one of the offered options", () => {
    for (const bad of ["4", "-1", "1.5", "", "同意", "NaN"]) {
      assert.equal(
        answerFromChoices(QUESTION, { "G-01": "0", "G-02": bad }), null, bad,
      );
    }
  });

  it("answers nothing when there is nothing to answer", () => {
    assert.deepEqual(answerFromChoices({ fields: [] }, {}), {});
  });
});
