ALTER TABLE `briefing_questions` ADD COLUMN `round_no` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
UPDATE `briefing_questions` SET `round_no` = 1 WHERE `round_no` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_briefing_questions_change_round`
  ON `briefing_questions` (`change_id`, `round_no`);
