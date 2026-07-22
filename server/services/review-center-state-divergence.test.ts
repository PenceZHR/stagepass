import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { runMigrations } from "../db/migrate";
import * as dbSchema from "../db/schema";
import {
  buildRunRecords,
  changes,
  findings,
  projects,
  reviewAttempts,
  reviewReports,
  reviewState,
} from "../db/schema";
import {
  getReviewCenterState as stateSvcGetReviewCenterState,
  setReviewCenterStateServiceDbForTest,
  type ReviewCenterStateDb,
} from "./review-center-state-service";
import {
  getReviewCenterState as centerSvcGetReviewCenterState,
  setReviewCenterServiceDbForTest,
} from "./review-center-service";
import { gateDecision } from "./action-contract-common-policy";
import type { StageAuthoritySnapshot } from "./stage-authority-service";

const NOW = "2026-07-20T00:00:00.000Z";

function createTestDb(): ReviewCenterStateDb {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  runMigrations(sqlite);
  return drizzle(sqlite, { schema: dbSchema }) as unknown as ReviewCenterStateDb;
}

function seedChange(db: ReviewCenterStateDb, changeId: string): void {
  db.insert(projects).values({
    id: `PRJ-${changeId}`,
    name: "divergence",
    repoPath: `/tmp/${changeId}`,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(changes).values({
    id: changeId,
    projectId: `PRJ-${changeId}`,
    title: "divergence",
    status: "review",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

function seedCompletedAttempt(
  db: ReviewCenterStateDb,
  changeId: string,
  gateStatus: string | null,
): void {
  db.insert(reviewAttempts).values({
    id: `RA-${changeId}`,
    changeId,
    attemptNo: 1,
    status: "completed",
    reviewStatus: "passed",
    idempotencyKey: `IK-${changeId}`,
    startedAt: NOW,
    endedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(reviewState).values({
    changeId,
    latestAttemptId: `RA-${changeId}`,
    gateStatus,
    updatedAt: NOW,
  }).run();
}

/** The full happy path: attempt -> valid report -> approved build run. */
function seedFullPass(
  db: ReviewCenterStateDb,
  changeId: string,
  opts: { buildFresh: boolean },
): void {
  const attemptId = `RA-${changeId}`;
  const reportId = `RR-${changeId}`;
  db.insert(buildRunRecords).values({
    id: `BR-${changeId}`,
    changeId,
    buildRunId: `BUILD-${changeId}`,
    status: "adopted",
    headSha: "sha-current",
    adoptedHeadSha: "sha-current",
    source: "build",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(reviewAttempts).values({
    id: attemptId,
    changeId,
    attemptNo: 1,
    status: "completed",
    reviewStatus: "passed",
    idempotencyKey: `IK-${changeId}`,
    startedAt: NOW,
    endedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(reviewReports).values({
    id: reportId,
    attemptId,
    changeId,
    reportVersion: 1,
    reviewConclusion: "passed",
    reportDbHash: "hash",
    gateStatus: "passed",
    qaAllowed: 1,
    sourceBuildRunId: opts.buildFresh ? `BUILD-${changeId}` : "BUILD-OLD",
    generatedAt: NOW,
    createdAt: NOW,
  }).run();
  db.insert(reviewState).values({
    changeId,
    latestAttemptId: attemptId,
    latestReportId: reportId,
    latestValidReviewReportId: reportId,
    gateStatus: "passed",
    updatedAt: NOW,
  }).run();
}

interface Scenario {
  name: string;
  seed: (db: ReviewCenterStateDb, changeId: string) => void;
}

const SCENARIOS: Scenario[] = [
  {
    name: "review_state passed, no findings",
    seed: (db, changeId) => {
      db.insert(reviewState).values({ changeId, gateStatus: "passed", updatedAt: NOW }).run();
    },
  },
  {
    name: "review_state passed, 1 WAIVED P1",
    seed: (db, changeId) => {
      db.insert(reviewState).values({ changeId, gateStatus: "passed", updatedAt: NOW }).run();
      db.insert(findings).values({
        id: `F-${changeId}-P1`,
        changeId,
        source: "review",
        severity: "P1",
        category: "correctness",
        title: "waived p1",
        status: "waived",
        createdAt: NOW,
      }).run();
    },
  },
  {
    name: "review_state passed, 1 OPEN P2",
    seed: (db, changeId) => {
      db.insert(reviewState).values({ changeId, gateStatus: "passed", updatedAt: NOW }).run();
      db.insert(findings).values({
        id: `F-${changeId}-P2`,
        changeId,
        source: "review",
        severity: "P2",
        category: "style",
        title: "open p2",
        status: "open",
        createdAt: NOW,
      }).run();
    },
  },
  {
    name: "review_state gateStatus NULL",
    seed: (db, changeId) => {
      db.insert(reviewState).values({ changeId, gateStatus: null, updatedAt: NOW }).run();
    },
  },
  {
    name: "review_state passed, 1 OPEN P0",
    seed: (db, changeId) => {
      db.insert(reviewState).values({ changeId, gateStatus: "passed", updatedAt: NOW }).run();
      db.insert(findings).values({
        id: `F-${changeId}-P0`,
        changeId,
        source: "review",
        severity: "P0",
        category: "correctness",
        title: "open p0",
        status: "open",
        createdAt: NOW,
      }).run();
    },
  },
  {
    name: "review_state failed",
    seed: (db, changeId) => {
      db.insert(reviewState).values({ changeId, gateStatus: "failed", updatedAt: NOW }).run();
    },
  },
  {
    name: "review_state stale",
    seed: (db, changeId) => {
      db.insert(reviewState).values({ changeId, gateStatus: "stale", updatedAt: NOW }).run();
    },
  },
  {
    name: "attempt done, gateStatus passed",
    seed: (db, changeId) => seedCompletedAttempt(db, changeId, "passed"),
  },
  {
    name: "attempt done, passed_with_waived_p1",
    seed: (db, changeId) => seedCompletedAttempt(db, changeId, "passed_with_waived_p1"),
  },
  {
    name: "attempt done, gateStatus NULL",
    seed: (db, changeId) => seedCompletedAttempt(db, changeId, null),
  },
  {
    name: "attempt done, invalid_output",
    seed: (db, changeId) => seedCompletedAttempt(db, changeId, "invalid_output"),
  },
  {
    name: "attempt done, blocked_p0 status only",
    seed: (db, changeId) => seedCompletedAttempt(db, changeId, "blocked_p0"),
  },
  {
    name: "valid report, qaAllowed, fresh build",
    seed: (db, changeId) => seedFullPass(db, changeId, { buildFresh: true }),
  },
  {
    name: "valid report, qaAllowed, STALE build",
    seed: (db, changeId) => seedFullPass(db, changeId, { buildFresh: false }),
  },
  {
    name: "attempt running",
    seed: (db, changeId) => {
      db.insert(reviewAttempts).values({
        id: `RA-${changeId}`,
        changeId,
        attemptNo: 1,
        status: "running",
        reviewStatus: "running",
        idempotencyKey: `IK-${changeId}`,
        startedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      }).run();
      db.insert(reviewState).values({
        changeId,
        latestAttemptId: `RA-${changeId}`,
        gateStatus: "passed",
        updatedAt: NOW,
      }).run();
    },
  },
];

/**
 * Two exported functions named `getReviewCenterState`, over one database.
 *
 * `review-center-service`'s is the authority -- it is what `review-center/route`
 * serves to the human. `review-center-state-service`'s is a fallback that
 * `gateDecision` consults only when a change has no QA `stage_gates` row.
 *
 * The table below is the whole point of this file. When it was first run, 9 of
 * these 15 scenarios disagreed and EVERY disagreement was the fallback being
 * more permissive: it answered `passed` for a change with no Review attempt at
 * all, for a NULL gate status, and -- worst -- for a stored verdict of
 * `blocked_p0`, because the old code listed the statuses it rejected and let
 * everything else fall out of the bottom as a pass.
 */
describe("two getReviewCenterState implementations, one db", { concurrency: false }, () => {
  it("agrees with the authority on canEnterQA in every scenario", () => {
    const rows: string[] = [];
    const disagreements: string[] = [];
    for (const [index, scenario] of SCENARIOS.entries()) {
      const changeId = `CHG-DIVERGE-${index}`;
      const db = createTestDb();
      seedChange(db, changeId);
      scenario.seed(db, changeId);

      const restoreState = setReviewCenterStateServiceDbForTest(db);
      const restoreCenter = setReviewCenterServiceDbForTest(db);
      try {
        const stateSvc = stateSvcGetReviewCenterState(changeId);
        const centerSvc = centerSvcGetReviewCenterState(changeId);
        const agree = stateSvc.canEnterQA === centerSvc.qaAllowed;
        if (!agree) disagreements.push(scenario.name);
        rows.push(
          [
            scenario.name.padEnd(34),
            `state-svc ${String(stateSvc.canEnterQA).padEnd(5)} (${stateSvc.gate})`.padEnd(34),
            `center-svc ${String(centerSvc.qaAllowed).padEnd(5)} (${centerSvc.headlineStatus})`.padEnd(36),
            agree ? "AGREE" : "DISAGREE",
          ].join("| "),
        );
      } finally {
        restoreCenter();
        restoreState();
      }
    }
    console.log("\n" + rows.join("\n") + "\n");
    assert.deepEqual(disagreements, []);
  });

  it("reaches canEnterQA true only from the full happy path", () => {
    // The complement of the table: pinning that SOMETHING still passes. A
    // derivation that answered `false` unconditionally would satisfy the
    // agreement test above while quietly bricking QA entry for every change.
    const passing = new Set(["valid report, qaAllowed, fresh build"]);
    for (const [index, scenario] of SCENARIOS.entries()) {
      const changeId = `CHG-PASSSET-${index}`;
      const db = createTestDb();
      seedChange(db, changeId);
      scenario.seed(db, changeId);
      const restore = setReviewCenterStateServiceDbForTest(db);
      try {
        assert.equal(
          stateSvcGetReviewCenterState(changeId).canEnterQA,
          passing.has(scenario.name),
          scenario.name,
        );
      } finally {
        restore();
      }
    }
  });
});

/**
 * The blast radius of the divergence, measured rather than assumed.
 *
 * The brief for this work assumed a permissive fallback could let a change into
 * QA. It could not: `gateDecision`'s `!gate` branch returns `enabled: false` on
 * BOTH sides of the `canEnterQA` test -- the review state only chooses which
 * refusal is reported. So the bug was never an authorization bypass; it was the
 * action contract telling a human "QA gate snapshot is missing" (with an empty
 * blocker list) about a change whose Review had never run.
 *
 * This is pinned because it is the reason the fix could be made conservative
 * without fear: tightening the fallback cannot disable anything that was
 * previously enabled, because nothing here was ever enabled.
 */
describe("gateDecision's QA fallback", { concurrency: false }, () => {
  function snapshotWithoutGate(changeId: string): StageAuthoritySnapshot {
    return {
      changeId,
      phase: "QA",
      state: null,
      latestAttempt: null,
      latestReport: null,
      latestValidReport: null,
      latestGate: null,
    };
  }

  it("stays disabled whether or not the review state permits QA", () => {
    const cases: Array<{ name: string; seed: (db: ReviewCenterStateDb, id: string) => void }> = [
      { name: "review permits QA", seed: (db, id) => seedFullPass(db, id, { buildFresh: true }) },
      { name: "review has not run", seed: () => {} },
    ];
    for (const [index, testCase] of cases.entries()) {
      const changeId = `CHG-GATEDEC-${index}`;
      const db = createTestDb();
      seedChange(db, changeId);
      testCase.seed(db, changeId);
      const restore = setReviewCenterStateServiceDbForTest(db);
      try {
        const decision = gateDecision("QA", snapshotWithoutGate(changeId));
        assert.equal(decision.enabled, false, testCase.name);
      } finally {
        restore();
      }
    }
  });

  it("names the review's own refusal instead of blaming the missing gate", () => {
    // The behaviour the divergence actually cost. Before the fix this change --
    // a `review_state` row with no attempt behind it -- read as `passed`, so
    // the QA branch was skipped entirely and the contract answered
    // `qa_gate_missing` with no blockers, hiding the real reason.
    const changeId = "CHG-GATEDEC-REASON";
    const db = createTestDb();
    seedChange(db, changeId);
    db.insert(reviewState).values({ changeId, gateStatus: "passed", updatedAt: NOW }).run();
    const restore = setReviewCenterStateServiceDbForTest(db);
    try {
      const decision = gateDecision("QA", snapshotWithoutGate(changeId));
      assert.equal(decision.reasonCode, "qa_blocked_by_review_not_started");
      assert.equal(decision.blockers.length > 0, true, "the refusal carries something actionable");
    } finally {
      restore();
    }
  });
});
