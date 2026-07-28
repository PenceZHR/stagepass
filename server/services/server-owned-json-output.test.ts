import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeServerOwnedJsonFailure,
  readServerOwnedJson,
} from "./server-owned-json-output.ts";
import { SPEC_JUDGE_OUTPUT_JSON_SCHEMA } from "./spec-judge-output-schema.ts";
import {
  BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA,
  RED_SPEC_OUTPUT_JSON_SCHEMA,
} from "./spec-battle-ledger.ts";

const JUDGE = {
  verdict: "红方补齐了导出上限，蓝方提出的 P2 不阻断。",
  rubric: [{ criterionId: "crit-1", verdict: "yes", evidence: "见 delta 第 3 节" }],
  roundDone: true,
};

function failureCode(text: string, schema: Record<string, unknown>): string {
  const result = readServerOwnedJson(text, schema);
  assert.equal(result.ok, false, `expected a violation for: ${text.slice(0, 60)}`);
  return result.ok ? "" : result.failure.code;
}

describe("server-owned JSON output", () => {
  it("accepts a reply that is exactly the schema's document", () => {
    const result = readServerOwnedJson(JSON.stringify(JUDGE), SPEC_JUDGE_OUTPUT_JSON_SCHEMA);

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.value : null, JUDGE);
  });

  /**
   * A fence is a formatting habit, not a structural choice, and a sub-agent
   * given its schema in the prompt will sometimes wrap the document. Who
   * authored the structure is unchanged, so this is not a loosening.
   */
  it("accepts a single fence wrapping the whole document", () => {
    const result = readServerOwnedJson(
      "```json\n" + JSON.stringify(JUDGE) + "\n```",
      SPEC_JUDGE_OUTPUT_JSON_SCHEMA,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.value : null, JUDGE);
  });

  /**
   * The whole point. Recovering the object out of surrounding prose would
   * accept a reply the model composed on its own terms -- and accept it
   * silently, so a side that ignored its schema still settles the round.
   */
  it("refuses a JSON document buried in prose instead of digging it out", () => {
    assert.equal(
      failureCode(
        `我已经完成了裁决，结果如下：\n\n${JSON.stringify(JUDGE)}\n\n如需我继续请告诉我。`,
        SPEC_JUDGE_OUTPUT_JSON_SCHEMA,
      ),
      "trailing_content",
    );
  });

  it("refuses a fence that is only part of the reply", () => {
    assert.equal(
      failureCode(
        "先说明一下：\n```json\n" + JSON.stringify(JUDGE) + "\n```\n以上。",
        SPEC_JUDGE_OUTPUT_JSON_SCHEMA,
      ),
      "trailing_content",
    );
  });

  it("refuses an empty reply, a non-object, and plain prose", () => {
    assert.equal(failureCode("", SPEC_JUDGE_OUTPUT_JSON_SCHEMA), "empty_reply");
    assert.equal(failureCode("   \n  ", SPEC_JUDGE_OUTPUT_JSON_SCHEMA), "empty_reply");
    assert.equal(failureCode("[1, 2]", SPEC_JUDGE_OUTPUT_JSON_SCHEMA), "not_an_object");
    assert.equal(failureCode("我裁决完了。", SPEC_JUDGE_OUTPUT_JSON_SCHEMA), "not_json");
  });

  /**
   * The judge inventing a field is the exact thing the rule forbids, so
   * `additionalProperties: false` has to bite rather than be tolerated.
   */
  it("refuses a field the schema did not declare", () => {
    assert.equal(
      failureCode(
        JSON.stringify({ ...JUDGE, blockingP0: 0 }),
        SPEC_JUDGE_OUTPUT_JSON_SCHEMA,
      ),
      "schema_violation",
    );
  });

  /**
   * `not_assessed` is how a criterion goes UNANSWERED, recorded by the server
   * when the judge says nothing about it. Letting the judge write it would turn
   * "I decline to judge" into a positive act it could spend on a criterion it
   * did not want to fail.
   */
  it("refuses a judge that writes not_assessed for itself", () => {
    assert.equal(
      failureCode(
        JSON.stringify({
          ...JUDGE,
          rubric: [{ criterionId: "crit-1", verdict: "not_assessed", evidence: "没看" }],
        }),
        SPEC_JUDGE_OUTPUT_JSON_SCHEMA,
      ),
      "schema_violation",
    );
  });

  it("refuses a rubric verdict with no evidence behind it", () => {
    assert.equal(
      failureCode(
        JSON.stringify({
          ...JUDGE,
          rubric: [{ criterionId: "crit-1", verdict: "no", evidence: "" }],
        }),
        SPEC_JUDGE_OUTPUT_JSON_SCHEMA,
      ),
      "schema_violation",
    );
  });

  /**
   * The sides' schemas are the ones the ledger already persists, and they are
   * validated by the same reader -- a sub-agent's schema is enforced later than
   * the judge's, not more weakly.
   */
  it("holds red and blue to the schemas the ledger already stores", () => {
    const red = readServerOwnedJson(
      JSON.stringify({
        markdown: "# PRD delta\n",
        fixClaims: [{
          canonicalGapId: "gap-1",
          claimStatus: "fixed",
          claimSummary: "补齐导出上限",
          evidence: "delta 第 3 节",
          artifactPath: null,
        }],
      }),
      RED_SPEC_OUTPUT_JSON_SCHEMA,
    );
    assert.equal(red.ok, true);

    // An invented claim status is a structure the model chose, not filled in.
    assert.equal(
      failureCode(
        JSON.stringify({
          markdown: "# PRD delta\n",
          fixClaims: [{
            canonicalGapId: "gap-1",
            claimStatus: "mostly_fixed",
            claimSummary: "差不多修好了",
            evidence: "见上",
            artifactPath: null,
          }],
        }),
        RED_SPEC_OUTPUT_JSON_SCHEMA,
      ),
      "schema_violation",
    );

    const blue = readServerOwnedJson(
      JSON.stringify({ gapReviews: [], requirementGaps: [], rubric: [] }),
      BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA,
    );
    assert.equal(blue.ok, true);

    assert.equal(
      failureCode(
        JSON.stringify({
          gapReviews: [],
          rubric: [],
          requirementGaps: [{
            canonicalGapId: "gap-9",
            title: "导出无上限",
            category: "scope",
            severity: "P3",
            evidence: "delta 未定义上限",
            affectedArtifacts: [],
            proposedSpecPatch: null,
            specBlocking: true,
            mergeBlocking: false,
          }],
        }),
        BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA,
      ),
      "schema_violation",
      "severity is a fixed vocabulary; P3 is a severity the critic invented",
    );
  });

  it("describes every failure it can produce", () => {
    for (const failure of [
      { code: "empty_reply" },
      { code: "not_json", detail: "x" },
      { code: "trailing_content" },
      { code: "not_an_object" },
      { code: "schema_violation", detail: "y" },
    ] as const) {
      assert.ok(describeServerOwnedJsonFailure(failure).length > 0, failure.code);
    }
  });
});
