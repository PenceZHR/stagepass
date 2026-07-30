import type Database from "better-sqlite3";

/**
 * What a Change belongs to：**一个 Project 就是一个仓库**（用户 2026-07-30 拍板）。
 *
 * ## Why this holds almost nothing
 *
 * A project has an id, a name and a path. It has no status, no phase and no gate,
 * because a project is not a thing that can be approved, blocked or reopened --
 * only a Change is. The tree this replaces let a grouping accumulate state
 * until nobody could say which layer a decision actually came from.
 *
 * 所以除了「它是哪个仓库」，一切可裁决的东西都留在 Change 上。
 *
 * ## `path` 不是可选的装饰
 *
 * **Codex 就跑在这个目录里。** 在它存在之前，pty 的 cwd 是服务启动时定死的一个值，
 * 于是任何项目下的任何 Change 都跑在同一个仓库里 —— 你新建一个项目，Codex 却在
 * 改 stagepass 本身，而且没有任何提示（用户发现的洞）。
 *
 * 列可空只是为了不弄坏已有的库。没有它不许跑，判据在 panel-server。
 */

export interface Project {
  readonly id: string;
  readonly name: string;
  /** 这个项目的代码在哪。null = 还没指定，这样的项目跑不了。 */
  readonly path: string | null;
  readonly createdAt: string;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string | null;
  created_at: string;
}

export class ProjectStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Create it, or return the one already there. Safe to call on every start.
   *
   * 已经存在时**会把 path 补上**（如果原来是空的）—— 这是给旧库用的：它们建的时候
   * 还没有这一列。已经有 path 的不动，免得一次重启就把人指到别的仓库去。
   */
  ensure(id: string, name: string, path?: string): Project {
    this.database.prepare(
      `INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET path = COALESCE(projects.path, excluded.path)`,
    ).run(id, name, path ?? null, this.now().toISOString());
    return this.read(id);
  }

  read(id: string): Project {
    const row = this.database.prepare(
      "SELECT id, name, path, created_at FROM projects WHERE id = ?",
    ).get(id) as ProjectRow | undefined;
    if (!row) throw new Error(`No project with id ${id}`);
    return { id: row.id, name: row.name, path: row.path, createdAt: row.created_at };
  }

  list(): Project[] {
    const rows = this.database.prepare(
      "SELECT id, name, path, created_at FROM projects ORDER BY created_at",
    ).all() as ProjectRow[];
    return rows.map((row) => ({
      id: row.id, name: row.name, path: row.path, createdAt: row.created_at,
    }));
  }
}
