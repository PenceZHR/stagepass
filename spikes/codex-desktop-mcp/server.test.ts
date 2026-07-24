import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createFdAuthorizationChannel,
  createPhase0McpServer,
  PHASE0_RESOURCE_URI,
} from "./server.ts";
import {
  createCodexPhase0SqliteJournal,
  type CodexPhase0SqliteJournal,
} from "../../server/services/codex-phase0-sqlite-journal.ts";
import {
  Phase0AuthorizationBroker,
  attestPhase0CodexLaunch,
  bindAuthorizationChannel,
  Phase0SupervisorError,
  type Phase0AuthorizedHostDispatch,
  type Phase0LaunchAttestationProbe,
  Phase0ServerChildSupervisor,
} from "./supervisor.ts";
import { requestPhase0Continuation } from "./ui.ts";
import {
  createPhase0HostTransport,
  MCP_EXT_APPS_HOST_TRANSPORT_EVIDENCE,
} from "./host-transport.ts";

const THREAD_ID = "THREAD-PHASE0";
const execFileAsync = promisify(execFile);

function lineReader(stream: PassThrough): () => Promise<string> {
  let buffer = "";
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  return () => {
    const line = lines.shift();
    return line === undefined
      ? new Promise((resolve) => waiters.push(resolve))
      : Promise.resolve(line);
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function terminalResult(
  supervisor: Phase0ServerChildSupervisor,
): Promise<number> {
  return new Promise((resolve) => {
    supervisor.onTerminal = resolve;
  });
}

function trustedLaunchProbe(): Phase0LaunchAttestationProbe {
  const main = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
  const codex = "/Applications/ChatGPT.app/Contents/Resources/codex";
  return {
    platform: "darwin",
    currentParentPid: () => 100,
    processIdentity(pid) {
      if (pid === 100) {
        return {
          pid,
          parentPid: 200,
          startTime: "parent-start",
          executablePath: codex,
          device: 1,
          inode: 100,
        };
      }
      if (pid === 200) {
        return {
          pid,
          parentPid: 1,
          startTime: "main-start",
          executablePath: main,
          device: 1,
          inode: 200,
        };
      }
      throw new Error("unexpected pid");
    },
    codeSignature(executablePath) {
      return {
        teamIdentifier: "2DC432GLL2",
        identifier: executablePath === main ? "com.openai.codex" : "codex",
      };
    },
  };
}

function verifiedBroker(
  options: ConstructorParameters<typeof Phase0AuthorizationBroker>[1] = {},
) {
  return new Phase0AuthorizationBroker(
    attestPhase0CodexLaunch(trustedLaunchProbe()),
    options,
  );
}

async function connectedFixture(now = () => 1_000): Promise<{
  client: Client;
  broker: Phase0AuthorizationBroker;
}> {
  const broker = verifiedBroker({ now, nonceTtlMs: 100 });
  const authorization = broker.createProtectedChannel();
  const server = createPhase0McpServer({ authorization });
  const client = new Client(
    { name: "phase0-test-host", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, broker };
}

async function connectAuthorization(
  authorization: ReturnType<Phase0AuthorizationBroker["createProtectedChannel"]>,
): Promise<Client> {
  const server = createPhase0McpServer({ authorization });
  const client = new Client(
    { name: "phase0-restart-test-host", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

async function seedVerificationJournal(input: {
  runId: string;
  interactionId: string;
  threadId: string;
}): Promise<{
  databasePath: string;
  journal: CodexPhase0SqliteJournal;
}> {
  const root = path.resolve(".stagepass", "verification");
  fs.mkdirSync(root, { recursive: true });
  const databasePath = path.join(
    root,
    `codex-desktop-bridge-phase0-${input.runId}.sqlite`,
  );
  const journal = createCodexPhase0SqliteJournal({ databasePath });
  const now = Date.now();
  const seeded = await journal.seedManagedRun({
    ownerKind: "project_ai_run",
    ownerId: `SERVER-TEST-${input.runId}`,
    projectId: `PROJECT-${input.runId}`,
    scopeKind: "project_prd",
    scopeId: `PROJECT-${input.runId}`,
    phase: "Interaction",
    role: "interaction_wakeup",
    round: 0,
    ordinal: 0,
    purpose: "interaction_wakeup",
    binding: {
      threadId: input.threadId,
      cwd: process.cwd(),
      title: "Phase 0 server restart test",
    },
    request: {
      cwd: process.cwd(),
      prompt: "Phase 0 server restart test",
      approvalPolicy: "never",
      sandboxMode: "read-only",
    },
    deadlineAt: new Date(now + 120_000).toISOString(),
    leaseExpiresAt: new Date(now + 120_000).toISOString(),
  });
  await journal.createInteractionWakeup({
    interactionId: input.interactionId,
    logicalTurnId: seeded.logicalTurnId,
    cardVersion: 1,
  });
  return { databasePath, journal };
}

function hostMeta(
  caller: "model" | "app",
  threadId = THREAD_ID,
): Record<string, unknown> {
  return {
    "stagepass/source-thread-attestation": threadId,
    "stagepass/caller": caller,
  };
}

describe("Phase 0 MCP/App fixture metadata", () => {
  it("registers exactly one UI resource and exactly two visibility-pinned tools", async () => {
    const { client } = await connectedFixture();
    const [{ tools }, { resources }] = await Promise.all([
      client.listTools(),
      client.listResources(),
    ]);

    assert.deepEqual(
      tools.map(({ name }) => name).sort(),
      ["present_phase0_card", "submit_phase0_card"],
    );
    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.uri, PHASE0_RESOURCE_URI);

    const present = tools.find(({ name }) => name === "present_phase0_card");
    assert.deepEqual(present?._meta?.ui, {
      resourceUri: PHASE0_RESOURCE_URI,
      visibility: ["model", "app"],
    });
    assert.equal(present?._meta?.["openai/widgetAccessible"], true);

    const submit = tools.find(({ name }) => name === "submit_phase0_card");
    assert.deepEqual(submit?._meta?.ui, {
      resourceUri: PHASE0_RESOURCE_URI,
      visibility: ["app"],
    });
    assert.equal(submit?._meta?.["openai/visibility"], "private");
  });

  it("returns the single-use nonce only in App-private result metadata", async () => {
    const { client } = await connectedFixture();
    const result = await client.callTool({
      name: "present_phase0_card",
      arguments: { threadId: THREAD_ID },
      _meta: hostMeta("model"),
    });
    const serializedPublicResult = JSON.stringify({
      content: result.content,
      structuredContent: result.structuredContent,
    });
    const privateMeta = result._meta?.stagepassPhase0 as
      | { nonce: string; nonceId: string; threadId: string }
      | undefined;

    assert.ok(privateMeta);
    assert.equal(privateMeta.threadId, THREAD_ID);
    assert.deepEqual(result.structuredContent, {
      ready: true,
      modelSubmitRejected: true,
      sourceNegativeMatrix: {
        presentMissing: true,
        statusCrossThread: true,
        submitMissing: true,
        submitCrossThread: true,
      },
    });
    assert.equal(serializedPublicResult.includes(privateMeta.nonce), false);
    assert.equal(serializedPublicResult.includes(privateMeta.nonceId), false);
  });

  it("returns no present/status structure for missing or cross-thread source", async () => {
    const { client } = await connectedFixture();
    for (const action of ["present", "status"] as const) {
      for (const source of [undefined, "THREAD-OTHER"] as const) {
        const result = await client.callTool({
          name: "present_phase0_card",
          arguments: { action, threadId: THREAD_ID },
          ...(source
            ? { _meta: hostMeta("model", source) }
            : { _meta: { "stagepass/caller": "model" } }),
        });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        assert.match(JSON.stringify(result.content), /source_thread_mismatch/);
      }
    }
  });

  it("does not retain nonces for status, invalid, or cross-binding calls while preserving present and click", async () => {
    const runId = randomUUID();
    const interactionId = `INTERACTION-${runId}`;
    const fixture = await seedVerificationJournal({
      runId,
      interactionId,
      threadId: "THREAD-BOUND",
    });
    const { client, broker } = await connectedFixture(() => Date.now());
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const status = await client.callTool({
          name: "present_phase0_card",
          arguments: { action: "status", threadId: THREAD_ID },
          _meta: hostMeta("model"),
        });
        assert.equal(status.isError, undefined);
        assert.equal(status._meta?.stagepassPhase0, undefined);
      }
      assert.deepEqual(broker.inspectResourceUsage(), {
        activeNonces: 0,
        settledTombstones: 0,
        retainedNonceSecrets: 0,
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const invalid = await client.callTool({
          name: "present_phase0_card",
          arguments: {
            threadId: THREAD_ID,
            verificationRunId: randomUUID(),
          },
          _meta: hostMeta("model"),
        });
        assert.equal(invalid.isError, true);
        assert.match(
          JSON.stringify(invalid.content),
          /phase0_verification_wakeup_invalid/,
        );
      }
      assert.deepEqual(broker.inspectResourceUsage(), {
        activeNonces: 0,
        settledTombstones: 0,
        retainedNonceSecrets: 0,
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const crossBinding = await client.callTool({
          name: "present_phase0_card",
          arguments: {
            threadId: THREAD_ID,
            verificationJournalPath: fixture.databasePath,
            verificationRunId: runId,
            interactionId,
            cardVersion: 1,
          },
          _meta: hostMeta("model"),
        });
        assert.equal(crossBinding.isError, true);
        assert.match(
          JSON.stringify(crossBinding.content),
          /source_thread_mismatch/,
        );
      }
      assert.deepEqual(broker.inspectResourceUsage(), {
        activeNonces: 0,
        settledTombstones: 0,
        retainedNonceSecrets: 0,
      });

      const present = await client.callTool({
        name: "present_phase0_card",
        arguments: { threadId: THREAD_ID },
        _meta: hostMeta("model"),
      });
      const privateNonce = present._meta?.stagepassPhase0 as {
        nonceId: string;
        nonce: string;
      };
      assert.ok(privateNonce);
      assert.equal(broker.inspectResourceUsage().activeNonces, 1);

      const click = await client.callTool({
        name: "submit_phase0_card",
        arguments: {
          threadId: THREAD_ID,
          nonceId: privateNonce.nonceId,
          nonce: privateNonce.nonce,
        },
        _meta: hostMeta("app"),
      });
      assert.equal(click.isError, undefined);
      const hostDispatch = (
        click.structuredContent as {
          hostDispatch: Phase0AuthorizedHostDispatch;
        }
      ).hostDispatch;
      assert.equal(hostDispatch.nonceId, privateNonce.nonceId);

      const ack = await client.callTool({
        name: "submit_phase0_card",
        arguments: {
          action: "ack",
          ...hostDispatch,
        },
        _meta: hostMeta("app"),
      });
      assert.equal(ack.isError, undefined);
      assert.equal(broker.inspectResourceUsage().activeNonces, 0);
    } finally {
      fixture.journal.close();
      fs.rmSync(fixture.databasePath, { force: true });
    }
  });

  it("revokes a nonce when presentation fails before private metadata handoff", async () => {
    const broker = verifiedBroker({
      now: () => Date.now(),
      nonceTtlMs: 120_000,
    });
    const authorization = broker.createProtectedChannel();
    const client = await connectAuthorization({
      ...authorization,
      async submit(request) {
        if (request.caller === "model") {
          throw new Error("injected_model_submit_failure");
        }
        return authorization.submit(request);
      },
    });

    const result = await client.callTool({
      name: "present_phase0_card",
      arguments: { threadId: THREAD_ID },
      _meta: hostMeta("model"),
    });

    assert.equal(result.isError, true);
    assert.match(
      JSON.stringify(result.content),
      /model_submit_rejection_unproven/,
    );
    assert.deepEqual(broker.inspectResourceUsage(), {
      activeNonces: 0,
      settledTombstones: 0,
      retainedNonceSecrets: 0,
    });
  });

  it("recovers the same dispatch after submit response loss and server restarts", async () => {
    const runId = randomUUID();
    const interactionId = `INTERACTION-${runId}`;
    const fixture = await seedVerificationJournal({
      runId,
      interactionId,
      threadId: THREAD_ID,
    });
    const broker = verifiedBroker({
      now: () => Date.now(),
      nonceTtlMs: 120_000,
    });
    const authorization = broker.createProtectedChannel();
    try {
      const presentClient = await connectAuthorization(authorization);
      const present = await presentClient.callTool({
        name: "present_phase0_card",
        arguments: {
          threadId: THREAD_ID,
          verificationJournalPath: fixture.databasePath,
          verificationRunId: runId,
          interactionId,
          cardVersion: 1,
        },
        _meta: hostMeta("model"),
      });
      const privateNonce = present._meta?.stagepassPhase0 as {
        nonceId: string;
        nonce: string;
      };
      assert.equal(
        fixture.journal.readVerificationWakeup(privateNonce.nonceId).state,
        "minted",
      );

      const submitClientAfterRestart = await connectAuthorization(authorization);
      const submit = await submitClientAfterRestart.callTool({
        name: "submit_phase0_card",
        arguments: {
          action: "submit",
          threadId: THREAD_ID,
          nonceId: privateNonce.nonceId,
          nonce: privateNonce.nonce,
          verificationRunId: runId,
        },
        _meta: hostMeta("app"),
      });
      const hostDispatch = (
        submit.structuredContent as { hostDispatch: Record<string, unknown> }
      ).hostDispatch;
      const authorized = fixture.journal.readVerificationWakeup(
        privateNonce.nonceId,
      );
      assert.equal(authorized.state, "authorized");
      assert.equal(authorized.jobId, hostDispatch.wakeupJobId);
      assert.equal(authorized.attemptId, hostDispatch.wakeupAttemptId);
      assert.equal(authorized.markerMessage, hostDispatch.markerMessage);

      const retrieveClientAfterResponseLoss =
        await connectAuthorization(authorization);
      const retrieved = await retrieveClientAfterResponseLoss.callTool({
        name: "submit_phase0_card",
        arguments: {
          action: "submit",
          threadId: THREAD_ID,
          nonceId: privateNonce.nonceId,
          nonce: privateNonce.nonce,
          verificationRunId: runId,
        },
        _meta: hostMeta("app"),
      });
      assert.deepEqual(
        (
          retrieved.structuredContent as {
            hostDispatch: Record<string, unknown>;
          }
        ).hostDispatch,
        hostDispatch,
      );
      assert.equal(
        fixture.journal.inspectInteractionWakeup(interactionId).dispatchCount,
        1,
      );

      const recoveredDispatch = (
        retrieved.structuredContent as {
          hostDispatch: Phase0AuthorizedHostDispatch;
        }
      ).hostDispatch;
      const ackClientAfterRestart = await connectAuthorization(authorization);
      const transportCalls: string[] = [];
      const hostTransport = createPhase0HostTransport({
        async sendMessage(input) {
          transportCalls.push("ui/message");
          assert.equal(input.content[0]?.text, recoveredDispatch.markerMessage);
          return {};
        },
        async callServerTool(input) {
          transportCalls.push(input.name);
          const result = await ackClientAfterRestart.callTool({
            ...input,
            _meta: hostMeta("app"),
          });
          return { isError: result.isError };
        },
      });
      await hostTransport.deliver(recoveredDispatch);
      await hostTransport.deliver(recoveredDispatch);
      assert.deepEqual(transportCalls, [
        "ui/message",
        "submit_phase0_card",
      ]);
      assert.equal(
        fixture.journal.readVerificationWakeup(privateNonce.nonceId).state,
        "acked",
      );
      const settledClientAfterRestart =
        await connectAuthorization(authorization);
      let settledMessages = 0;
      let settledAcks = 0;
      const settledTransport = createPhase0HostTransport({
        async sendMessage() {
          settledMessages += 1;
          return {};
        },
        async callServerTool() {
          settledAcks += 1;
          return {};
        },
      });
      const settledReplay = await settledClientAfterRestart.callTool({
        name: "submit_phase0_card",
        arguments: {
          threadId: THREAD_ID,
          nonceId: privateNonce.nonceId,
          nonce: privateNonce.nonce,
          verificationRunId: runId,
        },
        _meta: hostMeta("app"),
      });
      const replayDispatch = (
        settledReplay.structuredContent as {
          hostDispatch?: Phase0AuthorizedHostDispatch;
        } | undefined
      )?.hostDispatch;
      if (replayDispatch) await settledTransport.deliver(replayDispatch);
      assert.equal(settledReplay.isError, true);
      assert.equal(settledMessages, 0);
      assert.equal(settledAcks, 0);
      assert.deepEqual(
        fixture.journal.inspectInteractionWakeup(interactionId),
        {
          decisionCount: 1,
          jobCount: 1,
          attemptCount: 1,
          executionCount: 1,
          effectCount: 1,
          outboxCount: 1,
          receiptCount: 1,
          dispatchCount: 1,
          dispatchSurfaces: [
            "host_ui_message",
            "host_ui_message",
            "host_ui_message",
          ],
          jobId: authorized.jobId,
          attemptId: authorized.attemptId,
        },
      );
    } finally {
      fixture.journal.close();
      fs.rmSync(fixture.databasePath, { force: true });
    }
  });

  it("rejects cross-journal and cross-interaction bindings with zero journal mutation", async () => {
    const leftRunId = randomUUID();
    const rightRunId = randomUUID();
    const leftInteractionId = `INTERACTION-${leftRunId}`;
    const rightInteractionId = `INTERACTION-${rightRunId}`;
    const left = await seedVerificationJournal({
      runId: leftRunId,
      interactionId: leftInteractionId,
      threadId: "THREAD-LEFT",
    });
    const right = await seedVerificationJournal({
      runId: rightRunId,
      interactionId: rightInteractionId,
      threadId: "THREAD-RIGHT",
    });
    try {
      const { client } = await connectedFixture(() => Date.now());
      const crossJournal = await client.callTool({
        name: "present_phase0_card",
        arguments: {
          threadId: "THREAD-RIGHT",
          verificationJournalPath: right.databasePath,
          verificationRunId: rightRunId,
          interactionId: leftInteractionId,
          cardVersion: 1,
        },
        _meta: hostMeta("model", "THREAD-RIGHT"),
      });
      assert.equal(crossJournal.isError, true);

      const crossInteraction = await client.callTool({
        name: "present_phase0_card",
        arguments: {
          threadId: "THREAD-LEFT",
          verificationJournalPath: right.databasePath,
          verificationRunId: rightRunId,
          interactionId: rightInteractionId,
          cardVersion: 1,
        },
        _meta: hostMeta("model", "THREAD-LEFT"),
      });
      assert.equal(crossInteraction.isError, true);
      assert.match(
        JSON.stringify(crossInteraction.content),
        /source_thread_mismatch/,
      );

      for (const [journal, interactionId] of [
        [left.journal, leftInteractionId],
        [right.journal, rightInteractionId],
      ] as const) {
        const evidence = journal.inspectInteractionWakeup(interactionId);
        assert.deepEqual({
          decisionCount: evidence.decisionCount,
          jobCount: evidence.jobCount,
          attemptCount: evidence.attemptCount,
          outboxCount: evidence.outboxCount,
          dispatchCount: evidence.dispatchCount,
        }, {
          decisionCount: 0,
          jobCount: 0,
          attemptCount: 0,
          outboxCount: 0,
          dispatchCount: 0,
        });
      }
    } finally {
      left.journal.close();
      right.journal.close();
      fs.rmSync(left.databasePath, { force: true });
      fs.rmSync(right.databasePath, { force: true });
    }
  });
});

async function expectSupervisorCode(
  body: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(body, (error: unknown) => {
    assert.ok(error instanceof Phase0SupervisorError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("Phase 0 protected submit broker", () => {
  it("closes malformed or over-cap protected authorization generations", async () => {
    const malformedInput = new PassThrough();
    const malformedOutput = new PassThrough();
    const malformed = Duplex.from({
      readable: malformedInput,
      writable: malformedOutput,
    });
    malformed.on("error", () => {});
    bindAuthorizationChannel(malformed, {
      mint: async () => new Promise<never>(() => {}),
      revoke: async () => new Promise<never>(() => {}),
      submit: async () => new Promise<never>(() => {}),
      ack: async () => new Promise<never>(() => {}),
    });
    malformedInput.write("{not-json}\n");
    await waitUntil(() => malformed.destroyed);

    const floodInput = new PassThrough();
    const floodOutput = new PassThrough();
    const flooded = Duplex.from({
      readable: floodInput,
      writable: floodOutput,
    });
    flooded.on("error", () => {});
    bindAuthorizationChannel(flooded, {
      mint: async () => new Promise<never>(() => {}),
      revoke: async () => new Promise<never>(() => {}),
      submit: async () => new Promise<never>(() => {}),
      ack: async () => new Promise<never>(() => {}),
    });
    for (let index = 0; index < 65; index += 1) {
      floodInput.write(`${JSON.stringify({
        id: `REQ-${index}`,
        op: "mint",
        body: {},
      })}\n`);
    }
    await waitUntil(() => flooded.destroyed);
  });

  it("rejects FD pending work on malformed input and enforces inflight caps", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const channel = createFdAuthorizationChannel(3, { input, output });
    const pending = channel.mint({
      sourceThreadId: THREAD_ID,
      requestedThreadId: THREAD_ID,
    });
    input.write("{not-json}\n");
    await assert.rejects(pending, /protected_fd_frame_invalid/);
    assert.equal(input.destroyed, true);
    assert.equal(output.destroyed, true);

    const cappedInput = new PassThrough();
    const cappedOutput = new PassThrough();
    const capped = createFdAuthorizationChannel(3, {
      input: cappedInput,
      output: cappedOutput,
    });
    const requests = Array.from({ length: 64 }, () =>
      capped.mint({
        sourceThreadId: THREAD_ID,
        requestedThreadId: THREAD_ID,
      }).catch(() => undefined));
    await assert.rejects(
      capped.mint({
        sourceThreadId: THREAD_ID,
        requestedThreadId: THREAD_ID,
      }),
      /inflight limit/,
    );
    cappedInput.destroy();
    await Promise.all(requests);
  });

  it("pins signed Codex process ancestry before creating one channel", async () => {
    const broker = verifiedBroker();
    broker.createProtectedChannel();
    await expectSupervisorCode(
      async () => broker.createProtectedChannel(),
      "submit_auth_channel_unavailable",
    );

    const untrusted = trustedLaunchProbe();
    untrusted.codeSignature = () => ({
      teamIdentifier: "ATTACKER",
      identifier: "codex",
    });
    assert.throws(
      () => attestPhase0CodexLaunch(untrusted),
      (error: unknown) =>
        error instanceof Phase0SupervisorError
        && error.code === "phase0_host_launch_untrusted",
    );
  });

  it("rejects an ordinary Node or zsh parent in a real child process", async (t) => {
    const supervisorPath = path.resolve(
      "spikes/codex-desktop-mcp/supervisor.ts",
    );
    try {
      await execFileAsync(
        process.execPath,
        ["--import", "tsx", supervisorPath],
        { timeout: 10_000 },
      );
      assert.fail("ordinary process unexpectedly launched supervisor");
    } catch (error) {
      const stderr = (
        typeof error === "object"
        && error !== null
        && "stderr" in error
      )
        ? String(error.stderr)
        : "";
      if (
        /EPERM|operation not permitted|phase0_host_launch_attestation_unsupported/i
          .test(stderr)
      ) {
        t.skip("process ancestry probe unsupported in this sandbox");
        return;
      }
      assert.match(stderr, /phase0_host_launch_untrusted/);
    }
  });

  it("respawns a real crashed Server child with a fresh FD and retrieves the same dispatch", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const nextLine = lineReader(output);
    const childBridge = [
      "const fs=require('node:fs');",
      "const readline=require('node:readline');",
      "const authIn=fs.createReadStream('',{fd:3,autoClose:false});",
      "const authOut=fs.createWriteStream('',{fd:3,autoClose:false});",
      "let buffer='';",
      "authIn.setEncoding('utf8');",
      "authIn.on('data',(chunk)=>{buffer+=chunk;let nl=buffer.indexOf('\\n');",
      "while(nl>=0){const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);",
      "nl=buffer.indexOf('\\n');if(line)process.stdout.write(line+'\\n');}});",
      "readline.createInterface({input:process.stdin}).on('line',(line)=>{",
      "const value=JSON.parse(line);",
      "if(value.control==='crash')process.exit(17);",
      "authOut.write(line+'\\n');});",
    ].join("");
    const supervisor = new Phase0ServerChildSupervisor(
      attestPhase0CodexLaunch(trustedLaunchProbe()),
      {
        command: process.execPath,
        args: ["-e", childBridge],
        input,
        output,
        errorOutput,
        maxRestarts: 2,
        restartBackoffMs: 5,
        maxRestartBackoffMs: 10,
      },
    );
    let requestOrdinal = 0;
    const request = async (
      op: "mint" | "submit" | "ack",
      body: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      requestOrdinal += 1;
      input.write(`${JSON.stringify({
        id: `REQ-${requestOrdinal}`,
        op,
        body,
      })}\n`);
      return JSON.parse(await nextLine()) as Record<string, unknown>;
    };
    supervisor.start();
    try {
      const firstPid = await supervisor.waitForGeneration(1);
      const verificationRunId = "00000000-0000-4000-8000-000000000021";
      const wakeupJobId = "00000000-0000-4000-8000-000000000022";
      const wakeupAttemptId = "00000000-0000-4000-8000-000000000023";
      const mintedResponse = await request("mint", {
        sourceThreadId: THREAD_ID,
        requestedThreadId: THREAD_ID,
        verificationRunId,
      });
      assert.equal(mintedResponse.ok, true);
      const minted = mintedResponse.result as {
        nonceId: string;
        nonce: string;
      };
      const submitBody = {
        caller: "app",
        sourceThreadId: THREAD_ID,
        requestedThreadId: THREAD_ID,
        nonceId: minted.nonceId,
        nonce: minted.nonce,
        verificationRunId,
        wakeupJobId,
        wakeupAttemptId,
      };
      const submitted = await request("submit", submitBody);
      assert.equal(submitted.ok, true);

      process.kill(firstPid, "SIGKILL");
      const secondPid = await supervisor.waitForGeneration(2);
      assert.notEqual(secondPid, firstPid);
      const retrieved = await request("submit", submitBody);
      assert.equal(retrieved.ok, true);
      assert.deepEqual(
        (
          retrieved.result as {
            hostDispatch: Phase0AuthorizedHostDispatch;
          }
        ).hostDispatch,
        (
          submitted.result as {
            hostDispatch: Phase0AuthorizedHostDispatch;
          }
        ).hostDispatch,
      );
    } finally {
      await supervisor.stop();
    }
  });

  it("caps abnormal Server child respawns", async () => {
    const terminal = new Promise<number>((resolve) => {
      const supervisor = new Phase0ServerChildSupervisor(
        attestPhase0CodexLaunch(trustedLaunchProbe()),
        {
          command: process.execPath,
          args: ["-e", "process.exit(17)"],
          input: new PassThrough(),
          output: new PassThrough(),
          errorOutput: new PassThrough(),
          maxRestarts: 1,
          restartBackoffMs: 1,
          maxRestartBackoffMs: 1,
        },
      );
      supervisor.onTerminal = (code) => {
        assert.equal(supervisor.generation, 2);
        resolve(code);
      };
      supervisor.start();
    });
    assert.equal(await terminal, 17);
  });

  it("treats Host stdin EOF as terminal while a real child is running", async () => {
    const input = new PassThrough();
    const supervisor = new Phase0ServerChildSupervisor(
      attestPhase0CodexLaunch(trustedLaunchProbe()),
      {
        command: process.execPath,
        args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
        input,
        output: new PassThrough(),
        errorOutput: new PassThrough(),
        maxRestarts: 3,
        restartBackoffMs: 10,
      },
    );
    let terminalCalls = 0;
    const terminal = new Promise<number>((resolve) => {
      supervisor.onTerminal = (code) => {
        terminalCalls += 1;
        resolve(code);
      };
    });
    supervisor.start();
    const childPid = await supervisor.waitForGeneration(1);
    input.end();
    assert.equal(await terminal, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(terminalCalls, 1);
    assert.equal(supervisor.generation, 1);
    assert.equal(supervisor.childPid, null);
    assert.equal(supervisor.hasPendingRestart, false);
    assert.throws(() => process.kill(childPid, 0));
    assert.equal(input.listenerCount("end"), 0);
    assert.equal(input.listenerCount("finish"), 0);
    assert.equal(input.listenerCount("close"), 0);
    assert.equal(input.listenerCount("error"), 0);
    assert.equal(input.listenerCount("data"), 0);
  });

  it("cancels backoff when Host stdin ends and never respawns", async () => {
    const input = new PassThrough();
    const supervisor = new Phase0ServerChildSupervisor(
      attestPhase0CodexLaunch(trustedLaunchProbe()),
      {
        command: process.execPath,
        args: ["-e", "process.exit(17)"],
        input,
        output: new PassThrough(),
        errorOutput: new PassThrough(),
        maxRestarts: 3,
        restartBackoffMs: 250,
        maxRestartBackoffMs: 250,
      },
    );
    const terminal = terminalResult(supervisor);
    supervisor.start();
    await supervisor.waitForGeneration(1);
    await waitUntil(() => supervisor.hasPendingRestart);
    input.end();
    assert.equal(await terminal, 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(supervisor.generation, 1);
    assert.equal(supervisor.childPid, null);
    assert.equal(supervisor.hasPendingRestart, false);
    assert.equal(input.listenerCount("end"), 0);
    assert.equal(input.listenerCount("finish"), 0);
    assert.equal(input.listenerCount("close"), 0);
    assert.equal(input.listenerCount("error"), 0);
    assert.equal(input.listenerCount("data"), 0);
  });

  it("binds nonce to Host-attested source thread and consumes it once", async () => {
    const broker = verifiedBroker({
      now: () => 1_000,
      nonceTtlMs: 100,
    });
    const channel = broker.createProtectedChannel();
    const minted = await channel.mint({
      sourceThreadId: THREAD_ID,
      requestedThreadId: THREAD_ID,
    });

    const submitted = await channel.submit({
      caller: "app",
      sourceThreadId: THREAD_ID,
      requestedThreadId: THREAD_ID,
      nonceId: minted.nonceId,
      nonce: minted.nonce,
    });
    assert.equal(submitted.ok, true);
    assert.equal(submitted.threadId, THREAD_ID);
    assert.equal(submitted.nonceId, minted.nonceId);
    assert.match(
      submitted.hostDispatch.markerMessage,
      /^STAGEPASS_PHASE0_WAKEUP /,
    );
    assert.deepEqual(
      await channel.ack({
        ...submitted.hostDispatch,
        caller: "app",
        sourceThreadId: THREAD_ID,
      }),
      {
        ok: true,
        wakeupJobId: submitted.hostDispatch.wakeupJobId,
        duplicate: false,
      },
    );
    assert.equal(
      (await channel.ack({
        ...submitted.hostDispatch,
        caller: "app",
        sourceThreadId: THREAD_ID,
      })).duplicate,
      true,
    );
    assert.deepEqual(broker.inspectResourceUsage(), {
      activeNonces: 0,
      settledTombstones: 1,
      retainedNonceSecrets: 0,
    });
    await expectSupervisorCode(
      () => channel.ack({
        ...submitted.hostDispatch,
        authorizationTag: "x".repeat(
          submitted.hostDispatch.authorizationTag.length,
        ),
        caller: "app",
        sourceThreadId: THREAD_ID,
      }),
      "dispatch_ack_stale",
    );
    await expectSupervisorCode(
      () => channel.submit({
        caller: "app",
        sourceThreadId: THREAD_ID,
        requestedThreadId: THREAD_ID,
        nonceId: minted.nonceId,
        nonce: minted.nonce,
      }),
      "dispatch_settled",
    );
  });

  it("retrieves only the identical run-scoped durable dispatch after response loss", async () => {
    const broker = verifiedBroker({
      now: () => 1_000,
      nonceTtlMs: 100,
    });
    const channel = broker.createProtectedChannel();
    const verificationRunId = "00000000-0000-4000-8000-000000000011";
    const wakeupJobId = "00000000-0000-4000-8000-000000000012";
    const wakeupAttemptId = "00000000-0000-4000-8000-000000000013";
    const minted = await channel.mint({
      sourceThreadId: THREAD_ID,
      requestedThreadId: THREAD_ID,
      verificationRunId,
    });
    const request = {
      caller: "app" as const,
      sourceThreadId: THREAD_ID,
      requestedThreadId: THREAD_ID,
      nonceId: minted.nonceId,
      nonce: minted.nonce,
      verificationRunId,
      wakeupJobId,
      wakeupAttemptId,
    };
    const submitted = await channel.submit(request);
    const retrieved = await channel.submit(request);
    assert.deepEqual(retrieved.hostDispatch, submitted.hostDispatch);
    await expectSupervisorCode(
      () => channel.submit({
        ...request,
        wakeupAttemptId: "00000000-0000-4000-8000-000000000014",
      }),
      "nonce_replay_mismatch",
    );
    await expectSupervisorCode(
      () => channel.submit({
        ...request,
        verificationRunId: "00000000-0000-4000-8000-000000000015",
      }),
      "verification_run_mismatch",
    );
    await channel.ack({
      ...submitted.hostDispatch,
      caller: "app",
      sourceThreadId: THREAD_ID,
    });
    await expectSupervisorCode(
      () => channel.submit(request),
      "dispatch_settled",
    );
  });

  it("rejects missing attestation, wrong thread, expiry, and model invocation", async () => {
    let now = 1_000;
    const broker = verifiedBroker({
      now: () => now,
      nonceTtlMs: 100,
    });
    const channel = broker.createProtectedChannel();
    await expectSupervisorCode(
      () => channel.mint({
        sourceThreadId: "",
        requestedThreadId: THREAD_ID,
      }),
      "source_thread_mismatch",
    );
    const minted = await channel.mint({
      sourceThreadId: THREAD_ID,
      requestedThreadId: THREAD_ID,
    });
    await expectSupervisorCode(
      () => channel.submit({
        caller: "app",
        sourceThreadId: THREAD_ID,
        requestedThreadId: "THREAD-OTHER",
        nonceId: minted.nonceId,
        nonce: minted.nonce,
      }),
      "source_thread_mismatch",
    );
    await expectSupervisorCode(
      () => channel.submit({
        caller: "model",
        sourceThreadId: THREAD_ID,
        requestedThreadId: THREAD_ID,
        nonceId: minted.nonceId,
        nonce: minted.nonce,
      }),
      "model_invocation_forbidden",
    );
    now = 1_101;
    await expectSupervisorCode(
      () => channel.submit({
        caller: "app",
        sourceThreadId: THREAD_ID,
        requestedThreadId: THREAD_ID,
        nonceId: minted.nonceId,
        nonce: minted.nonce,
      }),
      "nonce_expired",
    );
  });

  it("bounds active nonces and rate limits minting with expiry cleanup", async () => {
    let now = 1_000;
    const capacityBroker = verifiedBroker({
      now: () => now,
      nonceTtlMs: 100,
      maxNonces: 1,
      maxNoncesPerRun: 1,
      maxNoncesPerThread: 1,
      maxMintsPerMinute: 10,
    });
    const capacity = capacityBroker.createProtectedChannel();
    await capacity.mint({
      sourceThreadId: THREAD_ID,
      requestedThreadId: THREAD_ID,
    });
    await expectSupervisorCode(
      () => capacity.mint({
        sourceThreadId: THREAD_ID,
        requestedThreadId: THREAD_ID,
      }),
      "nonce_capacity_exceeded",
    );
    now = 1_101;
    await capacity.mint({
      sourceThreadId: THREAD_ID,
      requestedThreadId: THREAD_ID,
    });

    now = 10_000;
    const rateBroker = verifiedBroker({
      now: () => now,
      nonceTtlMs: 120_000,
      maxMintsPerMinute: 1,
    });
    const rate = rateBroker.createProtectedChannel();
    await rate.mint({
      sourceThreadId: THREAD_ID,
      requestedThreadId: THREAD_ID,
    });
    await expectSupervisorCode(
      () => rate.mint({
        sourceThreadId: THREAD_ID,
        requestedThreadId: THREAD_ID,
      }),
      "nonce_rate_limited",
    );
    now += 60_001;
    await rate.mint({
      sourceThreadId: THREAD_ID,
      requestedThreadId: THREAD_ID,
    });
  });

  it("rejects callers without the inherited channel and an ordinary process MAC", async () => {
    const broker = verifiedBroker({
      now: () => 1_000,
      nonceTtlMs: 100,
    });
    await expectSupervisorCode(
      () => broker.submitWithoutProtectedChannel({
        caller: "app",
        sourceThreadId: THREAD_ID,
        requestedThreadId: THREAD_ID,
        nonceId: "known-route-id",
        nonce: "known-body",
        mac: "forged",
      }),
      "submit_auth_channel_unavailable",
    );
  });
});

describe("Phase 0 UI ordering", () => {
  it("pins the ext-apps view-to-Host ui/message API boundary", () => {
    const packageJson = JSON.parse(fs.readFileSync(
      path.join(
        process.cwd(),
        "node_modules/@modelcontextprotocol/ext-apps/package.json",
      ),
      "utf8",
    )) as { version?: string };
    const appTypes = fs.readFileSync(
      path.join(
        process.cwd(),
        "node_modules/@modelcontextprotocol/ext-apps/dist/src/app.d.ts",
      ),
      "utf8",
    );
    const specTypes = fs.readFileSync(
      path.join(
        process.cwd(),
        "node_modules/@modelcontextprotocol/ext-apps/dist/src/spec.types.d.ts",
      ),
      "utf8",
    );
    assert.equal(
      packageJson.version,
      MCP_EXT_APPS_HOST_TRANSPORT_EVIDENCE.packageVersion,
    );
    assert.match(appTypes, /sendMessage\(params: McpUiMessageRequest/);
    assert.ok(specTypes.includes(
      MCP_EXT_APPS_HOST_TRANSPORT_EVIDENCE.hostCapability,
    ));
    assert.equal(
      MCP_EXT_APPS_HOST_TRANSPORT_EVIDENCE.viewApi,
      "App.sendMessage",
    );
  });

  const dispatch = {
    threadId: THREAD_ID,
    nonceId: "00000000-0000-4000-8000-000000000001",
    wakeupJobId: "00000000-0000-4000-8000-000000000002",
    wakeupAttemptId: "00000000-0000-4000-8000-000000000003",
    markerMessage: [
      "STAGEPASS_PHASE0_WAKEUP",
      THREAD_ID,
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ].join(" "),
    expiresAt: Date.now() + 60_000,
    authorizationTag: "a".repeat(43),
  };

  it("submits privately before invoking the single Host transport wrapper", async () => {
    const calls: string[] = [];
    const authorized = await requestPhase0Continuation(
      {
        async callServerTool() {
          calls.push("submit");
          return { content: [], structuredContent: { hostDispatch: dispatch } };
        },
      },
      {
        threadId: THREAD_ID,
        nonceId: "NONCE-1",
        nonce: "NONCE-VALUE",
      },
    );
    calls.push("transport");
    assert.equal(authorized, dispatch);
    assert.deepEqual(calls, ["submit", "transport"]);
  });

  it("does not invoke Host transport when private submit fails", async () => {
    await assert.rejects(
      () => requestPhase0Continuation(
        {
          async callServerTool() {
            return { content: [], isError: true };
          },
        },
        {
          threadId: THREAD_ID,
          nonceId: "NONCE-1",
          nonce: "NONCE-VALUE",
        },
      ),
    );
  });

  it("does not send ui/message when submit omits durable dispatch authority", async () => {
    let submits = 0;
    await assert.rejects(
      () => requestPhase0Continuation(
        {
          async callServerTool() {
            submits += 1;
            return { content: [] };
          },
        },
        {
          threadId: THREAD_ID,
          nonceId: "NONCE-1",
          nonce: "NONCE-VALUE",
        },
      ),
    );
    assert.equal(submits, 1);
  });

  it("keeps ui/message in the receipt-validating Host transport only", async () => {
    const uiSource = fs.readFileSync(
      path.join(process.cwd(), "spikes/codex-desktop-mcp/ui.ts"),
      "utf8",
    );
    assert.equal(uiSource.includes(".sendMessage("), false);

    const calls: string[] = [];
    const transport = createPhase0HostTransport({
      async sendMessage(input) {
        calls.push("message");
        assert.equal(input.content[0]?.text, dispatch.markerMessage);
        return {};
      },
      async callServerTool(input) {
        calls.push(input.name);
        assert.deepEqual(input.arguments, { action: "ack", ...dispatch });
        return {};
      },
    });
    await transport.deliver(dispatch);
    await transport.deliver(dispatch);
    assert.deepEqual(calls, ["message", "submit_phase0_card"]);
  });

  it("does not acknowledge when Host transport fails and rejects stale receipts", async () => {
    let acknowledgements = 0;
    const transport = createPhase0HostTransport({
      async sendMessage() {
        return { isError: true };
      },
      async callServerTool() {
        acknowledgements += 1;
        return {};
      },
    });
    await assert.rejects(() => transport.deliver(dispatch));
    assert.equal(acknowledgements, 0);
    await assert.rejects(() => transport.deliver({
      ...dispatch,
      expiresAt: Date.now() - 1,
    }));
    assert.equal(acknowledgements, 0);
  });

  it("does not treat a rejected protected ack as settled", async () => {
    let messages = 0;
    const transport = createPhase0HostTransport({
      async sendMessage() {
        messages += 1;
        return {};
      },
      async callServerTool() {
        return { isError: true };
      },
    });
    await assert.rejects(() => transport.deliver(dispatch));
    assert.equal(messages, 1);
  });
});
