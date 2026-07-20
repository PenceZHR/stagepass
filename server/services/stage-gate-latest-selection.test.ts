import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { db } from "../db/index.ts";
import { changes, projects, stageGates } from "../db/schema.ts";
import { peekStageAuthority } from "./stage-authority-service.ts";
import { evaluateProviderActionAuthority } from "./provider-action-authority-service.ts";

/**
 * recomputeStageGate writes `gateVersion: input.gateVersion ?? 1`
 * (stage-authority-service.ts:444) -- the default never increments, so a change
 * can hold several gates for one phase that all sit at version 1. When two of
 * them also land in the same millisecond, ordering by (gateVersion, computedAt)
 * is not a total order and "the latest gate" becomes whatever SQLite returns
 * first.
 *
 * Stage Authority already breaks that tie on the gate id. The dispatch path did
 * not, so the two disagreed about which gate was current -- intermittently, and
 * only when the writes were fast enough to share a millisecond.
 */

const PROJECT_ID = "PRJ-GATE-TIE";
const CHANGE_ID = "CHG-GATE-TIE";
const NOW = "2026-07-14T00:00:00.000Z";
const SAME_MILLISECOND = "2026-07-14T00:01:00.000Z";

function cleanupRows(): void {
  db.delete(stageGates).where(eq(stageGates.changeId, CHANGE_ID)).run();
  db.delete(changes).where(eq(changes.id, CHANGE_ID)).run();
  db.delete(projects).where(eq(projects.id, PROJECT_ID)).run();
}

function seedChange(): void {
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Gate tie",
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
    title: "Gate tie",
    status: "IMPLEMENTED",
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

/**
 * Two gates for one phase, same gateVersion, same computedAt. Only the id
 * separates them, and only the newer one reflects the current sources. The
 * stale one is `blocked`, so whichever gate a reader picks is observable.
 */
function seedTiedGates(): void {
  db.insert(stageGates).values({
    id: "STG-GATE-TIE-001",
    changeId: CHANGE_ID,
    phase: "Plan",
    status: "blocked",
    blockersJson: null,
    freshnessJson: null,
    requiredActionsJson: null,
    sourceDbHash: "stale-hash",
    gateVersion: 1,
    computedAt: SAME_MILLISECOND,
  }).run();
  db.insert(stageGates).values({
    id: "STG-GATE-TIE-002",
    changeId: CHANGE_ID,
    phase: "Plan",
    status: "passed",
    blockersJson: null,
    freshnessJson: null,
    requiredActionsJson: null,
    sourceDbHash: "current-hash",
    gateVersion: 1,
    computedAt: SAME_MILLISECOND,
  }).run();
}

beforeEach(() => {
  cleanupRows();
  seedChange();
});

afterEach(cleanupRows);

describe("latest stage gate selection", () => {
  it("breaks a gateVersion + computedAt tie deterministically", () => {
    seedTiedGates();

    const gate = peekStageAuthority(CHANGE_ID, "Plan").latestGate;
    assert.equal(gate?.id, "STG-GATE-TIE-002", "Stage Authority picked the stale gate");
    assert.equal(gate?.sourceDbHash, "current-hash");
  });

  it("has the dispatch path agree with Stage Authority on which gate is current", () => {
    seedTiedGates();

    // waive_plan_p1 resolves its authority straight from the Plan gate, so the
    // gate the dispatch path picked is visible in the outcome: the stale gate is
    // `blocked` and would come back as gate_not_passed.
    const authority = evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID,
      phase: "plan",
      actionId: "waive_plan_p1",
    });

    assert.notEqual(
      authority.reasonCode,
      "gate_not_passed",
      "the dispatch path resolved the stale Plan gate while Stage Authority resolved the current " +
        "one -- the UI and the dispatcher disagree about which gate is in force",
    );
  });
});

/**
 * Residual-risk probe (recorded, NOT fixed -- out of scope): once retry_prd
 * accepts BLOCKED at the action-contract/preflight layers, the enqueue-time
 * authority in provider-action-authority-service still resolves phase "PRD" and
 * consults the latest "PRD" stage gate. syncPrdStageAuthority
 * (prd-briefing-service.ts) writes that gate as "blocked"/"pending" for any
 * briefing that has not locked, so a change that went through the new PRD flow
 * and was then recovered to BLOCKED carries a NON-passing PRD gate. This probe
 * conclusively records whether that layer independently blocks retry_prd.
 * retry_prd is verified UI-unreachable today, so this is documented, not fixed.
 */
describe("retry_prd enqueue authority after a new-flow intake block", () => {
  it("is independently blocked by a non-passing PRD gate (gate_not_passed)", () => {
    db.update(changes)
      .set({ status: "BLOCKED", blockedPhase: "intake" })
      .where(eq(changes.id, CHANGE_ID))
      .run();
    db.insert(stageGates).values({
      id: "STG-GATE-PRD-BLOCKED",
      changeId: CHANGE_ID,
      phase: "PRD",
      status: "blocked",
      blockersJson: null,
      freshnessJson: null,
      requiredActionsJson: null,
      sourceDbHash: "prd-blocked-source-hash",
      gateVersion: 1,
      computedAt: NOW,
    }).run();

    const authority = evaluateProviderActionAuthority(db, {
      changeId: CHANGE_ID,
      phase: "intake",
      actionId: "retry_prd",
    });

    // FINDING: yes -- this layer blocks retry_prd on gate_not_passed regardless of
    // the changes.status fix. A follow-up (out of this task's scope) is needed if
    // retry_prd ever becomes UI-reachable for a new-flow-then-BLOCKED change.
    assert.equal(authority.enabled, false);
    assert.equal(authority.reasonCode, "gate_not_passed");
  });
});
