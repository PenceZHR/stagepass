import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "./change-store";
import type { WorkItemDraft } from "../domain/worklist";
import { WorklistStore } from "./worklist-store";

const AT = "2026-08-02T00:00:00.000Z";
const CHANGE = "CHG-W";

function open() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ChangeStore(database, { now: () => new Date(AT) }).create(CHANGE);
  return { database, store: new WorklistStore(database, () => new Date(AT)) };
}

const gap = (target: string, prompt: string): WorkItemDraft => ({
  kind: "gap", target, prompt, choices: ["closed", "still_open"],
});
const criterion = (target: string, prompt: string): WorkItemDraft => ({
  kind: "criterion", target, prompt, choices: ["yes", "no"],
});

describe("L3 · 裁判逐条表态的名单", () => {
  it("按顺序问，答一条推进一条", () => {
    const { store } = open();
    store.open(CHANGE, "PRD", 1, [gap("G-1", "第一个问题"), gap("G-2", "第二个问题")]);

    assert.equal(store.next(CHANGE)?.prompt, "第一个问题");
    assert.deepEqual(store.answer(CHANGE, "closed", "修好了"), { kind: "recorded", remaining: 1 });
    assert.equal(store.next(CHANGE)?.prompt, "第二个问题");
    assert.deepEqual(store.answer(CHANGE, "still_open", "还在"), { kind: "recorded", remaining: 0 });
    assert.equal(store.next(CHANGE), null);
  });

  it("**`target` 是给上层看的，`prompt` 是给模型看的** —— 这就是整套机制", () => {
    const { store } = open();
    store.open(CHANGE, "PRD", 1, [gap("RB:critic:RBC-0123-4567-89ab", "标准的正文")]);

    const item = store.next(CHANGE)!;
    assert.equal(item.target, "RB:critic:RBC-0123-4567-89ab");
    // 模型看到的那段话里**不许**出现那个 id —— 出现了它就会去抄。
    assert.equal(item.prompt.includes("RBC-"), false);
  });

  it("还剩几项要说得出来 —— 模型得知道什么时候停", () => {
    const { store } = open();
    store.open(CHANGE, "PRD", 1, [gap("G-1", "a"), gap("G-2", "b"), gap("G-3", "c")]);
    assert.equal(store.next(CHANGE)?.total, 3);
    assert.equal(store.next(CHANGE)?.ordinal, 1);
  });

  it("**答不在名单里的值 —— 拒掉，并把允许的值原样回给它**", () => {
    const { store } = open();
    store.open(CHANGE, "PRD", 1, [gap("G-1", "问题")]);

    assert.deepEqual(store.answer(CHANGE, "满足", "我觉得可以"), {
      kind: "bad_answer", choices: ["closed", "still_open"],
    });
    // 拒掉之后这一条**仍然没答** —— 它还得回来答。
    assert.equal(store.next(CHANGE)?.ordinal, 1);
  });

  it("**没有理由不算答** —— 一句沉默和一句「已修复」信息量一样", () => {
    const { store } = open();
    store.open(CHANGE, "PRD", 1, [gap("G-1", "问题")]);
    assert.deepEqual(store.answer(CHANGE, "closed", "   "), { kind: "no_reason" });
    assert.equal(store.next(CHANGE)?.ordinal, 1);
  });

  it("名单都答完了还来答 —— 说清楚没有可答的了，不是静默成功", () => {
    const { store } = open();
    store.open(CHANGE, "PRD", 1, [gap("G-1", "问题")]);
    store.answer(CHANGE, "closed", "修了");
    assert.deepEqual(store.answer(CHANGE, "closed", "再来一次"), { kind: "nothing_open" });
  });

  it("gap 和 criterion 各自只认自己的那两个值", () => {
    const { store } = open();
    store.open(CHANGE, "PRD", 1, [criterion("RBC-1", "这条标准满足没有")]);
    assert.deepEqual(store.answer(CHANGE, "closed", "x"), {
      kind: "bad_answer", choices: ["yes", "no"],
    });
    assert.deepEqual(store.answer(CHANGE, "yes", "有依据"), { kind: "recorded", remaining: 0 });
  });

  it("**开一份新的会把上一份关掉** —— 上一轮的剩饭不许漏到这一轮", () => {
    // 没有这一条，裁判这一轮会被喂上一轮没答完的条目，而那些 gap 可能早关了。
    const { store } = open();
    store.open(CHANGE, "PRD", 1, [gap("G-1", "上一轮的"), gap("G-2", "上一轮的")]);
    store.answer(CHANGE, "closed", "只答了一条");

    store.open(CHANGE, "PRD", 2, [gap("G-9", "这一轮的")]);
    assert.equal(store.next(CHANGE)?.prompt, "这一轮的");
    store.answer(CHANGE, "still_open", "还在");
    assert.equal(store.next(CHANGE), null, "上一轮没答完的漏过来了");
  });

  it("别的 Change 开了名单也会把这一份关掉 —— 全库至多一份开着", () => {
    const { database, store } = open();
    new ChangeStore(database, { now: () => new Date(AT) }).create("CHG-OTHER");
    store.open(CHANGE, "PRD", 1, [gap("G-1", "这一个 Change 的")]);
    store.open("CHG-OTHER", "PRD", 1, [gap("G-2", "另一个 Change 的")]);

    // 这一份被关掉了，所以按自己的 changeId 问也什么都没有。
    assert.equal(store.next(CHANGE), null);
    assert.equal(store.next("CHG-OTHER")?.prompt, "另一个 Change 的");
  });

  it("空名单也照开 —— 「没什么要表态的」和「名单没开出来」是两件事", () => {
    const { store } = open();
    store.open(CHANGE, "PRD", 1, [gap("G-1", "上一轮的")]);
    store.open(CHANGE, "PRD", 2, []);
    assert.equal(store.next(CHANGE), null);
  });

  it("答完之后读得回来，顺序和答案都在", () => {
    const { store } = open();
    store.open(CHANGE, "PRD", 1, [gap("G-1", "a"), criterion("RBC-1", "b")]);
    store.answer(CHANGE, "closed", "修了");
    store.answer(CHANGE, "no", "没做到");

    assert.deepEqual(store.read(CHANGE, "PRD", 1).map((item) => ({
      target: item.target, answer: item.answer, reason: item.reason,
    })), [
      { target: "G-1", answer: "closed", reason: "修了" },
      { target: "RBC-1", answer: "no", reason: "没做到" },
    ]);
  });

  it("没答的读回来是 null —— 和「答了但没理由」区分得开", () => {
    const { store } = open();
    store.open(CHANGE, "PRD", 1, [gap("G-1", "a"), gap("G-2", "b")]);
    store.answer(CHANGE, "closed", "修了");

    const read = store.read(CHANGE, "PRD", 1);
    assert.equal(read[1]!.answer, null);
    assert.equal(read[1]!.reason, null);
  });

  it("close 之后 next 就空了，而且可以重复调", () => {
    const { store } = open();
    store.open(CHANGE, "PRD", 1, [gap("G-1", "a")]);
    store.close(CHANGE, "PRD", 1);
    store.close(CHANGE, "PRD", 1);
    assert.equal(store.next(CHANGE), null);
    // 关掉不等于抹掉 —— 账还在。
    assert.equal(store.read(CHANGE, "PRD", 1).length, 1);
  });
});
