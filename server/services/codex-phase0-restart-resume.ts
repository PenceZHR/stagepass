import type {
  CodexFollowerStartAttempt,
  CodexTurnSnapshot,
} from "./codex-desktop-bridge-types";
import type {
  CodexPhase0RestartCheckpoint,
} from "./codex-phase0-sqlite-journal";
import {
  reconcileConsumedRestartCompletion,
  reconcileRestartCheckpointEvidence,
  restartCheckpointEvidenceFromDurable,
  type RestartCheckpointReportEvidence,
  type RestartCompletionEvidence,
} from "./codex-phase0-verifier-contract";

export interface Phase0RestartExecutionEvidence {
  attempt: CodexFollowerStartAttempt;
  snapshot: CodexTurnSnapshot;
}

export async function orchestratePhase0RestartResume<T>(input: {
  checkpoint: CodexPhase0RestartCheckpoint;
  persistedReportCheckpoint?: RestartCheckpointReportEvidence;
  consumedExecution?: Phase0RestartExecutionEvidence;
  startRestart(): Promise<Phase0RestartExecutionEvidence>;
  consumeRestart(
    execution: Phase0RestartExecutionEvidence,
  ): Promise<CodexPhase0RestartCheckpoint>;
  continueDownstream(completion: RestartCompletionEvidence): Promise<T>;
}): Promise<{
  completion: RestartCompletionEvidence;
  downstream: T;
}> {
  let consumedCheckpoint: CodexPhase0RestartCheckpoint;
  let execution: Phase0RestartExecutionEvidence;
  if (input.checkpoint.state === "consumed") {
    const rebuiltCheckpoint = restartCheckpointEvidenceFromDurable(
      input.checkpoint,
    );
    if (
      input.persistedReportCheckpoint
      && JSON.stringify(input.persistedReportCheckpoint)
        !== JSON.stringify(rebuiltCheckpoint)
    ) {
      throw new Error(
        "Phase 0 consumed restart report checkpoint is inconsistent",
      );
    }
    if (!input.consumedExecution) {
      throw new Error(
        "Phase 0 consumed restart execution evidence is missing",
      );
    }
    consumedCheckpoint = input.checkpoint;
    execution = input.consumedExecution;
  } else {
    reconcileRestartCheckpointEvidence(
      input.persistedReportCheckpoint,
      input.checkpoint,
    );
    execution = await input.startRestart();
    consumedCheckpoint = await input.consumeRestart(execution);
    if (consumedCheckpoint.state !== "consumed") {
      throw new Error("Phase 0 restart consume did not persist a tombstone");
    }
  }
  const completion = reconcileConsumedRestartCompletion(
    consumedCheckpoint,
    execution.attempt,
    execution.snapshot,
  );
  const downstream = await input.continueDownstream(completion);
  return { completion, downstream };
}
