import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { eq } from "drizzle-orm";

import {
  buildRunRecords,
  findings,
  reviewAttempts,
  reviewPriorFindingReviews,
  reviewReports,
  reviewState,
} from "../db/schema";

type ReviewReportDb = typeof import("../db/index").db;
type ReviewAttempt = typeof reviewAttempts.$inferSelect;
type ReviewReport = typeof reviewReports.$inferSelect;
type ReviewState = typeof reviewState.$inferSelect;
type ReviewFinding = typeof findings.$inferSelect;
type BuildRunRecord = typeof buildRunRecords.$inferSelect;
type ReviewPriorFindingReview = typeof reviewPriorFindingReviews.$inferSelect;

export type ReviewConclusion =
  | "passed"
  | "issues_found"
  | "invalid_output"
  | "failed"
  | "legacy_incomplete"
  | "data_inconsistent";

export type ReviewReportGateStatus =
  | "passed"
  | "passed_with_waived_p1"
  | "blocked_p0"
  | "blocked_p1"
  | "stale"
  | "running"
  | "failed"
  | "invalid_output"
  | "data_inconsistent";

export interface RecomputeReviewReportResult {
  report: ReviewReport;
  state: ReviewState;
}

interface ReviewCounts {
  blockingP0: number;
  blockingP1: number;
  waivedP1: number;
  p2Count: number;
}

const requireDefaultDb = createRequire(import.meta.url);
let reviewReportDbForTest: ReviewReportDb | null = null;
let defaultReviewReportDb: ReviewReportDb | null = null;

export function setReviewReportServiceDbForTest(nextDb: ReviewReportDb): () => void {
  const previous = reviewReportDbForTest;
  reviewReportDbForTest = nextDb;
  return () => {
    reviewReportDbForTest = previous;
  };
}

function getReviewReportDb(): ReviewReportDb {
  if (reviewReportDbForTest) return reviewReportDbForTest;
  if (!defaultReviewReportDb) {
    defaultReviewReportDb = (requireDefaultDb("../db/index") as typeof import("../db/index")).db;
  }
  return defaultReviewReportDb;
}

function nowISO(): string {
  return new Date().toISOString();
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortForStableJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function hashCanonicalReviewValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function computeReviewFindingsDbHash(reviewFindings: ReviewFinding[]): string {
  return hashCanonicalReviewValue(
    reviewFindings
      .map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        status: finding.status,
        evidence: finding.evidence,
        requiredFix: finding.requiredFix,
        reviewAttemptId: finding.reviewAttemptId,
        sourceBuildRunId: finding.sourceBuildRunId,
        sourceHeadSha: finding.sourceHeadSha,
        waivable: finding.waivable,
        waivedBy: finding.waivedBy,
        waivedAt: finding.waivedAt,
        waiverDecisionId: finding.waiverDecisionId,
        findingVersion: finding.findingVersion,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

export function computeReviewReportDbHash(reportFacts: unknown, findingsDbHash: string): string {
  return hashCanonicalReviewValue({ ...(reportFacts as Record<string, unknown>), findingsDbHash });
}

function nextPrefixedId(ids: string[], prefix: string): string {
  const used = new Set(ids);
  let maxNum = 0;
  for (const id of ids) {
    const match = id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) maxNum = Math.max(maxNum, Number.parseInt(match[1], 10));
  }

  let nextNum = maxNum + 1;
  let candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;
  while (used.has(candidate)) {
    nextNum += 1;
    candidate = `${prefix}-${String(nextNum).padStart(3, "0")}`;
  }
  return candidate;
}

function nextReportId(db: ReviewReportDb): string {
  return nextPrefixedId(
    db.select({ id: reviewReports.id }).from(reviewReports).all().map((row) => row.id),
    "RRP",
  );
}

function nextReportVersion(db: ReviewReportDb, attemptId: string): number {
  return (
    db
      .select({ reportVersion: reviewReports.reportVersion })
      .from(reviewReports)
      .where(eq(reviewReports.attemptId, attemptId))
      .all()
      .reduce((max, row) => Math.max(max, row.reportVersion), 0) + 1
  );
}

function latestAttemptForChange(db: ReviewReportDb, changeId: string): ReviewAttempt | null {
  const attempts = db
    .select()
    .from(reviewAttempts)
    .where(eq(reviewAttempts.changeId, changeId))
    .all();
  attempts.sort((left, right) => {
    if (right.attemptNo !== left.attemptNo) return right.attemptNo - left.attemptNo;
    const started = right.startedAt.localeCompare(left.startedAt);
    if (started !== 0) return started;
    return right.id.localeCompare(left.id);
  });
  return attempts[0] ?? null;
}

function latestApprovedBuildRun(db: ReviewReportDb, changeId: string): BuildRunRecord | null {
  const records = db
    .select()
    .from(buildRunRecords)
    .where(eq(buildRunRecords.changeId, changeId))
    .all()
    .filter((record) => record.status === "approved_for_absorb" || record.status === "adopted");
  records.sort((left, right) => {
    const adopted = (right.adoptedAt ?? right.updatedAt ?? "").localeCompare(left.adoptedAt ?? left.updatedAt ?? "");
    if (adopted !== 0) return adopted;
    const updated = right.updatedAt.localeCompare(left.updatedAt);
    if (updated !== 0) return updated;
    return right.id.localeCompare(left.id);
  });
  return records[0] ?? null;
}

function buildIdentity(record: BuildRunRecord | null): string | null {
  if (!record) return null;
  return record.buildRunId ?? record.id;
}

function buildSourceHead(record: BuildRunRecord | null): string | null {
  if (!record) return null;
  if (record.status === "approved_for_absorb") return record.baseCommit ?? record.baseHeadSha ?? null;
  return record.headSha ?? record.adoptedHeadSha ?? record.baseCommit ?? null;
}

function maxVersion(rows: Array<{ findingVersion: number }>): number {
  return rows.reduce((max, row) => Math.max(max, row.findingVersion), 1);
}

function currentWaiverVersion(rows: ReviewFinding[]): number {
  const waiverRows = rows.filter(
    (finding) =>
      finding.status === "waived" ||
      Boolean(finding.waivedAt) ||
      Boolean(finding.waiverDecisionId),
  );
  return waiverRows.length > 0 ? maxVersion(waiverRows) : 1;
}

function isLegacyIncompleteFinding(finding: ReviewFinding): boolean {
  if (finding.source !== "review") return false;
  const missingEvidence = !finding.evidence || finding.evidence.trim().length === 0;
  const missingRequiredFix = !finding.requiredFix || finding.requiredFix.trim().length === 0;
  if (finding.severity === "P0" || finding.severity === "P1") {
    return missingEvidence || missingRequiredFix;
  }
  if (finding.severity === "P2") return missingEvidence;
  return true;
}

function isLegacyIncompleteAttempt(attempt: ReviewAttempt): boolean {
  return attempt.errorCode === "legacy_incomplete";
}

function isOpenP0P1(finding: ReviewFinding): boolean {
  return finding.status === "open" && (finding.severity === "P0" || finding.severity === "P1");
}

function parsePriorBlockingFindingIds(attempt: ReviewAttempt): Set<string> {
  if (!attempt.priorBlockingFindingIdsJson) return new Set();
  try {
    const parsed = JSON.parse(attempt.priorBlockingFindingIdsJson) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function priorFindingReviewsForAttempt(
  db: ReviewReportDb,
  attemptId: string,
): ReviewPriorFindingReview[] {
  return db
    .select()
    .from(reviewPriorFindingReviews)
    .where(eq(reviewPriorFindingReviews.attemptId, attemptId))
    .all()
    .sort((left, right) => {
      const prior = left.priorFindingId.localeCompare(right.priorFindingId);
      if (prior !== 0) return prior;
      return left.id.localeCompare(right.id);
    });
}

export function settlementFindingsForReviewAttempt(
  attempt: ReviewAttempt,
  reviewFindings: ReviewFinding[],
): ReviewFinding[] {
  const priorBlockingFindingIds = parsePriorBlockingFindingIds(attempt);
  const byId = new Map<string, ReviewFinding>();

  for (const finding of reviewFindings) {
    if (finding.reviewAttemptId === attempt.id) {
      byId.set(finding.id, finding);
    }
  }

  for (const finding of reviewFindings) {
    if (!isOpenP0P1(finding)) continue;
    if (finding.reviewAttemptId === attempt.id) {
      byId.set(finding.id, finding);
      continue;
    }
    if (priorBlockingFindingIds.has(finding.id)) {
      byId.set(finding.id, finding);
    }
  }

  return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function countFindings(rows: ReviewFinding[]): ReviewCounts {
  return {
    blockingP0: rows.filter((finding) => finding.severity === "P0" && finding.status === "open")
      .length,
    blockingP1: rows.filter((finding) => finding.severity === "P1" && finding.status === "open")
      .length,
    waivedP1: rows.filter((finding) => finding.severity === "P1" && finding.status === "waived")
      .length,
    p2Count: rows.filter((finding) => finding.severity === "P2").length,
  };
}

function findDbInconsistencies(
  db: ReviewReportDb,
  changeId: string,
  state: ReviewState | null,
  reviewFindings: ReviewFinding[],
): string[] {
  const reasons: string[] = [];
  if (state?.latestValidReviewReportId) {
    const report = db
      .select({ id: reviewReports.id })
      .from(reviewReports)
      .where(eq(reviewReports.id, state.latestValidReviewReportId))
      .get();
    if (!report) reasons.push("latest_valid_review_report_missing");
  }

  const attemptsById = new Map(
    db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.changeId, changeId))
      .all()
      .map((attempt) => [attempt.id, attempt]),
  );
  for (const finding of reviewFindings) {
    if (finding.reviewAttemptId) {
      const attempt = attemptsById.get(finding.reviewAttemptId);
      if (!attempt) reasons.push(`finding_attempt_missing:${finding.id}`);
      if (attempt && attempt.changeId !== finding.changeId) {
        reasons.push(`finding_attempt_change_mismatch:${finding.id}`);
      }
    }
    if (!["P0", "P1", "P2"].includes(finding.severity)) {
      reasons.push(`finding_severity_invalid:${finding.id}`);
    }
    if (finding.severity === "P0" && finding.waivable) {
      reasons.push(`p0_marked_waivable:${finding.id}`);
    }
    if (finding.waivable && finding.severity !== "P1") {
      reasons.push(`non_p1_marked_waivable:${finding.id}`);
    }
    if (finding.status === "waived" && finding.severity !== "P1") {
      reasons.push(`non_p1_waived:${finding.id}`);
    }
    if (finding.status === "waived" && (!finding.waivedBy || !finding.waivedAt)) {
      reasons.push(`waiver_metadata_missing:${finding.id}`);
    }
  }

  return Array.from(new Set(reasons)).sort();
}

function validReportConclusion(report: ReviewReport): boolean {
  return report.reviewConclusion === "passed" || report.reviewConclusion === "issues_found";
}

function reportById(db: ReviewReportDb, reportId: string | null): ReviewReport | null {
  if (!reportId) return null;
  return db.select().from(reviewReports).where(eq(reviewReports.id, reportId)).get() ?? null;
}

function stateValuesFromReport(report: ReviewReport | null): Partial<typeof reviewState.$inferInsert> {
  if (!report) return {};
  return {
    gateStatus: report.gateStatus,
    reviewStatus: report.reviewConclusion,
    sourceBuildRunId: report.sourceBuildRunId,
    sourceHeadSha: report.sourceHeadSha,
    reportDbHash: report.reportDbHash,
    findingVersion: report.findingVersion,
    waiverVersion: report.waiverVersion,
  };
}

function upsertReviewState(
  db: ReviewReportDb,
  changeId: string,
  values: typeof reviewState.$inferInsert,
): ReviewState {
  const existing = db.select().from(reviewState).where(eq(reviewState.changeId, changeId)).get();
  if (existing) {
    db.update(reviewState).set(values).where(eq(reviewState.changeId, changeId)).run();
  } else {
    db.insert(reviewState).values(values).run();
  }
  const updated = db.select().from(reviewState).where(eq(reviewState.changeId, changeId)).get();
  if (!updated) throw new Error(`Failed to update review_state for change ${changeId}`);
  return updated;
}

export function recomputeReviewReport(
  changeId: string,
  attemptId: string,
): RecomputeReviewReportResult {
  const db = getReviewReportDb();
  const attempt = db.select().from(reviewAttempts).where(eq(reviewAttempts.id, attemptId)).get();
  if (!attempt || attempt.changeId !== changeId) {
    throw new Error(`Review attempt not found for change ${changeId}: ${attemptId}`);
  }

  const previousState = db.select().from(reviewState).where(eq(reviewState.changeId, changeId)).get() ?? null;
  const reviewFindings = db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all()
    .filter((finding) => finding.source === "review");
  const settlementFindings = settlementFindingsForReviewAttempt(attempt, reviewFindings);
  const priorFindingReviews = priorFindingReviewsForAttempt(db, attempt.id);
  const counts = countFindings(settlementFindings);
  const findingVersion = maxVersion(settlementFindings);
  const waiverVersion = currentWaiverVersion(settlementFindings);
  const latestBuild = latestApprovedBuildRun(db, changeId);
  const latestBuildId = buildIdentity(latestBuild);
  const staleReasons: string[] = [];
  const dataInconsistencyReasons = findDbInconsistencies(
    db,
    changeId,
    previousState,
    reviewFindings,
  );

  if (latestBuildId && attempt.sourceBuildRunId !== latestBuildId) {
    staleReasons.push("source_build_changed");
  }
  const latestBuildHead = buildSourceHead(latestBuild);
  if (latestBuildHead && attempt.sourceHeadSha && attempt.sourceHeadSha !== latestBuildHead) {
    staleReasons.push("head_drift");
  }
  if ((previousState?.findingVersion ?? 1) > findingVersion) {
    staleReasons.push("finding_version_drift");
  }
  if ((previousState?.waiverVersion ?? 1) > waiverVersion) {
    staleReasons.push("waiver_version_drift");
  }

  const hasLegacyIncomplete =
    isLegacyIncompleteAttempt(attempt) || settlementFindings.some(isLegacyIncompleteFinding);
  if (hasLegacyIncomplete) staleReasons.push("legacy_incomplete");

  let reviewConclusion: ReviewConclusion | null;
  let gateStatus: ReviewReportGateStatus;
  if (dataInconsistencyReasons.length > 0 || attempt.reviewStatus === "data_inconsistent") {
    reviewConclusion = "data_inconsistent";
    gateStatus = "data_inconsistent";
  } else if (attempt.status === "running" || attempt.reviewStatus === "running") {
    reviewConclusion = null;
    gateStatus = "running";
  } else if (attempt.reviewStatus === "failed") {
    reviewConclusion = "failed";
    gateStatus = "failed";
  } else if (attempt.reviewStatus === "invalid_output") {
    reviewConclusion = "invalid_output";
    gateStatus = "invalid_output";
  } else if (hasLegacyIncomplete) {
    reviewConclusion = "legacy_incomplete";
    gateStatus = "stale";
  } else {
    const hasAnyFinding =
      counts.blockingP0 + counts.blockingP1 + counts.waivedP1 + counts.p2Count > 0;
    reviewConclusion = hasAnyFinding ? "issues_found" : "passed";
    if (staleReasons.length > 0) {
      gateStatus = "stale";
    } else if (counts.blockingP0 > 0) {
      gateStatus = "blocked_p0";
    } else if (counts.blockingP1 > 0) {
      gateStatus = "blocked_p1";
    } else if (counts.waivedP1 > 0) {
      gateStatus = "passed_with_waived_p1";
    } else {
      gateStatus = "passed";
    }
  }

  const qaAllowed = gateStatus === "passed" || gateStatus === "passed_with_waived_p1";
  const reportFacts = {
    attempt: {
      id: attempt.id,
      attemptNo: attempt.attemptNo,
      status: attempt.status,
      reviewStatus: attempt.reviewStatus,
      sourceBuildRunId: attempt.sourceBuildRunId,
      sourceHeadSha: attempt.sourceHeadSha,
    },
    counts,
    dataInconsistencyReasons,
    findingVersion,
    gateStatus,
    latestBuild: latestBuild
      ? {
          id: latestBuild.id,
          buildRunId: latestBuild.buildRunId,
          status: latestBuild.status,
          headSha: latestBuildHead,
          baseCommit: latestBuild.baseCommit,
          adoptedAt: latestBuild.adoptedAt,
        }
      : null,
    priorFindingReviews: priorFindingReviews.map((review) => ({
      id: review.id,
      priorFindingId: review.priorFindingId,
      verdict: review.verdict,
      evidence: review.evidence,
      requiredFix: review.requiredFix,
      replacementFindingId: review.replacementFindingId,
      reviewerNotes: review.reviewerNotes,
    })),
    qaAllowed,
    reviewConclusion,
    staleReasons,
    waiverVersion,
  };
  const findingsDbHash = computeReviewFindingsDbHash(settlementFindings);
  const reportDbHash = computeReviewReportDbHash(reportFacts, findingsDbHash);
  const existingReport = db
    .select()
    .from(reviewReports)
    .where(eq(reviewReports.attemptId, attemptId))
    .all()
    .find((report) => report.reportDbHash === reportDbHash);

  const generatedAt = nowISO();
  let report: ReviewReport;
  if (existingReport) {
    report = existingReport;
  } else {
    const values: typeof reviewReports.$inferInsert = {
      id: nextReportId(db),
      attemptId,
      changeId,
      reportVersion: nextReportVersion(db, attemptId),
      reviewConclusion,
      reportDbHash,
      gateStatus,
      qaAllowed: qaAllowed ? 1 : 0,
      sourceBuildRunId: attempt.sourceBuildRunId,
      sourceHeadSha: attempt.sourceHeadSha,
      findingVersion,
      waiverVersion,
      blockingP0: counts.blockingP0,
      blockingP1: counts.blockingP1,
      waivedP1: counts.waivedP1,
      p2Count: counts.p2Count,
      findingsDbHash,
      staleReason:
        staleReasons.length > 0 || dataInconsistencyReasons.length > 0
          ? JSON.stringify([...staleReasons, ...dataInconsistencyReasons])
          : null,
      legacyState: hasLegacyIncomplete ? "legacy_incomplete" : null,
      reportJson: stableJson(reportFacts),
      generatedAt,
      createdAt: generatedAt,
    };
    db.insert(reviewReports).values(values).run();
    const inserted = db.select().from(reviewReports).where(eq(reviewReports.id, values.id)).get();
    if (!inserted) throw new Error(`Failed to create review report for attempt ${attemptId}`);
    report = inserted;
  }

  const latestAttempt = latestAttemptForChange(db, changeId);
  if (!latestAttempt) throw new Error(`Review attempt list empty for change ${changeId}`);
  const previousValidAttemptNo = previousState?.latestValidAttemptNo ?? null;
  const canBecomeLatestValid =
    validReportConclusion(report) &&
    (previousValidAttemptNo === null || attempt.attemptNo >= previousValidAttemptNo);
  const latestValidReportId = canBecomeLatestValid
    ? report.id
    : previousState?.latestValidReviewReportId ?? null;
  const latestValidAttemptNo = canBecomeLatestValid
    ? attempt.attemptNo
    : previousState?.latestValidAttemptNo ?? null;
  const latestReportId =
    latestAttempt.id === attempt.id ? report.id : previousState?.latestReportId ?? null;
  const headlineReport =
    reportById(db, latestValidReportId) ??
    (latestAttempt.id === attempt.id ? report : reportById(db, latestReportId));
  const nextStateValues: typeof reviewState.$inferInsert = {
    changeId,
    latestAttemptId: latestAttempt.id,
    latestAttemptNo: latestAttempt.attemptNo,
    latestReportId,
    latestValidReviewReportId: latestValidReportId,
    latestValidAttemptNo,
    ...stateValuesFromReport(headlineReport),
    updatedAt: nowISO(),
  };
  const state = upsertReviewState(db, changeId, nextStateValues);

  return { report, state };
}
