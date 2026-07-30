import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { findLastCompletedTurn, parseRollout } from "./rollout";

/**
 * Finding what each sub-agent actually said.
 *
 * A round's judge spawns red and blue, and StagePass reads each of their own
 * session files rather than the judge's account of them. That is the difference
 * between an adversarial round and a summary of one: a judge that relayed blue
 * could soften it, and a softened attack is the thing this mechanism exists to
 * prevent.
 *
 * ## The one place StagePass reads Codex's own database
 *
 * Everywhere else the rollout is found from its filename, which carries the
 * thread id. A sub-agent has no such link to its parent -- the only record of
 * "these two threads belong to that round" is `thread_spawn_edges` in
 * `~/.codex/state_5.sqlite`. So this reads it, read-only, one join.
 *
 * That is a stronger dependency than a filename convention and it is recorded
 * as such: if Codex renames the table, this breaks. It must break loudly, which
 * is why a missing role is a named error rather than an empty result -- an
 * empty result would read as "blue found nothing", which is the most dangerous
 * possible misreading.
 */

export class SubAgentNotFoundError extends Error {
  constructor(readonly agentPath: string, readonly parentThreadId: string) {
    super(`no sub-agent at ${agentPath} under thread ${parentThreadId}`);
    this.name = "SubAgentNotFoundError";
  }
}

export class SubAgentUnfinishedError extends Error {
  constructor(readonly agentPath: string) {
    super(`sub-agent ${agentPath} has not completed a turn`);
    this.name = "SubAgentUnfinishedError";
  }
}

export interface SubAgentRecord {
  readonly agentPath: string;
  readonly threadId: string;
  readonly rolloutPath: string;
}

export interface SubAgentLookup {
  /** The sub-agents a thread spawned, by their declared path. */
  children(parentThreadId: string): SubAgentRecord[];
}

const DEFAULT_STATE_DB = join(homedir(), ".codex", "state_5.sqlite");

export function createSubAgentLookup(
  stateDbPath: string = DEFAULT_STATE_DB,
): SubAgentLookup {
  return {
    children(parentThreadId) {
      // Read-only, and opened per call: this is somebody else's database and
      // holding it open would mean holding a lock on it.
      const database = new Database(stateDbPath, { readonly: true });
      try {
        return (database.prepare(
          `SELECT c.agent_path AS agentPath, c.id AS threadId,
                  c.rollout_path AS rolloutPath
             FROM thread_spawn_edges e
             JOIN threads c ON c.id = e.child_thread_id
            WHERE e.parent_thread_id = ? AND c.agent_path IS NOT NULL
            ORDER BY c.created_at`,
        ).all(parentThreadId) as SubAgentRecord[]).filter(
          (record) => record.rolloutPath !== null,
        );
      } finally {
        database.close();
      }
    },
  };
}

/**
 * What one role said in its own words.
 *
 * Throws rather than returning empty when the role is missing or unfinished.
 * "Blue said nothing" and "blue could not be found" must never arrive at the
 * gate as the same thing.
 */
export function readRoleTranscript(input: {
  lookup: SubAgentLookup;
  parentThreadId: string;
  agentPath: string;
  read?: (path: string) => string;
}): string {
  /*
   * 同一个路径下有好几条时，**挑最新的那条**（`children` 按 created_at 升序）。
   *
   * 实测里 Codex 是跨轮复用同一条线程的，所以今天只会有一条。写成取最新是因为它和
   * 下面那个「读最后一轮」是**同一个坑的两种形状**：哪天 Codex 改成每轮新建一条，
   * `find` 取到的就是第一轮那条，症状一模一样 —— 悄悄读旧的，而一切看着都正常。
   */
  const matching = input.lookup.children(input.parentThreadId)
    .filter((child) => child.agentPath === input.agentPath);
  const record = matching[matching.length - 1];
  if (!record) {
    throw new SubAgentNotFoundError(input.agentPath, input.parentThreadId);
  }
  const read = input.read ?? ((path: string) => readFileSync(path, "utf-8"));
  /*
   * **最后**一轮，不是第一轮。
   *
   * 这里原来是 `findCompletedTurn(records, 0)`，而子 Agent 的线程**跨轮复用** ——
   * 一条 `/root/red` 的 rollout 里躺着这个阶段每一轮的答案。从头读的后果是
   * **第二轮起，读到的一直是第一轮说的话**：轮次照常结算、gap 看着也合理，内容却
   * 永远停在第一轮（2026-07-30 在真 Codex 上实测到，红方第 3 轮报出的新 P0
   * 一个字都没进库）。
   *
   * `findCompletedTurn` 的那个 `fromIndex` 在这里用不了：它要求调用方知道「问之前
   * 有几条记录」，而 StagePass 不盯子 Agent 的文件，只在一轮结束后来读一次。
   */
  const outcome = findLastCompletedTurn(parseRollout(read(record.rolloutPath)));
  if (!outcome) throw new SubAgentUnfinishedError(input.agentPath);
  return outcome.text;
}
