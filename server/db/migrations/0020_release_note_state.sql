CREATE TABLE IF NOT EXISTS `release_note_state` (
  `id` text PRIMARY KEY NOT NULL,
  `change_id` text NOT NULL,
  `run_id` text NOT NULL,
  `artifact_id` text NOT NULL,
  `approved_content_hash` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_release_note_state_change_run`
  ON `release_note_state` (`change_id`, `run_id`);
