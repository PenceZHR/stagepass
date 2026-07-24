import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  getAiEngine,
  setCodexDesktopEngineLoaderForTest,
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

  it("returns the Codex engine through the test loader", () => {
    const calls: string[] = [];
    const codexEngine = fakeEngine("codex");
    const restore = setAiEngineLoaderForTest("codex", () => {
      calls.push("codex");
      return codexEngine;
    });

    try {
      assert.equal(getAiEngine(), codexEngine);
      assert.deepEqual(calls, ["codex"]);
    } finally {
      restore();
    }
  });

  it("uses the Desktop follower engine regardless of the retired rollout flag", () => {
    const desktop = fakeEngine("desktop");
    const restoreDesktop = setCodexDesktopEngineLoaderForTest(() => desktop);
    try {
      delete process.env.STAGEPASS_CODEX_DESKTOP_BRIDGE;
      assert.equal(getAiEngine(), desktop);
      process.env.STAGEPASS_CODEX_DESKTOP_BRIDGE = "on";
      assert.equal(getAiEngine(), desktop);
      process.env.STAGEPASS_CODEX_DESKTOP_BRIDGE = "true";
      assert.equal(getAiEngine(), desktop);
    } finally {
      restoreDesktop();
      delete process.env.STAGEPASS_CODEX_DESKTOP_BRIDGE;
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
      assert.equal(await getPipelineEngine("codex"), engine);
      assert.deepEqual(seenProviders, ["codex"]);
    } finally {
      setPipelineEngineFactoryForTest(null);
    }
  });
});
