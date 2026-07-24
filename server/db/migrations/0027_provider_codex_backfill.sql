-- Converge historical provider values to codex before the AiProvider enum narrows.
-- Claude sessions are deleted (a Claude session id cannot be resumed by Codex);
-- all other rows are relabeled so strict read-path validation keeps accepting them.
DELETE FROM `change_provider_sessions` WHERE `provider` = 'claude';
--> statement-breakpoint
UPDATE `projects` SET `context_provider` = 'codex' WHERE `context_provider` = 'claude';
--> statement-breakpoint
UPDATE `projects` SET `prd_provider` = 'codex' WHERE `prd_provider` = 'claude';
--> statement-breakpoint
UPDATE `changes` SET `provider` = 'codex' WHERE `provider` = 'claude';
--> statement-breakpoint
UPDATE `runs` SET `provider` = 'codex' WHERE `provider` = 'claude';
--> statement-breakpoint
UPDATE `provider_run_processes` SET `provider` = 'codex' WHERE `provider` = 'claude';
--> statement-breakpoint
UPDATE `pipeline_jobs` SET `provider` = 'codex' WHERE `provider` = 'claude';
--> statement-breakpoint
UPDATE `review_attempts` SET `provider` = 'codex' WHERE `provider` = 'claude';
--> statement-breakpoint
UPDATE `stage_runs` SET `provider` = 'codex' WHERE `provider` = 'claude';
