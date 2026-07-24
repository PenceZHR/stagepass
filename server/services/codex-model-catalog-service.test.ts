import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  listCodexModels,
  resetCodexModelCatalogCacheForTest,
  setCodexShellModelListerForTest,
} from "./codex-model-catalog-service.ts";

describe("Codex model catalog", () => {
  afterEach(() => {
    resetCodexModelCatalogCacheForTest();
  });

  it("lists shell-control models and caches the catalog within the TTL", async () => {
    let calls = 0;
    const restore = setCodexShellModelListerForTest(async () => {
      calls += 1;
      return [{
        id: "gpt-x",
        model: "gpt-x",
        displayName: "GPT X",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "high"],
      }];
    });
    const first = await listCodexModels({ ttlMs: 60_000 });

    assert.deepEqual(first, [
      {
        id: "gpt-x",
        model: "gpt-x",
        displayName: "GPT X",
        description: "GPT X",
        isDefault: true,
        hidden: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "low" },
          { reasoningEffort: "high", description: "high" },
        ],
      },
    ]);

    const cached = await listCodexModels({ ttlMs: 60_000 });
    assert.strictEqual(cached, first);
    assert.equal(calls, 1);
    restore();
  });

  it("uses shell-control model/list without a rollback flag branch", async () => {
    const restore = setCodexShellModelListerForTest(async () => [{
      id: "desktop-model",
      model: "desktop-model",
      displayName: "Desktop Model",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: ["medium", "high"],
    }]);
    try {
      assert.deepEqual(await listCodexModels({ ttlMs: 0 }), [{
        id: "desktop-model",
        model: "desktop-model",
        displayName: "Desktop Model",
        description: "Desktop Model",
        isDefault: true,
        hidden: false,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "medium" },
          { reasoningEffort: "high", description: "high" },
        ],
      }]);
    } finally {
      restore();
    }
  });
});
