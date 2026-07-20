CREATE TABLE IF NOT EXISTS `provider_run_processes` (
  `id` text PRIMARY KEY NOT NULL,
  `change_id` text NOT NULL,
  `run_id` text NOT NULL,
  `phase` text NOT NULL,
  `provider` text NOT NULL,
  `pid` integer,
  `ppid` integer NOT NULL,
  `round_id` text,
  `status` text NOT NULL,
  `started_at` text NOT NULL,
  `last_heartbeat_at` text,
  `ended_at` text,
  `exit_code` integer,
  `signal` text,
  `summary` text,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_provider_run_processes_status_pid`
  ON `provider_run_processes` (`status`, `pid`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_provider_run_processes_change_run`
  ON `provider_run_processes` (`change_id`, `run_id`);
