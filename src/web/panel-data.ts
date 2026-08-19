import { basename } from "node:path";
import type Database from "better-sqlite3";

import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { panelView, type LiveSessions } from "../web/panel-view";

/**
 * 插件那一面要的数据。**这里不是第二份 view —— 它调的就是面板那个 `panelView`。**
 *
 * 网页端退休之后（2026-08-18 定案），widget 的数据不再走 `/api/panel` 这个 HTTP
 * 口，而是由插件的 MCP server 直接读库。但「一个 Change 现在长什么样」这件事只该
 * 有一份答案，所以这里只做两件事：**把库和名字凑齐**、**说清楚哪些字段现在没有**。
 */

/**
 * 「没有一个座位是活的」。
 *
 * 第 1 步（插件只读状态）里这是**事实**，不是占位：执行通道要到第 3 步才接上，
 * 此刻确实没有任何 turn 在这个进程的视野里跑。所以环上每个阶段都不画「在跑」。
 *
 * **别把它改成猜的。** 「看起来像在跑」比「显示没在跑」坏得多 —— 后者只是少说，
 * 前者是说错，而人会照着它做决定。
 */
const NO_LIVE_SESSIONS: LiveSessions = {
  has: () => false,
  quietForMs: () => null,
};

export interface PanelPayloadInput {
  readonly database: Database.Database;
  readonly changeId: string;
  /** `?project=` 那个。null = 没显式指定，跟着当前 Change 走。 */
  readonly askedProject: string | null;
}

/**
 * 面板顶上那个工作区名字。
 *
 * 面板进程原来拿的是它自己那份座位表里的工作区路径；插件没有座位表，但库里就有
 * —— Change 属于哪个项目、项目的路径是什么，都是已落库的事实。取不到就退回进程
 * 的 cwd，和面板同一个兜底。
 */
function workspaceName(database: Database.Database, changeId: string): string {
  try {
    const change = new ChangeStore(database).read(changeId);
    // Change 可以还没归到项目下（`projectId` 允许为 null），那就没有工作区可言。
    if (change.projectId === null) return basename(process.cwd());
    const path = new ProjectStore(database).read(change.projectId).path;
    if (path !== null && path !== "") return basename(path);
  } catch {
    // 没这个 Change、或者项目没路径 —— 和面板一样退回 cwd，不抛。
  }
  return basename(process.cwd());
}

/**
 * `/api/panel` 那份载荷的插件版。
 *
 * 和面板那份的**唯一差别**是 `blocked`：面板会跑一遍派发预检（树脏没脏、目录信不
 * 信任、上游产物缺不缺），告诉人「现在按下去会被哪一条拒」。插件到第 3 步才有派发
 * 能力，**在那之前这个问题没有答案**，所以给 null 而不是编一个 —— 编出来的「可以派」
 * 会让人按下去然后撞墙。
 */
export function panelPayload(input: PanelPayloadInput): unknown {
  return {
    ...panelView({
      database: input.database,
      sessions: NO_LIVE_SESSIONS,
      changeId: input.changeId,
      askedProject: input.askedProject,
      workspace: workspaceName(input.database, input.changeId),
    }) as object,
    blocked: null,
  };
}
