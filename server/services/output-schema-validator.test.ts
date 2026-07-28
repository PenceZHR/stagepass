import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateOutputSchema } from "./output-schema-validator.ts";

function message(schema: Record<string, unknown>, value: unknown): string | null {
  const result = validateOutputSchema(schema, value);
  return result === true ? null : result.message;
}

describe("output schema validator", () => {
  /**
   * `minLength` was a dud for as long as it existed here: the validator ignores
   * unrecognised keywords, so `{ type: "string", minLength: 1 }` -- written in
   * four production schemas by authors who meant "not empty" -- constrained
   * nothing, and those stages accepted empty documents through a rule that read
   * as if it forbade them.
   */
  it("enforces minLength on strings", () => {
    const schema = { type: "object", properties: { markdown: { type: "string", minLength: 1 } } };

    assert.equal(message(schema, { markdown: "x" }), null);
    assert.match(message(schema, { markdown: "" }) ?? "", /at least 1 character/);
  });

  it("says nothing about non-strings, so a nullable field still accepts null", () => {
    const schema = {
      type: "object",
      properties: {
        artifactPath: { type: ["string", "null"], minLength: 1 },
        count: { type: "number", minLength: 5 },
      },
    };

    assert.equal(message(schema, { artifactPath: null }), null);
    assert.equal(message(schema, { count: 1 }), null, "minLength does not apply to numbers");
    assert.match(message(schema, { artifactPath: "" }) ?? "", /at least 1 character/);
  });

  it("reaches strings nested in arrays and objects", () => {
    const schema = {
      type: "object",
      properties: {
        rubric: {
          type: "array",
          items: {
            type: "object",
            properties: { evidence: { type: "string", minLength: 1 } },
          },
        },
      },
    };

    assert.equal(message(schema, { rubric: [{ evidence: "见 delta" }] }), null);
    assert.match(
      message(schema, { rubric: [{ evidence: "ok" }, { evidence: "" }] }) ?? "",
      /rubric\[1\]\.evidence/,
    );
  });

  it("still applies the keywords it always did", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["verdict"],
      properties: { verdict: { type: "string", enum: ["yes", "no"] } },
    };

    assert.equal(message(schema, { verdict: "yes" }), null);
    assert.match(message(schema, {}) ?? "", /verdict is required/);
    assert.match(message(schema, { verdict: "maybe" }) ?? "", /enum/);
    assert.match(message(schema, { verdict: "yes", extra: 1 }) ?? "", /not allowed/);
  });
});
