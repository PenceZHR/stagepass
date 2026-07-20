import { and, eq } from "drizzle-orm";

import { buildRunRecords, runs } from "../db/schema";
import type { ActionContractDb, ActionDecision } from "./action-contract-types";
import {
  changeArtifactIgnoredPrefixes,
  checkGitBaseCamp,
  type GitBaseCampStatus,
} from "./build-workspace-service";
import {
  buildRetryStartDecisionFromInspection,
  inspectStaleBuildRun,
} from "./build-stale-run-recovery-service";

export function latestApprovedBuildRecord(
  db: ActionContractDb,
  changeId: string,
): typeof buildRunRecords.$inferSelect | null {
  const records = db
    .select()
    .from(buildRunRecords)
    .where(eq(buildRunRecords.changeId, changeId))
    .all()
    .filter((record) => record.status === "approved_for_absorb" || record.status === "adopted");
  return records.sort((left, right) => {
    const byAdoptedAt = (right.adoptedAt ?? right.updatedAt ?? "").localeCompare(left.adoptedAt ?? left.updatedAt ?? "");
    if (byAdoptedAt !== 0) return byAdoptedAt;
    const byUpdatedAt = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
    if (byUpdatedAt !== 0) return byUpdatedAt;
    return right.id.localeCompare(left.id);
  })[0] ?? null;
}

export function reviewBuildSourceHash(record: typeof buildRunRecords.$inferSelect): string | null {
  if (!record.patchHash || !record.changedFilesHash || !record.adoptedHeadSha) return null;
  return `${record.patchHash}:${record.changedFilesHash}:${record.adoptedHeadSha}`;
}

function latestBuildRunRecord(
  db: ActionContractDb,
  changeId: string,
): typeof buildRunRecords.$inferSelect | null {
  const records = db
    .select()
    .from(buildRunRecords)
    .where(eq(buildRunRecords.changeId, changeId))
    .all();
  return records.sort((left, right) => {
    const byUpdatedAt = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
    if (byUpdatedAt !== 0) return byUpdatedAt;
    return right.id.localeCompare(left.id);
  })[0] ?? null;
}

function latestCompletedFixRun(db: ActionContractDb, changeId: string): typeof runs.$inferSelect | null {
  const rows = db
    .select()
    .from(runs)
    .where(and(eq(runs.changeId, changeId), eq(runs.phase, "fix_findings")))
    .all()
    .filter((run) => run.status === "completed" || run.status === "success");
  return rows.sort((left, right) => {
    const byEnded = (right.endedAt ?? "").localeCompare(left.endedAt ?? "");
    if (byEnded !== 0) return byEnded;
    const byStarted = (right.startedAt ?? "").localeCompare(left.startedAt ?? "");
    if (byStarted !== 0) return byStarted;
    return right.id.localeCompare(left.id);
  })[0] ?? null;
}

function buildRunSourceHash(record: typeof buildRunRecords.$inferSelect): string | null {
  if (!record.patchHash || !record.changedFilesHash) return null;
  return `${record.patchHash}:${record.changedFilesHash}`;
}

export function adoptBuildRunDecision(db: ActionContractDb, changeId: string): ActionDecision {
  const latestBuild = latestBuildRunRecord(db, changeId);
  if (!latestBuild) {
    return {
      enabled: false,
      reasonCode: "build_run_missing",
      reason: "Build run is missing",
      blockers: [],
    };
  }
  if (latestBuild.status !== "awaiting_human" && latestBuild.status !== "approved_for_absorb") {
    return {
      enabled: false,
      reasonCode: "build_not_awaiting_absorb",
      reason: `Build run is ${latestBuild.status}`,
      blockers: [],
    };
  }
  const sourceDbHash = buildRunSourceHash(latestBuild);
  if (!sourceDbHash) {
    return {
      enabled: false,
      reasonCode: "build_hash_missing",
      reason: "Build run patch or changed-files hash is missing",
      blockers: [{ id: latestBuild.id, severity: "P1", title: "Build hash metadata is incomplete" }],
    };
  }
  return {
    enabled: true,
    reasonCode: null,
    reason: null,
    blockers: [],
    sourceDbHash,
  };
}

export function rejectBuildRunDecision(db: ActionContractDb, changeId: string): ActionDecision {
  const latestBuild = latestBuildRunRecord(db, changeId);
  if (!latestBuild) {
    return {
      enabled: false,
      reasonCode: "build_run_missing",
      reason: "Build run is missing",
      blockers: [],
    };
  }
  if (latestBuild.status === "adopted" || latestBuild.status === "rejected") {
    return {
      enabled: false,
      reasonCode: "build_terminal",
      reason: `Build run is ${latestBuild.status}`,
      blockers: [],
    };
  }
  if (latestBuild.status !== "awaiting_human" && latestBuild.status !== "gate_blocked") {
    return {
      enabled: false,
      reasonCode: "build_not_rejectable",
      reason: `Build run is ${latestBuild.status}`,
      blockers: [],
    };
  }
  return {
    enabled: true,
    reasonCode: null,
    reason: null,
    blockers: [],
    sourceDbHash: buildRunSourceHash(latestBuild) ?? latestBuild.artifactHash ?? latestBuild.id,
  };
}

export function retryBuildDecision(
  db: ActionContractDb,
  changeId: string,
  changeStatus: string,
  baseGate: ActionDecision,
): ActionDecision {
  void db;
  if (changeStatus === "PLAN_APPROVED") return baseGate;
  if (changeStatus !== "IMPLEMENTING") {
    return {
      enabled: false,
      reasonCode: "not_at_gate",
      reason: "not_at_gate",
      blockers: [],
    };
  }
  const retryStart = buildRetryStartDecisionFromInspection(
    changeStatus,
    inspectStaleBuildRun(changeId),
  );
  if (!retryStart.canStart) {
    return {
      enabled: false,
      reasonCode: retryStart.reasonCode,
      reason: retryStart.reason,
      blockers: [],
    };
  }
  return baseGate.enabled
    ? baseGate
    : {
        enabled: false,
        reasonCode: baseGate.reasonCode,
        reason: baseGate.reason,
        blockers: baseGate.blockers,
      };
}

export function reviewBuildAdoptionDecision(
  db: ActionContractDb,
  changeId: string,
  current: ActionDecision,
  isRetry: boolean = false,
): ActionDecision {
  if (!current.enabled) return current;
  const latestBuild = latestApprovedBuildRecord(db, changeId);
  const hasApprovedArtifact = Boolean(
    latestBuild?.status === "adopted" &&
      latestBuild.baseHeadSha &&
      latestBuild.baseCommit &&
      latestBuild.patchHash &&
      latestBuild.changedFilesHash &&
      latestBuild.adoptedHeadSha &&
      latestBuild.adoptionDecisionId &&
      latestBuild.adoptedAt &&
      latestBuild.artifactHash,
  );
  if (latestBuild && hasApprovedArtifact) {
    const latestFix = latestCompletedFixRun(db, changeId);
    const fixCompletedAt = latestFix?.endedAt ?? null;
    const approvedAt = latestBuild.updatedAt ?? latestBuild.adoptedAt ?? null;
    if (fixCompletedAt && (!approvedAt || fixCompletedAt > approvedAt)) {
      // For retry (both retry_review and run_review when user explicitly triggers),
      // allow re-running even without re-adopting after fix.
      // This lets users manually retry review without waiting for build re-adoption.
      if (isRetry) {
        return {
          ...current,
          gateVersion: "0",
          sourceDbHash: reviewBuildSourceHash(latestBuild) || current.sourceDbHash,
        };
      }
      return {
        enabled: false,
        reasonCode: "build_not_approved_after_fix",
        reason: "Review requires a new approved BuildRun after the latest fix run",
        blockers: [{ id: "build_after_fix", severity: "P1", title: "Latest fix has not been approved" }],
      };
    }
    return {
      ...current,
      gateVersion: "0",
      sourceDbHash: reviewBuildSourceHash(latestBuild) || current.sourceDbHash,
    };
  }
  // For retry, allow even without complete adoption (user may want to debug/force retry)
  if (isRetry && latestBuild) {
    return {
      ...current,
      sourceDbHash: [
        latestBuild.patchHash,
        latestBuild.changedFilesHash,
        latestBuild.baseCommit,
      ].filter(Boolean).join(":") || current.sourceDbHash,
    };
  }
  // For retry without any build, still allow (might be debugging/testing)
  if (isRetry) {
    return current;
  }
  return {
    enabled: false,
    reasonCode: "review_build_adoption_incomplete",
    reason: "Review requires a latest adopted BuildRun with complete adoption fields",
    blockers: [{ id: "build", severity: "P1", title: "Build adoption fields are incomplete" }],
  };
}

// --- Build workspace base camp gate (moved from the action-contract facade) ---

export function buildBaseCampDecision(
  changeId: string,
  repoPath: string,
  current: ActionDecision,
  options: { blockDirtyStatus?: boolean } = {},
): ActionDecision {
  if (!current.enabled) return current;
  const baseCamp = checkGitBaseCamp(repoPath, {
    ignoredPrefixes: changeArtifactIgnoredPrefixes(changeId),
  });
  if (!buildBaseCampHasBlockingProblem(baseCamp, options)) return current;
  const details =
    baseCamp.blockers.length > 0
      ? baseCamp.blockers.join("; ")
      : !baseCamp.headSha
        ? "Git HEAD is missing."
        : `Base camp status is ${baseCamp.status}.`;
  return {
    ...current,
    enabled: false,
    reasonCode: "build_base_camp_blocked",
    reason: `Build workspace base camp blocked: ${details}`,
    blockers: (baseCamp.blockers.length > 0 ? baseCamp.blockers : [details]).map((title, index) => ({
      id: `build_base_camp_${index + 1}`,
      severity: "P1",
      title,
    })),
  };
}

function buildBaseCampHasBlockingProblem(
  baseCamp: GitBaseCampStatus,
  options: { blockDirtyStatus?: boolean } = {},
): boolean {
  return !baseCamp.headSha || baseCamp.blockers.length > 0 || (options.blockDirtyStatus === true && baseCamp.status !== "ready");
}
