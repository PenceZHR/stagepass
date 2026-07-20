import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  CodexCliEngine,
  setCodexCliSpawnForTest,
  setCodexCliProcessIdentityProbeForTest,
} from "./codex-cli-engine";
import type {
  AiRunInput,
  AiRunLifecycleSink,
  AiStreamEvent,
} from "./ai-engine-types";
import type { ProcessIdentity, ProcessIdentityProbe } from "./process-identity-service";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal stand-in for a spawned `codex` child process. */
class FakeCodexProcess extends EventEmitter {
  pid = process.pid;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  killSignals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignals.push(signal ?? "SIGTERM");
    if (this.exitCode !== null || this.signalCode !== null) return true;
    // A killed process stops writing: stdout hits EOF, which is what ends the
    // engine's readline loop. Modelling only the `close` event let a "hung
    // provider" fake stay hung forever even after the engine killed it.
    this.signalCode = signal ?? "SIGTERM";
    queueMicrotask(() => {
      this.stdout.end();
      this.emit("close", null, this.signalCode);
    });
    return true;
  }
}

/** Write codex JSONL events to stdout, end it, and mark the process exited. */
function feed(child: FakeCodexProcess, events: unknown[], code = 0): void {
  for (const event of events) {
    child.stdout.write(`${JSON.stringify(event)}\n`);
  }
  child.stdout.end();
  child.exitCode = code;
  child.emit("close", code, null);
}

/**
 * The real shape of a run killed mid-flight: no exit code at all, a signal
 * instead. This is what macOS DarkWake -> dev-supervisor SIGTERM produces.
 */
function feedKilled(
  child: FakeCodexProcess,
  events: unknown[],
  options: { signal?: NodeJS.Signals; stderr?: string } = {},
): void {
  const signal = options.signal ?? "SIGTERM";
  for (const event of events) {
    child.stdout.write(`${JSON.stringify(event)}\n`);
  }
  if (options.stderr) child.stderr.write(options.stderr);
  child.stdout.end();
  child.exitCode = null;
  child.signalCode = signal;
  child.emit("close", null, signal);
}

function installFakeIdentityProbe(
  child: FakeCodexProcess,
  behaviour: "ok" | "throw" = "ok",
): () => void {
  const identity: ProcessIdentity = {
    pid: child.pid,
    ppid: process.pid,
    pgid: process.pid,
    nonce: `identity-${child.pid}`,
    processStartTime: "2026-07-10T00:00:00.000Z",
    cwd: process.cwd(),
    command: ["codex"],
  };
  const probe: ProcessIdentityProbe = {
    async capture(pid) {
      if (behaviour === "throw") throw new Error("probe failed");
      assert.equal(pid, child.pid);
      return identity;
    },
    async validate() {
      return { ok: true, observed: identity };
    },
  };
  return setCodexCliProcessIdentityProbeForTest(probe);
}

interface LifecycleCall {
  type: string;
  pid: number | null;
  exitCode?: number | null;
  signal?: string | null;
}

interface LifecycleRecorder {
  sink: AiRunLifecycleSink;
  calls: LifecycleCall[];
}

function recordingLifecycle(): LifecycleRecorder {
  const calls: LifecycleCall[] = [];
  const sink: AiRunLifecycleSink = {
    onProcessStarted(event) {
      calls.push({ type: "started", pid: event.pid });
    },
    onHeartbeat(event) {
      calls.push({ type: "heartbeat", pid: event.pid });
    },
    onTerminal(event) {
      calls.push({
        type: `terminal:${event.status}`,
        pid: event.pid,
        exitCode: event.exitCode,
        signal: event.signal,
      });
    },
  };
  return { sink, calls };
}

function baseInput(over: Partial<AiRunInput> = {}): AiRunInput {
  return {
    changeId: "CHG-CODEX-CLI",
    repoPath: process.cwd(),
    phase: "review", // no agents written; individual tests override when needed
    prompt: "do the thing",
    ...over,
  };
}

describe("CodexCliEngine.run", () => {
  it("aggregates the JSONL event stream into a success result", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const promise = engine.run(baseInput());
      feed(child, [
        { type: "thread.started", thread_id: "th_abc" },
        { type: "item.completed", item: { type: "reasoning", text: "thinking" } },
        { type: "item.completed", item: { type: "agent_message", text: "all done" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
      ]);
      const result = await promise;

      assert.equal(result.success, true);
      assert.equal(result.threadId, "th_abc");
      assert.equal(result.summary, "all done");
      assert.equal(result.items.length, 2);
      assert.equal(result.items[1].type, "agent_message");
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("extracts changed files from file_change items", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const promise = engine.run(baseInput());
      feed(child, [
        {
          type: "item.completed",
          item: { type: "file_change", changes: [{ path: "a.ts" }, { path: "b.ts" }] },
        },
        { type: "item.completed", item: { type: "agent_message", text: "edited" } },
      ]);
      const result = await promise;
      assert.deepEqual(result.changedFiles, ["a.ts", "b.ts"]);
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("parses structured output from the agent message when a schema is given", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const promise = engine.run(
        baseInput({ outputSchema: { type: "object", properties: { ok: { type: "boolean" } } } }),
      );
      feed(child, [
        {
          type: "item.completed",
          item: { type: "agent_message", text: '{"ok": true}' },
        },
      ]);
      const result = await promise;
      assert.equal(result.success, true);
      assert.deepEqual(result.structuredOutput, { ok: true });
      assert.equal(result.structuredOutputSource, "text_extracted");
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("captures the real pid + identity and reports it to the lifecycle sink", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    const lifecycle = recordingLifecycle();
    try {
      const engine = new CodexCliEngine();
      const promise = engine.run(baseInput({ lifecycle: lifecycle.sink }));
      feed(child, [{ type: "item.completed", item: { type: "agent_message", text: "ok" } }]);
      await promise;

      const started = lifecycle.calls.find((c) => c.type === "started");
      assert.ok(started, "expected onProcessStarted to fire");
      assert.equal(started.pid, child.pid); // the real OS pid — the whole point of going CLI
      assert.ok(lifecycle.calls.some((c) => c.type === "terminal:completed"));
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("maps a turn.failed event to a failure result", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    const lifecycle = recordingLifecycle();
    try {
      const engine = new CodexCliEngine();
      const promise = engine.run(baseInput({ lifecycle: lifecycle.sink }));
      feed(child, [{ type: "turn.failed", error: { message: "model exploded" } }], 1);
      const result = await promise;

      assert.equal(result.success, false);
      assert.equal(result.providerErrorCode, "provider_run_failed");
      assert.match(result.summary, /model exploded/);
      assert.ok(lifecycle.calls.some((c) => c.type === "terminal:failed"));
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("kills the process when identity capture fails", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child, "throw");
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    const lifecycle = recordingLifecycle();
    try {
      const engine = new CodexCliEngine();
      const result = await engine.run(baseInput({ lifecycle: lifecycle.sink }));
      assert.equal(result.success, false);
      assert.ok(child.killSignals.includes("SIGTERM"), "expected SIGTERM on capture failure");
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("writes the reviewer agent TOML and augments the prompt on the implement phase", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-agents-"));
    const child = new FakeCodexProcess();
    let stdinData = "";
    child.stdin.on("data", (chunk) => {
      stdinData += chunk.toString();
    });
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const promise = engine.run(baseInput({ repoPath, phase: "implement" }));
      feed(child, [{ type: "item.completed", item: { type: "agent_message", text: "done" } }]);
      await promise;

      // The prompt was augmented to invoke the reviewer subagent...
      assert.match(stdinData, /reviewer/);
      // ...and the .codex/agents dir is cleaned up after the run.
      assert.equal(fs.existsSync(path.join(repoPath, ".codex", "agents")), false);
    } finally {
      restoreSpawn();
      restoreProbe();
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

/**
 * The provider-delivery gate. Everything here defends one ordering: ask whether
 * the provider delivered a reply BEFORE asking whether the reply is well-formed.
 * The gate used to read `code !== 0 && !finalResponse && items.length === 0`, so
 * a run that emitted reasoning items and was then killed satisfied none of it,
 * returned `success: true` with `summary: ""`, and the line-protocol parser was
 * handed an empty document — reporting a MARKDOWN-block format error for output
 * the model never produced.
 */
describe("CodexCliEngine.run provider-delivery gate", () => {
  it("fails a run killed after reasoning items but before any agent_message", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    const lifecycle = recordingLifecycle();
    try {
      const engine = new CodexCliEngine();
      const promise = engine.run(baseInput({ lifecycle: lifecycle.sink }));
      // Exactly RUN-230: thread started, the model reasoned, the machine slept,
      // the supervisor killed the worker, and no agent_message ever arrived.
      feedKilled(child, [
        { type: "thread.started", thread_id: "th_killed" },
        { type: "item.completed", item: { type: "reasoning", text: "thinking hard" } },
      ]);
      const result = await promise;

      assert.equal(result.success, false, "a run that delivered no reply is not a success");
      assert.equal(result.providerErrorCode, "provider_empty_response");
      assert.equal(result.summary.includes("no assistant message"), true);
      // Forensics survive to the caller instead of being computed and dropped.
      assert.equal(result.exitCode, null);
      assert.equal(result.signal, "SIGTERM");
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("reports exit code and signal on the terminal lifecycle event", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    const lifecycle = recordingLifecycle();
    try {
      const engine = new CodexCliEngine();
      const promise = engine.run(baseInput({ lifecycle: lifecycle.sink }));
      feedKilled(child, [
        { type: "item.completed", item: { type: "reasoning", text: "thinking" } },
      ]);
      await promise;

      const terminal = lifecycle.calls.find((call) => call.type === "terminal:failed");
      assert.ok(terminal, "expected a failed terminal event");
      // These reached provider_run_processes as NULL for every codex row before:
      // run() never read the exitCode/signal spawnAndCollect already computed.
      assert.equal(terminal.exitCode, null);
      assert.equal(terminal.signal, "SIGTERM");
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("carries the exit code through a successful run too", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    const lifecycle = recordingLifecycle();
    try {
      const engine = new CodexCliEngine();
      const promise = engine.run(baseInput({ lifecycle: lifecycle.sink }));
      feed(child, [{ type: "item.completed", item: { type: "agent_message", text: "done" } }]);
      const result = await promise;

      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.signal, null);
      const terminal = lifecycle.calls.find((call) => call.type === "terminal:completed");
      assert.equal(terminal?.exitCode, 0);
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("names the transport only when the provider itself names it", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const promise = engine.run(baseInput());
      // Verbatim wording from a real failed row.
      feed(
        child,
        [
          {
            type: "turn.failed",
            error: {
              message:
                "stream disconnected before completion: error sending request for url "
                + "(https://chatgpt.com/backend-api/codex/responses)",
            },
          },
        ],
        1,
      );
      const result = await promise;

      assert.equal(result.success, false);
      assert.equal(result.providerErrorCode, "provider_transport_error");
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  /**
   * The over-attribution guard, and the reason provider_empty_response exists at
   * all: "we received nothing" is not evidence of a network fault. Claiming one
   * would just move the misattribution from the model to the network.
   */
  it("does not claim a transport fault for a run that merely returned nothing", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const promise = engine.run(baseInput());
      feedKilled(child, [{ type: "item.completed", item: { type: "reasoning", text: "..." } }], {
        stderr: "some unrelated diagnostic noise",
      });
      const result = await promise;

      assert.equal(result.providerErrorCode, "provider_empty_response");
      assert.notEqual(result.providerErrorCode, "provider_transport_error");
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("still fails an empty reply that exited cleanly", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const promise = engine.run(baseInput());
      feed(child, [{ type: "item.completed", item: { type: "reasoning", text: "thought" } }], 0);
      const result = await promise;

      assert.equal(result.success, false, "exit 0 with no reply is still no reply");
      assert.equal(result.providerErrorCode, "provider_empty_response");
      assert.equal(result.exitCode, 0);
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });
});

interface StreamOutcome {
  events: string[];
  error: (Error & { providerErrorCode?: string }) | null;
}

/** Drain a stream to its end (or `stopAfter` events), capturing any failure. */
async function consumeStream(
  stream: AsyncGenerator<AiStreamEvent>,
  options: { stopAfter?: number } = {},
): Promise<StreamOutcome> {
  const events: string[] = [];
  try {
    for await (const event of stream) {
      events.push(String(event.type));
      if (options.stopAfter !== undefined && events.length >= options.stopAfter) break;
    }
    return { events, error: null };
  } catch (err) {
    return { events, error: err as Error & { providerErrorCode?: string } };
  }
}

describe("CodexCliEngine.runStreamed", () => {
  it("yields parsed events and updates the thread id", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    const lifecycle = recordingLifecycle();
    try {
      const engine = new CodexCliEngine();
      const collected: string[] = [];
      const done = (async () => {
        for await (const event of engine.runStreamed(baseInput({ lifecycle: lifecycle.sink }))) {
          collected.push(String(event.type));
        }
      })();

      await delay(5); // let the generator spawn + attach readline
      feed(child, [
        { type: "thread.started", thread_id: "th_stream" },
        { type: "item.completed", item: { type: "agent_message", text: "streamed" } },
      ]);
      await done;

      assert.ok(collected.includes("thread.started"));
      assert.ok(collected.includes("item.completed"));
      const started = lifecycle.calls.find((c) => c.type === "started");
      assert.ok(started);
      assert.equal(started.pid, child.pid);
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });
});

/**
 * The streaming counterpart of the provider-delivery gate. It cannot reuse
 * run()'s rule: `build` and `fix` deliver their result as FILE MUTATIONS, so
 * "produced no agent_message" is not failure evidence here — the first test
 * below is the guard against exactly that over-correction. What the stream can
 * honestly report is whether the run REACHED ITS END, and the workspace diff
 * (build-workspace-service collectBuildResult) stays the authority on whether
 * the work itself happened.
 */
describe("CodexCliEngine.runStreamed provider-delivery gate", () => {
  it("succeeds for a build that mutated files and never produced an agent_message", async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-build-"));
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    const lifecycle = recordingLifecycle();
    try {
      const engine = new CodexCliEngine();
      const outcome = consumeStream(
        engine.runStreamed(
          baseInput({ repoPath, phase: "implement", lifecycle: lifecycle.sink, timeoutMs: 60_000 }),
        ),
      );
      await delay(5);
      // The shape of a real quiet build: it edited files, ran commands, finished
      // its turn, and said nothing worth calling a summary.
      feed(child, [
        { type: "thread.started", thread_id: "th_build" },
        {
          type: "item.completed",
          item: { type: "file_change", changes: [{ path: "server/a.ts" }, { path: "server/b.ts" }] },
        },
        { type: "item.completed", item: { type: "command_execution", command: "pnpm test", exitCode: 0 } },
        { type: "turn.completed", usage: { input_tokens: 900, output_tokens: 4 } },
      ]);
      const result = await outcome;

      assert.equal(result.error, null, `a file-mutating build must not fail: ${result.error?.message}`);
      assert.equal(result.events.length, 4);
      assert.ok(
        lifecycle.calls.some((call) => call.type === "terminal:completed"),
        "expected a completed terminal event",
      );
      assert.equal(child.killSignals.length, 0, "a healthy build must not be killed");
    } finally {
      restoreSpawn();
      restoreProbe();
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("fails a stream whose child was killed mid-run and reports the signal", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    const lifecycle = recordingLifecycle();
    try {
      const engine = new CodexCliEngine();
      const outcome = consumeStream(engine.runStreamed(baseInput({ lifecycle: lifecycle.sink })));
      await delay(5);
      // RUN-230 on the streaming path: half the edits applied, then SIGTERM.
      // stdout simply ends, which used to read as "stream completed".
      feedKilled(child, [
        { type: "thread.started", thread_id: "th_killed" },
        { type: "item.completed", item: { type: "file_change", changes: [{ path: "half.ts" }] } },
      ]);
      const result = await outcome;

      assert.ok(result.error, "a killed stream is not a completed stream");
      assert.equal(result.error.providerErrorCode, "provider_run_failed");
      assert.match(result.error.message, /^provider_run_failed: codex was killed mid-stream/);
      assert.match(result.error.message, /signal SIGTERM/);
      // The forensics reach provider_run_processes instead of the NULLs every
      // codex implement/fix_findings row carries today.
      const terminal = lifecycle.calls.find((call) => call.type === "terminal:failed");
      assert.ok(terminal, "expected a failed terminal event");
      assert.equal(terminal.exitCode, null);
      assert.equal(terminal.signal, "SIGTERM");
      assert.ok(
        !lifecycle.calls.some((call) => call.type === "terminal:completed"),
        "a killed stream must not report completion",
      );
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("waits for the exit facts when close lands after stdout EOF", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    const lifecycle = recordingLifecycle();
    try {
      const engine = new CodexCliEngine();
      const outcome = consumeStream(engine.runStreamed(baseInput({ lifecycle: lifecycle.sink })));
      await delay(5);
      // The real ordering, and the reason a fire-and-forget exit observer is not
      // enough: stdout hits EOF first and the process is reaped a tick later, so
      // reading the exit facts at EOF time reads nulls and calls a kill a
      // completion.
      child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "th_lag" })}\n`);
      child.stdout.end();
      setTimeout(() => {
        child.signalCode = "SIGKILL";
        child.emit("close", null, "SIGKILL");
      }, 10);

      const result = await outcome;
      assert.equal(result.error?.providerErrorCode, "provider_run_failed");
      assert.match(result.error!.message, /signal SIGKILL/);
      assert.equal(lifecycle.calls.find((call) => call.type === "terminal:failed")?.signal, "SIGKILL");
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("reports a stream that delivered nothing as provider_empty_response", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const outcome = consumeStream(engine.runStreamed(baseInput()));
      await delay(5);
      feed(child, [], 0); // exited cleanly having printed nothing at all

      const result = await outcome;
      assert.ok(result.error);
      assert.equal(result.error.providerErrorCode, "provider_empty_response");
      assert.match(result.error.message, /^provider_empty_response: codex stream produced no events/);
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("names the transport only when codex's own stderr names it", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const outcome = consumeStream(engine.runStreamed(baseInput()));
      await delay(5);
      feedKilled(child, [], { stderr: "stream disconnected before completion" });

      const result = await outcome;
      assert.equal(result.error?.providerErrorCode, "provider_transport_error");
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  /** The over-attribution guard: a dead process is not evidence of a dead network. */
  it("does not claim a transport fault for a kill with unrelated stderr", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const outcome = consumeStream(engine.runStreamed(baseInput()));
      await delay(5);
      feedKilled(child, [{ type: "thread.started", thread_id: "th_x" }], {
        stderr: "some unrelated diagnostic noise",
      });

      const result = await outcome;
      assert.equal(result.error?.providerErrorCode, "provider_run_failed");
      assert.notEqual(result.error?.providerErrorCode, "provider_transport_error");
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("classifies turn.failed with the same vocabulary run() uses", async () => {
    for (const scenario of [
      {
        message: "stream disconnected before completion: error sending request for url "
          + "(https://chatgpt.com/backend-api/codex/responses)",
        expected: "provider_transport_error",
      },
      { message: "model exploded", expected: "provider_run_failed" },
    ]) {
      const child = new FakeCodexProcess();
      const restoreProbe = installFakeIdentityProbe(child);
      const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
      try {
        const engine = new CodexCliEngine();
        const outcome = consumeStream(engine.runStreamed(baseInput()));
        await delay(5);
        feed(child, [{ type: "turn.failed", error: { message: scenario.message } }], 1);

        const result = await outcome;
        assert.equal(result.error?.providerErrorCode, scenario.expected, scenario.message);
        // The code has to be in the TEXT too: a streamed stage has no
        // AiRunResult, so the run summary is the only place the action contract
        // can read the error code from.
        assert.ok(result.error?.message.startsWith(`${scenario.expected}: `), result.error?.message);
      } finally {
        restoreSpawn();
        restoreProbe();
      }
    }
  });
});

/**
 * Gap 1: runStreamed accepted `input.timeoutMs` and dropped it. `fix` therefore
 * ran with no time bound at all, and `build` was bounded only on its FIRST event
 * by consumeBuildStreamWithStartupTimeout — a provider that went quiet after
 * event one hung the stage forever.
 */
describe("CodexCliEngine.runStreamed timeout", () => {
  // Bounded on purpose: without the wall-clock kill these two never settle at
  // all, and a suite that hangs reports nothing. The budget under test is 20-30ms.
  it("kills a hung stream once the caller's budget expires", { timeout: 5_000 }, async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    const lifecycle = recordingLifecycle();
    try {
      const engine = new CodexCliEngine();
      // Nothing is ever fed: codex is alive and silent, the shape that used to
      // hang forever.
      const result = await consumeStream(
        engine.runStreamed(baseInput({ timeoutMs: 20, lifecycle: lifecycle.sink })),
      );

      assert.ok(child.killSignals.includes("SIGTERM"), "the timeout must kill the child");
      assert.equal(result.error?.providerErrorCode, "provider_timeout");
      assert.match(result.error!.message, /^provider_timeout: codex stream timed out after 20ms/);
      assert.ok(lifecycle.calls.some((call) => call.type === "terminal:failed"));
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("kills a stream that goes quiet AFTER its first event", { timeout: 5_000 }, async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const outcome = consumeStream(engine.runStreamed(baseInput({ timeoutMs: 30 })));
      await delay(5);
      // One event, then silence — past the startup timeout's reach entirely.
      child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "th_quiet" })}\n`);

      const result = await outcome;
      assert.deepEqual(result.events, ["thread.started"]);
      assert.equal(result.error?.providerErrorCode, "provider_timeout");
      assert.ok(child.killSignals.includes("SIGTERM"));
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("leaves a run that finishes inside its budget completely alone", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    const lifecycle = recordingLifecycle();
    try {
      const engine = new CodexCliEngine();
      const outcome = consumeStream(
        engine.runStreamed(baseInput({ timeoutMs: 60_000, lifecycle: lifecycle.sink })),
      );
      await delay(5);
      feed(child, [{ type: "item.completed", item: { type: "agent_message", text: "done" } }]);

      const result = await outcome;
      assert.equal(result.error, null);
      assert.equal(child.killSignals.length, 0);
      const terminal = lifecycle.calls.find((call) => call.type === "terminal:completed");
      assert.equal(terminal?.exitCode, 0);
      assert.equal(terminal?.signal, null);
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("arms no timer when the caller passes no budget", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const outcome = consumeStream(engine.runStreamed(baseInput()));
      await delay(30);
      assert.equal(child.killSignals.length, 0, "no budget means no wall-clock kill");
      feed(child, [{ type: "item.completed", item: { type: "agent_message", text: "ok" } }]);
      assert.equal((await outcome).error, null);
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });
});

/**
 * Gap 2: the streaming finally cleared the heartbeat and emitted a terminal
 * event but never called proc.kill(), so any abnormal exit left `codex exec`
 * alive holding the build worktree open. consumeBuildStreamWithStartupTimeout's
 * error path calls iterator.return(), which runs that same finally.
 */
describe("CodexCliEngine.runStreamed child cleanup", () => {
  it("kills codex when the consumer stops mid-stream", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const outcome = consumeStream(engine.runStreamed(baseInput()), { stopAfter: 1 });
      await delay(5);
      // The child is still very much alive; stdout is deliberately left open.
      child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "th_x" })}\n`);

      const result = await outcome;
      assert.equal(result.events.length, 1);
      assert.equal(result.error, null, "a consumer break is not a provider failure");
      assert.ok(
        child.killSignals.includes("SIGTERM"),
        "breaking out of the stream must not orphan codex",
      );
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("kills codex when a turn.failed arrives while the child is still running", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const outcome = consumeStream(engine.runStreamed(baseInput()));
      await delay(5);
      // codex reports the turn as failed but does not exit — stdout stays open,
      // so nothing else would ever reap it.
      child.stdout.write(
        `${JSON.stringify({ type: "turn.failed", error: { message: "model exploded" } })}\n`,
      );

      const result = await outcome;
      assert.equal(result.error?.providerErrorCode, "provider_run_failed");
      assert.ok(child.killSignals.includes("SIGTERM"), "a failed turn must not orphan codex");
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  /**
   * The startup-timeout shape, and the one case the finally cannot cover on its
   * own. consumeBuildStreamWithStartupTimeout races iterator.next() against
   * buildStreamStartTimeoutMs and, on timeout, awaits iterator.return() while
   * that next() is STILL PENDING. An async generator queues the return request
   * behind the pending next(), so the finally — and its kill — do not run yet.
   * Measured: at t=25ms neither had happened.
   *
   * With no wall-clock timeout that pending next() never settled for a silent
   * codex, so the return() never completed either: the consumer hung on line
   * :159 forever and the child was orphaned forever. The provider budget is what
   * bounds it now.
   */
  it("bounds the orphan window when the consumer bails on a pending next()", { timeout: 5_000 }, async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child);
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    try {
      const engine = new CodexCliEngine();
      const iterator = engine.runStreamed(baseInput({ timeoutMs: 60 }))[Symbol.asyncIterator]();
      const pending = iterator.next(); // codex is silent; nothing settles this
      void pending.catch(() => {});
      await delay(5);

      const returned = iterator.return!(undefined as never);
      let returnSettled = false;
      void returned.then(() => { returnSettled = true; }, () => { returnSettled = true; });

      await delay(20); // still inside the 60ms budget
      assert.equal(returnSettled, false, "return() is queued behind the pending next()");
      assert.equal(child.killSignals.length, 0, "so the finally has not run yet either");

      await delay(120); // past the budget
      assert.ok(child.killSignals.includes("SIGTERM"), "the budget must reap the child");
      assert.equal(returnSettled, true, "and unblock the consumer waiting on return()");
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });

  it("kills codex when a lifecycle failure aborts the stream before it starts", async () => {
    const child = new FakeCodexProcess();
    const restoreProbe = installFakeIdentityProbe(child, "throw");
    const restoreSpawn = setCodexCliSpawnForTest(() => child as never);
    const lifecycle = recordingLifecycle();
    try {
      const engine = new CodexCliEngine();
      const result = await consumeStream(
        engine.runStreamed(baseInput({ lifecycle: lifecycle.sink })),
      );

      assert.ok(result.error, "identity capture failure must fail the stream");
      assert.ok(
        child.killSignals.includes("SIGTERM"),
        "a stream that never started must not leave codex running",
      );
    } finally {
      restoreSpawn();
      restoreProbe();
    }
  });
});
