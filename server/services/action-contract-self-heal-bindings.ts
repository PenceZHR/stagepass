import { randomUUID } from "node:crypto";

import { and, asc, desc, eq } from "drizzle-orm";

import {
  changes,
  qaCommandResults,
  qaFailures,
  qaRuns,
  requiredValidationCommands,
  runs,
  testplanCoverageItems,
  testplanManualChecks,
  testplanRiskMappings,
  testplanSnapshots,
} from "../db/schema";
import type { ActionContractDb, ActionDecision } from "./action-contract-types";
import {
  gateDecision,
  sortNewestRun,
  withSnapshotGateFields,
} from "./action-contract-common-policy";
import {
  selfHealLegacyTestPlanApprovalForBuild as selfHealLegacyTestPlanApprovalForBuildWithDeps,
  selfHealStuckCheckingQa as selfHealStuckCheckingQaWithDeps,
} from "./action-contract-self-heal-service";
import { getStageAuthority, recomputeStageGate } from "./stage-authority-service";
import { failQaRun, recomputeQaGate } from "./qa-run-service";

/**
 * Bindings for the two self-heal repairs. action-contract-self-heal-service is
 * fully dependency-injected — it takes a deps bag rather than importing anything
 * — so somebody has to assemble that bag. That assembly (and the DB reads it
 * needs: the latest TestPlan snapshot and its authority rows, the latest local
 * check run, the latest QA run and its failure evidence) used to sit in the
 * action-contract facade. It lives here now.
 *
 * The writes stay inside action-contract-self-heal-service, which is where the
 * db-write policy already registers them. This module only reads.
 */

function nowISO(): string {
  return new Date().toISOString();
}

function hasOnlyTestPlanApprovalBlocker(decision: ActionDecision): boolean {
  return (
    !decision.enabled &&
    decision.blockers.length > 0 &&
    decision.blockers.every((blocker) => blocker.id === "testplan_approval")
  );
}

function nextAutoTestPlanDecisionId(): string {
  return `HD-${randomUUID()}`;
}

function latestTestPlanSnapshot(db: ActionContractDb, changeId: string): typeof testplanSnapshots.$inferSelect | null {
  return (
    db
      .select()
      .from(testplanSnapshots)
      .where(eq(testplanSnapshots.changeId, changeId))
      .orderBy(desc(testplanSnapshots.createdAt), desc(testplanSnapshots.id))
      .limit(1)
      .get() ?? null
  );
}

function testPlanSnapshotAuthorityRows(db: ActionContractDb, changeId: string, snapshotId: string) {
  const coverageItems = db
    .select()
    .from(testplanCoverageItems)
    .where(eq(testplanCoverageItems.testplanSnapshotId, snapshotId))
    .orderBy(asc(testplanCoverageItems.id))
    .all();
  const riskMappings = db
    .select()
    .from(testplanRiskMappings)
    .where(eq(testplanRiskMappings.testplanSnapshotId, snapshotId))
    .orderBy(asc(testplanRiskMappings.id))
    .all();
  const requiredCommands = db
    .select()
    .from(requiredValidationCommands)
    .where(
      and(
        eq(requiredValidationCommands.changeId, changeId),
        eq(requiredValidationCommands.phase, "TestPlan"),
        eq(requiredValidationCommands.sourceSnapshotId, snapshotId),
      ),
    )
    .orderBy(asc(requiredValidationCommands.commandOrder), asc(requiredValidationCommands.id))
    .all();
  const manualChecks = db
    .select()
    .from(testplanManualChecks)
    .where(eq(testplanManualChecks.testplanSnapshotId, snapshotId))
    .orderBy(asc(testplanManualChecks.id))
    .all();
  return { coverageItems, riskMappings, requiredCommands, manualChecks };
}

export function selfHealLegacyTestPlanApprovalForBuild(
  db: ActionContractDb,
  changeId: string,
  changeStatus: string,
  current: ActionDecision,
): ActionDecision {
  return selfHealLegacyTestPlanApprovalForBuildWithDeps({
    changeId,
    changeStatus,
    current,
    db,
    nowISO,
    nextAutoTestPlanDecisionId,
    hasOnlyTestPlanApprovalBlocker,
    gateDecision,
    withSnapshotGateFields,
    // The self-heal service calls these without a db, so bind it in here.
    latestTestPlanSnapshot: (id) => latestTestPlanSnapshot(db, id),
    testPlanSnapshotAuthorityRows: (id, snapshotId) => testPlanSnapshotAuthorityRows(db, id, snapshotId),
    getStageAuthority,
    recomputeStageGate,
  });
}

function latestLocalCheckRun(db: ActionContractDb, changeId: string): typeof runs.$inferSelect | null {
  return sortNewestRun(
    db
      .select()
      .from(runs)
      .where(and(eq(runs.changeId, changeId), eq(runs.phase, "local_check")))
      .all(),
  );
}

function latestQaRunRecord(db: ActionContractDb, changeId: string): typeof qaRuns.$inferSelect | null {
  return sortNewestRun(
    db
      .select()
      .from(qaRuns)
      .where(eq(qaRuns.changeId, changeId))
      .all(),
  );
}

function qaRunHasFailureEvidence(db: ActionContractDb, qaRunId: string): boolean {
  return Boolean(
    db
      .select({ id: qaCommandResults.id })
      .from(qaCommandResults)
      .where(and(eq(qaCommandResults.qaRunId, qaRunId), eq(qaCommandResults.status, "failed")))
      .get(),
  ) || Boolean(
    db
      .select({ id: qaFailures.id })
      .from(qaFailures)
      .where(eq(qaFailures.qaRunId, qaRunId))
      .get(),
  );
}

export function selfHealStuckCheckingQa(
  db: ActionContractDb,
  change: typeof changes.$inferSelect,
): typeof changes.$inferSelect {
  return selfHealStuckCheckingQaWithDeps({
    change,
    db,
    nowISO,
    latestLocalCheckRun: (id) => latestLocalCheckRun(db, id),
    latestQaRunRecord: (id) => latestQaRunRecord(db, id),
    qaRunHasFailureEvidence: (qaRunId) => qaRunHasFailureEvidence(db, qaRunId),
    failQaRun,
    recomputeQaGate,
    recomputeStageGate,
  });
}

