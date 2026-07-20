import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

import { db } from "../db/index.ts";
import { projects } from "../db/schema.ts";
import { setAiEngineLoaderForTest } from "./ai-engine-adapter.ts";
import type { AiEngineAdapter, AiRunInput, AiRunResult } from "./ai-engine-types.ts";
import { initializeProjectContext } from "./context-init-service.ts";

function runResult(overrides: Partial<AiRunResult> = {}): AiRunResult {
  return {
    threadId: "context-thread",
    runId: "context-run",
    summary: "",
    success: true,
    changedFiles: [],
    items: [],
    ...overrides,
  };
}

describe("context initialization provider reliability", () => {
  let repoPath: string;
  let projectId: string;
  let restoreEngine: (() => void) | null = null;
  let previousTimeout: string | undefined;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "context-init-test-"));
    fs.mkdirSync(path.join(repoPath, ".ship"), { recursive: true });
    fs.mkdirSync(path.join(repoPath, "server", "services"), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, "server", "services", "sample.ts"),
      "export function sample(): string { return 'sample'; }\n",
      "utf-8",
    );
    projectId = `CTX-TST-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const now = new Date().toISOString();
    db.insert(projects).values({
      id: projectId,
      name: projectId,
      repoPath,
      contextStatus: "pending",
      contextProvider: "codex",
      prdStatus: "none",
      prdProvider: "codex",
      prdJson: null,
      prdMarkdown: null,
      gitEnabled: 0,
      gitDefaultBranch: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    previousTimeout = process.env.STAGEPASS_CONTEXT_TIMEOUT_MS;
  });

  afterEach(() => {
    restoreEngine?.();
    restoreEngine = null;
    if (previousTimeout === undefined) {
      delete process.env.STAGEPASS_CONTEXT_TIMEOUT_MS;
    } else {
      process.env.STAGEPASS_CONTEXT_TIMEOUT_MS = previousTimeout;
    }
    db.delete(projects).where(eq(projects.id, projectId)).run();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("passes the configured timeout to both provider stages and keeps successful generation working", async () => {
    process.env.STAGEPASS_CONTEXT_TIMEOUT_MS = "123456";
    const inputs: AiRunInput[] = [];
    const engine: AiEngineAdapter = {
      async run(input) {
        inputs.push(input);
        return inputs.length === 1
          ? runResult({ summary: '["server/services/sample.ts"]' })
          : runResult({
            summary: [
              "<architecture>new architecture</architecture>",
              "<coding-rules>new coding rules</coding-rules>",
              "<tech-stack>new tech stack</tech-stack>",
              "<file-guide>new file guide</file-guide>",
            ].join("\n"),
          });
      },
      async *runStreamed() {},
    };
    restoreEngine = setAiEngineLoaderForTest("codex", () => engine);

    await initializeProjectContext(projectId, "codex");

    assert.deepEqual(inputs.map((input) => input.timeoutMs), [123456, 123456]);
    assert.equal(
      db.select().from(projects).where(eq(projects.id, projectId)).get()!.contextStatus,
      "ready",
    );
    assert.equal(fs.readFileSync(path.join(repoPath, ".ship", "architecture.md"), "utf-8"), "new architecture");
  });

  it("uses the shared thirty minute default timeout for both provider stages", async () => {
    delete process.env.STAGEPASS_CONTEXT_TIMEOUT_MS;
    const observedTimeouts: Array<number | undefined> = [];
    const engine: AiEngineAdapter = {
      async run(input) {
        observedTimeouts.push(input.timeoutMs);
        return observedTimeouts.length === 1
          ? runResult({ summary: '["server/services/sample.ts"]' })
          : runResult({ summary: "<architecture>default timeout docs</architecture>" });
      },
      async *runStreamed() {},
    };
    restoreEngine = setAiEngineLoaderForTest("codex", () => engine);

    await initializeProjectContext(projectId, "codex");

    assert.deepEqual(observedTimeouts, [1_800_000, 1_800_000]);
  });

  for (const [label, configuredValue] of [
    ["numeric suffix", "123abc"],
    ["decimal", "1.5"],
    ["zero", "0"],
    ["negative", "-1"],
    ["Node timer overflow", "2147483648"],
    ["unsafe integer", "9007199254740992"],
  ] as const) {
    it(`falls back to thirty minutes when the configured timeout is ${label}`, async () => {
      process.env.STAGEPASS_CONTEXT_TIMEOUT_MS = configuredValue;
      const observedTimeouts: Array<number | undefined> = [];
      const engine: AiEngineAdapter = {
        async run(input) {
          observedTimeouts.push(input.timeoutMs);
          return observedTimeouts.length === 1
            ? runResult({ summary: '["server/services/sample.ts"]' })
            : runResult({ summary: "<architecture>fallback timeout docs</architecture>" });
        },
        async *runStreamed() {},
      };
      restoreEngine = setAiEngineLoaderForTest("codex", () => engine);

      await initializeProjectContext(projectId, "codex");

      assert.deepEqual(observedTimeouts, [1_800_000, 1_800_000]);
    });
  }

  it("marks context failed when file selection returns a provider failure and preserves existing docs", async () => {
    const architecturePath = path.join(repoPath, ".ship", "architecture.md");
    fs.writeFileSync(architecturePath, "existing architecture", "utf-8");
    let runCount = 0;
    const engine: AiEngineAdapter = {
      async run() {
        runCount += 1;
        return runResult({
          success: false,
          summary: "provider_timeout: selection timed out",
          providerErrorCode: "provider_timeout",
        });
      },
      async *runStreamed() {},
    };
    restoreEngine = setAiEngineLoaderForTest("codex", () => engine);

    await initializeProjectContext(projectId, "codex");

    assert.equal(runCount, 1);
    assert.equal(
      db.select().from(projects).where(eq(projects.id, projectId)).get()!.contextStatus,
      "failed",
    );
    assert.equal(fs.readFileSync(architecturePath, "utf-8"), "existing architecture");
    const progress = JSON.parse(
      fs.readFileSync(path.join(repoPath, ".ship", "context-progress.json"), "utf-8"),
    );
    assert.equal(progress.percent, 0);
    assert.match(progress.message, /provider_timeout: selection timed out/);
  });

  it("marks context failed when documentation generation returns a provider failure and preserves existing docs", async () => {
    const architecturePath = path.join(repoPath, ".ship", "architecture.md");
    fs.writeFileSync(architecturePath, "existing architecture", "utf-8");
    let runCount = 0;
    const engine: AiEngineAdapter = {
      async run() {
        runCount += 1;
        return runCount === 1
          ? runResult({ summary: '["server/services/sample.ts"]' })
          : runResult({
            success: false,
            summary: "provider_timeout: generation summary",
            providerErrorCode: "provider_timeout",
            providerErrorDetail: "provider_timeout: generation detail",
          });
      },
      async *runStreamed() {},
    };
    restoreEngine = setAiEngineLoaderForTest("codex", () => engine);

    await initializeProjectContext(projectId, "codex");

    assert.equal(runCount, 2);
    assert.equal(
      db.select().from(projects).where(eq(projects.id, projectId)).get()!.contextStatus,
      "failed",
    );
    assert.equal(fs.readFileSync(architecturePath, "utf-8"), "existing architecture");
    const progress = JSON.parse(
      fs.readFileSync(path.join(repoPath, ".ship", "context-progress.json"), "utf-8"),
    );
    assert.equal(progress.percent, 0);
    assert.match(progress.message, /provider_timeout: generation detail/);
    assert.doesNotMatch(progress.message, /generation summary/);
  });
});
