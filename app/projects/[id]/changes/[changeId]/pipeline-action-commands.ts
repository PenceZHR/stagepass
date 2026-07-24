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
  run_tech_spec: "tech-spec",
  retry_tech_spec: "tech-spec",
} as const;

/**
 * Decision action ids intentionally do not resolve in Web. They are submitted
 * through the Codex MCP interaction gateway (or its disclosed emergency path).
 */
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
