import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  changes,
  codexBindingRunLeases,
  codexFollowerStartAttempts,
  codexLogicalTurns,
  codexThreadBindings,
  pipelineJobs,
  projects,
} from "../db/schema";
import type { CodexLogicalTurnStartContext } from "./codex-desktop-bridge-types";
import { createCodexFollowerStartAttemptPort } from "./codex-follower-start-attempt-service";

const ids = {
  project: "PRJ-TASK4-ATTEMPT",
  change: "CHG-TASK4-ATTEMPT",
  binding: "BIND-TASK4-ATTEMPT",
  job: "JOB-TASK4-ATTEMPT",
  logical: "TURN-TASK4-ATTEMPT",
  thread: "thread-task4-attempt",
};
const NOW = "2026-07-24T00:00:00.000Z";
let deadlineAt = "";

function cleanup() {
  db.delete(codexBindingRunLeases)
    .where(eq(codexBindingRunLeases.bindingId, ids.binding)).run();
  db.delete(codexFollowerStartAttempts)
    .where(eq(codexFollowerStartAttempts.logicalTurnId, ids.logical)).run();
  db.delete(codexLogicalTurns)
    .where(eq(codexLogicalTurns.logicalTurnId, ids.logical)).run();
  db.delete(pipelineJobs).where(eq(pipelineJobs.id, ids.job)).run();
  db.delete(codexThreadBindings).where(eq(codexThreadBindings.bindingId, ids.binding)).run();
  db.delete(changes).where(eq(changes.id, ids.change)).run();
  db.delete(projects).where(eq(projects.id, ids.project)).run();
}

function context(): CodexLogicalTurnStartContext {
  return {
    logicalTurnId: ids.logical,
    owner: { kind: "pipeline_job", pipelineJobId: ids.job },
    projectId: ids.project,
    scopeKind: "change",
    scopeId: ids.change,
    phase: "Spec",
    role: "stage",
    round: 0,
    ordinal: 0,
    turnSlot: "slot",
    runCorrelationId: "run-correlation",
    dispatchSurface: "follower_ipc",
    request: {
      threadId: ids.thread,
      cwd: process.cwd(),
      prompt: "write spec",
      approvalPolicy: "never",
      sandboxMode: "read-only",
    },
    fence: {
      logicalTurnId: ids.logical,
      owner: { kind: "pipeline_job", pipelineJobId: ids.job },
      projectId: ids.project,
      scopeKind: "change",
      scopeId: ids.change,
      workerId: "worker",
      leaseToken: "lease",
      ownerAttempt: 1,
      ownerEpoch: 1,
      dispatchSurface: "follower_ipc",
      purpose: "stage_run",
      deadlineAt,
      leaseExpiresAt: deadlineAt,
    },
  };
}

describe("codex follower start attempt service", { concurrency: false }, () => {
  beforeEach(() => {
    cleanup();
    deadlineAt = new Date(Date.now() + 60_000).toISOString();
    db.insert(projects).values({
      id: ids.project, name: ids.project, repoPath: process.cwd(),
      contextStatus: "ready", contextProvider: "codex", prdStatus: "ready",
      prdProvider: "codex", prdJson: null, prdMarkdown: null, gitEnabled: 0,
      gitDefaultBranch: null, createdAt: NOW, updatedAt: NOW,
    }).run();
    db.insert(changes).values({
      id: ids.change, projectId: ids.project, title: ids.change,
      status: "SPECCING", provider: "codex", codexThreadId: ids.thread,
      fixIterations: 0, blockedPhase: null, reworkFromPhase: null,
      suspendedByPrd: 0, preSuspendStatus: null, gitBranch: null,
      gateState: null, docsComplete: 0, retroDone: 0,
      createdAt: NOW, updatedAt: NOW,
    }).run();
    db.insert(codexThreadBindings).values({
      bindingId: ids.binding, scopeKind: "change", scopeId: ids.change,
      projectId: ids.project, changeId: ids.change, threadId: ids.thread,
      codexProjectId: null, title: ids.change, status: "ready",
      bridgeProtocolVersion: "test", provisionClaimToken: null,
      provisionLeaseOwner: null, provisionLeaseExpiresAt: null,
      followerStartProvedAt: null, lastTurnId: null, lastObservationCursor: 0,
      lastSemanticSnapshotHash: null, lastSeenAt: NOW, lastErrorCode: null,
      createdAt: NOW, updatedAt: NOW,
    }).run();
    db.insert(pipelineJobs).values({
      id: ids.job, changeId: ids.change, phase: "spec", actionId: "run_spec",
      status: "running", leasedBy: "worker", leaseExpiresAt: deadlineAt,
      heartbeatAt: NOW, attemptNo: 1, createdAt: NOW, startedAt: NOW,
      leaseToken: "lease", provider: "codex",
    }).run();
    db.insert(codexLogicalTurns).values({
      logicalTurnId: ids.logical, pipelineJobId: ids.job, projectAiRunId: null,
      bindingId: ids.binding, phase: "Spec", role: "stage", round: 0,
      ordinal: 0, turnSlot: "slot-task4-attempt",
      runCorrelationId: "run-correlation",
      canonicalRequestJson: JSON.stringify({ request: { prompt: "write spec" } }),
      canonicalRequestHash: "hash", dispatchSurface: "follower_ipc",
      status: "pending", createdAt: NOW, updatedAt: NOW,
    }).run();
    db.insert(codexBindingRunLeases).values({
      bindingId: ids.binding, logicalTurnId: ids.logical, attemptId: null,
      workerId: "worker", leaseToken: "binding-lease", ownerEpoch: 1,
      leaseExpiresAt: deadlineAt, deadlineAt,
    }).run();
  });
  afterEach(cleanup);

  it("persists prepared baseline and settles one dispatch success", async () => {
    const port = createCodexFollowerStartAttemptPort(
      { readForStart: async () => context() },
      {
        readThreadWithTurns: async () => ({
          shell: { threadId: ids.thread, title: ids.change, cwd: process.cwd(), ephemeral: false },
          turns: [],
        }),
      },
    );
    const prepared = await port.prepare({
      attemptId: "ATTEMPT-TASK4",
      logicalTurnId: ids.logical,
    });
    assert.match(prepared.requestWithMarker.prompt, /stagepass-run/);
    const ordinal = await port.claimDispatch({
      attemptId: prepared.attemptId,
      fence: prepared.fence,
    });
    await port.recordSuccess({
      attemptId: prepared.attemptId,
      dispatchOrdinal: ordinal,
      turnId: "desktop-turn-task4",
      fence: prepared.fence,
    });
    const settled = await port.inspect(prepared.attemptId);
    assert.equal(settled?.state, "succeeded");
    assert.equal(settled?.turnId, "desktop-turn-task4");
    assert.equal(
      db.select().from(codexFollowerStartAttempts)
        .where(eq(codexFollowerStartAttempts.logicalTurnId, ids.logical)).all().length,
      1,
    );
  });
});
