import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { changes, codexThreadBindings, projects } from "../db/schema";
import { projectCodexStageControl } from "./codex-stage-control-projection";

const PROJECT_ID = "PRJ-STAGE-CTRL";
const CHANGE_ID = "CHG-STAGE-CTRL";
const NOW = "2026-07-27T00:00:00.000Z";

function cleanup(): void {
  db.delete(codexThreadBindings)
    .where(eq(codexThreadBindings.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function insertStageBinding(stageId: string, threadId: string): void {
  db.insert(codexThreadBindings).values({
    bindingId: `B-${stageId}`,
    scopeKind: "change_stage",
    scopeId: `${CHANGE_ID}:${stageId}`,
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    threadId,
    title: `[${CHANGE_ID}] ${stageId}`,
    status: "ready",
    bridgeProtocolVersion: "v1",
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

describe("codex stage control projection", () => {
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

  // The whole point of per-stage tasks: a stage that has not started has no
  // task of its own, which is what lets the page offer to start it.
  it("reports no task for a stage that never ran", () => {
    insertStageBinding("prd", "THREAD-PRD");

    const control = projectCodexStageControl({
      changeId: CHANGE_ID, projectId: PROJECT_ID, stageId: "spec",
    });

    assert.equal(control.threadId, null);
    assert.equal(control.bindingStatus, "detached");
  });

  it("reports the stage's own task once it has one", () => {
    insertStageBinding("prd", "THREAD-PRD");
    insertStageBinding("spec", "THREAD-SPEC");

    assert.equal(
      projectCodexStageControl({
        changeId: CHANGE_ID, projectId: PROJECT_ID, stageId: "spec",
      }).threadId,
      "THREAD-SPEC",
    );
    assert.equal(
      projectCodexStageControl({
        changeId: CHANGE_ID, projectId: PROJECT_ID, stageId: "prd",
      }).threadId,
      "THREAD-PRD",
    );
  });

  // A shared task from before per-stage tasks belongs to the stage that last
  // ran on it. With no turn recorded, no stage claims it -- which is what lets
  // every stage offer to start its own.
  it("does not show an unclaimed change-wide task to a stage", () => {
    db.insert(codexThreadBindings).values({
      bindingId: "B-LEGACY",
      scopeKind: "change",
      scopeId: CHANGE_ID,
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      threadId: "THREAD-LEGACY",
      title: "legacy",
      status: "ready",
      bridgeProtocolVersion: "v1",
      lastSeenAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    }).run();

    assert.equal(
      projectCodexStageControl({
        changeId: CHANGE_ID, projectId: PROJECT_ID, stageId: "spec",
      }).threadId,
      null,
    );
  });
});
