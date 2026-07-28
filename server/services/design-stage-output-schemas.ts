/**
 * The producer output schemas for the two design document stages.
 *
 * Moved out of `pipeline-design-stage-service.ts` so the delegated-round phase
 * descriptors can name them without importing a stage service. A descriptor
 * imported BY the stage service that also imports FROM it is a module cycle,
 * and under ESM a cycle resolves these `const` schemas to `undefined` at
 * module-init time -- a schema that validates nothing, silently, which is the
 * one failure this whole path is built to prevent.
 *
 * This is a move, not a fork: the stage service re-exports what it used to
 * declare, so there is still exactly one definition of each document.
 */

export const DESIGN_SECTIONS_SCHEMA = {
  type: "object",
  properties: {
    interfaces: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          change: { type: "string" },
        },
        required: ["name", "type", "change"],
        additionalProperties: false,
      },
    },
    dataContracts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          requiredFields: { type: "array", items: { type: "string" } },
          constraints: { type: "array", items: { type: "string" } },
        },
        required: ["name", "requiredFields", "constraints"],
        additionalProperties: false,
      },
    },
    migrationNotes: { type: "array", items: { type: "string" } },
    buildInputs: { type: "array", items: { type: "string" } },
    reviewInputs: { type: "array", items: { type: "string" } },
  },
  required: ["interfaces", "dataContracts", "migrationNotes", "buildInputs", "reviewInputs"],
  additionalProperties: false,
};

/**
 * `apiContract` is optional on purpose: a reply with no API_* line omits it, and
 * persistTechSpecAndApiSnapshots then derives the API contract from the tech
 * spec exactly as it does today (deriveApiContractFromTechSpec). Making it
 * required would have quietly retired the derive path that every existing
 * change actually used.
 */
export const TECH_SPEC_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    techSpec: DESIGN_SECTIONS_SCHEMA,
    apiContract: DESIGN_SECTIONS_SCHEMA,
  },
  required: ["techSpec"],
  additionalProperties: false,
};

export const TESTPLAN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    testIntent: { type: "string" },
    coverageItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          itemKey: { type: "string" },
          title: { type: "string" },
          requirementRef: { type: ["string", "null"] },
          testType: { type: "string" },
          priority: { type: "string", enum: ["P0", "P1", "P2"] },
        },
        required: ["itemKey", "title", "requirementRef", "testType", "priority"],
        additionalProperties: false,
      },
    },
    riskMappings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          coverageItemKey: { type: "string" },
          riskRef: { type: "string" },
          severity: { type: "string", enum: ["P0", "P1", "P2"] },
          mitigation: { type: "string" },
        },
        required: ["coverageItemKey", "riskRef", "severity", "mitigation"],
        additionalProperties: false,
      },
    },
    requiredCommands: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          required: { type: "boolean" },
        },
        required: ["command", "required"],
        additionalProperties: false,
      },
    },
    manualChecks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: ["string", "null"] },
          required: { type: "boolean" },
        },
        required: ["title", "description", "required"],
        additionalProperties: false,
      },
    },
  },
  required: ["testIntent", "coverageItems", "riskMappings", "requiredCommands", "manualChecks"],
  additionalProperties: false,
};
