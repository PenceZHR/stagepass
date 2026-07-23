import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  CodexAppServerEngine,
  getCodexAppServerEngine,
} from "./codex-app-server-engine.ts";
import { getCodexCliEngine } from "./codex-cli-engine.ts";
import type {
  AiRunInput,
  AiRunLifecycleSink,
  AiStreamEvent,
} from "./ai-engine-types.ts";

const FAKE_APP_SERVER = path.join(
  process.cwd(),
  "server",
  "services",
  "__fixtures__",
  "fake-codex-app-server.cjs",
);

function baseInput(overrides: Partial<AiRunInput> = {}): AiRunInput {
  return {
    changeId: "CHG-APP-SERVER",
    repoPath: process.cwd(),
    phase: "review",
    prompt: "Return a short answer",
    sandboxMode: "read-only",
    timeoutMs: 2_000,
    ...overrides,
  };
}

describe("CodexAppServerEngine", () => {
  let originalCodexBin: string | undefined;
  let originalFakeMode: string | undefined;
  let originalExpectOutputSchema: string | undefined;
  let originalStructuredOutput: string | undefined;
  let originalIncludeFileChange: string | undefined;

  beforeEach(() => {
    originalCodexBin = process.env.STAGEPASS_CODEX_BIN;
    originalFakeMode = process.env.FAKE_MODE;
    originalExpectOutputSchema = process.env.FAKE_EXPECT_OUTPUT_SCHEMA;
    originalStructuredOutput = process.env.FAKE_STRUCTURED_OUTPUT;
    originalIncludeFileChange = process.env.FAKE_INCLUDE_FILE_CHANGE;
    process.env.STAGEPASS_CODEX_BIN = FAKE_APP_SERVER;
    process.env.FAKE_MODE = "normal";
    delete process.env.FAKE_EXPECT_OUTPUT_SCHEMA;
    delete process.env.FAKE_STRUCTURED_OUTPUT;
    delete process.env.FAKE_INCLUDE_FILE_CHANGE;
  });

  afterEach(() => {
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
    const restoreEnv = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restoreEnv("FAKE_EXPECT_OUTPUT_SCHEMA", originalExpectOutputSchema);
    restoreEnv("FAKE_STRUCTURED_OUTPUT", originalStructuredOutput);
    restoreEnv("FAKE_INCLUDE_FILE_CHANGE", originalIncludeFileChange);
  });

  it("aggregates app-server deltas into an AiRunResult and lifecycle", async () => {
    const lifecycleCalls: Array<{
      type: string;
      pid: number | null;
      status?: string;
    }> = [];
    const lifecycle: AiRunLifecycleSink = {
      onProcessStarted(event) {
        lifecycleCalls.push({ type: "started", pid: event.pid });
      },
      onHeartbeat(event) {
        lifecycleCalls.push({ type: "heartbeat", pid: event.pid });
      },
      onTerminal(event) {
        lifecycleCalls.push({
          type: "terminal",
          pid: event.pid,
          status: event.status,
        });
      },
    };

    const result = await new CodexAppServerEngine().run(
      baseInput({ lifecycle }),
    );

    assert.equal(result.success, true);
    assert.equal(result.threadId, "THREAD-1");
    assert.equal(result.summary, "Hello world");
    assert.equal(result.items.some((item) => item.type === "agent_message"), true);
    assert.ok(
      lifecycleCalls.some((call) => call.type === "started" && call.pid !== null),
    );
    assert.ok(
      lifecycleCalls.some(
        (call) => call.type === "terminal" && call.status === "completed",
      ),
    );
  });

  it("normalizes app-server notifications to the frozen stream contract", async () => {
    const events: AiStreamEvent[] = [];

    for await (const event of new CodexAppServerEngine().runStreamed(baseInput())) {
      events.push(event);
    }

    assert.equal(events[0]?.type, "thread.started");
    assert.equal(
      events.some(
        (event) =>
          event.type === "item.updated"
          && event.item?.type === "agent_message"
          && event.item.text === "Hello world",
      ),
      true,
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "item.completed"
          && event.item?.type === "agent_message",
      ),
      true,
    );
    assert.equal(events.at(-1)?.type, "turn.completed");
  });

  it("returns a classified failure when app-server exits during startup", async () => {
    process.env.FAKE_MODE = "exit1";

    const result = await new CodexAppServerEngine().run(baseInput());

    assert.equal(result.success, false);
    assert.ok(result.providerErrorCode);
    assert.equal(result.exitCode, 1);
  });

  it("classifies app-server -32001 errors as provider_overloaded", async () => {
    process.env.FAKE_MODE = "overloaded";

    const result = await new CodexAppServerEngine().run(baseInput());

    assert.equal(result.success, false);
    assert.equal(result.providerErrorCode, "provider_overloaded");
  });

  it("interrupts and reaps a timed-out app-server run", async () => {
    process.env.FAKE_MODE = "hang";

    const result = await new CodexAppServerEngine().run(
      baseInput({ timeoutMs: 30 }),
    );

    assert.equal(result.success, false);
    assert.equal(result.providerErrorCode, "provider_timeout");
  });

  it("declines app-server approval requests by default", async () => {
    process.env.FAKE_MODE = "approval";

    const result = await new CodexAppServerEngine().run(baseInput());

    assert.equal(result.success, true);
  });

  it("passes output schema inline and collects file changes", async () => {
    process.env.FAKE_EXPECT_OUTPUT_SCHEMA = "1";
    process.env.FAKE_STRUCTURED_OUTPUT = "1";
    process.env.FAKE_INCLUDE_FILE_CHANGE = "1";

    const result = await new CodexAppServerEngine().run(
      baseInput({
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      }),
    );

    assert.equal(result.success, true);
    assert.deepEqual(result.structuredOutput, { ok: true });
    assert.equal(result.structuredOutputSource, "text_extracted");
    assert.deepEqual(result.changedFiles, ["server/example.ts"]);
  });

  it("resumes a read-only thread through thread/resume", async () => {
    const result = await new CodexAppServerEngine().run(
      baseInput({ threadId: "THREAD-EXISTING" }),
    );

    assert.equal(result.success, true);
    assert.equal(result.threadId, "THREAD-EXISTING");
  });

  it("switches the compatibility factory to the app-server engine", () => {
    assert.equal(getCodexCliEngine(), getCodexAppServerEngine());
  });
});
