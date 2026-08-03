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

  /**
   * 删掉一个项目，**连同它底下的每一个 Change**。
   *
   * 不做「还有 Change 就拒」：用户 2026-08-03 要的是能删得掉，而让他先逐个删完
   * 十几个 Change 再来删项目，只是把同一件事拆成十几步。级联在一个事务里，
   * 要么全删要么全不删。
   *
   * 项目级的 rubric（`change_id IS NULL` 的那些）也一起走 —— 它们的作用域就是这个
   * 项目，留着就是一堆没有归属的标准。
   */
  delete(projectId: string, changes: { delete(changeId: string): void }): void {
    const ids = (this.database.prepare(
      "SELECT id FROM changes WHERE project_id = ?",
    ).all(projectId) as { id: string }[]).map((row) => row.id);

    const wipe = this.database.transaction(() => {
      for (const id of ids) changes.delete(id);
      this.database.prepare(
        `DELETE FROM rubric_criteria WHERE rubric_id IN
           (SELECT id FROM rubrics WHERE project_id = ? AND change_id IS NULL)`,
      ).run(projectId);
      this.database.prepare(
        "DELETE FROM rubrics WHERE project_id = ? AND change_id IS NULL",
      ).run(projectId);
      this.database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    });
    wipe();
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
