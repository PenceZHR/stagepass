CREATE TABLE IF NOT EXISTS `rubrics` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`change_id` text,
	`phase` text NOT NULL,
	`role` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`is_current` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_rubrics_current_change` ON `rubrics` (`project_id`,`change_id`,`phase`,`role`) WHERE `is_current` = 1 AND `change_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_rubrics_current_project` ON `rubrics` (`project_id`,`phase`,`role`) WHERE `is_current` = 1 AND `change_id` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_rubrics_version_change` ON `rubrics` (`project_id`,`change_id`,`phase`,`role`,`version`) WHERE `change_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_rubrics_version_project` ON `rubrics` (`project_id`,`phase`,`role`,`version`) WHERE `change_id` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rubrics_scope_current` ON `rubrics` (`project_id`,`change_id`,`phase`,`role`,`is_current`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rubric_criteria` (
	`id` text PRIMARY KEY NOT NULL,
	`rubric_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`text` text NOT NULL,
	`blocking` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`rubric_id`) REFERENCES `rubrics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_rubric_criteria_rubric_ordinal` ON `rubric_criteria` (`rubric_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rubric_criteria_rubric` ON `rubric_criteria` (`rubric_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rubric_assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`run_id` text NOT NULL,
	`round_id` text,
	`rubric_id` text NOT NULL,
	`criterion_id` text NOT NULL,
	`verdict` text NOT NULL,
	`evidence` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rubric_id`) REFERENCES `rubrics`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`criterion_id`) REFERENCES `rubric_criteria`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_rubric_assessments_run_round_criterion` ON `rubric_assessments` (`run_id`,`round_id`,`criterion_id`) WHERE `round_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_rubric_assessments_run_criterion` ON `rubric_assessments` (`run_id`,`criterion_id`) WHERE `round_id` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rubric_assessments_change_rubric` ON `rubric_assessments` (`change_id`,`rubric_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rubric_assessments_run` ON `rubric_assessments` (`run_id`);
