import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { AiRunResult } from "./ai-engine-types";
import {
  applyLineProtocol,
  blockTerminator,
  collectSingletonBlock,
  findStructuralBlockError,
  guardLineProtocolSchema,
  scanProtocolLines,
  segmentProtocolText,
} from "./ai-line-protocol";

/**
 * The shared toolkit had no tests of its own: every stage's parser tested its
 * own use of these primitives, so a defect in a primitive could only surface as
 * a stage-shaped symptom. The two that carried defects — collectSingletonBlock
 * silently truncating a field, and scanProtocolLines harvesting records out of
 * block bodies — are covered here directly.
 */

describe("segmentProtocolText", () => {
  it("splits a block from the top-level lines around it", () => {
    const s = segmentProtocolText("before\nM<<\na\nb\n>>M\nafter");
    assert.equal(s.unterminated, null);
    assert.deepEqual(s.blocks, [{ name: "M", content: "a\nb", openLineNo: 2 }]);
    assert.deepEqual(s.topLevel.map((l) => l.text), ["before", "after"]);
  });

  it("keeps a bare >> inside a block as content — the truncation bug is gone by construction", () => {
    // A body line that is exactly ">>" used to close the block early and drop
    // the rest. With a named terminator it is just content.
    const s = segmentProtocolText("M<<\n> quote\n>>\nkept\n>>M");
    assert.deepEqual(s.blocks, [{ name: "M", content: "> quote\n>>\nkept", openLineNo: 1 }]);
    assert.equal(s.unterminated, null);
  });

  it("keeps another block's terminator, and an opener, as body content", () => {
    // Only the open block's own terminator is meaningful inside it.
    const s = segmentProtocolText("M<<\n>>OTHER\nN<<\nstill M\n>>M");
    assert.deepEqual(s.blocks, [{ name: "M", content: ">>OTHER\nN<<\nstill M", openLineNo: 1 }]);
  });

  it("reports the name of an unterminated block", () => {
    const s = segmentProtocolText("M<<\nbody with no terminator");
    assert.equal(s.unterminated, "M");
    assert.deepEqual(s.blocks, []);
  });

  it("reports a top-level terminator that closes no block as a stray terminator", () => {
    // The fingerprint of a block that closed early because its body contained
    // its own terminator: the real terminator is stranded at top level.
    const s = segmentProtocolText("M<<\na\n>>M\ntail\n>>M");
    assert.deepEqual(s.blocks, [{ name: "M", content: "a", openLineNo: 1 }]);
    assert.deepEqual(s.strayTerminators, [{ name: "M", lineNo: 5 }]);
    // The stranded terminator is not silently folded into topLevel.
    assert.deepEqual(s.topLevel.map((l) => l.text), ["tail"]);
  });

  it("tolerates a markdown bullet on both opener and terminator", () => {
    const s = segmentProtocolText("- M<<\nbody\n- >>M");
    assert.deepEqual(s.blocks, [{ name: "M", content: "body", openLineNo: 1 }]);
  });

  it("exposes blockTerminator as the single source of the terminator spelling", () => {
    assert.equal(blockTerminator("SUMMARY"), ">>SUMMARY");
  });
});

describe("findStructuralBlockError", () => {
  it("returns null for well-formed text", () => {
    assert.equal(findStructuralBlockError("PLAN: x\nM<<\nbody\n>>M\nmore prose"), null);
  });

  it("catches an unterminated block — a stray opener that swallows later records", () => {
    // The regression path: a record-only stage would otherwise settle with every
    // line after a stray opener silently dropped into the open block's body.
    const msg = findStructuralBlockError("QUESTION: a\nNOTE<<\nQUESTION: b");
    assert.match(msg ?? "", /unterminated NOTE<< block \(missing >>NOTE\)/);
  });

  it("catches a stray terminator — a block that closed early on its own terminator", () => {
    const msg = findStructuralBlockError("OVERVIEW<<\na\n>>OVERVIEW\ntail\n>>OVERVIEW");
    assert.match(msg ?? "", /stray ">>OVERVIEW".*closes no open OVERVIEW<< block/);
  });

  it("catches a well-formed but unexpected block that would swallow records", () => {
    // The seventh shape: a balanced NOTE<< … >>NOTE in a stage that declares no
    // such block. Structurally valid, so unterminated/stray miss it; its body
    // (and any records inside) would be silently dropped.
    const raw = ["QUESTION: a", "NOTE<<", "QUESTION: swallowed", ">>NOTE"].join("\n");
    assert.equal(findStructuralBlockError(raw), null, "no expected set → structural-only, permissive");
    const msg = findStructuralBlockError(raw, []);
    assert.match(msg ?? "", /unexpected NOTE<< block/);
  });

  it("accepts a block whose name is in the expected set", () => {
    assert.equal(findStructuralBlockError("SUMMARY<<\nok\n>>SUMMARY", ["SUMMARY"]), null);
    assert.match(
      findStructuralBlockError("SUMMARY<<\nok\n>>SUMMARY\nDETAIL<<\nx\n>>DETAIL", ["SUMMARY"]) ?? "",
      /unexpected DETAIL<< block/,
    );
  });

  it("catches a known block opener nested inside another block's body (case H mis-bind)", () => {
    // A standalone RISKS<< inside the OVERVIEW body does not nest — RISKS content
    // mis-binds into overview and the risks field goes silently empty.
    const raw = ["OVERVIEW<<", "概述。", "RISKS<<", "数据丢失风险。", ">>RISKS", ">>OVERVIEW"].join("\n");
    const msg = findStructuralBlockError(raw, ["OVERVIEW", "RISKS"]);
    assert.match(msg ?? "", /RISKS<< appears on its own line inside the OVERVIEW<< block body/);
  });

  it("leaves an opener-shaped line alone when its name is not a known block", () => {
    // The escape hatch: a markdown body may mention an off-script opener as prose.
    assert.equal(
      findStructuralBlockError("MARKDOWN<<\n例如写 NOTE<<\n就这样\n>>MARKDOWN", ["MARKDOWN"]),
      null,
    );
  });
});

describe("collectSingletonBlock", () => {
  it("collects a well-formed block", () => {
    const r = collectSingletonBlock(`MARKDOWN<<\n# PRD\n\n## 目标\nbody\n${blockTerminator("MARKDOWN")}`, "MARKDOWN");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.content, "# PRD\n\n## 目标\nbody");
  });

  it("returns null content when the block is absent", () => {
    const r = collectSingletonBlock("just prose", "MARKDOWN");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.content, null);
  });

  it("keeps a body that quotes this protocol — the motivating case", () => {
    // A PRD that documents the protocol wants bare ">>" and other openers in its
    // body. Before named terminators this truncated and cross-bound fields;
    // now it round-trips.
    const body = "块的收尾写：\n>>\n另一个块开头写 NAME<<\n就这样。";
    const r = collectSingletonBlock(`OVERVIEW<<\n${body}\n>>OVERVIEW`, "OVERVIEW");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.content, body);
  });

  it("fails loud when the body contains a standalone line equal to its own terminator", () => {
    // The one thing the named scheme cannot express: a body whose own line is
    // exactly `>>OVERVIEW`. It closes the block early. Rather than silently
    // truncate (the whole failure class), it must fail loud.
    const raw = ["OVERVIEW<<", "收尾写成", ">>OVERVIEW", "这句绝不能丢", ">>OVERVIEW"].join("\n");
    const r = collectSingletonBlock(raw, "OVERVIEW");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /stray ">>OVERVIEW"/);
  });

  it("rejects an unterminated block", () => {
    const r = collectSingletonBlock("MARKDOWN<<\nbody", "MARKDOWN");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /unterminated MARKDOWN<< block/);
    assert.match(r.message, />>MARKDOWN/);
  });

  it("rejects a duplicated block", () => {
    const r = collectSingletonBlock("MARKDOWN<<\na\n>>MARKDOWN\nMARKDOWN<<\nb\n>>MARKDOWN", "MARKDOWN");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /duplicate MARKDOWN<< block/);
  });

  it("does not mistake another block's terminator for its own in a multi-block payload", () => {
    const raw = ["OVERVIEW<<", "a", ">>OVERVIEW", "TARGETUSERS<<", "b", ">>TARGETUSERS", "RISKS<<", "c", ">>RISKS"].join("\n");
    for (const [name, expected] of [["OVERVIEW", "a"], ["TARGETUSERS", "b"], ["RISKS", "c"]] as const) {
      const r = collectSingletonBlock(raw, name);
      assert.equal(r.ok, true, `${name}: ${r.ok ? "" : r.message}`);
      if (!r.ok) return;
      assert.equal(r.content, expected);
    }
  });
});

describe("scanProtocolLines", () => {
  it("scans KEYWORD: rest lines and tolerates bullets", () => {
    const lines = scanProtocolLines("- FINDING: a\nprose\nAPPROVED: true", ["FINDING", "APPROVED"]);
    assert.deepEqual(lines.map((l) => [l.keyword, l.rest]), [["FINDING", "a"], ["APPROVED", "true"]]);
  });

  it("preserves !/? keyword variants", () => {
    const lines = scanProtocolLines("COMMAND!: npm test\nCOMMAND?: npm run lint", ["COMMAND!", "COMMAND?"]);
    assert.deepEqual(lines.map((l) => l.keyword), ["COMMAND!", "COMMAND?"]);
  });

  it("does NOT harvest records from inside a block body — the phantom-record bug", () => {
    // A model recapping its findings inside a SUMMARY block used to have that
    // prose parsed as real records: a phantom P0 that blocks the QA gate.
    const raw = [
      "FINDING: real",
      "SUMMARY<<",
      "Blocking issues:",
      "FINDING: recap that must not be harvested",
      ">>SUMMARY",
    ].join("\n");
    const found = scanProtocolLines(raw, ["FINDING"]);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.rest, "real");
  });
});

function aiResult(over: Partial<AiRunResult>): AiRunResult {
  return {
    threadId: "t",
    runId: "r",
    summary: "",
    success: true,
    changedFiles: [],
    items: [],
    ...over,
  } as AiRunResult;
}

/**
 * The security lynchpin: the migrated stages accept model output only through
 * this pair, so it is tested directly rather than only via a stage.
 */
describe("applyLineProtocol + guardLineProtocolSchema", () => {
  const okParse = () => ({ ok: true as const, payload: { a: 1 } });

  it("replaces structuredOutput with the parsed payload and marks the source", () => {
    const { result, state } = applyLineProtocol(
      aiResult({ summary: "PLAN: x", structuredOutput: { hand: "authored" } }),
      okParse,
      { changeId: "C", repoPath: "/tmp" },
    );
    assert.deepEqual(result.structuredOutput, { a: 1 });
    assert.equal(result.structuredOutputSource, "line_protocol");
    assert.equal(state.payload, result.structuredOutput, "state holds the payload by reference");
  });

  it("accepts only the parser's own payload object — model-authored JSON is refused by identity", () => {
    const { state, result } = applyLineProtocol(
      aiResult({ summary: "PLAN: x" }),
      okParse,
      { changeId: "C", repoPath: "/tmp" },
    );
    const guard = guardLineProtocolSchema(state, () => true, "plan");

    // The parser's payload (by reference) passes.
    assert.equal(guard(result.structuredOutput), true);
    // A structurally identical object the model could have authored does NOT.
    const impostor = guard({ a: 1 });
    assert.notEqual(impostor, true);
    if (impostor === true) return;
    assert.match(impostor.message, /line protocol is authoritative/);
  });

  it("defers to the base schema only after the identity check passes", () => {
    const { state, result } = applyLineProtocol(aiResult({ summary: "PLAN: x" }), okParse, { changeId: "C", repoPath: "/tmp" });
    const base = () => ({ ok: false as const, message: "schema says no" });
    const verdict = guardLineProtocolSchema(state, base, "plan")(result.structuredOutput);
    assert.notEqual(verdict, true);
    if (verdict === true) return;
    assert.equal(verdict.message, "schema says no");
  });

  it("fails every candidate with the parse message when the parse failed", () => {
    const { state, result } = applyLineProtocol(
      aiResult({ summary: "no protocol here", structuredOutput: { hand: "authored" } }),
      () => ({ ok: false as const, message: "protocol rejected: no PLAN" }),
      { changeId: "C", repoPath: "/tmp" },
    );
    // A sentinel {} is left so validateSchema runs at least once.
    assert.deepEqual(result.structuredOutput, {});
    assert.equal(state.failure, "protocol rejected: no PLAN");
    const guard = guardLineProtocolSchema(state, () => true, "plan");
    for (const candidate of [result.structuredOutput, { hand: "authored" }, { a: 1 }]) {
      const v = guard(candidate);
      assert.notEqual(v, true);
      if (v !== true) assert.equal(v.message, "protocol rejected: no PLAN");
    }
  });

  it("leaves a failed provider run untouched with an empty state", () => {
    const failed = aiResult({ success: false, structuredOutput: { x: 1 } });
    const { result, state } = applyLineProtocol(failed, okParse, { changeId: "C", repoPath: "/tmp" });
    assert.equal(result, failed, "the result is returned unchanged");
    assert.deepEqual(state, {}, "empty state — the caller must not guard against it");
  });

  /**
   * The parser must never be asked to explain a document that does not exist.
   * A provider killed mid-flight returns `success: true` with `summary: ""` from
   * engines that do not gate on delivery; parsing that produced "expected a
   * MARKDOWN<< … >>MARKDOWN block" and — worse — stamped the result
   * `structuredOutputSource: "line_protocol"`, which asserts the model authored
   * protocol text. That false provenance is what every downstream label trusted.
   */
  it("never parses an empty reply, and never claims line_protocol provenance for one", () => {
    for (const summary of ["", "   ", "\n\n\t "]) {
      let parserCalls = 0;
      const empty = aiResult({ summary, success: true });
      const { result, state } = applyLineProtocol(
        empty,
        () => {
          parserCalls += 1;
          return { ok: false as const, message: "expected a MARKDOWN<< … >>MARKDOWN block" };
        },
        { changeId: "C", repoPath: "/tmp" },
      );

      assert.equal(parserCalls, 0, `parser must not run on ${JSON.stringify(summary)}`);
      assert.equal(result, empty, "the result is returned unchanged");
      assert.notEqual(
        result.structuredOutputSource,
        "line_protocol",
        "an absent reply is not evidence the model wrote protocol lines",
      );
      assert.deepEqual(state, {}, "no payload and no parse failure — there was nothing to parse");
    }
  });

  it("still parses — and still reports format failures for — a reply that has text", () => {
    const { state } = applyLineProtocol(
      aiResult({ summary: "the model wrote prose instead of protocol lines", success: true }),
      () => ({ ok: false as const, message: "protocol rejected: no PLAN" }),
      { changeId: "C", repoPath: "/tmp" },
    );
    assert.equal(state.failure, "protocol rejected: no PLAN", "real text still gets a real verdict");
  });
});
