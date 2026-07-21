import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseSpecRedLineProtocol } from "./spec-red-line-protocol";
import { validateRedSpecLinePayload } from "./spec-battle-ledger";


function parse(text: string) {
  return parseSpecRedLineProtocol(text);
}

const BODY = "# CHG-1 PRD Delta\n\n## 问题与目标\n\n补齐状态矩阵。\n";

function reply(options: {
  body?: string;
  claims?: string[];
  done?: boolean;
  trailing?: string;
} = {}) {
  const lines = [
    "PRD_DELTA<<",
    options.body ?? BODY,
    ">>PRD_DELTA",
    ...(options.claims ?? [
      "FIXCLAIM: gap-state-matrix | fixed | 已补齐状态矩阵 | 新增 Ready/Running/Failed 转换规则 | prd-delta.md",
      "FIXCLAIM: gap-retention | not_fixed | 保留期仍待人工确认 | 需要法务给出期限 | -",
    ]),
    ...(options.done === false ? [] : ["SPEC_DONE: true"]),
    ...(options.trailing ? [options.trailing] : []),
  ];
  return lines.join("\n");
}

describe("parseSpecRedLineProtocol", () => {
  it("parses a well-formed reply into the red spec shape", () => {
    const result = parse(reply());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.markdown, BODY);
    assert.equal(result.payload.fixClaims.length, 2);
    assert.deepEqual(result.payload.fixClaims[0], {
      canonicalGapId: "gap-state-matrix",
      claimStatus: "fixed",
      claimSummary: "已补齐状态矩阵",
      evidence: "新增 Ready/Running/Failed 转换规则",
      artifactPath: "prd-delta.md",
    });
    assert.equal(result.payload.fixClaims[1]!.artifactPath, null);
  });

  it("assembles a payload the ledger schema accepts", () => {
    const result = parse(reply());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(validateRedSpecLinePayload(result.payload).success, true);
  });

  // The whole point of the migration. Under the JSON contract this exact reply
  // -- a correct payload with one extra line after it -- made JSON.parse throw,
  // and parseRedSpecOutput's bare catch silently returned zero fixClaims while
  // handing the raw text on as the PRD delta. A production round carried 11
  // claims; one stray line would have dropped all 11 with no error anywhere.
  it("keeps every claim when the model adds a line outside the protocol", () => {
    const result = parse(reply({ trailing: "以上就是本轮的修复说明。" }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.fixClaims.length, 2);
    assert.equal(result.payload.markdown, BODY);
  });

  it("keeps the markdown body byte-exact through tables, fences and pipes", () => {
    const body = [
      "# PRD",
      "",
      "| 字段 | 说明 |",
      "| --- | --- |",
      "| a | b |",
      "",
      "```ts",
      "const x = { a: 1 };",
      "```",
      "",
      "散文里出现 >> 或 >>OTHER 都不该关闭块。",
    ].join("\n");
    const result = parse(reply({ body }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.markdown, body);
  });

  // First round has no prior gaps to claim against, so zero FIXCLAIM lines is a
  // legal reply -- exactly what production round 1 produced.
  it("accepts zero FIXCLAIM lines", () => {
    const result = parse(reply({ claims: [] }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.payload.fixClaims, []);
  });

  // Zero claims being legal is why SPEC_DONE has to exist: the FIXCLAIM lines
  // trail a very large block, so a reply truncated just after the block still
  // looks structurally complete. Losing the marker is what turns that back into
  // a loud failure instead of a silently claim-free round.
  it("rejects a reply truncated after the block", () => {
    const result = parse(reply({ claims: [], done: false }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /SPEC_DONE/);
  });

  it("rejects more than one SPEC_DONE", () => {
    const result = parse(`${reply()}\nSPEC_DONE: true`);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /SPEC_DONE/);
  });

  it("rejects a missing PRD_DELTA block", () => {
    const result = parse("FIXCLAIM: gap-a | fixed | s | e | -\nSPEC_DONE: true");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /PRD_DELTA/);
  });

  it("rejects an empty PRD_DELTA block", () => {
    const result = parse(reply({ body: "   " }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /PRD_DELTA/);
  });

  it("rejects an unterminated PRD_DELTA block", () => {
    const result = parse(`PRD_DELTA<<\n${BODY}\nSPEC_DONE: true`);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /PRD_DELTA/);
  });

  // A structurally valid block this stage never declared swallows every record
  // inside it, so the schema never sees what went missing.
  it("rejects an undeclared block", () => {
    const result = parse(`NOTE<<\nFIXCLAIM: gap-a | fixed | s | e | -\n>>NOTE\n${reply()}`);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /NOTE/);
  });

  it("rejects an unknown claimStatus", () => {
    const result = parse(reply({ claims: ["FIXCLAIM: gap-a | done | s | e | -"] }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /claimStatus/);
  });

  it("rejects the wrong FIXCLAIM field count", () => {
    const result = parse(reply({ claims: ["FIXCLAIM: gap-a | fixed | s | e"] }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /FIXCLAIM/);
  });

  it("rejects an empty claimSummary or evidence", () => {
    const summary = parse(reply({ claims: ["FIXCLAIM: gap-a | fixed |  | e | -"] }));
    assert.equal(summary.ok, false);
    if (!summary.ok) assert.match(summary.message, /claimSummary/);
    const evidence = parse(reply({ claims: ["FIXCLAIM: gap-a | fixed | s |  | -"] }));
    assert.equal(evidence.ok, false);
    if (!evidence.ok) assert.match(evidence.message, /evidence/);
  });

  // Two claims for one gap carry contradictory statuses (fixed vs not_fixed)
  // and both land in red_fix_claims, so blue reviews a gap that claims both.
  it("rejects duplicate canonicalGapId", () => {
    const result = parse(reply({
      claims: [
        "FIXCLAIM: gap-a | fixed | s | e | -",
        "FIXCLAIM: gap-a | not_fixed | s | e | -",
      ],
    }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /duplicate/);
  });

  it("rejects a canonicalGapId that cannot round-trip", () => {
    const result = parse(reply({ claims: ["FIXCLAIM: gap a | fixed | s | e | -"] }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /canonicalGapId/);
  });

  it("reports every problem at once so one retry can fix them all", () => {
    const result = parse(reply({
      claims: [
        "FIXCLAIM: gap-a | done | s | e | -",
        "FIXCLAIM: gap-b | fixed | s | e",
      ],
    }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /claimStatus/);
    assert.match(result.message, /FIXCLAIM needs exactly/);
  });
});
