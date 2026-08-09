import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "./change-store";
import { ParallelStore, ParallelSeatError } from "./parallel-store";

/**
 * 并行座位（批 3）：小状态机、一座一行，以及**收编** —— 主线走到一个开着的
 * 座位上时，座位的进度变成主状态、座位消失。收编是这个模型的全部出口，
 * 所以它和状态机同一个文件里钉住。
 */

const CHANGE = "CHG-P3";

function open() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  const changes = new ChangeStore(database);
  changes.create(CHANGE);
  return { database, changes, seats: new ParallelStore(database) };
}

/** 主线推进到 target。和 panel 测试里的 advanceTo 同一个走法。 */
function advanceTo(changes: ChangeStore, target: string): void {
  for (let guard = 0; changes.read(CHANGE).state.phase !== target; guard += 1) {
    assert.ok(guard < 20, `${target} was not reached`);
    changes.apply(CHANGE, "start");
    changes.apply(CHANGE, "settle");
    changes.apply(CHANGE, "approve");
  }
}

describe("store · 并行座位的小状态机", () => {
  it("开座、跑、结算 —— 主线一个字都不动", () => {
    const { database, changes, seats } = open();
    try {
      advanceTo(changes, "TestPlan");
      const before = changes.read(CHANGE);

      seats.open(CHANGE, "Build");
      seats.apply(CHANGE, "Build", "start");
      assert.equal(seats.find(CHANGE, "Build")?.status, "running");
      seats.apply(CHANGE, "Build", "settle");
      assert.equal(seats.find(CHANGE, "Build")?.status, "settled");

      const after = changes.read(CHANGE);
      assert.equal(after.state.phase, before.state.phase, "主线被座位动了");
      assert.equal(after.seq, before.seq, "座位的一步跑进主线的账本里去了");
    } finally {
      database.close();
    }
  });

  it("重复开座抛；非法的一步抛 —— 和主线 transition 同一条纪律", () => {
    const { database, seats } = open();
    try {
      seats.open(CHANGE, "Build");
      assert.throws(() => seats.open(CHANGE, "Build"), ParallelSeatError);
      // pending 只收 start。
      assert.throws(
        () => seats.apply(CHANGE, "Build", "settle"), ParallelSeatError);
      // blocked 之后 retry 有路。
      seats.apply(CHANGE, "Build", "start");
      seats.apply(CHANGE, "Build", "fail");
      assert.equal(seats.apply(CHANGE, "Build", "retry").status, "running");
    } finally {
      database.close();
    }
  });
});

describe("store · 主线走到座位上：收编（批 3 的出口）", () => {
  it("**座位 settled，主线到达就是 settled** —— 并行跑过的轮不用重跑", () => {
    const { database, changes, seats } = open();
    try {
      advanceTo(changes, "TestPlan");
      seats.open(CHANGE, "Build");
      seats.apply(CHANGE, "Build", "start");
      seats.apply(CHANGE, "Build", "settle");

      // 主线批准 TestPlan，推荐落点正是 Build。
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "settle");
      changes.apply(CHANGE, "approve");

      const state = changes.read(CHANGE).state;
      assert.equal(state.phase, "Build");
      assert.equal(state.status, "settled",
        "收编丢了 —— 并行跑完的进度被一个 pending 盖掉，人得白跑一遍");
      assert.equal(seats.find(CHANGE, "Build"), null, "座位收编之后还占着行");
      // 账本说真话：这一步收编了并行进度。
      const last = changes.ledger(CHANGE).at(-1)!;
      assert.equal(last.to.status, "settled");
      assert.equal(last.reason, "adopted_parallel_progress");
    } finally {
      database.close();
    }
  });

  it("没开座位的到达一切照旧 —— pending，账本没有收编的说法", () => {
    const { database, changes } = open();
    try {
      advanceTo(changes, "TestPlan");
      changes.apply(CHANGE, "start");
      changes.apply(CHANGE, "settle");
      changes.apply(CHANGE, "approve");
      const state = changes.read(CHANGE).state;
      assert.equal(state.phase, "Build");
      assert.equal(state.status, "pending");
      assert.equal(changes.ledger(CHANGE).at(-1)!.reason, null);
    } finally {
      database.close();
    }
  });
});
