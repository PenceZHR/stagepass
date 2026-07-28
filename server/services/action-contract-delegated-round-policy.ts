import { isRunningBattleRoundStatus } from "../types/enums";
import type { ActionDecision } from "./action-contract-types";
import {
  getDelegatedRoundState,
  type DelegatedLedgerPhase,
} from "./delegated-round-ledger";

/**
 * What a phase's `run_*` and `retry_*` may do while it has a delegated round.
 *
 * Shaped after `specRunDecision`, because the decision table is the same one and
 * the two places it gets subtly wrong are the same two:
 *
 *  - **`awaiting_clarification` needs its own branch.** Without one it falls
 *    through to the bottom and disables BOTH actions, which is a dead end: the
 *    Codex task is open holding unanswered questions, and the human has no way
 *    out. `run_*` must stay shut -- a second producer run would race the answers
 *    being typed -- while `retry_*` stays open, because rotating the task is the
 *    only thing a human who wants to abandon a question loop can do.
 *  - **A settled round is not a green light.** `report_ready` means both sides
 *    produced and the human now has a decision to make. Leaving `run_*` enabled
 *    there would let a click silently open ANOTHER round and burn a full
 *    red/blue/judge cycle, which is why the settled branch names the human
 *    decision instead of falling through.
 *
 * Returns null when this policy has nothing to say, so the caller's own gate
 * checks decide.
 */
export function delegatedRoundRunDecision(input: {
  actionId: string;
  changeId: string;
  phase: DelegatedLedgerPhase;
  /** True for the phase's `retry_*` action. */
  isRetry: boolean;
}): ActionDecision | null {
  const disabled = (reasonCode: string): ActionDecision => ({
    enabled: false,
    reasonCode,
    reason: reasonCode,
    blockers: [],
  });

  const latest = getDelegatedRoundState(input.changeId, input.phase).latestRound;
  // No round yet means this phase has never run a delegated round, and the
  // phase's ordinary gate checks are the whole answer.
  if (!latest) return null;

  const prefix = input.phase.toLowerCase();

  if (isRunningBattleRoundStatus(latest.status)) {
    return disabled(`${prefix}_round_running`);
  }
  if (latest.status === "awaiting_clarification") {
    return input.isRetry ? null : disabled(`${prefix}_round_awaiting_clarification`);
  }
  if (latest.status === "failed") {
    return input.isRetry ? null : disabled(`${prefix}_round_failed_retry_required`);
  }
  // `red_done` / `blue_done` describe Spec's two-leg round and this ledger never
  // writes them -- it settles straight from `red_running` to `report_ready`. A
  // round wearing one is therefore a leg that finished with nothing running it:
  // stranded, not settled. Treated like `failed` rather than left to the
  // backstop, because the backstop shuts BOTH actions and a stranded round with
  // no exit is the dead end this table exists to avoid.
  if (latest.status === "red_done" || latest.status === "blue_done") {
    return input.isRetry ? null : disabled(`${prefix}_round_leg_stranded`);
  }
  // Past here the round is settled, closed or superseded, so there is nothing
  // for a retry to retry.
  if (input.isRetry) return disabled(`${prefix}_round_not_failed`);

  if (latest.status === "report_ready") {
    return disabled(`${prefix}_round_human_decision_required`);
  }
  if (latest.status === "closed") {
    return disabled(`${prefix}_round_closed`);
  }
  if (latest.status === "superseded" || latest.status === "not_started") {
    // A superseded round has been replaced and a not_started one is waiting to
    // be claimed; in both cases the phase may run.
    return null;
  }
  return disabled(`${prefix}_round_not_actionable`);
}
