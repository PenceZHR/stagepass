import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "../db";
import { projectAiRuns, projects } from "../db/schema";
import {
  acquireProjectAiRunLease,
  claimProjectAiRunForRecovery,
  createProjectAiRun,
  isLiveProjectAiRunLease,
  markProjectAiRunFailed,
  markProjectAiRunRunning,
  markProjectAiRunSucceeded,
  renewProjectAiRunLease,
} from "./project-ai-run-service";

const PROJECT_ID = "PRJ-TASK3-OWNER";
const NOW = "2026-07-24T00:00:00.000Z";

function cleanup(): void {
  db.delete(projectAiRuns).where(eq(projectAiRuns.projectId, PROJECT_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

describe("project AI run service", { concurrency: false }, () => {
  beforeEach(() => {
    cleanup();
    db.insert(projects).values({
      id: PROJECT_ID,
      name: "Task 3 owners",
      repoPath: process.cwd(),
      contextStatus: "ready",
      contextProvider: "codex",
      prdStatus: "ready",
      prdProvider: "codex",
      prdJson: null,
      prdMarkdown: null,
      gitEnabled: 0,
      gitDefaultBranch: null,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
  });
  afterEach(cleanup);

  it("creates one PRD owner per durable user event", async () => {
    const first = await createProjectAiRun({
      projectId: PROJECT_ID,
      kind: "prd_turn",
      requestKey: "user-event-1",
    });
    const duplicate = await createProjectAiRun({
      projectId: PROJECT_ID,
      kind: "prd_turn",
      requestKey: "user-event-1",
    });
    const second = await createProjectAiRun({
      projectId: PROJECT_ID,
      kind: "prd_turn",
      requestKey: "user-event-2",
    });
    assert.equal(first.id, duplicate.id);
    assert.notEqual(first.id, second.id);
    assert.deepEqual([first.sequence, second.sequence], [1, 2]);
  });

  it("enforces live lease renewal, running transition, stale fence, and terminal owner", async () => {
    const run = await createProjectAiRun({
      projectId: PROJECT_ID,
      kind: "context_init",
      requestKey: "confirmed-prd-revision-8",
    });
    const leased = await acquireProjectAiRunLease(run.id, "worker-1", {
      leaseMs: 5_000,
    });
    assert.equal(isLiveProjectAiRunLease(leased), true);
    const renewed = await renewProjectAiRunLease(leased.fence, {
      leaseMs: 20_000,
    });
    assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.parse(leased.fence.leaseExpiresAt));
    await assert.rejects(
      markProjectAiRunRunning(leased.fence),
      (error: unknown) =>
        (error as { code?: unknown }).code === "stale_owner_fence",
    );
    await markProjectAiRunRunning(renewed);
    await markProjectAiRunSucceeded(renewed);
    await assert.rejects(
      acquireProjectAiRunLease(run.id, "worker-2"),
      (error: unknown) => (error as { code?: unknown }).code === "owner_terminal",
    );
  });

  it("reports expired lease and deadline fixtures as not live", () => {
    const now = new Date();
    assert.equal(isLiveProjectAiRunLease({
      status: "running",
      workerId: "worker",
      leaseToken: "lease",
      leaseExpiresAt: new Date(now.getTime() - 1).toISOString(),
      deadlineAt: new Date(now.getTime() + 10_000).toISOString(),
    }, now), false);
    assert.equal(isLiveProjectAiRunLease({
      status: "leased",
      workerId: "worker",
      leaseToken: "lease",
      leaseExpiresAt: new Date(now.getTime() + 10_000).toISOString(),
      deadlineAt: new Date(now.getTime() - 1).toISOString(),
    }, now), false);
  });

  it("reclaims an expired owner with a new fence and settles failure", async () => {
    const timestamp = new Date().toISOString();
    const id = "PROJECT-AI-RUN-EXPIRED";
    db.insert(projectAiRuns).values({
      id,
      projectId: PROJECT_ID,
      kind: "context_init",
      requestKey: "expired-owner",
      sequence: 1,
      status: "leased",
      workerId: "worker-old",
      leaseToken: "lease-old",
      ownerAttempt: 1,
      ownerEpoch: 1,
      leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    }).run();
    const recovered = await claimProjectAiRunForRecovery(id, "worker-new");
    assert.equal(recovered.ownerAttempt, 2);
    assert.equal(recovered.ownerEpoch, 2);
    assert.notEqual(recovered.leaseToken, "lease-old");
    await markProjectAiRunRunning(recovered.fence);
    const failed = await markProjectAiRunFailed(recovered.fence);
    assert.equal(failed.status, "failed");
  });
});
