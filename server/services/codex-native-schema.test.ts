import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CodexBindingScopeSchema,
  CodexLogicalTurnOwnerSchema,
  CodexLogicalTurnSchema,
  CodexFollowerStartAttemptSchema,
  CodexTurnExecutionSchema,
  isLiveProjectAiRunLease,
  parsePipelineJobEffect,
} from "../types/models";
import {
  DispatchSurfaceSchema,
  STAGEPASS_DISPATCH_SURFACE_BY_ROLE,
} from "../types/enums";

describe("Codex native durable schema", () => {
  it("closes binding scope and logical owner unions", () => {
    assert.equal(CodexBindingScopeSchema.safeParse({
      scopeKind: "change", scopeId: "CHG-1", projectId: "PRJ-1", changeId: "CHG-1",
    }).success, true);
    assert.equal(CodexBindingScopeSchema.safeParse({
      scopeKind: "project_prd", scopeId: "PRJ-1", projectId: "PRJ-1", changeId: "CHG-1",
    }).success, false);
    assert.equal(CodexLogicalTurnOwnerSchema.safeParse({
      pipelineJobId: "JOB-1", projectAiRunId: "RUN-1",
    }).success, false);
  });

  it("uses one exhaustive role dispatch registry", () => {
    assert.equal(DispatchSurfaceSchema.parse(STAGEPASS_DISPATCH_SURFACE_BY_ROLE.interaction_wakeup), "host_ui_message");
    for (const [role, surface] of Object.entries(STAGEPASS_DISPATCH_SURFACE_BY_ROLE)) {
      assert.equal(
        surface,
        role === "interaction_wakeup" ? "host_ui_message" : "follower_ipc",
      );
    }
  });

  it("rejects unknown dispatch surfaces in logical, attempt, and execution rows", () => {
    const logicalTurnId = "00000000-0000-4000-8000-000000000001";
    const owner = { pipelineJobId: "JOB-1", projectAiRunId: null };
    const logical = {
      ...owner,
      logicalTurnId,
      bindingId: "B-1",
      interactionId: null,
      commandId: null,
      phase: "Spec",
      role: "stage",
      round: 0,
      ordinal: 0,
      turnSlot: "slot",
      runCorrelationId: "corr",
      canonicalRequestJson: "{}",
      canonicalRequestHash: "hash",
      dispatchSurface: "unknown",
      status: "ready",
      createdAt: "t",
      updatedAt: "t",
    };
    const attempt = {
      ...owner,
      attemptId: "ATT-1",
      logicalTurnId,
      runCorrelationId: "corr",
      workerId: "worker",
      leaseToken: "token",
      ownerAttempt: 1,
      ownerEpoch: 1,
      threadId: "THREAD-1",
      purpose: "test",
      dispatchSurface: "unknown",
      normalizedPromptHash: "hash",
      correlationMarker: "marker",
      cwd: "/tmp",
      model: null,
      reasoningEffort: null,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      preStartTurnIdsJson: "[]",
      preStartSemanticHash: "base",
      state: "prepared",
      dispatchOrdinal: 0,
      dispatchCount: 0,
      budgetDeadline: "z",
      followerTurnId: null,
      recoveryOwnerId: null,
      recoveryLeaseToken: null,
      recoveryEpoch: 0,
      lastResult: null,
      lastErrorCode: null,
      preparedAt: "t",
      dispatchedAt: null,
      completedAt: null,
    };
    const execution = {
      ...owner,
      id: "EX-1",
      startAttemptId: "ATT-1",
      logicalTurnId,
      threadId: "THREAD-1",
      turnId: "TURN-1",
      dispatchSurface: "unknown",
      leaseToken: "token",
      ownerAttempt: 1,
      ownerEpoch: 1,
      lastObservationCursor: 0,
      normalizedItemsJson: "[]",
      lastSemanticSnapshotHash: null,
      status: "running",
      lastObservedAt: null,
      terminalSemanticHash: null,
      reconnectCount: 0,
      notYetVisibleCount: 0,
      createdAt: "t",
      updatedAt: "t",
    };
    assert.equal(CodexLogicalTurnSchema.safeParse(logical).success, false);
    assert.equal(CodexFollowerStartAttemptSchema.safeParse(attempt).success, false);
    assert.equal(CodexTurnExecutionSchema.safeParse(execution).success, false);
  });

  it("requires an unexpired matching project owner lease and deadline", () => {
    const run = {
      status: "running",
      workerId: "worker",
      leaseToken: "token",
      leaseExpiresAt: "2026-07-24T00:02:00.000Z",
      deadlineAt: "2026-07-24T00:03:00.000Z",
    };
    assert.equal(isLiveProjectAiRunLease(run, "2026-07-24T00:01:00.000Z", {
      workerId: "worker", leaseToken: "token",
    }), true);
    assert.equal(isLiveProjectAiRunLease(
      { ...run, status: "succeeded" },
      "2026-07-24T00:01:00.000Z",
    ), false);
    assert.equal(isLiveProjectAiRunLease(
      { ...run, leaseExpiresAt: "2026-07-24T00:00:00.000Z" },
      "2026-07-24T00:01:00.000Z",
    ), false);
  });

  it("rejects job kind/payload/identity mismatches before dispatch", () => {
    assert.deepEqual(parsePipelineJobEffect({
      jobKind: "interaction_present",
      interactionId: "INT-1",
      commandId: null,
      effectSchemaVersion: "stagepass.pipeline-effect/v1",
      effectPayloadJson: JSON.stringify({
        schemaVersion: "stagepass.pipeline-effect/v1",
        kind: "interaction_present",
        interactionId: "INT-1",
      }),
    }), {
      schemaVersion: "stagepass.pipeline-effect/v1",
      kind: "interaction_present",
      interactionId: "INT-1",
    });
    assert.throws(() => parsePipelineJobEffect({
      jobKind: "interaction_wakeup",
      interactionId: "INT-1",
      commandId: "CMD-1",
      effectSchemaVersion: "stagepass.pipeline-effect/v1",
      effectPayloadJson: JSON.stringify({
        schemaVersion: "stagepass.pipeline-effect/v1",
        kind: "interaction_present",
        interactionId: "INT-1",
      }),
    }), /identity_mismatch/);
  });
});
