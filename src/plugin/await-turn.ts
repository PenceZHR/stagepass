import type { AppServerHistory } from "../codex/app-server-history";

/**
 * 不订阅之后，「这一轮跑完了没」怎么知道。
 *
 * ## 为什么会有这个文件
 *
 * 2026-08-18 定案（`docs/DESIGN-thread-ownership-2026-08-18.md`）：StagePass 让出订阅权
 * —— 线程归人，人能在 Codex App 里点开、接着打字、自己答审批。代价是拿不到事件流，
 * 于是 `AppServerSession.awaitTurn`（等 `turn/completed` 通知）不再可用。
 *
 * 那份文档盘过全树：**整条改动里唯一要新写的逻辑就是这一段**。别的都现成
 * （裁判说了什么 → `lastCompletedText`，派生了谁 → `childThreadIds`，
 * 两方说了什么 → `readThreadTranscript`），而且本来就走 `thread/read`，不走流。
 *
 * ## 它承的重量
 *
 * 一轮实测 60~343 分钟。**判早了**，这一轮的结论是空的，而下游会把空读成
 * 「模型什么都没说」—— 一次网络抖动就能伪造出一轮失败的对抗。**判不出来**，
 * 那一轮永远挂着。所以这里每一种下场都有名字，没有一种是静默的。
 */

export class TurnWatchError extends Error {
  constructor(
    readonly code: "turn_failed" | "turn_timeout",
    message: string,
  ) {
    super(message);
    this.name = "TurnWatchError";
  }
}

const spell = (ms: number): string => `${Math.round(ms / 1000)} 秒`;

/**
 * 轮询到这一轮有结局为止。
 *
 * **判据是「轮次数超过基线」**，不是「最后一轮完成了」—— 后者在派轮之前就成立
 * （上一轮早就完成了），于是会当场返回上一轮的结论。基线是派轮之前数的。
 */
export async function awaitTurnByPolling(input: {
  readonly history: Pick<AppServerHistory, "readThread">;
  readonly threadId: string;
  /** 派轮**之前**这条线程有几轮。多出来的那一轮才是这一轮。 */
  readonly baselineTurns: number;
  readonly timeoutMs: number;
  readonly everyMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<{ readonly text: string }> {
  const startedAt = input.now();

  for (;;) {
    /*
     * **读不出来不是「跑完了」。** 这是这段代码最贵的一个错：把 `null`（线程读不到）
     * 或者一次异常（daemon 抖一下）当成结局，这一轮的结论就变成一段空文本。
     * 所以两种都只是「这一次没问到」，接着等。
     */
    let thread = null;
    try {
      thread = await input.history.readThread(input.threadId);
    } catch { /* 问不到就是问不到，下一轮再问 */ }

    if (thread !== null && thread.turnCount > input.baselineTurns) {
      const latest = thread.turns[thread.turns.length - 1];
      if (latest !== undefined && latest.status !== "inProgress") {
        /*
         * 失败和被打断也是**结局**，不是「还没完」。不报出来的话它会一路等到超时，
         * 而人看到的原因会是「超时」——一个假的原因。
         */
        if (latest.status !== "completed") {
          throw new TurnWatchError(
            "turn_failed",
            `这一轮以 ${latest.status} 收场（线程 ${input.threadId}）`,
          );
        }
        return { text: thread.lastCompletedText ?? latest.agentText };
      }
    }

    const waited = input.now() - startedAt;
    if (waited >= input.timeoutMs) {
      // 「超时」两个字说不出等了多久，而那正是人下一步要判断的东西。
      throw new TurnWatchError(
        "turn_timeout",
        `等了 ${spell(waited)} 还没等到这一轮收场（线程 ${input.threadId}）`,
      );
    }
    await input.sleep(input.everyMs);
  }
}
