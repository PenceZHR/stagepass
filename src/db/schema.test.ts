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
describe("L0 · rubric_criteria 的 section 列补得进老库", () => {
  /** 一个 section 列出现之前建的库，里面已经有真数据。 */
  const oldShape = (): Database.Database => {
    const database = new Database(":memory:");
    database.exec(`CREATE TABLE rubric_criteria (
      rubric_id TEXT NOT NULL, criterion_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
      text TEXT NOT NULL, blocking INTEGER NOT NULL,
      PRIMARY KEY (rubric_id, criterion_key))`);
    database.prepare("INSERT INTO rubric_criteria VALUES (?,?,?,?,?)")
      .run("R1", "K1", 0, "老标准", 0);
    return database;
  };

  it("**没有 migrate，读 section 就抛**", () => {
    assert.throws(
      () => oldShape().prepare("SELECT section FROM rubric_criteria").all(),
      /no such column/,
    );
  });

  it("migrate 之后列在了，老行是 NULL —— 不是凭空挂到某一节上", () => {
    const database = oldShape();
    migrate(database);
    const row = database
      .prepare("SELECT section FROM rubric_criteria WHERE criterion_key = ?")
      .get("K1") as { section: string | null };
    assert.equal(row.section, null);
  });

  it("跑两次是幂等的", () => {
    const database = oldShape();
    migrate(database);
    assert.doesNotThrow(() => { migrate(database); });
  });
});

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
 * `change_bindings` 加 `kind`、`phase` 放开可空（DESIGN-phase-not-the-only-axis
 * §3.3）：第二次整表重建，和 return_stack 那次同一个理由 —— 旧列绑在 CHECK
 * 和 PRIMARY KEY 里，SQLite 改不了约束。
 */
describe("L0 · change_bindings 旧库重建出 kind 列", () => {
  /** 照 2026-08-06 之前的 SCHEMA_SQL 原样搭的老库，一行阶段绑定。 */
  const oldShape = () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(`
      -- 重建后的表带 REFERENCES changes(id)，老库里得有被引用的那张。
      -- 带上 return_stack 免得触发它自己的那场迁移 —— 这里只考 bindings 这场。
      CREATE TABLE changes (id TEXT PRIMARY KEY, return_stack TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE change_bindings (
        change_id   TEXT NOT NULL,
        phase       TEXT NOT NULL,
        thread_id   TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('bound','detached')),
        bound_at    TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (change_id, phase));
      CREATE UNIQUE INDEX uq_change_bindings_thread
        ON change_bindings (thread_id) WHERE status = 'bound';
    `);
    database.prepare("INSERT INTO changes (id) VALUES ('CHG-A')").run();
    database.prepare("INSERT INTO change_bindings VALUES (?,?,?,?,?,?)")
      .run("CHG-A", "PRD", "T-1", "bound", "t", "t");
    return database;
  };

  it("老行无损，全部记成 kind = round", () => {
    const database = oldShape();
    migrate(database);
    assert.deepEqual(
      database.prepare(
        "SELECT change_id, kind, phase, thread_id FROM change_bindings").all(),
      [{ change_id: "CHG-A", kind: "round", phase: "PRD", thread_id: "T-1" }],
    );
    database.close();
  });

  it("重建之后 aside 存得进去，而错配的行仍然不可存", () => {
    const database = oldShape();
    migrate(database);
    assert.doesNotThrow(() => database.prepare(
      `INSERT INTO change_bindings
        (change_id, kind, phase, thread_id, status, bound_at, updated_at)
       VALUES ('CHG-A', 'aside', NULL, 'T-2', 'bound', 't', 't')`).run());
    // round 没阶段、aside 带阶段 —— 两种错配都被 CHECK 挡住。
    assert.throws(() => database.prepare(
      `INSERT INTO change_bindings
        (change_id, kind, phase, thread_id, status, bound_at, updated_at)
       VALUES ('CHG-A', 'round', NULL, 'T-3', 'bound', 't', 't')`).run());
    assert.throws(() => database.prepare(
      `INSERT INTO change_bindings
        (change_id, kind, phase, thread_id, status, bound_at, updated_at)
       VALUES ('CHG-A', 'aside', 'PRD', 'T-4', 'bound', 't', 't')`).run());
    database.close();
  });

  it("跑两次是空操作，线程唯一索引也重建了", () => {
    const database = oldShape();
    migrate(database);
    migrate(database);
    const kinds = (database.pragma("table_info(change_bindings)") as { name: string }[])
      .filter((column) => column.name === "kind");
    assert.equal(kinds.length, 1);
    // 索引随旧表消失，必须当场重建 —— 同一条线程绑两次要被拒。
    assert.throws(() => database.prepare(
      `INSERT INTO change_bindings
        (change_id, kind, phase, thread_id, status, bound_at, updated_at)
       VALUES ('CHG-A', 'round', 'Spec', 'T-1', 'bound', 't', 't')`).run());
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
