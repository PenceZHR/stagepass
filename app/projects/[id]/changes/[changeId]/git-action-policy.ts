import { findPipelineAction, type PipelineActionContract } from "./pipeline-action-contract";

/**
 * Which git actions the Build/Fix stage bar shows.
 *
 * Both git actions are always present in the contract -- they have no
 * requiredStatus, because git has no status precondition (see
 * action-contract-registry-service) -- so the stage bar, not the contract, is
 * where the noise has to be filtered out. The rule is: show a git action when
 * the contract has something to say about it.
 *
 *   enabled                  -> it is the next step. init while the path is not
 *                               a repository, commit while the tree carries work.
 *   disabled WITH blockers   -> it is the explanation. commit_changes on a
 *                               non-repository carries the same
 *                               "Path is not a git repository." blocker run_build
 *                               refuses itself with, and that has to be readable
 *                               from the stage rather than only from the Build
 *                               sandbox.
 *   disabled WITHOUT blockers-> nothing is wrong and nothing is to be done: init
 *                               on an existing repo, commit on a clean tree. A
 *                               permanently greyed-out button here would be on
 *                               screen for the entire normal life of a change.
 */
export const GIT_STAGE_ACTION_IDS = ["init_git_repo", "commit_changes"] as const;

export function selectVisibleGitStageActions(
  actions: PipelineActionContract[] | undefined,
): PipelineActionContract[] {
  return GIT_STAGE_ACTION_IDS
    .map((actionId) => findPipelineAction(actions, actionId))
    .filter((action): action is PipelineActionContract => action !== null)
    .filter((action) => action.enabled || action.blockers.length > 0);
}
