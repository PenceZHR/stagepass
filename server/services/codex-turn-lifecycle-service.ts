import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db } from "../db";
import {
  codexFollowerStartAttempts,
  codexLogicalTurns,
  codexTurnExecutions,
} from "../db/schema";
import type { CodexTurnSnapshot } from "./codex-desktop-bridge-types";
import {
  assertCodexMutationFence,
  type CodexFenceTransaction,
} from "./codex-durable-execution-fence";

export type CodexTurnExecution = typeof codexTurnExecutions.$inferSelect;

export class CodexTurnLifecycleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodexTurnLifecycleError";
  }
}

function requireExecutionMutation(
  tx: CodexFenceTransaction,
  logicalTurnId: string,
) {
  const execution = tx.select().from(codexTurnExecutions)
    .where(eq(codexTurnExecutions.logicalTurnId, logicalTurnId)).get();
  if (!execution) {
    throw new CodexTurnLifecycleError("execution_not_found", "Execution not found");
  }
  const attempt = tx.select().from(codexFollowerStartAttempts)
    .where(eq(codexFollowerStartAttempts.attemptId, execution.startAttemptId)).get();
  if (
    !attempt
    || attempt.logicalTurnId !== execution.logicalTurnId
    || attempt.leaseToken !== execution.leaseToken
    || attempt.ownerAttempt !== execution.ownerAttempt
    || attempt.ownerEpoch !== execution.ownerEpoch
  ) {
    throw new CodexTurnLifecycleError(
      "turn_execution_fence_stale",
      "Turn execution no longer matches its start attempt",
    );
  }
  assertCodexMutationFence(tx, {
    logicalTurnId,
    owner: {
      workerId: attempt.workerId,
      leaseToken: execution.leaseToken,
      ownerAttempt: execution.ownerAttempt,
      ownerEpoch: execution.ownerEpoch,
    },
    attemptId: attempt.attemptId,
    requireAttachedAttempt: true,
  });
  return { execution, attempt };
}

export function startCodexTurnExecution(input: {
  logicalTurnId: string;
  attemptId: string;
  threadId: string;
  turnId: string;
}): CodexTurnExecution {
  return db.transaction((tx) => {
    const logical = tx.select().from(codexLogicalTurns)
      .where(eq(codexLogicalTurns.logicalTurnId, input.logicalTurnId)).get();
    if (!logical) {
      throw new CodexTurnLifecycleError("logical_turn_not_found", "Logical turn not found");
    }
    const attempt = tx.select().from(codexFollowerStartAttempts)
      .where(eq(codexFollowerStartAttempts.attemptId, input.attemptId)).get();
    if (
      !attempt
      || attempt.logicalTurnId !== logical.logicalTurnId
      || attempt.state !== "succeeded"
      || attempt.followerTurnId !== input.turnId
      || attempt.threadId !== input.threadId
      || attempt.dispatchSurface !== logical.dispatchSurface
    ) {
      throw new CodexTurnLifecycleError(
        "start_attempt_not_succeeded",
        "A matching succeeded/adopted follower attempt is required",
      );
    }
    assertCodexMutationFence(tx, {
      logicalTurnId: logical.logicalTurnId,
      owner: {
        workerId: attempt.workerId,
        leaseToken: attempt.leaseToken,
        ownerAttempt: attempt.ownerAttempt,
        ownerEpoch: attempt.ownerEpoch,
      },
      attemptId: attempt.attemptId,
      requireAttachedAttempt: true,
    });
    const existing = tx.select().from(codexTurnExecutions)
      .where(eq(codexTurnExecutions.logicalTurnId, logical.logicalTurnId)).get();
    if (existing) {
      // This row copied its owner stamp from the attempt when it was created.
      // A re-leased owner has just proved the attempt is theirs, so the
      // execution follows; leaving the old stamp makes every later snapshot
      // write on this turn read as a stale fence.
      if (
        existing.leaseToken !== attempt.leaseToken
        || existing.ownerAttempt !== attempt.ownerAttempt
        || existing.ownerEpoch !== attempt.ownerEpoch
      ) {
        tx.update(codexTurnExecutions).set({
          leaseToken: attempt.leaseToken,
          ownerAttempt: attempt.ownerAttempt,
          ownerEpoch: attempt.ownerEpoch,
          updatedAt: new Date().toISOString(),
        }).where(eq(codexTurnExecutions.id, existing.id)).run();
        return tx.select().from(codexTurnExecutions)
          .where(eq(codexTurnExecutions.id, existing.id)).get()!;
      }
      return existing;
    }
    const timestamp = new Date().toISOString();
    const id = randomUUID();
    tx.insert(codexTurnExecutions).values({
      id,
      startAttemptId: attempt.attemptId,
      logicalTurnId: logical.logicalTurnId,
      pipelineJobId: logical.pipelineJobId,
      projectAiRunId: logical.projectAiRunId,
      threadId: input.threadId,
      turnId: input.turnId,
      dispatchSurface: logical.dispatchSurface,
      leaseToken: attempt.leaseToken,
      ownerAttempt: attempt.ownerAttempt,
      ownerEpoch: attempt.ownerEpoch,
      lastObservationCursor: 0,
      normalizedItemsJson: "[]",
      lastSemanticSnapshotHash: null,
      status: "running",
      lastObservedAt: null,
      terminalSemanticHash: null,
      reconnectCount: 0,
      notYetVisibleCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
    return tx.select().from(codexTurnExecutions)
      .where(eq(codexTurnExecutions.id, id)).get()!;
  });
}

export function recordCodexTurnNotYetVisible(
  logicalTurnId: string,
): CodexTurnExecution {
  return db.transaction((tx) => {
    const { execution: row } = requireExecutionMutation(tx, logicalTurnId);
    const timestamp = new Date().toISOString();
    const updated = tx.update(codexTurnExecutions).set({
      notYetVisibleCount: row.notYetVisibleCount + 1,
      lastObservedAt: timestamp,
      updatedAt: timestamp,
    }).where(and(
      eq(codexTurnExecutions.id, row.id),
      eq(codexTurnExecutions.status, "running"),
      eq(codexTurnExecutions.leaseToken, row.leaseToken),
      eq(codexTurnExecutions.ownerAttempt, row.ownerAttempt),
      eq(codexTurnExecutions.ownerEpoch, row.ownerEpoch),
    )).run();
    if (updated.changes !== 1) {
      throw new CodexTurnLifecycleError(
        "turn_execution_fence_stale",
        "Turn visibility update was fenced",
      );
    }
    return tx.select().from(codexTurnExecutions)
      .where(eq(codexTurnExecutions.id, row.id)).get()!;
  });
}

export function recordCodexTurnSnapshot(input: {
  logicalTurnId: string;
  snapshot: CodexTurnSnapshot;
  cursor: number;
  semanticHash: string;
}): { execution: CodexTurnExecution; changed: boolean } {
  return db.transaction((tx) => {
    const { execution: row } = requireExecutionMutation(
      tx,
      input.logicalTurnId,
    );
    if (
      row.threadId !== input.snapshot.threadId
      || row.turnId !== input.snapshot.turnId
    ) {
      throw new CodexTurnLifecycleError(
        "turn_execution_identity_mismatch",
        "Observed snapshot is for a different thread/turn",
      );
    }
    if (row.status !== "running") {
      if (row.terminalSemanticHash !== input.semanticHash) {
        throw new CodexTurnLifecycleError(
          "terminal_snapshot_immutable",
          "Terminal semantic snapshot cannot change",
        );
      }
      return { execution: row, changed: false };
    }
    if (row.lastSemanticSnapshotHash === input.semanticHash) {
      return { execution: row, changed: false };
    }
    const terminal = input.snapshot.status !== "inProgress";
    const timestamp = new Date().toISOString();
    const updated = tx.update(codexTurnExecutions).set({
      lastObservationCursor: input.cursor,
      normalizedItemsJson: JSON.stringify(input.snapshot.items),
      lastSemanticSnapshotHash: input.semanticHash,
      status: terminal ? input.snapshot.status : "running",
      terminalSemanticHash: terminal ? input.semanticHash : null,
      lastObservedAt: timestamp,
      updatedAt: timestamp,
    }).where(and(
      eq(codexTurnExecutions.id, row.id),
      eq(codexTurnExecutions.status, "running"),
      eq(codexTurnExecutions.leaseToken, row.leaseToken),
      eq(codexTurnExecutions.ownerAttempt, row.ownerAttempt),
      eq(codexTurnExecutions.ownerEpoch, row.ownerEpoch),
    )).run();
    if (updated.changes !== 1) {
      throw new CodexTurnLifecycleError(
        "turn_execution_fence_stale",
        "Turn execution snapshot update was fenced",
      );
    }
    return {
      execution: tx.select().from(codexTurnExecutions)
        .where(eq(codexTurnExecutions.id, row.id)).get()!,
      changed: true,
    };
  });
}

export function readCodexTurnExecution(
  logicalTurnId: string,
): CodexTurnExecution | null {
  return db.select().from(codexTurnExecutions)
    .where(eq(codexTurnExecutions.logicalTurnId, logicalTurnId)).get() ?? null;
}
