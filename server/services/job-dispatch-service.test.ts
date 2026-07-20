import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { db } from "../db";
import { runMigrations } from "../db/migrate";
import * as dbSchema from "../db/schema";
import { apiSnapshots, artifacts, changes, events, findings, pipelineJobs, prdBriefings, projects, requiredValidationCommands, reviewAttempts, reviewReports, reviewState, runs, stageActions, stageGates, stageReports, stageRuns, stageStates, techspecSnapshots, testplanCoverageItems, testplanManualChecks, testplanRiskMappings, testplanSnapshots } from "../db/schema";
import {
  enqueueProviderActionAtomically,
  enqueuePipelineJob,
  ensurePipelineJobsTable,
  setJobDispatchDbForTest,
  type JobDispatchDb,
} from "./job-dispatch-service";
import { computeSourceDbHash } from "./stage-authority-service";

const PROJECT_ID = "PRJ-JOB-DISPATCH";
const CHANGE_ID = "CHG-JOB-DISPATCH";

function cleanupRows(): void {
  ensurePipelineJobsTable();
  db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(stageActions).where(eq(stageActions.changeId, CHANGE_ID)).run();
  db.delete(findings).where(eq(findings.changeId, CHANGE_ID)).run();
  db.delete(reviewState).where(eq(reviewState.changeId, CHANGE_ID)).run();
  db.delete(reviewReports).where(eq(reviewReports.changeId, CHANGE_ID)).run();
  db.delete(reviewAttempts).where(eq(reviewAttempts.changeId, CHANGE_ID)).run();
  db.delete(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).run();
  db.delete(artifacts).where(eq(artifacts.changeId, CHANGE_ID)).run();
  db.delete(apiSnapshots).where(eq(apiSnapshots.changeId, CHANGE_ID)).run();
  db.delete(techspecSnapshots).where(eq(techspecSnapshots.changeId, CHANGE_ID)).run();
  const testplanIds = db.select({ id: testplanSnapshots.id }).from(testplanSnapshots)
    .where(eq(testplanSnapshots.changeId, CHANGE_ID)).all().map((row) => row.id);
  for (const snapshotId of testplanIds) {
    db.delete(testplanCoverageItems).where(eq(testplanCoverageItems.testplanSnapshotId, snapshotId)).run();
    db.delete(testplanRiskMappings).where(eq(testplanRiskMappings.testplanSnapshotId, snapshotId)).run();
    db.delete(testplanManualChecks).where(eq(testplanManualChecks.testplanSnapshotId, snapshotId)).run();
  }
  db.delete(requiredValidationCommands).where(eq(requiredValidationCommands.changeId, CHANGE_ID)).run();
  db.delete(testplanSnapshots).where(eq(testplanSnapshots.changeId, CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
  db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
  db.delete(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(): void {
  const now = "2026-07-10T00:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Job dispatch",
    repoPath: process.cwd(),
    contextStatus: "ready",
    contextProvider: "codex",
    prdStatus: "ready",
    prdProvider: "codex",
    prdJson: null,
    prdMarkdown: null,
    gitEnabled: 0,
    gitDefaultBranch: null,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Dispatch job",
    status: "INTAKE_READY",
    provider: "codex",
    codexThreadId: null,
    fixIterations: 0,
    blockedPhase: null,
    reworkFromPhase: null,
    suspendedByPrd: 0,
    preSuspendStatus: null,
    gitBranch: null,
    gateState: null,
    docsComplete: 0,
    retroDone: 0,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function seedPlanAuthority(sourceDbHash = "techspec-authority", gateVersion = 3): void {
  const now = "2026-07-10T00:00:00.000Z";
  db.update(changes).set({ status: "TECHSPEC_READY" }).where(eq(changes.id, CHANGE_ID)).run();
  const runId = `STG-AUTH-${gateVersion}`;
  const businessRunId = `RUN-AUTH-${gateVersion}`;
  db.insert(stageRuns).values({
    id: runId, changeId: CHANGE_ID, phase: "TechSpec", attemptNo: gateVersion,
    status: "completed", idempotencyKey: null, inputDbHash: null, outputDbHash: sourceDbHash,
    sourceLineageJson: "{}", errorCode: null, startedAt: now, completedAt: now,
  }).run();
  db.insert(runs).values({
    id: businessRunId, changeId: CHANGE_ID, phase: "tech_spec", status: "completed",
    startedAt: now, endedAt: now, summary: null, attemptNo: gateVersion,
  }).run();
  db.insert(artifacts).values({
    id: `ART-AUTH-${gateVersion}`, changeId: CHANGE_ID, runId: businessRunId, type: "tech_spec_delta",
    path: `/fixture/tech-spec-${gateVersion}.md`, createdAt: now,
  }).run();
  db.insert(stageGates).values({
    id: `GATE-AUTH-${gateVersion}`, changeId: CHANGE_ID, phase: "TechSpec", status: "passed",
    blockersJson: "[]", freshnessJson: "{}", requiredActionsJson: "[]", sourceDbHash,
    gateVersion, computedAt: now,
  }).run();
}

function seedApprovedTestPlanAuthority(snapshotId = "TPL-SNAP-PRODUCTION"): string {
  const now = "2026-07-10T00:00:00.000Z";
  db.update(changes).set({ status: "PLAN_APPROVED", gateState: "test_plan" })
    .where(eq(changes.id, CHANGE_ID)).run();
  db.insert(testplanSnapshots).values({
    id: snapshotId, changeId: CHANGE_ID, status: "approved", testIntent: "Exercise the real backend",
    schemaVersion: "testplan/v1", approvalState: "approved", approvedAt: now,
    approvalDecisionId: null, snapshotDbHash: "testplan-content-hash", createdAt: now,
  }).run();
  db.insert(testplanCoverageItems).values({
    id: `${snapshotId}-COV`, testplanSnapshotId: snapshotId, itemKey: "REQ-1",
    title: "Backend flow", requirementRef: "REQ-1", testType: "integration", priority: "P0",
    status: "planned", createdAt: now,
  }).run();
  db.insert(testplanRiskMappings).values({
    id: `${snapshotId}-RISK`, testplanSnapshotId: snapshotId, coverageItemKey: "REQ-1",
    riskRef: "RISK-1", severity: "P0", mitigation: "Run the backend flow", createdAt: now,
  }).run();
  db.insert(requiredValidationCommands).values({
    id: `${snapshotId}-CMD`, changeId: CHANGE_ID, phase: "TestPlan", sourceSnapshotId: snapshotId,
    command: "pnpm test", commandOrder: 1, required: 1, createdAt: now,
  }).run();
  db.insert(testplanManualChecks).values({
    id: `${snapshotId}-MAN`, testplanSnapshotId: snapshotId, title: "Inspect persisted artifact",
    description: "Verify the file exists", required: 1, status: "pending", createdAt: now,
  }).run();
  const snapshot = db.select().from(testplanSnapshots).where(eq(testplanSnapshots.id, snapshotId)).get()!;
  const coverage = db.select().from(testplanCoverageItems)
    .where(eq(testplanCoverageItems.testplanSnapshotId, snapshotId)).all();
  const risks = db.select().from(testplanRiskMappings)
    .where(eq(testplanRiskMappings.testplanSnapshotId, snapshotId)).all();
  const commands = db.select().from(requiredValidationCommands)
    .where(eq(requiredValidationCommands.sourceSnapshotId, snapshotId)).all();
  const manual = db.select().from(testplanManualChecks)
    .where(eq(testplanManualChecks.testplanSnapshotId, snapshotId)).all();
  const sourceDbHash = computeSourceDbHash({
    changeId: CHANGE_ID, phase: "TestPlan", rows: [snapshot, ...coverage, ...risks, ...commands, ...manual],
  });
  db.insert(stageGates).values({
    id: `${snapshotId}-GATE`, changeId: CHANGE_ID, phase: "TestPlan", status: "passed",
    blockersJson: "[]", freshnessJson: "{}", requiredActionsJson: "[]",
    sourceDbHash, gateVersion: 1, computedAt: now,
  }).run();
  return sourceDbHash;
}

describe("job-dispatch-service", { concurrency: false }, () => {
  beforeEach(() => {
    cleanupRows();
    seedChange();
  });

  afterEach(() => {
    cleanupRows();
  });

  it("enqueues a queued pipeline job and emits pipeline_job_queued", () => {
    const result = enqueuePipelineJob({
      changeId: CHANGE_ID,
      phase: "spec",
      actionId: "run_spec",
      idempotencyKey: "idem-1",
    });

    assert.equal(result.created, true);
    assert.equal(result.job.status, "queued");
    assert.equal(result.job.changeId, CHANGE_ID);
    assert.equal(result.job.phase, "spec");
    assert.equal(result.job.actionId, "run_spec");
    assert.equal(result.job.idempotencyKey, "idem-1");

    const event = db
      .select()
      .from(events)
      .where(eq(events.changeId, CHANGE_ID))
      .all()
      .find((row) => row.type === "pipeline_job_queued");
    assert.ok(event);
    const payload = JSON.parse(event.rawJson ?? "{}").pipelineJob;
    assert.equal(payload.jobId, result.job.id);
    assert.equal(payload.actionId, "run_spec");
  });

  it("persists the requested provider and returns it in the queue audit", () => {
    const result = enqueuePipelineJob({
      changeId: CHANGE_ID,
      phase: "spec",
      actionId: "run_spec",
      provider: "claude",
      idempotencyKey: "provider-claude-1",
    });

    assert.equal(result.job.provider, "claude");
    const event = db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all()
      .find((row) => row.type === "pipeline_job_queued");
    assert.equal(JSON.parse(event?.rawJson ?? "{}").pipelineJob.provider, "claude");
  });

  it("rejects reusing an idempotency key with a different provider", () => {
    enqueuePipelineJob({
      changeId: CHANGE_ID,
      phase: "spec",
      actionId: "run_spec",
      provider: "codex",
      idempotencyKey: "provider-conflict-1",
    });

    assert.throws(
      () => enqueuePipelineJob({
        changeId: CHANGE_ID,
        phase: "spec",
        actionId: "run_spec",
        provider: "claude",
        idempotencyKey: "provider-conflict-1",
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "provider_selection_conflict",
    );
  });

  it("resolves omitted provider from the Change once and keeps the queued value immutable", () => {
    db.update(changes).set({ provider: "claude" }).where(eq(changes.id, CHANGE_ID)).run();
    const result = enqueuePipelineJob({
      changeId: CHANGE_ID,
      phase: "spec",
      actionId: "run_spec",
      idempotencyKey: "provider-fallback-1",
    });
    db.update(changes).set({ provider: "codex" }).where(eq(changes.id, CHANGE_ID)).run();
    assert.equal(result.job.provider, "claude");
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.id, result.job.id)).get()?.provider, "claude");
  });

  it("treats an omitted provider as the current default for idempotency conflicts", () => {
    enqueuePipelineJob({
      changeId: CHANGE_ID,
      phase: "spec",
      actionId: "run_spec",
      provider: "claude",
      idempotencyKey: "provider-default-drift-1",
    });
    db.update(changes).set({ provider: "codex" }).where(eq(changes.id, CHANGE_ID)).run();

    assert.throws(
      () => enqueuePipelineJob({
        changeId: CHANGE_ID,
        phase: "spec",
        actionId: "run_spec",
        idempotencyKey: "provider-default-drift-1",
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "provider_selection_conflict",
    );
  });

  it("returns an explicit conflict for active same-phase jobs instead of leaking SQLite errors", () => {
    enqueuePipelineJob({
      changeId: CHANGE_ID,
      phase: "spec",
      actionId: "run_spec",
      provider: "codex",
    });

    assert.throws(
      () => enqueuePipelineJob({
        changeId: CHANGE_ID,
        phase: "spec",
        actionId: "retry_spec",
        provider: "claude",
      }),
      (error: unknown) => error instanceof Error && "code" in error &&
        (error.code === "provider_selection_conflict" || error.code === "pipeline_job_conflict"),
    );
  });

  it("rejects provider selection for provider-free local actions", () => {
    assert.throws(
      () => enqueuePipelineJob({
        changeId: CHANGE_ID,
        phase: "local_check",
        actionId: "run_qa",
        provider: "claude",
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "provider_not_applicable",
    );
  });

  it("deduplicates repeated idempotency keys for the same change and action", () => {
    const first = enqueuePipelineJob({
      changeId: CHANGE_ID,
      phase: "spec",
      actionId: "run_spec",
      idempotencyKey: "same-key",
    });
    const second = enqueuePipelineJob({
      changeId: CHANGE_ID,
      phase: "spec",
      actionId: "run_spec",
      idempotencyKey: "same-key",
    });

    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    const jobs = db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all();
    assert.equal(jobs.length, 1);
    const persisted = jobs[0];
    assert.deepEqual(second.job, persisted);
  });

  it("keeps one active job per change and phase without an idempotency key", async () => {
    const [first, second] = await Promise.all([
      new Promise<ReturnType<typeof enqueuePipelineJob>>((resolve, reject) => setImmediate(() => {
        try { resolve(enqueuePipelineJob({ changeId: CHANGE_ID, phase: "spec", actionId: "run_spec" })); }
        catch (error) { reject(error); }
      })),
      new Promise<ReturnType<typeof enqueuePipelineJob>>((resolve, reject) => setImmediate(() => {
        try { resolve(enqueuePipelineJob({ changeId: CHANGE_ID, phase: "spec", actionId: "run_spec" })); }
        catch (error) { reject(error); }
      })),
    ]);

    assert.equal(first.job.id, second.job.id);
    assert.equal([first.created, second.created].filter(Boolean).length, 1);
    const active = db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all()
      .filter((job) => ["queued", "leased", "running"].includes(job.status));
    assert.equal(active.length, 1);
  });

  it("atomically rejects enqueue when the persisted action contract drifted", () => {
    const now = new Date().toISOString();
    db.insert(stageActions).values({
      id: "STG-ACT-ATOMIC",
      changeId: CHANGE_ID,
      phase: "Spec",
      actionId: "run_spec",
      enabled: 1,
      reasonCode: null,
      reason: null,
      blockersJson: "[]",
      gateVersion: 2,
      sourceDbHash: "current-hash",
      requiresIdempotencyKey: 0,
      computedAt: now,
    }).run();

    assert.throws(
      () => enqueueProviderActionAtomically({
        changeId: CHANGE_ID,
        phase: "spec",
        actionId: "run_spec",
      }, {
        actionId: "run_spec",
        enabled: true,
        gateVersion: "1",
        sourceDbHash: "stale-hash",
      }),
      /action_contract_drift/,
    );
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all().length, 0);
  });

  it("atomically queues fix_blockers against the same Review report fence exposed by getActions", () => {
    const now = "2026-07-10T00:00:00.000Z";
    db.update(changes).set({ status: "CHECK_FAILED" }).where(eq(changes.id, CHANGE_ID)).run();
    db.insert(runs).values({
      id: "RUN-REVIEW-FIX", changeId: CHANGE_ID, phase: "review", status: "completed",
      startedAt: now, endedAt: now, summary: "Review completed", attemptNo: 1,
    }).run();
    db.insert(reviewAttempts).values({
      id: "RAT-REVIEW-FIX", changeId: CHANGE_ID, runId: "RUN-REVIEW-FIX", attemptNo: 1,
      status: "completed", provider: "codex", reviewStatus: "passed",
      idempotencyKey: "review-fix-source", sourceBuildRunId: "build-1", sourceHeadSha: "head-1",
      priorBlockingFindingIdsJson: "[]", startedAt: now, endedAt: now, completedAt: now,
      createdAt: now, updatedAt: now,
    }).run();
    db.insert(reviewReports).values({
      id: "RRP-REVIEW-FIX", attemptId: "RAT-REVIEW-FIX", changeId: CHANGE_ID,
      reportVersion: 3, reviewConclusion: "issues_found", reportDbHash: "review-fix-report-hash",
      gateStatus: "blocked_p1", qaAllowed: 0, sourceBuildRunId: "build-1", sourceHeadSha: "head-1",
      findingVersion: 1, waiverVersion: 1, blockingP0: 0, blockingP1: 1,
      waivedP1: 0, p2Count: 0, findingsDbHash: "review-fix-findings-hash",
      generatedAt: now, createdAt: now,
    }).run();
    db.insert(reviewState).values({
      changeId: CHANGE_ID, latestAttemptId: "RAT-REVIEW-FIX", latestAttemptNo: 1,
      latestReportId: "RRP-REVIEW-FIX", latestValidReviewReportId: "RRP-REVIEW-FIX",
      latestValidAttemptNo: 1, gateStatus: "blocked_p1", reviewStatus: "passed",
      sourceBuildRunId: "build-1", sourceHeadSha: "head-1", reportDbHash: "review-fix-report-hash",
      findingVersion: 1, waiverVersion: 1, updatedAt: now,
    }).run();
    db.insert(findings).values({
      id: "FND-REVIEW-FIX", changeId: CHANGE_ID, runId: "RUN-REVIEW-FIX",
      source: "review", severity: "P1", category: "logic", title: "Review blocker",
      evidence: "Review evidence", requiredFix: "Fix the blocker", status: "open",
      reviewAttemptId: "RAT-REVIEW-FIX", sourceBuildRunId: "build-1", sourceHeadSha: "head-1",
      waivable: 1, createdAt: now,
    }).run();

    const result = enqueueProviderActionAtomically({
      changeId: CHANGE_ID,
      phase: "fix_findings",
      actionId: "fix_blockers",
      idempotencyKey: "fix-review-blocker",
    }, {
      actionId: "fix_blockers",
      enabled: true,
      gateVersion: "3",
      sourceDbHash: "review-fix-report-hash",
    });

    assert.equal(result.created, true);
    assert.equal(result.job.actionId, "fix_blockers");
  });

  it("re-evaluates PRD briefing authority inside enqueue instead of trusting a prior check", () => {
    const now = new Date().toISOString();
    db.insert(prdBriefings).values({
      id: "PBR-ATOMIC",
      changeId: CHANGE_ID,
      status: "intent_captured",
      intentText: "Build the requested change",
      finalReviewJson: null,
      sourceHashesJson: "{}",
      lockedAt: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.update(prdBriefings).set({ status: "locked" }).where(eq(prdBriefings.changeId, CHANGE_ID)).run();

    assert.throws(() => enqueueProviderActionAtomically({
      changeId: CHANGE_ID,
      phase: "prd_briefing_questions",
      actionId: "run_prd_briefing_questions",
    }), /action_contract_drift/);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all().length, 0);
  });

  it("atomically queues an enabled PRD briefing action through the shared provider entry", () => {
    const now = new Date().toISOString();
    db.insert(prdBriefings).values({
      id: "PBR-ATOMIC-OK",
      changeId: CHANGE_ID,
      status: "intent_captured",
      intentText: "Build the requested change",
      finalReviewJson: null,
      sourceHashesJson: "briefing-source",
      lockedAt: null,
      createdAt: now,
      updatedAt: now,
    }).run();

    const result = enqueueProviderActionAtomically({
      changeId: CHANGE_ID,
      phase: "prd_briefing_questions",
      actionId: "run_prd_briefing_questions",
    });
    assert.equal(result.created, true);
    assert.equal(result.job.actionId, "run_prd_briefing_questions");
  });

  it("derives provider authority without a stage_actions cache row", () => {
    seedPlanAuthority();
    const result = enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "generate_plan", actionId: "run_plan",
    }, {
      actionId: "run_plan", enabled: true, gateVersion: "3", sourceDbHash: "techspec-authority",
    });
    assert.equal(result.created, true);
  });

  it("atomically queues Plan from the TechSpec snapshot pair that produced the gate hash", () => {
    const now = "2026-07-10T00:00:00.000Z";
    db.update(changes).set({ status: "TECHSPEC_READY", gateState: "tech_spec" })
      .where(eq(changes.id, CHANGE_ID)).run();
    db.insert(techspecSnapshots).values({
      id: "TECHSPEC-PRODUCTION", changeId: CHANGE_ID, status: "approved",
      sourceSpecHash: "spec-source", contentJson: "{}", contentDbHash: "tech-content-hash",
      schemaVersion: "techspec/v1", reviewedAt: now, createdAt: now,
    }).run();
    db.insert(apiSnapshots).values({
      id: "API-PRODUCTION", changeId: CHANGE_ID, status: "approved",
      sourceTechspecHash: "tech-content-hash", contractJson: "{}", contractDbHash: "api-contract-hash",
      schemaVersion: "api/v1", reviewedAt: now, createdAt: now,
    }).run();
    const sourceDbHash = computeSourceDbHash({
      changeId: CHANGE_ID,
      phase: "TechSpec",
      rows: [
        { table: "techspec_snapshots", id: "TECHSPEC-PRODUCTION", contentDbHash: "tech-content-hash" },
        { table: "api_snapshots", id: "API-PRODUCTION", contractDbHash: "api-contract-hash" },
      ],
    });
    db.insert(stageGates).values({
      id: "GATE-TECHSPEC-PRODUCTION", changeId: CHANGE_ID, phase: "TechSpec", status: "passed",
      blockersJson: "[]", freshnessJson: "{}", requiredActionsJson: "[]",
      sourceDbHash, gateVersion: 1, computedAt: now,
    }).run();

    const result = enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "generate_plan", actionId: "run_plan",
      idempotencyKey: "production-techspec-plan",
    }, {
      actionId: "run_plan", enabled: true, gateVersion: "1", sourceDbHash,
    });
    assert.equal(result.created, true);
    assert.equal(result.job.phase, "generate_plan");
  });

  it("rejects Plan when the TechSpec snapshot pair no longer matches the gate source", () => {
    const now = "2026-07-10T00:00:00.000Z";
    db.update(changes).set({ status: "TECHSPEC_READY", gateState: "tech_spec" })
      .where(eq(changes.id, CHANGE_ID)).run();
    db.insert(techspecSnapshots).values({
      id: "TECHSPEC-STALE", changeId: CHANGE_ID, status: "approved",
      sourceSpecHash: "spec-source", contentJson: "{}", contentDbHash: "tech-content-hash",
      schemaVersion: "techspec/v1", reviewedAt: now, createdAt: now,
    }).run();
    db.insert(apiSnapshots).values({
      id: "API-STALE", changeId: CHANGE_ID, status: "approved",
      sourceTechspecHash: "tech-content-hash", contractJson: "{}", contractDbHash: "api-contract-hash",
      schemaVersion: "api/v1", reviewedAt: now, createdAt: now,
    }).run();
    const sourceDbHash = computeSourceDbHash({
      changeId: CHANGE_ID,
      phase: "TechSpec",
      rows: [
        { table: "techspec_snapshots", id: "TECHSPEC-STALE", contentDbHash: "tech-content-hash" },
        { table: "api_snapshots", id: "API-STALE", contractDbHash: "api-contract-hash" },
      ],
    });
    db.insert(stageGates).values({
      id: "GATE-TECHSPEC-STALE", changeId: CHANGE_ID, phase: "TechSpec", status: "passed",
      blockersJson: "[]", freshnessJson: "{}", requiredActionsJson: "[]",
      sourceDbHash, gateVersion: 1, computedAt: now,
    }).run();
    db.update(apiSnapshots).set({ contractDbHash: "api-contract-hash-mutated" })
      .where(eq(apiSnapshots.id, "API-STALE")).run();

    assert.throws(() => enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "generate_plan", actionId: "run_plan",
      idempotencyKey: "stale-techspec-plan",
    }, {
      actionId: "run_plan", enabled: true, gateVersion: "1", sourceDbHash,
    }), /action_contract_drift/);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
  });

  it("does not fall back to legacy authority when only an invalid TechSpec snapshot exists", () => {
    const now = "2026-07-10T00:00:00.000Z";
    seedPlanAuthority();
    db.insert(techspecSnapshots).values({
      id: "TECHSPEC-INVALID-ONLY", changeId: CHANGE_ID, status: "draft",
      sourceSpecHash: "spec-source", contentJson: "{}", contentDbHash: "",
      schemaVersion: "techspec/v1", reviewedAt: null, createdAt: now,
    }).run();

    assert.throws(() => enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "generate_plan", actionId: "run_plan",
      idempotencyKey: "invalid-techspec-only-plan",
    }, {
      actionId: "run_plan", enabled: true, gateVersion: "3", sourceDbHash: "techspec-authority",
    }), /action_contract_drift/);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
  });

  it("does not fall back to legacy authority when both snapshot tables contain only non-authoritative rows", () => {
    const now = "2026-07-10T00:00:00.000Z";
    seedPlanAuthority();
    db.insert(techspecSnapshots).values({
      id: "TECHSPEC-REJECTED", changeId: CHANGE_ID, status: "rejected",
      sourceSpecHash: "spec-source", contentJson: "{}", contentDbHash: "rejected-tech-hash",
      schemaVersion: "techspec/v1", reviewedAt: now, createdAt: now,
    }).run();
    db.insert(apiSnapshots).values({
      id: "API-DRAFT", changeId: CHANGE_ID, status: "draft",
      sourceTechspecHash: "rejected-tech-hash", contractJson: "{}", contractDbHash: "draft-api-hash",
      schemaVersion: "api/v1", reviewedAt: null, createdAt: now,
    }).run();

    assert.throws(() => enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "generate_plan", actionId: "run_plan",
      idempotencyKey: "non-authoritative-snapshots-plan",
    }, {
      actionId: "run_plan", enabled: true, gateVersion: "3", sourceDbHash: "techspec-authority",
    }), /action_contract_drift/);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
  });

  it("atomically queues Build from the approved TestPlan snapshot and all gate authority rows", () => {
    const sourceDbHash = seedApprovedTestPlanAuthority();

    const result = enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "implement", actionId: "run_build",
      idempotencyKey: "production-testplan-build",
    }, {
      actionId: "run_build", enabled: true, gateVersion: "1", sourceDbHash,
    });
    assert.equal(result.created, true);
    assert.equal(result.job.phase, "implement");
  });

  it("rejects Build when any TestPlan gate authority child row is missing", () => {
    const sourceDbHash = seedApprovedTestPlanAuthority("TPL-SNAP-PARTIAL");
    db.delete(testplanManualChecks)
      .where(eq(testplanManualChecks.testplanSnapshotId, "TPL-SNAP-PARTIAL")).run();

    assert.throws(() => enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "implement", actionId: "run_build",
      idempotencyKey: "partial-testplan-build",
    }, {
      actionId: "run_build", enabled: true, gateVersion: "1", sourceDbHash,
    }), /action_contract_drift/);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
  });

  it("rejects Build when the TestPlan snapshot is no longer approved", () => {
    const sourceDbHash = seedApprovedTestPlanAuthority("TPL-SNAP-NONAPPROVED");
    db.update(testplanSnapshots).set({ status: "draft", approvalState: "pending" })
      .where(eq(testplanSnapshots.id, "TPL-SNAP-NONAPPROVED")).run();

    assert.throws(() => enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "implement", actionId: "run_build",
      idempotencyKey: "nonapproved-testplan-build",
    }, {
      actionId: "run_build", enabled: true, gateVersion: "1", sourceDbHash,
    }), /action_contract_drift/);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
  });

  it("atomically queues TechSpec from an approved Spec authority whose stage and provider attempts differ", () => {
    const now = "2026-07-10T00:00:00.000Z";
    const sourceDbHash = "approved-spec-authority";
    db.update(changes).set({ status: "SPEC_READY", gateState: "spec" })
      .where(eq(changes.id, CHANGE_ID)).run();
    db.insert(stageRuns).values({
      id: "STG-RUN-SPEC-20", changeId: CHANGE_ID, phase: "Spec", attemptNo: 20,
      status: "passed", idempotencyKey: null, inputDbHash: sourceDbHash,
      outputDbHash: sourceDbHash, sourceLineageJson: "{}", errorCode: null,
      startedAt: now, completedAt: now,
    }).run();
    db.insert(stageGates).values({
      id: "GATE-SPEC-APPROVED", changeId: CHANGE_ID, phase: "Spec", status: "pass",
      blockersJson: "[]", freshnessJson: "{}", requiredActionsJson: "[]",
      sourceDbHash, gateVersion: 1, computedAt: now,
    }).run();
    db.insert(runs).values({
      id: "RUN-SPEC-PROVIDER-1", changeId: CHANGE_ID, phase: "spec", status: "completed",
      startedAt: now, endedAt: now, summary: "Spec battle completed", attemptNo: 1,
    }).run();

    const result = enqueueProviderActionAtomically({
      changeId: CHANGE_ID,
      phase: "tech_spec",
      actionId: "run_tech_spec",
      idempotencyKey: "approved-spec-to-techspec",
    }, {
      actionId: "run_tech_spec",
      enabled: true,
      gateVersion: "1",
      sourceDbHash,
    });

    assert.equal(result.created, true);
    assert.equal(result.job.phase, "tech_spec");
  });

  it("fails closed when the approved Spec source run stops passing before TechSpec enqueue", () => {
    const now = "2026-07-10T00:00:00.000Z";
    const sourceDbHash = "drifted-spec-authority";
    db.update(changes).set({ status: "SPEC_READY", gateState: "spec" })
      .where(eq(changes.id, CHANGE_ID)).run();
    db.insert(stageRuns).values({
      id: "STG-RUN-SPEC-DRIFT", changeId: CHANGE_ID, phase: "Spec", attemptNo: 7,
      status: "issues_found", idempotencyKey: null, inputDbHash: sourceDbHash,
      outputDbHash: sourceDbHash, sourceLineageJson: "{}", errorCode: null,
      startedAt: now, completedAt: now,
    }).run();
    db.insert(stageGates).values({
      id: "GATE-SPEC-STALE-PASS", changeId: CHANGE_ID, phase: "Spec", status: "pass",
      blockersJson: "[]", freshnessJson: "{}", requiredActionsJson: "[]",
      sourceDbHash, gateVersion: 1, computedAt: now,
    }).run();

    assert.throws(() => enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "tech_spec", actionId: "run_tech_spec",
    }, {
      actionId: "run_tech_spec", enabled: true, gateVersion: "1", sourceDbHash,
    }), /action_contract_drift/);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
  });

  for (const duplicateStatuses of [["passed", "issues_found"], ["passed", "passed"]] as const) {
    it(`fails closed for duplicate Spec source hashes with ${duplicateStatuses.join("/")} runs`, () => {
      const now = "2026-07-10T00:00:00.000Z";
      const sourceDbHash = `duplicate-spec-${duplicateStatuses.join("-")}`;
      db.update(changes).set({ status: "SPEC_READY", gateState: "spec" })
        .where(eq(changes.id, CHANGE_ID)).run();
      duplicateStatuses.forEach((status, index) => {
        db.insert(stageRuns).values({
          id: `STG-RUN-DUPLICATE-${index}`, changeId: CHANGE_ID, phase: "Spec", attemptNo: index + 1,
          status, idempotencyKey: null, inputDbHash: sourceDbHash, outputDbHash: sourceDbHash,
          sourceLineageJson: "{}", errorCode: null, startedAt: now, completedAt: now,
        }).run();
      });
      db.insert(stageGates).values({
        id: "GATE-SPEC-DUPLICATE", changeId: CHANGE_ID, phase: "Spec", status: "pass",
        blockersJson: "[]", freshnessJson: "{}", requiredActionsJson: "[]",
        sourceDbHash, gateVersion: 1, computedAt: now,
      }).run();

      assert.throws(() => enqueueProviderActionAtomically({
        changeId: CHANGE_ID, phase: "tech_spec", actionId: "run_tech_spec",
      }, {
        actionId: "run_tech_spec", enabled: true, gateVersion: "1", sourceDbHash,
      }), /action_contract_drift/);
      assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
    });
  }

  it("does not authorize TechSpec from a different phase that happens to share the Spec gate hash", () => {
    const now = "2026-07-10T00:00:00.000Z";
    const sourceDbHash = "cross-phase-shared-hash";
    db.update(changes).set({ status: "SPEC_READY", gateState: "spec" })
      .where(eq(changes.id, CHANGE_ID)).run();
    db.insert(stageRuns).values({
      id: "STG-RUN-WRONG-PHASE", changeId: CHANGE_ID, phase: "TechSpec", attemptNo: 1,
      status: "passed", idempotencyKey: null, inputDbHash: sourceDbHash,
      outputDbHash: sourceDbHash, sourceLineageJson: "{}", errorCode: null,
      startedAt: now, completedAt: now,
    }).run();
    db.insert(stageGates).values({
      id: "GATE-SPEC-CROSS-PHASE", changeId: CHANGE_ID, phase: "Spec", status: "pass",
      blockersJson: "[]", freshnessJson: "{}", requiredActionsJson: "[]",
      sourceDbHash, gateVersion: 1, computedAt: now,
    }).run();

    assert.throws(() => enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "tech_spec", actionId: "run_tech_spec",
    }, {
      actionId: "run_tech_spec", enabled: true, gateVersion: "1", sourceDbHash,
    }), /action_contract_drift/);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
  });

  it("fails closed when a provider action requires a missing snapshot gate", () => {
    db.update(changes).set({ status: "SPEC_READY", gateState: "spec" })
      .where(eq(changes.id, CHANGE_ID)).run();
    assert.throws(() => enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "tech_spec", actionId: "run_tech_spec",
    }, {
      actionId: "run_tech_spec", enabled: true, gateVersion: "0", sourceDbHash: "__missing_gate__",
    }), /action_contract_drift/);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
  });

  it("fails closed when a passing snapshot gate has no source DB hash", () => {
    const now = "2026-07-10T00:00:00.000Z";
    db.update(changes).set({ status: "SPEC_READY", gateState: "spec" })
      .where(eq(changes.id, CHANGE_ID)).run();
    db.insert(stageGates).values({
      id: "GATE-SPEC-EMPTY-SOURCE", changeId: CHANGE_ID, phase: "Spec", status: "pass",
      blockersJson: "[]", freshnessJson: "{}", requiredActionsJson: "[]",
      sourceDbHash: null, gateVersion: 1, computedAt: now,
    }).run();
    assert.throws(() => enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "tech_spec", actionId: "run_tech_spec",
    }, {
      actionId: "run_tech_spec", enabled: true, gateVersion: "1", sourceDbHash: "__missing_gate__",
    }), /action_contract_drift/);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
  });

  it("rejects enqueue when an authoritative artifact is deleted after preflight", () => {
    seedPlanAuthority();
    db.delete(artifacts).where(eq(artifacts.id, "ART-AUTH-3")).run();
    db.insert(runs).values({
      id: "RUN-AUTH-HISTORY", changeId: CHANGE_ID, phase: "tech_spec", status: "completed",
      startedAt: "2026-07-09T00:00:00.000Z", endedAt: "2026-07-09T00:01:00.000Z",
      summary: null, attemptNo: 2,
    }).run();
    db.insert(artifacts).values({
      id: "ART-AUTH-HISTORY", changeId: CHANGE_ID, runId: "RUN-AUTH-HISTORY",
      type: "tech_spec_delta", path: "/fixture/historical-tech-spec.md",
      createdAt: "2026-07-09T00:01:00.000Z",
    }).run();
    assert.throws(() => enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "generate_plan", actionId: "run_plan",
    }, {
      actionId: "run_plan", enabled: true, gateVersion: "3", sourceDbHash: "techspec-authority",
    }), /action_contract_drift/);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
    assert.equal(db.select().from(events).where(eq(events.changeId, CHANGE_ID)).all().length, 0);
  });

  it("rejects enqueue when the authoritative gate changes after preflight", () => {
    seedPlanAuthority();
    seedPlanAuthority("techspec-new-authority", 4);
    assert.throws(() => enqueueProviderActionAtomically({
      changeId: CHANGE_ID, phase: "generate_plan", actionId: "run_plan",
    }, {
      actionId: "run_plan", enabled: true, gateVersion: "3", sourceDbHash: "techspec-authority",
    }), /action_contract_drift/);
    assert.equal(db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all().length, 0);
  });

  it("rejects reuse of an idempotency key for a different valid phase/action", () => {
    enqueuePipelineJob({
      changeId: CHANGE_ID,
      phase: "spec",
      actionId: "run_spec",
      idempotencyKey: "conflicting-key",
    });

    assert.throws(
      () =>
        enqueuePipelineJob({
          changeId: CHANGE_ID,
          phase: "review",
          actionId: "run_review",
          idempotencyKey: "conflicting-key",
        }),
      /Pipeline job idempotency conflict: conflicting-key/,
    );
    const jobs = db.select().from(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).all();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.phase, "spec");
    assert.equal(jobs[0]?.actionId, "run_spec");
  });

  it("parses the persisted idempotency hit instead of masking it with current input", () => {
    const first = enqueuePipelineJob({
      changeId: CHANGE_ID,
      phase: "spec",
      actionId: "run_spec",
      idempotencyKey: "persisted-row-key",
    });
    db.update(pipelineJobs)
      .set({ phase: "review" })
      .where(eq(pipelineJobs.id, first.job.id))
      .run();

    assert.throws(
      () =>
        enqueuePipelineJob({
          changeId: CHANGE_ID,
          phase: "spec",
          actionId: "run_spec",
          idempotencyKey: "persisted-row-key",
        }),
      /Unsupported pipeline job phase\/action pair: review:run_spec/,
    );
    const persisted = db.select().from(pipelineJobs).where(eq(pipelineJobs.id, first.job.id)).get();
    assert.equal(persisted?.phase, "review");
    assert.equal(persisted?.actionId, "run_spec");
  });

  it("defines the Task 9 typed pipeline job payload boundary", () => {
    const typesPath = path.join(process.cwd(), "server", "services", "pipeline-job-types.ts");

    assert.equal(fs.existsSync(typesPath), true, "pipeline-job-types.ts should exist");
    const source = fs.readFileSync(typesPath, "utf8");
    for (const exportedName of [
      "PipelineJobPhase",
      "PipelineJobActionId",
      "EnqueuePipelineJobInput",
      "PipelineJobPayload",
      "parsePipelineJobPayload",
    ]) {
      assert.match(source, new RegExp(`export (?:type|interface|function) ${exportedName}\\b`));
    }
    const pairs = [
      ["intake", "run_prd"],
      ["prd_briefing_questions", "run_prd_briefing_questions"],
      ["prd_briefing_draft", "run_prd_briefing_draft"],
      ["prd_briefing_final_review", "run_prd_briefing_final_review"],
      ["spec", "run_spec"],
      ["tech_spec", "run_tech_spec"],
      ["generate_plan", "run_plan"],
      ["test_plan", "run_test_plan"],
      ["implement", "run_build"],
      ["review", "run_review"],
      ["local_check", "run_qa"],
      ["fix_findings", "run_fix"],
      ["release", "run_release"],
      ["retro", "run_retro"],
    ] as const;
    for (const [phase, actionId] of pairs) {
      assert.match(
        source,
        new RegExp(`${phase}: \\[[^\\]]*\\"${actionId}\\"`),
        `missing phase/action pair ${phase}:${actionId}`,
      );
    }
    assert.match(source, /type PipelineJobSelection = \{/);
    assert.match(source, /\[Phase in PipelineJobPhase\]/);

    const dispatchSource = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "job-dispatch-service.ts"),
      "utf8",
    ).replace(/\s+/g, " ");
    assert.match(
      dispatchSource,
      /enqueuePipelineJob\(input: EnqueuePipelineJobInput\): PipelineJobPayload/,
    );
  });

  it("resolves omitted providers and idempotency replay inside the enqueue transaction", () => {
    const dispatchSource = fs.readFileSync(
      path.join(process.cwd(), "server", "services", "job-dispatch-service.ts"),
      "utf8",
    ).replace(/\s+/g, " ");
    assert.doesNotMatch(
      dispatchSource,
      /resolveCurrentProvider\(/,
      "omitted-provider resolution must not happen in a pre-transaction lookup",
    );
    assert.match(
      dispatchSource,
      /getJobDispatchDb\(\)\.transaction\(\(tx\) => \{[^}]*resolveAndValidateProvider\(tx, input\)/,
      "the transaction must resolve the Change default before idempotency or insert",
    );
    assert.match(
      dispatchSource,
      /getJobDispatchDb\(\)\.transaction\(\(tx\) => \{[^}]*idempotencyKey[^}]*findExistingJobInTransaction\(tx/,
      "idempotency replay must use the same transaction snapshot as provider resolution",
    );
  });

  it("enqueues each Task 9 AI phase without executing a runner", () => {
    const cases = [
      ["intake", "run_prd"],
      ["prd_briefing_questions", "run_prd_briefing_questions"],
      ["prd_briefing_draft", "run_prd_briefing_draft"],
      ["prd_briefing_final_review", "run_prd_briefing_final_review"],
    ] as const;

    for (const [phase, actionId] of cases) {
      const result = enqueuePipelineJob({
        changeId: CHANGE_ID,
        phase,
        actionId,
        idempotencyKey: `task-9-${phase}`,
      });
      assert.equal(result.job.phase, phase);
      assert.equal(result.job.actionId, actionId);
      assert.equal(result.job.status, "queued");
    }

    const queuedEvents = db
      .select()
      .from(events)
      .where(eq(events.changeId, CHANGE_ID))
      .all()
      .filter((row) => row.type === "pipeline_job_queued");
    assert.equal(queuedEvents.length, 4);
  });
});

describe("job-dispatch-service injectable connection", { concurrency: false }, () => {
  const SEAM_CHANGE_ID = "CHG-JOB-DISPATCH-SEAM";

  function createDispatchTestDb(): JobDispatchDb {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = OFF");
    runMigrations(sqlite);
    return drizzle(sqlite, { schema: dbSchema }) as unknown as JobDispatchDb;
  }

  function seedSeamChange(database: JobDispatchDb): void {
    const now = "2026-07-10T00:00:00.000Z";
    database
      .insert(changes)
      .values({
        id: SEAM_CHANGE_ID,
        projectId: PROJECT_ID,
        title: "Seam change",
        status: "INTAKE_READY",
        provider: "codex",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  it("routes the enqueue transaction through the injected db, not the global singleton", () => {
    const seamDb = createDispatchTestDb();
    seedSeamChange(seamDb);

    const restore = setJobDispatchDbForTest(seamDb);
    let jobId = "";
    try {
      const result = enqueuePipelineJob({
        changeId: SEAM_CHANGE_ID,
        phase: "spec",
        actionId: "run_spec",
        idempotencyKey: "seam-idem",
      });
      jobId = result.job.id;
      // The job and its queued event were written to the injected connection.
      // Reverting the seam to the module-global db would instead throw
      // "Change not found" here, since SEAM_CHANGE_ID lives only in seamDb.
      assert.equal(
        seamDb.select().from(pipelineJobs).where(eq(pipelineJobs.id, jobId)).get()?.changeId,
        SEAM_CHANGE_ID,
      );
      assert.equal(
        seamDb
          .select()
          .from(events)
          .where(eq(events.changeId, SEAM_CHANGE_ID))
          .all()
          .filter((row) => row.type === "pipeline_job_queued").length,
        1,
      );
    } finally {
      restore();
    }

    // The write never reached the module-global singleton.
    assert.equal(
      db.select().from(pipelineJobs).where(eq(pipelineJobs.id, jobId)).get() ?? null,
      null,
    );

    // A second injected db is an independent world: the same idempotency key
    // resolves against an empty table and mints a fresh job there only.
    const otherDb = createDispatchTestDb();
    seedSeamChange(otherDb);
    const restoreOther = setJobDispatchDbForTest(otherDb);
    try {
      const other = enqueuePipelineJob({
        changeId: SEAM_CHANGE_ID,
        phase: "spec",
        actionId: "run_spec",
        idempotencyKey: "seam-idem",
      });
      assert.ok(
        otherDb.select().from(pipelineJobs).where(eq(pipelineJobs.id, other.job.id)).get(),
      );
      assert.equal(
        otherDb.select().from(pipelineJobs).where(eq(pipelineJobs.id, jobId)).get() ?? null,
        null,
      );
    } finally {
      restoreOther();
    }
  });
});
