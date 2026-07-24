import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { runMigrations } from "../db/migrate";
import * as dbSchema from "../db/schema";
import { reviewAttempts, reviewState } from "../db/schema";
import {
  getReviewCenterState,
  setReviewCenterStateServiceDbForTest,
  type ReviewCenterStateDb,
} from "./review-center-state-service";

describe("review-center-state-service injectable connection", { concurrency: false }, () => {
  const SEAM_CHANGE_ID = "CHG-REVIEW-CENTER-STATE-SEAM";
  const SEAM_ATTEMPT_ID = "RA-REVIEW-CENTER-STATE-SEAM";

  function createTestDb(): ReviewCenterStateDb {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = OFF");
    runMigrations(sqlite);
    return drizzle(sqlite, { schema: dbSchema }) as unknown as ReviewCenterStateDb;
  }

  it("derives Review center state from the injected db, not the global singleton", () => {
    const seamDb = createTestDb();
    // The attempt row is what makes this fixture DISCRIMINATING, and it is the
    // whole point of seeding it. A bare `review_state` row used to be enough --
    // `gateStatus: "failed"` alone produced gate `failed` -- but a stored
    // verdict with no Review run behind it now reads as `not_started`, which is
    // also what the empty singleton returns. Both halves of the assertion would
    // then be "not_started" and the test would pass whether or not the seam was
    // ever consulted. Seeding the attempt keeps the injected answer distinct.
    seamDb
      .insert(reviewAttempts)
      .values({
        id: SEAM_ATTEMPT_ID,
        changeId: SEAM_CHANGE_ID,
        attemptNo: 1,
        status: "completed",
        reviewStatus: "failed",
        idempotencyKey: `IK-${SEAM_CHANGE_ID}`,
        startedAt: "2026-07-15T00:00:00.000Z",
        endedAt: "2026-07-15T00:00:00.000Z",
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:00.000Z",
      })
      .run();
    seamDb
      .insert(reviewState)
      .values({
        changeId: SEAM_CHANGE_ID,
        latestAttemptId: SEAM_ATTEMPT_ID,
        gateStatus: "failed",
        updatedAt: "2026-07-15T00:00:00.000Z",
      })
      .run();

    const restore = setReviewCenterStateServiceDbForTest(seamDb);
    try {
      // The injected db has a review_state row for this change, so the gate
      // reflects its stored status. Reading the module-global singleton --
      // which has no such change -- would instead yield "not_started".
      const state = getReviewCenterState(SEAM_CHANGE_ID);
      assert.equal(state.gate, "failed");
      assert.equal(state.canEnterQA, false);
    } finally {
      restore();
    }

    // With the seam reverted, the same call reads the global singleton, where
    // SEAM_CHANGE_ID has no review_state row: the derivation returns the
    // not_started gate. This proves the read routed through the seam above.
    assert.equal(getReviewCenterState(SEAM_CHANGE_ID).gate, "not_started");
  });
});
