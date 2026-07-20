import { eq, sql } from "drizzle-orm";

import { db } from "../db";
import {
  artifacts,
  buildRunRecords,
  changes,
  findings,
  humanDecisions,
  projects,
  reviewArtifactMirrors,
  reviewAttempts,
  reviewReports,
  reviewState,
  runs,
} from "../db/schema";
import type { FindingSeverity, FindingStatus, RunStatus } from "../types/enums";
import {
  compareRunsDesc,
  parseReviewSummary,
  VALID_REVIEW_STATUSES,
  type ParsedReviewSummary,
  type ReviewRunStatus,
} from "./review-center-summary-parser";

export type { ReviewRunStatus } from "./review-center-summary-parser";

/** The default (singleton) connection, or an injected test connection. */
export type ReviewCenterDb = typeof db;

let reviewCenterDbForTest: ReviewCenterDb | null = null;

export function setReviewCenterServiceDbForTest(nextDb: ReviewCenterDb): () => void {
  const previous = reviewCenterDbForTest;
  reviewCenterDbForTest = nextDb;
  return () => {
    reviewCenterDbForTest = previous;
  };
}

function getReviewCenterDb(): ReviewCenterDb {
  return reviewCenterDbForTest ?? db;
}

export type ReviewCenterGateStatus =
  | "not_started"
  | "running"
  | "passed"
  | "blocked_p0"
  | "blocked_p1"
  | "failed"
  | "invalid_output"
  | "data_inconsistent"
  | "stale";

export interface ReviewCenterAttempt {
  runId: string;
  runStatus: RunStatus;
  reviewStatus: ReviewRunStatus;
  sourceBuildRunId: string | null;
  reportPath: string | null;
  findingsPath: string | null;
  rawOutputPath: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  findingCount: number;
}

export interface ReviewCenterCounts {
  p0: number;
  p1: number;
  p2: number;
  waived: number;
}

export interface ReviewFindingView {
  id: string;
  changeId: string;
  runId: string;
  source: "review";
  severity: "P0" | "P1" | "P2";
  category: string;
  title: string;
  file: string | null;
  line: number | null;
  evidence: string;
  requiredFix: string | null;
  status: "open" | "fixed" | "waived";
  waivable: boolean;
  createdAt: string;
  updatedAt: string | null;
  isLegacyIncomplete: boolean;
  isNotRechecked: boolean;
}

export interface ReviewCenterGate {
  status: ReviewCenterGateStatus;
  canEnterQa: boolean;
  reason: string | null;
  sourceBuildRunId: string | null;
  latestBuildRunId: string | null;
}

export interface ReviewCenterActions {
  run_review: ReviewCenterAction;
  retry_review: ReviewCenterAction;
  fix_blockers: ReviewCenterAction;
  waive_p1: ReviewCenterAction;
  enter_qa: ReviewCenterAction;
  stop_change: ReviewCenterAction;
  recompute_report: ReviewCenterAction;
  rebuild_mirror: ReviewCenterAction;
  canRunReview: boolean;
  canRetryReview: boolean;
  canFixBlockers: boolean;
  canWaiveP1: boolean;
  canEnterQa: boolean;
  canStopChange: boolean;
}

export type ReviewCenterActionId =
  | "run_review"
  | "retry_review"
  | "fix_blockers"
  | "waive_p1"
  | "enter_qa"
  | "stop_change"
  | "recompute_report"
  | "rebuild_mirror";

export interface ReviewCenterAction {
  id: ReviewCenterActionId;
  enabled: boolean;
  reason: string | null;
  idempotencyRequired: boolean;
}

export interface ReviewCenterWaiver {
  findingId: string;
  title: string;
  severity: "P1";
  reason: string | null;
  decisionId: string | null;
}

export interface ReviewCenterMirrorWarning {
  kind: string;
  status: string;
  reason: string | null;
  artifactId: string | null;
}

export interface ReviewCenterMirrorDetail {
  kind: string;
  status: string | null;
  artifactId: string | null;
  contentHash: string | null;
  artifactHash: string | null;
  sourceDbHash: string | null;
  schemaVersion: string | null;
  path: null;
}

export interface ReviewCenterRawOutputArtifactDetail {
  id: string;
  type: string;
  path: null;
  createdAt: string;
}

export interface ReviewCenterAttemptAdvancedDetails {
  attemptId: string | null;
  reportArtifactId: string | null;
  reportDbHash: string | null;
  findingsDbHash: string | null;
  sourceBuildRunId: string | null;
  sanitizedErrorSummary: string | null;
  rawOutputArtifact: ReviewCenterRawOutputArtifactDetail | null;
  mirrors: ReviewCenterMirrorDetail[];
}

export interface ReviewCenterAdvancedDetails {
  latestAttempt: ReviewCenterAttemptAdvancedDetails | null;
  latestValidReview: ReviewCenterAttemptAdvancedDetails | null;
}

export interface ReviewCenterState {
  headlineStatus: ReviewCenterGateStatus;
  qaAllowed: boolean;
  latestAttempt: ReviewCenterAttempt | null;
  latestValidReview: ReviewCenterAttempt | null;
  counts: ReviewCenterCounts;
  gate: ReviewCenterGate;
  findings: ReviewFindingView[];
  waivers: ReviewCenterWaiver[];
  mirrorWarnings: ReviewCenterMirrorWarning[];
  actions: ReviewCenterActions;
  advancedDetails: ReviewCenterAdvancedDetails;
}

export type ReviewCenterResponse = ReviewCenterState;

function reviewRunsFor(changeId: string) {
  const db = getReviewCenterDb();
  return db
    .select()
    .from(runs)
    .where(eq(runs.changeId, changeId))
    .all()
    .filter((run) => run.phase === "review")
    .sort(compareRunsDesc);
}

function attemptFromRunForChange(
  run: ReturnType<typeof reviewRunsFor>[number],
  changeId: string
): ReviewCenterAttempt {
  if (run.status === "running") {
    return {
      runId: run.id,
      runStatus: run.status as RunStatus,
      reviewStatus: "running",
      sourceBuildRunId: null,
      reportPath: null,
      findingsPath: null,
      rawOutputPath: null,
      errorCode: null,
      errorMessage: null,
      findingCount: 0,
    };
  }

  const parsed = parseReviewSummary(run.summary);
  if (
    parsed.valid &&
    parsed.reviewStatus !== null &&
    VALID_REVIEW_STATUSES.has(parsed.reviewStatus) &&
    !reviewFindingCountMatchesSummary(changeId, run.id, parsed)
  ) {
    return {
      runId: run.id,
      runStatus: run.status as RunStatus,
      reviewStatus: "data_inconsistent",
      sourceBuildRunId: parsed.sourceBuildRunId,
      reportPath: null,
      findingsPath: null,
      rawOutputPath: null,
      errorCode: "review_finding_count_mismatch",
      errorMessage: "Review run summary findingCount does not match DB review findings.",
      findingCount: parsed.findingCount,
    };
  }

  return {
    runId: run.id,
    runStatus: run.status as RunStatus,
    reviewStatus: parsed.valid && parsed.reviewStatus ? parsed.reviewStatus : "failed",
    sourceBuildRunId: parsed.sourceBuildRunId,
    reportPath: null,
    findingsPath: null,
    rawOutputPath: null,
    errorCode: parsed.errorCode ?? (parsed.valid ? null : "invalid_review_summary"),
    errorMessage: parsed.errorMessage,
    findingCount: parsed.findingCount,
  };
}

function reviewFindingCount(changeId: string, runId: string): number {
  const db = getReviewCenterDb();
  return db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all()
    .filter((finding) => finding.source === "review" && finding.runId === runId).length;
}

function reviewFindingCountMatchesSummary(
  changeId: string,
  runId: string,
  parsed: ParsedReviewSummary
): boolean {
  return reviewFindingCount(changeId, runId) === parsed.findingCount;
}

function latestValidReviewRun(changeId: string, reviewRuns: ReturnType<typeof reviewRunsFor>) {
  return reviewRuns.find((run) => {
    if (run.status !== "completed") return false;
    const parsed = parseReviewSummary(run.summary);
    return (
      parsed.valid &&
      parsed.reviewStatus !== null &&
      VALID_REVIEW_STATUSES.has(parsed.reviewStatus) &&
      reviewFindingCountMatchesSummary(changeId, run.id, parsed)
    );
  }) ?? null;
}

function latestApprovedBuildRunId(changeId: string): string | null {
  const db = getReviewCenterDb();
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
  const latest = records[0] ?? null;
  return latest ? latest.buildRunId ?? latest.id : null;
}

function isOpenBlocker(finding: { severity: string; status: string }): boolean {
  return finding.status === "open" && (finding.severity === "P0" || finding.severity === "P1");
}

function isLegacyIncompleteFinding(finding: {
  severity: string;
  evidence: string | null;
  requiredFix: string | null;
}): boolean {
  const missingEvidence = !finding.evidence || finding.evidence.trim().length === 0;
  const missingRequiredFix = !finding.requiredFix || finding.requiredFix.trim().length === 0;
  if (finding.severity === "P0" || finding.severity === "P1") {
    return missingEvidence || missingRequiredFix;
  }
  if (finding.severity === "P2") {
    return missingEvidence;
  }
  return false;
}

function publicFindingFilePath(filePath: string | null): string | null {
  if (!filePath) return null;
  const normalized = filePath.trim();
  if (normalized.length === 0) return null;
  const isAbsolute =
    normalized.startsWith("/") ||
    normalized.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(normalized) ||
    normalized.startsWith("file://");
  if (!isAbsolute) return normalized;
  const withoutProtocol = normalized.replace(/^file:\/+/i, "/");
  const parts = withoutProtocol.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? null;
}

function findingView(
  finding: typeof findings.$inferSelect,
  latestValidReview: ReviewCenterAttempt | null
): ReviewFindingView {
  const severity = finding.severity as FindingSeverity;
  const status = finding.status as FindingStatus;
  return {
    id: finding.id,
    changeId: finding.changeId,
    runId: finding.runId ?? "",
    source: "review",
    severity,
    category: finding.category,
    title: finding.title,
    file: publicFindingFilePath(finding.file),
    line: finding.line,
    evidence: finding.evidence ?? "",
    requiredFix: finding.requiredFix,
    status,
    waivable: severity === "P1",
    createdAt: finding.createdAt,
    updatedAt: finding.updatedAt,
    isLegacyIncomplete: isLegacyIncompleteFinding(finding),
    isNotRechecked: Boolean(
      latestValidReview &&
        finding.runId !== latestValidReview.runId &&
        status === "open" &&
        (severity === "P0" || severity === "P1")
    ),
  };
}

function reviewFindingViews(
  changeId: string,
  latestValidReview: ReviewCenterAttempt | null
): ReviewFindingView[] {
  const db = getReviewCenterDb();
  const reviewFindings = db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all()
    .filter((finding) => finding.source === "review");

  return reviewFindings
    .filter((finding) => {
      if (latestValidReview && finding.runId === latestValidReview.runId) return true;
      return isOpenBlocker(finding);
    })
    .map((finding) => findingView(finding, latestValidReview))
    .sort((left, right) => {
      const leftLatest = latestValidReview && left.runId === latestValidReview.runId ? 0 : 1;
      const rightLatest = latestValidReview && right.runId === latestValidReview.runId ? 0 : 1;
      if (leftLatest !== rightLatest) return leftLatest - rightLatest;
      return left.id.localeCompare(right.id);
    });
}

function gateFor(input: {
  latestAttempt: ReviewCenterAttempt | null;
  latestValidReview: ReviewCenterAttempt | null;
  latestBuildRunId: string | null;
  findings: ReviewFindingView[];
}): ReviewCenterGate {
  const sourceBuildRunId = input.latestValidReview?.sourceBuildRunId ?? input.latestAttempt?.sourceBuildRunId ?? null;
  const base = {
    canEnterQa: false,
    sourceBuildRunId,
    latestBuildRunId: input.latestBuildRunId,
  };

  if (!input.latestAttempt) {
    return { ...base, status: "not_started", reason: "No Review run has started." };
  }

  if (input.latestAttempt.reviewStatus === "running") {
    return { ...base, status: "running", reason: "Review is still running." };
  }

  if (!input.latestValidReview) {
    if (
      input.latestAttempt.reviewStatus === "invalid_output" ||
      input.latestAttempt.reviewStatus === "data_inconsistent"
    ) {
      return {
        ...base,
        status: input.latestAttempt.reviewStatus,
        reason: input.latestAttempt.errorMessage,
      };
    }
    return { ...base, status: "failed", reason: input.latestAttempt.errorMessage };
  }

  if (!input.latestBuildRunId) {
    return {
      ...base,
      status: "stale",
      reason: "Review requires an approved Build run before QA.",
    };
  }

  if (!input.latestValidReview.sourceBuildRunId) {
    return {
      ...base,
      status: "stale",
      reason: "Review is missing its source Build run.",
    };
  }

  if (input.latestValidReview.sourceBuildRunId !== input.latestBuildRunId) {
    return {
      ...base,
      status: "stale",
      reason: "Review was produced from an older approved Build run.",
    };
  }

  if (
    input.findings.some(
      (finding) =>
        finding.runId === input.latestValidReview?.runId &&
        finding.status === "waived" &&
        finding.severity === "P1"
    )
  ) {
    return {
      ...base,
      status: "stale",
      reason: "P1 waiver requires a fresh Review run before QA.",
    };
  }

  if (input.findings.some((finding) => finding.status === "open" && finding.severity === "P0")) {
    return { ...base, status: "blocked_p0", reason: "Open P0 Review findings block QA." };
  }

  if (input.findings.some((finding) => finding.status === "open" && finding.severity === "P1")) {
    return { ...base, status: "blocked_p1", reason: "Open P1 Review findings block QA." };
  }

  return { ...base, status: "passed", canEnterQa: true, reason: null };
}

function action(
  id: ReviewCenterActionId,
  enabled: boolean,
  reason: string | null,
  idempotencyRequired: boolean,
): ReviewCenterAction {
  return {
    id,
    enabled,
    reason: enabled ? null : reason,
    idempotencyRequired,
  };
}

function actionsFor(input: {
  gate: ReviewCenterGate;
  latestAttempt: ReviewCenterAttempt | null;
  latestAttemptRow: typeof reviewAttempts.$inferSelect | null;
  latestValidReport: typeof reviewReports.$inferSelect | null;
  latestBuildRunId: string | null;
}): ReviewCenterActions {
  const { gate, latestAttempt, latestAttemptRow, latestValidReport, latestBuildRunId } = input;
  const running = latestAttempt?.reviewStatus === "running";
  const hasApprovedBuild = Boolean(latestBuildRunId);
  const buildRequiredReason = "Review requires an approved Build run before starting.";
  const canRunReview = !running && hasApprovedBuild;
  const canRetryReview =
    !running &&
    hasApprovedBuild &&
    ["failed", "invalid_output", "data_inconsistent", "stale"].includes(gate.status);
  const canFixBlockers = gate.status === "blocked_p0" || gate.status === "blocked_p1";
  const canWaiveP1 = gate.status === "blocked_p1";
  const canEnterQa = gate.canEnterQa;
  const canStopChange = true;
  const canRecomputeReport = Boolean(latestAttemptRow) && !running;
  const canRebuildMirror = Boolean(latestValidReport) && !running;

  return {
    run_review: action(
      "run_review",
      canRunReview,
      running ? "Review is already running." : buildRequiredReason,
      true,
    ),
    retry_review: action(
      "retry_review",
      canRetryReview,
      !hasApprovedBuild ? buildRequiredReason : "Retry is only available for failed or stale Review state.",
      true,
    ),
    fix_blockers: action("fix_blockers", canFixBlockers, "No open P0/P1 blockers need a fix command.", false),
    waive_p1: action("waive_p1", canWaiveP1, "P1 waiver is only available when open P1 findings block QA.", false),
    enter_qa: action("enter_qa", canEnterQa, gate.reason ?? "Review gate does not allow QA.", false),
    stop_change: action("stop_change", canStopChange, null, false),
    recompute_report: action("recompute_report", canRecomputeReport, "No Review attempt is available to recompute.", true),
    rebuild_mirror: action("rebuild_mirror", canRebuildMirror, "No latest valid Review report is available to rebuild.", true),
    canRunReview,
    canRetryReview,
    canFixBlockers,
    canWaiveP1,
    canEnterQa,
    canStopChange,
  };
}

function latestDbAttempt(changeId: string) {
  const db = getReviewCenterDb();
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

function dbReportForState(changeId: string, state: typeof reviewState.$inferSelect | null) {
  const db = getReviewCenterDb();
  if (state?.latestValidReviewReportId) {
    const report = db
      .select()
      .from(reviewReports)
      .where(eq(reviewReports.id, state.latestValidReviewReportId))
      .get();
    if (report && report.changeId === changeId) return report;
  }

  return null;
}

function dbAttemptById(attemptId: string | null) {
  const db = getReviewCenterDb();
  if (!attemptId) return null;
  return db.select().from(reviewAttempts).where(eq(reviewAttempts.id, attemptId)).get() ?? null;
}

function reviewReportById(reportId: string | null) {
  const db = getReviewCenterDb();
  if (!reportId) return null;
  return db.select().from(reviewReports).where(eq(reviewReports.id, reportId)).get() ?? null;
}

function rawOutputArtifactDetail(
  attempt: typeof reviewAttempts.$inferSelect | null,
): ReviewCenterRawOutputArtifactDetail | null {
  const db = getReviewCenterDb();
  if (!attempt?.rawOutputArtifactId) return null;
  const artifact = db.select().from(artifacts).where(eq(artifacts.id, attempt.rawOutputArtifactId)).get();
  if (!artifact) return null;
  return {
    id: artifact.id,
    type: artifact.type,
    path: null,
    createdAt: artifact.createdAt,
  };
}

function mirrorRowsForReport(reportId: string | null) {
  const db = getReviewCenterDb();
  if (!reportId) return [];
  if (!hasReviewArtifactMirrorContract()) return [];
  return db
    .select()
    .from(reviewArtifactMirrors)
    .where(eq(reviewArtifactMirrors.reportId, reportId))
    .all()
    .sort((left, right) => {
      const kind = left.kind.localeCompare(right.kind);
      if (kind !== 0) return kind;
      return left.id.localeCompare(right.id);
    });
}

function hasReviewArtifactMirrorContract(): boolean {
  const mirrorColumns = tableColumnNames("review_artifact_mirrors");
  return (
    mirrorColumns.has("artifact_id") &&
    mirrorColumns.has("content_hash") &&
    mirrorColumns.has("mirror_status") &&
    mirrorColumns.has("artifact_hash")
  );
}

function mirrorDetails(reportId: string | null): ReviewCenterMirrorDetail[] {
  return mirrorRowsForReport(reportId).map((mirror) => ({
    kind: mirror.kind,
    status: mirror.mirrorStatus,
    artifactId: mirror.artifactId,
    contentHash: mirror.contentHash,
    artifactHash: mirror.artifactHash,
    sourceDbHash: mirror.sourceDbHash,
    schemaVersion: mirror.schemaVersion,
    path: null,
  }));
}

function mirrorWarningsForReport(reportId: string | null): ReviewCenterMirrorWarning[] {
  return mirrorRowsForReport(reportId)
    .filter((mirror) => mirror.mirrorStatus !== null && mirror.mirrorStatus !== "ok")
    .map((mirror) => ({
      kind: mirror.kind,
      status: mirror.mirrorStatus ?? "unknown",
      reason: mirror.errorCode ?? mirror.mirrorStatus,
      artifactId: mirror.artifactId,
    }));
}

function reportArtifactIdForReport(reportId: string | null): string | null {
  return mirrorRowsForReport(reportId).find((mirror) => mirror.kind === "review_report")?.artifactId ?? null;
}

function advancedDetailsFor(
  attempt: typeof reviewAttempts.$inferSelect | null,
  report: typeof reviewReports.$inferSelect | null,
): ReviewCenterAttemptAdvancedDetails | null {
  if (!attempt && !report) return null;
  const reportId = report?.id ?? null;
  return {
    attemptId: attempt?.id ?? report?.attemptId ?? null,
    reportArtifactId: reportArtifactIdForReport(reportId),
    reportDbHash: report?.reportDbHash ?? null,
    findingsDbHash: report?.findingsDbHash ?? null,
    sourceBuildRunId: report?.sourceBuildRunId ?? attempt?.sourceBuildRunId ?? null,
    sanitizedErrorSummary: attempt?.sanitizedErrorSummary ?? null,
    rawOutputArtifact: rawOutputArtifactDetail(attempt),
    mirrors: mirrorDetails(reportId),
  };
}

function countsFor(
  latestValidReport: typeof reviewReports.$inferSelect | null,
  findingViews: ReviewFindingView[],
): ReviewCenterCounts {
  if (latestValidReport) {
    return {
      p0: latestValidReport.blockingP0,
      p1: latestValidReport.blockingP1,
      p2: latestValidReport.p2Count,
      waived: latestValidReport.waivedP1,
    };
  }
  return {
    p0: findingViews.filter((finding) => finding.severity === "P0" && finding.status === "open").length,
    p1: findingViews.filter((finding) => finding.severity === "P1" && finding.status === "open").length,
    p2: findingViews.filter((finding) => finding.severity === "P2").length,
    waived: findingViews.filter((finding) => finding.severity === "P1" && finding.status === "waived").length,
  };
}

function waiverViews(changeId: string): ReviewCenterWaiver[] {
  const db = getReviewCenterDb();
  const decisions = new Map(
    db
      .select()
      .from(humanDecisions)
      .where(eq(humanDecisions.changeId, changeId))
      .all()
      .map((decision) => [decision.id, decision]),
  );
  return db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all()
    .filter(
      (finding) =>
        finding.source === "review" &&
        finding.severity === "P1" &&
        finding.status === "waived",
    )
    .map((finding) => {
      const decision = finding.waiverDecisionId ? decisions.get(finding.waiverDecisionId) : null;
      return {
        findingId: finding.id,
        title: finding.title,
        severity: "P1" as const,
        reason: decision?.reason ?? null,
        decisionId: finding.waiverDecisionId,
      };
    })
    .sort((left, right) => left.findingId.localeCompare(right.findingId));
}

function dbAttemptView(
  attempt: typeof reviewAttempts.$inferSelect,
  report: typeof reviewReports.$inferSelect | null = null
): ReviewCenterAttempt {
  return {
    runId: attempt.runId ?? attempt.id,
    runStatus: attempt.status as RunStatus,
    reviewStatus: attempt.reviewStatus as ReviewRunStatus,
    sourceBuildRunId: report?.sourceBuildRunId ?? attempt.sourceBuildRunId,
    reportPath: null,
    findingsPath: null,
    rawOutputPath: null,
    errorCode: attempt.errorCode,
    errorMessage: attempt.sanitizedErrorSummary,
    findingCount: report
      ? report.blockingP0 + report.blockingP1 + report.waivedP1 + report.p2Count
      : 0,
  };
}

function dbGateStatusForReport(gateStatus: string): ReviewCenterGateStatus {
  if (gateStatus === "passed_with_waived_p1") return "passed";
  if (
    gateStatus === "running" ||
    gateStatus === "passed" ||
    gateStatus === "blocked_p0" ||
    gateStatus === "blocked_p1" ||
    gateStatus === "failed" ||
    gateStatus === "invalid_output" ||
    gateStatus === "data_inconsistent" ||
    gateStatus === "stale"
  ) {
    return gateStatus;
  }
  return "data_inconsistent";
}

function dbGateReason(report: typeof reviewReports.$inferSelect | null): string | null {
  if (!report) return null;
  if (report.gateStatus === "passed_with_waived_p1") {
    return "P1 risk accepted with a fresh DB Review report.";
  }
  return report.staleReason;
}

function dbGateFor(input: {
  latestAttempt: ReviewCenterAttempt | null;
  latestValidReview: ReviewCenterAttempt | null;
  latestValidReport: typeof reviewReports.$inferSelect | null;
  latestBuildRunId: string | null;
}): ReviewCenterGate {
  const sourceBuildRunId =
    input.latestValidReport?.sourceBuildRunId ??
    input.latestValidReview?.sourceBuildRunId ??
    input.latestAttempt?.sourceBuildRunId ??
    null;
  const base = {
    canEnterQa: false,
    sourceBuildRunId,
    latestBuildRunId: input.latestBuildRunId,
  };

  if (input.latestAttempt?.reviewStatus === "running") {
    return { ...base, status: "running", reason: "Review is still running." };
  }

  if (!input.latestValidReport) {
    if (!input.latestAttempt) {
      return { ...base, status: "not_started", reason: "No Review run has started." };
    }
    if (
      input.latestAttempt.reviewStatus === "invalid_output" ||
      input.latestAttempt.reviewStatus === "data_inconsistent"
    ) {
      return {
        ...base,
        status: input.latestAttempt.reviewStatus,
        reason: input.latestAttempt.errorMessage,
      };
    }
    if (input.latestAttempt.reviewStatus === "failed") {
      return { ...base, status: "failed", reason: input.latestAttempt.errorMessage };
    }
    return {
      ...base,
      status: "stale",
      reason: "Review DB state does not point to a valid report.",
    };
  }

  if (!input.latestBuildRunId) {
    return {
      ...base,
      status: "stale",
      reason: "Review requires an approved Build run before QA.",
    };
  }

  if (!input.latestValidReport.sourceBuildRunId) {
    return {
      ...base,
      status: "stale",
      reason: "Review is missing its source Build run.",
    };
  }

  if (input.latestValidReport.sourceBuildRunId !== input.latestBuildRunId) {
    return {
      ...base,
      status: "stale",
      reason: "Review was produced from an older approved Build run.",
    };
  }

  return {
    ...base,
    status: dbGateStatusForReport(input.latestValidReport.gateStatus),
    canEnterQa: input.latestValidReport.qaAllowed === 1,
    reason: dbGateReason(input.latestValidReport),
  };
}

function dbReviewCenterState(
  changeId: string,
  latestBuildRunId: string | null
): (Pick<ReviewCenterState, "latestAttempt" | "latestValidReview" | "gate"> & {
  latestAttemptRow: typeof reviewAttempts.$inferSelect | null;
  latestValidAttemptRow: typeof reviewAttempts.$inferSelect | null;
  latestValidReport: typeof reviewReports.$inferSelect | null;
}) | null {
  const db = getReviewCenterDb();
  if (!hasReviewDbReportContract()) return null;
  const latestAttemptRow = latestDbAttempt(changeId);
  const dbState = db.select().from(reviewState).where(eq(reviewState.changeId, changeId)).get() ?? null;
  const latestValidReport = dbReportForState(changeId, dbState);
  if (!latestAttemptRow && !latestValidReport && !dbState) return null;

  const latestAttempt = latestAttemptRow ? dbAttemptView(latestAttemptRow) : null;
  const latestValidAttempt = latestValidReport ? dbAttemptById(latestValidReport.attemptId) : null;
  const latestValidReview =
    latestValidAttempt && latestValidReport ? dbAttemptView(latestValidAttempt, latestValidReport) : null;
  const gate = dbGateFor({
    latestAttempt,
    latestValidReview,
    latestValidReport,
    latestBuildRunId,
  });

  return {
    latestAttempt,
    latestValidReview,
    gate,
    latestAttemptRow,
    latestValidAttemptRow: latestValidAttempt,
    latestValidReport,
  };
}

function hasReviewDbReportContract(): boolean {
  const stateColumns = tableColumnNames("review_state");
  const reportColumns = tableColumnNames("review_reports");
  return (
    stateColumns.has("latest_attempt_no") &&
    stateColumns.has("latest_valid_review_report_id") &&
    reportColumns.has("review_conclusion") &&
    reportColumns.has("qa_allowed")
  );
}

function tableColumnNames(tableName: string): Set<string> {
  const db = getReviewCenterDb();
  return new Set(
    (db.all(sql.raw(`PRAGMA table_info(${tableName})`)) as Array<{ name: string }>).map((row) =>
      String(row.name),
    ),
  );
}

export function getReviewCenterState(changeId: string): ReviewCenterState {
  const db = getReviewCenterDb();
  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  if (!change) {
    throw new Error(`Change not found: ${changeId}`);
  }

  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();
  if (!project) {
    throw new Error(`Project not found: ${change.projectId}`);
  }

  const reviewRuns = reviewRunsFor(changeId);
  const latestBuildRunId = latestApprovedBuildRunId(changeId);
  const dbCenter = dbReviewCenterState(changeId, latestBuildRunId);
  const validRun = latestValidReviewRun(changeId, reviewRuns);
  const latestAttempt =
    dbCenter?.latestAttempt ?? (reviewRuns[0] ? attemptFromRunForChange(reviewRuns[0], changeId) : null);
  const latestValidReview =
    dbCenter?.latestValidReview ?? (validRun ? attemptFromRunForChange(validRun, changeId) : null);
  const latestAttemptRow = dbCenter?.latestAttemptRow ?? latestDbAttempt(changeId);
  const latestValidReport = dbCenter?.latestValidReport ?? reviewReportById(
    db.select().from(reviewState).where(eq(reviewState.changeId, changeId)).get()?.latestValidReviewReportId ?? null,
  );
  const latestValidAttemptRow =
    dbCenter?.latestValidAttemptRow ?? dbAttemptById(latestValidReport?.attemptId ?? null);
  const findingViews = reviewFindingViews(changeId, latestValidReview);
  const gate =
    dbCenter?.gate ??
    gateFor({
      latestAttempt,
      latestValidReview,
      latestBuildRunId,
      findings: findingViews,
    });
  const authoritativeGate =
    !dbCenter && hasReviewDbReportContract() && gate.canEnterQa
      ? {
          ...gate,
          status: "stale" as const,
          canEnterQa: false,
          reason: "Review DB state is required before QA.",
        }
      : gate;

  const counts = countsFor(latestValidReport, findingViews);
  const waivers = waiverViews(changeId);
  const advancedDetails = {
    latestAttempt: advancedDetailsFor(latestAttemptRow, null),
    latestValidReview: advancedDetailsFor(latestValidAttemptRow, latestValidReport),
  };

  return {
    headlineStatus: authoritativeGate.status,
    qaAllowed: authoritativeGate.canEnterQa,
    latestAttempt,
    latestValidReview,
    counts,
    gate: authoritativeGate,
    findings: findingViews,
    waivers,
    mirrorWarnings: mirrorWarningsForReport(latestValidReport?.id ?? null),
    actions: actionsFor({
      gate: authoritativeGate,
      latestAttempt,
      latestAttemptRow,
      latestValidReport,
      latestBuildRunId,
    }),
    advancedDetails,
  };
}
