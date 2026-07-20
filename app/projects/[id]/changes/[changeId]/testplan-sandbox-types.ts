export interface TestPlanSnapshotSummary {
  id: string;
  status: string;
  approvalState: string;
  approvedAt: string | null;
  snapshotDbHash: string;
  schemaVersion: string;
  createdAt: string;
}

export interface TestPlanCoverageItem {
  id: string;
  testplanSnapshotId: string;
  itemKey: string;
  title: string;
  requirementRef: string | null;
  testType: string;
  priority: string;
  status: string;
  createdAt: string;
}

export interface TestPlanRiskMapping {
  id: string;
  testplanSnapshotId: string;
  coverageItemKey: string;
  riskRef: string;
  severity: string;
  mitigation: string;
  createdAt: string;
}

export interface TestPlanRequiredCommand {
  id: string;
  changeId: string;
  phase: string;
  command: string;
  required: number;
  commandOrder: number;
  sourceSnapshotId: string | null;
  createdAt: string;
}

export interface TestPlanManualCheck {
  id: string;
  testplanSnapshotId: string;
  title: string;
  description: string | null;
  required: number;
  status?: string;
  createdAt: string;
}

export interface TestPlanSandboxState {
  changeId: string;
  status: "missing" | "draft" | "approved" | "blocked";
  snapshot: TestPlanSnapshotSummary | null;
  testIntent: string;
  coverageItems: TestPlanCoverageItem[];
  riskMappings: TestPlanRiskMapping[];
  requiredCommands: TestPlanRequiredCommand[];
  manualChecks: TestPlanManualCheck[];
  gate: {
    status: string | null;
    sourceDbHash: string | null;
    blockers: unknown[];
    requiredActions: string[];
  };
  reportFresh: boolean;
  markdown: string;
}
