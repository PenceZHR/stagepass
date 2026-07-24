import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CodexNativeRecoveryService,
  type CodexNativeRecoveryCandidate,
  type CodexNativeRecoveryDependencies,
} from "./codex-native-recovery-service";

const DEADLINE = "2026-07-24T12:30:00.000Z";
const NOW = new Date("2026-07-24T12:00:00.000Z");

function candidate(
  overrides: Partial<CodexNativeRecoveryCandidate> = {},
): CodexNativeRecoveryCandidate {
  return {
    attemptId: "ATTEMPT-1",
    logicalTurnId: "logical-build-r1",
    threadId: "canonical-shell",
    canonicalThreadId: "canonical-shell",
    state: "prepared",
    owner: { kind: "pipeline_job", id: "JOB-1" },
    workerId: "worker-old",
    leaseToken: "lease-old-expired",
    ownerAttempt: 1,
    ownerEpoch: 7,
    deadlineAt: DEADLINE,
    correlationMarker: "[stagepass-run:RUN-1:attempt:ATTEMPT-1]",
    normalizedPromptHash: "prompt-hash",
    preStartSemanticHash: "baseline-hash",
    dispatchOrdinal: 2,
    turnId: null,
    ...overrides,
  };
}

function fixture(initial: CodexNativeRecoveryCandidate) {
  let row = { ...initial };
  const calls = {
    acquire: 0,
    safeClaim: 0,
    dispatch: 0,
    reconcile: 0,
    resume: 0,
    quarantine: [] as string[],
    diagnostics: [] as string[],
  };
  const dependencies: CodexNativeRecoveryDependencies = {
    listCandidates: async () => [row.attemptId],
    readCandidate: async (attemptId) =>
      attemptId === row.attemptId ? { ...row } : null,
    acquireOwnerLease: async () => {
      calls.acquire += 1;
      return {
        workerId: "worker-new",
        leaseToken: "lease-new",
        ownerAttempt: 2,
        ownerEpoch: 8,
        leaseExpiresAt: DEADLINE,
      };
    },
    claimSafeAttempt: async ({ candidate: before, lease }) => {
      calls.safeClaim += 1;
      assert.equal(before.attemptId, initial.attemptId);
      assert.equal(before.logicalTurnId, initial.logicalTurnId);
      assert.equal(before.correlationMarker, initial.correlationMarker);
      assert.equal(before.normalizedPromptHash, initial.normalizedPromptHash);
      assert.equal(before.preStartSemanticHash, initial.preStartSemanticHash);
      assert.equal(before.dispatchOrdinal, initial.dispatchOrdinal);
      assert.equal(lease.ownerEpoch, before.ownerEpoch + 1);
      row = {
        ...row,
        workerId: lease.workerId,
        leaseToken: lease.leaseToken,
        ownerAttempt: lease.ownerAttempt,
        ownerEpoch: lease.ownerEpoch,
      };
      return true;
    },
    dispatchSafeAttempt: async () => {
      calls.dispatch += 1;
      return { action: "succeeded", turnId: "TURN-1" };
    },
    reconcileAmbiguous: async () => {
      calls.reconcile += 1;
      return { action: "not_visible" };
    },
    resumeSucceededTurn: async () => {
      calls.resume += 1;
      return { action: "running" };
    },
    quarantine: async ({ reason }) => {
      calls.quarantine.push(reason);
      row = { ...row, state: "quarantined" };
    },
    emitDiagnostic: ({ code }) => {
      calls.diagnostics.push(code);
    },
    now: () => NOW,
  };
  return {
    service: new CodexNativeRecoveryService(dependencies),
    calls,
    setRow(next: CodexNativeRecoveryCandidate) {
      row = next;
    },
  };
}

describe("codex-native-recovery-service", () => {
  it("quarantines a noncanonical execution before owner or external calls", async () => {
    const test = fixture(candidate({
      threadId: "legacy-build-shell",
    }));

    const result = await test.service.recoverAttempt("ATTEMPT-1");

    assert.equal(result.action, "quarantined");
    assert.equal(result.reason, "noncanonical_thread_override");
    assert.equal(test.calls.acquire, 0);
    assert.equal(test.calls.dispatch, 0);
    assert.equal(test.calls.reconcile, 0);
    assert.deepEqual(test.calls.diagnostics, ["noncanonical_thread_override"]);
  });

  it("claims a prepared attempt through the real owner lease and dispatches the same identity", async () => {
    const test = fixture(candidate());

    const result = await test.service.recoverAttempt("ATTEMPT-1");

    assert.equal(result.action, "handoff_same_attempt");
    assert.equal(result.turnId, "TURN-1");
    assert.equal(test.calls.acquire, 1);
    assert.equal(test.calls.safeClaim, 1);
    assert.equal(test.calls.dispatch, 1);
    assert.equal(test.calls.reconcile, 0);
  });

  it("quarantines expired prepared work without dispatch", async () => {
    const test = fixture(candidate({
      deadlineAt: "2026-07-24T11:59:59.000Z",
    }));

    const result = await test.service.recoverAttempt("ATTEMPT-1");

    assert.equal(result.action, "quarantined");
    assert.equal(result.reason, "safe_attempt_deadline_expired");
    assert.equal(test.calls.safeClaim, 0);
    assert.equal(test.calls.dispatch, 0);
  });

  it("reconciles dispatching work read-only and never redispatches visibility lag", async () => {
    const test = fixture(candidate({ state: "dispatching" }));

    const result = await test.service.recoverAttempt("ATTEMPT-1");

    assert.equal(result.action, "turn_not_yet_visible");
    assert.equal(test.calls.reconcile, 1);
    assert.equal(test.calls.dispatch, 0);
    assert.equal(test.calls.safeClaim, 0);
  });

  it("resumes a known succeeded turn without preparing or starting another", async () => {
    const test = fixture(candidate({
      state: "succeeded",
      turnId: "TURN-DURABLE",
    }));

    const result = await test.service.recoverAttempt("ATTEMPT-1");

    assert.equal(result.action, "resumed_snapshot_poll");
    assert.equal(result.turnId, "TURN-DURABLE");
    assert.equal(test.calls.resume, 1);
    assert.equal(test.calls.dispatch, 0);
    assert.equal(test.calls.safeClaim, 0);
  });

  it("re-reads the canonical binding immediately before external dispatch", async () => {
    const test = fixture(candidate());
    const original = candidate();
    let reads = 0;
    const service = new CodexNativeRecoveryService({
      listCandidates: async () => [original.attemptId],
      readCandidate: async () => {
        reads += 1;
        return {
          ...original,
          ...(reads >= 3 ? { canonicalThreadId: "replacement-shell" } : {}),
        };
      },
      acquireOwnerLease: async () => ({
        workerId: "worker-new",
        leaseToken: "lease-new",
        ownerAttempt: 2,
        ownerEpoch: 8,
        leaseExpiresAt: DEADLINE,
      }),
      claimSafeAttempt: async () => true,
      dispatchSafeAttempt: async () => {
        assert.fail("noncanonical work must not reach Desktop");
      },
      reconcileAmbiguous: async () => {
        assert.fail("unexpected reconcile");
      },
      resumeSucceededTurn: async () => {
        assert.fail("unexpected resume");
      },
      quarantine: async ({ reason }) => {
        test.calls.quarantine.push(reason);
      },
      emitDiagnostic: ({ code }) => {
        test.calls.diagnostics.push(code);
      },
      now: () => NOW,
    });

    const result = await service.recoverAttempt(original.attemptId);

    assert.equal(result.action, "quarantined");
    assert.deepEqual(test.calls.quarantine, ["noncanonical_thread_override"]);
    assert.equal(reads, 3);
  });
});
