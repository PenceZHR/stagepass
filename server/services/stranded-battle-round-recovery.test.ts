import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { db } from "../db";
import { battleRounds, changes, events, projects, runs } from "../db/schema";
import { recoverStrandedBattleRounds } from "./recovery-executors";

const PROJECT_ID = "PRJ-STRANDED-ROUND";
const CHANGE_ID = "CHG-STRANDED-ROUND";
const ROUND_ID = "BRD-STRANDED-ROUND";
const NOW = new Date("2026-07-20T10:00:00.000Z");

function cleanupRows() {
  db.delete(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).run();
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(runs).where(eq(runs.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedRound(status: "red_running" | "blue_running" | "report_ready") {
  const at = "2026-07-20T09:00:00.000Z";
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Stranded round recovery",
    repoPath: "/tmp/stranded-round-recovery",
    contextStatus: "ready",
    createdAt: at,
    updatedAt: at,
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Stranded round",
    status: "SPECCING",
    createdAt: at,
    updatedAt: at,
  }).run();
  db.insert(battleRounds).values({
    id: ROUND_ID,
    changeId: CHANGE_ID,
    phase: "Spec",
    template: "default",
    roundNo: 1,
    status,
    redUnit: "red",
    blueUnit: "blue",
    inputSnapshotJson: "{}",
    paramsJson: "{}",
    startedAt: at,
    createdAt: at,
    updatedAt: at,
  }).run();
}

function seedRun(status: "running" | "failed") {
  db.insert(runs).values({
    id: `RUN-STRANDED-${status}`,
    changeId: CHANGE_ID,
    phase: "spec",
    status,
    startedAt: "2026-07-20T09:00:00.000Z",
    endedAt: status === "running" ? null : "2026-07-20T09:05:00.000Z",
    attemptNo: 1,
  }).run();
}

function roundStatus(): string | undefined {
  return db.select().from(battleRounds).where(eq(battleRounds.id, ROUND_ID)).get()?.status;
}

describe("stranded Spec battle round recovery", () => {
  beforeEach(cleanupRows);
  afterEach(cleanupRows);

  it("fails a round left running after its run is already terminal", () => {
    seedRound("blue_running");
    seedRun("failed");

    const recovered = recoverStrandedBattleRounds(NOW);

    assert.deepEqual(recovered, [ROUND_ID]);
    assert.equal(roundStatus(), "failed");
    const round = db.select().from(battleRounds).where(eq(battleRounds.id, ROUND_ID)).get();
    assert.equal(round?.endedAt, NOW.toISOString());
    const event = db.select().from(events)
      .where(eq(events.type, "stranded_battle_round_recovered")).get();
    assert.ok(event, "recovery should be recorded as an event");
    assert.match(event?.rawJson ?? "", /"from":"blue_running"/);
  });

  it("recovers a round stranded in the red half too", () => {
    seedRound("red_running");
    seedRun("failed");

    assert.deepEqual(recoverStrandedBattleRounds(NOW), [ROUND_ID]);
    assert.equal(roundStatus(), "failed");
  });

  // The whole point of the liveness guard: a Spec round legitimately sits at
  // blue_running for minutes while the run behind it works. Killing that is
  // strictly worse than the dead end this recovery exists to clear.
  it("leaves a round alone while a Spec run is still in flight", () => {
    seedRound("blue_running");
    seedRun("running");

    assert.deepEqual(recoverStrandedBattleRounds(NOW), []);
    assert.equal(roundStatus(), "blue_running");
    assert.equal(
      db.select().from(events).where(eq(events.type, "stranded_battle_round_recovered")).all().length,
      0,
    );
  });

  it("ignores rounds that are not claiming to run", () => {
    seedRound("report_ready");
    seedRun("failed");

    assert.deepEqual(recoverStrandedBattleRounds(NOW), []);
    assert.equal(roundStatus(), "report_ready");
  });

  it("recovers a round whose run row is gone entirely", () => {
    seedRound("blue_running");

    assert.deepEqual(recoverStrandedBattleRounds(NOW), [ROUND_ID]);
    assert.equal(roundStatus(), "failed");
  });
});
