export type PlanRiskSeverity = "P0" | "P1" | "P2";
export type PlanRiskStatus = "open" | "resolved" | "waived";

export interface PlanStep {
  step: number;
  description: string;
  file?: string;
  status?: "pending" | "blocked" | "done";
}

export interface PlanJson {
  planName?: string;
  expectedFiles?: string[];
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  implementationSteps?: PlanStep[];
  testPlan?: string[];
  validationCommands?: string[];
  risks?: string[];
}

export interface PlanRisk {
  id: string;
  severity: PlanRiskSeverity;
  category:
    | "scope"
    | "ordering"
    | "granularity"
    | "missing_test"
    | "migration"
    | "security"
    | "dependency"
    | "rollback"
    | "unknown";
  title: string;
  evidence: string;
  requiredPlanChange: string | null;
  affectedStepNumbers: number[];
  status: PlanRiskStatus;
  waiverReason: string | null;
}

export interface PlanGate {
  canApprove: boolean;
  blockingP0: number;
  blockingP1: number;
  nonBlockingP2: number;
  missingFields: string[];
  stale: boolean;
}

export interface PlanSandboxState {
  changeId: string;
  status: "not_started" | "plan_ready" | "report_ready" | "approved" | "blocked" | "failed";
  plan: PlanJson | null;
  planMarkdown: string | null;
  risks: PlanRisk[];
  gate: PlanGate;
  reportPath: string | null;
  reportFresh: boolean;
}
