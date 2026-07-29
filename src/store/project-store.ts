import type Database from "better-sqlite3";

/**
 * What a Change belongs to.
 *
 * ## Why this holds almost nothing
 *
 * A project has an id and a name. It has no status, no phase and no gate,
 * because a project is not a thing that can be approved, blocked or reopened --
 * only a Change is. The tree this replaces let a grouping accumulate state
 * until nobody could say which layer a decision actually came from.
 *
 * So this is a label, and everything decidable stays on the Change.
 */

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
}

export class ProjectStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Create it, or return the one already there. Safe to call on every start. */
  ensure(id: string, name: string): Project {
    this.database.prepare(
      "INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
    ).run(id, name, this.now().toISOString());
    return this.read(id);
  }

  read(id: string): Project {
    const row = this.database.prepare(
      "SELECT id, name, created_at FROM projects WHERE id = ?",
    ).get(id) as ProjectRow | undefined;
    if (!row) throw new Error(`No project with id ${id}`);
    return { id: row.id, name: row.name, createdAt: row.created_at };
  }

  list(): Project[] {
    const rows = this.database.prepare(
      "SELECT id, name, created_at FROM projects ORDER BY created_at",
    ).all() as ProjectRow[];
    return rows.map((row) => ({
      id: row.id, name: row.name, createdAt: row.created_at,
    }));
  }
}
