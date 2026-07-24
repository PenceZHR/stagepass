import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { AiRunLifecycleSink } from "./ai-engine-types.ts";
import {
  buildMultiAgentPrompt,
  cleanupAgentFiles,
  CODEX_BIN_ENV,
  codexStderrTail,
  ensureAgentFiles,
  extractChangedFiles,
  hasCodexTransportEvidence,
  resolveCodexBin,
  sanitizeCodexErrorMessage,
  startCodexHeartbeat,
} from "./codex-engine-shared.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withFastHeartbeat(
  body: () => Promise<void>,
): Promise<void> {
  const original = process.env.STAGEPASS_CODEX_HEARTBEAT_MS;
  process.env.STAGEPASS_CODEX_HEARTBEAT_MS = "5";
  try {
    await body();
  } finally {
    if (original === undefined) {
      delete process.env.STAGEPASS_CODEX_HEARTBEAT_MS;
    } else {
      process.env.STAGEPASS_CODEX_HEARTBEAT_MS = original;
    }
  }
}

describe("Codex shared engine helpers", () => {
  it("resolves the configured binary and falls back to codex", () => {
    assert.equal(
      resolveCodexBin({ [CODEX_BIN_ENV]: "  /custom/codex  " }),
      "/custom/codex",
    );
    assert.equal(resolveCodexBin({ [CODEX_BIN_ENV]: "   " }), "codex");
    assert.equal(resolveCodexBin({}), "codex");
  });

  it("writes agent config, augments the prompt, and cleans it up", () => {
    const repoPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "codex-shared-agent-"),
    );
    try {
      const agents = ensureAgentFiles(repoPath, "implement");
      assert.deepEqual(agents, ["reviewer"]);
      const configPath = path.join(
        repoPath,
        ".codex",
        "agents",
        "reviewer.toml",
      );
      assert.match(fs.readFileSync(configPath, "utf8"), /sandbox_mode = "read-only"/);
      assert.match(
        buildMultiAgentPrompt("Implement it", agents, "implement"),
        /use the "reviewer" agent/,
      );
      cleanupAgentFiles(repoPath);
      assert.equal(fs.existsSync(configPath), false);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("extracts unique changed files from normalized items", () => {
    assert.deepEqual(
      extractChangedFiles([
        {
          type: "file_change",
          changes: [
            { path: "server/a.ts" },
            { path: "server/a.ts" },
            { path: "server/b.ts" },
          ],
        },
      ]),
      ["server/a.ts", "server/b.ts"],
    );
  });

  it("redacts errors and only names transport failures with evidence", () => {
    const redacted = sanitizeCodexErrorMessage(
      "Bearer fixture-secret sk-123456789abcdef",
    );
    assert.equal(redacted.includes("fixture-secret"), false);
    assert.equal(redacted.includes("sk-123456789abcdef"), false);
    assert.equal(codexStderrTail(`noise ${redacted}`).includes("noise"), true);
    assert.equal(
      hasCodexTransportEvidence("stream disconnected before completion"),
      true,
    );
    assert.equal(hasCodexTransportEvidence("provider returned nothing"), false);
  });
});

describe("Codex shared heartbeat", () => {
  for (const mode of ["throw", "reject"] as const) {
    it(`reports a lifecycle ${mode} once and stops the timer`, async () => {
      await withFastHeartbeat(async () => {
        let heartbeatCount = 0;
        let failureCount = 0;
        let resolveFailure!: () => void;
        const failureSeen = new Promise<void>((resolve) => {
          resolveFailure = resolve;
        });
        const lifecycle: AiRunLifecycleSink = {
          onProcessStarted() {},
          onHeartbeat() {
            heartbeatCount += 1;
            const error = new Error(`heartbeat ${mode}`);
            if (mode === "throw") throw error;
            return Promise.reject(error);
          },
          onTerminal() {},
        };

        const timer = startCodexHeartbeat({
          lifecycle,
          pid: 123,
          externalRef: () => "THREAD-1",
          onLifecycleFailure(error) {
            failureCount += 1;
            assert.match(error.message, new RegExp(mode));
            resolveFailure();
          },
        });
        try {
          await failureSeen;
          await delay(20);
          assert.equal(heartbeatCount, 1);
          assert.equal(failureCount, 1);
        } finally {
          clearInterval(timer);
        }
      });
    });
  }

  it("keeps ticking while the lifecycle is healthy", async () => {
    await withFastHeartbeat(async () => {
      let heartbeatCount = 0;
      const lifecycle: AiRunLifecycleSink = {
        onProcessStarted() {},
        onHeartbeat() {
          heartbeatCount += 1;
        },
        onTerminal() {},
      };
      const timer = startCodexHeartbeat({
        lifecycle,
        pid: 123,
        externalRef: () => null,
        onLifecycleFailure(error) {
          assert.fail(error.message);
        },
      });
      try {
        await delay(25);
        assert.ok(heartbeatCount > 1);
      } finally {
        clearInterval(timer);
      }
    });
  });
});
