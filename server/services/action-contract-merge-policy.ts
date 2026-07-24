import { desc, eq } from "drizzle-orm";

import { mergeApprovals, mergeReadiness } from "../db/schema";
import type { ActionContractDb, ActionDecision, Blocker } from "./action-contract-types";
import { MISSING_GATE_SOURCE_DB_HASH, normalizeSeverity, readJson } from "./action-contract-common-policy";
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

type RawMergeBlocker = {
  id?: unknown;
  reasonCode?: unknown;
  severity?: unknown;
  title?: unknown;
};

/**
 * Reads the stored blocker payload, or null when it cannot be read as a list.
 *
 * Parsing is delegated to the shared `readJson` so this module does not carry a
 * second, independently-drifting JSON.parse of the same column. What is *not*
 * shared is the reaction to failure, and deliberately so: in `gateDecision` the
 * blocker list is only the explanation for a verdict `gate.status` already
 * decided, so degrading to an empty list there loses detail and nothing more.
 * Here the list *is* the verdict -- emptiness is the enable predicate -- so the
 * caller has to be able to tell "no blockers" from "no readable answer".
 * Collapsing those two used to hand a corrupt row more permission than a
 * well-formed one.
 */
function readMergeReadinessBlockers(
  readiness: typeof mergeReadiness.$inferSelect,
): RawMergeBlocker[] | null {
  const parsed = readJson(readiness.blockersJson);
  return Array.isArray(parsed) ? (parsed as RawMergeBlocker[]) : null;
}

/**
 * A readiness row that says "blocked" but cannot show why. Fail closed: the
 * stored blockers are the only evidence the persisted path has, and unreadable
 * evidence must never read as "nothing is wrong". P0 because the row is
 * corrupt, not merely unsatisfied -- a human has to look at the database.
 */
function unreadableMergeBlockersDecision(
  readiness: typeof mergeReadiness.$inferSelect,
  reasonCode: "merge_blockers_unreadable" | "merge_blockers_inconsistent",
  reason: string,
): ActionDecision {
  return {
    enabled: false,
    reasonCode,
    reason,
    blockers: [{ id: reasonCode, severity: "P0", title: reason }],
    sourceDbHash: readiness.sourceDbHash ?? MISSING_GATE_SOURCE_DB_HASH,
  };
}

function mergeBlockersFromParsedReadiness(
  blockers: RawMergeBlocker[],
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
  rawBlockers: RawMergeBlocker[],
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
  // A "ready" row never consults the payload, so a corrupt one cannot
  // retroactively block a change that genuinely passed.
  if (readiness.status === "ready") {
    return mergeDecisionFromPersistedReadinessBlockers(readiness, []);
  }
  const rawBlockers = readMergeReadinessBlockers(readiness);
  if (!rawBlockers) {
    return unreadableMergeBlockersDecision(
      readiness,
      "merge_blockers_unreadable",
      "Merge readiness blockers could not be read",
    );
  }
  // computeMergeReadiness derives status as `blockers.length === 0 ? ready :
  // blocked`, so "blocked" with an empty list cannot be written by the normal
  // path. If it shows up anyway the two encodings of the same fact disagree,
  // and the permissive reading is the one that must not win.
  if (rawBlockers.length === 0) {
    return unreadableMergeBlockersDecision(
      readiness,
      "merge_blockers_inconsistent",
      "Merge readiness is blocked but lists no blockers",
    );
  }
  return mergeDecisionFromPersistedReadinessBlockers(readiness, rawBlockers);
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
  const rawBlockers = readMergeReadinessBlockers(readiness);
  if (!rawBlockers) {
    return unreadableMergeBlockersDecision(
      readiness,
      "merge_blockers_unreadable",
      "Merge readiness blockers could not be read",
    );
  }
  // Unlike the merge decision, an empty list here is legitimate: the missing
  // approval is exactly what this action exists to clear, so a readiness
  // blocked on nothing else must still let the approval through.
  return mergeDecisionFromPersistedReadinessBlockers(
    readiness,
    rawBlockers.filter((blocker) => blocker.reasonCode !== "merge_approval_missing"),
  );
}
