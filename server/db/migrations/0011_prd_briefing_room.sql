CREATE TABLE IF NOT EXISTS `prd_briefings` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `status` TEXT NOT NULL,
  `intent_text` TEXT NOT NULL DEFAULT '',
  `final_review_json` TEXT,
  `source_hashes_json` TEXT NOT NULL DEFAULT '{}',
  `locked_at` TEXT,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE IF NOT EXISTS `briefing_questions` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `category` TEXT NOT NULL,
  `severity` TEXT NOT NULL,
  `question` TEXT NOT NULL,
  `why_it_matters` TEXT NOT NULL,
  `suggested_default` TEXT,
  `status` TEXT NOT NULL,
  `answer` TEXT,
  `source` TEXT NOT NULL DEFAULT 'ai_blue',
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE IF NOT EXISTS `prd_drafts` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `change_id` TEXT NOT NULL,
  `version` INTEGER NOT NULL,
  `markdown` TEXT NOT NULL,
  `source_question_ids_json` TEXT NOT NULL,
  `unresolved_question_ids_json` TEXT NOT NULL,
  `draft_hash` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX IF NOT EXISTS `idx_prd_briefings_change` ON `prd_briefings` (`change_id`);
CREATE INDEX IF NOT EXISTS `idx_briefing_questions_change` ON `briefing_questions` (`change_id`);
CREATE INDEX IF NOT EXISTS `idx_briefing_questions_status` ON `briefing_questions` (`status`);
CREATE INDEX IF NOT EXISTS `idx_prd_drafts_change` ON `prd_drafts` (`change_id`);
