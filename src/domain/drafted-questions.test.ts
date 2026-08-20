import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DRAFTED_OPTIONS,
  draftedQuestions,
} from "./question";
import { createSlotDocument, QUESTION_SHAPE, readSlotDocument } from "./round-slots";

const HEAD = {
  changeId: "CHG-002", phase: "PRD" as const, round: 7, role: "blue" as const,
  artifacts: [], shape: QUESTION_SHAPE, options: [...DRAFTED_OPTIONS],
};

const sheetWith = (entries: readonly (readonly [number, string, string?])[]): string => {
  const doc = JSON.parse(createSlotDocument(HEAD));
  for (const [index, question, why] of entries) {
    doc.slots[index].question = question;
    if (why !== undefined) doc.slots[index].why = why;
  }
  return JSON.stringify(doc, null, 2);
};

describe("Questions the model drafted into its sheet", () => {
  it("turns filled slots into one elicitation whose options are ours", () => {
    const read = readSlotDocument(sheetWith([[0, "结算失败时分数保留吗？", "PRD 3.2 没写"]]), HEAD);
    assert.equal(read.ok, true);

    const question = draftedQuestions({ phase: "PRD", drafted: read.filled })!;
    assert.match(question.message, /PRD/);
    assert.deepEqual(Object.keys(question.requestedSchema.properties), ["B-01"]);
    const field = question.requestedSchema.properties["B-01"]!;
    assert.match(field.title, /结算失败时分数保留吗/);
    assert.match(field.title, /PRD 3\.2 没写/);
    assert.deepEqual(field.enum, [...DRAFTED_OPTIONS]);
  });

  it("keeps the sheet order, which is what makes the form legible", () => {
    // 槽位 id 补过零，所以字典序 = 铺出去的顺序 = 人看到的顺序。
    const read = readSlotDocument(
      sheetWith([[0, "第一问"], [1, "第二问"], [9, "第十问"]]), HEAD,
    );
    assert.equal(read.ok, true);
    const question = draftedQuestions({ phase: "PRD", drafted: read.filled })!;
    assert.deepEqual(Object.keys(question.requestedSchema.properties), ["B-01", "B-02", "B-10"]);
  });

  it("survives the full ten a round is allowed to ask", () => {
    const ten = Array.from({ length: 10 }, (_, i) => [i, `第 ${i + 1} 问`] as const);
    const read = readSlotDocument(sheetWith(ten), HEAD);
    assert.equal(read.ok, true);
    const question = draftedQuestions({ phase: "PRD", drafted: read.filled })!;
    assert.equal(Object.keys(question.requestedSchema.properties).length, 10);
  });

  it("asks nothing when the model filled nothing", () => {
    const read = readSlotDocument(createSlotDocument(HEAD), HEAD);
    assert.equal(read.ok, true);
    assert.equal(draftedQuestions({ phase: "PRD", drafted: read.filled }), null);
  });
});
