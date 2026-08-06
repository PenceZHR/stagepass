import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { IllegalTransitionError, type ChangeState } from "../domain/change-state";
import { ChangeNotFoundError, ChangeStore } from "./change-store";

/**
 * L0's other half: the ledger cannot be bypassed.
 *
 * In-memory SQLite, a fixed clock, no network, no model. Same rule as the
 * domain tests -- if the foundation needs the things built on it in order to be
 * proved, it is not a foundation.
 */

const AT = "2026-07-28T00:00:00.000Z";

/** 外键开着，所以引用得到的项目必须先存在。 */
function seedProject(database: import("better-sqlite3").Database): void {
  database.prepare(
    "INSERT OR IGNORE INTO projects (id, name, created_at) VALUES ('PRJ-1', 'p', ?)",
  ).run(AT);
}

function open() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  return {
    database,
    store: new ChangeStore(database, { now: () => new Date(AT) }),
  };
}

describe("L0 · a Change starts where the machine says it starts", () => {
  it("creates at PRD/pending with the creation already in the ledger", () => {
    const { database, store } = open();
    try {
      const created = store.create("CHG-1");
      assert.deepEqual(created.state, {
        phase: "PRD",
        status: "pending",
        returnStack: [],
      });
      assert.equal(created.seq, 0);
      assert.deepEqual(store.ledger("CHG-1").map((entry) => entry.action), [
        "create",
      ]);
    } finally {
      database.close();
    }
  });

  it("reports an unknown Change instead of returning an empty one", () => {
    const { database, store } = open();
    try {
      assert.throws(() => store.read("CHG-NOPE"), ChangeNotFoundError);
    } finally {
      database.close();
    }
  });
});

describe("L0 · 打回上游落库：栈、理由、账本一次到位（§5.9.1/5.9.2）", () => {
  /** 把一个 Change 推到 Build/settled。 */
  const toBuildSettled = (store: ChangeStore, id: string) => {
    store.create(id);
    for (let step = 0; step < 5; step += 1) {
      store.apply(id, "start");
      store.apply(id, "settle");
      store.apply(id, "approve");
    }
    store.apply(id, "start");
    store.apply(id, "settle");
  };

  it("sendBack 带目标和理由 —— 状态压栈，理由进账本那一行", () => {
    const { database, store } = open();
    try {
      toBuildSettled(store, "CHG-1");
      const after = store.apply("CHG-1", "sendBack", {
        to: "Spec", reason: "接口边界在 Spec 里就画错了",
      });
      assert.deepEqual(after.state, {
        phase: "Spec", status: "pending", returnStack: ["Build"],
      });
      const jump = store.ledger("CHG-1").at(-1)!;
      assert.equal(jump.action, "sendBack");
      assert.equal(jump.from?.phase, "Build");
      assert.equal(jump.to.phase, "Spec");
      // 理由在账本上，不在别处 —— 环上历史箭头的「什么理由」就从这儿来（§4.3）。
      assert.equal(jump.reason, "接口边界在 Spec 里就画错了");
    } finally {
      database.close();
    }
  });

  /**
   * §8.9（2026-08-06 反转）：被打回的阶段批准之后**沿主线重走**，栈原样带着，
   * 走到发起方才还清。原来是直接弹回发起方，于是中间那几个阶段的产物（全是照
   * 旧上游建的）一个都没重跑。
   */
  it("被打回的阶段批准后沿主线重走 —— 栈带着，走到发起方才还清", () => {
    const { database, store } = open();
    try {
      toBuildSettled(store, "CHG-1");
      store.apply("CHG-1", "sendBack", { to: "Spec", reason: "r" });
      store.apply("CHG-1", "start");
      store.apply("CHG-1", "settle");
      const next = store.apply("CHG-1", "approve");
      assert.deepEqual(next.state, {
        phase: "TechSpec", status: "pending", returnStack: ["Build"],
      });

      // 一路走回 Build，债才还清 —— 每一步都真的落进账本。
      // 显式标类型：上面那句 `assert.deepEqual` 是 assertion 签名，会收窄 `next.state`。
      let state: ChangeState = next.state;
      while (state.returnStack.length > 0) {
        store.apply("CHG-1", "start");
        store.apply("CHG-1", "settle");
        state = store.apply("CHG-1", "approve").state;
      }
      assert.deepEqual(state, {
        phase: "Build", status: "pending", returnStack: [],
      });
    } finally {
      database.close();
    }
  });

  it("普通动作不带理由 —— 账本那一列是 null，不编", () => {
    const { database, store } = open();
    try {
      store.create("CHG-1");
      store.apply("CHG-1", "start");
      assert.equal(store.ledger("CHG-1").at(-1)!.reason, null);
    } finally {
      database.close();
    }
  });
});

describe("L0 · 项目的阶段图是数据（§4.5）", () => {
  it("设了 phase_order 的项目：Change 生在子序列的第一站，approve 沿子序列走", () => {
    const { database, store } = open();
    try {
      database.prepare(
        "INSERT INTO projects (id, name, phase_order, created_at) VALUES ('PRJ-S', 'p', ?, ?)",
      ).run(JSON.stringify(["PRD", "Build", "Review", "Done"]), AT);
      const created = store.create("CHG-S", { projectId: "PRJ-S" });
      assert.equal(created.state.phase, "PRD");

      store.apply("CHG-S", "start");
      store.apply("CHG-S", "settle");
      // 全序里 PRD 的下一站是 Spec；这张图上是 Build。
      assert.equal(store.apply("CHG-S", "approve").state.phase, "Build");
    } finally {
      database.close();
    }
  });

  it("存坏的 phase_order 在用到时炸出来，不把 Change 引进走不通的图", () => {
    const { database, store } = open();
    try {
      database.prepare(
        "INSERT INTO projects (id, name, phase_order, created_at) VALUES ('PRJ-B', 'p', ?, ?)",
      ).run(JSON.stringify(["Spec", "PRD", "Done"]), AT);   // 重排 —— 非法
      assert.throws(() => store.create("CHG-B", { projectId: "PRJ-B" }));
    } finally {
      database.close();
    }
  });
});

describe("L0 · every transition lands in the ledger", () => {
  it("records one entry per applied action, in order", () => {
    const { database, store } = open();
    try {
      store.create("CHG-1");
      store.apply("CHG-1", "start");
      store.apply("CHG-1", "settle");
      store.apply("CHG-1", "approve");

      const ledger = store.ledger("CHG-1");
      assert.deepEqual(ledger.map((entry) => entry.action), [
        "create", "start", "settle", "approve",
      ]);
      assert.deepEqual(ledger.map((entry) => entry.seq), [0, 1, 2, 3]);
      // The ledger reads as a chain: each entry's `to` is the next entry's `from`.
      for (let index = 1; index < ledger.length; index += 1) {
        assert.deepEqual(
          ledger[index]!.from!.phase,
          ledger[index - 1]!.to.phase,
        );
        assert.deepEqual(
          ledger[index]!.from!.status,
          ledger[index - 1]!.to.status,
        );
      }
      assert.equal(store.read("CHG-1").state.phase, "Spec");
    } finally {
      database.close();
    }
  });

  it("walks a full Change to closed and keeps every step", () => {
    const { database, store } = open();
    try {
      store.create("CHG-1");
      let guard = 0;
      while (store.read("CHG-1").state.status !== "closed" && guard < 100) {
        store.apply("CHG-1", "start");
        store.apply("CHG-1", "settle");
        store.apply("CHG-1", "approve");
        guard += 1;
      }
      const record = store.read("CHG-1");
      assert.equal(record.state.phase, "Done");
      assert.equal(record.state.status, "closed");
      // 11 phases x 3 actions, plus the creation entry.
      assert.equal(store.ledger("CHG-1").length, 11 * 3 + 1);
      assert.equal(record.seq, 11 * 3);
    } finally {
      database.close();
    }
  });
});

describe("L0 · an illegal action changes nothing", () => {
  it("refuses it before the database is touched", () => {
    const { database, store } = open();
    try {
      store.create("CHG-1");
      assert.throws(
        () => store.apply("CHG-1", "approve"),
        IllegalTransitionError,
      );
      const record = store.read("CHG-1");
      assert.equal(record.seq, 0);
      assert.deepEqual(record.state, {
        phase: "PRD", status: "pending", returnStack: [],
      });
      assert.equal(store.ledger("CHG-1").length, 1);
    } finally {
      database.close();
    }
  });
});

describe("L0 · the ledger cannot be bypassed", () => {
  /**
   * The rule this proves is the one that matters most at this layer: "every
   * state change is recorded" is only true if skipping the record is
   * impossible. A convention holds until the second caller appears.
   */
  it("aborts a direct UPDATE that writes no ledger row", () => {
    const { database, store } = open();
    try {
      store.create("CHG-1");
      assert.throws(
        () => database.prepare(
          "UPDATE changes SET phase = 'Merge', seq = 1 WHERE id = ?",
        ).run("CHG-1"),
        /change_updated_without_ledger_entry/,
      );
      assert.equal(store.read("CHG-1").state.phase, "PRD");
    } finally {
      database.close();
    }
  });

  it("aborts an UPDATE that leaves the sequence where it was", () => {
    const { database, store } = open();
    try {
      store.create("CHG-1");
      assert.throws(
        () => database.prepare(
          "UPDATE changes SET status = 'running' WHERE id = ?",
        ).run("CHG-1"),
        /change_seq_must_advance_by_one/,
      );
      assert.equal(store.read("CHG-1").state.status, "pending");
    } finally {
      database.close();
    }
  });

  it("refuses a stored state the machine could not have produced", () => {
    const { database } = open();
    try {
      // Fix without a return stack, inserted straight past the store.
      assert.throws(
        () => database.prepare(
          `INSERT INTO changes
             (id, phase, status, return_stack, seq, created_at, updated_at)
           VALUES ('CHG-BAD', 'Fix', 'pending', '[]', 0, ?, ?)`,
        ).run(AT, AT),
        /CHECK constraint failed/,
      );
      // `closed` on a phase that is not the terminal one.
      assert.throws(
        () => database.prepare(
          `INSERT INTO changes
             (id, phase, status, return_stack, seq, created_at, updated_at)
           VALUES ('CHG-BAD2', 'Spec', 'closed', '[]', 0, ?, ?)`,
        ).run(AT, AT),
        /CHECK constraint failed/,
      );
      // closed 还欠着回程 —— 关不了。
      assert.throws(
        () => database.prepare(
          `INSERT INTO changes
             (id, phase, status, return_stack, seq, created_at, updated_at)
           VALUES ('CHG-BAD3', 'Done', 'closed', '["Build"]', 0, ?, ?)`,
        ).run(AT, AT),
        /CHECK constraint failed/,
      );
    } finally {
      database.close();
    }
  });

  it("refuses a phase the domain has never heard of", () => {
    const { database } = open();
    try {
      assert.throws(
        () => database.prepare(
          `INSERT INTO changes
             (id, phase, status, return_stack, seq, created_at, updated_at)
           VALUES ('CHG-BAD', 'Intake', 'pending', '[]', 0, ?, ?)`,
        ).run(AT, AT),
        /CHECK constraint failed/,
      );
    } finally {
      database.close();
    }
  });
});

describe("L0 · concurrent writers cannot both win", () => {
  it("fails the writer whose sequence has moved under it", () => {
    const { database, store } = open();
    try {
      store.create("CHG-1");
      const stale = store.read("CHG-1");
      store.apply("CHG-1", "start");
      // `stale` still believes seq is 0. Replaying from it must not overwrite
      // the transition it never saw.
      assert.throws(
        () => new ChangeStore(database, { now: () => new Date(AT) })
          .apply("CHG-1", "start"),
        IllegalTransitionError,
      );
      assert.equal(stale.seq, 0);
      assert.equal(store.read("CHG-1").seq, 1);
    } finally {
      database.close();
    }
  });
});

describe("L0 · 记下人答出来的需求", () => {
  /*
   * 写的是 change_briefs，**不是 changes 上的一列**。
   *
   * 实测撞出来的：changes 上那两条触发器要求每一次 UPDATE 都是一次状态转移
   * （ck_changes_seq_advances 要 NEW.seq = OLD.seq + 1）。而录入需求不是转移 ——
   * 没有 action 可记。做成一列就得放宽触发器；换一张表，触发器一个字都不用动。
   */
  it("**录入不推 seq，也不进账本**", () => {
    const { store: changes } = open();
    changes.create("CHG-1");
    const after = changes.setBrief("CHG-1", "我要一个重新生成按钮");

    assert.equal(after.brief, "我要一个重新生成按钮");
    assert.equal(after.seq, 0, "录入需求不是状态转移，seq 不该动");
    assert.deepEqual(changes.ledger("CHG-1").map((entry) => entry.action), ["create"]);
  });

  it("状态转移之后需求还在", () => {
    const { store: changes } = open();
    changes.create("CHG-1");
    changes.setBrief("CHG-1", "我要一个重新生成按钮");
    changes.apply("CHG-1", "start");
    assert.equal(changes.read("CHG-1").brief, "我要一个重新生成按钮");
  });

  it("改一次就覆盖，不留两份", () => {
    const { store: changes } = open();
    changes.create("CHG-1");
    changes.setBrief("CHG-1", "第一版");
    assert.equal(changes.setBrief("CHG-1", "想清楚之后的第二版").brief, "想清楚之后的第二版");
  });

  it("没录入就是 null —— list 里也是", () => {
    const { store: changes } = open();
    changes.create("CHG-1");
    assert.equal(changes.read("CHG-1").brief, null);
    assert.equal(changes.list()[0]?.brief, null);
  });

  it("往不存在的 Change 上录 —— 报 ChangeNotFoundError，不是外键报错", () => {
    const { store: changes } = open();
    assert.throws(() => changes.setBrief("CHG-nope", "x"), ChangeNotFoundError);
  });
});

/**
 * 删除。用户 2026-08-03：「每个 change 每个 project 我需要可以删除，我现在没法删。」
 */
describe("L0 · 删掉一个 Change，连同它的全部痕迹", () => {
  /**
   * **一张表都不许剩。**
   *
   * 有十三张表引用 `changes(id)`，还有几张隔一层（`answers` -> `questions`、
   * `rubric_criteria` -> `rubrics`）。这条测试不去逐个念名字，而是**问库自己**：
   * 凡是有 `change_id` 这一列的表，删完都不该再有这个 id 的行。
   *
   * 所以将来加了一张新表却忘了往 `delete` 的名单里加一行，它会红 —— 那正是这条
   * 测试存在的理由，而不是为了复述我刚写的那个数组。
   */
  it("**凡是有 change_id 的表，删完都查不到它**", () => {
    const { database, store: changes } = open();
    seedProject(database);
    changes.create("CHG-DEL", { projectId: "PRJ-1", title: "要删的" });
    changes.setBrief("CHG-DEL", "需求");
    changes.apply("CHG-DEL", "start");

    const tables = (database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all() as { name: string }[])
      .map((row) => row.name)
      .filter((name) => (database.pragma(`table_info(${name})`) as { name: string }[])
        .some((column) => column.name === "change_id"));
    assert.ok(tables.length >= 10, "没找到那些引用表 —— 这条测试在空转");

    changes.delete("CHG-DEL");

    const left = tables.filter((table) => (database.prepare(
      `SELECT 1 FROM ${table} WHERE change_id = ? LIMIT 1`,
    ).get("CHG-DEL")) !== undefined);
    assert.deepEqual(left, [], "这几张表里还留着它");
    assert.throws(() => changes.read("CHG-DEL"));
  });

  it("**别的 Change 一根汗毛都不许动**", () => {
    const { database, store: changes } = open();
    seedProject(database);
    changes.create("CHG-DEL", { projectId: "PRJ-1", title: "要删的" });
    changes.create("CHG-KEEP", { projectId: "PRJ-1", title: "留着的" });
    changes.setBrief("CHG-KEEP", "它的需求");

    changes.delete("CHG-DEL");

    assert.equal(changes.read("CHG-KEEP").brief, "它的需求");
    assert.deepEqual(changes.list("PRJ-1").map((each) => each.id), ["CHG-KEEP"]);
  });

  it("删一个不存在的 —— 什么都不做，也不抛", () => {
    const { store: changes } = open();
    changes.delete("CHG-NOPE");
  });
});
