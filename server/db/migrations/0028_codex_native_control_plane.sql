ALTER TABLE `projects` ADD COLUMN `default_codex_model` TEXT;
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `default_reasoning_effort` TEXT;
--> statement-breakpoint
ALTER TABLE `changes` ADD COLUMN `codex_model` TEXT;
--> statement-breakpoint
ALTER TABLE `changes` ADD COLUMN `reasoning_effort` TEXT;
--> statement-breakpoint
ALTER TABLE `human_decisions` ADD COLUMN `interaction_id` TEXT REFERENCES `codex_interactions`(`id`);
--> statement-breakpoint
ALTER TABLE `human_decisions` ADD COLUMN `actor_surface` TEXT CHECK (
  `actor_surface` IS NULL OR `actor_surface` IN (
    'codex_mcp_app',
    'stagepass_web_emergency',
    'stagepass_web_ops',
    'legacy_web_migration',
    'recovery'
  )
);
--> statement-breakpoint
ALTER TABLE `human_decisions` ADD COLUMN `codex_thread_id` TEXT;
--> statement-breakpoint
ALTER TABLE `human_decisions` ADD COLUMN `command_id` TEXT REFERENCES `pipeline_command_receipts`(`command_id`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `codex_thread_bindings` (
  `binding_id` TEXT PRIMARY KEY NOT NULL,
  `scope_kind` TEXT NOT NULL CHECK (`scope_kind` IN ('change','project_prd','project_context')),
  `scope_id` TEXT NOT NULL,
  `project_id` TEXT NOT NULL REFERENCES `projects`(`id`),
  `change_id` TEXT REFERENCES `changes`(`id`),
  `codex_project_id` TEXT,
  `thread_id` TEXT,
  `title` TEXT NOT NULL,
  `status` TEXT NOT NULL CHECK (`status` IN ('provisioning','ready','running','waiting_human','failed','detached')),
  `bridge_protocol_version` TEXT NOT NULL,
  `provision_claim_token` TEXT,
  `provision_lease_owner` TEXT,
  `provision_lease_expires_at` TEXT,
  `follower_start_proved_at` TEXT,
  `last_turn_id` TEXT,
  `last_observation_cursor` INTEGER NOT NULL DEFAULT 0,
  `last_semantic_snapshot_hash` TEXT,
  `last_seen_at` TEXT NOT NULL,
  `last_error_code` TEXT,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL,
  CHECK (
    (`scope_kind` = 'change' AND `change_id` IS NOT NULL AND `scope_id` = `change_id`)
    OR
    (`scope_kind` IN ('project_prd','project_context') AND `change_id` IS NULL AND `scope_id` = `project_id`)
  ),
  CHECK (`thread_id` IS NOT NULL OR `status` = 'provisioning')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_codex_thread_bindings_scope`
  ON `codex_thread_bindings` (`scope_kind`, `scope_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_codex_thread_bindings_thread`
  ON `codex_thread_bindings` (`thread_id`) WHERE `thread_id` IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `project_ai_runs` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `project_id` TEXT NOT NULL REFERENCES `projects`(`id`),
  `kind` TEXT NOT NULL CHECK (`kind` IN ('prd_turn','context_init')),
  `request_key` TEXT NOT NULL,
  `sequence` INTEGER NOT NULL,
  `status` TEXT NOT NULL CHECK (`status` IN ('pending','leased','running','succeeded','failed','cancelled','quarantined')),
  `worker_id` TEXT,
  `lease_token` TEXT,
  `owner_attempt` INTEGER NOT NULL DEFAULT 0,
  `owner_epoch` INTEGER NOT NULL DEFAULT 0,
  `lease_expires_at` TEXT,
  `deadline_at` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL,
  `completed_at` TEXT,
  UNIQUE (`project_id`, `kind`, `request_key`),
  CHECK (
    (`status` = 'pending' AND `worker_id` IS NULL AND `lease_token` IS NULL AND `lease_expires_at` IS NULL)
    OR
    (`status` IN ('leased','running') AND `worker_id` IS NOT NULL AND `lease_token` IS NOT NULL AND `lease_expires_at` IS NOT NULL)
    OR
    (`status` IN ('succeeded','failed','cancelled','quarantined'))
  )
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_project_ai_runs_state_machine`
BEFORE UPDATE OF `status`,`worker_id`,`lease_token`,`owner_attempt`,`owner_epoch`,`lease_expires_at`,`deadline_at`
ON `project_ai_runs`
WHEN NOT (
  (
    OLD.`status` = 'pending'
    AND NEW.`status` = 'leased'
    AND NEW.`worker_id` IS NOT NULL AND NEW.`lease_token` IS NOT NULL
    AND NEW.`owner_attempt` = OLD.`owner_attempt` + 1
    AND NEW.`owner_epoch` = OLD.`owner_epoch` + 1
    AND julianday(NEW.`lease_expires_at`) > julianday('now')
    AND julianday(NEW.`deadline_at`) > julianday('now')
  )
  OR
  (
    OLD.`status` IN ('leased','running')
    AND NEW.`status` = OLD.`status`
    AND NEW.`worker_id` = OLD.`worker_id`
    AND NEW.`lease_token` = OLD.`lease_token`
    AND NEW.`owner_attempt` = OLD.`owner_attempt`
    AND NEW.`owner_epoch` = OLD.`owner_epoch`
    AND julianday(NEW.`lease_expires_at`) > julianday(OLD.`lease_expires_at`)
    AND julianday(NEW.`lease_expires_at`) <= julianday(OLD.`deadline_at`)
    AND NEW.`deadline_at` = OLD.`deadline_at`
    AND julianday(OLD.`lease_expires_at`) > julianday('now')
    AND julianday(OLD.`deadline_at`) > julianday('now')
  )
  OR
  (
    OLD.`status` = 'leased'
    AND NEW.`status` = 'running'
    AND NEW.`worker_id` = OLD.`worker_id`
    AND NEW.`lease_token` = OLD.`lease_token`
    AND NEW.`owner_attempt` = OLD.`owner_attempt`
    AND NEW.`owner_epoch` = OLD.`owner_epoch`
    AND NEW.`lease_expires_at` = OLD.`lease_expires_at`
    AND NEW.`deadline_at` = OLD.`deadline_at`
    AND julianday(OLD.`lease_expires_at`) > julianday('now')
    AND julianday(OLD.`deadline_at`) > julianday('now')
  )
  OR
  (
    OLD.`status` = 'running'
    AND NEW.`status` IN ('succeeded','failed','cancelled','quarantined')
    AND NEW.`worker_id` = OLD.`worker_id`
    AND NEW.`lease_token` = OLD.`lease_token`
    AND NEW.`owner_attempt` = OLD.`owner_attempt`
    AND NEW.`owner_epoch` = OLD.`owner_epoch`
    AND NEW.`lease_expires_at` = OLD.`lease_expires_at`
    AND NEW.`deadline_at` = OLD.`deadline_at`
    AND julianday(OLD.`lease_expires_at`) > julianday('now')
    AND julianday(OLD.`deadline_at`) > julianday('now')
  )
  OR
  (
    OLD.`status` IN ('leased','running')
    AND NEW.`status` = 'leased'
    AND julianday(OLD.`lease_expires_at`) <= julianday('now')
    AND julianday(OLD.`deadline_at`) > julianday('now')
    AND NEW.`worker_id` IS NOT NULL AND NEW.`lease_token` IS NOT NULL
    AND (NEW.`worker_id` <> OLD.`worker_id` OR NEW.`lease_token` <> OLD.`lease_token`)
    AND NEW.`owner_attempt` = OLD.`owner_attempt` + 1
    AND NEW.`owner_epoch` = OLD.`owner_epoch` + 1
    AND julianday(NEW.`lease_expires_at`) > julianday('now')
    AND NEW.`deadline_at` = OLD.`deadline_at`
  )
  OR
  (
    OLD.`status` IN ('succeeded','failed','cancelled','quarantined')
    AND NEW.`status` = OLD.`status`
    AND NEW.`worker_id` IS OLD.`worker_id`
    AND NEW.`lease_token` IS OLD.`lease_token`
    AND NEW.`owner_attempt` = OLD.`owner_attempt`
    AND NEW.`owner_epoch` = OLD.`owner_epoch`
    AND NEW.`lease_expires_at` IS OLD.`lease_expires_at`
    AND NEW.`deadline_at` = OLD.`deadline_at`
  )
)
BEGIN
  SELECT RAISE(ABORT, 'project_ai_run_transition_invalid');
END;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `codex_interactions` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL REFERENCES `changes`(`id`),
  `binding_id` TEXT NOT NULL REFERENCES `codex_thread_bindings`(`binding_id`),
  `codex_thread_id` TEXT NOT NULL,
  `phase` TEXT NOT NULL,
  `kind` TEXT NOT NULL,
  `gate_version` INTEGER NOT NULL,
  `source_db_hash` TEXT NOT NULL,
  `payload_json` TEXT NOT NULL,
  `form_json` TEXT,
  `status` TEXT NOT NULL CHECK (`status` IN ('pending','presented','submitting','completed','expired','superseded','cancelled','failed')),
  `idempotency_key` TEXT NOT NULL,
  `invocation_nonce_hash` TEXT,
  `source_thread_id` TEXT,
  `nonce_expires_at` TEXT,
  `nonce_consumed_at` TEXT,
  `expected_head_sha` TEXT,
  `request_hash` TEXT NOT NULL DEFAULT '',
  `superseded_by_id` TEXT,
  `presented_at` TEXT,
  `completed_at` TEXT,
  `expires_at` TEXT NOT NULL,
  `superseded_at` TEXT,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_codex_interactions_active_identity`
  ON `codex_interactions` (`change_id`, `kind`, `gate_version`, `source_db_hash`)
  WHERE `status` IN ('pending','presented','submitting');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_codex_interactions_idempotency`
  ON `codex_interactions` (`change_id`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_codex_interactions_change_status_created`
  ON `codex_interactions` (`change_id`, `status`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_codex_interactions_thread_status`
  ON `codex_interactions` (`codex_thread_id`, `status`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `pipeline_command_receipts` (
  `command_id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL REFERENCES `changes`(`id`),
  `interaction_id` TEXT,
  `codex_thread_id` TEXT,
  `action` TEXT NOT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_surface` TEXT NOT NULL CHECK (`actor_surface` IN ('codex_mcp_app','stagepass_web_emergency','stagepass_web_ops','legacy_web_migration','recovery')),
  `idempotency_key` TEXT NOT NULL,
  `request_hash` TEXT NOT NULL,
  `status` TEXT NOT NULL CHECK (`status` IN ('accepted','completed','rejected','failed')),
  `result_json` TEXT,
  `error_code` TEXT,
  `created_at` TEXT NOT NULL,
  `completed_at` TEXT,
  UNIQUE (`change_id`, `idempotency_key`)
);
--> statement-breakpoint

ALTER TABLE `pipeline_jobs` ADD COLUMN `job_kind` TEXT NOT NULL DEFAULT 'stage'
  CHECK (`job_kind` IN ('stage','interaction_present','interaction_wakeup'));
--> statement-breakpoint
ALTER TABLE `pipeline_jobs` ADD COLUMN `effect_type` TEXT;
--> statement-breakpoint
ALTER TABLE `pipeline_jobs` ADD COLUMN `interaction_id` TEXT REFERENCES `codex_interactions`(`id`);
--> statement-breakpoint
ALTER TABLE `pipeline_jobs` ADD COLUMN `command_id` TEXT REFERENCES `pipeline_command_receipts`(`command_id`);
--> statement-breakpoint
ALTER TABLE `pipeline_jobs` ADD COLUMN `effect_schema_version` TEXT;
--> statement-breakpoint
ALTER TABLE `pipeline_jobs` ADD COLUMN `effect_payload_json` TEXT;
--> statement-breakpoint
ALTER TABLE `pipeline_jobs` ADD COLUMN `next_turn_ordinal` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `pipeline_jobs` ADD COLUMN `effect_deadline_at` TEXT;
--> statement-breakpoint
DROP INDEX IF EXISTS `uq_pipeline_jobs_one_active_change_phase`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_pipeline_jobs_one_active_change_phase`
  ON `pipeline_jobs` (`change_id`, `phase`)
  WHERE `job_kind` = 'stage' AND `status` IN ('queued','leased','running');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_pipeline_jobs_interaction_present_effect`
  ON `pipeline_jobs` (`interaction_id`, `effect_type`)
  WHERE `job_kind` = 'interaction_present';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_pipeline_jobs_interaction_wakeup_effect`
  ON `pipeline_jobs` (`command_id`, `effect_type`)
  WHERE `job_kind` = 'interaction_wakeup';
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_pipeline_jobs_effect_insert`
BEFORE INSERT ON `pipeline_jobs`
WHEN NOT (
  (NEW.`job_kind` = 'stage' AND NEW.`effect_type` IS NULL AND NEW.`interaction_id` IS NULL
    AND NEW.`command_id` IS NULL AND NEW.`effect_schema_version` IS NULL
    AND NEW.`effect_payload_json` IS NULL AND NEW.`effect_deadline_at` IS NULL)
  OR
  (NEW.`job_kind` = 'interaction_present' AND NEW.`effect_type` IS NOT NULL
    AND NEW.`interaction_id` IS NOT NULL AND NEW.`command_id` IS NULL
    AND NEW.`effect_schema_version` = 'stagepass.pipeline-effect/v1'
    AND json_valid(NEW.`effect_payload_json`) = 1
    AND json_extract(NEW.`effect_payload_json`, '$.schemaVersion') = 'stagepass.pipeline-effect/v1'
    AND json_extract(NEW.`effect_payload_json`, '$.kind') = 'interaction_present'
    AND json_extract(NEW.`effect_payload_json`, '$.interactionId') = NEW.`interaction_id`
    AND json_type(NEW.`effect_payload_json`, '$.commandId') IS NULL
    AND NEW.`effect_deadline_at` IS NOT NULL)
  OR
  (NEW.`job_kind` = 'interaction_wakeup' AND NEW.`effect_type` IS NOT NULL
    AND NEW.`interaction_id` IS NOT NULL AND NEW.`command_id` IS NOT NULL
    AND NEW.`effect_schema_version` = 'stagepass.pipeline-effect/v1'
    AND json_valid(NEW.`effect_payload_json`) = 1
    AND json_extract(NEW.`effect_payload_json`, '$.schemaVersion') = 'stagepass.pipeline-effect/v1'
    AND json_extract(NEW.`effect_payload_json`, '$.kind') = 'interaction_wakeup'
    AND json_extract(NEW.`effect_payload_json`, '$.interactionId') = NEW.`interaction_id`
    AND json_extract(NEW.`effect_payload_json`, '$.commandId') = NEW.`command_id`
    AND NEW.`effect_deadline_at` IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'pipeline_job_effect_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_pipeline_jobs_effect_update`
BEFORE UPDATE OF `job_kind`,`effect_type`,`interaction_id`,`command_id`,`effect_schema_version`,`effect_payload_json`,`effect_deadline_at`
ON `pipeline_jobs`
WHEN NOT (
  (NEW.`job_kind` = 'stage' AND NEW.`effect_type` IS NULL AND NEW.`interaction_id` IS NULL
    AND NEW.`command_id` IS NULL AND NEW.`effect_schema_version` IS NULL
    AND NEW.`effect_payload_json` IS NULL AND NEW.`effect_deadline_at` IS NULL)
  OR
  (NEW.`job_kind` = 'interaction_present' AND NEW.`effect_type` IS NOT NULL
    AND NEW.`interaction_id` IS NOT NULL AND NEW.`command_id` IS NULL
    AND NEW.`effect_schema_version` = 'stagepass.pipeline-effect/v1'
    AND json_valid(NEW.`effect_payload_json`) = 1
    AND json_extract(NEW.`effect_payload_json`, '$.schemaVersion') = 'stagepass.pipeline-effect/v1'
    AND json_extract(NEW.`effect_payload_json`, '$.kind') = 'interaction_present'
    AND json_extract(NEW.`effect_payload_json`, '$.interactionId') = NEW.`interaction_id`
    AND json_type(NEW.`effect_payload_json`, '$.commandId') IS NULL
    AND NEW.`effect_deadline_at` IS NOT NULL)
  OR
  (NEW.`job_kind` = 'interaction_wakeup' AND NEW.`effect_type` IS NOT NULL
    AND NEW.`interaction_id` IS NOT NULL AND NEW.`command_id` IS NOT NULL
    AND NEW.`effect_schema_version` = 'stagepass.pipeline-effect/v1'
    AND json_valid(NEW.`effect_payload_json`) = 1
    AND json_extract(NEW.`effect_payload_json`, '$.schemaVersion') = 'stagepass.pipeline-effect/v1'
    AND json_extract(NEW.`effect_payload_json`, '$.kind') = 'interaction_wakeup'
    AND json_extract(NEW.`effect_payload_json`, '$.interactionId') = NEW.`interaction_id`
    AND json_extract(NEW.`effect_payload_json`, '$.commandId') = NEW.`command_id`
    AND NEW.`effect_deadline_at` IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'pipeline_job_effect_invalid');
END;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `codex_logical_turns` (
  `logical_turn_id` TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))),2) || '-' ||
    substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' ||
    lower(hex(randomblob(6)))
  ),
  `pipeline_job_id` TEXT REFERENCES `pipeline_jobs`(`id`),
  `project_ai_run_id` TEXT REFERENCES `project_ai_runs`(`id`),
  `binding_id` TEXT NOT NULL REFERENCES `codex_thread_bindings`(`binding_id`),
  `interaction_id` TEXT REFERENCES `codex_interactions`(`id`),
  `command_id` TEXT REFERENCES `pipeline_command_receipts`(`command_id`),
  `phase` TEXT NOT NULL,
  `role` TEXT NOT NULL CHECK (`role` IN ('stage','spec_writer','spec_critic','spec_verdict','build','fix','prd_turn','context_select','context_generate','interaction_present','interaction_wakeup')),
  `round` INTEGER NOT NULL,
  `ordinal` INTEGER NOT NULL,
  `turn_slot` TEXT NOT NULL,
  `run_correlation_id` TEXT NOT NULL,
  `canonical_request_json` TEXT NOT NULL,
  `canonical_request_hash` TEXT NOT NULL,
  `dispatch_surface` TEXT NOT NULL CHECK (`dispatch_surface` IN ('follower_ipc','host_ui_message')),
  `status` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL,
  CHECK ((`pipeline_job_id` IS NOT NULL) <> (`project_ai_run_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_codex_logical_turns_pipeline_slot`
  ON `codex_logical_turns` (`pipeline_job_id`,`phase`,`role`,`round`,`ordinal`)
  WHERE `pipeline_job_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_codex_logical_turns_project_slot`
  ON `codex_logical_turns` (`project_ai_run_id`,`phase`,`role`,`round`,`ordinal`)
  WHERE `project_ai_run_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_codex_logical_turns_turn_slot`
  ON `codex_logical_turns` (`turn_slot`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_codex_logical_turns_correlation`
  ON `codex_logical_turns` (`run_correlation_id`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `codex_follower_start_attempts` (
  `attempt_id` TEXT PRIMARY KEY NOT NULL,
  `logical_turn_id` TEXT NOT NULL REFERENCES `codex_logical_turns`(`logical_turn_id`),
  `run_correlation_id` TEXT NOT NULL,
  `pipeline_job_id` TEXT REFERENCES `pipeline_jobs`(`id`),
  `project_ai_run_id` TEXT REFERENCES `project_ai_runs`(`id`),
  `worker_id` TEXT NOT NULL,
  `lease_token` TEXT NOT NULL,
  `owner_attempt` INTEGER NOT NULL,
  `owner_epoch` INTEGER NOT NULL,
  `thread_id` TEXT NOT NULL,
  `purpose` TEXT NOT NULL,
  `dispatch_surface` TEXT NOT NULL CHECK (`dispatch_surface` IN ('follower_ipc','host_ui_message')),
  `normalized_prompt_hash` TEXT NOT NULL,
  `correlation_marker` TEXT NOT NULL,
  `cwd` TEXT NOT NULL,
  `model` TEXT,
  `reasoning_effort` TEXT,
  `sandbox_mode` TEXT NOT NULL,
  `approval_policy` TEXT NOT NULL,
  `pre_start_turn_ids_json` TEXT NOT NULL,
  `pre_start_semantic_hash` TEXT NOT NULL,
  `state` TEXT NOT NULL CHECK (`state` IN ('prepared','dispatching','no_client_found','ambiguous','succeeded','quarantined')),
  `dispatch_ordinal` INTEGER NOT NULL DEFAULT 0,
  `dispatch_count` INTEGER NOT NULL DEFAULT 0,
  `budget_deadline` TEXT NOT NULL,
  `follower_turn_id` TEXT,
  `recovery_owner_id` TEXT,
  `recovery_lease_token` TEXT,
  `recovery_epoch` INTEGER NOT NULL DEFAULT 0,
  `last_result` TEXT,
  `last_error_code` TEXT,
  `prepared_at` TEXT NOT NULL,
  `dispatched_at` TEXT,
  `completed_at` TEXT,
  CHECK ((`pipeline_job_id` IS NOT NULL) <> (`project_ai_run_id` IS NOT NULL)),
  UNIQUE (`logical_turn_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_codex_follower_attempt_turn`
  ON `codex_follower_start_attempts` (`follower_turn_id`) WHERE `follower_turn_id` IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `codex_binding_run_leases` (
  `binding_id` TEXT PRIMARY KEY NOT NULL REFERENCES `codex_thread_bindings`(`binding_id`),
  `logical_turn_id` TEXT NOT NULL,
  `attempt_id` TEXT,
  `worker_id` TEXT NOT NULL,
  `lease_token` TEXT NOT NULL,
  `owner_epoch` INTEGER NOT NULL,
  `lease_expires_at` TEXT NOT NULL,
  `deadline_at` TEXT NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `codex_turn_executions` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `start_attempt_id` TEXT NOT NULL REFERENCES `codex_follower_start_attempts`(`attempt_id`),
  `logical_turn_id` TEXT NOT NULL REFERENCES `codex_logical_turns`(`logical_turn_id`),
  `pipeline_job_id` TEXT REFERENCES `pipeline_jobs`(`id`),
  `project_ai_run_id` TEXT REFERENCES `project_ai_runs`(`id`),
  `thread_id` TEXT NOT NULL,
  `turn_id` TEXT NOT NULL,
  `dispatch_surface` TEXT NOT NULL CHECK (`dispatch_surface` IN ('follower_ipc','host_ui_message')),
  `lease_token` TEXT NOT NULL,
  `owner_attempt` INTEGER NOT NULL,
  `owner_epoch` INTEGER NOT NULL,
  `last_observation_cursor` INTEGER NOT NULL DEFAULT 0,
  `normalized_items_json` TEXT NOT NULL,
  `last_semantic_snapshot_hash` TEXT,
  `status` TEXT NOT NULL,
  `last_observed_at` TEXT,
  `terminal_semantic_hash` TEXT,
  `reconnect_count` INTEGER NOT NULL DEFAULT 0,
  `not_yet_visible_count` INTEGER NOT NULL DEFAULT 0,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL,
  CHECK ((`pipeline_job_id` IS NOT NULL) <> (`project_ai_run_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_codex_turn_executions_start_attempt`
  ON `codex_turn_executions` (`start_attempt_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_codex_turn_executions_logical_turn`
  ON `codex_turn_executions` (`logical_turn_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_codex_turn_executions_thread_turn`
  ON `codex_turn_executions` (`thread_id`, `turn_id`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `pipeline_command_outbox` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `command_id` TEXT NOT NULL REFERENCES `pipeline_command_receipts`(`command_id`),
  `interaction_id` TEXT REFERENCES `codex_interactions`(`id`),
  `effect_type` TEXT NOT NULL,
  `effect_payload_json` TEXT NOT NULL,
  `status` TEXT NOT NULL,
  `attempt_count` INTEGER NOT NULL DEFAULT 0,
  `last_error_code` TEXT,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL,
  `dispatched_at` TEXT,
  UNIQUE (`command_id`, `effect_type`)
);
