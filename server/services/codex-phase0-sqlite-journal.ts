import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import type {
  CodexDesktopTurnRequest,
  CodexFollowerStartAttempt,
  CodexFollowerStartAttemptPort,
  CodexFollowerStartFence,
  CodexFollowerStartRecoveryFence,
  CodexLogicalTurnIdentity,
  CodexLogicalTurnPort,
  CodexLogicalTurnRole,
  CodexLogicalTurnStartContext,
  CodexManagedOwner,
  CodexManagedScope,
  CodexShellProvisionPort,
  CodexTurnSnapshot,
} from "./codex-desktop-bridge-types";
import { dispatchSurfaceForRole } from "./codex-desktop-bridge-types";

type SqliteDatabase = InstanceType<typeof Database>;
type ScopeKind = CodexManagedScope["kind"];
type Purpose = CodexFollowerStartFence["purpose"];

export type CodexPhase0JournalFailpoint =
  | "after_prepare"
  | "after_no_client_found"
  | "after_dispatch_cas"
  | "before_success_cas"
  | "after_host_ack_before_receipt"
  | "after_host_ack_before_settlement";

export class CodexPhase0InjectedCrash extends Error {
  readonly phase0CrashCheckpoint: CodexPhase0JournalFailpoint;

  constructor(checkpoint: CodexPhase0JournalFailpoint) {
    super(`phase0 journal failpoint: ${checkpoint}`);
    this.name = "CodexPhase0InjectedCrash";
    this.phase0CrashCheckpoint = checkpoint;
  }
}

export interface CodexPhase0ManagedRunSeed {
  ownerKind: CodexManagedOwner["kind"];
  ownerId: string;
  projectId: string;
  scopeKind: ScopeKind;
  scopeId: string;
  changeId?: string;
  phase: string;
  role: CodexLogicalTurnRole;
  round: number;
  ordinal: number;
  binding: { threadId: string; cwd: string; title: string };
  request: Omit<CodexDesktopTurnRequest, "threadId">;
  purpose?: Purpose;
  workerId?: string;
  leaseToken?: string;
  ownerAttempt?: number;
  ownerEpoch?: number;
  deadlineAt?: string;
  leaseExpiresAt?: string;
}

export interface CodexPhase0RestartCheckpoint {
  runId: string;
  state: "awaiting_resume" | "consumed";
  logicalTurnId: string;
  attemptId: string;
  correlationMarker: string;
  normalizedPromptHash: string;
  preStartTurnIds: string[];
  preStartSemanticHash: string;
  dispatchOrdinal: number;
  turnId: string;
  shellThreadId: string;
  desktopPid: number;
  processStartedAt: string;
  socketPath: string;
  socketDevice: number;
  socketInode: number;
  observationCursor: number;
  lastSnapshotHash: string;
  lastNormalizedSnapshot: CodexTurnSnapshot;
  resumedLogicalTurnId: string | null;
  resumedAttemptId: string | null;
  resumedCorrelationMarker: string | null;
  resumedNormalizedPromptHash: string | null;
  resumedPreStartSemanticHash: string | null;
  resumedShellThreadId: string | null;
  resumedDispatchOrdinal: number | null;
  resumedTurnId: string | null;
  consumedAt: string | null;
}

interface OwnerRow {
  owner_id: string;
  project_id: string;
  change_id: string | null;
  worker_id: string;
  lease_token: string;
  owner_attempt: number;
  owner_epoch: number;
  deadline_at: string;
  lease_expires_at: string;
  status: "running" | "completed" | "failed";
}

interface BindingRow {
  binding_id: string;
  scope_kind: ScopeKind;
  scope_id: string;
  project_id: string;
  change_id: string | null;
  thread_id: string | null;
  candidate_thread_id: string | null;
  bootstrap_activation_requested: number;
  creator_baseline_turn_ids_json: string | null;
  creator_baseline_semantic_hash: string | null;
  materialization_logical_turn_id: string | null;
  cwd: string;
  title: string;
  provision_state:
    | "provisioning"
    | "bootstrap_ready"
    | "materializing"
    | "durable_ready"
    | "ambiguous";
  claim_owner_id: string | null;
  claim_lease_token: string | null;
  claim_lease_expires_at: string | null;
  provision_deadline_at: string | null;
  claim_owner_attempt: number | null;
  claim_owner_epoch: number | null;
  baseline_thread_ids_json: string;
  last_error: string | null;
}

const PHASE0_JOURNAL_SCHEMA_VERSION = 4;

interface LogicalRow {
  logical_turn_id: string;
  pipeline_job_id: string | null;
  project_ai_run_id: string | null;
  binding_id: string;
  phase: string;
  role: CodexLogicalTurnRole;
  round: number;
  ordinal: number;
  turn_slot: string;
  run_correlation_id: string;
  dispatch_surface: "follower_ipc" | "host_ui_message";
  purpose: Purpose | null;
  request_json: string | null;
}

interface AttemptRow {
  attempt_id: string;
  logical_turn_id: string;
  pipeline_job_id: string | null;
  project_ai_run_id: string | null;
  binding_id: string;
  request_json: string;
  correlation_marker: string;
  normalized_prompt_hash: string;
  pre_start_turn_ids_json: string;
  pre_start_semantic_hash: string;
  state: CodexFollowerStartAttempt["state"];
  dispatch_ordinal: number;
  turn_id: string | null;
  code: "desktop_follower_start_ambiguous" | null;
  ambiguous_reason: CodexFollowerStartAttempt["ambiguousReason"] | null;
  project_id: string;
  scope_kind: ScopeKind;
  scope_id: string;
  worker_id: string;
  lease_token: string;
  owner_attempt: number;
  owner_epoch: number;
  purpose: Purpose;
  dispatch_surface: "follower_ipc" | "host_ui_message";
  deadline_at: string;
  original_deadline_at: string;
  lease_expires_at: string;
  recovery_owner_id: string | null;
  recovery_lease_token: string | null;
  recovery_owner_attempt: number | null;
  recovery_epoch: number | null;
  recovery_deadline_at: string | null;
  recovery_lease_expires_at: string | null;
}

interface RestartCheckpointRow {
  run_id: string;
  state: "awaiting_resume" | "consumed";
  logical_turn_id: string;
  attempt_id: string;
  correlation_marker: string;
  normalized_prompt_hash: string;
  pre_start_turn_ids_json: string;
  pre_start_semantic_hash: string;
  dispatch_ordinal: number;
  turn_id: string;
  shell_thread_id: string;
  desktop_pid: number;
  process_started_at: string;
  socket_path: string;
  socket_device: number;
  socket_inode: number;
  observation_cursor: number;
  last_snapshot_hash: string;
  last_normalized_snapshot_json: string;
  resumed_logical_turn_id: string | null;
  resumed_attempt_id: string | null;
  resumed_correlation_marker: string | null;
  resumed_normalized_prompt_hash: string | null;
  resumed_pre_start_semantic_hash: string | null;
  resumed_shell_thread_id: string | null;
  resumed_dispatch_ordinal: number | null;
  resumed_turn_id: string | null;
  consumed_at: string | null;
}

export interface CodexPhase0SqliteJournal {
  logicalTurnPort: CodexLogicalTurnPort;
  startAttemptPort: CodexFollowerStartAttemptPort;
  shellProvisionPort: CodexShellProvisionPort;
  seedManagedRun(
    input: CodexPhase0ManagedRunSeed,
  ): Promise<{ logicalTurnId: string; fence: CodexFollowerStartFence }>;
  takeOverOwner(input: {
    owner: CodexManagedOwner;
    expectedWorkerId: string;
    expectedLeaseToken: string;
    expectedOwnerAttempt: number;
    expectedOwnerEpoch: number;
    expectedDeadlineAt: string;
    expectedLeaseExpiresAt: string;
    expectedStatus: "running";
    workerId: string;
    leaseToken: string;
    ownerAttempt: number;
    ownerEpoch: number;
    deadlineAt: string;
    leaseExpiresAt: string;
  }): Promise<void>;
  readOwner(fence: CodexFollowerStartFence): {
    ownerId: string;
    projectId: string;
    workerId: string;
    leaseToken: string;
    ownerAttempt: number;
    ownerEpoch: number;
  };
  readBinding(scopeKind: ScopeKind, scopeId: string): {
    bindingId: string;
    scopeKind: ScopeKind;
    scopeId: string;
    projectId: string;
    changeId: string | null;
    threadId: string;
  };
  inspectShellProvision(scopeKind: ScopeKind, scopeId: string): {
    provisionId: string;
    state: BindingRow["provision_state"];
    candidateThreadId: string | null;
    threadId: string | null;
    cwd: string;
    title: string;
    materializationLogicalTurnId: string | null;
    creatorBaselineTurnIds: string[] | null;
    creatorBaselineSemanticHash: string | null;
    attempt: CodexFollowerStartAttempt | null;
    candidateCount: number;
    attemptCount: number;
    executionCount: number;
  };
  readLogicalTurn(logicalTurnId: string): {
    logicalTurnId: string;
    owner: CodexManagedOwner;
    ownerId: string;
    turnSlot: string;
    runCorrelationId: string;
    dispatchSurface: "follower_ipc" | "host_ui_message";
  };
  insertSecondAttempt(logicalTurnId: string): Promise<void>;
  inspectAttempt(attemptId: string): Promise<CodexFollowerStartAttempt | null>;
  inspectAttemptByLogicalTurn(
    logicalTurnId: string,
  ): Promise<CodexFollowerStartAttempt | null>;
  listAttempts(): Promise<CodexFollowerStartAttempt[]>;
  saveRestartCheckpoint(input: {
    runId: string;
    logicalTurnId: string;
    shellThreadId: string;
    desktopPid: number;
    processStartedAt: string;
    socketPath: string;
    socketDevice: number;
    socketInode: number;
    observationCursor: number;
    lastSnapshotHash: string;
    lastNormalizedSnapshot: CodexTurnSnapshot;
  }): Promise<void>;
  readRestartCheckpoint(
    runId: string,
  ): CodexPhase0RestartCheckpoint | null;
  consumeRestartCheckpoint(input: {
    runId: string;
    expectedAttemptId: string;
    expectedDispatchOrdinal: number;
    expectedTurnId: string;
    expectedResumedLogicalTurnId: string;
    expectedResumedAttemptId: string;
    expectedResumedThreadId: string;
    expectedResumedCanonicalBindingThreadId: string;
    expectedResumedNormalizedPromptHash: string;
  }): Promise<void>;
  createInteractionWakeup(input: {
    interactionId: string;
    logicalTurnId: string;
    cardVersion: number;
  }): Promise<void>;
  inspectInteractionBinding(interactionId: string): {
    interactionId: string;
    logicalTurnId: string;
    bindingId: string;
    threadId: string;
    state: "pending" | "decided";
  };
  registerVerificationWakeup(input: {
    runId: string;
    nonceId: string;
    interactionId: string;
    logicalTurnId: string;
    bindingId: string;
    threadId: string;
    cardVersion: number;
  }): Promise<void>;
  readVerificationWakeup(nonceId: string): {
    runId: string;
    nonceId: string;
    interactionId: string;
    logicalTurnId: string;
    bindingId: string;
    threadId: string;
    cardVersion: number;
    state: "minted" | "authorized" | "acked";
    jobId?: string;
    attemptId?: string;
    workerId?: string;
    leaseToken?: string;
    leaseExpiresAt?: string;
    markerMessage?: string;
  };
  submitInteractionDecision(input: {
    interactionId: string;
    cardVersion: number;
    clickId: string;
    selectedOption: string;
  }): Promise<{
    status: "accepted" | "duplicate" | "stale";
    jobId?: string;
    attemptId?: string;
  }>;
  authorizeInteractionWakeup(input: {
    jobId: string;
    verificationNonceId?: string;
    markerNonceId: string;
    workerId: string;
    leaseToken: string;
    leaseExpiresAt: string;
  }): Promise<{
    threadId: string;
    markerMessage: string;
    attemptId: string;
    dispatchCount: number;
  }>;
  recordInteractionWakeupAck(input: {
    jobId: string;
    source: "host" | "recovery";
    workerId: string;
    leaseToken: string;
    leaseExpiresAt: string;
    receiptId: string;
    markerMessage: string;
  }): Promise<{
    effectId: string;
    executionId: string;
    created: boolean;
    source: "host" | "recovery";
  }>;
  executeInteractionWakeup(input: {
    jobId: string;
    source: "host" | "recovery";
    workerId: string;
    leaseToken: string;
    leaseExpiresAt: string;
    transport: {
      sendMarkerMessage(input: {
        threadId: string;
        markerMessage: string;
      }): Promise<
        | { status: "acknowledged"; receiptId: string }
        | { status: "rejected" }
      >;
      reconcileMarkerMessage(input: {
        threadId: string;
        markerMessage: string;
      }): Promise<{ receiptId: string } | null>;
    };
  }): Promise<{
    effectId: string;
    executionId: string;
    created: boolean;
    source: "host" | "recovery";
  }>;
  inspectInteractionWakeup(interactionId: string): {
    decisionCount: number;
    jobCount: number;
    attemptCount: number;
    executionCount: number;
    effectCount: number;
    outboxCount: number;
    receiptCount: number;
    dispatchCount: number;
    dispatchSurfaces: string[];
    jobId?: string;
    attemptId?: string;
  };
  setFailpoint(failpoint?: CodexPhase0JournalFailpoint): void;
  close(): void;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function hash(value: string, encoding: "hex" | "base64url" = "hex"): string {
  return createHash("sha256").update(value).digest(encoding);
}

function durableUuid(namespace: string, value: string): string {
  const digest = hash(`${namespace}:${value}`);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function ownerColumns(owner: CodexManagedOwner): [string | null, string | null] {
  return owner.kind === "pipeline_job"
    ? [owner.pipelineJobId, null]
    : [null, owner.projectAiRunId];
}

function ownerFromColumns(
  pipelineJobId: string | null,
  projectAiRunId: string | null,
): CodexManagedOwner {
  if ((pipelineJobId === null) === (projectAiRunId === null)) {
    throw new Error("managed owner XOR is invalid");
  }
  return pipelineJobId
    ? { kind: "pipeline_job", pipelineJobId }
    : { kind: "project_ai_run", projectAiRunId: projectAiRunId! };
}

function ensureSchema(sqlite: SqliteDatabase): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const existingSchema = sqlite.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'phase0_thread_bindings'
  `).get();
  const schemaVersion = sqlite.pragma("user_version", {
    simple: true,
  }) as number;
  if (
    existingSchema
    && schemaVersion !== PHASE0_JOURNAL_SCHEMA_VERSION
  ) {
    throw new Error(
      `incompatible Phase 0 journal schema version ${schemaVersion}; `
      + `delete the disposable journal and start a fresh verifier run`,
    );
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS phase0_pipeline_jobs (
      owner_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      change_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      lease_token TEXT NOT NULL,
      owner_attempt INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      deadline_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL
      , status TEXT NOT NULL CHECK (status IN ('running','completed','failed'))
    );
    CREATE TABLE IF NOT EXISTS phase0_project_ai_runs (
      owner_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      change_id TEXT,
      worker_id TEXT NOT NULL,
      lease_token TEXT NOT NULL,
      owner_attempt INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      deadline_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
      CHECK (change_id IS NULL)
    );
    CREATE TABLE IF NOT EXISTS phase0_thread_bindings (
      binding_id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL CHECK (
        scope_kind IN ('change','project_prd','project_context')
      ),
      scope_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      change_id TEXT,
      thread_id TEXT UNIQUE,
      candidate_thread_id TEXT,
      bootstrap_activation_requested INTEGER NOT NULL DEFAULT 0 CHECK (
        bootstrap_activation_requested IN (0, 1)
      ),
      creator_baseline_turn_ids_json TEXT,
      creator_baseline_semantic_hash TEXT,
      materialization_logical_turn_id TEXT UNIQUE,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      provision_state TEXT NOT NULL CHECK (
        provision_state IN (
          'provisioning','bootstrap_ready','materializing',
          'durable_ready','ambiguous'
        )
      ),
      claim_owner_id TEXT,
      claim_lease_token TEXT,
      claim_lease_expires_at TEXT,
      provision_deadline_at TEXT,
      claim_owner_attempt INTEGER,
      claim_owner_epoch INTEGER,
      baseline_thread_ids_json TEXT NOT NULL,
      last_error TEXT,
      UNIQUE(scope_kind, scope_id),
      CHECK (
        (
          provision_state = 'durable_ready'
          AND thread_id IS NOT NULL
          AND candidate_thread_id = thread_id
          AND bootstrap_activation_requested = 1
          AND creator_baseline_turn_ids_json IS NOT NULL
          AND creator_baseline_semantic_hash IS NOT NULL
        )
        OR
        (
          provision_state IN ('bootstrap_ready','materializing')
          AND thread_id IS NULL
          AND candidate_thread_id IS NOT NULL
          AND bootstrap_activation_requested = 1
          AND creator_baseline_turn_ids_json IS NOT NULL
          AND creator_baseline_semantic_hash IS NOT NULL
        )
        OR
        (
          provision_state IN ('provisioning','ambiguous')
          AND thread_id IS NULL
        )
      ),
      CHECK (
        (claim_owner_id IS NULL AND claim_lease_token IS NULL
          AND claim_lease_expires_at IS NULL
          AND provision_deadline_at IS NULL
          AND claim_owner_attempt IS NULL AND claim_owner_epoch IS NULL)
        OR
        (claim_owner_id IS NOT NULL AND claim_lease_token IS NOT NULL
          AND claim_lease_expires_at IS NOT NULL
          AND provision_deadline_at IS NOT NULL
          AND claim_owner_attempt IS NOT NULL AND claim_owner_epoch IS NOT NULL
          AND claim_owner_attempt >= 1 AND claim_owner_epoch >= 1
          AND claim_lease_expires_at <= provision_deadline_at)
      ),
      CHECK (
        (scope_kind = 'change' AND change_id IS NOT NULL
          AND change_id = scope_id)
        OR
        (scope_kind IN ('project_prd','project_context')
          AND change_id IS NULL AND scope_id = project_id)
      )
    );
    CREATE TABLE IF NOT EXISTS phase0_logical_turns (
      logical_turn_id TEXT PRIMARY KEY,
      pipeline_job_id TEXT REFERENCES phase0_pipeline_jobs(owner_id),
      project_ai_run_id TEXT REFERENCES phase0_project_ai_runs(owner_id),
      binding_id TEXT NOT NULL REFERENCES phase0_thread_bindings(binding_id),
      phase TEXT NOT NULL,
      role TEXT NOT NULL,
      round INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      turn_slot TEXT NOT NULL UNIQUE,
      run_correlation_id TEXT NOT NULL UNIQUE,
      dispatch_surface TEXT NOT NULL CHECK (
        dispatch_surface IN ('follower_ipc','host_ui_message')
      ),
      purpose TEXT,
      request_json TEXT,
      CHECK ((pipeline_job_id IS NOT NULL) <> (project_ai_run_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS phase0_pipeline_logical_slot
      ON phase0_logical_turns(
        pipeline_job_id, phase, role, round, ordinal
      ) WHERE pipeline_job_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS phase0_project_logical_slot
      ON phase0_logical_turns(
        project_ai_run_id, phase, role, round, ordinal
      ) WHERE project_ai_run_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS phase0_start_attempts (
      attempt_id TEXT PRIMARY KEY,
      logical_turn_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_logical_turns(logical_turn_id),
      pipeline_job_id TEXT REFERENCES phase0_pipeline_jobs(owner_id),
      project_ai_run_id TEXT REFERENCES phase0_project_ai_runs(owner_id),
      binding_id TEXT NOT NULL REFERENCES phase0_thread_bindings(binding_id),
      request_json TEXT NOT NULL,
      correlation_marker TEXT NOT NULL UNIQUE,
      normalized_prompt_hash TEXT NOT NULL,
      pre_start_turn_ids_json TEXT NOT NULL,
      pre_start_semantic_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'prepared','dispatching','no_client_found',
        'ambiguous','succeeded','quarantined'
      )),
      dispatch_ordinal INTEGER NOT NULL,
      turn_id TEXT UNIQUE,
      code TEXT,
      ambiguous_reason TEXT,
      project_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      lease_token TEXT NOT NULL,
      owner_attempt INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      purpose TEXT NOT NULL,
      dispatch_surface TEXT NOT NULL CHECK (
        dispatch_surface IN ('follower_ipc','host_ui_message')
      ),
      deadline_at TEXT NOT NULL,
      original_deadline_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      recovery_owner_id TEXT,
      recovery_lease_token TEXT,
      recovery_owner_attempt INTEGER,
      recovery_epoch INTEGER,
      recovery_deadline_at TEXT,
      recovery_lease_expires_at TEXT,
      CHECK ((pipeline_job_id IS NOT NULL) <> (project_ai_run_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS phase0_turn_executions (
      execution_id TEXT PRIMARY KEY,
      logical_turn_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_logical_turns(logical_turn_id),
      attempt_id TEXT NOT NULL UNIQUE REFERENCES phase0_start_attempts(attempt_id),
      pipeline_job_id TEXT REFERENCES phase0_pipeline_jobs(owner_id),
      project_ai_run_id TEXT REFERENCES phase0_project_ai_runs(owner_id),
      binding_id TEXT NOT NULL REFERENCES phase0_thread_bindings(binding_id),
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      dispatch_surface TEXT NOT NULL CHECK (
        dispatch_surface IN ('follower_ipc','host_ui_message')
      ),
      worker_id TEXT NOT NULL,
      lease_token TEXT NOT NULL,
      owner_attempt INTEGER NOT NULL,
      owner_epoch INTEGER NOT NULL,
      UNIQUE(thread_id, turn_id),
      CHECK ((pipeline_job_id IS NOT NULL) <> (project_ai_run_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS phase0_restart_checkpoints (
      run_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('awaiting_resume','consumed')),
      logical_turn_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_logical_turns(logical_turn_id),
      attempt_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_start_attempts(attempt_id),
      correlation_marker TEXT NOT NULL,
      normalized_prompt_hash TEXT NOT NULL,
      pre_start_turn_ids_json TEXT NOT NULL,
      pre_start_semantic_hash TEXT NOT NULL,
      dispatch_ordinal INTEGER NOT NULL,
      turn_id TEXT NOT NULL UNIQUE,
      shell_thread_id TEXT NOT NULL,
      desktop_pid INTEGER NOT NULL,
      process_started_at TEXT NOT NULL,
      socket_path TEXT NOT NULL,
      socket_device INTEGER NOT NULL,
      socket_inode INTEGER NOT NULL,
      observation_cursor INTEGER NOT NULL,
      last_snapshot_hash TEXT NOT NULL,
      last_normalized_snapshot_json TEXT NOT NULL,
      resumed_logical_turn_id TEXT UNIQUE
        REFERENCES phase0_logical_turns(logical_turn_id),
      resumed_attempt_id TEXT UNIQUE
        REFERENCES phase0_start_attempts(attempt_id),
      resumed_correlation_marker TEXT,
      resumed_normalized_prompt_hash TEXT,
      resumed_pre_start_semantic_hash TEXT,
      resumed_shell_thread_id TEXT,
      resumed_dispatch_ordinal INTEGER,
      resumed_turn_id TEXT UNIQUE,
      consumed_at TEXT,
      CHECK (
        (state = 'awaiting_resume'
          AND resumed_logical_turn_id IS NULL
          AND resumed_attempt_id IS NULL
          AND resumed_correlation_marker IS NULL
          AND resumed_normalized_prompt_hash IS NULL
          AND resumed_pre_start_semantic_hash IS NULL
          AND resumed_shell_thread_id IS NULL
          AND resumed_dispatch_ordinal IS NULL
          AND resumed_turn_id IS NULL
          AND consumed_at IS NULL)
        OR
        (state = 'consumed'
          AND resumed_logical_turn_id IS NOT NULL
          AND resumed_attempt_id IS NOT NULL
          AND resumed_correlation_marker IS NOT NULL
          AND resumed_normalized_prompt_hash IS NOT NULL
          AND resumed_pre_start_semantic_hash IS NOT NULL
          AND resumed_shell_thread_id IS NOT NULL
          AND resumed_dispatch_ordinal IS NOT NULL
          AND resumed_turn_id IS NOT NULL
          AND consumed_at IS NOT NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS phase0_interactions (
      interaction_id TEXT PRIMARY KEY,
      logical_turn_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_logical_turns(logical_turn_id),
      card_version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','decided')),
      selected_option TEXT,
      accepted_click_id TEXT UNIQUE,
      decided_at TEXT,
      CHECK (
        (state = 'pending' AND selected_option IS NULL
          AND accepted_click_id IS NULL AND decided_at IS NULL)
        OR
        (state = 'decided' AND selected_option IS NOT NULL
          AND accepted_click_id IS NOT NULL AND decided_at IS NOT NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS phase0_wakeup_jobs (
      job_id TEXT PRIMARY KEY,
      interaction_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_interactions(interaction_id),
      logical_turn_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_logical_turns(logical_turn_id),
      attempt_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_start_attempts(attempt_id),
      state TEXT NOT NULL CHECK (state IN ('queued','dispatching','succeeded'))
    );
    CREATE TABLE IF NOT EXISTS phase0_verification_wakeups (
      nonce_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_interactions(interaction_id),
      logical_turn_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_logical_turns(logical_turn_id),
      binding_id TEXT NOT NULL REFERENCES phase0_thread_bindings(binding_id),
      thread_id TEXT NOT NULL,
      card_version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('minted','authorized','acked')),
      job_id TEXT UNIQUE REFERENCES phase0_wakeup_jobs(job_id),
      attempt_id TEXT UNIQUE REFERENCES phase0_start_attempts(attempt_id),
      worker_id TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      marker_message TEXT UNIQUE,
      CHECK (
        (state = 'minted' AND job_id IS NULL AND attempt_id IS NULL
          AND worker_id IS NULL AND lease_token IS NULL
          AND lease_expires_at IS NULL AND marker_message IS NULL)
        OR
        (state IN ('authorized','acked') AND job_id IS NOT NULL
          AND attempt_id IS NOT NULL AND worker_id IS NOT NULL
          AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
          AND marker_message IS NOT NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS phase0_wakeup_outbox (
      outbox_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES phase0_wakeup_jobs(job_id),
      interaction_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_interactions(interaction_id),
      attempt_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_start_attempts(attempt_id),
      thread_id TEXT NOT NULL,
      marker_message TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('queued','dispatching','sent')),
      worker_id TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      dispatch_count INTEGER NOT NULL DEFAULT 0,
      CHECK (
        (state = 'queued' AND worker_id IS NULL AND lease_token IS NULL
          AND lease_expires_at IS NULL AND dispatch_count >= 0)
        OR
        (state IN ('dispatching','sent') AND worker_id IS NOT NULL
          AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
          AND dispatch_count >= 1)
      )
    );
    CREATE TABLE IF NOT EXISTS phase0_wakeup_receipts (
      receipt_id TEXT PRIMARY KEY,
      outbox_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_wakeup_outbox(outbox_id),
      marker_message TEXT NOT NULL UNIQUE,
      acknowledged_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS phase0_wakeup_effects (
      effect_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES phase0_wakeup_jobs(job_id),
      interaction_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_interactions(interaction_id),
      execution_id TEXT NOT NULL UNIQUE
        REFERENCES phase0_turn_executions(execution_id),
      source TEXT NOT NULL CHECK (source IN ('host','recovery'))
    );
  `);
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS phase0_thread_bindings_candidate_thread
      ON phase0_thread_bindings(candidate_thread_id)
      WHERE candidate_thread_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS phase0_thread_binding_materialization
      ON phase0_thread_bindings(materialization_logical_turn_id)
      WHERE materialization_logical_turn_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS phase0_thread_candidate_immutable
      BEFORE UPDATE OF candidate_thread_id ON phase0_thread_bindings
      WHEN OLD.candidate_thread_id IS NOT NULL
        AND NEW.candidate_thread_id IS NOT OLD.candidate_thread_id
      BEGIN
        SELECT RAISE(ABORT, 'phase0 thread candidate is immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS phase0_thread_ready_candidate_exact
      BEFORE UPDATE OF provision_state, thread_id, candidate_thread_id
      ON phase0_thread_bindings
      WHEN NEW.provision_state = 'durable_ready'
        AND NEW.candidate_thread_id IS NOT NULL
        AND NEW.candidate_thread_id <> NEW.thread_id
      BEGIN
        SELECT RAISE(ABORT, 'phase0 ready thread candidate is detached');
      END;
  `);
  sqlite.pragma(`user_version = ${PHASE0_JOURNAL_SCHEMA_VERSION}`);
}

export function createCodexPhase0SqliteJournal(input: {
  databasePath: string;
  now?: () => number;
  readBaseline?: (
    request: CodexDesktopTurnRequest,
  ) => Promise<{ turnIds: string[]; semanticHash: string }>;
}): CodexPhase0SqliteJournal {
  const sqlite = new Database(input.databasePath);
  const now = input.now ?? Date.now;
  const readBaseline = input.readBaseline ?? (async () => ({
    turnIds: [],
    semanticHash: hash("[]"),
  }));
  let failpoint: CodexPhase0JournalFailpoint | undefined;
  try {
    ensureSchema(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  function trip(expected: CodexPhase0JournalFailpoint): void {
    if (failpoint !== expected) return;
    failpoint = undefined;
    throw new CodexPhase0InjectedCrash(expected);
  }

  function readOwner(owner: CodexManagedOwner): OwnerRow {
    const [pipelineJobId, projectAiRunId] = ownerColumns(owner);
    const table = pipelineJobId
      ? "phase0_pipeline_jobs"
      : "phase0_project_ai_runs";
    const ownerId = pipelineJobId ?? projectAiRunId!;
    const row = sqlite.prepare(
      `SELECT * FROM ${table} WHERE owner_id = ?`,
    ).get(ownerId) as OwnerRow | undefined;
    if (!row) throw new Error("managed owner not found");
    return row;
  }

  function readBinding(scopeKind: ScopeKind, scopeId: string): BindingRow {
    const row = sqlite.prepare(`
      SELECT * FROM phase0_thread_bindings
      WHERE scope_kind = ? AND scope_id = ?
    `).get(scopeKind, scopeId) as BindingRow | undefined;
    if (!row) throw new Error("canonical binding not found");
    return row;
  }

  function readLogicalTurn(logicalTurnId: string): LogicalRow {
    const row = sqlite.prepare(`
      SELECT * FROM phase0_logical_turns WHERE logical_turn_id = ?
    `).get(logicalTurnId) as LogicalRow | undefined;
    if (!row) throw new Error("logical turn not found");
    ownerFromColumns(row.pipeline_job_id, row.project_ai_run_id);
    return row;
  }

  function identity(row: LogicalRow): CodexLogicalTurnIdentity {
    const binding = sqlite.prepare(`
      SELECT * FROM phase0_thread_bindings WHERE binding_id = ?
    `).get(row.binding_id) as BindingRow;
    return {
      logicalTurnId: row.logical_turn_id,
      owner: ownerFromColumns(row.pipeline_job_id, row.project_ai_run_id),
      projectId: binding.project_id,
      scopeKind: binding.scope_kind,
      scopeId: binding.scope_id,
      phase: row.phase,
      role: row.role,
      round: row.round,
      ordinal: row.ordinal,
      turnSlot: row.turn_slot,
      runCorrelationId: row.run_correlation_id,
      dispatchSurface: row.dispatch_surface,
    };
  }

  function startContext(logicalTurnId: string): CodexLogicalTurnStartContext {
    const logical = readLogicalTurn(logicalTurnId);
    const resolved = identity(logical);
    const binding = readBinding(resolved.scopeKind, resolved.scopeId);
    const owner = readOwner(resolved.owner);
    if (!logical.request_json || !logical.purpose) {
      throw new Error("logical request not seeded");
    }
    const isMaterialization = resolved.role === "shell_materialization";
    const threadId = isMaterialization
      ? binding.candidate_thread_id
      : binding.thread_id;
    if (
      !threadId
      || (
        isMaterialization
          ? !(
              binding.provision_state === "bootstrap_ready"
              || binding.provision_state === "materializing"
            )
          : binding.provision_state !== "durable_ready"
      )
    ) {
      throw new Error("canonical shell binding is not ready");
    }
    return {
      ...resolved,
      request: {
        ...(JSON.parse(logical.request_json) as Omit<
          CodexDesktopTurnRequest,
          "threadId"
        >),
        threadId,
      },
      fence: {
        logicalTurnId,
        owner: resolved.owner,
        projectId: resolved.projectId,
        scopeKind: resolved.scopeKind,
        scopeId: resolved.scopeId,
        workerId: owner.worker_id,
        leaseToken: owner.lease_token,
        ownerAttempt: owner.owner_attempt,
        ownerEpoch: owner.owner_epoch,
        dispatchSurface: logical.dispatch_surface,
        purpose: logical.purpose,
        deadlineAt: owner.deadline_at,
        leaseExpiresAt: owner.lease_expires_at,
      },
    };
  }

  function attemptRow(attemptId: string): AttemptRow {
    const row = sqlite.prepare(`
      SELECT * FROM phase0_start_attempts WHERE attempt_id = ?
    `).get(attemptId) as AttemptRow | undefined;
    if (!row) throw new Error("start attempt not found");
    ownerFromColumns(row.pipeline_job_id, row.project_ai_run_id);
    return row;
  }

  function attemptFence(row: AttemptRow): CodexFollowerStartFence {
    return {
      logicalTurnId: row.logical_turn_id,
      owner: ownerFromColumns(row.pipeline_job_id, row.project_ai_run_id),
      projectId: row.project_id,
      scopeKind: row.scope_kind,
      scopeId: row.scope_id,
      workerId: row.worker_id,
      leaseToken: row.lease_token,
      ownerAttempt: row.owner_attempt,
      ownerEpoch: row.owner_epoch,
      dispatchSurface: row.dispatch_surface,
      purpose: row.purpose,
      deadlineAt: row.deadline_at,
      leaseExpiresAt: row.lease_expires_at,
    };
  }

  function assertLiveOwnerForAttempt(row: AttemptRow): OwnerRow {
    const owner = readOwner(
      ownerFromColumns(row.pipeline_job_id, row.project_ai_run_id),
    );
    if (
      owner.status !== "running"
      || owner.worker_id !== row.worker_id
      || owner.lease_token !== row.lease_token
      || owner.owner_attempt !== row.owner_attempt
      || owner.owner_epoch !== row.owner_epoch
      || Date.parse(owner.lease_expires_at) <= now()
      || Date.parse(owner.deadline_at) <= now()
      || owner.deadline_at !== row.deadline_at
      || Date.parse(row.deadline_at) > Date.parse(row.original_deadline_at)
      || Date.parse(owner.lease_expires_at)
        > Date.parse(row.original_deadline_at)
    ) {
      throw new Error("start attempt owner lease is stale");
    }
    return owner;
  }

  function assertLiveRecoveryOwner(
    row: AttemptRow,
    fence: CodexFollowerStartFence,
  ): OwnerRow {
    const attemptOwner = ownerFromColumns(
      row.pipeline_job_id,
      row.project_ai_run_id,
    );
    if (
      stableJson(fence.owner) !== stableJson(attemptOwner)
      || fence.logicalTurnId !== row.logical_turn_id
      || fence.projectId !== row.project_id
      || fence.scopeKind !== row.scope_kind
      || fence.scopeId !== row.scope_id
      || fence.purpose !== row.purpose
      || fence.dispatchSurface !== row.dispatch_surface
      || Date.parse(fence.deadlineAt) > Date.parse(row.original_deadline_at)
      || Date.parse(fence.leaseExpiresAt)
        > Date.parse(row.original_deadline_at)
    ) {
      throw new Error("recovery owner fence is incompatible with dispatch");
    }
    const owner = readOwner(fence.owner);
    if (
      owner.status !== "running"
      || owner.worker_id !== fence.workerId
      || owner.lease_token !== fence.leaseToken
      || owner.owner_attempt !== fence.ownerAttempt
      || owner.owner_epoch !== fence.ownerEpoch
      || owner.deadline_at !== fence.deadlineAt
      || owner.lease_expires_at !== fence.leaseExpiresAt
      || Date.parse(owner.deadline_at) <= now()
      || Date.parse(owner.lease_expires_at) <= now()
    ) {
      throw new Error("recovery owner lease is stale");
    }
    return owner;
  }

  function recoveryFenceFromRow(
    row: AttemptRow,
  ): CodexFollowerStartRecoveryFence | undefined {
    if (
      !row.recovery_owner_id
      || !row.recovery_lease_token
      || row.recovery_owner_attempt === null
      || row.recovery_epoch === null
      || !row.recovery_deadline_at
      || !row.recovery_lease_expires_at
    ) return undefined;
    return {
      ownerFence: {
        ...attemptFence(row),
        workerId: row.recovery_owner_id,
        leaseToken: row.recovery_lease_token,
        ownerAttempt: row.recovery_owner_attempt,
        ownerEpoch: row.recovery_epoch,
        deadlineAt: row.recovery_deadline_at,
        leaseExpiresAt: row.recovery_lease_expires_at,
      },
      recoveryLeaseToken: row.recovery_lease_token,
      recoveryEpoch: row.recovery_epoch,
    };
  }

  function fenceValues(fence: CodexFollowerStartFence): unknown[] {
    const [pipelineJobId, projectAiRunId] = ownerColumns(fence.owner);
    return [
      fence.logicalTurnId,
      pipelineJobId,
      projectAiRunId,
      fence.projectId,
      fence.scopeKind,
      fence.scopeId,
      fence.workerId,
      fence.leaseToken,
      fence.ownerAttempt,
      fence.ownerEpoch,
      fence.dispatchSurface,
      fence.purpose,
      fence.deadlineAt,
      fence.leaseExpiresAt,
    ];
  }

  const fenceSql = `
    logical_turn_id = ?
    AND pipeline_job_id IS ?
    AND project_ai_run_id IS ?
    AND project_id = ?
    AND scope_kind = ?
    AND scope_id = ?
    AND worker_id = ?
    AND lease_token = ?
    AND owner_attempt = ?
    AND owner_epoch = ?
    AND dispatch_surface = ?
    AND purpose = ?
    AND deadline_at = ?
    AND lease_expires_at = ?
  `;

  function toAttempt(row: AttemptRow): CodexFollowerStartAttempt {
    const recoveryFence = recoveryFenceFromRow(row);
    return {
      attemptId: row.attempt_id,
      logicalTurnId: row.logical_turn_id,
      request: JSON.parse(row.request_json) as CodexDesktopTurnRequest,
      fence: attemptFence(row),
      originalDeadlineAt: row.original_deadline_at,
      correlationMarker: row.correlation_marker,
      normalizedPromptHash: row.normalized_prompt_hash,
      preStartTurnIds: JSON.parse(row.pre_start_turn_ids_json) as string[],
      preStartSemanticHash: row.pre_start_semantic_hash,
      state: row.state,
      dispatchOrdinal: row.dispatch_ordinal,
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      ...(row.code ? { code: row.code } : {}),
      ...(row.ambiguous_reason
        ? { ambiguousReason: row.ambiguous_reason }
        : {}),
      ...(recoveryFence ? { recoveryFence } : {}),
    };
  }

  function toRestartCheckpoint(
    row: RestartCheckpointRow,
  ): CodexPhase0RestartCheckpoint {
    return {
      runId: row.run_id,
      state: row.state,
      logicalTurnId: row.logical_turn_id,
      attemptId: row.attempt_id,
      correlationMarker: row.correlation_marker,
      normalizedPromptHash: row.normalized_prompt_hash,
      preStartTurnIds: JSON.parse(row.pre_start_turn_ids_json) as string[],
      preStartSemanticHash: row.pre_start_semantic_hash,
      dispatchOrdinal: row.dispatch_ordinal,
      turnId: row.turn_id,
      shellThreadId: row.shell_thread_id,
      desktopPid: row.desktop_pid,
      processStartedAt: row.process_started_at,
      socketPath: row.socket_path,
      socketDevice: row.socket_device,
      socketInode: row.socket_inode,
      observationCursor: row.observation_cursor,
      lastSnapshotHash: row.last_snapshot_hash,
      lastNormalizedSnapshot: JSON.parse(
        row.last_normalized_snapshot_json,
      ) as CodexTurnSnapshot,
      resumedLogicalTurnId: row.resumed_logical_turn_id,
      resumedAttemptId: row.resumed_attempt_id,
      resumedCorrelationMarker: row.resumed_correlation_marker,
      resumedNormalizedPromptHash: row.resumed_normalized_prompt_hash,
      resumedPreStartSemanticHash: row.resumed_pre_start_semantic_hash,
      resumedShellThreadId: row.resumed_shell_thread_id,
      resumedDispatchOrdinal: row.resumed_dispatch_ordinal,
      resumedTurnId: row.resumed_turn_id,
      consumedAt: row.consumed_at,
    };
  }

  function insertExecution(
    row: AttemptRow,
    turnId: string,
    settlementFence: CodexFollowerStartFence = attemptFence(row),
  ): void {
    const binding = sqlite.prepare(`
      SELECT binding_id, thread_id, candidate_thread_id, provision_state
      FROM phase0_thread_bindings WHERE binding_id = ?
    `).get(row.binding_id) as {
      binding_id: string;
      thread_id: string | null;
      candidate_thread_id: string | null;
      provision_state: BindingRow["provision_state"];
    };
    const logical = readLogicalTurn(row.logical_turn_id);
    const isMaterialization = logical.role === "shell_materialization";
    const executionThreadId = isMaterialization
      ? binding.candidate_thread_id
      : binding.thread_id;
    if (
      !binding
      || !executionThreadId
      || (
        isMaterialization
          ? binding.provision_state !== "materializing"
          : binding.provision_state !== "durable_ready"
      )
      || logical.binding_id !== row.binding_id
      || stableJson(settlementFence.owner)
        !== stableJson(ownerFromColumns(
          row.pipeline_job_id,
          row.project_ai_run_id,
        ))
    ) {
      throw new Error("execution binding or owner fence is inconsistent");
    }
    sqlite.prepare(`
      INSERT INTO phase0_turn_executions (
        execution_id, logical_turn_id, attempt_id,
        pipeline_job_id, project_ai_run_id, binding_id, thread_id, turn_id,
        dispatch_surface, worker_id, lease_token, owner_attempt, owner_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      row.logical_turn_id,
      row.attempt_id,
      row.pipeline_job_id,
      row.project_ai_run_id,
      binding.binding_id,
      executionThreadId,
      turnId,
      row.dispatch_surface,
      settlementFence.workerId,
      settlementFence.leaseToken,
      settlementFence.ownerAttempt,
      settlementFence.ownerEpoch,
    );
  }

  function resolveLogicalTurn(
    raw: Parameters<CodexLogicalTurnPort["resolve"]>[0],
  ): CodexLogicalTurnIdentity {
      const canonical = {
        owner: raw.owner,
        projectId: raw.projectId,
        scopeKind: raw.scopeKind,
        scopeId: raw.scopeId,
        phase: raw.phase,
        role: raw.role,
        round: raw.round,
        ordinal: raw.ordinal,
      };
      const owner = readOwner(canonical.owner);
      const binding = readBinding(canonical.scopeKind, canonical.scopeId);
      if (
        owner.project_id !== canonical.projectId
        || binding.project_id !== canonical.projectId
        || !Number.isSafeInteger(canonical.round)
        || canonical.round < 0
        || !Number.isSafeInteger(canonical.ordinal)
        || canonical.ordinal < 0
      ) {
        throw new Error("logical identity is invalid");
      }
      const [pipelineJobId, projectAiRunId] = ownerColumns(canonical.owner);
      const ownerId = pipelineJobId ?? projectAiRunId!;
      const slot = [
        canonical.owner.kind,
        ownerId,
        canonical.phase,
        canonical.role,
        `round-${canonical.round}`,
        `ordinal-${canonical.ordinal}`,
      ].join("/");
      const logicalTurnId = randomUUID();
      sqlite.prepare(`
        INSERT INTO phase0_logical_turns (
          logical_turn_id, pipeline_job_id, project_ai_run_id, binding_id,
          phase, role, round, ordinal, turn_slot, run_correlation_id,
          dispatch_surface
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).run(
        logicalTurnId,
        pipelineJobId,
        projectAiRunId,
        binding.binding_id,
        canonical.phase,
        canonical.role,
        canonical.round,
        canonical.ordinal,
        slot,
        `sp-${hash(logicalTurnId, "base64url")}`,
        dispatchSurfaceForRole(canonical.role),
      );
      const row = sqlite.prepare(`
        SELECT * FROM phase0_logical_turns
        WHERE pipeline_job_id IS ? AND project_ai_run_id IS ?
          AND phase = ? AND role = ? AND round = ? AND ordinal = ?
      `).get(
        pipelineJobId,
        projectAiRunId,
        canonical.phase,
        canonical.role,
        canonical.round,
        canonical.ordinal,
      ) as LogicalRow;
      if (
        row.pipeline_job_id !== pipelineJobId
        || row.project_ai_run_id !== projectAiRunId
        || row.binding_id !== binding.binding_id
        || row.phase !== canonical.phase
        || row.role !== canonical.role
        || row.round !== canonical.round
        || row.ordinal !== canonical.ordinal
        || row.turn_slot !== slot
        || row.run_correlation_id
          !== `sp-${hash(row.logical_turn_id, "base64url")}`
        || row.dispatch_surface !== dispatchSurfaceForRole(canonical.role)
      ) {
        throw new Error("logical turn identity conflict is immutable");
      }
      return identity(row);
  }

  const logicalTurnPort: CodexLogicalTurnPort = {
    async resolve(raw) {
      return resolveLogicalTurn(raw);
    },
    async readForStart(logicalTurnId) {
      return startContext(logicalTurnId);
    },
  };

  const startAttemptPort: CodexFollowerStartAttemptPort = {
    async inspect(attemptId) {
      const row = sqlite.prepare(`
        SELECT * FROM phase0_start_attempts WHERE attempt_id = ?
      `).get(attemptId) as AttemptRow | undefined;
      return row ? toAttempt(row) : null;
    },
    async inspectByLogicalTurn(logicalTurnId) {
      const row = sqlite.prepare(`
        SELECT * FROM phase0_start_attempts WHERE logical_turn_id = ?
      `).get(logicalTurnId) as AttemptRow | undefined;
      return row ? toAttempt(row) : null;
    },
    async prepare(prepared) {
      const beforeRead = startContext(prepared.logicalTurnId);
      const beforeLogical = readLogicalTurn(prepared.logicalTurnId);
      const beforeBinding = sqlite.prepare(`
        SELECT * FROM phase0_thread_bindings WHERE binding_id = ?
      `).get(beforeLogical.binding_id) as BindingRow;
      const baseline = beforeRead.role === "shell_materialization"
        ? {
            turnIds: JSON.parse(
              beforeBinding.creator_baseline_turn_ids_json ?? "null",
            ) as string[],
            semanticHash:
              beforeBinding.creator_baseline_semantic_hash ?? "",
          }
        : await readBaseline(beforeRead.request);
      if (
        !Array.isArray(baseline.turnIds)
        || (
          beforeRead.role === "shell_materialization"
          && (
            baseline.turnIds.length !== 0
            || baseline.semanticHash !== hash("[]")
          )
        )
      ) {
        throw new Error(
          beforeRead.role === "shell_materialization"
            ? "creator shell baseline proof is invalid"
            : "follower start baseline is invalid",
        );
      }
      const result = sqlite.transaction(() => {
        const context = startContext(prepared.logicalTurnId);
        if (
          stableJson(context.request) !== stableJson(beforeRead.request)
          || stableJson(context.fence) !== stableJson(beforeRead.fence)
        ) {
          throw new Error("logical start context changed during baseline read");
        }
        const logical = readLogicalTurn(context.logicalTurnId);
        const owner = readOwner(context.owner);
        if (
          owner.status !== "running"
          || Date.parse(owner.lease_expires_at) <= now()
          || Date.parse(owner.deadline_at) <= now()
        ) {
          throw new Error("logical turn owner lease is not live");
        }
        const marker =
          `[stagepass-run:${context.runCorrelationId}:attempt:${prepared.attemptId}]`;
        const requestWithMarker = {
          ...context.request,
          prompt: `${context.request.prompt}\n\n${marker}`,
        };
        sqlite.prepare(`
          INSERT INTO phase0_start_attempts (
            attempt_id, logical_turn_id, pipeline_job_id, project_ai_run_id,
            binding_id, request_json, correlation_marker,
            normalized_prompt_hash, pre_start_turn_ids_json,
            pre_start_semantic_hash, state, dispatch_ordinal,
            project_id, scope_kind, scope_id, worker_id, lease_token,
            owner_attempt, owner_epoch, purpose, deadline_at,
            original_deadline_at, lease_expires_at, dispatch_surface
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `).run(
          prepared.attemptId,
          context.logicalTurnId,
          logical.pipeline_job_id,
          logical.project_ai_run_id,
          logical.binding_id,
          stableJson(requestWithMarker),
          marker,
          hash(requestWithMarker.prompt),
          stableJson(baseline.turnIds),
          baseline.semanticHash,
          context.projectId,
          context.scopeKind,
          context.scopeId,
          context.fence.workerId,
          context.fence.leaseToken,
          context.fence.ownerAttempt,
          context.fence.ownerEpoch,
          context.fence.purpose,
          context.fence.deadlineAt,
          context.fence.deadlineAt,
          owner.lease_expires_at,
          context.fence.dispatchSurface,
        );
        return {
          attemptId: prepared.attemptId,
          state: "prepared" as const,
          fence: context.fence,
          request: context.request,
          correlationMarker: marker,
          normalizedPromptHash: hash(requestWithMarker.prompt),
          requestWithMarker,
          preStartTurnIds: [...baseline.turnIds],
          preStartSemanticHash: baseline.semanticHash,
        };
      })();
      trip("after_prepare");
      return result;
    },
    async claimDispatch(input) {
      const nextOrdinal = sqlite.transaction(() => {
        const row = attemptRow(input.attemptId);
        assertLiveOwnerForAttempt(row);
        const ordinal = row.dispatch_ordinal + 1;
        const result = sqlite.prepare(`
          UPDATE phase0_start_attempts
          SET state = 'dispatching', dispatch_ordinal = ?
          WHERE attempt_id = ? AND state IN ('prepared','no_client_found')
            AND dispatch_ordinal = ? AND ${fenceSql}
        `).run(
          ordinal,
          input.attemptId,
          row.dispatch_ordinal,
          ...fenceValues(input.fence),
        );
        if (result.changes !== 1) throw new Error("attempt not dispatchable");
        return ordinal;
      })();
      trip("after_dispatch_cas");
      return nextOrdinal;
    },
    async claimSafeAttemptForWorker(input) {
      const old = input.expectedOldFence;
      const next = input.newFence;
      if (
        stableJson(old.owner) !== stableJson(next.owner)
        || old.logicalTurnId !== next.logicalTurnId
        || old.projectId !== next.projectId
        || old.scopeKind !== next.scopeKind
        || old.scopeId !== next.scopeId
        || old.purpose !== next.purpose
        || next.ownerAttempt <= old.ownerAttempt
        || next.ownerEpoch <= old.ownerEpoch
        || Date.parse(next.deadlineAt) > Date.parse(old.deadlineAt)
        || Date.parse(next.leaseExpiresAt) > Date.parse(old.deadlineAt)
      ) {
        throw new Error("unsafe attempt handoff");
      }
      sqlite.transaction(() => {
        const row = attemptRow(input.attemptId);
        const owner = readOwner(next.owner);
        if (
          owner.status !== "running"
          || owner.worker_id !== next.workerId
          || owner.lease_token !== next.leaseToken
          || owner.owner_attempt !== next.ownerAttempt
          || owner.owner_epoch !== next.ownerEpoch
          || Date.parse(owner.lease_expires_at) <= now()
          || Date.parse(owner.deadline_at) <= now()
          || Date.parse(row.lease_expires_at) > now()
          || Date.parse(old.deadlineAt) <= now()
          || Date.parse(next.deadlineAt)
            > Date.parse(row.original_deadline_at)
          || Date.parse(next.leaseExpiresAt)
            > Date.parse(row.original_deadline_at)
        ) {
          throw new Error("new owner lease is not live");
        }
        const result = sqlite.prepare(`
          UPDATE phase0_start_attempts
          SET worker_id = ?, lease_token = ?, owner_attempt = ?,
            owner_epoch = ?, deadline_at = ?, lease_expires_at = ?
          WHERE attempt_id = ? AND state = ? AND ${fenceSql}
        `).run(
          next.workerId,
          next.leaseToken,
          next.ownerAttempt,
          next.ownerEpoch,
          next.deadlineAt,
          owner.lease_expires_at,
          input.attemptId,
          input.expectedState,
          ...fenceValues(old),
        );
        if (result.changes !== 1) throw new Error("attempt handoff rejected");
      })();
    },
    async recordNoClientFound(input) {
      sqlite.transaction(() => {
        assertLiveOwnerForAttempt(attemptRow(input.attemptId));
        const result = sqlite.prepare(`
          UPDATE phase0_start_attempts SET state = 'no_client_found'
          WHERE attempt_id = ? AND state = 'dispatching'
            AND dispatch_ordinal = ? AND ${fenceSql}
        `).run(
          input.attemptId,
          input.dispatchOrdinal,
          ...fenceValues(input.fence),
        );
        if (result.changes !== 1) throw new Error("stale no-client fence");
      })();
      trip("after_no_client_found");
    },
    async recordSuccess(input) {
      trip("before_success_cas");
      sqlite.transaction(() => {
        const row = attemptRow(input.attemptId);
        assertLiveOwnerForAttempt(row);
        const result = sqlite.prepare(`
          UPDATE phase0_start_attempts SET state = 'succeeded', turn_id = ?
          WHERE attempt_id = ? AND state = 'dispatching'
            AND dispatch_ordinal = ? AND ${fenceSql}
        `).run(
          input.turnId,
          input.attemptId,
          input.dispatchOrdinal,
          ...fenceValues(input.fence),
        );
        if (result.changes !== 1) throw new Error("stale success fence");
        insertExecution(row, input.turnId);
      })();
    },
    async recordAmbiguous(input) {
      sqlite.transaction(() => {
        assertLiveOwnerForAttempt(attemptRow(input.attemptId));
        const result = sqlite.prepare(`
          UPDATE phase0_start_attempts
          SET state = 'ambiguous', ambiguous_reason = ?
          WHERE attempt_id = ? AND state = 'dispatching'
            AND dispatch_ordinal = ? AND ${fenceSql}
        `).run(
          input.reason,
          input.attemptId,
          input.dispatchOrdinal,
          ...fenceValues(input.fence),
        );
        if (result.changes !== 1) throw new Error("stale ambiguous fence");
      })();
    },
    async claimReconciliation(input) {
      return sqlite.transaction(() => {
        const row = attemptRow(input.attemptId);
        assertLiveRecoveryOwner(row, input.ownerFence);
        const result = sqlite.prepare(`
          UPDATE phase0_start_attempts
          SET recovery_owner_id = ?, recovery_lease_token = ?,
            recovery_owner_attempt = ?, recovery_epoch = ?,
            recovery_deadline_at = ?, recovery_lease_expires_at = ?
          WHERE attempt_id = ? AND state IN ('dispatching','ambiguous')
            AND (recovery_epoch IS NULL OR recovery_epoch < ?)
        `).run(
          input.ownerFence.workerId,
          input.ownerFence.leaseToken,
          input.ownerFence.ownerAttempt,
          input.ownerFence.ownerEpoch,
          input.ownerFence.deadlineAt,
          input.ownerFence.leaseExpiresAt,
          input.attemptId,
          input.ownerFence.ownerEpoch,
        );
        if (result.changes !== 1) throw new Error("stale recovery fence");
        return {
          ownerFence: input.ownerFence,
          recoveryLeaseToken: input.ownerFence.leaseToken,
          recoveryEpoch: input.ownerFence.ownerEpoch,
        };
      })();
    },
    async adoptSuccess(input) {
      sqlite.transaction(() => {
        const row = attemptRow(input.attemptId);
        const stored = recoveryFenceFromRow(row);
        if (!stored || stableJson(stored) !== stableJson(input.fence)) {
          throw new Error("stale adoption recovery fence");
        }
        assertLiveRecoveryOwner(row, input.fence.ownerFence);
        const result = sqlite.prepare(`
          UPDATE phase0_start_attempts SET state = 'succeeded', turn_id = ?
          WHERE attempt_id = ? AND state IN ('dispatching','ambiguous')
            AND dispatch_ordinal = ? AND recovery_owner_id = ?
            AND recovery_lease_token = ? AND recovery_owner_attempt = ?
            AND recovery_epoch = ? AND recovery_deadline_at = ?
            AND recovery_lease_expires_at = ?
        `).run(
          input.turnId,
          input.attemptId,
          input.dispatchOrdinal,
          input.fence.ownerFence.workerId,
          input.fence.ownerFence.leaseToken,
          input.fence.ownerFence.ownerAttempt,
          input.fence.ownerFence.ownerEpoch,
          input.fence.ownerFence.deadlineAt,
          input.fence.ownerFence.leaseExpiresAt,
        );
        if (result.changes !== 1) throw new Error("stale adoption fence");
        insertExecution(row, input.turnId, input.fence.ownerFence);
      })();
    },
    async quarantine(input) {
      sqlite.transaction(() => {
        const row = attemptRow(input.attemptId);
        const stored = recoveryFenceFromRow(row);
        if (!stored || stableJson(stored) !== stableJson(input.fence)) {
          throw new Error("stale quarantine recovery fence");
        }
        assertLiveRecoveryOwner(row, input.fence.ownerFence);
        const result = sqlite.prepare(`
          UPDATE phase0_start_attempts
          SET state = 'quarantined', code = ?, ambiguous_reason = ?
          WHERE attempt_id = ? AND state IN ('dispatching','ambiguous')
            AND dispatch_ordinal = ? AND recovery_owner_id = ?
            AND recovery_lease_token = ? AND recovery_owner_attempt = ?
            AND recovery_epoch = ? AND recovery_deadline_at = ?
            AND recovery_lease_expires_at = ?
        `).run(
          input.code,
          input.reason ?? row.ambiguous_reason,
          input.attemptId,
          input.dispatchOrdinal,
          input.fence.ownerFence.workerId,
          input.fence.ownerFence.leaseToken,
          input.fence.ownerFence.ownerAttempt,
          input.fence.ownerFence.ownerEpoch,
          input.fence.ownerFence.deadlineAt,
          input.fence.ownerFence.leaseExpiresAt,
        );
        if (result.changes !== 1) throw new Error("stale quarantine fence");
      })();
    },
    async expireVisibility(input) {
      sqlite.transaction(() => {
        const row = attemptRow(input.attemptId);
        const stored = recoveryFenceFromRow(row);
        if (!stored || stableJson(stored) !== stableJson(input.fence)) {
          throw new Error("stale visibility expiry recovery fence");
        }
        const owner = readOwner(
          ownerFromColumns(row.pipeline_job_id, row.project_ai_run_id),
        );
        const fence = input.fence.ownerFence;
        const expiryAt = Math.min(
          Date.parse(row.original_deadline_at),
          Date.parse(fence.deadlineAt),
          Date.parse(fence.leaseExpiresAt),
        );
        if (
          stableJson(fence.owner)
            !== stableJson(ownerFromColumns(
              row.pipeline_job_id,
              row.project_ai_run_id,
            ))
          || owner.worker_id !== fence.workerId
          || owner.lease_token !== fence.leaseToken
          || owner.owner_attempt !== fence.ownerAttempt
          || owner.owner_epoch !== fence.ownerEpoch
          || owner.deadline_at !== fence.deadlineAt
          || owner.lease_expires_at !== fence.leaseExpiresAt
          || now() < expiryAt
        ) {
          throw new Error("visibility expiry fence is not due");
        }
        const result = sqlite.prepare(`
          UPDATE phase0_start_attempts
          SET state = 'quarantined', code = ?,
            ambiguous_reason = 'visibility_timeout'
          WHERE attempt_id = ? AND state IN ('dispatching','ambiguous')
            AND dispatch_ordinal = ? AND recovery_owner_id = ?
            AND recovery_lease_token = ? AND recovery_owner_attempt = ?
            AND recovery_epoch = ? AND recovery_deadline_at = ?
            AND recovery_lease_expires_at = ?
            AND original_deadline_at = ?
        `).run(
          input.code,
          input.attemptId,
          input.dispatchOrdinal,
          fence.workerId,
          fence.leaseToken,
          fence.ownerAttempt,
          fence.ownerEpoch,
          fence.deadlineAt,
          fence.leaseExpiresAt,
          row.original_deadline_at,
        );
        if (result.changes !== 1) {
          throw new Error("stale visibility expiry fence");
        }
      })();
    },
  };

  const shellProvisionPort: CodexShellProvisionPort = {
    async claim(input) {
      const provisionDeadlineAt =
        input.fence.deadlineAt ?? input.fence.leaseExpiresAt;
      const ownerAttempt = input.fence.ownerAttempt ?? 1;
      const ownerEpoch = input.fence.ownerEpoch ?? 1;
      if (
        !input.fence.ownerId
        || !input.fence.leaseToken
        || Date.parse(input.fence.leaseExpiresAt) <= now()
        || Date.parse(provisionDeadlineAt)
          < Date.parse(input.fence.leaseExpiresAt)
        || !Number.isSafeInteger(ownerAttempt)
        || !Number.isSafeInteger(ownerEpoch)
        || ownerAttempt < 1
        || ownerEpoch < 1
      ) {
        throw new Error("shell provision claim lease is not live");
      }
      if (
        input.scope.scopeId.length === 0
        || (
          input.scope.kind === "change"
          && input.scope.changeId !== input.scope.scopeId
        )
        || (
          input.scope.kind !== "change"
          && input.scope.scopeId !== input.scope.projectId
        )
      ) {
        throw new Error("shell provision scope is invalid");
      }
      return sqlite.transaction(() => {
        let row = sqlite.prepare(`
          SELECT * FROM phase0_thread_bindings
          WHERE scope_kind = ? AND scope_id = ?
        `).get(input.scope.kind, input.scope.scopeId) as BindingRow | undefined;
        let created = false;
        if (!row) {
          const bindingId = randomUUID();
          sqlite.prepare(`
            INSERT INTO phase0_thread_bindings (
              binding_id, scope_kind, scope_id, project_id, change_id,
              thread_id, cwd, title, provision_state,
              claim_owner_id, claim_lease_token, claim_lease_expires_at,
              provision_deadline_at, claim_owner_attempt, claim_owner_epoch,
              baseline_thread_ids_json, last_error
            ) VALUES (
              ?, ?, ?, ?, ?, NULL, ?, ?, 'provisioning',
              ?, ?, ?, ?, ?, ?, ?, NULL
            )
          `).run(
            bindingId,
            input.scope.kind,
            input.scope.scopeId,
            input.scope.projectId,
            input.scope.kind === "change" ? input.scope.changeId : null,
            input.cwd,
            input.title,
            input.fence.ownerId,
            input.fence.leaseToken,
            input.fence.leaseExpiresAt,
            provisionDeadlineAt,
            ownerAttempt,
            ownerEpoch,
            stableJson([...new Set(input.baselineThreadIds)]),
          );
          row = readBinding(input.scope.kind, input.scope.scopeId);
          created = true;
        } else {
          if (
            row.project_id !== input.scope.projectId
            || row.change_id !== (
              input.scope.kind === "change" ? input.scope.changeId : null
            )
            || row.cwd !== input.cwd
            || row.title !== input.title
            || (
              input.fence.deadlineAt !== undefined
              && row.provision_deadline_at !== provisionDeadlineAt
            )
          ) {
            throw new Error("shell provision intent is immutable");
          }
          if (
            (
              row.provision_state === "provisioning"
              || row.provision_state === "bootstrap_ready"
              || row.provision_state === "materializing"
            )
            && (
              row.claim_owner_id !== input.fence.ownerId
              || row.claim_lease_token !== input.fence.leaseToken
            )
          ) {
            if (
              !row.claim_lease_expires_at
              || Date.parse(row.claim_lease_expires_at) > now()
              || ownerAttempt !== (row.claim_owner_attempt ?? 0) + 1
              || ownerEpoch !== (row.claim_owner_epoch ?? 0) + 1
              || Date.parse(input.fence.leaseExpiresAt)
                > Date.parse(row.provision_deadline_at ?? "")
            ) {
              throw new Error("shell provision claim is owned by a live worker");
            }
            const takeover = sqlite.prepare(`
              UPDATE phase0_thread_bindings
              SET claim_owner_id = ?, claim_lease_token = ?,
                claim_lease_expires_at = ?,
                claim_owner_attempt = ?, claim_owner_epoch = ?
              WHERE binding_id = ? AND provision_state IN (
                'provisioning','bootstrap_ready','materializing'
              ) AND provision_state = ?
                AND claim_owner_id = ? AND claim_lease_token = ?
                AND claim_lease_expires_at = ?
                AND provision_deadline_at = ?
                AND claim_owner_attempt = ? AND claim_owner_epoch = ?
                AND claim_lease_expires_at <= ?
            `).run(
              input.fence.ownerId,
              input.fence.leaseToken,
              input.fence.leaseExpiresAt,
              ownerAttempt,
              ownerEpoch,
              row.binding_id,
              row.provision_state,
              row.claim_owner_id,
              row.claim_lease_token,
              row.claim_lease_expires_at,
              row.provision_deadline_at,
              row.claim_owner_attempt,
              row.claim_owner_epoch,
              new Date(now()).toISOString(),
            );
            if (takeover.changes !== 1) {
              throw new Error("shell provision takeover was fenced");
            }
            if (row.materialization_logical_turn_id) {
              const ownerId = `shell-materialization:${row.binding_id}`;
              const table = row.scope_kind === "change"
                ? "phase0_pipeline_jobs"
                : "phase0_project_ai_runs";
              const ownerTakeover = sqlite.prepare(`
                UPDATE ${table}
                SET worker_id = ?, lease_token = ?, owner_attempt = ?,
                  owner_epoch = ?, lease_expires_at = ?
                WHERE owner_id = ? AND deadline_at = ?
                  AND worker_id = ? AND lease_token = ?
                  AND owner_attempt = ? AND owner_epoch = ?
                  AND lease_expires_at = ?
                  AND lease_expires_at <= ?
              `).run(
                input.fence.ownerId,
                input.fence.leaseToken,
                ownerAttempt,
                ownerEpoch,
                input.fence.leaseExpiresAt,
                ownerId,
                row.provision_deadline_at,
                row.claim_owner_id,
                row.claim_lease_token,
                row.claim_owner_attempt,
                row.claim_owner_epoch,
                row.claim_lease_expires_at,
                new Date(now()).toISOString(),
              );
              if (ownerTakeover.changes !== 1) {
                throw new Error(
                  "shell materialization owner takeover was fenced",
                );
              }
            }
            row = readBinding(input.scope.kind, input.scope.scopeId);
          }
        }
        return {
          provisionId: row.binding_id,
          cwd: row.cwd,
          title: row.title,
          baselineThreadIds: JSON.parse(
            row.baseline_thread_ids_json,
          ) as string[],
          state: row.provision_state,
          created,
          ...(row.candidate_thread_id
            ? { candidateThreadId: row.candidate_thread_id }
            : {}),
          ...(row.thread_id ? { threadId: row.thread_id } : {}),
          ...(row.materialization_logical_turn_id
            ? {
                materializationLogicalTurnId:
                  row.materialization_logical_turn_id,
              }
            : {}),
          ...(row.last_error
            ? { ambiguousReason: row.last_error }
            : {}),
        };
      })();
    },
    async recordCandidate(input) {
      if (!input.threadId) {
        throw new Error("shell provision candidate thread id is required");
      }
      const result = sqlite.prepare(`
        UPDATE phase0_thread_bindings
        SET candidate_thread_id = ?
        WHERE binding_id = ? AND provision_state = 'provisioning'
          AND candidate_thread_id IS NULL
          AND claim_owner_id = ? AND claim_lease_token = ?
          AND claim_lease_expires_at = ?
          AND claim_lease_expires_at > ?
      `).run(
        input.threadId,
        input.provisionId,
        input.fence.ownerId,
        input.fence.leaseToken,
        input.fence.leaseExpiresAt,
        new Date(now()).toISOString(),
      );
      if (result.changes !== 1) {
        throw new Error("shell provision candidate CAS was fenced");
      }
    },
    async recordBootstrapReady(input) {
      if (!input.activationRequested) {
        throw new Error("shell bootstrap activation was not requested");
      }
      const result = sqlite.prepare(`
        UPDATE phase0_thread_bindings
        SET provision_state = 'bootstrap_ready',
          bootstrap_activation_requested = 1,
          creator_baseline_turn_ids_json = '[]',
          creator_baseline_semantic_hash = ?,
          last_error = NULL
        WHERE binding_id = ? AND provision_state = 'provisioning'
          AND candidate_thread_id = ? AND thread_id IS NULL
          AND claim_owner_id = ? AND claim_lease_token = ?
          AND claim_lease_expires_at = ?
          AND claim_lease_expires_at > ?
      `).run(
        hash("[]"),
        input.provisionId,
        input.threadId,
        input.fence.ownerId,
        input.fence.leaseToken,
        input.fence.leaseExpiresAt,
        new Date(now()).toISOString(),
      );
      if (result.changes !== 1) {
        throw new Error("shell bootstrap-ready CAS was fenced");
      }
    },
    async beginMaterialization(input) {
      return sqlite.transaction(() => {
        const ownerAttempt = input.fence.ownerAttempt ?? 1;
        const ownerEpoch = input.fence.ownerEpoch ?? 1;
        const deadlineAt =
          input.fence.deadlineAt ?? input.fence.leaseExpiresAt;
        const row = sqlite.prepare(`
          SELECT * FROM phase0_thread_bindings WHERE binding_id = ?
        `).get(input.provisionId) as BindingRow | undefined;
        if (
          !row
          || (
            row.provision_state !== "bootstrap_ready"
            && row.provision_state !== "materializing"
          )
          || !row.candidate_thread_id
          || row.bootstrap_activation_requested !== 1
          || row.claim_owner_id !== input.fence.ownerId
          || row.claim_lease_token !== input.fence.leaseToken
          || row.claim_lease_expires_at !== input.fence.leaseExpiresAt
          || row.provision_deadline_at !== deadlineAt
          || row.claim_owner_attempt !== ownerAttempt
          || row.claim_owner_epoch !== ownerEpoch
          || Date.parse(input.fence.leaseExpiresAt) <= now()
        ) {
          throw new Error("shell materialization claim was fenced");
        }
        const ownerId = `shell-materialization:${row.binding_id}`;
        const ownerKind = row.scope_kind === "change"
          ? "pipeline_job" as const
          : "project_ai_run" as const;
        const owner: CodexManagedOwner = ownerKind === "pipeline_job"
          ? { kind: ownerKind, pipelineJobId: ownerId }
          : { kind: ownerKind, projectAiRunId: ownerId };
        const table = ownerKind === "pipeline_job"
          ? "phase0_pipeline_jobs"
          : "phase0_project_ai_runs";
        sqlite.prepare(`
          INSERT INTO ${table} (
            owner_id, project_id, change_id, worker_id, lease_token,
            owner_attempt, owner_epoch, deadline_at, lease_expires_at, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')
          ON CONFLICT(owner_id) DO NOTHING
        `).run(
          ownerId,
          row.project_id,
          ownerKind === "pipeline_job" ? row.change_id : null,
          input.fence.ownerId,
          input.fence.leaseToken,
          ownerAttempt,
          ownerEpoch,
          deadlineAt,
          input.fence.leaseExpiresAt,
        );
        const persistedOwner = readOwner(owner);
        if (
          persistedOwner.project_id !== row.project_id
          || persistedOwner.change_id !== (
            ownerKind === "pipeline_job" ? row.change_id : null
          )
          || persistedOwner.worker_id !== input.fence.ownerId
          || persistedOwner.lease_token !== input.fence.leaseToken
          || persistedOwner.owner_attempt !== ownerAttempt
          || persistedOwner.owner_epoch !== ownerEpoch
          || persistedOwner.deadline_at !== deadlineAt
          || persistedOwner.lease_expires_at !== input.fence.leaseExpiresAt
        ) {
          throw new Error("shell materialization owner is immutable");
        }
        const logical = resolveLogicalTurn({
          owner,
          projectId: row.project_id,
          scopeKind: row.scope_kind,
          scopeId: row.scope_id,
          phase: "ShellBootstrap",
          role: "shell_materialization",
          round: 0,
          ordinal: 0,
        });
        const request = stableJson({
          cwd: row.cwd,
          prompt: [
            "Materialize this StagePass shell with one read-only bootstrap turn.",
            "Reply exactly STAGEPASS_SHELL_MATERIALIZED",
          ].join(" "),
          approvalPolicy: "never",
          sandboxMode: "read-only",
        });
        const logicalUpdate = sqlite.prepare(`
          UPDATE phase0_logical_turns
          SET purpose = 'shell_materialization', request_json = ?
          WHERE logical_turn_id = ?
            AND (purpose IS NULL OR purpose = 'shell_materialization')
            AND (request_json IS NULL OR request_json = ?)
        `).run(request, logical.logicalTurnId, request);
        if (logicalUpdate.changes !== 1) {
          throw new Error("shell materialization request is immutable");
        }
        const bindingUpdate = sqlite.prepare(`
          UPDATE phase0_thread_bindings
          SET provision_state = 'materializing',
            materialization_logical_turn_id = ?
          WHERE binding_id = ?
            AND provision_state IN ('bootstrap_ready','materializing')
            AND candidate_thread_id = ?
            AND (
              materialization_logical_turn_id IS NULL
              OR materialization_logical_turn_id = ?
            )
            AND claim_owner_id = ? AND claim_lease_token = ?
            AND claim_lease_expires_at = ?
        `).run(
          logical.logicalTurnId,
          row.binding_id,
          row.candidate_thread_id,
          logical.logicalTurnId,
          input.fence.ownerId,
          input.fence.leaseToken,
          input.fence.leaseExpiresAt,
        );
        if (bindingUpdate.changes !== 1) {
          throw new Error("shell materialization transition was fenced");
        }
        return { logicalTurnId: logical.logicalTurnId };
      })();
    },
    async finalizeDurableReady(input) {
      sqlite.transaction(() => {
        const row = sqlite.prepare(`
          SELECT * FROM phase0_thread_bindings WHERE binding_id = ?
        `).get(input.provisionId) as BindingRow | undefined;
        const attempt = attemptRow(input.attemptId);
        const execution = sqlite.prepare(`
          SELECT thread_id, turn_id FROM phase0_turn_executions
          WHERE attempt_id = ?
        `).get(input.attemptId) as {
          thread_id: string;
          turn_id: string;
        } | undefined;
        if (
          !row
          || row.provision_state !== "materializing"
          || row.candidate_thread_id !== input.threadId
          || row.materialization_logical_turn_id !== input.logicalTurnId
          || attempt.logical_turn_id !== input.logicalTurnId
          || attempt.state !== "succeeded"
          || attempt.turn_id !== input.turnId
          || attempt.correlation_marker !== input.correlationMarker
          || execution?.thread_id !== input.threadId
          || execution.turn_id !== input.turnId
          || row.claim_owner_id !== input.fence.ownerId
          || row.claim_lease_token !== input.fence.leaseToken
          || row.claim_lease_expires_at !== input.fence.leaseExpiresAt
          || Date.parse(input.fence.leaseExpiresAt) <= now()
        ) {
          throw new Error("shell durable-ready proof was fenced");
        }
        const result = sqlite.prepare(`
          UPDATE phase0_thread_bindings
          SET provision_state = 'durable_ready', thread_id = ?,
            last_error = NULL
          WHERE binding_id = ? AND provision_state = 'materializing'
            AND candidate_thread_id = ?
            AND materialization_logical_turn_id = ?
            AND claim_owner_id = ? AND claim_lease_token = ?
            AND claim_lease_expires_at = ?
            AND claim_lease_expires_at > ?
        `).run(
          input.threadId,
          input.provisionId,
          input.threadId,
          input.logicalTurnId,
          input.fence.ownerId,
          input.fence.leaseToken,
          input.fence.leaseExpiresAt,
          new Date(now()).toISOString(),
        );
        if (result.changes !== 1) {
          throw new Error("shell durable-ready CAS was fenced");
        }
      })();
    },
    async failMaterializationProof(input) {
      const result = sqlite.prepare(`
        UPDATE phase0_thread_bindings
        SET provision_state = 'ambiguous', last_error = ?
        WHERE binding_id = ? AND provision_state = 'materializing'
          AND claim_owner_id = ? AND claim_lease_token = ?
          AND claim_lease_expires_at = ?
          AND claim_lease_expires_at > ?
      `).run(
        input.reason,
        input.provisionId,
        input.fence.ownerId,
        input.fence.leaseToken,
        input.fence.leaseExpiresAt,
        new Date(now()).toISOString(),
      );
      if (result.changes !== 1) {
        throw new Error("shell materialization proof failure was fenced");
      }
    },
    async markAmbiguous(input) {
      const result = sqlite.prepare(`
        UPDATE phase0_thread_bindings
        SET provision_state = 'ambiguous', last_error = ?
        WHERE binding_id = ?
          AND provision_state IN (
            'provisioning','bootstrap_ready','materializing'
          )
          AND claim_owner_id = ? AND claim_lease_token = ?
          AND claim_lease_expires_at = ?
          AND claim_lease_expires_at > ?
      `).run(
        input.reason,
        input.provisionId,
        input.fence.ownerId,
        input.fence.leaseToken,
        input.fence.leaseExpiresAt,
        new Date(now()).toISOString(),
      );
      if (result.changes !== 1) {
        throw new Error("shell provision ambiguous CAS was fenced");
      }
    },
    async expireProvisionVisibility(input) {
      sqlite.transaction(() => {
        const row = sqlite.prepare(`
          SELECT * FROM phase0_thread_bindings WHERE binding_id = ?
        `).get(input.provisionId) as BindingRow | undefined;
        const deadlineAt =
          input.fence.deadlineAt ?? input.fence.leaseExpiresAt;
        const expiry = Date.parse(deadlineAt);
        if (
          !row
          || !(
            row.provision_state === "provisioning"
            || row.provision_state === "bootstrap_ready"
            || row.provision_state === "materializing"
          )
          || !input.fence.ownerId
          || !input.fence.leaseToken
          || !Number.isFinite(expiry)
          || row.claim_owner_id !== input.fence.ownerId
          || row.claim_lease_token !== input.fence.leaseToken
          || row.claim_lease_expires_at !== input.fence.leaseExpiresAt
          || row.provision_deadline_at !== deadlineAt
        ) {
          throw new Error("shell provision visibility expiry was fenced");
        }
        const currentNow = now();
        if (currentNow < expiry) {
          throw new Error("shell provision visibility expiry is not due");
        }
        const result = sqlite.prepare(`
          UPDATE phase0_thread_bindings
          SET provision_state = 'ambiguous', last_error = 'visibility_timeout'
          WHERE binding_id = ?
            AND provision_state IN (
              'provisioning','bootstrap_ready','materializing'
            )
            AND claim_owner_id = ? AND claim_lease_token = ?
            AND claim_lease_expires_at = ?
            AND provision_deadline_at = ?
            AND provision_deadline_at <= ?
        `).run(
          input.provisionId,
          input.fence.ownerId,
          input.fence.leaseToken,
          input.fence.leaseExpiresAt,
          deadlineAt,
          new Date(currentNow).toISOString(),
        );
        if (result.changes !== 1) {
          throw new Error("shell provision visibility expiry was fenced");
        }
      })();
    },
  };

  function insertOwner(seed: CodexPhase0ManagedRunSeed): CodexManagedOwner {
    const table = seed.ownerKind === "pipeline_job"
      ? "phase0_pipeline_jobs"
      : "phase0_project_ai_runs";
    const changeId = seed.ownerKind === "pipeline_job"
      ? seed.changeId
      : null;
    if (
      seed.ownerKind === "pipeline_job"
      && (
        seed.scopeKind !== "change"
        || !seed.changeId
        || seed.changeId !== seed.scopeId
      )
    ) {
      throw new Error("pipeline owner requires a Change scope");
    }
    if (
      seed.ownerKind === "project_ai_run"
      && (
        seed.scopeKind === "change"
        || seed.scopeId !== seed.projectId
        || seed.changeId
      )
    ) {
      throw new Error("project owner requires a Project scope");
    }
    sqlite.prepare(`
      INSERT INTO ${table} (
        owner_id, project_id, change_id, worker_id, lease_token,
        owner_attempt, owner_epoch, deadline_at, lease_expires_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')
      ON CONFLICT(owner_id) DO NOTHING
    `).run(
      seed.ownerId,
      seed.projectId,
      changeId,
      seed.workerId ?? "phase0-worker",
      seed.leaseToken ?? randomUUID(),
      seed.ownerAttempt ?? 1,
      seed.ownerEpoch ?? 1,
      seed.deadlineAt ?? "2099-01-01T00:10:00.000Z",
      seed.leaseExpiresAt ?? "2099-01-01T00:01:00.000Z",
    );
    const result: CodexManagedOwner = seed.ownerKind === "pipeline_job"
      ? { kind: "pipeline_job", pipelineJobId: seed.ownerId }
      : { kind: "project_ai_run", projectAiRunId: seed.ownerId };
    const persisted = readOwner(result);
    const expected = {
      owner_id: seed.ownerId,
      project_id: seed.projectId,
      change_id: changeId,
      worker_id: seed.workerId ?? "phase0-worker",
      lease_token: seed.leaseToken,
      owner_attempt: seed.ownerAttempt ?? 1,
      owner_epoch: seed.ownerEpoch ?? 1,
      deadline_at: seed.deadlineAt ?? "2099-01-01T00:10:00.000Z",
      lease_expires_at:
        seed.leaseExpiresAt ?? "2099-01-01T00:01:00.000Z",
      status: "running" as const,
    };
    if (
      Date.parse(expected.lease_expires_at) > Date.parse(expected.deadline_at)
    ) {
      throw new Error("managed owner lease exceeds immutable deadline");
    }
    if (
      persisted.owner_id !== expected.owner_id
      || persisted.project_id !== expected.project_id
      || persisted.change_id !== expected.change_id
      || persisted.worker_id !== expected.worker_id
      || (
        seed.leaseToken !== undefined
        && persisted.lease_token !== expected.lease_token
      )
      || persisted.owner_attempt !== expected.owner_attempt
      || persisted.owner_epoch !== expected.owner_epoch
      || persisted.deadline_at !== expected.deadline_at
      || persisted.lease_expires_at !== expected.lease_expires_at
      || persisted.status !== expected.status
    ) {
      throw new Error("managed owner seed conflict is immutable");
    }
    return result;
  }

  return {
    logicalTurnPort,
    startAttemptPort,
    shellProvisionPort,
    async seedManagedRun(seed) {
      const purpose = seed.purpose ?? (
        seed.role === "interaction_wakeup"
          ? "interaction_wakeup"
          : seed.role === "interaction_present"
            ? "interaction_present"
            : "stage_run"
      );
      if (
        (seed.role === "interaction_wakeup")
          !== (purpose === "interaction_wakeup")
        || (
          seed.role !== "interaction_wakeup"
          && purpose === "interaction_wakeup"
        )
      ) {
        throw new Error("logical role and purpose dispatch surfaces conflict");
      }
      const normalizedSeed: CodexPhase0ManagedRunSeed = {
        ...seed,
        leaseToken: seed.leaseToken
          ?? `phase0-${hash(`${seed.ownerKind}:${seed.ownerId}`, "base64url")}`,
      };
      return sqlite.transaction(() => {
        const owner = insertOwner(normalizedSeed);
        const bindingId = randomUUID();
        sqlite.prepare(`
          INSERT INTO phase0_thread_bindings (
            binding_id, scope_kind, scope_id, project_id, change_id,
            thread_id, candidate_thread_id,
            bootstrap_activation_requested,
            creator_baseline_turn_ids_json,
            creator_baseline_semantic_hash,
            cwd, title, provision_state,
            claim_owner_id, claim_lease_token, claim_lease_expires_at,
            baseline_thread_ids_json, last_error
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, 1, '[]', ?, ?, ?, 'durable_ready',
            NULL, NULL, NULL, '[]', NULL
          )
          ON CONFLICT(scope_kind, scope_id) DO NOTHING
        `).run(
          bindingId,
          normalizedSeed.scopeKind,
          normalizedSeed.scopeId,
          normalizedSeed.projectId,
          normalizedSeed.changeId ?? null,
          normalizedSeed.binding.threadId,
          normalizedSeed.binding.threadId,
          hash("[]"),
          normalizedSeed.binding.cwd,
          normalizedSeed.binding.title,
        );
        const persistedBinding = readBinding(
          normalizedSeed.scopeKind,
          normalizedSeed.scopeId,
        );
        const baselineIds = JSON.parse(
          persistedBinding.baseline_thread_ids_json,
        ) as unknown;
        const claimAllNull = persistedBinding.claim_owner_id === null
          && persistedBinding.claim_lease_token === null
          && persistedBinding.claim_lease_expires_at === null;
        const claimAllPresent =
          typeof persistedBinding.claim_owner_id === "string"
          && persistedBinding.claim_owner_id.length > 0
          && typeof persistedBinding.claim_lease_token === "string"
          && persistedBinding.claim_lease_token.length > 0
          && typeof persistedBinding.claim_lease_expires_at === "string"
          && Number.isFinite(
            Date.parse(persistedBinding.claim_lease_expires_at),
          );
        if (
          !persistedBinding.binding_id
          || persistedBinding.scope_kind !== normalizedSeed.scopeKind
          || persistedBinding.scope_id !== normalizedSeed.scopeId
          || persistedBinding.project_id !== normalizedSeed.projectId
          || persistedBinding.change_id !== (normalizedSeed.changeId ?? null)
          || persistedBinding.thread_id !== normalizedSeed.binding.threadId
          || persistedBinding.cwd !== normalizedSeed.binding.cwd
          || persistedBinding.title !== normalizedSeed.binding.title
          || persistedBinding.provision_state !== "durable_ready"
          || persistedBinding.last_error !== null
          || !Array.isArray(baselineIds)
          || baselineIds.some((id) => typeof id !== "string")
          || new Set(baselineIds).size !== baselineIds.length
          || (!claimAllNull && !claimAllPresent)
        ) {
          throw new Error("canonical binding seed conflict is immutable");
        }
        const logical = resolveLogicalTurn({
          owner,
          projectId: normalizedSeed.projectId,
          scopeKind: normalizedSeed.scopeKind,
          scopeId: normalizedSeed.scopeId,
          phase: normalizedSeed.phase,
          role: normalizedSeed.role,
          round: normalizedSeed.round,
          ordinal: normalizedSeed.ordinal,
        });
        const requestJson = stableJson(normalizedSeed.request);
        sqlite.prepare(`
          UPDATE phase0_logical_turns
          SET purpose = ?, request_json = ?
          WHERE logical_turn_id = ? AND purpose IS NULL AND request_json IS NULL
        `).run(
          purpose,
          requestJson,
          logical.logicalTurnId,
        );
        const persistedLogical = readLogicalTurn(logical.logicalTurnId);
        if (
          persistedLogical.purpose !== purpose
          || persistedLogical.request_json !== requestJson
        ) {
          throw new Error("logical turn seed conflict is immutable");
        }
        return {
          logicalTurnId: logical.logicalTurnId,
          fence: startContext(logical.logicalTurnId).fence,
        };
      })();
    },
    async takeOverOwner(takeover) {
      const [pipelineJobId, projectAiRunId] = ownerColumns(takeover.owner);
      const table = pipelineJobId
        ? "phase0_pipeline_jobs"
        : "phase0_project_ai_runs";
      const ownerId = pipelineJobId ?? projectAiRunId!;
      if (
        takeover.deadlineAt !== takeover.expectedDeadlineAt
        || !Number.isFinite(Date.parse(takeover.expectedDeadlineAt))
      ) {
        throw new Error("managed owner takeover cannot extend deadline");
      }
      if (
        takeover.ownerAttempt !== takeover.expectedOwnerAttempt + 1
        || takeover.ownerEpoch !== takeover.expectedOwnerEpoch + 1
        || !Number.isFinite(Date.parse(takeover.expectedLeaseExpiresAt))
        || !Number.isFinite(Date.parse(takeover.leaseExpiresAt))
        || Date.parse(takeover.leaseExpiresAt)
          > Date.parse(takeover.deadlineAt)
      ) {
        throw new Error("managed owner takeover fence is invalid");
      }
      const result = sqlite.prepare(`
        UPDATE ${table}
        SET worker_id = ?, lease_token = ?, owner_attempt = ?,
          owner_epoch = ?, deadline_at = ?, lease_expires_at = ?
        WHERE owner_id = ? AND worker_id = ? AND lease_token = ?
          AND owner_attempt = ? AND owner_epoch = ?
          AND deadline_at = ? AND lease_expires_at = ? AND status = ?
          AND lease_expires_at <= ?
      `).run(
        takeover.workerId,
        takeover.leaseToken,
        takeover.ownerAttempt,
        takeover.ownerEpoch,
        takeover.deadlineAt,
        takeover.leaseExpiresAt,
        ownerId,
        takeover.expectedWorkerId,
        takeover.expectedLeaseToken,
        takeover.expectedOwnerAttempt,
        takeover.expectedOwnerEpoch,
        takeover.expectedDeadlineAt,
        takeover.expectedLeaseExpiresAt,
        takeover.expectedStatus,
        new Date(now()).toISOString(),
      );
      if (result.changes !== 1) {
        throw new Error("managed owner takeover rejected");
      }
    },
    readOwner(fence) {
      const row = readOwner(fence.owner);
      return {
        ownerId: row.owner_id,
        projectId: row.project_id,
        workerId: row.worker_id,
        leaseToken: row.lease_token,
        ownerAttempt: row.owner_attempt,
        ownerEpoch: row.owner_epoch,
      };
    },
    readBinding(scopeKind, scopeId) {
      const row = readBinding(scopeKind, scopeId);
      if (!row.thread_id || row.provision_state !== "durable_ready") {
        throw new Error("canonical binding is not ready");
      }
      return {
        bindingId: row.binding_id,
        scopeKind: row.scope_kind,
        scopeId: row.scope_id,
        projectId: row.project_id,
        changeId: row.change_id,
        threadId: row.thread_id,
      };
    },
    inspectShellProvision(scopeKind, scopeId) {
      const row = readBinding(scopeKind, scopeId);
      const attempt = row.materialization_logical_turn_id
        ? sqlite.prepare(`
            SELECT * FROM phase0_start_attempts WHERE logical_turn_id = ?
          `).get(row.materialization_logical_turn_id) as
            | AttemptRow
            | undefined
        : undefined;
      const materializationLogicalTurnId =
        row.materialization_logical_turn_id;
      const attemptCount = materializationLogicalTurnId
        ? sqlite.prepare(`
            SELECT COUNT(*) AS count FROM phase0_start_attempts
            WHERE binding_id = ? AND logical_turn_id = ?
          `).get(row.binding_id, materializationLogicalTurnId) as
            { count: number }
        : { count: 0 };
      const executionCount = materializationLogicalTurnId
        ? sqlite.prepare(`
            SELECT COUNT(*) AS count FROM phase0_turn_executions
            WHERE binding_id = ? AND logical_turn_id = ?
          `).get(row.binding_id, materializationLogicalTurnId) as
            { count: number }
        : { count: 0 };
      return {
        provisionId: row.binding_id,
        state: row.provision_state,
        candidateThreadId: row.candidate_thread_id,
        threadId: row.thread_id,
        cwd: row.cwd,
        title: row.title,
        materializationLogicalTurnId:
          row.materialization_logical_turn_id,
        creatorBaselineTurnIds: row.creator_baseline_turn_ids_json
          ? JSON.parse(row.creator_baseline_turn_ids_json) as string[]
          : null,
        creatorBaselineSemanticHash:
          row.creator_baseline_semantic_hash,
        attempt: attempt ? toAttempt(attempt) : null,
        candidateCount: row.candidate_thread_id ? 1 : 0,
        attemptCount: attemptCount.count,
        executionCount: executionCount.count,
      };
    },
    readLogicalTurn(logicalTurnId) {
      const row = readLogicalTurn(logicalTurnId);
      const owner = ownerFromColumns(
        row.pipeline_job_id,
        row.project_ai_run_id,
      );
      return {
        logicalTurnId: row.logical_turn_id,
        owner,
        ownerId: owner.kind === "pipeline_job"
          ? owner.pipelineJobId
          : owner.projectAiRunId,
        turnSlot: row.turn_slot,
        runCorrelationId: row.run_correlation_id,
        dispatchSurface: row.dispatch_surface,
      };
    },
    async insertSecondAttempt(logicalTurnId) {
      const existing = sqlite.prepare(`
        SELECT * FROM phase0_start_attempts WHERE logical_turn_id = ?
      `).get(logicalTurnId) as AttemptRow | undefined;
      if (!existing) throw new Error("first attempt not found");
      sqlite.prepare(`
        INSERT INTO phase0_start_attempts
        SELECT ?, logical_turn_id, pipeline_job_id, project_ai_run_id,
          binding_id, request_json, ?, normalized_prompt_hash,
          pre_start_turn_ids_json, pre_start_semantic_hash, state,
          dispatch_ordinal, NULL, code, ambiguous_reason, project_id,
          scope_kind, scope_id, worker_id, lease_token, owner_attempt,
          owner_epoch, purpose, dispatch_surface, deadline_at,
          original_deadline_at, lease_expires_at,
          recovery_owner_id, recovery_lease_token, recovery_owner_attempt,
          recovery_epoch, recovery_deadline_at, recovery_lease_expires_at
        FROM phase0_start_attempts WHERE logical_turn_id = ?
      `).run(
        randomUUID(),
        `${existing.correlation_marker}-duplicate`,
        logicalTurnId,
      );
    },
    async inspectAttempt(attemptId) {
      const row = sqlite.prepare(`
        SELECT * FROM phase0_start_attempts WHERE attempt_id = ?
      `).get(attemptId) as AttemptRow | undefined;
      return row ? toAttempt(row) : null;
    },
    async inspectAttemptByLogicalTurn(logicalTurnId) {
      const row = sqlite.prepare(`
        SELECT * FROM phase0_start_attempts WHERE logical_turn_id = ?
      `).get(logicalTurnId) as AttemptRow | undefined;
      return row ? toAttempt(row) : null;
    },
    async listAttempts() {
      const rows = sqlite.prepare(`
        SELECT * FROM phase0_start_attempts ORDER BY attempt_id
      `).all() as AttemptRow[];
      return rows.map(toAttempt);
    },
    async saveRestartCheckpoint(input) {
      sqlite.transaction(() => {
        const attempt = sqlite.prepare(`
          SELECT * FROM phase0_start_attempts WHERE logical_turn_id = ?
        `).get(input.logicalTurnId) as AttemptRow | undefined;
        const snapshot = input.lastNormalizedSnapshot;
        const request = attempt
          ? JSON.parse(attempt.request_json) as CodexDesktopTurnRequest
          : undefined;
        if (
          !attempt
          || attempt.state !== "succeeded"
          || !attempt.turn_id
          || request?.threadId !== input.shellThreadId
          || snapshot.threadId !== input.shellThreadId
          || snapshot.turnId !== attempt.turn_id
          || snapshot.status !== "completed"
          || !Number.isSafeInteger(input.desktopPid)
          || input.desktopPid < 1
          || !Number.isSafeInteger(input.socketDevice)
          || !Number.isSafeInteger(input.socketInode)
          || !Number.isSafeInteger(input.observationCursor)
          || input.observationCursor < 1
          || input.lastSnapshotHash.length === 0
        ) {
          throw new Error("restart checkpoint evidence is invalid");
        }
        const values = [
          input.runId,
          input.logicalTurnId,
          attempt.attempt_id,
          attempt.correlation_marker,
          attempt.normalized_prompt_hash,
          attempt.pre_start_turn_ids_json,
          attempt.pre_start_semantic_hash,
          attempt.dispatch_ordinal,
          attempt.turn_id,
          input.shellThreadId,
          input.desktopPid,
          input.processStartedAt,
          input.socketPath,
          input.socketDevice,
          input.socketInode,
          input.observationCursor,
          input.lastSnapshotHash,
          stableJson(snapshot),
        ] as const;
        sqlite.prepare(`
          INSERT INTO phase0_restart_checkpoints (
            run_id, state, logical_turn_id, attempt_id,
            correlation_marker, normalized_prompt_hash,
            pre_start_turn_ids_json, pre_start_semantic_hash,
            dispatch_ordinal, turn_id, shell_thread_id, desktop_pid,
            process_started_at, socket_path, socket_device, socket_inode,
            observation_cursor, last_snapshot_hash,
            last_normalized_snapshot_json,
            resumed_logical_turn_id, resumed_attempt_id,
            resumed_correlation_marker, resumed_normalized_prompt_hash,
            resumed_pre_start_semantic_hash, resumed_shell_thread_id,
            resumed_dispatch_ordinal, resumed_turn_id, consumed_at
          ) VALUES (
            ?, 'awaiting_resume', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
          )
          ON CONFLICT(run_id) DO NOTHING
        `).run(...values);
        const persisted = sqlite.prepare(`
          SELECT * FROM phase0_restart_checkpoints WHERE run_id = ?
        `).get(input.runId) as RestartCheckpointRow | undefined;
        if (
          !persisted
          || persisted.state !== "awaiting_resume"
          || stableJson([
            persisted.run_id,
            persisted.logical_turn_id,
            persisted.attempt_id,
            persisted.correlation_marker,
            persisted.normalized_prompt_hash,
            persisted.pre_start_turn_ids_json,
            persisted.pre_start_semantic_hash,
            persisted.dispatch_ordinal,
            persisted.turn_id,
            persisted.shell_thread_id,
            persisted.desktop_pid,
            persisted.process_started_at,
            persisted.socket_path,
            persisted.socket_device,
            persisted.socket_inode,
            persisted.observation_cursor,
            persisted.last_snapshot_hash,
            persisted.last_normalized_snapshot_json,
          ]) !== stableJson(values)
        ) {
          throw new Error("restart checkpoint identity is immutable");
        }
      })();
    },
    readRestartCheckpoint(runId) {
      const row = sqlite.prepare(`
        SELECT * FROM phase0_restart_checkpoints WHERE run_id = ?
      `).get(runId) as RestartCheckpointRow | undefined;
      return row ? toRestartCheckpoint(row) : null;
    },
    async consumeRestartCheckpoint(input) {
      sqlite.transaction(() => {
        const checkpoint = sqlite.prepare(`
          SELECT * FROM phase0_restart_checkpoints WHERE run_id = ?
        `).get(input.runId) as RestartCheckpointRow | undefined;
        const resumed = sqlite.prepare(`
          SELECT * FROM phase0_start_attempts WHERE logical_turn_id = ?
        `).get(
          input.expectedResumedLogicalTurnId,
        ) as AttemptRow | undefined;
        const resumedBinding = sqlite.prepare(`
          SELECT binding.thread_id
          FROM phase0_logical_turns AS logical
          JOIN phase0_thread_bindings AS binding
            ON binding.binding_id = logical.binding_id
          WHERE logical.logical_turn_id = ?
        `).get(input.expectedResumedLogicalTurnId) as {
          thread_id: string;
        } | undefined;
        const resumedRequest = resumed
          ? JSON.parse(resumed.request_json) as CodexDesktopTurnRequest
          : undefined;
        if (
          !checkpoint
          || checkpoint.state !== "awaiting_resume"
          || checkpoint.attempt_id !== input.expectedAttemptId
          || checkpoint.dispatch_ordinal !== input.expectedDispatchOrdinal
          || checkpoint.turn_id !== input.expectedTurnId
          || !resumed
          || resumed.logical_turn_id
            !== input.expectedResumedLogicalTurnId
          || resumed.attempt_id !== input.expectedResumedAttemptId
          || resumed.state !== "succeeded"
          || !resumed.turn_id
          || resumed.normalized_prompt_hash
            !== input.expectedResumedNormalizedPromptHash
          || !resumedBinding
          || input.expectedResumedThreadId
            !== input.expectedResumedCanonicalBindingThreadId
          || resumedBinding.thread_id
            !== input.expectedResumedCanonicalBindingThreadId
          || resumedBinding.thread_id !== checkpoint.shell_thread_id
          || resumedRequest?.threadId !== input.expectedResumedThreadId
        ) {
          throw new Error("restart checkpoint consume was fenced");
        }
        const consumedAt = new Date(now()).toISOString();
        const result = sqlite.prepare(`
          UPDATE phase0_restart_checkpoints
          SET state = 'consumed',
            resumed_logical_turn_id = ?,
            resumed_attempt_id = ?,
            resumed_correlation_marker = ?,
            resumed_normalized_prompt_hash = ?,
            resumed_pre_start_semantic_hash = ?,
            resumed_shell_thread_id = ?,
            resumed_dispatch_ordinal = ?,
            resumed_turn_id = ?,
            consumed_at = ?
          WHERE run_id = ? AND state = 'awaiting_resume'
            AND logical_turn_id = ? AND attempt_id = ?
            AND correlation_marker = ? AND normalized_prompt_hash = ?
            AND pre_start_turn_ids_json = ?
            AND pre_start_semantic_hash = ?
            AND dispatch_ordinal = ? AND turn_id = ?
            AND resumed_logical_turn_id IS NULL
            AND resumed_attempt_id IS NULL
            AND resumed_normalized_prompt_hash IS NULL
            AND resumed_shell_thread_id IS NULL
            AND EXISTS (
              SELECT 1
              FROM phase0_start_attempts AS expected_resumed_attempt
              JOIN phase0_logical_turns AS expected_resumed_logical
                ON expected_resumed_logical.logical_turn_id
                  = expected_resumed_attempt.logical_turn_id
              JOIN phase0_thread_bindings AS expected_resumed_binding
                ON expected_resumed_binding.binding_id
                  = expected_resumed_logical.binding_id
              WHERE expected_resumed_attempt.logical_turn_id = ?
                AND expected_resumed_attempt.attempt_id = ?
                AND expected_resumed_attempt.state = 'succeeded'
                AND expected_resumed_attempt.normalized_prompt_hash = ?
                AND json_extract(
                  expected_resumed_attempt.request_json,
                  '$.threadId'
                ) = ?
                AND expected_resumed_binding.thread_id = ?
            )
        `).run(
          input.expectedResumedLogicalTurnId,
          input.expectedResumedAttemptId,
          resumed.correlation_marker,
          input.expectedResumedNormalizedPromptHash,
          resumed.pre_start_semantic_hash,
          input.expectedResumedCanonicalBindingThreadId,
          resumed.dispatch_ordinal,
          resumed.turn_id,
          consumedAt,
          checkpoint.run_id,
          checkpoint.logical_turn_id,
          checkpoint.attempt_id,
          checkpoint.correlation_marker,
          checkpoint.normalized_prompt_hash,
          checkpoint.pre_start_turn_ids_json,
          checkpoint.pre_start_semantic_hash,
          checkpoint.dispatch_ordinal,
          checkpoint.turn_id,
          input.expectedResumedLogicalTurnId,
          input.expectedResumedAttemptId,
          input.expectedResumedNormalizedPromptHash,
          input.expectedResumedThreadId,
          input.expectedResumedCanonicalBindingThreadId,
        );
        if (result.changes !== 1) {
          throw new Error("restart checkpoint consume was fenced");
        }
      })();
    },
    async createInteractionWakeup(interaction) {
      if (
        !interaction.interactionId
        || !Number.isSafeInteger(interaction.cardVersion)
        || interaction.cardVersion < 1
      ) {
        throw new Error("interaction wakeup identity is invalid");
      }
      sqlite.transaction(() => {
        const logical = readLogicalTurn(interaction.logicalTurnId);
        if (
          logical.role !== "interaction_wakeup"
          || logical.dispatch_surface !== "host_ui_message"
          || logical.purpose !== "interaction_wakeup"
        ) {
          throw new Error("interaction wakeup logical surface is invalid");
        }
        sqlite.prepare(`
          INSERT INTO phase0_interactions (
            interaction_id, logical_turn_id, card_version, state,
            selected_option, accepted_click_id, decided_at
          ) VALUES (?, ?, ?, 'pending', NULL, NULL, NULL)
          ON CONFLICT(interaction_id) DO NOTHING
        `).run(
          interaction.interactionId,
          interaction.logicalTurnId,
          interaction.cardVersion,
        );
        const persisted = sqlite.prepare(`
          SELECT * FROM phase0_interactions WHERE interaction_id = ?
        `).get(interaction.interactionId) as {
          logical_turn_id: string;
          card_version: number;
        };
        if (
          !persisted
          || persisted.logical_turn_id !== interaction.logicalTurnId
          || persisted.card_version !== interaction.cardVersion
        ) {
          throw new Error("interaction wakeup seed conflict is immutable");
        }
      })();
    },
    inspectInteractionBinding(interactionId) {
      const row = sqlite.prepare(`
        SELECT i.interaction_id, i.logical_turn_id, i.state,
          l.binding_id, b.thread_id
        FROM phase0_interactions i
        JOIN phase0_logical_turns l
          ON l.logical_turn_id = i.logical_turn_id
        JOIN phase0_thread_bindings b
          ON b.binding_id = l.binding_id
        WHERE i.interaction_id = ?
      `).get(interactionId) as {
        interaction_id: string;
        logical_turn_id: string;
        state: "pending" | "decided";
        binding_id: string;
        thread_id: string | null;
      } | undefined;
      if (!row || !row.thread_id) {
        throw new Error("interaction canonical binding not found");
      }
      return {
        interactionId: row.interaction_id,
        logicalTurnId: row.logical_turn_id,
        bindingId: row.binding_id,
        threadId: row.thread_id,
        state: row.state,
      };
    },
    async registerVerificationWakeup(verification) {
      sqlite.transaction(() => {
        const canonical = sqlite.prepare(`
          SELECT i.logical_turn_id, i.state, l.binding_id, b.thread_id
          FROM phase0_interactions i
          JOIN phase0_logical_turns l
            ON l.logical_turn_id = i.logical_turn_id
          JOIN phase0_thread_bindings b
            ON b.binding_id = l.binding_id
          WHERE i.interaction_id = ?
        `).get(verification.interactionId) as {
          logical_turn_id: string;
          state: "pending" | "decided";
          binding_id: string;
          thread_id: string | null;
        } | undefined;
        if (
          !canonical
          || canonical.logical_turn_id !== verification.logicalTurnId
          || canonical.binding_id !== verification.bindingId
          || canonical.thread_id !== verification.threadId
          || canonical.state !== "pending"
          || !/^[0-9a-f-]{36}$/i.test(verification.runId)
          || !/^[0-9a-f-]{36}$/i.test(verification.nonceId)
        ) {
          throw new Error("verification wakeup canonical binding mismatch");
        }
        sqlite.prepare(`
          INSERT INTO phase0_verification_wakeups (
            nonce_id, run_id, interaction_id, logical_turn_id, binding_id,
            thread_id, card_version, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'minted')
        `).run(
          verification.nonceId,
          verification.runId,
          verification.interactionId,
          verification.logicalTurnId,
          verification.bindingId,
          verification.threadId,
          verification.cardVersion,
        );
      })();
    },
    readVerificationWakeup(nonceId) {
      const row = sqlite.prepare(`
        SELECT * FROM phase0_verification_wakeups WHERE nonce_id = ?
      `).get(nonceId) as {
        nonce_id: string;
        run_id: string;
        interaction_id: string;
        logical_turn_id: string;
        binding_id: string;
        thread_id: string;
        card_version: number;
        state: "minted" | "authorized" | "acked";
        job_id: string | null;
        attempt_id: string | null;
        worker_id: string | null;
        lease_token: string | null;
        lease_expires_at: string | null;
        marker_message: string | null;
      } | undefined;
      if (!row) throw new Error("verification wakeup nonce not found");
      return {
        runId: row.run_id,
        nonceId: row.nonce_id,
        interactionId: row.interaction_id,
        logicalTurnId: row.logical_turn_id,
        bindingId: row.binding_id,
        threadId: row.thread_id,
        cardVersion: row.card_version,
        state: row.state,
        ...(row.job_id ? { jobId: row.job_id } : {}),
        ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
        ...(row.worker_id ? { workerId: row.worker_id } : {}),
        ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
        ...(row.lease_expires_at
          ? { leaseExpiresAt: row.lease_expires_at }
          : {}),
        ...(row.marker_message
          ? { markerMessage: row.marker_message }
          : {}),
      };
    },
    async submitInteractionDecision(decision) {
      return sqlite.transaction(() => {
        const interaction = sqlite.prepare(`
          SELECT * FROM phase0_interactions WHERE interaction_id = ?
        `).get(decision.interactionId) as {
          interaction_id: string;
          logical_turn_id: string;
          card_version: number;
          state: "pending" | "decided";
          selected_option: string | null;
          accepted_click_id: string | null;
        } | undefined;
        if (!interaction) throw new Error("interaction not found");
        const existingJob = sqlite.prepare(`
          SELECT job_id, attempt_id FROM phase0_wakeup_jobs
          WHERE interaction_id = ?
        `).get(decision.interactionId) as {
          job_id: string;
          attempt_id: string;
        } | undefined;
        if (interaction.state === "decided") {
          if (interaction.accepted_click_id === decision.clickId) {
            return {
              status: "duplicate" as const,
              jobId: existingJob?.job_id,
              attemptId: existingJob?.attempt_id,
            };
          }
          return { status: "stale" as const };
        }
        if (
          decision.cardVersion !== interaction.card_version
          || !decision.clickId
          || !decision.selectedOption
        ) {
          return { status: "stale" as const };
        }
        const context = startContext(interaction.logical_turn_id);
        const logical = readLogicalTurn(interaction.logical_turn_id);
        const owner = readOwner(context.owner);
        if (
          context.dispatchSurface !== "host_ui_message"
          || context.fence.purpose !== "interaction_wakeup"
          || owner.status !== "running"
          || Date.parse(owner.deadline_at) <= now()
          || Date.parse(owner.lease_expires_at) <= now()
        ) {
          throw new Error("interaction wakeup owner lease is not live");
        }
        const attemptId = durableUuid(
          "interaction-attempt",
          interaction.interaction_id,
        );
        const jobId = durableUuid("interaction-job", interaction.interaction_id);
        const marker =
          `[stagepass-run:${context.runCorrelationId}:attempt:${attemptId}]`;
        const request = {
          ...context.request,
          prompt: `${context.request.prompt}\n\n${marker}`,
        };
        const updated = sqlite.prepare(`
          UPDATE phase0_interactions
          SET state = 'decided', selected_option = ?,
            accepted_click_id = ?, decided_at = ?
          WHERE interaction_id = ? AND state = 'pending' AND card_version = ?
        `).run(
          decision.selectedOption,
          decision.clickId,
          new Date(now()).toISOString(),
          interaction.interaction_id,
          decision.cardVersion,
        );
        if (updated.changes !== 1) throw new Error("interaction decision lost CAS");
        sqlite.prepare(`
          INSERT INTO phase0_start_attempts (
            attempt_id, logical_turn_id, pipeline_job_id, project_ai_run_id,
            binding_id, request_json, correlation_marker,
            normalized_prompt_hash, pre_start_turn_ids_json,
            pre_start_semantic_hash, state, dispatch_ordinal, turn_id, code,
            ambiguous_reason, project_id, scope_kind, scope_id, worker_id,
            lease_token, owner_attempt, owner_epoch, purpose, dispatch_surface,
            deadline_at, original_deadline_at, lease_expires_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'prepared', 0, NULL, NULL, NULL,
            ?, ?, ?, ?, ?, ?, ?, ?, 'host_ui_message', ?, ?, ?
          )
        `).run(
          attemptId,
          context.logicalTurnId,
          logical.pipeline_job_id,
          logical.project_ai_run_id,
          logical.binding_id,
          stableJson(request),
          marker,
          hash(request.prompt),
          hash("[]"),
          context.projectId,
          context.scopeKind,
          context.scopeId,
          context.fence.workerId,
          context.fence.leaseToken,
          context.fence.ownerAttempt,
          context.fence.ownerEpoch,
          context.fence.purpose,
          context.fence.deadlineAt,
          context.fence.deadlineAt,
          context.fence.leaseExpiresAt,
        );
        sqlite.prepare(`
          INSERT INTO phase0_wakeup_jobs (
            job_id, interaction_id, logical_turn_id, attempt_id, state
          ) VALUES (?, ?, ?, ?, 'queued')
        `).run(
          jobId,
          interaction.interaction_id,
          context.logicalTurnId,
          attemptId,
        );
        const outboxId = durableUuid(
          "interaction-outbox",
          interaction.interaction_id,
        );
        const markerMessage = [
          "STAGEPASS_PHASE0_WAKEUP",
          interaction.interaction_id,
          jobId,
          attemptId,
          decision.selectedOption,
        ].join(" ");
        sqlite.prepare(`
          INSERT INTO phase0_wakeup_outbox (
            outbox_id, job_id, interaction_id, attempt_id, thread_id,
            marker_message, state, worker_id, lease_token, lease_expires_at,
            dispatch_count
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, 0)
        `).run(
          outboxId,
          jobId,
          interaction.interaction_id,
          attemptId,
          context.request.threadId,
          markerMessage,
        );
        return { status: "accepted" as const, jobId, attemptId };
      })();
    },
    async authorizeInteractionWakeup(authorization) {
      return sqlite.transaction(() => {
        const job = sqlite.prepare(`
          SELECT job_id, interaction_id, logical_turn_id, attempt_id, state
          FROM phase0_wakeup_jobs WHERE job_id = ?
        `).get(authorization.jobId) as {
          job_id: string;
          interaction_id: string;
          logical_turn_id: string;
          attempt_id: string;
          state: "queued" | "dispatching" | "succeeded";
        } | undefined;
        if (!job || job.state !== "queued") {
          throw new Error("interaction wakeup job is not authorizable");
        }
        const row = attemptRow(job.attempt_id);
        assertLiveOwnerForAttempt(row);
        if (
          Date.parse(authorization.leaseExpiresAt) <= now()
          || Date.parse(authorization.leaseExpiresAt)
            > Date.parse(row.original_deadline_at)
          || !/^[0-9a-f-]{36}$/i.test(authorization.markerNonceId)
        ) {
          throw new Error("interaction wakeup authorization lease is invalid");
        }
        const outbox = sqlite.prepare(`
          SELECT outbox_id, thread_id, dispatch_count
          FROM phase0_wakeup_outbox
          WHERE job_id = ? AND state = 'queued'
        `).get(job.job_id) as {
          outbox_id: string;
          thread_id: string;
          dispatch_count: number;
        } | undefined;
        if (!outbox) {
          throw new Error("interaction wakeup outbox is not authorizable");
        }
        const dispatchCount = outbox.dispatch_count + 1;
        const markerMessage = [
          "STAGEPASS_PHASE0_WAKEUP",
          outbox.thread_id,
          authorization.markerNonceId,
          job.job_id,
          job.attempt_id,
        ].join(" ");
        const claimed = sqlite.prepare(`
          UPDATE phase0_wakeup_outbox
          SET marker_message = ?, state = 'dispatching', worker_id = ?,
            lease_token = ?, lease_expires_at = ?,
            dispatch_count = dispatch_count + 1
          WHERE outbox_id = ? AND state = 'queued'
        `).run(
          markerMessage,
          authorization.workerId,
          authorization.leaseToken,
          authorization.leaseExpiresAt,
          outbox.outbox_id,
        );
        if (claimed.changes !== 1) {
          throw new Error("interaction wakeup authorization CAS lost");
        }
        const attempt = sqlite.prepare(`
          UPDATE phase0_start_attempts
          SET state = 'dispatching', dispatch_ordinal = ?
          WHERE attempt_id = ? AND state = 'prepared'
            AND dispatch_ordinal = 0
            AND dispatch_surface = 'host_ui_message'
        `).run(dispatchCount, job.attempt_id);
        if (attempt.changes !== 1) {
          throw new Error("interaction wakeup attempt authorization CAS lost");
        }
        sqlite.prepare(`
          UPDATE phase0_wakeup_jobs SET state = 'dispatching'
          WHERE job_id = ? AND state = 'queued'
        `).run(job.job_id);
        if (authorization.verificationNonceId) {
          const bound = sqlite.prepare(`
            UPDATE phase0_verification_wakeups
            SET state = 'authorized', job_id = ?, attempt_id = ?,
              worker_id = ?, lease_token = ?, lease_expires_at = ?,
              marker_message = ?
            WHERE nonce_id = ? AND interaction_id = ?
              AND logical_turn_id = ? AND binding_id = ?
              AND thread_id = ? AND state = 'minted'
          `).run(
            job.job_id,
            job.attempt_id,
            authorization.workerId,
            authorization.leaseToken,
            authorization.leaseExpiresAt,
            markerMessage,
            authorization.verificationNonceId,
            job.interaction_id,
            job.logical_turn_id,
            row.binding_id,
            outbox.thread_id,
          );
          if (bound.changes !== 1) {
            throw new Error("verification wakeup authorization binding lost");
          }
        }
        return {
          threadId: outbox.thread_id,
          markerMessage,
          attemptId: job.attempt_id,
          dispatchCount,
        };
      })();
    },
    async recordInteractionWakeupAck(acknowledgement) {
      return sqlite.transaction(() => {
        const job = sqlite.prepare(`
          SELECT job_id, interaction_id, logical_turn_id, attempt_id, state
          FROM phase0_wakeup_jobs WHERE job_id = ?
        `).get(acknowledgement.jobId) as {
          job_id: string;
          interaction_id: string;
          logical_turn_id: string;
          attempt_id: string;
          state: "queued" | "dispatching" | "succeeded";
        } | undefined;
        if (!job) throw new Error("interaction wakeup job not found");
        const existing = sqlite.prepare(`
          SELECT effect_id, execution_id, source
          FROM phase0_wakeup_effects WHERE job_id = ?
        `).get(job.job_id) as {
          effect_id: string;
          execution_id: string;
          source: "host" | "recovery";
        } | undefined;
        if (existing) {
          return {
            effectId: existing.effect_id,
            executionId: existing.execution_id,
            created: false,
            source: existing.source,
          };
        }
        const row = attemptRow(job.attempt_id);
        assertLiveOwnerForAttempt(row);
        const outbox = sqlite.prepare(`
          SELECT * FROM phase0_wakeup_outbox WHERE job_id = ?
        `).get(job.job_id) as {
          outbox_id: string;
          marker_message: string;
          state: "queued" | "dispatching" | "sent";
          worker_id: string | null;
          lease_token: string | null;
          lease_expires_at: string | null;
          dispatch_count: number;
        };
        if (
          outbox.state !== "dispatching"
          || outbox.worker_id !== acknowledgement.workerId
          || outbox.lease_token !== acknowledgement.leaseToken
          || outbox.lease_expires_at !== acknowledgement.leaseExpiresAt
          || Date.parse(outbox.lease_expires_at) <= now()
          || outbox.marker_message !== acknowledgement.markerMessage
          || row.state !== "dispatching"
          || row.dispatch_ordinal !== outbox.dispatch_count
        ) {
          throw new Error("interaction wakeup acknowledgement is stale");
        }
        sqlite.prepare(`
          INSERT INTO phase0_wakeup_receipts (
            receipt_id, outbox_id, marker_message, acknowledged_at
          ) VALUES (?, ?, ?, ?)
        `).run(
          acknowledgement.receiptId,
          outbox.outbox_id,
          outbox.marker_message,
          new Date(now()).toISOString(),
        );
        const settled = sqlite.prepare(`
          UPDATE phase0_start_attempts
          SET state = 'succeeded', turn_id = ?
          WHERE attempt_id = ? AND state = 'dispatching'
            AND dispatch_ordinal = ?
            AND dispatch_surface = 'host_ui_message'
        `).run(
          acknowledgement.receiptId,
          row.attempt_id,
          outbox.dispatch_count,
        );
        if (settled.changes !== 1) {
          throw new Error("interaction wakeup acknowledgement lost CAS");
        }
        insertExecution(row, acknowledgement.receiptId);
        const execution = sqlite.prepare(`
          SELECT execution_id FROM phase0_turn_executions
          WHERE attempt_id = ?
        `).get(row.attempt_id) as { execution_id: string };
        const effectId = durableUuid(
          "interaction-effect",
          job.interaction_id,
        );
        sqlite.prepare(`
          INSERT INTO phase0_wakeup_effects (
            effect_id, job_id, interaction_id, execution_id, source
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          effectId,
          job.job_id,
          job.interaction_id,
          execution.execution_id,
          acknowledgement.source,
        );
        sqlite.prepare(`
          UPDATE phase0_wakeup_outbox SET state = 'sent'
          WHERE outbox_id = ? AND state = 'dispatching'
        `).run(outbox.outbox_id);
        sqlite.prepare(`
          UPDATE phase0_wakeup_jobs SET state = 'succeeded'
          WHERE job_id = ? AND state = 'dispatching'
        `).run(job.job_id);
        sqlite.prepare(`
          UPDATE phase0_verification_wakeups SET state = 'acked'
          WHERE job_id = ? AND state = 'authorized'
        `).run(job.job_id);
        return {
          effectId,
          executionId: execution.execution_id,
          created: true,
          source: acknowledgement.source,
        };
      })();
    },
    async executeInteractionWakeup(wakeup) {
      type WakeJob = {
        job_id: string;
        interaction_id: string;
        logical_turn_id: string;
        attempt_id: string;
        state: "queued" | "dispatching" | "succeeded";
      };
      type WakeOutbox = {
        outbox_id: string;
        thread_id: string;
        marker_message: string;
        state: "queued" | "dispatching" | "sent";
        worker_id: string | null;
        lease_token: string | null;
        lease_expires_at: string | null;
        dispatch_count: number;
      };
      type WakeReceipt = {
        receipt_id: string;
        outbox_id: string;
        marker_message: string;
        acknowledged_at: string;
      };
      while (true) {
        const claim = sqlite.transaction(() => {
          const job = sqlite.prepare(`
            SELECT * FROM phase0_wakeup_jobs WHERE job_id = ?
          `).get(wakeup.jobId) as WakeJob | undefined;
          if (!job) throw new Error("interaction wakeup job not found");
          const existing = sqlite.prepare(`
            SELECT effect_id, execution_id, source
            FROM phase0_wakeup_effects WHERE job_id = ?
          `).get(job.job_id) as {
            effect_id: string;
            execution_id: string;
            source: "host" | "recovery";
          } | undefined;
          if (existing) {
            return {
              kind: "existing" as const,
              effectId: existing.effect_id,
              executionId: existing.execution_id,
              source: existing.source,
            };
          }
          const row = attemptRow(job.attempt_id);
          assertLiveOwnerForAttempt(row);
          const outbox = sqlite.prepare(`
            SELECT * FROM phase0_wakeup_outbox WHERE job_id = ?
          `).get(job.job_id) as WakeOutbox | undefined;
          if (!outbox) throw new Error("interaction wakeup outbox not found");
          const receipt = sqlite.prepare(`
            SELECT * FROM phase0_wakeup_receipts WHERE outbox_id = ?
          `).get(outbox.outbox_id) as WakeReceipt | undefined;
          if (
            Date.parse(wakeup.leaseExpiresAt) <= now()
            || Date.parse(wakeup.leaseExpiresAt)
              > Date.parse(row.original_deadline_at)
          ) {
            throw new Error("interaction wakeup dispatch lease is invalid");
          }
          if (receipt) {
            if (
              receipt.marker_message !== outbox.marker_message
              || outbox.state === "sent"
            ) {
              throw new Error("interaction wakeup receipt binding is invalid");
            }
            const claimedReceipt = sqlite.prepare(`
              UPDATE phase0_wakeup_outbox
              SET worker_id = ?, lease_token = ?, lease_expires_at = ?
              WHERE outbox_id = ? AND state = 'dispatching'
            `).run(
              wakeup.workerId,
              wakeup.leaseToken,
              wakeup.leaseExpiresAt,
              outbox.outbox_id,
            );
            if (claimedReceipt.changes !== 1) {
              return { kind: "wait" as const };
            }
            return {
              kind: "settle" as const,
              job,
              receipt,
            };
          }
          if (
            outbox.state === "dispatching"
            && Date.parse(outbox.lease_expires_at ?? "") > now()
          ) {
            return { kind: "wait" as const };
          }
          if (
            row.logical_turn_id !== job.logical_turn_id
            || (
              row.state !== "prepared"
              && row.state !== "dispatching"
            )
            || row.dispatch_surface !== "host_ui_message"
            || row.purpose !== "interaction_wakeup"
          ) {
            throw new Error("interaction wakeup attempt is not dispatchable");
          }
          if (outbox.state === "dispatching") {
            const claimedReconciliation = sqlite.prepare(`
              UPDATE phase0_wakeup_outbox
              SET worker_id = ?, lease_token = ?, lease_expires_at = ?
              WHERE outbox_id = ? AND state = 'dispatching'
                AND lease_expires_at <= ?
            `).run(
              wakeup.workerId,
              wakeup.leaseToken,
              wakeup.leaseExpiresAt,
              outbox.outbox_id,
              new Date(now()).toISOString(),
            );
            if (claimedReconciliation.changes !== 1) {
              return { kind: "wait" as const };
            }
            return {
              kind: "reconcile" as const,
              job,
              outbox,
            };
          }
          const nextDispatchCount = outbox.dispatch_count + 1;
          const claimed = sqlite.prepare(`
            UPDATE phase0_wakeup_outbox
            SET state = 'dispatching', worker_id = ?, lease_token = ?,
              lease_expires_at = ?, dispatch_count = dispatch_count + 1
            WHERE outbox_id = ? AND state = 'queued'
          `).run(
            wakeup.workerId,
            wakeup.leaseToken,
            wakeup.leaseExpiresAt,
            outbox.outbox_id,
          );
          if (claimed.changes !== 1) return { kind: "wait" as const };
          const claimedAttempt = sqlite.prepare(`
            UPDATE phase0_start_attempts
            SET state = 'dispatching', dispatch_ordinal = ?
            WHERE attempt_id = ? AND state IN ('prepared','dispatching')
              AND dispatch_ordinal < ?
              AND dispatch_surface = 'host_ui_message'
          `).run(
            nextDispatchCount,
            row.attempt_id,
            nextDispatchCount,
          );
          if (claimedAttempt.changes !== 1) {
            throw new Error("interaction wakeup attempt dispatch CAS lost");
          }
          sqlite.prepare(`
            UPDATE phase0_wakeup_jobs SET state = 'dispatching'
            WHERE job_id = ? AND state = 'queued'
          `).run(job.job_id);
          return {
            kind: "claimed" as const,
            job,
            row,
            outbox: {
              ...outbox,
              dispatch_count: nextDispatchCount,
              worker_id: wakeup.workerId,
              lease_token: wakeup.leaseToken,
              lease_expires_at: wakeup.leaseExpiresAt,
            },
          };
        })();
        if (claim.kind === "existing") {
          return {
            effectId: claim.effectId,
            executionId: claim.executionId,
            created: false,
            source: claim.source,
          };
        }
        if (claim.kind === "wait") {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
          continue;
        }

        if (claim.kind === "claimed") {
          const result = await wakeup.transport.sendMarkerMessage({
            threadId: claim.outbox.thread_id,
            markerMessage: claim.outbox.marker_message,
          });
          if (result.status === "rejected") {
            sqlite.transaction(() => {
              const rejected = sqlite.prepare(`
                UPDATE phase0_wakeup_outbox
                SET state = 'queued', worker_id = NULL, lease_token = NULL,
                  lease_expires_at = NULL
                WHERE outbox_id = ? AND state = 'dispatching'
                  AND worker_id = ? AND lease_token = ?
                  AND lease_expires_at = ?
                  AND dispatch_count = ?
              `).run(
                claim.outbox.outbox_id,
                wakeup.workerId,
                wakeup.leaseToken,
                wakeup.leaseExpiresAt,
                claim.outbox.dispatch_count,
              );
              if (rejected.changes !== 1) {
                throw new Error("rejected Host dispatch lost its lease");
              }
            })();
            throw new Error("Host marker dispatch was rejected");
          }
          trip("after_host_ack_before_receipt");
          sqlite.transaction(() => {
            sqlite.prepare(`
              INSERT INTO phase0_wakeup_receipts (
                receipt_id, outbox_id, marker_message, acknowledged_at
              ) VALUES (?, ?, ?, ?)
            `).run(
              result.receiptId,
              claim.outbox.outbox_id,
              claim.outbox.marker_message,
              new Date(now()).toISOString(),
            );
          })();
          trip("after_host_ack_before_settlement");
        } else if (claim.kind === "reconcile") {
          const reconciled = await wakeup.transport.reconcileMarkerMessage({
            threadId: claim.outbox.thread_id,
            markerMessage: claim.outbox.marker_message,
          });
          if (!reconciled) {
            throw new Error(
              "Host marker dispatch result remains unknown; resend prohibited",
            );
          }
          sqlite.transaction(() => {
            sqlite.prepare(`
              INSERT INTO phase0_wakeup_receipts (
                receipt_id, outbox_id, marker_message, acknowledged_at
              ) VALUES (?, ?, ?, ?)
            `).run(
              reconciled.receiptId,
              claim.outbox.outbox_id,
              claim.outbox.marker_message,
              new Date(now()).toISOString(),
            );
          })();
          trip("after_host_ack_before_settlement");
        }

        return sqlite.transaction(() => {
          const job = claim.job;
          const row = attemptRow(job.attempt_id);
          assertLiveOwnerForAttempt(row);
          const outbox = sqlite.prepare(`
            SELECT * FROM phase0_wakeup_outbox WHERE job_id = ?
          `).get(job.job_id) as WakeOutbox;
          const receipt = sqlite.prepare(`
            SELECT * FROM phase0_wakeup_receipts WHERE outbox_id = ?
          `).get(outbox.outbox_id) as WakeReceipt | undefined;
          if (
            outbox.state !== "dispatching"
            || outbox.worker_id !== wakeup.workerId
            || outbox.lease_token !== wakeup.leaseToken
            || outbox.lease_expires_at !== wakeup.leaseExpiresAt
            || Date.parse(outbox.lease_expires_at) <= now()
            || row.state !== "dispatching"
            || row.dispatch_ordinal !== outbox.dispatch_count
            || !receipt
            || receipt.marker_message !== outbox.marker_message
          ) {
            throw new Error("interaction wakeup settlement lease is stale");
          }
          const settled = sqlite.prepare(`
            UPDATE phase0_start_attempts
            SET state = 'succeeded', turn_id = ?
            WHERE attempt_id = ? AND state = 'dispatching'
              AND dispatch_ordinal = ?
              AND dispatch_surface = 'host_ui_message'
          `).run(
            receipt.receipt_id,
            row.attempt_id,
            outbox.dispatch_count,
          );
          if (settled.changes !== 1) {
            throw new Error("interaction wakeup attempt lost CAS");
          }
          insertExecution(row, receipt.receipt_id);
          const execution = sqlite.prepare(`
            SELECT execution_id FROM phase0_turn_executions
            WHERE attempt_id = ?
          `).get(row.attempt_id) as { execution_id: string };
          const effectId = durableUuid(
            "interaction-effect",
            job.interaction_id,
          );
          sqlite.prepare(`
            INSERT INTO phase0_wakeup_effects (
              effect_id, job_id, interaction_id, execution_id, source
            ) VALUES (?, ?, ?, ?, ?)
          `).run(
            effectId,
            job.job_id,
            job.interaction_id,
            execution.execution_id,
            wakeup.source,
          );
          sqlite.prepare(`
            UPDATE phase0_wakeup_outbox SET state = 'sent'
            WHERE outbox_id = ? AND state = 'dispatching'
              AND worker_id = ? AND lease_token = ?
          `).run(outbox.outbox_id, wakeup.workerId, wakeup.leaseToken);
          sqlite.prepare(`
            UPDATE phase0_wakeup_jobs SET state = 'succeeded'
            WHERE job_id = ? AND state = 'dispatching'
          `).run(job.job_id);
          return {
            effectId,
            executionId: execution.execution_id,
            created: true,
            source: wakeup.source,
          };
        })();
      }
    },
    inspectInteractionWakeup(interactionId) {
      const interaction = sqlite.prepare(`
        SELECT logical_turn_id, state FROM phase0_interactions
        WHERE interaction_id = ?
      `).get(interactionId) as {
        logical_turn_id: string;
        state: "pending" | "decided";
      } | undefined;
      if (!interaction) throw new Error("interaction not found");
      const job = sqlite.prepare(`
        SELECT job_id, attempt_id FROM phase0_wakeup_jobs
        WHERE interaction_id = ?
      `).get(interactionId) as {
        job_id: string;
        attempt_id: string;
      } | undefined;
      const outbox = sqlite.prepare(`
        SELECT outbox_id, dispatch_count FROM phase0_wakeup_outbox
        WHERE interaction_id = ?
      `).get(interactionId) as {
        outbox_id: string;
        dispatch_count: number;
      } | undefined;
      const count = (table: string, column: string, value: string): number =>
        (sqlite.prepare(
          `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
        ).get(value) as { count: number }).count;
      const surfaces = sqlite.prepare(`
        SELECT dispatch_surface FROM phase0_logical_turns
          WHERE logical_turn_id = ?
        UNION ALL
        SELECT dispatch_surface FROM phase0_start_attempts
          WHERE logical_turn_id = ?
        UNION ALL
        SELECT dispatch_surface FROM phase0_turn_executions
          WHERE logical_turn_id = ?
      `).all(
        interaction.logical_turn_id,
        interaction.logical_turn_id,
        interaction.logical_turn_id,
      ) as Array<{ dispatch_surface: string }>;
      return {
        decisionCount: interaction.state === "decided" ? 1 : 0,
        jobCount: count(
          "phase0_wakeup_jobs",
          "interaction_id",
          interactionId,
        ),
        attemptCount: count(
          "phase0_start_attempts",
          "logical_turn_id",
          interaction.logical_turn_id,
        ),
        executionCount: count(
          "phase0_turn_executions",
          "logical_turn_id",
          interaction.logical_turn_id,
        ),
        effectCount: count(
          "phase0_wakeup_effects",
          "interaction_id",
          interactionId,
        ),
        outboxCount: count(
          "phase0_wakeup_outbox",
          "interaction_id",
          interactionId,
        ),
        receiptCount: outbox
          ? count("phase0_wakeup_receipts", "outbox_id", outbox.outbox_id)
          : 0,
        dispatchCount: outbox?.dispatch_count ?? 0,
        dispatchSurfaces: surfaces.map(({ dispatch_surface }) =>
          dispatch_surface),
        ...(job ? { jobId: job.job_id, attemptId: job.attempt_id } : {}),
      };
    },
    setFailpoint(next) {
      failpoint = next;
    },
    close() {
      sqlite.close();
    },
  };
}
