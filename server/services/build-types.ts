import type { PolicyScope, WorkspaceMutation } from "./stage-guard-service";

export type BuildRunStatus =
  | "created"
  | "running"
  | "gate_blocked"
  | "awaiting_human"
  | "approved_for_absorb"
  | "audit_ready"
  | "adopted"
  | "rejected"
  | "failed";

export interface BuildRunFile {
  changeId: string;
  runNumber: number;
  status: BuildRunStatus;
  purpose?: "build" | "fix";
  baseHeadSha?: string | null;
  baseCommit: string | null;
  workspacePath: string;
  branchName: string;
  expectedFiles: string[];
  forbiddenFiles: string[];
  changedFiles: string[];
  deviations: BuildDeviation[];
  blockers: string[];
  patchPath: string | null;
  patchSha256: string | null;
  patchHash?: string | null;
  changedFilesHash?: string | null;
  designSourceDbHash?: string | null;
  adoptedHeadSha?: string | null;
  adoptionDecisionId?: string | null;
  approvalPath: string | null;
  diffPath: string | null;
  auditPath: string | null;
  reportPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuildPatchApprovalFile {
  changeId: string;
  runNumber: number;
  baseCommit: string;
  patchPath: string;
  patchSha256: string;
  approvedAt: string;
}

export type BuildDeviationReason =
  | "outside_expected_files"
  | "dependency"
  | "lockfile"
  | "migration"
  | "generated_file";

export type BuildDeviationSeverityHint = "P1" | "P2";

export interface BuildDeviation {
  file: string;
  reason: BuildDeviationReason;
  severityHint: BuildDeviationSeverityHint;
}

export interface BuildPlanScope {
  expectedFiles?: string[];
  allowedFiles?: string[];
  forbiddenFiles?: string[];
}

export interface BuildGateInput {
  mutations: WorkspaceMutation[];
  plan: BuildPlanScope;
  policy: PolicyScope;
}

export interface BuildGateResult {
  blocked: boolean;
  blockingFiles: string[];
  deviations: BuildDeviation[];
}
