/**
 * Reading a Codex session file.
 *
 * A rollout is the record of everything that happened in a thread: one JSON
 * object per line, appended as the turn runs. It is the only place StagePass
 * can learn what a TUI turn did, because a TUI is not a child process handing
 * back a return value -- it is a window somebody is watching.
 *
 * ## Why this is where StagePass listens
 *
 * Measured 2026-07-28: the TUI, the Desktop app and `codex mcp-server` all
 * share `~/.codex` -- the App's `app-server` process was holding both
 * `state_5.sqlite` and a rollout file created by mcp-server open at the same
 * time. And `codex resume` appends to the file its thread already had rather
 * than starting a new one. So the rollout is the substrate every surface writes
 * to, which makes it the one thing StagePass can depend on without caring which
 * window the human is in.
 *
 * ## This module is pure
 *
 * Lines in, findings out. No filesystem, no clock -- so "did this turn finish"
 * is provable offline against captured records instead of by running a turn and
 * watching a window.
 */

export interface RolloutRecord {
  readonly type?: unknown;
  readonly payload?: { type?: unknown; message?: unknown } | undefined;
  readonly timestamp?: unknown;
}

export function parseRollout(text: string): RolloutRecord[] {
  const records: RolloutRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as RolloutRecord);
    } catch {
      // A half-written last line is normal: the file is being appended to
      // while it is read. Skipping it and reading again is correct; throwing
      // would make a routine race look like a corrupt session.
    }
  }
  return records;
}

function eventType(record: RolloutRecord): string | null {
  if (record.type !== "event_msg") return null;
  const type = record.payload?.type;
  return typeof type === "string" ? type : null;
}

export interface TurnOutcome {
  /** Everything the model said in the completed turn. */
  readonly text: string;
}

/**
 * The result of the first turn that both starts and finishes after `fromIndex`.
 *
 * `fromIndex` is how many records the file held before StagePass asked for this
 * turn. Without it the scan would happily return the answer to the PREVIOUS
 * question -- a rollout accumulates every turn the thread has ever had, and
 * `codex resume` appends to the same file.
 */
export function findCompletedTurn(
  records: readonly RolloutRecord[],
  fromIndex: number,
): TurnOutcome | null {
  let started = false;
  const said: string[] = [];

  for (let index = fromIndex; index < records.length; index += 1) {
    const record = records[index]!;
    const type = eventType(record);
    if (type === "task_started") {
      // A new turn begins: anything collected so far belonged to an earlier
      // one that never completed.
      started = true;
      said.length = 0;
      continue;
    }
    if (!started) continue;
    if (type === "agent_message") {
      const message = record.payload?.message;
      if (typeof message === "string" && message !== "") said.push(message);
      continue;
    }
    if (type === "task_complete") {
      return { text: said.join("\n") };
    }
  }
  return null;
}

/**
 * A thread id, taken from a rollout's filename.
 *
 * `rollout-<timestamp>-<uuid>.jsonl`. Reading it from the name rather than from
 * `state_5.sqlite` keeps StagePass out of Codex's database entirely -- a weaker
 * dependency, though still a convention rather than a published interface.
 */
const ROLLOUT_NAME =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function threadIdFromRolloutName(name: string): string | null {
  return ROLLOUT_NAME.exec(name)?.[1]?.toLowerCase() ?? null;
}
