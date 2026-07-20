CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`run_id` text,
	`type` text NOT NULL,
	`path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `changes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`codex_thread_id` text,
	`fix_iterations` integer DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text,
	`run_id` text,
	`type` text NOT NULL,
	`message` text,
	`raw_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`run_id` text,
	`source` text NOT NULL,
	`severity` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`file` text,
	`line` integer,
	`evidence` text,
	`required_fix` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_path` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repo_path_unique` ON `projects` (`repo_path`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`phase` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	`summary` text,
	FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
