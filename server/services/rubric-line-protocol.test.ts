import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateOutputSchema } from "./output-schema-validator.ts";
import {
  buildRubricAssessments,
  rubricOutcome,
  type RubricCriterion,
} from "./rubric-assessment.ts";
import {
  parseRubricLineProtocol,
  RUBRIC_OUTPUT_SCHEMA,
  type RubricLineProtocolOptions,
} from "./rubric-line-protocol.ts";

const CRITERIA: RubricCriterion[] = [
  { id: "C1", ordinal: 0, text: "Every requirement has an acceptance criterion", blocking: true },
  { id: "C2", ordinal: 1, text: "No requirement contradicts the PRD", blocking: true },
  { id: "C3", ordinal: 2, text: "Wording is consistent", blocking: false },
];
const IDS = CRITERIA.map((criterion) => criterion.id);

function ok(rawText: string, options?: Partial<RubricLineProtocolOptions>) {
  const parsed = parseRubricLineProtocol(rawText, { criterionIds: IDS, ...options });
  assert.ok(parsed.ok, `expected parse to succeed, got: ${parsed.ok ? "" : parsed.message}`);
  return parsed.payload;
}

function rejected(rawText: string, options?: Partial<RubricLineProtocolOptions>): string {
  const parsed = parseRubricLineProtocol(rawText, { criterionIds: IDS, ...options });
  assert.equal(parsed.ok, false, "expected parse to be rejected");
  return parsed.ok ? "" : parsed.message;
}

describe("rubric line protocol", () => {
  it("assembles judgments from RUBRIC lines", () => {
    const payload = ok([
      "Checked each requirement against the locked PRD.",
      "RUBRIC: C1 | yes | REQ-1..REQ-7 each carry an AC block",
      "RUBRIC: C2 | no | REQ-4 allows anonymous access, PRD §3 requires auth",
      "RUBRIC: C3 | yes | terminology matches the glossary throughout",
    ].join("\n"));

    assert.deepEqual(payload.judgments, [
      { criterionId: "C1", verdict: "yes", evidence: "REQ-1..REQ-7 each carry an AC block" },
      {
        criterionId: "C2",
        verdict: "no",
        evidence: "REQ-4 allows anonymous access, PRD §3 requires auth",
      },
      { criterionId: "C3", verdict: "yes", evidence: "terminology matches the glossary throughout" },
    ]);
    assert.equal(validateOutputSchema(RUBRIC_OUTPUT_SCHEMA, payload), true);
  });

  it("voids the whole output on an unknown criterion id", () => {
    // §4.2. A reply naming a criterion this rubric does not contain answered a
    // different checklist; none of its judgments are attributable, so partial
    // salvage is not on the table.
    assert.match(
      rejected([
        "RUBRIC: C1 | yes | fine",
        "RUBRIC: C9 | yes | invented criterion",
      ].join("\n")),
      /unknown criterionId "C9" is not part of this rubric/,
    );
  });

  it("voids the whole output on an unknown verdict", () => {
    assert.match(
      rejected("RUBRIC: C1 | maybe | hedging"),
      /verdict must be yes or no, got "maybe"/,
    );
  });

  it("refuses to let the model write not_assessed itself", () => {
    // not_assessed is stagepass's record of an unanswered criterion, not a
    // third answer. If a model could declare it, "I decline to answer" would
    // become indistinguishable from "I was never asked".
    assert.match(
      rejected("RUBRIC: C1 | not_assessed | I could not tell"),
      /not_assessed is recorded by stagepass for an unanswered criterion/,
    );
  });

  it("rejects a duplicate criterion id", () => {
    assert.match(
      rejected(["RUBRIC: C1 | yes | a", "RUBRIC: C1 | no | b"].join("\n")),
      /duplicate RUBRIC criterionId: C1/,
    );
  });

  it("requires evidence on every judgment, including yes", () => {
    assert.match(rejected("RUBRIC: C1 | yes | "), /evidence is empty/);
    assert.match(rejected("RUBRIC: C1 | yes"), /RUBRIC needs 3 "\|" fields/);
  });

  it("lets evidence contain pipes without shifting the fixed fields", () => {
    const payload = ok("RUBRIC: C1 | no | saw a | b | c in the output");
    assert.deepEqual(payload.judgments, [
      { criterionId: "C1", verdict: "no", evidence: "saw a | b | c in the output" },
    ]);
  });

  it("ignores prose and tolerates a host stage's own blocks", () => {
    const payload = ok([
      "Some reasoning the model wants to write down.",
      "SUMMARY<<",
      "RUBRIC: C1 | yes | this line is inside the host block and is not a record",
      ">>SUMMARY",
      "RUBRIC: C2 | yes | actually judged",
    ].join("\n"), { expectedBlockNames: ["SUMMARY"] });

    assert.deepEqual(payload.judgments, [
      { criterionId: "C2", verdict: "yes", evidence: "actually judged" },
    ]);
  });

  it("treats zero RUBRIC lines as a parse success", () => {
    // Not an error, because an empty rubric is legal. A non-empty rubric that
    // got no lines is caught downstream as not_assessed on every criterion,
    // which blocks -- see the assessment tests below.
    assert.deepEqual(ok("I have nothing to report.").judgments, []);
  });
});

describe("rubric assessments", () => {
  it("records a criterion the model never answered as not_assessed", () => {
    // The central fail-closed guarantee: silence is recorded as silence.
    const { judgments } = ok("RUBRIC: C1 | yes | done");
    const assessments = buildRubricAssessments(CRITERIA, judgments);

    assert.deepEqual(assessments, [
      { criterionId: "C1", verdict: "yes", evidence: "done" },
      { criterionId: "C2", verdict: "not_assessed", evidence: null },
      { criterionId: "C3", verdict: "not_assessed", evidence: null },
    ]);
  });

  it("blocks on a missing answer rather than passing it", () => {
    // The over-permissive direction this whole mechanism exists to prevent:
    // an unanswered criterion must never read as a pass.
    const assessments = buildRubricAssessments(CRITERIA, ok("RUBRIC: C1 | yes | done").judgments);
    const outcome = rubricOutcome(CRITERIA, assessments);

    assert.equal(outcome.blocked, true);
    assert.deepEqual(outcome.notAssessedCriterionIds, ["C2", "C3"]);
    assert.deepEqual(outcome.failedCriterionIds, []);
  });

  it("blocks on not_assessed even for a non-blocking criterion", () => {
    // §4.3. `blocking: false` says "a failure here should not stop the
    // pipeline" -- a judgment about content. Silence is not content, so a
    // non-blocking criterion must not become a place to hide unanswered
    // questions.
    const answeredExceptC3 = ok([
      "RUBRIC: C1 | yes | a",
      "RUBRIC: C2 | yes | b",
    ].join("\n"));
    const outcome = rubricOutcome(
      CRITERIA,
      buildRubricAssessments(CRITERIA, answeredExceptC3.judgments),
    );

    assert.equal(outcome.blocked, true);
    assert.deepEqual(outcome.notAssessedCriterionIds, ["C3"]);
  });

  it("blocks a `no` on a blocking criterion and only records one on a non-blocking criterion", () => {
    const outcome = rubricOutcome(
      CRITERIA,
      buildRubricAssessments(
        CRITERIA,
        ok([
          "RUBRIC: C1 | yes | a",
          "RUBRIC: C2 | no | REQ-4 contradicts PRD §3",
          "RUBRIC: C3 | no | two spellings of 'workspace'",
        ].join("\n")).judgments,
      ),
    );

    assert.equal(outcome.blocked, true);
    assert.deepEqual(outcome.failedCriterionIds, ["C2"]);
    assert.deepEqual(outcome.advisoryCriterionIds, ["C3"]);
    assert.deepEqual(outcome.notAssessedCriterionIds, []);
  });

  it("passes only when every criterion is answered and no blocking one failed", () => {
    const outcome = rubricOutcome(
      CRITERIA,
      buildRubricAssessments(
        CRITERIA,
        ok([
          "RUBRIC: C1 | yes | a",
          "RUBRIC: C2 | yes | b",
          "RUBRIC: C3 | no | cosmetic only",
        ].join("\n")).judgments,
      ),
    );

    assert.equal(outcome.blocked, false);
    assert.deepEqual(outcome.advisoryCriterionIds, ["C3"]);
  });

  it("blocks every criterion when the model answers nothing at all", () => {
    const outcome = rubricOutcome(
      CRITERIA,
      buildRubricAssessments(CRITERIA, ok("I have nothing to report.").judgments),
    );

    assert.equal(outcome.blocked, true);
    assert.deepEqual(outcome.notAssessedCriterionIds, ["C1", "C2", "C3"]);
  });

  it("refuses to silently drop a judgment for an unknown criterion", () => {
    // Reaching this means a caller parsed without the rubric's criterion ids,
    // so the parser's unknown-id gate never ran. Dropping the judgment would be
    // indistinguishable from the model never answering.
    assert.throws(
      () =>
        buildRubricAssessments(CRITERIA, [
          { criterionId: "C9", verdict: "yes", evidence: "invented" },
        ]),
      /criteria that are not in this rubric: C9/,
    );
  });

  it("returns assessments in ordinal order regardless of the order answered", () => {
    const assessments = buildRubricAssessments(
      CRITERIA,
      ok([
        "RUBRIC: C3 | yes | c",
        "RUBRIC: C1 | yes | a",
        "RUBRIC: C2 | yes | b",
      ].join("\n")).judgments,
    );
    assert.deepEqual(assessments.map((assessment) => assessment.criterionId), ["C1", "C2", "C3"]);
  });
});
