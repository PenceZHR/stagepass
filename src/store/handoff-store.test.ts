import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "./change-store";
import { HandoffStore } from "./handoff-store";

const AT = "2026-08-19T00:00:00.000Z";
const CHANGE = "CHG-H";

function open() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ChangeStore(database, { now: () => new Date(AT) }).create(CHANGE);
  return new HandoffStore(database, () => new Date(AT));
}

const files = {
  worklist: { listPath: "/tmp/a/list.md", answersPath: "/tmp/a/ans.md", count: 3 },
  blueRubric: { criteriaPath: "/tmp/a/c.md", answersPath: "/tmp/a/ra.md", count: 2 },
  rubricIds: { producer: "RB-1", critic: "RB-2" },
};

const prepared = (round: number) => ({
  changeId: CHANGE, phase: "PRD" as const, round,
  envelope: `你是本轮的裁判。阶段：PRD，第 ${round} 轮。`,
  scriptPath: `/tmp/stagepass-round-xyz/round-script-PRD-r${round}.md`,
  files,
});

describe("L3 · 备好交给人、还没结算的那一轮", () => {
  it("**路径原样存回来** —— 结算时它们一个都推不出来", () => {
    const store = open();
    store.prepare(prepared(1));

    const found = store.waiting(CHANGE, "PRD")!;
    assert.equal(found.scriptPath, "/tmp/stagepass-round-xyz/round-script-PRD-r1.md");
    assert.deepEqual(found.worklist, files.worklist);
    assert.deepEqual(found.blueRubric, files.blueRubric);
    assert.deepEqual(found.rubricIds, files.rubricIds);
    assert.equal(found.status, "waiting");
    assert.equal(found.threadId, null);
  });

  it("这个阶段没备过就是 null —— 不编一个空的出来", () => {
    assert.equal(open().waiting(CHANGE, "PRD"), null);
  });

  it("**同一轮再备一次是覆盖，不是第二条** —— 否则结算要猜他跑的是哪份", () => {
    const store = open();
    store.prepare(prepared(1));
    store.prepare({
      ...prepared(1),
      scriptPath: "/tmp/新的/round-script-PRD-r1.md",
      envelope: "新的信封",
    });

    const found = store.waiting(CHANGE, "PRD")!;
    assert.equal(found.scriptPath, "/tmp/新的/round-script-PRD-r1.md");
    assert.equal(found.envelope, "新的信封");
    assert.equal(store.read(CHANGE, "PRD", 1)?.envelope, "新的信封");
  });

  it("结算之后它不再是「等着的那一轮」，但线程 id 留在它身上", () => {
    const store = open();
    store.prepare(prepared(1));

    store.settled(CHANGE, "PRD", 1, "01a01896-580d-7b02-91c7-70b7aa16b894");

    assert.equal(store.waiting(CHANGE, "PRD"), null, "结算完的不该再等人跑");
    const read = store.read(CHANGE, "PRD", 1)!;
    assert.equal(read.status, "settled");
    assert.equal(read.threadId, "01a01896-580d-7b02-91c7-70b7aa16b894");
    assert.equal(read.settledAt, AT);
  });

  it("**撤掉就是没发生过** —— 不留一条要人分辨的尸体", () => {
    const store = open();
    store.prepare(prepared(1));

    store.discard(CHANGE, "PRD", 1);

    assert.equal(store.waiting(CHANGE, "PRD"), null);
    assert.equal(store.read(CHANGE, "PRD", 1), null);
  });

  it("备了新一轮就等新的那一轮 —— 旧的还开着也不该被认成当前", () => {
    const store = open();
    store.prepare(prepared(1));
    store.prepare(prepared(2));

    assert.equal(store.waiting(CHANGE, "PRD")?.round, 2);
  });
});
