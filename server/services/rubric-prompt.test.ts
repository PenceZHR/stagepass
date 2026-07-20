import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseRubricLineProtocol } from "./rubric-line-protocol.ts";
import { renderRubricPromptSection } from "./rubric-prompt.ts";
import type { RubricRole } from "./rubric-assessment.ts";
import type { RubricVersionRecord } from "./rubric-service.ts";

function rubric(role: RubricRole, texts: string[]): RubricVersionRecord {
  return {
    id: "RUB-fixture",
    projectId: "PRJ-fixture",
    changeId: null,
    phase: "Spec",
    role,
    version: 1,
    isCurrent: true,
    createdAt: "2026-07-20T10:00:00.000Z",
    criteria: texts.map((text, ordinal) => ({
      id: `RBC-${ordinal + 1}`,
      ordinal,
      text,
      blocking: true,
    })),
  };
}

const CRITERIA = [
  "Every requirement has an acceptance criterion",
  "No requirement contradicts the PRD",
];

describe("rubric prompt section", () => {
  it("asks for every criterion by its exact id", () => {
    const section = renderRubricPromptSection(rubric("producer", CRITERIA))!;
    assert.ok(section);
    for (const criterion of rubric("producer", CRITERIA).criteria) {
      assert.match(section, new RegExp(criterion.id));
      assert.match(section, new RegExp(criterion.text));
    }
    assert.match(section, /恰好一行/);
    assert.match(section, /共 2 行/);
  });

  it("teaches exactly the vocabulary the parser accepts", () => {
    const section = renderRubricPromptSection(rubric("critic", CRITERIA))!;
    // The prompt and the parser have to agree on the verdict vocabulary. A
    // prompt that offered a third value would produce replies the parser voids
    // wholesale, and the model would never learn why.
    assert.match(section, /`yes` 或 `no`/);
    assert.match(section, /不要写 `not_assessed`/);
    assert.match(section, /未知 ID/);
  });

  it("round-trips its own worked example through the parser", () => {
    // This is the guard that keeps prompt and parser from drifting: whatever
    // shape the section demonstrates must be a shape parseRubricLineProtocol
    // actually accepts.
    const record = rubric("verdict", CRITERIA);
    const section = renderRubricPromptSection(record)!;
    const example = section.split("\n").filter((line) => line.startsWith("RUBRIC: RBC-"));
    assert.equal(example.length, 1, "the section should demonstrate exactly one worked line");

    const parsed = parseRubricLineProtocol(example[0]!, {
      criterionIds: record.criteria.map((criterion) => criterion.id),
    });
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.equal(parsed.payload.judgments.length, 1);
    assert.equal(parsed.payload.judgments[0]!.criterionId, "RBC-1");
    assert.equal(parsed.payload.judgments[0]!.verdict, "no");
  });

  it("frames the ask differently for producer, critic and verdict", () => {
    const producer = renderRubricPromptSection(rubric("producer", CRITERIA))!;
    const critic = renderRubricPromptSection(rubric("critic", CRITERIA))!;
    const verdict = renderRubricPromptSection(rubric("verdict", CRITERIA))!;

    assert.match(producer, /自证/);
    assert.match(critic, /不要采信作者的自证结论/);
    assert.match(verdict, /正方与反方各自的产出/);
    assert.notEqual(producer, critic);
    assert.notEqual(critic, verdict);
  });

  it("renders nothing for an empty rubric", () => {
    // §4.5: an empty rubric means this phase does no rubric judging, so the
    // stage's prompt must be byte-identical to what it was before rubrics.
    assert.equal(renderRubricPromptSection(rubric("producer", [])), null);
  });
});
