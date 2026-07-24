import { randomUUID } from "node:crypto";

import { and, eq, max } from "drizzle-orm";

import { db } from "../db";
import { projectAiRuns } from "../db/schema";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_DEADLINE_MS = 15 * 60_000;

export type ProjectAiRun = typeof projectAiRuns.$inferSelect;

export interface ProjectAiRunFence {
  projectAiRunId: string;
  workerId: string;
  leaseToken: string;
  ownerAttempt: number;
  ownerEpoch: number;
  leaseExpiresAt: string;
  deadlineAt: string;
}
export class ProjectAiRunError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProjectAiRunError";
  }
}

export function isLiveProjectAiRunLease(
  run: Pick<
    ProjectAiRun,
    "status" | "workerId" | "leaseToken" | "leaseExpiresAt" | "deadlineAt"
  >,
  now = new Date(),
): boolean {
  return (run.status === "leased" || run.status === "running")
    && Boolean(run.workerId)
    && Boolean(run.leaseToken)
    && run.leaseExpiresAt !== null
    && Date.parse(run.leaseExpiresAt) > now.getTime()
    && Date.parse(run.deadlineAt) > now.getTime();
}

function readRun(id: string): ProjectAiRun {
  const run = db.select().from(projectAiRuns)
    .where(eq(projectAiRuns.id, id)).get();
  if (!run) throw new ProjectAiRunError("owner_not_found", `Project AI run not found: ${id}`);
  return run;
}

function fenceFor(run: ProjectAiRun): ProjectAiRunFence {
  if (!run.workerId || !run.leaseToken || !run.leaseExpiresAt) {
    throw new ProjectAiRunError("owner_not_leased", "Project AI run has no lease");
  }
  return {
    projectAiRunId: run.id,
    workerId: run.workerId,
    leaseToken: run.leaseToken,
    ownerAttempt: run.ownerAttempt,
    ownerEpoch: run.ownerEpoch,
    leaseExpiresAt: run.leaseExpiresAt,
    deadlineAt: run.deadlineAt,
  };
}

function fencePredicate(fence: ProjectAiRunFence) {
  return and(
    eq(projectAiRuns.id, fence.projectAiRunId),
    eq(projectAiRuns.workerId, fence.workerId),
    eq(projectAiRuns.leaseToken, fence.leaseToken),
    eq(projectAiRuns.ownerAttempt, fence.ownerAttempt),
    eq(projectAiRuns.ownerEpoch, fence.ownerEpoch),
    eq(projectAiRuns.leaseExpiresAt, fence.leaseExpiresAt),
    eq(projectAiRuns.deadlineAt, fence.deadlineAt),
  );
}

export async function createProjectAiRun(input: {
  projectId: string;
  kind: "prd_turn" | "context_init";
  requestKey: string;
  deadlineMs?: number;
  now?: Date;
}): Promise<ProjectAiRun> {
  const requestKey = input.requestKey.trim();
  if (!requestKey) throw new ProjectAiRunError("request_key_invalid", "requestKey is required");
  const now = input.now ?? new Date();
  return db.transaction((tx) => {
    const existing = tx.select().from(projectAiRuns).where(and(
      eq(projectAiRuns.projectId, input.projectId),
      eq(projectAiRuns.kind, input.kind),
      eq(projectAiRuns.requestKey, requestKey),
    )).get();
    if (existing) return existing;
    const latest = tx.select({ value: max(projectAiRuns.sequence) })
      .from(projectAiRuns)
      .where(and(
        eq(projectAiRuns.projectId, input.projectId),
        eq(projectAiRuns.kind, input.kind),
      )).get()?.value ?? 0;
    const id = randomUUID();
    const timestamp = now.toISOString();
    tx.insert(projectAiRuns).values({
      id,
      projectId: input.projectId,
      kind: input.kind,
      requestKey,
      sequence: latest + 1,
      status: "pending",
      workerId: null,
      leaseToken: null,
      ownerAttempt: 0,
      ownerEpoch: 0,
      leaseExpiresAt: null,
      deadlineAt: new Date(
        now.getTime() + (input.deadlineMs ?? DEFAULT_DEADLINE_MS),
      ).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    }).run();
    return tx.select().from(projectAiRuns)
      .where(eq(projectAiRuns.id, id)).get()!;
  });
}

export async function acquireProjectAiRunLease(
  id: string,
  workerId: string,
  options: { now?: Date; leaseMs?: number } = {},
): Promise<ProjectAiRun & { fence: ProjectAiRunFence }> {
  const now = options.now ?? new Date();
  const run = readRun(id);
  if (["succeeded", "failed", "cancelled", "quarantined"].includes(run.status)) {
    throw new ProjectAiRunError("owner_terminal", "Project AI run is terminal");
  }
  if (Date.parse(run.deadlineAt) <= now.getTime()) {
    throw new ProjectAiRunError("owner_deadline_elapsed", "Project AI run deadline elapsed");
  }
  if (isLiveProjectAiRunLease(run, now)) {
    if (run.workerId === workerId) return Object.assign(run, { fence: fenceFor(run) });
    throw new ProjectAiRunError("owner_lease_busy", "Project AI run is leased");
  }

  const leaseExpiresAt = new Date(Math.min(
    now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS),
    Date.parse(run.deadlineAt),
  )).toISOString();
  const leaseToken = randomUUID();
  const updated = db.update(projectAiRuns).set({
    status: "leased",
    workerId,
    leaseToken,
    ownerAttempt: run.ownerAttempt + 1,
    ownerEpoch: run.ownerEpoch + 1,
    leaseExpiresAt,
    updatedAt: now.toISOString(),
  }).where(and(
    eq(projectAiRuns.id, id),
    eq(projectAiRuns.status, run.status),
    eq(projectAiRuns.ownerAttempt, run.ownerAttempt),
    eq(projectAiRuns.ownerEpoch, run.ownerEpoch),
  )).run();
  if (updated.changes !== 1) {
    throw new ProjectAiRunError("owner_claim_conflict", "Project AI run claim lost");
  }
  const leased = readRun(id);
  return Object.assign(leased, { fence: fenceFor(leased) });
}

export async function renewProjectAiRunLease(
  fence: ProjectAiRunFence,
  options: { now?: Date; leaseMs?: number } = {},
): Promise<ProjectAiRunFence> {
  const now = options.now ?? new Date();
  const run = readRun(fence.projectAiRunId);
  if (!isLiveProjectAiRunLease(run, now)) {
    throw new ProjectAiRunError("stale_owner_fence", "Project AI run lease is not live");
  }
  const nextExpiry = new Date(Math.min(
    now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS),
    Date.parse(fence.deadlineAt),
  )).toISOString();
  if (Date.parse(nextExpiry) <= Date.parse(fence.leaseExpiresAt)) return fenceFor(run);
  const updated = db.update(projectAiRuns).set({
    leaseExpiresAt: nextExpiry,
    updatedAt: now.toISOString(),
  }).where(fencePredicate(fence)).run();
  if (updated.changes !== 1) {
    throw new ProjectAiRunError("stale_owner_fence", "Project AI run renewal was fenced");
  }
  return fenceFor(readRun(fence.projectAiRunId));
}

export async function markProjectAiRunRunning(
  fence: ProjectAiRunFence,
): Promise<ProjectAiRun> {
  const updated = db.update(projectAiRuns).set({
    status: "running",
    updatedAt: new Date().toISOString(),
  }).where(and(
    fencePredicate(fence),
    eq(projectAiRuns.status, "leased"),
  )).run();
  if (updated.changes !== 1) {
    throw new ProjectAiRunError("stale_owner_fence", "Project AI run start was fenced");
  }
  return readRun(fence.projectAiRunId);
}

async function settle(
  fence: ProjectAiRunFence,
  status: "succeeded" | "failed" | "cancelled" | "quarantined",
): Promise<ProjectAiRun> {
  const timestamp = new Date().toISOString();
  const updated = db.update(projectAiRuns).set({
    status,
    completedAt: timestamp,
    updatedAt: timestamp,
  }).where(and(
    fencePredicate(fence),
    eq(projectAiRuns.status, "running"),
  )).run();
  if (updated.changes !== 1) {
    throw new ProjectAiRunError("stale_owner_fence", "Project AI run settlement was fenced");
  }
  return readRun(fence.projectAiRunId);
}

export const markProjectAiRunSucceeded = (fence: ProjectAiRunFence) =>
  settle(fence, "succeeded");

export const markProjectAiRunFailed = (fence: ProjectAiRunFence) =>
  settle(fence, "failed");

export const markProjectAiRunCancelled = (fence: ProjectAiRunFence) =>
  settle(fence, "cancelled");

export const markProjectAiRunQuarantined = (fence: ProjectAiRunFence) =>
  settle(fence, "quarantined");

export async function claimProjectAiRunForRecovery(
  id: string,
  workerId: string,
  options: { now?: Date; leaseMs?: number } = {},
) {
  return acquireProjectAiRunLease(id, workerId, options);
}

export function readProjectAiRun(id: string): ProjectAiRun | null {
  return db.select().from(projectAiRuns)
    .where(eq(projectAiRuns.id, id)).get() ?? null;
}
