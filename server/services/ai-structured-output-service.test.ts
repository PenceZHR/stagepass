import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseStructuredOutputText } from "./ai-structured-output-service";

describe("ai structured output parser", () => {
  it("parses direct JSON", () => {
    assert.deepEqual(parseStructuredOutputText('{"planName":"demo"}'), {
      value: { planName: "demo" },
      source: "json",
    });
  });

  it("parses JSON code blocks", () => {
    assert.deepEqual(parseStructuredOutputText('```json\n{"ok":true}\n```'), {
      value: { ok: true },
      source: "json_block",
    });
  });

  it("parses an object embedded in text", () => {
    assert.deepEqual(parseStructuredOutputText('summary\n{"ok":true}\nthanks'), {
      value: { ok: true },
      source: "object_slice",
    });
  });

  it("returns no value when text is not parseable JSON", () => {
    assert.deepEqual(parseStructuredOutputText("plain text"), {});
  });

  it("repairs unescaped quotes inside a JSON string emitted by a provider", () => {
    const output = [
      "```json",
      '{"unit":"PRD_BLUE_INTERROGATOR","verdict":"ready","blockingQuestionIds":[],"riskSummary":"用户答"跑通为准"但仍需验证","recommendedNextAction":"lock_prd"}',
      "```",
    ].join("\n");

    assert.deepEqual(parseStructuredOutputText(output), {
      value: {
        unit: "PRD_BLUE_INTERROGATOR",
        verdict: "ready",
        blockingQuestionIds: [],
        riskSummary: '用户答"跑通为准"但仍需验证',
        recommendedNextAction: "lock_prd",
      },
      source: "json_block",
    });
  });
});
