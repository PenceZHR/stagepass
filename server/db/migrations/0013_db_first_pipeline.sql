ALTER TABLE `build_run_records` ADD COLUMN `base_head_sha` TEXT;
--> statement-breakpoint
ALTER TABLE `build_run_records` ADD COLUMN `base_commit` TEXT;
--> statement-breakpoint
ALTER TABLE `build_run_records` ADD COLUMN `patch_hash` TEXT;
--> statement-breakpoint
ALTER TABLE `build_run_records` ADD COLUMN `changed_files_hash` TEXT;
--> statement-breakpoint
ALTER TABLE `build_run_records` ADD COLUMN `adopted_head_sha` TEXT;
--> statement-breakpoint
ALTER TABLE `build_run_records` ADD COLUMN `adoption_decision_id` TEXT;
--> statement-breakpoint
ALTER TABLE `review_attempts` ADD COLUMN `input_source_db_hash` TEXT;
--> statement-breakpoint
ALTER TABLE `review_attempts` ADD COLUMN `input_source_lineage_json` TEXT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `stage_states` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `phase` TEXT NOT NULL,
  `status` TEXT NOT NULL,
  `latest_run_id` TEXT,
  `latest_report_id` TEXT,
  `latest_gate_id` TEXT,
  `latest_valid_report_id` TEXT,
  `db_hash` TEXT,
  `version` INTEGER NOT NULL DEFAULT 1,
  `updated_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `stage_runs` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `phase` TEXT NOT NULL,
  `attempt_no` INTEGER NOT NULL,
  `status` TEXT NOT NULL,
  `idempotency_key` TEXT,
  `input_db_hash` TEXT,
  `output_db_hash` TEXT,
  `source_lineage_json` TEXT,
  `error_code` TEXT,
  `started_at` TEXT NOT NULL,
  `completed_at` TEXT,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `stage_reports` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `phase` TEXT NOT NULL,
  `source_run_id` TEXT,
  `status` TEXT NOT NULL,
  `counts_json` TEXT,
  `is_fresh` INTEGER NOT NULL DEFAULT 1,
  `stale_reason` TEXT,
  `report_db_hash` TEXT,
  `generated_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`source_run_id`) REFERENCES `stage_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `stage_gates` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `phase` TEXT NOT NULL,
  `status` TEXT NOT NULL,
  `blockers_json` TEXT,
  `freshness_json` TEXT,
  `required_actions_json` TEXT,
  `source_db_hash` TEXT,
  `gate_version` INTEGER NOT NULL DEFAULT 1,
  `computed_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `stage_actions` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `phase` TEXT NOT NULL,
  `action_id` TEXT NOT NULL,
  `enabled` INTEGER NOT NULL DEFAULT 0,
  `reason_code` TEXT,
  `reason` TEXT,
  `blockers_json` TEXT,
  `gate_version` INTEGER NOT NULL DEFAULT 1,
  `source_db_hash` TEXT,
  `requires_idempotency_key` INTEGER NOT NULL DEFAULT 0,
  `computed_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `artifact_mirrors` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `phase` TEXT NOT NULL,
  `artifact_type` TEXT NOT NULL,
  `path` TEXT NOT NULL,
  `content_hash` TEXT,
  `source_db_hash` TEXT,
  `schema_version` TEXT,
  `mirror_status` TEXT NOT NULL,
  `generated_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `legacy_imports` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `phase` TEXT NOT NULL,
  `source_path` TEXT NOT NULL,
  `source_artifact_hash` TEXT,
  `schema_version` TEXT,
  `import_status` TEXT NOT NULL,
  `import_result_json` TEXT,
  `imported_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `plan_snapshots` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `status` TEXT NOT NULL,
  `plan_name` TEXT,
  `source_spec_hash` TEXT,
  `expected_files_json` TEXT,
  `forbidden_files_json` TEXT,
  `validation_policy_hash` TEXT,
  `approved_at` TEXT,
  `approval_decision_id` TEXT,
  `snapshot_db_hash` TEXT,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`approval_decision_id`) REFERENCES `human_decisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `plan_steps` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `plan_snapshot_id` TEXT NOT NULL,
  `step_no` INTEGER NOT NULL,
  `title` TEXT,
  `description` TEXT,
  `expected_files_json` TEXT,
  `status` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`plan_snapshot_id`) REFERENCES `plan_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `plan_risks` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `plan_snapshot_id` TEXT NOT NULL,
  `severity` TEXT NOT NULL,
  `category` TEXT,
  `title` TEXT,
  `evidence` TEXT,
  `required_plan_change` TEXT,
  `status` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`plan_snapshot_id`) REFERENCES `plan_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `plan_approvals` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `plan_snapshot_id` TEXT NOT NULL,
  `decision_id` TEXT NOT NULL,
  `actor` TEXT NOT NULL,
  `approved_at` TEXT NOT NULL,
  FOREIGN KEY (`plan_snapshot_id`) REFERENCES `plan_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`decision_id`) REFERENCES `human_decisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `techspec_snapshots` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `status` TEXT NOT NULL,
  `source_spec_hash` TEXT,
  `content_json` TEXT,
  `content_db_hash` TEXT,
  `schema_version` TEXT NOT NULL,
  `reviewed_at` TEXT,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_snapshots` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `status` TEXT NOT NULL,
  `source_techspec_hash` TEXT,
  `contract_json` TEXT,
  `contract_db_hash` TEXT,
  `schema_version` TEXT NOT NULL,
  `reviewed_at` TEXT,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `required_validation_commands` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `phase` TEXT NOT NULL,
  `source_snapshot_id` TEXT,
  `command` TEXT NOT NULL,
  `command_order` INTEGER NOT NULL,
  `required` INTEGER NOT NULL DEFAULT 1,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `testplan_snapshots` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `status` TEXT NOT NULL,
  `test_intent` TEXT NOT NULL,
  `schema_version` TEXT NOT NULL,
  `approval_state` TEXT NOT NULL DEFAULT 'pending',
  `approved_at` TEXT,
  `approval_decision_id` TEXT,
  `snapshot_db_hash` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`approval_decision_id`) REFERENCES `human_decisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `testplan_coverage_items` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `testplan_snapshot_id` TEXT NOT NULL,
  `item_key` TEXT NOT NULL,
  `title` TEXT NOT NULL,
  `requirement_ref` TEXT,
  `test_type` TEXT NOT NULL,
  `priority` TEXT NOT NULL,
  `status` TEXT NOT NULL DEFAULT 'planned',
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`testplan_snapshot_id`) REFERENCES `testplan_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `testplan_risk_mappings` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `testplan_snapshot_id` TEXT NOT NULL,
  `coverage_item_key` TEXT NOT NULL,
  `risk_ref` TEXT NOT NULL,
  `severity` TEXT NOT NULL,
  `mitigation` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`testplan_snapshot_id`) REFERENCES `testplan_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `testplan_manual_checks` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `testplan_snapshot_id` TEXT NOT NULL,
  `title` TEXT NOT NULL,
  `description` TEXT,
  `required` INTEGER NOT NULL DEFAULT 1,
  `status` TEXT NOT NULL DEFAULT 'pending',
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`testplan_snapshot_id`) REFERENCES `testplan_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `qa_runs` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `source_review_report_id` TEXT,
  `source_build_run_id` TEXT,
  `source_head_sha` TEXT,
  `status` TEXT NOT NULL,
  `started_at` TEXT NOT NULL,
  `completed_at` TEXT,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`source_review_report_id`) REFERENCES `review_reports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `qa_command_results` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `qa_run_id` TEXT NOT NULL,
  `command` TEXT NOT NULL,
  `command_order` INTEGER NOT NULL,
  `status` TEXT NOT NULL,
  `exit_code` INTEGER,
  `duration_ms` INTEGER,
  `output_artifact_mirror_id` TEXT,
  `completed_at` TEXT,
  FOREIGN KEY (`qa_run_id`) REFERENCES `qa_runs`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`output_artifact_mirror_id`) REFERENCES `artifact_mirrors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `qa_failures` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `qa_run_id` TEXT NOT NULL,
  `command_result_id` TEXT,
  `severity` TEXT NOT NULL,
  `title` TEXT,
  `evidence` TEXT,
  `required_fix` TEXT,
  `status` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`qa_run_id`) REFERENCES `qa_runs`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`command_result_id`) REFERENCES `qa_command_results`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `qa_evidence` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `qa_run_id` TEXT NOT NULL,
  `evidence_type` TEXT NOT NULL,
  `artifact_mirror_id` TEXT,
  `content_hash` TEXT,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`qa_run_id`) REFERENCES `qa_runs`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`artifact_mirror_id`) REFERENCES `artifact_mirrors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `merge_readiness` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `status` TEXT NOT NULL,
  `source_db_hash` TEXT,
  `source_head_sha` TEXT,
  `blockers_json` TEXT,
  `computed_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `merge_blockers` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `merge_readiness_id` TEXT NOT NULL,
  `blocker_type` TEXT NOT NULL,
  `severity` TEXT NOT NULL,
  `title` TEXT,
  `source_table` TEXT,
  `source_id` TEXT,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`merge_readiness_id`) REFERENCES `merge_readiness`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `merge_approvals` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `decision_id` TEXT NOT NULL,
  `actor` TEXT NOT NULL,
  `approved_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`decision_id`) REFERENCES `human_decisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `merge_decisions` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `readiness_id` TEXT,
  `decision_type` TEXT NOT NULL,
  `actor` TEXT NOT NULL,
  `reason` TEXT,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`readiness_id`) REFERENCES `merge_readiness`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_stage_states_change_phase` ON `stage_states` (`change_id`, `phase`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_stage_runs_change_phase_attempt` ON `stage_runs` (`change_id`, `phase`, `attempt_no`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_stage_reports_change_phase_generated` ON `stage_reports` (`change_id`, `phase`, `generated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_stage_gates_change_phase_computed` ON `stage_gates` (`change_id`, `phase`, `computed_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_stage_actions_change_phase_action` ON `stage_actions` (`change_id`, `phase`, `action_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_artifact_mirrors_change_phase_status` ON `artifact_mirrors` (`change_id`, `phase`, `mirror_status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_legacy_imports_change_phase_status` ON `legacy_imports` (`change_id`, `phase`, `import_status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_plan_snapshots_change_status_created` ON `plan_snapshots` (`change_id`, `status`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_plan_steps_snapshot_step` ON `plan_steps` (`plan_snapshot_id`, `step_no`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_required_validation_commands_change_phase_order` ON `required_validation_commands` (`change_id`, `phase`, `command_order`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_testplan_snapshots_change_status_created` ON `testplan_snapshots` (`change_id`, `status`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_testplan_coverage_snapshot_key` ON `testplan_coverage_items` (`testplan_snapshot_id`, `item_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_testplan_risk_mappings_snapshot_coverage` ON `testplan_risk_mappings` (`testplan_snapshot_id`, `coverage_item_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_testplan_manual_checks_snapshot_required` ON `testplan_manual_checks` (`testplan_snapshot_id`, `required`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_techspec_snapshots_change_status_created` ON `techspec_snapshots` (`change_id`, `status`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_api_snapshots_change_status_created` ON `api_snapshots` (`change_id`, `status`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_qa_runs_change_status_started` ON `qa_runs` (`change_id`, `status`, `started_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_qa_command_results_run_order` ON `qa_command_results` (`qa_run_id`, `command_order`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_merge_readiness_change_computed` ON `merge_readiness` (`change_id`, `computed_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_build_run_records_change_status_adopted` ON `build_run_records` (`change_id`, `status`, `adopted_at`);
