export interface PipelineActionContract {
  actionId: string;
  phase: "PRD" | "Spec" | "Plan" | "TestPlan" | "Build" | "Review" | "QA" | "Merge";
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
  defaultProvider: "codex" | "claude";
}

export type ContractPhase = PipelineActionContract["phase"];
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
