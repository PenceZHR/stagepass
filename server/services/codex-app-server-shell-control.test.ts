import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  codexPhase0VerificationArgumentsHash,
  createCodexAppServerShellControl,
  type AppServerShellClient,
} from "./codex-app-server-shell-control.ts";

const TEST_APP_SERVER_BINARY = {
  path: "/Applications/ChatGPT.app/Contents/Resources/codex",
  version: "codex-cli 0.146.0-alpha.3.1",
  file: {
    isSocket: false,
    isDirectory: false,
    isSymbolicLink: false,
    uid: 0,
    mode: 0o755,
    device: 9,
    inode: 101,
  },
  bundlePath: "/Applications/ChatGPT.app",
  bundleFile: {
    isSocket: false,
    isDirectory: true,
    isSymbolicLink: false,
    uid: 0,
    mode: 0o755,
    device: 9,
    inode: 102,
  },
  bundleIdentifier: "com.openai.codex",
  teamIdentifier: "2DC432GLL2",
} as const;

class FakeShellClient implements AppServerShellClient {
  readonly calls: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];
  threadReadOverride?: unknown;
  userAgent = "codex-test/1.2.3";

  async initialize(): Promise<Record<string, unknown>> {
    return { userAgent: this.userAgent };
  }

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "turn/start") {
      throw new Error("managed turn method reached shell control");
    }
    if (method === "thread/start") {
      return {
        thread: {
          id: "THREAD-1",
          name: null,
          cwd: "/repo",
          ephemeral: false,
        },
      };
    }
    if (method === "thread/list") {
      return {
        data: [{
          id: "THREAD-1",
          name: "[CHG-1] First",
          cwd: "/repo",
          ephemeral: false,
        }],
        nextCursor: null,
      };
    }
    if (method === "thread/read") {
      if (this.threadReadOverride) return this.threadReadOverride;
      return {
        thread: {
          id: "THREAD-1",
          name: "[CHG-1] First",
          cwd: "/repo",
          ephemeral: false,
          turns: [{
            id: "TURN-1",
            itemsView: "full",
            status: "completed",
            startedAt: 100,
            completedAt: 101,
            durationMs: 1_000,
            error: null,
            items: [
              { type: "userMessage", id: "ITEM-1", content: [] },
              {
                type: "agentMessage",
                id: "ITEM-2",
                text: "LIFECYCLE_OK",
              },
            ],
          }],
        },
      };
    }
    if (method === "model/list") {
      return {
        data: [{
          id: "gpt-test",
          model: "gpt-test",
          displayName: "GPT Test",
        }],
        nextCursor: null,
      };
    }
    return {};
  }

  async close(): Promise<void> {}
}

function sessionScopedClientFixture(
  transientNameError = "thread not loaded",
) {
  const durable = new Map<string, {
    id: string;
    name: string | null;
    cwd: string;
    ephemeral: false;
  }>();
  const activated = new Set<string>();
  const clients: Array<{
    calls: string[];
    closed: boolean;
  }> = [];
  let nextThread = 1;
  let transientNameFailures = 1;

  return {
    durable,
    activated,
    clients,
    async activate(threadId: string) {
      activated.add(threadId);
    },
    clientFactory(): AppServerShellClient {
      const local = new Map<string, {
        id: string;
        name: string | null;
        cwd: string;
        ephemeral: false;
      }>();
      const facts = { calls: [] as string[], closed: false };
      clients.push(facts);
      return {
        async initialize() {
          return { userAgent: "session-test" };
        },
        async request(method, params) {
          facts.calls.push(method);
          if (method === "turn/start") {
            throw new Error("managed turn method reached provisioning");
          }
          if (method === "thread/start") {
            const thread = {
              id: `THREAD-${nextThread++}`,
              name: null,
              cwd: String(params.cwd),
              ephemeral: false as const,
            };
            local.set(thread.id, thread);
            return { thread };
          }
          if (method === "thread/name/set") {
            const threadId = String(params.threadId);
            const thread = local.get(threadId) ?? durable.get(threadId);
            if (!thread) throw new Error("thread not loaded");
            if (!activated.has(threadId)) throw new Error("thread not loaded");
            if (transientNameFailures > 0) {
              transientNameFailures -= 1;
              throw new Error(transientNameError);
            }
            const named = { ...thread, name: String(params.name) };
            local.set(threadId, named);
            durable.set(threadId, named);
            return {};
          }
          if (method === "thread/read") {
            const threadId = String(params.threadId);
            const thread = local.get(threadId) ?? durable.get(threadId);
            if (!thread) throw new Error("thread not loaded");
            return { thread: { ...thread, turns: [] } };
          }
          if (method === "thread/list") {
            const visible = new Map(durable);
            for (const [threadId, thread] of local) {
              visible.set(threadId, thread);
            }
            return {
              data: [...visible.values()].filter(
                ({ cwd }) => cwd === params.cwd,
              ),
              nextCursor: null,
            };
          }
          if (method === "model/list") {
            return { data: [], nextCursor: null };
          }
          return {};
        },
        async close() {
          facts.closed = true;
          local.clear();
        },
      };
    },
  };
}

function fixture(behaviorEvidence?: {
  protocolFingerprint: string;
  capabilities: string[];
}): {
  client: FakeShellClient;
  shellControl: ReturnType<typeof createCodexAppServerShellControl>;
} {
  const client = new FakeShellClient();
  return {
    client,
    shellControl: createCodexAppServerShellControl({
      appServerBinary: TEST_APP_SERVER_BINARY,
      clientFactory: () => client,
      verifyAppServerBinary: async () => {},
      now: () => 200_000,
      behaviorEvidence,
    }),
  };
}

// Strict fixtures below were regenerated/confirmed on 2026-07-23 with the
// ChatGPT-bundled codex-cli 0.146.0-alpha.3.1 into a disposable directory.
// Sorted relative paths without a leading "./", then per-file SHA-256:
// fd6f8bb9872165ce1e991c7ec175aa370bf1b4bbf797b5574b53eafd194711a1.
// Turn fields: id/items/itemsView/status/error/startedAt/completedAt/durationMs;
// itemsView is notLoaded|summary|full.
/**
 * A settled round must not be lost to the deadline on its own bookkeeping.
 *
 * `listSubAgentThreads` enumerates every sub-agent thread the app-server knows,
 * 100 per page, filtering by parent client-side because `thread/list` has no
 * parent filter -- so its cost grows with every round ever run. On the default
 * 15s control-plane budget that killed a Spec round which had already spent
 * 4m44s: judge, red and blue had all finished and their files were on disk.
 */
describe("sub-agent enumeration budget", () => {
  it("gives thread/list a budget sized for enumeration, not for a health check", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "codex-app-server-shell-control.ts"),
      "utf-8",
    );
    const declared = /const SUB_AGENT_LIST_TIMEOUT_MS = ([0-9_]+);/.exec(source);
    assert.ok(declared, "the sub-agent listing timeout must be named, not inlined");
    assert.ok(
      Number(declared[1]!.replace(/_/g, "")) >= 60_000,
      "a paged enumeration that grows with history cannot share the 15s control-plane default",
    );
    // And it must actually be passed to the call, not merely declared.
    assert.match(
      source,
      /sourceKinds: \["subAgentThreadSpawn"\],\s*\}, SUB_AGENT_LIST_TIMEOUT_MS\)/,
    );
  });
});

describe("Codex app-server shell control", () => {
  it("accepts the exact 0.146.0-alpha.3.1 generated-schema runtime fingerprint", async () => {
    const client = new FakeShellClient();
    client.userAgent =
      "Codex Desktop/0.146.0-alpha.3.1 (Mac OS 26.5.1; arm64) dumb (stagepass; 0.1.0)";
    const shellControl = createCodexAppServerShellControl({
      appServerBinary: {
        ...TEST_APP_SERVER_BINARY,
        version: "codex-cli 0.146.0-alpha.3.1",
      },
      clientFactory: () => client,
      verifyAppServerBinary: async () => {},
    });

    const probe = await shellControl.probe();
    assert.equal(
      probe.protocolFingerprint,
      "codex-cli-0.146.0-alpha.3.1-generate-ts:"
      + "fd6f8bb9872165ce1e991c7ec175aa370bf1b4bbf797b5574b53eafd194711a1"
      + `;runtime=${client.userAgent}`,
    );
    assert.deepEqual(probe.protocolCapabilities, [
      "thread/start:persistent",
      "thread/name/set",
      "thread/read:includeTurns",
      "thread/list",
      "model/list",
    ]);
  });

  it("rejects an old bundled-binary identity before creating a client", () => {
    let factoryCalls = 0;

    assert.throws(
      () => createCodexAppServerShellControl({
        appServerBinary: {
          ...TEST_APP_SERVER_BINARY,
          version: "codex-cli 0.144.4",
        },
        clientFactory: () => {
          factoryCalls += 1;
          return new FakeShellClient();
        },
        verifyAppServerBinary: async () => {},
      }),
      (error: unknown) =>
        error instanceof Error
        && "code" in error
        && error.code === "desktop_bridge_unavailable",
    );
    assert.equal(factoryCalls, 0);
  });

  it("passes the same attested bundled binary to every client factory", async () => {
    const paths: string[] = [];
    const checks: string[] = [];
    const shellControl = createCodexAppServerShellControl({
      appServerBinary: TEST_APP_SERVER_BINARY,
      clientFactory(_cwd, codexBin) {
        paths.push(codexBin);
        return new FakeShellClient();
      },
      async verifyAppServerBinary(_identity, phase) {
        checks.push(phase);
      },
    });

    await shellControl.probe();
    await shellControl.listModels();

    assert.deepEqual(paths, [
      TEST_APP_SERVER_BINARY.path,
      TEST_APP_SERVER_BINARY.path,
    ]);
    assert.deepEqual(checks, [
      "before_spawn",
      "after_spawn",
      "before_spawn",
      "after_spawn",
    ]);
  });

  it("does not repeat deep bundle verification after discovery attestation", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "server",
        "services",
        "codex-app-server-shell-control.ts",
      ),
      "utf8",
    );
    const verifier = source.slice(
      source.indexOf("export async function verifyAttestedAppServerBinary"),
      source.indexOf("\nfunction asRecord"),
    );

    assert.doesNotMatch(verifier, /\["--verify",\s*"--deep",\s*"--strict"/);
    assert.match(verifier, /\["-dv",\s*"--verbose=4"/);
  });

  it("provisions and proves a persistent shell within its creator client", async () => {
    const fixture = sessionScopedClientFixture();
    let currentNow = 0;
    const checkpoints: string[] = [];
    const lifecycle: string[] = [];
    const shellControl = createCodexAppServerShellControl({
      appServerBinary: TEST_APP_SERVER_BINARY,
      clientFactory: () => fixture.clientFactory(),
      verifyAppServerBinary: async () => {},
      now: () => currentNow,
      sleep: async (ms) => {
        currentNow += ms;
      },
    });

    const legacy = await shellControl.startPersistentThread({
      cwd: "/repo",
      ephemeral: false,
    });
    await assert.rejects(
      shellControl.readPersistentShell(legacy.threadId),
      /thread not loaded/,
    );

    const shell = await shellControl.startPersistentThreadAndName({
      cwd: "/repo",
      ephemeral: false,
      name: "[CHG-1] First",
      deadlineAt: new Date(1_000).toISOString(),
      async onStarted(threadId) {
        lifecycle.push(`record:${threadId}`);
      },
      async activate(threadId) {
        lifecycle.push(`activate:${threadId}`);
        await fixture.activate(threadId);
      },
      onCheckpoint(point) {
        checkpoints.push(point);
        lifecycle.push(point);
      },
    });
    assert.deepEqual(shell, {
      threadId: "THREAD-2",
      title: "[CHG-1] First",
      cwd: "/repo",
      ephemeral: false,
    });
    assert.deepEqual(checkpoints, [
      "after_thread_start",
      "after_thread_activation",
      "after_thread_name",
    ]);
    assert.deepEqual(lifecycle, [
      "record:THREAD-2",
      "after_thread_start",
      "activate:THREAD-2",
      "after_thread_activation",
      "after_thread_name",
    ]);
    assert.equal(fixture.clients.at(-1)?.closed, true);
    assert.deepEqual(
      await shellControl.readPersistentShell(shell.threadId),
      shell,
    );
    const provisioningCalls = fixture.clients[2]?.calls ?? [];
    assert.deepEqual(provisioningCalls, [
      "thread/start",
      "thread/name/set",
      "thread/name/set",
      "thread/read",
    ]);
    assert.equal(
      fixture.clients.flatMap(({ calls }) => calls)
        .filter((method) => method === "turn/start").length,
      0,
    );
  });

  it("retries the Codex App rollout registration lag after activation", async () => {
    const fixture = sessionScopedClientFixture(
      "no rollout found for thread id THREAD-1",
    );
    let currentNow = 0;
    const shellControl = createCodexAppServerShellControl({
      appServerBinary: TEST_APP_SERVER_BINARY,
      clientFactory: () => fixture.clientFactory(),
      verifyAppServerBinary: async () => {},
      now: () => currentNow,
      sleep: async (ms) => {
        currentNow += ms;
      },
    });

    const shell = await shellControl.startPersistentThreadAndName({
      cwd: "/repo",
      ephemeral: false,
      name: "[CHG-1] First",
      deadlineAt: new Date(1_000).toISOString(),
      async onStarted() {},
      activate: (threadId) => fixture.activate(threadId),
    });

    assert.equal(shell.threadId, "THREAD-1");
    assert.deepEqual(fixture.clients[0]?.calls, [
      "thread/start",
      "thread/name/set",
      "thread/name/set",
      "thread/read",
    ]);
  });

  it("closes the creator session at every provisioning crash checkpoint", async () => {
    for (
      const checkpoint of [
        "after_thread_start",
        "after_thread_activation",
        "after_thread_name",
      ] as const
    ) {
      const fixture = sessionScopedClientFixture();
      let currentNow = 0;
      const shellControl = createCodexAppServerShellControl({
        appServerBinary: TEST_APP_SERVER_BINARY,
        clientFactory: () => fixture.clientFactory(),
        verifyAppServerBinary: async () => {},
        now: () => currentNow,
        sleep: async (ms) => {
          currentNow += ms;
        },
      });

      await assert.rejects(
        shellControl.startPersistentThreadAndName({
          cwd: "/repo",
          ephemeral: false,
          name: "[CHG-1] First",
          deadlineAt: new Date(1_000).toISOString(),
          async onStarted() {},
          activate: (threadId) => fixture.activate(threadId),
          onCheckpoint(point) {
            if (point === checkpoint) throw new Error(`crash:${point}`);
          },
        }),
        new RegExp(`crash:${checkpoint}`),
      );
      assert.equal(fixture.clients[0]?.closed, true);
      if (checkpoint !== "after_thread_name") {
        assert.equal(fixture.durable.size, 0);
      } else {
        assert.equal(fixture.durable.size, 1);
        assert.equal(
          (await shellControl.readPersistentShell("THREAD-1"))?.title,
          "[CHG-1] First",
        );
      }
    }
  });

  it("fails closed when the attested binary changes after spawn", async () => {
    const shellControl = createCodexAppServerShellControl({
      appServerBinary: TEST_APP_SERVER_BINARY,
      clientFactory: () => new FakeShellClient(),
      async verifyAppServerBinary(_identity, phase) {
        if (phase === "after_spawn") {
          throw new Error("attested app-server binary identity changed");
        }
      },
    });

    await assert.rejects(
      () => shellControl.probe(),
      /attested app-server binary identity changed/,
    );
  });

  it("keeps every Phase 0 verifier path off ambient Codex resolution", () => {
    const verifier = fs.readFileSync(
      path.join(process.cwd(), "scripts/verify-codex-desktop-bridge.ts"),
      "utf8",
    );
    assert.doesNotMatch(verifier, /resolveCodexBin\s*\(/);
    assert.doesNotMatch(
      verifier,
      /CodexAppServerClient\.spawn\(\{\s*bin:\s*["']codex["']/,
    );
    assert.match(verifier, /--phase0-bootstrap-ready-crash-child/);
    assert.match(verifier, /childAppServerMethodCounts/);
    assert.match(verifier, /resumeInvocationThreadStartCount/);
    assert.doesNotMatch(verifier, /desktop_restart_already_completed/);
    assert.match(verifier, /reconcileConsumedRestartCompletion/);
    assert.match(verifier, /orchestratePhase0RestartResume/);
    assert.match(verifier, /assertStartAttemptEvidenceMatchesJournal/);
    assert.match(verifier, /validateRealCrashRecoveryBranch/);
    assert.match(
      verifier,
      /prompt:\s*`Reply exactly \$\{PHASE0_RESTART_RESUME_OUTPUT\}`/,
    );
    assert.match(
      verifier,
      /expectedOutput:\s*PHASE0_RESTART_RESUME_OUTPUT/,
    );
    assert.doesNotMatch(verifier, /PHASE0_RESTART_RESUME_OK\./);
  });

  it("accepts only the exact generated-schema runtime fingerprint", async () => {
    const exact = fixture();
    exact.client.userAgent =
      "Codex Desktop/0.146.0-alpha.3.1 (Mac OS 26.5.1; arm64) dumb (stagepass; 0.1.0)";
    const exactProbe = await exact.shellControl.probe();
    assert.equal(
      exactProbe.protocolFingerprint,
      "codex-cli-0.146.0-alpha.3.1-generate-ts:"
      + "fd6f8bb9872165ce1e991c7ec175aa370bf1b4bbf797b5574b53eafd194711a1"
      + `;runtime=${exact.client.userAgent}`,
    );
    assert.deepEqual(exactProbe.protocolCapabilities, [
      "thread/start:persistent",
      "thread/name/set",
      "thread/read:includeTurns",
      "thread/list",
      "model/list",
    ]);

    const old = fixture();
    old.client.userAgent = "codex_cli_rs/0.144.4";
    assert.deepEqual(
      (await old.shellControl.probe()).protocolCapabilities,
      [],
    );

    const unknown = fixture();
    unknown.client.userAgent =
      "Codex Desktop/0.145.0-alpha.19 (Mac OS 26.5.1; arm64) dumb (stagepass; 0.1.0)";
    assert.deepEqual(
      (await unknown.shellControl.probe()).protocolCapabilities,
      [],
    );
  });

  it("reports only capabilities observed by non-mutating runtime probes", async () => {
    const { client, shellControl } = fixture();
    const probe = await shellControl.probe();
    assert.equal(probe.version, "codex-test/1.2.3");
    assert.deepEqual(probe.capabilities, ["model/list", "thread/list"]);
    assert.match(probe.protocolFingerprint, /runtime=codex-test\/1\.2\.3/);
    assert.deepEqual(probe.protocolCapabilities, []);
    assert.deepEqual(client.calls.map(({ method }) => method), [
      "model/list",
      "thread/list",
    ]);
  });

  it("unlocks an unknown runtime only with exact same-fingerprint behavior evidence", async () => {
    const unknown = await fixture().shellControl.probe();
    const required = [
      "thread/start:persistent",
      "thread/name/set",
      "thread/read:includeTurns",
      "thread/list",
      "model/list",
    ];
    const mismatched = await fixture({
      protocolFingerprint: `${unknown.protocolFingerprint}-other`,
      capabilities: required,
    }).shellControl.probe();
    assert.deepEqual(mismatched.protocolCapabilities, []);
    const evidenced = await fixture({
      protocolFingerprint: unknown.protocolFingerprint,
      capabilities: required,
    }).shellControl.probe();
    assert.deepEqual(evidenced.protocolCapabilities, required);
  });

  it("starts an explicitly persistent shell and names it", async () => {
    const { client, shellControl } = fixture();
    const shell = await shellControl.startPersistentThread({
      cwd: "/repo",
      ephemeral: false,
    });
    await shellControl.setThreadName({
      threadId: shell.threadId,
      name: "[CHG-1] First",
    });

    assert.equal(shell.threadId, "THREAD-1");
    assert.deepEqual(client.calls, [
      {
        method: "thread/start",
        params: { cwd: "/repo", ephemeral: false },
      },
      {
        method: "thread/name/set",
        params: { threadId: "THREAD-1", name: "[CHG-1] First" },
      },
    ]);
  });

  it("reads, finds, and lists models without any managed-turn method", async () => {
    const { client, shellControl } = fixture();
    assert.deepEqual(
      await shellControl.findPersistentShell({
        cwd: "/repo",
        title: "[CHG-1] First",
      }),
      [{
        threadId: "THREAD-1",
        title: "[CHG-1] First",
        cwd: "/repo",
        ephemeral: false,
      }],
    );
    assert.deepEqual(
      await shellControl.readPersistentShell("THREAD-1"),
      {
        threadId: "THREAD-1",
        title: "[CHG-1] First",
        cwd: "/repo",
        ephemeral: false,
      },
    );
    assert.deepEqual(await shellControl.listModels(), [{
      id: "gpt-test",
      model: "gpt-test",
      displayName: "GPT Test",
    }]);
    assert.equal(
      client.calls.some(({ method }) => method === "turn/start"),
      false,
    );
  });

  it("contains no app-server managed-turn request in the adapter source", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "server",
        "services",
        "codex-app-server-shell-control.ts",
      ),
      "utf8",
    );
    assert.equal(
      /request\s*\(\s*["']turn\/start["']/.test(source),
      false,
    );
  });

  it("normalizes a full Desktop-started turn snapshot from includeTurns", async () => {
    const { client, shellControl } = fixture();
    const result = await shellControl.readThreadWithTurns({
      threadId: "THREAD-1",
      includeTurns: true,
    });
    assert.deepEqual(
      result.turns,
      [{
        threadId: "THREAD-1",
        turnId: "TURN-1",
        status: "completed",
        items: [
          {
            id: "ITEM-1",
            kind: "user_message",
            semantic: { text: "" },
          },
          {
            id: "ITEM-2",
            kind: "agent_message",
            semantic: { text: "LIFECYCLE_OK" },
          },
        ],
        terminal: { output: "LIFECYCLE_OK" },
        metadata: {
          startedAt: "1970-01-01T00:01:40.000Z",
          completedAt: "1970-01-01T00:01:41.000Z",
          durationMs: 1_000,
          observedAt: "1970-01-01T00:03:20.000Z",
        },
      }],
    );
    assert.deepEqual(client.calls.at(-1), {
      method: "thread/read",
      params: { threadId: "THREAD-1", includeTurns: true },
    });
  });

  it("treats Codex's premature completed flag without terminal metadata as still in progress", async () => {
    const { client, shellControl } = fixture();
    client.threadReadOverride = {
      thread: {
        id: "THREAD-1",
        name: "[CHG-1] First",
        cwd: "/repo",
        ephemeral: false,
        turns: [{
          id: "TURN-1",
          itemsView: "full",
          status: "completed",
          startedAt: 100,
          completedAt: null,
          durationMs: null,
          error: null,
          items: [{
            type: "userMessage",
            id: "ITEM-1",
            clientId: null,
            content: [],
          }],
        }],
      },
    };

    const result = await shellControl.readThreadWithTurns({
      threadId: "THREAD-1",
      includeTurns: true,
    });

    assert.equal(result.turns[0]?.status, "inProgress");
    assert.equal(result.turns[0]?.terminal, undefined);
  });

  it("treats Codex's premature interrupted flag without terminal metadata as still in progress", async () => {
    // Observed live on Codex Desktop/0.146.0-alpha.3.1: for roughly the first
    // minute after thread/turn start, thread/read reports the new turn as
    // status "interrupted" with completedAt/durationMs null, then flips it to
    // completed with full terminal metadata. Rejecting that transient read
    // poisoned the whole thread snapshot and killed every stage job that
    // polled during turn startup.
    const { client, shellControl } = fixture();
    client.threadReadOverride = {
      thread: {
        id: "THREAD-1",
        name: "[CHG-1] First",
        cwd: "/repo",
        ephemeral: false,
        turns: [{
          id: "TURN-1",
          itemsView: "full",
          status: "interrupted",
          startedAt: 100,
          completedAt: null,
          durationMs: null,
          error: null,
          items: [{
            type: "userMessage",
            id: "ITEM-1",
            clientId: null,
            content: [],
          }],
        }],
      },
    };

    const result = await shellControl.readThreadWithTurns({
      threadId: "THREAD-1",
      includeTurns: true,
    });

    assert.equal(result.turns[0]?.status, "inProgress");
    assert.equal(result.turns[0]?.terminal, undefined);
  });

  it("retries transient rollout registration lag when reading a visible task", async () => {
    const client = new FakeShellClient();
    const request = client.request.bind(client);
    let readAttempts = 0;
    let currentNow = 0;
    client.request = async (method, params) => {
      if (method === "thread/read") {
        readAttempts += 1;
        if (readAttempts < 3) {
          throw new Error("no rollout found for thread id THREAD-1");
        }
      }
      return request(method, params);
    };
    const shellControl = createCodexAppServerShellControl({
      appServerBinary: TEST_APP_SERVER_BINARY,
      clientFactory: () => client,
      verifyAppServerBinary: async () => {},
      now: () => currentNow,
      sleep: async (ms) => {
        currentNow += ms;
      },
    });

    const result = await shellControl.readThreadWithTurns({
      threadId: "THREAD-1",
      includeTurns: true,
      deadlineAt: new Date(1_000).toISOString(),
    });

    assert.equal(readAttempts, 3);
    assert.equal(result.shell.threadId, "THREAD-1");
    assert.equal(result.turns.length, 1);
  });

  it("ignores the known transient reasoning item while preserving lifecycle semantics", async () => {
    const { client, shellControl } = fixture();
    client.threadReadOverride = {
      thread: {
        id: "THREAD-1",
        name: "[CHG-1] First",
        cwd: "/repo",
        ephemeral: false,
        turns: [{
          id: "TURN-1",
          itemsView: "full",
          status: "inProgress",
          startedAt: 100,
          completedAt: null,
          durationMs: null,
          error: null,
          items: [
            { id: "ITEM-1", type: "userMessage", clientId: null, content: [] },
            {
              id: "ITEM-REASONING",
              type: "reasoning",
              summary: ["private transient summary"],
              content: ["private transient content"],
            },
            { id: "ITEM-2", type: "agentMessage", text: "" },
          ],
        }],
      },
    };

    const result = await shellControl.readThreadWithTurns({
      threadId: "THREAD-1",
      includeTurns: true,
    });

    assert.deepEqual(result.turns[0]?.items, [
      {
        id: "ITEM-1",
        kind: "user_message",
        semantic: { text: "" },
      },
      {
        id: "ITEM-2",
        kind: "agent_message",
        semantic: { text: "" },
      },
    ]);
    assert.equal(JSON.stringify(result).includes("private transient"), false);
  });

  it("fails closed on unknown item kinds and duplicate raw item ids", async () => {
    for (const items of [
      [{ id: "ITEM-1", type: "unknownFutureItem", payload: [] }],
      [
        { id: "ITEM-1", type: "reasoning", summary: [], content: [] },
        { id: "ITEM-1", type: "userMessage", clientId: null, content: [] },
      ],
    ]) {
      const { client, shellControl } = fixture();
      client.threadReadOverride = {
        thread: {
          id: "THREAD-1",
          name: "[CHG-1] First",
          cwd: "/repo",
          ephemeral: false,
          turns: [{
            id: "TURN-1",
            itemsView: "full",
            status: "inProgress",
            startedAt: 100,
            completedAt: null,
            durationMs: null,
            error: null,
            items,
          }],
        },
      };
      await assert.rejects(
        () => shellControl.readThreadWithTurns({
          threadId: "THREAD-1",
          includeTurns: true,
        }),
        (error: unknown) =>
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "turn_snapshot_invalid",
      );
    }
  });

  it("fails closed on duplicate turn ids", async () => {
    const { client, shellControl } = fixture();
    const duplicate = {
      id: "TURN-DUPLICATE",
      itemsView: "full",
      status: "inProgress",
      startedAt: 100,
      completedAt: null,
      durationMs: null,
      error: null,
      items: [{
        id: "ITEM-1",
        type: "userMessage",
        clientId: null,
        content: [],
      }],
    };
    client.threadReadOverride = {
      thread: {
        id: "THREAD-1",
        name: "[CHG-1] First",
        cwd: "/repo",
        ephemeral: false,
        turns: [duplicate, { ...duplicate, items: [{
          id: "ITEM-2",
          type: "userMessage",
          clientId: null,
          content: [],
        }] }],
      },
    };
    await assert.rejects(
      () => shellControl.readThreadWithTurns({
        threadId: "THREAD-1",
        includeTurns: true,
      }),
      (error: unknown) =>
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "turn_snapshot_invalid",
    );
  });

  /**
   * A turn that delegates carries two item types nothing here had ever seen,
   * and the normalizer fails CLOSED on unknown kinds -- so before this, the
   * first Spec turn that spawned a sub-agent would have been thrown out whole
   * as `turn_snapshot_invalid`, with the delegation blamed on a malformed
   * snapshot.
   *
   * The `subAgentActivity` fields are the load-bearing part: `agentThreadId` is
   * how the server later reads a delegated side's output off a thread the main
   * agent cannot forge. Dropping it reads downstream as "no sub-agent ran",
   * which is exactly what a silent spawn failure also looks like.
   */
  it("keeps a delegating turn readable and preserves each sub-agent's thread", async () => {
    const { client, shellControl } = fixture();
    client.threadReadOverride = {
      thread: {
        id: "THREAD-1",
        name: "[CHG-1] First",
        cwd: "/repo",
        ephemeral: false,
        turns: [{
          id: "TURN-1",
          itemsView: "full",
          status: "inProgress",
          startedAt: 100,
          completedAt: null,
          durationMs: null,
          error: null,
          // Shapes captured verbatim from a real delegating turn; see
          // docs/CODEX-SUBAGENT-RUNTIME-EVIDENCE-2026-07-27.md.
          items: [
            {
              type: "subAgentActivity",
              id: "ITEM-SUB-RED",
              kind: "started",
              agentThreadId: "THREAD-RED",
              agentPath: "/root/red",
            },
            {
              type: "subAgentActivity",
              id: "ITEM-SUB-BLUE",
              kind: "started",
              agentThreadId: "THREAD-BLUE",
              agentPath: "/root/blue",
            },
            {
              type: "collabAgentToolCall",
              id: "ITEM-COLLAB",
              tool: "wait",
              status: "completed",
              senderThreadId: "THREAD-1",
              receiverThreadIds: [],
              prompt: null,
              model: null,
              reasoningEffort: null,
              agentsStates: {},
            },
          ],
        }],
      },
    };

    const result = await shellControl.readThreadWithTurns({
      threadId: "THREAD-1",
      includeTurns: true,
    });

    assert.deepEqual(
      result.turns[0]?.items.map((item) => item.kind),
      ["sub_agent_activity", "sub_agent_activity", "tool_call"],
    );
    assert.deepEqual(
      result.turns[0]?.items
        .filter((item) => item.kind === "sub_agent_activity")
        .map((item) => item.semantic),
      [
        { activity: "started", agentThreadId: "THREAD-RED", agentPath: "/root/red" },
        { activity: "started", agentThreadId: "THREAD-BLUE", agentPath: "/root/blue" },
      ],
    );
  });

  /**
   * `receiverThreadIds` and `agentsStates` came back EMPTY in the run where two
   * sub-agents demonstrably spawned and both replied. Projecting them would put
   * a field that reads like attribution next to one that actually is, and the
   * empty one would quietly win.
   */
  it("keeps the collab tool call's unreliable fields out of semantics", async () => {
    const { client, shellControl } = fixture();
    client.threadReadOverride = {
      thread: {
        id: "THREAD-1",
        name: "[CHG-1] First",
        cwd: "/repo",
        ephemeral: false,
        turns: [{
          id: "TURN-1",
          itemsView: "full",
          status: "inProgress",
          startedAt: 100,
          completedAt: null,
          durationMs: null,
          error: null,
          items: [{
            type: "collabAgentToolCall",
            id: "ITEM-COLLAB",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "THREAD-1",
            receiverThreadIds: ["THREAD-RED"],
            prompt: "spawn red",
            model: "gpt-5.6-sol",
            reasoningEffort: "low",
            agentsStates: { "THREAD-RED": { status: "running", message: null } },
          }],
        }],
      },
    };

    const semantic = JSON.stringify(
      (await shellControl.readThreadWithTurns({ threadId: "THREAD-1", includeTurns: true }))
        .turns[0]?.items[0]?.semantic,
    );

    assert.equal(semantic.includes("THREAD-RED"), false, "receiverThreadIds is not attribution");
    assert.equal(semantic.includes("spawn red"), false);
    assert.equal(semantic.includes("running"), false, "agentsStates is not attribution");
    assert.match(semantic, /collab\/spawnAgent/);
  });

  it("never projects MCP App-private result metadata into semantics", async () => {
    const { client, shellControl } = fixture();
    client.threadReadOverride = {
      thread: {
        id: "THREAD-1",
        name: "[CHG-1] First",
        cwd: "/repo",
        ephemeral: false,
        turns: [{
          id: "TURN-1",
          itemsView: "full",
          status: "inProgress",
          startedAt: 100,
          completedAt: null,
          durationMs: null,
          error: null,
          items: [{
            type: "mcpToolCall",
            id: "ITEM-MCP",
            server: "stagepass-phase0",
            tool: "present_phase0_card",
            status: "completed",
            arguments: {
              verificationCaseId: "cross_source_present",
              nonce: "RAW-PRIVATE-NONCE",
              token: "RAW-PRIVATE-TOKEN",
            },
            appContext: null,
            pluginId: null,
            result: {
              content: [{ type: "text", text: "ready" }],
              structuredContent: { ready: true },
              _meta: { stagepassPhase0: { nonce: "PRIVATE-NONCE" } },
            },
            error: null,
            durationMs: 10,
          }],
        }],
      },
    };

    const result = await shellControl.readThreadWithTurns({
      threadId: "THREAD-1",
      includeTurns: true,
    });
    assert.equal(
      JSON.stringify(result.turns[0]?.items[0]?.semantic)
        .includes("PRIVATE-NONCE"),
      false,
    );
    assert.equal(
      JSON.stringify(result.turns[0]?.items[0]?.semantic)
        .includes("PRIVATE-TOKEN"),
      false,
    );
    const rawTool = (
      client.threadReadOverride as {
        thread: {
          turns: Array<{
            items: Array<{ arguments: unknown }>;
          }>;
        };
      }
    ).thread.turns[0]!.items[0]!;
    rawTool.arguments = {
      verificationCaseId: "cross_source_present",
      nonce: "DIFFERENT-RAW-PRIVATE-NONCE",
      token: "DIFFERENT-RAW-PRIVATE-TOKEN",
    };
    const replay = await shellControl.readThreadWithTurns({
      threadId: "THREAD-1",
      includeTurns: true,
    });
    assert.deepEqual(
      replay.turns,
      result.turns,
      "raw MCP arguments must not change normalized snapshots, hashes, cursors, or projection",
    );
  });

  it("extracts allowlisted auth evidence outside normalized semantics", async () => {
    const { client, shellControl } = fixture();
    const argumentsValue = {
      action: "present",
      verificationCaseId: "cross_source_present",
      threadId: "THREAD-CROSS",
      nonce: "RAW-PRIVATE-NONCE",
    };
    client.threadReadOverride = {
      thread: {
        id: "THREAD-1",
        name: "[CHG-1] First",
        cwd: "/repo",
        ephemeral: false,
        turns: [{
          id: "TURN-VERIFY",
          items: [{
            type: "mcpToolCall",
            id: "ITEM-VERIFY",
            server: "stagepass-phase0-run",
            tool: "present_phase0_card",
            status: "failed",
            arguments: argumentsValue,
            result: null,
            error: { code: "source_thread_mismatch" },
          }],
        }],
      },
    };
    const evidence = await shellControl.readPhase0VerificationToolEvidence?.({
      threadId: "THREAD-1",
      turnId: "TURN-VERIFY",
      registrationName: "stagepass-phase0-run",
    });
    assert.deepEqual(evidence, [{
      itemId: "ITEM-VERIFY",
      toolName: "stagepass-phase0-run/present_phase0_card",
      caseId: "cross_source_present",
      canonicalArgumentsHash:
        codexPhase0VerificationArgumentsHash(argumentsValue),
      status: "failed",
      errorCode: "source_thread_mismatch",
    }]);
    assert.equal(JSON.stringify(evidence).includes("RAW-PRIVATE-NONCE"), false);
  });

  it("aborts timed reads, awaits cleanup, and caps active clients", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let closeCalls = 0;
    let cleanupFinished = false;
    const hangingClient: AppServerShellClient = {
      async initialize() {
        return { userAgent: "codex-test/1.2.3" };
      },
      async request() {
        requestStarted();
        return new Promise<never>(() => {});
      },
      async close() {
        closeCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        cleanupFinished = true;
      },
    };
    const shellControl = createCodexAppServerShellControl({
      appServerBinary: TEST_APP_SERVER_BINARY,
      clientFactory: () => hangingClient,
      verifyAppServerBinary: async () => {},
      maxActiveClients: 1,
    });
    const controller = new AbortController();
    const first = shellControl.readThreadWithTurns({
      threadId: "THREAD-1",
      includeTurns: true,
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      signal: controller.signal,
    });
    await started;
    await assert.rejects(
      shellControl.readThreadWithTurns({
        threadId: "THREAD-2",
        includeTurns: true,
      }),
      /active client limit/,
    );
    controller.abort();
    await assert.rejects(first, /read aborted/);
    assert.equal(closeCalls, 1);
    assert.equal(cleanupFinished, true);
  });

  it("fails closed on malformed file-change fields and kinds", async () => {
    for (const change of [
      {
        path: "src/a.ts",
        kind: { type: "update", move_path: null },
        diff: "@@",
        privateField: true,
      },
      {
        path: "src/a.ts",
        kind: { type: "rename" },
        diff: "@@",
      },
      {
        path: "src/a.ts",
        kind: { type: "add", unexpected: true },
        diff: "@@",
      },
    ]) {
      const { client, shellControl } = fixture();
      client.threadReadOverride = {
        thread: {
          id: "THREAD-1",
          name: "[CHG-1] First",
          cwd: "/repo",
          ephemeral: false,
          turns: [{
            id: "TURN-1",
            itemsView: "full",
            status: "inProgress",
            startedAt: 100,
            completedAt: null,
            durationMs: null,
            error: null,
            items: [{
              type: "fileChange",
              id: "ITEM-FILE",
              changes: [change],
              status: "completed",
            }],
          }],
        },
      };
      await assert.rejects(
        () => shellControl.readThreadWithTurns({
          threadId: "THREAD-1",
          includeTurns: true,
        }),
        (error: unknown) =>
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "turn_snapshot_invalid",
      );
    }
  });

  it("fails closed on terminal fields inconsistent with status", async () => {
    const malformedTurns = [
      {
        id: "TURN-1",
        itemsView: "full",
        status: "inProgress",
        startedAt: 100,
        completedAt: 101,
        durationMs: 1_000,
        error: null,
        items: [],
      },
      {
        id: "TURN-1",
        itemsView: "full",
        status: "completed",
        startedAt: 100,
        completedAt: 101,
        durationMs: 1_000,
        error: { message: "must be null" },
        items: [],
      },
      {
        id: "TURN-1",
        itemsView: "full",
        status: "failed",
        startedAt: 100,
        completedAt: 101,
        durationMs: 1_000,
        error: {
          message: "failed",
          codexErrorInfo: { unknown: {} },
          additionalDetails: null,
        },
        items: [],
      },
      {
        id: "TURN-1",
        itemsView: "full",
        status: "interrupted",
        startedAt: 100,
        completedAt: 101,
        durationMs: 1_000,
        error: {
          message: "unexpected",
          codexErrorInfo: null,
          additionalDetails: null,
        },
        items: [],
      },
    ];
    for (const turn of malformedTurns) {
      const { client, shellControl } = fixture();
      client.threadReadOverride = {
        thread: {
          id: "THREAD-1",
          name: "[CHG-1] First",
          cwd: "/repo",
          ephemeral: false,
          turns: [turn],
        },
      };
      await assert.rejects(
        () => shellControl.readThreadWithTurns({
          threadId: "THREAD-1",
          includeTurns: true,
        }),
        (error: unknown) =>
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "turn_snapshot_invalid",
      );
    }
  });
});
