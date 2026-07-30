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
