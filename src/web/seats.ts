import type Database from "better-sqlite3";

import type { AppServerHistory } from "../codex/app-server-history";
import { AppServerSessionHost } from "../codex/app-server-transport";
import type { AppServerSessionOptions } from "../codex/app-server-session";
import type { CodexTransport } from "../codex/transport";
import type { Phase } from "../domain/phase";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { awaitTurnByPolling } from "./await-turn";

/**
 * 一个座位 = 一个 (Change, 阶段) 绑着的 Codex 会话。
 *
 * ## 它替掉了什么
 *
 * 旧的座位是「一个跑着 codex TUI 的原生 Terminal 窗口」（`web/native-sessions.ts`），
 * 派一轮的做法是**往那个窗口里打字**，再轮询历史等这一轮出现。2026-08-18 网页端
 * 退休时那套整个删了 —— 插件里没有终端可以打字。
 *
 * 现在直接用 App Server 的公开协议：`thread/start` 开线程、`turn/start` 发题面、
 * 等 `turn/completed`。**没有中间人，也没有要靠 UI 状态推断的东西。**
 *
 * ## 为什么开出来的会话人能看见
 *
 * `threadSource: "user"` —— 2026-08-18 实测：带这个字段的线程落进 Codex App 的
 * **项目分类**，人能点开、能接着打字；不带就只在 Recents 里。判据不在 API 层
 * （两边 `thread/read` 返回完全相同），在 `state_5.sqlite` 的 `threads.thread_source`。
 * 那个字段由 `AppServerSession` 统一带上，这里不重复。
 *
 * ## 审批归谁
 *
 * 反向请求（审批 / elicitation）由 `AppServerSessionHost` 按 threadId 路由到拥有
 * 那条线程的会话。**StagePass 起的 turn，审批就落在 StagePass 手里** —— 这和
 * 「人在 App 里打开那条线程自己审批」是两种归属，不能同时成立。哪一种更对是产品
 * 决定，不是这一层的：这一层只保证请求有人接、不会静默挂住。
 */

/**
 * 旁路座位的名字。**它不是一个阶段** —— 类型上就不该能和 `Phase` 混着传。
 *
 * 界面用同一个字段（`?phase=`）说「哪个座位」，所以这个名字要能出现在那儿；
 * 而账本里它是另一种行（`change_bindings.kind = 'aside'`），不是某个阶段的行。
 */
export const ASIDE = "aside" as const;

export interface SeatOptions extends Pick<
  AppServerSessionOptions, "sandbox" | "approvalPolicy" | "effort" | "model"
> {
  readonly database: Database.Database;
  readonly host: AppServerSessionHost;
  /**
   * 读线程历史。**退订之后这是唯一的信息来源** —— 一轮跑完没有、裁判说了什么，
   * 全从这儿轮询着问（`await-turn.ts`）。
   */
  readonly history: Pick<AppServerHistory, "readThread">;
  /** 轮询间隔。一轮 60~343 分钟，晚几秒无所谓；默认 5 秒。 */
  readonly pollEveryMs?: number;
  /** 一轮的硬顶。到点算这一轮失败，而不是无限等下去。 */
  readonly turnTimeoutMs: number;
}

/*
 * 不导出：目前没有调用者接它 —— `runtime.runRound` 在派轮之前就先查了项目路径，
 * 所以这条抛出来只会是「查过之后路径又没了」那种竞态。有人要按类型接它时再放出去。
 */
class SeatError extends Error {
  constructor(readonly code: "no_such_change" | "project_path_missing", message: string) {
    super(message);
    this.name = "SeatError";
  }
}

/**
 * 这个 Change 的代码在哪。**只读库，不碰 Codex。**
 *
 * 独立于 `PluginSeats` 存在，是因为「取题面」那条路要问同一个问题，而它**一个
 * 子进程都不该起**（备一轮不跟 Codex 说话）。挂在座位上就只能先 `ready()`，
 * 那等于为了拿一份题面去拉起一个 app-server。
 *
 * 路径是空串当成没有：一个空路径拿去当 cwd，Codex 会在**当前进程的目录**里跑起来
 * —— 那是工作台自己的仓库，不是人的项目。
 */
export function workspaceOf(
  database: SeatOptions["database"], changeId: string,
): string | null {
  try {
    const change = new ChangeStore(database).read(changeId);
    if (change.projectId === null) return null;
    const path = new ProjectStore(database).read(change.projectId).path;
    return path === "" ? null : path;
  } catch {
    return null;
  }
}

export class PluginSeats {
  /**
   * 每条线程最后一次收到 App Server 事件的时刻。
   *
   * `StreamSnapshot` 里没有这个 —— 它记的是「现在是什么状态」，不是「多久没动」。
   * 所以在开会话的时候订一次事件流，自己记。**这是「在跑」和「卡住」唯一分得开
   * 的依据**，而那两种在界面上完全同形。
   */
  private readonly lastEventAt = new Map<string, number>();

  /**
   * 这个进程手上正在飞的轮（按 threadId）。
   *
   * **退订之后 `has()` 不能再问「我们还持有会话吗」** —— 那个答案从派轮的下一毫秒起
   * 永远是「不持有」（线程已经还给人了），于是进度那一屏会对每一轮在跑的活儿报
   * 「进程没了」。它会**主动说谎**，比没有这一格更糟。
   *
   * 换成这个：轮派出去就记上，轮询判定结束（成、败、超时都算）就抹掉。插件重启它是
   * 空的 —— 那时 `processGone` 为真，而那正是事实：轮询的那条腿死了，没人在收这一轮。
   */
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: SeatOptions) {}

  /** 这个 Change 的代码在哪 —— Codex 会在这个目录里跑。 */
  workspaceFor(changeId: string): string | null {
    return workspaceOf(this.options.database, changeId);
  }

  /**
   * 派一轮用的通道。
   *
   * **线程是懒开的**：`runTurn` 被调到才开，因为「看一眼阶段页」不该顺手起一条
   * Codex 会话（用户的界面原则：看状态不该有副作用）。
   *
   * 新开的线程当场写进绑定表 —— 中途死掉时，「线程建了但 StagePass 不知道」
   * 是最难查的一种状态。
   */
  transportFor(changeId: string, phase: Phase): CodexTransport {
    return this.seatOn(changeId, phase);
  }

  /**
   * 旁路那条线程的通道 —— 「这个 Change 的闲聊」，一个 Change 一条。
   *
   * 它**不属于任何阶段**：不产出、不推闸门、不占阶段座位。所以绑的是 `aside` 那一行
   * （schema 用部分唯一索引钉死一条）。落错行的代价很具体：「同一阶段只许一轮」
   * 会把一次闲聊当成一轮在跑，从此这个阶段派不动。
   *
   * 起草需求（`app/converge-brief.ts`）就是照 `findAside` 去认这段对话的 —— 线程
   * 不记在这儿，那条路永远停在「先去开旁路窗口谈」，而人明明已经谈过了。
   */
  asideTransport(changeId: string): CodexTransport {
    return this.seatOn(changeId, ASIDE);
  }

  /**
   * 一个座位怎么跑一轮。阶段座位和旁路只差**绑在哪一行**，别的一个字不差 ——
   * 所以它们共用这一段，而不是各写一份迟早会分叉的拷贝。
   */
  private seatOn(changeId: string, seat: Phase | typeof ASIDE): CodexTransport {
    const bindings = (): BindingStore => new BindingStore(this.options.database);
    const found = (): { threadId: string; status: string } | null =>
      seat === ASIDE ? bindings().findAside(changeId) : bindings().find(changeId, seat);
    const remember = (threadId: string): void => {
      if (seat === ASIDE) bindings().bindAside(changeId, threadId);
      else bindings().bind(changeId, seat, threadId);
    };

    return {
      runTurn: async (dispatch) => {
        const cwd = this.workspaceFor(changeId);
        if (cwd === null) {
          throw new SeatError("project_path_missing", `${changeId} 的项目没有路径，跑不了`);
        }
        const bound = found();
        const open = {
          cwd,
          sandbox: this.options.sandbox,
          approvalPolicy: this.options.approvalPolicy,
          effort: this.options.effort,
          ...(this.options.model === undefined ? {} : { model: this.options.model }),
        };
        /*
         * **绑着的那条线程可能在 Codex 里已经不存在了。**
         *
         * 绑定是在 `thread/start` 那一刻写下的（中途死掉时「线程建了但 StagePass 不
         * 知道」是最难查的状态，所以必须早写）。代价是：第一轮没跑成的话，账本上会
         * 留下一条指向**零轮次线程**的绑定 —— 而零轮次线程连 `threads` 表都不进，
         * `thread/resume` 必拒（2026-08-18 实测：`no rollout found for thread id …`）。
         *
         * 不接这一下的话，这个座位会被自己的绑定毒死：每次派轮都在同一句话上失败，
         * 而那句话说的是 Codex 的内部状态，不是人做错了什么。
         *
         * 所以 resume 不成就**开一条新的**，绑定跟着换过去。丢掉的是那条线程的历史
         * —— 而一条零轮次线程本来就没有历史可丢。
         */
        let session;
        try {
          session = await this.options.host.open(
            bound?.status === "bound" ? bound.threadId : null, open,
          );
        } catch (error) {
          if (bound?.status !== "bound") throw error;
          /*
           * **明着解绑，再开新的。** 绑定层故意不许直接换绑（它的注释：换绑会把人
           * 正看着的那段对话丢掉）—— 那条规矩是对的，而这里正是它说的「先 detach，
           * 有意为之」的那种情况：resume 都被拒了，那条线程在 Codex 里已经没有
           * 可看的东西。
           */
          if (seat !== ASIDE) new BindingStore(this.options.database).detach(changeId, seat);
          session = await this.options.host.open(null, open);
        }
        if (bound?.threadId !== session.threadId) remember(session.threadId);
        this.watch(session.threadId, session);
        dispatch.onThread?.(session.threadId);

        /*
         * **基线要在派轮之前数。** 判据是「轮次数超过基线」，而不是「最后一轮完成了」
         * —— 后者在派轮之前就成立（上一轮早完成了），会当场返回上一轮的结论。
         *
         * ## 读不出来 = 0，不是失败
         *
         * 一条刚 `thread/start` 出来、还没收到第一条用户消息的线程**读不了**
         * （2026-08-18 真机原话：`is not materialized yet; includeTurns is unavailable
         * before first user message`）—— 而数基线恰好就发生在那个窗口里。
         *
         * 那不是故障，是新线程的正常状态：它确实还没有轮次。把它当失败会让**每个座位
         * 的第一轮**都跑不起来。
         */
        let baselineTurns = 0;
        try {
          baselineTurns = (await this.options.history.readThread(session.threadId))?.turnCount ?? 0;
        } catch { /* 还没落地的线程读不出来 —— 它就是 0 轮 */ }

        this.inFlight.add(session.threadId);
        await session.startTurn(dispatch.prompt);

        /*
         * **发完就把线程还给人。** 不退订的话，人在 Codex 里点开它只会看到
         * 「This is open in another app」—— 而「人要看得见它跑」是这套东西存在的理由。
         *
         * 退订之后我们收不到流了，所以完成判定改成轮询历史。那是 2026-08-18 定案里
         * 唯一要新写的一段，代价盘在 `docs/DESIGN-thread-ownership-2026-08-18.md`。
         */
        await this.options.host.unsubscribe(session.threadId);

        try {
          const done = await awaitTurnByPolling({
            history: this.options.history,
            threadId: session.threadId,
            baselineTurns,
            timeoutMs: this.options.turnTimeoutMs,
            everyMs: this.options.pollEveryMs ?? 5_000,
            now: () => Date.now(),
            sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
          });
          return { threadId: session.threadId, text: done.text };
        } finally {
          // 成、败、超时都算「不在飞了」。漏掉任何一条，这个座位从此永远显示在跑。
          this.inFlight.delete(session.threadId);
        }
      },
    };
  }

  /**
   * 放掉这个座位的会话 —— 活干完了，或者人当场把它关了。
   *
   * **只放会话，不动绑定。** 线程还在 Codex 里、人还点得开、下一轮 resume 回同一条；
   * 放掉的只是「StagePass 手上这条连接」。抹掉绑定等于把那段历史丢了。
   *
   * 不放的代价很具体：`has()` 永远是真 → 进度那一屏的 `live` 一直是真 → 界面一直
   * 显示「在跑」，而账本上早就没有活儿了。
   */
  release(changeId: string, seat: Phase | typeof ASIDE): void {
    const bindings = new BindingStore(this.options.database);
    const bound = seat === ASIDE ? bindings.findAside(changeId) : bindings.find(changeId, seat);
    if (bound === null || bound.status !== "bound") return;
    this.options.host.close(bound.threadId);
    this.lastEventAt.delete(bound.threadId);
    this.watching.delete(bound.threadId);
  }

  /**
   * 这个座位现在有没有一轮在飞。
   *
   * **问的不是「我们还持有那条线程吗」** —— 派完轮就退订了（线程还给人），那个答案
   * 永远是否。问的是「这个进程手上还有没有一轮没收尾」。
   */
  has(changeId: string, phase: Phase): boolean {
    const bound = new BindingStore(this.options.database).find(changeId, phase);
    if (bound === null || bound.status !== "bound") return false;
    return this.inFlight.has(bound.threadId);
  }

  /**
   * 这个座位多久没动静了（毫秒）。`null` = **说不出来**。
   *
   * ## 它在 2026-08-18 之后变粗了，而且经常就是 null
   *
   * 这个数原来来自事件流：「最后一次收到事件到现在多久」。退订之后我们收不到流了，
   * 所以除了派轮那一瞬间，这里基本没有新的观察点。
   *
   * **不编。** 说不出来就返回 null，界面照实说「说不出来」—— 这一格存在的意义就是
   * 不再让人猜，编一个数出来等于白做。代价盘在
   * `docs/DESIGN-thread-ownership-2026-08-18.md` §5.1，是定案时接受了的。
   */
  quietForMs(changeId: string, phase: Phase): number | null {
    const bound = new BindingStore(this.options.database).find(changeId, phase);
    if (bound === null || bound.status !== "bound") return null;
    if (!this.inFlight.has(bound.threadId)) return null;
    const at = this.lastEventAt.get(bound.threadId);
    return at === undefined ? null : Date.now() - at;
  }

  /** 订一次就够 —— 同一条线程重复开会拿到同一个 session 对象。 */
  private readonly watching = new Set<string>();
  private watch(threadId: string, session: { subscribe(listener: () => void): () => void }): void {
    if (this.watching.has(threadId)) return;
    this.watching.add(threadId);
    this.lastEventAt.set(threadId, Date.now());
    session.subscribe(() => { this.lastEventAt.set(threadId, Date.now()); });
  }
}
