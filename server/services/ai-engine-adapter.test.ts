import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  getAiEngine,
  setAiEngineLoaderForTest,
} from "./ai-engine-adapter.ts";
import type { AiEngineAdapter } from "./ai-engine-types.ts";
import { STRUCTURED_OUTPUT_SOURCES } from "./stage-ai-output-contract.ts";
import {
  getPipelineEngine,
  setPipelineEngineFactoryForTest,
} from "./pipeline-engine-service.ts";

function fakeEngine(name: string): AiEngineAdapter {
  return {
    async run() {
      return {
        threadId: `${name}-thread`,
        runId: `${name}-run`,
        summary: name,
        success: true,
        changedFiles: [],
        items: [],
      };
    },
    async *runStreamed() {},
  };
}

describe("ai-engine-adapter", () => {
  it("does not classify schema_prompt as a structured output source", () => {
    assert.equal(STRUCTURED_OUTPUT_SOURCES.includes("schema_prompt" as never), false);
  });

  it("keeps the public AI engine types independent from the Codex SDK", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "server/services/ai-engine-types.ts"),
      "utf-8",
    );

    assert.doesNotMatch(source, /@openai\/codex-sdk/);
  });

  it("exposes lifecycle callback types on AiRunInput", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "server/services/ai-engine-types.ts"),
      "utf-8",
    );

    assert.match(source, /interface AiRunLifecycleProcessStarted/);
    assert.match(source, /interface AiRunLifecycleTerminal/);
    assert.match(source, /interface AiRunLifecycleSink/);
    assert.match(source, /lifecycle\?: AiRunLifecycleSink/);
  });

  it("returns the selected provider engine without loading the other provider", () => {
    const calls: string[] = [];
    const codexEngine = fakeEngine("codex");
    const claudeEngine = fakeEngine("claude");
    const restoreCodex = setAiEngineLoaderForTest("codex", () => {
      calls.push("codex");
      return codexEngine;
    });
    const restoreClaude = setAiEngineLoaderForTest("claude", () => {
      calls.push("claude");
      return claudeEngine;
    });

    try {
      assert.equal(getAiEngine("codex"), codexEngine);
      assert.deepEqual(calls, ["codex"]);

      assert.equal(getAiEngine("claude"), claudeEngine);
      assert.deepEqual(calls, ["codex", "claude"]);
    } finally {
      restoreClaude();
      restoreCodex();
    }
  });

  it("keeps the pipeline engine test factory as the first resolution path", async () => {
    const engine = fakeEngine("pipeline-test");
    const seenProviders: string[] = [];
    setPipelineEngineFactoryForTest((provider) => {
      seenProviders.push(provider);
      return engine;
    });

    try {
      assert.equal(await getPipelineEngine("claude"), engine);
      assert.deepEqual(seenProviders, ["claude"]);
    } finally {
      setPipelineEngineFactoryForTest(null);
    }
  });
});
