import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { db } from "../db";
import { withSqliteWriteRetry } from "../db/write-boundary";
import {
  battleRounds,
  buildRunRecords,
  changes,
  events,
  pipelineJobs,
  providerRunProcesses,
  reviewAttempts,
  reviewReports,
  reviewState,
  runs,
  stageRuns,
} from "../db/schema";
import type { ChangeStatus } from "../types";
import { ALLOWED_TRANSITIONS } from "../state-machine/transitions";
import { transitionChangeStatusWithDb } from "./change-status-service";
import type { ProviderRunProcess } from "./provider-run-lifecycle-service";
import type {
  BusinessEvidenceObservation,
  RecoveryDecision,
  RecoveryObservation,
  RecoveryOwnership,
  StaleProviderRunRecoveryResult,
} from "./recovery-types";
import { DEFAULT_MAX_REVIEW_FINDINGS } from "./recovery-types";
import {
  canonicalOwnershipPhase,
  inArrayValue,
  isCanonicalUtcIsoTimestamp,
  jobFreshnessMatches,
  providerFreshnessMatches,
  providerOwnershipMatchesRun,
  sameFence,
} from "./recovery-predicates";
import { fileObservationsMatch } from "./recovery-evidence";
import {
  captureEvidenceDbSnapshot,
  documentStagePhases,
} from "./recovery-business-evidence";

/**
 * Transactional recovery executors: the four write paths that reconcile a stale
 * provider run (missing provider, existing running provider, terminal run, and
 * post-commit evidence-drift compensation) plus the ownership helper and status
 * mappings they share. Each executor wraps a single short SQLite transaction in
 * withSqliteWriteRetry, guards every write with a compare-and-set, and returns
 * null (or throws RecoveryCasMissError, caught locally) when the observed state
 * no longer matches — never partially committing. Extracted from the recovery
 * orchestrator so the ~1000 lines of write logic live apart from candidate
 * selection and dispatch; the loop dependency is broken by inlining the evidence
 * DB-query hook type and the review-findings default rather than importing the
 * orchestrator's option type. Behavior is unchanged from the in-orchestrator
 * version.
 */

type RecoveryDb = typeof db;

type EvidenceDbQueryHook = (
  phase: string,
  scope: "observation" | "transaction",
) => void;

class RecoveryCasMissError extends Error {}

const fallbackStatusByProviderPhase: Partial<Record<string, ChangeStatus>> = {
  intake: "BLOCKED",
  spec: "BLOCKED",
  spec_critic: "BLOCKED",
  tech_spec: "SPEC_READY",
  generate_plan: "TECHSPEC_READY",
  test_plan: "PLAN_APPROVED",
  implement: "PLAN_APPROVED",
  review: "IMPLEMENTED",
  local_check: "CHECK_FAILED",
  fix_findings: "CHECK_FAILED",
  release: "MERGE_READY",
  retro: "RETRO_PENDING",
};

const completedStatusByProviderPhase: Partial<Record<string, ChangeStatus>> = {
  intake: "INTAKE_READY",
  spec: "SPEC_READY",
  spec_critic: "SPEC_READY",
  tech_spec: "TECHSPEC_READY",
  generate_plan: "PLAN_READY",
  test_plan: "TESTPLAN_DONE",
  implement: "IMPLEMENTED",
  review: "IMPLEMENTED",
  release: "RETRO_PENDING",
  retro: "DONE",
};

export function determineRecoveryOwnership(
  ownershipDb: Pick<RecoveryDb, "select">,
  run: typeof runs.$inferSelect,
): RecoveryOwnership {
  if (!run.jobId) {
    if (!isCanonicalUtcIsoTimestamp(run.startedAt)) {
      return {
        currentJob: null,
        ownershipMismatch: false,
        newerAttemptExists: true,
        oldJobOwned: false,
        ownsChange: false,
      };
    }
    const invalidDifferentJobExists = Boolean(
      ownershipDb.select({ id: pipelineJobs.id }).from(pipelineJobs).where(and(
        eq(pipelineJobs.changeId, run.changeId),
        sql`NOT (
          length(${pipelineJobs.createdAt}) = 24
          AND ${pipelineJobs.createdAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
          AND julianday(${pipelineJobs.createdAt}) IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', ${pipelineJobs.createdAt}) = ${pipelineJobs.createdAt}
        )`,
      )).limit(1).get(),
    );
    const differentJobExists = invalidDifferentJobExists || Boolean(
      ownershipDb.select({ id: pipelineJobs.id }).from(pipelineJobs).where(and(
        eq(pipelineJobs.changeId, run.changeId),
        gte(pipelineJobs.createdAt, run.startedAt),
      )).limit(1).get(),
    );
    return {
      currentJob: null,
      ownershipMismatch: false,
      newerAttemptExists: differentJobExists,
      oldJobOwned: false,
      ownsChange: !differentJobExists,
    };
  }

  const currentJob = ownershipDb.select().from(pipelineJobs)
    .where(eq(pipelineJobs.id, run.jobId)).get() ?? null;
  if (
    currentJob
    && (
      currentJob.changeId !== run.changeId
      || canonicalOwnershipPhase(currentJob.phase) !== canonicalOwnershipPhase(run.phase)
    )
  ) {
    return {
      currentJob,
      ownershipMismatch: true,
      newerAttemptExists: true,
      oldJobOwned: false,
      ownsChange: false,
    };
  }
  if (!currentJob || !isCanonicalUtcIsoTimestamp(currentJob.createdAt)) {
    return {
      currentJob,
      ownershipMismatch: false,
      newerAttemptExists: true,
      oldJobOwned: false,
      ownsChange: false,
    };
  }

  const sameJobFenceChanged = !sameFence(run, currentJob);
  const invalidDifferentJobExists = Boolean(
    ownershipDb.select({ id: pipelineJobs.id }).from(pipelineJobs).where(and(
      eq(pipelineJobs.changeId, run.changeId),
      ne(pipelineJobs.id, currentJob.id),
      sql`NOT (
        length(${pipelineJobs.createdAt}) = 24
        AND ${pipelineJobs.createdAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND julianday(${pipelineJobs.createdAt}) IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', ${pipelineJobs.createdAt}) = ${pipelineJobs.createdAt}
      )`,
    )).limit(1).get(),
  );
  const differentCurrentOrNewerJobExists = Boolean(
    ownershipDb.select({ id: pipelineJobs.id }).from(pipelineJobs).where(and(
      eq(pipelineJobs.changeId, run.changeId),
      ne(pipelineJobs.id, currentJob.id),
      sql`
        length(${pipelineJobs.createdAt}) = 24
        AND ${pipelineJobs.createdAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND julianday(${pipelineJobs.createdAt}) IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', ${pipelineJobs.createdAt}) = ${pipelineJobs.createdAt}
      `,
      gte(pipelineJobs.createdAt, currentJob.createdAt),
    )).limit(1).get(),
  );
  const newerAttemptExists = sameJobFenceChanged
    || invalidDifferentJobExists
    || differentCurrentOrNewerJobExists;
  const oldJobOwned = !sameJobFenceChanged;
  return {
    currentJob,
    ownershipMismatch: false,
    newerAttemptExists,
    oldJobOwned,
    ownsChange: !newerAttemptExists,
  };
}

function eqNullable(column: typeof pipelineJobs.leaseToken, value: string | null) {
  return value === null ? isNull(column) : eq(column, value);
}


export function recoverMissingProvider(input: {
  run: typeof runs.$inferSelect;
  reasonCode:
    | "provider_start_missing"
    | "legacy_lifecycle_missing"
    | "stale_lease_fenced"
    | "provider_lease_expired";
  recoveredAt: string;
  observation?: RecoveryObservation;
  assertWithinBudget?: () => void;
  beforeCommitForTest?: () => void;
}): StaleProviderRunRecoveryResult | null {
  const { run, reasonCode, recoveredAt, observation, assertWithinBudget, beforeCommitForTest } = input;
  const syntheticProcessId = `PRP-RECOVERY-${run.id}-${run.attemptNo ?? 0}`;
  let recovered: boolean;
  try {
    recovered = withSqliteWriteRetry("stale-provider-run.recover-missing-provider", () => {
      assertWithinBudget?.();
      return db.transaction((tx) => {
      const ownership = determineRecoveryOwnership(tx as unknown as RecoveryDb, run);
      if (ownership.ownershipMismatch) return false;
      const { currentJob, oldJobOwned, ownsChange } = ownership;
      const runCas = tx.update(runs)
        .set({ status: "failed", endedAt: recoveredAt, summary: reasonCode })
        .where(and(
          eq(runs.id, run.id),
          eq(runs.status, "running"),
          run.startedAt === null ? isNull(runs.startedAt) : eq(runs.startedAt, run.startedAt),
          run.leaseToken === null ? isNull(runs.leaseToken) : eq(runs.leaseToken, run.leaseToken),
          run.attemptNo === null ? isNull(runs.attemptNo) : eq(runs.attemptNo, run.attemptNo),
        ))
        .run();
      if (runCas.changes !== 1) return false;

      if (currentJob && inArrayValue(currentJob.status, ["leased", "running"]) && oldJobOwned) {
        const jobCas = tx.update(pipelineJobs)
          .set({
            status: "failed",
            leaseExpiresAt: null,
            endedAt: recoveredAt,
            heartbeatAt: recoveredAt,
            errorCode: reasonCode,
            errorSummary: reasonCode,
          })
          .where(and(
            eq(pipelineJobs.id, currentJob.id),
            inArray(pipelineJobs.status, ["leased", "running"]),
            eq(pipelineJobs.attemptNo, run.attemptNo ?? 0),
            eqNullable(pipelineJobs.leaseToken, run.leaseToken),
          ))
          .run();
        if (jobCas.changes !== 1) throw new RecoveryCasMissError();
      }

      const change = tx.select().from(changes).where(eq(changes.id, run.changeId)).get();
      const syntheticProvider = change?.provider === "claude" ? "claude" : "codex";
      const syntheticInsert = tx.insert(providerRunProcesses).values({
        id: syntheticProcessId,
        changeId: run.changeId,
        runId: run.id,
        phase: run.phase,
        provider: syntheticProvider,
        pid: null,
        ppid: process.pid,
        roundId: null,
        status: reasonCode === "stale_lease_fenced" || reasonCode === "provider_lease_expired"
          ? "stopped"
          : "orphaned",
        startedAt: run.startedAt ?? recoveredAt,
        lastHeartbeatAt: recoveredAt,
        endedAt: recoveredAt,
        exitCode: null,
        signal: null,
        summary: reasonCode,
        jobId: run.jobId,
        workerId: run.workerId,
        leaseToken: run.leaseToken,
        attemptNo: run.attemptNo,
      }).onConflictDoNothing().run();
      if (syntheticInsert.changes !== 1) throw new RecoveryCasMissError();

      const stagePhase = documentStagePhases[run.phase];
      if (stagePhase && run.attemptNo !== null) {
        const currentStage = tx.select().from(stageRuns).where(and(
          eq(stageRuns.changeId, run.changeId),
          eq(stageRuns.phase, stagePhase),
          eq(stageRuns.attemptNo, run.attemptNo),
        )).get() ?? null;
        if (currentStage?.status === "running") {
          const stageCas = tx.update(stageRuns)
            .set({ status: "failed", completedAt: recoveredAt, errorCode: reasonCode })
            .where(and(
              eq(stageRuns.id, currentStage.id),
              eq(stageRuns.status, "running"),
            ))
            .run();
          if (stageCas.changes !== 1) throw new RecoveryCasMissError();
        }
      }

      if (ownsChange && (run.phase === "spec" || run.phase === "spec_critic")) {
        const runningRoundStatus = run.phase === "spec_critic" ? "blue_running" : "red_running";
        const currentRound = tx.select().from(battleRounds).where(and(
          eq(battleRounds.changeId, run.changeId),
          inArray(battleRounds.phase, ["Spec", "spec"]),
          eq(battleRounds.status, runningRoundStatus),
        )).get() ?? null;
        if (currentRound) {
          const roundCas = tx.update(battleRounds)
            .set({ status: "failed", endedAt: recoveredAt, updatedAt: recoveredAt })
            .where(and(
              eq(battleRounds.id, currentRound.id),
              eq(battleRounds.status, runningRoundStatus),
            ))
            .run();
          if (roundCas.changes !== 1) throw new RecoveryCasMissError();
        }
      }
      if (ownsChange && (run.phase === "implement" || run.phase === "fix_findings")) {
        const currentBuild = tx.select().from(buildRunRecords).where(and(
          eq(buildRunRecords.changeId, run.changeId),
          eq(buildRunRecords.runId, run.id),
          eq(buildRunRecords.status, "running"),
        )).get() ?? null;
        if (currentBuild) {
          const buildCas = tx.update(buildRunRecords)
            .set({ status: "failed", updatedAt: recoveredAt })
            .where(and(
              eq(buildRunRecords.id, currentBuild.id),
              eq(buildRunRecords.status, "running"),
            ))
            .run();
          if (buildCas.changes !== 1) throw new RecoveryCasMissError();
        }
      }
      if (ownsChange && run.phase === "review") {
        const currentReview = tx.select().from(reviewAttempts).where(and(
          eq(reviewAttempts.changeId, run.changeId),
          eq(reviewAttempts.runId, run.id),
          eq(reviewAttempts.status, "running"),
        )).get() ?? null;
        if (currentReview) {
          const reviewCas = tx.update(reviewAttempts)
            .set({
              status: "failed",
              reviewStatus: "failed",
              errorCode: reasonCode,
              sanitizedErrorSummary: reasonCode,
              endedAt: recoveredAt,
              completedAt: recoveredAt,
              updatedAt: recoveredAt,
            })
            .where(and(
              eq(reviewAttempts.id, currentReview.id),
              eq(reviewAttempts.status, "running"),
            ))
            .run();
          if (reviewCas.changes !== 1) throw new RecoveryCasMissError();
        }
        const currentReviewState = tx.select().from(reviewState)
          .where(eq(reviewState.changeId, run.changeId)).get() ?? null;
        if (currentReviewState?.gateStatus === "running") {
          const reviewStateCas = tx.update(reviewState)
            .set({ gateStatus: "blocked", reviewStatus: "failed", updatedAt: recoveredAt })
            .where(and(
              eq(reviewState.changeId, run.changeId),
              eq(reviewState.gateStatus, "running"),
            ))
            .run();
          if (reviewStateCas.changes !== 1) throw new RecoveryCasMissError();
        }
      }

      if (change && ownsChange) {
        const target = targetStatusForRecovery(change.status as ChangeStatus, run.phase);
        transitionChangeStatusWithDb(tx as unknown as RecoveryDb, {
          changeId: run.changeId,
          to: target.to,
          blockedPhase: target.blockedPhase,
          message: `Recovered provider lifecycle gap: ${run.phase}`,
          rawJson: { source: "stale_provider_run_recovery", runId: run.id, reasonCode },
        });
      }

      tx.insert(events).values({
        id: `EVT-RECOVERY-${reasonCode}-${run.id}-${run.attemptNo ?? 0}`,
        changeId: run.changeId,
        runId: run.id,
        type: reasonCode,
        message: `Recovered ${reasonCode} for ${run.phase}`,
        rawJson: JSON.stringify({
          schemaVersion: "provider_run_recovery/v2",
          reasonCode,
          runId: run.id,
          observedAt: recoveredAt,
          ...(observation ? { observation } : {}),
        }),
        createdAt: recoveredAt,
      }).onConflictDoNothing().run();
        beforeCommitForTest?.();
        assertWithinBudget?.();
        return true;
      });
    });
  } catch (error) {
    if (error instanceof RecoveryCasMissError) return null;
    throw error;
  }
  if (!recovered) return null;
  return {
    kind: "recovered",
    processId: syntheticProcessId,
    runId: run.id,
    changeId: run.changeId,
    phase: run.phase,
    reason: reasonCode,
    reasonCode,
  };
}

function targetStatusForRecovery(
  current: ChangeStatus,
  phase: string,
): { to: ChangeStatus; blockedPhase?: string | null } {
  const preferred = fallbackStatusByProviderPhase[phase] ?? "BLOCKED";
  if (preferred === "BLOCKED") {
    return { to: "BLOCKED", blockedPhase: phase === "spec_critic" ? "spec" : phase };
  }
  if (current === preferred || ALLOWED_TRANSITIONS.get(current)?.has(preferred)) {
    return { to: preferred };
  }
  return { to: "BLOCKED", blockedPhase: phase };
}

function targetStatusForCompletedProvider(
  current: ChangeStatus,
  phase: string,
): { to: ChangeStatus; blockedPhase?: string | null } {
  const completed = completedStatusByProviderPhase[phase];
  if (completed && (current === completed || ALLOWED_TRANSITIONS.get(current)?.has(completed))) {
    return { to: completed };
  }
  return targetStatusForRecovery(current, phase);
}

function requireCompensationCas(
  changes: number,
  alreadyTarget: () => boolean,
): void {
  if (changes === 1) return;
  if (changes === 0 && alreadyTarget()) return;
  throw new RecoveryCasMissError();
}

function compensateEvidenceDrift(input: {
  run: typeof runs.$inferSelect;
  provider: ProviderRunProcess;
  recoveredAt: string;
  evidenceObservation: BusinessEvidenceObservation;
}): boolean {
  const { run, provider, recoveredAt, evidenceObservation } = input;
  return withSqliteWriteRetry("stale-provider-run.compensate-evidence-drift", () =>
    db.transaction((tx) => {
      const ownership = determineRecoveryOwnership(
        tx as unknown as RecoveryDb,
        run,
      );
      if (ownership.ownershipMismatch) return false;
      const { oldJobOwned, ownsChange } = ownership;
      const runCas = tx.update(runs).set({
        status: "failed",
        summary: "business_evidence_changed_after_commit",
      }).where(and(
        eq(runs.id, run.id),
        eq(runs.status, "completed"),
        eq(runs.endedAt, recoveredAt),
      )).run();
      if (runCas.changes !== 1) return false;

      if (run.jobId && oldJobOwned) {
        const jobCas = tx.update(pipelineJobs).set({
          status: "failed",
          errorCode: "business_evidence_changed_after_commit",
          errorSummary: "business_evidence_changed_after_commit",
        }).where(and(
          eq(pipelineJobs.id, run.jobId),
          eq(pipelineJobs.status, "succeeded"),
          eq(pipelineJobs.attemptNo, run.attemptNo ?? 0),
          eqNullable(pipelineJobs.leaseToken, run.leaseToken),
        )).run();
        requireCompensationCas(jobCas.changes, () => {
          const after = tx.select().from(pipelineJobs)
            .where(eq(pipelineJobs.id, run.jobId!)).get() ?? null;
          return after?.status === "failed"
            && after.attemptNo === (run.attemptNo ?? 0)
            && after.leaseToken === run.leaseToken
            && after.errorCode === "business_evidence_changed_after_commit";
        });
      }

      const stagePhase = documentStagePhases[provider.phase];
      if (stagePhase) {
        const stageAttemptNo = run.attemptNo ?? provider.attemptNo ?? 0;
        const stage = tx.select({
          id: stageRuns.id,
          status: stageRuns.status,
          outputDbHash: stageRuns.outputDbHash,
          sourceLineageJson: stageRuns.sourceLineageJson,
          errorCode: stageRuns.errorCode,
        }).from(stageRuns).where(and(
          eq(stageRuns.changeId, run.changeId),
          eq(stageRuns.phase, stagePhase),
          eq(stageRuns.attemptNo, stageAttemptNo),
        )).orderBy(desc(stageRuns.startedAt), desc(stageRuns.id)).limit(1).get() ?? null;
        if (stage?.status === "completed") {
          const stageCas = tx.update(stageRuns).set({
            status: "failed",
            errorCode: "business_evidence_changed_after_commit",
          }).where(and(
            eq(stageRuns.id, stage.id),
            eq(stageRuns.changeId, run.changeId),
            eq(stageRuns.phase, stagePhase),
            eq(stageRuns.attemptNo, stageAttemptNo),
            eq(stageRuns.status, "completed"),
            stage.outputDbHash === null
              ? isNull(stageRuns.outputDbHash)
              : eq(stageRuns.outputDbHash, stage.outputDbHash),
            stage.sourceLineageJson === null
              ? isNull(stageRuns.sourceLineageJson)
              : eq(stageRuns.sourceLineageJson, stage.sourceLineageJson),
            stage.errorCode === null
              ? isNull(stageRuns.errorCode)
              : eq(stageRuns.errorCode, stage.errorCode),
          )).run();
          requireCompensationCas(stageCas.changes, () => {
            const after = tx.select().from(stageRuns).where(eq(stageRuns.id, stage.id)).get();
            return after?.status === "failed"
              && after.errorCode === "business_evidence_changed_after_commit";
          });
        } else if (stage && stage.status !== "failed") {
          throw new RecoveryCasMissError();
        }
      }

      if ((provider.phase === "spec" || provider.phase === "spec_critic") && provider.roundId) {
        const round = tx.select().from(battleRounds)
          .where(eq(battleRounds.id, provider.roundId)).get() ?? null;
        if (round && inArrayValue(round.status, ["report_ready", "closed"])) {
          const roundCas = tx.update(battleRounds).set({
            status: "failed",
            updatedAt: recoveredAt,
          }).where(and(
            eq(battleRounds.id, provider.roundId),
            eq(battleRounds.changeId, run.changeId),
            eq(battleRounds.status, round.status),
          )).run();
          requireCompensationCas(roundCas.changes, () =>
            tx.select({ status: battleRounds.status }).from(battleRounds)
              .where(eq(battleRounds.id, provider.roundId!)).get()?.status === "failed"
          );
        } else if (round?.status !== "failed") {
          throw new RecoveryCasMissError();
        }
      }

      if (provider.phase === "implement" || provider.phase === "fix_findings") {
        const build = tx.select({ id: buildRunRecords.id, status: buildRunRecords.status })
          .from(buildRunRecords).where(and(
            eq(buildRunRecords.changeId, run.changeId),
            eq(buildRunRecords.runId, run.id),
          )).orderBy(desc(buildRunRecords.updatedAt), desc(buildRunRecords.id)).limit(1).get() ?? null;
        if (build && inArrayValue(build.status, ["adopted", "approved_for_absorb", "awaiting_human"])) {
          const buildCas = tx.update(buildRunRecords).set({
            status: "failed",
            updatedAt: recoveredAt,
          }).where(and(
            eq(buildRunRecords.id, build.id),
            eq(buildRunRecords.runId, run.id),
            eq(buildRunRecords.status, build.status),
          )).run();
          requireCompensationCas(buildCas.changes, () =>
            tx.select({ status: buildRunRecords.status }).from(buildRunRecords)
              .where(eq(buildRunRecords.id, build.id)).get()?.status === "failed"
          );
        } else if (!build || build.status !== "failed") {
          throw new RecoveryCasMissError();
        }
      }

      if (provider.phase === "review") {
        const attempt = tx.select().from(reviewAttempts).where(and(
          eq(reviewAttempts.changeId, run.changeId),
          eq(reviewAttempts.runId, run.id),
        )).limit(1).get() ?? null;
        const state = tx.select().from(reviewState)
          .where(eq(reviewState.changeId, run.changeId)).get() ?? null;
        const report = state?.latestValidReviewReportId
          ? tx.select().from(reviewReports)
            .where(eq(reviewReports.id, state.latestValidReviewReportId)).get() ?? null
          : null;
        if (attempt?.status === "completed") {
          const attemptCas = tx.update(reviewAttempts).set({
            status: "failed",
            reviewStatus: "failed",
            errorCode: "business_evidence_changed_after_commit",
            sanitizedErrorSummary: "business_evidence_changed_after_commit",
            updatedAt: recoveredAt,
          }).where(and(
            eq(reviewAttempts.id, attempt.id),
            eq(reviewAttempts.runId, run.id),
            eq(reviewAttempts.status, "completed"),
          )).run();
          requireCompensationCas(attemptCas.changes, () => {
            const after = tx.select().from(reviewAttempts)
              .where(eq(reviewAttempts.id, attempt.id)).get();
            return after?.status === "failed" && after.reviewStatus === "failed";
          });
        } else if (!attempt || attempt.status !== "failed" || attempt.reviewStatus !== "failed") {
          throw new RecoveryCasMissError();
        }
        if (report && report.attemptId === attempt?.id && report.staleReason === null) {
          const reportCas = tx.update(reviewReports).set({
            staleReason: "business_evidence_changed_after_commit",
          }).where(and(
            eq(reviewReports.id, report.id),
            eq(reviewReports.attemptId, report.attemptId),
            eq(reviewReports.reportDbHash, report.reportDbHash),
            isNull(reviewReports.staleReason),
          )).run();
          requireCompensationCas(reportCas.changes, () =>
            tx.select({ staleReason: reviewReports.staleReason }).from(reviewReports)
              .where(eq(reviewReports.id, report.id)).get()?.staleReason
                === "business_evidence_changed_after_commit"
          );
        } else if (
          !report
          || report.attemptId !== attempt.id
          || report.staleReason !== "business_evidence_changed_after_commit"
        ) {
          throw new RecoveryCasMissError();
        }
        if (
          state
          && state.latestAttemptId === attempt?.id
          && state.latestValidReviewReportId === report?.id
        ) {
          const stateCas = tx.update(reviewState).set({
            gateStatus: "blocked",
            reviewStatus: "failed",
            latestValidReviewReportId: null,
            latestValidAttemptNo: null,
            reportDbHash: null,
            updatedAt: recoveredAt,
          }).where(and(
            eq(reviewState.changeId, run.changeId),
            eq(reviewState.latestAttemptId, attempt.id),
            eq(reviewState.latestValidReviewReportId, report.id),
            report.reportDbHash === null
              ? isNull(reviewState.reportDbHash)
              : eq(reviewState.reportDbHash, report.reportDbHash),
          )).run();
          requireCompensationCas(stateCas.changes, () => {
            const after = tx.select().from(reviewState)
              .where(eq(reviewState.changeId, run.changeId)).get();
            return after?.gateStatus === "blocked"
              && after.reviewStatus === "failed"
              && after.latestValidReviewReportId === null
              && after.reportDbHash === null;
          });
        } else if (
          !state
          || state.gateStatus !== "blocked"
          || state.reviewStatus !== "failed"
          || state.latestValidReviewReportId !== null
          || state.reportDbHash !== null
        ) {
          throw new RecoveryCasMissError();
        }
      }

      const change = ownsChange
        ? tx.select().from(changes).where(eq(changes.id, run.changeId)).get()
        : null;
      if (change) {
        const target = targetStatusForRecovery(change.status as ChangeStatus, provider.phase);
        transitionChangeStatusWithDb(tx as unknown as RecoveryDb, {
          changeId: run.changeId,
          to: target.to,
          blockedPhase: target.blockedPhase,
          message: `Business evidence changed after recovery commit: ${provider.phase}`,
          rawJson: {
            source: "stale_provider_run_recovery_compensation",
            runId: run.id,
            processId: provider.id,
            reasonCode: "business_evidence_changed_after_commit",
          },
        });
        const preferred = fallbackStatusByProviderPhase[provider.phase];
        if (
          target.to === "BLOCKED"
          && preferred
          && preferred !== "BLOCKED"
          && ALLOWED_TRANSITIONS.get("BLOCKED")?.has(preferred)
        ) {
          transitionChangeStatusWithDb(tx as unknown as RecoveryDb, {
            changeId: run.changeId,
            to: preferred,
            blockedPhase: null,
            message: `Restored legal retry gate after evidence drift: ${provider.phase}`,
            rawJson: {
              source: "stale_provider_run_recovery_compensation",
              runId: run.id,
              processId: provider.id,
              reasonCode: "business_evidence_changed_after_commit",
            },
          });
        }
      }

      const eventId = `EVT-RECOVERY-business_run_reconciled-${run.id}-${run.attemptNo ?? 0}`;
      const eventCas = tx.update(events).set({
        message: `Recovered business_run_reconciled for ${provider.phase} with incomplete evidence`,
        rawJson: JSON.stringify({
          schemaVersion: "provider_run_recovery/v2",
          reasonCode: "business_run_reconciled",
          providerTerminal: provider.status,
          businessEvidenceComplete: false,
          missingEvidence: [
            ...evidenceObservation.missingEvidence,
            "business_evidence_changed_after_commit",
          ],
          runId: run.id,
          processId: provider.id,
          observedAt: recoveredAt,
        }),
      }).where(eq(events.id, eventId)).run();
      if (eventCas.changes !== 1) throw new RecoveryCasMissError();
      return true;
    }),
  );
}

export function recoverExistingProvider(input: {
  run: typeof runs.$inferSelect;
  provider: ProviderRunProcess;
  job: typeof pipelineJobs.$inferSelect | null;
  decision: RecoveryDecision;
  recoveredAt: string;
  evidenceObservation: BusinessEvidenceObservation | null;
  onEvidenceProbe?: (kind: "fs" | "git") => void;
  onEvidenceDbQuery?: EvidenceDbQueryHook;
  evidenceDriftAfterCommitForTest?: () => boolean;
  assertWithinBudget?: () => void;
  maxReviewFindings?: number;
  beforeCommitForTest?: () => void;
}): { result: StaleProviderRunRecoveryResult; postCommitCompensated: boolean } | null {
  const {
    run, provider, job, decision, recoveredAt, evidenceObservation,
    onEvidenceProbe, onEvidenceDbQuery, evidenceDriftAfterCommitForTest, assertWithinBudget,
    maxReviewFindings = DEFAULT_MAX_REVIEW_FINDINGS,
    beforeCommitForTest,
  } = input;
  const effectivePhase = provider.phase;
  let recovered: boolean;
  try {
    recovered = withSqliteWriteRetry("stale-provider-run.reconcile", () => {
      assertWithinBudget?.();
      if (evidenceObservation && !fileObservationsMatch(evidenceObservation, onEvidenceProbe)) return false;
      assertWithinBudget?.();
      return db.transaction((tx) => {
      const currentProvider = tx.select().from(providerRunProcesses)
        .where(eq(providerRunProcesses.id, provider.id)).get() ?? null;
      const currentRunSnapshot = tx.select().from(runs)
        .where(eq(runs.id, run.id)).get() ?? null;
      const currentObservedJob = run.jobId
        ? tx.select().from(pipelineJobs).where(eq(pipelineJobs.id, run.jobId)).get() ?? null
        : null;
      if (!currentProvider
        || !currentRunSnapshot
        || !providerFreshnessMatches(provider, currentProvider)
        || !providerOwnershipMatchesRun(currentProvider, currentRunSnapshot)
        || !jobFreshnessMatches(job, currentObservedJob)) {
        return false;
      }
      const ownership = determineRecoveryOwnership(tx as unknown as RecoveryDb, run);
      if (ownership.ownershipMismatch) return false;
      const { currentJob, oldJobOwned, ownsChange } = ownership;
      if (evidenceObservation
        && captureEvidenceDbSnapshot(
          tx as unknown as RecoveryDb,
          run,
          provider,
          onEvidenceDbQuery,
          "transaction",
          maxReviewFindings,
        ) !== evidenceObservation.dbSnapshot) {
        return false;
      }
      const effectiveDecision: RecoveryDecision = evidenceObservation && !evidenceObservation.complete
        ? {
          ...decision,
          runStatus: "failed",
          jobStatus: "failed",
          summary: "provider_completed_business_incomplete",
        }
        : decision;
      const runCas = tx.update(runs)
        .set({
          status: effectiveDecision.runStatus,
          endedAt: recoveredAt,
          summary: effectiveDecision.summary ?? effectiveDecision.reasonCode,
        })
        .where(and(
          eq(runs.id, run.id),
          eq(runs.status, "running"),
          run.startedAt === null ? isNull(runs.startedAt) : eq(runs.startedAt, run.startedAt),
          run.leaseToken === null ? isNull(runs.leaseToken) : eq(runs.leaseToken, run.leaseToken),
          run.attemptNo === null ? isNull(runs.attemptNo) : eq(runs.attemptNo, run.attemptNo),
        ))
        .run();
      if (runCas.changes !== 1) return false;

      if (provider.status === "running") {
        const providerCas = tx.update(providerRunProcesses)
          .set({
            status: decision.providerStatus,
            endedAt: recoveredAt,
            lastHeartbeatAt: recoveredAt,
            summary: effectiveDecision.summary ?? effectiveDecision.reasonCode,
          })
          .where(and(
            eq(providerRunProcesses.id, provider.id),
            eq(providerRunProcesses.status, "running"),
            provider.leaseToken === null
              ? isNull(providerRunProcesses.leaseToken)
              : eq(providerRunProcesses.leaseToken, provider.leaseToken),
            provider.attemptNo === null
              ? isNull(providerRunProcesses.attemptNo)
              : eq(providerRunProcesses.attemptNo, provider.attemptNo),
          ))
          .run();
        if (providerCas.changes !== 1) throw new RecoveryCasMissError();
      }

      if (currentJob && inArrayValue(currentJob.status, ["leased", "running"]) && oldJobOwned) {
        const jobCas = tx.update(pipelineJobs)
          .set({
            status: effectiveDecision.jobStatus,
            leaseExpiresAt: null,
            endedAt: recoveredAt,
            heartbeatAt: recoveredAt,
            errorCode: effectiveDecision.jobStatus === "failed"
              ? effectiveDecision.summary ?? effectiveDecision.reasonCode
              : null,
            errorSummary: effectiveDecision.jobStatus === "failed"
              ? effectiveDecision.summary ?? effectiveDecision.reasonCode
              : null,
          })
          .where(and(
            eq(pipelineJobs.id, currentJob.id),
            inArray(pipelineJobs.status, ["leased", "running"]),
            eq(pipelineJobs.attemptNo, run.attemptNo ?? 0),
            eqNullable(pipelineJobs.leaseToken, run.leaseToken),
          ))
          .run();
        if (jobCas.changes !== 1) throw new RecoveryCasMissError();
      }

      const stagePhase = documentStagePhases[effectivePhase];
      if (stagePhase) {
        const stageAttemptNo = run.attemptNo ?? provider.attemptNo ?? 0;
        const currentStage = tx.select().from(stageRuns).where(and(
          eq(stageRuns.changeId, run.changeId),
          eq(stageRuns.phase, stagePhase),
          eq(stageRuns.attemptNo, stageAttemptNo),
        )).get() ?? null;
        if (currentStage?.status === "running") {
          const stageCas = tx.update(stageRuns)
            .set({
              status: effectiveDecision.runStatus === "completed" ? "completed" : "failed",
              completedAt: recoveredAt,
              errorCode: effectiveDecision.runStatus === "completed"
                ? null
                : effectiveDecision.summary ?? effectiveDecision.reasonCode,
            })
            .where(and(
              eq(stageRuns.id, currentStage.id),
              eq(stageRuns.status, "running"),
              eq(stageRuns.attemptNo, stageAttemptNo),
            ))
            .run();
          if (stageCas.changes !== 1) throw new RecoveryCasMissError();
        }
      }

      if (ownsChange) {
        if (effectivePhase === "spec" || effectivePhase === "spec_critic") {
          const runningRoundStatus = effectivePhase === "spec_critic" ? "blue_running" : "red_running";
          const currentRound = tx.select().from(battleRounds).where(and(
            eq(battleRounds.changeId, run.changeId),
            inArray(battleRounds.phase, ["Spec", "spec"]),
            eq(battleRounds.status, runningRoundStatus),
          )).get() ?? null;
          if (currentRound) {
            const roundCas = tx.update(battleRounds)
            .set({
              status: effectiveDecision.runStatus === "completed" ? "report_ready" : "failed",
              endedAt: recoveredAt,
              updatedAt: recoveredAt,
            })
            .where(and(
              eq(battleRounds.id, currentRound.id),
              eq(battleRounds.status, runningRoundStatus),
            ))
            .run();
            if (roundCas.changes !== 1) throw new RecoveryCasMissError();
          }
        }
        if (effectivePhase === "implement" || effectivePhase === "fix_findings") {
          const currentBuild = tx.select().from(buildRunRecords).where(and(
            eq(buildRunRecords.changeId, run.changeId),
            eq(buildRunRecords.runId, run.id),
            eq(buildRunRecords.status, "running"),
          )).get() ?? null;
          if (currentBuild) {
            const buildCas = tx.update(buildRunRecords)
            .set({
              status: effectiveDecision.runStatus === "completed" ? "awaiting_human" : "failed",
              updatedAt: recoveredAt,
            })
            .where(and(
              eq(buildRunRecords.id, currentBuild.id),
              eq(buildRunRecords.status, "running"),
            ))
            .run();
            if (buildCas.changes !== 1) throw new RecoveryCasMissError();
          }
        }
        if (effectivePhase === "review") {
          const currentReview = tx.select().from(reviewAttempts).where(and(
            eq(reviewAttempts.changeId, run.changeId),
            eq(reviewAttempts.runId, run.id),
            eq(reviewAttempts.status, "running"),
          )).get() ?? null;
          if (currentReview) {
            const reviewCas = tx.update(reviewAttempts)
            .set({
              status: effectiveDecision.runStatus === "completed" ? "completed" : "failed",
              reviewStatus: effectiveDecision.runStatus === "completed" ? "passed" : "failed",
              errorCode: effectiveDecision.runStatus === "completed" ? null : effectiveDecision.summary ?? effectiveDecision.reasonCode,
              sanitizedErrorSummary: effectiveDecision.runStatus === "completed" ? null : effectiveDecision.summary ?? effectiveDecision.reasonCode,
              endedAt: recoveredAt,
              completedAt: recoveredAt,
              updatedAt: recoveredAt,
            })
            .where(and(
              eq(reviewAttempts.id, currentReview.id),
              eq(reviewAttempts.status, "running"),
            ))
            .run();
            if (reviewCas.changes !== 1) throw new RecoveryCasMissError();
          }
          const currentReviewState = tx.select().from(reviewState)
            .where(eq(reviewState.changeId, run.changeId)).get() ?? null;
          if (currentReviewState?.gateStatus === "running") {
            const reviewStateCas = tx.update(reviewState)
              .set({
                gateStatus: effectiveDecision.runStatus === "completed" ? "passed" : "blocked",
                reviewStatus: effectiveDecision.runStatus === "completed" ? "passed" : "failed",
                updatedAt: recoveredAt,
              })
              .where(and(
                eq(reviewState.changeId, run.changeId),
                eq(reviewState.gateStatus, "running"),
              ))
              .run();
            if (reviewStateCas.changes !== 1) throw new RecoveryCasMissError();
          }
        }
        const change = tx.select().from(changes).where(eq(changes.id, run.changeId)).get();
        if (change) {
          const target = effectiveDecision.runStatus === "completed"
            ? targetStatusForCompletedProvider(change.status as ChangeStatus, effectivePhase)
            : targetStatusForRecovery(change.status as ChangeStatus, effectivePhase);
          transitionChangeStatusWithDb(tx as unknown as RecoveryDb, {
            changeId: run.changeId,
            to: target.to,
            blockedPhase: target.blockedPhase,
            message: `Reconciled provider run: ${effectivePhase}`,
            rawJson: {
              source: "stale_provider_run_recovery",
              runId: run.id,
              processId: provider.id,
              reasonCode: decision.reasonCode,
            },
          });
        }
      }

      tx.insert(events).values({
        id: `EVT-RECOVERY-${decision.reasonCode}-${run.id}-${run.attemptNo ?? 0}`,
        changeId: run.changeId,
        runId: run.id,
        type: decision.reasonCode,
        message: `Recovered ${decision.reasonCode} for ${effectivePhase}`,
        rawJson: JSON.stringify({
          schemaVersion: "provider_run_recovery/v2",
          reasonCode: decision.reasonCode,
          providerTerminal: provider.status,
          businessEvidenceComplete: evidenceObservation?.complete ?? null,
          missingEvidence: evidenceObservation?.missingEvidence ?? [],
          runId: run.id,
          processId: provider.id,
          observedAt: recoveredAt,
          ...(decision.observation ? { observation: decision.observation } : {}),
        }),
        createdAt: recoveredAt,
      }).onConflictDoNothing().run();
      beforeCommitForTest?.();
      assertWithinBudget?.();
      return true;
      });
    });
  } catch (error) {
    if (error instanceof RecoveryCasMissError) return null;
    throw error;
  }
  if (!recovered) return null;
  let postCommitCompensated = false;
  if (
    evidenceObservation
    && (
      !fileObservationsMatch(evidenceObservation, onEvidenceProbe)
      || evidenceDriftAfterCommitForTest?.() === true
    )
  ) {
    compensateEvidenceDrift({ run, provider, recoveredAt, evidenceObservation });
    postCommitCompensated = true;
  }
  return {
    postCommitCompensated,
    result: {
      kind: "recovered",
      processId: provider.id,
      runId: run.id,
      changeId: run.changeId,
      phase: effectivePhase,
      reason: decision.reasonCode,
      reasonCode: decision.reasonCode,
    },
  };
}

export function recoverProviderAfterTerminalRun(input: {
  run: typeof runs.$inferSelect;
  provider: ProviderRunProcess;
  job: typeof pipelineJobs.$inferSelect | null;
  decision: RecoveryDecision;
  recoveredAt: string;
  assertWithinBudget?: () => void;
}): StaleProviderRunRecoveryResult | null {
  const { run, provider, job, decision, recoveredAt, assertWithinBudget } = input;
  let skippedForNewerOwner = false;
  const recovered = withSqliteWriteRetry("stale-provider-run.reconcile-terminal-run-provider", () => {
    assertWithinBudget?.();
    return db.transaction((tx) => {
      const currentRun = tx.select().from(runs).where(eq(runs.id, run.id)).get() ?? null;
      const currentProvider = tx.select().from(providerRunProcesses)
        .where(eq(providerRunProcesses.id, provider.id)).get() ?? null;
      const currentJob = job
        ? tx.select().from(pipelineJobs).where(eq(pipelineJobs.id, job.id)).get() ?? null
        : null;
      if (!currentRun
        || currentRun.status === "running"
        || !currentProvider
        || !providerFreshnessMatches(provider, currentProvider)
        || !providerOwnershipMatchesRun(currentProvider, currentRun)
        || !jobFreshnessMatches(job, currentJob)) {
        return false;
      }
      const ownership = determineRecoveryOwnership(tx as unknown as RecoveryDb, currentRun);
      const newerActiveOwnerExists = Boolean(tx.select({ id: pipelineJobs.id })
        .from(pipelineJobs).where(and(
          eq(pipelineJobs.changeId, currentRun.changeId),
          currentRun.jobId ? ne(pipelineJobs.id, currentRun.jobId) : sql`1 = 1`,
          inArray(pipelineJobs.status, ["leased", "running"]),
          currentRun.startedAt
            ? or(
                sql`NOT (
                  length(${pipelineJobs.createdAt}) = 24
                  AND ${pipelineJobs.createdAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
                  AND julianday(${pipelineJobs.createdAt}) IS NOT NULL
                  AND strftime('%Y-%m-%dT%H:%M:%fZ', ${pipelineJobs.createdAt}) = ${pipelineJobs.createdAt}
                )`,
                gte(pipelineJobs.createdAt, currentRun.startedAt),
              )
            : sql`1 = 1`,
        )).limit(1).get());
      const currentJobFenceMismatch = ownership.currentJob !== null && !ownership.oldJobOwned;
      if (ownership.ownershipMismatch || currentJobFenceMismatch || newerActiveOwnerExists) {
        skippedForNewerOwner = true;
        return false;
      }
      const providerCas = tx.update(providerRunProcesses).set({
        status: decision.providerStatus,
        endedAt: recoveredAt,
        lastHeartbeatAt: recoveredAt,
        summary: decision.reasonCode,
      }).where(and(
        eq(providerRunProcesses.id, provider.id),
        eq(providerRunProcesses.status, "running"),
        provider.leaseToken === null
          ? isNull(providerRunProcesses.leaseToken)
          : eq(providerRunProcesses.leaseToken, provider.leaseToken),
        provider.attemptNo === null
          ? isNull(providerRunProcesses.attemptNo)
          : eq(providerRunProcesses.attemptNo, provider.attemptNo),
      )).run();
      if (providerCas.changes !== 1) throw new RecoveryCasMissError();
      tx.insert(events).values({
        id: `EVT-RECOVERY-${decision.reasonCode}-${run.id}-${run.attemptNo ?? 0}`,
        changeId: run.changeId,
        runId: run.id,
        type: decision.reasonCode,
        message: `Recovered ${decision.reasonCode} for ${provider.phase}`,
        rawJson: JSON.stringify({
          schemaVersion: "provider_run_recovery/v2",
          reasonCode: decision.reasonCode,
          providerTerminal: provider.status,
          runTerminal: currentRun.status,
          runId: run.id,
          processId: provider.id,
          observedAt: recoveredAt,
        }),
        createdAt: recoveredAt,
      }).onConflictDoNothing().run();
      assertWithinBudget?.();
      return true;
    });
  });
  if (!recovered && skippedForNewerOwner) {
    return {
      kind: "skipped",
      processId: provider.id,
      runId: run.id,
      changeId: run.changeId,
      phase: provider.phase,
      reason: "newer_attempt_owner",
      reasonCode: "newer_attempt_owner",
    };
  }
  return recovered ? {
    kind: "recovered",
    processId: provider.id,
    runId: run.id,
    changeId: run.changeId,
    phase: provider.phase,
    reason: decision.reasonCode,
    reasonCode: decision.reasonCode,
  } : null;
}
