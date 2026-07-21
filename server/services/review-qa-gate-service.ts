import { execSync } from "node:child_process";
import { createRequire } from "node:module";

import { and, eq } from "drizzle-orm";

import {
  buildRunRecords,
  changes,
  findings,
  humanDecisions,
  projects,
  reviewAttempts,
  reviewReports,
  reviewState,
} from "../db/schema";
import {
  InvalidPriorBlockingSnapshotError,
  settlementFindingsForReviewAttempt,
} from "./review-report-service";

const GIT_COMMAND_TIMEOUT_MS = 30_000;

type ReviewQaGateDb = typeof import("../db/index").db;
type ReviewAttempt = typeof reviewAttempts.$inferSelect;
type ReviewReport = typeof reviewReports.$inferSelect;
type ReviewFinding = typeof findings.$inferSelect;
type BuildRunRecord = typeof buildRunRecords.$inferSelect;
type HumanDecision = typeof humanDecisions.$inferSelect;

export type ReviewQaGateEntrypoint =
  | "api_check_route"
  | "run_check"
  | "graph_runner"
  | "merge_gate";

export type ReviewQaGateActor = "system" | "human";

export interface AssertCanEnterQaInput {
  projectId: string;
  changeId: string;
  entrypoint: ReviewQaGateEntrypoint;
  actor: ReviewQaGateActor;
  expectedHeadSha?: string;
}

export interface ReviewQaGateCounts {
  blockingP0: number;
  blockingP1: number;
  waivedP1: number;
  p2Count: number;
}

export interface ReviewQaGateWaivedP1 {
  count: number;
  reasons: Array<{ findingId: string; reason: string | null }>;
}

export interface ReviewQaGateResult {
  allowed: boolean;
  status: string;
  reason: string | null;
  sourceBuildRunId: string | null;
  latestBuildRunId: string | null;
  counts: ReviewQaGateCounts;
  waivedP1: ReviewQaGateWaivedP1;
  warnings: string[];
  entrypoint: ReviewQaGateEntrypoint;
  actor: ReviewQaGateActor;
  reportId: string | null;
  latestAttemptId: string | null;
  sourceHeadSha: string | null;
}

export type ReviewQaGateErrorCode =
  | "change_not_found"
  | "no_latest_valid_review"
  | "latest_attempt_running"
  | "source_build_stale"
  | "head_drift"
  | "legacy_incomplete"
  | "review_blockers"
  | "review_not_allowed"
  | "data_inconsistent";

export class ReviewQaGateError extends Error {
  constructor(
    public readonly code: ReviewQaGateErrorCode,
    public readonly status: number,
    public readonly details: ReviewQaGateResult,
  ) {
    super(details.reason ?? code);
    this.name = "ReviewQaGateError";
  }
}

const requireDefaultDb = createRequire(import.meta.url);
let reviewQaGateDbForTest: ReviewQaGateDb | null = null;
let defaultReviewQaGateDb: ReviewQaGateDb | null = null;
let headProbeForTest: ((repoPath: string) => string | null) | null = null;

export function setReviewQaGateDbForTest(nextDb: ReviewQaGateDb): () => void {
  const previous = reviewQaGateDbForTest;
  reviewQaGateDbForTest = nextDb;
  return () => {
    reviewQaGateDbForTest = previous;
  };
}

export function setReviewQaGateHeadProbeForTest(
  nextProbe: (repoPath: string) => string | null,
): () => void {
  const previous = headProbeForTest;
  headProbeForTest = nextProbe;
  return () => {
    headProbeForTest = previous;
  };
}

function getReviewQaGateDb(): ReviewQaGateDb {
  if (reviewQaGateDbForTest) return reviewQaGateDbForTest;
  if (!defaultReviewQaGateDb) {
    defaultReviewQaGateDb = (requireDefaultDb("../db/index") as typeof import("../db/index")).db;
  }
  return defaultReviewQaGateDb;
}

function probeGitHead(repoPath: string): string | null {
  if (headProbeForTest) return headProbeForTest(repoPath);
  try {
    return execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: GIT_COMMAND_TIMEOUT_MS,
    }).trim();
  } catch {
    return null;
  }
}

function latestApprovedBuild(db: ReviewQaGateDb, changeId: string): BuildRunRecord | null {
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

function latestAttemptByNumber(db: ReviewQaGateDb, changeId: string): ReviewAttempt | null {
  const attempts = db
    .select()
    .from(reviewAttempts)
    .where(eq(reviewAttempts.changeId, changeId))
    .all();
  attempts.sort((left, right) => {
    if (right.attemptNo !== left.attemptNo) return right.attemptNo - left.attemptNo;
    return right.startedAt.localeCompare(left.startedAt);
  });
  return attempts[0] ?? null;
}

function reportById(db: ReviewQaGateDb, reportId: string | null): ReviewReport | null {
  if (!reportId) return null;
  return db.select().from(reviewReports).where(eq(reviewReports.id, reportId)).get() ?? null;
}

function attemptById(db: ReviewQaGateDb, attemptId: string | null): ReviewAttempt | null {
  if (!attemptId) return null;
  return db.select().from(reviewAttempts).where(eq(reviewAttempts.id, attemptId)).get() ?? null;
}

function reviewFindings(db: ReviewQaGateDb, changeId: string): ReviewFinding[] {
  return db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all()
    .filter((finding) => finding.source === "review");
}

function countReviewFindings(rows: ReviewFinding[]): ReviewQaGateCounts {
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

function isLegacyIncomplete(finding: ReviewFinding): boolean {
  if (finding.legacyState === "legacy_incomplete") return true;
  if (finding.source !== "review") return false;
  const missingEvidence = !finding.evidence || finding.evidence.trim().length === 0;
  const missingRequiredFix = !finding.requiredFix || finding.requiredFix.trim().length === 0;
  if (finding.severity === "P0" || finding.severity === "P1") {
    return missingEvidence || missingRequiredFix;
  }
  if (finding.severity === "P2") return missingEvidence;
  return true;
}

function maxFindingVersion(rows: ReviewFinding[]): number {
  return rows.reduce((max, finding) => Math.max(max, finding.findingVersion), 1);
}

function currentWaiverVersion(rows: ReviewFinding[]): number {
  const waiverRows = rows.filter(
    (finding) =>
      finding.status === "waived" ||
      Boolean(finding.waivedAt) ||
      Boolean(finding.waiverDecisionId),
  );
  return waiverRows.length > 0 ? maxFindingVersion(waiverRows) : 1;
}

function waiverReasons(
  rows: ReviewFinding[],
  decisions: HumanDecision[],
): ReviewQaGateWaivedP1 {
  const reasons = rows
    .filter((finding) => finding.severity === "P1" && finding.status === "waived")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((finding) => {
      const decision =
        (finding.waiverDecisionId
          ? decisions.find((candidate) => candidate.id === finding.waiverDecisionId)
          : null) ??
        decisions.find(
          (candidate) =>
            candidate.action === "review_p1_waiver" &&
            candidate.targetType === "finding" &&
            candidate.targetId === finding.id,
        );
      return { findingId: finding.id, reason: decision?.reason ?? null };
    });
  return { count: reasons.length, reasons };
}

function allowedGateStatus(status: string): boolean {
  return status === "passed" || status === "passed_with_waived_p1";
}

function emptyResult(input: AssertCanEnterQaInput): ReviewQaGateResult {
  return {
    allowed: false,
    status: "unknown",
    reason: null,
    sourceBuildRunId: null,
    latestBuildRunId: null,
    counts: { blockingP0: 0, blockingP1: 0, waivedP1: 0, p2Count: 0 },
    waivedP1: { count: 0, reasons: [] },
    warnings: [],
    entrypoint: input.entrypoint,
    actor: input.actor,
    reportId: null,
    latestAttemptId: null,
    sourceHeadSha: null,
  };
}

function deny(
  code: ReviewQaGateErrorCode,
  reason: string,
  result: ReviewQaGateResult,
): never {
  throw new ReviewQaGateError(code, 409, {
    ...result,
    allowed: false,
    status: code,
    reason,
  });
}

export function assertCanEnterQa(input: AssertCanEnterQaInput): ReviewQaGateResult {
  const db = getReviewQaGateDb();
  const result = emptyResult(input);
  const change = db
    .select()
    .from(changes)
    .where(and(eq(changes.id, input.changeId), eq(changes.projectId, input.projectId)))
    .get();
  const project = change
    ? db.select().from(projects).where(eq(projects.id, input.projectId)).get()
    : null;
  if (!change || !project) {
    deny("change_not_found", `Change not found: ${input.projectId}/${input.changeId}`, result);
  }

  const state = db.select().from(reviewState).where(eq(reviewState.changeId, input.changeId)).get();
  const report = reportById(db, state?.latestValidReviewReportId ?? null);
  if (!state?.latestValidReviewReportId || !report) {
    deny("no_latest_valid_review", "No latest valid review is available for QA", result);
  }

  result.reportId = report.id;
  result.sourceBuildRunId = report.sourceBuildRunId;
  result.sourceHeadSha = report.sourceHeadSha;
  result.status = report.gateStatus;

  const reportAttempt = attemptById(db, report.attemptId);
  if (!reportAttempt || reportAttempt.changeId !== input.changeId) {
    deny(
      "data_inconsistent",
      "Latest valid review report points to a missing or mismatched attempt",
      result,
    );
  }

  const latestAttempt =
    latestAttemptByNumber(db, input.changeId) ?? attemptById(db, state.latestAttemptId ?? null);
  result.latestAttemptId = latestAttempt?.id ?? null;
  if (latestAttempt?.status === "running" || latestAttempt?.reviewStatus === "running") {
    deny("latest_attempt_running", "Latest review attempt is still running", result);
  }

  const latestBuild = latestApprovedBuild(db, input.changeId);
  const latestBuildRunId = buildIdentity(latestBuild);
  result.latestBuildRunId = latestBuildRunId;
  if (!latestBuild || !latestBuildRunId || latestBuildRunId !== report.sourceBuildRunId) {
    deny("source_build_stale", "Review source build is stale", result);
  }
  const latestBuildHead = latestBuild.status === "approved_for_absorb"
    ? latestBuild.baseCommit ?? latestBuild.baseHeadSha ?? null
    : latestBuild.headSha ?? latestBuild.adoptedHeadSha ?? latestBuild.baseCommit ?? null;
  if (latestBuildHead && report.sourceHeadSha && latestBuildHead !== report.sourceHeadSha) {
    deny("source_build_stale", "Review source build HEAD is stale", result);
  }

  const currentHead = input.expectedHeadSha ?? probeGitHead(project.repoPath);
  if (!currentHead) {
    result.warnings.push("git_head_unavailable");
  }

  const rows = reviewFindings(db, input.changeId);
  // An unreadable prior_blocking_snapshot is a data fault on ONE review attempt,
  // but this call sits under ACTION_DEFINITIONS.map() in action-contract-service,
  // which has no per-action try. Letting the throw escape takes out the entire
  // action contract for the change — every button on the page, in every phase,
  // not just QA. Observed: a change parked at DONE lost its "生成交付单" button
  // (GET .../gate and GET .../phases both 500) because of a Review-attempt row it
  // no longer has any reason to consult.
  //
  // Deny with the same code the stored-report path uses below, so the fault
  // surfaces as a 409 naming the reason instead of a 500 naming nothing.
  let settlementRows: ReviewFinding[];
  try {
    settlementRows = settlementFindingsForReviewAttempt(reportAttempt, rows);
  } catch (error) {
    if (!(error instanceof InvalidPriorBlockingSnapshotError)) throw error;
    deny("data_inconsistent", `Review DB state is inconsistent: ${error.message}`, result);
  }
  const decisions = db
    .select()
    .from(humanDecisions)
    .where(eq(humanDecisions.changeId, input.changeId))
    .all();
  result.counts = countReviewFindings(settlementRows);
  result.waivedP1 = waiverReasons(settlementRows, decisions);

  if (report.legacyState === "legacy_incomplete" || settlementRows.some(isLegacyIncomplete)) {
    deny("legacy_incomplete", "Review contains legacy incomplete data", result);
  }

  if (maxFindingVersion(settlementRows) !== report.findingVersion) {
    deny("review_not_allowed", "Review report is stale because findings changed", result);
  }
  if (currentWaiverVersion(settlementRows) !== report.waiverVersion) {
    deny("review_not_allowed", "Review report is stale because waivers changed", result);
  }

  if (result.counts.blockingP0 > 0 || result.counts.blockingP1 > 0) {
    deny("review_blockers", "Review has open P0/P1 blockers", result);
  }

  if (report.gateStatus === "data_inconsistent") {
    deny("data_inconsistent", "Review DB state is inconsistent", result);
  }
  if (!allowedGateStatus(report.gateStatus) || report.qaAllowed !== 1) {
    deny("review_not_allowed", `Review gate is ${report.gateStatus}`, result);
  }

  return {
    ...result,
    allowed: true,
    status: report.gateStatus,
    reason: null,
  };
}
