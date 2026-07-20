import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

import { db } from "../db";
import {
  events,
  pipelineJobs,
  providerRunProcesses,
  runs,
} from "../db/schema";
import { runLedgerRepository } from "../repositories/run-ledger-repository";
import {
  type ProviderRunProcess,
} from "./provider-run-lifecycle-service";
import {
  processIdentityProbe,
  type ProcessIdentity,
  type ProcessIdentityProbe,
  type ProcessIdentityProbeFailureReason,
  type ProcessIdentityValidationFailureReason,
} from "./process-identity-service";
import type {
  ProviderRunRecoveryKind,
  RecoveryDecision,
  RecoveryObservation,
  StaleProviderRunRecoveryResult,
} from "./recovery-types";
import { DEFAULT_MAX_REVIEW_FINDINGS } from "./recovery-types";
export type { ProviderRunRecoveryKind, StaleProviderRunRecoveryResult };
export { DEFAULT_MAX_REVIEW_FINDINGS };
import {
  canonicalOwnershipPhase,
  hasValidExternalRef,
  heartbeatIsStale,
  inArrayValue,
  isCanonicalUtcIsoTimestamp,
  jobHeartbeatAgeMs,
  jobHeartbeatIsFresh,
  processIdentitiesMatch,
  processIdentityForProvider,
  providerHeartbeatAgeMs,
  providerOwnershipMatchesRun,
  sameFence,
  strongIdentityMatchesAfterReparent,
} from "./recovery-predicates";
import {
  ABSOLUTE_MAX_ARTIFACT_BYTES,
  DEFAULT_MAX_ARTIFACT_BYTES,
} from "./recovery-evidence";
export { ABSOLUTE_MAX_ARTIFACT_BYTES, DEFAULT_MAX_ARTIFACT_BYTES };
import {
  businessEvidenceForCompletedProvider,
} from "./recovery-business-evidence";
import {
  determineRecoveryOwnership,
  recoverExistingProvider,
  recoverMissingProvider,
  recoverProviderAfterTerminalRun,
} from "./recovery-executors";

export const DEFAULT_PROVIDER_START_GRACE_MS = 30_000;
export const DEFAULT_PROVIDER_HEARTBEAT_STALE_MS = 45_000;
export const DEFAULT_LEGACY_LIFECYCLE_GRACE_MS = 60_000;
export const DEFAULT_PROVIDER_STALE_RUN_MS = DEFAULT_PROVIDER_HEARTBEAT_STALE_MS;
export const DEFAULT_SCOPED_RECOVERY_MAX_CANDIDATES = 16;
export const DEFAULT_GLOBAL_RECOVERY_MAX_CANDIDATES = 64;
export const DEFAULT_SCOPED_RECOVERY_TIME_BUDGET_MS = 1_000;
export const DEFAULT_GLOBAL_RECOVERY_TIME_BUDGET_MS = 5_000;
export const ABSOLUTE_MAX_RECOVERY_CANDIDATES = 1_024;
export const ABSOLUTE_MAX_RECOVERY_TIME_BUDGET_MS = 60_000;
export const ABSOLUTE_MAX_REVIEW_FINDINGS = 5_000;

export type RecoveryBoundedOption =
  | "maxCandidates"
  | "timeBudgetMs"
  | "maxReviewFindings"
  | "maxArtifactBytes";

export class RecoveryOptionValidationError extends RangeError {
  readonly code = "invalid_recovery_option";

  constructor(public readonly option: RecoveryBoundedOption) {
    super(`${option} must be a positive integer within its recovery limit`);
    this.name = "RecoveryOptionValidationError";
  }
}

function normalizeRecoveryBound(
  option: RecoveryBoundedOption,
  value: number | undefined,
  fallback: number,
  absoluteMax: number,
): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized)
    || !Number.isInteger(normalized)
    || normalized <= 0
    || normalized > absoluteMax) {
    throw new RecoveryOptionValidationError(option);
  }
  return normalized;
}

export interface RecoveryCursor {
  startedAt: string | null;
  id: string;
}

export interface StaleProviderRunRecoveryOptions {
  changeId?: string;
  execute?: boolean;
  staleAfterMs?: number;
  now?: () => Date;
  observedAt?: Date;
  providerStartGraceMs?: number;
  providerHeartbeatStaleMs?: number;
  legacyLifecycleGraceMs?: number;
  processIdentityProbe?: ProcessIdentityProbe;
  terminateProcess?: (identity: ProcessIdentity) => Promise<void>;
  onEvidenceProbe?: (kind: "fs" | "git") => void;
  onEvidenceDbQuery?: (
    phase: string,
    scope: "observation" | "transaction",
  ) => void;
  evidenceDriftAfterCommitForTest?: () => boolean;
  beforeTerminateOwnershipCheckForTest?: () => void;
  beforeRecoveryCommitForTest?: () => void;
  maxCandidates?: number;
  timeBudgetMs?: number;
  maxReviewFindings?: number;
  maxArtifactBytes?: number;
  monotonicNowForTest?: () => number;
  cursor?: RecoveryCursor;
  onCandidateDbQuery?: (table: "runs" | "providers" | "jobs") => void;
  onCandidateRowsLoadedForTest?: (table: "runs" | "providers" | "jobs", count: number) => void;
}

export interface RecoveryFailure {
  runId: string;
  changeId: string;
  phase: string;
  code: "recovery_failed";
  error: string;
}

export interface ProviderRunRecoveryReport {
  recovered: StaleProviderRunRecoveryResult[];
  failed: RecoveryFailure[];
  observed: StaleProviderRunRecoveryResult[];
  observedAt: string;
  processedCandidates: number;
  truncated: boolean;
  deferred: Array<{
    reason: "candidate_limit" | "time_budget" | "review_findings_limit" | "provider_prefetch_limit";
    count: number;
    runId?: string;
    atLeast?: boolean;
  }>;
  nextCursor: RecoveryCursor | null;
  cursorResetReason?: "invalid_cursor";
}

export function isRecoveryIncomplete(report: ProviderRunRecoveryReport): boolean {
  return report.failed.length > 0 || report.truncated || report.deferred.length > 0;
}

const bestEffortCursors = new Map<string, RecoveryCursor>();
let bestEffortOptionsForTest: Partial<StaleProviderRunRecoveryOptions> | null = null;

export function setBestEffortRecoveryOptionsForTest(
  options: Partial<StaleProviderRunRecoveryOptions> | null,
): void {
  bestEffortOptionsForTest = options;
}

export function resetRecoveryCursorsForTest(): void {
  bestEffortCursors.clear();
  bestEffortOptionsForTest = null;
}

class RecoveryDeadlineExceededError extends Error {}

function recordRecoveryFailure(
  report: ProviderRunRecoveryReport,
  run: typeof runs.$inferSelect,
  error: unknown,
): void {
  const errorSummary = error instanceof Error ? error.message : String(error);
  report.failed.push({
    runId: run.id,
    changeId: run.changeId,
    phase: run.phase,
    code: "recovery_failed",
    error: errorSummary,
  });
  try {
    db.insert(events).values({
      id: `EVT-RECOVERY-FAILED-${run.id}-${run.attemptNo ?? 0}`,
      changeId: run.changeId,
      runId: run.id,
      type: "stale_provider_run_recovery_failed",
      message: "Provider run recovery failed",
      rawJson: JSON.stringify({
        schemaVersion: "provider_run_recovery_failed/v2",
        code: "recovery_failed",
        runId: run.id,
        phase: run.phase,
        observedAt: report.observedAt,
      }),
      createdAt: report.observedAt,
    }).onConflictDoNothing().run();
  } catch {
    // The per-run report remains authoritative when telemetry cannot be written.
  }
}

type RecoveryDb = typeof db;

interface RecoveryCandidate {
  run: typeof runs.$inferSelect;
  provider: ProviderRunProcess | null;
  job: typeof pipelineJobs.$inferSelect | null;
}

interface RecoveryCandidateBatch {
  candidates: RecoveryCandidate[];
  truncated: boolean;
  providerPrefetchOverflow: boolean;
}

function validRecoveryCursor(cursor: RecoveryCursor | undefined): cursor is RecoveryCursor {
  return cursor !== undefined
    && (cursor.startedAt === null || isCanonicalUtcIsoTimestamp(cursor.startedAt))
    && cursor.id.trim().length > 0
    && cursor.id.length <= 512;
}

function recoveryCandidates(
  changeId: string | undefined,
  maxCandidates: number,
  cursor: RecoveryCursor | undefined,
  onQuery?: StaleProviderRunRecoveryOptions["onCandidateDbQuery"],
  onRowsLoaded?: StaleProviderRunRecoveryOptions["onCandidateRowsLoadedForTest"],
): RecoveryCandidateBatch {
  onQuery?.("runs");
  const cursorOrder = cursor
    ? cursor.startedAt === null
      ? sql<number>`CASE WHEN (
          (${runs.startedAt} IS NULL AND ${runs.id} > ${cursor.id})
          OR ${runs.startedAt} IS NOT NULL
        ) THEN 0 ELSE 1 END`
      : sql<number>`CASE WHEN (
          ${runs.startedAt} > ${cursor.startedAt}
          OR (${runs.startedAt} = ${cursor.startedAt} AND ${runs.id} > ${cursor.id})
        ) THEN 0 ELSE 1 END`
    : null;
  const hasLatestRunningProvider = sql`EXISTS (
    SELECT 1 FROM provider_run_processes AS active_provider
    WHERE active_provider.run_id = ${runs.id}
      AND active_provider.status = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM provider_run_processes AS newer_provider
        WHERE newer_provider.run_id = active_provider.run_id
          AND (
            newer_provider.started_at > active_provider.started_at
            OR (
              newer_provider.started_at = active_provider.started_at
              AND newer_provider.id > active_provider.id
            )
          )
      )
  )`;
  const recoverableRun = or(eq(runs.status, "running"), hasLatestRunningProvider);
  const scopeCondition = changeId
    ? and(recoverableRun, eq(runs.changeId, changeId))
    : recoverableRun;
  const cursorExclusion = cursor
    ? cursor.startedAt === null
      ? sql`NOT (${runs.startedAt} IS NULL AND ${runs.id} = ${cursor.id})`
      : sql`NOT (${runs.startedAt} = ${cursor.startedAt} AND ${runs.id} = ${cursor.id})`
    : null;
  const runQuery = db.select().from(runs).where(cursorExclusion
    ? and(scopeCondition, cursorExclusion)
    : scopeCondition);
  const runRows = (cursorOrder
    ? runQuery.orderBy(cursorOrder, asc(runs.startedAt), asc(runs.id))
    : runQuery.orderBy(asc(runs.startedAt), asc(runs.id)))
    .limit(maxCandidates + 1).all();
  onRowsLoaded?.("runs", runRows.length);
  const truncated = runRows.length > maxCandidates;
  const selectedRuns = runRows.slice(0, maxCandidates);
  if (selectedRuns.length === 0) {
    return { candidates: [], truncated, providerPrefetchOverflow: false };
  }
  onQuery?.("providers");
  const providerRows = db.select().from(providerRunProcesses)
    .where(and(
      inArray(providerRunProcesses.runId, selectedRuns.map((run) => run.id)),
      sql`NOT EXISTS (
        SELECT 1 FROM provider_run_processes AS newer
        WHERE newer.run_id = ${providerRunProcesses.runId}
          AND (
            newer.started_at > ${providerRunProcesses.startedAt}
            OR (newer.started_at = ${providerRunProcesses.startedAt} AND newer.id > ${providerRunProcesses.id})
          )
      )`,
    ))
    .orderBy(desc(providerRunProcesses.startedAt), desc(providerRunProcesses.id))
    .limit(selectedRuns.length + 1).all();
  onRowsLoaded?.("providers", providerRows.length);
  if (providerRows.length > selectedRuns.length) {
    return { candidates: [], truncated: true, providerPrefetchOverflow: true };
  }
  const providersByRun = new Map<string, ProviderRunProcess>();
  for (const provider of providerRows) {
    if (!providersByRun.has(provider.runId)) providersByRun.set(provider.runId, provider);
  }
  const jobIds = [...new Set(selectedRuns
    .map((run) => run.jobId ?? providersByRun.get(run.id)?.jobId ?? null)
    .filter((id): id is string => id !== null))];
  const jobsById = new Map<string, typeof pipelineJobs.$inferSelect>();
  if (jobIds.length > 0) {
    onQuery?.("jobs");
    const jobRows = db.select().from(pipelineJobs).where(inArray(pipelineJobs.id, jobIds))
      .limit(jobIds.length + 1).all();
    onRowsLoaded?.("jobs", jobRows.length);
    for (const job of jobRows) {
      jobsById.set(job.id, job);
    }
  }
  const candidates = selectedRuns.map((run) => {
    const provider = providersByRun.get(run.id) ?? null;
    const jobId = run.jobId ?? provider?.jobId ?? null;
    return { run, provider, job: jobId ? jobsById.get(jobId) ?? null : null };
  });
  return { candidates, truncated, providerPrefetchOverflow: false };
}

function providerOwnershipAndIdentityMatchCurrentState(
  expectedProvider: ProviderRunProcess,
  expectedRun: typeof runs.$inferSelect,
  expectedJob: typeof pipelineJobs.$inferSelect | null,
  expectedJobStatus: RecoveryDecision["jobStatus"],
  recoveredAt: string,
  signalIdentity: ProcessIdentity,
): boolean {
  const currentProvider = db.select().from(providerRunProcesses)
    .where(eq(providerRunProcesses.id, expectedProvider.id)).get() ?? null;
  const currentRun = db.select().from(runs).where(eq(runs.id, expectedRun.id)).get() ?? null;
  if (!currentProvider || !currentRun || !providerOwnershipMatchesRun(currentProvider, currentRun)) {
    return false;
  }
  const ownership = determineRecoveryOwnership(db as unknown as RecoveryDb, currentRun);
  if (ownership.ownershipMismatch || ownership.newerAttemptExists) return false;
  const currentJob = ownership.currentJob;
  const jobAllowsSignal = expectedJob === null
    ? currentJob === null && currentRun.jobId === null && currentProvider.jobId === null
    : currentJob !== null
      && currentJob.id === expectedJob.id
      && currentJob.changeId === expectedRun.changeId
      && canonicalOwnershipPhase(currentJob.phase) === canonicalOwnershipPhase(expectedRun.phase)
      && sameFence(currentRun, currentJob)
      && currentJob.status === expectedJobStatus
      && currentJob.leaseExpiresAt === null
      && currentJob.heartbeatAt === recoveredAt
      && currentJob.endedAt === recoveredAt;
  if (!jobAllowsSignal) return false;
  const ownershipUnchanged = currentProvider.changeId === expectedProvider.changeId
    && canonicalOwnershipPhase(currentProvider.phase)
      === canonicalOwnershipPhase(expectedProvider.phase)
    && currentProvider.jobId === expectedProvider.jobId
    && currentProvider.leaseToken === expectedProvider.leaseToken
    && currentProvider.attemptNo === expectedProvider.attemptNo
    && currentRun.changeId === expectedRun.changeId
    && canonicalOwnershipPhase(currentRun.phase) === canonicalOwnershipPhase(expectedRun.phase)
    && currentRun.jobId === expectedRun.jobId
    && currentRun.leaseToken === expectedRun.leaseToken
    && currentRun.attemptNo === expectedRun.attemptNo;
  if (!ownershipUnchanged) return false;
  const currentIdentity = processIdentityForProvider(currentProvider);
  const expectedPersistedIdentity = processIdentityForProvider(expectedProvider);
  return currentIdentity !== null
    && expectedPersistedIdentity !== null
    && processIdentitiesMatch(currentIdentity, expectedPersistedIdentity)
    && strongIdentityMatchesAfterReparent(currentIdentity, signalIdentity);
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && String(error.code) === "ESRCH"
    ) return false;
    throw error;
  }
}

async function terminateValidatedProcess(
  identity: ProcessIdentity,
  probe: ProcessIdentityProbe,
  remainingBudgetMs: number,
  monotonicNow: () => number,
): Promise<void> {
  if (remainingBudgetMs <= 0) return;
  const startedAt = monotonicNow();
  const budgetDeadline = startedAt + remainingBudgetMs;
  const graceDeadline = startedAt + Math.min(2_000, remainingBudgetMs);
  const beforeSignal = await probe.validate(identity);
  const stillSameChild = (
    validation: Awaited<ReturnType<ProcessIdentityProbe["validate"]>>,
  ): boolean => validation.ok;
  if (!stillSameChild(beforeSignal) || monotonicNow() >= budgetDeadline) return;
  if (!signalProcess(identity.pid, "SIGTERM")) return;

  while (monotonicNow() < graceDeadline) {
    const waitMs = Math.min(100, Math.max(0, graceDeadline - monotonicNow()));
    if (waitMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const current = await probe.validate(identity);
    if (!stillSameChild(current)) return;
  }
  if (monotonicNow() >= budgetDeadline) return;
  const beforeKill = await probe.validate(identity);
  if (stillSameChild(beforeKill)) signalProcess(identity.pid, "SIGKILL");
}

/**
 * The `validate()` failure reasons that describe the probe rather than the
 * process. Written as a total record over ProcessIdentityProbeFailureReason so
 * that growing that union fails to compile here instead of silently letting a
 * new infrastructure failure fall through to `provider_identity_mismatch`.
 */
const probeInfrastructureFailures: Record<ProcessIdentityProbeFailureReason, true> = {
  probe_timeout: true,
  probe_output_limit: true,
  probe_failed: true,
  probe_command_unreadable: true,
  probe_identity_unstable: true,
};

function probeDidNotComplete(
  reason: ProcessIdentityValidationFailureReason,
): reason is ProcessIdentityProbeFailureReason {
  return Object.prototype.hasOwnProperty.call(probeInfrastructureFailures, reason);
}

async function decideProviderRecovery(input: {
  run: typeof runs.$inferSelect;
  provider: ProviderRunProcess;
  job: typeof pipelineJobs.$inferSelect | null;
  observedAt: Date;
  heartbeatStaleMs: number;
  probe: ProcessIdentityProbe;
}): Promise<RecoveryDecision | null> {
  const { run, provider, job, observedAt, heartbeatStaleMs, probe } = input;
  // Snapshot the inputs every decision below is derived from, so the persisted
  // event carries the evidence instead of only the verdict.
  const observe = (extra: RecoveryObservation = {}): RecoveryObservation => ({
    providerHeartbeatAgeMs: providerHeartbeatAgeMs(provider, observedAt),
    jobHeartbeatAgeMs: jobHeartbeatAgeMs(job, observedAt),
    heartbeatStaleMs,
    jobStatus: job?.status ?? null,
    ...extra,
  });
  if (provider.status !== "running") {
    const completed = provider.status === "completed";
    if (completed) {
      // A clean provider exit is not, on its own, a business outcome. The
      // lifecycle sink marks the provider `completed` the instant the process
      // ends (createProviderLifecycleSink.onTerminal -> finishProviderRun), and
      // EVERY phase writes its business evidence after that point: artifacts and
      // snapshots, the Spec battle's blue leg plus its report commit, the Review
      // report, the Build adoption. "provider completed + evidence incomplete"
      // is therefore the normal mid-flight state of a healthy run, not a fault.
      // It only becomes a fault once nobody is left to finish the commit.
      //
      // The owning worker heartbeats its job every 10s for the whole of
      // runPipelineJob -- across both legs of a Spec battle -- and that renewal
      // is fenced, so it stops the moment the worker loses the job. A fresh job
      // heartbeat is thus a positive proof that the commit is still coming, and
      // it is the same reprieve a failed identity probe and a missing pid
      // already get below. Both of those are strictly stronger negative signals
      // than a provider exiting exactly as designed, so withholding recovery
      // here is the weaker, safer claim.
      //
      // Reconciling anyway does not merely mis-report: it steals the job from a
      // live worker. Every job CAS is fenced on `status='running'`, so writing a
      // terminal job status makes the worker's own heartbeat/complete/fail calls
      // fail their fence and blow up mid-flight. Withholding costs at most one
      // heartbeat-stale window of delay before a genuinely stranded run is
      // reconciled.
      if (jobHeartbeatIsFresh(job, observedAt, heartbeatStaleMs)) return null;
      return {
        reasonCode: "business_run_reconciled",
        providerStatus: "completed",
        runStatus: "completed",
        jobStatus: "succeeded",
        requiresBusinessEvidence: true,
        observation: observe(),
      };
    }
    return {
      reasonCode: "business_run_reconciled",
      providerStatus: provider.status as RecoveryDecision["providerStatus"],
      runStatus: "failed",
      jobStatus: "failed",
    };
  }

  const leaseExpired = Boolean(
    job?.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= observedAt.getTime(),
  );
  const fenceInvalid = Boolean(
    job && (!inArrayValue(job.status, ["leased", "running"])
      || !sameFence(run, job)
      || provider.leaseToken !== run.leaseToken
      || provider.attemptNo !== run.attemptNo),
  );
  if (leaseExpired || fenceInvalid) {
    // A failed fence check is the stronger statement -- something else already
    // owns this slot -- so it wins when both hold. A lease that merely ran out
    // while the fence still matches says only that this run stopped renewing,
    // which is a different diagnosis and gets its own code.
    return {
      reasonCode: fenceInvalid ? "stale_lease_fenced" : "provider_lease_expired",
      providerStatus: "stopped",
      runStatus: "failed",
      jobStatus: "failed",
      observation: observe({ leaseExpired, fenceInvalid }),
    };
  }

  if (provider.provider === "codex" && provider.pid === null) {
    if (!hasValidExternalRef(provider)) {
      if (jobHeartbeatIsFresh(job, observedAt, heartbeatStaleMs)) return null;
      return {
        reasonCode: "provider_protocol_invalid",
        providerStatus: "orphaned",
        runStatus: "failed",
        jobStatus: "failed",
        observation: observe(),
      };
    }
    if (!heartbeatIsStale(provider, observedAt, heartbeatStaleMs)) return null;
    return {
      reasonCode: "provider_heartbeat_stale",
      providerStatus: "orphaned",
      runStatus: "failed",
      jobStatus: "failed",
      shouldTerminate: false,
      observation: observe(),
    };
  }
  if (provider.pid === null) {
    return {
      reasonCode: "provider_process_orphaned",
      providerStatus: "orphaned",
      runStatus: "failed",
      jobStatus: "failed",
      observation: observe(),
    };
  }
  const identity = processIdentityForProvider(provider);
  if (!identity) {
    return {
      reasonCode: "provider_identity_mismatch",
      providerStatus: "orphaned",
      runStatus: "failed",
      jobStatus: "failed",
      observation: observe(),
    };
  }
  const validation = await probe.validate(identity);
  if (!validation.ok) {
    const observation = observe({ identityValidation: validation.reason });
    // Ask whether the probe produced an observation at all before interpreting
    // one. A timed-out or failed `ps`/`lsof` says nothing about the process, so
    // it must not be reported as a fact about the process's identity.
    if (probeDidNotComplete(validation.reason)) {
      // ...and having produced no verdict, it is not evidence against the
      // process either. A run that is still heartbeating on both the provider
      // and its job is demonstrably alive, and "we could not look" must never
      // be grounds to kill it -- this is the same reprieve pid_missing gets
      // below, which is a strictly stronger negative signal (the pid is gone,
      // rather than merely unobserved). Withholding recovery is the safe
      // direction: it signals nothing, so it cannot touch a foreign process.
      // Once the heartbeats stop, the cleanup below runs as before.
      if (
        !heartbeatIsStale(provider, observedAt, heartbeatStaleMs)
        && jobHeartbeatIsFresh(job, observedAt, heartbeatStaleMs)
      ) {
        return null;
      }
      return {
        reasonCode: "provider_identity_probe_failed",
        providerStatus: "orphaned",
        runStatus: "failed",
        jobStatus: "failed",
        observation,
      };
    }
    if (validation.reason === "pid_missing") {
      if (
        !heartbeatIsStale(provider, observedAt, heartbeatStaleMs)
        && jobHeartbeatIsFresh(job, observedAt, heartbeatStaleMs)
      ) {
        return null;
      }
      return {
        reasonCode: "provider_process_orphaned",
        providerStatus: "orphaned",
        runStatus: "failed",
        jobStatus: "failed",
        observation,
      };
    }
    if (validation.reason === "ppid_dead") {
      try {
        const recaptured = await probe.capture(identity.pid, {
          pid: identity.pid,
          pgid: identity.pgid,
          processStartTime: identity.processStartTime,
          cwd: identity.cwd,
          command: identity.command,
        });
        if (strongIdentityMatchesAfterReparent(identity, recaptured)) {
          return {
            reasonCode: "provider_parent_missing",
            providerStatus: "orphaned",
            runStatus: "failed",
            jobStatus: "failed",
            identity: recaptured,
            shouldTerminate: true,
            observation,
          };
        }
      } catch {
        // The child remains unmanaged unless every observable strong field matches.
      }
      return {
        reasonCode: "provider_parent_missing",
        providerStatus: "orphaned",
        runStatus: "failed",
        jobStatus: "failed",
        shouldTerminate: false,
        summary: "provider_parent_missing:cleanup_deferred_unmanaged",
        observation,
      };
    }
    if (validation.reason === "ppid_mismatch") {
      return {
        reasonCode: "provider_parent_mismatch",
        providerStatus: "orphaned",
        runStatus: "failed",
        jobStatus: "failed",
        observation,
      };
    }
    // Everything left is a completed probe that disagreed with the persisted
    // identity (pid_reused, cwd/command/nonce mismatch): a real mismatch.
    return {
      reasonCode: "provider_identity_mismatch",
      providerStatus: "orphaned",
      runStatus: "failed",
      jobStatus: "failed",
      observation,
    };
  }

  if (heartbeatIsStale(provider, observedAt, heartbeatStaleMs)) {
    return {
      reasonCode: "provider_heartbeat_stale",
      providerStatus: "orphaned",
      runStatus: "failed",
      jobStatus: "failed",
      identity: validation.observed,
      shouldTerminate: true,
      observation: observe(),
    };
  }
  return null;
}

export async function recoverStaleProviderRuns(
  options: StaleProviderRunRecoveryOptions = {},
): Promise<ProviderRunRecoveryReport> {
  const maxCandidates = normalizeRecoveryBound(
    "maxCandidates",
    options.maxCandidates,
    options.changeId ? DEFAULT_SCOPED_RECOVERY_MAX_CANDIDATES : DEFAULT_GLOBAL_RECOVERY_MAX_CANDIDATES,
    ABSOLUTE_MAX_RECOVERY_CANDIDATES,
  );
  const timeBudgetMs = normalizeRecoveryBound(
    "timeBudgetMs",
    options.timeBudgetMs,
    options.changeId ? DEFAULT_SCOPED_RECOVERY_TIME_BUDGET_MS : DEFAULT_GLOBAL_RECOVERY_TIME_BUDGET_MS,
    ABSOLUTE_MAX_RECOVERY_TIME_BUDGET_MS,
  );
  const maxReviewFindings = normalizeRecoveryBound(
    "maxReviewFindings",
    options.maxReviewFindings,
    DEFAULT_MAX_REVIEW_FINDINGS,
    ABSOLUTE_MAX_REVIEW_FINDINGS,
  );
  const maxArtifactBytes = normalizeRecoveryBound(
    "maxArtifactBytes",
    options.maxArtifactBytes,
    DEFAULT_MAX_ARTIFACT_BYTES,
    ABSOLUTE_MAX_ARTIFACT_BYTES,
  );
  const now = options.now ?? (() => new Date());
  const observedAt = options.observedAt ?? now();
  const monotonicNow = options.monotonicNowForTest ?? Date.now;
  const deadline = monotonicNow() + timeBudgetMs;
  const remainingBudgetMs = (): number => Math.max(0, deadline - monotonicNow());
  const assertWithinBudget = (): void => {
    if (remainingBudgetMs() <= 0) throw new RecoveryDeadlineExceededError();
  };
  const heartbeatStaleMs = options.providerHeartbeatStaleMs
    ?? options.staleAfterMs
    ?? DEFAULT_PROVIDER_HEARTBEAT_STALE_MS;
  const probe = options.processIdentityProbe ?? processIdentityProbe;
  const terminateProcess = options.terminateProcess
    ?? ((identity: ProcessIdentity) => terminateValidatedProcess(
      identity,
      probe,
      remainingBudgetMs(),
      monotonicNow,
    ));
  const execute = options.execute ?? false;
  const cursorIsValid = validRecoveryCursor(options.cursor);
  const effectiveCursor = cursorIsValid ? options.cursor : undefined;
  const report: ProviderRunRecoveryReport = {
    recovered: [],
    failed: [],
    observed: [],
    observedAt: observedAt.toISOString(),
    processedCandidates: 0,
    truncated: false,
    deferred: [],
    nextCursor: effectiveCursor ?? null,
    ...(options.cursor && !cursorIsValid ? { cursorResetReason: "invalid_cursor" as const } : {}),
  };

  const startGraceMs = options.providerStartGraceMs ?? DEFAULT_PROVIDER_START_GRACE_MS;
  const legacyGraceMs = options.legacyLifecycleGraceMs ?? DEFAULT_LEGACY_LIFECYCLE_GRACE_MS;
  if (remainingBudgetMs() <= 0) {
    report.truncated = true;
    report.deferred.push({ reason: "time_budget", count: 1, atLeast: true });
    return report;
  }
  const candidateBatch = recoveryCandidates(
    options.changeId,
    maxCandidates,
    effectiveCursor,
    options.onCandidateDbQuery,
    options.onCandidateRowsLoadedForTest,
  );
  if (candidateBatch.providerPrefetchOverflow) {
    report.truncated = true;
    report.deferred.push({ reason: "provider_prefetch_limit", count: 1, atLeast: true });
    return report;
  }
  if (remainingBudgetMs() <= 0) {
    report.truncated = candidateBatch.candidates.length > 0 || candidateBatch.truncated;
    report.deferred.push({
      reason: "time_budget",
      count: candidateBatch.candidates.length,
      atLeast: candidateBatch.truncated,
    });
    return report;
  }
  if (candidateBatch.truncated) {
    report.truncated = true;
    report.deferred.push({ reason: "candidate_limit", count: 1, atLeast: true });
  }
  for (let index = 0; index < candidateBatch.candidates.length; index += 1) {
    const { run, provider, job } = candidateBatch.candidates[index];
    if (remainingBudgetMs() <= 0) {
      report.truncated = true;
      report.deferred.push({
        reason: "time_budget",
        count: candidateBatch.candidates.length - index,
        atLeast: candidateBatch.truncated,
      });
      break;
    }
    const cursorBeforeCandidate = report.nextCursor;
    const deferredBeforeCandidate = report.deferred.length;
    report.processedCandidates += 1;
    report.nextCursor = { startedAt: run.startedAt, id: run.id };
    try {
      if (!provider) {
        const leaseExpired = Boolean(
          job?.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= observedAt.getTime(),
        );
        const fenceInvalid = Boolean(
          job && (!inArrayValue(job.status, ["leased", "running"]) || !sameFence(run, job)),
        );
        const startedAtMs = Date.parse(run.startedAt ?? "");
        const runAgeMs = Number.isFinite(startedAtMs)
          ? observedAt.getTime() - startedAtMs
          : null;
        // An unparseable startedAt is treated as exactly at the grace boundary,
        // the same as before; runAgeMs stays null so the recorded evidence does
        // not claim an age that was never observed.
        const ageMs = runAgeMs ?? startGraceMs;
        const legacy = run.phase === "implement" || run.phase === "fix_findings";
        const threshold = legacy ? legacyGraceMs : startGraceMs;
        if (!leaseExpired && !fenceInvalid && ageMs < threshold) {
          report.observed.push({
            kind: "active",
            processId: `missing:${run.id}`,
            runId: run.id,
            changeId: run.changeId,
            phase: run.phase,
            reason: "provider_start_grace",
          });
          continue;
        }
        // Same precedence as the provider-present path: a failed fence check
        // outranks a lease that merely ran out.
        const reasonCode = fenceInvalid
          ? "stale_lease_fenced"
          : leaseExpired
            ? "provider_lease_expired"
            : legacy
              ? "legacy_lifecycle_missing"
              : "provider_start_missing";
        if (!execute) {
          report.observed.push({
            kind: "stale",
            processId: `missing:${run.id}`,
            runId: run.id,
            changeId: run.changeId,
            phase: run.phase,
            reason: reasonCode,
            reasonCode,
          });
          continue;
        }
        const result = recoverMissingProvider({
          run,
          reasonCode,
          recoveredAt: observedAt.toISOString(),
          observation: {
            jobHeartbeatAgeMs: jobHeartbeatAgeMs(job, observedAt),
            runAgeMs,
            heartbeatStaleMs,
            jobStatus: job?.status ?? null,
            leaseExpired,
            fenceInvalid,
          },
          assertWithinBudget,
          beforeCommitForTest: options.beforeRecoveryCommitForTest,
        });
        report.observed.push(result ?? {
          kind: "skipped",
          processId: `missing:${run.id}`,
          runId: run.id,
          changeId: run.changeId,
          phase: run.phase,
          reason: "already_reconciled",
          reasonCode: "already_reconciled",
        });
        if (result) report.recovered.push(result);
        continue;
      }

      if (!providerOwnershipMatchesRun(provider, run)) {
        report.observed.push({
          kind: "skipped",
          processId: provider.id,
          runId: run.id,
          changeId: run.changeId,
          phase: run.phase,
          reason: "ownership_mismatch",
          reasonCode: "ownership_mismatch",
        });
        continue;
      }

      const decision: RecoveryDecision | null = run.status !== "running"
        ? {
            reasonCode: "business_run_reconciled",
            providerStatus: run.status === "completed" ? "completed" : "failed",
            runStatus: run.status === "completed" ? "completed" : "failed",
            jobStatus: run.status === "completed" ? "succeeded" : "failed",
          }
        : await decideProviderRecovery({
            run,
            provider,
            job,
            observedAt,
            heartbeatStaleMs,
            probe,
          });
      assertWithinBudget();
      if (!decision) {
        report.observed.push({
          kind: "active",
          processId: provider.id,
          runId: run.id,
          changeId: run.changeId,
          phase: run.phase,
          // A terminal provider never reaches the identity probe, so reporting
          // "identity_valid" for one would be a claim nothing checked. The only
          // way a terminal provider yields no decision is the live-worker
          // reprieve, so name that instead -- an operator asking why a completed
          // provider was left alone gets the actual answer.
          reason: provider.status !== "running"
            ? "provider_terminal_business_commit_pending"
            : provider.provider === "codex" && provider.pid === null
              ? "external_ref_heartbeat_fresh"
              : "identity_valid",
        });
        continue;
      }
      if (!execute) {
        report.observed.push({
          kind: "stale",
          processId: provider.id,
          runId: run.id,
          changeId: run.changeId,
          phase: run.phase,
          reason: decision.reasonCode,
          reasonCode: decision.reasonCode,
        });
        continue;
      }
      if (run.status !== "running") {
        const terminalResult = recoverProviderAfterTerminalRun({
          run,
          provider,
          job,
          decision,
          recoveredAt: observedAt.toISOString(),
          assertWithinBudget,
        });
        const result = terminalResult ?? {
          kind: "skipped" as const,
          processId: provider.id,
          runId: run.id,
          changeId: run.changeId,
          phase: run.phase,
          reason: "already_reconciled",
          reasonCode: "already_reconciled",
        };
        report.observed.push(result);
        if (terminalResult?.kind === "recovered") report.recovered.push(terminalResult);
        continue;
      }
      const evidenceObservation = decision.requiresBusinessEvidence
        ? businessEvidenceForCompletedProvider(
          db,
          run,
          provider,
          maxReviewFindings,
          options.onEvidenceProbe,
          options.onEvidenceDbQuery,
          maxArtifactBytes,
        )
        : null;
      assertWithinBudget();
      if (evidenceObservation?.missingEvidence.includes("review_findings_limit")) {
        report.truncated = true;
        report.deferred.push({ reason: "review_findings_limit", count: 1, runId: run.id, atLeast: true });
        continue;
      }
      const recoveryOutcome = recoverExistingProvider({
        run,
        provider,
        job,
        decision,
        recoveredAt: observedAt.toISOString(),
        evidenceObservation,
        onEvidenceProbe: options.onEvidenceProbe,
        onEvidenceDbQuery: options.onEvidenceDbQuery,
        evidenceDriftAfterCommitForTest: options.evidenceDriftAfterCommitForTest,
        assertWithinBudget,
        maxReviewFindings,
        beforeCommitForTest: options.beforeRecoveryCommitForTest,
      });
      const recovered = recoveryOutcome?.result ?? null;
      if (recoveryOutcome?.postCommitCompensated && remainingBudgetMs() <= 0) {
        report.truncated = true;
        report.deferred.push({ reason: "time_budget", count: 1, runId: run.id });
      }
      const result = recovered ?? {
        kind: "skipped" as const,
        processId: provider.id,
        runId: run.id,
        changeId: run.changeId,
        phase: run.phase,
        reason: "already_reconciled",
        reasonCode: "already_reconciled",
      };
      report.observed.push(result);
      if (recovered) {
        report.recovered.push(recovered);
        if (decision.shouldTerminate && decision.identity) {
          options.beforeTerminateOwnershipCheckForTest?.();
          if (remainingBudgetMs() <= 0) {
            report.truncated = true;
            report.deferred.push({ reason: "time_budget", count: 1, runId: run.id });
          } else if (providerOwnershipAndIdentityMatchCurrentState(
            provider,
            run,
            job,
            decision.jobStatus,
            observedAt.toISOString(),
            decision.identity,
          )) {
            await terminateProcess(decision.identity);
          }
        }
      }
    } catch (error) {
      if (error instanceof RecoveryDeadlineExceededError) {
        report.truncated = true;
        report.deferred.push({
          reason: "time_budget",
          count: candidateBatch.candidates.length - index,
          atLeast: candidateBatch.truncated,
        });
        break;
      }
      recordRecoveryFailure(report, run, error);
    } finally {
      if (report.deferred.length > deferredBeforeCandidate) {
        report.nextCursor = cursorBeforeCandidate;
      }
    }
  }

  if (!report.truncated) report.nextCursor = null;

  return report;
}

export async function recoverStaleProviderRunsBestEffort(
  changeId?: string,
): Promise<ProviderRunRecoveryReport> {
  const scope = changeId ?? "__global__";
  try {
    const report = await recoverStaleProviderRuns({
      ...(bestEffortOptionsForTest ?? {}),
      changeId,
      execute: true,
      cursor: bestEffortCursors.get(scope),
    });
    if (report.nextCursor) bestEffortCursors.set(scope, report.nextCursor);
    else bestEffortCursors.delete(scope);
    return report;
  } catch (error) {
    const observedAt = new Date().toISOString();
    const errorSummary = error instanceof Error ? error.message : String(error);
    try {
      runLedgerRepository.insertEvent({
        id: runLedgerRepository.nextRunLedgerId("EVT"),
        changeId: changeId ?? null,
        runId: null,
        type: "stale_provider_run_recovery_failed",
        message: "Provider run recovery failed",
        rawJson: JSON.stringify({
          schemaVersion: "stale_provider_run_recovery_failed/v1",
          changeId: changeId ?? null,
          code: "recovery_failed",
        }),
        createdAt: new Date().toISOString(),
      });
    } catch {
      // This path runs from page refresh/SSE setup. Recovery telemetry must never
      // make a read endpoint fail.
    }
    return {
      recovered: [],
      observed: [],
      observedAt,
      processedCandidates: 0,
      truncated: false,
      deferred: [],
      nextCursor: null,
      failed: [{
        runId: "unknown",
        changeId: changeId ?? "unknown",
        phase: "unknown",
        code: "recovery_failed",
        error: errorSummary,
      }],
    };
  }
}
