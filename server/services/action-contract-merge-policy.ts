import { desc, eq } from "drizzle-orm";

import { mergeApprovals, mergeReadiness } from "../db/schema";
import type { ActionContractDb, ActionDecision, Blocker } from "./action-contract-types";
import { MISSING_GATE_SOURCE_DB_HASH, normalizeSeverity } from "./action-contract-common-policy";
import { computeMergeReadiness } from "./merge-readiness-service";

export function mergeDecision(changeId: string, requireApproval: boolean): ActionDecision {
  const readiness = computeMergeReadiness({ changeId, requireApproval, persist: requireApproval });
  if (readiness.status === "ready") {
    return {
      enabled: true,
      reasonCode: null,
      reason: null,
      blockers: [],
      sourceDbHash: readiness.sourceDbHash,
    };
  }
  const blockers = readiness.blockers.map((item) => ({
    id: item.id,
    severity: item.severity,
    title: item.title,
  }));
  const first = readiness.blockers[0];
  return {
    enabled: false,
    reasonCode: first?.reasonCode ?? "merge_blocked",
    reason: first?.title ?? "Merge is blocked",
    blockers,
    sourceDbHash: readiness.sourceDbHash,
  };
}

export function approveMergeDecision(db: ActionContractDb, changeId: string): ActionDecision {
  const existingApproval = db.select().from(mergeApprovals).where(eq(mergeApprovals.changeId, changeId)).get();
  if (existingApproval) {
    return {
      enabled: false,
      reasonCode: "merge_already_approved",
      reason: "Merge has already been approved",
      blockers: [],
    };
  }
  return mergeDecision(changeId, false);
}

// --- Persisted merge readiness (moved from the action-contract facade) ---
//
// The recompute path above and the persisted-readiness path below are the two
// halves of the same decision; they belong in one module.

function latestPersistedMergeReadiness(db: ActionContractDb, changeId: string): typeof mergeReadiness.$inferSelect | null {
  return db
    .select()
    .from(mergeReadiness)
    .where(eq(mergeReadiness.changeId, changeId))
    .orderBy(desc(mergeReadiness.computedAt), desc(mergeReadiness.id))
    .limit(1)
    .get() ?? null;
}

function parseMergeReadinessBlockers(
  readiness: typeof mergeReadiness.$inferSelect,
): Array<{
  id?: unknown;
  reasonCode?: unknown;
  severity?: unknown;
  title?: unknown;
}> {
  try {
    const parsed = JSON.parse(readiness.blockersJson ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mergeBlockersFromParsedReadiness(
  blockers: ReturnType<typeof parseMergeReadinessBlockers>,
): Blocker[] {
  return blockers.map((blocker, index) => ({
    id:
      typeof blocker.id === "string"
        ? blocker.id
        : typeof blocker.reasonCode === "string"
          ? blocker.reasonCode
          : `merge_blocker_${index + 1}`,
    severity: normalizeSeverity(blocker.severity),
    title:
      typeof blocker.title === "string"
        ? blocker.title
        : "Merge is blocked",
  }));
}

function mergeDecisionFromPersistedReadinessBlockers(
  readiness: typeof mergeReadiness.$inferSelect,
  rawBlockers: ReturnType<typeof parseMergeReadinessBlockers>,
): ActionDecision {
  if (rawBlockers.length === 0) {
    return {
      enabled: true,
      reasonCode: null,
      reason: null,
      blockers: [],
      sourceDbHash: readiness.sourceDbHash ?? MISSING_GATE_SOURCE_DB_HASH,
    };
  }
  const firstRaw = rawBlockers[0];
  return {
    enabled: false,
    reasonCode: typeof firstRaw?.reasonCode === "string" ? firstRaw.reasonCode : "merge_blocked",
    reason: typeof firstRaw?.title === "string" ? firstRaw.title : "Merge is blocked",
    blockers: mergeBlockersFromParsedReadiness(rawBlockers),
    sourceDbHash: readiness.sourceDbHash ?? MISSING_GATE_SOURCE_DB_HASH,
  };
}

function mergeReadinessMissingDecision(): ActionDecision {
  return {
    enabled: false,
    reasonCode: "merge_readiness_missing",
    reason: "Merge readiness has not been computed",
    blockers: [],
  };
}

export function mergeDecisionFromPersistedReadiness(db: ActionContractDb, changeId: string): ActionDecision {
  const readiness = latestPersistedMergeReadiness(db, changeId);
  if (!readiness) {
    return mergeReadinessMissingDecision();
  }
  return mergeDecisionFromPersistedReadinessBlockers(
    readiness,
    readiness.status === "ready" ? [] : parseMergeReadinessBlockers(readiness),
  );
}

export function approveMergeDecisionFromPersistedReadiness(db: ActionContractDb, changeId: string): ActionDecision {
  const existingApproval = db
    .select()
    .from(mergeApprovals)
    .where(eq(mergeApprovals.changeId, changeId))
    .get();
  if (existingApproval) {
    return {
      enabled: false,
      reasonCode: "merge_already_approved",
      reason: "Merge has already been approved",
      blockers: [],
    };
  }
  const readiness = latestPersistedMergeReadiness(db, changeId);
  if (!readiness) {
    return mergeReadinessMissingDecision();
  }
  return mergeDecisionFromPersistedReadinessBlockers(
    readiness,
    parseMergeReadinessBlockers(readiness).filter(
      (blocker) => blocker.reasonCode !== "merge_approval_missing",
    ),
  );
}
