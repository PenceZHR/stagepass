import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  changes,
  prdBriefings,
  prdDrafts,
  projects,
  stageGates,
  stageReports,
  stageRuns,
  stageStates,
} from "../db/schema";
import { sealClarifiedStageGate } from "./clarified-stage-gate-service";
import { getStageAuthority } from "./stage-authority-service";

const PROJECT_ID = "PRJ-CLARIFIED-GATE";
const CHANGE_ID = "CHG-CLARIFIED-GATE";
const NOW = "2026-07-10T00:00:00.000Z";

function cleanup(): void {
  db.delete(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).run();
  db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
  db.delete(prdDrafts).where(eq(prdDrafts.changeId, CHANGE_ID)).run();
  db.delete(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).run();
  db.delete(stageStates).where(eq(stageStates.changeId, CHANGE_ID)).run();
  db.delete(stageReports).where(eq(stageReports.changeId, CHANGE_ID)).run();
  db.delete(stageRuns).where(eq(stageRuns.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

describe("clarified stage gate", () => {
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

  // The PRD gate is derived from the briefing tables, which the card loop
  // deliberately replaces. Without its own gate the change lands in
  // INTAKE_READY with no action left: approving needs a gate snapshot that
  // nothing produces, and locking a briefing is only offered before the stage
  // ran. The stage that actually converged has to record its own verdict.
  it("records a passing PRD gate the change can be approved from", () => {
    sealClarifiedStageGate({ changeId: CHANGE_ID, phase: "prd", document: "# PRD" });

    const snapshot = getStageAuthority(CHANGE_ID, "PRD");
    assert.equal(snapshot.latestGate?.status, "pass");
  });

  it("puts the change at the intake gate so the next stage can start", () => {
    sealClarifiedStageGate({ changeId: CHANGE_ID, phase: "prd", document: "# PRD" });

    assert.equal(
      db.select().from(changes).where(eq(changes.id, CHANGE_ID)).get()?.gateState,
      "intake",
    );
  });

  // Re-adopting the same reply must not stack a second baseline; the PRD
  // authority recomputes its gate from those rows, so a duplicated baseline
  // would move the hash and read as a stale gate downstream.
  it("is idempotent when a stage is adopted more than once", () => {
    sealClarifiedStageGate({ changeId: CHANGE_ID, phase: "prd", document: "# PRD" });
    sealClarifiedStageGate({ changeId: CHANGE_ID, phase: "prd", document: "# PRD" });

    assert.equal(
      db.select().from(prdDrafts).where(eq(prdDrafts.changeId, CHANGE_ID)).all().length,
      1,
    );
    assert.equal(
      db.select().from(prdBriefings).where(eq(prdBriefings.changeId, CHANGE_ID)).all().length,
      1,
    );
  });

  // Only PRD owns a gate the card loop can settle today. Silently sealing a
  // phase whose gate means something else would clear it on no evidence.
  it("leaves phases it does not own untouched", () => {
    sealClarifiedStageGate({ changeId: CHANGE_ID, phase: "spec" });

    assert.equal(
      db.select().from(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).all().length,
      0,
    );
  });
});
