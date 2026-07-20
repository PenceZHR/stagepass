import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AiStreamEvent } from "./ai-engine-types.ts";
import {
  consumeBuildStreamWithStartupTimeout,
  formatThreadEvent,
} from "./pipeline-build-stage-service.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurnCompletedEvent(): AiStreamEvent {
  return { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
}

describe("runFixStreamed source contract", () => {
  it("keeps Fix service limited to CHECK_FAILED and SCOPE_FAILED", () => {
    const source = readFileSync(
      join(process.cwd(), "server/services/pipeline-build-stage-service.ts"),
      "utf8",
    );

    // The guard is spelled through a named constant so the action contract can
    // mirror it (fix_blockers' requiredStatus, reviewControlDecision's
    // FIX_ENTRY_STATUSES) instead of restating it. The literal pair matters
    // just as much as before -- FIXING must NOT appear here, or the stranded
    // claim would be accepted rather than repaired.
    assert.match(source, /const FIX_ALLOWED_STATUSES: ChangeStatus\[\] = \["CHECK_FAILED", "SCOPE_FAILED"\]/);
    assert.match(source, /assertStatus\(change, \.\.\.FIX_ALLOWED_STATUSES\)/);
  });

  it("repairs a stranded FIXING claim before the guard reads it", () => {
    const source = readFileSync(
      join(process.cwd(), "server/services/pipeline-build-stage-service.ts"),
      "utf8",
    );
    const scope = source.slice(
      source.indexOf("async function runFixStreamedInExecutionScope"),
      source.indexOf("if ((change.fixIterations ?? 0) >= MAX_FIX_ITERATIONS)"),
    );

    // Order is the whole point: assertStatus runs before runFencedStreamedStage
    // WithLedger can create a run, so a recovery placed after it never executes.
    assert.match(scope, /recoverStrandedRunningStatus\(\{[\s\S]*runningStatus: "FIXING"[\s\S]*\}\)[\s\S]*assertStatus\(/);
  });
});

describe("retryBuildStreamed source contract", () => {
  it("recovers stale Build state before starting a new Build", () => {
    const source = readFileSync(
      join(process.cwd(), "server/services/pipeline-build-stage-service.ts"),
      "utf8",
    );

    assert.match(source, /export async function retryBuildStreamed/);
    assert.match(source, /recoverStaleBuildRun\(changeId/);
    assert.match(source, /runImplementStreamed\(changeId, context, provider\)/);
  });
});

describe("formatThreadEvent", () => {
  it("maps completed command_execution items to codex_output", () => {
    const event = {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "npm test",
        exitCode: 0,
      },
    } satisfies AiStreamEvent;

    const formatted = formatThreadEvent(event);

    assert.deepEqual(formatted, {
      type: "codex_output",
      message: "$ npm test (exit 0)",
      raw: {
        itemType: "command",
        command: "npm test",
        exitCode: 0,
      },
    });
  });

  it("maps completed file_change items to codex_output with changed paths", () => {
    const event = {
      type: "item.completed",
      item: {
        type: "file_change",
        changes: [
          { path: "server/services/pipeline-build-stage-service.ts" },
          { path: "app/projects/[id]/changes/[changeId]/page.tsx" },
        ],
      },
    } satisfies AiStreamEvent;

    const formatted = formatThreadEvent(event);

    assert.deepEqual(formatted, {
      type: "codex_output",
      message: "Changed: server/services/pipeline-build-stage-service.ts, app/projects/[id]/changes/[changeId]/page.tsx",
      raw: {
        itemType: "file_change",
        paths: [
          "server/services/pipeline-build-stage-service.ts",
          "app/projects/[id]/changes/[changeId]/page.tsx",
        ],
      },
    });
  });

  it("maps reasoning item updates to ai_reasoning", () => {
    const event = {
      type: "item.updated",
      item: {
        type: "reasoning",
        text: "Inspecting the build stream event contract.",
      },
    } satisfies AiStreamEvent;

    const formatted = formatThreadEvent(event);

    assert.deepEqual(formatted, {
      type: "ai_reasoning",
      message: "Inspecting the build stream event contract.",
      raw: {
        itemType: "reasoning",
        text: "Inspecting the build stream event contract.",
      },
    });
  });

  it("maps assistant message item updates to ai_message", () => {
    const event = {
      type: "item.started",
      item: {
        type: "agent_message",
        text: "I will apply the build changes now.",
      },
    } satisfies AiStreamEvent;

    const formatted = formatThreadEvent(event);

    assert.deepEqual(formatted, {
      type: "ai_message",
      message: "I will apply the build changes now.",
      raw: {
        itemType: "message",
        text: "I will apply the build changes now.",
      },
    });
  });
});

describe("consumeBuildStreamWithStartupTimeout", () => {
  it("awaits iterator.return before rejecting an onEvent failure", async () => {
    const returnGate = deferred<IteratorResult<AiStreamEvent>>();
    let returned = 0;
    const stream: AsyncIterable<AiStreamEvent> = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          async next() {
            if (!emitted) {
              emitted = true;
              return { done: false as const, value: nextTurnCompletedEvent() };
            }
            return new Promise<IteratorResult<AiStreamEvent>>(() => {});
          },
          return() {
            returned += 1;
            return returnGate.promise;
          },
        };
      },
    };
    const primaryError = new Error("Build event persistence failed");
    const consumePromise = consumeBuildStreamWithStartupTimeout(stream, async () => {
      throw primaryError;
    });
    let settled = false;
    void consumePromise.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(returned, 1);
    assert.equal(settled, false);

    returnGate.resolve({ done: true, value: undefined });
    await assert.rejects(consumePromise, (error) => error === primaryError);
  });

  it("awaits iterator.return before rejecting a startup timeout", async () => {
    const previousTimeout = process.env.STAGEPASS_BUILD_STREAM_START_TIMEOUT_MS;
    process.env.STAGEPASS_BUILD_STREAM_START_TIMEOUT_MS = "5";
    const returnGate = deferred<IteratorResult<AiStreamEvent>>();
    let returned = 0;
    const stream: AsyncIterable<AiStreamEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise<IteratorResult<AiStreamEvent>>(() => {});
          },
          return() {
            returned += 1;
            return returnGate.promise;
          },
        };
      },
    };
    try {
      const consumePromise = consumeBuildStreamWithStartupTimeout(stream, async () => {});
      let settled = false;
      void consumePromise.then(
        () => { settled = true; },
        () => { settled = true; },
      );

      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(returned, 1);
      assert.equal(settled, false);

      returnGate.resolve({ done: true, value: undefined });
      await assert.rejects(consumePromise, /Build stream start timed out after 5ms/);
    } finally {
      returnGate.resolve({ done: true, value: undefined });
      if (previousTimeout === undefined) {
        delete process.env.STAGEPASS_BUILD_STREAM_START_TIMEOUT_MS;
      } else {
        process.env.STAGEPASS_BUILD_STREAM_START_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("preserves the primary error and handles iterator.return rejection", async () => {
    const primaryError = new Error("Build event handler failed");
    const returnError = new Error("Build provider cancellation failed");
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    const stream: AsyncIterable<AiStreamEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false as const, value: nextTurnCompletedEvent() };
          },
          async return() {
            throw returnError;
          },
        };
      },
    };
    try {
      await assert.rejects(
        consumeBuildStreamWithStartupTimeout(stream, async () => {
          throw primaryError;
        }),
        (error) => error === primaryError,
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
