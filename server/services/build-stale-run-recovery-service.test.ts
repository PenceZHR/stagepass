import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { buildRunRecords, changes, events, projects, runs } from "../db/schema";
import {
  inspectStaleBuildRun,
  recoverStaleBuildRun,
} from "./build-stale-run-recovery-service";
import { setBuildRunRecordDbForTest } from "./build-run-record-service";
import { readLatestBuildRun, writeBuildRun } from "./build-workspace-service";
import type { BuildRunFile } from "./build-types";

const PROJECT_ID = "PRJ-BUILD-STALE-RECOVERY";
const CHANGE_ID = "CHG-BUILD-STALE-RECOVERY";
const RUN_ID = "RUN-BUILD-STALE-RECOVERY";

let repoPath: string;
let restoreBuildRunRecordDb: (() => void) | null = null;

function cleanupRows() {
  db.delete(buildRunRecords).where(eq(buildRunRecords.changeId, CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedProjectChange(input: { status?: string } = {}) {
  const now = "2026-07-08T00:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Build stale recovery",
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
    title: "Recover stale Build",
    status: input.status ?? "IMPLEMENTING",
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

function seedRun(input: { id?: string; status?: string; startedAt: string }) {
  db.insert(runs).values({
    id: input.id ?? RUN_ID,
    changeId: CHANGE_ID,
    phase: "implement",
    status: input.status ?? "running",
    startedAt: input.startedAt,
    endedAt: null,
    summary: null,
  }).run();
}

function makeBuildRun(input: {
  runNumber: number;
  status: BuildRunFile["status"];
  updatedAt: string;
  blockers?: string[];
}): BuildRunFile {
  return {
    changeId: CHANGE_ID,
    runNumber: input.runNumber,
    status: input.status,
    purpose: "build",
    baseHeadSha: "a".repeat(40),
    baseCommit: "a".repeat(40),
    workspacePath: path.join(repoPath, "..", ".stagepass-workspaces", CHANGE_ID, `build-${input.runNumber}`),
    branchName: `stagepass/build/${CHANGE_ID}/build-${input.runNumber}`,
    expectedFiles: [],
    forbiddenFiles: [],
    changedFiles: [],
    deviations: [],
    blockers: input.blockers ?? [],
    patchPath: null,
    patchSha256: null,
    approvalPath: null,
    diffPath: null,
    auditPath: null,
    reportPath: null,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  };
}

function seedBuildRunFile(input: {
  runNumber: number;
  status: BuildRunFile["status"];
  updatedAt: string;
  blockers?: string[];
}) {
  writeBuildRun(repoPath, makeBuildRun(input));
}

describe("build stale run recovery service", () => {
  beforeEach(() => {
    cleanupRows();
    restoreBuildRunRecordDb = setBuildRunRecordDbForTest(db);
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "build-stale-recovery-"));
  });

  afterEach(() => {
    restoreBuildRunRecordDb?.();
    restoreBuildRunRecordDb = null;
    cleanupRows();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it("reports not stale when no running implement run exists", () => {
    seedProjectChange({ status: "IMPLEMENTING" });

    const result = inspectStaleBuildRun(CHANGE_ID, {
      now: () => new Date("2026-07-08T01:00:00.000Z"),
    });

    assert.equal(result.kind, "none");
  });

  it("reports active when the running Build is younger than the stale threshold", () => {
    seedProjectChange({ status: "IMPLEMENTING" });
    seedRun({ id: RUN_ID, startedAt: "2026-07-08T00:55:00.000Z" });
    seedBuildRunFile({
      runNumber: 1,
      status: "running",
      updatedAt: "2026-07-08T00:55:00.000Z",
    });

    const result = inspectStaleBuildRun(CHANGE_ID, {
      now: () => new Date("2026-07-08T01:00:00.000Z"),
    });

    assert.equal(result.kind, "active");
  });

  it("reports stale when the running Build is older than threshold and no live provider exists", () => {
    seedProjectChange({ status: "IMPLEMENTING" });
    seedRun({ id: RUN_ID, startedAt: "2026-07-07T16:11:18.181Z" });
    seedBuildRunFile({
      runNumber: 1,
      status: "running",
      updatedAt: "2026-07-07T16:11:18.317Z",
    });

    const result = inspectStaleBuildRun(CHANGE_ID, {
      now: () => new Date("2026-07-08T01:00:00.000Z"),
      hasLiveProviderProcess: () => false,
    });

    assert.equal(result.kind, "stale");
    assert.equal(result.runId, RUN_ID);
    assert.equal(result.buildRun?.runNumber, 1);
  });

  it("marks a stale running Build as failed and returns the change to PLAN_APPROVED", async () => {
    seedProjectChange({ status: "IMPLEMENTING" });
    seedRun({ id: RUN_ID, startedAt: "2026-07-07T16:11:18.181Z" });
    seedBuildRunFile({
      runNumber: 1,
      status: "running",
      updatedAt: "2026-07-07T16:11:18.317Z",
      blockers: [],
    });

    const result = await recoverStaleBuildRun(CHANGE_ID, {
      now: () => new Date("2026-07-08T01:00:00.000Z"),
      hasLiveProviderProcess: () => false,
    });

    assert.equal(result.recovered, true);
    assert.equal(db.select().from(runs).where(eq(runs.id, RUN_ID)).get()?.status, "failed");
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "PLAN_APPROVED");
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "failed");
    const buildRecord = db
      .select()
      .from(buildRunRecords)
      .where(and(eq(buildRunRecords.changeId, CHANGE_ID), eq(buildRunRecords.buildRunId, "build-1")))
      .get();
    assert.equal(buildRecord?.status, "failed");
  });

  /**
   * D6 audit Tier 2 (docs/state-projection-audit-2026-07-14.md): recoverStaleBuildRun
   * used to end the run and set the status as two separate transactions. A crash
   * in between left the run `failed` (terminal) with the status still
   * IMPLEMENTING -- and since nothing is running, the change is invisible to the
   * ordinary recovery sweep and both the forward and retry actions are gated off.
   * This asserts the run and status commit together by forcing the status half to
   * fail (an illegal target) and checking the run was not left terminal.
   */
  it("does not leave the run failed when the paired status transition would be illegal", async () => {
    seedProjectChange({ status: "SPECCING" }); // PLAN_APPROVED is not reachable from here
    seedRun({ id: RUN_ID, startedAt: "2026-07-07T16:11:18.181Z" });
    seedBuildRunFile({
      runNumber: 1,
      status: "running",
      updatedAt: "2026-07-07T16:11:18.317Z",
      blockers: [],
    });

    await assert.rejects(() => recoverStaleBuildRun(CHANGE_ID, {
      now: () => new Date("2026-07-08T01:00:00.000Z"),
      hasLiveProviderProcess: () => false,
    }));

    assert.equal(
      db.select().from(runs).where(eq(runs.id, RUN_ID)).get()?.status,
      "running",
      "the run must not end up terminal when the status write it's paired with fails",
    );
  });

  it("refuses to recover an active running Build", async () => {
    seedProjectChange({ status: "IMPLEMENTING" });
    seedRun({ id: RUN_ID, startedAt: "2026-07-08T00:59:00.000Z" });
    seedBuildRunFile({
      runNumber: 1,
      status: "running",
      updatedAt: "2026-07-08T00:59:00.000Z",
    });

    await assert.rejects(
      () => recoverStaleBuildRun(CHANGE_ID, { now: () => new Date("2026-07-08T01:00:00.000Z") }),
      /Build run is still active/,
    );
  });

  it("refuses to recover an old Build when the provider process is still live", async () => {
    seedProjectChange({ status: "IMPLEMENTING" });
    seedRun({ id: RUN_ID, startedAt: "2026-07-07T16:11:18.181Z" });
    seedBuildRunFile({
      runNumber: 1,
      status: "running",
      updatedAt: "2026-07-07T16:11:18.317Z",
    });

    await assert.rejects(
      () =>
        recoverStaleBuildRun(CHANGE_ID, {
          now: () => new Date("2026-07-08T01:00:00.000Z"),
          hasLiveProviderProcess: () => true,
        }),
      /Build run is still active: live_provider_process/,
    );
  });

  it("refuses to recover an old Build when liveness cannot be checked", async () => {
    seedProjectChange({ status: "IMPLEMENTING" });
    seedRun({ id: RUN_ID, startedAt: "2026-07-07T16:11:18.181Z" });
    seedBuildRunFile({
      runNumber: 1,
      status: "running",
      updatedAt: "2026-07-07T16:11:18.317Z",
    });

    await assert.rejects(
      () =>
        recoverStaleBuildRun(CHANGE_ID, {
          now: () => new Date("2026-07-08T01:00:00.000Z"),
          hasLiveProviderProcess: () => "unknown",
        }),
      /Build run is still active: liveness_unknown/,
    );
  });

  /**
   * The escape from a Build run the stale-provider sweeper already reconciled.
   *
   * The sweeper ends the run row (`failed`) and clears the provider row, but it
   * never touches build-N.json -- no recovery path writes it (only the stage's
   * own catch and recoverStaleBuildRun do). So the change is left claiming
   * IMPLEMENTING, the run row is terminal, and the workspace file still says
   * `running`. Every exit was then closed: retry_build's recovery looks only for
   * a *running* implement run and reported no_running_implement_run;
   * reject_build refuses anything but awaiting_human/gate_blocked; adopt_build
   * likewise. Permanent, and invisible to the next sweep because the sweep only
   * selects running runs (the exit-side gap endStageRun's comment names).
   *
   * IMPLEMENTING cannot be repaired on "no running run" alone, the way PLANNING
   * or FIXING can: runImplementStreamed COMPLETES into IMPLEMENTING and parks
   * there awaiting adoption, so for a successful build "no running implement
   * run" is the normal resting state, not a stranding. The workspace file's own
   * status is the discriminator, and the whitelist is 4a738e88's: only a file
   * still claiming `running` was killed mid-flight. Everything else -- above
   * all awaiting_human -- is either finished or parked on a person, and
   * retrying would destroy a deliverable nobody has ruled on.
   */
  function strandAfterSweeperReconciled() {
    seedProjectChange({ status: "IMPLEMENTING" });
    // What the sweeper leaves behind: run terminal, workspace file untouched.
    seedRun({ id: RUN_ID, status: "failed", startedAt: "2026-07-07T16:11:18.181Z" });
    seedBuildRunFile({
      runNumber: 1,
      status: "running",
      updatedAt: "2026-07-07T16:11:18.317Z",
    });
  }

  it("reports stranded when the sweeper already failed the run and no provider process survives", () => {
    strandAfterSweeperReconciled();

    const result = inspectStaleBuildRun(CHANGE_ID, {
      now: () => new Date("2026-07-08T01:00:00.000Z"),
      hasLiveProviderProcess: () => false,
    });

    assert.equal(result.kind, "stranded");
  });

  for (const liveness of [true, "unknown"] as const) {
    it(`still refuses a sweeper-reconciled run when liveness is ${String(liveness)}`, () => {
      strandAfterSweeperReconciled();

      // The sweeper commits its DB reconciliation BEFORE it best-effort
      // terminates the process, and skips the terminate entirely when its time
      // budget is spent or the ownership check fails -- so a terminal run row
      // does not prove the process died. The lsof probe is the only
      // current-moment evidence, and only a definite `false` may pass. This is
      // the concurrency guard: without it, retry would race a live build.
      const result = inspectStaleBuildRun(CHANGE_ID, {
        now: () => new Date("2026-07-08T01:00:00.000Z"),
        hasLiveProviderProcess: () => liveness,
      });

      assert.equal(result.kind, "active");
    });
  }

  for (const status of ["awaiting_human", "gate_blocked", "created", "adopted", "approved_for_absorb"] as const) {
    it(`never treats a ${status} Build run as stranded`, () => {
      seedProjectChange({ status: "IMPLEMENTING" });
      seedRun({ id: RUN_ID, status: "completed", startedAt: "2026-07-07T16:11:18.181Z" });
      seedBuildRunFile({
        runNumber: 1,
        status,
        updatedAt: "2026-07-07T16:11:18.317Z",
      });

      // awaiting_human is the whole reason this cannot key off "no running
      // implement run": it is where a SUCCESSFUL build waits for adopt_build.
      // Classifying it stranded would let retry_build silently discard a
      // finished deliverable. created may still produce one; the rest are
      // already decided. A dead process is not evidence that any of them are
      // retryable.
      const result = inspectStaleBuildRun(CHANGE_ID, {
        now: () => new Date("2026-07-08T01:00:00.000Z"),
        hasLiveProviderProcess: () => false,
      });

      assert.equal(result.kind, "none");
    });
  }

  it("returns a stranded change to PLAN_APPROVED and fails the abandoned workspace file", async () => {
    strandAfterSweeperReconciled();

    const result = await recoverStaleBuildRun(CHANGE_ID, {
      now: () => new Date("2026-07-08T01:00:00.000Z"),
      hasLiveProviderProcess: () => false,
    });

    assert.equal(result.recovered, true);
    // PLAN_APPROVED is the sweeper's own rollback target for this phase
    // (fallbackStatusByProviderPhase.implement), the status the stale path
    // above already ends runs into, and a legal IMPLEMENTING exit in
    // ALLOWED_TRANSITIONS.
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "PLAN_APPROVED");
    // The abandoned file must stop claiming `running`, or the next inspection
    // would classify the same corpse as stranded all over again.
    assert.equal(readLatestBuildRun(repoPath, CHANGE_ID)?.status, "failed");
    // The already-terminal run row is left exactly as the sweeper wrote it.
    assert.equal(db.select().from(runs).where(eq(runs.id, RUN_ID)).get()?.status, "failed");
  });

  it("refuses to repair a stranded claim if a run of the phase is running again", async () => {
    strandAfterSweeperReconciled();
    // A retry that got in first. The file still says running from the corpse,
    // but the phase is genuinely in flight again and must not be pre-empted.
    seedRun({ id: `${RUN_ID}-2`, status: "running", startedAt: "2026-07-08T00:59:00.000Z" });

    await assert.rejects(
      () => recoverStaleBuildRun(CHANGE_ID, {
        now: () => new Date("2026-07-08T01:00:00.000Z"),
        hasLiveProviderProcess: () => false,
      }),
      /Build run is still active: below_threshold/,
    );
    assert.equal(db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.status, "IMPLEMENTING");
  });
});
