import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CodexAppServerShellControl } from "./codex-app-server-shell-control.ts";
import {
  CodexDesktopBridgeError,
  codexTurnSetSemanticHash,
  createCodexDesktopBridge,
  createPhase0InMemoryLogicalTurnPort,
  createPhase0InMemoryStartAttemptPort,
} from "./codex-desktop-bridge.ts";
import {
  createCodexDesktopProcessProbe,
  discoverCodexDesktopIpcEndpoint,
  type CodexDesktopDiscoveryFileSystem,
  type CodexDesktopProbeCommandRunner,
  type CodexDesktopProcessProbe,
} from "./codex-desktop-ipc-discovery.ts";
import {
  assertCodexDesktopEndpointIdentity,
  CodexDesktopFollowerRoutingError,
  desktopFollowerProtocolCapabilities,
  desktopFollowerProtocolFingerprint,
  type CodexDesktopFollowerTransport,
} from "./codex-desktop-ipc-transport.ts";
import {
  REQUIRED_APP_SERVER_SHELL_CAPABILITIES,
  REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES,
  type CodexDesktopTurnRequest,
  type CodexFollowerStartFence,
  type CodexFollowerStartAttemptPort,
  type CodexLogicalTurnRole,
  type CodexModel,
  type NormalizedCodexTurnItem,
  type CodexPersistentShell,
  type CodexShellProvisionFence,
  type CodexShellProvisionIntent,
  type CodexShellProvisionPort,
  type CodexTurnSnapshot,
  type CodexTurnPollResult,
} from "./codex-desktop-bridge-types.ts";

function turnSnapshot(
  status: CodexTurnSnapshot["status"],
  values: Array<Record<string, unknown>>,
): CodexTurnSnapshot {
  const items: NormalizedCodexTurnItem[] = values.map((value) => {
    if (typeof value.kind === "string" && typeof value.semantic === "object") {
      return value as unknown as NormalizedCodexTurnItem;
    }
    const id = String(value.id);
    if (value.type === "agentMessage") {
      return {
        id,
        kind: "agent_message",
        semantic: { text: typeof value.text === "string" ? value.text : "" },
      };
    }
    return {
      id,
      kind: "user_message",
      semantic: { text: typeof value.text === "string" ? value.text : id },
    };
  });
  return {
    threadId: "THREAD-1",
    turnId: "TURN-1",
    status,
    items,
    metadata: {
      startedAt: "2026-07-23T00:00:00.000Z",
      observedAt: "2026-07-23T00:00:02.000Z",
    },
    ...(status === "completed"
      ? {
        terminal: { output: "done" },
        metadata: {
          startedAt: "2026-07-23T00:00:00.000Z",
          completedAt: "2026-07-23T00:00:01.000Z",
          durationMs: 1_000,
          observedAt: "2026-07-23T00:00:02.000Z",
        },
      }
      : {}),
  };
}

const fakeShellControlsByThread = new Map<string, FakeShellControl>();

class FakeShellControl implements CodexAppServerShellControl {
  capabilities = [...REQUIRED_APP_SERVER_SHELL_CAPABILITIES];
  protocolCapabilities = [...REQUIRED_APP_SERVER_SHELL_CAPABILITIES];
  readonly shells = new Map<string, CodexPersistentShell>();
  readonly startThreadCalls: Array<{ cwd: string; ephemeral: false }> = [];
  readonly atomicProvisionCalls: Array<{
    cwd: string;
    ephemeral: false;
    name: string;
    deadlineAt: string;
  }> = [];
  readonly nameCalls: Array<{ threadId: string; name: string }> = [];
  readonly threadReadCalls: Array<{
    threadId: string;
    includeTurns: true;
  }> = [];
  readonly materializationTurns = new Map<string, CodexTurnSnapshot>();
  readonly materializationTurnDuplicates =
    new Map<string, CodexTurnSnapshot[]>();
  materializationTurnTransform?: (
    snapshot: CodexTurnSnapshot,
  ) => CodexTurnSnapshot[];
  turnStartCalls = 0;
  probeCalls = 0;
  readResults: Array<CodexTurnSnapshot[] | Error> = [
    [turnSnapshot("completed", [{ id: "ITEM-1" }])],
  ];
  readHook?: (
    input: { threadId: string; includeTurns: true },
  ) => Promise<CodexTurnSnapshot[]>;

  async probe() {
    this.probeCalls += 1;
    return {
      version: "app-server-test",
      protocolFingerprint: "app-server-fingerprint",
      capabilities: this.capabilities,
      protocolCapabilities: this.protocolCapabilities,
    };
  }

  async startPersistentThread(input: { cwd: string; ephemeral: false }) {
    this.startThreadCalls.push(input);
    const threadId = `THREAD-${this.startThreadCalls.length}`;
    this.shells.set(threadId, {
      threadId,
      title: "",
      cwd: input.cwd,
      ephemeral: false,
    });
    fakeShellControlsByThread.set(threadId, this);
    return { threadId };
  }

  recordMaterializationTurn(
    threadId: string,
    turnId: string,
    prompt: string,
  ): void {
    const snapshot: CodexTurnSnapshot = {
      threadId,
      turnId,
      status: "completed",
      items: [{
        id: `USER-${turnId}`,
        kind: "user_message",
        semantic: { text: prompt },
      }],
      terminal: { output: "STAGEPASS_SHELL_MATERIALIZED" },
      metadata: {
        completedAt: "2026-07-23T00:00:01.000Z",
        observedAt: "2026-07-23T00:00:02.000Z",
      },
    };
    const snapshots = this.materializationTurnTransform?.(snapshot)
      ?? [snapshot];
    this.materializationTurns.set(threadId, snapshots[0]!);
    this.materializationTurnDuplicates.set(threadId, snapshots.slice(1));
  }

  async startPersistentThreadAndName(input: {
    cwd: string;
    ephemeral: false;
    name: string;
    deadlineAt: string;
    onStarted: (threadId: string) => Promise<void>;
    activate: (threadId: string) => Promise<void>;
    onCheckpoint?: (
      point:
        | "after_thread_start"
        | "after_thread_activation"
        | "after_thread_name",
    ) => void;
  }) {
    this.atomicProvisionCalls.push({
      cwd: input.cwd,
      ephemeral: input.ephemeral,
      name: input.name,
      deadlineAt: input.deadlineAt,
    });
    const created = await this.startPersistentThread({
      cwd: input.cwd,
      ephemeral: false,
    });
    await input.onStarted(created.threadId);
    input.onCheckpoint?.("after_thread_start");
    await input.activate(created.threadId);
    input.onCheckpoint?.("after_thread_activation");
    while (true) {
      try {
        await this.setThreadName({
          threadId: created.threadId,
          name: input.name,
        });
        break;
      } catch (error) {
        if (
          !(error instanceof Error)
          || (
            error.message !== "thread not loaded"
            && error.message !== "thread not found"
          )
        ) {
          throw error;
        }
      }
    }
    input.onCheckpoint?.("after_thread_name");
    return this.shells.get(created.threadId)!;
  }

  async setThreadName(input: { threadId: string; name: string }) {
    this.nameCalls.push(input);
    const shell = this.shells.get(input.threadId);
    if (!shell) throw new Error("missing shell");
    this.shells.set(input.threadId, { ...shell, title: input.name });
  }

  async findPersistentShell(input: { cwd: string; title: string }) {
    return [...this.shells.values()].filter(
      (shell) => shell.cwd === input.cwd && shell.title === input.title,
    );
  }

  async listPersistentShells(input: { cwd: string }) {
    return [...this.shells.values()].filter(
      (shell) => shell.cwd === input.cwd,
    );
  }

  async readPersistentShell(threadId: string) {
    return this.shells.get(threadId) ?? null;
  }

  async readThreadWithTurns(input: {
    threadId: string;
    includeTurns: true;
  }) {
    this.threadReadCalls.push(input);
    if (this.readHook) {
      const turns = await this.readHook(input);
      const shell = this.shells.get(input.threadId) ?? {
        threadId: input.threadId,
        title: "[CHG-1] First",
        cwd: "/repo",
        ephemeral: false as const,
      };
      const materialized = this.materializationTurns.get(input.threadId);
      const duplicates =
        this.materializationTurnDuplicates.get(input.threadId) ?? [];
      return {
        shell,
        turns: [
          ...(materialized ? [materialized, ...duplicates] : []),
          ...turns,
        ],
      };
    }
    const next = this.readResults.length > 1
      ? this.readResults.shift()
      : this.readResults[0];
    if (next instanceof Error) throw next;
    const shell = this.shells.get(input.threadId) ?? {
      threadId: input.threadId,
      title: "[CHG-1] First",
      cwd: "/repo",
      ephemeral: false as const,
    };
    const materialized = this.materializationTurns.get(input.threadId);
    const duplicates =
      this.materializationTurnDuplicates.get(input.threadId) ?? [];
    return {
      shell,
      turns: [
        ...(materialized ? [materialized, ...duplicates] : []),
        ...(next ?? []),
      ],
    };
  }

  async listModels(): Promise<CodexModel[]> {
    return [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test" }];
  }
}

class FakeFollower implements CodexDesktopFollowerTransport {
  capabilities = [...REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES];
  protocolCapabilities = [...REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES];
  responses: Array<
    { status: "started"; turnId: string }
    | { status: "no-client-found" }
    | Error
  > = [{ status: "started", turnId: "TURN-1" }];
  materializationResponses: Array<
    { status: "started"; turnId: string }
    | { status: "no-client-found" }
    | Error
  > = [{ status: "started", turnId: "TURN-SHELL-MATERIALIZATION" }];
  materializationResponseLossAfterCreate = false;
  readonly opened: string[] = [];
  readonly startCalls: CodexDesktopTurnRequest[] = [];
  readonly materializationStartCalls: CodexDesktopTurnRequest[] = [];
  readonly turnsCreatedByAttempt: number[] = [];
  readinessProbeCalls = 0;
  lifecycleSubscriptionCalls = 0;
  readonly interrupted: Array<{ threadId: string; turnId: string }> = [];
  interruptError?: Error;
  openError?: Error;
  probeCalls = 0;

  async probe() {
    this.probeCalls += 1;
    return {
      clientVersion: "desktop-test",
      protocolFingerprint: "follower-fingerprint",
      capabilities: this.capabilities,
      protocolCapabilities: this.protocolCapabilities,
    };
  }

  async openThreadDeepLink(input: { url: `codex://threads/${string}` }) {
    if (this.openError) throw this.openError;
    this.opened.push(input.url);
  }

  async startFollowerTurn(input: CodexDesktopTurnRequest) {
    if (input.prompt.startsWith("Materialize this managed shell.")) {
      this.materializationStartCalls.push(input);
      const response = this.materializationResponses.length > 1
        ? this.materializationResponses.shift()
        : this.materializationResponses[0];
      if (this.materializationResponseLossAfterCreate) {
        this.materializationResponseLossAfterCreate = false;
        const turnId = "TURN-SHELL-MATERIALIZATION";
        fakeShellControlsByThread.get(input.threadId)
          ?.recordMaterializationTurn(input.threadId, turnId, input.prompt);
        throw new Error("materialization response lost");
      }
      if (response instanceof Error) throw response;
      if (response?.status === "started") {
        fakeShellControlsByThread.get(input.threadId)
          ?.recordMaterializationTurn(
            input.threadId,
            response.turnId,
            input.prompt,
          );
      }
      return response ?? { status: "no-client-found" as const };
    }
    this.startCalls.push(input);
    const response = this.responses.length > 1
      ? this.responses.shift()
      : this.responses[0];
    if (response instanceof Error) {
      this.turnsCreatedByAttempt.push(0);
      throw response;
    }
    this.turnsCreatedByAttempt.push(response?.status === "started" ? 1 : 0);
    return response ?? { status: "no-client-found" as const };
  }

  async interruptTurn(input: { threadId: string; turnId: string }) {
    if (this.interruptError) throw this.interruptError;
    this.interrupted.push(input);
  }
}

async function expectBridgeCode(
  body: () => Promise<unknown>,
  code: CodexDesktopBridgeError["code"],
): Promise<void> {
  await assert.rejects(body, (error: unknown) => {
    assert.ok(error instanceof CodexDesktopBridgeError);
    assert.equal(error.code, code);
    return true;
  });
}

function turnRequest(threadId = "THREAD-1"): CodexDesktopTurnRequest {
  return {
    threadId,
    cwd: "/repo",
    prompt: "verify hybrid execution",
    approvalPolicy: "never",
    sandboxMode: "read-only",
  };
}

function startFence(
  logicalTurnId: string,
  overrides: Partial<CodexFollowerStartFence> = {},
): CodexFollowerStartFence {
  return {
    logicalTurnId,
    owner: { kind: "pipeline_job", pipelineJobId: "JOB-1" },
    projectId: "PROJECT-1",
    scopeKind: "change",
    scopeId: "CHG-1",
    workerId: "WORKER-1",
    leaseToken: "LEASE-1",
    ownerAttempt: 1,
    ownerEpoch: 1,
    dispatchSurface: "follower_ipc",
    purpose: "stage_run",
    deadlineAt: "2099-01-01T00:01:00.000Z",
    leaseExpiresAt: "2099-01-01T00:01:00.000Z",
    ...overrides,
  };
}

function phase0Ports() {
  const logicalTurnPort = createPhase0InMemoryLogicalTurnPort();
  return {
    logicalTurnPort,
    startAttemptPort: createPhase0InMemoryStartAttemptPort(
      logicalTurnPort,
      async () => ({
        turnIds: ["TURN-BASELINE"],
        semanticHash: "BASELINE-HASH",
      }),
    ),
    shellProvisionPort: createTestShellProvisionPort(logicalTurnPort),
  };
}

function provisionFence(): CodexShellProvisionFence {
  return {
    ownerId: "TEST-SHELL-WORKER",
    leaseToken: "TEST-SHELL-LEASE",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function createTestShellProvisionPort(
  logicalTurnPort: ReturnType<typeof createPhase0InMemoryLogicalTurnPort>,
): CodexShellProvisionPort {
  const intents = new Map<string, CodexShellProvisionIntent>();
  const scopes = new Map<string, Parameters<CodexShellProvisionPort["claim"]>[0]["scope"]>();
  return {
    async claim(input) {
      const key = `${input.scope.kind}:${input.scope.scopeId}`;
      const existing = intents.get(key);
      if (existing) return { ...existing, created: false };
      const intent: CodexShellProvisionIntent = {
        provisionId: `PROVISION-${intents.size + 1}`,
        cwd: input.cwd,
        title: input.title,
        baselineThreadIds: [...input.baselineThreadIds],
        state: "provisioning",
        created: true,
      };
      intents.set(key, intent);
      scopes.set(key, input.scope);
      return { ...intent };
    },
    async recordCandidate(input) {
      const entry = [...intents.entries()].find(
        ([, intent]) => intent.provisionId === input.provisionId,
      );
      if (
        !entry
        || entry[1].state !== "provisioning"
        || entry[1].candidateThreadId
      ) {
        throw new Error("shell provision candidate CAS was fenced");
      }
      intents.set(entry[0], {
        ...entry[1],
        created: false,
        candidateThreadId: input.threadId,
      });
    },
    async recordBootstrapReady(input) {
      const entry = [...intents.entries()].find(
        ([, intent]) => intent.provisionId === input.provisionId,
      );
      if (
        !entry
        || entry[1].state !== "provisioning"
        || entry[1].candidateThreadId !== input.threadId
        || !input.activationRequested
      ) {
        throw new Error("shell bootstrap proof was fenced");
      }
      intents.set(entry[0], {
        ...entry[1],
        state: "bootstrap_ready",
        created: false,
        candidateThreadId: input.threadId,
      });
    },
    async beginMaterialization(input) {
      const entry = [...intents.entries()].find(
        ([, intent]) => intent.provisionId === input.provisionId,
      );
      if (
        !entry
        || (
          entry[1].state !== "bootstrap_ready"
          && entry[1].state !== "materializing"
        )
        || !entry[1].candidateThreadId
      ) {
        throw new Error("shell materialization was fenced");
      }
      let logicalTurnId = entry[1].materializationLogicalTurnId;
      if (!logicalTurnId) {
        const scope = scopes.get(entry[0]);
        if (!scope) throw new Error("missing shell materialization scope");
        const identity = await logicalTurnPort.resolve({
          owner: scope.kind === "change"
            ? {
              kind: "pipeline_job",
              pipelineJobId: `SHELL-${scope.scopeId}`,
            }
            : {
              kind: "project_ai_run",
              projectAiRunId: `SHELL-${scope.scopeId}`,
            },
          projectId: scope.projectId,
          scopeKind: scope.kind,
          scopeId: scope.scopeId,
          phase: "ShellBootstrap",
          role: "shell_materialization",
          round: 0,
          ordinal: 0,
        });
        logicalTurnId = identity.logicalTurnId;
        await logicalTurnPort.bindStartContext({
          logicalTurnId,
          request: {
            threadId: entry[1].candidateThreadId,
            cwd: entry[1].cwd,
            prompt:
              "Materialize this managed shell. Read the project only and acknowledge readiness.",
            approvalPolicy: "never",
            sandboxMode: "read-only",
          },
          fence: {
            logicalTurnId,
            owner: identity.owner,
            projectId: identity.projectId,
            scopeKind: identity.scopeKind,
            scopeId: identity.scopeId,
            workerId: input.fence.ownerId,
            leaseToken: input.fence.leaseToken,
            ownerAttempt: 1,
            ownerEpoch: 1,
            dispatchSurface: "follower_ipc",
            purpose: "shell_materialization",
            deadlineAt: input.fence.leaseExpiresAt,
            leaseExpiresAt: input.fence.leaseExpiresAt,
          },
        });
      }
      intents.set(entry[0], {
        ...entry[1],
        state: "materializing",
        created: false,
        materializationLogicalTurnId: logicalTurnId,
      });
      return { logicalTurnId };
    },
    async finalizeDurableReady(input) {
      const entry = [...intents.entries()].find(
        ([, intent]) => intent.provisionId === input.provisionId,
      );
      if (
        !entry
        || entry[1].state !== "materializing"
        || entry[1].candidateThreadId !== input.threadId
        || entry[1].materializationLogicalTurnId !== input.logicalTurnId
        || !input.attemptId
        || !input.turnId
        || !input.correlationMarker
      ) {
        throw new Error("shell durable-ready promotion was fenced");
      }
      intents.set(entry[0], {
        ...entry[1],
        state: "durable_ready",
        created: false,
        threadId: input.threadId,
      });
    },
    async failMaterializationProof(input) {
      const entry = [...intents.entries()].find(
        ([, intent]) => intent.provisionId === input.provisionId,
      );
      if (!entry || entry[1].state !== "materializing") {
        throw new Error("shell materialization proof failure was fenced");
      }
      intents.set(entry[0], {
        ...entry[1],
        state: "ambiguous",
        created: false,
        ambiguousReason: input.reason,
      });
    },
    async markAmbiguous(input) {
      const entry = [...intents.entries()].find(
        ([, intent]) => intent.provisionId === input.provisionId,
      );
      if (!entry) throw new Error("missing provision");
      intents.set(entry[0], {
        ...entry[1],
        state: "ambiguous",
        created: false,
        ambiguousReason: input.reason,
      });
    },
    async expireProvisionVisibility(input) {
      const entry = [...intents.entries()].find(
        ([, intent]) => intent.provisionId === input.provisionId,
      );
      if (
        !entry
        || ![
          "provisioning",
          "bootstrap_ready",
          "materializing",
        ].includes(entry[1].state)
      ) {
        throw new Error("shell provision visibility expiry was fenced");
      }
      intents.set(entry[0], {
        ...entry[1],
        state: "ambiguous",
        created: false,
        ambiguousReason: "visibility_timeout",
      });
    },
  };
}

async function startInput(
  logicalTurnPort: ReturnType<typeof createPhase0InMemoryLogicalTurnPort>,
  threadId = "THREAD-1",
  role: CodexLogicalTurnRole = "stage",
  round = 0,
  ordinal = 0,
  request: CodexDesktopTurnRequest = turnRequest(threadId),
) {
  const { logical } = await bindLogicalContext(
    logicalTurnPort,
    role,
    round,
    ordinal,
    request,
  );
  return { logicalTurnId: logical.logicalTurnId };
}

async function bindLogicalContext(
  logicalTurnPort: ReturnType<typeof createPhase0InMemoryLogicalTurnPort>,
  role: CodexLogicalTurnRole,
  round: number,
  ordinal: number,
  request: CodexDesktopTurnRequest,
) {
  const logical = await logicalTurnPort.resolve({
    owner: { kind: "pipeline_job", pipelineJobId: "JOB-1" },
    projectId: "PROJECT-1",
    scopeKind: "change",
    scopeId: "CHG-1",
    phase: role.startsWith("spec_") ? "Spec" : "Stage",
    role,
    round,
    ordinal,
  });
  await logicalTurnPort.bindStartContext({
    logicalTurnId: logical.logicalTurnId,
    request,
    fence: startFence(logical.logicalTurnId, {
      dispatchSurface: logical.dispatchSurface,
      purpose: role === "interaction_wakeup"
        ? "interaction_wakeup"
        : role === "interaction_present"
          ? "interaction_present"
          : "stage_run",
    }),
  });
  return {
    logical,
    fence: startFence(logical.logicalTurnId, {
      dispatchSurface: logical.dispatchSurface,
      purpose: role === "interaction_wakeup"
        ? "interaction_wakeup"
        : role === "interaction_present"
          ? "interaction_present"
          : "stage_run",
    }),
  };
}

describe("Codex hybrid Desktop bridge contract", () => {
  it("activates a compatibility shell in Codex App before proving it", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      ...phase0Ports(),
    });

    const shell = await bridge.provisionPersistentShell!({
      projectPath: "/repo",
      title: "[CHG-1] First",
    });

    assert.equal(shellControl.atomicProvisionCalls.length, 1);
    assert.deepEqual(follower.opened, [
      `codex://threads/${shell.threadId}`,
      `codex://threads/${shell.threadId}`,
    ]);
  });

  it("retries and caches a transient hybrid probe before starting the turn", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    const originalProbe = shellControl.probe.bind(shellControl);
    let transientFailures = 1;
    shellControl.probe = async () => {
      if (transientFailures > 0) {
        transientFailures -= 1;
        throw new Error("transient app-server probe failure");
      }
      return originalProbe();
    };
    const delays: number[] = [];
    const ports = phase0Ports();
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      ...ports,
      async sleep(ms) {
        delays.push(ms);
      },
    });
    const input = await startInput(ports.logicalTurnPort);

    await bridge.startTurn(input);
    await bridge.probe();

    assert.equal(shellControl.probeCalls, 1);
    assert.equal(follower.probeCalls, 2);
    assert.deepEqual(delays, [250]);
    assert.equal(follower.startCalls.length, 1);
  });

  it("accepts only the exact signed 26.721.41059 follower build", () => {
    const identity = {
      bundleIdentifier: "com.openai.codex",
      bundleShortVersion: "26.721.41059",
      bundleVersion: "5848",
      chromiumBaseVersion: "150.0.7871.128",
    };
    const fingerprint = desktopFollowerProtocolFingerprint(identity);
    assert.deepEqual(desktopFollowerProtocolCapabilities({
      clientVersion: "unreported",
      signedBundleIdentity: identity,
      protocolFingerprint: fingerprint,
    }), [...REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES]);

    const drifted = {
      ...identity,
      bundleShortVersion: "26.721.30844",
      bundleVersion: "5813",
    };
    assert.deepEqual(desktopFollowerProtocolCapabilities({
      clientVersion: "unreported",
      signedBundleIdentity: drifted,
      protocolFingerprint: desktopFollowerProtocolFingerprint(drifted),
    }), []);
  });

  it("binds follower capability evidence to the exact signed bundle build", () => {
    const required = [...REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES];
    const currentBundleIdentity = {
      bundleIdentifier: "com.openai.codex",
      bundleShortVersion: "26.721.41059",
      bundleVersion: "5848",
      chromiumBaseVersion: "150.0.7871.128",
    };
    const currentFingerprint = [
      "initialize-v0+le32-json+desktop-follower-v1",
      "bundleIdentifier=com.openai.codex",
      "bundleShortVersion=26.721.41059",
      "bundleVersion=5848",
      "chromiumBaseVersion=150.0.7871.128",
    ].join(";");
    assert.deepEqual(desktopFollowerProtocolCapabilities({
      clientVersion: "unreported",
      signedBundleIdentity: currentBundleIdentity,
      protocolFingerprint: currentFingerprint,
    }), required);
    assert.deepEqual(desktopFollowerProtocolCapabilities({
      clientVersion: "unreported",
      signedBundleIdentity: {
        ...currentBundleIdentity,
        chromiumBaseVersion: "150.0.7871.125",
      },
      protocolFingerprint: currentFingerprint.replace(
        "150.0.7871.128",
        "150.0.7871.125",
      ),
      behaviorEvidence: {
        protocolFingerprint: currentFingerprint,
        capabilities: required,
      },
    }), []);
  });

  it("fails closed for unknown Desktop fingerprints unless behavior evidence matches exactly", () => {
    const fingerprint =
      "initialize-v0+le32-json+desktop-follower-v1;"
      + "bundleIdentifier=com.openai.codex;"
      + "bundleShortVersion=26.721.30844;"
      + "bundleVersion=5813;"
      + "chromiumBaseVersion=150.0.7871.125";
    const signedBundleIdentity = {
      bundleIdentifier: "com.openai.codex",
      bundleShortVersion: "26.721.30844",
      bundleVersion: "5813",
      chromiumBaseVersion: "150.0.7871.125",
    };
    const required = [...REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES];
    assert.deepEqual(desktopFollowerProtocolCapabilities({
      clientVersion: "unreported",
      signedBundleIdentity,
      protocolFingerprint: fingerprint,
    }), []);
    assert.deepEqual(desktopFollowerProtocolCapabilities({
      clientVersion: "unreported",
      signedBundleIdentity,
      protocolFingerprint: fingerprint,
      behaviorEvidence: {
        protocolFingerprint: `${fingerprint}-mismatch`,
        capabilities: required,
      },
    }), []);
    assert.deepEqual(desktopFollowerProtocolCapabilities({
      clientVersion: "unreported",
      signedBundleIdentity,
      protocolFingerprint: fingerprint,
      behaviorEvidence: {
        protocolFingerprint: fingerprint,
        capabilities: required,
      },
    }), required);
  });

  it("probes only shell-control and observed follower capabilities", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    const ports = phase0Ports();
    const result = await createCodexDesktopBridge({
      shellControl,
      follower,
      ...ports,
    }).probe();

    assert.deepEqual(result.shellCapabilities, shellControl.capabilities);
    assert.deepEqual(result.followerCapabilities, follower.capabilities);
    assert.equal("mcpHostCapabilities" in result, false);
    assert.equal(
      result.followerCapabilities.includes("renderer-follower-ready"),
      false,
    );
  });

  it("does not invent unobserved capabilities during preflight", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    const ports = phase0Ports();
    follower.capabilities = [];
    const probe = await createCodexDesktopBridge({
      shellControl,
      follower,
      ...ports,
    }).probe();
    assert.deepEqual(probe.followerCapabilities, []);
  });

  it("fails closed when the protocol-supported layer is incomplete", async () => {
    const follower = new FakeFollower();
    follower.protocolCapabilities = follower.protocolCapabilities.filter(
      (capability) => capability !== "project/alternate-cwd",
    );
    await expectBridgeCode(
      () => createCodexDesktopBridge({
        shellControl: new FakeShellControl(),
        follower,
        ...phase0Ports(),
      }).probe(),
      "codex_hybrid_bridge_unsupported",
    );
  });

  it("accepts only the closed Change PRD and Context shell scopes", async () => {
    const shellControl = new FakeShellControl();
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower: new FakeFollower(),
      ...phase0Ports(),
    });
    const scopes = [
      {
        kind: "change" as const,
        scopeId: "CHG-1",
        projectId: "PROJECT-1",
        changeId: "CHG-1",
      },
      {
        kind: "project_prd" as const,
        scopeId: "PROJECT-1",
        projectId: "PROJECT-1",
      },
      {
        kind: "project_context" as const,
        scopeId: "PROJECT-1",
        projectId: "PROJECT-1",
      },
    ];
    for (const scope of scopes) {
      await bridge.ensurePersistentShell({
        projectPath: "/repo",
        provisionFence: provisionFence(),
        scope,
        title: `[${scope.kind}] shell`,
      });
    }
    assert.equal(shellControl.startThreadCalls.length, 3);
    await expectBridgeCode(
      () => bridge.ensurePersistentShell({
        projectPath: "/repo",
        provisionFence: provisionFence(),
        scope: {
          kind: "project_prd",
          scopeId: "not-project",
          projectId: "PROJECT-1",
        },
        title: "invalid",
      }),
      "desktop_protocol_invalid",
    );
  });

  it("provisions a persistent shell and retries only explicit no-client-found", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    follower.responses = [
      { status: "no-client-found" },
      { status: "started", turnId: "TURN-1" },
    ];
    let now = 0;
    const ports = phase0Ports();
    let candidateRecorded = false;
    const persistedProvision = ports.shellProvisionPort;
    const shellProvisionPort: CodexShellProvisionPort = {
      ...persistedProvision,
      async recordCandidate(input) {
        await persistedProvision.recordCandidate(input);
        candidateRecorded = true;
      },
    };
    const openThreadDeepLink =
      follower.openThreadDeepLink.bind(follower);
    follower.openThreadDeepLink = async (input) => {
      assert.equal(candidateRecorded, true);
      await openThreadDeepLink(input);
    };
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      ...ports,
      shellProvisionPort,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const shell = await bridge.ensurePersistentShell({
      projectPath: "/repo",
      provisionFence: provisionFence(),
      scope: {
        kind: "change",
        scopeId: "CHG-1",
        projectId: "PROJECT-1",
        changeId: "CHG-1",
      },
      title: "[CHG-1] First",
    });
    const durableReuse = await bridge.ensurePersistentShell({
      projectPath: "/repo",
      provisionFence: provisionFence(),
      scope: {
        kind: "change",
        scopeId: "CHG-1",
        projectId: "PROJECT-1",
        changeId: "CHG-1",
      },
      title: "[CHG-1] First",
    });
    assert.equal(durableReuse.threadId, shell.threadId);
    assert.deepEqual(follower.opened, [
      `codex://threads/${shell.threadId}`,
      `codex://threads/${shell.threadId}`,
    ]);
    assert.equal(follower.materializationStartCalls.length, 1);
    const started = await bridge.startTurn(
      await startInput(ports.logicalTurnPort, shell.threadId),
    );
    const observations: CodexTurnPollResult[] = [];
    for await (const observation of bridge.pollTurn({
      threadId: shell.threadId,
      turnId: started.turnId,
      deadlineAt: new Date(now + 10_000).toISOString(),
    })) {
      observations.push(observation);
    }

    assert.deepEqual(shellControl.startThreadCalls, [{
      cwd: "/repo",
      ephemeral: false,
    }]);
    assert.equal(shellControl.atomicProvisionCalls.length, 1);
    assert.equal(shellControl.turnStartCalls, 0);
    assert.deepEqual(follower.turnsCreatedByAttempt, [0, 1]);
    assert.equal(follower.readinessProbeCalls, 0);
    assert.equal(follower.lifecycleSubscriptionCalls, 0);
    assert.equal(
      shellControl.threadReadCalls.at(-1)?.threadId,
      shell.threadId,
    );
    assert.equal(shellControl.threadReadCalls.at(-1)?.includeTurns, true);
    assert.equal(
      observations.findLast(({ kind }) => kind === "observation")
        ?.snapshot.status,
      "completed",
    );
  });

  it("retries materialization no-client on one candidate and one attempt", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    follower.materializationResponses = [
      { status: "no-client-found" },
      { status: "started", turnId: "TURN-SHELL-MATERIALIZATION" },
    ];
    let now = 0;
    const ports = phase0Ports();
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      ...ports,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    const shell = await bridge.ensurePersistentShell({
      projectPath: "/repo",
      provisionFence: provisionFence(),
      scope: {
        kind: "change",
        scopeId: "CHG-1",
        projectId: "PROJECT-1",
        changeId: "CHG-1",
      },
      title: "[CHG-1] First",
    });

    assert.equal(shell.threadId, "THREAD-1");
    assert.equal(shellControl.startThreadCalls.length, 1);
    assert.equal(follower.materializationStartCalls.length, 2);
    assert.equal(
      new Set(
        follower.materializationStartCalls.map(({ prompt }) => prompt),
      ).size,
      1,
    );
  });

  it("adopts one response-lost materialization turn without redispatch", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    follower.materializationResponseLossAfterCreate = true;
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      ...phase0Ports(),
    });

    const shell = await bridge.ensurePersistentShell({
      projectPath: "/repo",
      provisionFence: provisionFence(),
      scope: {
        kind: "change",
        scopeId: "CHG-1",
        projectId: "PROJECT-1",
        changeId: "CHG-1",
      },
      title: "[CHG-1] First",
    });

    assert.equal(shell.threadId, "THREAD-1");
    assert.equal(shellControl.startThreadCalls.length, 1);
    assert.equal(follower.materializationStartCalls.length, 1);
  });

  it("repeats only independent proof after durable-promotion crash", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    const ports = phase0Ports();
    const durableProvision = ports.shellProvisionPort;
    let promotionCalls = 0;
    const shellProvisionPort: CodexShellProvisionPort = {
      ...durableProvision,
      async finalizeDurableReady(input) {
        promotionCalls += 1;
        if (promotionCalls === 1) {
          throw new Error("crash before durable promotion CAS");
        }
        await durableProvision.finalizeDurableReady(input);
      },
    };
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      ...ports,
      shellProvisionPort,
    });
    const input = {
      projectPath: "/repo",
      provisionFence: provisionFence(),
      scope: {
        kind: "change" as const,
        scopeId: "CHG-1",
        projectId: "PROJECT-1",
        changeId: "CHG-1",
      },
      title: "[CHG-1] First",
    };

    await assert.rejects(
      bridge.ensurePersistentShell(input),
      /crash before durable promotion CAS/,
    );
    const shell = await bridge.ensurePersistentShell(input);

    assert.equal(shell.threadId, "THREAD-1");
    assert.equal(promotionCalls, 2);
    assert.equal(shellControl.startThreadCalls.length, 1);
    assert.equal(follower.materializationStartCalls.length, 1);
  });

  it("blocks live materialization proof timeout before provision lease expiry", async () => {
    const shellControl = new FakeShellControl();
    const originalList =
      shellControl.listPersistentShells.bind(shellControl);
    shellControl.listPersistentShells = async (input) =>
      shellControl.materializationTurns.size > 0 ? [] : originalList(input);
    const follower = new FakeFollower();
    let now = 0;
    const ports = phase0Ports();
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      ...ports,
      readinessDeadlineMs: 100,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const input = {
      projectPath: "/repo",
      provisionFence: {
        ...provisionFence(),
        leaseExpiresAt: new Date(10_000).toISOString(),
      },
      scope: {
        kind: "change" as const,
        scopeId: "CHG-1",
        projectId: "PROJECT-1",
        changeId: "CHG-1",
      },
      title: "[CHG-1] First",
    };

    await expectBridgeCode(
      () => bridge.ensurePersistentShell(input),
      "shell_provision_ambiguous",
    );
    await expectBridgeCode(
      () => bridge.ensurePersistentShell(input),
      "shell_provision_ambiguous",
    );
    assert.equal(now, 100);
    assert.equal(shellControl.startThreadCalls.length, 1);
    assert.equal(follower.materializationStartCalls.length, 1);
    assert.equal(follower.startCalls.length, 0);
  });

  it("requires one terminal effect-free materialization proof", async () => {
    const invalidTransforms: Array<
      (snapshot: CodexTurnSnapshot) => CodexTurnSnapshot[]
    > = [
      (snapshot) => [{
        ...snapshot,
        status: "inProgress",
        terminal: undefined,
      }],
      (snapshot) => [{
        ...snapshot,
        items: [...snapshot.items, {
          id: "FILE-CHANGE",
          kind: "file_change",
          semantic: { path: "README.md", change: "modified" },
        }],
      }],
      (snapshot) => [{
        ...snapshot,
        terminal: { output: " STAGEPASS_SHELL_MATERIALIZED" },
      }],
      (snapshot) => [{
        ...snapshot,
        terminal: { output: "STAGEPASS_SHELL_MATERIALIZED\n" },
      }],
      (snapshot) => [snapshot, { ...snapshot }],
    ];
    for (const transform of invalidTransforms) {
      const shellControl = new FakeShellControl();
      shellControl.materializationTurnTransform = transform;
      const follower = new FakeFollower();
      let now = 0;
      const bridge = createCodexDesktopBridge({
        shellControl,
        follower,
        ...phase0Ports(),
        readinessDeadlineMs: 100,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      });

      await expectBridgeCode(
        () => bridge.ensurePersistentShell({
          projectPath: "/repo",
          provisionFence: {
            ...provisionFence(),
            leaseExpiresAt: new Date(10_000).toISOString(),
          },
          scope: {
            kind: "change",
            scopeId: "CHG-1",
            projectId: "PROJECT-1",
            changeId: "CHG-1",
          },
          title: "[CHG-1] First",
        }),
        "shell_provision_ambiguous",
      );
      assert.equal(follower.materializationStartCalls.length, 1);
      assert.equal(follower.startCalls.length, 0);
    }
  });

  it("preserves and reuses the shell after bounded no-client-found", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    follower.responses = [{ status: "no-client-found" }];
    let now = 0;
    const ports = phase0Ports();
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      ...ports,
      readinessDeadlineMs: 1_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const shell = await bridge.ensurePersistentShell({
      projectPath: "/repo",
      provisionFence: provisionFence(),
      scope: {
        kind: "change",
        scopeId: "CHG-1",
        projectId: "PROJECT-1",
        changeId: "CHG-1",
      },
      title: "[CHG-1] First",
    });
    const exhaustedInput = await startInput(
      ports.logicalTurnPort,
      shell.threadId,
    );
    await expectBridgeCode(
      () => bridge.startTurn(exhaustedInput),
      "desktop_follower_not_ready",
    );
    const reused = await bridge.ensurePersistentShell({
      projectPath: "/repo",
      provisionFence: provisionFence(),
      scope: {
        kind: "change",
        scopeId: "CHG-1",
        projectId: "PROJECT-1",
        changeId: "CHG-1",
      },
      title: "[CHG-1] First",
    });
    follower.responses = [
      { status: "started", turnId: "TURN-1" },
      { status: "started", turnId: "TURN-2" },
    ];
    await bridge.startTurn(
      await startInput(ports.logicalTurnPort, reused.threadId, "spec_writer"),
    );
    await bridge.startTurn(
      await startInput(ports.logicalTurnPort, reused.threadId, "spec_critic"),
    );

    assert.equal(shellControl.startThreadCalls.length, 1);
    assert.equal(
      follower.turnsCreatedByAttempt.filter((count) => count === 1).length,
      2,
    );
  });

  it("fails closed on lost creator-session start or name responses", async () => {
    const scope = {
      kind: "change" as const,
      scopeId: "CHG-1",
      projectId: "PROJECT-1",
      changeId: "CHG-1",
    };
    {
      const shellControl = new FakeShellControl();
      const originalStart = shellControl.startPersistentThread.bind(shellControl);
      shellControl.startPersistentThread = async (input) => {
        await originalStart(input);
        throw new Error("start response lost");
      };
      const bridge = createCodexDesktopBridge({
        shellControl,
        follower: new FakeFollower(),
        ...phase0Ports(),
      });
      await expectBridgeCode(
        () => bridge.ensurePersistentShell({
          projectPath: "/repo",
          provisionFence: provisionFence(),
          scope,
          title: "[CHG-1] First",
        }),
        "shell_provision_ambiguous",
      );
      assert.equal(shellControl.startThreadCalls.length, 1);
    }
    {
      const shellControl = new FakeShellControl();
      const originalName = shellControl.setThreadName.bind(shellControl);
      shellControl.setThreadName = async (input) => {
        await originalName(input);
        throw new Error("name response lost");
      };
      const bridge = createCodexDesktopBridge({
        shellControl,
        follower: new FakeFollower(),
        ...phase0Ports(),
      });
      await expectBridgeCode(
        () => bridge.ensurePersistentShell({
          projectPath: "/repo",
          provisionFence: provisionFence(),
          scope,
          title: "[CHG-1] First",
        }),
        "shell_provision_ambiguous",
      );
      assert.equal(shellControl.startThreadCalls.length, 1);
    }
  });

  it("polls real thread-not-loaded visibility lag without restarting", async () => {
    const shellControl = new FakeShellControl();
    const originalRead =
      shellControl.readPersistentShell.bind(shellControl);
    const originalList =
      shellControl.listPersistentShells.bind(shellControl);
    const originalName = shellControl.setThreadName.bind(shellControl);
    let readLag = 2;
    let listLag = 2;
    let nameLag = 1;
    let nameAttempts = 0;
    shellControl.readPersistentShell = async (threadId) => {
      if (shellControl.startThreadCalls.length > 0 && readLag > 0) {
        readLag -= 1;
        throw new Error("thread not loaded");
      }
      return originalRead(threadId);
    };
    shellControl.listPersistentShells = async (input) => {
      if (shellControl.startThreadCalls.length > 0 && listLag > 0) {
        listLag -= 1;
        throw new Error("thread not found");
      }
      return originalList(input);
    };
    shellControl.setThreadName = async (input) => {
      nameAttempts += 1;
      if (nameLag > 0) {
        nameLag -= 1;
        throw new Error("thread not loaded");
      }
      return originalName(input);
    };
    let now = 0;
    let cursorAllocations = 0;
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower: new FakeFollower(),
      ...phase0Ports(),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      allocateCursor: async (cursor) => {
        cursorAllocations += 1;
        return cursor + 1;
      },
    });

    const shell = await bridge.ensurePersistentShell({
      projectPath: "/repo",
      provisionFence: {
        ...provisionFence(),
        leaseExpiresAt: new Date(2_000).toISOString(),
      },
      scope: {
        kind: "change",
        scopeId: "CHG-1",
        projectId: "PROJECT-1",
        changeId: "CHG-1",
      },
      title: "[CHG-1] First",
    });

    assert.equal(shell.threadId, "THREAD-1");
    assert.equal(shell.title, "[CHG-1] First");
    assert.equal(shellControl.startThreadCalls.length, 1);
    assert.ok(nameAttempts >= 2);
    assert.equal(readLag, 2);
    assert.equal(listLag, 0);
    assert.equal(cursorAllocations, 0);
  });

  it("does not activate or name a started thread when candidate recording is fenced", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    const ports = phase0Ports();
    const persistedProvision = ports.shellProvisionPort;
    const shellProvisionPort: CodexShellProvisionPort = {
      ...persistedProvision,
      async recordCandidate() {
        throw new Error("shell provision candidate CAS was fenced");
      },
    };
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      ...ports,
      shellProvisionPort,
    });

    await assert.rejects(
      bridge.ensurePersistentShell({
        projectPath: "/repo",
        provisionFence: provisionFence(),
        scope: {
          kind: "change",
          scopeId: "CHG-1",
          projectId: "PROJECT-1",
          changeId: "CHG-1",
        },
        title: "[CHG-1] First",
      }),
      /candidate CAS was fenced/,
    );
    assert.equal(shellControl.startThreadCalls.length, 1);
    assert.deepEqual(follower.opened, []);
    assert.deepEqual(shellControl.nameCalls, []);
    assert.equal(shellControl.turnStartCalls, 0);
  });

  it("times out zero visibility without issuing a second thread start", async () => {
    const shellControl = new FakeShellControl();
    const originalList =
      shellControl.listPersistentShells.bind(shellControl);
    shellControl.readPersistentShell = async () => {
      throw new Error("thread not loaded");
    };
    shellControl.listPersistentShells = async (input) =>
      shellControl.startThreadCalls.length > 0 ? [] : originalList(input);
    let now = 0;
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower: new FakeFollower(),
      ...phase0Ports(),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const input = {
      projectPath: "/repo",
      provisionFence: {
        ...provisionFence(),
        leaseExpiresAt: new Date(100).toISOString(),
      },
      scope: {
        kind: "change" as const,
        scopeId: "CHG-1",
        projectId: "PROJECT-1",
        changeId: "CHG-1",
      },
      title: "[CHG-1] First",
    };

    await assert.rejects(
      bridge.ensurePersistentShell(input),
      (error: unknown) =>
        error instanceof CodexDesktopBridgeError
        && error.code === "shell_provision_ambiguous"
        && /provision deadline expired/i.test(error.message),
    );
    await expectBridgeCode(
      () => bridge.ensurePersistentShell(input),
      "shell_provision_ambiguous",
    );
    assert.equal(shellControl.startThreadCalls.length, 1);
  });

  it("materializes only the recorded candidate despite concurrent shells", async () => {
    const shellControl = new FakeShellControl();
    const originalList =
      shellControl.listPersistentShells.bind(shellControl);
    shellControl.listPersistentShells = async (input) => {
      const shells = await originalList(input);
      return shellControl.startThreadCalls.length > 0
        ? [
            ...shells,
            {
              threadId: "THREAD-CONCURRENT",
              cwd: input.cwd,
              title: "",
              ephemeral: false,
            },
          ]
        : shells;
    };
    let sleepCalls = 0;
    let now = 0;
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower: new FakeFollower(),
      ...phase0Ports(),
      now: () => now,
      sleep: async (ms) => {
        sleepCalls += 1;
        now += ms;
      },
    });

    const shell = await bridge.ensurePersistentShell({
      projectPath: "/repo",
      provisionFence: {
        ...provisionFence(),
        leaseExpiresAt: new Date(100).toISOString(),
      },
      scope: {
        kind: "change",
        scopeId: "CHG-1",
        projectId: "PROJECT-1",
        changeId: "CHG-1",
      },
      title: "[CHG-1] First",
    });
    assert.equal(shell.threadId, "THREAD-1");
    assert.equal(shellControl.startThreadCalls.length, 1);
    assert.equal(sleepCalls, 0);
  });

  it("fails closed on non-visibility provisioning errors", async () => {
    const shellControl = new FakeShellControl();
    const originalList =
      shellControl.listPersistentShells.bind(shellControl);
    shellControl.listPersistentShells = async (input) => {
      if (shellControl.startThreadCalls.length > 0) {
        throw new Error("protocol schema mismatch");
      }
      return originalList(input);
    };
    let sleepCalls = 0;
    let now = 0;
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower: new FakeFollower(),
      ...phase0Ports(),
      readinessDeadlineMs: 100,
      now: () => now,
      sleep: async (ms) => {
        sleepCalls += 1;
        now += ms;
      },
    });

    await expectBridgeCode(
      () => bridge.ensurePersistentShell({
        projectPath: "/repo",
        provisionFence: provisionFence(),
        scope: {
          kind: "change",
          scopeId: "CHG-1",
          projectId: "PROJECT-1",
          changeId: "CHG-1",
        },
        title: "[CHG-1] First",
      }),
      "shell_provision_ambiguous",
    );
    assert.equal(shellControl.startThreadCalls.length, 1);
    assert.ok(sleepCalls > 0);
  });

  it("blocks a retry after a zero-candidate lost shell response", async () => {
    const shellControl = new FakeShellControl();
    let startCalls = 0;
    let now = 0;
    shellControl.startPersistentThread = async () => {
      startCalls += 1;
      throw new Error("unknown start result");
    };
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower: new FakeFollower(),
      ...phase0Ports(),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const input = {
      projectPath: "/repo",
      provisionFence: {
        ...provisionFence(),
        leaseExpiresAt: new Date(100).toISOString(),
      },
      scope: {
        kind: "change" as const,
        scopeId: "CHG-1",
        projectId: "PROJECT-1",
        changeId: "CHG-1",
      },
      title: "[CHG-1] First",
    };
    await expectBridgeCode(
      () => bridge.ensurePersistentShell(input),
      "shell_provision_ambiguous",
    );
    await expectBridgeCode(
      () => bridge.ensurePersistentShell(input),
      "shell_provision_ambiguous",
    );
    assert.equal(startCalls, 1);
  });

  it("does not retry an ambiguous follower start failure", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    follower.responses = [new CodexDesktopBridgeError(
      "desktop_bridge_unavailable",
      "connection_lost",
    )];
    let now = 0;
    const ports = phase0Ports();
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      ...ports,
      readinessDeadlineMs: 1_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    const input = await startInput(ports.logicalTurnPort);
    await expectBridgeCode(
      () => bridge.startTurn(input),
      "desktop_follower_start_ambiguous",
    );
    assert.equal(follower.startCalls.length, 1);
  });

  it("preserves a tagged Phase 0 crash raised after prepare", async () => {
    const ports = phase0Ports();
    const persistedStartAttemptPort = ports.startAttemptPort;
    const taggedCrash = Object.assign(
      new Error("phase0 journal failpoint: after_prepare"),
      { phase0CrashCheckpoint: "after_prepare" },
    );
    const bridge = createCodexDesktopBridge({
      shellControl: new FakeShellControl(),
      follower: new FakeFollower(),
      ...ports,
      startAttemptPort: {
        ...persistedStartAttemptPort,
        async prepare(input) {
          await persistedStartAttemptPort.prepare(input);
          throw taggedCrash;
        },
      },
    });
    const input = await startInput(ports.logicalTurnPort);

    await assert.rejects(
      () => bridge.startTurn(input),
      (error: unknown) => error === taggedCrash,
    );
  });

  it("does not misreport a baseline read failure as an active attempt conflict", async () => {
    const ports = phase0Ports();
    const bridge = createCodexDesktopBridge({
      shellControl: new FakeShellControl(),
      follower: new FakeFollower(),
      ...ports,
      startAttemptPort: {
        ...ports.startAttemptPort,
        async prepare() {
          throw new Error("no rollout found for thread id THREAD-1");
        },
      },
    });
    const input = await startInput(ports.logicalTurnPort);

    await assert.rejects(
      () => bridge.startTurn(input),
      (error: unknown) =>
        error instanceof CodexDesktopBridgeError
        && error.code === "desktop_follower_start_ambiguous"
        && /baseline could not be prepared/.test(error.message)
        && /no rollout found for thread id THREAD-1/.test(error.message)
        && !/active follower-start attempt/.test(error.message),
    );
  });

  it("keeps a crash-before-dispatch checkpoint prepared and schedulable", async () => {
    const ports = phase0Ports();
    const port = ports.startAttemptPort;
    const request = turnRequest();
    const { fence } = await bindLogicalContext(
      ports.logicalTurnPort,
      "stage",
      0,
      0,
      request,
    );
    const attemptId = "ATTEMPT-PREPARED";
    await port.prepare({
      attemptId,
      logicalTurnId: fence.logicalTurnId,
    });

    assert.equal((await port.inspect(attemptId))?.state, "prepared");
    assert.equal(
      await port.claimDispatch({ attemptId, fence }),
      1,
    );
  });

  it("keeps deep-link failure before the dispatch CAS safely prepared", async () => {
    const ports = phase0Ports();
    const follower = new FakeFollower();
    follower.openError = new Error("deep link unavailable");
    const bridge = createCodexDesktopBridge({
      shellControl: new FakeShellControl(),
      follower,
      ...ports,
    });
    const input = await startInput(ports.logicalTurnPort);
    await assert.rejects(() => bridge.startTurn(input), /deep link unavailable/);
    const attempt = await ports.startAttemptPort.inspectByLogicalTurn(
      input.logicalTurnId,
    );
    assert.equal(attempt?.state, "prepared");
    assert.equal(attempt?.dispatchOrdinal, 0);
    assert.equal(follower.startCalls.length, 0);
  });

  it("resolves stable logical slots and isolates Spec role turns", async () => {
    const port = createPhase0InMemoryLogicalTurnPort();
    const base = {
      owner: { kind: "pipeline_job", pipelineJobId: "JOB-1" } as const,
      projectId: "PROJECT-1",
      scopeKind: "change" as const,
      scopeId: "CHG-1",
      phase: "Spec",
      round: 2,
      ordinal: 0,
    };
    const first = await port.resolve({
      ...base,
      role: "spec_writer",
    });
    const duplicate = await port.resolve({
      ...base,
      role: "spec_writer",
      retry: 9,
      callerRandom: "ignored",
    } as never);
    const nextRound = await port.resolve({
      ...base,
      role: "spec_writer",
      round: 3,
    });
    const roleIds = await Promise.all(
      (["spec_writer", "spec_critic", "spec_verdict"] as const).map(
        (role) => port.resolve({
          ...base,
          role,
        }),
      ),
    );

    assert.equal(first.logicalTurnId, duplicate.logicalTurnId);
    assert.equal(first.turnSlot, duplicate.turnSlot);
    assert.equal(first.runCorrelationId, duplicate.runCorrelationId);
    assert.notEqual(first.logicalTurnId, nextRound.logicalTurnId);
    assert.equal(
      new Set(roleIds.map(({ logicalTurnId }) => logicalTurnId)).size,
      3,
    );
    assert.equal(new Set(roleIds.map(({ turnSlot }) => turnSlot)).size, 3);
  });

  it("allows only one dispatch for concurrent callers of one logical slot", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    const ports = phase0Ports();
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      ...ports,
    });
    const input = await startInput(ports.logicalTurnPort);

    const results = await Promise.allSettled([
      bridge.startTurn(input),
      bridge.startTurn(input),
    ]);

    assert.equal(
      results.filter(({ status }) => status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter(({ status }) => status === "rejected").length,
      1,
    );
    assert.equal(follower.startCalls.length, 1);
  });

  it("rejects Host ui-message wakeup slots before any follower call", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    const ports = phase0Ports();
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      ...ports,
    });
    const input = await startInput(
      ports.logicalTurnPort,
      "THREAD-1",
      "interaction_wakeup",
    );

    await expectBridgeCode(
      () => bridge.startTurn(input),
      "desktop_protocol_invalid",
    );
    assert.equal(shellControl.probeCalls, 0);
    assert.equal(follower.probeCalls, 0);
    assert.equal(follower.startCalls.length, 0);
  });

  it("rejects invalid model effort and sandbox inputs before follower dispatch", async () => {
    const invalidRequests = [
      {
        ...turnRequest(),
        model: "missing-model",
      },
      {
        ...turnRequest(),
        model: "gpt-test",
        reasoningEffort: "unsupported-effort",
      },
      {
        ...turnRequest(),
        sandboxMode: "danger-full-access",
      },
    ] as unknown as CodexDesktopTurnRequest[];
    for (const [index, request] of invalidRequests.entries()) {
      const ports = phase0Ports();
      const follower = new FakeFollower();
      const bridge = createCodexDesktopBridge({
        shellControl: new FakeShellControl(),
        follower,
        ...ports,
      });
      const input = await startInput(
        ports.logicalTurnPort,
        "THREAD-1",
        "stage",
        index,
        0,
        request,
      );
      await expectBridgeCode(
        () => bridge.startTurn(input),
        "desktop_protocol_invalid",
      );
      assert.equal(follower.startCalls.length, 0);
      assert.equal(follower.opened.length, 0);
    }
  });

  it("hands off only prepared and no-client-found ownership safely", async () => {
    for (const checkpoint of ["prepared", "no_client_found"] as const) {
      const ports = phase0Ports();
      const port = ports.startAttemptPort;
      const request = turnRequest();
      const { fence: currentFence } = await bindLogicalContext(
        ports.logicalTurnPort,
        "stage",
        checkpoint === "prepared" ? 10 : 11,
        0,
        request,
      );
      const nextFence = {
        ...currentFence,
        workerId: "WORKER-2",
        leaseToken: "LEASE-2",
        ownerAttempt: 2,
        ownerEpoch: 2,
      };
      const attemptId = `ATTEMPT-${checkpoint}`;
      await port.prepare({
        attemptId,
        logicalTurnId: currentFence.logicalTurnId,
      });
      if (checkpoint === "no_client_found") {
        const ordinal = await port.claimDispatch({
          attemptId,
          fence: currentFence,
        });
        await port.recordNoClientFound({
          attemptId,
          dispatchOrdinal: ordinal,
          fence: currentFence,
        });
      }
      const beforeHandoff = await port.inspect(attemptId);

      await port.claimSafeAttemptForWorker({
        attemptId,
        expectedState: checkpoint,
        expectedOldFence: currentFence,
        newFence: nextFence,
      });
      await assert.rejects(
        () => port.claimDispatch({ attemptId, fence: currentFence }),
      );
      assert.equal(
        await port.claimDispatch({ attemptId, fence: nextFence }),
        checkpoint === "prepared" ? 1 : 2,
      );
      const retained = await port.inspect(attemptId);
      assert.equal(retained?.attemptId, attemptId);
      assert.equal(
        retained?.correlationMarker,
        beforeHandoff?.correlationMarker,
      );
      assert.deepEqual(retained?.preStartTurnIds, ["TURN-BASELINE"]);
      assert.equal(retained?.preStartSemanticHash, "BASELINE-HASH");
      assert.equal(
        retained?.dispatchOrdinal,
        checkpoint === "prepared" ? 1 : 2,
      );
    }
  });

  it("rejects ownership handoff after dispatch and routes it to recovery", async () => {
    const ports = phase0Ports();
    const port = ports.startAttemptPort;
    const request = turnRequest();
    const { fence: currentFence } = await bindLogicalContext(
      ports.logicalTurnPort,
      "build",
      1,
      0,
      request,
    );
    const nextFence = {
      ...currentFence,
      workerId: "WORKER-2",
      leaseToken: "LEASE-2",
      ownerAttempt: 2,
      ownerEpoch: 2,
    };
    await port.prepare({
      attemptId: "ATTEMPT-DISPATCHING",
      logicalTurnId: currentFence.logicalTurnId,
    });
    await port.claimDispatch({
      attemptId: "ATTEMPT-DISPATCHING",
      fence: currentFence,
    });

    await assert.rejects(
      () => port.claimSafeAttemptForWorker({
        attemptId: "ATTEMPT-DISPATCHING",
        expectedState: "prepared",
        expectedOldFence: currentFence,
        newFence: nextFence,
      }),
    );
    assert.deepEqual(
      await port.claimReconciliation({
        attemptId: "ATTEMPT-DISPATCHING",
        ownerFence: currentFence,
      }),
      {
        ownerFence: currentFence,
      },
    );
  });

  it("fences stale reconciliation owners by recovery epoch", async () => {
    const ports = phase0Ports();
    const port = ports.startAttemptPort;
    const request = turnRequest();
    const { fence } = await bindLogicalContext(
      ports.logicalTurnPort,
      "fix",
      1,
      0,
      request,
    );
    const attemptId = "ATTEMPT-RECOVERY-FENCE";
    await port.prepare({
      attemptId,
      logicalTurnId: fence.logicalTurnId,
    });
    const dispatchOrdinal = await port.claimDispatch({ attemptId, fence });
    await port.recordAmbiguous({
      attemptId,
      dispatchOrdinal,
      reason: "unknown_response",
      fence,
    });
    assert.equal((await port.inspect(attemptId))?.state, "ambiguous");
    const stale = await port.claimReconciliation({
      attemptId,
      ownerFence: fence,
    });
    await assert.rejects(
      () => port.claimReconciliation({
        attemptId,
        ownerFence: fence,
      }),
    );
    const recoveredOwnerFence = {
      ...fence,
      workerId: "RECOVERY-B",
      leaseToken: "RECOVERY-LEASE-B",
      ownerAttempt: 2,
      ownerEpoch: 2,
    };
    const current = await port.claimReconciliation({
      attemptId,
      ownerFence: recoveredOwnerFence,
    });
    await assert.rejects(
      () => port.adoptSuccess({
        attemptId,
        dispatchOrdinal,
        turnId: "TURN-STALE",
        fence: stale,
      }),
    );
    await port.adoptSuccess({
      attemptId,
      dispatchOrdinal,
      turnId: "TURN-CURRENT",
      fence: current,
    });
    assert.equal((await port.inspect(attemptId))?.turnId, "TURN-CURRENT");
  });

  it("rejects adoption when persisted cwd model effort or sandbox differs from the logical request", async () => {
    for (const field of [
      "cwd",
      "model",
      "reasoningEffort",
      "sandboxMode",
    ] as const) {
      const shellControl = new FakeShellControl();
      const follower = new FakeFollower();
      const logicalTurnPort = createPhase0InMemoryLogicalTurnPort();
      const durable = createPhase0InMemoryStartAttemptPort(
        logicalTurnPort,
        async () => ({
          turnIds: ["TURN-BASELINE"],
          semanticHash: "BASELINE-HASH",
        }),
      );
      const request: CodexDesktopTurnRequest = {
        ...turnRequest(),
        model: "gpt-test",
        reasoningEffort: "high",
      };
      const { logical, fence } = await bindLogicalContext(
        logicalTurnPort,
        "build",
        1,
        0,
        request,
      );
      const attemptId = `ATTEMPT-TAMPER-${field}`;
      await durable.prepare({ attemptId, logicalTurnId: logical.logicalTurnId });
      const dispatchOrdinal = await durable.claimDispatch({ attemptId, fence });
      await durable.recordAmbiguous({
        attemptId,
        dispatchOrdinal,
        reason: "unknown_response",
        fence,
      });
      const tampered: CodexFollowerStartAttemptPort = {
        ...durable,
        async inspectByLogicalTurn(logicalTurnId) {
          const attempt = await durable.inspectByLogicalTurn(logicalTurnId);
          if (!attempt) return null;
          const replacements = {
            cwd: "/tampered",
            model: "gpt-tampered",
            reasoningEffort: "low",
            sandboxMode: "workspace-write" as const,
          };
          return {
            ...attempt,
            request: {
              ...attempt.request,
              [field]: replacements[field],
            },
          };
        },
      };
      await assert.rejects(
        createCodexDesktopBridge({
          shellControl,
          follower,
          logicalTurnPort,
          startAttemptPort: tampered,
          shellProvisionPort: createTestShellProvisionPort(logicalTurnPort),
        }).recoverTurn({ logicalTurnId: logical.logicalTurnId }),
        (error: unknown) =>
          error instanceof CodexDesktopBridgeError
          && error.code === "desktop_follower_start_ambiguous"
          && /request or baseline is inconsistent/.test(error.message),
      );
      assert.equal(follower.startCalls.length, 0);
      assert.equal(shellControl.threadReadCalls.length, 0);
    }
  });

  it("recovers success-before-CAS without a second follower dispatch", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    follower.responses = [{ status: "started", turnId: "TURN-ADOPTED" }];
    let reads = 0;
    shellControl.readHook = async () => {
      reads += 1;
      if (reads === 1) return [];
      const prompt = follower.startCalls[0]?.prompt ?? "";
      return [{
        ...turnSnapshot("inProgress", [{
          id: "ITEM-CORRELATION",
          type: "userMessage",
          text: prompt,
        }]),
        turnId: "TURN-ADOPTED",
      }];
    };
    const logicalTurnPort = createPhase0InMemoryLogicalTurnPort();
    const durable = createPhase0InMemoryStartAttemptPort(logicalTurnPort);
    let failBeforeSuccessCas = true;
    const port: CodexFollowerStartAttemptPort = {
      inspect: (attemptId) => durable.inspect(attemptId),
      inspectByLogicalTurn: (logicalTurnId) =>
        durable.inspectByLogicalTurn(logicalTurnId),
      prepare: (input) => durable.prepare(input),
      claimDispatch: (input) => durable.claimDispatch(input),
      claimSafeAttemptForWorker: (input) =>
        durable.claimSafeAttemptForWorker(input),
      recordNoClientFound: (input) => durable.recordNoClientFound(input),
      async recordSuccess(input) {
        if (failBeforeSuccessCas) {
          failBeforeSuccessCas = false;
          throw new Error("crash-before-success-cas");
        }
        await durable.recordSuccess(input);
      },
      recordAmbiguous: (input) => durable.recordAmbiguous(input),
      claimReconciliation: (input) => durable.claimReconciliation(input),
      adoptSuccess: (input) => durable.adoptSuccess(input),
      quarantine: (input) => durable.quarantine(input),
      expireVisibility: (input) => durable.expireVisibility(input),
    };
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      startAttemptPort: port,
      logicalTurnPort,
    });

    const result = await bridge.startTurn(
      await startInput(logicalTurnPort),
    );

    assert.equal(result.turnId, "TURN-ADOPTED");
    assert.equal(follower.startCalls.length, 1);
    assert.equal((await durable.inspect(result.attemptId))?.state, "succeeded");
  });

  it("adopts exactly one baseline-delta turn carrying the durable marker", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    follower.responses = [new Error("response_lost")];
    let reads = 0;
    shellControl.readHook = async () => {
      reads += 1;
      if (reads === 1) return [];
      const prompt = follower.startCalls[0]?.prompt ?? "";
      return [{
        ...turnSnapshot("inProgress", [{
          id: "ITEM-CORRELATION",
          type: "userMessage",
          text: prompt,
        }]),
        turnId: "TURN-ADOPTED",
      }];
    };
    const ports = phase0Ports();
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      ...ports,
    });

    const result = await bridge.startTurn(
      await startInput(ports.logicalTurnPort),
    );

    assert.equal(result.turnId, "TURN-ADOPTED");
    assert.equal(follower.startCalls.length, 1);
    assert.match(
      follower.startCalls[0]?.prompt ?? "",
      /\[stagepass-run:sp-[A-Za-z0-9_-]+:attempt:[0-9a-f-]+\]/,
    );
  });

  it("quarantines multiple marker-correlated baseline-delta turns", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    follower.responses = [new Error("response_lost")];
    let reads = 0;
    shellControl.readHook = async () => {
      reads += 1;
      if (reads === 1) return [];
      const prompt = follower.startCalls[0]?.prompt ?? "";
      return ["TURN-A", "TURN-B"].map((turnId) => ({
        ...turnSnapshot("inProgress", [{
          id: `ITEM-${turnId}`,
          type: "userMessage",
          text: prompt,
        }]),
        turnId,
      }));
    };
    const ports = phase0Ports();
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      ...ports,
    });
    const input = await startInput(ports.logicalTurnPort);

    await expectBridgeCode(
      () => bridge.startTurn(input),
      "desktop_follower_start_ambiguous",
    );
    assert.equal(follower.startCalls.length, 1);
  });

  it("deduplicates snapshots, advances local cursors, and reconnects reads", async () => {
    const shellControl = new FakeShellControl();
    const inProgress = turnSnapshot("inProgress", [{ id: "ITEM-1" }]);
    const completed = turnSnapshot(
      "completed",
      [{ id: "ITEM-1" }, { id: "ITEM-2", type: "agentMessage", text: "done" }],
    );
    shellControl.readResults = [
      [inProgress],
      [inProgress],
      new Error("connection_lost"),
      [completed],
    ];
    const follower = new FakeFollower();
    let now = Date.parse("2026-07-23T00:00:00.000Z");
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      startAttemptPort: createPhase0InMemoryStartAttemptPort(),
      logicalTurnPort: createPhase0InMemoryLogicalTurnPort(),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const observations: CodexTurnPollResult[] = [];
    for await (const observation of bridge.pollTurn({
      threadId: "THREAD-1",
      turnId: "TURN-1",
      deadlineAt: new Date(now + 30_000).toISOString(),
    })) {
      observations.push(observation);
    }

    const projected = observations.filter(
      (item) => item.kind === "observation",
    );
    assert.deepEqual(projected.map(({ cursor }) => cursor), [1, 2]);
    assert.notEqual(
      projected[0]?.semanticSnapshotHash,
      projected[1]?.semanticSnapshotHash,
    );
    assert.equal(projected.at(-1)?.snapshot.status, "completed");
    assert.equal(shellControl.threadReadCalls.length, 5);
  });

  it("surfaces semantic snapshot failures immediately instead of masking them as reconnect outages", async () => {
    const shellControl = new FakeShellControl();
    shellControl.readResults = [
      new CodexDesktopBridgeError(
        "turn_snapshot_invalid",
        "Codex turn contains an unknown item kind",
      ),
    ];
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower: new FakeFollower(),
      startAttemptPort: createPhase0InMemoryStartAttemptPort(),
      logicalTurnPort: createPhase0InMemoryLogicalTurnPort(),
    });

    await assert.rejects(async () => {
      for await (const observation of bridge.pollTurn({
        threadId: "THREAD-1",
        turnId: "TURN-1",
        deadlineAt: "2099-01-01T00:00:00.000Z",
      })) {
        void observation;
      }
    }, (error: unknown) =>
      error instanceof CodexDesktopBridgeError
      && error.code === "turn_snapshot_invalid"
      && /unknown item kind/.test(error.message));
    assert.equal(shellControl.threadReadCalls.length, 1);
  });

  it("resumes polling from persisted normalized state and rejects regression", async () => {
    const shellControl = new FakeShellControl();
    const persisted = turnSnapshot("inProgress", [
      { id: "ITEM-1" },
      { id: "ITEM-2" },
    ]);
    shellControl.readResults = [
      [persisted],
      [turnSnapshot("inProgress", [{ id: "ITEM-1" }])],
    ];
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower: new FakeFollower(),
      startAttemptPort: createPhase0InMemoryStartAttemptPort(),
      logicalTurnPort: createPhase0InMemoryLogicalTurnPort(),
    });
    const firstPoll = bridge.pollTurn({
      threadId: "THREAD-1",
      turnId: "TURN-1",
      deadlineAt: "2099-01-01T00:00:00.000Z",
    })[Symbol.asyncIterator]();
    const first = await firstPoll.next();
    assert.equal(first.value?.kind, "observation");
    await firstPoll.return?.();
    assert.equal(first.value?.kind, "observation");
    if (first.value?.kind !== "observation") {
      throw new Error("expected persisted observation");
    }

    await assert.rejects(async () => {
      for await (const observation of bridge.pollTurn({
        threadId: "THREAD-1",
        turnId: "TURN-1",
        afterCursor: first.value.cursor,
        lastSnapshotHash: first.value.semanticSnapshotHash,
        lastNormalizedSnapshot: first.value.snapshot,
        deadlineAt: "2099-01-01T00:00:00.000Z",
      })) {
        // A regressed snapshot must fail before yielding.
        void observation;
      }
    }, (error: unknown) =>
      error instanceof CodexDesktopBridgeError
      && error.code === "turn_snapshot_invalid");
  });

  it("rejects a resume hash without its normalized snapshot", async () => {
    const bridge = createCodexDesktopBridge({
      shellControl: new FakeShellControl(),
      follower: new FakeFollower(),
      startAttemptPort: createPhase0InMemoryStartAttemptPort(),
      logicalTurnPort: createPhase0InMemoryLogicalTurnPort(),
    });
    await assert.rejects(async () => {
      for await (const observation of bridge.pollTurn({
        threadId: "THREAD-1",
        turnId: "TURN-1",
        lastSnapshotHash: "orphaned-hash",
        deadlineAt: "2099-01-01T00:00:00.000Z",
      })) {
        // Resume state must be complete before any read.
        void observation;
      }
    }, (error: unknown) =>
      error instanceof CodexDesktopBridgeError
      && error.code === "turn_snapshot_invalid");
  });

  it("treats an absent requested turn as not-yet-visible without starting", async () => {
    const shellControl = new FakeShellControl();
    shellControl.readResults = [
      [],
      [],
      [turnSnapshot("completed", [{ id: "ITEM-1" }])],
    ];
    const follower = new FakeFollower();
    let now = Date.parse("2026-07-23T00:00:00.000Z");
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      startAttemptPort: createPhase0InMemoryStartAttemptPort(),
      logicalTurnPort: createPhase0InMemoryLogicalTurnPort(),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const observations: CodexTurnPollResult[] = [];
    for await (const observation of bridge.pollTurn({
      threadId: "THREAD-1",
      turnId: "TURN-1",
      deadlineAt: new Date(now + 30_000).toISOString(),
    })) {
      observations.push(observation);
    }

    assert.equal(follower.startCalls.length, 0);
    assert.equal(shellControl.threadReadCalls.length, 4);
    assert.equal(
      observations.filter(
        ({ kind }) => kind === "turn_not_yet_visible",
      ).length,
      2,
    );
    assert.deepEqual(
      observations
        .filter((item) => item.kind === "observation")
        .map(({ cursor }) => cursor),
      [1],
    );
  });

  it("ignores volatile timing drift but rejects item deletion or reorder", async () => {
    const shellControl = new FakeShellControl();
    const stable = turnSnapshot(
      "inProgress",
      [{ id: "ITEM-1" }, { id: "ITEM-2" }],
    );
    shellControl.readResults = [
      [stable],
      [{
        ...stable,
        metadata: {
          ...stable.metadata,
          durationMs: 999,
          observedAt: "2026-07-23T00:00:09.000Z",
        },
      }],
      [{ ...stable, items: [{ id: "ITEM-2" }, { id: "ITEM-1" }] }],
    ];
    const follower = new FakeFollower();
    let now = Date.parse("2026-07-23T00:00:00.000Z");
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      startAttemptPort: createPhase0InMemoryStartAttemptPort(),
      logicalTurnPort: createPhase0InMemoryLogicalTurnPort(),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const cursors: number[] = [];

    await assert.rejects(
      async () => {
        for await (const observation of bridge.pollTurn({
          threadId: "THREAD-1",
          turnId: "TURN-1",
          deadlineAt: new Date(now + 30_000).toISOString(),
        })) {
          if (observation.kind === "observation") {
            cursors.push(observation.cursor);
          }
        }
      },
      (error: unknown) =>
        error instanceof CodexDesktopBridgeError
        && error.code === "turn_snapshot_invalid",
    );
    assert.deepEqual(cursors, [1]);
  });

  it("hashes a turn set from stable semantic fields only", () => {
    const first = turnSnapshot("completed", [{ id: "ITEM-1" }]);
    const volatileOnly = {
      ...first,
      metadata: {
        ...first.metadata,
        durationMs: 9_999,
        observedAt: "2026-07-23T00:00:09.999Z",
      },
    };
    assert.equal(
      codexTurnSetSemanticHash([first]),
      codexTurnSetSemanticHash([volatileOnly]),
    );
    assert.notEqual(
      codexTurnSetSemanticHash([first]),
      codexTurnSetSemanticHash([{
        ...first,
        terminal: { output: "semantic drift" },
      }]),
    );
  });

  it("rejects terminal semantic drift before projecting a cursor", async () => {
    const shellControl = new FakeShellControl();
    const first = turnSnapshot(
      "completed",
      [{ id: "ITEM-1", type: "agentMessage", text: "first" }],
    );
    const changed = {
      ...first,
      items: [{
        id: "ITEM-1",
        kind: "agent_message" as const,
        semantic: { text: "changed" },
      }],
      terminal: { output: "changed" },
    };
    shellControl.readResults = [[first], [changed]];
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower: new FakeFollower(),
      startAttemptPort: createPhase0InMemoryStartAttemptPort(),
      logicalTurnPort: createPhase0InMemoryLogicalTurnPort(),
    });

    await assert.rejects(
      async () => {
        for await (const observation of bridge.pollTurn({
          threadId: "THREAD-1",
          turnId: "TURN-1",
          deadlineAt: "2099-01-01T00:00:00.000Z",
        })) {
          void observation;
          assert.fail("terminal drift must not project");
        }
      },
      (error: unknown) =>
        error instanceof CodexDesktopBridgeError
        && error.code === "turn_snapshot_invalid",
    );
  });

  it("does not blind-adopt pre-existing title matches and targets interrupts", async () => {
    const shellControl = new FakeShellControl();
    const follower = new FakeFollower();
    for (const threadId of ["THREAD-A", "THREAD-B"]) {
      shellControl.shells.set(threadId, {
        threadId,
        title: "[CHG-1] First",
        cwd: "/repo",
        ephemeral: false,
      });
    }
    const logicalTurnPort = createPhase0InMemoryLogicalTurnPort();
    const bridge = createCodexDesktopBridge({
      shellControl,
      follower,
      startAttemptPort: createPhase0InMemoryStartAttemptPort(logicalTurnPort),
      logicalTurnPort,
      shellProvisionPort: createTestShellProvisionPort(logicalTurnPort),
    });
    const shell = await bridge.ensurePersistentShell({
      projectPath: "/repo",
      provisionFence: provisionFence(),
      scope: {
        kind: "change",
        scopeId: "CHG-1",
        projectId: "PROJECT-1",
        changeId: "CHG-1",
      },
      title: "[CHG-1] First",
    });
    assert.equal(shell.threadId, "THREAD-1");
    await bridge.interruptTurn({
      threadId: "THREAD-A",
      turnId: "TURN-TARGET",
    });
    assert.deepEqual(follower.interrupted, [{
      threadId: "THREAD-A",
      turnId: "TURN-TARGET",
    }]);
    follower.interruptError = new CodexDesktopFollowerRoutingError(
      "thread-detached",
    );
    await expectBridgeCode(
      () => bridge.interruptTurn({
        threadId: "THREAD-DELETED",
        turnId: "TURN-DELETED",
      }),
      "desktop_thread_detached",
    );
  });
});

function discoveryFixtures(): {
  fileSystem: CodexDesktopDiscoveryFileSystem;
  processProbe: CodexDesktopProcessProbe;
} {
  return {
    fileSystem: {
      async lstat(candidate) {
        return candidate.endsWith(".sock")
          ? {
              isSocket: true,
              isDirectory: false,
              isSymbolicLink: false,
              uid: 501,
              mode: 0o600,
              device: 1,
              inode: 2,
            }
          : {
              isSocket: false,
              isDirectory: true,
              isSymbolicLink: false,
              uid: 501,
              mode: 0o700,
              device: 1,
              inode: 1,
            };
      },
    },
    processProbe: {
      currentUid() {
        return 501;
      },
      async advertisedEndpoints() {
        return [{
          path: "/runtime/codex/ipc.sock",
          pid: 42,
          desktopVerified: true,
          desktopBundleIdentity: {
            bundleIdentifier: "com.openai.codex",
            bundleShortVersion: "26.721.30844",
            bundleVersion: "5813",
            chromiumBaseVersion: "150.0.7871.128",
          },
          appServerBinary: {
            path:
              "/Applications/ChatGPT.app/Contents/Resources/codex",
            version: "codex-cli 0.146.0-alpha.3",
            file: {
              isSocket: false,
              isDirectory: false,
              isSymbolicLink: false,
              uid: 0,
              mode: 0o644,
              device: 9,
              inode: 10_001,
            },
            bundlePath: "/Applications/ChatGPT.app",
            bundleFile: {
              isSocket: false,
              isDirectory: true,
              isSymbolicLink: false,
              uid: 0,
              mode: 0o755,
              device: 9,
              inode: 10_002,
            },
            bundleIdentifier: "com.openai.codex",
            teamIdentifier: "2DC432GLL2",
          },
        }];
      },
      async isRunning(pid) {
        return pid === 42;
      },
    },
  };
}

describe("Codex Desktop IPC discovery", () => {
  it("accepts the exact signed 26.721.41059 Desktop and bundled 0.146.0-alpha.3.1 CLI", async () => {
    const fixtures = processDiscoveryFixtures({
      lsofPids: [9410],
      commands: {
        9410: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      kernelExecutables: {
        9410: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      },
      procPidPathOutputs: {
        9410: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      bundleMetadataSequences: {
        CFBundleShortVersionString: ["26.721.41059", "26.721.41059"],
        CFBundleVersion: ["5848", "5848"],
        ChromiumBaseVersion: ["150.0.7871.128", "150.0.7871.128"],
      },
      codexVersionSequence: [
        "codex-cli 0.146.0-alpha.3.1",
        "codex-cli 0.146.0-alpha.3.1",
      ],
      codesignIdentities: {
        "/Applications/ChatGPT.app": [
          "Identifier=com.openai.codex",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
      },
    });

    const endpoint = await discoverCodexDesktopIpcEndpoint(
      fixtures.dependencies,
    );

    assert.equal(endpoint.pid, 9410);
    assert.deepEqual(endpoint.desktopBundleIdentity, {
      bundleIdentifier: "com.openai.codex",
      bundleShortVersion: "26.721.41059",
      bundleVersion: "5848",
      chromiumBaseVersion: "150.0.7871.128",
    });
    assert.equal(
      endpoint.appServerBinary.version,
      "codex-cli 0.146.0-alpha.3.1",
    );
  });

  it("rejects the previously pinned 0.146.0-alpha.3 CLI", async () => {
    const fixtures = processDiscoveryFixtures({
      lsofPids: [9409],
      commands: {
        9409: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      kernelExecutables: {
        9409: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      },
      procPidPathOutputs: {
        9409: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      bundleMetadataSequences: {
        CFBundleShortVersionString: ["26.721.30844", "26.721.30844"],
        CFBundleVersion: ["5813", "5813"],
        ChromiumBaseVersion: ["150.0.7871.128", "150.0.7871.128"],
      },
      codexVersionSequence: [
        "codex-cli 0.146.0-alpha.3",
        "codex-cli 0.146.0-alpha.3",
      ],
      codesignIdentities: {
        "/Applications/ChatGPT.app": [
          "Identifier=com.openai.codex",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
      },
    });

    await expectBridgeCode(
      () => discoverCodexDesktopIpcEndpoint(fixtures.dependencies),
      "desktop_bridge_unavailable",
    );
  });

  it("accepts only the endpoint advertised by a running verified Desktop", async () => {
    const fixtures = discoveryFixtures();
    assert.equal(
      (await discoverCodexDesktopIpcEndpoint(fixtures)).path,
      "/runtime/codex/ipc.sock",
    );
  });

  function processDiscoveryFixtures(input: {
    lsofPids: readonly number[];
    commands: Readonly<Record<number, string>>;
    kernelExecutables: Readonly<Record<number, readonly string[]>>;
    procPidPathOutputs: Readonly<Record<number, string>>;
    procPidPathFailures?: readonly number[];
    codesignIdentities: Readonly<Record<string, string>>;
    codesignVerificationFailures?: readonly string[];
    bundleMetadataSequences?: Readonly<
      Partial<Record<
        | "CFBundleIdentifier"
        | "CFBundleShortVersionString"
        | "CFBundleVersion"
        | "ChromiumBaseVersion",
        readonly string[]
      >>
    >;
    codexVersionSequence?: readonly string[];
    codexVersionStderrSequence?: readonly string[];
    fileIdentityDriftPath?: string;
  }): {
    dependencies: {
      fileSystem: CodexDesktopDiscoveryFileSystem;
      processProbe: CodexDesktopProcessProbe;
    };
    codesignTargets: string[];
    commandFiles: string[];
    lsofTextProbeCalls: number;
    plutilCalls: readonly (readonly string[])[];
    pythonInvocations: readonly (readonly string[])[];
  } {
    const codesignTargets: string[] = [];
    const commandFiles: string[] = [];
    let lsofTextProbeCalls = 0;
    const plutilCalls: string[][] = [];
    const pythonInvocations: string[][] = [];
    const fileLstatCalls = new Map<string, number>();
    const runCommand: CodexDesktopProbeCommandRunner =
      async (file, args) => {
        commandFiles.push(file);
        if (
          file === "lsof"
          || file === "codesign"
          || file === "codex"
          || file === "plutil"
          || file === "python3"
        ) {
          throw new Error(`malicious PATH tool invoked: ${file}`);
        }
        if (file === "/usr/sbin/lsof" && args[0] === "-t") {
          return {
            stdout: `${input.lsofPids.join("\n")}\n`,
            stderr: "",
          };
        }
        if (file === "/usr/sbin/lsof" && args.includes("-Fn")) {
          lsofTextProbeCalls += 1;
          const pid = Number(args[args.indexOf("-p") + 1]);
          const executableRecords = input.kernelExecutables[pid] ?? [];
          return {
            stdout: [
              `p${pid}`,
              ...executableRecords.flatMap((candidate) => [
                "ftxt",
                `n${candidate}`,
              ]),
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        if (file === "/usr/bin/python3") {
          pythonInvocations.push([...args]);
          const pid = Number(args.at(-1));
          if (input.procPidPathFailures?.includes(pid)) {
            throw new Error("python or libproc unavailable");
          }
          return {
            stdout: input.procPidPathOutputs[pid] ?? "",
            stderr: "",
          };
        }
        if (file === "/usr/bin/plutil") {
          plutilCalls.push([...args]);
          const key = args[1] as
            | "CFBundleIdentifier"
            | "CFBundleShortVersionString"
            | "CFBundleVersion"
            | "ChromiumBaseVersion";
          const defaults = {
            CFBundleIdentifier: "com.openai.codex",
            CFBundleShortVersionString: "26.721.41059",
            CFBundleVersion: "5848",
            ChromiumBaseVersion: "150.0.7871.128",
          };
          const sequence = input.bundleMetadataSequences?.[key]
            ?? [defaults[key]];
          const readIndex = plutilCalls.filter(
            (call) => call[1] === key,
          ).length - 1;
          return {
            stdout: `${sequence[Math.min(readIndex, sequence.length - 1)]}\n`,
            stderr: "",
          };
        }
        if (
          file
            === "/Applications/ChatGPT.app/Contents/Resources/codex"
          || file === "/Applications/Codex.app/Contents/Resources/codex"
        ) {
          const calls = commandFiles.filter(
            (candidate) => candidate === file,
          ).length - 1;
          const sequence = input.codexVersionSequence
            ?? ["codex-cli 0.146.0-alpha.3.1"];
          const stderrSequence = input.codexVersionStderrSequence ?? [""];
          return {
            stdout: `${sequence[Math.min(calls, sequence.length - 1)]}\n`,
            stderr:
              stderrSequence[
                Math.min(calls, stderrSequence.length - 1)
              ],
          };
        }
        if (file === "/usr/bin/codesign") {
          const target = args.at(-1) ?? "";
          codesignTargets.push(target);
          if (
            args.includes("--verify")
            && input.codesignVerificationFailures?.includes(target)
          ) {
            throw new Error("codesign verification failed");
          }
          return {
            stdout: "",
            stderr: input.codesignIdentities[target] ?? "",
          };
        }
        throw new Error(`unexpected command: ${file}`);
      };
    const base = discoveryFixtures();
    return {
      codesignTargets,
      commandFiles,
      get lsofTextProbeCalls() {
        return lsofTextProbeCalls;
      },
      plutilCalls,
      pythonInvocations,
      dependencies: {
        fileSystem: base.fileSystem,
        processProbe: createCodexDesktopProcessProbe({
          endpoint: "/runtime/codex/ipc.sock",
          currentUid: () => 501,
          runCommand,
          realpath: async (candidate) => candidate,
          lstat: async (candidate) => {
            if (candidate.startsWith("/runtime/")) {
              return base.fileSystem.lstat(candidate);
            }
            const calls = (fileLstatCalls.get(candidate) ?? 0) + 1;
            fileLstatCalls.set(candidate, calls);
            const drifted = input.fileIdentityDriftPath === candidate
              && calls > 1;
            return {
              isSocket: false,
              isDirectory: candidate.endsWith(".app"),
              isSymbolicLink: false,
              uid: 0,
              mode: candidate.endsWith(".app") ? 0o755 : 0o644,
              device: 9,
              inode: drifted ? 10_999 : 10_000 + candidate.length,
            };
          },
          isRunning: async () => true,
        }),
      },
    };
  }

  it("selects one canonical main process when lsof also reports renderer service and helper processes", async () => {
    const fixtures = processDiscoveryFixtures({
      lsofPids: [33399, 33400, 33401, 33402],
      commands: {
        33399: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --started-from-login",
        33400: "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper (Renderer).app/Contents/MacOS/ChatGPT Helper (Renderer) --type=renderer",
        33401: "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper --type=utility",
        33402: "/Applications/ChatGPT.app/Contents/Library/LoginItems/ChatGPT Service.app/Contents/MacOS/ChatGPT Service",
      },
      kernelExecutables: {
        33399: [
          "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
          "/usr/lib/dyld",
          "/System/Library/Frameworks/AppKit.framework/AppKit",
        ],
        33400: [
          "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper (Renderer).app/Contents/MacOS/ChatGPT Helper (Renderer)",
          "/usr/lib/dyld",
        ],
        33401: [
          "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper",
          "/usr/lib/dyld",
        ],
        33402: [
          "/Applications/ChatGPT.app/Contents/Library/LoginItems/ChatGPT Service.app/Contents/MacOS/ChatGPT Service",
          "/usr/lib/dyld",
        ],
      },
      procPidPathOutputs: {
        33399: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
        33400: "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper (Renderer).app/Contents/MacOS/ChatGPT Helper (Renderer)",
        33401: "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper",
        33402: "/Applications/ChatGPT.app/Contents/Library/LoginItems/ChatGPT Service.app/Contents/MacOS/ChatGPT Service",
      },
      codesignIdentities: {
        "/Applications/ChatGPT.app": [
          "Identifier=com.openai.codex",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
      },
      codexVersionStderrSequence: [
        "WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)\n",
        "WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)\n",
      ],
    });

    const endpoint = await discoverCodexDesktopIpcEndpoint(
      fixtures.dependencies,
    );

    assert.equal(endpoint.pid, 33399);
    assert.deepEqual(endpoint.desktopBundleIdentity, {
      bundleIdentifier: "com.openai.codex",
      bundleShortVersion: "26.721.41059",
      bundleVersion: "5848",
      chromiumBaseVersion: "150.0.7871.128",
    });
    assert.equal(
      endpoint.appServerBinary.path,
      "/Applications/ChatGPT.app/Contents/Resources/codex",
    );
    assert.equal(
      endpoint.appServerBinary.version,
      "codex-cli 0.146.0-alpha.3.1",
    );
    assert.equal(
      endpoint.appServerBinary.bundlePath,
      "/Applications/ChatGPT.app",
    );
    assert.equal(
      endpoint.appServerBinary.bundleIdentifier,
      "com.openai.codex",
    );
    assert.equal(endpoint.appServerBinary.teamIdentifier, "2DC432GLL2");
    assert.deepEqual(fixtures.codesignTargets, [
      "/Applications/ChatGPT.app",
      "/Applications/ChatGPT.app",
      "/Applications/ChatGPT.app",
    ]);
    assert.ok(fixtures.commandFiles.includes("/usr/sbin/lsof"));
    assert.ok(fixtures.commandFiles.includes("/usr/bin/python3"));
    assert.ok(fixtures.commandFiles.includes("/usr/bin/plutil"));
    assert.ok(fixtures.commandFiles.includes("/usr/bin/codesign"));
    assert.ok(fixtures.commandFiles.includes(
      "/Applications/ChatGPT.app/Contents/Resources/codex",
    ));
    assert.ok(!fixtures.commandFiles.includes("lsof"));
    assert.ok(!fixtures.commandFiles.includes("python3"));
    assert.ok(!fixtures.commandFiles.includes("plutil"));
    assert.ok(!fixtures.commandFiles.includes("codesign"));
    assert.ok(!fixtures.commandFiles.includes("codex"));
    assert.equal(fixtures.lsofTextProbeCalls, 0);
    assert.equal(fixtures.pythonInvocations.length, 5);
    for (const args of fixtures.pythonInvocations) {
      assert.deepEqual(args.slice(0, 3), ["-I", "-S", "-c"]);
      assert.equal(args.length, 5);
      assert.match(args[3] ?? "", /sys\.argv\[1\]/);
      assert.match(args[4] ?? "", /^\d+$/);
    }
    assert.equal(
      new Set(fixtures.pythonInvocations.map((args) => args[3])).size,
      1,
    );
    assert.equal(fixtures.plutilCalls.length, 8);
    for (const args of fixtures.plutilCalls) {
      assert.deepEqual(args.slice(0, 1), ["-extract"]);
      assert.deepEqual(args.slice(2), [
        "raw",
        "-o",
        "-",
        "/Applications/ChatGPT.app/Contents/Info.plist",
      ]);
    }
  });

  it("rejects the legacy ChatGPT identifier for the canonical ChatGPT bundle", async () => {
    const fixtures = processDiscoveryFixtures({
      lsofPids: [34343],
      commands: {
        34343: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      kernelExecutables: {
        34343: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      },
      procPidPathOutputs: {
        34343: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      codesignIdentities: {
        "/Applications/ChatGPT.app": [
          "Identifier=com.openai.chat",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
      },
    });

    await expectBridgeCode(
      () => discoverCodexDesktopIpcEndpoint(fixtures.dependencies),
      "desktop_bridge_unavailable",
    );
  });

  it("rejects two independently attested canonical main processes as ambiguous", async () => {
    const fixtures = processDiscoveryFixtures({
      lsofPids: [33399, 44444],
      commands: {
        33399: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
        44444: "/Applications/Codex.app/Contents/MacOS/Codex",
      },
      kernelExecutables: {
        33399: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
        44444: ["/Applications/Codex.app/Contents/MacOS/Codex"],
      },
      procPidPathOutputs: {
        33399: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
        44444: "/Applications/Codex.app/Contents/MacOS/Codex",
      },
      codesignIdentities: {
        "/Applications/ChatGPT.app": [
          "Identifier=com.openai.codex",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
        "/Applications/Codex.app": [
          "Identifier=com.openai.codex",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
      },
    });

    await expectBridgeCode(
      () => discoverCodexDesktopIpcEndpoint(fixtures.dependencies),
      "desktop_bridge_unavailable",
    );
  });

  it("rejects a forged canonical ps command when the kernel executable is Node", async () => {
    const fixtures = processDiscoveryFixtures({
      lsofPids: [55555],
      commands: {
        55555: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --forged-argv0",
      },
      kernelExecutables: {
        55555: ["/usr/bin/node"],
      },
      procPidPathOutputs: {
        55555: "/usr/bin/node",
      },
      codesignIdentities: {
        "/Applications/ChatGPT.app": [
          "Identifier=com.openai.codex",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
      },
    });

    await expectBridgeCode(
      () => discoverCodexDesktopIpcEndpoint(fixtures.dependencies),
      "desktop_bridge_unavailable",
    );
    assert.deepEqual(fixtures.codesignTargets, []);
  });

  for (const [name, procPidPathOutput] of [
    ["empty", ""],
    [
      "multiline",
      "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n/usr/bin/node",
    ],
    ["NUL-containing", "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\0"],
    ["relative", "Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
  ] as const) {
    it(`fails closed when proc_pidpath output is ${name}`, async () => {
      const fixtures = processDiscoveryFixtures({
        lsofPids: [66666],
        commands: {
          66666: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
        },
        kernelExecutables: {
          66666: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
        },
        procPidPathOutputs: {
          66666: procPidPathOutput,
        },
        codesignIdentities: {
          "/Applications/ChatGPT.app": [
            "Identifier=com.openai.codex",
            "TeamIdentifier=2DC432GLL2",
          ].join("\n"),
        },
      });

      await expectBridgeCode(
        () => discoverCodexDesktopIpcEndpoint(fixtures.dependencies),
        "desktop_bridge_unavailable",
      );
      assert.deepEqual(fixtures.codesignTargets, []);
    });
  }

  it("fails closed when Python or libproc cannot query proc_pidpath", async () => {
    const fixtures = processDiscoveryFixtures({
      lsofPids: [67676],
      commands: {
        67676: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      kernelExecutables: {
        67676: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      },
      procPidPathOutputs: {},
      procPidPathFailures: [67676],
      codesignIdentities: {
        "/Applications/ChatGPT.app": [
          "Identifier=com.openai.codex",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
      },
    });

    await expectBridgeCode(
      () => discoverCodexDesktopIpcEndpoint(fixtures.dependencies),
      "desktop_bridge_unavailable",
    );
    assert.deepEqual(fixtures.codesignTargets, []);
  });

  it("rejects signed bundle metadata drift across codesign verification", async () => {
    const fixtures = processDiscoveryFixtures({
      lsofPids: [68686],
      commands: {
        68686: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      kernelExecutables: {
        68686: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      },
      procPidPathOutputs: {
        68686: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      codesignIdentities: {
        "/Applications/ChatGPT.app": [
          "Identifier=com.openai.codex",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
      },
      bundleMetadataSequences: {
        ChromiumBaseVersion: [
          "150.0.7871.128",
          "150.0.7871.125",
        ],
      },
    });

    await expectBridgeCode(
      () => discoverCodexDesktopIpcEndpoint(fixtures.dependencies),
      "desktop_bridge_unavailable",
    );
  });

  it("rejects Info.plist inode replacement during bundle attestation", async () => {
    const fixtures = processDiscoveryFixtures({
      lsofPids: [69696],
      commands: {
        69696: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      kernelExecutables: {
        69696: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      },
      procPidPathOutputs: {
        69696: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      codesignIdentities: {
        "/Applications/ChatGPT.app": [
          "Identifier=com.openai.codex",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
      },
      fileIdentityDriftPath:
        "/Applications/ChatGPT.app/Contents/Info.plist",
    });

    await expectBridgeCode(
      () => discoverCodexDesktopIpcEndpoint(fixtures.dependencies),
      "desktop_bridge_unavailable",
    );
  });

  it("rejects bundled app-server binary replacement during attestation", async () => {
    const fixtures = processDiscoveryFixtures({
      lsofPids: [70707],
      commands: {
        70707: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      kernelExecutables: {
        70707: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      },
      procPidPathOutputs: {
        70707: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      codesignIdentities: {
        "/Applications/ChatGPT.app": [
          "Identifier=com.openai.codex",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
      },
      fileIdentityDriftPath:
        "/Applications/ChatGPT.app/Contents/Resources/codex",
    });

    await expectBridgeCode(
      () => discoverCodexDesktopIpcEndpoint(fixtures.dependencies),
      "desktop_bridge_unavailable",
    );
  });

  it("rejects bundled app-server version drift during attestation", async () => {
    const fixtures = processDiscoveryFixtures({
      lsofPids: [71717],
      commands: {
        71717: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      kernelExecutables: {
        71717: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      },
      procPidPathOutputs: {
        71717: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      codesignIdentities: {
        "/Applications/ChatGPT.app": [
          "Identifier=com.openai.codex",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
      },
      codexVersionSequence: [
        "codex-cli 0.146.0-alpha.3",
        "codex-cli 0.144.4",
      ],
    });

    await expectBridgeCode(
      () => discoverCodexDesktopIpcEndpoint(fixtures.dependencies),
      "desktop_bridge_unavailable",
    );
  });

  it("rejects arbitrary bundled app-server version stderr", async () => {
    const fixtures = processDiscoveryFixtures({
      lsofPids: [72727],
      commands: {
        72727: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      kernelExecutables: {
        72727: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      },
      procPidPathOutputs: {
        72727: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      codesignIdentities: {
        "/Applications/ChatGPT.app": [
          "Identifier=com.openai.codex",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
      },
      codexVersionStderrSequence: [
        "unexpected warning",
        "unexpected warning",
      ],
    });

    await expectBridgeCode(
      () => discoverCodexDesktopIpcEndpoint(fixtures.dependencies),
      "desktop_bridge_unavailable",
    );
  });

  it("rejects a canonical kernel executable without the trusted OpenAI signature", async () => {
    const fixtures = processDiscoveryFixtures({
      lsofPids: [77777],
      commands: {
        77777: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      kernelExecutables: {
        77777: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      },
      procPidPathOutputs: {
        77777: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      codesignIdentities: {
        "/Applications/ChatGPT.app": [
          "Identifier=com.openai.codex",
          "TeamIdentifier=UNTRUSTED",
        ].join("\n"),
      },
    });

    await expectBridgeCode(
      () => discoverCodexDesktopIpcEndpoint(fixtures.dependencies),
      "desktop_bridge_unavailable",
    );
  });

  it("rejects a canonical kernel executable whose bundle signature does not verify", async () => {
    const fixtures = processDiscoveryFixtures({
      lsofPids: [88888],
      commands: {
        88888: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      kernelExecutables: {
        88888: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      },
      procPidPathOutputs: {
        88888: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      },
      codesignIdentities: {
        "/Applications/ChatGPT.app": [
          "Identifier=com.openai.codex",
          "TeamIdentifier=2DC432GLL2",
        ].join("\n"),
      },
      codesignVerificationFailures: ["/Applications/ChatGPT.app"],
    });

    await expectBridgeCode(
      () => discoverCodexDesktopIpcEndpoint(fixtures.dependencies),
      "desktop_bridge_unavailable",
    );
  });

  for (const [name, mutate] of [
    ["stale", (fixtures: ReturnType<typeof discoveryFixtures>) => {
      fixtures.processProbe.isRunning = async () => false;
    }],
    ["world-writable", (fixtures: ReturnType<typeof discoveryFixtures>) => {
      fixtures.fileSystem.lstat = async (candidate) => ({
        isSocket: true,
        isDirectory: false,
        isSymbolicLink: false,
        uid: 501,
        mode: candidate.endsWith(".sock") ? 0o606 : 0o700,
        device: 1,
        inode: 2,
      });
    }],
    ["other-UID", (fixtures: ReturnType<typeof discoveryFixtures>) => {
      fixtures.fileSystem.lstat = async () => ({
        isSocket: true,
        isDirectory: false,
        isSymbolicLink: false,
        uid: 502,
        mode: 0o600,
        device: 1,
        inode: 2,
      });
    }],
    ["symlink", (fixtures: ReturnType<typeof discoveryFixtures>) => {
      fixtures.fileSystem.lstat = async () => ({
        isSocket: true,
        isDirectory: false,
        isSymbolicLink: true,
        uid: 501,
        mode: 0o600,
        device: 1,
        inode: 2,
      });
    }],
  ] as const) {
    it(`rejects a ${name} socket endpoint`, async () => {
      const fixtures = discoveryFixtures();
      mutate(fixtures);
      await expectBridgeCode(
        () => discoverCodexDesktopIpcEndpoint(fixtures),
        "desktop_bridge_unavailable",
      );
    });
  }

  it("rejects socket and parent replacement after discovery", async () => {
    const fixtures = discoveryFixtures();
    const attested = await discoverCodexDesktopIpcEndpoint(fixtures);
    const original = fixtures.fileSystem.lstat;
    fixtures.fileSystem.lstat = async (candidate) => {
      const stat = await original(candidate);
      return candidate.endsWith(".sock")
        ? { ...stat, inode: stat.inode + 1 }
        : stat;
    };
    await expectBridgeCode(
      () => assertCodexDesktopEndpointIdentity(
        attested,
        fixtures.fileSystem,
      ),
      "desktop_bridge_unavailable",
    );

    const parentFixtures = discoveryFixtures();
    const parentAttested = await discoverCodexDesktopIpcEndpoint(
      parentFixtures,
    );
    const parentOriginal = parentFixtures.fileSystem.lstat;
    parentFixtures.fileSystem.lstat = async (candidate) => {
      const stat = await parentOriginal(candidate);
      return candidate.endsWith(".sock")
        ? stat
        : { ...stat, mode: 0o777 };
    };
    await expectBridgeCode(
      () => assertCodexDesktopEndpointIdentity(
        parentAttested,
        parentFixtures.fileSystem,
      ),
      "desktop_bridge_unavailable",
    );
  });
});
