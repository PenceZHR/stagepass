import type { PipelineActionContract } from "./pipeline-action-contract";
import type { SpecBattleGateState } from "./spec-battle-types";

export type GateName = "intake" | "spec" | "tech_spec" | "merge";

export interface MergeChecks {
  qaPassed: boolean;
  reviewPassed: boolean;
  docsComplete: boolean;
  requirementGapsPassed?: boolean;
  mergeBlockingRequirementGaps?: number;
  canMerge: boolean;
  missing: string[];
}

export interface GateStatus {
  atGate: boolean;
  gate: GateName | null;
  status: string;
  pendingArtifact: string | null;
  actions?: PipelineActionContract[];
  mergeChecks?: MergeChecks;
  specBattle?: SpecBattleGateState;
}
