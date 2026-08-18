import type Database from "better-sqlite3";

import { AppServerSessionHost } from "../codex/app-server-transport";
import type { AppServerSessionOptions } from "../codex/app-server-session";
import type { CodexTransport } from "../codex/transport";
import type { Phase } from "../domain/phase";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";

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

export interface SeatOptions extends Pick<
  AppServerSessionOptions, "sandbox" | "approvalPolicy" | "effort" | "model"
> {
  readonly database: Database.Database;
  readonly host: AppServerSessionHost;
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

export class PluginSeats {
  /**
   * 每条线程最后一次收到 App Server 事件的时刻。
   *
   * `StreamSnapshot` 里没有这个 —— 它记的是「现在是什么状态」，不是「多久没动」。
   * 所以在开会话的时候订一次事件流，自己记。**这是「在跑」和「卡住」唯一分得开
   * 的依据**，而那两种在界面上完全同形。
   */
  private readonly lastEventAt = new Map<string, number>();

  constructor(private readonly options: SeatOptions) {}

  /** 这个 Change 的代码在哪 —— Codex 会在这个目录里跑。 */
  workspaceFor(changeId: string): string | null {
    try {
      const change = new ChangeStore(this.options.database).read(changeId);
      if (change.projectId === null) return null;
      const path = new ProjectStore(this.options.database).read(change.projectId).path;
      return path === "" ? null : path;
    } catch {
      return null;
    }
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
    return {
      runTurn: async (dispatch) => {
        const cwd = this.workspaceFor(changeId);
        if (cwd === null) {
          throw new SeatError("project_path_missing", `${changeId} 的项目没有路径，跑不了`);
        }
        const bindings = new BindingStore(this.options.database);
        const bound = bindings.find(changeId, phase);
        const session = await this.options.host.open(
          bound?.status === "bound" ? bound.threadId : null,
          {
            cwd,
            sandbox: this.options.sandbox,
            approvalPolicy: this.options.approvalPolicy,
            effort: this.options.effort,
            ...(this.options.model === undefined ? {} : { model: this.options.model }),
          },
        );
        if (bound?.threadId !== session.threadId) {
          bindings.bind(changeId, phase, session.threadId);
        }
        this.watch(session.threadId, session);
        dispatch.onThread?.(session.threadId);

        const turnId = await session.startTurn(dispatch.prompt);
        const done = await session.awaitTurn(turnId, this.options.turnTimeoutMs);
        return { threadId: session.threadId, text: done.text };
      },
    };
  }

  /** 这个座位现在有没有活着的会话。用于「同一阶段只许一轮」那条判据。 */
  has(changeId: string, phase: Phase): boolean {
    const bound = new BindingStore(this.options.database).find(changeId, phase);
    if (bound === null || bound.status !== "bound") return false;
    return this.options.host.session(bound.threadId) !== null;
  }

  /**
   * 这个座位多久没动静了（毫秒）。null = 没有开着的会话。
   *
   * 「在跑」有三种：真在跑、进程死了、进程活着但卡住（等许可、模型僵住）。
   * 后两种和第一种在界面上完全同形，所以要有这个数 —— 但它只提醒，不下结论。
   */
  quietForMs(changeId: string, phase: Phase): number | null {
    const bound = new BindingStore(this.options.database).find(changeId, phase);
    if (bound === null || bound.status !== "bound") return null;
    if (this.options.host.session(bound.threadId) === null) return null;
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
