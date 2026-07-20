CREATE TABLE `red_fix_claims` (
  `id` text PRIMARY KEY NOT NULL,
  `change_id` text NOT NULL,
  `round_id` text NOT NULL,
  `gap_id` text,
  `canonical_gap_id` text NOT NULL,
  `claim_status` text NOT NULL,
  `claim_summary` text NOT NULL,
  `evidence` text NOT NULL,
  `artifact_path` text,
  `source_hashes_json` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`round_id`) REFERENCES `battle_rounds`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`gap_id`) REFERENCES `requirement_gaps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `blue_gap_reviews` (
  `id` text PRIMARY KEY NOT NULL,
  `change_id` text NOT NULL,
  `round_id` text NOT NULL,
  `gap_id` text,
  `canonical_gap_id` text NOT NULL,
  `verdict` text NOT NULL,
  `review_summary` text NOT NULL,
  `evidence` text NOT NULL,
  `resolution_evidence` text,
  `downgraded_to` text,
  `source_hashes_json` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`change_id`) REFERENCES `changes`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`round_id`) REFERENCES `battle_rounds`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`gap_id`) REFERENCES `requirement_gaps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_red_fix_claims_change_round` ON `red_fix_claims` (`change_id`, `round_id`);
--> statement-breakpoint
CREATE INDEX `idx_red_fix_claims_gap` ON `red_fix_claims` (`change_id`, `canonical_gap_id`);
--> statement-breakpoint
CREATE INDEX `idx_blue_gap_reviews_change_round` ON `blue_gap_reviews` (`change_id`, `round_id`);
--> statement-breakpoint
CREATE INDEX `idx_blue_gap_reviews_gap` ON `blue_gap_reviews` (`change_id`, `canonical_gap_id`);
