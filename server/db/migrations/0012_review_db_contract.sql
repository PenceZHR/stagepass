CREATE TABLE IF NOT EXISTS `build_run_records` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `run_id` TEXT,
  `build_run_id` TEXT,
  `status` TEXT NOT NULL,
  `head_sha` TEXT,
  `adopted_at` TEXT,
  `artifact_hash` TEXT,
  `source` TEXT NOT NULL DEFAULT 'unknown',
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `review_attempts` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `run_id` TEXT,
  `attempt_no` INTEGER NOT NULL,
  `status` TEXT NOT NULL,
  `provider` TEXT NOT NULL DEFAULT 'codex',
  `review_status` TEXT NOT NULL DEFAULT 'running',
  `idempotency_key` TEXT NOT NULL,
  `source_build_run_id` TEXT,
  `source_head_sha` TEXT,
  `input_source_db_hash` TEXT,
  `input_source_lineage_json` TEXT,
  `prior_blocking_finding_ids_json` TEXT,
  `raw_output_artifact_id` TEXT,
  `error_code` TEXT,
  `sanitized_error_summary` TEXT,
  `started_at` TEXT NOT NULL,
  `ended_at` TEXT,
  `completed_at` TEXT,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`raw_output_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `review_reports` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `attempt_id` TEXT NOT NULL,
  `change_id` TEXT NOT NULL,
  `report_version` INTEGER NOT NULL,
  `review_conclusion` TEXT,
  `report_db_hash` TEXT NOT NULL,
  `gate_status` TEXT NOT NULL,
  `qa_allowed` INTEGER NOT NULL DEFAULT 0,
  `source_build_run_id` TEXT,
  `source_head_sha` TEXT,
  `finding_version` INTEGER NOT NULL DEFAULT 1,
  `waiver_version` INTEGER NOT NULL DEFAULT 1,
  `blocking_p0` INTEGER NOT NULL DEFAULT 0,
  `blocking_p1` INTEGER NOT NULL DEFAULT 0,
  `waived_p1` INTEGER NOT NULL DEFAULT 0,
  `p2_count` INTEGER NOT NULL DEFAULT 0,
  `findings_db_hash` TEXT,
  `stale_reason` TEXT,
  `legacy_state` TEXT,
  `report_json` TEXT,
  `generated_at` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`attempt_id`) REFERENCES `review_attempts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `review_state` (
  `change_id` TEXT PRIMARY KEY NOT NULL,
  `latest_attempt_id` TEXT,
  `latest_attempt_no` INTEGER,
  `latest_report_id` TEXT,
  `latest_valid_review_report_id` TEXT,
  `latest_valid_attempt_no` INTEGER,
  `gate_status` TEXT,
  `review_status` TEXT,
  `source_build_run_id` TEXT,
  `source_head_sha` TEXT,
  `report_db_hash` TEXT,
  `finding_version` INTEGER NOT NULL DEFAULT 1,
  `waiver_version` INTEGER NOT NULL DEFAULT 1,
  `updated_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`latest_attempt_id`) REFERENCES `review_attempts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`latest_report_id`) REFERENCES `review_reports`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`latest_valid_review_report_id`) REFERENCES `review_reports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `review_artifact_mirrors` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `report_id` TEXT NOT NULL,
  `change_id` TEXT NOT NULL,
  `artifact_id` TEXT,
  `kind` TEXT NOT NULL,
  `path` TEXT,
  `schema_version` TEXT,
  `source_db_hash` TEXT,
  `content_hash` TEXT,
  `mirror_status` TEXT,
  `last_checked_at` TEXT,
  `last_rebuilt_at` TEXT,
  `error_code` TEXT,
  `artifact_path` TEXT,
  `artifact_hash` TEXT,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`report_id`) REFERENCES `review_reports`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `review_prior_finding_reviews` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `attempt_id` TEXT NOT NULL,
  `prior_finding_id` TEXT NOT NULL,
  `verdict` TEXT NOT NULL,
  `evidence` TEXT,
  `required_fix` TEXT,
  `replacement_finding_id` TEXT,
  `reviewer_notes` TEXT,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`attempt_id`) REFERENCES `review_attempts`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`prior_finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`replacement_finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `findings` ADD COLUMN `review_attempt_id` TEXT REFERENCES `review_attempts`(`id`) CHECK (`review_attempt_id` IS NULL OR `source` = 'review');
--> statement-breakpoint
ALTER TABLE `findings` ADD COLUMN `source_build_run_id` TEXT;
--> statement-breakpoint
ALTER TABLE `findings` ADD COLUMN `source_head_sha` TEXT;
--> statement-breakpoint
ALTER TABLE `findings` ADD COLUMN `waivable` INTEGER NOT NULL DEFAULT 0 CHECK (`waivable` IN (0, 1) AND (`waivable` = 0 OR (`source` = 'review' AND `severity` = 'P1')));
--> statement-breakpoint
ALTER TABLE `findings` ADD COLUMN `waived_by` TEXT;
--> statement-breakpoint
ALTER TABLE `findings` ADD COLUMN `waived_at` TEXT;
--> statement-breakpoint
ALTER TABLE `findings` ADD COLUMN `waiver_decision_id` TEXT REFERENCES `human_decisions`(`id`);
--> statement-breakpoint
ALTER TABLE `findings` ADD COLUMN `legacy_state` TEXT;
--> statement-breakpoint
ALTER TABLE `findings` ADD COLUMN `legacy_finding_key` TEXT;
--> statement-breakpoint
ALTER TABLE `findings` ADD COLUMN `finding_version` INTEGER NOT NULL DEFAULT 1 CHECK (`source` != 'review' OR `review_attempt_id` IS NULL OR `severity` NOT IN ('P0', 'P1') OR (`evidence` IS NOT NULL AND length(trim(`evidence`)) > 0 AND `required_fix` IS NOT NULL AND length(trim(`required_fix`)) > 0));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_review_attempts_change_attempt_no` ON `review_attempts` (`change_id`, `attempt_no`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_review_attempts_change_idempotency_key` ON `review_attempts` (`change_id`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_review_attempts_change_status` ON `review_attempts` (`change_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_review_attempts_one_running_per_change` ON `review_attempts` (`change_id`) WHERE `status` = 'running';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_review_reports_attempt_version` ON `review_reports` (`attempt_id`, `report_version`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_review_reports_attempt_db_hash` ON `review_reports` (`attempt_id`, `report_db_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_review_reports_change_gate_generated` ON `review_reports` (`change_id`, `gate_status`, `generated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_review_prior_finding_reviews_attempt_prior` ON `review_prior_finding_reviews` (`attempt_id`, `prior_finding_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_review_artifact_mirrors_report_kind` ON `review_artifact_mirrors` (`report_id`, `kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_build_run_records_change_status_adopted` ON `build_run_records` (`change_id`, `status`, `adopted_at`);
