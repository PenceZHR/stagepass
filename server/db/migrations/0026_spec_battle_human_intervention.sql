ALTER TABLE `briefing_questions` ADD COLUMN `phase` text NOT NULL DEFAULT 'PRD';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_briefing_questions_change_phase`
  ON `briefing_questions` (`change_id`, `phase`, `round_no`);
--> statement-breakpoint
ALTER TABLE `requirement_gaps` ADD COLUMN `merge_override_reason` text;
