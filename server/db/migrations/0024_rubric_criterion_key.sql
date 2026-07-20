-- Gives every rubric criterion an identity that survives editing (§5.1).
--
-- Before this migration a criterion's only identity was `rubric_criteria.id`,
-- which saveRubricVersion regenerates on EVERY save because an edit appends a
-- whole new version. Batch 5 derives a requirement gap from a blocking `no`;
-- if that gap's id came from the row id, one rubric edit would orphan every
-- open rubric-derived gap -- blue cannot recheck a gap it never reported, a
-- human is forbidden from resolving one (human_cannot_resolve_gap), and only P1
-- can be waived. An orphaned P0 would jam the Spec gate with no exit at all.
--
-- `criterion_key` is that stable identity. It is minted once and carried
-- forward by saveRubricVersion whenever the editor round-trips it or the text
-- is unchanged, so rewording a criterion no longer severs it from its history.
--
-- The column is added by rebuilding the table rather than by ALTER TABLE ADD
-- COLUMN, because SQLite can only add a NOT NULL column with a DEFAULT, and a
-- defaulted key is exactly the fail-open this column exists to prevent: a row
-- that silently inherits '' would collide with every other defaulted row, and
-- batch 5 would derive one gap id for all of them. NOT NULL with no default
-- means a caller that forgets the key gets an error instead of a collision.
-- Verified on a copy of the real production database: foreign_key_check and
-- integrity_check both stay clean, and rubric_assessments' FK re-resolves to
-- the rebuilt table after the rename.
--
-- PRAGMA / BEGIN / COMMIT / PRAGMA is SQLite's documented procedure for this
-- kind of change, and the transaction is load-bearing here rather than tidy:
-- the migration runner records a tag only after every statement of that tag has
-- succeeded, so a crash between the DROP and the RENAME would otherwise leave a
-- database with no `rubric_criteria` at all AND no record that 0024 ran -- and
-- the retry would die on "no such table". Wrapped, a failure rolls the whole
-- rebuild back and the retry starts from the original table.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
BEGIN;
--> statement-breakpoint
DROP TABLE IF EXISTS `__rubric_criteria_new`;
--> statement-breakpoint
CREATE TABLE `__rubric_criteria_new` (
	`id` text PRIMARY KEY NOT NULL,
	`rubric_id` text NOT NULL,
	`criterion_key` text NOT NULL,
	`ordinal` integer NOT NULL,
	`text` text NOT NULL,
	`blocking` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`rubric_id`) REFERENCES `rubrics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Backfill. Rows written before this migration never recorded an identity, so
-- one is reconstructed from the only evidence available: a criterion whose text
-- appears in an earlier version of the SAME scope is the same criterion, and
-- inherits that version's key.
--
-- The two COUNT(*) = 1 guards are what make this safe rather than a guess. They
-- link only when the text occurs exactly once in both versions; a version that
-- repeats a wording is ambiguous about which row the earlier one continues, so
-- every such row falls back to its own id. That fallback is also what keeps the
-- result collision-free by construction: two rows of one version can only share
-- a computed key if they share a text, and a shared text disables linking.
INSERT INTO `__rubric_criteria_new` (`id`, `rubric_id`, `criterion_key`, `ordinal`, `text`, `blocking`, `created_at`)
SELECT
	c.`id`,
	c.`rubric_id`,
	'RBK-' || COALESCE(
		(SELECT c0.`id`
		   FROM `rubric_criteria` c0
		   JOIN `rubrics` r0 ON r0.`id` = c0.`rubric_id`
		  WHERE r0.`project_id` = r.`project_id`
		    AND r0.`change_id` IS r.`change_id`
		    AND r0.`phase` = r.`phase`
		    AND r0.`role` = r.`role`
		    AND c0.`text` = c.`text`
		    AND (SELECT COUNT(*) FROM `rubric_criteria` x
		          WHERE x.`rubric_id` = c0.`rubric_id` AND x.`text` = c0.`text`) = 1
		    AND (SELECT COUNT(*) FROM `rubric_criteria` y
		          WHERE y.`rubric_id` = c.`rubric_id` AND y.`text` = c.`text`) = 1
		  ORDER BY r0.`version` ASC, c0.`id` ASC
		  LIMIT 1),
		c.`id`),
	c.`ordinal`,
	c.`text`,
	c.`blocking`,
	c.`created_at`
FROM `rubric_criteria` c
JOIN `rubrics` r ON r.`id` = c.`rubric_id`;
--> statement-breakpoint
DROP TABLE `rubric_criteria`;
--> statement-breakpoint
ALTER TABLE `__rubric_criteria_new` RENAME TO `rubric_criteria`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_rubric_criteria_rubric_ordinal` ON `rubric_criteria` (`rubric_id`,`ordinal`);
--> statement-breakpoint
-- One key may appear at most once per version. Without this, an editor that
-- sent the same key twice would produce two criteria batch 5 would derive one
-- gap id from, and whichever row answered last would decide the gap.
CREATE UNIQUE INDEX IF NOT EXISTS `uq_rubric_criteria_rubric_key` ON `rubric_criteria` (`rubric_id`,`criterion_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rubric_criteria_rubric` ON `rubric_criteria` (`rubric_id`);
--> statement-breakpoint
-- "Show me every round's verdict on this one standard" is a lookup by key
-- across versions, which has no other supporting index.
CREATE INDEX IF NOT EXISTS `idx_rubric_criteria_key` ON `rubric_criteria` (`criterion_key`);
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
