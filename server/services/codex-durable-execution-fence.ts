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
import { pipelineJobOwnerDeadlineAt } from "./pipeline-owner-deadline";
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
      || (
        binding.scopeKind === "change"
          ? binding.scopeId !== change.id
          : binding.scopeKind !== "change_stage"
            || !binding.scopeId.startsWith(`${change.id}:`)
      )
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

/**
 * Whether a heartbeat would actually move the lease forward.
 *
 * The owner state machines accept a heartbeat only when the new expiry is
 * STRICTLY later than the old one, so this is the guard that decides between
 * writing and returning -- not a rounding convenience.
 */
function extendsLease(current: string | null, next: string): boolean {
  if (!current) return true;
  const from = Date.parse(current);
  const to = Date.parse(next);
  // An unparseable current expiry is not evidence that the lease is at its
  // maximum, so let the write happen and the state machine judge it.
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
  return to > from;
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
    const deadline = pipelineJobOwnerDeadlineAt(owner);
    const leaseExpiresAt = new Date(Math.min(
      input.now.getTime() + input.leaseMs,
      Date.parse(deadline),
    )).toISOString();
    // A lease already at its deadline cannot be extended, and the state machine
    // requires a heartbeat to move the expiry strictly forward. Writing the
    // unchanged value is therefore an illegal transition, so the heartbeat has
    // to recognise that there is nothing left to extend and stop -- the owner
    // still holds the lease, it simply cannot hold it any longer than the
    // deadline it was given.
    if (!extendsLease(owner.leaseExpiresAt, leaseExpiresAt)) return;
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
  // Same reason as the pipeline-job branch above. This one bites sooner:
  // acquireProjectAiRunLease already clamps the initial expiry to the deadline
  // when the requested lease is the longer of the two, so the very first
  // heartbeat computes a value equal to the current one and every heartbeat
  // after it is an illegal no-op transition.
  if (!extendsLease(owner.leaseExpiresAt, leaseExpiresAt)) return;
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
