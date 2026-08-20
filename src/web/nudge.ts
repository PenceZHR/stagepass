import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";
import { ChangeStore } from "../store/change-store";
import { ParallelStore } from "../store/parallel-store";
import type { ProcessOps } from "../system/process";
import type { RunResult } from "../work/turn-loop";

/**
 * 一轮跑完了，叫一声人。
 *
 * ## 它补的是哪个缺口
 *
 * 一轮实测 60~343 分钟。跑完之后闸门停在那里等人裁决 —— 而**没有任何东西会说这件事**。
 * 插件是个 MCP server，它只能被动应答：不能把面板推到人眼前、不能在人没问的时候说话。
 * 于是「人要看得见它跑」在实现上变成了「人要记得回来看」。
 *
 * 系统通知是这棵树上唯一能主动出去的一条缝。`system/process.ts` 本来就是外部进程的
 * 唯一出口，而 osascript 早就在它的许可名单里（见那个文件开头）—— 不用开新口子。
 *
 * ## 它刻意不做的事
 *
 * **不替人做决定，也不带动作。** 通知只说「轮到你了，在哪个 Change 的哪个阶段」；
 * 点开它不会批准什么、不会派下一轮。人自己走过去看。
 */

export interface Nudge {
  readonly title: string;
  readonly body: string;
}

/**
 * 人自己按下「停掉这一轮」时，账本上记的就是这个。
 *
 * 他就在屏幕跟前、刚松开鼠标 —— 对着人已经知道的事再叫一声，是这类通知失去可信度的
 * 第一步。**一条不该响的通知，代价不是这一条，是之后所有条都被关掉。**
 */
const BY_HUMAN = "aborted_by_human";

/**
 * 这一轮之后，值不值得打断人。**`null` = 不值得。**
 *
 * 判据只有一条：**轮到人了没有。** 状态机里有三种「轮到人了」，其余都不是：
 *
 * - `blocked` —— 这一轮报了问题，要人裁决（`decide-gate`）
 * - `settled` —— 这一轮干净跑完，要人批准
 * - `closed`  —— 最后一个阶段批准了，这件事结束了
 *
 * `running` / `pending` 是「它还在忙」，不是事。每轮中途都响一次的话，人两天之内就会
 * 把通知关掉 —— 那时候真有事也叫不动他了。
 */
export function nudgeFor(input: {
  readonly changeId: string;
  readonly phase: Phase;
  /** 这一轮之后，这个座位停在哪个状态。 */
  readonly status: string;
  /** 这一轮失败的原因；跑成了就是 `null`。 */
  readonly failure: string | null;
}): Nudge | null {
  if (input.failure === BY_HUMAN) return null;

  const title = `StagePass · ${input.changeId} ${input.phase}`;
  // 失败要把原因带上：「失败了」和「为什么失败」是两件事，只说前一件等于要人再查一遍。
  if (input.failure !== null && input.failure !== "") {
    return { title, body: `这一轮没跑成：${input.failure}` };
  }

  switch (input.status) {
    case "blocked":
      return { title, body: "这一轮跑完了，有问题要你裁决。" };
    case "settled":
      return { title, body: "这一轮跑完了，等你批准。" };
    case "closed":
      return { title, body: "最后一个阶段批准了 —— 这个 Change 结束了。" };
    default:
      return null;
  }
}

/**
 * 送出去。
 *
 * ## 文本走 argv，不拼进脚本
 *
 * 失败原因是**模型输出的一部分**，里面到处是引号。拼字符串的话 osascript 会把后面的
 * 内容当代码 —— 一条提醒变成一次任意执行。所以脚本是三行固定文本，内容从 `argv` 取。
 *
 * ## 送不出去不算错
 *
 * 它是提醒，不是功能。osascript 不在、没有通知权限、系统在勿扰 —— 这些都不该让这一轮
 * 的结算跟着失败。**吞掉异常在这里是对的**，而在别处几乎总是错的。
 */
export async function sendNudge(nudge: Nudge, process: ProcessOps): Promise<void> {
  try {
    await process.run({
      command: "osascript",
      args: [
        "-e", "on run argv",
        "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
        "-e", "end run",
        nudge.body,
        nudge.title,
      ],
    });
  } catch { /* 提醒送不到就算了；它不该把一轮的结算拖下水 */ }
}

/**
 * 一轮跑完之后：问对了地方要状态，该响就响。
 *
 * ## 为什么这一段不在 `runtime.ts` 里
 *
 * 「问主线还是问座位」是**会静默出错的那种逻辑**：并行座位跑完时主线常常还是
 * `running`（它自己那一轨在忙），问错了对象就永远读到 running，于是整条并行轨上
 * 这条通知一次都不会响 —— 而那正是最容易被忘掉的一轨。它必须能离线证。
 *
 * `runtime.ts` 那边起 daemon、派真轮，测不了；所以判断搬到这儿，那边只剩一次调用。
 */
export async function nudgeAfterRound(input: {
  readonly database: Database.Database;
  readonly changeId: string;
  readonly phase: Phase;
  /** 这一轮跑在并行座位上，还是主线上。 */
  readonly onSeat: boolean;
  /** 用 `TurnLoop` 自己的形状，不在这儿手抄一份会跟着分叉的。 */
  readonly result: RunResult;
  readonly process: ProcessOps;
}): Promise<void> {
  // 一条活儿都没领到不是「一轮跑完了」。
  if (input.result.kind === "idle") return;

  const status = input.onSeat
    ? new ParallelStore(input.database).find(input.changeId, input.phase)?.status ?? null
    : (() => {
      try {
        return new ChangeStore(input.database).read(input.changeId).state.status;
      } catch {
        return null;   // Change 在这一轮里被删了 —— 没有人可叫
      }
    })();
  if (status === null) return;

  const nudge = nudgeFor({
    changeId: input.changeId,
    phase: input.phase,
    status,
    failure: input.result.kind === "failed" ? input.result.reason : null,
  });
  if (nudge !== null) await sendNudge(nudge, input.process);
}
