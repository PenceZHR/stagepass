import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL, migrate } from "./schema";

/**
 * 后加的列，得能补进一个已经存在的库。
 *
 * `SCHEMA_SQL` 整篇是 `CREATE TABLE IF NOT EXISTS`。新表没问题，但**已存在的表不会
 * 因此多出一列** —— 那条语句直接跳过，然后一个 `SELECT … path …` 抛
 * 「no such column」，旧库就打不开了。
 *
 * 2026-07-30 我自己撞上这个（`projects.path`），当时手跑了一次 ALTER 就过去了，
 * 差点让真实的旧库带着这个坑上线。
 */
describe("L0 · 旧库能补上后加的列", () => {
  /** 一个 path 列出现之前建的库。 */
  const oldShape = () => {
    const database = new Database(":memory:");
    database.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)`);
    database.prepare("INSERT INTO projects VALUES (?,?,?)")
      .run("PRJ-OLD", "老项目", "2026-07-01");
    return database;
  };

  it("**没有 migrate，旧库读不了新列**", () => {
    const database = oldShape();
    // 这一条钉住的是「为什么需要 migrate」。它一旦变绿，说明 SCHEMA_SQL 已经能自己
    // 补列了，那时这整个 describe 才可以删。
    database.exec(SCHEMA_SQL);
    assert.throws(
      () => database.prepare("SELECT id, name, path FROM projects").all(),
      /no such column/);
    database.close();
  });

  it("migrate 之后读得到，值是 null", () => {
    const database = oldShape();
    database.exec(SCHEMA_SQL);
    migrate(database);
    assert.deepEqual(
      database.prepare("SELECT id, path FROM projects").get(),
      { id: "PRJ-OLD", path: null });
    database.close();
  });

  it("跑两次不会加两列", () => {
    const database = oldShape();
    migrate(database);
    migrate(database);
    const paths = (database.pragma("table_info(projects)") as { name: string }[])
      .filter((column) => column.name === "path");
    assert.equal(paths.length, 1);
    database.close();
  });

  it("全新的库跑 migrate 是空操作", () => {
    const database = new Database(":memory:");
    database.exec(SCHEMA_SQL);
    migrate(database);
    assert.doesNotThrow(() => {
      database.prepare("SELECT id, name, path, created_at FROM projects").all();
    });
    database.close();
  });
});

/**
 * `return_phase` → `return_stack`：**这棵树第一次整表重建**（migrate 注释里
 * 预告过的「正经写迁移」那一天，2026-08-05 因为 §5.9.2 的跳转栈到了）。
 * 加列那条路走不了：旧列绑在 CHECK 里，SQLite 改不了约束。
 */
describe("L0 · return_phase 旧库重建成 return_stack", () => {
  /** 照 2026-08-05 之前的 SCHEMA_SQL 原样搭的老库，两行数据。 */
  const oldShape = () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NULL, created_at TEXT NOT NULL);
      CREATE TABLE changes (
        id            TEXT PRIMARY KEY,
        project_id    TEXT     NULL REFERENCES projects(id),
        title         TEXT     NULL,
        phase         TEXT NOT NULL,
        status        TEXT NOT NULL,
        return_phase  TEXT     NULL,
        seq           INTEGER NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        CHECK ((phase = 'Fix') = (return_phase IS NOT NULL)));
      CREATE TABLE change_events (
        change_id   TEXT NOT NULL REFERENCES changes(id),
        seq         INTEGER NOT NULL,
        action      TEXT NOT NULL,
        from_phase  TEXT NULL, from_status TEXT NULL,
        to_phase    TEXT NOT NULL, to_status TEXT NOT NULL,
        at          TEXT NOT NULL,
        PRIMARY KEY (change_id, seq));
      CREATE TRIGGER ck_changes_ledger AFTER UPDATE ON changes FOR EACH ROW
      WHEN NOT EXISTS (SELECT 1 FROM change_events WHERE change_id = NEW.id AND seq = NEW.seq)
      BEGIN SELECT RAISE(ABORT, 'change_updated_without_ledger_entry'); END;
    `);
    database.prepare("INSERT INTO changes VALUES (?,?,?,?,?,?,?,?,?)")
      .run("CHG-A", null, null, "PRD", "pending", null, 0, "t", "t");
    database.prepare("INSERT INTO changes VALUES (?,?,?,?,?,?,?,?,?)")
      .run("CHG-B", null, null, "Fix", "pending", "Review", 3, "t", "t");
    return database;
  };

  it("老数据无损：NULL 变空栈，Review 变单层栈", () => {
    const database = oldShape();
    migrate(database);
    assert.deepEqual(
      database.prepare(
        "SELECT id, return_stack FROM changes ORDER BY id").all(),
      [
        { id: "CHG-A", return_stack: "[]" },
        { id: "CHG-B", return_stack: '["Review"]' },
      ],
    );
    database.close();
  });

  it("重建之后账本触发器还在 —— 没账的 UPDATE 当场被拒", () => {
    // 触发器随旧表一起消失。等下一次重启的 SCHEMA_SQL 来补，中间这段时间账本
    // 就没人守了 —— 所以迁移必须当场重建，而这一条盯着它。
    const database = oldShape();
    migrate(database);
    assert.throws(
      () => database.prepare(
        "UPDATE changes SET seq = 1, updated_at = 'x' WHERE id = 'CHG-A'").run(),
      /change_updated_without_ledger_entry/,
    );
    database.close();
  });

  it("跑两次是空操作，外键开关也拨回来了", () => {
    const database = oldShape();
    migrate(database);
    migrate(database);
    const stacks = (database.pragma("table_info(changes)") as { name: string }[])
      .filter((column) => column.name === "return_stack");
    assert.equal(stacks.length, 1);
    assert.deepEqual(database.pragma("foreign_keys"), [{ foreign_keys: 1 }]);
    database.close();
  });
});
