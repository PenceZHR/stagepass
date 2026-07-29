import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { findCompletedTurn, parseRollout } from "./rollout";

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
  const record = input.lookup.children(input.parentThreadId)
    .find((child) => child.agentPath === input.agentPath);
  if (!record) {
    throw new SubAgentNotFoundError(input.agentPath, input.parentThreadId);
  }
  const read = input.read ?? ((path: string) => readFileSync(path, "utf-8"));
  const outcome = findCompletedTurn(parseRollout(read(record.rolloutPath)), 0);
  if (!outcome) throw new SubAgentUnfinishedError(input.agentPath);
  return outcome.text;
}
