ALTER TABLE `pipeline_jobs` ADD COLUMN `lease_token` text;
--> statement-breakpoint
ALTER TABLE `pipeline_jobs` ADD COLUMN `worker_nonce` text;
--> statement-breakpoint
ALTER TABLE `provider_run_processes` ADD COLUMN `job_id` text;
--> statement-breakpoint
ALTER TABLE `provider_run_processes` ADD COLUMN `worker_id` text;
--> statement-breakpoint
ALTER TABLE `provider_run_processes` ADD COLUMN `lease_token` text;
--> statement-breakpoint
ALTER TABLE `provider_run_processes` ADD COLUMN `attempt_no` integer;
--> statement-breakpoint
ALTER TABLE `provider_run_processes` ADD COLUMN `external_ref` text;
--> statement-breakpoint
ALTER TABLE `provider_run_processes` ADD COLUMN `process_nonce` text;
--> statement-breakpoint
ALTER TABLE `provider_run_processes` ADD COLUMN `process_start_time` text;
--> statement-breakpoint
ALTER TABLE `provider_run_processes` ADD COLUMN `process_ppid` integer;
--> statement-breakpoint
ALTER TABLE `provider_run_processes` ADD COLUMN `process_pgid` integer;
--> statement-breakpoint
ALTER TABLE `provider_run_processes` ADD COLUMN `process_cwd` text;
--> statement-breakpoint
ALTER TABLE `provider_run_processes` ADD COLUMN `process_command_json` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_pipeline_jobs_lease_fence`
  ON `pipeline_jobs` (`id`, `lease_token`, `attempt_no`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_provider_run_processes_job_lease_attempt`
  ON `provider_run_processes` (`job_id`, `lease_token`, `attempt_no`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_provider_run_processes_process_identity`
  ON `provider_run_processes` (`pid`, `process_start_time`, `process_nonce`);
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `job_id` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `worker_id` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `lease_token` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `attempt_no` integer;
