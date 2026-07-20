CREATE INDEX IF NOT EXISTS `idx_provider_run_processes_run_started_id`
  ON `provider_run_processes` (`run_id`, `started_at`, `id`);
