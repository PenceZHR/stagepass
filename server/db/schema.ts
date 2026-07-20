import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex, check, primaryKey } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull().unique(),
  contextStatus: text("context_status").notNull().default("pending"),
  contextProvider: text("context_provider").notNull().default("codex"),
  prdStatus: text("prd_status").notNull().default("none"),
  prdProvider: text("prd_provider").notNull().default("codex"),
  prdJson: text("prd_json"),
  prdMarkdown: text("prd_markdown"),
  gitEnabled: integer("git_enabled").notNull().default(0),
  gitDefaultBranch: text("git_default_branch"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const changes = sqliteTable("changes", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  status: text("status").notNull(),
  provider: text("provider").notNull().default("codex"),
  codexThreadId: text("codex_thread_id"),
  fixIterations: integer("fix_iterations").default(0),
  blockedPhase: text("blocked_phase"),
  reworkFromPhase: text("rework_from_phase"),
  suspendedByPrd: integer("suspended_by_prd").notNull().default(0),
  preSuspendStatus: text("pre_suspend_status"),
  gitBranch: text("git_branch"),
  gateState: text("gate_state"),
  docsComplete: integer("docs_complete").notNull().default(0),
  retroDone: integer("retro_done").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  changeId: text("change_id")
    .notNull()
    .references(() => changes.id),
  phase: text("phase").notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  summary: text("summary"),
  jobId: text("job_id"),
  workerId: text("worker_id"),
  leaseToken: text("lease_token"),
  attemptNo: integer("attempt_no"),
  /** Immutable provider selected at enqueue time; null for historical rows that cannot be reconstructed. */
  provider: text("provider"),
});

export const providerRunProcesses = sqliteTable(
  "provider_run_processes",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    phase: text("phase").notNull(),
    provider: text("provider").notNull(),
    pid: integer("pid"),
    ppid: integer("ppid").notNull(),
    roundId: text("round_id"),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    lastHeartbeatAt: text("last_heartbeat_at"),
    endedAt: text("ended_at"),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    summary: text("summary"),
    jobId: text("job_id"),
    workerId: text("worker_id"),
    leaseToken: text("lease_token"),
    attemptNo: integer("attempt_no"),
    externalRef: text("external_ref"),
    processNonce: text("process_nonce"),
    processStartTime: text("process_start_time"),
    processPpid: integer("process_ppid"),
    processPgid: integer("process_pgid"),
    processCwd: text("process_cwd"),
    processCommandJson: text("process_command_json"),
  },
  (table) => [
    index("idx_provider_run_processes_status_pid").on(table.status, table.pid),
    index("idx_provider_run_processes_change_run").on(table.changeId, table.runId),
    index("idx_provider_run_processes_run_started_id").on(
      table.runId,
      table.startedAt,
      table.id,
    ),
    index("idx_provider_run_processes_job_lease_attempt").on(
      table.jobId,
      table.leaseToken,
      table.attemptNo,
    ),
    index("idx_provider_run_processes_process_identity").on(
      table.pid,
      table.processStartTime,
      table.processNonce,
    ),
  ],
);

export const pipelineJobs = sqliteTable(
  "pipeline_jobs",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    phase: text("phase").notNull(),
    actionId: text("action_id").notNull(),
    idempotencyKey: text("idempotency_key"),
    status: text("status").notNull(),
    leasedBy: text("leased_by"),
    leaseExpiresAt: text("lease_expires_at"),
    heartbeatAt: text("heartbeat_at"),
    attemptNo: integer("attempt_no").notNull().default(1),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    leaseToken: text("lease_token"),
    workerNonce: text("worker_nonce"),
    provider: text("provider").notNull().default("codex"),
  },
  (table) => [
    uniqueIndex("uq_pipeline_jobs_change_action_idempotency")
      .on(table.changeId, table.actionId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    uniqueIndex("uq_pipeline_jobs_one_active_change_phase")
      .on(table.changeId, table.phase)
      .where(sql`${table.status} IN ('queued', 'leased', 'running')`),
    index("idx_pipeline_jobs_status_lease").on(
      table.status,
      table.leaseExpiresAt,
      table.createdAt,
    ),
    index("idx_pipeline_jobs_change_created").on(table.changeId, table.createdAt),
    index("idx_pipeline_jobs_lease_fence").on(
      table.id,
      table.leaseToken,
      table.attemptNo,
    ),
  ],
);

export const changeProviderSessions = sqliteTable(
  "change_provider_sessions",
  {
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    provider: text("provider").notNull(),
    sessionKind: text("session_kind").notNull(),
    externalSessionId: text("external_session_id").notNull(),
    lastRunId: text("last_run_id").references(() => runs.id),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.changeId, table.provider, table.sessionKind] }),
    index("idx_change_provider_sessions_change_provider").on(table.changeId, table.provider),
  ],
);

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  changeId: text("change_id").references(() => changes.id),
  runId: text("run_id").references(() => runs.id),
  type: text("type").notNull(),
  message: text("message"),
  rawJson: text("raw_json"),
  createdAt: text("created_at").notNull(),
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  changeId: text("change_id")
    .notNull()
    .references(() => changes.id),
  runId: text("run_id").references(() => runs.id),
  type: text("type").notNull(),
  path: text("path").notNull(),
  createdAt: text("created_at").notNull(),
});

/**
 * Immutable, approved-at-release-time content hash for a change's release note.
 * The retro action authority reads `approvedContentHash` from here instead of
 * re-hashing the run-scoped release-note.md on disk; the live "current" copy is
 * still hashed and compared against this value as the tamper check.
 */
export const releaseNoteState = sqliteTable(
  "release_note_state",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    approvedContentHash: text("approved_content_hash").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_release_note_state_change_run").on(table.changeId, table.runId),
  ],
);

export const buildRunRecords = sqliteTable(
  "build_run_records",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    runId: text("run_id").references(() => runs.id),
    buildRunId: text("build_run_id"),
    status: text("status").notNull(),
    headSha: text("head_sha"),
    baseHeadSha: text("base_head_sha"),
    baseCommit: text("base_commit"),
    patchHash: text("patch_hash"),
    changedFilesHash: text("changed_files_hash"),
    adoptedHeadSha: text("adopted_head_sha"),
    adoptionDecisionId: text("adoption_decision_id"),
    adoptedAt: text("adopted_at"),
    artifactHash: text("artifact_hash"),
    source: text("source").notNull().default("unknown"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_build_run_records_change_status_adopted").on(
      table.changeId,
      table.status,
      table.adoptedAt,
    ),
  ],
);

export const reviewAttempts = sqliteTable(
  "review_attempts",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    runId: text("run_id").references(() => runs.id),
    attemptNo: integer("attempt_no").notNull(),
    status: text("status").notNull(),
    provider: text("provider").notNull().default("codex"),
    reviewStatus: text("review_status").notNull().default("running"),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceBuildRunId: text("source_build_run_id"),
    sourceHeadSha: text("source_head_sha"),
    inputSourceDbHash: text("input_source_db_hash"),
    inputSourceLineageJson: text("input_source_lineage_json"),
    priorBlockingFindingIdsJson: text("prior_blocking_finding_ids_json"),
    rawOutputArtifactId: text("raw_output_artifact_id").references(() => artifacts.id),
    errorCode: text("error_code"),
    sanitizedErrorSummary: text("sanitized_error_summary"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_review_attempts_change_attempt_no").on(table.changeId, table.attemptNo),
    uniqueIndex("uq_review_attempts_change_idempotency_key").on(
      table.changeId,
      table.idempotencyKey,
    ),
    index("idx_review_attempts_change_status").on(table.changeId, table.status),
    uniqueIndex("uq_review_attempts_one_running_per_change")
      .on(table.changeId)
      .where(sql`${table.status} = 'running'`),
  ],
);

export const findings = sqliteTable(
  "findings",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    runId: text("run_id").references(() => runs.id),
    roundId: text("round_id"),
    phase: text("phase"),
    source: text("source").notNull(),
    severity: text("severity").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    file: text("file"),
    line: integer("line"),
    evidence: text("evidence"),
    requiredFix: text("required_fix"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at"),
    reviewAttemptId: text("review_attempt_id").references(() => reviewAttempts.id),
    sourceBuildRunId: text("source_build_run_id"),
    sourceHeadSha: text("source_head_sha"),
    waivable: integer("waivable").notNull().default(0),
    waivedBy: text("waived_by"),
    waivedAt: text("waived_at"),
    waiverDecisionId: text("waiver_decision_id").references(() => humanDecisions.id),
    legacyState: text("legacy_state"),
    legacyFindingKey: text("legacy_finding_key"),
    findingVersion: integer("finding_version").notNull().default(1),
  },
  (table) => [
    check(
      "chk_findings_review_attempt_source",
      sql`${table.reviewAttemptId} IS NULL OR ${table.source} = 'review'`,
    ),
    check(
      "chk_findings_waivable_scope",
      sql`${table.waivable} IN (0, 1) AND (${table.waivable} = 0 OR (${table.source} = 'review' AND ${table.severity} = 'P1'))`,
    ),
    check(
      "chk_findings_review_p0_p1_evidence",
      sql`${table.source} != 'review' OR ${table.reviewAttemptId} IS NULL OR ${table.severity} NOT IN ('P0', 'P1') OR (${table.evidence} IS NOT NULL AND length(trim(${table.evidence})) > 0 AND ${table.requiredFix} IS NOT NULL AND length(trim(${table.requiredFix})) > 0)`,
    ),
  ],
);

export const reviewReports = sqliteTable(
  "review_reports",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => reviewAttempts.id),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    reportVersion: integer("report_version").notNull(),
    reviewConclusion: text("review_conclusion"),
    reportDbHash: text("report_db_hash").notNull(),
    gateStatus: text("gate_status").notNull(),
    qaAllowed: integer("qa_allowed").notNull().default(0),
    sourceBuildRunId: text("source_build_run_id"),
    sourceHeadSha: text("source_head_sha"),
    findingVersion: integer("finding_version").notNull().default(1),
    waiverVersion: integer("waiver_version").notNull().default(1),
    blockingP0: integer("blocking_p0").notNull().default(0),
    blockingP1: integer("blocking_p1").notNull().default(0),
    waivedP1: integer("waived_p1").notNull().default(0),
    p2Count: integer("p2_count").notNull().default(0),
    findingsDbHash: text("findings_db_hash"),
    staleReason: text("stale_reason"),
    legacyState: text("legacy_state"),
    reportJson: text("report_json"),
    generatedAt: text("generated_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_review_reports_attempt_version").on(table.attemptId, table.reportVersion),
    uniqueIndex("uq_review_reports_attempt_db_hash").on(table.attemptId, table.reportDbHash),
    index("idx_review_reports_change_gate_generated").on(
      table.changeId,
      table.gateStatus,
      table.generatedAt,
    ),
  ],
);

export const reviewState = sqliteTable("review_state", {
  changeId: text("change_id")
    .primaryKey()
    .references(() => changes.id),
  latestAttemptId: text("latest_attempt_id").references(() => reviewAttempts.id),
  latestAttemptNo: integer("latest_attempt_no"),
  latestReportId: text("latest_report_id").references(() => reviewReports.id),
  latestValidReviewReportId: text("latest_valid_review_report_id").references(() => reviewReports.id),
  latestValidAttemptNo: integer("latest_valid_attempt_no"),
  gateStatus: text("gate_status"),
  reviewStatus: text("review_status"),
  sourceBuildRunId: text("source_build_run_id"),
  sourceHeadSha: text("source_head_sha"),
  reportDbHash: text("report_db_hash"),
  findingVersion: integer("finding_version").notNull().default(1),
  waiverVersion: integer("waiver_version").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});

export const reviewArtifactMirrors = sqliteTable(
  "review_artifact_mirrors",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => reviewReports.id),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    artifactId: text("artifact_id").references(() => artifacts.id),
    kind: text("kind").notNull(),
    path: text("path"),
    schemaVersion: text("schema_version"),
    sourceDbHash: text("source_db_hash"),
    contentHash: text("content_hash"),
    mirrorStatus: text("mirror_status"),
    lastCheckedAt: text("last_checked_at"),
    lastRebuiltAt: text("last_rebuilt_at"),
    errorCode: text("error_code"),
    artifactPath: text("artifact_path"),
    artifactHash: text("artifact_hash"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_review_artifact_mirrors_report_kind").on(table.reportId, table.kind)],
);

export const reviewPriorFindingReviews = sqliteTable(
  "review_prior_finding_reviews",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => reviewAttempts.id),
    priorFindingId: text("prior_finding_id")
      .notNull()
      .references(() => findings.id),
    verdict: text("verdict").notNull(),
    evidence: text("evidence"),
    requiredFix: text("required_fix"),
    replacementFindingId: text("replacement_finding_id").references(() => findings.id),
    reviewerNotes: text("reviewer_notes"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_review_prior_finding_reviews_attempt_prior").on(
      table.attemptId,
      table.priorFindingId,
    ),
  ],
);

export const battleRounds = sqliteTable("battle_rounds", {
  id: text("id").primaryKey(),
  changeId: text("change_id")
    .notNull()
    .references(() => changes.id),
  phase: text("phase").notNull(),
  template: text("template").notNull(),
  roundNo: integer("round_no").notNull(),
  status: text("status").notNull(),
  redUnit: text("red_unit").notNull(),
  blueUnit: text("blue_unit").notNull(),
  inputSnapshotJson: text("input_snapshot_json").notNull(),
  paramsJson: text("params_json").notNull(),
  redArtifactPath: text("red_artifact_path"),
  redArtifactHash: text("red_artifact_hash"),
  blueArtifactPath: text("blue_artifact_path"),
  blueArtifactHash: text("blue_artifact_hash"),
  reportPath: text("report_path"),
  supersededByRoundId: text("superseded_by_round_id"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const requirementGaps = sqliteTable("requirement_gaps", {
  id: text("id").primaryKey(),
  changeId: text("change_id")
    .notNull()
    .references(() => changes.id),
  canonicalGapId: text("canonical_gap_id").notNull(),
  firstSeenRoundId: text("first_seen_round_id").notNull(),
  lastEvaluatedRoundId: text("last_evaluated_round_id").notNull(),
  resolvedByRoundId: text("resolved_by_round_id"),
  sourcePhase: text("source_phase").notNull(),
  sourceUnit: text("source_unit").notNull(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  evidence: text("evidence").notNull(),
  affectedArtifactsJson: text("affected_artifacts_json").notNull(),
  proposedSpecPatch: text("proposed_spec_patch"),
  severity: text("severity").notNull(),
  originalSeverity: text("original_severity").notNull(),
  downgradedTo: text("downgraded_to"),
  status: text("status").notNull(),
  resolutionEvidence: text("resolution_evidence"),
  waiverReason: text("waiver_reason"),
  downgradeReason: text("downgrade_reason"),
  overrideReason: text("override_reason"),
  specBlocking: integer("spec_blocking").notNull().default(0),
  mergeBlocking: integer("merge_blocking").notNull().default(0),
  sourceHashesJson: text("source_hashes_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  closedAt: text("closed_at"),
});

export const redFixClaims = sqliteTable("red_fix_claims", {
  id: text("id").primaryKey(),
  changeId: text("change_id")
    .notNull()
    .references(() => changes.id),
  roundId: text("round_id")
    .notNull()
    .references(() => battleRounds.id),
  gapId: text("gap_id").references(() => requirementGaps.id),
  canonicalGapId: text("canonical_gap_id").notNull(),
  claimStatus: text("claim_status").notNull(),
  claimSummary: text("claim_summary").notNull(),
  evidence: text("evidence").notNull(),
  artifactPath: text("artifact_path"),
  sourceHashesJson: text("source_hashes_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const blueGapReviews = sqliteTable("blue_gap_reviews", {
  id: text("id").primaryKey(),
  changeId: text("change_id")
    .notNull()
    .references(() => changes.id),
  roundId: text("round_id")
    .notNull()
    .references(() => battleRounds.id),
  gapId: text("gap_id").references(() => requirementGaps.id),
  canonicalGapId: text("canonical_gap_id").notNull(),
  verdict: text("verdict").notNull(),
  reviewSummary: text("review_summary").notNull(),
  evidence: text("evidence").notNull(),
  resolutionEvidence: text("resolution_evidence"),
  downgradedTo: text("downgraded_to"),
  sourceHashesJson: text("source_hashes_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const humanDecisions = sqliteTable("human_decisions", {
  id: text("id").primaryKey(),
  changeId: text("change_id")
    .notNull()
    .references(() => changes.id),
  roundId: text("round_id"),
  gate: text("gate").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  reason: text("reason"),
  reportHash: text("report_hash"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
});

export const stageStates = sqliteTable(
  "stage_states",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    phase: text("phase").notNull(),
    status: text("status").notNull(),
    latestRunId: text("latest_run_id"),
    latestReportId: text("latest_report_id"),
    latestGateId: text("latest_gate_id"),
    latestValidReportId: text("latest_valid_report_id"),
    dbHash: text("db_hash"),
    version: integer("version").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_stage_states_change_phase").on(table.changeId, table.phase)],
);

export const stageRuns = sqliteTable(
  "stage_runs",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    phase: text("phase").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key"),
    inputDbHash: text("input_db_hash"),
    outputDbHash: text("output_db_hash"),
    sourceLineageJson: text("source_lineage_json"),
    errorCode: text("error_code"),
    /** Immutable provider selected at enqueue time; nullable for historical rows. */
    provider: text("provider"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("idx_stage_runs_change_phase_attempt").on(table.changeId, table.phase, table.attemptNo),
  ],
);

export const stageReports = sqliteTable(
  "stage_reports",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    phase: text("phase").notNull(),
    sourceRunId: text("source_run_id").references(() => stageRuns.id),
    status: text("status").notNull(),
    countsJson: text("counts_json"),
    isFresh: integer("is_fresh").notNull().default(1),
    staleReason: text("stale_reason"),
    reportDbHash: text("report_db_hash"),
    generatedAt: text("generated_at").notNull(),
  },
  (table) => [
    index("idx_stage_reports_change_phase_generated").on(
      table.changeId,
      table.phase,
      table.generatedAt,
    ),
  ],
);

export const stageGates = sqliteTable(
  "stage_gates",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    phase: text("phase").notNull(),
    status: text("status").notNull(),
    blockersJson: text("blockers_json"),
    freshnessJson: text("freshness_json"),
    requiredActionsJson: text("required_actions_json"),
    sourceDbHash: text("source_db_hash"),
    gateVersion: integer("gate_version").notNull().default(1),
    computedAt: text("computed_at").notNull(),
  },
  (table) => [
    index("idx_stage_gates_change_phase_computed").on(
      table.changeId,
      table.phase,
      table.computedAt,
    ),
  ],
);

export const stageActions = sqliteTable(
  "stage_actions",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    phase: text("phase").notNull(),
    actionId: text("action_id").notNull(),
    enabled: integer("enabled").notNull().default(0),
    reasonCode: text("reason_code"),
    reason: text("reason"),
    blockersJson: text("blockers_json"),
    gateVersion: integer("gate_version").notNull().default(1),
    sourceDbHash: text("source_db_hash"),
    requiresIdempotencyKey: integer("requires_idempotency_key").notNull().default(0),
    computedAt: text("computed_at").notNull(),
  },
  (table) => [
    index("idx_stage_actions_change_phase_action").on(
      table.changeId,
      table.phase,
      table.actionId,
    ),
  ],
);

export const artifactMirrors = sqliteTable(
  "artifact_mirrors",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    phase: text("phase").notNull(),
    artifactType: text("artifact_type").notNull(),
    path: text("path").notNull(),
    contentHash: text("content_hash"),
    sourceDbHash: text("source_db_hash"),
    schemaVersion: text("schema_version"),
    mirrorStatus: text("mirror_status").notNull(),
    generatedAt: text("generated_at").notNull(),
  },
  (table) => [
    index("idx_artifact_mirrors_change_phase_status").on(
      table.changeId,
      table.phase,
      table.mirrorStatus,
    ),
  ],
);

export const legacyImports = sqliteTable(
  "legacy_imports",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    phase: text("phase").notNull(),
    sourcePath: text("source_path").notNull(),
    sourceArtifactHash: text("source_artifact_hash"),
    schemaVersion: text("schema_version"),
    importStatus: text("import_status").notNull(),
    importResultJson: text("import_result_json"),
    importedAt: text("imported_at").notNull(),
  },
  (table) => [
    index("idx_legacy_imports_change_phase_status").on(
      table.changeId,
      table.phase,
      table.importStatus,
    ),
  ],
);

export const planSnapshots = sqliteTable(
  "plan_snapshots",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    status: text("status").notNull(),
    planName: text("plan_name"),
    sourceSpecHash: text("source_spec_hash"),
    expectedFilesJson: text("expected_files_json"),
    forbiddenFilesJson: text("forbidden_files_json"),
    // Model-authored prose, stored as JSON string arrays exactly like
    // expected/forbidden files. Deliberately NOT the `plan_risks` table:
    // that table holds structured, severity-bearing critique risks that drive
    // the Plan gate. Model RISK lines carry no severity and must never be
    // promoted into blockers, so they get their own column.
    testPlanJson: text("test_plan_json"),
    modelRisksJson: text("model_risks_json"),
    validationPolicyHash: text("validation_policy_hash"),
    approvedAt: text("approved_at"),
    approvalDecisionId: text("approval_decision_id").references(() => humanDecisions.id),
    snapshotDbHash: text("snapshot_db_hash"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_plan_snapshots_change_status_created").on(
      table.changeId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const planSteps = sqliteTable(
  "plan_steps",
  {
    id: text("id").primaryKey(),
    planSnapshotId: text("plan_snapshot_id")
      .notNull()
      .references(() => planSnapshots.id),
    stepNo: integer("step_no").notNull(),
    title: text("title"),
    description: text("description"),
    expectedFilesJson: text("expected_files_json"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_plan_steps_snapshot_step").on(table.planSnapshotId, table.stepNo)],
);

export const planRisks = sqliteTable("plan_risks", {
  id: text("id").primaryKey(),
  planSnapshotId: text("plan_snapshot_id")
    .notNull()
    .references(() => planSnapshots.id),
  severity: text("severity").notNull(),
  category: text("category"),
  title: text("title"),
  evidence: text("evidence"),
  requiredPlanChange: text("required_plan_change"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const planApprovals = sqliteTable("plan_approvals", {
  id: text("id").primaryKey(),
  planSnapshotId: text("plan_snapshot_id")
    .notNull()
    .references(() => planSnapshots.id),
  decisionId: text("decision_id")
    .notNull()
    .references(() => humanDecisions.id),
  actor: text("actor").notNull(),
  approvedAt: text("approved_at").notNull(),
});

export const techspecSnapshots = sqliteTable(
  "techspec_snapshots",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    status: text("status").notNull(),
    sourceSpecHash: text("source_spec_hash"),
    contentJson: text("content_json"),
    contentDbHash: text("content_db_hash"),
    schemaVersion: text("schema_version").notNull(),
    reviewedAt: text("reviewed_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_techspec_snapshots_change_status_created").on(
      table.changeId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const apiSnapshots = sqliteTable(
  "api_snapshots",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    status: text("status").notNull(),
    sourceTechspecHash: text("source_techspec_hash"),
    contractJson: text("contract_json"),
    contractDbHash: text("contract_db_hash"),
    schemaVersion: text("schema_version").notNull(),
    reviewedAt: text("reviewed_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_api_snapshots_change_status_created").on(
      table.changeId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const requiredValidationCommands = sqliteTable(
  "required_validation_commands",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    phase: text("phase").notNull(),
    sourceSnapshotId: text("source_snapshot_id"),
    command: text("command").notNull(),
    commandOrder: integer("command_order").notNull(),
    required: integer("required").notNull().default(1),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_required_validation_commands_change_phase_order").on(
      table.changeId,
      table.phase,
      table.commandOrder,
    ),
  ],
);

export const testplanSnapshots = sqliteTable(
  "testplan_snapshots",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    status: text("status").notNull(),
    testIntent: text("test_intent").notNull(),
    schemaVersion: text("schema_version").notNull(),
    approvalState: text("approval_state").notNull().default("pending"),
    approvedAt: text("approved_at"),
    approvalDecisionId: text("approval_decision_id").references(() => humanDecisions.id),
    snapshotDbHash: text("snapshot_db_hash").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_testplan_snapshots_change_status_created").on(
      table.changeId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const testplanCoverageItems = sqliteTable(
  "testplan_coverage_items",
  {
    id: text("id").primaryKey(),
    testplanSnapshotId: text("testplan_snapshot_id")
      .notNull()
      .references(() => testplanSnapshots.id),
    itemKey: text("item_key").notNull(),
    title: text("title").notNull(),
    requirementRef: text("requirement_ref"),
    testType: text("test_type").notNull(),
    priority: text("priority").notNull(),
    status: text("status").notNull().default("planned"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_testplan_coverage_snapshot_key").on(
      table.testplanSnapshotId,
      table.itemKey,
    ),
  ],
);

export const testplanRiskMappings = sqliteTable(
  "testplan_risk_mappings",
  {
    id: text("id").primaryKey(),
    testplanSnapshotId: text("testplan_snapshot_id")
      .notNull()
      .references(() => testplanSnapshots.id),
    coverageItemKey: text("coverage_item_key").notNull(),
    riskRef: text("risk_ref").notNull(),
    severity: text("severity").notNull(),
    mitigation: text("mitigation").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_testplan_risk_mappings_snapshot_coverage").on(
      table.testplanSnapshotId,
      table.coverageItemKey,
    ),
  ],
);

export const testplanManualChecks = sqliteTable(
  "testplan_manual_checks",
  {
    id: text("id").primaryKey(),
    testplanSnapshotId: text("testplan_snapshot_id")
      .notNull()
      .references(() => testplanSnapshots.id),
    title: text("title").notNull(),
    description: text("description"),
    required: integer("required").notNull().default(1),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_testplan_manual_checks_snapshot_required").on(
      table.testplanSnapshotId,
      table.required,
    ),
  ],
);

export const qaRuns = sqliteTable(
  "qa_runs",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    sourceReviewReportId: text("source_review_report_id").references(() => reviewReports.id),
    sourceBuildRunId: text("source_build_run_id"),
    sourceHeadSha: text("source_head_sha"),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("idx_qa_runs_change_status_started").on(table.changeId, table.status, table.startedAt),
  ],
);

export const qaCommandResults = sqliteTable(
  "qa_command_results",
  {
    id: text("id").primaryKey(),
    qaRunId: text("qa_run_id")
      .notNull()
      .references(() => qaRuns.id),
    command: text("command").notNull(),
    commandOrder: integer("command_order").notNull(),
    status: text("status").notNull(),
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms"),
    outputArtifactMirrorId: text("output_artifact_mirror_id").references(() => artifactMirrors.id),
    completedAt: text("completed_at"),
  },
  (table) => [index("idx_qa_command_results_run_order").on(table.qaRunId, table.commandOrder)],
);

export const qaFailures = sqliteTable("qa_failures", {
  id: text("id").primaryKey(),
  qaRunId: text("qa_run_id")
    .notNull()
    .references(() => qaRuns.id),
  commandResultId: text("command_result_id").references(() => qaCommandResults.id),
  severity: text("severity").notNull(),
  title: text("title"),
  evidence: text("evidence"),
  requiredFix: text("required_fix"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const qaEvidence = sqliteTable("qa_evidence", {
  id: text("id").primaryKey(),
  qaRunId: text("qa_run_id")
    .notNull()
    .references(() => qaRuns.id),
  evidenceType: text("evidence_type").notNull(),
  artifactMirrorId: text("artifact_mirror_id").references(() => artifactMirrors.id),
  contentHash: text("content_hash"),
  createdAt: text("created_at").notNull(),
});

export const mergeReadiness = sqliteTable(
  "merge_readiness",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    status: text("status").notNull(),
    sourceDbHash: text("source_db_hash"),
    sourceHeadSha: text("source_head_sha"),
    blockersJson: text("blockers_json"),
    computedAt: text("computed_at").notNull(),
  },
  (table) => [
    index("idx_merge_readiness_change_computed").on(table.changeId, table.computedAt),
  ],
);

export const mergeBlockers = sqliteTable("merge_blockers", {
  id: text("id").primaryKey(),
  mergeReadinessId: text("merge_readiness_id")
    .notNull()
    .references(() => mergeReadiness.id),
  blockerType: text("blocker_type").notNull(),
  severity: text("severity").notNull(),
  title: text("title"),
  sourceTable: text("source_table"),
  sourceId: text("source_id"),
  createdAt: text("created_at").notNull(),
});

export const mergeApprovals = sqliteTable("merge_approvals", {
  id: text("id").primaryKey(),
  changeId: text("change_id")
    .notNull()
    .references(() => changes.id),
  decisionId: text("decision_id")
    .notNull()
    .references(() => humanDecisions.id),
  actor: text("actor").notNull(),
  approvedAt: text("approved_at").notNull(),
});

export const mergeDecisions = sqliteTable("merge_decisions", {
  id: text("id").primaryKey(),
  changeId: text("change_id")
    .notNull()
    .references(() => changes.id),
  readinessId: text("readiness_id").references(() => mergeReadiness.id),
  decisionType: text("decision_type").notNull(),
  actor: text("actor").notNull(),
  reason: text("reason"),
  createdAt: text("created_at").notNull(),
});

export const warReports = sqliteTable("war_reports", {
  id: text("id").primaryKey(),
  changeId: text("change_id")
    .notNull()
    .references(() => changes.id),
  roundId: text("round_id"),
  phase: text("phase").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  path: text("path").notNull(),
  sourceHashesJson: text("source_hashes_json").notNull(),
  reportHash: text("report_hash").notNull(),
  blockingP0: integer("blocking_p0").notNull().default(0),
  blockingP1: integer("blocking_p1").notNull().default(0),
  nonBlockingP2: integer("non_blocking_p2").notNull().default(0),
  overriddenP0: integer("overridden_p0").notNull().default(0),
  openRequirementGaps: integer("open_requirement_gaps").notNull().default(0),
  generatedBy: text("generated_by").notNull(),
  aiPolished: integer("ai_polished").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const prdBriefings = sqliteTable("prd_briefings", {
  id: text("id").primaryKey(),
  changeId: text("change_id")
    .notNull()
    .references(() => changes.id),
  status: text("status").notNull(),
  intentText: text("intent_text").notNull().default(""),
  finalReviewJson: text("final_review_json"),
  sourceHashesJson: text("source_hashes_json").notNull().default("{}"),
  lockedAt: text("locked_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const briefingQuestions = sqliteTable("briefing_questions", {
  id: text("id").primaryKey(),
  changeId: text("change_id")
    .notNull()
    .references(() => changes.id),
  /**
   * Which interrogation round produced this card. Generation APPENDS a round;
   * it never replaces the set, so a card's round is fixed at insert and every
   * earlier round stays readable and answerable. Defaults to 1 so pre-round
   * rows (and fixtures that predate the column) read as the first round.
   */
  roundNo: integer("round_no").notNull().default(1),
  category: text("category").notNull(),
  severity: text("severity").notNull(),
  question: text("question").notNull(),
  whyItMatters: text("why_it_matters").notNull(),
  suggestedDefault: text("suggested_default"),
  status: text("status").notNull(),
  answer: text("answer"),
  source: text("source").notNull().default("ai_blue"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const prdDrafts = sqliteTable("prd_drafts", {
  id: text("id").primaryKey(),
  changeId: text("change_id")
    .notNull()
    .references(() => changes.id),
  version: integer("version").notNull(),
  markdown: text("markdown").notNull(),
  sourceQuestionIdsJson: text("source_question_ids_json").notNull(),
  unresolvedQuestionIdsJson: text("unresolved_question_ids_json").notNull(),
  draftHash: text("draft_hash").notNull(),
  createdAt: text("created_at").notNull(),
});

/**
 * A user-editable yes/no checklist for one (scope, phase, role).
 *
 * Rubric rows are APPEND-ONLY. Editing a rubric writes a new row with
 * `version + 1` and moves `is_current`; the old row and every criterion under it
 * stay readable forever, because assessments reference them and a finished run
 * must remain explainable in the terms it was actually judged by.
 *
 * `change_id` NULL means the project-level default; a non-NULL row overrides it
 * for that one change. NULL is not a wildcard for the uniqueness rule, and
 * SQLite treats NULLs as distinct in a unique index, so "one current rubric per
 * scope" needs the two partial indexes below rather than one over all four
 * columns -- with a single index, every project-level rubric version would read
 * as current simultaneously.
 */
export const rubrics = sqliteTable(
  "rubrics",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    /** NULL = project-level default; non-NULL = this change's override. */
    changeId: text("change_id").references(() => changes.id),
    phase: text("phase").notNull(),
    /** producer | critic | verdict -- see RUBRIC_ROLES. */
    role: text("role").notNull(),
    version: integer("version").notNull().default(1),
    isCurrent: integer("is_current").notNull().default(1),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_rubrics_current_change")
      .on(table.projectId, table.changeId, table.phase, table.role)
      .where(sql`${table.isCurrent} = 1 AND ${table.changeId} IS NOT NULL`),
    uniqueIndex("uq_rubrics_current_project")
      .on(table.projectId, table.phase, table.role)
      .where(sql`${table.isCurrent} = 1 AND ${table.changeId} IS NULL`),
    uniqueIndex("uq_rubrics_version_change")
      .on(table.projectId, table.changeId, table.phase, table.role, table.version)
      .where(sql`${table.changeId} IS NOT NULL`),
    uniqueIndex("uq_rubrics_version_project")
      .on(table.projectId, table.phase, table.role, table.version)
      .where(sql`${table.changeId} IS NULL`),
    index("idx_rubrics_scope_current").on(
      table.projectId,
      table.changeId,
      table.phase,
      table.role,
      table.isCurrent,
    ),
  ],
);

/**
 * One yes/no criterion. Immutable, like the rubric version that owns it: an
 * edit produces a new rubric version carrying a fresh set of criterion rows, so
 * a stored assessment's `criterion_id` always resolves to the exact text the
 * model was shown.
 */
export const rubricCriteria = sqliteTable(
  "rubric_criteria",
  {
    id: text("id").primaryKey(),
    rubricId: text("rubric_id")
      .notNull()
      .references(() => rubrics.id),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    /**
     * Defaults to blocking. A criterion someone bothered to write is assumed to
     * matter until they say otherwise -- the fail-closed direction, matching
     * `not_assessed` being blocking rather than ignorable.
     */
    blocking: integer("blocking").notNull().default(1),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_rubric_criteria_rubric_ordinal").on(table.rubricId, table.ordinal),
    index("idx_rubric_criteria_rubric").on(table.rubricId),
  ],
);

/**
 * One criterion's verdict for one run (and, where the stage has them, one
 * round).
 *
 * `change_id` is carried here rather than being reached through `run_id`, and
 * that is deliberate: `run_id` names a row in whichever ledger the stage uses
 * (`runs`, `stage_runs`, or a spec-battle round), so it cannot carry a foreign
 * key, and without one a change deletion could not find the assessments a run
 * made against a PROJECT-level rubric -- those rows' only other link is
 * `rubric_id`, which points at a rubric that outlives the change. The column
 * keeps deletion a single `change_id = ?` predicate and lets the FK graph
 * enrol this table in CHANGE_DELETE_PLAN automatically.
 *
 * `verdict` may be not_assessed here even though a model may only ever write
 * yes or no: that value is stagepass's own record of an unanswered criterion.
 */
export const rubricAssessments = sqliteTable(
  "rubric_assessments",
  {
    id: text("id").primaryKey(),
    changeId: text("change_id")
      .notNull()
      .references(() => changes.id),
    /** Ledger row this judgment belongs to. Intentionally un-keyed; see above. */
    runId: text("run_id").notNull(),
    roundId: text("round_id"),
    rubricId: text("rubric_id")
      .notNull()
      .references(() => rubrics.id),
    criterionId: text("criterion_id")
      .notNull()
      .references(() => rubricCriteria.id),
    /** yes | no | not_assessed -- see RUBRIC_VERDICTS. */
    verdict: text("verdict").notNull(),
    evidence: text("evidence"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    // One verdict per criterion per run/round. Two rows would be contradictory
    // and which one won would depend on read order. Split in two for the same
    // NULL-distinctness reason as `rubrics`: with one index over a nullable
    // `round_id`, a round-less stage could store a criterion twice.
    uniqueIndex("uq_rubric_assessments_run_round_criterion")
      .on(table.runId, table.roundId, table.criterionId)
      .where(sql`${table.roundId} IS NOT NULL`),
    uniqueIndex("uq_rubric_assessments_run_criterion")
      .on(table.runId, table.criterionId)
      .where(sql`${table.roundId} IS NULL`),
    index("idx_rubric_assessments_change_rubric").on(table.changeId, table.rubricId),
    index("idx_rubric_assessments_run").on(table.runId),
  ],
);
