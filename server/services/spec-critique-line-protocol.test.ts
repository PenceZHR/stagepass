import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseSpecCritiqueLineProtocol } from "./spec-critique-line-protocol";
import { validateBlueCritiqueOutput } from "./spec-battle-ledger";


function parse(text: string) {
  return parseSpecCritiqueLineProtocol(text);
}

const HAPPY = [
  "REVIEW: gap-auth-scope | resolved | 红方补齐了权限矩阵 | PRD delta 第 2 节新增角色表 | PRD delta 第 2 节 | -",
  "REVIEW: gap-retention | still_open | 保留期仍未定义 | fixClaims 未提到保留期 | - | -",
  "GAP: gap-export-limit | 导出条数上限未定义 | scope | P1 | 规格只说“支持导出”，没有上限 | 补一句：单次导出上限 10000 条",
  "ARTIFACT: gap-export-limit | .ship/changes/CHG-1/spec/round-1/prd-delta.md",
  "CRITIQUE_DONE: true",
].join("\n");

describe("parseSpecCritiqueLineProtocol", () => {
  it("parses a well-formed critique into the blue critique shape", () => {
    const result = parse(HAPPY);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.gapReviews.length, 2);
    assert.deepEqual(result.payload.gapReviews[0], {
      canonicalGapId: "gap-auth-scope",
      verdict: "resolved",
      reviewSummary: "红方补齐了权限矩阵",
      evidence: "PRD delta 第 2 节新增角色表",
      resolutionEvidence: "PRD delta 第 2 节",
      downgradedTo: null,
    });
    assert.equal(result.payload.gapReviews[1]!.resolutionEvidence, null);
    assert.equal(result.payload.requirementGaps.length, 1);
    assert.deepEqual(result.payload.requirementGaps[0], {
      canonicalGapId: "gap-export-limit",
      title: "导出条数上限未定义",
      category: "scope",
      severity: "P1",
      evidence: "规格只说“支持导出”，没有上限",
      affectedArtifacts: [".ship/changes/CHG-1/spec/round-1/prd-delta.md"],
      proposedSpecPatch: "补一句：单次导出上限 10000 条",
      specBlocking: true,
      mergeBlocking: true,
    });
  });

  it("assembles a payload the ledger schema accepts", () => {
    const result = parse(HAPPY);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(validateBlueCritiqueOutput(result.payload).success, true);
  });

  it("accepts a clean critique that found nothing", () => {
    const result = parse("我复核了旧 gap，也没发现新问题。\nCRITIQUE_DONE: true");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.payload, { gapReviews: [], requirementGaps: [] });
  });

  it("rejects a prose-only reply rather than settling it as a clean critique", () => {
    // Both arrays may legitimately be empty, so without the CRITIQUE_DONE
    // anchor an ignored protocol is indistinguishable from "spec looks good".
    const result = parse("我看了一下，规格写得挺好的。");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /expected exactly 1 CRITIQUE_DONE: true line, got 0/);
  });

  it("derives specBlocking/mergeBlocking from severity", () => {
    const result = parse(
      "GAP: gap-typo | 文案不一致 | ux | P2 | 两处称呼不同 | -\nCRITIQUE_DONE: true",
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.requirementGaps[0]!.specBlocking, false);
    assert.equal(result.payload.requirementGaps[0]!.mergeBlocking, false);
    assert.equal(result.payload.requirementGaps[0]!.proposedSpecPatch, null);
  });

  it("collects multiple artifacts per gap and defaults to an empty list", () => {
    const result = parse([
      "GAP: gap-a | A | scope | P0 | evidence a | -",
      "GAP: gap-b | B | risk | P0 | evidence b | -",
      "ARTIFACT: gap-a | spec/a.md",
      "ARTIFACT: gap-a | spec/b.md",
      "CRITIQUE_DONE: true",
    ].join("\n"));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.payload.requirementGaps[0]!.affectedArtifacts, ["spec/a.md", "spec/b.md"]);
    assert.deepEqual(result.payload.requirementGaps[1]!.affectedArtifacts, []);
  });

  it("rejects an ARTIFACT that references no declared GAP", () => {
    const result = parse("ARTIFACT: gap-ghost | spec/a.md\nCRITIQUE_DONE: true");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /ARTIFACT references unknown GAP canonicalGapId "gap-ghost"/);
  });

  it("rejects a downgraded verdict with no downgrade target", () => {
    // completeBlueCritique() silently updates nothing for downgraded+null: the
    // gap would stay open and un-evaluated with no trace of the review.
    const result = parse("REVIEW: gap-a | downgraded | 降级 | 证据 | 依据 | -\nCRITIQUE_DONE: true");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /downgraded verdict requires downgradedTo P1 or P2/);
  });

  it("rejects a downgrade target on a non-downgraded verdict", () => {
    const result = parse("REVIEW: gap-a | still_open | 仍开着 | 证据 | - | P2\nCRITIQUE_DONE: true");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /downgradedTo must be - unless the verdict is downgraded/);
  });

  it("accepts a well-formed downgrade", () => {
    const result = parse("REVIEW: gap-a | downgraded | 降为 P2 | 证据 | 降级依据 | P2\nCRITIQUE_DONE: true");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.gapReviews[0]!.downgradedTo, "P2");
  });

  it("rejects resolved/downgraded verdicts with no resolutionEvidence", () => {
    const result = parse("REVIEW: gap-a | resolved | 已解决 | 证据 | - | -\nCRITIQUE_DONE: true");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /resolved verdict requires resolutionEvidence/);
  });

  it("rejects unknown verdicts and severities", () => {
    assert.equal(parse("REVIEW: gap-a | looks_ok | s | e | - | -\nCRITIQUE_DONE: true").ok, false);
    assert.equal(parse("GAP: gap-a | t | scope | P3 | e | -\nCRITIQUE_DONE: true").ok, false);
  });

  it("rejects a canonicalGapId with whitespace or JSON garbage", () => {
    const spaced = parse("GAP: gap a | t | scope | P0 | e | -\nCRITIQUE_DONE: true");
    assert.equal(spaced.ok, false);
    if (spaced.ok) return;
    assert.match(spaced.message, /canonicalGapId contains whitespace/);

    const garbage = parse('GAP: gap-a"},{" | t | scope | P0 | e | -\nCRITIQUE_DONE: true');
    assert.equal(garbage.ok, false);
    if (garbage.ok) return;
    assert.match(garbage.message, /canonicalGapId contains JSON fragment garbage/);
  });

  it("rejects duplicate REVIEW ids carrying contradictory verdicts", () => {
    const result = parse([
      "REVIEW: G1 | resolved | s | e | ev | -",
      "REVIEW: G1 | still_open | s2 | e2 | - | -",
      "CRITIQUE_DONE: true",
    ].join("\n"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /duplicate REVIEW canonicalGapId: G1/);
  });

  it("rejects duplicate GAP ids rather than silently keeping one", () => {
    const result = parse([
      "GAP: gap-a | A | scope | P0 | evidence a | -",
      "GAP: gap-a | A again | scope | P1 | evidence b | -",
      "CRITIQUE_DONE: true",
    ].join("\n"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /duplicate GAP canonicalGapId: gap-a/);
  });

  it("rejects a wrong field count rather than silently shifting fields", () => {
    const result = parse("GAP: gap-a | title | scope | P0 | evidence\nCRITIQUE_DONE: true");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /GAP needs exactly 6 "\|" fields/);
  });

  it("rejects empty required text fields", () => {
    assert.equal(parse("REVIEW: gap-a | still_open |  | e | - | -\nCRITIQUE_DONE: true").ok, false);
    assert.equal(parse("REVIEW: gap-a | still_open | s |  | - | -\nCRITIQUE_DONE: true").ok, false);
    assert.equal(parse("GAP: gap-a | t | scope | P0 |  | -\nCRITIQUE_DONE: true").ok, false);
  });

  it("ignores prose around the protocol lines", () => {
    const result = parse(`先复核旧 gap：\n${HAPPY}\n以上就是本轮结论。`);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.gapReviews.length, 2);
  });
});
