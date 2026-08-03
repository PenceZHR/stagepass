import Database from "better-sqlite3";
import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  allTextIn, findLastCompletedTurn, lineageOf, parseRollout, threadIdFromRolloutName,
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
 * 而「这两条线程属于那一轮」由 StagePass **自己按血缘认**（`childThreadsOf`）——
 * 它读的是 rollout 里 `session_meta` 的 `parent_thread_id`。
 *
 * 这条路走过两版。原来从 `state_5.sqlite` 的 `agent_path` 认，而那一列只有原生
 * `spawn_agent({task_name})` 会设，**那个工具不是每个会话都有**（2026-07-30 实测），
 * 没有它的会话里每个阶段的每一轮都跑不了。于是改成**让裁判把两个 `agent_id` 报进
 * 答案** —— 那修好了跑不了的问题，代价是把一个 36 字符的 UUID 放进了模型必须手抄
 * 的文本里。抄错一个字符整轮作废，而正反两方说的话谁也看不到（`02059a8` 实测过）。
 *
 * 第三版两头都不占：`parent_thread_id` 说的是线程血缘而不是 Agent 的名字，
 * 2026-08-02 在 100 条真线程上数过 **76/76 有值**（同一批里 `agent_path` 是 1/76）。
 * 见 docs/DESIGN-no-hand-transcription-2026-08-02.md §三。
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
export function readThreadTranscript(input: ThreadLookup): string {
  const outcome = findLastCompletedTurn(rolloutOf(input));
  if (!outcome) throw new SubAgentUnfinishedError(input.threadId);
  return outcome.text;
}

/**
 * 一条线程**收到过**的全部文本 —— 它说的，和它被告知的。
 *
 * ## 和上面那个的分工
 *
 * `readThreadTranscript` 给「它说了什么」，这个给「它经历了什么」。两个都要，是因为
 * 有一个问题只有后者答得了：**契约到底送到没有。** 契约在它被问到的那一段里，
 * 而「它说了什么」里当然找不到。
 *
 * 「反方没答」和「反方压根没收到」今天在库里长得一模一样，而人对这两件事该做的
 * 完全不同 —— 前者去看反方，后者去看裁判有没有转达。见
 * docs/DESIGN-rubric-delivery-2026-07-31.md §3.3。
 *
 * ## 半截的一轮也算
 *
 * 这里**不要求** turn 跑完（`readThreadTranscript` 要求）。问的是「收到过吗」，
 * 而一条被问了却还没答完的线程确实收到过。
 */
export function readThreadWholeText(input: ThreadLookup): string {
  return allTextIn(rolloutOf(input));
}

/**
 * 这条线程派生的子 Agent，**按出生先后排**。
 *
 * ## 为什么顺序就是身份
 *
 * 裁判被明确要求「一个跑完再派下一个，不要并行」（`domain/round.ts` 的
 * `judgePrompt`），所以先出生的是红方、后出生的是蓝方。这不是约定俗成的猜测：
 * 出生时刻是每条线程自己 `session_meta` 里写着的事实。
 *
 * ## 一条线程可能有两个 rollout 文件
 *
 * 补问会 `resume` 蓝方那条线程，而 resume 有时会另起一个文件（2026-08-02 在真目录
 * 里见过同一个 id 出现两次）。所以**按 thread id 去重**，取它最早的那次出生时刻 ——
 * 认的是线程，不是文件。
 *
 * ## 只读文件头
 *
 * 要的东西全在第一行的 `session_meta` 里，而一个会话目录轻易上百个文件、每个几 MB。
 * 实测那一行最大 19.3KB（`base_instructions` 占了大头），所以 256KB 绰绰有余。
 */
export function childThreadsOf(input: {
  parentThreadId: string;
  /** 会话目录里所有的 rollout 路径。注入是为了离线证。 */
  list?: () => readonly string[];
  read?: (path: string) => string;
}): string[] {
  const list = input.list ?? (() => walkRollouts(DEFAULT_SESSIONS));
  const read = input.read ?? readHead;
  const wanted = input.parentThreadId.trim().toLowerCase();

  /** thread id -> 它最早的出生时刻。同一条线程两个文件时取早的那个。 */
  const born = new Map<string, string>();
  for (const path of list()) {
    let lineage;
    try {
      lineage = lineageOf(parseRollout(read(path)));
    } catch {
      continue; // 文件正被写、或者刚被删 —— 扫描不该为此整个失败
    }
    if (!lineage || lineage.parentThreadId !== wanted) continue;
    const at = lineage.startedAt ?? "";
    const seen = born.get(lineage.threadId);
    if (seen === undefined || at < seen) born.set(lineage.threadId, at);
  }

  return [...born.entries()]
    .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([threadId]) => threadId);
}

/** 只读前 256KB —— 理由见 `childThreadsOf`。 */
function readHead(path: string): string {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(handle, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf-8");
  } finally {
    closeSync(handle);
  }
}

const HEAD_BYTES = 256 * 1024;

interface ThreadLookup {
  threadId: string;
  /** 会话目录里所有的 rollout 路径。注入是为了离线证。 */
  list?: () => readonly string[];
  read?: (path: string) => string;
}

/** 找到这条线程的 rollout 并解析。**找不到就抛，不返回空** —— 见上面那段。 */
function rolloutOf(input: ThreadLookup) {
  const list = input.list ?? (() => walkRollouts(DEFAULT_SESSIONS));
  const read = input.read ?? ((path: string) => readFileSync(path, "utf-8"));
  const wanted = input.threadId.trim().toLowerCase();

  const path = list().find((each) =>
    threadIdFromRolloutName(each.slice(each.lastIndexOf("/") + 1)) === wanted);
  if (path === undefined) {
    throw new SubAgentNotFoundError(input.threadId);
  }
  return parseRollout(read(path));
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
