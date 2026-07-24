import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  orchestratePhase0RestartResume,
} from "./codex-phase0-restart-resume.ts";
import type {
  CodexFollowerStartAttempt,
  CodexTurnSnapshot,
} from "./codex-desktop-bridge-types.ts";
import type {
  CodexPhase0RestartCheckpoint,
} from "./codex-phase0-sqlite-journal.ts";
import {
  restartCheckpointEvidenceFromDurable,
} from "./codex-phase0-verifier-contract.ts";

function consumedFixture(): {
  checkpoint: CodexPhase0RestartCheckpoint;
  attempt: CodexFollowerStartAttempt;
  snapshot: CodexTurnSnapshot;
} {
  const attempt: CodexFollowerStartAttempt = {
    attemptId: "ATTEMPT-RESUME",
    logicalTurnId: "LOGICAL-RESUME",
    request: {
      threadId: "THREAD-1",
      cwd: "/repo",
      prompt: "Reply exactly PHASE0_RESTART_RESUME_OK.",
      approvalPolicy: "never",
      sandboxMode: "read-only",
    },
    fence: {
      logicalTurnId: "LOGICAL-RESUME",
      owner: {
        kind: "project_ai_run",
        projectAiRunId: "OWNER-RESUME",
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
    correlationMarker: "MARKER-RESUME",
    normalizedPromptHash: "PROMPT-HASH-RESUME",
    preStartTurnIds: ["TURN-CHECKPOINT"],
    preStartSemanticHash: "BASELINE-HASH-RESUME",
    state: "succeeded",
    dispatchOrdinal: 1,
    turnId: "TURN-RESUME",
  };
  const checkpoint: CodexPhase0RestartCheckpoint = {
    runId: "RUN-1",
    state: "consumed",
    logicalTurnId: "LOGICAL-CHECKPOINT",
    attemptId: "ATTEMPT-CHECKPOINT",
    correlationMarker: "MARKER-CHECKPOINT",
    normalizedPromptHash: "PROMPT-HASH-CHECKPOINT",
    preStartTurnIds: [],
    preStartSemanticHash: "BASELINE-HASH-CHECKPOINT",
    dispatchOrdinal: 1,
    turnId: "TURN-CHECKPOINT",
    shellThreadId: "THREAD-1",
    desktopPid: 101,
    processStartedAt: "2026-07-23T11:59:00.000Z",
    socketPath: "/tmp/codex.sock",
    socketDevice: 11,
    socketInode: 12,
    observationCursor: 3,
    lastSnapshotHash: "SNAPSHOT-HASH",
    lastNormalizedSnapshot: {
      threadId: "THREAD-1",
      turnId: "TURN-CHECKPOINT",
      status: "completed",
      items: [],
      terminal: { output: "PHASE0_RESTART_CHECKPOINT_READY." },
      metadata: { observedAt: "2026-07-23T12:00:00.000Z" },
    },
    resumedLogicalTurnId: attempt.logicalTurnId,
    resumedAttemptId: attempt.attemptId,
    resumedCorrelationMarker: attempt.correlationMarker,
    resumedNormalizedPromptHash: attempt.normalizedPromptHash,
    resumedPreStartSemanticHash: attempt.preStartSemanticHash,
    resumedShellThreadId: attempt.request.threadId,
    resumedDispatchOrdinal: attempt.dispatchOrdinal,
    resumedTurnId: attempt.turnId!,
    consumedAt: "2026-07-23T12:01:00.000Z",
  };
  return {
    checkpoint,
    attempt,
    snapshot: {
      threadId: "THREAD-1",
      turnId: "TURN-RESUME",
      status: "completed",
      items: [],
      terminal: { output: "PHASE0_RESTART_RESUME_OK." },
      metadata: { observedAt: "2026-07-23T12:01:00.000Z" },
    },
  };
}

describe("Codex Phase 0 restart-resume production orchestration", () => {
  for (const reportState of ["stale", "missing"] as const) {
    it(`continues once from a consumed tombstone with ${reportState} JSON`, async () => {
      const fixture = consumedFixture();
      let restartStarts = 0;
      let consumes = 0;
      let downstreamRuns = 0;
      const result = await orchestratePhase0RestartResume({
        checkpoint: fixture.checkpoint,
        persistedReportCheckpoint: reportState === "stale"
          ? restartCheckpointEvidenceFromDurable(fixture.checkpoint)
          : undefined,
        consumedExecution: {
          attempt: fixture.attempt,
          snapshot: fixture.snapshot,
        },
        async startRestart() {
          restartStarts += 1;
          throw new Error("consumed checkpoint must not restart");
        },
        async consumeRestart() {
          consumes += 1;
          throw new Error("consumed checkpoint must not consume twice");
        },
        async continueDownstream(completion) {
          downstreamRuns += 1;
          assert.equal(
            completion.resumedTurnId,
            fixture.checkpoint.resumedTurnId,
          );
          return "PHASE0_DOWNSTREAM_SENTINEL";
        },
      });

      assert.equal(result.downstream, "PHASE0_DOWNSTREAM_SENTINEL");
      assert.equal(restartStarts, 0);
      assert.equal(consumes, 0);
      assert.equal(downstreamRuns, 1);
    });
  }
});
