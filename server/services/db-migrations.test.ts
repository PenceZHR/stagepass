import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runMigrations } from "../db/migrate.ts";

function columnNames(sqlite: Database.Database, tableName: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

describe("db migrations", () => {
  it("applies gate metadata columns to a fresh database", () => {
    const sqlite = new Database(":memory:");

    const result = runMigrations(sqlite);

    assert.ok(result.applied.includes("0008_add_gate_fields"));
    assert.deepEqual(
      ["gate_state", "docs_complete", "retro_done"].every((column) =>
        columnNames(sqlite, "changes").includes(column)
      ),
      true
    );
  });

  it("does not reapply recorded migrations on a second run", () => {
    const sqlite = new Database(":memory:");

    runMigrations(sqlite);
    const second = runMigrations(sqlite);
    const recorded = sqlite
      .prepare("SELECT tag FROM __migrations WHERE tag = ?")
      .all("0008_add_gate_fields");

    assert.deepEqual(second.applied, []);
    assert.equal(recorded.length, 1);
  });

  /**
   * 0022 has to be additive over a database that already holds question cards:
   * the owner's rows predate rounds entirely, and a card that came back with a
   * NULL or 0 round would sort and group wrongly forever. Migrating rows that
   * exist BEFORE the ALTER is the case a fresh-schema check cannot see.
   */
  it("backfills pre-existing briefing questions to round 1", () => {
    const sqlite = new Database(":memory:");
    // Rewind to the pre-round shape: unrecord 0022 and undo it, index first --
    // SQLite refuses to drop a column an index still references.
    runMigrations(sqlite);
    sqlite.prepare("DELETE FROM __migrations WHERE tag = ?").run("0022_briefing_question_rounds");
    sqlite.exec("DROP INDEX IF EXISTS `idx_briefing_questions_change_round`");
    sqlite.exec("ALTER TABLE `briefing_questions` DROP COLUMN `round_no`");
    // The card is the fixture; its change/project chain is not what is under
    // test, so the row stands alone rather than dragging in two parent tables.
    sqlite.pragma("foreign_keys = OFF");
    sqlite.prepare(`
      INSERT INTO briefing_questions
        (id, change_id, category, severity, question, why_it_matters, suggested_default,
         status, answer, source, created_at, updated_at)
      VALUES ('BQ-LEGACY', 'CHG-LEGACY', 'scope', 'critical', 'q', 'why', NULL,
              'answered', 'recorded answer', 'ai_blue', '2026-07-01T00:00:00.000Z',
              '2026-07-01T00:00:00.000Z')
    `).run();
    assert.equal(columnNames(sqlite, "briefing_questions").includes("round_no"), false);

    const result = runMigrations(sqlite);

    assert.deepEqual(result.applied, ["0022_briefing_question_rounds"]);
    const row = sqlite.prepare("SELECT round_no, status, answer FROM briefing_questions WHERE id = ?")
      .get("BQ-LEGACY") as { round_no: number; status: string; answer: string };
    assert.equal(row.round_no, 1, "a pre-round card belongs to round 1");
    assert.equal(row.status, "answered", "the migration must not disturb recorded decisions");
    assert.equal(row.answer, "recorded answer");
  });

  it("records a migration when its columns were already applied manually", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);
    sqlite
      .prepare("DELETE FROM __migrations WHERE tag = ?")
      .run("0008_add_gate_fields");

    const result = runMigrations(sqlite);
    const recorded = sqlite
      .prepare("SELECT tag FROM __migrations WHERE tag = ?")
      .all("0008_add_gate_fields");

    assert.deepEqual(result.applied, ["0008_add_gate_fields"]);
    assert.equal(recorded.length, 1);
  });
});
