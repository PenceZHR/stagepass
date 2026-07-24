import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import Database from "better-sqlite3";

import type { CodexAppServerShellControl } from "./codex-app-server-shell-control.ts";
import {
  CodexDesktopBridgeError,
  createCodexDesktopBridge,
} from "./codex-desktop-bridge.ts";
import type { CodexDesktopFollowerTransport } from "./codex-desktop-ipc-transport.ts";
import {
  REQUIRED_APP_SERVER_SHELL_CAPABILITIES,
  REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES,
  type CodexDesktopTurnRequest,
  type CodexFollowerStartAttempt,
  type CodexTurnSnapshot,
} from "./codex-desktop-bridge-types.ts";
import {
  CodexPhase0InjectedCrash,
  createCodexPhase0SqliteJournal,
  type CodexPhase0ManagedRunSeed,
  type CodexPhase0SqliteJournal,
} from "./codex-phase0-sqlite-journal.ts";
import {
  reconcileConsumedRestartCompletion,
} from "./codex-phase0-verifier-contract.ts";

const NOW = Date.parse("2026-07-23T12:00:00.000Z");
const execFileAsync = promisify(execFile);
const BASELINE = {
  turnIds: ["TURN-BASELINE"],
  semanticHash: "BASELINE-HASH",
};

function openJournal(
  databasePath: string,
  now: () => number = () => NOW,
): CodexPhase0SqliteJournal {
  return createCodexPhase0SqliteJournal({
    databasePath,
    now,
    readBaseline: async () => BASELINE,
  });
}

async function withJournal(
  body: (fixture: {
    databasePath: string;
    journal: CodexPhase0SqliteJournal;
    setNow(value: number): void;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "stagepass-phase0-journal-"),
  );
  const databasePath = path.join(directory, "phase0.sqlite");
  let currentNow = NOW;
  const journal = openJournal(databasePath, () => currentNow);
  try {
    await body({
      databasePath,
      journal,
      setNow(value) {
        currentNow = value;
      },
    });
  } finally {
    try {
      journal.close();
    } catch {
      // A crash/reopen test may already have closed this handle.
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function projectSeed(
  overrides: Partial<CodexPhase0ManagedRunSeed> = {},
): CodexPhase0ManagedRunSeed {
  return {
    ownerKind: "project_ai_run",
    ownerId: "PHASE0-RUN-1",
    projectId: "P-1",
    scopeKind: "project_prd",
    scopeId: "P-1",
    phase: "PRD",
    role: "prd_turn",
    round: 0,
    ordinal: 0,
    binding: {
      threadId: "THREAD-PRD",
      cwd: "/repo",
      title: "[P-1] Project PRD",
    },
    request: {
      cwd: "/repo",
      prompt: "verify durable hybrid execution",
      approvalPolicy: "never",
      sandboxMode: "read-only",
    },
    deadlineAt: "2026-07-23T12:10:00.000Z",
    leaseExpiresAt: "2026-07-23T12:01:00.000Z",
    ...overrides,
  };
}

async function prepare(
  journal: CodexPhase0SqliteJournal,
  seeded: Awaited<ReturnType<CodexPhase0SqliteJournal["seedManagedRun"]>>,
  attemptId = "ATTEMPT-1",
) {
  const context = await journal.logicalTurnPort.readForStart(
    seeded.logicalTurnId,
  );
  await journal.startAttemptPort.prepare({
    attemptId,
    logicalTurnId: context.logicalTurnId,
  });
  return context;
}

function expectedRestartResume(
  attempt: CodexFollowerStartAttempt,
) {
  return {
    expectedResumedLogicalTurnId: attempt.logicalTurnId,
    expectedResumedAttemptId: attempt.attemptId,
    expectedResumedThreadId: attempt.request.threadId,
    expectedResumedCanonicalBindingThreadId: attempt.request.threadId,
    expectedResumedNormalizedPromptHash: attempt.normalizedPromptHash,
  };
}

function correlatedTurn(
  turnId: string,
  request: CodexDesktopTurnRequest,
): CodexTurnSnapshot {
  return {
    threadId: request.threadId,
    turnId,
    status: "inProgress",
    items: [{
      id: `ITEM-${turnId}`,
      kind: "user_message",
      semantic: { text: request.prompt },
    }],
    metadata: { observedAt: new Date(NOW).toISOString() },
  };
}

function sqliteRecoveryFixture(
  candidateCount: 0 | 1 | 2,
  visibleAfterReads = 0,
) {
  let dispatched: CodexDesktopTurnRequest | undefined;
  let reads = 0;
  let startCalls = 0;
  const shellControl: CodexAppServerShellControl = {
    async probe() {
      return {
        version: "test",
        protocolFingerprint: "test-shell",
        capabilities: [...REQUIRED_APP_SERVER_SHELL_CAPABILITIES],
        protocolCapabilities: [...REQUIRED_APP_SERVER_SHELL_CAPABILITIES],
      };
    },
    async startPersistentThread() {
      return { threadId: "THREAD-PRD" };
    },
    async startPersistentThreadAndName(input) {
      await input.onStarted("THREAD-PRD");
      input.onCheckpoint?.("after_thread_start");
      await input.activate("THREAD-PRD");
      input.onCheckpoint?.("after_thread_activation");
      input.onCheckpoint?.("after_thread_name");
      return {
        threadId: "THREAD-PRD",
        title: input.name,
        cwd: input.cwd,
        ephemeral: false,
      };
    },
    async setThreadName() {},
    async findPersistentShell() {
      return [];
    },
    async listPersistentShells() {
      return [];
    },
    async readPersistentShell() {
      return null;
    },
    async readThreadWithTurns(input) {
      reads += 1;
      const turns = dispatched && reads > visibleAfterReads
        ? Array.from({ length: candidateCount }, (_, index) =>
          correlatedTurn(`TURN-CANDIDATE-${index + 1}`, dispatched!))
        : [];
      return {
        shell: {
          threadId: input.threadId,
          title: "[P-1] Project PRD",
          cwd: "/repo",
          ephemeral: false,
        },
        turns,
      };
    },
    async listModels() {
      return [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test" }];
    },
  };
  const follower: CodexDesktopFollowerTransport = {
    async probe() {
      return {
        clientVersion: "test",
        protocolFingerprint: "test-follower",
        capabilities: [...REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES],
        protocolCapabilities: [...REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES],
      };
    },
    async openThreadDeepLink() {},
    async startFollowerTurn(request) {
      startCalls += 1;
      dispatched = request;
      throw new Error("response_lost");
    },
    async interruptTurn() {},
  };
  return {
    shellControl,
    follower,
    startCalls: () => startCalls,
    reads: () => reads,
  };
}

function successfulFollowerFixture() {
  let dispatched: CodexDesktopTurnRequest | undefined;
  let startCalls = 0;
  const shellControl: CodexAppServerShellControl = {
    async probe() {
      return {
        version: "test",
        protocolFingerprint: "test-shell",
        capabilities: [...REQUIRED_APP_SERVER_SHELL_CAPABILITIES],
        protocolCapabilities: [...REQUIRED_APP_SERVER_SHELL_CAPABILITIES],
      };
    },
    async startPersistentThread() {
      return { threadId: "THREAD-PRD" };
    },
    async startPersistentThreadAndName(input) {
      await input.onStarted("THREAD-PRD");
      input.onCheckpoint?.("after_thread_start");
      await input.activate("THREAD-PRD");
      input.onCheckpoint?.("after_thread_activation");
      input.onCheckpoint?.("after_thread_name");
      return {
        threadId: "THREAD-PRD",
        title: input.name,
        cwd: input.cwd,
        ephemeral: false,
      };
    },
    async setThreadName() {},
    async findPersistentShell() {
      return [];
    },
    async listPersistentShells() {
      return [];
    },
    async readPersistentShell() {
      return null;
    },
    async readThreadWithTurns(input) {
      const started = dispatched
        ? correlatedTurn("TURN-SUCCESS", dispatched)
        : undefined;
      return {
        shell: {
          threadId: input.threadId,
          title: "[P-1] Project PRD",
          cwd: "/repo",
          ephemeral: false,
        },
        turns: started
          ? [{
            ...started,
            status: "completed" as const,
            terminal: { output: "PHASE0_RESTART_RESUME_OK." },
          }]
          : [],
      };
    },
    async listModels() {
      return [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test" }];
    },
  };
  const follower: CodexDesktopFollowerTransport = {
    async probe() {
      return {
        clientVersion: "test",
        protocolFingerprint: "test-follower",
        capabilities: [...REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES],
        protocolCapabilities: [...REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES],
      };
    },
    async openThreadDeepLink() {},
    async startFollowerTurn(request) {
      startCalls += 1;
      dispatched = request;
      return { status: "started", turnId: "TURN-SUCCESS" };
    },
    async interruptTurn() {},
  };
  return {
    shellControl,
    follower,
    startCalls: () => startCalls,
  };
}

function durableShellFixture() {
  const shells = new Map<string, {
    threadId: string;
    title: string;
    cwd: string;
    ephemeral: false;
  }>();
  const activated = new Set<string>();
  const opened: string[] = [];
  const materializationTurns = new Map<string, CodexTurnSnapshot>();
  let starts = 0;
  const shellControl: CodexAppServerShellControl = {
    async probe() {
      return {
        version: "test",
        protocolFingerprint: "test-shell",
        capabilities: ["model/list", "thread/list"],
        protocolCapabilities: [...REQUIRED_APP_SERVER_SHELL_CAPABILITIES],
      };
    },
    async startPersistentThread(input) {
      starts += 1;
      const threadId = `THREAD-PROVISION-${starts}`;
      shells.set(threadId, {
        threadId,
        title: "",
        cwd: input.cwd,
        ephemeral: false,
      });
      return { threadId };
    },
    async startPersistentThreadAndName(input) {
      starts += 1;
      const shell = {
        threadId: `THREAD-PROVISION-${starts}`,
        title: "",
        cwd: input.cwd,
        ephemeral: false as const,
      };
      shells.set(shell.threadId, shell);
      await input.onStarted(shell.threadId);
      input.onCheckpoint?.("after_thread_start");
      await input.activate(shell.threadId);
      input.onCheckpoint?.("after_thread_activation");
      if (!activated.has(shell.threadId)) {
        throw new Error("thread not loaded");
      }
      const named = { ...shell, title: input.name };
      shells.set(named.threadId, named);
      input.onCheckpoint?.("after_thread_name");
      return named;
    },
    async setThreadName(input) {
      const shell = shells.get(input.threadId);
      if (!shell || !activated.has(input.threadId)) {
        throw new Error("thread not loaded");
      }
      shells.set(input.threadId, { ...shell, title: input.name });
    },
    async findPersistentShell(input) {
      return [...shells.values()].filter(
        (shell) => shell.cwd === input.cwd && shell.title === input.title,
      );
    },
    async listPersistentShells(input) {
      return [...shells.values()].filter(
        (shell) => shell.cwd === input.cwd && activated.has(shell.threadId),
      );
    },
    async readPersistentShell(threadId) {
      return activated.has(threadId) ? shells.get(threadId) ?? null : null;
    },
    async readThreadWithTurns(input) {
      const shell = shells.get(input.threadId);
      if (!shell) throw new Error("shell missing");
      const turn = materializationTurns.get(input.threadId);
      return { shell, turns: turn ? [turn] : [] };
    },
    async listModels() {
      return [];
    },
  };
  const follower: CodexDesktopFollowerTransport = {
    async probe() {
      return {
        clientVersion: "test",
        protocolFingerprint: "test-follower",
        capabilities: [],
        protocolCapabilities: [...REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES],
      };
    },
    async openThreadDeepLink(input) {
      const threadId = input.url.slice("codex://threads/".length);
      opened.push(threadId);
      if (shells.has(threadId)) activated.add(threadId);
    },
    async startFollowerTurn(request) {
      const turnId = "TURN-SHELL-MATERIALIZATION";
      const started = correlatedTurn(turnId, request);
      materializationTurns.set(request.threadId, {
        ...started,
        status: "completed",
        terminal: { output: "STAGEPASS_SHELL_MATERIALIZED" },
        metadata: {
          ...started.metadata,
          completedAt: new Date(NOW + 1).toISOString(),
        },
      });
      return { status: "started", turnId };
    },
    async interruptTurn() {},
  };
  return {
    shellControl,
    follower,
    shells,
    activated,
    opened,
    starts: () => starts,
    materializationTurnCount: () => materializationTurns.size,
  };
}

describe("Codex Phase 0 SQLite journal", () => {
  it("refuses an unversioned legacy ready-state journal", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "stagepass-phase0-"));
    const databasePath = path.join(directory, "legacy.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE phase0_thread_bindings (
        binding_id TEXT PRIMARY KEY,
        provision_state TEXT NOT NULL CHECK (
          provision_state IN ('provisioning','ready','ambiguous')
        )
      );
    `);
    legacy.close();
    try {
      assert.throws(
        () => createCodexPhase0SqliteJournal({ databasePath }),
        /incompatible Phase 0 journal schema version 0/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates production-isomorphic owner binding logical and XOR rows", async () => {
    await withJournal(async ({ journal }) => {
      const seeded = await journal.seedManagedRun(projectSeed());
      assert.equal(journal.readOwner(seeded.fence).leaseToken.length > 0, true);
      assert.equal(
        journal.readBinding("project_prd", "P-1").projectId,
        "P-1",
      );
      const logical = journal.readLogicalTurn(seeded.logicalTurnId);
      assert.equal(logical.ownerId, "PHASE0-RUN-1");
      assert.equal(logical.owner.kind, "project_ai_run");

      await prepare(journal, seeded);
      await assert.rejects(
        journal.insertSecondAttempt(seeded.logicalTurnId),
        /UNIQUE constraint failed: phase0_start_attempts.logical_turn_id/,
      );
    });
  });

  it("resolves three Spec slots and isolates owner round identity", async () => {
    await withJournal(async ({ journal }) => {
      const base = {
        ownerKind: "pipeline_job" as const,
        ownerId: "JOB-1",
        projectId: "P-1",
        scopeKind: "change" as const,
        scopeId: "CHG-1",
        changeId: "CHG-1",
        phase: "Spec",
        round: 2,
        ordinal: 0,
        binding: {
          threadId: "THREAD-CHANGE",
          cwd: "/repo",
          title: "[CHG-1] First",
        },
        request: {
          cwd: "/repo",
          prompt: "spec",
          approvalPolicy: "never" as const,
          sandboxMode: "read-only" as const,
        },
      };
      const rows = await Promise.all(
        (["spec_writer", "spec_critic", "spec_verdict"] as const).map(
          async (role) => {
            const seeded = await journal.seedManagedRun({ ...base, role });
            return journal.readLogicalTurn(seeded.logicalTurnId);
          },
        ),
      );
      const duplicate = await journal.logicalTurnPort.resolve({
        owner: { kind: "pipeline_job", pipelineJobId: "JOB-1" },
        projectId: "P-1",
        scopeKind: "change",
        scopeId: "CHG-1",
        phase: "Spec",
        role: "spec_writer",
        round: 2,
        ordinal: 0,
        retry: 9,
      } as never);
      const next = await journal.seedManagedRun({
        ...base,
        role: "spec_writer",
        round: 3,
      });

      assert.equal(new Set(rows.map((row) => row.logicalTurnId)).size, 3);
      assert.equal(new Set(rows.map((row) => row.turnSlot)).size, 3);
      assert.equal(duplicate.logicalTurnId, rows[0]?.logicalTurnId);
      assert.notEqual(next.logicalTurnId, duplicate.logicalTurnId);
    });
  });

  it("rejects immutable owner binding and logical seed conflicts", async () => {
    await withJournal(async ({ journal }) => {
      const seed = projectSeed({ leaseToken: "LEASE-IMMUTABLE" });
      await journal.seedManagedRun(seed);
      await assert.rejects(
        journal.seedManagedRun({
          ...seed,
          workerId: "MUTATED-WORKER",
        }),
        /owner seed conflict is immutable/,
      );
      await assert.rejects(
        journal.seedManagedRun({
          ...seed,
          binding: { ...seed.binding, title: "mutated title" },
        }),
        /binding seed conflict is immutable/,
      );
      await assert.rejects(
        journal.seedManagedRun({
          ...seed,
          request: { ...seed.request, prompt: "mutated prompt" },
        }),
        /logical turn seed conflict is immutable/,
      );
    });
  });

  it("rolls back the entire managed seed when a later immutable compare fails", async () => {
    await withJournal(async ({ journal }) => {
      const first = await journal.seedManagedRun(projectSeed());
      await assert.rejects(
        journal.seedManagedRun(projectSeed({
          ownerId: "PHASE0-RUN-ROLLED-BACK",
          binding: {
            threadId: "THREAD-PRD",
            cwd: "/repo",
            title: "conflicting immutable title",
          },
        })),
        /binding seed conflict is immutable/,
      );
      assert.throws(
        () => journal.readOwner({
          ...first.fence,
          owner: {
            kind: "project_ai_run",
            projectAiRunId: "PHASE0-RUN-ROLLED-BACK",
          },
        }),
        /managed owner not found/,
      );
    });
  });

  it("derives Host wakeup dispatch surface from the closed role mapping", async () => {
    await withJournal(async ({ journal }) => {
      const seeded = await journal.seedManagedRun(projectSeed({
        role: "interaction_wakeup",
        phase: "Interaction",
        purpose: "interaction_wakeup",
      }));
      assert.equal(
        journal.readLogicalTurn(seeded.logicalTurnId).dispatchSurface,
        "host_ui_message",
      );
      assert.equal(seeded.fence.dispatchSurface, "host_ui_message");
      await assert.rejects(
        journal.seedManagedRun(projectSeed({
          ownerId: "PHASE0-RUN-BAD-SURFACE",
          role: "interaction_wakeup",
          phase: "Interaction",
          purpose: "stage_run",
        })),
        /role and purpose dispatch surfaces conflict/,
      );
    });
  });

  it("seeds a legal Change-owned cross-binding wakeup before any click", async () => {
    await withJournal(async ({ journal }) => {
      const changeId = "CHG-CROSS-BINDING";
      const seeded = await journal.seedManagedRun(projectSeed({
        ownerKind: "pipeline_job",
        ownerId: "PIPELINE-CROSS-BINDING",
        projectId: "P-1",
        changeId,
        scopeKind: "change",
        scopeId: changeId,
        phase: "InteractionWakeupCrossBinding",
        role: "interaction_wakeup",
        purpose: "interaction_wakeup",
        binding: {
          threadId: "THREAD-CHANGE-CROSS-BINDING",
          cwd: "/repo",
          title: "[CHG-CROSS-BINDING] Isolated",
        },
      }));
      assert.equal(seeded.fence.owner.kind, "pipeline_job");
      assert.equal(seeded.fence.dispatchSurface, "host_ui_message");
      const interactionId = "INTERACTION-CROSS-BINDING";
      await journal.createInteractionWakeup({
        interactionId,
        logicalTurnId: seeded.logicalTurnId,
        cardVersion: 1,
      });
      const beforeClick = journal.inspectInteractionWakeup(interactionId);
      assert.equal(beforeClick.decisionCount, 0);
      assert.equal(beforeClick.jobCount, 0);
      assert.equal(beforeClick.attemptCount, 0);
      assert.equal(beforeClick.outboxCount, 0);
      assert.equal(beforeClick.dispatchCount, 0);
    });
  });

  it("rejects dispatch and settlement after the live owner lease expires", async () => {
    await withJournal(async ({ journal, setNow }) => {
      const seeded = await journal.seedManagedRun(projectSeed());
      const context = await prepare(journal, seeded, "ATTEMPT-EXPIRES");
      setNow(NOW + 120_000);
      await assert.rejects(
        journal.startAttemptPort.claimDispatch({
          attemptId: "ATTEMPT-EXPIRES",
          fence: context.fence,
        }),
        /owner lease is stale/,
      );

      const second = await journal.seedManagedRun(projectSeed({
        ownerId: "PHASE0-RUN-SETTLE",
        ordinal: 1,
        leaseExpiresAt: "2026-07-23T12:03:00.000Z",
      }));
      const secondContext = await prepare(
        journal,
        second,
        "ATTEMPT-SETTLE-EXPIRES",
      );
      const ordinal = await journal.startAttemptPort.claimDispatch({
        attemptId: "ATTEMPT-SETTLE-EXPIRES",
        fence: secondContext.fence,
      });
      setNow(NOW + 240_000);
      await assert.rejects(
        journal.startAttemptPort.recordSuccess({
          attemptId: "ATTEMPT-SETTLE-EXPIRES",
          dispatchOrdinal: ordinal,
          turnId: "TURN-MUST-NOT-SETTLE",
          fence: secondContext.fence,
        }),
        /owner lease is stale/,
      );
      assert.equal(
        (await journal.inspectAttempt("ATTEMPT-SETTLE-EXPIRES"))?.state,
        "dispatching",
      );
      await assert.rejects(
        journal.startAttemptPort.claimReconciliation({
          attemptId: "ATTEMPT-SETTLE-EXPIRES",
          ownerFence: secondContext.fence,
        }),
        /owner lease is stale/,
      );
    });
  });

  it("recovers a committed prepare after close and reopen", async () => {
    await withJournal(async ({ databasePath, journal }) => {
      const seeded = await journal.seedManagedRun(projectSeed());
      const context = await journal.logicalTurnPort.readForStart(
        seeded.logicalTurnId,
      );
      journal.setFailpoint("after_prepare");
      await assert.rejects(
        journal.startAttemptPort.prepare({
          attemptId: "ATTEMPT-CRASH",
          logicalTurnId: context.logicalTurnId,
        }),
        /after_prepare/,
      );
      assert.equal(
        (await journal.inspectAttempt("ATTEMPT-CRASH"))?.state,
        "prepared",
      );
      journal.close();

      const reopened = openJournal(databasePath);
      assert.equal(
        (await reopened.inspectAttempt("ATTEMPT-CRASH"))?.state,
        "prepared",
      );
      assert.equal(await reopened.startAttemptPort.claimDispatch({
        attemptId: "ATTEMPT-CRASH",
        fence: context.fence,
      }), 1);
      reopened.close();
    });
  });

  it("recovers a committed no-client checkpoint after close and reopen", async () => {
    await withJournal(async ({ databasePath, journal }) => {
      const seeded = await journal.seedManagedRun(projectSeed());
      const context = await prepare(journal, seeded, "ATTEMPT-NO-CLIENT");
      const ordinal = await journal.startAttemptPort.claimDispatch({
        attemptId: "ATTEMPT-NO-CLIENT",
        fence: context.fence,
      });
      journal.setFailpoint("after_no_client_found");
      await assert.rejects(
        journal.startAttemptPort.recordNoClientFound({
          attemptId: "ATTEMPT-NO-CLIENT",
          dispatchOrdinal: ordinal,
          fence: context.fence,
        }),
        /after_no_client_found/,
      );
      journal.close();

      const reopened = openJournal(databasePath);
      assert.equal(
        (await reopened.inspectAttempt("ATTEMPT-NO-CLIENT"))?.state,
        "no_client_found",
      );
      reopened.close();
    });
  });

  it("recovers a committed dispatch CAS after close and reopen", async () => {
    await withJournal(async ({ databasePath, journal }) => {
      const seeded = await journal.seedManagedRun(projectSeed());
      const context = await prepare(journal, seeded, "ATTEMPT-DISPATCH-CRASH");
      journal.setFailpoint("after_dispatch_cas");
      await assert.rejects(
        journal.startAttemptPort.claimDispatch({
          attemptId: "ATTEMPT-DISPATCH-CRASH",
          fence: context.fence,
        }),
        /after_dispatch_cas/,
      );
      journal.close();

      const reopened = openJournal(databasePath);
      assert.equal(
        (await reopened.inspectAttempt("ATTEMPT-DISPATCH-CRASH"))?.state,
        "dispatching",
      );
      const recovery = await reopened.startAttemptPort.claimReconciliation({
        attemptId: "ATTEMPT-DISPATCH-CRASH",
        ownerFence: context.fence,
      });
      await reopened.startAttemptPort.adoptSuccess({
        attemptId: "ATTEMPT-DISPATCH-CRASH",
        dispatchOrdinal: 1,
        turnId: "TURN-RECOVERED-DISPATCH",
        fence: recovery,
      });
      assert.equal(
        (await reopened.inspectAttempt("ATTEMPT-DISPATCH-CRASH"))?.turnId,
        "TURN-RECOVERED-DISPATCH",
      );
      reopened.close();
    });
  });

  it("recovers a pre-success-CAS crash after close and reopen", async () => {
    await withJournal(async ({ databasePath, journal }) => {
      const seeded = await journal.seedManagedRun(projectSeed());
      const context = await prepare(journal, seeded, "ATTEMPT-SUCCESS-CRASH");
      const ordinal = await journal.startAttemptPort.claimDispatch({
        attemptId: "ATTEMPT-SUCCESS-CRASH",
        fence: context.fence,
      });
      journal.setFailpoint("before_success_cas");
      await assert.rejects(
        journal.startAttemptPort.recordSuccess({
          attemptId: "ATTEMPT-SUCCESS-CRASH",
          dispatchOrdinal: ordinal,
          turnId: "TURN-LOST-RESPONSE",
          fence: context.fence,
        }),
        /before_success_cas/,
      );
      journal.close();

      const reopened = openJournal(databasePath);
      assert.equal(
        (await reopened.inspectAttempt("ATTEMPT-SUCCESS-CRASH"))?.state,
        "dispatching",
      );
      const recovery = await reopened.startAttemptPort.claimReconciliation({
        attemptId: "ATTEMPT-SUCCESS-CRASH",
        ownerFence: context.fence,
      });
      await reopened.startAttemptPort.adoptSuccess({
        attemptId: "ATTEMPT-SUCCESS-CRASH",
        dispatchOrdinal: ordinal,
        turnId: "TURN-LOST-RESPONSE",
        fence: recovery,
      });
      assert.equal(
        (await reopened.inspectAttempt("ATTEMPT-SUCCESS-CRASH"))?.state,
        "succeeded",
      );
      reopened.close();
    });
  });

  it("safe-handoffs only an expired safe state", async () => {
    await withJournal(async ({ journal, setNow }) => {
      const seeded = await journal.seedManagedRun(projectSeed());
      const old = await prepare(journal, seeded, "ATTEMPT-HANDOFF");
      const ordinal = await journal.startAttemptPort.claimDispatch({
        attemptId: "ATTEMPT-HANDOFF",
        fence: old.fence,
      });
      await journal.startAttemptPort.recordNoClientFound({
        attemptId: "ATTEMPT-HANDOFF",
        dispatchOrdinal: ordinal,
        fence: old.fence,
      });
      setNow(NOW + 120_000);
      await journal.takeOverOwner({
        owner: seeded.fence.owner,
        expectedWorkerId: old.fence.workerId,
        expectedLeaseToken: old.fence.leaseToken,
        expectedOwnerAttempt: old.fence.ownerAttempt,
        expectedOwnerEpoch: old.fence.ownerEpoch,
        expectedDeadlineAt: old.fence.deadlineAt,
        expectedLeaseExpiresAt: old.fence.leaseExpiresAt,
        expectedStatus: "running",
        workerId: "WORKER-2",
        leaseToken: "LEASE-2",
        ownerAttempt: 2,
        ownerEpoch: 2,
        deadlineAt: "2026-07-23T12:10:00.000Z",
        leaseExpiresAt: "2026-07-23T12:04:00.000Z",
      });
      const next = await journal.logicalTurnPort.readForStart(
        seeded.logicalTurnId,
      );
      await journal.startAttemptPort.claimSafeAttemptForWorker({
        attemptId: "ATTEMPT-HANDOFF",
        expectedState: "no_client_found",
        expectedOldFence: old.fence,
        newFence: next.fence,
      });
      await assert.rejects(
        journal.startAttemptPort.claimDispatch({
          attemptId: "ATTEMPT-HANDOFF",
          fence: old.fence,
        }),
      );
      assert.equal(await journal.startAttemptPort.claimDispatch({
        attemptId: "ATTEMPT-HANDOFF",
        fence: next.fence,
      }), 2);
    });
  });

  it("reconciles an immutable dispatch through the current takeover owner lease", async () => {
    await withJournal(async ({ journal, setNow }) => {
      const seeded = await journal.seedManagedRun(projectSeed());
      const original = await prepare(
        journal,
        seeded,
        "ATTEMPT-RECOVERY-TAKEOVER",
      );
      const dispatchOrdinal = await journal.startAttemptPort.claimDispatch({
        attemptId: "ATTEMPT-RECOVERY-TAKEOVER",
        fence: original.fence,
      });
      setNow(NOW + 120_000);
      await journal.takeOverOwner({
        owner: seeded.fence.owner,
        expectedWorkerId: original.fence.workerId,
        expectedLeaseToken: original.fence.leaseToken,
        expectedOwnerAttempt: original.fence.ownerAttempt,
        expectedOwnerEpoch: original.fence.ownerEpoch,
        expectedDeadlineAt: original.fence.deadlineAt,
        expectedLeaseExpiresAt: original.fence.leaseExpiresAt,
        expectedStatus: "running",
        workerId: "RECOVERY-WORKER-2",
        leaseToken: "RECOVERY-LEASE-2",
        ownerAttempt: 2,
        ownerEpoch: 2,
        deadlineAt: "2026-07-23T12:10:00.000Z",
        leaseExpiresAt: "2026-07-23T12:04:00.000Z",
      });
      const second = await journal.logicalTurnPort.readForStart(
        seeded.logicalTurnId,
      );
      const staleRecovery = await journal.startAttemptPort.claimReconciliation({
        attemptId: "ATTEMPT-RECOVERY-TAKEOVER",
        ownerFence: second.fence,
      });

      setNow(NOW + 300_000);
      await journal.takeOverOwner({
        owner: seeded.fence.owner,
        expectedWorkerId: second.fence.workerId,
        expectedLeaseToken: second.fence.leaseToken,
        expectedOwnerAttempt: second.fence.ownerAttempt,
        expectedOwnerEpoch: second.fence.ownerEpoch,
        expectedDeadlineAt: second.fence.deadlineAt,
        expectedLeaseExpiresAt: second.fence.leaseExpiresAt,
        expectedStatus: "running",
        workerId: "RECOVERY-WORKER-3",
        leaseToken: "RECOVERY-LEASE-3",
        ownerAttempt: 3,
        ownerEpoch: 3,
        deadlineAt: "2026-07-23T12:10:00.000Z",
        leaseExpiresAt: "2026-07-23T12:08:00.000Z",
      });
      await assert.rejects(
        journal.startAttemptPort.adoptSuccess({
          attemptId: "ATTEMPT-RECOVERY-TAKEOVER",
          dispatchOrdinal,
          turnId: "TURN-STALE-RECOVERY",
          fence: staleRecovery,
        }),
        /recovery owner lease is stale/,
      );
      const third = await journal.logicalTurnPort.readForStart(
        seeded.logicalTurnId,
      );
      const currentRecovery =
        await journal.startAttemptPort.claimReconciliation({
          attemptId: "ATTEMPT-RECOVERY-TAKEOVER",
          ownerFence: third.fence,
        });
      await journal.startAttemptPort.adoptSuccess({
        attemptId: "ATTEMPT-RECOVERY-TAKEOVER",
        dispatchOrdinal,
        turnId: "TURN-CURRENT-RECOVERY",
        fence: currentRecovery,
      });
      assert.equal(
        (await journal.inspectAttempt("ATTEMPT-RECOVERY-TAKEOVER"))?.turnId,
        "TURN-CURRENT-RECOVERY",
      );
    });
  });

  for (
    const failpoint of [
      "after_thread_start",
      "after_thread_activation",
      "after_thread_name",
    ] as const
  ) {
    it(`blocks incomplete creator proof ${failpoint} after close and reopen`, async () => {
      await withJournal(async ({ databasePath, journal }) => {
        const fixture = durableShellFixture();
        const provisionFence = {
          ownerId: "SHELL-WORKER-1",
          leaseToken: "SHELL-LEASE-1",
          leaseExpiresAt: new Date(NOW + 100).toISOString(),
        };
        const request = {
          projectPath: "/repo",
          scope: {
            kind: "change" as const,
            scopeId: "CHG-SHELL",
            projectId: "P-1",
            changeId: "CHG-SHELL",
          },
          title: "[CHG-SHELL] Durable",
          provisionFence,
        };
        const crashing = createCodexDesktopBridge({
          shellControl: fixture.shellControl,
          follower: fixture.follower,
          logicalTurnPort: journal.logicalTurnPort,
          startAttemptPort: journal.startAttemptPort,
          shellProvisionPort: journal.shellProvisionPort,
          now: () => Date.parse("2026-07-23T12:00:00.000Z"),
          shellProvisionFailpoint(point) {
            if (point === failpoint) throw new Error(`crash:${point}`);
          },
        });
        await assert.rejects(
          crashing.ensurePersistentShell(request),
          new RegExp(`crash:${failpoint}`),
        );
        const crashedIntent = await journal.shellProvisionPort.claim({
          scope: request.scope,
          cwd: request.projectPath,
          title: request.title,
          baselineThreadIds: [],
          fence: provisionFence,
        });
        assert.equal(
          crashedIntent.candidateThreadId,
          "THREAD-PROVISION-1",
        );
        journal.close();

        let currentNow = NOW;
        const reopened = openJournal(databasePath, () => currentNow);
        const recovered = createCodexDesktopBridge({
          shellControl: fixture.shellControl,
          follower: fixture.follower,
          logicalTurnPort: reopened.logicalTurnPort,
          startAttemptPort: reopened.startAttemptPort,
          shellProvisionPort: reopened.shellProvisionPort,
          now: () => currentNow,
          sleep: async (ms) => {
            currentNow += ms;
          },
        });
        await assert.rejects(
          recovered.ensurePersistentShell(request),
          (error: unknown) =>
            error instanceof CodexDesktopBridgeError
            && error.code === "shell_provision_ambiguous"
            && /creator-session shell proof/.test(error.message),
        );
        const blocked = await reopened.shellProvisionPort.claim({
          scope: request.scope,
          cwd: request.projectPath,
          title: request.title,
          baselineThreadIds: [],
          fence: provisionFence,
        });
        assert.equal(blocked.state, "ambiguous");
        assert.equal(fixture.starts(), 1);
        assert.equal(fixture.materializationTurnCount(), 0);
        reopened.close();
      });
    });
  }

  it("resumes one candidate after bootstrap-ready crash without another start", async () => {
    await withJournal(async ({ databasePath, journal }) => {
      const fixture = durableShellFixture();
      const provisionFence = {
        ownerId: "SHELL-BOOTSTRAP-WORKER",
        leaseToken: "SHELL-BOOTSTRAP-LEASE",
        leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
      };
      const request = {
        projectPath: "/repo",
        scope: {
          kind: "change" as const,
          scopeId: "CHG-BOOTSTRAP",
          projectId: "P-1",
          changeId: "CHG-BOOTSTRAP",
        },
        title: "[CHG-BOOTSTRAP] Durable",
        provisionFence,
      };
      const durableProvision = journal.shellProvisionPort;
      const crashing = createCodexDesktopBridge({
        shellControl: fixture.shellControl,
        follower: fixture.follower,
        logicalTurnPort: journal.logicalTurnPort,
        startAttemptPort: journal.startAttemptPort,
        shellProvisionPort: {
          ...durableProvision,
          async recordBootstrapReady(input) {
            await durableProvision.recordBootstrapReady(input);
            throw new Error("crash after bootstrap-ready CAS");
          },
        },
        now: () => NOW,
      });
      await assert.rejects(
        crashing.ensurePersistentShell(request),
        /crash after bootstrap-ready CAS/,
      );
      journal.close();

      const reopened = openJournal(databasePath, () => NOW);
      const recovered = createCodexDesktopBridge({
        shellControl: fixture.shellControl,
        follower: fixture.follower,
        logicalTurnPort: reopened.logicalTurnPort,
        startAttemptPort: reopened.startAttemptPort,
        shellProvisionPort: reopened.shellProvisionPort,
        now: () => NOW,
      });
      const shell = await recovered.ensurePersistentShell(request);

      assert.equal(shell.threadId, "THREAD-PROVISION-1");
      assert.equal(fixture.starts(), 1);
      assert.equal(
        reopened.readBinding("change", "CHG-BOOTSTRAP").threadId,
        shell.threadId,
      );
      const firstInspection = reopened.inspectShellProvision(
        "change",
        "CHG-BOOTSTRAP",
      );
      const persistedReportEvidence = JSON.parse(JSON.stringify({
        provisionId: firstInspection.provisionId,
        candidateThreadId: firstInspection.candidateThreadId,
        cwd: firstInspection.cwd,
        title: firstInspection.title,
        materializationLogicalTurnId:
          firstInspection.materializationLogicalTurnId,
        attempt: firstInspection.attempt,
        candidateCount: firstInspection.candidateCount,
        attemptCount: firstInspection.attemptCount,
        executionCount: firstInspection.executionCount,
      })) as typeof firstInspection;
      reopened.close();

      const resumeReopened = openJournal(databasePath, () => NOW);
      try {
        const resumedInspection = resumeReopened.inspectShellProvision(
          "change",
          "CHG-BOOTSTRAP",
        );
        assert.deepEqual({
          provisionId: resumedInspection.provisionId,
          candidateThreadId: resumedInspection.candidateThreadId,
          cwd: resumedInspection.cwd,
          title: resumedInspection.title,
          materializationLogicalTurnId:
            resumedInspection.materializationLogicalTurnId,
          attempt: resumedInspection.attempt,
          candidateCount: resumedInspection.candidateCount,
          attemptCount: resumedInspection.attemptCount,
          executionCount: resumedInspection.executionCount,
        }, persistedReportEvidence);
        assert.equal(resumedInspection.state, "durable_ready");
        assert.equal(resumedInspection.threadId, shell.threadId);
        assert.equal(resumedInspection.attempt?.state, "succeeded");
        assert.equal(resumedInspection.candidateCount, 1);
        assert.equal(
          resumedInspection.attempt?.turnId,
          persistedReportEvidence.attempt?.turnId,
        );
        assert.equal((await resumeReopened.listAttempts()).length, 1);
      } finally {
        resumeReopened.close();
      }
    });
  });

  it("persists and consumes a restart checkpoint through exact SQLite CAS", async () => {
    await withJournal(async ({ databasePath, journal }) => {
      const checkpointSeed = await journal.seedManagedRun(projectSeed({
        ownerId: "RESTART-CHECKPOINT-OWNER",
        phase: "Restart",
        role: "context_select",
      }));
      await prepare(
        journal,
        checkpointSeed,
        "RESTART-CHECKPOINT-ATTEMPT",
      );
      const checkpointAttempt = (
        await journal.inspectAttempt("RESTART-CHECKPOINT-ATTEMPT")
      )!;
      const checkpointOrdinal =
        await journal.startAttemptPort.claimDispatch({
          attemptId: checkpointAttempt.attemptId,
          fence: checkpointAttempt.fence,
        });
      await journal.startAttemptPort.recordSuccess({
        attemptId: checkpointAttempt.attemptId,
        dispatchOrdinal: checkpointOrdinal,
        turnId: "RESTART-CHECKPOINT-TURN",
        fence: checkpointAttempt.fence,
      });
      await journal.saveRestartCheckpoint({
        runId: "00000000-0000-4000-8000-000000000001",
        logicalTurnId: checkpointSeed.logicalTurnId,
        shellThreadId: checkpointAttempt.request.threadId,
        desktopPid: 101,
        processStartedAt: "2026-07-23T11:59:00.000Z",
        socketPath: "/tmp/codex.sock",
        socketDevice: 11,
        socketInode: 12,
        observationCursor: 3,
        lastSnapshotHash: "SNAPSHOT-HASH",
        lastNormalizedSnapshot: {
          threadId: checkpointAttempt.request.threadId,
          turnId: "RESTART-CHECKPOINT-TURN",
          status: "completed",
          items: [],
          terminal: { output: "PHASE0_RESTART_CHECKPOINT_READY." },
          metadata: { observedAt: new Date(NOW).toISOString() },
        },
      });
      journal.close();

      const reopened = openJournal(databasePath);
      const awaiting = reopened.readRestartCheckpoint(
        "00000000-0000-4000-8000-000000000001",
      );
      assert.equal(awaiting?.state, "awaiting_resume");
      assert.equal(awaiting?.logicalTurnId, checkpointSeed.logicalTurnId);
      assert.equal(awaiting?.attemptId, checkpointAttempt.attemptId);
      assert.equal(
        awaiting?.correlationMarker,
        checkpointAttempt.correlationMarker,
      );
      assert.deepEqual(
        awaiting?.preStartTurnIds,
        checkpointAttempt.preStartTurnIds,
      );
      assert.equal(
        awaiting?.preStartSemanticHash,
        checkpointAttempt.preStartSemanticHash,
      );
      assert.equal(awaiting?.dispatchOrdinal, 1);
      assert.equal(awaiting?.turnId, "RESTART-CHECKPOINT-TURN");

      const resumedSeed = await reopened.seedManagedRun(projectSeed({
        ownerId: "RESTART-RESUME-OWNER",
        phase: "Restart",
        role: "context_generate",
      }));
      await prepare(
        reopened,
        resumedSeed,
        "RESTART-RESUME-ATTEMPT",
      );
      const resumedAttempt = (
        await reopened.inspectAttempt("RESTART-RESUME-ATTEMPT")
      )!;
      const resumedOrdinal =
        await reopened.startAttemptPort.claimDispatch({
          attemptId: resumedAttempt.attemptId,
          fence: resumedAttempt.fence,
        });
      await reopened.startAttemptPort.recordSuccess({
        attemptId: resumedAttempt.attemptId,
        dispatchOrdinal: resumedOrdinal,
        turnId: "RESTART-RESUME-TURN",
        fence: resumedAttempt.fence,
      });
      await reopened.consumeRestartCheckpoint({
        runId: awaiting!.runId,
        expectedAttemptId: awaiting!.attemptId,
        expectedDispatchOrdinal: awaiting!.dispatchOrdinal,
        expectedTurnId: awaiting!.turnId,
        ...expectedRestartResume(resumedAttempt),
      });
      const consumed = reopened.readRestartCheckpoint(awaiting!.runId);
      assert.equal(consumed?.state, "consumed");
      assert.equal(
        consumed?.resumedLogicalTurnId,
        resumedSeed.logicalTurnId,
      );
      assert.equal(consumed?.resumedAttemptId, resumedAttempt.attemptId);
      assert.equal(
        consumed?.resumedNormalizedPromptHash,
        resumedAttempt.normalizedPromptHash,
      );
      assert.equal(
        consumed?.resumedShellThreadId,
        resumedAttempt.request.threadId,
      );
      assert.equal(consumed?.resumedTurnId, "RESTART-RESUME-TURN");
      await assert.rejects(
        reopened.consumeRestartCheckpoint({
          runId: awaiting!.runId,
          expectedAttemptId: awaiting!.attemptId,
          expectedDispatchOrdinal: awaiting!.dispatchOrdinal,
          expectedTurnId: awaiting!.turnId,
          ...expectedRestartResume(resumedAttempt),
        }),
        /restart checkpoint consume was fenced/,
      );
      reopened.close();
    });
  });

  it("reconciles a succeeded resume after process restart without a second follower start", async () => {
    await withJournal(async ({ databasePath, journal }) => {
      const checkpointSeed = await journal.seedManagedRun(projectSeed({
        ownerId: "RESTART-RECOVERY-CHECKPOINT-OWNER",
        phase: "RestartRecovery",
        role: "context_select",
      }));
      await prepare(
        journal,
        checkpointSeed,
        "RESTART-RECOVERY-CHECKPOINT-ATTEMPT",
      );
      const checkpointAttempt = (
        await journal.inspectAttempt("RESTART-RECOVERY-CHECKPOINT-ATTEMPT")
      )!;
      const checkpointOrdinal =
        await journal.startAttemptPort.claimDispatch({
          attemptId: checkpointAttempt.attemptId,
          fence: checkpointAttempt.fence,
        });
      await journal.startAttemptPort.recordSuccess({
        attemptId: checkpointAttempt.attemptId,
        dispatchOrdinal: checkpointOrdinal,
        turnId: "RESTART-RECOVERY-CHECKPOINT-TURN",
        fence: checkpointAttempt.fence,
      });
      const runId = "00000000-0000-4000-8000-000000000003";
      await journal.saveRestartCheckpoint({
        runId,
        logicalTurnId: checkpointSeed.logicalTurnId,
        shellThreadId: checkpointAttempt.request.threadId,
        desktopPid: 101,
        processStartedAt: "2026-07-23T11:59:00.000Z",
        socketPath: "/tmp/codex.sock",
        socketDevice: 11,
        socketInode: 12,
        observationCursor: 3,
        lastSnapshotHash: "SNAPSHOT-HASH",
        lastNormalizedSnapshot: {
          threadId: checkpointAttempt.request.threadId,
          turnId: "RESTART-RECOVERY-CHECKPOINT-TURN",
          status: "completed",
          items: [],
          terminal: { output: "PHASE0_RESTART_CHECKPOINT_READY." },
          metadata: { observedAt: new Date(NOW).toISOString() },
        },
      });

      const resumedSeed = await journal.seedManagedRun(projectSeed({
        ownerId: "RESTART-RECOVERY-RESUME-OWNER",
        phase: "RestartRecovery",
        role: "context_generate",
      }));
      const fixture = successfulFollowerFixture();
      const bridge = createCodexDesktopBridge({
        shellControl: fixture.shellControl,
        follower: fixture.follower,
        logicalTurnPort: journal.logicalTurnPort,
        startAttemptPort: journal.startAttemptPort,
        shellProvisionPort: journal.shellProvisionPort,
        now: () => NOW,
      });
      const first = await bridge.startTurn({
        logicalTurnId: resumedSeed.logicalTurnId,
      });
      assert.equal(
        (await journal.inspectAttempt(first.attemptId))?.state,
        "succeeded",
      );
      assert.equal(fixture.startCalls(), 1);

      // Simulate a process crash after the turn succeeds but before JSON and
      // checkpoint-consumption state are written.
      journal.close();
      const reopened = openJournal(databasePath);
      const recovered = await createCodexDesktopBridge({
        shellControl: fixture.shellControl,
        follower: fixture.follower,
        logicalTurnPort: reopened.logicalTurnPort,
        startAttemptPort: reopened.startAttemptPort,
        shellProvisionPort: reopened.shellProvisionPort,
        now: () => NOW,
      }).recoverTurn({
        logicalTurnId: resumedSeed.logicalTurnId,
      });
      assert.equal(recovered.state, "succeeded");
      assert.equal(recovered.turnId, first.turnId);
      assert.equal(fixture.startCalls(), 1);

      const awaiting = reopened.readRestartCheckpoint(runId)!;
      await reopened.consumeRestartCheckpoint({
        runId,
        expectedAttemptId: awaiting.attemptId,
        expectedDispatchOrdinal: awaiting.dispatchOrdinal,
        expectedTurnId: awaiting.turnId,
        ...expectedRestartResume(
          (await reopened.inspectAttempt(first.attemptId))!,
        ),
      });
      assert.equal(
        reopened.readRestartCheckpoint(runId)?.state,
        "consumed",
      );
      await assert.rejects(
        reopened.consumeRestartCheckpoint({
          runId,
          expectedAttemptId: awaiting.attemptId,
          expectedDispatchOrdinal: awaiting.dispatchOrdinal,
          expectedTurnId: awaiting.turnId,
          ...expectedRestartResume(
            (await reopened.inspectAttempt(first.attemptId))!,
          ),
        }),
        /restart checkpoint consume was fenced/,
      );
      reopened.close();

      const afterCrash = openJournal(databasePath);
      const durableTombstone = afterCrash.readRestartCheckpoint(runId)!;
      const durableResumedAttempt = (
        await afterCrash.inspectAttemptByLogicalTurn(
          resumedSeed.logicalTurnId,
        )
      )!;
      const followerStartsBeforeRerun = fixture.startCalls();
      const rerunRecovery = await createCodexDesktopBridge({
        shellControl: fixture.shellControl,
        follower: fixture.follower,
        logicalTurnPort: afterCrash.logicalTurnPort,
        startAttemptPort: afterCrash.startAttemptPort,
        shellProvisionPort: afterCrash.shellProvisionPort,
        now: () => NOW,
      }).recoverTurn({
        logicalTurnId: resumedSeed.logicalTurnId,
      });
      assert.equal(rerunRecovery.state, "succeeded");
      assert.equal(fixture.startCalls() - followerStartsBeforeRerun, 0);
      const rerunSnapshot = (
        await fixture.shellControl.readThreadWithTurns({
          threadId: durableTombstone.resumedShellThreadId!,
          includeTurns: true,
        })
      ).turns.find(
        ({ turnId }) => turnId === durableTombstone.resumedTurnId,
      )!;
      assert.deepEqual(
        reconcileConsumedRestartCompletion(
          durableTombstone,
          durableResumedAttempt,
          rerunSnapshot,
        ),
        {
          state: "desktop_restart_completed",
          shellThreadId: durableTombstone.shellThreadId,
          checkpointTurnId: durableTombstone.turnId,
          resumedTurnId: durableTombstone.resumedTurnId,
          completedAt: durableTombstone.consumedAt,
        },
      );
      afterCrash.close();
    });
  });

  it("runs a fresh verifier shell start once and reopens with zero new starts", async () => {
    await withJournal(async ({ databasePath, journal }) => {
      const fixture = durableShellFixture();
      const request = {
        projectPath: "/repo",
        scope: {
          kind: "project_context" as const,
          scopeId: "P-VERIFIER-REOPEN",
          projectId: "P-VERIFIER-REOPEN",
        },
        title: "[P-VERIFIER-REOPEN] Context",
        provisionFence: {
          ownerId: "VERIFIER-FRESH-WORKER",
          leaseToken: "VERIFIER-FRESH-LEASE",
          leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
        },
      };
      const freshBridge = createCodexDesktopBridge({
        shellControl: fixture.shellControl,
        follower: fixture.follower,
        logicalTurnPort: journal.logicalTurnPort,
        startAttemptPort: journal.startAttemptPort,
        shellProvisionPort: journal.shellProvisionPort,
        now: () => NOW,
      });
      const fresh = await freshBridge.ensurePersistentShell(request);
      assert.equal(fixture.starts(), 1);
      const freshInspection = journal.inspectShellProvision(
        request.scope.kind,
        request.scope.scopeId,
      );
      assert.equal(freshInspection.cwd, request.projectPath);
      assert.equal(freshInspection.title, request.title);
      journal.close();

      const reopened = openJournal(databasePath);
      const resumedBridge = createCodexDesktopBridge({
        shellControl: fixture.shellControl,
        follower: fixture.follower,
        logicalTurnPort: reopened.logicalTurnPort,
        startAttemptPort: reopened.startAttemptPort,
        shellProvisionPort: reopened.shellProvisionPort,
        now: () => NOW,
      });
      const startsBeforeResume = fixture.starts();
      const resumed = await resumedBridge.ensurePersistentShell(request);
      assert.equal(resumed.threadId, fresh.threadId);
      const resumedInspection = reopened.inspectShellProvision(
        request.scope.kind,
        request.scope.scopeId,
      );
      assert.equal(resumedInspection.cwd, request.projectPath);
      assert.equal(resumedInspection.title, request.title);
      assert.equal(fixture.starts() - startsBeforeResume, 0);
      assert.equal(fixture.starts(), 1);
      reopened.close();
    });
  });

  it("rejects report or resumed-turn identity drift at restart consumption", async () => {
    await withJournal(async ({ journal }) => {
      const seed = await journal.seedManagedRun(projectSeed({
        ownerId: "RESTART-DRIFT-CHECKPOINT",
        phase: "RestartDrift",
        role: "context_select",
      }));
      await prepare(journal, seed, "RESTART-DRIFT-ATTEMPT");
      const attempt = (
        await journal.inspectAttempt("RESTART-DRIFT-ATTEMPT")
      )!;
      const ordinal = await journal.startAttemptPort.claimDispatch({
        attemptId: attempt.attemptId,
        fence: attempt.fence,
      });
      await journal.startAttemptPort.recordSuccess({
        attemptId: attempt.attemptId,
        dispatchOrdinal: ordinal,
        turnId: "RESTART-DRIFT-TURN",
        fence: attempt.fence,
      });
      await journal.saveRestartCheckpoint({
        runId: "00000000-0000-4000-8000-000000000002",
        logicalTurnId: seed.logicalTurnId,
        shellThreadId: attempt.request.threadId,
        desktopPid: 101,
        processStartedAt: "2026-07-23T11:59:00.000Z",
        socketPath: "/tmp/codex.sock",
        socketDevice: 11,
        socketInode: 12,
        observationCursor: 3,
        lastSnapshotHash: "SNAPSHOT-HASH",
        lastNormalizedSnapshot: {
          threadId: attempt.request.threadId,
          turnId: "RESTART-DRIFT-TURN",
          status: "completed",
          items: [],
          terminal: { output: "PHASE0_RESTART_CHECKPOINT_READY." },
          metadata: { observedAt: new Date(NOW).toISOString() },
        },
      });
      await assert.rejects(
        journal.consumeRestartCheckpoint({
          runId: "00000000-0000-4000-8000-000000000002",
          expectedAttemptId: "WRONG-ATTEMPT",
          expectedDispatchOrdinal: 1,
          expectedTurnId: "RESTART-DRIFT-TURN",
          expectedResumedLogicalTurnId: "MISSING-LOGICAL",
          expectedResumedAttemptId: "MISSING-ATTEMPT",
          expectedResumedThreadId: "THREAD-PRD",
          expectedResumedCanonicalBindingThreadId: "THREAD-PRD",
          expectedResumedNormalizedPromptHash: "MISSING-HASH",
        }),
        /restart checkpoint consume was fenced/,
      );
      const expectedResumeSeed = await journal.seedManagedRun(projectSeed({
        ownerId: "RESTART-DRIFT-EXPECTED-RESUME",
        phase: "RestartDriftExpected",
        role: "context_generate",
      }));
      await prepare(
        journal,
        expectedResumeSeed,
        "RESTART-DRIFT-EXPECTED-RESUME-ATTEMPT",
      );
      const expectedResumeAttempt = (
        await journal.inspectAttempt(
          "RESTART-DRIFT-EXPECTED-RESUME-ATTEMPT",
        )
      )!;
      const wrongPromptSeed = await journal.seedManagedRun(projectSeed({
        ownerId: "RESTART-DRIFT-WRONG-PROMPT",
        phase: "RestartDriftWrongPrompt",
        role: "context_generate",
        request: {
          cwd: "/repo",
          prompt: "Reply with the wrong restart sentinel.",
          approvalPolicy: "never",
          sandboxMode: "read-only",
        },
      }));
      await prepare(
        journal,
        wrongPromptSeed,
        "RESTART-DRIFT-WRONG-PROMPT-ATTEMPT",
      );
      const wrongPromptAttempt = (
        await journal.inspectAttempt(
          "RESTART-DRIFT-WRONG-PROMPT-ATTEMPT",
        )
      )!;
      const wrongPromptOrdinal =
        await journal.startAttemptPort.claimDispatch({
          attemptId: wrongPromptAttempt.attemptId,
          fence: wrongPromptAttempt.fence,
        });
      await journal.startAttemptPort.recordSuccess({
        attemptId: wrongPromptAttempt.attemptId,
        dispatchOrdinal: wrongPromptOrdinal,
        turnId: "RESTART-DRIFT-WRONG-PROMPT-TURN",
        fence: wrongPromptAttempt.fence,
      });
      await assert.rejects(
        journal.consumeRestartCheckpoint({
          runId: "00000000-0000-4000-8000-000000000002",
          expectedAttemptId: attempt.attemptId,
          expectedDispatchOrdinal: ordinal,
          expectedTurnId: "RESTART-DRIFT-TURN",
          expectedResumedLogicalTurnId: wrongPromptSeed.logicalTurnId,
          expectedResumedAttemptId: wrongPromptAttempt.attemptId,
          expectedResumedThreadId: "THREAD-PRD",
          expectedResumedCanonicalBindingThreadId: "THREAD-PRD",
          expectedResumedNormalizedPromptHash:
            expectedResumeAttempt.normalizedPromptHash,
        }),
        /restart checkpoint consume was fenced/,
      );
      assert.equal(
        journal.readRestartCheckpoint(
          "00000000-0000-4000-8000-000000000002",
        )?.state,
        "awaiting_resume",
      );
      const wrongBindingSeed = await journal.seedManagedRun(projectSeed({
        ownerId: "RESTART-DRIFT-WRONG-BINDING",
        projectId: "P-OTHER",
        scopeId: "P-OTHER",
        phase: "RestartDrift",
        role: "context_generate",
        binding: {
          threadId: "THREAD-OTHER",
          cwd: "/repo",
          title: "[P-OTHER] Context",
        },
      }));
      await prepare(
        journal,
        wrongBindingSeed,
        "RESTART-DRIFT-WRONG-BINDING-ATTEMPT",
      );
      const wrongBindingAttempt = (
        await journal.inspectAttempt(
          "RESTART-DRIFT-WRONG-BINDING-ATTEMPT",
        )
      )!;
      const wrongBindingOrdinal =
        await journal.startAttemptPort.claimDispatch({
          attemptId: wrongBindingAttempt.attemptId,
          fence: wrongBindingAttempt.fence,
        });
      await journal.startAttemptPort.recordSuccess({
        attemptId: wrongBindingAttempt.attemptId,
        dispatchOrdinal: wrongBindingOrdinal,
        turnId: "RESTART-DRIFT-WRONG-BINDING-TURN",
        fence: wrongBindingAttempt.fence,
      });
      await assert.rejects(
        journal.consumeRestartCheckpoint({
          runId: "00000000-0000-4000-8000-000000000002",
          expectedAttemptId: attempt.attemptId,
          expectedDispatchOrdinal: ordinal,
          expectedTurnId: "RESTART-DRIFT-TURN",
          ...expectedRestartResume(wrongBindingAttempt),
        }),
        /restart checkpoint consume was fenced/,
      );
      assert.equal(
        journal.readRestartCheckpoint(
          "00000000-0000-4000-8000-000000000002",
        )?.state,
        "awaiting_resume",
      );
    });
  });

  for (const safeState of ["prepared", "no_client_found"] as const) {
    it(`takes over expired ${safeState} materialization without identity drift`, async () => {
      await withJournal(async ({ databasePath, journal }) => {
        const fixture = durableShellFixture();
        let currentNow = NOW;
        const deadlineAt = new Date(NOW + 10_000).toISOString();
        const firstFence = {
          ownerId: "SHELL-TAKEOVER-WORKER-1",
          leaseToken: "SHELL-TAKEOVER-LEASE-1",
          leaseExpiresAt: new Date(NOW + 100).toISOString(),
          deadlineAt,
          ownerAttempt: 1,
          ownerEpoch: 1,
        };
        const request = {
          projectPath: "/repo",
          scope: {
            kind: "change" as const,
            scopeId: `CHG-TAKEOVER-${safeState}`,
            projectId: "P-1",
            changeId: `CHG-TAKEOVER-${safeState}`,
          },
          title: `[CHG-TAKEOVER-${safeState}] Durable`,
          provisionFence: firstFence,
        };
        if (safeState === "prepared") {
          journal.setFailpoint("after_prepare");
        }
        const firstBridge = createCodexDesktopBridge({
          shellControl: fixture.shellControl,
          follower: safeState === "no_client_found"
            ? {
                ...fixture.follower,
                async startFollowerTurn() {
                  return { status: "no-client-found" as const };
                },
              }
            : fixture.follower,
          logicalTurnPort: journal.logicalTurnPort,
          startAttemptPort: journal.startAttemptPort,
          shellProvisionPort: journal.shellProvisionPort,
          now: () => currentNow,
          sleep: async (ms) => {
            currentNow += ms;
          },
        });
        await assert.rejects(
          firstBridge.ensurePersistentShell(request),
          safeState === "prepared"
            ? /phase0 journal failpoint: after_prepare/
            : (error: unknown) =>
                error instanceof CodexDesktopBridgeError
                && error.code === "desktop_follower_not_ready",
        );
        if (safeState === "no_client_found") currentNow = NOW + 50;
        const beforeIntent = await journal.shellProvisionPort.claim({
          scope: request.scope,
          cwd: request.projectPath,
          title: request.title,
          baselineThreadIds: [],
          fence: firstFence,
        });
        const logicalTurnId = beforeIntent.materializationLogicalTurnId!;
        const beforeAttempt =
          await journal.inspectAttemptByLogicalTurn(logicalTurnId);
        assert.equal(beforeAttempt?.state, safeState);
        journal.close();

        currentNow = NOW + 101;
        const reopened = openJournal(databasePath, () => currentNow);
        const takeoverFence = {
          ownerId: "SHELL-TAKEOVER-WORKER-2",
          leaseToken: "SHELL-TAKEOVER-LEASE-2",
          leaseExpiresAt: new Date(NOW + 1_000).toISOString(),
          deadlineAt,
          ownerAttempt: 2,
          ownerEpoch: 2,
        };
        const recovered = createCodexDesktopBridge({
          shellControl: fixture.shellControl,
          follower: fixture.follower,
          logicalTurnPort: reopened.logicalTurnPort,
          startAttemptPort: reopened.startAttemptPort,
          shellProvisionPort: reopened.shellProvisionPort,
          now: () => currentNow,
        });
        const shell = await recovered.ensurePersistentShell({
          ...request,
          provisionFence: takeoverFence,
        });
        const afterAttempt =
          await reopened.inspectAttemptByLogicalTurn(logicalTurnId);

        assert.equal(shell.threadId, "THREAD-PROVISION-1");
        assert.equal(fixture.starts(), 1);
        assert.equal(afterAttempt?.attemptId, beforeAttempt?.attemptId);
        assert.equal(
          afterAttempt?.correlationMarker,
          beforeAttempt?.correlationMarker,
        );
        assert.equal(
          afterAttempt?.dispatchOrdinal,
          (beforeAttempt?.dispatchOrdinal ?? 0) + 1,
        );
        assert.equal(afterAttempt?.state, "succeeded");
        reopened.close();
      });
    });
  }

  it("takes over dispatching materialization by reconciliation without resend", async () => {
    await withJournal(async ({ databasePath, journal }) => {
      const fixture = durableShellFixture();
      let currentNow = NOW;
      const deadlineAt = new Date(NOW + 10_000).toISOString();
      const request = {
        projectPath: "/repo",
        scope: {
          kind: "change" as const,
          scopeId: "CHG-TAKEOVER-DISPATCHING",
          projectId: "P-1",
          changeId: "CHG-TAKEOVER-DISPATCHING",
        },
        title: "[CHG-TAKEOVER-DISPATCHING] Durable",
        provisionFence: {
          ownerId: "SHELL-DISPATCHING-WORKER-1",
          leaseToken: "SHELL-DISPATCHING-LEASE-1",
          leaseExpiresAt: new Date(NOW + 100).toISOString(),
          deadlineAt,
          ownerAttempt: 1,
          ownerEpoch: 1,
        },
      };
      const responseLostFollower: CodexDesktopFollowerTransport = {
        ...fixture.follower,
        async startFollowerTurn(input) {
          await fixture.follower.startFollowerTurn(input);
          throw new Error("materialization response lost");
        },
      };
      const crashing = createCodexDesktopBridge({
        shellControl: fixture.shellControl,
        follower: responseLostFollower,
        logicalTurnPort: journal.logicalTurnPort,
        startAttemptPort: journal.startAttemptPort,
        shellProvisionPort: journal.shellProvisionPort,
        followerStartFailpoint(checkpoint) {
          if (checkpoint === "unknown_response") {
            throw new Error("crash before ambiguous CAS");
          }
        },
        now: () => currentNow,
      });
      await assert.rejects(
        crashing.ensurePersistentShell(request),
        /injected phase0 crash: unknown_response/,
      );
      const beforeIntent = await journal.shellProvisionPort.claim({
        scope: request.scope,
        cwd: request.projectPath,
        title: request.title,
        baselineThreadIds: [],
        fence: request.provisionFence,
      });
      const logicalTurnId = beforeIntent.materializationLogicalTurnId!;
      const beforeAttempt =
        await journal.inspectAttemptByLogicalTurn(logicalTurnId);
      assert.equal(beforeAttempt?.state, "dispatching");
      journal.close();

      currentNow = NOW + 101;
      const reopened = openJournal(databasePath, () => currentNow);
      const recovered = createCodexDesktopBridge({
        shellControl: fixture.shellControl,
        follower: fixture.follower,
        logicalTurnPort: reopened.logicalTurnPort,
        startAttemptPort: reopened.startAttemptPort,
        shellProvisionPort: reopened.shellProvisionPort,
        now: () => currentNow,
      });
      const shell = await recovered.ensurePersistentShell({
        ...request,
        provisionFence: {
          ownerId: "SHELL-DISPATCHING-WORKER-2",
          leaseToken: "SHELL-DISPATCHING-LEASE-2",
          leaseExpiresAt: new Date(NOW + 1_000).toISOString(),
          deadlineAt,
          ownerAttempt: 2,
          ownerEpoch: 2,
        },
      });
      const afterAttempt =
        await reopened.inspectAttemptByLogicalTurn(logicalTurnId);

      assert.equal(shell.threadId, "THREAD-PROVISION-1");
      assert.equal(fixture.starts(), 1);
      assert.equal(fixture.materializationTurnCount(), 1);
      assert.equal(afterAttempt?.attemptId, beforeAttempt?.attemptId);
      assert.equal(afterAttempt?.dispatchOrdinal, 1);
      assert.equal(afterAttempt?.state, "succeeded");
      reopened.close();
    });
  });

  it("expires a missing recorded candidate without starting or adopting another shell", async () => {
    await withJournal(async ({ databasePath, journal }) => {
      const fixture = durableShellFixture();
      const provisionFence = {
        ownerId: "SHELL-WORKER-MISSING-CANDIDATE",
        leaseToken: "SHELL-LEASE-MISSING-CANDIDATE",
        leaseExpiresAt: new Date(NOW + 100).toISOString(),
      };
      const request = {
        projectPath: "/repo",
        scope: {
          kind: "change" as const,
          scopeId: "CHG-SHELL-MISSING-CANDIDATE",
          projectId: "P-1",
          changeId: "CHG-SHELL-MISSING-CANDIDATE",
        },
        title: "[CHG-SHELL-MISSING-CANDIDATE] Durable",
        provisionFence,
      };
      const intent = await journal.shellProvisionPort.claim({
        scope: request.scope,
        cwd: request.projectPath,
        title: request.title,
        baselineThreadIds: [],
        fence: provisionFence,
      });
      await journal.shellProvisionPort.recordCandidate({
        provisionId: intent.provisionId,
        threadId: "THREAD-MISSING",
        fence: provisionFence,
      });
      fixture.shells.set("THREAD-OTHER", {
        threadId: "THREAD-OTHER",
        title: request.title,
        cwd: request.projectPath,
        ephemeral: false,
      });
      fixture.activated.add("THREAD-OTHER");
      journal.close();

      let currentNow = NOW;
      const reopened = openJournal(databasePath, () => currentNow);
      const recovered = createCodexDesktopBridge({
        shellControl: fixture.shellControl,
        follower: fixture.follower,
        logicalTurnPort: reopened.logicalTurnPort,
        startAttemptPort: reopened.startAttemptPort,
        shellProvisionPort: reopened.shellProvisionPort,
        now: () => currentNow,
        sleep: async (ms) => {
          currentNow += ms;
        },
      });
      await assert.rejects(
        recovered.ensurePersistentShell(request),
        (error: unknown) =>
          error instanceof CodexDesktopBridgeError
          && error.code === "shell_provision_ambiguous"
          && /creator-session shell proof/i.test(error.message),
      );
      const expired = await reopened.shellProvisionPort.claim({
        scope: request.scope,
        cwd: request.projectPath,
        title: request.title,
        baselineThreadIds: [],
        fence: {
          ownerId: "SHELL-WORKER-RECOVERY",
          leaseToken: "SHELL-LEASE-RECOVERY",
          leaseExpiresAt: new Date(currentNow + 1_000).toISOString(),
        },
      });
      assert.equal(expired.state, "ambiguous");
      assert.equal(expired.candidateThreadId, "THREAD-MISSING");
      assert.match(expired.ambiguousReason ?? "", /creator-session shell proof/);
      assert.deepEqual(fixture.opened, []);
      assert.equal(fixture.starts(), 0);
      reopened.close();
    });
  });

  it("expires zero shell visibility durably at the immutable provision deadline", async () => {
    await withJournal(async ({ databasePath, journal, setNow }) => {
      const fixture = durableShellFixture();
      const originalList =
        fixture.shellControl.listPersistentShells.bind(fixture.shellControl);
      fixture.shellControl.listPersistentShells = async (input) =>
        fixture.starts() > 0 ? [] : originalList(input);
      fixture.shellControl.readPersistentShell = async () => null;
      let currentNow = NOW;
      let cursorAllocations = 0;
      const provisionFence = {
        ownerId: "SHELL-WORKER-VISIBILITY",
        leaseToken: "SHELL-LEASE-VISIBILITY",
        leaseExpiresAt: new Date(NOW + 100).toISOString(),
      };
      const request = {
        projectPath: "/repo",
        scope: {
          kind: "change" as const,
          scopeId: "CHG-SHELL-VISIBILITY",
          projectId: "P-1",
          changeId: "CHG-SHELL-VISIBILITY",
        },
        title: "[CHG-SHELL-VISIBILITY] Durable",
        provisionFence,
      };
      const bridge = createCodexDesktopBridge({
        shellControl: fixture.shellControl,
        follower: fixture.follower,
        logicalTurnPort: journal.logicalTurnPort,
        startAttemptPort: journal.startAttemptPort,
        shellProvisionPort: journal.shellProvisionPort,
        now: () => currentNow,
        sleep: async (ms) => {
          currentNow += ms;
          setNow(currentNow);
        },
        allocateCursor: async (cursor) => {
          cursorAllocations += 1;
          return cursor + 1;
        },
      });

      await assert.rejects(
        bridge.ensurePersistentShell(request),
        (error: unknown) =>
          error instanceof CodexDesktopBridgeError
          && error.code === "shell_provision_ambiguous"
          && /provision deadline expired/i.test(error.message),
      );
      assert.equal(fixture.starts(), 1);
      assert.equal(cursorAllocations, 0);
      journal.close();

      const reopened = openJournal(databasePath, () => currentNow);
      const intent = await reopened.shellProvisionPort.claim({
        scope: request.scope,
        cwd: request.projectPath,
        title: request.title,
        baselineThreadIds: [],
        fence: {
          ownerId: "SHELL-WORKER-RECOVERY",
          leaseToken: "SHELL-LEASE-RECOVERY",
          leaseExpiresAt: new Date(currentNow + 1_000).toISOString(),
        },
      });
      assert.equal(intent.state, "ambiguous");
      assert.equal(intent.ambiguousReason, "visibility_timeout");
      assert.equal(fixture.starts(), 1);
      reopened.close();
    });
  });

  it("fences shell visibility expiry by owner token and immutable deadline", async () => {
    await withJournal(async ({ journal, setNow }) => {
      const fence = {
        ownerId: "SHELL-WORKER-EXPIRY",
        leaseToken: "SHELL-LEASE-EXPIRY",
        leaseExpiresAt: new Date(NOW + 100).toISOString(),
      };
      const scope = {
        kind: "change" as const,
        scopeId: "CHG-SHELL-EXPIRY",
        projectId: "P-1",
        changeId: "CHG-SHELL-EXPIRY",
      };
      const intent = await journal.shellProvisionPort.claim({
        scope,
        cwd: "/repo",
        title: "[CHG-SHELL-EXPIRY] Durable",
        baselineThreadIds: [],
        fence,
      });

      await assert.rejects(
        journal.shellProvisionPort.expireProvisionVisibility({
          provisionId: intent.provisionId,
          fence,
        }),
        /not due/,
      );
      setNow(NOW + 100);
      for (const staleFence of [
        { ...fence, ownerId: "OTHER-WORKER" },
        { ...fence, leaseToken: "OTHER-LEASE" },
        {
          ...fence,
          leaseExpiresAt: new Date(NOW + 101).toISOString(),
        },
      ]) {
        await assert.rejects(
          journal.shellProvisionPort.expireProvisionVisibility({
            provisionId: intent.provisionId,
            fence: staleFence,
          }),
          /fenced/,
        );
      }
      await assert.rejects(
        journal.shellProvisionPort.markAmbiguous({
          provisionId: intent.provisionId,
          reason: "late ordinary write",
          fence,
        }),
        /fenced/,
      );
      await journal.shellProvisionPort.expireProvisionVisibility({
        provisionId: intent.provisionId,
        fence,
      });
      const persisted = await journal.shellProvisionPort.claim({
        scope,
        cwd: "/repo",
        title: "[CHG-SHELL-EXPIRY] Durable",
        baselineThreadIds: [],
        fence: {
          ownerId: "SHELL-WORKER-RECOVERY",
          leaseToken: "SHELL-LEASE-RECOVERY",
          leaseExpiresAt: new Date(NOW + 1_000).toISOString(),
        },
      });
      assert.equal(persisted.state, "ambiguous");
      assert.equal(persisted.ambiguousReason, "visibility_timeout");
    });
  });

  it("records one immutable shell candidate only under its live provision fence", async () => {
    await withJournal(async ({ journal }) => {
      const fence = {
        ownerId: "SHELL-WORKER-CANDIDATE",
        leaseToken: "SHELL-LEASE-CANDIDATE",
        leaseExpiresAt: new Date(NOW + 100).toISOString(),
      };
      const scope = {
        kind: "change" as const,
        scopeId: "CHG-SHELL-CANDIDATE",
        projectId: "P-1",
        changeId: "CHG-SHELL-CANDIDATE",
      };
      const intent = await journal.shellProvisionPort.claim({
        scope,
        cwd: "/repo",
        title: "[CHG-SHELL-CANDIDATE] Durable",
        baselineThreadIds: [],
        fence,
      });

      await journal.shellProvisionPort.recordCandidate({
        provisionId: intent.provisionId,
        threadId: "THREAD-CANDIDATE",
        fence,
      });
      const persisted = await journal.shellProvisionPort.claim({
        scope,
        cwd: "/repo",
        title: "[CHG-SHELL-CANDIDATE] Durable",
        baselineThreadIds: [],
        fence,
      });
      assert.equal(persisted.candidateThreadId, "THREAD-CANDIDATE");

      await assert.rejects(
        journal.shellProvisionPort.recordCandidate({
          provisionId: intent.provisionId,
          threadId: "THREAD-DIFFERENT",
          fence,
        }),
        /candidate.*fenced|immutable/i,
      );
      await assert.rejects(
        journal.shellProvisionPort.recordCandidate({
          provisionId: intent.provisionId,
          threadId: "THREAD-CANDIDATE",
          fence: { ...fence, leaseToken: "STALE-LEASE" },
        }),
        /candidate.*fenced/i,
      );
    });
  });

  it("promotes only a proved materialization attempt from bootstrap to durable ready", async () => {
    await withJournal(async ({ journal }) => {
      const fence = {
        ownerId: "SHELL-BOOTSTRAP-WORKER",
        leaseToken: "SHELL-BOOTSTRAP-LEASE",
        leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
      };
      const scope = {
        kind: "project_context" as const,
        scopeId: "P-BOOTSTRAP",
        projectId: "P-BOOTSTRAP",
      };
      const intent = await journal.shellProvisionPort.claim({
        scope,
        cwd: "/repo",
        title: "[P-BOOTSTRAP] Context",
        baselineThreadIds: [],
        fence,
      });
      await journal.shellProvisionPort.recordCandidate({
        provisionId: intent.provisionId,
        threadId: "THREAD-BOOTSTRAP",
        fence,
      });
      await journal.shellProvisionPort.recordBootstrapReady({
        provisionId: intent.provisionId,
        threadId: "THREAD-BOOTSTRAP",
        activationRequested: true,
        fence,
      });
      let persisted = await journal.shellProvisionPort.claim({
        scope,
        cwd: "/repo",
        title: "[P-BOOTSTRAP] Context",
        baselineThreadIds: [],
        fence,
      });
      assert.equal(persisted.state, "bootstrap_ready");
      assert.equal(persisted.threadId, undefined);

      const materialization =
        await journal.shellProvisionPort.beginMaterialization({
          provisionId: intent.provisionId,
          fence,
        });
      const context = await journal.logicalTurnPort.readForStart(
        materialization.logicalTurnId,
      );
      assert.equal(context.role, "shell_materialization");
      assert.equal(context.request.threadId, "THREAD-BOOTSTRAP");
      assert.equal(context.request.approvalPolicy, "never");
      assert.equal(context.request.sandboxMode, "read-only");

      const prepared = await journal.startAttemptPort.prepare({
        attemptId: "ATTEMPT-MATERIALIZATION",
        logicalTurnId: materialization.logicalTurnId,
      });
      const dispatchOrdinal = await journal.startAttemptPort.claimDispatch({
        attemptId: prepared.attemptId,
        fence: prepared.fence,
      });
      await journal.startAttemptPort.recordSuccess({
        attemptId: prepared.attemptId,
        dispatchOrdinal,
        turnId: "TURN-MATERIALIZATION",
        fence: prepared.fence,
      });
      await journal.shellProvisionPort.finalizeDurableReady({
        provisionId: intent.provisionId,
        threadId: "THREAD-BOOTSTRAP",
        logicalTurnId: materialization.logicalTurnId,
        attemptId: prepared.attemptId,
        turnId: "TURN-MATERIALIZATION",
        correlationMarker: prepared.correlationMarker,
        fence,
      });
      persisted = await journal.shellProvisionPort.claim({
        scope,
        cwd: "/repo",
        title: "[P-BOOTSTRAP] Context",
        baselineThreadIds: [],
        fence,
      });
      assert.equal(persisted.state, "durable_ready");
      assert.equal(persisted.threadId, "THREAD-BOOTSTRAP");
    });
  });

  it("dispatches materialization from creator baseline while independent read is invisible", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "stagepass-phase0-"));
    const databasePath = path.join(directory, "journal.sqlite");
    let baselineReadCalls = 0;
    const journal = createCodexPhase0SqliteJournal({
      databasePath,
      now: () => NOW,
      async readBaseline() {
        baselineReadCalls += 1;
        throw new Error("independent client cannot see bootstrap shell");
      },
    });
    try {
      const fixture = durableShellFixture();
      const bridge = createCodexDesktopBridge({
        shellControl: fixture.shellControl,
        follower: fixture.follower,
        logicalTurnPort: journal.logicalTurnPort,
        startAttemptPort: journal.startAttemptPort,
        shellProvisionPort: journal.shellProvisionPort,
        now: () => NOW,
      });
      const shell = await bridge.ensurePersistentShell({
        projectPath: "/repo",
        scope: {
          kind: "change",
          scopeId: "CHG-BASELINE",
          projectId: "P-1",
          changeId: "CHG-BASELINE",
        },
        title: "[CHG-BASELINE] Durable",
        provisionFence: {
          ownerId: "SHELL-BASELINE-WORKER",
          leaseToken: "SHELL-BASELINE-LEASE",
          leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
        },
      });

      assert.equal(shell.threadId, "THREAD-PROVISION-1");
      assert.equal(baselineReadCalls, 0);
      assert.equal(fixture.starts(), 1);
      assert.deepEqual(fixture.opened, [
        "THREAD-PROVISION-1",
        "THREAD-PROVISION-1",
      ]);
      assert.equal(
        journal.readBinding("change", "CHG-BASELINE").threadId,
        shell.threadId,
      );
    } finally {
      journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails live materialization proof before lease expiry without redispatch", async () => {
    await withJournal(async ({ journal, setNow }) => {
      const fixture = durableShellFixture();
      fixture.shellControl.listPersistentShells = async () => [];
      let currentNow = NOW;
      const scope = {
        kind: "change" as const,
        scopeId: "CHG-PROOF-TIMEOUT",
        projectId: "P-1",
        changeId: "CHG-PROOF-TIMEOUT",
      };
      const bridge = createCodexDesktopBridge({
        shellControl: fixture.shellControl,
        follower: fixture.follower,
        logicalTurnPort: journal.logicalTurnPort,
        startAttemptPort: journal.startAttemptPort,
        shellProvisionPort: journal.shellProvisionPort,
        readinessDeadlineMs: 100,
        now: () => currentNow,
        sleep: async (ms) => {
          currentNow += ms;
          setNow(currentNow);
        },
      });

      await assert.rejects(
        bridge.ensurePersistentShell({
          projectPath: "/repo",
          scope,
          title: "[CHG-PROOF-TIMEOUT] Durable",
          provisionFence: {
            ownerId: "SHELL-PROOF-WORKER",
            leaseToken: "SHELL-PROOF-LEASE",
            leaseExpiresAt: new Date(NOW + 10_000).toISOString(),
            deadlineAt: new Date(NOW + 20_000).toISOString(),
          },
        }),
        (error: unknown) =>
          error instanceof CodexDesktopBridgeError
          && error.code === "shell_provision_ambiguous"
          && /materialization visibility timeout/.test(error.message),
      );
      const inspected = journal.inspectShellProvision(
        scope.kind,
        scope.scopeId,
      );
      assert.equal(inspected.state, "ambiguous");
      assert.equal(inspected.attempt?.state, "succeeded");
      assert.equal(inspected.attempt?.dispatchOrdinal, 1);
      assert.equal(inspected.attemptCount, 1);
      assert.equal(inspected.executionCount, 1);
      assert.equal(fixture.starts(), 1);
      assert.equal(fixture.materializationTurnCount(), 1);
    });
  });

  for (const candidateCount of [0, 2] as const) {
    it(`durably blocks shell creation after reopen with ${candidateCount} provision candidates`, async () => {
      await withJournal(async ({ databasePath, journal }) => {
        const fixture = durableShellFixture();
        const provisionFence = {
          ownerId: "SHELL-WORKER-AMBIGUOUS",
          leaseToken: "SHELL-LEASE-AMBIGUOUS",
          leaseExpiresAt: "2026-07-23T12:05:00.000Z",
        };
        const scope = {
          kind: "change" as const,
          scopeId: `CHG-SHELL-${candidateCount}`,
          projectId: "P-1",
          changeId: `CHG-SHELL-${candidateCount}`,
        };
        await journal.shellProvisionPort.claim({
          scope,
          cwd: "/repo",
          title: `[${scope.scopeId}] Durable`,
          baselineThreadIds: [],
          fence: provisionFence,
        });
        journal.close();
        for (let index = 0; index < candidateCount; index += 1) {
          const threadId = `THREAD-AMBIGUOUS-${index}`;
          fixture.shells.set(threadId, {
            threadId,
            title: "",
            cwd: "/repo",
            ephemeral: false,
          });
        }

        let currentNow = NOW;
        const reopened = openJournal(databasePath, () => currentNow);
        const bridge = createCodexDesktopBridge({
          shellControl: fixture.shellControl,
          follower: fixture.follower,
          logicalTurnPort: reopened.logicalTurnPort,
          startAttemptPort: reopened.startAttemptPort,
          shellProvisionPort: reopened.shellProvisionPort,
          now: () => currentNow,
          sleep: async (ms) => {
            currentNow += ms;
          },
        });
        const request = {
          projectPath: "/repo",
          scope,
          title: `[${scope.scopeId}] Durable`,
        };
        for (let call = 0; call < 2; call += 1) {
          await assert.rejects(
            bridge.ensurePersistentShell({
              ...request,
              provisionFence: call === 0
                ? provisionFence
                : {
                    ownerId: "SHELL-WORKER-RECOVERY",
                    leaseToken: "SHELL-LEASE-RECOVERY",
                    leaseExpiresAt:
                      new Date(currentNow + 1_000).toISOString(),
                  },
            }),
            (error: unknown) =>
              error instanceof CodexDesktopBridgeError
              && error.code === "shell_provision_ambiguous",
          );
        }
        assert.equal(fixture.starts(), 0);
        reopened.close();
      });
    });
  }

  for (const candidateCount of [0, 2] as const) {
    it(`quarantines ${candidateCount} marker candidates through the SQLite-backed bridge`, async () => {
      await withJournal(async ({ journal, setNow }) => {
        const seeded = await journal.seedManagedRun(projectSeed({
          deadlineAt: new Date(NOW + 1_000).toISOString(),
          leaseExpiresAt: new Date(NOW + 1_000).toISOString(),
        }));
        const { shellControl, follower } = sqliteRecoveryFixture(candidateCount);
        let currentNow = NOW;
        const bridge = createCodexDesktopBridge({
          shellControl,
          follower,
          logicalTurnPort: journal.logicalTurnPort,
          startAttemptPort: journal.startAttemptPort,
          shellProvisionPort: journal.shellProvisionPort,
          readinessDeadlineMs: 1_000,
          now: () => currentNow,
          sleep: async (ms) => {
            currentNow += ms;
            setNow(currentNow);
          },
        });

        await assert.rejects(
          bridge.startTurn({ logicalTurnId: seeded.logicalTurnId }),
          (error: unknown) => {
            assert.ok(error instanceof CodexDesktopBridgeError);
            assert.equal(error.code, "desktop_follower_start_ambiguous");
            assert.match(
              error.message,
              candidateCount === 0 ? /could not be uniquely reconciled/ : /multiple correlated/,
            );
            return true;
          },
        );
      });
    });
  }

  it("polls zero candidates read-only until one appears without redispatch or cursor advance", async () => {
    await withJournal(async ({ journal, setNow }) => {
      const seeded = await journal.seedManagedRun(projectSeed());
      const fixture = sqliteRecoveryFixture(1, 1);
      let currentNow = NOW;
      let cursorAllocations = 0;
      const common = {
        shellControl: fixture.shellControl,
        follower: fixture.follower,
        logicalTurnPort: journal.logicalTurnPort,
        startAttemptPort: journal.startAttemptPort,
        shellProvisionPort: journal.shellProvisionPort,
        now: () => currentNow,
        sleep: async (ms: number) => {
          currentNow += ms;
          setNow(currentNow);
        },
        allocateCursor: async (cursor: number) => {
          cursorAllocations += 1;
          return cursor + 1;
        },
      };
      const crashing = createCodexDesktopBridge({
        ...common,
        followerStartFailpoint(checkpoint) {
          if (checkpoint !== "unknown_response") return;
          const error = new Error("crash after unknown response");
          Object.assign(error, {
            phase0CrashCheckpoint: "unknown_response",
          });
          throw error;
        },
      });
      await assert.rejects(
        crashing.startTurn({ logicalTurnId: seeded.logicalTurnId }),
        /unknown_response/,
      );
      assert.equal(fixture.startCalls(), 1);
      const recovered = await createCodexDesktopBridge(common).recoverTurn({
        logicalTurnId: seeded.logicalTurnId,
      });
      assert.equal(recovered.state, "succeeded");
      assert.equal(fixture.reads(), 2);
      assert.equal(fixture.startCalls(), 1);
      assert.equal(cursorAllocations, 0);
    });
  });

  it("polls through the immutable deadline then uses the fenced expiry transition", async () => {
    await withJournal(async ({ journal, setNow }) => {
      const immutableDeadline = NOW + 100;
      const seeded = await journal.seedManagedRun(projectSeed({
        deadlineAt: new Date(immutableDeadline).toISOString(),
        leaseExpiresAt: new Date(immutableDeadline).toISOString(),
      }));
      const fixture = sqliteRecoveryFixture(0);
      let currentNow = NOW;
      let cursorAllocations = 0;
      const common = {
        shellControl: fixture.shellControl,
        follower: fixture.follower,
        logicalTurnPort: journal.logicalTurnPort,
        startAttemptPort: journal.startAttemptPort,
        shellProvisionPort: journal.shellProvisionPort,
        now: () => currentNow,
        sleep: async (ms: number) => {
          currentNow += ms;
          setNow(currentNow);
        },
        allocateCursor: async (cursor: number) => {
          cursorAllocations += 1;
          return cursor + 1;
        },
      };
      const crashing = createCodexDesktopBridge({
        ...common,
        followerStartFailpoint(checkpoint) {
          if (checkpoint !== "unknown_response") return;
          const error = new Error("crash after unknown response");
          Object.assign(error, {
            phase0CrashCheckpoint: "unknown_response",
          });
          throw error;
        },
      });
      await assert.rejects(
        crashing.startTurn({ logicalTurnId: seeded.logicalTurnId }),
      );
      const recovered = await createCodexDesktopBridge(common).recoverTurn({
        logicalTurnId: seeded.logicalTurnId,
      });
      assert.equal(recovered.state, "quarantined");
      assert.equal(currentNow, immutableDeadline);
      assert.equal(fixture.startCalls(), 1);
      assert.equal(cursorAllocations, 0);
      assert.equal(
        (await journal.inspectAttemptByLogicalTurn(
          seeded.logicalTurnId,
        ))?.ambiguousReason,
        "visibility_timeout",
      );
    });
  });

  it("rejects owner takeover that extends the immutable original deadline", async () => {
    await withJournal(async ({ journal, setNow }) => {
      const deadlineAt = new Date(NOW + 120_000).toISOString();
      const leaseExpiresAt = new Date(NOW + 60_000).toISOString();
      const seeded = await journal.seedManagedRun(projectSeed({
        deadlineAt,
        leaseExpiresAt,
      }));
      setNow(NOW + 61_000);
      await assert.rejects(
        journal.takeOverOwner({
          owner: seeded.fence.owner,
          expectedWorkerId: seeded.fence.workerId,
          expectedLeaseToken: seeded.fence.leaseToken,
          expectedOwnerAttempt: seeded.fence.ownerAttempt,
          expectedOwnerEpoch: seeded.fence.ownerEpoch,
          expectedDeadlineAt: deadlineAt,
          expectedLeaseExpiresAt: leaseExpiresAt,
          expectedStatus: "running",
          workerId: "WORKER-EXTENSION",
          leaseToken: "LEASE-EXTENSION",
          ownerAttempt: 2,
          ownerEpoch: 2,
          deadlineAt: new Date(NOW + 120_001).toISOString(),
          leaseExpiresAt: new Date(NOW + 100_000).toISOString(),
        }),
        /cannot extend deadline/,
      );
      assert.equal(
        journal.readOwner(seeded.fence).workerId,
        seeded.fence.workerId,
      );
    });
  });

  it("rejects expired takeover when any persisted old-fence field drifted", async () => {
    await withJournal(async ({ databasePath, journal, setNow }) => {
      const deadlineAt = new Date(NOW + 120_000).toISOString();
      const leaseExpiresAt = new Date(NOW + 60_000).toISOString();
      const seeded = await journal.seedManagedRun(projectSeed({
        deadlineAt,
        leaseExpiresAt,
      }));
      setNow(NOW + 61_000);
      const expectedOldFence = {
        expectedWorkerId: seeded.fence.workerId,
        expectedLeaseToken: seeded.fence.leaseToken,
        expectedOwnerAttempt: seeded.fence.ownerAttempt,
        expectedOwnerEpoch: seeded.fence.ownerEpoch,
        expectedDeadlineAt: deadlineAt,
        expectedLeaseExpiresAt: leaseExpiresAt,
        expectedStatus: "running" as const,
      };
      for (const [column, driftedValue, originalValue] of [
        [
          "lease_expires_at",
          new Date(NOW + 59_000).toISOString(),
          leaseExpiresAt,
        ],
        [
          "deadline_at",
          new Date(NOW + 119_000).toISOString(),
          deadlineAt,
        ],
        ["status", "completed", "running"],
      ] as const) {
        const drift = new Database(databasePath);
        drift.prepare(`
          UPDATE phase0_project_ai_runs
          SET ${column} = ?
          WHERE owner_id = ?
        `).run(driftedValue, seeded.fence.owner.projectAiRunId);
        drift.close();

        await assert.rejects(
          journal.takeOverOwner({
            owner: seeded.fence.owner,
            ...expectedOldFence,
            workerId: "WORKER-DRIFT",
            leaseToken: "LEASE-DRIFT",
            ownerAttempt: 2,
            ownerEpoch: 2,
            deadlineAt,
            leaseExpiresAt: new Date(NOW + 90_000).toISOString(),
          }),
          /managed owner takeover rejected/,
        );
        assert.equal(
          journal.readOwner(seeded.fence).workerId,
          seeded.fence.workerId,
        );
        const restore = new Database(databasePath);
        restore.prepare(`
          UPDATE phase0_project_ai_runs
          SET ${column} = ?
          WHERE owner_id = ?
        `).run(originalValue, seeded.fence.owner.projectAiRunId);
        restore.close();
      }
      await assert.rejects(
        journal.takeOverOwner({
          owner: seeded.fence.owner,
          ...expectedOldFence,
          workerId: "WORKER-SKIPPED-EPOCH",
          leaseToken: "LEASE-SKIPPED-EPOCH",
          ownerAttempt: 3,
          ownerEpoch: 3,
          deadlineAt,
          leaseExpiresAt: new Date(NOW + 90_000).toISOString(),
        }),
        /managed owner takeover fence is invalid/,
      );
    });
  });

  it("applies the same full-fence drift and +1 takeover rules to pipeline owners", async () => {
    await withJournal(async ({ databasePath, journal, setNow }) => {
      const deadlineAt = new Date(NOW + 120_000).toISOString();
      const leaseExpiresAt = new Date(NOW + 60_000).toISOString();
      const seeded = await journal.seedManagedRun(projectSeed({
        ownerKind: "pipeline_job",
        ownerId: "PIPELINE-TAKEOVER-OWNER",
        scopeKind: "change",
        scopeId: "CHG-PIPELINE-TAKEOVER",
        changeId: "CHG-PIPELINE-TAKEOVER",
        phase: "Build",
        role: "build",
        binding: {
          threadId: "THREAD-PIPELINE-TAKEOVER",
          cwd: "/repo",
          title: "[CHG-PIPELINE-TAKEOVER] Build",
        },
        deadlineAt,
        leaseExpiresAt,
      }));
      if (seeded.fence.owner.kind !== "pipeline_job") {
        assert.fail("expected pipeline owner");
      }
      const pipelineOwnerId = seeded.fence.owner.pipelineJobId;
      setNow(NOW + 61_000);
      const drift = new Database(databasePath);
      drift.prepare(`
        UPDATE phase0_pipeline_jobs SET status = 'completed'
        WHERE owner_id = ?
      `).run(pipelineOwnerId);
      drift.close();
      await assert.rejects(
        journal.takeOverOwner({
          owner: seeded.fence.owner,
          expectedWorkerId: seeded.fence.workerId,
          expectedLeaseToken: seeded.fence.leaseToken,
          expectedOwnerAttempt: seeded.fence.ownerAttempt,
          expectedOwnerEpoch: seeded.fence.ownerEpoch,
          expectedDeadlineAt: deadlineAt,
          expectedLeaseExpiresAt: leaseExpiresAt,
          expectedStatus: "running",
          workerId: "PIPELINE-RECOVERY-WORKER",
          leaseToken: "PIPELINE-RECOVERY-LEASE",
          ownerAttempt: seeded.fence.ownerAttempt + 1,
          ownerEpoch: seeded.fence.ownerEpoch + 1,
          deadlineAt,
          leaseExpiresAt: new Date(NOW + 90_000).toISOString(),
        }),
        /managed owner takeover rejected/,
      );
      const restore = new Database(databasePath);
      restore.prepare(`
        UPDATE phase0_pipeline_jobs SET status = 'running'
        WHERE owner_id = ?
      `).run(pipelineOwnerId);
      restore.close();
      await journal.takeOverOwner({
        owner: seeded.fence.owner,
        expectedWorkerId: seeded.fence.workerId,
        expectedLeaseToken: seeded.fence.leaseToken,
        expectedOwnerAttempt: seeded.fence.ownerAttempt,
        expectedOwnerEpoch: seeded.fence.ownerEpoch,
        expectedDeadlineAt: deadlineAt,
        expectedLeaseExpiresAt: leaseExpiresAt,
        expectedStatus: "running",
        workerId: "PIPELINE-RECOVERY-WORKER",
        leaseToken: "PIPELINE-RECOVERY-LEASE",
        ownerAttempt: seeded.fence.ownerAttempt + 1,
        ownerEpoch: seeded.fence.ownerEpoch + 1,
        deadlineAt,
        leaseExpiresAt: new Date(NOW + 90_000).toISOString(),
      });
      assert.equal(
        journal.readOwner(seeded.fence).workerId,
        "PIPELINE-RECOVERY-WORKER",
      );
    });
  });

  it("persists one authoritative click and one Host wakeup effect across duplicate stale and recovery races", async () => {
    await withJournal(async ({ databasePath, journal }) => {
      for (
        const [ordinal, order] of ([
          ["host", "recovery"],
          ["recovery", "host"],
        ] as const).entries()
      ) {
        const seeded = await journal.seedManagedRun(projectSeed({
          phase: "Interaction",
          role: "interaction_wakeup",
          ordinal,
          purpose: "interaction_wakeup",
        }));
        const interactionId = `INTERACTION-${ordinal}`;
        await journal.createInteractionWakeup({
          interactionId,
          logicalTurnId: seeded.logicalTurnId,
          cardVersion: 1,
        });
        const accepted = await journal.submitInteractionDecision({
          interactionId,
          cardVersion: 1,
          clickId: `CLICK-${ordinal}`,
          selectedOption: "approve",
        });
        assert.equal(accepted.status, "accepted");
        assert.ok(accepted.jobId);
        assert.equal(
          (await journal.submitInteractionDecision({
            interactionId,
            cardVersion: 1,
            clickId: `CLICK-${ordinal}`,
            selectedOption: "approve",
          })).status,
          "duplicate",
        );
        assert.equal(
          (await journal.submitInteractionDecision({
            interactionId,
            cardVersion: 0,
            clickId: `STALE-${ordinal}`,
            selectedOption: "reject",
          })).status,
          "stale",
        );

        const recovery = openJournal(databasePath);
        const delivered: Array<{
          threadId: string;
          markerMessage: string;
        }> = [];
        const transport = {
          async sendMarkerMessage(message: {
            threadId: string;
            markerMessage: string;
          }) {
            delivered.push(message);
            await Promise.resolve();
            return {
              status: "acknowledged" as const,
              receiptId: `HOST-RECEIPT-${interactionId}`,
            };
          },
          async reconcileMarkerMessage() {
            return null;
          },
        };
        try {
          const outcomes = await Promise.all(order.map((source, index) =>
            (index === 0 ? journal : recovery).executeInteractionWakeup({
              jobId: accepted.jobId!,
              source,
              workerId: `${source.toUpperCase()}-WORKER`,
              leaseToken: `${source.toUpperCase()}-LEASE`,
              leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
              transport,
            })));
          assert.deepEqual(
            outcomes.map(({ created }) => created),
            [true, false],
          );
          assert.equal(outcomes[0]!.effectId, outcomes[1]!.effectId);
          assert.equal(outcomes[0]!.executionId, outcomes[1]!.executionId);
          assert.equal(outcomes[0]!.source, order[0]);
          assert.equal(delivered.length, 1);
          assert.equal(delivered[0]!.threadId, "THREAD-PRD");
          assert.match(
            delivered[0]!.markerMessage,
            new RegExp(
              `^STAGEPASS_PHASE0_WAKEUP ${interactionId} ${
                accepted.jobId
              } ${accepted.attemptId} approve$`,
            ),
          );
        } finally {
          recovery.close();
        }

        const evidence = journal.inspectInteractionWakeup(interactionId);
        assert.deepEqual(evidence, {
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
          jobId: accepted.jobId,
          attemptId: accepted.attemptId,
        });
      }
    });
  });

  it("keeps the wake job unsettled when Host marker transport fails", async () => {
    await withJournal(async ({ journal }) => {
      const seeded = await journal.seedManagedRun(projectSeed({
        phase: "Interaction",
        role: "interaction_wakeup",
        ordinal: 9,
        purpose: "interaction_wakeup",
      }));
      await journal.createInteractionWakeup({
        interactionId: "INTERACTION-TRANSPORT-FAIL",
        logicalTurnId: seeded.logicalTurnId,
        cardVersion: 1,
      });
      const accepted = await journal.submitInteractionDecision({
        interactionId: "INTERACTION-TRANSPORT-FAIL",
        cardVersion: 1,
        clickId: "CLICK-TRANSPORT-FAIL",
        selectedOption: "approve",
      });
      await assert.rejects(
        journal.executeInteractionWakeup({
          jobId: accepted.jobId!,
          source: "host",
          workerId: "HOST-WORKER",
          leaseToken: "HOST-LEASE",
          leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
          transport: {
            async sendMarkerMessage() {
              throw new Error("Host ui/message rejected");
            },
            async reconcileMarkerMessage() {
              return null;
            },
          },
        }),
        /Host ui\/message rejected/,
      );
      const evidence = journal.inspectInteractionWakeup(
        "INTERACTION-TRANSPORT-FAIL",
      );
      assert.deepEqual({
        decisionCount: evidence.decisionCount,
        jobCount: evidence.jobCount,
        attemptCount: evidence.attemptCount,
        executionCount: evidence.executionCount,
        effectCount: evidence.effectCount,
        outboxCount: evidence.outboxCount,
        receiptCount: evidence.receiptCount,
        dispatchCount: evidence.dispatchCount,
        dispatchSurfaces: evidence.dispatchSurfaces,
      }, {
        decisionCount: 1,
        jobCount: 1,
        attemptCount: 1,
        executionCount: 0,
        effectCount: 0,
        outboxCount: 1,
        receiptCount: 0,
        dispatchCount: 1,
        dispatchSurfaces: ["host_ui_message", "host_ui_message"],
      });
      assert.equal(
        (await journal.inspectAttempt(accepted.attemptId!))?.state,
        "dispatching",
      );
    });
  });

  it("durably records Host ack before settlement and recovers without resending", async () => {
    await withJournal(async ({ databasePath, journal }) => {
      const seeded = await journal.seedManagedRun(projectSeed({
        phase: "Interaction",
        role: "interaction_wakeup",
        ordinal: 10,
        purpose: "interaction_wakeup",
      }));
      const interactionId = "INTERACTION-ACK-CRASH";
      await journal.createInteractionWakeup({
        interactionId,
        logicalTurnId: seeded.logicalTurnId,
        cardVersion: 1,
      });
      const accepted = await journal.submitInteractionDecision({
        interactionId,
        cardVersion: 1,
        clickId: "CLICK-ACK-CRASH",
        selectedOption: "approve",
      });
      let sends = 0;
      journal.setFailpoint("after_host_ack_before_settlement");
      await assert.rejects(
        journal.executeInteractionWakeup({
          jobId: accepted.jobId!,
          source: "host",
          workerId: "HOST-WORKER",
          leaseToken: "HOST-LEASE",
          leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
          transport: {
            async sendMarkerMessage() {
              sends += 1;
              return {
                status: "acknowledged" as const,
                receiptId: "HOST-RECEIPT-1",
              };
            },
            async reconcileMarkerMessage() {
              throw new Error("durable receipt should be read before Host reconciliation");
            },
          },
        }),
        (error: unknown) =>
          error instanceof CodexPhase0InjectedCrash
          && error.phase0CrashCheckpoint
            === "after_host_ack_before_settlement",
      );
      assert.equal(sends, 1);
      assert.equal(
        journal.inspectInteractionWakeup(interactionId).executionCount,
        0,
      );
      journal.close();

      const recovered = openJournal(databasePath);
      try {
        const result = await recovered.executeInteractionWakeup({
          jobId: accepted.jobId!,
          source: "recovery",
          workerId: "RECOVERY-WORKER",
          leaseToken: "RECOVERY-LEASE",
          leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
          transport: {
            async sendMarkerMessage() {
              throw new Error("acknowledged marker must never be resent");
            },
            async reconcileMarkerMessage() {
              throw new Error("durable receipt should settle directly");
            },
          },
        });
        assert.equal(result.created, true);
        assert.equal(sends, 1);
        assert.equal(
          recovered.inspectInteractionWakeup(interactionId).dispatchCount,
          1,
        );
      } finally {
        recovered.close();
      }
    });
  });

  it("authorizes a view-owned Host dispatch before send and settles its protected ack", async () => {
    await withJournal(async ({ journal }) => {
      const seeded = await journal.seedManagedRun(projectSeed({
        phase: "Interaction",
        role: "interaction_wakeup",
        ordinal: 14,
        purpose: "interaction_wakeup",
      }));
      const interactionId = "INTERACTION-VIEW-HOST";
      await journal.createInteractionWakeup({
        interactionId,
        logicalTurnId: seeded.logicalTurnId,
        cardVersion: 1,
      });
      const canonical = journal.inspectInteractionBinding(interactionId);
      await journal.registerVerificationWakeup({
        runId: "00000000-0000-4000-8000-000000000014",
        nonceId: "00000000-0000-4000-8000-000000000015",
        interactionId,
        logicalTurnId: canonical.logicalTurnId,
        bindingId: canonical.bindingId,
        threadId: canonical.threadId,
        cardVersion: 1,
      });
      const decision = await journal.submitInteractionDecision({
        interactionId,
        cardVersion: 1,
        clickId: "00000000-0000-4000-8000-000000000014",
        selectedOption: "continue",
      });
      const leaseExpiresAt = new Date(NOW + 60_000).toISOString();
      const authorized = await journal.authorizeInteractionWakeup({
        jobId: decision.jobId!,
        markerNonceId: "00000000-0000-4000-8000-000000000015",
        verificationNonceId: "00000000-0000-4000-8000-000000000015",
        workerId: "VIEW-HOST-WORKER",
        leaseToken: "VIEW-HOST-LEASE",
        leaseExpiresAt,
      });
      assert.equal(authorized.attemptId, decision.attemptId);
      assert.equal(
        journal.readVerificationWakeup(
          "00000000-0000-4000-8000-000000000015",
        ).state,
        "authorized",
      );
      assert.match(
        authorized.markerMessage,
        new RegExp(
          `^STAGEPASS_PHASE0_WAKEUP THREAD-PRD `
          + `00000000-0000-4000-8000-000000000015 `
          + `${decision.jobId} ${decision.attemptId}$`,
        ),
      );
      const settled = await journal.recordInteractionWakeupAck({
        jobId: decision.jobId!,
        source: "host",
        workerId: "VIEW-HOST-WORKER",
        leaseToken: "VIEW-HOST-LEASE",
        leaseExpiresAt,
        receiptId: "VIEW-HOST-RECEIPT",
        markerMessage: authorized.markerMessage,
      });
      assert.equal(settled.created, true);
      assert.equal(
        journal.readVerificationWakeup(
          "00000000-0000-4000-8000-000000000015",
        ).state,
        "acked",
      );
      const evidence = journal.inspectInteractionWakeup(interactionId);
      assert.deepEqual({
        decisionCount: evidence.decisionCount,
        jobCount: evidence.jobCount,
        attemptCount: evidence.attemptCount,
        outboxCount: evidence.outboxCount,
        receiptCount: evidence.receiptCount,
        executionCount: evidence.executionCount,
        effectCount: evidence.effectCount,
        dispatchCount: evidence.dispatchCount,
      }, {
        decisionCount: 1,
        jobCount: 1,
        attemptCount: 1,
        outboxCount: 1,
        receiptCount: 1,
        executionCount: 1,
        effectCount: 1,
        dispatchCount: 1,
      });
    });
  });

  it("recovers verification identity after decision and authorization response restarts", async () => {
    await withJournal(async ({ databasePath, journal }) => {
      const seeded = await journal.seedManagedRun(projectSeed({
        phase: "Interaction",
        role: "interaction_wakeup",
        ordinal: 15,
        purpose: "interaction_wakeup",
      }));
      const interactionId = "INTERACTION-VERIFICATION-RESTART";
      const runId = "00000000-0000-4000-8000-000000000016";
      const nonceId = "00000000-0000-4000-8000-000000000017";
      await journal.createInteractionWakeup({
        interactionId,
        logicalTurnId: seeded.logicalTurnId,
        cardVersion: 1,
      });
      const canonical = journal.inspectInteractionBinding(interactionId);
      await journal.registerVerificationWakeup({
        runId,
        nonceId,
        interactionId,
        logicalTurnId: canonical.logicalTurnId,
        bindingId: canonical.bindingId,
        threadId: canonical.threadId,
        cardVersion: 1,
      });
      const decision = await journal.submitInteractionDecision({
        interactionId,
        cardVersion: 1,
        clickId: nonceId,
        selectedOption: "continue",
      });
      journal.close();

      const afterDecisionRestart = openJournal(databasePath);
      const persistedMint = afterDecisionRestart.readVerificationWakeup(nonceId);
      assert.equal(persistedMint.state, "minted");
      assert.equal(
        afterDecisionRestart.inspectInteractionWakeup(interactionId)
          .decisionCount,
        1,
      );
      const replayedDecision =
        await afterDecisionRestart.submitInteractionDecision({
          interactionId,
          cardVersion: 1,
          clickId: nonceId,
          selectedOption: "continue",
        });
      assert.equal(replayedDecision.status, "duplicate");
      assert.equal(replayedDecision.jobId, decision.jobId);
      assert.equal(replayedDecision.attemptId, decision.attemptId);
      const leaseExpiresAt = new Date(NOW + 60_000).toISOString();
      const authorized =
        await afterDecisionRestart.authorizeInteractionWakeup({
          jobId: decision.jobId!,
          verificationNonceId: nonceId,
          markerNonceId: nonceId,
          workerId: "RESTART-WORKER",
          leaseToken: "RESTART-LEASE",
          leaseExpiresAt,
        });
      afterDecisionRestart.close();

      const afterAuthorizationRestart = openJournal(databasePath);
      try {
        const persistedAuthorization =
          afterAuthorizationRestart.readVerificationWakeup(nonceId);
        assert.deepEqual(persistedAuthorization, {
          runId,
          nonceId,
          interactionId,
          logicalTurnId: canonical.logicalTurnId,
          bindingId: canonical.bindingId,
          threadId: canonical.threadId,
          cardVersion: 1,
          state: "authorized",
          jobId: decision.jobId,
          attemptId: decision.attemptId,
          workerId: "RESTART-WORKER",
          leaseToken: "RESTART-LEASE",
          leaseExpiresAt,
          markerMessage: authorized.markerMessage,
        });
      } finally {
        afterAuthorizationRestart.close();
      }
    });
  });

  it("reconciles the Host marker after ack-before-receipt crash without redispatch", async () => {
    await withJournal(async ({ journal, setNow }) => {
      const seeded = await journal.seedManagedRun(projectSeed({
        phase: "Interaction",
        role: "interaction_wakeup",
        ordinal: 13,
        purpose: "interaction_wakeup",
      }));
      const interactionId = "INTERACTION-ACK-BEFORE-RECEIPT";
      await journal.createInteractionWakeup({
        interactionId,
        logicalTurnId: seeded.logicalTurnId,
        cardVersion: 1,
      });
      const accepted = await journal.submitInteractionDecision({
        interactionId,
        cardVersion: 1,
        clickId: "CLICK-ACK-BEFORE-RECEIPT",
        selectedOption: "approve",
      });
      let sends = 0;
      journal.setFailpoint("after_host_ack_before_receipt");
      await assert.rejects(
        journal.executeInteractionWakeup({
          jobId: accepted.jobId!,
          source: "host",
          workerId: "HOST-WORKER",
          leaseToken: "HOST-LEASE",
          leaseExpiresAt: new Date(NOW + 10).toISOString(),
          transport: {
            async sendMarkerMessage() {
              sends += 1;
              return {
                status: "acknowledged" as const,
                receiptId: "HOST-RECEIPT-NOT-COMMITTED",
              };
            },
            async reconcileMarkerMessage() {
              throw new Error("initial dispatch does not reconcile");
            },
          },
        }),
        (error: unknown) =>
          error instanceof CodexPhase0InjectedCrash
          && error.phase0CrashCheckpoint === "after_host_ack_before_receipt",
      );
      assert.equal(sends, 1);
      setNow(NOW + 11);

      let reconciliations = 0;
      const recovered = await journal.executeInteractionWakeup({
        jobId: accepted.jobId!,
        source: "recovery",
        workerId: "RECOVERY-WORKER",
        leaseToken: "RECOVERY-LEASE",
        leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
        transport: {
          async sendMarkerMessage() {
            throw new Error("acknowledged marker must not be redispatched");
          },
          async reconcileMarkerMessage() {
            reconciliations += 1;
            return { receiptId: "HOST-RECEIPT-RECONCILED" };
          },
        },
      });
      assert.equal(recovered.created, true);
      assert.equal(sends, 1);
      assert.equal(reconciliations, 1);
      assert.equal(
        journal.inspectInteractionWakeup(interactionId).dispatchCount,
        1,
      );
    });
  });

  it("reconciles an unknown Host result without resend and increments real rejected retries", async () => {
    await withJournal(async ({ journal, setNow }) => {
      const create = async (interactionId: string, ordinal: number) => {
        const seeded = await journal.seedManagedRun(projectSeed({
          phase: "Interaction",
          role: "interaction_wakeup",
          ordinal,
          purpose: "interaction_wakeup",
        }));
        await journal.createInteractionWakeup({
          interactionId,
          logicalTurnId: seeded.logicalTurnId,
          cardVersion: 1,
        });
        return journal.submitInteractionDecision({
          interactionId,
          cardVersion: 1,
          clickId: `CLICK-${ordinal}`,
          selectedOption: "approve",
        });
      };

      const unknown = await create("INTERACTION-UNKNOWN", 11);
      let sends = 0;
      await assert.rejects(
        journal.executeInteractionWakeup({
          jobId: unknown.jobId!,
          source: "host",
          workerId: "HOST-WORKER",
          leaseToken: "HOST-LEASE",
          leaseExpiresAt: new Date(NOW + 10).toISOString(),
          transport: {
            async sendMarkerMessage() {
              sends += 1;
              throw new Error("Host result lost");
            },
            async reconcileMarkerMessage() {
              return null;
            },
          },
        }),
        /Host result lost/,
      );
      setNow(NOW + 11);
      const reconciled = await journal.executeInteractionWakeup({
        jobId: unknown.jobId!,
        source: "recovery",
        workerId: "RECOVERY-WORKER",
        leaseToken: "RECOVERY-LEASE",
        leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
        transport: {
          async sendMarkerMessage() {
            throw new Error("unknown Host result must never be resent");
          },
          async reconcileMarkerMessage() {
            return { receiptId: "HOST-RECEIPT-UNKNOWN" };
          },
        },
      });
      assert.equal(reconciled.created, true);
      assert.equal(sends, 1);

      const rejected = await create("INTERACTION-REJECTED", 12);
      await assert.rejects(
        journal.executeInteractionWakeup({
          jobId: rejected.jobId!,
          source: "host",
          workerId: "HOST-WORKER-1",
          leaseToken: "HOST-LEASE-1",
          leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
          transport: {
            async sendMarkerMessage() {
              return { status: "rejected" as const };
            },
            async reconcileMarkerMessage() {
              return null;
            },
          },
        }),
        /Host marker dispatch was rejected/,
      );
      const retried = await journal.executeInteractionWakeup({
        jobId: rejected.jobId!,
        source: "host",
        workerId: "HOST-WORKER-2",
        leaseToken: "HOST-LEASE-2",
        leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
        transport: {
          async sendMarkerMessage() {
            return {
              status: "acknowledged" as const,
              receiptId: "HOST-RECEIPT-RETRY",
            };
          },
          async reconcileMarkerMessage() {
            return null;
          },
        },
      });
      assert.equal(retried.created, true);
      assert.equal(
        journal.inspectInteractionWakeup("INTERACTION-REJECTED").dispatchCount,
        2,
      );
    });
  });

  it("recovers every crash window through two processes and one SQLite file without ambiguous redispatch", async () => {
    const cases = [
      {
        scenario: "after_prepare",
        candidateCount: 1,
        crashed: "prepared",
        recovered: "succeeded",
        dispatches: 1,
      },
      {
        scenario: "after_no_client_found",
        candidateCount: 1,
        crashed: "no_client_found",
        recovered: "succeeded",
        dispatches: 2,
      },
      {
        scenario: "after_dispatch_cas_before_send",
        candidateCount: 0,
        crashed: "dispatching",
        recovered: "quarantined",
        dispatches: 0,
      },
      {
        scenario: "unknown_response",
        candidateCount: 1,
        crashed: "dispatching",
        recovered: "succeeded",
        dispatches: 1,
      },
      {
        scenario: "success_before_cas",
        candidateCount: 1,
        crashed: "dispatching",
        recovered: "succeeded",
        dispatches: 1,
      },
      {
        scenario: "unknown_response",
        candidateCount: 0,
        crashed: "dispatching",
        recovered: "quarantined",
        dispatches: 1,
      },
      {
        scenario: "unknown_response",
        candidateCount: 2,
        crashed: "dispatching",
        recovered: "quarantined",
        dispatches: 1,
      },
    ] as const;
    const fixture = path.join(
      process.cwd(),
      "server/services/fixtures/codex-phase0-recovery-subprocess.mts",
    );

    for (const [index, testCase] of cases.entries()) {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "stagepass-phase0-subprocess-"),
      );
      try {
        const common = {
          scenario: testCase.scenario,
          databasePath: path.join(directory, "phase0.sqlite"),
          statePath: path.join(directory, "state.json"),
          candidatePath: path.join(directory, "candidates.json"),
          dispatchLogPath: path.join(directory, "dispatch.log"),
          candidateCount: testCase.candidateCount,
        };
        const configPath = path.join(directory, "config.json");
        await writeFile(configPath, JSON.stringify({
          ...common,
          action: "crash",
        }));
        const crashed = await execFileAsync(process.execPath, [
          "--import",
          "tsx",
          fixture,
          configPath,
        ]);
        assert.equal(
          JSON.parse(crashed.stdout).attemptState,
          testCase.crashed,
          `crash state ${index}`,
        );

        await writeFile(configPath, JSON.stringify({
          ...common,
          action: "recover",
        }));
        const recovered = await execFileAsync(process.execPath, [
          "--import",
          "tsx",
          fixture,
          configPath,
        ]);
        assert.equal(
          JSON.parse(recovered.stdout).attemptState,
          testCase.recovered,
          `recovery state ${index}`,
        );
        const dispatchLog = await readFile(common.dispatchLogPath, "utf8")
          .catch((error: NodeJS.ErrnoException) =>
            error.code === "ENOENT" ? "" : Promise.reject(error));
        assert.equal(
          dispatchLog.trim().split("\n").filter(Boolean).length,
          testCase.dispatches,
          `external dispatch count ${index}`,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});
