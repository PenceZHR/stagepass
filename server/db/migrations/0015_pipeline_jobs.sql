CREATE TABLE IF NOT EXISTS `pipeline_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `change_id` text NOT NULL,
  `phase` text NOT NULL,
  `action_id` text NOT NULL,
  `idempotency_key` text,
  `status` text NOT NULL,
  `leased_by` text,
  `lease_expires_at` text,
  `heartbeat_at` text,
  `attempt_no` integer NOT NULL DEFAULT 1,
  `error_code` text,
  `error_summary` text,
  `created_at` text NOT NULL,
  `started_at` text,
  `ended_at` text,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_pipeline_jobs_change_action_idempotency`
  ON `pipeline_jobs` (`change_id`, `action_id`, `idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_pipeline_jobs_status_lease`
  ON `pipeline_jobs` (`status`, `lease_expires_at`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_pipeline_jobs_change_created`
  ON `pipeline_jobs` (`change_id`, `created_at`);
