/**
 * The Plan stage's producer output schema.
 *
 * In a leaf module for the same reason as design-stage-output-schemas.ts: the
 * delegated-round phase descriptors name it, and a descriptor that imported the
 * plan stage service -- which will import the descriptors back -- is a module
 * cycle that resolves this schema to `undefined` at init.
 */

export const PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    planName: { type: "string" },
    expectedFiles: { type: "array", items: { type: "string" } },
    forbiddenFiles: { type: "array", items: { type: "string" } },
    implementationSteps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step: { type: "number" },
          description: { type: "string" },
          file: { type: "string" },
          status: { type: "string", enum: ["pending", "blocked", "done"] },
        },
        required: ["step", "description", "file", "status"],
        additionalProperties: false,
      },
    },
    testPlan: { type: "array", items: { type: "string" } },
    validationCommands: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
  },
  required: [
    "planName",
    "expectedFiles",
    "forbiddenFiles",
    "implementationSteps",
    "testPlan",
    "validationCommands",
    "risks",
  ],
  additionalProperties: false,
};
