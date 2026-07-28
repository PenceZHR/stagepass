import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { events } from "../db/schema";
import { emitIdempotentEvent } from "./event-service";

/**
 * Which sub-agent threads a change's earlier delegated rounds already used.
 *
 * ## Why this has to be persisted at all
 *
 * The judge's Codex task stays open across rounds, so its thread accumulates
 * every round's `subAgentActivity`. Round 2 could therefore be "attributed"
 * from round 1's sub-agents without round 2 spawning anything -- the sides
 * would resolve, their threads would have real output and real timings, and
 * every check would pass on work that happened an hour earlier.
 *
 * The ingestion already refuses a reused thread, but only if it is TOLD which
 * threads are spent. Without this the guard was inert: nothing computed the
 * set, so it was always empty and always passed.
 *
 * Events rather than a column because the round table has no room for a set and
 * the audit trail wants the pairing anyway -- "round 3 used threads X and Y" is
 * exactly what a post-mortem asks.
 */

const SIDE_THREADS_EVENT = "delegated_round_side_threads";

export function recordDelegatedRoundSideThreads(input: {
  changeId: string;
  runId: string;
  phase: string;
  roundId: string;
  roundNo: number;
  sideThreads: Record<string, string>;
}): void {
  emitIdempotentEvent({
    id: `EVT-round-sides-${input.roundId}-${input.roundNo}`,
    changeId: input.changeId,
    runId: input.runId,
    type: SIDE_THREADS_EVENT,
    message: `Delegated ${input.phase} round ${input.roundNo} sides recorded`,
    rawJson: {
      delegatedRoundSideThreads: {
        schemaVersion: "delegated_round_side_threads/v1",
        phase: input.phase,
        roundId: input.roundId,
        roundNo: input.roundNo,
        sideThreads: input.sideThreads,
      },
    },
  });
}

/**
 * Every sub-agent thread this change has already spent, across all phases.
 *
 * Deliberately not scoped to the phase. A thread id is globally unique, and a
 * round that somehow reached for another phase's sub-agent is no more entitled
 * to it than to its own phase's -- so the widest reading is also the safest.
 */
export function usedSubAgentThreadIds(changeId: string): Set<string> {
  const used = new Set<string>();
  const rows = db.select({ rawJson: events.rawJson })
    .from(events)
    .where(and(eq(events.changeId, changeId), eq(events.type, SIDE_THREADS_EVENT)))
    .all();
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.rawJson ?? "null") as {
        delegatedRoundSideThreads?: { sideThreads?: Record<string, unknown> };
      } | null;
      for (const threadId of Object.values(payload?.delegatedRoundSideThreads?.sideThreads ?? {})) {
        if (typeof threadId === "string" && threadId.length > 0) used.add(threadId);
      }
    } catch {
      // A malformed row must not hide the rest of the history: skipping it
      // narrows the guard, and a narrower guard is the failure mode that lets a
      // reused thread through, so keep reading the others.
      continue;
    }
  }
  return used;
}
