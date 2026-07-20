import { eq } from "drizzle-orm";

import { db } from "../db";
import { humanDecisions, planApprovals, planSnapshots } from "../db/schema";
import { getActions } from "./action-contract-service";
import { latestPlanSnapshot } from "./plan-snapshot-service";
import { getStageAuthority } from "./stage-authority-service";

function nextPrefixedId(ids: string[], prefix: string): string {
  const used = new Set(ids);
  let maxNum = 0;
  for (const id of ids) {
    const match = id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) maxNum = Math.max(maxNum, Number.parseInt(match[1], 10));
  }

  let nextNum = maxNum + 1;
  let candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;
  while (used.has(candidate)) {
    nextNum += 1;
    candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;
  }
  return candidate;
}

function nextHumanDecisionId(): string {
  return nextPrefixedId(
    db.select({ id: humanDecisions.id }).from(humanDecisions).all().map((row) => row.id),
    "DEC"
  );
}

function nextPlanApprovalId(): string {
  return nextPrefixedId(
    db.select({ id: planApprovals.id }).from(planApprovals).all().map((row) => row.id),
    "PLAN-APPROVAL"
  );
}

export function assertPlanCanApprove(changeId: string): void {
  const snapshot = latestPlanSnapshot(changeId);
  const authority = getStageAuthority(changeId, "Plan");
  const gate = authority.latestGate;
  if (!snapshot || !gate) {
    throw new Error("Plan cannot be approved: missing DB Plan snapshot or gate");
  }
  if (snapshot.status === "approved") {
    return;
  }
  if (snapshot.status !== "ready" || gate.status !== "passed") {
    const blockers = gate.blockersJson ?? "[]";
    throw new Error(`Plan cannot be approved: ${snapshot.status}, gate:${gate.status}, blockers:${blockers}`);
  }
  if (gate.sourceDbHash !== snapshot.snapshotDbHash) {
    throw new Error("Plan cannot be approved: source_db_hash_drift");
  }
}

export function approvePlanSnapshot(changeId: string, actor = "human"): string {
  assertPlanCanApprove(changeId);
  const snapshot = latestPlanSnapshot(changeId);
  if (!snapshot) {
    throw new Error("Plan cannot be approved: missing DB Plan snapshot");
  }
  if (snapshot.status === "approved" && snapshot.approvalDecisionId) {
    return snapshot.approvalDecisionId;
  }

  const now = new Date().toISOString();
  const decisionId = nextHumanDecisionId();
  const approvalId = nextPlanApprovalId();
  db.transaction((tx) => {
    tx.insert(humanDecisions).values({
      id: decisionId,
      changeId,
      roundId: null,
      gate: "Plan",
      action: "approve_plan",
      targetType: "plan_snapshot",
      targetId: snapshot.id,
      reason: "Plan approved from DB Plan snapshot",
      reportHash: snapshot.snapshotDbHash,
      createdBy: actor,
      createdAt: now,
    }).run();
    tx.insert(planApprovals).values({
      id: approvalId,
      planSnapshotId: snapshot.id,
      decisionId,
      actor,
      approvedAt: now,
    }).run();
    tx.update(planSnapshots)
      .set({
        status: "approved",
        approvedAt: now,
        approvalDecisionId: decisionId,
      })
      .where(eq(planSnapshots.id, snapshot.id))
      .run();
  });
  getActions(changeId);
  return decisionId;
}
