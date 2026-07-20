UPDATE `pipeline_jobs`
SET `status` = 'canceled',
    `ended_at` = COALESCE(`ended_at`, CURRENT_TIMESTAMP),
    `error_code` = COALESCE(`error_code`, 'superseded_active_job'),
    `error_summary` = COALESCE(`error_summary`, 'Canceled while enforcing one active job per change phase')
WHERE `status` IN ('queued', 'leased', 'running')
  AND EXISTS (
    SELECT 1
    FROM `pipeline_jobs` AS newer
    WHERE newer.`change_id` = `pipeline_jobs`.`change_id`
      AND newer.`phase` = `pipeline_jobs`.`phase`
      AND newer.`status` IN ('queued', 'leased', 'running')
      AND (newer.`created_at` > `pipeline_jobs`.`created_at`
        OR (newer.`created_at` = `pipeline_jobs`.`created_at` AND newer.`id` > `pipeline_jobs`.`id`))
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_pipeline_jobs_one_active_change_phase`
  ON `pipeline_jobs` (`change_id`, `phase`)
  WHERE `status` IN ('queued', 'leased', 'running');
