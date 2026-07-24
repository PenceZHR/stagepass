import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  changes,
  codexBindingRunLeases,
  codexLogicalTurns,
  codexThreadBindings,
  pipelineJobs,
  projects,
} from "../db/schema";
import {
  claimCodexBindingRunLease,
  readCodexBindingRunLease,
  releaseCodexBindingRunLease,
} from "./codex-binding-run-lease-service";

const PROJECT = "PRJ-TASK4-LEASE";
const CHANGE = "CHG-TASK4-LEASE";
const BINDING = "BIND-TASK4-LEASE";
const JOB = "JOB-TASK4-LEASE";
const TURN_A = "TURN-TASK4-LEASE-A";
const TURN_B = "TURN-TASK4-LEASE-B";
const NOW = "2026-07-24T00:00:00.000Z";

function cleanup() {
  db.delete(codexBindingRunLeases).where(eq(codexBindingRunLeases.bindingId, BINDING)).run();
  db.delete(codexLogicalTurns).where(eq(codexLogicalTurns.pipelineJobId, JOB)).run();
  db.delete(pipelineJobs).where(eq(pipelineJobs.id, JOB)).run();
  db.delete(codexThreadBindings).where(eq(codexThreadBindings.bindingId, BINDING)).run();
  db.delete(changes).where(eq(changes.id, CHANGE)).run();
  db.delete(projects).where(eq(projects.id, PROJECT)).run();
}

describe("codex binding run lease service", { concurrency: false }, () => {
  beforeEach(() => {
    cleanup();
    const future = new Date(Date.now() + 60_000).toISOString();
    db.insert(projects).values({
      id: PROJECT, name: PROJECT, repoPath: process.cwd(),
      contextStatus: "ready", contextProvider: "codex",
      prdStatus: "ready", prdProvider: "codex",
      prdJson: null, prdMarkdown: null, gitEnabled: 0,
      gitDefaultBranch: null, createdAt: NOW, updatedAt: NOW,
    }).run();
    db.insert(changes).values({
      id: CHANGE, projectId: PROJECT, title: CHANGE, status: "SPECCING",
      provider: "codex", codexThreadId: "thread-task4-lease", fixIterations: 0,
      blockedPhase: null, reworkFromPhase: null, suspendedByPrd: 0,
      preSuspendStatus: null, gitBranch: null, gateState: null,
      docsComplete: 0, retroDone: 0, createdAt: NOW, updatedAt: NOW,
    }).run();
    db.insert(codexThreadBindings).values({
      bindingId: BINDING, scopeKind: "change", scopeId: CHANGE,
      projectId: PROJECT, changeId: CHANGE, threadId: "thread-task4-lease",
      codexProjectId: null, title: CHANGE, status: "ready",
      bridgeProtocolVersion: "test", provisionClaimToken: null,
      provisionLeaseOwner: null, provisionLeaseExpiresAt: null,
      followerStartProvedAt: null, lastTurnId: null, lastObservationCursor: 0,
      lastSemanticSnapshotHash: null, lastSeenAt: NOW, lastErrorCode: null,
      createdAt: NOW, updatedAt: NOW,
    }).run();
    db.insert(pipelineJobs).values({
      id: JOB, changeId: CHANGE, phase: "spec", actionId: "run_spec",
      status: "running", leasedBy: "worker", leaseExpiresAt: future,
      heartbeatAt: NOW, attemptNo: 1, createdAt: NOW, startedAt: NOW,
      leaseToken: "lease", provider: "codex",
    }).run();
    for (const [id, ordinal] of [[TURN_A, 0], [TURN_B, 1]] as const) {
      db.insert(codexLogicalTurns).values({
        logicalTurnId: id, pipelineJobId: JOB, projectAiRunId: null,
        bindingId: BINDING, phase: "Spec", role: "stage", round: 0,
        ordinal, turnSlot: `${JOB}:Spec:stage:0:${ordinal}`,
        runCorrelationId: `corr-${ordinal}`,
        canonicalRequestJson: JSON.stringify({ request: { prompt: id } }),
        canonicalRequestHash: `hash-${ordinal}`, dispatchSurface: "follower_ipc",
        status: "pending", createdAt: NOW, updatedAt: NOW,
      }).run();
    }
  });
  afterEach(cleanup);

  it("serializes logical turns and releases only through its fence", () => {
    const deadlineAt = db.select().from(pipelineJobs)
      .where(eq(pipelineJobs.id, JOB)).get()!.leaseExpiresAt!;
    const first = claimCodexBindingRunLease({
      logicalTurnId: TURN_A, workerId: "worker",
      ownerLeaseToken: "lease", ownerAttempt: 1, ownerEpoch: 1,
      deadlineAt,
    });
    assert.equal(readCodexBindingRunLease(BINDING)?.logicalTurnId, TURN_A);
    assert.throws(
      () => claimCodexBindingRunLease({
        logicalTurnId: TURN_B, workerId: "worker",
        ownerLeaseToken: "lease", ownerAttempt: 1, ownerEpoch: 1,
        deadlineAt,
      }),
      (error: unknown) => (error as { code?: string }).code === "binding_run_lease_busy",
    );
    releaseCodexBindingRunLease(first);
    assert.equal(
      claimCodexBindingRunLease({
        logicalTurnId: TURN_B, workerId: "worker",
        ownerLeaseToken: "lease", ownerAttempt: 1, ownerEpoch: 1,
        deadlineAt,
      }).logicalTurnId,
      TURN_B,
    );
  });
});
