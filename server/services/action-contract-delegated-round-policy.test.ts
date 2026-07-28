import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "../db/index.ts";
import { battleRounds, changes, projects } from "../db/schema.ts";
import { delegatedRoundRunDecision } from "./action-contract-delegated-round-policy.ts";
import type { BattleRoundStatus } from "../types/battle-round-status.ts";

const PROJECT_ID = "PRJ-ROUND-POLICY";
const CHANGE_ID = "CHG-ROUND-POLICY";

function cleanup(): void {
  db.delete(battleRounds).where(eq(battleRounds.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seed(): void {
  const now = new Date().toISOString();
  db.insert(projects).values({
    id: PROJECT_ID, name: "Round policy", repoPath: "/tmp/round-policy",
    contextStatus: "ready", contextProvider: "codex", prdStatus: "ready", prdProvider: "codex",
    prdJson: null, prdMarkdown: null, gitEnabled: 0, gitDefaultBranch: null,
    createdAt: now, updatedAt: now,
  }).run();
  db.insert(changes).values({
    id: CHANGE_ID, projectId: PROJECT_ID, title: "Round policy change", status: "SPEC_READY",
    provider: "codex", codexThreadId: null, fixIterations: 0, blockedPhase: null,
    reworkFromPhase: null, suspendedByPrd: 0, preSuspendStatus: null, gitBranch: null,
    gateState: "spec", docsComplete: 0, retroDone: 0, createdAt: now, updatedAt: now,
  }).run();
}

function seedRound(status: BattleRoundStatus): void {
  const now = new Date().toISOString();
  db.insert(battleRounds).values({
    id: `BRD-${status}`, changeId: CHANGE_ID, phase: "TechSpec", template: "DELEGATED_ROUND_V1",
    roundNo: 1, status, redUnit: "TECH_SPEC_WRITER", blueUnit: "TECH_SPEC_CRITIC",
    inputSnapshotJson: "{}", paramsJson: "{}", redArtifactPath: null, redArtifactHash: null,
    blueArtifactPath: null, blueArtifactHash: null, reportPath: null, supersededByRoundId: null,
    startedAt: now, endedAt: null, createdAt: now, updatedAt: now,
  }).run();
}

function decide(isRetry: boolean) {
  return delegatedRoundRunDecision({
    actionId: isRetry ? "retry_tech_spec" : "run_tech_spec",
    changeId: CHANGE_ID,
    phase: "TechSpec",
    isRetry,
  });
}

describe("delegated round run policy", { concurrency: false }, () => {
  beforeEach(() => {
    cleanup();
    seed();
  });
  afterEach(cleanup);

  it("says nothing when the phase has never run a round", () => {
    assert.equal(decide(false), null, "the phase's own gate should decide");
    assert.equal(decide(true), null);
  });

  it("shuts both actions while a round is in flight", () => {
    seedRound("red_running");
    assert.equal(decide(false)?.reasonCode, "techspec_round_running");
    assert.equal(decide(true)?.reasonCode, "techspec_round_running");
  });

  /**
   * The branch whose absence is a dead end rather than a wrong answer. Without
   * it `awaiting_clarification` falls to the bottom of the table and disables
   * BOTH actions: the Codex task sits open holding unanswered questions and the
   * human has no way to abandon them.
   */
  it("leaves retry open on a round parked on the human, and run shut", () => {
    seedRound("awaiting_clarification");
    assert.equal(
      decide(false)?.reasonCode,
      "techspec_round_awaiting_clarification",
      "a second run would race the answers the human is typing",
    );
    assert.equal(decide(true), null, "retry is the only way out of a question loop");
  });

  it("leaves retry open on a failed round, and run shut", () => {
    seedRound("failed");
    assert.equal(decide(false)?.reasonCode, "techspec_round_failed_retry_required");
    assert.equal(decide(true), null);
  });

  /**
   * A settled round is a human decision, not a green light. Leaving `run_*`
   * enabled here would let one click silently open another round and burn a
   * full red/blue/judge cycle.
   */
  it("hands a settled round to the human instead of re-running it", () => {
    seedRound("report_ready");
    assert.equal(decide(false)?.reasonCode, "techspec_round_human_decision_required");
    assert.equal(decide(true)?.reasonCode, "techspec_round_not_failed");
  });

  it("lets the phase run again once the previous round is superseded", () => {
    seedRound("superseded");
    assert.equal(decide(false), null);
    assert.equal(decide(true)?.reasonCode, "techspec_round_not_failed");
  });

  it("keeps a closed round from being re-run", () => {
    seedRound("closed");
    assert.equal(decide(false)?.reasonCode, "techspec_round_closed");
  });

  /**
   * Every status must land on a branch that names itself. The fallthrough exists
   * only as a backstop, and a status reaching it means the table is missing a
   * case -- so nothing may reach it today.
   */
  it("gives every round status a named branch", () => {
    const statuses: BattleRoundStatus[] = [
      "not_started", "red_running", "red_done", "blue_running", "blue_done",
      "report_ready", "closed", "superseded", "failed", "awaiting_clarification",
    ];
    for (const status of statuses) {
      cleanup();
      seed();
      seedRound(status);
      for (const isRetry of [false, true]) {
        assert.notEqual(
          decide(isRetry)?.reasonCode,
          "techspec_round_not_actionable",
          `${status} (retry=${isRetry}) fell through to the backstop`,
        );
      }
    }
  });

  it("scopes to its own phase's rounds", () => {
    seedRound("red_running");
    assert.equal(
      delegatedRoundRunDecision({
        actionId: "run_plan", changeId: CHANGE_ID, phase: "Plan", isRetry: false,
      }),
      null,
      "a running TechSpec round shut Plan's button",
    );
  });
});
