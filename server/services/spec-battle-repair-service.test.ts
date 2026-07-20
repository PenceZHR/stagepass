import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import fs from "fs";
import os from "os";
import path from "path";

import { db } from "../db/index.ts";
import { battleRounds, changes, events, projects, runs, stageRuns } from "../db/schema.ts";
import { repairStuckSpecRounds } from "./spec-battle-repair-service.ts";

const PROJECT_ID = "PRJ-SPEC-BATTLE-REPAIR";
const CHANGE_ID = "CHG-SPEC-BATTLE-REPAIR";

function cleanupRows() {
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(repoPath: string) {
  const now = "2026-06-29T00:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Spec Battle repair",
    repoPath,
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
    title: "Repair stuck Spec round",
    status: "SPECCING",
    provider: "codex",
    codexThreadId: null,
    fixIterations: 0,
    blockedPhase: null,
    reworkFromPhase: null,
    suspendedByPrd: 0,
    preSuspendStatus: null,
    gitBranch: null,
    gateState: "intake",
    docsComplete: 0,
    retroDone: 0,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function seedRound(input: Partial<typeof battleRounds.$inferInsert> = {}) {
  const now = "2026-06-29T00:00:00.000Z";
  db.insert(battleRounds).values({
    id: input.id ?? "BRD-SPEC-BATTLE-REPAIR-1",
    changeId: CHANGE_ID,
    phase: "Spec",
    template: "SPEC_BATTLE_MVP",
    roundNo: input.roundNo ?? 1,
    status: input.status ?? "red_running",
    redUnit: "SPEC_WRITER",
    blueUnit: "REQUIREMENT_CRITIC",
    inputSnapshotJson: "{}",
    paramsJson: "{}",
    redArtifactPath: input.redArtifactPath ?? null,
    redArtifactHash: input.redArtifactHash ?? null,
    blueArtifactPath: input.blueArtifactPath ?? null,
    blueArtifactHash: input.blueArtifactHash ?? null,
    reportPath: input.reportPath ?? null,
    supersededByRoundId: null,
    startedAt: input.startedAt ?? now,
    endedAt: null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }).run();
}

describe("spec-battle-repair-service", { concurrency: false }, () => {
  let repoPath: string;

  beforeEach(() => {
    cleanupRows();
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "spec-battle-repair-"));
    seedChange(repoPath);
  });

  afterEach(() => {
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("dry-runs a fake stuck latest red_running round without writing", () => {
    seedRound();

    const results = repairStuckSpecRounds({
      changeId: CHANGE_ID,
      now: new Date("2026-06-29T00:10:00.000Z"),
    });

    assert.equal(results[0].action, "would_repair");
    assert.equal(db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get()?.status, "red_running");
  });

  it("repairs a fake stuck latest red_running round only when execute is explicit", () => {
    seedRound();

    const results = repairStuckSpecRounds({
      changeId: CHANGE_ID,
      execute: true,
      now: new Date("2026-06-29T00:10:00.000Z"),
    });

    assert.equal(results[0].action, "repaired");
    assert.equal(db.select().from(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).get()?.status, "not_started");
  });

  it("refuses when a spec run is actively running", () => {
    seedRound();
    db.insert(runs).values({
      id: "RUN-SPEC-BATTLE-REPAIR",
      changeId: CHANGE_ID,
      phase: "spec",
      status: "running",
      startedAt: "2026-06-29T00:01:00.000Z",
      endedAt: null,
      summary: null,
    }).run();

    const results = repairStuckSpecRounds({ changeId: CHANGE_ID, execute: true, now: new Date("2026-06-29T00:10:00.000Z") });

    assert.equal(results[0].action, "refused");
    assert.deepEqual(results[0].reasons, ["active_spec_run"]);
  });

  it("refuses when a Spec stage run is actively running", () => {
    seedRound();
    db.insert(stageRuns).values({
      id: "STG-RUN-SPEC-BATTLE-REPAIR",
      changeId: CHANGE_ID,
      phase: "Spec",
      attemptNo: 1,
      status: "running",
      idempotencyKey: "repair-stage-run",
      inputDbHash: null,
      outputDbHash: null,
      sourceLineageJson: null,
      errorCode: null,
      startedAt: "2026-06-29T00:01:00.000Z",
      completedAt: null,
    }).run();

    const results = repairStuckSpecRounds({ changeId: CHANGE_ID, execute: true, now: new Date("2026-06-29T00:10:00.000Z") });

    assert.equal(results[0].action, "refused");
    assert.deepEqual(results[0].reasons, ["active_spec_stage_run"]);
  });

  it("refuses when recent stage_progress shows a spec provider is still active", () => {
    seedRound();
    db.insert(runs).values({
      id: "RUN-SPEC-BATTLE-REPAIR-PROGRESS",
      changeId: CHANGE_ID,
      phase: "spec",
      status: "completed",
      startedAt: "2026-06-29T00:08:00.000Z",
      endedAt: "2026-06-29T00:08:30.000Z",
      summary: "provider reported progress out of band",
    }).run();
    db.insert(events).values({
      id: "EVT-SPEC-BATTLE-REPAIR-STAGE-PROGRESS",
      changeId: CHANGE_ID,
      runId: "RUN-SPEC-BATTLE-REPAIR-PROGRESS",
      type: "stage_progress",
      message: "Spec provider running",
      rawJson: JSON.stringify({
        stageProgress: {
          schemaVersion: "stage_progress/v1",
          phase: "spec",
          runId: "RUN-SPEC-BATTLE-REPAIR-PROGRESS",
          status: "provider_running",
          source: "none",
          message: "Spec provider running",
        },
      }),
      createdAt: "2026-06-29T00:09:00.000Z",
    }).run();

    const results = repairStuckSpecRounds({
      changeId: CHANGE_ID,
      execute: true,
      now: new Date("2026-06-29T00:10:00.000Z"),
    });

    assert.equal(results[0].action, "refused");
    assert.deepEqual(results[0].reasons, ["active_spec_stage_progress"]);
  });

  it("refuses rounds with artifacts, non-latest rounds, and existing red files", () => {
    seedRound({ id: "BRD-SPEC-BATTLE-REPAIR-OLD", roundNo: 1 });
    seedRound({ id: "BRD-SPEC-BATTLE-REPAIR-LATEST", roundNo: 2, redArtifactPath: "rounds/spec-round-02-red.md" });
    fs.mkdirSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "rounds"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, ".ship", "changes", CHANGE_ID, "rounds", "spec-round-01-red.md"), "# exists\n");

    const results = repairStuckSpecRounds({ changeId: CHANGE_ID, execute: true, now: new Date("2026-06-29T00:10:00.000Z") });

    assert.equal(results.find((result) => result.roundId === "BRD-SPEC-BATTLE-REPAIR-OLD")?.action, "refused");
    assert.ok(results.find((result) => result.roundId === "BRD-SPEC-BATTLE-REPAIR-OLD")?.reasons.includes("not_latest_round"));
    assert.ok(results.find((result) => result.roundId === "BRD-SPEC-BATTLE-REPAIR-OLD")?.reasons.includes("red_artifact_file_present"));
    assert.equal(results.find((result) => result.roundId === "BRD-SPEC-BATTLE-REPAIR-LATEST")?.action, "refused");
    assert.ok(results.find((result) => result.roundId === "BRD-SPEC-BATTLE-REPAIR-LATEST")?.reasons.includes("red_artifact_present"));
  });

  it("refuses a round with blue or report artifact state", () => {
    seedRound({ blueArtifactPath: "rounds/spec-round-01-blue.json", reportPath: "reports/spec-report.md" });

    const results = repairStuckSpecRounds({ changeId: CHANGE_ID, execute: true, now: new Date("2026-06-29T00:10:00.000Z") });

    assert.equal(results[0].action, "refused");
    assert.ok(results[0].reasons.includes("blue_or_report_artifact_present"));
  });
});
