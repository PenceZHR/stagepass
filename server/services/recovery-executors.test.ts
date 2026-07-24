import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { db } from "../db";
import {
  battleRounds,
  changes,
  events,
  pipelineJobs,
  projects,
  providerRunProcesses,
  runs,
} from "../db/schema";
import { recoverMissingProvider } from "./recovery-executors";
import { claimSpecBattleRedRun } from "./spec-battle-service";

const PROJECT_ID = "PRJ-RECOVERY-EXEC";
const CHANGE_ID = "CHG-RECOVERY-EXEC";
const OTHER_CHANGE_ID = "CHG-RECOVERY-EXEC-OTHER";
const ROUND_ID = "BRD-RECOVERY-EXEC";
const OTHER_ROUND_ID = "BRD-RECOVERY-EXEC-OTHER";
const RUN_ID = "RUN-RECOVERY-EXEC";
const SEEDED_AT = "2026-07-20T09:00:00.000Z";
const RECOVERED_AT = "2026-07-20T10:00:00.000Z";

function cleanupRows() {
  for (const changeId of [CHANGE_ID, OTHER_CHANGE_ID]) {
    db.delete(battleRounds).where(eq(battleRounds.changeId, changeId)).run();
    db.delete(events).where(eq(events.changeId, changeId)).run();
    db.delete(providerRunProcesses).where(eq(providerRunProcesses.changeId, changeId)).run();
    db.delete(pipelineJobs).where(eq(pipelineJobs.changeId, changeId)).run();
    db.delete(runs).where(eq(runs.changeId, changeId)).run();
    db.delete(changes).where(eq(changes.id, changeId)).run();
  }
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedProject() {
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Recovery executors",
    repoPath: "/tmp/recovery-executors-does-not-exist",
    contextStatus: "ready",
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  }).run();
}

function seedChange(changeId: string) {
  db.insert(changes).values({
    id: changeId,
    projectId: PROJECT_ID,
    title: "Recovery executors",
    status: "SPECCING",
    provider: "codex",
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  }).run();
}

function seedRound(input: { roundId: string; changeId: string; status: string }) {
  db.insert(battleRounds).values({
    id: input.roundId,
    changeId: input.changeId,
    phase: "Spec",
    template: "SPEC_BATTLE_MVP",
    roundNo: 1,
    status: input.status,
    redUnit: "SPEC_WRITER",
    blueUnit: "REQUIREMENT_CRITIC",
    inputSnapshotJson: "{}",
    paramsJson: "{}",
    startedAt: SEEDED_AT,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  }).run();
}

/**
 * Mirrors spec-battle-service's claim insert exactly: phase is always "spec"
 * even on the resumeBlue path, and neither jobId nor attemptNo is written.
 */
function seedSpecRun(changeId: string) {
  db.insert(runs).values({
    id: RUN_ID,
    changeId,
    phase: "spec",
    status: "running",
    startedAt: SEEDED_AT,
    endedAt: null,
    summary: null,
    provider: "codex",
  }).run();
  return db.select().from(runs).where(eq(runs.id, RUN_ID)).get()!;
}

function roundStatus(roundId: string): string | undefined {
  return db.select().from(battleRounds).where(eq(battleRounds.id, roundId)).get()?.status;
}

describe("recoverMissingProvider settles the Spec round its run stranded", () => {
  beforeEach(cleanupRows);
  afterEach(cleanupRows);

  /**
   * The user-visible dead end. A crash on the resumeBlue path leaves the round
   * at blue_running behind a run whose phase is "spec". Recovery must clear the
   * round's running claim, otherwise run_spec answers spec_round_running for
   * ever and the change has no way forward.
   */
  it("unblocks run_spec after a crash on the resumeBlue path", () => {
    seedProject();
    seedChange(CHANGE_ID);
    seedRound({ roundId: ROUND_ID, changeId: CHANGE_ID, status: "blue_running" });
    const run = seedSpecRun(CHANGE_ID);

    const result = recoverMissingProvider({
      run,
      reasonCode: "provider_start_missing",
      recoveredAt: RECOVERED_AT,
    });
    assert.ok(result, "recovery should have run");

    assert.equal(
      roundStatus(ROUND_ID),
      "failed",
      "round must not still be claiming to run after its run was recovered",
    );

    const claim = claimSpecBattleRedRun({ changeId: CHANGE_ID, idempotencyKey: "after-recovery" });
    assert.notEqual(
      claim.reason,
      "spec_round_running",
      "run_spec must not stay blocked on a round nothing is running any more",
    );
    assert.equal(claim.claimed, true);
  });

  it("settles a round stranded in the red half as well", () => {
    seedProject();
    seedChange(CHANGE_ID);
    seedRound({ roundId: ROUND_ID, changeId: CHANGE_ID, status: "red_running" });
    const run = seedSpecRun(CHANGE_ID);

    assert.ok(recoverMissingProvider({
      run,
      reasonCode: "provider_start_missing",
      recoveredAt: RECOVERED_AT,
    }));

    assert.equal(roundStatus(ROUND_ID), "failed");
  });

  /**
   * The other half of the rule. A round that already reached a settled status
   * is finished work; recovery widening its reach to "any round of this change"
   * would destroy a completed round because an unrelated provider row was
   * missing.
   */
  it("leaves a round that is not claiming to run untouched", () => {
    seedProject();
    seedChange(CHANGE_ID);
    seedRound({ roundId: ROUND_ID, changeId: CHANGE_ID, status: "report_ready" });
    const run = seedSpecRun(CHANGE_ID);

    assert.ok(recoverMissingProvider({
      run,
      reasonCode: "provider_start_missing",
      recoveredAt: RECOVERED_AT,
    }));

    assert.equal(roundStatus(ROUND_ID), "report_ready");
  });

  it("leaves another change's running round untouched", () => {
    seedProject();
    seedChange(CHANGE_ID);
    seedChange(OTHER_CHANGE_ID);
    seedRound({ roundId: ROUND_ID, changeId: CHANGE_ID, status: "blue_running" });
    seedRound({ roundId: OTHER_ROUND_ID, changeId: OTHER_CHANGE_ID, status: "blue_running" });
    const run = seedSpecRun(CHANGE_ID);

    assert.ok(recoverMissingProvider({
      run,
      reasonCode: "provider_start_missing",
      recoveredAt: RECOVERED_AT,
    }));

    assert.equal(roundStatus(ROUND_ID), "failed");
    assert.equal(
      roundStatus(OTHER_ROUND_ID),
      "blue_running",
      "recovery must stay scoped to the change it is recovering",
    );
  });

  it("keeps the round's running claim when the recovery itself is skipped", () => {
    seedProject();
    seedChange(CHANGE_ID);
    seedRound({ roundId: ROUND_ID, changeId: CHANGE_ID, status: "blue_running" });
    const run = seedSpecRun(CHANGE_ID);
    // A newer job for the same change means this run no longer owns it, so
    // recovery must not settle state the new owner is about to drive.
    db.insert(pipelineJobs).values({
      id: "JOB-RECOVERY-EXEC-NEWER",
      changeId: CHANGE_ID,
      phase: "spec",
      actionId: "run_spec",
      status: "leased",
      attemptNo: 0,
      createdAt: "2026-07-20T09:30:00.000Z",
    }).run();

    recoverMissingProvider({
      run,
      reasonCode: "provider_start_missing",
      recoveredAt: RECOVERED_AT,
    });

    assert.equal(roundStatus(ROUND_ID), "blue_running");
  });
});
