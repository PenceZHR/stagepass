import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "../db/index.ts";
import { changes, events, projects, runs } from "../db/schema.ts";
import { getGraphRunner } from "./graph-runner.ts";
import { stopActiveRunsAndSetStatus } from "./pipeline-run-ledger-service.ts";

/**
 * graph-runner.ts had no test coverage at all before this file. stopCurrentRun
 * and blockChange used to call stopActiveRuns() and setStatus() as two separate
 * transactions -- a crash in between left every run `stopped` (terminal) with
 * the status still at the running phase, invisible to recovery (which only
 * selects candidates with a running run). See
 * docs/state-projection-audit-2026-07-14.md, D6 audit Tier 2.
 */

const PROJECT_ID = "PRJ-GRAPH-RUNNER";
const CHANGE_ID = "CHG-GRAPH-RUNNER";
const RUN_ID = "RUN-GRAPH-RUNNER";
const NOW = "2026-07-14T00:00:00.000Z";

function cleanupRows(): void {
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(status: string): void {
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Graph runner",
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
    title: "Graph runner",
    status,
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
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

function seedRunningRun(phase: string): void {
  db.insert(runs).values({
    id: RUN_ID,
    changeId: CHANGE_ID,
    phase,
    status: "running",
    startedAt: NOW,
    endedAt: null,
    summary: null,
    provider: "codex",
  }).run();
}

beforeEach(cleanupRows);
afterEach(cleanupRows);

describe("GraphRunner.stopCurrentRun", () => {
  it("stops the running run and rolls the status back together", async () => {
    seedChange("IMPLEMENTING");
    seedRunningRun("implement");

    await getGraphRunner().stopCurrentRun(CHANGE_ID);

    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    const run = db.select().from(runs).where(eq(runs.id, RUN_ID)).get();
    assert.equal(change?.status, "PLAN_APPROVED");
    assert.equal(run?.status, "stopped");
  });

  it("rejects a change that is not in a running state", async () => {
    seedChange("PLAN_APPROVED");

    await assert.rejects(
      () => getGraphRunner().stopCurrentRun(CHANGE_ID),
      /not a running state/,
    );
  });
});

describe("GraphRunner.blockChange", () => {
  it("stops the running run and sets BLOCKED together, recording blockedPhase", async () => {
    seedChange("CHECKING");
    seedRunningRun("local_check");

    await getGraphRunner().blockChange(CHANGE_ID, "manual block", "local_check");

    const change = db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get();
    const run = db.select().from(runs).where(eq(runs.id, RUN_ID)).get();
    assert.equal(change?.status, "BLOCKED");
    assert.equal(change?.blockedPhase, "local_check");
    assert.equal(run?.status, "stopped");
  });

  it("rejects a change that is already blocked", async () => {
    seedChange("BLOCKED");

    await assert.rejects(
      () => getGraphRunner().blockChange(CHANGE_ID, "manual block"),
      /already blocked/,
    );
  });
});

describe("stopActiveRunsAndSetStatus atomicity", () => {
  it("does not leave the run stopped when the paired status transition is illegal", () => {
    seedChange("IMPLEMENTING");
    seedRunningRun("implement");

    assert.throws(() => stopActiveRunsAndSetStatus({
      changeId: CHANGE_ID,
      status: "DONE", // not a legal target from IMPLEMENTING
    }));

    const run = db.select().from(runs).where(eq(runs.id, RUN_ID)).get();
    assert.equal(
      run?.status,
      "running",
      "the run must not end up stopped when the status write it's paired with fails -- otherwise " +
        "recovery, which only selects candidates with a running run, would never see this change again",
    );
  });
});
