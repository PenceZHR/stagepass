import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { openDatabase } from "./sqlite-handle";

/**
 * 这组测试守的是一句话：**换掉驱动，行为不许变**。
 *
 * 插件进程没有 node_modules，所以库句柄从 better-sqlite3 换成了 Node 内置的
 * `node:sqlite`。领域层一个字都没改 —— 它只认句柄的形状。那么唯一值得测的就不是
 * 「适配器的方法能不能调通」，而是**同一段生产代码，两个驱动跑出来一不一样**。
 *
 * 所以下面跑的是真的 `ChangeStore` 和真的 `SCHEMA_SQL`，不是我自己挑的几条 SQL。
 */

const AT = "2026-07-28T00:00:00.000Z";

type Handle = ReturnType<typeof openDatabase>;

function seed(database: Handle): void {
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database, () => new Date(AT)).ensure("PRJ-1", "p", "/repo");
}

/** 同一段剧本，喂给一个句柄，返回可以逐字比对的结果。 */
function play(database: Handle): unknown {
  seed(database);
  const store = new ChangeStore(database, { now: () => new Date(AT) });
  const created = store.create("CHG-1");
  const read = store.read("CHG-1");
  return {
    created: { state: created.state, seq: created.seq },
    read: { state: read.state, brief: read.brief },
    ledger: store.ledger("CHG-1").map((entry) => entry.action),
    columns: (database.pragma("table_info(changes)") as { name: string }[])
      .map((column) => column.name),
  };
}

describe("plugin · node:sqlite 顶替 better-sqlite3", () => {
  it("同一段生产代码，两个驱动跑出完全一样的结果", () => {
    const native = new Database(":memory:") as unknown as Handle;
    const builtin = openDatabase(":memory:");
    try {
      assert.deepEqual(play(builtin), play(native));
    } finally {
      native.close();
      builtin.close();
    }
  });

  it("事务能提交、能回滚，而且允许嵌套", () => {
    const database = openDatabase(":memory:");
    try {
      seed(database);
      const store = new ChangeStore(database, { now: () => new Date(AT) });

      // 外层套内层 —— turn-loop 里就是这么用的，裸 BEGIN 在这儿会抛。
      database.transaction(() => {
        database.transaction(() => { store.create("CHG-KEEP"); })();
      })();
      assert.equal(store.read("CHG-KEEP").seq, 0);

      assert.throws(() => database.transaction(() => {
        store.create("CHG-GONE");
        throw new Error("boom");
      })());
      assert.throws(() => store.read("CHG-GONE"));

      // 回滚过一次之后，事务还能继续用（存点没堆在栈上）。
      database.transaction(() => { store.create("CHG-AFTER"); })();
      assert.equal(store.read("CHG-AFTER").seq, 0);
    } finally {
      database.close();
    }
  });

  it("没顶到的成员当场抛，不静默返回 undefined", () => {
    const database = openDatabase(":memory:");
    try {
      assert.throws(
        () => (database as unknown as { backup: () => void }).backup(),
        /没有顶 `backup`/,
      );
    } finally {
      database.close();
    }
  });
});
