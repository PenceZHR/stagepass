import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  ClaudeSdkEngine,
  setClaudeProcessIdentityProbeForTest,
  setClaudeSpawnForTest,
  setClaudeStreamHeartbeatIntervalForTest,
} from "./claude-engine.ts";
import type { ProcessIdentity, ProcessIdentityProbe } from "./process-identity-service.ts";

const TEST_STREAM_HEARTBEAT_INTERVAL_MS = 5;
const HEARTBEAT_STOP_SETTLE_MS = TEST_STREAM_HEARTBEAT_INTERVAL_MS * 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function assertPending(promise: Promise<unknown>): Promise<void> {
  const settled = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);
  assert.equal(settled, false);
}

async function assertHeartbeatsStopped(
  heartbeatCount: () => number,
): Promise<void> {
  const countAfterExit = heartbeatCount();
  await delay(HEARTBEAT_STOP_SETTLE_MS);
  assert.equal(heartbeatCount(), countAfterExit);
}

const outputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
  },
  required: ["ok"],
};

class FakeClaudeProcess extends EventEmitter {
  pid = process.pid;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  killSignal: NodeJS.Signals | undefined;
  killSignals: NodeJS.Signals[] = [];

  constructor(private readonly ignoreSigterm = false) {
    super();
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignal = signal;
    this.killSignals.push(signal ?? "SIGTERM");
    if (this.ignoreSigterm && signal !== "SIGKILL") return true;
    queueMicrotask(() => this.emit("close", null, signal ?? "SIGTERM"));
    return true;
  }
}

function installFakeIdentityProbe(child: FakeClaudeProcess) {
  let captureCount = 0;
  const identity: ProcessIdentity = {
    pid: child.pid,
    ppid: process.pid,
    pgid: process.pid,
    nonce: `identity-${child.pid}`,
    processStartTime: "2026-07-10T00:00:00.000Z",
    cwd: process.cwd(),
    command: ["claude"],
  };
  const probe: ProcessIdentityProbe = {
    async capture(pid, expected) {
      captureCount += 1;
      assert.equal(pid, child.pid);
      assert.equal(expected?.ppid, process.pid);
      assert.equal(expected?.cwd, process.cwd());
      return identity;
    },
    async validate() {
      return { ok: true, observed: identity };
    },
  };
  const restore = setClaudeProcessIdentityProbeForTest(probe);
  return {
    identity,
    restore,
    captureCount: () => captureCount,
  };
}

describe("claude-engine", () => {
  it("heartbeats a silent non-streamed Claude process until it closes", async () => {
    const child = new FakeClaudeProcess();
    const identityProbe = installFakeIdentityProbe(child);
    const heartbeatEvents: Array<{
      pid: number | null | undefined;
      externalRef: string | null | undefined;
      observedAt: string;
    }> = [];
    const lifecycleEvents: string[] = [];
    const restoreHeartbeatInterval = setClaudeStreamHeartbeatIntervalForTest(
      TEST_STREAM_HEARTBEAT_INTERVAL_MS,
    );
    const restoreSpawn = setClaudeSpawnForTest(() => child as never);

    try {
      const engine = new ClaudeSdkEngine();
      const completion = engine.run({
        changeId: "CHG-CLAUDE-SILENT-RUN-HEARTBEAT",
        repoPath: process.cwd(),
        phase: "spec",
        prompt: "remain silent briefly",
        threadId: "claude-silent-run-thread",
        sandboxMode: "read-only",
        lifecycle: {
          async onProcessStarted() {
            lifecycleEvents.push("started");
          },
          async onHeartbeat(event) {
            lifecycleEvents.push("heartbeat");
            heartbeatEvents.push({
              pid: event.pid,
              externalRef: event.externalRef,
              observedAt: event.observedAt,
            });
          },
          async onTerminal(event) {
            lifecycleEvents.push(`terminal:${event.status}`);
          },
        },
      });

      await delay(30);

      assert.equal(lifecycleEvents[0], "started");
      assert.ok(heartbeatEvents.length >= 2, "silent run should receive periodic heartbeats");
      assert.ok(heartbeatEvents.every((event) => event.pid === child.pid));
      assert.ok(heartbeatEvents.every((event) => event.externalRef === "claude-silent-run-thread"));
      assert.ok(heartbeatEvents.every((event) => !Number.isNaN(Date.parse(event.observedAt))));

      child.stdout.write(`${JSON.stringify({
        type: "result",
        session_id: "claude-silent-run-thread",
        result: "completed",
      })}\n`);
      child.emit("close", 0, null);

      const result = await completion;
      assert.equal(result.success, true);
      assert.equal(lifecycleEvents.at(-1), "terminal:completed");
      await assertHeartbeatsStopped(() => heartbeatEvents.length);
    } finally {
      restoreSpawn();
      restoreHeartbeatInterval();
      identityProbe.restore();
    }
  });

  it("heartbeats a silent streamed Claude process after lifecycle start persists and stops after close", async () => {
    const child = new FakeClaudeProcess();
    const identityProbe = installFakeIdentityProbe(child);
    const heartbeatEvents: Array<{
      pid: number | null | undefined;
      externalRef: string | null | undefined;
      observedAt: string;
    }> = [];
    const lifecycleEvents: string[] = [];
    const restoreHeartbeatInterval = setClaudeStreamHeartbeatIntervalForTest(
      TEST_STREAM_HEARTBEAT_INTERVAL_MS,
    );
    const restoreSpawn = setClaudeSpawnForTest(() => child as never);
    let stream: AsyncGenerator<unknown> | undefined;

    try {
      const engine = new ClaudeSdkEngine();
      stream = engine.runStreamed({
        changeId: "CHG-CLAUDE-SILENT-HEARTBEAT",
        repoPath: process.cwd(),
        phase: "implement",
        prompt: "remain silent briefly",
        threadId: "claude-silent-thread",
        sandboxMode: "workspace-write",
        lifecycle: {
          async onProcessStarted() {
            lifecycleEvents.push("started");
          },
          async onHeartbeat(event) {
            lifecycleEvents.push("heartbeat");
            heartbeatEvents.push({
              pid: event.pid,
              externalRef: event.externalRef,
              observedAt: event.observedAt,
            });
          },
          async onTerminal(event) {
            lifecycleEvents.push(`terminal:${event.status}`);
          },
        },
      });
      const completion = stream.next();

      await delay(30);

      assert.equal(lifecycleEvents[0], "started");
      assert.ok(heartbeatEvents.length >= 2, "silent stream should receive periodic heartbeats");
      assert.ok(heartbeatEvents.every((event) => event.pid === child.pid));
      assert.ok(heartbeatEvents.every((event) => event.externalRef === "claude-silent-thread"));
      assert.ok(heartbeatEvents.every((event) => !Number.isNaN(Date.parse(event.observedAt))));

      child.emit("close", 0, null);
      assert.deepEqual(await completion, { done: true, value: undefined });
      assert.equal(lifecycleEvents.at(-1), "terminal:completed");

      await assertHeartbeatsStopped(() => heartbeatEvents.length);
    } finally {
      await stream?.return(undefined).catch(() => undefined);
      restoreSpawn();
      restoreHeartbeatInterval();
      identityProbe.restore();
    }
  });

  it("kills the Claude child process and returns a provider_timeout failure when timeoutMs elapses", async () => {
    const child = new FakeClaudeProcess();
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const result = await engine.run({
        changeId: "CHG-CLAUDE-TIMEOUT",
        repoPath: process.cwd(),
        phase: "plan",
        prompt: "timeout please",
        timeoutMs: 10,
        sandboxMode: "read-only",
      });

      assert.equal(child.killed, true);
      assert.equal(child.killSignal, "SIGTERM");
      assert.equal(result.success, false);
      assert.match(result.summary, /provider_timeout/);
      assert.match(result.summary, /timed out after 10ms/);
      assert.equal(result.providerErrorCode, "provider_timeout");
      assert.equal(result.schemaDelivery, "none");
      assert.equal(result.schemaCapabilityInvoked, false);
      assert.equal(result.structuredOutputSource, "none");
    } finally {
      restore();
    }
  });

  it("preserves a streamed Claude session id when the run times out after progress", async () => {
    const child = new FakeClaudeProcess();
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const completion = engine.run({
        changeId: "CHG-CLAUDE-TIMEOUT-AFTER-PROGRESS",
        repoPath: process.cwd(),
        phase: "plan",
        prompt: "start work, then hang",
        timeoutMs: 10,
        sandboxMode: "read-only",
      });

      child.stdout.write(`${JSON.stringify({
        type: "system",
        subtype: "progress",
        session_id: "sess-progress",
      })}\n`);

      const result = await completion;

      assert.equal(result.success, false);
      assert.equal(result.providerErrorCode, "provider_timeout");
      assert.equal(result.threadId, "sess-progress");
    } finally {
      restore();
    }
  });

  it("preserves a final unterminated Claude session line when timeout closes the process", async () => {
    const child = new FakeClaudeProcess();
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const completion = engine.run({
        changeId: "CHG-CLAUDE-TIMEOUT-FINAL-BUFFER",
        repoPath: process.cwd(),
        phase: "plan",
        prompt: "write a final partial line, then hang",
        timeoutMs: 10,
        sandboxMode: "read-only",
      });

      child.stdout.write(JSON.stringify({
        type: "system",
        subtype: "progress",
        session_id: "sess-final-buffer",
      }));

      const result = await completion;

      assert.equal(result.success, false);
      assert.equal(result.providerErrorCode, "provider_timeout");
      assert.equal(result.threadId, "sess-final-buffer");
    } finally {
      restore();
    }
  });

  it("escalates to SIGKILL when the Claude child process ignores SIGTERM", async () => {
    const child = new FakeClaudeProcess(true);
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const result = await engine.run({
        changeId: "CHG-CLAUDE-FORCE-KILL",
        repoPath: process.cwd(),
        phase: "plan",
        prompt: "ignore sigterm please",
        timeoutMs: 10,
        sandboxMode: "read-only",
      });

      assert.equal(result.success, false);
      assert.match(result.summary, /provider_timeout/);
      assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
    } finally {
      restore();
    }
  });

  it("sets schemaDelivery schema_prompt via append system prompt", async () => {
    const child = new FakeClaudeProcess();
    let args: string[] = [];
    const restore = setClaudeSpawnForTest(((_bin: string, spawnArgs: string[]) => {
      args = spawnArgs;
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            type: "result",
            session_id: "claude-session-1",
            result: '{"ok":true}',
          }) + "\n",
        );
        child.emit("close", 0);
      });
      return child;
    }) as never);
    try {
      const engine = new ClaudeSdkEngine();
      const result = await engine.run({
        changeId: "CHG-CLAUDE-SCHEMA",
        repoPath: process.cwd(),
        phase: "plan",
        prompt: "return schema",
        outputSchema,
        sandboxMode: "read-only",
      });

      const appendPromptIndex = args.indexOf("--append-system-prompt");
      assert.notEqual(appendPromptIndex, -1);
      assert.match(args[appendPromptIndex + 1] ?? "", /valid JSON matching this schema/);
      assert.match(args[appendPromptIndex + 1] ?? "", /"ok"/);
      assert.equal(result.schemaDelivery, "schema_prompt");
      assert.equal(result.schemaCapabilityInvoked, true);
      assert.equal(result.structuredOutputSource, "text_extracted");
      assert.deepEqual(result.structuredOutput, { ok: true });
    } finally {
      restore();
    }
  });

  it("classifies assistant API error messages as provider failures", async () => {
    const child = new FakeClaudeProcess();
    const restore = setClaudeSpawnForTest((() => {
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            type: "assistant",
            session_id: "claude-api-error-session",
            isApiErrorMessage: true,
            apiErrorStatus: 529,
            error: "server_error",
            message: {
              content: [
                {
                  type: "text",
                  text: "API Error: 529 [1305][该模型当前访问量过大，请您稍后再试][req-123]",
                },
              ],
            },
          }) + "\n",
        );
        child.emit("close", 0);
      });
      return child;
    }) as never);
    try {
      const engine = new ClaudeSdkEngine();
      const result = await engine.run({
        changeId: "CHG-CLAUDE-API-ERROR",
        repoPath: process.cwd(),
        phase: "plan",
        prompt: "hit provider limit",
        outputSchema,
        sandboxMode: "read-only",
      });

      assert.equal(result.success, false);
      // 529 is the service refusing to answer, not the model answering badly.
      // The status used to be checked for existence and then discarded, so this
      // and a malformed-request rejection both surfaced as provider_run_failed
      // and neither told the user whether retrying would help.
      assert.equal(result.providerErrorCode, "provider_transport_error");
      assert.equal(result.structuredOutputSource, "none");
      assert.match(result.summary, /API Error: 529/);
      assert.match(result.summary, /访问量过大/);
      assert.match(result.providerErrorDetail ?? "", /HTTP 529/);
    } finally {
      restore();
    }
  });

  /**
   * The over-attribution guard. A 402 is the account's problem, not the
   * network's; reporting it as a transport fault would send the user to check
   * their connection when the fix is their billing. Only statuses that mean
   * "the service did not answer" count as transport evidence.
   */
  it("does not call an account-level API error a transport fault", async () => {
    const child = new FakeClaudeProcess();
    const restore = setClaudeSpawnForTest((() => {
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            type: "assistant",
            session_id: "claude-api-billing-session",
            isApiErrorMessage: true,
            apiErrorStatus: 402,
            message: {
              content: [{ type: "text", text: "API Error: 402 Insufficient Balance" }],
            },
          }) + "\n",
        );
        child.emit("close", 0);
      });
      return child;
    }) as never);
    try {
      const engine = new ClaudeSdkEngine();
      const result = await engine.run({
        changeId: "CHG-CLAUDE-API-BILLING",
        repoPath: process.cwd(),
        phase: "plan",
        prompt: "run out of credit",
        outputSchema,
        sandboxMode: "read-only",
      });

      assert.equal(result.success, false);
      assert.equal(result.providerErrorCode, "provider_run_failed");
      assert.notEqual(result.providerErrorCode, "provider_transport_error");
    } finally {
      restore();
    }
  });

  it("reads the status out of the prose when the CLI omits the field", async () => {
    const child = new FakeClaudeProcess();
    const restore = setClaudeSpawnForTest((() => {
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            type: "assistant",
            session_id: "claude-api-prose-session",
            isApiErrorMessage: true,
            message: {
              content: [
                // Real wording: the number is the only stable part, the prose
                // around it is localized.
                { type: "text", text: "API Error: Request rejected (429) 请稍后再试" },
              ],
            },
          }) + "\n",
        );
        child.emit("close", 0);
      });
      return child;
    }) as never);
    try {
      const engine = new ClaudeSdkEngine();
      const result = await engine.run({
        changeId: "CHG-CLAUDE-API-PROSE",
        repoPath: process.cwd(),
        phase: "plan",
        prompt: "hit the rate limit",
        outputSchema,
        sandboxMode: "read-only",
      });

      assert.equal(result.providerErrorCode, "provider_transport_error");
    } finally {
      restore();
    }
  });

  it("rejects a streamed run when Claude emits an API error and exits non-zero", async () => {
    const child = new FakeClaudeProcess();
    const identityProbe = installFakeIdentityProbe(child);
    const terminals: string[] = [];
    const restore = setClaudeSpawnForTest((() => {
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            type: "assistant",
            session_id: "claude-stream-api-error-session",
            isApiErrorMessage: true,
            apiErrorStatus: 529,
            error: "server_error",
            message: {
              content: [{
                type: "text",
                text: "API Error: 529 [1305][该模型当前访问量过大，请您稍后再试][req-stream-529]",
              }],
            },
          }) + "\n",
        );
        child.emit("close", 1);
      });
      return child;
    }) as never);
    try {
      const engine = new ClaudeSdkEngine();
      const stream = engine.runStreamed({
        changeId: "CHG-CLAUDE-STREAM-API-ERROR",
        repoPath: process.cwd(),
        phase: "fix",
        prompt: "fix blocker",
        sandboxMode: "workspace-write",
        lifecycle: {
          async onProcessStarted() {},
          async onHeartbeat() {},
          async onTerminal(event) {
            terminals.push(`${event.status}:${event.exitCode}:${event.summary}`);
          },
        },
      });

      await assert.rejects(async () => {
        while (!(await stream.next()).done) {
          // Drain all provider events; terminal failure must reject the stream.
        }
      }, /API Error: 529.*访问量过大/);
      assert.equal(terminals.length, 1);
      assert.match(terminals[0] ?? "", /^failed:1:.*API Error: 529/);
    } finally {
      restore();
      identityProbe.restore();
    }
  });

  it("extracts structured output from stdout result", async () => {
    const child = new FakeClaudeProcess();
    const restore = setClaudeSpawnForTest((() => {
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            type: "result",
            session_id: "claude-session-2",
            result: "Done\n```json\n{\"ok\":true}\n```",
          }) + "\n",
        );
        child.emit("close", 0);
      });
      return child;
    }) as never);
    try {
      const engine = new ClaudeSdkEngine();
      const result = await engine.run({
        changeId: "CHG-CLAUDE-EXTRACT",
        repoPath: process.cwd(),
        phase: "plan",
        prompt: "return fenced json",
        outputSchema,
        sandboxMode: "read-only",
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.structuredOutput, { ok: true });
      assert.equal(result.structuredOutputSource, "text_extracted");
      assert.equal(result.schemaDelivery, "schema_prompt");
      assert.equal(result.schemaCapabilityInvoked, true);
    } finally {
      restore();
    }
  });

  it("calls lifecycle callbacks around successful Claude SDK runs", async () => {
    const child = new FakeClaudeProcess();
    const identityProbe = installFakeIdentityProbe(child);
    const events: string[] = [];
    const restore = setClaudeSpawnForTest((() => {
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            type: "result",
            session_id: "claude-lifecycle-session",
            result: "Lifecycle complete",
          }) + "\n",
        );
        child.emit("close", 0);
      });
      return child;
    }) as never);
    try {
      const engine = new ClaudeSdkEngine();
      const result = await engine.run({
        changeId: "CHG-CLAUDE-LIFECYCLE",
        repoPath: process.cwd(),
        phase: "plan",
        prompt: "lifecycle",
        sandboxMode: "read-only",
        lifecycle: {
          async onProcessStarted(event) {
            assert.equal(event.identity?.pid, child.pid);
            assert.equal(event.identity?.ppid, process.pid);
            assert.equal(event.identity?.cwd, process.cwd());
            assert.ok(event.identity?.nonce);
            events.push(`started:${event.provider}:${event.pid}:${event.ppid}`);
          },
          async onHeartbeat(event) {
            events.push(`heartbeat:${event.provider}:${event.pid}`);
          },
          async onTerminal(event) {
            events.push(`terminal:${event.status}:${event.provider}:${event.pid}`);
          },
        },
      });

      assert.equal(result.success, true);
      assert.deepEqual(events, [
        `started:claude:${child.pid}:${process.pid}`,
        `heartbeat:claude:${child.pid}`,
        `terminal:completed:claude:${child.pid}`,
      ]);
      assert.equal(identityProbe.captureCount(), 1);
    } finally {
      restore();
      identityProbe.restore();
    }
  });

  it("fails closed when the spawned Claude process identity cannot be captured", async () => {
    const child = new FakeClaudeProcess();
    child.pid = 2_147_483_647;
    const lifecycleEvents: string[] = [];
    const restore = setClaudeSpawnForTest((() => {
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            type: "result",
            session_id: "identity-capture-must-fail",
            result: "must not be accepted",
          }) + "\n",
        );
        child.emit("close", 0);
      });
      return child;
    }) as never);
    try {
      const engine = new ClaudeSdkEngine();
      const result = await engine.run({
        changeId: "CHG-CLAUDE-IDENTITY-FAIL",
        repoPath: process.cwd(),
        phase: "plan",
        prompt: "identity failure",
        sandboxMode: "read-only",
        lifecycle: {
          async onProcessStarted() {
            lifecycleEvents.push("started");
          },
          async onHeartbeat() {},
          async onTerminal(event) {
            lifecycleEvents.push(`terminal:${event.status}`);
          },
        },
      });

      assert.equal(result.success, false);
      assert.equal(child.killed, true);
      assert.match(result.summary, /provider_identity_capture_failed/);
      assert.equal(result.providerErrorCode, "provider_identity_capture_failed");
      assert.deepEqual(lifecycleEvents, ["terminal:failed"]);
    } finally {
      restore();
    }
  });

  it("calls lifecycle terminal failed when Claude SDK run fails", async () => {
    const child = new FakeClaudeProcess();
    const identityProbe = installFakeIdentityProbe(child);
    const terminals: string[] = [];
    const restore = setClaudeSpawnForTest((() => {
      queueMicrotask(() => {
        child.stderr.write("boom");
        child.emit("close", 1);
      });
      return child;
    }) as never);
    try {
      const engine = new ClaudeSdkEngine();
      const result = await engine.run({
        changeId: "CHG-CLAUDE-LIFECYCLE-FAIL",
        repoPath: process.cwd(),
        phase: "plan",
        prompt: "fail lifecycle",
        sandboxMode: "read-only",
        lifecycle: {
          async onProcessStarted() {},
          async onHeartbeat() {},
          async onTerminal(event) {
            terminals.push(`${event.status}:${event.exitCode ?? "null"}:${event.summary}`);
          },
        },
      });

      assert.equal(result.success, false);
      assert.equal(terminals.length, 1);
      assert.match(terminals[0], /^failed:1:Claude SDK exited with code 1/);
    } finally {
      restore();
      identityProbe.restore();
    }
  });

  it("terminates and reaps a non-streamed Claude process when heartbeat persistence fails", async () => {
    const child = new FakeClaudeProcess(true);
    const identityProbe = installFakeIdentityProbe(child);
    const terminals: string[] = [];
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const completion = engine.run({
        changeId: "CHG-CLAUDE-RUN-HEARTBEAT-FAIL",
        repoPath: process.cwd(),
        phase: "plan",
        prompt: "fail persisted heartbeat",
        sandboxMode: "read-only",
        lifecycle: {
          async onProcessStarted() {},
          async onHeartbeat() {
            throw new Error("heartbeat persistence failed");
          },
          async onTerminal(event) {
            terminals.push(`${event.status}:${event.signal ?? "null"}:${event.summary}`);
          },
        },
      });

      child.stdout.write(`${JSON.stringify({
        type: "system",
        subtype: "progress",
        session_id: "heartbeat-failure-session",
      })}\n`);
      const result = await completion;

      assert.equal(result.success, false);
      assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
      assert.equal(result.threadId, "heartbeat-failure-session");
      assert.equal(terminals.length, 1);
      assert.match(terminals[0], /^failed:SIGKILL:heartbeat persistence failed$/);
    } finally {
      restore();
      identityProbe.restore();
    }
  });

  it("terminates the streamed Claude child process when the consumer stops early", async () => {
    const child = new FakeClaudeProcess(true);
    const identityProbe = installFakeIdentityProbe(child);
    let heartbeatCount = 0;
    const restoreHeartbeatInterval = setClaudeStreamHeartbeatIntervalForTest(
      TEST_STREAM_HEARTBEAT_INTERVAL_MS,
    );
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const stream = engine.runStreamed({
        changeId: "CHG-CLAUDE-STREAM-RETURN",
        repoPath: process.cwd(),
        phase: "implement",
        prompt: "stream forever",
        sandboxMode: "workspace-write",
        lifecycle: {
          async onProcessStarted() {},
          async onHeartbeat() {
            heartbeatCount += 1;
          },
          async onTerminal() {},
        },
      });
      const pendingNext = stream.next().catch(() => undefined);
      await delay(20);
      assert.ok(heartbeatCount >= 2);

      await stream.return(undefined);
      await pendingNext;
      await assertHeartbeatsStopped(() => heartbeatCount);
      await delay(65);

      assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
    } finally {
      restore();
      restoreHeartbeatInterval();
      identityProbe.restore();
    }
  });

  it("waits for process close and stopped terminal persistence before resolving iterator.return", async () => {
    const child = new FakeClaudeProcess(true);
    const identityProbe = installFakeIdentityProbe(child);
    const started = deferred();
    const terminalStarted = deferred();
    const releaseTerminal = deferred();
    const terminals: string[] = [];
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const stream = engine.runStreamed({
        changeId: "CHG-CLAUDE-STREAM-RETURN-COMPLETION",
        repoPath: process.cwd(),
        phase: "implement",
        prompt: "wait for return completion",
        sandboxMode: "workspace-write",
        lifecycle: {
          async onProcessStarted() {
            started.resolve();
          },
          async onHeartbeat() {},
          async onTerminal(event) {
            terminals.push(event.status);
            terminalStarted.resolve();
            await releaseTerminal.promise;
          },
        },
      });
      const pendingNext = stream.next();
      await started.promise;

      const returned = stream.return(undefined);
      await assertPending(returned);
      assert.deepEqual(await pendingNext, { done: true, value: undefined });
      assert.deepEqual(child.killSignals, ["SIGTERM"]);
      assert.deepEqual(terminals, []);

      child.emit("close", null, "SIGTERM");
      await terminalStarted.promise;
      await assertPending(returned);

      releaseTerminal.resolve();
      assert.deepEqual(await returned, { done: true, value: undefined });
      assert.deepEqual(terminals, ["stopped"]);
    } finally {
      releaseTerminal.resolve();
      restore();
      identityProbe.restore();
    }
  });

  it("waits for close and terminal persistence before iterator.throw rejects with the consumer error", async () => {
    const child = new FakeClaudeProcess(true);
    const identityProbe = installFakeIdentityProbe(child);
    const started = deferred();
    const terminalStarted = deferred();
    const releaseTerminal = deferred();
    const consumerError = new Error("consumer aborted stream");
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const stream = engine.runStreamed({
        changeId: "CHG-CLAUDE-STREAM-THROW-COMPLETION",
        repoPath: process.cwd(),
        phase: "implement",
        prompt: "wait for throw completion",
        sandboxMode: "workspace-write",
        lifecycle: {
          async onProcessStarted() {
            started.resolve();
          },
          async onHeartbeat() {},
          async onTerminal(event) {
            assert.equal(event.status, "stopped");
            terminalStarted.resolve();
            await releaseTerminal.promise;
            throw new Error("terminal persistence failed");
          },
        },
      });
      const pendingNext = stream.next().catch(() => undefined);
      await started.promise;

      const thrown = stream.throw(consumerError);
      void thrown.catch(() => undefined);
      await assertPending(thrown);

      child.emit("close", null, "SIGTERM");
      await terminalStarted.promise;
      await assertPending(thrown);

      releaseTerminal.resolve();
      await assert.rejects(thrown, (error) => error === consumerError);
      await pendingNext;
    } finally {
      releaseTerminal.resolve();
      restore();
      identityProbe.restore();
    }
  });

  it("keeps iterator.return pending through SIGKILL until close and emits terminal exactly once", async () => {
    const child = new FakeClaudeProcess(true);
    const identityProbe = installFakeIdentityProbe(child);
    const started = deferred();
    const sigkillSent = deferred();
    const originalKill = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        child.killSignals.push(signal);
        sigkillSent.resolve();
        return true;
      }
      return originalKill(signal);
    };
    let terminalCount = 0;
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const stream = engine.runStreamed({
        changeId: "CHG-CLAUDE-STREAM-RETURN-SIGKILL",
        repoPath: process.cwd(),
        phase: "implement",
        prompt: "ignore termination until close",
        sandboxMode: "workspace-write",
        lifecycle: {
          async onProcessStarted() {
            started.resolve();
          },
          async onHeartbeat() {},
          async onTerminal(event) {
            assert.equal(event.status, "stopped");
            terminalCount += 1;
          },
        },
      });
      const pendingNext = stream.next();
      await started.promise;

      const firstReturn = stream.return(undefined);
      const secondReturn = stream.return(undefined);
      await sigkillSent.promise;
      await assertPending(firstReturn);
      await assertPending(secondReturn);
      assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
      assert.equal(terminalCount, 0);

      child.emit("close", null, "SIGKILL");
      assert.deepEqual(await firstReturn, { done: true, value: undefined });
      assert.deepEqual(await secondReturn, { done: true, value: undefined });
      assert.deepEqual(await pendingNext, { done: true, value: undefined });
      assert.equal(terminalCount, 1);

      child.emit("close", null, "SIGKILL");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(terminalCount, 1);
    } finally {
      restore();
      identityProbe.restore();
    }
  });

  it("rejects repeated iterator.return calls with terminal persistence failure", async () => {
    const child = new FakeClaudeProcess(true);
    const identityProbe = installFakeIdentityProbe(child);
    const started = deferred();
    const terminalError = new Error("terminal persistence failed");
    let terminalCount = 0;
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const stream = engine.runStreamed({
        changeId: "CHG-CLAUDE-STREAM-RETURN-TERMINAL-FAIL",
        repoPath: process.cwd(),
        phase: "implement",
        prompt: "surface terminal persistence failure",
        sandboxMode: "workspace-write",
        lifecycle: {
          async onProcessStarted() {
            started.resolve();
          },
          async onHeartbeat() {},
          async onTerminal() {
            terminalCount += 1;
            throw terminalError;
          },
        },
      });
      void stream.next();
      await started.promise;

      const firstReturn = stream.return(undefined);
      const secondReturn = stream.return(undefined);
      void firstReturn.catch(() => undefined);
      void secondReturn.catch(() => undefined);
      child.emit("close", null, "SIGTERM");

      await assert.rejects(firstReturn, (error) => error === terminalError);
      await assert.rejects(secondReturn, (error) => error === terminalError);
      assert.equal(terminalCount, 1);
    } finally {
      restore();
      identityProbe.restore();
    }
  });

  it("does not let an in-flight process error terminal chain settle iterator.return before close", async () => {
    const child = new FakeClaudeProcess(true);
    const identityProbe = installFakeIdentityProbe(child);
    const started = deferred();
    const terminalStarted = deferred();
    const releaseTerminal = deferred();
    let terminalCount = 0;
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const stream = engine.runStreamed({
        changeId: "CHG-CLAUDE-STREAM-ERROR-RETURN-RACE",
        repoPath: process.cwd(),
        phase: "implement",
        prompt: "race process error with return",
        sandboxMode: "workspace-write",
        lifecycle: {
          async onProcessStarted() {
            started.resolve();
          },
          async onHeartbeat() {},
          async onTerminal() {
            terminalCount += 1;
            terminalStarted.resolve();
            await releaseTerminal.promise;
          },
        },
      });
      const pendingNext = stream.next().catch(() => undefined);
      await started.promise;

      child.emit("error", new Error("spawn failed during cancellation"));
      await terminalStarted.promise;
      const returned = stream.return(undefined);
      releaseTerminal.resolve();

      await assertPending(returned);
      child.emit("close", null, "SIGTERM");
      assert.deepEqual(await returned, { done: true, value: undefined });
      await pendingNext;
      assert.equal(terminalCount, 1);
    } finally {
      releaseTerminal.resolve();
      restore();
      identityProbe.restore();
    }
  });

  it("stops streamed Claude heartbeats when the consumer throws", async () => {
    const child = new FakeClaudeProcess(true);
    const identityProbe = installFakeIdentityProbe(child);
    let heartbeatCount = 0;
    const restoreHeartbeatInterval = setClaudeStreamHeartbeatIntervalForTest(
      TEST_STREAM_HEARTBEAT_INTERVAL_MS,
    );
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const stream = engine.runStreamed({
        changeId: "CHG-CLAUDE-STREAM-THROW",
        repoPath: process.cwd(),
        phase: "implement",
        prompt: "stream until consumer throws",
        sandboxMode: "workspace-write",
        lifecycle: {
          async onProcessStarted() {},
          async onHeartbeat() {
            heartbeatCount += 1;
          },
          async onTerminal() {},
        },
      });
      const pendingNext = stream.next().catch(() => undefined);
      await delay(20);
      assert.ok(heartbeatCount >= 2);

      await assert.rejects(stream.throw(new Error("consumer aborted stream")), /consumer aborted stream/);
      await pendingNext;
      await assertHeartbeatsStopped(() => heartbeatCount);
      await delay(65);

      assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
    } finally {
      restore();
      restoreHeartbeatInterval();
      identityProbe.restore();
    }
  });

  for (const timeoutCase of [
    { name: "SIGTERM", ignoreSigterm: false, signals: ["SIGTERM"] },
    { name: "SIGKILL escalation", ignoreSigterm: true, signals: ["SIGTERM", "SIGKILL"] },
  ] as const) {
    it(`stops streamed Claude heartbeats on timeout ${timeoutCase.name}`, async () => {
      const child = new FakeClaudeProcess(timeoutCase.ignoreSigterm);
      const identityProbe = installFakeIdentityProbe(child);
      let heartbeatCount = 0;
      const restoreHeartbeatInterval = setClaudeStreamHeartbeatIntervalForTest(
        TEST_STREAM_HEARTBEAT_INTERVAL_MS,
      );
      const restore = setClaudeSpawnForTest(() => child as never);
      try {
        const engine = new ClaudeSdkEngine();
        const stream = engine.runStreamed({
          changeId: `CHG-CLAUDE-STREAM-TIMEOUT-${timeoutCase.name}`,
          repoPath: process.cwd(),
          phase: "implement",
          prompt: "remain silent until timeout",
          timeoutMs: 20,
          sandboxMode: "workspace-write",
          lifecycle: {
            async onProcessStarted() {},
            async onHeartbeat() {
              heartbeatCount += 1;
            },
            async onTerminal() {},
          },
        });

        await assert.rejects(stream.next(), /provider_timeout/);
        assert.ok(heartbeatCount >= 2);
        assert.deepEqual(child.killSignals, timeoutCase.signals);
        await assertHeartbeatsStopped(() => heartbeatCount);
      } finally {
        restore();
        restoreHeartbeatInterval();
        identityProbe.restore();
      }
    });
  }

  it("fails closed and stops the timer when streamed heartbeat persistence fails", async () => {
    const child = new FakeClaudeProcess(true);
    const identityProbe = installFakeIdentityProbe(child);
    let heartbeatCount = 0;
    const restoreHeartbeatInterval = setClaudeStreamHeartbeatIntervalForTest(
      TEST_STREAM_HEARTBEAT_INTERVAL_MS,
    );
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const stream = engine.runStreamed({
        changeId: "CHG-CLAUDE-HEARTBEAT-PERSISTENCE-FAIL",
        repoPath: process.cwd(),
        phase: "implement",
        prompt: "fail heartbeat persistence",
        timeoutMs: 20,
        sandboxMode: "workspace-write",
        lifecycle: {
          async onProcessStarted() {},
          async onHeartbeat() {
            heartbeatCount += 1;
            throw new Error("heartbeat persistence failed");
          },
          async onTerminal() {},
        },
      });

      await assert.rejects(stream.next(), /heartbeat persistence failed/);
      assert.equal(heartbeatCount, 1);
      await assertHeartbeatsStopped(() => heartbeatCount);
      await delay(65);
      assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
    } finally {
      restore();
      restoreHeartbeatInterval();
      identityProbe.restore();
    }
  });

  it("converts streamed Claude assistant text to internal agent_message events", async () => {
    const child = new FakeClaudeProcess();
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const stream = engine.runStreamed({
        changeId: "CHG-CLAUDE-STREAM-MESSAGE",
        repoPath: process.cwd(),
        phase: "implement",
        prompt: "stream text",
        sandboxMode: "workspace-write",
      });
      const next = stream.next();
      await new Promise((resolve) => setImmediate(resolve));

      child.stdout.write(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Applying the build change." }],
          },
        }) + "\n",
      );

      assert.deepEqual(await next, {
        done: false,
        value: {
          type: "item.completed",
          item: {
            type: "agent_message",
            text: "Applying the build change.",
          },
        },
      });

      await stream.return(undefined);
    } finally {
      restore();
    }
  });

  it("does not emit streamed output or heartbeat until lifecycle start persists", async () => {
    const child = new FakeClaudeProcess();
    const identityProbe = installFakeIdentityProbe(child);
    const restoreHeartbeatInterval = setClaudeStreamHeartbeatIntervalForTest(
      TEST_STREAM_HEARTBEAT_INTERVAL_MS,
    );
    let releaseStart: (() => void) | undefined;
    const startPersisted = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const lifecycleEvents: string[] = [];
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const stream = engine.runStreamed({
        changeId: "CHG-CLAUDE-STREAM-LEASE-GATE",
        repoPath: process.cwd(),
        phase: "implement",
        prompt: "gate output on lifecycle persistence",
        sandboxMode: "workspace-write",
        lifecycle: {
          async onProcessStarted() {
            lifecycleEvents.push("started");
            await startPersisted;
            lifecycleEvents.push("persisted");
          },
          async onHeartbeat() {
            lifecycleEvents.push("heartbeat");
          },
          async onTerminal() {},
        },
      });
      const next = stream.next();
      let outputSettled = false;
      void next.then(() => {
        outputSettled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));

      child.stdout.write(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "must wait for lease" }],
          },
        }) + "\n",
      );
      await delay(HEARTBEAT_STOP_SETTLE_MS);

      assert.equal(outputSettled, false);
      assert.deepEqual(lifecycleEvents, ["started"]);
      assert.equal(identityProbe.captureCount(), 1);

      releaseStart?.();
      assert.equal((await next).value.item?.text, "must wait for lease");
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(lifecycleEvents, ["started", "persisted", "heartbeat"]);
      await stream.return(undefined);
    } finally {
      restore();
      restoreHeartbeatInterval();
      identityProbe.restore();
    }
  });

  it("does not start streamed heartbeats when Claude process identity capture fails", async () => {
    const child = new FakeClaudeProcess();
    let heartbeatCount = 0;
    const failingProbe: ProcessIdentityProbe = {
      async capture() {
        throw new Error("identity unavailable");
      },
      async validate() {
        return { ok: false, reason: "identity unavailable" };
      },
    };
    const restoreIdentityProbe = setClaudeProcessIdentityProbeForTest(failingProbe);
    const restoreHeartbeatInterval = setClaudeStreamHeartbeatIntervalForTest(
      TEST_STREAM_HEARTBEAT_INTERVAL_MS,
    );
    const restoreSpawn = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const stream = engine.runStreamed({
        changeId: "CHG-CLAUDE-STREAM-IDENTITY-FAIL",
        repoPath: process.cwd(),
        phase: "implement",
        prompt: "identity failure must stop startup",
        sandboxMode: "workspace-write",
        lifecycle: {
          async onProcessStarted() {
            assert.fail("lifecycle start must not run after identity capture failure");
          },
          async onHeartbeat() {
            heartbeatCount += 1;
          },
          async onTerminal() {},
        },
      });

      await assert.rejects(stream.next(), /provider_identity_capture_failed/);
      assert.equal(child.killSignals[0], "SIGTERM");
      assert.equal(heartbeatCount, 0);
      await assertHeartbeatsStopped(() => heartbeatCount);
    } finally {
      restoreSpawn();
      restoreHeartbeatInterval();
      restoreIdentityProbe();
    }
  });

  it("surfaces streamed Claude spawn errors without leaving an unhandled child error", async () => {
    const child = new FakeClaudeProcess();
    const identityProbe = installFakeIdentityProbe(child);
    const lifecycleEvents: string[] = [];
    let heartbeatCount = 0;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const restoreHeartbeatInterval = setClaudeStreamHeartbeatIntervalForTest(
      TEST_STREAM_HEARTBEAT_INTERVAL_MS,
    );
    const restore = setClaudeSpawnForTest(() => child as never);
    try {
      const engine = new ClaudeSdkEngine();
      const stream = engine.runStreamed({
        changeId: "CHG-CLAUDE-STREAM-ERROR",
        repoPath: process.cwd(),
        phase: "implement",
        prompt: "spawn fails",
        sandboxMode: "workspace-write",
        lifecycle: {
          async onProcessStarted(event) {
            assert.equal(event.identity?.pid, child.pid);
            assert.equal(event.identity?.ppid, process.pid);
            assert.equal(event.identity?.cwd, process.cwd());
            assert.ok(event.identity?.nonce);
            lifecycleEvents.push("started");
            markStarted?.();
          },
          async onHeartbeat() {
            heartbeatCount += 1;
          },
          async onTerminal(event) {
            lifecycleEvents.push(`terminal:${event.status}`);
          },
        },
      });
      const next = stream.next();
      await started;
      await delay(20);
      assert.ok(heartbeatCount >= 2);

      child.emit("error", new Error("spawn nope"));

      await assert.rejects(next, /Failed to spawn Claude SDK: spawn nope/);
      assert.equal(child.killSignals[0], "SIGTERM");
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(lifecycleEvents, ["started", "terminal:failed"]);
      await assertHeartbeatsStopped(() => heartbeatCount);
    } finally {
      restore();
      restoreHeartbeatInterval();
      identityProbe.restore();
    }
  });
});
