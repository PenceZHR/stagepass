-- Per-stage Codex tasks.
--
-- A binding used to be scoped to the whole change, so all twelve stages shared
-- one Codex task: a stage could not tell whether it had its own task yet, and
-- one stage's conversation carried into the next. Adding `change_stage` gives
-- each stage its own task, keyed by `<changeId>:<stageId>`.
--
-- SQLite cannot widen a CHECK in place, so the table is rebuilt. The order
-- matters: renaming the live table first would rewrite every foreign key that
-- points at it to the temporary name, and dropping that name then leaves
-- `codex_interactions` and `codex_logical_turns` referencing a table that does
-- not exist. Building the replacement under its own name and renaming it into
-- place last leaves those references reading `codex_thread_bindings`
-- throughout, which is true again the moment the rename lands.
--
-- The old `change` scope stays valid: bindings created before this migration
-- keep working while their change finishes.

-- Rebuilding a referenced table requires foreign keys off, the same procedure
-- 0024 follows. The runner restores the caller's original setting afterwards.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
-- Restartable: a run that failed after creating the replacement must not leave
-- it behind to be filled twice.
DROP TABLE IF EXISTS `__0029_codex_thread_bindings_new`;
--> statement-breakpoint
CREATE TABLE `__0029_codex_thread_bindings_new` (
  `binding_id` TEXT PRIMARY KEY NOT NULL,
  `scope_kind` TEXT NOT NULL CHECK (`scope_kind` IN ('change','change_stage','project_prd','project_context')),
  `scope_id` TEXT NOT NULL,
  `project_id` TEXT NOT NULL REFERENCES `projects`(`id`),
  `change_id` TEXT REFERENCES `changes`(`id`),
  `codex_project_id` TEXT,
  `thread_id` TEXT,
  `title` TEXT NOT NULL,
  `status` TEXT NOT NULL CHECK (`status` IN ('provisioning','ready','running','waiting_human','failed','detached')),
  `bridge_protocol_version` TEXT NOT NULL,
  `provision_claim_token` TEXT,
  `provision_lease_owner` TEXT,
  `provision_lease_expires_at` TEXT,
  `follower_start_proved_at` TEXT,
  `last_turn_id` TEXT,
  `last_observation_cursor` INTEGER NOT NULL DEFAULT 0,
  `last_semantic_snapshot_hash` TEXT,
  `last_seen_at` TEXT NOT NULL,
  `last_error_code` TEXT,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL,
  CHECK (
    (`scope_kind` = 'change' AND `change_id` IS NOT NULL AND `scope_id` = `change_id`)
    OR
    (`scope_kind` = 'change_stage' AND `change_id` IS NOT NULL
      AND `scope_id` LIKE `change_id` || ':%')
    OR
    (`scope_kind` IN ('project_prd','project_context') AND `change_id` IS NULL AND `scope_id` = `project_id`)
  ),
  CHECK (`thread_id` IS NOT NULL OR `status` = 'provisioning')
);
--> statement-breakpoint
INSERT INTO `__0029_codex_thread_bindings_new`
  SELECT * FROM `codex_thread_bindings`;
--> statement-breakpoint
DROP TABLE `codex_thread_bindings`;
--> statement-breakpoint
ALTER TABLE `__0029_codex_thread_bindings_new` RENAME TO `codex_thread_bindings`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_codex_thread_bindings_scope`
  ON `codex_thread_bindings` (`scope_kind`, `scope_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_codex_thread_bindings_thread`
  ON `codex_thread_bindings` (`thread_id`) WHERE `thread_id` IS NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
