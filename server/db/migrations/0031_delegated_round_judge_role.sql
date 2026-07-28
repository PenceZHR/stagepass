-- The delegated round's judge, for every phase that runs one.
--
-- 0030 added `spec_judge` when the delegated form existed only for Spec. It now
-- runs for TechSpec, Plan and TestPlan too, and a role literally named for one
-- phase would be read as "this round was a Spec round" by anyone querying the
-- table. `spec_judge` stays valid rather than being renamed: a row already
-- carries it, and rewriting history to tidy a name is how a post-mortem starts
-- disagreeing with the events it is reconstructing.
--
-- Same rebuild procedure and same ordering rationale as 0029/0030.

PRAGMA foreign_keys=OFF;
--> statement-breakpoint
-- Restartable: a run that failed after creating the replacement must not leave
-- it behind to be filled twice.
DROP TABLE IF EXISTS `__0031_codex_logical_turns_new`;
--> statement-breakpoint
CREATE TABLE `__0031_codex_logical_turns_new` (
  `logical_turn_id` TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))),2) || '-' ||
    substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' ||
    lower(hex(randomblob(6)))
  ),
  `pipeline_job_id` TEXT REFERENCES `pipeline_jobs`(`id`),
  `project_ai_run_id` TEXT REFERENCES `project_ai_runs`(`id`),
  `binding_id` TEXT NOT NULL REFERENCES `codex_thread_bindings`(`binding_id`),
  `interaction_id` TEXT REFERENCES `codex_interactions`(`id`),
  `command_id` TEXT REFERENCES `pipeline_command_receipts`(`command_id`),
  `phase` TEXT NOT NULL,
  `role` TEXT NOT NULL CHECK (`role` IN ('stage','spec_writer','spec_critic','spec_verdict','spec_judge','delegated_round_judge','build','fix','prd_turn','context_select','context_generate','interaction_present','interaction_wakeup')),
  `round` INTEGER NOT NULL,
  `ordinal` INTEGER NOT NULL,
  `turn_slot` TEXT NOT NULL,
  `run_correlation_id` TEXT NOT NULL,
  `canonical_request_json` TEXT NOT NULL,
  `canonical_request_hash` TEXT NOT NULL,
  `dispatch_surface` TEXT NOT NULL CHECK (`dispatch_surface` IN ('follower_ipc','host_ui_message')),
  `status` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL,
  CHECK ((`pipeline_job_id` IS NOT NULL) <> (`project_ai_run_id` IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__0031_codex_logical_turns_new` (
  `logical_turn_id`, `pipeline_job_id`, `project_ai_run_id`, `binding_id`,
  `interaction_id`, `command_id`, `phase`, `role`, `round`, `ordinal`,
  `turn_slot`, `run_correlation_id`, `canonical_request_json`,
  `canonical_request_hash`, `dispatch_surface`, `status`, `created_at`, `updated_at`
)
SELECT
  `logical_turn_id`, `pipeline_job_id`, `project_ai_run_id`, `binding_id`,
  `interaction_id`, `command_id`, `phase`, `role`, `round`, `ordinal`,
  `turn_slot`, `run_correlation_id`, `canonical_request_json`,
  `canonical_request_hash`, `dispatch_surface`, `status`, `created_at`, `updated_at`
FROM `codex_logical_turns`;
--> statement-breakpoint
DROP TABLE `codex_logical_turns`;
--> statement-breakpoint
ALTER TABLE `__0031_codex_logical_turns_new` RENAME TO `codex_logical_turns`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_codex_logical_turns_pipeline_slot`
  ON `codex_logical_turns` (`pipeline_job_id`,`phase`,`role`,`round`,`ordinal`)
  WHERE `pipeline_job_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_codex_logical_turns_project_slot`
  ON `codex_logical_turns` (`project_ai_run_id`,`phase`,`role`,`round`,`ordinal`)
  WHERE `project_ai_run_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_codex_logical_turns_turn_slot`
  ON `codex_logical_turns` (`turn_slot`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_codex_logical_turns_correlation`
  ON `codex_logical_turns` (`run_correlation_id`);
