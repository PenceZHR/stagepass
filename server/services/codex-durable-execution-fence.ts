import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  changes,
  codexBindingRunLeases,
  codexLogicalTurns,
  codexThreadBindings,
  pipelineJobs,
  projectAiRuns,
} from "../db/schema";
import { isLiveProjectAiRunLease } from "./project-ai-run-service";

export type CodexFenceTransaction =
  Parameters<Parameters<typeof db.transaction>[0]>[0];

export class CodexDurableExecutionFenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodexDurableExecutionFenceError";
  }
}

export interface CodexOwnerFence {
  workerId: string;
  leaseToken: string;
  ownerAttempt: number;
  ownerEpoch: number;
}

export function assertCodexOwnerFence(
  tx: CodexFenceTransaction,
  logicalTurnId: string,
  expected: CodexOwnerFence,
  now = new Date(),
) {
  const logical = tx.select().from(codexLogicalTurns)
    .where(eq(codexLogicalTurns.logicalTurnId, logicalTurnId)).get();
  if (!logical || Boolean(logical.pipelineJobId) === Boolean(logical.projectAiRunId)) {
    throw new CodexDurableExecutionFenceError(
      "logical_turn_owner_invalid",
      "Logical turn owner is missing or invalid",
    );
  }
  const binding = tx.select().from(codexThreadBindings)
    .where(eq(codexThreadBindings.bindingId, logical.bindingId)).get();
  if (!binding) {
    throw new CodexDurableExecutionFenceError(
      "binding_not_found",
      "Logical turn binding is missing",
    );
  }
  if (logical.pipelineJobId) {
    const owner = tx.select().from(pipelineJobs)
      .where(eq(pipelineJobs.id, logical.pipelineJobId)).get();
    const change = owner
      ? tx.select().from(changes).where(eq(changes.id, owner.changeId)).get()
      : null;
    if (
      !owner
      || !change
      || !["leased", "running"].includes(owner.status)
      || owner.leasedBy !== expected.workerId
      || owner.leaseToken !== expected.leaseToken
      || owner.attemptNo !== expected.ownerAttempt
      || owner.attemptNo !== expected.ownerEpoch
      || !owner.leaseExpiresAt
      || Date.parse(owner.leaseExpiresAt) <= now.getTime()
      || binding.scopeKind !== "change"
      || binding.scopeId !== change.id
      || binding.changeId !== change.id
      || binding.projectId !== change.projectId
    ) {
      throw new CodexDurableExecutionFenceError(
        "codex_owner_fence_stale",
        "Pipeline owner or binding ownership changed",
      );
    }
  } else {
    const owner = tx.select().from(projectAiRuns)
      .where(eq(projectAiRuns.id, logical.projectAiRunId!)).get();
    const expectedScope = owner?.kind === "prd_turn"
      ? "project_prd"
      : "project_context";
    if (
      !owner
      || !isLiveProjectAiRunLease(owner, now)
      || owner.workerId !== expected.workerId
      || owner.leaseToken !== expected.leaseToken
      || owner.ownerAttempt !== expected.ownerAttempt
      || owner.ownerEpoch !== expected.ownerEpoch
      || binding.scopeKind !== expectedScope
      || binding.scopeId !== owner.projectId
      || binding.projectId !== owner.projectId
      || binding.changeId !== null
    ) {
      throw new CodexDurableExecutionFenceError(
        "codex_owner_fence_stale",
        "Project AI owner or binding ownership changed",
      );
    }
  }
  return { logical, binding };
}

export function heartbeatCodexOwnerFence(
  tx: CodexFenceTransaction,
  logicalTurnId: string,
  expected: CodexOwnerFence,
  input: { now: Date; leaseMs: number },
): void {
  const { logical } = assertCodexOwnerFence(
    tx,
    logicalTurnId,
    expected,
    input.now,
  );
  const timestamp = input.now.toISOString();
  if (logical.pipelineJobId) {
    const owner = tx.select().from(pipelineJobs)
      .where(eq(pipelineJobs.id, logical.pipelineJobId)).get()!;
    const deadline = owner.effectDeadlineAt ?? owner.leaseExpiresAt!;
    const leaseExpiresAt = new Date(Math.min(
      input.now.getTime() + input.leaseMs,
      Date.parse(deadline),
    )).toISOString();
    const updated = tx.update(pipelineJobs).set({
      leaseExpiresAt,
      heartbeatAt: timestamp,
    }).where(eq(pipelineJobs.id, owner.id)).run();
    if (updated.changes !== 1) {
      throw new CodexDurableExecutionFenceError(
        "codex_owner_fence_stale",
        "Pipeline owner heartbeat was fenced",
      );
    }
    return;
  }
  const owner = tx.select().from(projectAiRuns)
    .where(eq(projectAiRuns.id, logical.projectAiRunId!)).get()!;
  const leaseExpiresAt = new Date(Math.min(
    input.now.getTime() + input.leaseMs,
    Date.parse(owner.deadlineAt),
  )).toISOString();
  const updated = tx.update(projectAiRuns).set({
    leaseExpiresAt,
    updatedAt: timestamp,
  }).where(eq(projectAiRuns.id, owner.id)).run();
  if (updated.changes !== 1) {
    throw new CodexDurableExecutionFenceError(
      "codex_owner_fence_stale",
      "Project AI owner heartbeat was fenced",
    );
  }
}

export function assertCodexBindingLeaseFence(
  tx: CodexFenceTransaction,
  input: {
    logicalTurnId: string;
    bindingId: string;
    workerId: string;
    attemptId?: string;
    requireAttachedAttempt?: boolean;
  },
  now = new Date(),
) {
  const lease = tx.select().from(codexBindingRunLeases)
    .where(eq(codexBindingRunLeases.bindingId, input.bindingId)).get();
  if (
    !lease
    || lease.logicalTurnId !== input.logicalTurnId
    || lease.workerId !== input.workerId
    || Date.parse(lease.leaseExpiresAt) <= now.getTime()
    || (
      input.requireAttachedAttempt
        ? lease.attemptId !== input.attemptId
        : lease.attemptId !== null && lease.attemptId !== input.attemptId
    )
  ) {
    throw new CodexDurableExecutionFenceError(
      "binding_run_lease_stale",
      "Binding run lease no longer fences this logical turn",
    );
  }
  return lease;
}

export function assertCodexMutationFence(
  tx: CodexFenceTransaction,
  input: {
    logicalTurnId: string;
    owner: CodexOwnerFence;
    attemptId?: string;
    requireAttachedAttempt?: boolean;
  },
  now = new Date(),
) {
  const { logical, binding } = assertCodexOwnerFence(
    tx,
    input.logicalTurnId,
    input.owner,
    now,
  );
  const bindingLease = assertCodexBindingLeaseFence(tx, {
    logicalTurnId: input.logicalTurnId,
    bindingId: binding.bindingId,
    workerId: input.owner.workerId,
    attemptId: input.attemptId,
    requireAttachedAttempt: input.requireAttachedAttempt,
  }, now);
  return { logical, binding, bindingLease };
}
