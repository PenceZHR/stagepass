import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allTextIn,
  findCompletedTurn,
  parseRollout,
  threadIdFromRolloutName,
  findLastCompletedTurn,
} from "./rollout";

/**
 * Built from records captured out of a real session file on 0.144.4, so the
 * shapes are what Codex writes rather than what they were assumed to be.
 */
const line = (payload: object) =>
  JSON.stringify({ timestamp: "2026-07-28T22:07:15.000Z", type: "event_msg", payload });

const started = line({ type: "task_started" });
const complete = line({ type: "task_complete" });
const user = (text: string) => line({ type: "user_message", message: text });
const agent = (text: string) => line({ type: "agent_message", message: text });

describe("L2 · reading a session file", () => {
  it("skips a half-written last line instead of failing", () => {
    // Normal, not exceptional: the file is appended to while it is read.
    const records = parseRollout(`${started}\n${agent("hi")}\n{"type":"event_m`);
    assert.equal(records.length, 2);
  });

  it("ignores blank lines", () => {
    assert.equal(parseRollout(`\n${started}\n\n${complete}\n`).length, 2);
  });

  it("takes the thread id from the filename", () => {
    assert.equal(
      threadIdFromRolloutName(
        "rollout-2026-07-28T22-07-10-019faba0-33e3-7141-b44d-f8a067e4d8c6.jsonl",
      ),
      "019faba0-33e3-7141-b44d-f8a067e4d8c6",
    );
    for (const name of ["notes.txt", "rollout-2026-07-28.jsonl", "rollout--.jsonl"]) {
      assert.equal(threadIdFromRolloutName(name), null, name);
    }
  });
});

describe("L2 · finding the turn StagePass asked for", () => {
  it("returns what the model said once the turn completes", () => {
    const records = parseRollout([
      started, user("do the thing"), agent("done"), complete,
    ].join("\n"));
    assert.deepEqual(findCompletedTurn(records, 0), { text: "done" });
  });

  it("returns nothing while the turn is still running", () => {
    const records = parseRollout([started, user("go"), agent("working")].join("\n"));
    assert.equal(findCompletedTurn(records, 0), null);
  });

  /**
   * The trap this exists for. A rollout accumulates every turn the thread ever
   * had, and `codex resume` appends to the same file -- so a scan from zero
   * returns the answer to the PREVIOUS question, which would look like a
   * suspiciously fast, suspiciously wrong turn.
   */
  it("does not return an earlier turn's answer", () => {
    const text = [
      started, user("first question"), agent("first answer"), complete,
      started, user("second question"), agent("second answer"), complete,
    ].join("\n");
    const records = parseRollout(text);
    assert.deepEqual(findCompletedTurn(records, 0), { text: "first answer" });
    // Asked after the first turn was already on disk: only the second counts.
    assert.deepEqual(findCompletedTurn(records, 4), { text: "second answer" });
  });

  it("waits when the file only holds turns that finished before we asked", () => {
    const records = parseRollout([
      started, user("old"), agent("old answer"), complete,
    ].join("\n"));
    assert.equal(findCompletedTurn(records, 4), null);
  });

  it("joins everything the model said in one turn", () => {
    const records = parseRollout([
      started, user("go"), agent("part one"), agent("part two"), complete,
    ].join("\n"));
    assert.deepEqual(findCompletedTurn(records, 0), { text: "part one\npart two" });
  });

  /**
   * An abandoned turn must not leak its text into the next one -- otherwise a
   * retry after a crash answers with a mixture of both attempts.
   */
  it("drops an unfinished turn when a new one starts", () => {
    const records = parseRollout([
      started, agent("abandoned"),
      started, agent("real"), complete,
    ].join("\n"));
    assert.deepEqual(findCompletedTurn(records, 0), { text: "real" });
  });

  it("ignores records that are not turn events", () => {
    const records = parseRollout([
      JSON.stringify({ type: "response_item", payload: { type: "message" } }),
      started,
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
      agent("answer"),
      complete,
    ].join("\n"));
    assert.deepEqual(findCompletedTurn(records, 0), { text: "answer" });
  });

  it("completes with empty text rather than hanging when nothing was said", () => {
    const records = parseRollout([started, complete].join("\n"));
    assert.deepEqual(findCompletedTurn(records, 0), { text: "" });
  });
});

/**
 * 一条 rollout 里累积了好几轮时，**最后那一轮**是谁说的。
 *
 * ## 为什么非要有这个
 *
 * 2026-07-30 在真 Codex 上撞到的：子 Agent 的线程**跨轮复用**，`/root/red` 那条
 * rollout 里同时有第 2 轮和第 3 轮的答案。而 `readRoleTranscript` 一直传
 * `fromIndex: 0` —— 于是**第二轮起，StagePass 读到的一直是第一轮红蓝说的话**。
 *
 * 症状极隐蔽：轮次照常结算，gap 看着也合理，只是内容永远停在第一轮。当天实测里
 * 红方第 3 轮明明读完文档、报了一条新的 P0（Plan 的时区闸门没关，禁止创建
 * index.html），而库里记下来的还是第 2 轮那句「五份文件不存在」。
 *
 * `findCompletedTurn` 的注释早就写着这个坑（「rollout 会累积每一轮，resume 往同一个
 * 文件追加」），护栏一直在，只是子 Agent 那一侧没用上。而那一侧**不知道**问之前有
 * 几条记录（它不盯子 Agent 的文件），所以只能取最后一个。
 */
describe("rollout · 累积了好几轮时取最后一轮", () => {
  it("**取最后一个完成的 turn，不是第一个**", () => {
    const text = [
      started, user("第 2 轮"), agent("第二轮的答案"), complete,
      started, user("第 3 轮"), agent("第三轮的答案"), complete,
    ].join("\n");
    assert.deepEqual(
      findLastCompletedTurn(parseRollout(text)),
      { text: "第三轮的答案" },
    );
  });

  it("最后一轮还没跑完 —— 给上一个跑完的，不给半截的", () => {
    // 半截的那一轮不是「这一轮的答案」，把它交出去等于把没说完的话当成结论。
    const text = [
      started, agent("第二轮的答案"), complete,
      started, agent("第三轮说到一半"),
    ].join("\n");
    assert.deepEqual(
      findLastCompletedTurn(parseRollout(text)),
      { text: "第二轮的答案" },
    );
  });

  it("一轮都没跑完 —— null，不是空字符串", () => {
    assert.equal(findLastCompletedTurn(parseRollout([started, agent("在说")].join("\n"))), null);
  });

  it("只有一轮时和从头读一样", () => {
    const records = parseRollout([started, agent("只有这一轮"), complete].join("\n"));
    assert.deepEqual(findLastCompletedTurn(records), findCompletedTurn(records, 0));
  });

  it("一轮里说了好几段 —— 合起来，和 findCompletedTurn 同一个规矩", () => {
    const text = [
      started, agent("旧的"), complete,
      started, agent("第一段"), agent("第二段"), complete,
    ].join("\n");
    assert.deepEqual(
      findLastCompletedTurn(parseRollout(text)),
      { text: "第一段\n第二段" },
    );
  });
});

/**
 * `allTextIn` —— 「这条线程收到过什么」。
 *
 * 记录形状取自 2026-07-31 真实读过的一条子 Agent rollout：转达进来的提示词同时落在
 * `event_msg/user_message` 和 `response_item/message` 两种记录上。
 */
describe("L2 · 这条线程收到过什么", () => {
  const responseItem = (role: string, text: string) => JSON.stringify({
    timestamp: "2026-07-30T18:40:34.000Z",
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  });

  it("**收到的和说过的都算** —— 它答不了的问题正是「有没有收到」", () => {
    const text = [started, user("这是转达进来的任务"), agent("这是它自己说的"), complete].join("\n");
    const whole = allTextIn(parseRollout(text));
    assert.ok(whole.includes("这是转达进来的任务"));
    assert.ok(whole.includes("这是它自己说的"));
  });

  it("response_item 的正文也算 —— 提示词同时落在这一种上", () => {
    const whole = allTextIn(parseRollout(responseItem("user", "RBC-abc 这一条标准")));
    assert.ok(whole.includes("RBC-abc"));
  });

  it("**没收到就是没收到** —— 这是 fail-closed 那条链的判据", () => {
    const text = [started, user("你是反方，去挑毛病"), agent("我挑完了"), complete].join("\n");
    assert.equal(allTextIn(parseRollout(text)).includes("RBC-"), false);
  });

  it("`findLastCompletedTurn` 看不见转达进来的话 —— 两个函数不能互相替代", () => {
    const records = parseRollout(
      [started, user("契约 RBC-abc 在这里"), agent("我没答"), complete].join("\n"),
    );
    assert.equal(findLastCompletedTurn(records)!.text.includes("RBC-abc"), false);
    assert.ok(allTextIn(records).includes("RBC-abc"));
  });

  it("空记录给空串，不是抛", () => {
    assert.equal(allTextIn([]), "");
  });
});
