/**
 * The wire shape of `/api/projects/[id]/changes/[changeId]/rubrics`.
 *
 * Mirrors server/services/rubric-panel-service.ts. Declared here rather than
 * imported so a client component never pulls the DB layer into the browser
 * bundle, which is what every other panel in this route does
 * (spec-battle-types.ts, gate-types.ts, ...).
 */

export const RUBRIC_ROLES = ["producer", "critic", "verdict"] as const;
export type RubricRole = (typeof RUBRIC_ROLES)[number];

export type RubricPhase =
  | "Refine"
  | "PRD"
  | "Spec"
  | "TechSpec"
  | "Plan"
  | "TestPlan"
  | "Build"
  | "Fix"
  | "QA"
  | "Merge"
  | "Retro";

export type RubricVerdict = "yes" | "no" | "not_assessed";

export interface RubricPanelCriterion {
  criterionKey: string;
  text: string;
  blocking: boolean;
}

export interface RubricPanelVerdict {
  criterionKey: string;
  text: string;
  blocking: boolean;
  verdict: RubricVerdict;
  evidence: string | null;
  stillCurrent: boolean;
}

export interface RubricRolePanel {
  role: RubricRole;
  applicable: boolean;
  rubricId: string | null;
  version: number | null;
  source: "change" | "project" | null;
  hasChangeOverride: boolean;
  criteria: RubricPanelCriterion[];
  verdicts: RubricPanelVerdict[];
  judgedVersion: number | null;
  judgedByOutdatedVersion: boolean;
  blocked: boolean;
  /** The pipeline stage that answers this role; null when nothing does. */
  answeredBy: string | null;
}

export type RubricBlockingChannel = "requirement_gap" | "finding" | "stage_gate" | "none";

export interface RubricPanelState {
  phase: RubricPhase;
  projectId: string;
  changeId: string;
  roundId: string | null;
  blockingChannel: RubricBlockingChannel;
  roles: RubricRolePanel[];
}

export const RUBRIC_ROLE_LABELS: Record<RubricRole, string> = {
  producer: "正方",
  critic: "反方",
  verdict: "裁决",
};

export const RUBRIC_ROLE_HINTS: Record<RubricRole, string> = {
  producer: "产出这一阶段产物的 agent 交付前自证：我是否满足了这些条件。",
  critic: "审查方独立复核：产物是否满足这些条件。",
  verdict: "裁决 agent 读正反方的产出，决定这道门能不能过。",
};
