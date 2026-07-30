import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 归档：让「这条线程还能不能 resume」变成 StagePass 自己管的事。
 *
 * ## 为什么需要这一层
 *
 * 2026-07-30 用户点「请 Codex 问我」报错，查到底是这个：
 *
 * ```
 * Error: session 019fb12a-… is archived. Run `codex unarchive 019fb12a-…` first.
 * ```
 *
 * 一条被归档的会话，`codex resume` **一起来就退**。而 StagePass 是「一个 (Change,
 * 阶段) 绑一条线程绑一辈子」（PRD §6.5 规则 2），于是那个阶段从此每次都撞同一面墙。
 *
 * 归档不是 StagePass 干的（代码里零处），也不是进程退出触发的（实测：kill 前后
 * `archived` 都是 0）。它成批发生 —— 用户库里 51 条在 12 秒内被归档，**其中就有
 * 那条裁判线程派生的 `/root/red` 和 `/root/blue`**。也就是说这是外面的动作，
 * 而它扫得到 StagePass 依赖的东西。
 *
 * ## 用户拍板的形状（2026-07-30）
 *
 * > 「Archive 只能我在 stage 跑完了之后，才能自动地 archive。」
 *
 * 落成两半：
 *
 *   批准之前  遇到归档一律**自动解开**，历史完整保留，人什么都不用做
 *   批准之后  由 StagePass **主动归档**它 —— 归档从此标记的是「这个阶段结束了」，
 *             而不是「Codex 那边有人清了一下」
 *
 * ## 判据是那一列，不是命令的退出码
 *
 * `codex unarchive` 对一条**没被归档**的会话会报 `failed to unarchive session`
 * （实测），所以不能无脑先跑一遍；而它的退出码这边也不好当真。**权威是
 * `state_5.sqlite` 的 `threads.archived`** —— 做完之后再读一次那一列，才算数。
 *
 * 读别人的库是一个已经记在案的依赖（PRD §10、`codex/subagent.ts` 早就在读它）。
 * 读不到就**明说读不到**，退回加这一层之前的行为，不假装成功。
 */

const DEFAULT_STATE_DB = join(homedir(), ".codex", "state_5.sqlite");

export interface ArchiveOps {
  /** 这条线程被归档了吗。查不到（库读不了、或者没有这条）返回 null —— 不猜。 */
  isArchived(threadId: string): boolean | null;
  /** 跑 `codex unarchive`。失败让它抛，调用方自己决定怎么说。 */
  unarchive(threadId: string): void;
  /** 跑 `codex archive`。 */
  archive(threadId: string): void;
}

export function createArchiveOps(options: {
  stateDbPath?: string;
  run?: (args: readonly string[]) => void;
} = {}): ArchiveOps {
  const stateDbPath = options.stateDbPath ?? DEFAULT_STATE_DB;
  const run = options.run
    ?? ((args: readonly string[]): void => {
      execFileSync("codex", [...args], { stdio: "ignore" });
    });

  return {
    isArchived(threadId) {
      try {
        // 只读，而且用完就关：这是别人的库，握着它就是握着一把锁。
        const database = new Database(stateDbPath, { readonly: true });
        try {
          const row = database.prepare(
            "SELECT archived FROM threads WHERE id = ?",
          ).get(threadId) as { archived: number } | undefined;
          return row === undefined ? null : row.archived === 1;
        } finally {
          database.close();
        }
      } catch {
        return null; // 库读不了。**说不知道**，不说「没归档」。
      }
    },
    unarchive(threadId) { run(["unarchive", threadId]); },
    archive(threadId) { run(["archive", threadId]); },
  };
}

/** `ensureResumable` 做完之后的实话。 */
export type ResumableOutcome =
  /** 本来就没被归档，什么都没做。 */
  | "already_open"
  /** 本来被归档了，已经解开。 */
  | "unarchived"
  /** 试着解了，但那一列还是 1 —— 这一次 resume 多半还是会一起来就死。 */
  | "still_archived"
  /** 查不到状态（读不了那个库）。退回加这一层之前的行为。 */
  | "unknown";

/**
 * resume 之前，把这条线程弄成 resume 得动的。
 *
 * **只在真的被归档时才动手** —— `codex unarchive` 对一条没被归档的会话会报错。
 */
export function ensureResumable(
  threadId: string,
  ops: ArchiveOps,
): ResumableOutcome {
  const archived = ops.isArchived(threadId);
  if (archived === null) return "unknown";
  if (!archived) return "already_open";
  try {
    ops.unarchive(threadId);
  } catch {
    return "still_archived";
  }
  // **做完再读一次那一列。** 命令的退出码在这里不当真，那一列才是权威。
  return ops.isArchived(threadId) === false ? "unarchived" : "still_archived";
}

/** `archiveFinished` 做完之后的实话。 */
export type ArchiveOutcome =
  | "archived"
  /** 本来就已经归档了，什么都没做。 */
  | "already_archived"
  /** 试着归档了，但那一列还是 0。 */
  | "still_open"
  | "unknown";

/**
 * 一个阶段被批准之后，归档它那条线程。
 *
 * 这是用户要的那个语义：**归档标记的是「这个阶段结束了」**。所以它只该由批准触发，
 * 别的地方一概不许调 —— 一个还没批准的阶段的线程被归档，下一次 resume 就会死，
 * 而那正是这一整个模块在收拾的事。
 */
export function archiveFinished(
  threadId: string,
  ops: ArchiveOps,
): ArchiveOutcome {
  const archived = ops.isArchived(threadId);
  if (archived === null) return "unknown";
  if (archived) return "already_archived";
  try {
    ops.archive(threadId);
  } catch {
    return "still_open";
  }
  return ops.isArchived(threadId) === true ? "archived" : "still_open";
}
