import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "./change-store";
import { AsideStore } from "./aside-store";

/**
 * 旁路账本（彗星，2026-08-11）。
 *
 * 这里钉的是那条判据本身：**动了手才要理由**。它是整张表存在的理由 ——
 * 轻的用法（问个名词）要保持轻，而环外改过树的那种必须留得下痕，否则下游会
 * 对着一份来历不明的代码干活。
 */

const CHANGE = "CHG-A";
const AT = "2026-08-11T00:00:00.000Z";

function open() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ChangeStore(database, { now: () => new Date(AT) }).create(CHANGE);
  return { database, aside: new AsideStore(database, () => new Date(AT)) };
}

describe("L1 · 旁路账本：动了手才要理由", () => {
  it("**只聊过 —— 照记一趟，但不追问**", () => {
    const { aside } = open();
    aside.open(CHANGE, "sha-before");
    const settled = aside.close(CHANGE, "sha-before");
    assert.equal(settled?.visit.touched, false);
    assert.equal(settled?.needsNote, false, "只聊过却要人写理由，轻的用法就变重了");
    assert.equal(aside.list(CHANGE).length, 1, "来过这一趟本身也该留下");
  });

  it("**动过手 —— 必须写一句**", () => {
    const { aside } = open();
    aside.open(CHANGE, "sha-before");
    const settled = aside.close(CHANGE, "sha-after");
    assert.equal(settled?.visit.touched, true);
    assert.equal(settled?.needsNote, true, "环外改了树却不留痕，下游就不知道发生过什么");
  });

  it("**HEAD 读不到时不追问** —— 「拿不到」和「没变」是两件事", () => {
    const { aside } = open();
    aside.open(CHANGE, null);          // 不是 git 仓库 / 项目没路径
    const settled = aside.close(CHANGE, null);
    assert.equal(settled?.visit.touched, false);
    assert.equal(settled?.needsNote, false, "读不到 HEAD 就逼人写理由，等于替他承认做过事");
  });

  it("理由写进去之后就不再欠着；空话拒收", () => {
    const { aside } = open();
    const visit = aside.open(CHANGE, "a");
    aside.close(CHANGE, "b");
    assert.equal(aside.note(CHANGE, visit.seq, "   "), false, "空白也算一句话了");
    assert.equal(aside.note(CHANGE, visit.seq, "  修了测试自己启动 GUI 的死循环  "), true);
    assert.equal(aside.read(CHANGE, visit.seq)?.note, "修了测试自己启动 GUI 的死循环");
  });

  it("开着的时候再开是同一趟（幂等）—— 每点一次侧栏不该记一趟空账", () => {
    const { aside } = open();
    const first = aside.open(CHANGE, "a");
    const again = aside.open(CHANGE, "a");
    assert.equal(again.seq, first.seq);
    assert.equal(aside.list(CHANGE).length, 1);
  });

  it("关一个没开着的 —— 什么都不做，不造账", () => {
    const { aside } = open();
    assert.equal(aside.close(CHANGE, "a"), null);
    assert.deepEqual(aside.list(CHANGE), []);
  });

  it("一趟接一趟，序号往下排；尾迹只数动过手的那几趟", () => {
    const { aside } = open();
    aside.open(CHANGE, "a"); aside.close(CHANGE, "a");      // 只聊过
    aside.open(CHANGE, "a"); aside.close(CHANGE, "b");      // 动过手
    aside.open(CHANGE, "b"); aside.close(CHANGE, "c");      // 动过手
    const visits = aside.list(CHANGE);
    assert.deepEqual(visits.map((each) => each.seq), [1, 2, 3]);
    assert.equal(visits.filter((each) => each.touched).length, 2);
  });
});
