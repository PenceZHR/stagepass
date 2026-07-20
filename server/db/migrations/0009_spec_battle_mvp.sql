CREATE TABLE `battle_rounds` (
  `id` text PRIMARY KEY NOT NULL,
  `change_id` text NOT NULL,
  `phase` text NOT NULL,
  `template` text NOT NULL,
  `round_no` integer NOT NULL,
  `status` text NOT NULL,
  `red_unit` text NOT NULL,
  `blue_unit` text NOT NULL,
  `input_snapshot_json` text NOT NULL,
  `params_json` text NOT NULL,
  `red_artifact_path` text,
  `red_artifact_hash` text,
  `blue_artifact_path` text,
  `blue_artifact_hash` text,
  `report_path` text,
  `superseded_by_round_id` text,
  `started_at` text NOT NULL,
  `ended_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `requirement_gaps` (
  `id` text PRIMARY KEY NOT NULL,
  `change_id` text NOT NULL,
  `canonical_gap_id` text NOT NULL,
  `first_seen_round_id` text NOT NULL,
  `last_evaluated_round_id` text NOT NULL,
  `resolved_by_round_id` text,
  `source_phase` text NOT NULL,
  `source_unit` text NOT NULL,
  `title` text NOT NULL,
  `category` text NOT NULL,
  `evidence` text NOT NULL,
  `affected_artifacts_json` text NOT NULL,
  `proposed_spec_patch` text,
  `severity` text NOT NULL,
  `original_severity` text NOT NULL,
  `downgraded_to` text,
  `status` text NOT NULL,
  `resolution_evidence` text,
  `waiver_reason` text,
  `downgrade_reason` text,
  `override_reason` text,
  `spec_blocking` integer NOT NULL DEFAULT 0,
  `merge_blocking` integer NOT NULL DEFAULT 0,
  `source_hashes_json` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `closed_at` text,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `human_decisions` (
  `id` text PRIMARY KEY NOT NULL,
  `change_id` text NOT NULL,
  `round_id` text,
  `gate` text NOT NULL,
  `action` text NOT NULL,
  `target_type` text,
  `target_id` text,
  `reason` text,
  `report_hash` text,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `war_reports` (
  `id` text PRIMARY KEY NOT NULL,
  `change_id` text NOT NULL,
  `round_id` text,
  `phase` text NOT NULL,
  `type` text NOT NULL,
  `status` text NOT NULL,
  `path` text NOT NULL,
  `source_hashes_json` text NOT NULL,
  `report_hash` text NOT NULL,
  `blocking_p0` integer NOT NULL DEFAULT 0,
  `blocking_p1` integer NOT NULL DEFAULT 0,
  `non_blocking_p2` integer NOT NULL DEFAULT 0,
  `overridden_p0` integer NOT NULL DEFAULT 0,
  `open_requirement_gaps` integer NOT NULL DEFAULT 0,
  `generated_by` text NOT NULL,
  `ai_polished` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE findings ADD COLUMN round_id TEXT;
--> statement-breakpoint
ALTER TABLE findings ADD COLUMN phase TEXT;
--> statement-breakpoint
ALTER TABLE findings ADD COLUMN updated_at TEXT;
--> statement-breakpoint
UPDATE findings SET updated_at = created_at WHERE updated_at IS NULL;
