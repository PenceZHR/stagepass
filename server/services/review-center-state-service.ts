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
import { buildRunRecords, findings, reviewAttempts, reviewReports, reviewState } from "../db/schema";
import { latestApprovedBuildRecord } from "./build-record-identity";
import type { ReviewReportGateStatus } from "./review-report-service";

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
 * The gate statuses that permit QA, as decided by the phase that writes them.
 *
 * `review_state.gateStatus` is a verbatim mirror of `review_reports.gateStatus`
 * (`review-report-service.stateValuesFromReport`), and that service settles the
 * question in one line next to where it picks the status:
 *
 *     const qaAllowed = gateStatus === "passed" || gateStatus === "passed_with_waived_p1";
 *
 * so this predicate is that rule read back off the same column, not a second
 * opinion about it. `ReviewReportGateStatus` is imported as a type purely so
 * that widening that union without revisiting this line is a compile error.
 *
 * NOT reusable from `PASSING_GATE_STATUSES` in action-contract-common-policy:
 * that set describes `stage_gates.status`, a different column whose vocabulary
 * (`pass`, `passed_with_warnings`) `review_state` never contains. Sharing them
 * would couple two enums that are free to drift.
 */
function gateStatusAllowsQA(status: string | null): boolean {
  const allowed: ReviewReportGateStatus[] = ["passed", "passed_with_waived_p1"];
  return status !== null && (allowed as string[]).includes(status);
}

/**
 * Get Review center state for a change.
 *
 * ## What this is, and what it is NOT
 *
 * There are two functions with this name. The authority is
 * `review-center-service.getReviewCenterState`: it is what `review-center/route`
 * serves to the human, and it answers `qaAllowed` from `review_reports.qaAllowed`
 * -- the verdict `review-report-service` computed from findings, waivers, and
 * Build lineage together.
 *
 * This one is a FALLBACK with a single caller: `gateDecision` consults it only
 * when phase is QA and the change has no `stage_gates` row at all. It cannot
 * call the authority -- that function throws on a missing change or project and
 * re-reads mirrors, waivers and artifacts on a path that runs for every action
 * on every phase -- so it derives the same answer from the columns the authority
 * keys on, and is deliberately narrower everywhere it cannot.
 *
 * ## Why it used to say `passed` when the authority said `not_started`
 *
 * The final return was reached by falling THROUGH: only `stale` and `failed`
 * were checked, so every other value of `gateStatus` -- including `blocked_p0`,
 * `invalid_output`, and SQL NULL -- arrived at `canEnterQA: true`. It never
 * asked whether a Review had run at all, so a bare `review_state` row with no
 * attempt behind it read as a pass; and it never looked at the report or the
 * Build, so a pass produced from a superseded Build stayed a pass.
 *
 * Driving both functions off one injected database
 * (review-center-state-divergence.test.ts), 10 of 15 scenarios disagreed with
 * the authority, and every single disagreement was in the permissive direction.
 *
 * Every hole is the same mistake -- absence of evidence read as evidence of a
 * pass -- so all are closed the same way: `passed` is now reachable only from a
 * resolved attempt, a valid report the authority itself marked `qaAllowed`, a
 * status that explicitly permits QA, and a Build the report was actually
 * produced from. Every other status maps to the gate that names it rather than
 * falling out of the bottom.
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
    // A waived P1 is `status === "waived"`, so it never reaches openP1Count in
    // the first place -- "all P1s waived" already passes this branch by
    // construction. (A prior `TODO: check if all P1s are waived` here implied a
    // hole that the finding status makes impossible.) Whether each waiver
    // carries a reason is settled upstream by review-report-service, which
    // stales the report on `waiver_metadata_missing` / `non_p1_waived` rather
    // than letting an unjustified waiver reach this column.
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

  const carried = {
    openP0Count,
    openP1Count,
    latestAttemptId: review.latestAttemptId,
    latestReportId: review.latestReportId,
  };

  // A `review_state` row is written before an attempt finishes, so its presence
  // is not evidence that a Review ran -- only a resolved attempt row is. The
  // authority keys on exactly this (`dbGateFor`: no latestAttempt -> "No Review
  // run has started"), and it is the one precondition this fallback can check
  // from the same columns.
  if (!latestAttempt) {
    return {
      gate: "not_started",
      reason: "Review has not been run yet",
      canEnterQA: false,
      ...carried,
    };
  }

  // The verdict the authority itself serves. `review-center-service` answers
  // `qaAllowed` as `latestValidReport.qaAllowed === 1` and nothing else, so
  // reading that same row here is deriving from the authority rather than
  // re-deciding alongside it. `latest_valid_review_report_id` is the pointer
  // review-report-service moves only for a report that passed validation, which
  // is why it, and not `latest_report_id`, is the one worth trusting.
  const validReport = review.latestValidReviewReportId
    ? db
        .select()
        .from(reviewReports)
        .where(eq(reviewReports.id, review.latestValidReviewReportId))
        .get()
    : null;

  // The single permission test, asked positively. The old code asked it
  // negatively -- reject `stale`, reject `failed`, otherwise pass -- and every
  // status nobody thought to list, `blocked_p0` and SQL NULL among them, fell
  // out of the bottom as a pass.
  if (
    validReport
    && validReport.changeId === changeId
    && validReport.qaAllowed === 1
    && gateStatusAllowsQA(review.gateStatus)
  ) {
    const staleBuild = buildFreshnessRefusal(db, changeId, validReport.sourceBuildRunId);
    if (staleBuild) {
      return { ...staleBuild, canEnterQA: false, ...carried };
    }
    return {
      gate: "passed",
      reason: "Review passed, ready for Check/QA",
      canEnterQA: true,
      ...carried,
    };
  }

  if (!validReport && gateStatusAllowsQA(review.gateStatus)) {
    // The status column says pass but the pointer to the report that would
    // justify it is empty. The authority calls this exact shape stale ("Review
    // DB state does not point to a valid report") rather than believing the
    // status on its own.
    return {
      gate: "stale",
      reason: "Review DB state does not point to a valid report",
      canEnterQA: false,
      ...carried,
    };
  }

  return { ...refusedGateFor(review.gateStatus), canEnterQA: false, ...carried };
}

/**
 * The `stale` this module's header always promised ("Build run / HEAD / waiver
 * makes report stale") and never actually checked.
 *
 * A report can be `qaAllowed` and still describe a Build that has since been
 * superseded; the authority refuses exactly that (`dbGateFor`: "Review was
 * produced from an older approved Build run"), and until now this fallback
 * happily passed it. `latestApprovedBuildRecord` is imported rather than
 * reimplemented on purpose -- build-record-identity exists precisely because
 * "which build run is the current approved one" was being spelled a dozen
 * different ways, and a divergence between two spellings is a false equality,
 * not a style problem.
 */
function buildFreshnessRefusal(
  db: ReviewCenterStateDb,
  changeId: string,
  reportSourceBuildRunId: string | null,
): { gate: ReviewCenterGate; reason: string } | null {
  const record = latestApprovedBuildRecord(
    db.select().from(buildRunRecords).where(eq(buildRunRecords.changeId, changeId)).all(),
  );
  const latestBuildRunId = record ? record.buildRunId ?? record.id : null;
  if (!latestBuildRunId) {
    return { gate: "stale", reason: "Review requires an approved Build run before QA" };
  }
  if (!reportSourceBuildRunId) {
    return { gate: "stale", reason: "Review is missing its source Build run" };
  }
  if (reportSourceBuildRunId !== latestBuildRunId) {
    return { gate: "stale", reason: "Review was produced from an older approved Build run" };
  }
  return null;
}

/**
 * Which refusal to show once `gateStatusAllowsQA` has already said no.
 *
 * Naming every status matters less than the default does: an unrecognised value
 * is by definition one this derivation has never reasoned about, so the only
 * safe thing it can mean is "no verdict I can stand on".
 */
function refusedGateFor(status: string | null): { gate: ReviewCenterGate; reason: string } {
  switch (status) {
    case "stale":
      return { gate: "stale", reason: "Review report is stale and must be re-run" };
    case "failed":
    case "invalid_output":
    case "data_inconsistent":
      // The three states this module's header already groups under `failed`:
      // "Provider failure, invalid output, or inconsistent data".
      return { gate: "failed", reason: "Review failed due to provider error or invalid output" };
    case "blocked_p0":
    case "blocked_p1":
      // The stored verdict says blocking even though no open finding row backs
      // it up. The two encodings of the same fact disagree, and the permissive
      // reading is the one that must not win.
      return {
        gate: status,
        reason: `Review gate is ${status} with no open finding to explain it`,
      };
    case "running":
      return { gate: "running", reason: "Review is currently running" };
    default:
      // NULL, or a status written by a version this code has not met. The
      // authority answers "Review DB state does not point to a valid report"
      // and calls that stale; so does this.
      return {
        gate: "stale",
        reason: "Review has not recorded a gate verdict this gate can stand on",
      };
  }
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
