ALTER TABLE `pipeline_jobs` ADD COLUMN `provider` TEXT NOT NULL DEFAULT 'codex';
--> statement-breakpoint
UPDATE `pipeline_jobs`
SET `provider` = COALESCE((SELECT `provider` FROM `changes` WHERE `changes`.`id` = `pipeline_jobs`.`change_id`), 'codex');
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `provider` TEXT;
--> statement-breakpoint
UPDATE `runs`
SET `provider` = (SELECT `provider` FROM `changes` WHERE `changes`.`id` = `runs`.`change_id`)
WHERE `provider` IS NULL;
--> statement-breakpoint
ALTER TABLE `stage_runs` ADD COLUMN `provider` TEXT;
--> statement-breakpoint
UPDATE `stage_runs`
SET `provider` = (SELECT `provider` FROM `changes` WHERE `changes`.`id` = `stage_runs`.`change_id`)
WHERE `provider` IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `change_provider_sessions` (
  `change_id` TEXT NOT NULL,
  `provider` TEXT NOT NULL,
  `session_kind` TEXT NOT NULL,
  `external_session_id` TEXT NOT NULL,
  `last_run_id` TEXT,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL,
  PRIMARY KEY (`change_id`, `provider`, `session_kind`),
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`last_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_change_provider_sessions_change_provider`
  ON `change_provider_sessions` (`change_id`, `provider`);
