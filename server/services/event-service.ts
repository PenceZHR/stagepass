import fs from "fs";
import path from "path";
import { db } from "../db";
import { events } from "../db/schema";

function nowISO(): string {
  return new Date().toISOString();
}

export interface EmitEventInput {
  changeId: string;
  runId?: string | null;
  type: string;
  message: string;
  rawJson?: Record<string, unknown>;
  repoPath?: string;
}

function nextEventId(): string {
  const rows = db.select({ id: events.id }).from(events).all();
  const used = new Set<string>();
  let maxNum = 0;
  for (const row of rows) {
    const id = row.id as string;
    used.add(id);
    const match = id.match(/^EVT-(\d+)$/);
    if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
  }

  let nextNum = maxNum + 1;
  let candidate = `EVT-${String(nextNum).padStart(3, "0")}`;
  while (used.has(candidate)) {
    nextNum += 1;
    candidate = `EVT-${String(nextNum).padStart(3, "0")}`;
  }
  return candidate;
}

/**
 * Inserts an event with a caller-supplied deterministic id, ignoring duplicates.
 * For continuity markers that may be re-recorded on retries: the first write
 * wins and replays are silent no-ops.
 */
export function emitIdempotentEvent(input: EmitEventInput & { id: string }): void {
  db.insert(events)
    .values({
      id: input.id,
      changeId: input.changeId,
      runId: input.runId ?? null,
      type: input.type,
      message: input.message,
      rawJson: input.rawJson ? JSON.stringify(input.rawJson) : null,
      createdAt: nowISO(),
    })
    .onConflictDoNothing()
    .run();
}

export async function emitEvent(input: EmitEventInput): Promise<string> {
  const id = nextEventId();
  const now = nowISO();
  const raw = input.rawJson ? JSON.stringify(input.rawJson) : null;

  db.insert(events)
    .values({
      id,
      changeId: input.changeId,
      runId: input.runId ?? null,
      type: input.type,
      message: input.message,
      rawJson: raw,
      createdAt: now,
    })
    .run();

  // Append to events.jsonl in .ship/changes/{changeId}/ if repoPath provided
  if (input.repoPath && input.changeId) {
    const eventsDir = path.join(
      input.repoPath,
      ".ship",
      "changes",
      input.changeId
    );
    if (fs.existsSync(eventsDir)) {
      const line = JSON.stringify({
        id,
        type: input.type,
        message: input.message,
        createdAt: now,
      });
      fs.appendFileSync(path.join(eventsDir, "events.jsonl"), line + "\n");
    }
  }

  return id;
}
