import type { AiProvider } from "../types/enums";

export interface PipelineActionContract {
  actionId: string;
  phase:
    | "PRD"
    | "Spec"
    | "TechSpec"
    | "Plan"
    | "TestPlan"
    | "Build"
    | "Review"
    | "QA"
    | "Merge";
  label: string;
  enabled: boolean;
  reasonCode: string | null;
  reason: string | null;
  blockers: Array<{ id: string; severity: "P0" | "P1" | "P2"; title: string }>;
  warnings: ActionContractWarning[];
  gateVersion: string;
  sourceDbHash: string;
  requiresIdempotencyKey: boolean;
  requiresProvider: boolean;
  providerSelectable: boolean;
  defaultProvider: AiProvider;
}

export type ContractPhase = PipelineActionContract["phase"];
export type PrdInteractionActionId =
  | "answer_prd_question"
  | "accept_prd_assumption"
  | "defer_prd_question"
  | "lock_prd_briefing";
export type Blocker = PipelineActionContract["blockers"][number];
export type ActionContractWarning = {
  id: string;
  severity: "warning";
  title: string;
};
export type ActionContractDb = typeof import("../db/index").db;

export interface ActionDefinition {
  actionId: string;
  phase: ContractPhase;
  label: string;
  snapshotPhase?: string;
  requiredStatus?: string | string[];
  requiresProvider?: boolean;
  providerSelectable?: boolean;
}

export interface ActionDecision {
  enabled: boolean;
  reasonCode: string | null;
  reason: string | null;
  blockers: Blocker[];
  gateVersion?: string;
  sourceDbHash?: string;
}
