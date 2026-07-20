import { eq } from "drizzle-orm";

import { changes, humanDecisions, testplanSnapshots } from "../db/schema";
import type { ActionContractDb, ActionDecision } from "./action-contract-types";
import type { getStageAuthority, recomputeStageGate, StageAuthoritySnapshot } from "./stage-authority-service";
import type { failQaRun, recomputeQaGate } from "./qa-run-service";
import { transitionChangeStatusWithDb } from "./change-status-service";

interface LegacyTestPlanSelfHealInput {
  changeId: string;
  changeStatus: string;
  current: ActionDecision;
  db: ActionContractDb;
  nowISO: () => string;
  nextAutoTestPlanDecisionId: () => string;
  hasOnlyTestPlanApprovalBlocker: (decision: ActionDecision) => boolean;
  gateDecision: (phase: "Build", snapshot: StageAuthoritySnapshot) => ActionDecision;
  withSnapshotGateFields: (
    decision: ActionDecision,
    snapshot: StageAuthoritySnapshot,
  ) => ActionDecision;
  latestTestPlanSnapshot: (changeId: string) => typeof testplanSnapshots.$inferSelect | null;
  testPlanSnapshotAuthorityRows: (
    changeId: string,
    snapshotId: string,
  ) => {
    coverageItems: unknown[];
    riskMappings: unknown[];
    requiredCommands: unknown[];
    manualChecks: unknown[];
  };
  getStageAuthority: typeof getStageAuthority;
  recomputeStageGate: typeof recomputeStageGate;
}

interface StuckCheckingQaSelfHealInput {
  change: typeof changes.$inferSelect;
  db: ActionContractDb;
  nowISO: () => string;
  latestLocalCheckRun: (changeId: string) => { id: string; status: string; summary: string | null; endedAt: string | null } | null;
  latestQaRunRecord: (changeId: string) => { id: string; status: string; completedAt: string | null } | null;
  qaRunHasFailureEvidence: (qaRunId: string) => boolean;
  failQaRun: typeof failQaRun;
  recomputeQaGate: typeof recomputeQaGate;
  recomputeStageGate: typeof recomputeStageGate;
}

export function selfHealLegacyTestPlanApprovalForBuild(
  input: LegacyTestPlanSelfHealInput,
): ActionDecision {
  const {
    changeId,
    changeStatus,
    current,
    db,
    nowISO,
    nextAutoTestPlanDecisionId,
    hasOnlyTestPlanApprovalBlocker,
    gateDecision,
    withSnapshotGateFields,
    latestTestPlanSnapshot,
    testPlanSnapshotAuthorityRows,
    getStageAuthority,
    recomputeStageGate,
  } = input;

  if (!["PLAN_APPROVED", "TESTPLAN_DONE"].includes(changeStatus) || !hasOnlyTestPlanApprovalBlocker(current)) {
    return current;
  }

  const latestAuthority = getStageAuthority(changeId, "TestPlan");
  const latestDecision = gateDecision("Build", latestAuthority);
  if (latestDecision.enabled) {
    return withSnapshotGateFields(latestDecision, latestAuthority);
  }
  if (
    latestAuthority.latestGate?.status !== "blocked" ||
    !hasOnlyTestPlanApprovalBlocker(latestDecision)
  ) {
    return current;
  }

  const snapshot = latestTestPlanSnapshot(changeId);
  if (!snapshot) {
    return current;
  }

  const approvedAt = nowISO();
  let approvedSnapshot: typeof testplanSnapshots.$inferSelect = snapshot;
  if (snapshot.approvalState !== "approved") {
    const decisionId = nextAutoTestPlanDecisionId();
    // The decision and the approval it justifies must land together, or a crash
    // leaves a human_decisions row claiming an approval the snapshot never got.
    db.transaction((tx) => {
      tx.insert(humanDecisions).values({
        id: decisionId,
        changeId,
        roundId: null,
        gate: "test_plan",
        action: "approve",
        targetType: "testplan_snapshot",
        targetId: snapshot.id,
        reason: "Auto-approve completed TestPlan legacy approval blocker",
        reportHash: snapshot.snapshotDbHash,
        createdBy: "system",
        createdAt: approvedAt,
      }).run();
      tx.update(testplanSnapshots)
        .set({
          status: "approved",
          approvalState: "approved",
          approvedAt,
          approvalDecisionId: decisionId,
        })
        .where(eq(testplanSnapshots.id, snapshot.id))
        .run();
    });
    approvedSnapshot = {
      ...snapshot,
      status: "approved",
      approvalState: "approved",
      approvedAt,
      approvalDecisionId: decisionId,
    };
  }

  const rows = testPlanSnapshotAuthorityRows(changeId, approvedSnapshot.id);
  recomputeStageGate({
    changeId,
    phase: "TestPlan",
    status: "passed",
    blockers: [],
    freshness: {
      fresh: true,
      sourceSnapshotId: approvedSnapshot.id,
      selfHealed: "legacy_testplan_approval",
    },
    requiredActions: [],
    // gateVersion is left to recomputeStageGate's own default, computed inside
    // its transaction against the live max -- latestAuthority above was read
    // outside that transaction and could be stale by the time this inserts.
    rows: [
      approvedSnapshot,
      ...rows.coverageItems,
      ...rows.riskMappings,
      ...rows.requiredCommands,
      ...rows.manualChecks,
    ],
  });

  const repairedAuthority = getStageAuthority(changeId, "TestPlan");
  return withSnapshotGateFields(gateDecision("Build", repairedAuthority), repairedAuthority);
}

export function selfHealStuckCheckingQa(
  input: StuckCheckingQaSelfHealInput,
): typeof changes.$inferSelect {
  const {
    change,
    db,
    nowISO,
    latestLocalCheckRun,
    latestQaRunRecord,
    qaRunHasFailureEvidence,
    failQaRun,
    recomputeQaGate,
    recomputeStageGate,
  } = input;

  if (change.status !== "CHECKING") return change;

  const latestCheck = latestLocalCheckRun(change.id);
  if (latestCheck?.status === "running") return change;

  const latestQa = latestQaRunRecord(change.id);
  const checkFailed = latestCheck?.status === "failed";
  const qaHasFailureEvidence = latestQa ? qaRunHasFailureEvidence(latestQa.id) : false;
  const qaFailed = latestQa?.status === "failed" || qaHasFailureEvidence;
  if (!checkFailed && !qaFailed) return change;

  const completedAt = latestCheck?.endedAt ?? latestQa?.completedAt ?? nowISO();
  const reason = latestCheck?.summary ?? "Recovered failed QA run";
  if (latestQa) {
    if (latestQa.status === "running" || !qaHasFailureEvidence) {
      failQaRun({ qaRunId: latestQa.id, reason, completedAt });
    }
    recomputeQaGate(change.id);
  } else {
    recomputeStageGate({
      changeId: change.id,
      phase: "QA",
      status: "failed",
      blockers: [{ id: latestCheck?.id ?? "local_check_failed", severity: "P1", title: reason }],
      freshness: { fresh: true, recoveredFrom: "stuck_checking", latestRunId: latestCheck?.id ?? null },
      requiredActions: ["retry_qa"],
      rows: latestCheck ? [{ table: "runs", ...latestCheck }] : [],
    });
  }

  // transitionChangeStatusWithDb writes changes and events; handed the bare db
  // handle they autocommit separately, so a crash between them advances the
  // status with no event behind it.
  return db.transaction((tx) => transitionChangeStatusWithDb(tx, {
    changeId: change.id,
    to: "CHECK_FAILED",
    message: "Recovered stuck CHECKING from failed QA evidence",
    rawJson: { source: "action_contract_self_heal" },
  }));
}
