import type { ChangeStatus, RunPhase } from "../types";
import type { Provider } from "./provider-selection-service";
import {
  beginStageRun,
  endStageRun,
  setStatus,
  StageBoundaryViolationError,
} from "./pipeline-run-ledger-service";

export interface StageExecutionResult<TResult> {
  result: TResult;
  successSummary: string;
}

export interface RunStageWithLedgerInput<TResult> {
  changeId: string;
  phase: RunPhase;
  runningStatus: ChangeStatus;
  successStatus: ChangeStatus;
  failureStatus: ChangeStatus;
  runId?: string;
  provider?: Provider;
  deferRunCompletion?: boolean;
  execute: (input: { runId: string }) => Promise<StageExecutionResult<TResult>>;
}

export interface QaLocalCheckLedgerCompletion<TResult> {
  result: TResult;
  summary: string;
  success: boolean;
  finalStatus: ChangeStatus;
}

export interface RunQaLocalCheckWithLedgerInput<TResult> {
  changeId: string;
  execute: (input: { runId: string }) => Promise<QaLocalCheckLedgerCompletion<TResult>>;
  beforeFinalStatus?: (input: QaLocalCheckLedgerCompletion<TResult> & { runId: string }) => Promise<void> | void;
  onFailureBeforeStatus?: (input: { runId: string; error: unknown; summary: string }) => Promise<void> | void;
  onFailureRecoveryError?: (err: unknown) => void;
  formatFailureSummary?: (err: unknown) => string;
}

function shouldBypassFailureLedger(err: unknown): boolean {
  return (
    err instanceof StageBoundaryViolationError ||
    (err instanceof Error && err.name === "PipelineRunStoppedError")
  );
}

export async function runStageWithLedger<TResult>({
  changeId,
  phase,
  runningStatus,
  successStatus,
  failureStatus,
  runId: reservedRunId,
  deferRunCompletion = false,
  provider,
  execute,
}: RunStageWithLedgerInput<TResult>): Promise<TResult> {
  // The run row must land in the same transaction as the status it justifies.
  // When the caller reserved a run id, that row already exists.
  let runId: string;
  if (reservedRunId) {
    await setStatus(changeId, runningStatus);
    runId = reservedRunId;
  } else {
    runId = beginStageRun({ changeId, phase, runningStatus, provider });
  }

  try {
    const { result, successSummary } = await execute({ runId });
    if (deferRunCompletion) return result;
    endStageRun({ changeId, runId, status: successStatus, summary: successSummary, success: true });
    return result;
  } catch (err) {
    if (deferRunCompletion || shouldBypassFailureLedger(err)) {
      throw err;
    }
    endStageRun({ changeId, runId, status: failureStatus, summary: String(err), success: false });
    throw err;
  }
}

export async function runQaLocalCheckWithLedger<TResult>({
  changeId,
  execute,
  beforeFinalStatus,
  onFailureBeforeStatus,
  onFailureRecoveryError,
  formatFailureSummary,
}: RunQaLocalCheckWithLedgerInput<TResult>): Promise<TResult> {
  const runId = beginStageRun({
    changeId,
    phase: "local_check",
    runningStatus: "CHECKING",
  });

  try {
    const completion = await execute({ runId });
    // beforeFinalStatus (recomputes the QA gate) touches qa_runs/stage_gates,
    // never `runs`, so running it before the run ends and the status advances
    // is safe and lets those two land in one transaction with nothing after them.
    await beforeFinalStatus?.({ ...completion, runId });
    endStageRun({
      changeId, runId, status: completion.finalStatus,
      summary: completion.summary, success: completion.success,
    });
    return completion.result;
  } catch (err) {
    if (err instanceof StageBoundaryViolationError) {
      throw err;
    }
    const summary = formatFailureSummary
      ? formatFailureSummary(err)
      : err instanceof Error ? err.message : String(err);
    try {
      await onFailureBeforeStatus?.({ runId, error: err, summary });
      endStageRun({ changeId, runId, status: "CHECK_FAILED", summary, success: false });
    } catch (recoveryErr) {
      onFailureRecoveryError?.(recoveryErr);
    }
    throw err;
  }
}
