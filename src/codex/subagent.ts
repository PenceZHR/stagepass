import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  findLastCompletedTurn, parseRollout, threadIdFromRolloutName,
} from "./rollout";

/**
 * Finding what each sub-agent actually said.
 *
 * A round's judge spawns red and blue, and StagePass reads each of their own
 * session files rather than the judge's account of them. That is the difference
 * between an adversarial round and a summary of one: a judge that relayed blue
 * could soften it, and a softened attack is the thing this mechanism exists to
 * prevent.
 *
 * ## 取证只按线程 id，不碰 Codex 的私有库
 *
 * rollout 的**文件名里就带着 thread id**，所以读一方说了什么只要扫会话目录。
 * 而「这两条线程属于那一轮」由**裁判自己报**（`domain/round.ts` 的 `readAgents`）——
 * 原来是从 `state_5.sqlite` 的 `agent_path` 认的，而那一列只有原生
 * `spawn_agent({task_name})` 会设，**那个工具不是每个会话都有**（2026-07-30 实测），
 * 没有它的会话里每个阶段的每一轮都跑不了。
 *
 * ## 还剩一处读那个库：进度那一屏
 *
 * 「这一轮派生了几个子 Agent」只能从 `thread_spawn_edges` 数。它是**尽力而为**的：
 * 读不到就说不知道，界面照实说「还看不出走到哪一步」，没有任何东西建立在它之上。
 * 注意它**不看 `agent_path`** —— 数个数就够，而那一列可能是空的。
 */

/** 裁判报了这条线程，可是会话目录里找不到它。 */
export class SubAgentNotFoundError extends Error {
  constructor(readonly threadId: string) {
    super(`no rollout for thread ${threadId}`);
    this.name = "SubAgentNotFoundError";
  }
}

/** 找到了，但它一轮都没跑完 —— 半截的话不是这一方的结论。 */
export class SubAgentUnfinishedError extends Error {
  constructor(readonly threadId: string) {
    super(`thread ${threadId} has not completed a turn`);
    this.name = "SubAgentUnfinishedError";
  }
}

export interface SubAgentLookup {
  /**
   * 这条线程派生了几个子 Agent。**只数个数，不看 `agent_path`** —— 那一列可能是空的
   * （见文件开头），而进度那一屏要的只是「红方在写」还是「蓝方在挑」。
   */
  spawnCount(parentThreadId: string): number;
}

const DEFAULT_STATE_DB = join(homedir(), ".codex", "state_5.sqlite");

export function createSubAgentLookup(
  stateDbPath: string = DEFAULT_STATE_DB,
): SubAgentLookup {
  return {
    spawnCount(parentThreadId) {
      // Read-only, and opened per call: this is somebody else's database and
      // holding it open would mean holding a lock on it.
      const database = new Database(stateDbPath, { readonly: true });
      try {
        return (database.prepare(
          "SELECT COUNT(*) AS n FROM thread_spawn_edges WHERE parent_thread_id = ?",
        ).get(parentThreadId) as { n: number }).n;
      } finally {
        database.close();
      }
    },
  };
}

/**
 * 一条线程自己说的最后一句完整的话，**按线程 id 找**。
 *
 * ## 为什么这条取代了按 `agent_path` 认红蓝
 *
 * 那一列只有原生 `spawn_agent({task_name})` 会设，而**那个工具不是每个 Codex 会话
 * 都有**（2026-07-30 实测：同一天同一台机器，几小时前有、后来没有）。没有它的会话里
 * 每个阶段的每一轮都跑不了，症状是 `no sub-agent at /root/red`。
 * 现在改成裁判把它派生的两个 `agent_id` 报进答案（`domain/round.ts` 的 `readAgents`）。
 *
 * ## 顺带：不再碰 Codex 的私有库
 *
 * **rollout 文件名里就带着 thread id**，所以这条路只扫会话目录。上面那段关于
 * 「如果 Codex 改了表名这里就会坏」的依赖，对轮次这条路已经不存在了。
 *
 * ## 找不到就抛，不返回空
 *
 * 空字符串会被上游读成「这一方什么都没说」，而那和「找不到」是两件事 —— 后者必须
 * 大声失败。
 */
export function readThreadTranscript(input: {
  threadId: string;
  /** 会话目录里所有的 rollout 路径。注入是为了离线证。 */
  list?: () => readonly string[];
  read?: (path: string) => string;
}): string {
  const list = input.list ?? (() => walkRollouts(DEFAULT_SESSIONS));
  const read = input.read ?? ((path: string) => readFileSync(path, "utf-8"));
  const wanted = input.threadId.trim().toLowerCase();

  const path = list().find((each) =>
    threadIdFromRolloutName(each.slice(each.lastIndexOf("/") + 1)) === wanted);
  if (path === undefined) {
    throw new SubAgentNotFoundError(input.threadId);
  }
  const outcome = findLastCompletedTurn(parseRollout(read(path)));
  if (!outcome) throw new SubAgentUnfinishedError(input.threadId);
  return outcome.text;
}

const DEFAULT_SESSIONS = join(homedir(), ".codex", "sessions");

/** 会话目录里所有的 rollout 文件。`tui-transport` 那边是同一个走法。 */
function walkRollouts(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return; // 还没建出来，第一次跑之前是正常的
    }
    for (const entry of entries) {
      const path = join(directory, entry);
      if (threadIdFromRolloutName(entry)) found.push(path);
      else if (!entry.includes(".")) walk(path);
    }
  };
  walk(root);
  return found;
}
