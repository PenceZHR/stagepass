import { eq } from "drizzle-orm";

import { db } from "../db";
import { changes, projects } from "../db/schema";
import { createChildLogger } from "../logger";
import type { ChangeStatus, Project } from "../types";
import type { AiRunResult } from "./ai-engine-types";
import type { JobExecutionContext } from "./job-execution-context";
import type { Provider } from "./provider-selection-service";
import {
  claimDelegatedRound,
  failDelegatedRound,
  getDelegatedRoundState,
  openDelegatedRound,
  pauseDelegatedRound,
  resumeDelegatedRound,
  type DelegatedLedgerPhase,
} from "./delegated-round-ledger";
import type { DelegatedRoundPhase } from "./delegated-round-phases";
import {
  runDelegatedPhaseRound,
  type DelegatedPhaseRoundInput,
} from "./pipeline-delegated-phase-round";
import { StageAwaitingClarificationError } from "./pipeline-document-stage-runner-service";
import { beginStageRun, endStageRun, stopRun } from "./pipeline-run-ledger-service";
import { isRunningBattleRoundStatus } from "../types/enums";

const log = createChildLogger("pipeline-delegated-phase-stage");

/**
 * The stage-level wrapper around one delegated round: open or resume the round,
 * run it, and give the round a terminal whatever happens.
 *
 * ## Why open/resume is here and not in the runner
 *
 * `runDelegatedPhaseRound` settles a round that ran. Deciding WHICH round is
 * running -- a fresh one, a retry of a failed one, or one parked on the human
 * whose answer just arrived -- is stage business, and it is the part where
 * getting it wrong strands a change rather than failing it. Keeping the two
 * apart means the runner has exactly one job and this file has exactly one
 * decision table.
 *
 * ## Why a parked round is not a failed one
 *
 * A turn that ends by opening a question card produced an acknowledgement, not a
 * round. Failing it would burn the round AND leave the Codex task holding
 * unanswered questions, so it parks: the round stays `awaiting_clarification`
 * with no `endedAt`, the run settles as produced-nothing, and the job reports
 * success so the worker does not retry a turn whose answer is with the user.
 * Adoption completes this same round later.
 */

/**
 * A descriptor narrowed to a phase THIS ledger owns.
 *
 * The narrowing is load-bearing rather than decorative: stage authority takes
 * `PipelinePhase`, and `openDelegatedRound` refuses Spec outright. Naming the
 * narrowed type means a caller that passes `SPEC_DELEGATED_ROUND` fails to
 * compile instead of failing at runtime inside a round that has already spent a
 * model turn.
 */
export type DelegatedPhaseDescriptor = DelegatedRoundPhase & { phase: DelegatedLedgerPhase };

export interface DelegatedPhaseStageOptions {
  descriptor: DelegatedPhaseDescriptor;
  changeId: string;
  context: JobExecutionContext;
  provider: Provider;
  /** Status the stage sits in while a round is running. */
  runningStatus: ChangeStatus;
  /**
   * Status once a round settles: the phase's "produced, awaiting the human"
   * status, NOT its approved one.
   *
   * It cannot be `runningStatus`. The transition table has no self-edge on a
   * running status (`TECHSPECCING -> {TECHSPEC_READY, SPEC_READY, BLOCKED}`), so
   * ending the run on it throws IllegalTransitionError -- and it would throw
   * AFTER the round, the gaps and the gate had all been written, which is the
   * half-settled round this design exists to make impossible. A change parked on
   * a running status is also in `RUNNING_CHANGE_STATUSES`, so it would hold the
   * one-active-change lock for the whole project.
   *
   * The Spec precedent is exactly this: `completeBlueCritique` moves the change
   * to SPEC_READY when the round reports, and the human decision closes the gate
   * separately.
   */
  settledStatus: ChangeStatus;
  /** Status to restore when the round fails. */
  failureStatus: ChangeStatus;
  persistRed: DelegatedPhaseRoundInput["persistRed"];
  /** A judge turn this task already produced, once its questions converged. */
  adoptedResult?: AiRunResult;
  /** Caps rounds per phase. Absent means no cap. */
  maxRounds?: number;
}

function requireChangeAndProject(changeId: string): { change: typeof changes.$inferSelect; project: Project } {
  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  if (!change) throw new Error(`Change not found: ${changeId}`);
  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
  if (!project) throw new Error(`Project not found: ${change.projectId}`);
  return { change, project: project as unknown as Project };
}

export async function runDelegatedPhaseStage(
  options: DelegatedPhaseStageOptions,
): Promise<AiRunResult> {
  const { descriptor, changeId } = options;
  const { change, project } = requireChangeAndProject(changeId);

  const existing = getDelegatedRoundState(changeId, descriptor.phase).latestRound;
  // A parked round resumes in place. Opening a second round beside it would put
  // two rounds on one phase with one of them un-completable, which is precisely
  // what `isOccupiedBattleRoundStatus` counts `awaiting_clarification` as
  // occupying for.
  const resumed = existing?.status === "awaiting_clarification"
    ? resumeDelegatedRound({ changeId, descriptor, roundId: existing.id })
    : null;

  const round = resumed?.resumed
    ? { roundId: existing!.id, roundNo: existing!.roundNo }
    : await openAndClaim(options);

  const runId = beginStageRun({
    changeId,
    phase: descriptor.runPhase,
    runningStatus: options.runningStatus,
    provider: options.provider,
  });

  try {
    const result = await runDelegatedPhaseRound({
      descriptor,
      changeId,
      changeTitle: change.title,
      projectId: change.projectId,
      project,
      context: options.context,
      provider: options.provider,
      runId,
      roundId: round.roundId,
      roundNo: round.roundNo,
      adoptedResult: options.adoptedResult,
      persistRed: options.persistRed,
    });
    endStageRun({
      changeId,
      runId,
      // Deliberately NOT the phase's "approved" gate state. A settled round is
      // evidence, not approval -- the human decision is what moves the gate on,
      // exactly as `applySpecBattleDecision` is for Spec.
      status: options.settledStatus,
      summary: `${descriptor.label} round ${round.roundNo} settled`,
      success: true,
    });
    return result;
  } catch (err) {
    if (err instanceof StageAwaitingClarificationError) {
      pauseDelegatedRound({ changeId, descriptor, roundId: round.roundId });
      // `stopRun`, not `endStageRun`: the change must STAY on its running status
      // while the round is parked. The round is unfinished and its Codex task is
      // still open, so advancing to the settled status would advertise a result
      // that does not exist -- and `endStageRun` cannot write the running status
      // back onto itself anyway. Same shape as runSpec's clarification branch.
      stopRun(runId, err.message);
      log.info(
        { changeId, phase: descriptor.phase, roundId: round.roundId, runId },
        "Delegated round parked awaiting human clarification",
      );
      return {
        threadId: `${changeId}-${descriptor.runPhase}-awaiting-clarification`,
        runId,
        summary: `${descriptor.runPhase}_round_awaiting_clarification`,
        success: true,
        changedFiles: [],
        structuredOutput: undefined,
        items: [],
      };
    }
    failDelegatedRound({
      changeId,
      descriptor,
      roundId: round.roundId,
      reason: err instanceof Error ? err.message : String(err),
    });
    endStageRun({
      changeId,
      runId,
      status: options.failureStatus,
      summary: err instanceof Error ? err.message : String(err),
      success: false,
    });
    throw err;
  }
}

async function openAndClaim(
  options: DelegatedPhaseStageOptions,
): Promise<{ roundId: string; roundNo: number }> {
  const { changeId, descriptor } = options;
  const existing = getDelegatedRoundState(changeId, descriptor.phase).latestRound;
  // A round left `red_running` by a worker that died is taken over rather than
  // stacked beside: `openDelegatedRound` would refuse it as occupied, and the
  // change would have no exit at all.
  if (existing && isRunningBattleRoundStatus(existing.status)) {
    return { roundId: existing.id, roundNo: existing.roundNo };
  }
  const opened = await openDelegatedRound({
    changeId,
    descriptor,
    maxRounds: options.maxRounds,
  });
  claimDelegatedRound({ changeId, descriptor, roundId: opened.roundId });
  return { roundId: opened.roundId, roundNo: opened.roundNo };
}
