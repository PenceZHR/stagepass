/**
 * Red's output schema for a delegated round: the phase's own producer document,
 * plus its answers to the gaps the previous round's blue left open.
 *
 * ## Why the producer schema alone was not enough
 *
 * Every phase already had a producer schema, and the descriptors reused it --
 * deliberately, so a phase would not end up with two definitions of the same
 * document. That reasoning is right about the document and wrong about the
 * round: a round is adversarial, and the judge's shared checklist opens with
 * 「红方的自证不等于事实」-- red claims a gap is fixed, blue confirms or refuses,
 * and the judge treats an unconfirmed claim as unresolved.
 *
 * Spec's red schema had `fixClaims` and the other three did not. Their producer
 * schemas are `additionalProperties: false`, so red could not have answered a
 * prior gap even by volunteering the field: the round would have been refused
 * for an unknown key. The judge's first check therefore had nothing to read on
 * three of the four phases, and the round would have looked clean while blue's
 * findings quietly survived every round untouched.
 *
 * ## Why wrapping rather than editing the producer schemas
 *
 * `fixClaims` belongs to the round, not to the document. A tech spec is not
 * partly a list of gap responses, and the single-turn producer path (which is
 * still what runs with the delegated round switched off) must keep validating
 * the document alone. Wrapping keeps one definition of each document and adds
 * the round's own field around it.
 */

/**
 * One definition, shared by all four phases.
 *
 * Kept here rather than inline in each schema for the same reason the judge
 * template is one file: four copies of a shape are four places for one of them
 * to drift, and this one is read back by the ledger that stores the claims.
 */
export const RED_FIX_CLAIMS_JSON_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      canonicalGapId: { type: "string" },
      claimStatus: {
        type: "string",
        enum: ["fixed", "partially_fixed", "not_fixed", "needs_human_decision"],
      },
      claimSummary: { type: "string" },
      evidence: { type: "string" },
      artifactPath: { type: ["string", "null"] },
    },
    required: [
      "canonicalGapId",
      "claimStatus",
      "claimSummary",
      "evidence",
      "artifactPath",
    ],
  },
};

type JsonSchemaObject = {
  properties?: Record<string, unknown>;
  required?: readonly string[];
  [key: string]: unknown;
};

/**
 * The producer schema with `fixClaims` added, as a new object.
 *
 * `fixClaims` is REQUIRED, not optional. An omitted array and an empty one would
 * otherwise mean the same thing to the validator while meaning opposite things
 * in the round: "I have nothing outstanding" is a claim red makes, and a round
 * where red silently said nothing about blue's open gaps is exactly what the
 * judge is supposed to catch. An empty list is a legitimate answer on round 1,
 * when there is no previous blue.
 */
export function withRedFixClaims(
  producerSchema: Record<string, unknown>,
): Record<string, unknown> {
  const schema = producerSchema as JsonSchemaObject;
  return {
    ...schema,
    type: "object",
    additionalProperties: false,
    properties: { ...(schema.properties ?? {}), fixClaims: RED_FIX_CLAIMS_JSON_SCHEMA },
    required: [...(schema.required ?? []), "fixClaims"],
  };
}
