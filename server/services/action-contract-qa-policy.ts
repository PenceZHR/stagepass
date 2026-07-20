import { and, asc, desc, eq } from "drizzle-orm";

import {
  changes,
  qaRuns,
  requiredValidationCommands,
  runs,
  testplanSnapshots,
} from "../db/schema";
import {
  gateDecision,
  normalizeBlockers,
  readJson,
} from "./action-contract-common-policy";
import {
  latestReviewReportSource,
  reviewFindingBlockers,
} from "./action-contract-review-policy";
import type { ActionContractDb, ActionDecision } from "./action-contract-types";
import {
  assertCanEnterQa,
  ReviewQaGateError,
  type ReviewQaGateResult,
} from "./review-qa-gate-service";
import type { StageAuthoritySnapshot } from "./stage-authority-service";

export function reviewBlockerReason(details: ReviewQaGateResult): Pick<ActionDecision, "reasonCode" | "reason"> {
  if (details.counts.blockingP0 > 0) {
    return { reasonCode: "review_open_p0", reason: "Review has open P0 blockers" };
  }
  if (details.counts.blockingP1 > 0) {
    return { reasonCode: "review_open_p1", reason: "Review has open P1 blockers" };
  }
  return { reasonCode: "review_not_allowed", reason: details.reason ?? "Review is not ready for QA" };
}

export function enterQaDecision(
  db: ActionContractDb,
  changeId: string,
  testPlanSnapshot: StageAuthoritySnapshot,
): ActionDecision | null {
  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  if (!change) return null;
  try {
    assertCanEnterQa({
      projectId: change.projectId,
      changeId,
      entrypoint: "api_check_route",
      actor: "human",
    });
  } catch (error) {
    if (!(error instanceof ReviewQaGateError)) throw error;
    const reason = error.code === "review_blockers"
      ? reviewBlockerReason(error.details)
      : { reasonCode: error.code, reason: error.details.reason ?? error.message };
    return {
      enabled: false,
      ...reason,
      blockers: reviewFindingBlockers(db, changeId),
    };
  }

  const testPlanDecision = testPlanDecisionForQa(db, changeId, testPlanSnapshot);
  if (!testPlanDecision.enabled) return testPlanDecision;

  return {
    enabled: true,
    reasonCode: null,
    reason: null,
    blockers: [],
    ...latestReviewReportSource(db, changeId),
  };
}

export function hasRunningQaCheck(db: ActionContractDb, changeId: string): boolean {
  return Boolean(
    db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.changeId, changeId), eq(runs.phase, "local_check"), eq(runs.status, "running")))
      .get(),
  ) || Boolean(
    db
      .select({ id: qaRuns.id })
      .from(qaRuns)
      .where(and(eq(qaRuns.changeId, changeId), eq(qaRuns.status, "running")))
      .get(),
  );
}

export function retryQaDecision(
  db: ActionContractDb,
  changeId: string,
  changeStatus: string,
  snapshot: StageAuthoritySnapshot,
  testPlanSnapshot: StageAuthoritySnapshot,
): ActionDecision {
  const gate = snapshot.latestGate;
  if (changeStatus === "CHECKING" || gate?.status === "running" || hasRunningQaCheck(db, changeId)) {
    return {
      enabled: false,
      reasonCode: "qa_running",
      reason: "QA is already running",
      blockers: normalizeBlockers(readJson(gate?.blockersJson ?? null)),
      gateVersion: gate ? String(gate.gateVersion) : undefined,
      sourceDbHash: gate?.sourceDbHash ?? undefined,
    };
  }

  const current = gateDecision("QA", snapshot);
  if (changeStatus !== "CHECK_FAILED" || gate?.status !== "failed") {
    return current;
  }

  const qaPrerequisites = enterQaDecision(db, changeId, testPlanSnapshot) ?? {
    enabled: false,
    reasonCode: "review_not_allowed",
    reason: "Review is not ready for QA",
    blockers: [],
  };
  if (!qaPrerequisites.enabled) return qaPrerequisites;

  return {
    enabled: true,
    reasonCode: null,
    reason: null,
    blockers: current.blockers,
    gateVersion: String(gate.gateVersion),
    sourceDbHash: gate.sourceDbHash ?? undefined,
  };
}

export function testPlanDecisionForQa(
  db: ActionContractDb,
  changeId: string,
  snapshot: StageAuthoritySnapshot,
): ActionDecision {
  const decision = gateDecision("TestPlan", snapshot);
  if (decision.enabled) {
    const latestApprovedSnapshot =
      db
        .select()
        .from(testplanSnapshots)
        .where(and(eq(testplanSnapshots.changeId, changeId), eq(testplanSnapshots.approvalState, "approved")))
        .orderBy(desc(testplanSnapshots.approvedAt), desc(testplanSnapshots.createdAt), desc(testplanSnapshots.id))
        .limit(1)
        .get() ?? null;
    if (!latestApprovedSnapshot) {
      return {
        enabled: false,
        reasonCode: "test_plan_snapshot_missing",
        reason: "Latest approved TestPlan snapshot is missing",
        blockers: [{ id: "testplan_snapshot", severity: "P1", title: "Latest approved TestPlan snapshot is missing" }],
      };
    }
    const commands = db
      .select()
      .from(requiredValidationCommands)
      .where(
        and(
          eq(requiredValidationCommands.changeId, changeId),
          eq(requiredValidationCommands.phase, "TestPlan"),
          eq(requiredValidationCommands.sourceSnapshotId, latestApprovedSnapshot.id),
          eq(requiredValidationCommands.required, 1),
        ),
      )
      .orderBy(asc(requiredValidationCommands.commandOrder), asc(requiredValidationCommands.id))
      .all();
    if (commands.length > 0) return decision;
    return {
      enabled: false,
      reasonCode: "test_plan_commands_missing",
      reason: "TestPlan required commands are missing",
      blockers: [{ id: "testplan_commands", severity: "P1", title: "TestPlan required commands are missing" }],
    };
  }
  return {
    enabled: false,
    reasonCode: decision.reasonCode === "test_plan_gate_missing"
      ? "test_plan_gate_missing"
      : "test_plan_blocked",
    reason: decision.reason ?? "TestPlan gate is blocked",
    blockers: decision.blockers,
  };
}
