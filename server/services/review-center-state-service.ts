/**
 * Review Center State Service
 *
 * Implements ReviewCenterState derivation as per state-machine.md section 3.1
 *
 * ReviewCenterGate states:
 * - not_started: Build absorbed but no valid Review run
 * - running: Review run in progress
 * - failed: Provider failure, invalid output, or inconsistent data
 * - blocked_p0: Open P0 Review findings exist
 * - blocked_p1: Open P1 Review findings exist (not all waived)
 * - stale: Build run / HEAD / waiver makes report stale
 * - passed: Fresh, latest Build, no open P0/P1 or P1 with reason waiver
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { findings, reviewAttempts, reviewState } from "../db/schema";

/** The default (singleton) connection, or an injected test connection. */
export type ReviewCenterStateDb = typeof db;

let reviewCenterStateDbForTest: ReviewCenterStateDb | null = null;

export function setReviewCenterStateServiceDbForTest(nextDb: ReviewCenterStateDb): () => void {
  const previous = reviewCenterStateDbForTest;
  reviewCenterStateDbForTest = nextDb;
  return () => {
    reviewCenterStateDbForTest = previous;
  };
}

function getReviewCenterStateDb(): ReviewCenterStateDb {
  return reviewCenterStateDbForTest ?? db;
}

export type ReviewCenterGate =
  | "not_started"
  | "running"
  | "failed"
  | "blocked_p0"
  | "blocked_p1"
  | "stale"
  | "passed";

export interface ReviewCenterState {
  gate: ReviewCenterGate;
  reason: string;
  canEnterQA: boolean;
  openP0Count: number;
  openP1Count: number;
  latestAttemptId: string | null;
  latestReportId: string | null;
}

/**
 * Get Review center state for a change
 * This is the authoritative source for determining if Check/QA can run
 */
export function getReviewCenterState(changeId: string): ReviewCenterState {
  const db = getReviewCenterStateDb();
  // Check if Review state exists
  const review = db.select().from(reviewState).where(eq(reviewState.changeId, changeId)).get();

  if (!review) {
    return {
      gate: "not_started",
      reason: "Review has not been run yet",
      canEnterQA: false,
      openP0Count: 0,
      openP1Count: 0,
      latestAttemptId: null,
      latestReportId: null,
    };
  }

  // Count open Review findings
  const openFindings = db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all()
    .filter(f => f.source === "review" && f.status === "open");

  const openP0Count = openFindings.filter(f => f.severity === "P0").length;
  const openP1Count = openFindings.filter(f => f.severity === "P1").length;

  // Check if Review attempt is running
  const latestAttempt = review.latestAttemptId
    ? db.select().from(reviewAttempts).where(eq(reviewAttempts.id, review.latestAttemptId)).get()
    : null;

  if (latestAttempt && latestAttempt.status === "running") {
    return {
      gate: "running",
      reason: "Review is currently running",
      canEnterQA: false,
      openP0Count,
      openP1Count,
      latestAttemptId: review.latestAttemptId,
      latestReportId: review.latestReportId,
    };
  }

  // Check for P0 blockers (highest priority)
  if (openP0Count > 0) {
    return {
      gate: "blocked_p0",
      reason: `Review has ${openP0Count} open P0 finding${openP0Count > 1 ? "s" : ""}`,
      canEnterQA: false,
      openP0Count,
      openP1Count,
      latestAttemptId: review.latestAttemptId,
      latestReportId: review.latestReportId,
    };
  }

  // Check for P1 blockers
  if (openP1Count > 0) {
    // TODO: Check if all P1s are waived with reasons
    // For now, any open P1 blocks QA
    return {
      gate: "blocked_p1",
      reason: `Review has ${openP1Count} open P1 finding${openP1Count > 1 ? "s" : ""} that must be fixed or waived`,
      canEnterQA: false,
      openP0Count,
      openP1Count,
      latestAttemptId: review.latestAttemptId,
      latestReportId: review.latestReportId,
    };
  }

  // Check gate status from review_state
  if (review.gateStatus === "stale") {
    return {
      gate: "stale",
      reason: "Review report is stale and must be re-run",
      canEnterQA: false,
      openP0Count,
      openP1Count,
      latestAttemptId: review.latestAttemptId,
      latestReportId: review.latestReportId,
    };
  }

  if (review.gateStatus === "failed") {
    return {
      gate: "failed",
      reason: "Review failed due to provider error or invalid output",
      canEnterQA: false,
      openP0Count,
      openP1Count,
      latestAttemptId: review.latestAttemptId,
      latestReportId: review.latestReportId,
    };
  }

  // All checks passed
  return {
    gate: "passed",
    reason: "Review passed, ready for Check/QA",
    canEnterQA: true,
    openP0Count,
    openP1Count,
    latestAttemptId: review.latestAttemptId,
    latestReportId: review.latestReportId,
  };
}

/**
 * Check if a change can enter QA based on Review center state
 * This implements Invariant #7 from state-machine.md
 */
export function canEnterQA(changeId: string): boolean {
  const state = getReviewCenterState(changeId);
  return state.canEnterQA;
}

/**
 * Get blockers that prevent entering QA
 */
export function getQABlockers(
  changeId: string,
): Array<{ id: string; severity: "P0" | "P1" | "P2"; title: string }> {
  const db = getReviewCenterStateDb();
  const state = getReviewCenterState(changeId);

  if (state.canEnterQA) {
    return [];
  }

  // If blocked by Review findings, return those findings
  if (state.gate === "blocked_p0" || state.gate === "blocked_p1") {
    return db
      .select()
      .from(findings)
      .where(eq(findings.changeId, changeId))
      .all()
      .filter(f =>
        f.source === "review" &&
        f.status === "open" &&
        (f.severity === "P0" || f.severity === "P1")
      )
      // Severity is narrowed to P0/P1 by the filter above.
      .map(f => ({
        id: f.id,
        severity: f.severity as "P0" | "P1",
        title: f.title,
      }));
  }

  // Otherwise return a synthetic blocker describing the gate state
  return [{
    id: `review_${state.gate}`,
    severity: "P1",
    title: state.reason,
  }];
}
