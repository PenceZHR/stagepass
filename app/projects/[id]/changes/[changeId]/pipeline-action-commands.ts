export const ACTION_ENDPOINTS = {
  run_plan: "plan",
  retry_plan: "plan",
  run_test_plan: "test-plan",
  retry_test_plan: "test-plan",
  run_build: "implement",
  retry_build: "implement",
  run_review: "review",
  retry_review: "review",
  run_qa: "check",
  retry_qa: "check",
  run_retro: "retro",
  run_delivery: "delivery",
  run_prd: "intake",
  retry_prd: "intake",
  run_spec: "spec",
  retry_spec: "spec",
  // Without this entry the action had a contract, an availability rule and no
  // way to be clicked: selectRoutableStageRunActions hides anything unroutable,
  // so the next round was unreachable from the web.
  request_spec_changes: "spec-battle/next-round",
  run_tech_spec: "tech-spec",
  retry_tech_spec: "tech-spec",
  // Same shape as `request_spec_changes` above, one phase each. Missing entries
  // are why an action can exist, be enabled, and still never render.
  request_tech_spec_changes: "tech-spec-round/next",
  request_plan_changes: "plan-round/next",
  request_test_plan_changes: "test-plan-round/next",
} as const;

/**
 * Decision action ids intentionally do not resolve in Web. They are submitted
 * through the Codex MCP interaction gateway (or its disclosed emergency path).
 */
/**
 * Actions that supersede a settled round and therefore need a human's reason.
 *
 * A set rather than four `===` comparisons at the call site: the check lives in
 * the page component, and a phase added without its entry here would silently
 * post no reason at all -- which the routes reject with a 422 the user would
 * read as the button being broken.
 */
export const NEXT_ROUND_ACTION_IDS: ReadonlySet<string> = new Set([
  "request_spec_changes",
  "request_tech_spec_changes",
  "request_plan_changes",
  "request_test_plan_changes",
]);

export const NON_POST_ROUTED_ACTION_IDS: ReadonlySet<string> = new Set([
  "approve_intake",
  "approve_spec",
  "reject_spec",
  "approve_tech_spec",
  "reject_tech_spec",
  "approve_plan",
  "approve_merge",
  "reject_merge",
  "waive_spec_p1",
  "adopt_build",
  "adopt_fix",
  "reject_build",
  "waive_review_p1",
  "waive_plan_p1",
  "fix_blockers",
  "enter_qa",
  "merge",
  "stop_change",
  "recompute_report",
  "regenerate_plan_report",
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
