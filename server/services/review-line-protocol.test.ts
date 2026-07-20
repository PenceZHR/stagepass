import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseReviewLineProtocol } from "./review-line-protocol";
import { parseReviewStructuredOutput } from "./review-structured-output-parser";


function parse(text: string) {
  return parseReviewLineProtocol(text);
}

const HAPPY = [
  "FINDING: P1 | security | server/api/login.ts | 42 | Open redirect | res.redirect(req.query.next) unchecked | Whitelist next before redirect",
  "FINDING: P2 | style | - | - | Naming nit | inconsistent casing | -",
  "PRIOR: FND-9 | fixed | login now whitelists next | - | - | prior blocker resolved",
  "APPROVED: false",
  "SUMMARY<<",
  "One P1 open redirect remains; not approved.",
  ">>SUMMARY",
].join("\n");

describe("parseReviewLineProtocol", () => {
  it("parses a well-formed review into the review structured-output shape", () => {
    const result = parse(HAPPY);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.approved, false);
    assert.equal(result.payload.summary, "One P1 open redirect remains; not approved.");
    assert.equal(result.payload.findings.length, 2);
    assert.deepEqual(result.payload.findings[0], {
      severity: "P1",
      category: "security",
      file: "server/api/login.ts",
      line: 42,
      title: "Open redirect",
      evidence: "res.redirect(req.query.next) unchecked",
      requiredFix: "Whitelist next before redirect",
    });
    assert.equal(result.payload.findings[1]!.file, null);
    assert.equal(result.payload.findings[1]!.line, null);
    assert.equal(result.payload.findings[1]!.requiredFix, null);
    assert.equal(result.payload.priorFindingReviews.length, 1);
    assert.equal(result.payload.priorFindingReviews[0]!.verdict, "fixed");
  });

  it("produces a payload the downstream review parser accepts unchanged", () => {
    const result = parse(HAPPY);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The assembled payload must survive parseReviewStructuredOutput (the
    // settlement consumer) with no reshaping.
    const reparsed = parseReviewStructuredOutput(result.payload);
    assert.equal(reparsed.findings.length, 2);
    assert.equal(reparsed.approved, false);
  });

  it("accepts an approved review with no findings and no priors", () => {
    const result = parse(["APPROVED: true", "SUMMARY<<", "All good.", ">>SUMMARY"].join("\n"));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.approved, true);
    assert.deepEqual(result.payload.findings, []);
    assert.deepEqual(result.payload.priorFindingReviews, []);
  });

  it("rejects an unknown APPROVED value", () => {
    const result = parse(["APPROVED: maybe", "SUMMARY<<", "x", ">>SUMMARY"].join("\n"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /APPROVED must be true or false/);
  });

  it("rejects a missing APPROVED line", () => {
    const result = parse(["SUMMARY<<", "x", ">>SUMMARY"].join("\n"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /exactly 1 APPROVED line/);
  });

  it("rejects a missing or empty SUMMARY block", () => {
    const result = parse("APPROVED: true");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /SUMMARY/);
  });

  it("rejects a FINDING with the wrong field count", () => {
    const result = parse(
      ["FINDING: P1 | bug | - | - | title | evidence", "APPROVED: true", "SUMMARY<<", "s", ">>SUMMARY"].join("\n"),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /FINDING needs exactly 7/);
  });

  it("rejects a FINDING with an invalid severity", () => {
    const result = parse(
      ["FINDING: PX | bug | - | - | title | evidence | fix", "APPROVED: true", "SUMMARY<<", "s", ">>SUMMARY"].join("\n"),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /severity must be P0\/P1\/P2/);
  });

  it("rejects a P0/P1 FINDING that lacks requiredFix", () => {
    const result = parse(
      ["FINDING: P0 | bug | - | - | title | evidence | -", "APPROVED: true", "SUMMARY<<", "s", ">>SUMMARY"].join("\n"),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /P0 FINDING requires a non-empty requiredFix/);
  });

  it("rejects a FINDING that lacks evidence", () => {
    const result = parse(
      ["FINDING: P2 | style | - | - | title | - | -", "APPROVED: true", "SUMMARY<<", "s", ">>SUMMARY"].join("\n"),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /evidence is empty/);
  });

  it("rejects a FINDING file that escapes the repo root", () => {
    const result = parse(
      ["FINDING: P2 | style | ../secrets.txt | - | title | evidence | -", "APPROVED: true", "SUMMARY<<", "s", ">>SUMMARY"].join("\n"),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /FINDING file/);
  });

  it("rejects a non-numeric FINDING line", () => {
    const result = parse(
      ["FINDING: P2 | style | src/app.ts | forty | title | evidence | -", "APPROVED: true", "SUMMARY<<", "s", ">>SUMMARY"].join("\n"),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /FINDING line must be a non-negative integer/);
  });

  it("rejects an unknown PRIOR verdict", () => {
    const result = parse(
      ["PRIOR: FND-1 | maybe | ev | - | - | note", "APPROVED: true", "SUMMARY<<", "s", ">>SUMMARY"].join("\n"),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /PRIOR verdict must be/);
  });

  it("rejects a PRIOR with neither evidence nor reviewerNotes", () => {
    const result = parse(
      ["PRIOR: FND-1 | not_rechecked | - | - | - | -", "APPROVED: true", "SUMMARY<<", "s", ">>SUMMARY"].join("\n"),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /PRIOR requires evidence or reviewerNotes/);
  });

  it("rejects a still_open PRIOR that lacks requiredFix", () => {
    const result = parse(
      ["PRIOR: FND-1 | still_open | ev | - | - | -", "APPROVED: false", "SUMMARY<<", "s", ">>SUMMARY"].join("\n"),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /still_open verdict requires requiredFix/);
  });

  it("rejects a fixed PRIOR that lacks evidence", () => {
    const result = parse(
      ["PRIOR: FND-1 | fixed | - | - | - | note", "APPROVED: true", "SUMMARY<<", "s", ">>SUMMARY"].join("\n"),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /fixed verdict requires evidence/);
  });

  it("rejects duplicate PRIOR ids carrying contradictory verdicts", () => {
    const result = parse([
      "PRIOR: FND-1 | fixed | ev | - | - | n",
      "PRIOR: FND-1 | still_open | ev | fix | - | n",
      "APPROVED: true",
      "SUMMARY<<",
      "s",
      ">>SUMMARY",
    ].join("\n"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /duplicate PRIOR priorFindingId: FND-1/);
  });

  it("refuses to resurrect JSON with no protocol lines", () => {
    const json = JSON.stringify({ findings: [], priorFindingReviews: [], approved: true, summary: "hi" });
    const result = parse(`Here is my review:\n\`\`\`json\n${json}\n\`\`\``);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /APPROVED|SUMMARY/);
  });

  it("fails loud when a FINDING is stranded after a stray opener", () => {
    // scanProtocolLines excludes block bodies now; a stray opener before the
    // real findings must not silently swallow them.
    const result = parse([
      "APPROVED: true",
      "SUMMARY<<",
      "ok",
      ">>SUMMARY",
      "SCRATCH<<",
      "FINDING: P0 | bug | src/a.ts | 1 | stranded | ev | fix",
    ].join("\n"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /unterminated SCRATCH<< block/);
  });

  it("fails loud when a FINDING is inside a balanced unexpected block", () => {
    // The seventh shape: a DETAIL<< … >>DETAIL block that hides a P0.
    const result = parse([
      "FINDING: P1 | bug | a.ts | 1 | real | ev | fix",
      "DETAIL<<",
      "FINDING: P0 | security | b.ts | 2 | hidden | ev | fix",
      ">>DETAIL",
      "APPROVED: false",
      "SUMMARY<<",
      "s",
      ">>SUMMARY",
    ].join("\n"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /unexpected DETAIL<< block/);
  });

  it("fails loud when the SUMMARY body contains its own terminator", () => {
    const result = parse([
      "APPROVED: false",
      "SUMMARY<<",
      "收尾行写成",
      ">>SUMMARY",
      "这句会丢",
      ">>SUMMARY",
    ].join("\n"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /stray ">>SUMMARY"/);
  });
});
