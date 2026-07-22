import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { runMigrations } from "../db/migrate.ts";
import * as dbSchema from "../db/schema.ts";
import { changes, mergeReadiness, projects } from "../db/schema.ts";
import { computeActions, setActionContractServiceDbForTest } from "./action-contract-service.ts";
import {
  approveMergeDecisionFromPersistedReadiness,
  mergeDecisionFromPersistedReadiness,
} from "./action-contract-merge-policy.ts";
import type { ActionContractDb } from "./action-contract-types.ts";

const PROJECT_ID = "PRJ-MERGE-POLICY-BLOCKERS";
const CHANGE_ID = "CHG-MERGE-POLICY-BLOCKERS";
const NOW = "2026-07-22T00:00:00.000Z";

function createTestDb(): ActionContractDb {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  runMigrations(sqlite);
  return drizzle(sqlite, { schema: dbSchema }) as unknown as ActionContractDb;
}

let db: ActionContractDb;
let restoreDb: () => void = () => {};

function seedChange() {
  db.insert(projects).values({
    id: PROJECT_ID,
    name: "Merge policy blockers",
    repoPath: "/tmp/merge-policy-blockers",
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
    title: "Merge policy blockers",
    status: "MERGE_READY",
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

function seedReadiness(status: string, blockersJson: string | null) {
  db.insert(mergeReadiness).values({
    id: `MR-${status}-${Math.random().toString(36).slice(2)}`,
    changeId: CHANGE_ID,
    status,
    sourceDbHash: "hash-merge-policy",
    sourceHeadSha: "a".repeat(40),
    blockersJson,
    computedAt: NOW,
  }).run();
}

describe("action-contract-merge-policy persisted readiness", () => {
  beforeEach(() => {
    db = createTestDb();
    restoreDb = setActionContractServiceDbForTest(db);
    seedChange();
  });

  afterEach(() => {
    restoreDb();
  });

  // The core symptom. A persisted readiness that says "blocked" must never
  // yield an enabled decision. Before the fix, an unparseable blockers_json was
  // swallowed into an empty array, and an empty array is the *enable*
  // predicate in mergeDecisionFromPersistedReadinessBlockers -- so corrupting
  // the payload bought the change more permission than a readable blocker list
  // would have. Unreadable evidence must fail closed, not open.
  describe("blocked readiness with an unreadable blockers_json", () => {
    it("keeps the merge decision disabled with an explicit reason", () => {
      seedReadiness("blocked", "{not valid json");

      const decision = mergeDecisionFromPersistedReadiness(db, CHANGE_ID);

      assert.equal(decision.enabled, false);
      assert.equal(decision.reasonCode, "merge_blockers_unreadable");
      assert.equal(decision.blockers.length, 1);
      assert.equal(decision.blockers[0].severity, "P0");
    });

    it("keeps the approve_merge decision disabled with an explicit reason", () => {
      seedReadiness("blocked", "{not valid json");

      const decision = approveMergeDecisionFromPersistedReadiness(db, CHANGE_ID);

      assert.equal(decision.enabled, false);
      assert.equal(decision.reasonCode, "merge_blockers_unreadable");
    });

    it("treats a valid-JSON non-array payload as unreadable too", () => {
      seedReadiness("blocked", '{"id":"x","title":"single object"}');

      const decision = mergeDecisionFromPersistedReadiness(db, CHANGE_ID);

      assert.equal(decision.enabled, false);
      assert.equal(decision.reasonCode, "merge_blockers_unreadable");
    });

    // A blocked readiness that lost its payload entirely is in the same
    // position as one that cannot be parsed: no readable evidence, so no
    // permission. "[]" from a NULL column used to read as "nothing blocks it".
    it("treats a null payload on a blocked readiness as unreadable", () => {
      seedReadiness("blocked", null);

      const decision = mergeDecisionFromPersistedReadiness(db, CHANGE_ID);

      assert.equal(decision.enabled, false);
      assert.equal(decision.reasonCode, "merge_blockers_unreadable");
    });

    // Status and payload disagreeing is still a disagreement: "blocked" with a
    // well-formed empty list is not evidence of readiness.
    it("keeps a blocked readiness disabled when its blocker array is empty", () => {
      seedReadiness("blocked", "[]");

      const decision = mergeDecisionFromPersistedReadiness(db, CHANGE_ID);

      assert.equal(decision.enabled, false);
    });
  });

  // The opposite direction, so the fix cannot be a blanket "always disabled".
  describe("readiness that should still be trusted", () => {
    it("enables merge for a ready readiness", () => {
      seedReadiness("ready", "[]");

      const decision = mergeDecisionFromPersistedReadiness(db, CHANGE_ID);

      assert.equal(decision.enabled, true);
      assert.equal(decision.reasonCode, null);
    });

    // A "ready" readiness never consults the blocker payload, so a garbage
    // payload must not retroactively block a change that genuinely passed.
    it("enables merge for a ready readiness even with a corrupt payload", () => {
      seedReadiness("ready", "{not valid json");

      const decision = mergeDecisionFromPersistedReadiness(db, CHANGE_ID);

      assert.equal(decision.enabled, true);
    });

    it("still surfaces real blockers from a well-formed blocked readiness", () => {
      seedReadiness(
        "blocked",
        JSON.stringify([{ id: "b1", reasonCode: "qa_failed", severity: "P0", title: "QA failed" }]),
      );

      const decision = mergeDecisionFromPersistedReadiness(db, CHANGE_ID);

      assert.equal(decision.enabled, false);
      assert.equal(decision.reasonCode, "qa_failed");
      assert.equal(decision.blockers.length, 1);
      assert.equal(decision.blockers[0].title, "QA failed");
    });

    // approve_merge drops the "approval missing" blocker before deciding --
    // that blocker is the very thing the action exists to clear. A readiness
    // blocked on nothing else must still let the approval through.
    it("enables approve_merge when the only blocker is the missing approval", () => {
      seedReadiness(
        "blocked",
        JSON.stringify([{ id: "b1", reasonCode: "merge_approval_missing", severity: "P1", title: "Approval missing" }]),
      );

      const decision = approveMergeDecisionFromPersistedReadiness(db, CHANGE_ID);

      assert.equal(decision.enabled, true);
    });
  });

  // End-to-end through the served contract. approve_merge carries no
  // enqueue-authority overlay (it is absent from PIPELINE_JOB_ACTIONS_BY_PHASE),
  // so the persisted-readiness policy is the only thing standing between a
  // corrupt payload and an enabled approval button.
  describe("served action contract", () => {
    it("does not offer an enabled approve_merge on a corrupt blocked readiness", () => {
      seedReadiness("blocked", "{not valid json");

      const action = computeActions(CHANGE_ID).find((item) => item.actionId === "approve_merge");

      assert.ok(action, "approve_merge should be present for a MERGE_READY change");
      assert.equal(action.enabled, false);
      assert.equal(action.reasonCode, "merge_blockers_unreadable");
    });
  });
});
