import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DELEGATED_ROUND_PHASES,
  PLAN_DELEGATED_ROUND,
  SPEC_DELEGATED_ROUND,
  TECH_SPEC_DELEGATED_ROUND,
  TEST_PLAN_DELEGATED_ROUND,
} from "./delegated-round-phases.ts";
import { RED_FIX_CLAIMS_JSON_SCHEMA, withRedFixClaims } from "./delegated-round-red-schema.ts";
import { readServerOwnedJson } from "./server-owned-json-output.ts";

const FIX_CLAIM = {
  canonicalGapId: "GAP-1",
  claimStatus: "fixed",
  claimSummary: "补上了迁移说明",
  evidence: "techSpec.migrationNotes 第 2 条",
  artifactPath: null,
};

/** A minimal document that satisfies each phase's producer half. */
const PRODUCER_BODY: Record<string, Record<string, unknown>> = {
  Spec: { markdown: "# Delta\n" },
  TechSpec: {
    techSpec: {
      interfaces: [],
      dataContracts: [],
      migrationNotes: [],
      buildInputs: [],
      reviewInputs: [],
    },
  },
  Plan: {
    planName: "P",
    expectedFiles: [],
    forbiddenFiles: [],
    implementationSteps: [],
    testPlan: [],
    validationCommands: [],
    risks: [],
  },
  TestPlan: {
    testIntent: "验证回合",
    coverageItems: [],
    riskMappings: [],
    requiredCommands: [],
    manualChecks: [],
  },
};

function read(descriptor: (typeof DELEGATED_ROUND_PHASES)[number], value: unknown) {
  return readServerOwnedJson(JSON.stringify(value), descriptor.redOutputSchema);
}

describe("every delegated phase's red schema carries fix claims", () => {
  /**
   * The judge's shared checklist opens with "红方的自证不等于事实" -- red claims
   * fixed, blue confirms or refuses. TechSpec, Plan and TestPlan reused their
   * bare producer schemas, which are `additionalProperties: false` and have no
   * `fixClaims`, so red could not answer a prior round's gap even in principle
   * and the judge's first check had nothing to read.
   */
  for (const descriptor of DELEGATED_ROUND_PHASES) {
    it(`accepts ${descriptor.phase} red output that answers a prior gap`, () => {
      const result = read(descriptor, {
        ...PRODUCER_BODY[descriptor.phase],
        fixClaims: [FIX_CLAIM],
      });
      assert.equal(
        result.ok,
        true,
        `${descriptor.phase} red rejected a fix claim: ${
          result.ok ? "" : JSON.stringify(result.failure)
        }`,
      );
    });

    it(`requires ${descriptor.phase} red to state its fix claims explicitly`, () => {
      const result = read(descriptor, PRODUCER_BODY[descriptor.phase]);
      assert.equal(
        result.ok,
        false,
        "an omitted fixClaims reads as 'no gaps outstanding', which is a claim red must make on purpose",
      );
    });

    it(`still holds ${descriptor.phase} red to its producer schema`, () => {
      const result = read(descriptor, { fixClaims: [] });
      assert.equal(result.ok, false, "the producer half must stay required");
    });

    it(`refuses an unknown key in ${descriptor.phase} red output`, () => {
      const result = read(descriptor, {
        ...PRODUCER_BODY[descriptor.phase],
        fixClaims: [],
        somethingRedInvented: true,
      });
      assert.equal(result.ok, false, "additionalProperties:false must survive the wrap");
    });
  }

  it("uses one definition of a fix claim across every phase", () => {
    const perPhase = [
      SPEC_DELEGATED_ROUND,
      TECH_SPEC_DELEGATED_ROUND,
      PLAN_DELEGATED_ROUND,
      TEST_PLAN_DELEGATED_ROUND,
    ].map((descriptor) => {
      const properties = descriptor.redOutputSchema.properties as Record<string, unknown>;
      return JSON.stringify(properties.fixClaims);
    });
    assert.equal(
      new Set(perPhase).size,
      1,
      "four copies of the fix-claim shape is four places for one of them to drift",
    );
    assert.equal(perPhase[0], JSON.stringify(RED_FIX_CLAIMS_JSON_SCHEMA));
  });

  it("rejects a fix claim whose status is not one the ledger stores", () => {
    const result = read(TECH_SPEC_DELEGATED_ROUND, {
      ...PRODUCER_BODY.TechSpec,
      fixClaims: [{ ...FIX_CLAIM, claimStatus: "mostly_fixed" }],
    });
    assert.equal(result.ok, false);
  });

  it("leaves a producer schema untouched when it wraps it", () => {
    const producer = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    const before = JSON.stringify(producer);
    withRedFixClaims(producer);
    assert.equal(JSON.stringify(producer), before, "wrapping must not mutate the producer schema");
  });
});
