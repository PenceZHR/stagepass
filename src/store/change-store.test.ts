import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { IllegalTransitionError } from "../domain/change-state";
import { ChangeNotFoundError, ChangeStore } from "./change-store";

/**
 * L0's other half: the ledger cannot be bypassed.
 *
 * In-memory SQLite, a fixed clock, no network, no model. Same rule as the
 * domain tests -- if the foundation needs the things built on it in order to be
 * proved, it is not a foundation.
 */

const AT = "2026-07-28T00:00:00.000Z";

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
        returnPhase: null,
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
        phase: "PRD", status: "pending", returnPhase: null,
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
      // Fix without a return target, inserted straight past the store.
      assert.throws(
        () => database.prepare(
          `INSERT INTO changes
             (id, phase, status, return_phase, seq, created_at, updated_at)
           VALUES ('CHG-BAD', 'Fix', 'pending', NULL, 0, ?, ?)`,
        ).run(AT, AT),
        /CHECK constraint failed/,
      );
      // `closed` on a phase that is not the terminal one.
      assert.throws(
        () => database.prepare(
          `INSERT INTO changes
             (id, phase, status, return_phase, seq, created_at, updated_at)
           VALUES ('CHG-BAD2', 'Spec', 'closed', NULL, 0, ?, ?)`,
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
             (id, phase, status, return_phase, seq, created_at, updated_at)
           VALUES ('CHG-BAD', 'Intake', 'pending', NULL, 0, ?, ?)`,
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
