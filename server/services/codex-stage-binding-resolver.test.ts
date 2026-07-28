import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  changes,
  codexLogicalTurns,
  codexThreadBindings,
  pipelineJobs,
  projects,
} from "../db/schema";
import { resolveStageBinding } from "./codex-stage-binding-resolver";

const PROJECT_ID = "PRJ-STAGE-BIND";
const CHANGE_ID = "CHG-STAGE-BIND";
const NOW = "2026-07-27T00:00:00.000Z";

let turnSeq = 0;

function insertLogicalTurn(bindingId: string, phase: string): void {
  turnSeq += 1;
  const jobId = `PJOB-${bindingId}-${turnSeq}`;
  db.insert(pipelineJobs).values({
    id: jobId,
    changeId: CHANGE_ID,
    phase,
    actionId: "run_prd",
    status: "succeeded",
    attemptNo: 1,
    provider: "codex",
    createdAt: NOW,
  }).run();
  db.insert(codexLogicalTurns).values({
    logicalTurnId: `LT-${bindingId}-${turnSeq}`,
    pipelineJobId: jobId,
    bindingId,
    phase,
    role: "stage",
    round: 0,
    ordinal: 0,
    turnSlot: `slot-${bindingId}-${turnSeq}`,
    runCorrelationId: `sp-${turnSeq}`,
    canonicalRequestJson: "{}",
    canonicalRequestHash: `hash-${turnSeq}`,
    dispatchSurface: "follower_ipc",
    status: "pending",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

function cleanup(): void {
  db.delete(codexLogicalTurns).where(eq(codexLogicalTurns.bindingId, "B-LEGACY")).run();
  db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, CHANGE_ID)).run();
  db.delete(codexThreadBindings)
    .where(eq(codexThreadBindings.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function insertBinding(input: {
  bindingId: string;
  scopeKind: "change" | "change_stage";
  scopeId: string;
  threadId: string;
}): void {
  db.insert(codexThreadBindings).values({
    bindingId: input.bindingId,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    threadId: input.threadId,
    title: "T",
    status: "ready",
    bridgeProtocolVersion: "v1",
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

describe("stage binding resolution", () => {
  beforeEach(() => {
    cleanup();
    db.insert(projects).values({
      id: PROJECT_ID, name: "P", repoPath: process.cwd(),
      createdAt: NOW, updatedAt: NOW,
    }).run();
    db.insert(changes).values({
      id: CHANGE_ID, projectId: PROJECT_ID, title: "C",
      status: "INTAKE_READY", createdAt: NOW, updatedAt: NOW,
    }).run();
  });

  afterEach(cleanup);

  it("gives each stage its own task", () => {
    insertBinding({
      bindingId: "B-PRD", scopeKind: "change_stage",
      scopeId: `${CHANGE_ID}:prd`, threadId: "THREAD-PRD",
    });
    insertBinding({
      bindingId: "B-SPEC", scopeKind: "change_stage",
      scopeId: `${CHANGE_ID}:spec`, threadId: "THREAD-SPEC",
    });

    assert.equal(resolveStageBinding(CHANGE_ID, "prd")?.threadId, "THREAD-PRD");
    assert.equal(resolveStageBinding(CHANGE_ID, "spec")?.threadId, "THREAD-SPEC");
  });

  // A stage that has not started yet has no task of its own, which is exactly
  // what lets the UI offer to start it.
  it("reports no task for a stage that never ran", () => {
    insertBinding({
      bindingId: "B-PRD", scopeKind: "change_stage",
      scopeId: `${CHANGE_ID}:prd`, threadId: "THREAD-PRD",
    });

    assert.equal(resolveStageBinding(CHANGE_ID, "spec"), null);
  });

  // Changes already in flight when per-stage tasks landed keep one shared
  // task; refusing to see it would strand them mid-pipeline. It belongs to the
  // stage that last ran on it -- every other stage is free to start its own.
  it("gives a change-wide task to the stage that last ran on it", () => {
    insertBinding({
      bindingId: "B-LEGACY", scopeKind: "change",
      scopeId: CHANGE_ID, threadId: "THREAD-LEGACY",
    });
    insertLogicalTurn("B-LEGACY", "intake");

    assert.equal(resolveStageBinding(CHANGE_ID, "prd")?.threadId, "THREAD-LEGACY");
    assert.equal(resolveStageBinding(CHANGE_ID, "spec"), null);
  });

  // With no turn on it, nothing says which stage it belongs to; treating it as
  // every stage's task is what made a later stage look already started.
  it("does not hand an unused change-wide task to an unrelated stage", () => {
    insertBinding({
      bindingId: "B-LEGACY", scopeKind: "change",
      scopeId: CHANGE_ID, threadId: "THREAD-LEGACY",
    });

    assert.equal(resolveStageBinding(CHANGE_ID, "spec"), null);
  });

  it("prefers the stage's own task over the shared one", () => {
    insertBinding({
      bindingId: "B-LEGACY", scopeKind: "change",
      scopeId: CHANGE_ID, threadId: "THREAD-LEGACY",
    });
    insertLogicalTurn("B-LEGACY", "spec");
    insertBinding({
      bindingId: "B-SPEC", scopeKind: "change_stage",
      scopeId: `${CHANGE_ID}:spec`, threadId: "THREAD-SPEC",
    });

    assert.equal(resolveStageBinding(CHANGE_ID, "spec")?.threadId, "THREAD-SPEC");
  });

  it("maps a persisted phase name to its stage task", () => {
    insertBinding({
      bindingId: "B-PRD", scopeKind: "change_stage",
      scopeId: `${CHANGE_ID}:prd`, threadId: "THREAD-PRD",
    });

    // "intake" is the persisted phase for the PRD stage.
    assert.equal(resolveStageBinding(CHANGE_ID, "intake")?.threadId, "THREAD-PRD");
  });
});
