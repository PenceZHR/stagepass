import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "./change-store";
import { RoundNoteStore } from "./round-note-store";

/**
 * 一轮里那两句只写给人看的话。
 *
 * 用户 2026-07-31：「每对抗一轮，我都是要知情的。」逐条判定说得出「第 3 条没勾上」，
 * 说不出「加起来还差在哪」—— 这两句补的是那一格。哪一句都不动闸门。
 */

const AT = "2026-07-31T00:00:00.000Z";

function open() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  const now = () => new Date(AT);
  new ChangeStore(database, { now }).create("CHG-1");
  return { database, notes: new RoundNoteStore(database, now) };
}

describe("L3 · 一轮里写给人看的那两句", () => {
  it("裁判的结论存得下，带着「还要不要再来一轮」", () => {
    const { notes } = open();
    notes.put("CHG-1", "Build", 2, {
      source: "judge_conclusion", anotherRound: true, text: "运行证据还不完整",
    });
    assert.deepEqual(notes.read("CHG-1", "Build", 2), [{
      round: 2, source: "judge_conclusion", anotherRound: true,
      text: "运行证据还不完整", createdAt: AT,
    }]);
  });

  it("反方那句整体判断没有 another_round —— 它是印象，不是建议", () => {
    const { notes } = open();
    notes.put("CHG-1", "Build", 1, { source: "blue_overall", text: "整体够格" });
    assert.equal(notes.read("CHG-1", "Build", 1)[0]!.anotherRound, null);
  });

  it("**给反方那句硬塞一个 another_round —— 数据库拒**（配对 CHECK）", () => {
    const { database, notes } = open();
    notes.put("CHG-1", "Build", 1, { source: "blue_overall", text: "整体够格" });
    assert.throws(() => database.prepare(
      `INSERT INTO round_notes
         (change_id, phase, round, source, another_round, text, created_at)
       VALUES ('CHG-1','Build',2,'blue_overall',1,'编一个','${AT}')`,
    ).run());
  });

  /**
   * 反过来那半边**不**成立，而且必须不成立。
   *
   * 裁判给了结论却写坏了的时候，「还要不要再来一轮」这个问题没有答案。逼它记 0，
   * 界面就会渲染成「可以了」—— 那是替裁判说了一句它没说过的话。
   */
  it("**裁判的结论可以没有 another_round** —— 读不出来时它就是没有答案", () => {
    const { notes } = open();
    notes.put("CHG-1", "Build", 1, {
      source: "judge_conclusion", anotherRound: null,
      text: "裁判给了结论但读不出来：{\"another_round\":\"也许\"}",
    });
    const read = notes.read("CHG-1", "Build", 1)[0]!;
    assert.equal(read.anotherRound, null);
    assert.match(read.text, /读不出来/);
  });

  it("同一轮同一来源写两次是覆盖 —— 一轮里裁判只有一个结论", () => {
    const { notes } = open();
    notes.put("CHG-1", "Build", 1, { source: "judge_conclusion", anotherRound: true, text: "先" });
    notes.put("CHG-1", "Build", 1, { source: "judge_conclusion", anotherRound: false, text: "后" });
    const read = notes.read("CHG-1", "Build", 1);
    assert.equal(read.length, 1);
    assert.deepEqual([read[0]!.text, read[0]!.anotherRound], ["后", false]);
  });

  it("**跨轮不覆盖** —— 回头看第 2 轮怎么说，是判断有没有进展的唯一依据", () => {
    const { notes } = open();
    notes.put("CHG-1", "Build", 2, { source: "judge_conclusion", anotherRound: true, text: "第二轮" });
    notes.put("CHG-1", "Build", 3, { source: "judge_conclusion", anotherRound: false, text: "第三轮" });
    assert.equal(notes.read("CHG-1", "Build", 2)[0]!.text, "第二轮");
    assert.equal(notes.read("CHG-1", "Build", 3)[0]!.text, "第三轮");
  });

  it("latest 给最近一轮，而且两句取自同一轮", () => {
    const { notes } = open();
    notes.put("CHG-1", "Build", 2, { source: "judge_conclusion", anotherRound: true, text: "旧的" });
    notes.put("CHG-1", "Build", 4, { source: "judge_conclusion", anotherRound: false, text: "新的" });
    notes.put("CHG-1", "Build", 4, { source: "blue_overall", text: "整体可以" });
    const latest = notes.latest("CHG-1", "Build");
    assert.deepEqual(latest.map((each) => each.round), [4, 4]);
    assert.deepEqual(latest.map((each) => each.text), ["整体可以", "新的"]);
  });

  it("一轮都没跑过 —— 空数组，不是抛", () => {
    const { notes } = open();
    assert.deepEqual(notes.latest("CHG-1", "Build"), []);
    assert.deepEqual(notes.read("CHG-1", "Build", 1), []);
  });

  it("**空话不存** —— 反方没写整体判断是常态，不是错误", () => {
    const { notes } = open();
    notes.put("CHG-1", "Build", 1, { source: "blue_overall", text: "   " });
    assert.deepEqual(notes.read("CHG-1", "Build", 1), []);
  });

  it("两个阶段互不干扰", () => {
    const { notes } = open();
    notes.put("CHG-1", "Build", 1, { source: "blue_overall", text: "Build 的" });
    notes.put("CHG-1", "Review", 1, { source: "blue_overall", text: "Review 的" });
    assert.equal(notes.read("CHG-1", "Build", 1)[0]!.text, "Build 的");
    assert.equal(notes.read("CHG-1", "Review", 1)[0]!.text, "Review 的");
  });
});
