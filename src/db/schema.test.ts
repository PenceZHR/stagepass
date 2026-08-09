import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL, migrate, prepareSchema } from "./schema";

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
 * **一个真实旧库能不能被打开** —— 2026-08-06 真机上炸在这儿，而这个文件里所有
 * 别的测试都建全新库，所以它们全绿也没拦住。
 *
 * 病是顺序：`SCHEMA_SQL` 里有引用新列的部分索引（`change_bindings` 那三个
 * `WHERE kind = ...`），而旧库那张表的 `kind` 是 `migrate` 才补的，
 * `CREATE TABLE IF NOT EXISTS` 对已存在的表又什么都不做 —— 于是
 * 「先 SCHEMA_SQL 后 migrate」必抛 `no such column: kind`，面板起不来。
 *
 * 所以这一组用的是**真库那个形状**：2026-08-06 之前的 `change_bindings`
 * （没有 kind）、`gaps`（phase 名单里没有 Arch）、`jobs`（没有 phase 列）。
 */
/**
 * **老库记不下「打回上游」** —— 2026-08-07 真机栽的那一次。
 *
 * `change_events.action` 的 CHECK 名单是建表时从 `CHANGE_ACTIONS` 生成的，而
 * `sendBack` / `rerun` 是后来加进那个常量的。`CREATE TABLE IF NOT EXISTS` 对已经
 * 存在的表什么都不做，于是人在选择器里选了「打回上游」→ 账本写不进去 → 整个事务
 * 回滚 → `questions.apply` 抛 SqliteError（`decideGate` 只接得住闸门那两种）→ 500。
 *
 * 迁移的判据原来只认阶段名那一种陈旧（有 'PRD' 没 'Arch'），看不见这一列。
 * 现在换成通用的：**代码现在允许、而库里那张表不认的字面量**，有一个就重建。
 */
describe("L0 · 老库的枚举 CHECK 落后了就重建", () => {
  const oldLedger = () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE changes (
        id TEXT PRIMARY KEY, project_id TEXT NULL, title TEXT NULL,
        phase TEXT NOT NULL, status TEXT NOT NULL,
        return_stack TEXT NOT NULL DEFAULT '[]',
        seq INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      -- 2026-08-05 之前的名单：没有 sendBack、没有 rerun
      CREATE TABLE change_events (
        change_id   TEXT NOT NULL REFERENCES changes(id),
        seq         INTEGER NOT NULL,
        action      TEXT NOT NULL CHECK (action IN
          ('start','settle','fail','retry','approve','reject','create')),
        from_phase  TEXT NULL, from_status TEXT NULL,
        to_phase    TEXT NOT NULL, to_status TEXT NOT NULL,
        at          TEXT NOT NULL,
        PRIMARY KEY (change_id, seq));
      CREATE TRIGGER ck_changes_ledger AFTER UPDATE ON changes FOR EACH ROW
      WHEN NOT EXISTS (SELECT 1 FROM change_events WHERE change_id = NEW.id AND seq = NEW.seq)
      BEGIN SELECT RAISE(ABORT, 'change_updated_without_ledger_entry'); END;
    `);
    database.prepare(
      "INSERT INTO changes VALUES ('CHG-1',NULL,NULL,'Build','settled','[]',3,'t','t')",
    ).run();
    database.prepare(
      `INSERT INTO change_events VALUES ('CHG-1',3,'settle',NULL,NULL,'Build','settled','t')`,
    ).run();
    return database;
  };

  it("**没迁移，账本记不下 sendBack**", () => {
    const database = oldLedger();
    assert.throws(() => database.prepare(
      `INSERT INTO change_events VALUES ('CHG-1',4,'sendBack','Build','settled','Arch','pending','t')`,
    ).run(), /CHECK constraint failed/);
    database.close();
  });

  it("prepareSchema 之后记得下了，老账一行不少", () => {
    const database = oldLedger();
    prepareSchema(database);
    assert.doesNotThrow(() => database.prepare(
      `INSERT INTO change_events
         (change_id, seq, action, from_phase, from_status, to_phase, to_status, reason, at)
       VALUES ('CHG-1',4,'sendBack','Build','settled','Arch','pending','我要做arch','t')`,
    ).run());
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM change_events")
      .get() as { n: number }).n, 2, "重建把老账本行弄丢了");
    database.close();
  });

  it("**重建之后账本触发器还在** —— 摘掉它只为躲开悬空引用，不是放它走", () => {
    // change_events 自己就在待重建名单里，触发器引用它 —— 不先摘掉，DROP 之后
    // 下一条语句就撞 “no such table: main.change_events”。摘了必须装回来。
    const database = oldLedger();
    prepareSchema(database);
    // seq 要**加一**：否则先撞上的是 ck_changes_seq_advances 那条，
    // 而这里要问的是账本那条还在不在。
    assert.throws(
      () => database.prepare(
        "UPDATE changes SET seq = 4, updated_at = 'x' WHERE id = 'CHG-1'").run(),
      /change_updated_without_ledger_entry/,
    );
    database.close();
  });
});

describe("L0 · 打开一个 2026-08-06 之前的旧库", () => {
  const oldDatabase = () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NULL,
        phase_order TEXT NULL, created_at TEXT NOT NULL);
      CREATE TABLE changes (
        id TEXT PRIMARY KEY, project_id TEXT NULL, title TEXT NULL,
        phase TEXT NOT NULL, status TEXT NOT NULL,
        return_stack TEXT NOT NULL DEFAULT '[]',
        seq INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE change_bindings (
        change_id  TEXT NOT NULL REFERENCES changes(id),
        phase      TEXT NOT NULL CHECK (phase IN ('PRD','Spec','TechSpec','Plan','TestPlan','Build','Review','Fix','QA','Merge','Retro','Done')),
        thread_id  TEXT NOT NULL,
        status     TEXT NOT NULL CHECK (status IN ('bound','detached')),
        bound_at   TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (change_id, phase));
      CREATE UNIQUE INDEX uq_change_bindings_thread
        ON change_bindings (thread_id) WHERE status = 'bound';
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id),
        kind TEXT NOT NULL, status TEXT NOT NULL,
        attempt INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
        owner TEXT NULL, token TEXT NULL, expires_at INTEGER NULL,
        deadline_at INTEGER NOT NULL, error TEXT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    database.prepare(
      `INSERT INTO changes VALUES ('CHG-001', NULL, '重构项目', 'Build', 'blocked', '[]', 9, 't', 't')`,
    ).run();
    database.prepare(
      `INSERT INTO change_bindings VALUES ('CHG-001', 'Build', 'T-OLD', 'bound', 't', 't')`,
    ).run();
    return database;
  };

  it("**prepareSchema 打得开** —— 老数据一行不少", () => {
    const database = oldDatabase();
    prepareSchema(database);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM changes")
      .get() as { n: number }).n, 1);
    assert.deepEqual(
      database.prepare("SELECT change_id, kind, phase, thread_id FROM change_bindings")
        .get(),
      { change_id: "CHG-001", kind: "round", phase: "Build", thread_id: "T-OLD" },
    );
    database.close();
  });

  it("打开之后新东西全都在：Arch、aside、并行座位、jobs.phase", () => {
    const database = oldDatabase();
    prepareSchema(database);
    /*
     * 批 5：Arch 进了 phase 名单。
     *
     * **插一行新的，不 UPDATE 老的** —— `ck_changes_ledger` 会拒掉任何没有配套
     * 账本行的 UPDATE（那条触发器正是这么设计的），拿它测 CHECK 只会撞见账本。
     */
    assert.doesNotThrow(() => database.prepare(
      `INSERT INTO changes VALUES ('CHG-ARCH', NULL, 'x', 'Arch', 'pending', '[]', 0, 't', 't')`,
    ).run());
    // 批 1：旁路绑定存得进去，而且那三个部分索引真的建出来了。
    assert.doesNotThrow(() => database.prepare(
      `INSERT INTO change_bindings
         (change_id, kind, phase, thread_id, status, bound_at, updated_at)
       VALUES ('CHG-001', 'aside', NULL, 'T-ASIDE', 'bound', 't', 't')`).run());
    assert.throws(() => database.prepare(
      `INSERT INTO change_bindings
         (change_id, kind, phase, thread_id, status, bound_at, updated_at)
       VALUES ('CHG-001', 'aside', NULL, 'T-TWO', 'bound', 't', 't')`).run(),
    /UNIQUE/, "一个 Change 两条 aside —— 部分索引没建出来");
    // 批 3：并行座位表和 jobs.phase 都在。
    assert.doesNotThrow(() => database.prepare(
      `INSERT INTO change_states VALUES ('CHG-001', 'QA', 'pending', 't', 't')`).run());
    assert.doesNotThrow(() => database.prepare(
      `INSERT INTO jobs (id, change_id, kind, status, attempt, max_attempts,
         owner, token, expires_at, deadline_at, error, phase, created_at, updated_at)
       VALUES ('J-1', 'CHG-001', 'phase_turn', 'queued', 0, 1,
         NULL, NULL, NULL, 0, NULL, 'QA', 't', 't')`).run());
    database.close();
  });

  it("**跑两次是空操作** —— 面板重启走的就是第二次", () => {
    const database = oldDatabase();
    prepareSchema(database);
    assert.doesNotThrow(() => { prepareSchema(database); });
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM change_bindings")
      .get() as { n: number }).n, 1);
    database.close();
  });

  it("全新的空库照样打得开 —— migrate 那半是空操作", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    assert.doesNotThrow(() => { prepareSchema(database); });
    assert.doesNotThrow(() => database.prepare(
      "SELECT change_id, kind, phase FROM change_bindings").all());
    database.close();
  });
});

/**
 * 旧库的 phase CHECK 名单补上 `Arch`（批 5）：名单是建表时从 PHASES 生成的，
 * 旧库拒收 'Arch'，新代码第一次让 Change 走进 Arch 就当场炸。
 */
describe("L0 · 旧库的 phase 名单补上 Arch", () => {
  /** 照 Arch 之前的样子搭一张带 phase CHECK 的表（拿 gaps 当代表）。 */
  const oldShape = () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(`
      -- 迁移末尾会整篇补 SCHEMA_SQL 的索引，所以桩表要带上索引摸得到的列。
      -- **列要摆全**：重建是「按老表有的列拷进新表」，缺列会撞新表的 NOT NULL。
      CREATE TABLE changes (
        id TEXT PRIMARY KEY, project_id TEXT NULL, title TEXT NULL,
        phase TEXT NOT NULL, status TEXT NOT NULL,
        return_stack TEXT NOT NULL DEFAULT '[]',
        seq INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE gaps (
        id TEXT NOT NULL,
        change_id TEXT NOT NULL REFERENCES changes(id),
        phase TEXT NOT NULL CHECK (phase IN ('PRD','Spec','TechSpec','Plan','TestPlan','Build','Review','Fix','QA','Merge','Retro','Done')),
        kind TEXT NOT NULL, severity TEXT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL,
        opened_round INTEGER NOT NULL, resolution TEXT NULL,
        note TEXT NULL, closed_by TEXT NULL,
        found_where TEXT NULL, found_why TEXT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (change_id, phase, id));
    `);
    database.prepare(
      "INSERT INTO changes VALUES ('CHG-A',NULL,NULL,'PRD','pending','[]',0,'t','t')").run();
    database.prepare(
      `INSERT INTO gaps (id, change_id, phase, kind, severity, title, status,
         opened_round, updated_at)
       VALUES ('G-1', 'CHG-A', 'Build', 'finding', 'P1', '老问题', 'open', 1, 't')`,
    ).run();
    return database;
  };

  it("**没迁移之前，Arch 行存不进去** —— 这一条钉住为什么必须迁", () => {
    const database = oldShape();
    assert.throws(() => database.prepare(
      `INSERT INTO gaps (id, change_id, phase, kind, severity, title, status,
         opened_round, updated_at)
       VALUES ('G-2', 'CHG-A', 'Arch', 'finding', 'P1', 'x', 'open', 1, 't')`,
    ).run(), /CHECK constraint failed/);
    database.close();
  });

  it("迁移之后老行无损、Arch 存得进去，跑两次是空操作", () => {
    const database = oldShape();
    migrate(database);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM gaps")
      .get() as { n: number }).n, 1, "老行丢了");
    assert.doesNotThrow(() => database.prepare(
      `INSERT INTO gaps (id, change_id, phase, kind, severity, title, status,
         opened_round, updated_at)
       VALUES ('G-2', 'CHG-A', 'Arch', 'finding', 'P1', 'x', 'open', 1, 't')`,
    ).run());
    assert.doesNotThrow(() => { migrate(database); });
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
      -- **列要摆全**：迁移是「按老表有的列拷进新表」，桩表缺列就会撞新表的
      -- NOT NULL —— 那是桩不真实，不是迁移有问题。
      CREATE TABLE changes (
        id TEXT PRIMARY KEY, project_id TEXT NULL, title TEXT NULL,
        phase TEXT NOT NULL, status TEXT NOT NULL,
        return_stack TEXT NOT NULL DEFAULT '[]',
        seq INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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
    database.prepare(
      "INSERT INTO changes VALUES ('CHG-A',NULL,NULL,'PRD','pending','[]',0,'t','t')").run();
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
