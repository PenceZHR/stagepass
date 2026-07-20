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
