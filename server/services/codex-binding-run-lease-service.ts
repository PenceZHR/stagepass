import { randomUUID } from "node:crypto";

import { and, eq, isNull, lte } from "drizzle-orm";

import { db } from "../db";
import {
  codexBindingRunLeases,
  codexLogicalTurns,
  pipelineJobs,
  projectAiRuns,
} from "../db/schema";
import {
  assertCodexOwnerFence,
  heartbeatCodexOwnerFence,
  type CodexOwnerFence,
} from "./codex-durable-execution-fence";
import { pipelineJobOwnerDeadlineAt } from "./pipeline-owner-deadline";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_QUEUE_POLL_MS = 50;

export type CodexBindingRunLease = typeof codexBindingRunLeases.$inferSelect;

export class CodexBindingRunLeaseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodexBindingRunLeaseError";
  }
}

export interface CodexBindingRunLeaseFence {
  bindingId: string;
  logicalTurnId: string;
  workerId: string;
  leaseToken: string;
  ownerEpoch: number;
  ownerFence: CodexOwnerFence;
  leaseExpiresAt: string;
  deadlineAt: string;
}

function read(bindingId: string): CodexBindingRunLease | null {
  return db.select().from(codexBindingRunLeases)
    .where(eq(codexBindingRunLeases.bindingId, bindingId)).get() ?? null;
}

function fencePredicate(fence: CodexBindingRunLeaseFence) {
  return and(
    eq(codexBindingRunLeases.bindingId, fence.bindingId),
    eq(codexBindingRunLeases.logicalTurnId, fence.logicalTurnId),
    eq(codexBindingRunLeases.workerId, fence.workerId),
    eq(codexBindingRunLeases.leaseToken, fence.leaseToken),
    eq(codexBindingRunLeases.ownerEpoch, fence.ownerEpoch),
  );
}

function asFenceWithOwner(
  row: CodexBindingRunLease,
  ownerFence: CodexOwnerFence,
): CodexBindingRunLeaseFence {
  return {
    bindingId: row.bindingId,
    logicalTurnId: row.logicalTurnId,
    workerId: row.workerId,
    leaseToken: row.leaseToken,
    ownerEpoch: row.ownerEpoch,
    ownerFence,
    leaseExpiresAt: row.leaseExpiresAt,
    deadlineAt: row.deadlineAt,
  };
}

export function claimCodexBindingRunLease(input: {
  logicalTurnId: string;
  workerId: string;
  ownerLeaseToken: string;
  ownerAttempt: number;
  ownerEpoch: number;
  deadlineAt: string;
  leaseMs?: number;
  now?: Date;
}): CodexBindingRunLeaseFence {
  const now = input.now ?? new Date();
  const ownerFence: CodexOwnerFence = {
    workerId: input.workerId,
    leaseToken: input.ownerLeaseToken,
    ownerAttempt: input.ownerAttempt,
    ownerEpoch: input.ownerEpoch,
  };
  if (Date.parse(input.deadlineAt) <= now.getTime()) {
    throw new CodexBindingRunLeaseError(
      "logical_turn_deadline_elapsed",
      "Logical turn deadline elapsed",
    );
  }
  const leaseExpiresAt = new Date(Math.min(
    now.getTime() + (input.leaseMs ?? DEFAULT_LEASE_MS),
    Date.parse(input.deadlineAt),
  )).toISOString();

  return db.transaction((tx) => {
    const { logical } = assertCodexOwnerFence(
      tx,
      input.logicalTurnId,
      ownerFence,
      now,
    );
    const ownerDeadlineAt = logical.pipelineJobId
      ? (() => {
          const owner = tx.select().from(pipelineJobs)
            .where(eq(pipelineJobs.id, logical.pipelineJobId!)).get()!;
          return pipelineJobOwnerDeadlineAt(owner);
        })()
      : tx.select().from(projectAiRuns)
          .where(eq(projectAiRuns.id, logical.projectAiRunId!)).get()!.deadlineAt;
    if (input.deadlineAt !== ownerDeadlineAt) {
      throw new CodexBindingRunLeaseError(
        "binding_run_lease_deadline_drift",
        "Binding lease deadline must equal the current owner deadline",
      );
    }
    const current = tx.select().from(codexBindingRunLeases)
      .where(eq(codexBindingRunLeases.bindingId, logical.bindingId)).get();
    if (current && Date.parse(current.leaseExpiresAt) > now.getTime()) {
      if (
        current.logicalTurnId === logical.logicalTurnId
        && current.workerId === input.workerId
      ) {
        tx.update(codexLogicalTurns).set({
          status: "running",
          updatedAt: now.toISOString(),
        }).where(eq(codexLogicalTurns.logicalTurnId, logical.logicalTurnId)).run();
        return asFenceWithOwner(current, ownerFence);
      }
      throw new CodexBindingRunLeaseError(
        "binding_run_lease_busy",
        "The canonical Codex binding is executing another logical turn",
      );
    }

    const ownerEpoch = (current?.ownerEpoch ?? 0) + 1;
    const leaseToken = randomUUID();
    if (current) {
      const updated = tx.update(codexBindingRunLeases).set({
        logicalTurnId: logical.logicalTurnId,
        attemptId: null,
        workerId: input.workerId,
        leaseToken,
        ownerEpoch,
        leaseExpiresAt,
        deadlineAt: input.deadlineAt,
      }).where(and(
        eq(codexBindingRunLeases.bindingId, logical.bindingId),
        lte(codexBindingRunLeases.leaseExpiresAt, now.toISOString()),
      )).run();
      if (updated.changes !== 1) {
        throw new CodexBindingRunLeaseError(
          "binding_run_lease_busy",
          "The canonical Codex binding lease changed",
        );
      }
    } else {
      tx.insert(codexBindingRunLeases).values({
        bindingId: logical.bindingId,
        logicalTurnId: logical.logicalTurnId,
        attemptId: null,
        workerId: input.workerId,
        leaseToken,
        ownerEpoch,
        leaseExpiresAt,
        deadlineAt: input.deadlineAt,
      }).run();
    }
    tx.update(codexLogicalTurns).set({
      status: "running",
      updatedAt: now.toISOString(),
    }).where(eq(codexLogicalTurns.logicalTurnId, logical.logicalTurnId)).run();
    return asFenceWithOwner(
      tx.select().from(codexBindingRunLeases)
        .where(eq(codexBindingRunLeases.bindingId, logical.bindingId)).get()!,
      ownerFence,
    );
  });
}

export async function waitForCodexBindingRunLease(input: {
  logicalTurnId: string;
  workerId: string;
  ownerLeaseToken: string;
  ownerAttempt: number;
  ownerEpoch: number;
  deadlineAt: string;
  leaseMs?: number;
  queuePollMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}): Promise<CodexBindingRunLeaseFence> {
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? ((ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const ownerFence: CodexOwnerFence = {
    workerId: input.workerId,
    leaseToken: input.ownerLeaseToken,
    ownerAttempt: input.ownerAttempt,
    ownerEpoch: input.ownerEpoch,
  };
  for (;;) {
    const instant = now();
    try {
      return claimCodexBindingRunLease({
        ...input,
        now: instant,
      });
    } catch (error) {
      if (
        !(error instanceof CodexBindingRunLeaseError)
        || error.code !== "binding_run_lease_busy"
      ) {
        throw error;
      }
    }
    db.transaction((tx) => {
      heartbeatCodexOwnerFence(tx, input.logicalTurnId, ownerFence, {
        now: instant,
        leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      });
      tx.update(codexLogicalTurns).set({
        status: "waiting_binding",
        updatedAt: instant.toISOString(),
      }).where(eq(codexLogicalTurns.logicalTurnId, input.logicalTurnId)).run();
    });
    const remaining = Date.parse(input.deadlineAt) - instant.getTime();
    if (remaining <= 0) {
      throw new CodexBindingRunLeaseError(
        "binding_run_lease_queue_timeout",
        "Binding lease queue reached the owner deadline",
      );
    }
    const logical = db.select().from(codexLogicalTurns)
      .where(eq(codexLogicalTurns.logicalTurnId, input.logicalTurnId)).get()!;
    const current = read(logical.bindingId);
    const untilExpiry = current
      ? Math.max(1, Date.parse(current.leaseExpiresAt) - instant.getTime() + 1)
      : 1;
    await sleep(Math.min(
      remaining,
      input.queuePollMs ?? DEFAULT_QUEUE_POLL_MS,
      untilExpiry,
    ));
  }
}

export function attachCodexBindingRunAttempt(
  fence: CodexBindingRunLeaseFence,
  attemptId: string,
): void {
  db.transaction((tx) => {
    assertCodexOwnerFence(
      tx,
      fence.logicalTurnId,
      fence.ownerFence,
    );
    const updated = tx.update(codexBindingRunLeases).set({ attemptId })
      .where(and(
        fencePredicate(fence),
        isNull(codexBindingRunLeases.attemptId),
      )).run();
    if (updated.changes !== 1) {
      const current = tx.select().from(codexBindingRunLeases)
        .where(eq(codexBindingRunLeases.bindingId, fence.bindingId)).get();
      if (current?.attemptId === attemptId) return;
      throw new CodexBindingRunLeaseError(
        "binding_run_lease_stale",
        "Binding run lease attempt update was fenced",
      );
    }
  });
}

export function renewCodexBindingRunLease(
  fence: CodexBindingRunLeaseFence,
  input: { leaseMs?: number; now?: Date } = {},
): CodexBindingRunLeaseFence {
  const now = input.now ?? new Date();
  return db.transaction((tx) => {
    heartbeatCodexOwnerFence(
      tx,
      fence.logicalTurnId,
      fence.ownerFence,
      {
        now,
        leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      },
    );
    if (Date.parse(fence.deadlineAt) <= now.getTime()) {
      throw new CodexBindingRunLeaseError(
        "logical_turn_deadline_elapsed",
        "Logical turn deadline elapsed",
      );
    }
    const leaseExpiresAt = new Date(Math.min(
      now.getTime() + (input.leaseMs ?? DEFAULT_LEASE_MS),
      Date.parse(fence.deadlineAt),
    )).toISOString();
    const updated = tx.update(codexBindingRunLeases).set({ leaseExpiresAt })
      .where(fencePredicate(fence)).run();
    if (updated.changes !== 1) {
      throw new CodexBindingRunLeaseError(
        "binding_run_lease_stale",
        "Binding run lease renewal was fenced",
      );
    }
    return { ...fence, leaseExpiresAt };
  });
}

export function releaseCodexBindingRunLease(
  fence: CodexBindingRunLeaseFence,
): void {
  const deleted = db.delete(codexBindingRunLeases)
    .where(fencePredicate(fence)).run();
  if (deleted.changes !== 1) {
    throw new CodexBindingRunLeaseError(
      "binding_run_lease_stale",
      "Binding run lease release was fenced",
    );
  }
}

export function readCodexBindingRunLease(
  bindingId: string,
): CodexBindingRunLease | null {
  return read(bindingId);
}
