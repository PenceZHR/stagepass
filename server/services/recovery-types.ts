import type { pipelineJobs } from "../db/schema";
import type {
  ProcessIdentity,
  ProcessIdentityValidationFailureReason,
} from "./process-identity-service";

/**
 * Shared internal types for the stale-provider-run recovery subsystem. Extracted
 * so predicate, evidence, and executor modules can share them without importing
 * the large orchestrator. The recovery result/kind live here (re-exported by the
 * facade to keep its public surface stable); the option/report shapes stay with
 * the facade in stale-provider-run-recovery-service.ts.
 */

/**
 * Default cap on review findings materialized during evidence gathering. Shared
 * by the orchestrator (public default), the evidence module, and the executors
 * so the three cannot silently diverge.
 */
export const DEFAULT_MAX_REVIEW_FINDINGS = 500;

export type ProviderRunRecoveryKind = "active" | "stale" | "recovered" | "skipped";

export interface StaleProviderRunRecoveryResult {
  kind: ProviderRunRecoveryKind;
  processId: string;
  runId: string;
  changeId: string;
  phase: string;
  reason: string;
  reasonCode?: string;
}

/**
 * What the sweeper observed, not what caused it.
 *
 * `provider_identity_mismatch` vs `provider_identity_probe_failed`: the first
 * means the probe ran to completion and the process it found is provably not
 * ours (reused pid, different cwd/command/nonce). The second means the probe
 * itself never produced an observation -- it timed out, blew its output limit,
 * or failed to run -- so the identity is simply *unknown*. Collapsing the two
 * makes an unanswered `ps` look like proof of a wrong process, which points a
 * reader at process identity when the real story is a host that could not
 * answer inside the probe budget.
 *
 * `provider_lease_expired` vs `stale_lease_fenced`: the first means this run
 * still holds the fence but its job lease deadline had already passed -- the
 * signature of a run that stopped renewing (a stall). The second means a fence
 * check failed outright: the job is terminal, or the lease token / attempt no
 * longer matches, i.e. something else owns this slot. Events written before the
 * split carry `stale_lease_fenced` for both situations; the code has only ever
 * narrowed, so an old row still means "one of these two".
 */
export type RecoveryReasonCode =
  | "provider_start_missing"
  | "business_run_reconciled"
  | "provider_protocol_invalid"
  | "legacy_lifecycle_missing"
  | "provider_process_orphaned"
  | "provider_identity_mismatch"
  | "provider_identity_probe_failed"
  | "provider_parent_missing"
  | "provider_parent_mismatch"
  | "provider_heartbeat_stale"
  | "provider_lease_expired"
  | "stale_lease_fenced";

/**
 * The facts a recovery decision was made from, persisted alongside the reason
 * code so the next post-mortem reads them instead of re-deriving them from
 * logs. Every field is an observation with no cause attached: a stale heartbeat
 * and a failed identity probe are equally consistent with a crash, a SIGKILL, a
 * machine that went to sleep, and a host too busy to answer `ps` in time.
 * Record what was seen; leave the attribution to the reader.
 */
export interface RecoveryObservation {
  /** Discriminator from ProcessIdentityProbe.validate, when a probe ran. */
  identityValidation?: ProcessIdentityValidationFailureReason;
  /** observedAt minus the provider heartbeat (or startedAt); null if unparseable. */
  providerHeartbeatAgeMs?: number | null;
  /** observedAt minus the job heartbeat (or startedAt/createdAt); null if absent. */
  jobHeartbeatAgeMs?: number | null;
  /** observedAt minus runs.startedAt; null if absent or unparseable. */
  runAgeMs?: number | null;
  /** The staleness threshold in force for this sweep, so the ages can be judged. */
  heartbeatStaleMs?: number;
  /** pipeline_jobs.leaseExpiresAt had already passed at observedAt. */
  leaseExpired?: boolean;
  /** Job terminal, or lease-token / attempt-number drift across run and provider. */
  fenceInvalid?: boolean;
  /** pipeline_jobs.status at observation time; null when the run has no job row. */
  jobStatus?: string | null;
}

export interface RecoveryDecision {
  reasonCode: RecoveryReasonCode;
  providerStatus: "completed" | "failed" | "stopped" | "orphaned";
  runStatus: "completed" | "failed" | "stopped";
  jobStatus: "succeeded" | "failed";
  identity?: ProcessIdentity;
  shouldTerminate?: boolean;
  summary?: string;
  requiresBusinessEvidence?: boolean;
  observation?: RecoveryObservation;
}

export interface FileEvidenceObservation {
  repoPath: string;
  repoRealPath: string;
  rawPath: string;
  realPath: string;
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  contentHash: string;
  expectedMirrorHash: string | null;
}

export interface BusinessEvidenceObservation {
  complete: boolean;
  missingEvidence: string[];
  dbSnapshot: string;
  files: FileEvidenceObservation[];
}

export interface RecoveryOwnership {
  currentJob: typeof pipelineJobs.$inferSelect | null;
  ownershipMismatch: boolean;
  newerAttemptExists: boolean;
  oldJobOwned: boolean;
  ownsChange: boolean;
}
