import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateOutputSchema } from "./output-schema-validator.ts";
import { parseRefineLineProtocol, stripRefineProtocol } from "./refine-line-protocol.ts";
import { REFINE_OUTPUT_SCHEMA } from "./refine-service.ts";

function ok(rawText: string) {
  const parsed = parseRefineLineProtocol(rawText);
  assert.ok(parsed.ok, `expected parse to succeed, got: ${parsed.ok ? "" : parsed.message}`);
  return parsed.payload;
}

function rejected(rawText: string): string {
  const parsed = parseRefineLineProtocol(rawText);
  assert.equal(parsed.ok, false, "expected parse to be rejected");
  return parsed.ok ? "" : parsed.message;
}

describe("refine line protocol", () => {
  it("assembles requirements from REQ lines", () => {
    const payload = ok([
      "还需要确认两个问题：响应格式用什么？",
      "REQ: REQ-1 | functional | confirmed | GET /healthz 接口 | 新增一个 HTTP GET 接口 /healthz",
      "REQ: REQ-2 | non-functional | new | 无需鉴权 | 该接口不需要任何认证或授权",
      "REQ: REQ-3 | constraint | uncertain | 不检查外部依赖 | 只要进程存活就返回 200",
    ].join("\n"));

    assert.deepEqual(payload.requirements, [
      {
        id: "REQ-1",
        category: "functional",
        status: "confirmed",
        title: "GET /healthz 接口",
        description: "新增一个 HTTP GET 接口 /healthz",
      },
      {
        id: "REQ-2",
        category: "non-functional",
        status: "new",
        title: "无需鉴权",
        description: "该接口不需要任何认证或授权",
      },
      {
        id: "REQ-3",
        category: "constraint",
        status: "uncertain",
        title: "不检查外部依赖",
        description: "只要进程存活就返回 200",
      },
    ]);
  });

  it("treats a turn with no REQ line as empty rather than as an error", () => {
    // Refine is a conversation: a turn that only asks questions has nothing to
    // extract yet. Failing it would throw away the assistant's reply to the
    // human, so the caller retries in-thread instead.
    assert.deepEqual(ok("响应格式用什么？需要鉴权吗？").requirements, []);
  });

  it("keeps pipes legal in the description only", () => {
    const payload = ok("REQ: R1 | functional | new | 标题 | a | b | c");
    assert.equal(payload.requirements[0]?.description, "a | b | c");
  });

  it("rejects an unknown category", () => {
    assert.match(
      rejected("REQ: R1 | feature | new | t | d"),
      /REQ category must be functional\/non-functional\/constraint, got "feature"/,
    );
  });

  it("rejects an unknown status", () => {
    assert.match(
      rejected("REQ: R1 | functional | done | t | d"),
      /REQ status must be confirmed\/uncertain\/new, got "done"/,
    );
  });

  it("rejects a short record instead of shifting the remaining fields", () => {
    assert.match(rejected("REQ: R1 | functional | new | t"), /REQ needs 5 "\|" fields.*got 4/s);
  });

  it("rejects an empty id, title or description", () => {
    assert.match(rejected("REQ:  | functional | new | t | d"), /REQ has an empty id\/title\/description/);
    assert.match(rejected("REQ: R1 | functional | new |  | d"), /REQ has an empty id\/title\/description/);
  });

  it("rejects duplicate ids", () => {
    // refineTurn dedups by id keeping the LAST entry, so a duplicate silently
    // discards a requirement the model stated.
    assert.match(
      rejected([
        "REQ: R1 | functional | confirmed | 甲 | 描述甲",
        "REQ: R1 | constraint | new | 乙 | 描述乙",
      ].join("\n")),
      /duplicate REQ id: R1/,
    );
  });

  it("rejects JSON-fragment garbage and unbalanced quotes", () => {
    assert.match(rejected("REQ: R1 | functional | new | t | broken },{ frag"), /contains JSON fragment garbage/);
    assert.match(rejected('REQ: R1 | functional | new | t | an "unbalanced'), /has unbalanced quotes/);
  });

  it("rejects an over-long field", () => {
    assert.match(
      rejected(`REQ: R1 | functional | new | t | ${"x".repeat(2_001)}`),
      /REQ description exceeds 2000 chars/,
    );
  });

  it("rejects an unexpected block whose body would swallow REQ lines", () => {
    assert.match(
      rejected(["NOTE<<", "REQ: R1 | functional | new | t | d", ">>NOTE"].join("\n")),
      /unexpected NOTE<< block/,
    );
  });

  it("accepts a markdown bullet in front of a record", () => {
    assert.equal(ok("- REQ: R1 | functional | new | t | d").requirements.length, 1);
  });
});

describe("stripRefineProtocol", () => {
  it("removes REQ lines and leaves the prose the human reads", () => {
    const stripped = stripRefineProtocol([
      "还需要确认两个问题：",
      "1. 响应格式用什么？",
      "REQ: R1 | functional | new | t | d",
      "REQ: R2 | constraint | new | t2 | d2",
    ].join("\n"));
    assert.equal(stripped, "还需要确认两个问题：\n1. 响应格式用什么？");
  });

  it("leaves a reply with no protocol untouched", () => {
    assert.equal(stripRefineProtocol("纯对话回复。"), "纯对话回复。");
  });
});

/**
 * REFINE_OUTPUT_SCHEMA is the stage's SECOND gate over the payload the parser
 * assembles. The parser cannot produce a payload that violates it, so no
 * end-to-end refine test can distinguish a correct schema from one widened to
 * `{type:"object"}` -- these assertions are what make loosening it fail.
 */
describe("refine output schema", () => {
  const accept = (value: unknown) =>
    assert.equal(validateOutputSchema(REFINE_OUTPUT_SCHEMA, value), true);
  const reject = (value: unknown, pattern: RegExp) => {
    const result = validateOutputSchema(REFINE_OUTPUT_SCHEMA, value);
    assert.notEqual(result, true, "expected the schema to reject this payload");
    assert.match((result as { message: string }).message, pattern);
  };

  const requirement = () => ({
    id: "R1",
    category: "functional",
    title: "t",
    description: "d",
    status: "new",
  });

  it("accepts exactly what the parser produces", () => {
    accept(ok("REQ: R1 | functional | new | t | d"));
    accept(ok("no requirements yet"));
  });

  it("requires the requirements key", () => {
    reject({}, /\$\.requirements is required/);
  });

  it("rejects a requirements value that is not an array", () => {
    reject({ requirements: "none" }, /\$\.requirements must be array/);
  });

  it("rejects an item missing a field", () => {
    const partial = requirement() as Record<string, unknown>;
    delete partial.status;
    reject({ requirements: [partial] }, /\$\.requirements\[0\]\.status is required/);
  });

  it("rejects a category or status outside the vocabulary", () => {
    reject(
      { requirements: [{ ...requirement(), category: "feature" }] },
      /\$\.requirements\[0\]\.category must be one of the allowed enum values/,
    );
    reject(
      { requirements: [{ ...requirement(), status: "done" }] },
      /\$\.requirements\[0\]\.status must be one of the allowed enum values/,
    );
  });

  it("rejects an unknown key on an item and on the payload", () => {
    reject(
      { requirements: [{ ...requirement(), extra: 1 }] },
      /\$\.requirements\[0\]\.extra is not allowed/,
    );
    reject({ requirements: [], smuggled: 1 }, /\$\.smuggled is not allowed/);
  });

  it("rejects the raw model-authored array shape the old parser accepted", () => {
    // `Array.isArray(parsed)` was the ENTIRE old check, so `[1,2,3]` passed.
    reject([1, 2, 3], /\$ must be object/);
    reject({ requirements: [1, 2, 3] }, /\$\.requirements\[0\] must be object/);
  });
});
