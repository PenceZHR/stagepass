import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(__dirname, "prd-briefing-room.tsx"), "utf-8");

describe("PRD briefing response boundaries", () => {
  it("keeps asynchronous queue receipts out of page state", () => {
    const commandStart = source.indexOf("const requestCommandJson");
    const stateStart = source.indexOf("const requestStateJson");
    const saveIntentStart = source.indexOf("const saveIntent");
    const startAiJobStart = source.indexOf("const startAiJob");
    const questionActionStart = source.indexOf("const handleQuestionAction");

    assert.notEqual(commandStart, -1, "queue commands need a dedicated request helper");
    assert.notEqual(stateStart, -1, "state-returning commands need a dedicated request helper");
    assert.notEqual(startAiJobStart, -1);
    assert.notEqual(questionActionStart, -1);

    const commandHelper = source.slice(commandStart, stateStart);
    const saveIntent = source.slice(saveIntentStart, startAiJobStart);
    const startAiJob = source.slice(startAiJobStart, questionActionStart);

    assert.doesNotMatch(commandHelper, /normalizeState|syncState/);
    assert.match(saveIntent, /requestStateJson\(/);
    assert.match(startAiJob, /requestCommandJson\(/);
    assert.doesNotMatch(startAiJob, /requestStateJson\(/);
  });
});
