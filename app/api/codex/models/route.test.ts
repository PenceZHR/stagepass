import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleCodexModelsGet } from "./route";

describe("Codex model catalog route", () => {
  it("exposes the server catalog", async () => {
    const response = await handleCodexModelsGet({
      listModels: async () => [{
        id: "gpt",
        model: "gpt",
        displayName: "GPT",
        description: "GPT",
        isDefault: true,
        hidden: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{
          reasoningEffort: "medium",
          description: "Medium",
        }],
      }],
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).models[0].model, "gpt");
  });
});
