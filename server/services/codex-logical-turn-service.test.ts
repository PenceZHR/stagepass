import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db, sqlite } from "../db";
import {
  changes,
  codexLogicalTurns,
  codexThreadBindings,
  pipelineJobs,
  projectAiRuns,
  projects,
} from "../db/schema";
import {
  resolveBuildTurn,
  resolveContextInitTurns,
  resolveFixTurn,
  resolveLogicalTurn,
  resolveProjectPrdTurn,
  resolveSpecLogicalTurns,
} from "./codex-logical-turn-service";
import {
  acquireProjectAiRunLease,
  createProjectAiRun,
} from "./project-ai-run-service";

const PROJECT_ID = "PRJ-TASK3-LOGICAL";
const CHANGE_ID = "CHG-TASK3-LOGICAL";
const JOB_ID = "JOB-TASK3-LOGICAL";
const NOW = "2026-07-24T00:00:00.000Z";

function future(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function cleanup(): void {
  db.delete(codexLogicalTurns).where(eq(codexLogicalTurns.pipelineJobId, JOB_ID)).run();
  const runs = db.select({ id: projectAiRuns.id }).from(projectAiRuns)
    .where(eq(projectAiRuns.projectId, PROJECT_ID)).all();
  for (const run of runs) {
    db.delete(codexLogicalTurns)
      .where(eq(codexLogicalTurns.projectAiRunId, run.id)).run();
  }
  db.delete(pipelineJobs).where(eq(pipelineJobs.id, JOB_ID)).run();
  db.delete(projectAiRuns).where(eq(projectAiRuns.projectId, PROJECT_ID)).run();
  db.delete(codexThreadBindings).where(eq(codexThreadBindings.projectId, PROJECT_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedBinding(input: {
  bindingId: string;
  scopeKind: "change_stage" | "project_prd" | "project_context";
  threadId: string;
}): void {
  db.insert(codexThreadBindings).values({
    bindingId: input.bindingId,
    scopeKind: input.scopeKind,
    scopeId: input.scopeKind === "change_stage" ? `${CHANGE_ID}:spec` : PROJECT_ID,
    projectId: PROJECT_ID,
    changeId: input.scopeKind === "change_stage" ? CHANGE_ID : null,
    codexProjectId: null,
    threadId: input.threadId,
    title: input.scopeKind === "change_stage"
      ? `[${CHANGE_ID}] spec · Logical`
      : `[${PROJECT_ID}] ${input.scopeKind === "project_prd" ? "Project PRD" : "Project Context"}`,
    status: "ready",
    bridgeProtocolVersion: "test",
    provisionClaimToken: null,
    provisionLeaseOwner: null,
    provisionLeaseExpiresAt: null,
    followerStartProvedAt: null,
    lastTurnId: null,
    lastObservationCursor: 0,
    lastSemanticSnapshotHash: null,
    lastSeenAt: NOW,
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

describe("codex logical turn service", { concurrency: false }, () => {
  beforeEach(() => {
    cleanup();
    db.insert(projects).values({
      id: PROJECT_ID,
      name: "Task 3 logical",
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
    db.insert(changes).values({
      id: CHANGE_ID,
      projectId: PROJECT_ID,
      title: "Logical",
      status: "SPECCING",
      provider: "codex",
      codexThreadId: "canonical-change-shell",
      fixIterations: 0,
      blockedPhase: null,
      reworkFromPhase: null,
      suspendedByPrd: 0,
      preSuspendStatus: null,
      gitBranch: null,
      gateState: null,
      docsComplete: 0,
      retroDone: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();
    seedBinding({
      bindingId: "BIND-TASK3-CHANGE",
      scopeKind: "change_stage",
      threadId: "canonical-change-shell",
    });
    seedBinding({
      bindingId: "BIND-TASK3-PRD",
      scopeKind: "project_prd",
      threadId: "canonical-prd-shell",
    });
    seedBinding({
      bindingId: "BIND-TASK3-CONTEXT",
      scopeKind: "project_context",
      threadId: "canonical-context-shell",
    });
    db.insert(pipelineJobs).values({
      id: JOB_ID,
      changeId: CHANGE_ID,
      phase: "spec",
      actionId: "run_spec",
      idempotencyKey: "task3-logical",
      status: "running",
      leasedBy: "worker-1",
      leaseExpiresAt: future(60_000),
      heartbeatAt: new Date().toISOString(),
      attemptNo: 1,
      errorCode: null,
      errorSummary: null,
      createdAt: NOW,
      startedAt: NOW,
      endedAt: null,
      leaseToken: "lease-task3",
      workerNonce: "nonce-task3",
      provider: "codex",
    }).run();
  });
  afterEach(cleanup);

  it("creates sequential Spec writer critic and verdict slots on one binding", async () => {
    const turns = await resolveSpecLogicalTurns({
      pipelineJobId: JOB_ID,
      round: 2,
    });
    assert.deepEqual(turns.map((turn) => turn.role), [
      "spec_writer",
      "spec_critic",
      "spec_verdict",
    ]);
    assert.equal(new Set(turns.map((turn) => turn.logicalTurnId)).size, 3);
    assert.equal(new Set(turns.map((turn) => turn.bindingId)).size, 1);
    assert.equal(new Set(turns.map((turn) => turn.runCorrelationId)).size, 3);
  });

  it("collapses duplicate slots, rejects caller identity, and rejects request hash drift", async () => {
    const input = {
      owner: { kind: "pipeline_job" as const, pipelineJobId: JOB_ID },
      phase: "Build",
      role: "build" as const,
      round: 3,
      ordinal: 0,
      request: { prompt: "same canonical input" },
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolveLogicalTurn(input)),
    );
    assert.equal(new Set(results.map((turn) => turn.logicalTurnId)).size, 1);
    await assert.rejects(
      resolveLogicalTurn({ ...input, callerRandom: crypto.randomUUID() } as never),
      (error: unknown) =>
        (error as { code?: unknown }).code === "logical_turn_input_invalid",
    );
    await assert.rejects(
      resolveLogicalTurn({ ...input, request: { prompt: "different" } }),
      (error: unknown) =>
        (error as { code?: unknown }).code === "logical_turn_request_conflict",
    );
  });

  it("validates owner lease, binding, slot read, and insert through one transaction handle", async () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "server/services/codex-logical-turn-service.ts"),
      "utf8",
    );
    assert.match(
      source,
      /db\.transaction\(\(tx\) => \{\s+const owner = resolveOwner\(tx, input,/,
    );
    assert.match(source, /const existing = readConflict\(tx, input\)/);
    assert.doesNotMatch(source, /const owner = resolveOwner\(input\)/);

    db.update(pipelineJobs).set({
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    }).where(eq(pipelineJobs.id, JOB_ID)).run();
    await assert.rejects(
      resolveLogicalTurn({
        owner: { kind: "pipeline_job", pipelineJobId: JOB_ID },
        phase: "Plan",
        role: "stage",
        round: 0,
        ordinal: 0,
      }),
      (error: unknown) =>
        (error as { code?: unknown }).code === "owner_lease_not_live",
    );
    assert.equal(
      db.select().from(codexLogicalTurns)
        .where(eq(codexLogicalTurns.pipelineJobId, JOB_ID)).all().length,
      0,
    );
  });

  it("preserves non-unique SQLite failures instead of rewriting them as slot conflicts", async () => {
    sqlite.exec(`
      CREATE TRIGGER task3_force_non_unique_logical_failure
      BEFORE INSERT ON codex_logical_turns
      WHEN NEW.phase = 'ForcedNonUnique'
      BEGIN
        SELECT RAISE(ABORT, 'forced_non_unique_logical_failure');
      END
    `);
    try {
      await assert.rejects(
        resolveLogicalTurn({
          owner: { kind: "pipeline_job", pipelineJobId: JOB_ID },
          phase: "ForcedNonUnique",
          role: "stage",
          round: 0,
          ordinal: 0,
        }),
        (error: unknown) => {
          assert.match(
            error instanceof Error ? error.message : "",
            /forced_non_unique_logical_failure/,
          );
          assert.notEqual(
            (error as { code?: unknown }).code,
            "logical_turn_request_conflict",
          );
          return true;
        },
      );
      assert.equal(
        db.select().from(codexLogicalTurns)
          .where(eq(codexLogicalTurns.pipelineJobId, JOB_ID)).all().length,
        0,
      );
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS task3_force_non_unique_logical_failure");
    }
  });

  it("reuses retry slots and separates Build and Fix rounds", async () => {
    assert.equal(
      (await resolveBuildTurn({ pipelineJobId: JOB_ID, round: 1, retry: 0 })).logicalTurnId,
      (await resolveBuildTurn({ pipelineJobId: JOB_ID, round: 1, retry: 9 })).logicalTurnId,
    );
    assert.notEqual(
      (await resolveBuildTurn({ pipelineJobId: JOB_ID, round: 1 })).logicalTurnId,
      (await resolveBuildTurn({ pipelineJobId: JOB_ID, round: 2 })).logicalTurnId,
    );
    assert.notEqual(
      (await resolveBuildTurn({ pipelineJobId: JOB_ID, round: 1 })).logicalTurnId,
      (await resolveFixTurn({ pipelineJobId: JOB_ID, round: 1 })).logicalTurnId,
    );
  });

  it("uses one PRD slot per owner and two Context slots on the project bindings", async () => {
    const prd1 = await createProjectAiRun({
      projectId: PROJECT_ID,
      kind: "prd_turn",
      requestKey: "prd-event-1",
    });
    const prd2 = await createProjectAiRun({
      projectId: PROJECT_ID,
      kind: "prd_turn",
      requestKey: "prd-event-2",
    });
    const context = await createProjectAiRun({
      projectId: PROJECT_ID,
      kind: "context_init",
      requestKey: "confirmed-revision-1",
    });
    await acquireProjectAiRunLease(prd1.id, "worker-prd-1");
    await acquireProjectAiRunLease(prd2.id, "worker-prd-2");
    await acquireProjectAiRunLease(context.id, "worker-context");

    const first = await resolveProjectPrdTurn(prd1.id);
    const second = await resolveProjectPrdTurn(prd2.id);
    assert.notEqual(first.logicalTurnId, second.logicalTurnId);
    assert.equal(first.bindingId, second.bindingId);

    const [select, generate] = await resolveContextInitTurns(context.id);
    assert.deepEqual([select.role, generate.role], [
      "context_select",
      "context_generate",
    ]);
    assert.notEqual(select.logicalTurnId, generate.logicalTurnId);
    assert.equal(select.bindingId, generate.bindingId);
    assert.notEqual(select.bindingId, first.bindingId);
  });
});
