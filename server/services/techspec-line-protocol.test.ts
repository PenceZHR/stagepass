import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateOutputSchema } from "./output-schema-validator.ts";
import { TECH_SPEC_OUTPUT_SCHEMA } from "./pipeline-design-stage-service.ts";
import { parseTechSpecLineProtocol } from "./techspec-line-protocol.ts";

function ok(rawText: string) {
  const parsed = parseTechSpecLineProtocol(rawText);
  assert.ok(parsed.ok, `expected parse to succeed, got: ${parsed.ok ? "" : parsed.message}`);
  return parsed.payload;
}

function rejected(rawText: string): string {
  const parsed = parseTechSpecLineProtocol(rawText);
  assert.equal(parsed.ok, false, "expected parse to be rejected");
  return parsed.ok ? "" : parsed.message;
}

const MINIMAL = [
  "INTERFACE: GameSession | module | 新增客户端单局会话边界",
  "BUILD: 复用仓库现有前端框架",
  "REVIEW: 确认必填响应字段仍然存在",
].join("\n");

describe("tech-spec line protocol", () => {
  it("assembles the five design sections from prefixed lines", () => {
    const payload = ok([
      "先说一下思路，这一段没有前缀所以会被忽略。",
      "INTERFACE: GET /api/example | http | preserve response shape",
      "CONTRACT: ExampleResponse | actions,status | actions 至少一项; status 仅允许 ok 或 error",
      "MIGRATION: No destructive migration required.",
      "BUILD: Implement only the listed interfaces and contracts.",
      "REVIEW: Verify the required response fields are still present.",
    ].join("\n"));

    assert.deepEqual(payload.techSpec, {
      interfaces: [{ name: "GET /api/example", type: "http", change: "preserve response shape" }],
      dataContracts: [{
        name: "ExampleResponse",
        requiredFields: ["actions", "status"],
        constraints: ["actions 至少一项", "status 仅允许 ok 或 error"],
      }],
      migrationNotes: ["No destructive migration required."],
      buildInputs: ["Implement only the listed interfaces and contracts."],
      reviewInputs: ["Verify the required response fields are still present."],
    });
  });

  it("omits apiContract entirely when no API_ line is present", () => {
    // deriveApiContractFromTechSpec depends on the KEY being absent, not on it
    // being an empty object: selectApiCandidate reads `record.apiContract ?? …`,
    // so an empty object here would be adopted verbatim and normalizeDesignSections
    // would then reject it for missing sections.
    const payload = ok(MINIMAL);
    assert.equal("apiContract" in payload, false);
  });

  it("builds a separate apiContract from API_ lines", () => {
    const payload = ok([
      MINIMAL,
      "API_INTERFACE: POST /api/actions | http | 新增 actions 数组字段",
      "API_CONTRACT: ActionsResponse | actions,gate | gate 仅允许 passed 或 blocked",
      "API_MIGRATION: 新增字段可选，旧客户端忽略即可",
      "API_BUILD: 严格按上述 route 施工",
      "API_REVIEW: 确认错误结构未被破坏",
    ].join("\n"));

    assert.deepEqual(payload.apiContract, {
      interfaces: [{ name: "POST /api/actions", type: "http", change: "新增 actions 数组字段" }],
      dataContracts: [{
        name: "ActionsResponse",
        requiredFields: ["actions", "gate"],
        constraints: ["gate 仅允许 passed 或 blocked"],
      }],
      migrationNotes: ["新增字段可选，旧客户端忽略即可"],
      buildInputs: ["严格按上述 route 施工"],
      reviewInputs: ["确认错误结构未被破坏"],
    });
    // API_ lines must not bleed into the tech spec's own sections.
    assert.deepEqual(payload.techSpec.interfaces, [
      { name: "GameSession", type: "module", change: "新增客户端单局会话边界" },
    ]);
  });

  it("does not let API_INTERFACE match the INTERFACE keyword", () => {
    // The scan regex alternates INTERFACE|API_INTERFACE; anchoring is what keeps
    // "API_INTERFACE:" from being read as an INTERFACE line with a mangled name.
    const payload = ok([MINIMAL, "API_INTERFACE: X | http | y"].join("\n"));
    assert.equal(payload.techSpec.interfaces.length, 1);
    assert.equal(payload.apiContract?.interfaces.length, 1);
  });

  it("requires the three sections downstream stages consume", () => {
    assert.match(
      rejected("MIGRATION: only a note"),
      /expected at least 1 INTERFACE line.*expected at least 1 BUILD line.*expected at least 1 REVIEW line/s,
    );
  });

  it("allows empty dataContracts and migrationNotes", () => {
    const payload = ok(MINIMAL);
    assert.deepEqual(payload.techSpec.dataContracts, []);
    assert.deepEqual(payload.techSpec.migrationNotes, []);
  });

  it("rejects a partial API_ group that carries no API_INTERFACE", () => {
    // The truncation fingerprint: the model opened an API contract and stopped.
    assert.match(
      rejected([MINIMAL, "API_BUILD: 只写了一半"].join("\n")),
      /API_\* lines are present but no API_INTERFACE line/,
    );
  });

  it("rejects an INTERFACE line missing a field", () => {
    assert.match(
      rejected([MINIMAL, "INTERFACE: OnlyName | http"].join("\n")),
      /INTERFACE needs 3 "\|" fields \(name \| type \| change\), got 2/,
    );
  });

  it("rejects an INTERFACE line with an empty field", () => {
    assert.match(
      rejected([MINIMAL, "INTERFACE: OnlyName |  | change"].join("\n")),
      /INTERFACE has an empty name\/type\/change/,
    );
  });

  it("keeps pipes legal in the last field of each record", () => {
    const payload = ok([
      "INTERFACE: N | http | a | b | c",
      "CONTRACT: C | f | x | y",
      "BUILD: build | with | pipes",
      "REVIEW: review | with | pipes",
    ].join("\n"));
    assert.equal(payload.techSpec.interfaces[0]?.change, "a | b | c");
    assert.deepEqual(payload.techSpec.dataContracts[0]?.constraints, ["x | y"]);
    assert.equal(payload.techSpec.buildInputs[0], "build | with | pipes");
  });

  it("reads - as an empty list for requiredFields and constraints", () => {
    const payload = ok([MINIMAL, "CONTRACT: Bare | - | -"].join("\n"));
    assert.deepEqual(payload.techSpec.dataContracts[0], {
      name: "Bare",
      requiredFields: [],
      constraints: [],
    });
  });

  it("rejects JSON-fragment garbage and unbalanced quotes in free text", () => {
    // The `},{` class observed live before the protocol existed.
    assert.match(
      rejected([MINIMAL, 'BUILD: broken },{ fragment'].join("\n")),
      /BUILD contains JSON fragment garbage/,
    );
    assert.match(
      rejected([MINIMAL, 'REVIEW: an "unbalanced quote'].join("\n")),
      /REVIEW has unbalanced quotes/,
    );
  });

  it("rejects an over-long field instead of storing it", () => {
    assert.match(
      rejected([MINIMAL, `BUILD: ${"x".repeat(2_001)}`].join("\n")),
      /BUILD exceeds 2000 chars/,
    );
  });

  it("rejects an unexpected block whose body would swallow records", () => {
    // A balanced NOTE<< … >>NOTE block is structurally valid and invisible to
    // the schema, so every record inside it would be dropped silently.
    assert.match(
      rejected([
        "NOTE<<",
        MINIMAL,
        ">>NOTE",
      ].join("\n")),
      /unexpected NOTE<< block/,
    );
  });

  it("rejects an unterminated block", () => {
    assert.match(
      rejected([MINIMAL, "SUMMARY<<", "dangling"].join("\n")),
      /unterminated SUMMARY<< block/,
    );
  });

  it("ignores prose that has no protocol prefix", () => {
    const payload = ok([
      "我先读了 server/db/schema.ts，判断这次不需要迁移。",
      "- 顺带说明：dataContracts 暂时为空。",
      MINIMAL,
    ].join("\n"));
    assert.equal(payload.techSpec.interfaces.length, 1);
    assert.equal(payload.techSpec.buildInputs.length, 1);
  });

  it("accepts a markdown bullet in front of a record", () => {
    const payload = ok([
      "- INTERFACE: GameSession | module | 新增边界",
      "- BUILD: 复用现有框架",
      "- REVIEW: 确认字段",
    ].join("\n"));
    assert.equal(payload.techSpec.interfaces.length, 1);
  });
});

/**
 * TECH_SPEC_OUTPUT_SCHEMA is the stage's SECOND gate: by construction the
 * parser cannot emit a payload that violates it, so nothing in the stage's
 * end-to-end tests can tell a correct schema from one widened to
 * `{type:"object"}`. These assertions are what make the schema falsifiable --
 * without them, loosening it is a silent no-op.
 */
describe("tech-spec output schema", () => {
  const accept = (value: unknown) =>
    assert.equal(validateOutputSchema(TECH_SPEC_OUTPUT_SCHEMA, value), true);
  const reject = (value: unknown, pattern: RegExp) => {
    const result = validateOutputSchema(TECH_SPEC_OUTPUT_SCHEMA, value);
    assert.notEqual(result, true, "expected the schema to reject this payload");
    assert.match((result as { message: string }).message, pattern);
  };

  const sections = () => ({
    interfaces: [{ name: "n", type: "http", change: "c" }],
    dataContracts: [{ name: "d", requiredFields: ["a"], constraints: ["b"] }],
    migrationNotes: ["m"],
    buildInputs: ["b"],
    reviewInputs: ["r"],
  });

  it("accepts exactly what the parser produces, with and without apiContract", () => {
    accept(parseOk(MINIMAL));
    accept(parseOk([MINIMAL, "API_INTERFACE: X | http | y"].join("\n")));
    accept({ techSpec: sections() });
    accept({ techSpec: sections(), apiContract: sections() });
  });

  it("requires techSpec", () => {
    reject({ apiContract: sections() }, /\$\.techSpec is required/);
  });

  it("requires all five sections on each group", () => {
    const missing = sections() as Record<string, unknown>;
    delete missing.reviewInputs;
    reject({ techSpec: missing }, /\$\.techSpec\.reviewInputs is required/);
  });

  it("rejects a section that is not an array", () => {
    reject(
      { techSpec: { ...sections(), migrationNotes: "not an array" } },
      /\$\.techSpec\.migrationNotes must be array/,
    );
  });

  it("rejects a prose note that is not a string", () => {
    reject(
      { techSpec: { ...sections(), buildInputs: [{ note: "object" }] } },
      /\$\.techSpec\.buildInputs\[0\] must be string/,
    );
  });

  it("rejects an interface record missing a field", () => {
    reject(
      { techSpec: { ...sections(), interfaces: [{ name: "n", type: "http" }] } },
      /\$\.techSpec\.interfaces\[0\]\.change is required/,
    );
  });

  it("rejects an unknown key on a record and on the payload", () => {
    // additionalProperties:false is what keeps the parser the only thing that
    // can put a key on these objects.
    reject(
      { techSpec: { ...sections(), interfaces: [{ name: "n", type: "http", change: "c", extra: 1 }] } },
      /\$\.techSpec\.interfaces\[0\]\.extra is not allowed/,
    );
    reject({ techSpec: sections(), smuggled: {} }, /\$\.smuggled is not allowed/);
  });

  it("rejects requiredFields entries that are not strings", () => {
    reject(
      { techSpec: { ...sections(), dataContracts: [{ name: "d", requiredFields: [1], constraints: [] }] } },
      /\$\.techSpec\.dataContracts\[0\]\.requiredFields\[0\] must be string/,
    );
  });

  it("rejects a non-object payload", () => {
    reject([], /\$ must be object/);
    reject("prose", /\$ must be object/);
  });
});

function parseOk(rawText: string) {
  const parsed = parseTechSpecLineProtocol(rawText);
  assert.ok(parsed.ok);
  return parsed.payload;
}
