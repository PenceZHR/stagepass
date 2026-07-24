import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  changes, codexBindingRunLeases, codexFollowerStartAttempts,
  codexLogicalTurns, codexThreadBindings, codexTurnExecutions,
  pipelineJobs, projects,
} from "../db/schema";
import type { CodexDesktopBridge } from "./codex-desktop-bridge";
import { CodexDesktopEngine } from "./codex-desktop-engine";
import { recoverDesktopFollowerExecution } from "./recovery-executors";
import { startCodexTurnExecution } from "./codex-turn-lifecycle-service";

const P = "PRJ-TASK4-ENGINE", C = "CHG-TASK4-ENGINE", B = "BIND-TASK4-ENGINE";
const J = "JOB-TASK4-ENGINE", L = "TURN-TASK4-ENGINE", A = "ATTEMPT-TASK4-ENGINE";
const THREAD = "thread-task4-engine", TURN = "desktop-turn-task4-engine";
const NOW = "2026-07-24T00:00:00.000Z";
let deadline = "";

function cleanup() {
  db.delete(codexBindingRunLeases).where(eq(codexBindingRunLeases.bindingId, B)).run();
  db.delete(codexTurnExecutions).where(eq(codexTurnExecutions.logicalTurnId, L)).run();
  db.delete(codexFollowerStartAttempts).where(eq(codexFollowerStartAttempts.logicalTurnId, L)).run();
  db.delete(codexLogicalTurns).where(eq(codexLogicalTurns.logicalTurnId, L)).run();
  db.delete(pipelineJobs).where(eq(pipelineJobs.id, J)).run();
  db.delete(codexThreadBindings).where(eq(codexThreadBindings.bindingId, B)).run();
  db.delete(changes).where(eq(changes.id, C)).run();
  db.delete(projects).where(eq(projects.id, P)).run();
}

function logicalIdentity() {
  const canonicalRequestJson = JSON.stringify({
    commandId: null,
    interactionId: null,
    ordinal: 0,
    owner: { kind: "pipeline_job", pipelineJobId: J },
    phase: "Spec",
    request: { prompt: "write spec", sandboxMode: "read-only" },
    role: "stage",
    round: 0,
  });
  return {
    canonicalRequestJson,
    canonicalRequestHash: createHash("sha256").update(canonicalRequestJson).digest("hex"),
    runCorrelationId: `sp-${createHash("sha256").update(L).digest("base64url")}`,
  };
}

function insertSucceededAttempt() {
  const identity = logicalIdentity();
  db.insert(codexFollowerStartAttempts).values({
    attemptId: A, logicalTurnId: L, runCorrelationId: identity.runCorrelationId,
    pipelineJobId: J, projectAiRunId: null, workerId: "worker",
    leaseToken: "lease", ownerAttempt: 1, ownerEpoch: 1, threadId: THREAD,
    purpose: "stage_run", dispatchSurface: "follower_ipc",
    normalizedPromptHash: "hash", correlationMarker: "[marker]",
    cwd: process.cwd(), model: null, reasoningEffort: null,
    sandboxMode: "read-only", approvalPolicy: "never",
    preStartTurnIdsJson: "[]", preStartSemanticHash: "empty",
    state: "succeeded", dispatchOrdinal: 1, dispatchCount: 1,
    budgetDeadline: deadline, followerTurnId: TURN, recoveryOwnerId: null,
    recoveryLeaseToken: null, recoveryEpoch: 0, lastResult: "started",
    lastErrorCode: null, preparedAt: NOW, dispatchedAt: NOW, completedAt: NOW,
  }).run();
}

describe("codex desktop engine", { concurrency: false }, () => {
  beforeEach(() => {
    cleanup();
    deadline = new Date(Date.now() + 60_000).toISOString();
    db.insert(projects).values({
      id: P, name: P, repoPath: process.cwd(), contextStatus: "ready",
      contextProvider: "codex", prdStatus: "ready", prdProvider: "codex",
      prdJson: null, prdMarkdown: null, gitEnabled: 0, gitDefaultBranch: null,
      createdAt: NOW, updatedAt: NOW,
    }).run();
    db.insert(changes).values({
      id: C, projectId: P, title: C, status: "SPECCING", provider: "codex",
      codexThreadId: THREAD, fixIterations: 0, blockedPhase: null,
      reworkFromPhase: null, suspendedByPrd: 0, preSuspendStatus: null,
      gitBranch: null, gateState: null, docsComplete: 0, retroDone: 0,
      createdAt: NOW, updatedAt: NOW,
    }).run();
    db.insert(codexThreadBindings).values({
      bindingId: B, scopeKind: "change", scopeId: C, projectId: P, changeId: C,
      threadId: THREAD, codexProjectId: null, title: C, status: "ready",
      bridgeProtocolVersion: "test", provisionClaimToken: null,
      provisionLeaseOwner: null, provisionLeaseExpiresAt: null,
      followerStartProvedAt: null, lastTurnId: null, lastObservationCursor: 0,
      lastSemanticSnapshotHash: null, lastSeenAt: NOW, lastErrorCode: null,
      createdAt: NOW, updatedAt: NOW,
    }).run();
    db.insert(pipelineJobs).values({
      id: J, changeId: C, phase: "spec", actionId: "run_spec", status: "running",
      leasedBy: "worker", leaseExpiresAt: deadline, heartbeatAt: NOW,
      attemptNo: 1, createdAt: NOW, startedAt: NOW, leaseToken: "lease",
      provider: "codex",
    }).run();
    db.insert(codexLogicalTurns).values({
      ...logicalIdentity(),
      logicalTurnId: L, pipelineJobId: J, projectAiRunId: null, bindingId: B,
      phase: "Spec", role: "stage", round: 0, ordinal: 0,
      turnSlot: `pipeline_job:${J}:Spec:stage:0:0`, dispatchSurface: "follower_ipc",
      status: "pending", createdAt: NOW, updatedAt: NOW,
    }).run();
  });
  afterEach(cleanup);

  it("starts through follower bridge and observes a proved terminal snapshot", async () => {
    let starts = 0;
    let polls = 0;
    const bridge: CodexDesktopBridge = {
      probe: async () => { throw new Error("unused"); },
      ensurePersistentShell: async () => { throw new Error("unused"); },
      async startTurn() {
        starts += 1;
        insertSucceededAttempt();
        return { attemptId: A, turnId: TURN };
      },
      async recoverTurn() { throw new Error("unused"); },
      async interruptTurn() {},
      async *pollTurn() {
        polls += 1;
        yield {
          kind: "observation",
          cursor: 1,
          semanticSnapshotHash: "terminal-hash",
          snapshot: {
            threadId: THREAD, turnId: TURN, status: "completed",
            items: [
              { id: "message", kind: "agent_message", semantic: { text: "done" } },
              { id: "file", kind: "file_change", semantic: { path: "a.ts", change: "modified" } },
            ],
            terminal: { output: "done" },
            metadata: { observedAt: NOW },
          },
        };
      },
    };
    const result = await new CodexDesktopEngine(bridge).run({
      logicalTurnId: L,
    } as never);
    assert.equal(result.success, true);
    assert.equal(result.threadId, THREAD);
    assert.deepEqual(result.changedFiles, ["a.ts"]);
    assert.equal(starts, 1);
    assert.equal(polls, 1);
    assert.equal(db.select().from(codexBindingRunLeases)
      .where(eq(codexBindingRunLeases.bindingId, B)).get(), undefined);
  });

  it("rejects caller identity overrides before follower calls", async () => {
    let calls = 0;
    const bridge = {
      startTurn: async () => { calls += 1; throw new Error("must not run"); },
    } as unknown as CodexDesktopBridge;
    await assert.rejects(
      new CodexDesktopEngine(bridge).run({
        logicalTurnId: L,
        threadId: "caller-thread",
      } as never),
      (error: unknown) => (error as { code?: string }).code === "caller_identity_override",
    );
    assert.equal(calls, 0);
  });

  it("recovers follower lifecycle by app-server observation without a second start", async () => {
    insertSucceededAttempt();
    db.insert(codexBindingRunLeases).values({
      bindingId: B, logicalTurnId: L, attemptId: A, workerId: "worker",
      leaseToken: "binding-lease", ownerEpoch: 1,
      leaseExpiresAt: deadline, deadlineAt: deadline,
    }).run();
    startCodexTurnExecution({
      logicalTurnId: L, attemptId: A, threadId: THREAD, turnId: TURN,
    });
    let recoveryStarts = 0;
    const result = await recoverDesktopFollowerExecution({
      logicalTurnId: L,
      bridge: {
        async recoverTurn() {
          recoveryStarts += 1;
          throw new Error("must not start or adopt an already durable execution");
        },
        async *pollTurn() {
          yield {
            kind: "observation",
            cursor: 1,
            semanticSnapshotHash: "recovered-terminal",
            snapshot: {
              threadId: THREAD,
              turnId: TURN,
              status: "completed",
              items: [{ id: "message", kind: "agent_message", semantic: { text: "recovered" } }],
              terminal: { output: "recovered" },
              metadata: { observedAt: NOW },
            },
          };
        },
      },
    });
    assert.equal(result.kind, "recovered");
    assert.equal(recoveryStarts, 0);
  });
});
