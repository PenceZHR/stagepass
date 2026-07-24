import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  changes,
  humanDecisions,
  planApprovals,
  planRisks,
  planSnapshots,
  testplanSnapshots,
} from "../db/schema";
import { getActions } from "./action-contract-service";
import { transitionChangeStatusWithDb } from "./change-status-service";
import { latestPlanSnapshot } from "./plan-snapshot-service";
import { getStageAuthority } from "./stage-authority-service";
import { nextSequencedId as nextPrefixedId } from "./record-identity";

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

type PlanApprovalDb = Pick<typeof db, "select" | "insert" | "update">;

export function approvePlanSnapshotWithDb(
  planDb: PlanApprovalDb,
  input: {
    changeId: string;
    decisionId: string;
    actor?: string;
  },
): string {
  const snapshot = planDb
    .select()
    .from(planSnapshots)
    .where(eq(planSnapshots.changeId, input.changeId))
    .all()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (!snapshot) {
    throw new Error("Plan cannot be approved: missing DB Plan snapshot");
  }
  if (snapshot.status !== "ready" && snapshot.status !== "approved") {
    throw new Error(`Plan cannot be approved: ${snapshot.status}`);
  }
  const now = new Date().toISOString();
  if (snapshot.status === "ready") {
    planDb
      .insert(planApprovals)
      .values({
        id: `PLAN-APPROVAL-CMD-${input.decisionId}`,
        planSnapshotId: snapshot.id,
        decisionId: input.decisionId,
        actor: input.actor ?? "human",
        approvedAt: now,
      })
      .onConflictDoNothing()
      .run();
    planDb
      .update(planSnapshots)
      .set({
        status: "approved",
        approvedAt: now,
        approvalDecisionId: input.decisionId,
      })
      .where(eq(planSnapshots.id, snapshot.id))
      .run();
  }
  const change = planDb.select().from(changes)
    .where(eq(changes.id, input.changeId)).get();
  if (change?.status === "PLAN_READY") {
    transitionChangeStatusWithDb(
      planDb as Parameters<typeof transitionChangeStatusWithDb>[0],
      {
        changeId: input.changeId,
        to: "PLAN_APPROVED",
        gateState: "plan",
        message: "Plan approved",
        rawJson: { source: "pipeline_command", decisionId: input.decisionId },
      },
    );
  }
  return input.decisionId;
}

export function rejectPlanSnapshotWithDb(
  planDb: PlanApprovalDb,
  input: { changeId: string; reason: string },
): void {
  const change = planDb.select().from(changes)
    .where(eq(changes.id, input.changeId)).get();
  if (!change || change.status !== "PLAN_READY") {
    throw new Error("reject_plan_not_at_gate");
  }
  transitionChangeStatusWithDb(
    planDb as Parameters<typeof transitionChangeStatusWithDb>[0],
    {
      changeId: input.changeId,
      to: "TECHSPEC_READY",
      gateState: "tech_spec",
      message: "Plan rejected",
      rawJson: { source: "pipeline_command", reason: input.reason },
    },
  );
}

export function waivePlanP1WithDb(
  planDb: PlanApprovalDb,
  input: { changeId: string; riskId: string; reason: string },
): void {
  const snapshot = planDb.select().from(planSnapshots)
    .where(eq(planSnapshots.changeId, input.changeId)).all()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (!snapshot) throw new Error("plan_snapshot_missing");
  const risk = planDb.select().from(planRisks)
    .where(eq(planRisks.id, input.riskId)).get();
  if (
    !risk
    || risk.planSnapshotId !== snapshot.id
    || risk.severity !== "P1"
    || risk.status !== "open"
  ) {
    throw new Error("plan_p1_waiver_not_allowed");
  }
  if (!input.reason.trim()) throw new Error("decision_reason_required");
  planDb.update(planRisks).set({ status: "waived" })
    .where(eq(planRisks.id, risk.id)).run();
}

export function confirmTestPlanWithDb(
  planDb: PlanApprovalDb,
  input: { changeId: string; confirmation: true; decisionId: string },
): void {
  const change = planDb.select().from(changes)
    .where(eq(changes.id, input.changeId)).get();
  if (!change || change.status !== "TESTPLAN_DONE") {
    throw new Error("approve_test_plan_not_at_gate");
  }
  const snapshot = planDb.select().from(testplanSnapshots)
    .where(eq(testplanSnapshots.changeId, input.changeId)).all()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (!snapshot || snapshot.approvalState !== "approved") {
    throw new Error("testplan_snapshot_not_approved");
  }
  transitionChangeStatusWithDb(
    planDb as Parameters<typeof transitionChangeStatusWithDb>[0],
    {
      changeId: input.changeId,
      to: "PLAN_APPROVED",
      gateState: "test_plan",
      message: "TestPlan confirmed",
      rawJson: {
        source: "pipeline_command",
        decisionId: input.decisionId,
      },
    },
  );
}

export function rejectTestPlanWithDb(
  planDb: PlanApprovalDb,
  input: { changeId: string; reason: string },
): void {
  const change = planDb.select().from(changes)
    .where(eq(changes.id, input.changeId)).get();
  if (!change || change.status !== "TESTPLAN_DONE") {
    throw new Error("reject_test_plan_not_at_gate");
  }
  transitionChangeStatusWithDb(
    planDb as Parameters<typeof transitionChangeStatusWithDb>[0],
    {
      changeId: input.changeId,
      to: "PLAN_APPROVED",
      gateState: "plan",
      message: "TestPlan rejected",
      rawJson: { source: "pipeline_command", reason: input.reason },
    },
  );
}
