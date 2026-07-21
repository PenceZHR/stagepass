export const ACTION_ENDPOINTS = {
  approve_intake: "intake",
  run_plan: "plan",
  retry_plan: "plan",
  approve_plan: "approve-plan",
  run_test_plan: "test-plan",
  retry_test_plan: "test-plan",
  run_build: "implement",
  retry_build: "implement",
  run_review: "review",
  retry_review: "review",
  enter_qa: "check",
  merge: "release",
  fix_blockers: "fix",
  stop_change: "block",
  run_qa: "check",
  retry_qa: "check",
  run_retro: "retro",
  run_delivery: "delivery",
  run_prd: "intake",
  retry_prd: "intake",
  run_spec: "spec",
  retry_spec: "spec",
  run_tech_spec: "tech-spec",
  retry_tech_spec: "tech-spec",
  regenerate_plan_report: "plan-sandbox/report",
  waive_plan_p1: "plan-sandbox/decision",
  init_git_repo: "git",
  commit_changes: "git",
} as const;

/**
 * Stage-table action ids that deliberately do NOT resolve through ACTION_ENDPOINTS
 * because a dedicated route owns them:
 *
 *   approve_/reject_ gates -> POST /gate/approve, POST /gate/reject
 *   waive_spec_p1          -> POST /spec-battle/decision
 *   adopt_build/adopt_fix/reject_build -> POST /build-workspace
 *   waive_review_p1/recompute_report/rebuild_mirror -> POST /review-center/*
 *
 * Anything listed in a stage's `actionIds` that is in neither this set nor
 * ACTION_ENDPOINTS has no way to reach the server: routing it through
 * `handleAction` would produce a button that silently does nothing. The
 * routability test in phase-review.test.ts fails on exactly that gap, so a newly
 * added action id has to declare which of the two routes it takes.
 */
export const NON_POST_ROUTED_ACTION_IDS: ReadonlySet<string> = new Set([
  "approve_spec",
  "reject_spec",
  "approve_tech_spec",
  "reject_tech_spec",
  "approve_merge",
  "reject_merge",
  "waive_spec_p1",
  "adopt_build",
  "adopt_fix",
  "reject_build",
  "waive_review_p1",
  "recompute_report",
  "rebuild_mirror",
]);

export type PipelineActionCommand = {
  endpoint: string;
};

export function resolvePipelineActionCommand(actionId: string): PipelineActionCommand | null {
  const endpoint = ACTION_ENDPOINTS[actionId as keyof typeof ACTION_ENDPOINTS];
  if (!endpoint) return null;
  return { endpoint };
}

/** True when `handleAction` can actually POST this action id somewhere. */
export function isPostRoutedAction(actionId: string): boolean {
  return resolvePipelineActionCommand(actionId) !== null;
}
