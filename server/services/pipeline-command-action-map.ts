import type { PipelineCommandAction } from "./pipeline-command-types";

export const INTERACTION_ACTION_ALIASES = {
  supply_spec_fact: "request_spec_changes",
  dispute_spec_gap: "request_spec_changes",
  approve_test_plan: "approve_plan",
  request_qa_fix: "fix_blockers",
} as const;

export type InteractionActionAlias = keyof typeof INTERACTION_ACTION_ALIASES;

export const DESIGN_INTERACTION_PHASES = {
  supply_spec_fact: "Spec",
  dispute_spec_gap: "Spec",
  return_to_spec: "Spec",
  waive_spec_p1: "Spec",
  approve_spec: "Spec",
  reject_spec: "Spec",
  approve_tech_spec: "TechSpec",
  reject_tech_spec: "TechSpec",
  waive_plan_p1: "Plan",
  approve_plan: "Plan",
  reject_plan: "Plan",
  approve_test_plan: "TestPlan",
  reject_test_plan: "TestPlan",
  request_qa_fix: "QA",
} as const;

export type DesignInteractionActionId =
  keyof typeof DESIGN_INTERACTION_PHASES;

export function resolvePipelineCommandAction(
  externalActionId: string,
): PipelineCommandAction {
  const canonicalActionId =
    INTERACTION_ACTION_ALIASES[
      externalActionId as InteractionActionAlias
    ] ?? externalActionId;
  return { externalActionId, canonicalActionId };
}

export function resolveInteractionAction(externalId: string): {
  externalId: string;
  canonicalId: string;
} {
  const resolved = resolvePipelineCommandAction(externalId);
  return {
    externalId: resolved.externalActionId,
    canonicalId: resolved.canonicalActionId,
  };
}

export function projectInteractionPhase(
  externalActionId: DesignInteractionActionId,
): (typeof DESIGN_INTERACTION_PHASES)[DesignInteractionActionId] {
  return DESIGN_INTERACTION_PHASES[externalActionId];
}
