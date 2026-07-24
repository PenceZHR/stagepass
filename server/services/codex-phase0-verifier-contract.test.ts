import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertStartAttemptEvidenceMatchesJournal,
  assertExactCompletedOutput,
  parseBootstrapReadyCrashChildEvidence,
  parseRealCrashChildEvidence,
  reconcileConsumedRestartCompletion,
  reconcileRestartCheckpointEvidence,
  upsertStartAttemptEvidence,
  validateRealCrashRecoveryBranch,
  validatePhase0ReportEnvelope,
  type Phase0StartAttemptEvidence,
} from "./codex-phase0-verifier-contract.ts";
import type {
  CodexFollowerStartAttempt,
  CodexTurnSnapshot,
} from "./codex-desktop-bridge-types.ts";

function terminal(output: string): CodexTurnSnapshot {
  return {
    threadId: "THREAD-1",
    turnId: "TURN-1",
    status: "completed",
    items: [],
    terminal: { output },
    metadata: { observedAt: "2026-07-23T12:00:00.000Z" },
  };
}

describe("Codex Phase 0 verifier executable contracts", () => {
  it("accepts only a byte-exact completed terminal output", () => {
    assert.doesNotThrow(() =>
      assertExactCompletedOutput(
        terminal("PHASE0_RESTART_RESUME_OK."),
        "PHASE0_RESTART_RESUME_OK.",
      ));
    for (const snapshot of [
      terminal(" PHASE0_RESTART_RESUME_OK."),
      terminal("PHASE0_RESTART_RESUME_OK.\n"),
      terminal("PHASE0_RESTART_RESUME_WRONG."),
      { ...terminal("PHASE0_RESTART_RESUME_OK."), status: "inProgress" as const },
      {
        ...terminal("PHASE0_RESTART_RESUME_OK."),
        status: "failed" as const,
        terminal: {
          output: "PHASE0_RESTART_RESUME_OK.",
          errorCode: "failed",
        },
      },
    ]) {
      assert.throws(
        () =>
          assertExactCompletedOutput(
            snapshot,
            "PHASE0_RESTART_RESUME_OK.",
          ),
        /exact completed output/,
      );
    }
  });

  it("validates the report envelope before nested fields are accessed", () => {
    const strictEvidence = {
      real_shell_materialization: {
        source: "real_client_verifier",
        satisfied: true,
        version: 1,
        facts: ["materialized by the real client"],
      },
    };
    const valid = {
      phase: "phase0",
      schemaVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      registrationName:
        "stagepass-phase0-00000000-0000-4000-8000-000000000001",
      status: "BLOCKED",
      startedAt: "2026-07-23T12:00:00.000Z",
      checks: [{ name: "check-a", requiredEvidence: "evidence-a", status: "passed" }],
      actualStartAttempts: [],
      startAttemptEvidence: [],
      shellIds: [],
      followerTurnIds: [],
      deepLinkUrls: [],
      provisioningActivationUrls: [],
      followerDispatchEvidence: [],
      failureCodes: [],
      evidenceNotes: [],
      protocol: {},
      capabilities: {},
      securityBoundary: {},
      strictEvidence,
      turnReadEvidence: {},
      appServerMethodCounts: {},
      desktopMethodCounts: {},
    };
    assert.doesNotThrow(() =>
      validatePhase0ReportEnvelope(valid, {
        runId: valid.runId,
        registrationName: valid.registrationName,
        checks: [{ name: "check-a", requiredEvidence: "evidence-a" }],
      }));
    for (const invalid of [
      null,
      {},
      { ...valid, phase: "phase1" },
      { ...valid, schemaVersion: 0 },
      { ...valid, checks: "not-an-array" },
      { ...valid, checks: [{ name: "wrong" }] },
      {
        ...valid,
        checks: [{
          name: "check-a",
          requiredEvidence: "wrong",
          status: "passed",
        }],
      },
      {
        ...valid,
        startAttemptEvidence: [{ attemptId: "INCOMPLETE" }],
      },
    ]) {
      assert.throws(
        () =>
          validatePhase0ReportEnvelope(invalid, {
            runId: valid.runId,
            registrationName: valid.registrationName,
            checks: [{ name: "check-a", requiredEvidence: "evidence-a" }],
          }),
        /report schema/,
      );
    }
  });

  it("validates strict evidence as a closed versioned discriminated union", () => {
    const valid = {
      phase: "phase0",
      schemaVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      registrationName:
        "stagepass-phase0-00000000-0000-4000-8000-000000000001",
      status: "BLOCKED",
      startedAt: "2026-07-23T12:00:00.000Z",
      checks: [{
        name: "check-a",
        requiredEvidence: "real_shell_materialization",
        status: "passed",
      }],
      actualStartAttempts: [],
      startAttemptEvidence: [],
      shellIds: [],
      followerTurnIds: [],
      deepLinkUrls: [],
      provisioningActivationUrls: [],
      followerDispatchEvidence: [],
      failureCodes: [],
      evidenceNotes: [],
      protocol: {},
      capabilities: {},
      securityBoundary: {},
      strictEvidence: {
        real_shell_materialization: {
          source: "real_client_verifier",
          satisfied: true,
          version: 1,
          facts: ["materialized by the real client"],
        },
      },
      turnReadEvidence: {},
      appServerMethodCounts: {},
      desktopMethodCounts: {},
    };
    const expected = {
      runId: valid.runId,
      registrationName: valid.registrationName,
      checks: [{
        name: "check-a",
        requiredEvidence: "real_shell_materialization",
      }],
    };
    assert.doesNotThrow(() =>
      validatePhase0ReportEnvelope(valid, expected));
    for (const kind of [
      "real_shell_materialization",
      "real_cross_process_failpoints",
      "real_visibility_lag",
      "real_snapshot_replay",
      "real_auth_negative_matrix",
      "real_durable_click",
    ]) {
      assert.doesNotThrow(() =>
        validatePhase0ReportEnvelope({
          ...valid,
          strictEvidence: {
            [kind]: {
              source: "real_client_verifier",
              satisfied: true,
              version: 1,
              facts: [`real-client fact for ${kind}`],
            },
          },
        }, expected));
    }

    const invalidStrictEvidence = [
      {
        real_shell_materialization: {
          source: "real_client_verifier",
          satisfied: true,
          facts: ["legacy record without a version"],
        },
      },
      {
        unknown_evidence_kind: {
          source: "real_client_verifier",
          satisfied: true,
          version: 1,
          facts: ["unknown kinds must fail closed"],
        },
      },
      {
        real_shell_materialization: {
          source: "unit_test",
          satisfied: true,
          version: 1,
          facts: ["wrong source"],
        },
      },
      {
        real_shell_materialization: {
          source: "real_client_verifier",
          satisfied: false,
          version: 1,
          facts: ["not satisfied"],
        },
      },
      {
        real_shell_materialization: {
          source: "real_client_verifier",
          satisfied: true,
          version: 2,
          facts: ["unknown version"],
        },
      },
      {
        real_shell_materialization: {
          source: "real_client_verifier",
          satisfied: true,
          version: 1,
          facts: [],
        },
      },
      {
        real_shell_materialization: {
          source: "real_client_verifier",
          satisfied: true,
          version: 1,
          facts: [""],
        },
      },
      {
        real_shell_materialization: {
          source: "real_client_verifier",
          satisfied: true,
          version: 1,
          facts: [42],
        },
      },
      {
        real_shell_materialization: {
          source: "real_client_verifier",
          satisfied: true,
          version: 1,
          facts: ["valid fact"],
          unexpected: true,
        },
      },
    ];
    for (const strictEvidence of invalidStrictEvidence) {
      assert.throws(
        () =>
          validatePhase0ReportEnvelope(
            { ...valid, strictEvidence },
            expected,
          ),
        /report schema/,
      );
    }
  });

  it("parses complete bootstrap child method evidence", () => {
    const evidence = {
      provisionId: "PROVISION-1",
      candidateThreadId: "THREAD-1",
      creatorBaselineTurnIds: [],
      creatorBaselineSemanticHash: "EMPTY-HASH",
      fence: {
        ownerId: "OWNER-1",
        leaseToken: "LEASE-1",
        leaseExpiresAt: "2026-07-23T12:05:00.000Z",
      },
      childAppServerMethodCounts: {
        "thread/start": 1,
        "turn/start": 0,
      },
      childThreadStartCount: 1,
    };
    assert.deepEqual(
      parseBootstrapReadyCrashChildEvidence(
        `diagnostic\n${JSON.stringify(evidence)}\n`,
        "EMPTY-HASH",
      ),
      evidence,
    );
    assert.throws(
      () =>
        parseBootstrapReadyCrashChildEvidence(
          `${JSON.stringify({
            ...evidence,
            creatorBaselineSemanticHash: "",
          })}\n`,
          "EMPTY-HASH",
        ),
      /bootstrap child evidence/,
    );
  });

  it("parses complete real crash-child durable attempt evidence", () => {
    const evidence = {
      window: "success_before_cas",
      checkpointTag: "bridge:success_before_cas",
      writeCommitted: true,
      logicalTurnId: "LOGICAL-1",
      attemptId: "ATTEMPT-1",
      state: "dispatching",
      dispatchOrdinal: 1,
      preStartTurnIds: ["TURN-BASELINE"],
      preStartSemanticHash: "BASELINE-HASH",
      normalizedPromptHash: "PROMPT-HASH",
      correlationMarker: "[stagepass-run:run:attempt:ATTEMPT-1]",
      turnId: null,
      childAppServerMethodCounts: {
        "thread/read": 1,
        "turn/start": 0,
      },
    };
    assert.deepEqual(
      parseRealCrashChildEvidence(`${JSON.stringify(evidence)}\n`),
      evidence,
    );
    assert.throws(
      () =>
        parseRealCrashChildEvidence(JSON.stringify({
          ...evidence,
          preStartSemanticHash: "",
        })),
      /real crash child evidence/,
    );
    assert.throws(
      () =>
        parseRealCrashChildEvidence(JSON.stringify({
          ...evidence,
          checkpointTag: "",
        })),
      /real crash child evidence/,
    );
    assert.throws(
      () =>
        parseRealCrashChildEvidence(JSON.stringify({
          ...evidence,
          window: "after_ipc_write_before_response",
          checkpointTag: "follower:before_write",
          writeCommitted: false,
        })),
      /real crash child evidence/,
    );
  });

  it("rebuilds JSON restart evidence from SQLite and rejects mismatches", () => {
    const checkpoint = {
      runId: "RUN-1",
      state: "awaiting_resume" as const,
      logicalTurnId: "LOGICAL-1",
      attemptId: "ATTEMPT-1",
      correlationMarker: "MARKER-1",
      normalizedPromptHash: "PROMPT-HASH",
      preStartTurnIds: ["TURN-0"],
      preStartSemanticHash: "BASELINE-HASH",
      dispatchOrdinal: 1,
      turnId: "TURN-1",
      shellThreadId: "THREAD-1",
      desktopPid: 101,
      processStartedAt: "2026-07-23T11:59:00.000Z",
      socketPath: "/tmp/codex.sock",
      socketDevice: 11,
      socketInode: 12,
      observationCursor: 3,
      lastSnapshotHash: "SNAPSHOT-HASH",
      lastNormalizedSnapshot: terminal(
        "PHASE0_RESTART_CHECKPOINT_READY.",
      ),
      resumedLogicalTurnId: null,
      resumedAttemptId: null,
      resumedCorrelationMarker: null,
      resumedNormalizedPromptHash: null,
      resumedPreStartSemanticHash: null,
      resumedShellThreadId: null,
      resumedDispatchOrdinal: null,
      resumedTurnId: null,
      consumedAt: null,
    };
    checkpoint.lastNormalizedSnapshot.threadId = "THREAD-1";
    checkpoint.lastNormalizedSnapshot.turnId = "TURN-1";
    const rebuilt = reconcileRestartCheckpointEvidence(undefined, checkpoint);
    assert.equal(rebuilt.attemptId, "ATTEMPT-1");
    assert.deepEqual(
      reconcileRestartCheckpointEvidence(rebuilt, checkpoint),
      rebuilt,
    );
    assert.throws(
      () =>
        reconcileRestartCheckpointEvidence(
          { ...rebuilt, correlationMarker: "DRIFT" },
          checkpoint,
        ),
      /restart checkpoint mismatch/,
    );
  });

  it("rebuilds consumed restart completion only from an exact durable resume", () => {
    const resumedAttempt: CodexFollowerStartAttempt = {
      attemptId: "ATTEMPT-RESUMED",
      logicalTurnId: "LOGICAL-RESUMED",
      request: {
        threadId: "THREAD-1",
        cwd: "/repo",
        prompt: "Reply exactly PHASE0_RESTART_RESUME_OK.",
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      fence: {
        logicalTurnId: "LOGICAL-RESUMED",
        owner: {
          kind: "project_ai_run",
          projectAiRunId: "OWNER-1",
        },
        projectId: "PROJECT-1",
        scopeKind: "project_context",
        scopeId: "PROJECT-1",
        workerId: "WORKER-1",
        leaseToken: "LEASE-1",
        ownerAttempt: 1,
        ownerEpoch: 1,
        dispatchSurface: "follower_ipc",
        purpose: "stage_run",
        deadlineAt: "2026-07-23T12:05:00.000Z",
        leaseExpiresAt: "2026-07-23T12:05:00.000Z",
      },
      originalDeadlineAt: "2026-07-23T12:05:00.000Z",
      correlationMarker: "MARKER-RESUMED",
      normalizedPromptHash: "PROMPT-HASH-RESUMED",
      preStartTurnIds: ["TURN-1"],
      preStartSemanticHash: "BASELINE-HASH-RESUMED",
      state: "succeeded",
      dispatchOrdinal: 1,
      turnId: "TURN-RESUMED",
    };
    const consumed = {
      runId: "RUN-1",
      state: "consumed" as const,
      logicalTurnId: "LOGICAL-1",
      attemptId: "ATTEMPT-1",
      correlationMarker: "MARKER-1",
      normalizedPromptHash: "PROMPT-HASH",
      preStartTurnIds: ["TURN-0"],
      preStartSemanticHash: "BASELINE-HASH",
      dispatchOrdinal: 1,
      turnId: "TURN-1",
      shellThreadId: "THREAD-1",
      desktopPid: 101,
      processStartedAt: "2026-07-23T11:59:00.000Z",
      socketPath: "/tmp/codex.sock",
      socketDevice: 11,
      socketInode: 12,
      observationCursor: 3,
      lastSnapshotHash: "SNAPSHOT-HASH",
      lastNormalizedSnapshot: terminal(
        "PHASE0_RESTART_CHECKPOINT_READY.",
      ),
      resumedLogicalTurnId: "LOGICAL-RESUMED",
      resumedAttemptId: "ATTEMPT-RESUMED",
      resumedCorrelationMarker: "MARKER-RESUMED",
      resumedNormalizedPromptHash: "PROMPT-HASH-RESUMED",
      resumedPreStartSemanticHash: "BASELINE-HASH-RESUMED",
      resumedShellThreadId: "THREAD-1",
      resumedDispatchOrdinal: 1,
      resumedTurnId: "TURN-RESUMED",
      consumedAt: "2026-07-23T12:01:00.000Z",
    };
    const resumedTerminal = terminal("PHASE0_RESTART_RESUME_OK.");
    resumedTerminal.turnId = "TURN-RESUMED";
    const completion = reconcileConsumedRestartCompletion(
      consumed,
      resumedAttempt,
      resumedTerminal,
    );
    assert.equal(completion.resumedTurnId, "TURN-RESUMED");
    for (const invalid of [
      {
        checkpoint: {
          ...consumed,
          resumedNormalizedPromptHash: "DRIFT",
        },
        attempt: resumedAttempt,
        snapshot: resumedTerminal,
      },
      {
        checkpoint: consumed,
        attempt: {
          ...resumedAttempt,
          request: { ...resumedAttempt.request, threadId: "THREAD-OTHER" },
        },
        snapshot: resumedTerminal,
      },
      {
        checkpoint: consumed,
        attempt: resumedAttempt,
        snapshot: {
          ...resumedTerminal,
          terminal: { output: "PHASE0_RESTART_RESUME_OK.\n" },
        },
      },
    ]) {
      assert.throws(
        () =>
          reconcileConsumedRestartCompletion(
            invalid.checkpoint,
            invalid.attempt,
            invalid.snapshot,
          ),
        /consumed restart/,
      );
    }
  });

  it("upserts one complete evidence row per journal attempt and rejects drift", () => {
    const attempt: CodexFollowerStartAttempt = {
      attemptId: "ATTEMPT-1",
      logicalTurnId: "LOGICAL-1",
      request: {
        threadId: "THREAD-1",
        cwd: "/repo",
        prompt: "test",
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      fence: {
        logicalTurnId: "LOGICAL-1",
        owner: {
          kind: "project_ai_run",
          projectAiRunId: "OWNER-1",
        },
        projectId: "PROJECT-1",
        scopeKind: "project_context",
        scopeId: "PROJECT-1",
        workerId: "WORKER-1",
        leaseToken: "LEASE-1",
        ownerAttempt: 1,
        ownerEpoch: 1,
        dispatchSurface: "follower_ipc",
        purpose: "stage_run",
        deadlineAt: "2026-07-23T12:05:00.000Z",
        leaseExpiresAt: "2026-07-23T12:05:00.000Z",
      },
      originalDeadlineAt: "2026-07-23T12:05:00.000Z",
      correlationMarker: "MARKER-1",
      normalizedPromptHash: "PROMPT-HASH-1",
      preStartTurnIds: ["TURN-0"],
      preStartSemanticHash: "BASELINE-HASH-1",
      state: "succeeded",
      dispatchOrdinal: 1,
      turnId: "TURN-1",
    };
    const evidence: Phase0StartAttemptEvidence[] = [];
    upsertStartAttemptEvidence(evidence, attempt, "started");
    upsertStartAttemptEvidence(evidence, attempt, "recovered_succeeded");
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.recoveryOutcome, "recovered_succeeded");
    assert.doesNotThrow(() =>
      assertStartAttemptEvidenceMatchesJournal([attempt], evidence));
    assert.throws(
      () => assertStartAttemptEvidenceMatchesJournal([attempt], []),
      /attempt evidence/,
    );
    assert.throws(
      () =>
        assertStartAttemptEvidenceMatchesJournal(
          [attempt],
          [evidence[0]!, { ...evidence[0]! }],
        ),
      /attempt evidence/,
    );
    assert.throws(
      () =>
        assertStartAttemptEvidenceMatchesJournal(
          [{ ...attempt, normalizedPromptHash: "DRIFT" }],
          evidence,
        ),
      /attempt evidence/,
    );
  });

  it("accepts both real after-IPC outcomes without recovery redispatch", () => {
    assert.deepEqual(
      validateRealCrashRecoveryBranch({
        window: "after_ipc_write_before_response",
        recoveredState: "quarantined",
        createdTurnIds: [],
        recoveryFollowerStartDelta: 0,
        recoveryAppServerMethodCounts: { "turn/start": 0 },
        exactTerminalObserved: false,
      }),
      { outcome: "quarantined", correlatedTurnCount: 0 },
    );
    assert.deepEqual(
      validateRealCrashRecoveryBranch({
        window: "after_ipc_write_before_response",
        recoveredState: "succeeded",
        recoveredTurnId: "TURN-1",
        createdTurnIds: ["TURN-1"],
        recoveryFollowerStartDelta: 0,
        recoveryAppServerMethodCounts: { "turn/start": 0 },
        exactTerminalObserved: true,
      }),
      { outcome: "succeeded", correlatedTurnCount: 1 },
    );
    assert.throws(
      () =>
        validateRealCrashRecoveryBranch({
          window: "after_ipc_write_before_response",
          recoveredState: "quarantined",
          createdTurnIds: [],
          recoveryFollowerStartDelta: 1,
          recoveryAppServerMethodCounts: { "turn/start": 0 },
          exactTerminalObserved: false,
        }),
      /real crash recovery/,
    );
    assert.doesNotThrow(() =>
      validateRealCrashRecoveryBranch({
        window: "success_before_cas",
        recoveredState: "succeeded",
        recoveredTurnId: "TURN-2",
        createdTurnIds: ["TURN-2"],
        recoveryFollowerStartDelta: 0,
        recoveryAppServerMethodCounts: { "turn/start": 0 },
        exactTerminalObserved: true,
      }));
  });
});
