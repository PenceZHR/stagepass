import { DELEGATED_ROUND_PHASES } from "./delegated-round-phases";
import type { RunPhase } from "../types";

/**
 * Whether a stage job must run in a FRESH Codex task.
 *
 * ## The bug this replaces
 *
 * The job runner decided this with `actionId.startsWith("retry_")`: rotate the
 * task when the human clicked retry, reuse it otherwise. That reads as a
 * sensible rule and is not one -- it keys the decision off what the BUTTON was
 * called instead of off what the work needs.
 *
 * A delegated round needs fresh sub-agents. `readDelegatedRound` refuses any
 * sub-agent thread an earlier round already used, because a round attributed
 * from last round's children is a round that never delegated. But sub-agents
 * live inside the judge's Codex task, so "fresh sub-agents" and "fresh task"
 * are the same requirement -- `spawn_agent` inside a task that already has a
 * `red` hands back the existing one.
 *
 * With the old rule, every round opened by 「继续对抗」 dispatched `run_*`,
 * which reused the task, which reused the sub-agents, which the guard refused.
 * The round was then marked failed, the change went BLOCKED, and the only exit
 * was `retry_*` -- which rotated the task and therefore worked. So the system
 * appeared to function while every single 「继续对抗」 burned one guaranteed
 * failure first, and the human was told to 「重新对抗」 a round that had never
 * run at all.
 *
 * CHG-006's ledger shows it exactly: every `run_spec` failed, every completed
 * round came from a `retry_spec`, and round 1 took eight attempts.
 *
 * ## Why not simply "always rotate"
 *
 * Phases that do not run a delegated round have no sub-agents and gain nothing
 * from a rotation; they lose the continuity of a task the human may be reading.
 * The rotation is a cost paid for a reason, so it is spent only where the reason
 * applies.
 */

const DELEGATED_RUN_PHASES: ReadonlySet<string> = new Set(
  DELEGATED_ROUND_PHASES.map((descriptor) => descriptor.runPhase),
);

export function stageJobNeedsFreshTask(input: {
  actionId: string;
  phase: RunPhase | string;
  /** `STAGEPASS_SPEC_JUDGE_SUBAGENTS`, which gates the delegated form. */
  delegatedRoundsEnabled: boolean;
  /**
   * Whether this change has already spent sub-agents inside the task it is
   * bound to now.
   *
   * This is what makes the rotation per-ROUND instead of per-DISPATCH, and the
   * difference is not academic. The first version rotated on every delegated
   * dispatch, so three clicks on a failing round abandoned three Codex tasks in
   * ninety seconds -- and the human watching the adversarial round watched it go
   * blank each time, because that task IS the only place the round is visible.
   * A retry of a round whose sub-agents never spawned has nothing to avoid: the
   * task is already clean, and rotating it costs the human everything they were
   * reading for no gain at all.
   */
  taskHasSpentSubAgents: boolean;
}): boolean {
  if (input.delegatedRoundsEnabled && DELEGATED_RUN_PHASES.has(input.phase)) {
    // The round guard refuses a sub-agent an earlier round already used, and
    // sub-agents live in the task -- so a task that has spent them cannot host
    // another round. One that has not is exactly what this round needs.
    return input.taskHasSpentSubAgents;
  }
  // The deliberate abandon: a human walking away from a task holding unanswered
  // questions has no other way out, so retry keeps rotating on every other path.
  return input.actionId.startsWith("retry_");
}
