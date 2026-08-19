import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ThreadHistory } from "../codex/app-server-history";
import { awaitTurnByPolling, TurnWatchError } from "./await-turn";

const thread = (turns: { status: string; agentText: string }[]): ThreadHistory => ({
  id: "T-1",
  parentThreadId: null,
  status: "open",
  turns: turns.map((each, index) => ({
    id: `TURN-${index}`,
    status: each.status as "completed",
    userMessages: [],
    agentText: each.agentText,
    allText: each.agentText,
  })),
  turnCount: turns.length,
  userMessages: [],
  allText: "",
  lastCompletedText: [...turns].reverse().find((each) => each.status === "completed")?.agentText ?? null,
  childThreadIds: [],
  contextUsage: null,
});

/** 轮询用的假时钟：不真睡，只记睡了几次。 */
function fakeClock() {
  let at = 0;
  const naps: number[] = [];
  return {
    naps,
    now: () => at,
    sleep: async (ms: number) => { at += ms; naps.push(ms); },
  };
}

/**
 * 不订阅之后，「这一轮跑完了没」只能轮询着问 —— 而这一段是整条改动里**唯一新写的逻辑**
 * （见 `docs/DESIGN-thread-ownership-2026-08-18.md` §八）。
 *
 * 它承的是一轮 60~343 分钟的结算：判早了，这一轮的结论是空的；判不出来，那一轮永远
 * 挂着。所以每一种下场都要有测试。
 */
describe("plugin · 不订阅之后怎么知道一轮跑完了", () => {
  it("多出来的那一轮跑完了 —— 交出它说的话", async () => {
    const clock = fakeClock();
    const answers = [
      thread([{ status: "completed", agentText: "上一轮" }]),
      thread([
        { status: "completed", agentText: "上一轮" },
        { status: "inProgress", agentText: "" },
      ]),
      thread([
        { status: "completed", agentText: "上一轮" },
        { status: "completed", agentText: "这一轮的结论" },
      ]),
    ];
    let call = 0;

    const done = await awaitTurnByPolling({
      history: { readThread: async () => answers[Math.min(call++, answers.length - 1)]! },
      threadId: "T-1",
      baselineTurns: 1,
      timeoutMs: 60_000,
      everyMs: 1_000,
      ...clock,
    });

    assert.equal(done.text, "这一轮的结论");
  });

  /*
   * **打的是最贵的那个错**：把「读不到线程」当成「跑完了」。
   *
   * 那样这一轮的结论会变成一段空文本，而下游（`readConclusion` / `readVerdicts`）
   * 会把它读成「模型什么都没说」—— 一次网络抖动就能伪造出一轮失败的对抗。
   */
  it("读不出线程时继续等，绝不当成「跑完了」", async () => {
    const clock = fakeClock();
    let call = 0;

    const done = await awaitTurnByPolling({
      history: {
        readThread: async () => {
          call += 1;
          if (call < 3) return null;
          return thread([
            { status: "completed", agentText: "旧的" },
            { status: "completed", agentText: "新的" },
          ]);
        },
      },
      threadId: "T-1",
      baselineTurns: 1,
      timeoutMs: 60_000,
      everyMs: 1_000,
      ...clock,
    });

    assert.equal(done.text, "新的");
    assert.equal(call >= 3, true, "读不到的那两次不该被当成结果");
  });

  /** 读一次炸一次也不该让这一轮失败 —— daemon 抖一下不等于这一轮完了。 */
  it("读的时候抛异常就接着等", async () => {
    const clock = fakeClock();
    let call = 0;

    const done = await awaitTurnByPolling({
      history: {
        readThread: async () => {
          call += 1;
          if (call === 1) throw new Error("daemon 抖了一下");
          return thread([
            { status: "completed", agentText: "旧的" },
            { status: "completed", agentText: "新的" },
          ]);
        },
      },
      threadId: "T-1",
      baselineTurns: 1,
      timeoutMs: 60_000,
      everyMs: 1_000,
      ...clock,
    });

    assert.equal(done.text, "新的");
  });

  /** 那一轮失败/被打断也是**结局**，不是「还没完」—— 不报出来的话它会一直等到超时。 */
  it("那一轮失败了就说失败，不接着等", async () => {
    const clock = fakeClock();

    await assert.rejects(
      awaitTurnByPolling({
        history: {
          readThread: async () => thread([
            { status: "completed", agentText: "旧的" },
            { status: "failed", agentText: "" },
          ]),
        },
        threadId: "T-1",
        baselineTurns: 1,
        timeoutMs: 60_000,
        everyMs: 1_000,
        ...clock,
      }),
      (error: unknown) => error instanceof TurnWatchError && error.code === "turn_failed",
    );
  });

  it("等过头要说等了多久，不能只说「超时」", async () => {
    const clock = fakeClock();

    await assert.rejects(
      awaitTurnByPolling({
        history: { readThread: async () => thread([{ status: "completed", agentText: "旧的" }]) },
        threadId: "T-1",
        baselineTurns: 1,
        timeoutMs: 5_000,
        everyMs: 1_000,
        ...clock,
      }),
      (error: unknown) => error instanceof TurnWatchError
        && error.code === "turn_timeout"
        && error.message.includes("5"),
    );
  });
});
