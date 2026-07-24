import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  changes, codexFollowerStartAttempts, codexLogicalTurns, codexThreadBindings,
  codexBindingRunLeases, codexTurnExecutions, pipelineJobs, projects,
} from "../db/schema";
import {
  recordCodexTurnSnapshot,
  startCodexTurnExecution,
} from "./codex-turn-lifecycle-service";

const P = "PRJ-TASK4-LIFE", C = "CHG-TASK4-LIFE", B = "BIND-TASK4-LIFE";
const J = "JOB-TASK4-LIFE", L = "TURN-TASK4-LIFE", A = "ATTEMPT-TASK4-LIFE";
const THREAD = "thread-task4-life", TURN = "desktop-turn-task4-life";
const NOW = "2026-07-24T00:00:00.000Z";

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

describe("codex turn lifecycle service", { concurrency: false }, () => {
  beforeEach(() => {
    cleanup();
    const deadline = new Date(Date.now() + 60_000).toISOString();
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
      followerStartProvedAt: NOW, lastTurnId: TURN, lastObservationCursor: 0,
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
      logicalTurnId: L, pipelineJobId: J, projectAiRunId: null, bindingId: B,
      phase: "Spec", role: "stage", round: 0, ordinal: 0,
      turnSlot: "slot-task4-life", runCorrelationId: "corr-task4-life",
      canonicalRequestJson: "{}", canonicalRequestHash: "hash",
      dispatchSurface: "follower_ipc", status: "pending",
      createdAt: NOW, updatedAt: NOW,
    }).run();
    db.insert(codexFollowerStartAttempts).values({
      attemptId: A, logicalTurnId: L, runCorrelationId: "corr-task4-life",
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
    db.insert(codexBindingRunLeases).values({
      bindingId: B, logicalTurnId: L, attemptId: A, workerId: "worker",
      leaseToken: "binding-lease", ownerEpoch: 1,
      leaseExpiresAt: deadline, deadlineAt: deadline,
    }).run();
  });
  afterEach(cleanup);

  it("deduplicates semantic snapshots and freezes terminal state", () => {
    startCodexTurnExecution({
      logicalTurnId: L, attemptId: A, threadId: THREAD, turnId: TURN,
    });
    const snapshot = {
      threadId: THREAD, turnId: TURN, status: "completed" as const,
      items: [{ id: "item-1", kind: "agent_message" as const, semantic: { text: "done" } }],
      terminal: { output: "done" }, metadata: { observedAt: NOW },
    };
    assert.equal(recordCodexTurnSnapshot({
      logicalTurnId: L, snapshot, cursor: 1, semanticHash: "terminal-hash",
    }).changed, true);
    assert.equal(recordCodexTurnSnapshot({
      logicalTurnId: L, snapshot, cursor: 2, semanticHash: "terminal-hash",
    }).changed, false);
    assert.throws(() => recordCodexTurnSnapshot({
      logicalTurnId: L, snapshot: { ...snapshot, terminal: { output: "drift" } },
      cursor: 3, semanticHash: "drift-hash",
    }), (error: unknown) =>
      (error as { code?: string }).code === "terminal_snapshot_immutable");
  });
});
