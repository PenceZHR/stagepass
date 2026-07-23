import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  listCodexModels,
  resetCodexModelCatalogCacheForTest,
} from "./codex-model-catalog-service.ts";

const FAKE_APP_SERVER = path.join(
  process.cwd(),
  "server",
  "services",
  "__fixtures__",
  "fake-codex-app-server.cjs",
);

describe("Codex model catalog", () => {
  let originalCodexBin: string | undefined;
  let originalFakeMode: string | undefined;

  before(() => {
    originalCodexBin = process.env.STAGEPASS_CODEX_BIN;
    originalFakeMode = process.env.FAKE_MODE;
    process.env.STAGEPASS_CODEX_BIN = FAKE_APP_SERVER;
    process.env.FAKE_MODE = "normal";
    resetCodexModelCatalogCacheForTest();
  });

  after(() => {
    resetCodexModelCatalogCacheForTest();
    if (originalCodexBin === undefined) {
      delete process.env.STAGEPASS_CODEX_BIN;
    } else {
      process.env.STAGEPASS_CODEX_BIN = originalCodexBin;
    }
    if (originalFakeMode === undefined) {
      delete process.env.FAKE_MODE;
    } else {
      process.env.FAKE_MODE = originalFakeMode;
    }
  });

  it("lists app-server models and caches the catalog within the TTL", async () => {
    const first = await listCodexModels({ ttlMs: 60_000 });

    assert.deepEqual(first, [
      {
        id: "gpt-x",
        model: "gpt-x",
        displayName: "GPT X",
        description: "Fixture model",
        isDefault: true,
        hidden: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "high", description: "Deep" },
        ],
      },
    ]);

    process.env.FAKE_MODE = "exit1";
    const cached = await listCodexModels({ ttlMs: 60_000 });
    assert.strictEqual(cached, first);
  });
});
