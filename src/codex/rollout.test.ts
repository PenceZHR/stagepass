import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allTextIn,
  contextUsageOf,
  findCompletedTurn,
  parseRollout,
  threadIdFromRolloutName,
  findLastCompletedTurn,
  lineageOf,
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

/**
 * 形状取自 2026-08-02 真会话目录里的 `session_meta`（0.146.0-alpha.3.1），
 * 不是照着猜写的。
 */
describe("L2 · 一条线程的血缘", () => {
  const meta = (payload: object) => JSON.stringify({
    timestamp: "2026-08-02T09:15:29.993Z", type: "session_meta", payload,
  });

  const CHILD = "019fc1c1-c6fb-7f02-84b1-25479d9365a6";
  const PARENT = "019fac13-bc4b-72e2-a20f-89ecd5fff7c4";

  const spawn = { thread_spawn: { parent_thread_id: PARENT, depth: 1 } };
  const subagent = meta({
    session_id: PARENT, id: CHILD, parent_thread_id: PARENT,
    timestamp: "2026-08-02T09:15:29.915Z", thread_source: "subagent",
    source: { subagent: spawn },
  });

  it("子 Agent 报得出它爹是谁", () => {
    assert.deepEqual(lineageOf(parseRollout(subagent)), {
      threadId: CHILD,
      parentThreadId: PARENT,
      startedAt: "2026-08-02T09:15:29.915Z",
    });
  });

  it("裁判自己那条线程没有爹 —— 所以结构上不可能被认成子 Agent", () => {
    const judge = meta({ id: PARENT, thread_source: "user" });
    assert.equal(lineageOf(parseRollout(judge))!.parentThreadId, null);
  });

  it("**光有 parent 不算** —— 将来 resume 之类也填这一列时不许认它", () => {
    // 认错一条，它的话会被当成红方或蓝方的发言写进 gap。
    const resumed = meta({
      id: CHILD, parent_thread_id: PARENT, thread_source: "user",
      source: { subagent: spawn },
    });
    assert.equal(lineageOf(parseRollout(resumed))!.parentThreadId, null);
  });

  it("是 subagent 但没记下爹 —— 也不认", () => {
    const orphan = meta({ id: CHILD, thread_source: "subagent", source: { subagent: spawn } });
    assert.equal(lineageOf(parseRollout(orphan))!.parentThreadId, null);
  });

  it("**不是被 spawn 出来的子 Agent 不算** —— guardian 就是这么一种", () => {
    // 2026-08-02 真会话目录里的形状：Codex 自己派的一种审查子 Agent，同样是
    // thread_source=subagent、同样带 parent。它哪天挂到裁判线程下，就会被当成
    // 红方或蓝方 —— 而 StagePass 会把它说的话写进 gap。
    const guardian = meta({
      id: CHILD, parent_thread_id: PARENT, thread_source: "subagent",
      source: { subagent: { other: "guardian" } },
    });
    assert.equal(lineageOf(parseRollout(guardian))!.parentThreadId, null);
  });

  it("连 source 都没有也不认 —— 三样缺一不可", () => {
    const bare = meta({ id: CHILD, parent_thread_id: PARENT, thread_source: "subagent" });
    assert.equal(lineageOf(parseRollout(bare))!.parentThreadId, null);
  });

  it("id 大小写归一 —— 文件名那条路也是这么做的", () => {
    const upper = meta({
      id: CHILD.toUpperCase(), parent_thread_id: PARENT.toUpperCase(),
      thread_source: "subagent", source: { subagent: spawn },
    });
    const read = lineageOf(parseRollout(upper))!;
    assert.equal(read.threadId, CHILD);
    assert.equal(read.parentThreadId, PARENT);
  });

  it("payload 没有自己的时刻时退回记录的时刻", () => {
    const noInner = meta({
      id: CHILD, parent_thread_id: PARENT, thread_source: "subagent",
      source: { subagent: spawn },
    });
    assert.equal(lineageOf(parseRollout(noInner))!.startedAt, "2026-08-02T09:15:29.993Z");
  });

  it("没有 session_meta 就是读不出来 —— null，不是编一个", () => {
    assert.equal(lineageOf(parseRollout(`${started}\n${agent("hi")}`)), null);
  });

  it("session_meta 里没有 id 也读不出来", () => {
    assert.equal(lineageOf(parseRollout(meta({ thread_source: "subagent" }))), null);
  });
});

describe("L2 · 这条线程离上下文墙多远（§3.3·11）", () => {
  /*
   * 同一条裁判线程跑到第 5 轮，上下文 99,553 / 258,400 = 38.5%，每轮稳定涨约
   * 16k —— 而人看不见自己离墙多远。数据一直在 rollout 里：每次请求后都有一条
   * `token_count`，`last_token_usage` 是**这一次**真实装进上下文的量（input 已含
   * 全部历史）。形状照 2026-08-05 真机 rollout 抄的，不是猜的。
   */
  const tokenCount = (info: unknown): string => JSON.stringify({
    type: "event_msg", payload: { type: "token_count", info },
  });
  const usage = (input: number, output: number): unknown => ({
    last_token_usage: { input_tokens: input, output_tokens: output },
    model_context_window: 258_400,
  });

  it("取最后一个 token_count —— 一条线程一直在长，旧的读了就是假话", () => {
    const records = parseRollout([
      tokenCount(usage(10_000, 200)),
      tokenCount(usage(99_353, 200)),
    ].join("\n"));
    assert.deepEqual(contextUsageOf(records), { used: 99_553, window: 258_400 });
  });

  it("最后一条读不出来就往前找 —— 不因为一条坏行就说不出", () => {
    const records = parseRollout([
      tokenCount(usage(50_000, 100)),
      tokenCount(null),
    ].join("\n"));
    assert.deepEqual(contextUsageOf(records), { used: 50_100, window: 258_400 });
  });

  it("一个 token_count 都没有 —— null，不编一个数", () => {
    assert.equal(contextUsageOf(parseRollout(
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    )), null);
  });
});
