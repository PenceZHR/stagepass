import {
  DEFAULT_AI_PROVIDER_TIMEOUT_MS,
  resolveAiProviderTimeoutMs,
} from "./ai-timeout-policy";

const STAGE_BUDGET_GRACE_MS = 5 * 60_000;

/**
 * Stage execution budget. Sits above every per-stage provider timeout so the
 * stage runner's own timeout reports the failure first and the fence stays a
 * backstop rather than the thing that kills healthy turns.
 */
export const DEFAULT_STAGE_TURN_BUDGET_MS =
  DEFAULT_AI_PROVIDER_TIMEOUT_MS + STAGE_BUDGET_GRACE_MS;

export function stageTurnBudgetMs(): number {
  return resolveAiProviderTimeoutMs(
    "STAGEPASS_STAGE_TURN_BUDGET_MS",
    DEFAULT_STAGE_TURN_BUDGET_MS,
  );
}

export interface PipelineJobDeadlineFacts {
  jobKind?: string | null;
  effectDeadlineAt?: string | null;
  startedAt?: string | null;
  leaseExpiresAt?: string | null;
}

/**
 * How long the owner of a pipeline job may keep an effect running.
 *
 * Interaction jobs carry an explicit `effectDeadlineAt` decided by whoever
 * queued them. Stage jobs are forbidden from carrying one (see
 * `trg_pipeline_jobs_effect_*`), and their lease is a liveness signal renewed
 * every few seconds -- not a statement about how long the stage may run. Using
 * the lease expiry as the deadline capped every Codex turn at one lease period
 * (30s), so a real App turn died as `turn_observation_timeout` while it was
 * still running, and `heartbeatCodexOwnerFence` could never renew past it.
 *
 * Anchoring on `startedAt` keeps the value stable across heartbeats, which is
 * what the fence assumes: a deadline is decided once and never extended. The
 * lease expiry stays a floor, so a job re-leased after its budget already
 * elapsed keeps exactly the reach it had before this rule existed instead of
 * being refused outright.
 */
export function pipelineJobOwnerDeadlineAt(
  job: PipelineJobDeadlineFacts,
): string {
  if (job.effectDeadlineAt) return job.effectDeadlineAt;
  const startedAt = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
  if ((job.jobKind ?? "stage") !== "stage" || !Number.isFinite(startedAt)) {
    return job.leaseExpiresAt!;
  }
  const budgeted = startedAt + stageTurnBudgetMs();
  const leaseExpiresAt = job.leaseExpiresAt
    ? Date.parse(job.leaseExpiresAt)
    : Number.NaN;
  return new Date(
    Number.isFinite(leaseExpiresAt) ? Math.max(budgeted, leaseExpiresAt) : budgeted,
  ).toISOString();
}
