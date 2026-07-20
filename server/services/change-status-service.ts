import { and, eq } from "drizzle-orm";

import type { db } from "../db";
import { changes, events } from "../db/schema";
import type { Change, ChangeStatus } from "../types";
import { withCurrentExecutionFenceWrite } from "./execution-fence-service";
import {
  RUNNING_CHANGE_STATUSES,
  assertLegalTransition,
  assertTransitionInvariants,
} from "../state-machine/transitions";

function nowISO(): string {
  return new Date().toISOString();
}

type StatusDb = typeof db;

function nextEventId(statusDb: Pick<StatusDb, "select">): string {
  const rows = statusDb.select({ id: events.id }).from(events).all();
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

export interface ChangeStatusTransitionInput {
  changeId: string;
  to: ChangeStatus;
  blockedPhase?: string | null;
  gateState?: string | null;
  message?: string;
  rawJson?: Record<string, unknown>;
}

export function transitionChangeStatusWithDb(
  statusDb: Pick<StatusDb, "select" | "update" | "insert">,
  input: ChangeStatusTransitionInput,
): typeof changes.$inferSelect {
  const existing = statusDb
    .select()
    .from(changes)
    .where(eq(changes.id, input.changeId))
    .get() as Change | undefined;
  if (!existing) {
    throw new Error(`Change not found: ${input.changeId}`);
  }

  const from = existing.status as ChangeStatus;
  if (from !== input.to) {
    assertLegalTransition(from, input.to);
  }
  const siblingRunningChanges = statusDb
    .select({ id: changes.id, status: changes.status })
    .from(changes)
    .where(and(eq(changes.projectId, existing.projectId)))
    .all()
    .filter((change): change is { id: string; status: ChangeStatus } =>
      RUNNING_CHANGE_STATUSES.has(change.status as ChangeStatus),
    );
  assertTransitionInvariants({
    changeId: existing.id,
    projectId: existing.projectId,
    from,
    to: input.to,
    fixIterations: existing.fixIterations ?? 0,
    siblingRunningChanges,
  });

  const now = nowISO();
  const patch: Partial<typeof changes.$inferInsert> = {
    status: input.to,
    updatedAt: now,
  };
  if (input.blockedPhase !== undefined) {
    patch.blockedPhase = input.blockedPhase;
  } else if (input.to !== "BLOCKED") {
    patch.blockedPhase = null;
  }
  if (input.gateState !== undefined) {
    patch.gateState = input.gateState;
  }

  statusDb.update(changes).set(patch).where(eq(changes.id, input.changeId)).run();
  statusDb.insert(events).values({
    id: nextEventId(statusDb),
    changeId: input.changeId,
    runId: null,
    type: "change_status_changed",
    message: input.message ?? `Status changed: ${from} -> ${input.to}`,
    rawJson: JSON.stringify({ from, to: input.to, ...input.rawJson }),
    createdAt: now,
  }).run();

  return { ...existing, ...patch } as typeof changes.$inferSelect;
}

export function transitionChangeStatus(input: ChangeStatusTransitionInput): Change {
  return withCurrentExecutionFenceWrite("change-status.transition", undefined, (tx) =>
    transitionChangeStatusWithDb(tx as unknown as StatusDb, input) as Change,
  );
}
