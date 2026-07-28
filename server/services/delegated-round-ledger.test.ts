import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "../db/index.ts";
import { battleRounds, changes, events, projects } from "../db/schema.ts";
import {
  DelegatedRoundLedgerError,
  failDelegatedRound,
  getDelegatedRoundState,
  openDelegatedRound,
  pauseDelegatedRound,
  claimDelegatedRound,
  resumeDelegatedRound,
  settleDelegatedRound,
} from "./delegated-round-ledger.ts";
import {
  PLAN_DELEGATED_ROUND,
  SPEC_DELEGATED_ROUND,
  TECH_SPEC_DELEGATED_ROUND,
} from "./delegated-round-phases.ts";

const PROJECT_ID = "PRJ-DELEGATED-LEDGER";
const CHANGE_ID = "CHG-DELEGATED-LEDGER";

function cleanup(): void {
  // Events first: fail and pause both emit one, and every event row carries a
  // foreign key onto the change.
  db.delete(events).where(eq(events.changeId, CHANGE_ID)).run();
  db.delete(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seed(): void {
  const now = new Date().toISOString();
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Delegated Ledger",
    repoPath: "/tmp/delegated-ledger",
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
    title: "Delegated ledger change",
    status: "SPEC_READY",
    provider: "codex",
    codexThreadId: null,
    fixIterations: 0,
    blockedPhase: null,
    reworkFromPhase: null,
    suspendedByPrd: 0,
    preSuspendStatus: null,
    gitBranch: null,
    gateState: "spec",
    docsComplete: 0,
    retroDone: 0,
    createdAt: now,
    updatedAt: now,
  }).run();
}

const SETTLEMENT = {
  redArtifactPath: "/tmp/red.json",
  redArtifactHash: "redhash",
  blueArtifactPath: "/tmp/blue.json",
  blueArtifactHash: "bluehash",
};

async function openAndClaim(descriptor = TECH_SPEC_DELEGATED_ROUND) {
  const opened = await openDelegatedRound({ changeId: CHANGE_ID, descriptor });
  claimDelegatedRound({ changeId: CHANGE_ID, descriptor, roundId: opened.roundId });
  return opened;
}

describe("delegated-round-ledger", { concurrency: false }, () => {
  beforeEach(() => {
    cleanup();
    seed();
  });

  afterEach(cleanup);

  it("opens round 1 with the phase's own codenames", async () => {
    const opened = await openDelegatedRound({
      changeId: CHANGE_ID,
      descriptor: TECH_SPEC_DELEGATED_ROUND,
    });

    assert.equal(opened.roundNo, 1);
    assert.equal(opened.status, "not_started");
    const row = db.select().from(battleRounds).where(eq(battleRounds.id, opened.roundId)).get();
    assert.ok(row);
    assert.equal(row.phase, "TechSpec");
    assert.equal(row.redUnit, "TECH_SPEC_WRITER");
    assert.equal(row.blueUnit, "TECH_SPEC_CRITIC");
  });

  /**
   * The whole reason this ledger is separate from spec-battle-service. Each
   * phase gets its own round sequence, its own occupancy and its own latest
   * round; sharing a table must not mean sharing a slot.
   */
  it("numbers and occupies each phase independently", async () => {
    const techSpec = await openAndClaim(TECH_SPEC_DELEGATED_ROUND);
    const plan = await openDelegatedRound({
      changeId: CHANGE_ID,
      descriptor: PLAN_DELEGATED_ROUND,
    });

    assert.equal(plan.roundNo, 1, "Plan numbered around a TechSpec round");
    assert.equal(
      getDelegatedRoundState(CHANGE_ID, "TechSpec").latestRound?.id,
      techSpec.roundId,
    );
    assert.equal(getDelegatedRoundState(CHANGE_ID, "Plan").latestRound?.id, plan.roundId);
    assert.equal(getDelegatedRoundState(CHANGE_ID, "Spec").latestRound, null);
  });

  it("refuses a second round of the same phase while one occupies the slot", async () => {
    await openAndClaim(TECH_SPEC_DELEGATED_ROUND);

    await assert.rejects(
      () => openDelegatedRound({ changeId: CHANGE_ID, descriptor: TECH_SPEC_DELEGATED_ROUND }),
      (err: Error) => err instanceof DelegatedRoundLedgerError && err.code === "round_occupied",
    );
  });

  it("numbers the next round after the previous one is superseded", async () => {
    const first = await openAndClaim(TECH_SPEC_DELEGATED_ROUND);
    db.update(battleRounds).set({ status: "superseded" })
      .where(eq(battleRounds.id, first.roundId)).run();

    const second = await openDelegatedRound({
      changeId: CHANGE_ID,
      descriptor: TECH_SPEC_DELEGATED_ROUND,
    });
    assert.equal(second.roundNo, 2);
  });

  it("settles a claimed round to report_ready with both sides' artifacts", async () => {
    const opened = await openAndClaim();

    settleDelegatedRound({
      changeId: CHANGE_ID,
      descriptor: TECH_SPEC_DELEGATED_ROUND,
      roundId: opened.roundId,
      ...SETTLEMENT,
    });

    const row = db.select().from(battleRounds).where(eq(battleRounds.id, opened.roundId)).get();
    assert.equal(row?.status, "report_ready");
    assert.equal(row?.redArtifactPath, SETTLEMENT.redArtifactPath);
    assert.equal(row?.blueArtifactHash, SETTLEMENT.blueArtifactHash);
    assert.ok(row?.endedAt, "a settled round must record when it ended");
  });

  /**
   * §7.3's rule, at the ledger's own door: a round that never ran cannot be
   * settled from whatever files happen to be on disk.
   */
  it("refuses to settle a round that was never claimed", async () => {
    const opened = await openDelegatedRound({
      changeId: CHANGE_ID,
      descriptor: TECH_SPEC_DELEGATED_ROUND,
    });

    assert.throws(
      () => settleDelegatedRound({
        changeId: CHANGE_ID,
        descriptor: TECH_SPEC_DELEGATED_ROUND,
        roundId: opened.roundId,
        ...SETTLEMENT,
      }),
      (err: Error) => err instanceof DelegatedRoundLedgerError && err.code === "round_not_ready",
    );
  });

  it("refuses to settle a round that is not the phase's current one", async () => {
    const first = await openAndClaim();
    db.update(battleRounds).set({ status: "superseded" })
      .where(eq(battleRounds.id, first.roundId)).run();
    await openAndClaim();

    assert.throws(
      () => settleDelegatedRound({
        changeId: CHANGE_ID,
        descriptor: TECH_SPEC_DELEGATED_ROUND,
        roundId: first.roundId,
        ...SETTLEMENT,
      }),
      (err: Error) => err instanceof DelegatedRoundLedgerError && err.code === "round_not_current",
    );
  });

  it("refuses a round belonging to another phase", async () => {
    const opened = await openAndClaim(TECH_SPEC_DELEGATED_ROUND);

    assert.throws(
      () => settleDelegatedRound({
        changeId: CHANGE_ID,
        descriptor: PLAN_DELEGATED_ROUND,
        roundId: opened.roundId,
        ...SETTLEMENT,
      }),
      (err: Error) => err instanceof DelegatedRoundLedgerError && err.code === "round_phase_mismatch",
    );
  });

  it("fails a running round and records the reason", async () => {
    const opened = await openAndClaim();

    failDelegatedRound({
      changeId: CHANGE_ID,
      descriptor: TECH_SPEC_DELEGATED_ROUND,
      roundId: opened.roundId,
      reason: "delegated round refused",
    });

    const row = db.select().from(battleRounds).where(eq(battleRounds.id, opened.roundId)).get();
    assert.equal(row?.status, "failed");
    assert.ok(row?.endedAt);
  });

  /**
   * Parking must not end the round: `endedAt` is what every later reader uses to
   * tell a finished round from one still holding the human's unanswered
   * questions.
   */
  it("parks a round on the human without ending it, and returns it to the leg it left", async () => {
    const opened = await openAndClaim();

    pauseDelegatedRound({
      changeId: CHANGE_ID,
      descriptor: TECH_SPEC_DELEGATED_ROUND,
      roundId: opened.roundId,
    });
    const parked = db.select().from(battleRounds).where(eq(battleRounds.id, opened.roundId)).get();
    assert.equal(parked?.status, "awaiting_clarification");
    assert.equal(parked?.endedAt, null, "a parked round is unfinished, not finished");

    const resumed = resumeDelegatedRound({
      changeId: CHANGE_ID,
      descriptor: TECH_SPEC_DELEGATED_ROUND,
      roundId: opened.roundId,
    });
    assert.equal(resumed.resumed, true);
    const back = db.select().from(battleRounds).where(eq(battleRounds.id, opened.roundId)).get();
    assert.equal(back?.status, "red_running");
  });

  /**
   * Adoption can deliver the same converged answer twice. The second one must
   * not restart a round that has already moved on.
   */
  it("resumes a parked round exactly once", async () => {
    const opened = await openAndClaim();
    pauseDelegatedRound({
      changeId: CHANGE_ID,
      descriptor: TECH_SPEC_DELEGATED_ROUND,
      roundId: opened.roundId,
    });
    resumeDelegatedRound({
      changeId: CHANGE_ID,
      descriptor: TECH_SPEC_DELEGATED_ROUND,
      roundId: opened.roundId,
    });

    const again = resumeDelegatedRound({
      changeId: CHANGE_ID,
      descriptor: TECH_SPEC_DELEGATED_ROUND,
      roundId: opened.roundId,
    });
    assert.equal(again.resumed, false);
  });

  it("does not park a round that is no longer in flight", async () => {
    const opened = await openAndClaim();
    settleDelegatedRound({
      changeId: CHANGE_ID,
      descriptor: TECH_SPEC_DELEGATED_ROUND,
      roundId: opened.roundId,
      ...SETTLEMENT,
    });

    assert.throws(
      () => pauseDelegatedRound({
        changeId: CHANGE_ID,
        descriptor: TECH_SPEC_DELEGATED_ROUND,
        roundId: opened.roundId,
      }),
      (err: Error) => err instanceof DelegatedRoundLedgerError && err.code === "round_not_in_flight",
    );
  });

  /**
   * Spec keeps its own ledger (see the handoff's §5.0: spec-battle-service has
   * 45 Spec-specific call sites and is the only path with real runtime
   * evidence). This ledger must never be the thing that writes a Spec round.
   */
  /**
   * A settled round has to leave the change on a status the transition table can
   * actually reach from the running one. The table has no self-edge on a running
   * status (`TECHSPECCING -> {TECHSPEC_READY, SPEC_READY, BLOCKED}`), so a stage
   * that ended its run on `runningStatus` threw IllegalTransitionError AFTER the
   * round, its gaps and its gate had all been written -- the half-settled round
   * the whole ingestion path exists to prevent, reached from the other side.
   *
   * Asserted against the real table rather than against the constant each stage
   * passes, so a phase wired with the wrong pair fails here rather than on a
   * live round.
   */
  it("gives every delegated phase a settled status its running status can reach", async () => {
    const { ALLOWED_TRANSITIONS } = await import("../state-machine/transitions.ts");
    for (const [running, settled] of [
      ["TECHSPECCING", "TECHSPEC_READY"],
      ["PLANNING", "PLAN_READY"],
      ["TESTPLANNING", "TESTPLAN_DONE"],
    ] as const) {
      assert.ok(
        ALLOWED_TRANSITIONS.get(running)?.has(settled),
        `${running} -> ${settled} is not a legal transition, so the round would settle and then throw`,
      );
      assert.equal(
        ALLOWED_TRANSITIONS.get(running)?.has(running),
        false,
        `${running} has a self-edge, which would hide this class of bug`,
      );
    }
  });

  it("refuses to open a Spec round", async () => {
    await assert.rejects(
      () => openDelegatedRound({ changeId: CHANGE_ID, descriptor: SPEC_DELEGATED_ROUND }),
      (err: Error) => err instanceof DelegatedRoundLedgerError && err.code === "phase_has_own_ledger",
    );
  });
});
