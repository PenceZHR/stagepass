import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "./change-store";
import { BindingStore, ThreadAlreadyBoundError } from "./binding-store";

/**
 * 绑定这一层的两种座位：round（阶段线程）和 aside（旁路会话，§3.3）。
 *
 * round 那半在 panel-server / round-turn-runner 的测试里早有覆盖；这个文件
 * 钉的是 aside 加进来之后**两边互不越界**：aside 不占阶段的座、一个 Change
 * 只有一条 aside、一条线程不许同时坐两个座。
 */

function open() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ChangeStore(database).create("CHG-1");
  return { database, bindings: new BindingStore(database) };
}

describe("store · 旁路会话的绑定（kind = aside）", () => {
  it("绑得上、找得到、解得开 —— 而且不占任何阶段的座", () => {
    const { database, bindings } = open();
    try {
      bindings.bindAside("CHG-1", "T-ASIDE");
      assert.deepEqual(bindings.findAside("CHG-1"),
        { threadId: "T-ASIDE", status: "bound" });
      // 阶段那边一个字都看不见它 —— aside 的 phase 是 NULL。
      assert.equal(bindings.find("CHG-1", "PRD"), null);

      bindings.detachAside("CHG-1");
      assert.equal(bindings.findAside("CHG-1")?.status, "detached");
    } finally {
      database.close();
    }
  });

  it("一个 Change 只有一条 aside —— 重绑是换线程，不是长出第二条", () => {
    const { database, bindings } = open();
    try {
      bindings.bindAside("CHG-1", "T-1");
      bindings.detachAside("CHG-1");
      bindings.bindAside("CHG-1", "T-2");
      assert.deepEqual(bindings.findAside("CHG-1"),
        { threadId: "T-2", status: "bound" });
      const rows = database.prepare(
        "SELECT COUNT(*) AS n FROM change_bindings WHERE kind = 'aside'",
      ).get() as { n: number };
      assert.equal(rows.n, 1, "长出了第二条 aside —— 收敛 brief 就不知道读哪条了");
    } finally {
      database.close();
    }
  });

  it("**一条线程不许同时坐两个座** —— aside 占着的线程，round 绑它要抛", () => {
    // 两个座位往同一个 rollout 追加，「哪一轮是我的」就没有答案了（§6.4 坑 2）。
    const { database, bindings } = open();
    try {
      bindings.bindAside("CHG-1", "T-SHARED");
      assert.throws(
        () => bindings.bind("CHG-1", "PRD", "T-SHARED"),
        ThreadAlreadyBoundError,
      );
      // 反方向同理。
      bindings.bind("CHG-1", "Spec", "T-ROUND");
      assert.throws(
        () => bindings.bindAside("CHG-1", "T-ROUND"),
        ThreadAlreadyBoundError,
      );
    } finally {
      database.close();
    }
  });

  it("同一条 (change, thread) 重复 bindAside 是幂等的", () => {
    const { database, bindings } = open();
    try {
      bindings.bindAside("CHG-1", "T-A");
      assert.doesNotThrow(() => { bindings.bindAside("CHG-1", "T-A"); });
    } finally {
      database.close();
    }
  });

  it("round 的绑定语义一个字没变 —— 换线程要先 detach", () => {
    const { database, bindings } = open();
    try {
      bindings.bind("CHG-1", "PRD", "T-1");
      assert.throws(
        () => bindings.bind("CHG-1", "PRD", "T-2"),
        ThreadAlreadyBoundError,
      );
      bindings.detach("CHG-1", "PRD");
      assert.doesNotThrow(() => bindings.bind("CHG-1", "PRD", "T-2"));
    } finally {
      database.close();
    }
  });
});
