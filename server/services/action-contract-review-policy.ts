import { eq } from "drizzle-orm";

import {
  artifacts,
  changes,
  findings,
  projects,
  reviewArtifactMirrors,
  reviewAttempts,
  reviewPriorFindingReviews,
  reviewReports,
  reviewState,
} from "../db/schema";
import { normalizeSeverity } from "./action-contract-common-policy";
import type { ActionContractDb, ActionDecision, Blocker } from "./action-contract-types";
import { latestApprovedBuildRecord } from "./action-contract-build-policy";
import { assertBuildRecordFresh } from "./build-run-record-service";
import {
  computeReviewFindingsDbHash,
  computeReviewReportDbHash,
  settlementFindingsForReviewAttempt,
} from "./review-report-service";
import { buildReviewInputSnapshot } from "./review-run-service";

export function reviewFindingBlockers(db: ActionContractDb, changeId: string): Blocker[] {
  return db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all()
    .filter(
      (finding) =>
        finding.source === "review" &&
        finding.status === "open" &&
        (finding.severity === "P0" || finding.severity === "P1"),
    )
    .map((finding) => ({
      id: finding.id,
      severity: normalizeSeverity(finding.severity),
      title: finding.title,
    }));
}

export function latestReviewReportSource(
  db: ActionContractDb,
  changeId: string,
): {
  gateVersion?: string;
  sourceDbHash?: string;
} {
  const state = db.select().from(reviewState).where(eq(reviewState.changeId, changeId)).get();
  const report = db
    .select()
    .from(reviewReports)
    .where(eq(reviewReports.id, state?.latestValidReviewReportId ?? ""))
    .get();
  return {
    gateVersion: report ? String(report.reportVersion) : undefined,
    sourceDbHash: report?.reportDbHash ?? report?.findingsDbHash ?? undefined,
  };
}

export function trustedLatestReviewReportSource(
  db: ActionContractDb,
  changeId: string,
): { gateVersion: string; sourceDbHash: string } | null {
  const state = db.select().from(reviewState).where(eq(reviewState.changeId, changeId)).get();
  if (!state?.latestValidReviewReportId || !state.latestAttemptId) {
    return null;
  }
  const reports = db.select().from(reviewReports).where(eq(reviewReports.changeId, changeId)).all();
  const report = reports.find((row) => row.id === state.latestValidReviewReportId);
  if (!report || report.attemptId !== state.latestAttemptId || report.qaAllowed !== 1 ||
      !["passed", "passed_with_waived_p1"].includes(report.gateStatus) || report.staleReason ||
      report.legacyState || !report.reportDbHash || !report.findingsDbHash ||
      state.reportDbHash !== report.reportDbHash || state.gateStatus !== report.gateStatus ||
      state.sourceBuildRunId !== report.sourceBuildRunId || state.sourceHeadSha !== report.sourceHeadSha) return null;
  const attempts = db.select().from(reviewAttempts).where(eq(reviewAttempts.changeId, changeId)).all();
  const attempt = attempts.find((row) => row.id === report.attemptId);
  // A waived-P1 settlement leaves the attempt's own conclusion at
  // "issues_found" while the report legitimately carries
  // passed_with_waived_p1 / qaAllowed=1 (the state assertCanEnterQa accepts).
  // Requiring reviewStatus === "passed" here stranded every waived-P1 change
  // at the QA door. "Nothing actually open" is still enforced below: the
  // settlement counts are recomputed from current findings and must equal the
  // report's, and the accepted gate statuses derive from zero open P0/P1.
  if (!attempt || attempt.changeId !== changeId || attempt.status !== "completed"
    || !["passed", "issues_found"].includes(attempt.reviewStatus)) {
    return null;
  }
  const latestAttemptNo = Math.max(...attempts.map((row) => row.attemptNo));
  if (attempt.attemptNo !== latestAttemptNo || attempts.filter((row) => row.attemptNo === latestAttemptNo).length !== 1) {
    return null;
  }
  const change = db.select().from(changes).where(eq(changes.id, changeId)).get();
  const project = change
    ? db.select().from(projects).where(eq(projects.id, change.projectId)).get()
    : null;
  const latestBuild = latestApprovedBuildRecord(db, changeId);
  if (!project || !latestBuild || latestBuild.status !== "adopted" ||
      (latestBuild.buildRunId ?? latestBuild.id) !== attempt.sourceBuildRunId ||
      attempt.sourceBuildRunId !== report.sourceBuildRunId ||
      attempt.sourceHeadSha !== report.sourceHeadSha ||
      latestBuild.adoptedHeadSha !== report.sourceHeadSha) return null;
  // DB is authoritative for read-time QA-gate trust: the adopted build_run_records
  // row (headSha === the report's adopted source HEAD) is the authority, not the
  // .ship build-N.json projection. Post-adoption working-tree tampering is re-caught
  // downstream at execution (merge/review-stage paths still verify live files).
  // See docs/state-projection-audit-2026-07-14.md and the two kept git reads.
  if (!report.sourceHeadSha) return null;
  try {
    assertBuildRecordFresh(changeId, report.sourceHeadSha);
  } catch {
    return null;
  }
  let priorFindingIds: string[];
  try {
    const parsed = JSON.parse(attempt.priorBlockingFindingIdsJson ?? "[]") as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) return null;
    priorFindingIds = parsed;
  } catch {
    return null;
  }
  const inputSnapshot = buildReviewInputSnapshot(db as never, changeId, priorFindingIds);
  if (!attempt.inputSourceDbHash || inputSnapshot.inputSourceDbHash !== attempt.inputSourceDbHash ||
      inputSnapshot.sourceBuildRunId !== attempt.sourceBuildRunId ||
      inputSnapshot.sourceHeadSha !== attempt.sourceHeadSha) return null;
  const currentFindings = db.select().from(findings).where(eq(findings.changeId, changeId)).all();
  const settlementFindings = settlementFindingsForReviewAttempt(attempt, currentFindings);
  const findingsDbHash = computeReviewFindingsDbHash(settlementFindings);
  if (findingsDbHash !== report.findingsDbHash || !report.reportJson) return null;
  const counts = {
    blockingP0: settlementFindings.filter((row) => row.severity === "P0" && row.status === "open").length,
    blockingP1: settlementFindings.filter((row) => row.severity === "P1" && row.status === "open").length,
    waivedP1: settlementFindings.filter((row) => row.severity === "P1" && row.status === "waived").length,
    p2Count: settlementFindings.filter((row) => row.severity === "P2").length,
  };
  const findingVersion = settlementFindings.reduce((max, row) => Math.max(max, row.findingVersion), 1);
  const waiverRows = settlementFindings.filter((row) =>
    row.status === "waived" || Boolean(row.waivedAt) || Boolean(row.waiverDecisionId));
  const waiverVersion = waiverRows.reduce((max, row) => Math.max(max, row.findingVersion), 1);
  const gateStatus = counts.blockingP0 > 0
    ? "blocked_p0"
    : counts.blockingP1 > 0
      ? "blocked_p1"
      : counts.waivedP1 > 0 ? "passed_with_waived_p1" : "passed";
  const qaAllowed = gateStatus === "passed" || gateStatus === "passed_with_waived_p1";
  const reviewConclusion = Object.values(counts).some((count) => count > 0) ? "issues_found" : "passed";
  if (report.blockingP0 !== counts.blockingP0 || report.blockingP1 !== counts.blockingP1 ||
      report.waivedP1 !== counts.waivedP1 || report.p2Count !== counts.p2Count ||
      report.findingVersion !== findingVersion || report.waiverVersion !== waiverVersion ||
      report.gateStatus !== gateStatus || report.qaAllowed !== (qaAllowed ? 1 : 0) ||
      report.reviewConclusion !== reviewConclusion) return null;
  const priorFindingReviews = db.select().from(reviewPriorFindingReviews)
    .where(eq(reviewPriorFindingReviews.attemptId, attempt.id)).all()
    .sort((left, right) => left.priorFindingId.localeCompare(right.priorFindingId) || left.id.localeCompare(right.id));
  const reportFacts = {
    attempt: {
      id: attempt.id, attemptNo: attempt.attemptNo, status: attempt.status,
      reviewStatus: attempt.reviewStatus, sourceBuildRunId: attempt.sourceBuildRunId,
      sourceHeadSha: attempt.sourceHeadSha,
    },
    counts,
    dataInconsistencyReasons: [],
    findingVersion,
    gateStatus,
    latestBuild: {
      id: latestBuild.id,
      buildRunId: latestBuild.buildRunId,
      status: latestBuild.status,
      headSha: latestBuild.headSha ?? latestBuild.adoptedHeadSha ?? latestBuild.baseCommit,
      baseCommit: latestBuild.baseCommit,
      adoptedAt: latestBuild.adoptedAt,
    },
    priorFindingReviews: priorFindingReviews.map((review) => ({
      id: review.id, priorFindingId: review.priorFindingId, verdict: review.verdict,
      evidence: review.evidence, requiredFix: review.requiredFix,
      replacementFindingId: review.replacementFindingId, reviewerNotes: review.reviewerNotes,
    })),
    qaAllowed,
    reviewConclusion,
    staleReasons: [],
    waiverVersion,
  };
  if (computeReviewReportDbHash(reportFacts, findingsDbHash) !== report.reportDbHash) return null;
  const mirrors = db.select().from(reviewArtifactMirrors)
    .where(eq(reviewArtifactMirrors.reportId, report.id)).all();
  for (const [kind, sourceHash] of [
    ["review_report", report.reportDbHash],
    ["review_findings", report.findingsDbHash],
  ] as const) {
    const matching = mirrors.filter((mirror) => mirror.kind === kind);
    if (matching.length === 0) continue;
    if (matching.length !== 1) return null;
    const mirror = matching[0]!;
    // DB is authoritative: trust mirrorStatus + the artifactHash/contentHash
    // cross-check that review-artifact-mirror-service already verified and
    // persisted when it last rebuilt this mirror, rather than re-reading the
    // file from disk here. See docs/state-projection-audit-2026-07-14.md §4.
    if (mirror.mirrorStatus !== "ok" || mirror.sourceDbHash !== sourceHash || !mirror.path ||
        !mirror.contentHash || mirror.artifactHash !== mirror.contentHash || !mirror.artifactId) return null;
    const artifact = db.select().from(artifacts).where(eq(artifacts.id, mirror.artifactId)).get();
    if (!artifact || artifact.changeId !== changeId || artifact.path !== mirror.path) return null;
  }
  return { gateVersion: String(report.reportVersion), sourceDbHash: report.reportDbHash };
}

export function latestReviewAttemptId(db: ActionContractDb, changeId: string): string | null {
  const state = db.select().from(reviewState).where(eq(reviewState.changeId, changeId)).get();
  if (state?.latestAttemptId) return state.latestAttemptId;
  const attempts = db.select().from(reviewAttempts).where(eq(reviewAttempts.changeId, changeId)).all();
  attempts.sort((left, right) => {
    if (right.attemptNo !== left.attemptNo) return right.attemptNo - left.attemptNo;
    const started = right.startedAt.localeCompare(left.startedAt);
    if (started !== 0) return started;
    return right.id.localeCompare(left.id);
  });
  return attempts[0]?.id ?? null;
}

export function hasWaivableOpenReviewP1(db: ActionContractDb, changeId: string): boolean {
  return Boolean(
    db
      .select()
      .from(findings)
      .where(eq(findings.changeId, changeId))
      .all()
      .find(
        (finding) =>
          finding.source === "review" &&
          finding.severity === "P1" &&
          finding.status === "open" &&
          finding.waivable === 1,
      ),
  );
}

/**
 * The statuses a `fix_blockers` dispatch can actually reach a run from: the two
 * runFixStreamed asserts, plus the running status its stranded-claim recovery
 * repairs. Keep in step with FIX_ALLOWED_STATUSES in
 * pipeline-build-stage-service -- when these disagree the user gets a dead end
 * in one direction or the other.
 */
const FIX_ENTRY_STATUSES = new Set(["CHECK_FAILED", "SCOPE_FAILED", "FIXING"]);

export function reviewControlDecision(
  db: ActionContractDb,
  changeId: string,
  actionId: string,
  changeStatus?: string,
): ActionDecision {
  const source = latestReviewReportSource(db, changeId);
  if (actionId === "fix_blockers") {
    const blockers = reviewFindingBlockers(db, changeId);
    if (blockers.length === 0) {
      return {
        enabled: false,
        reasonCode: "no_review_blockers",
        reason: "No open P0/P1 blockers need a fix command.",
        blockers,
        ...source,
      };
    }
    // Mirrors what runFixStreamed actually reaches
    // (pipeline-build-stage-service FIX_ALLOWED_STATUSES): CHECK_FAILED and
    // SCOPE_FAILED are the normal entries, and FIXING is the stranded-run
    // entry, where the runner rolls the change back to CHECK_FAILED first
    // (recoverStrandedRunningStatus) and then runs. Without FIXING a fix run
    // killed mid-flight had no exit at all: the runner could repair the claim
    // and nothing could enqueue the action that does.
    if (changeStatus && !FIX_ENTRY_STATUSES.has(changeStatus)) {
      return {
        enabled: false,
        reasonCode: "not_at_gate",
        reason: "Fix can only run from CHECK_FAILED or SCOPE_FAILED.",
        blockers,
        ...source,
      };
    }
    return {
      enabled: true,
      reasonCode: null,
      reason: null,
      blockers,
      ...source,
    };
  }
  if (actionId === "waive_review_p1") {
    const enabled = hasWaivableOpenReviewP1(db, changeId);
    return {
      enabled,
      reasonCode: enabled ? null : "no_waivable_review_p1",
      reason: enabled ? null : "P1 waiver is only available when open P1 findings block QA.",
      blockers: [],
      ...source,
    };
  }
  if (actionId === "recompute_report") {
    const attemptId = latestReviewAttemptId(db, changeId);
    return {
      enabled: Boolean(attemptId),
      reasonCode: attemptId ? null : "review_attempt_missing",
      reason: attemptId ? null : "No Review attempt is available to recompute.",
      blockers: [],
      gateVersion: source.gateVersion,
      sourceDbHash: source.sourceDbHash ?? attemptId ?? undefined,
    };
  }
  if (actionId === "rebuild_mirror") {
    const enabled = Boolean(source.sourceDbHash);
    return {
      enabled,
      reasonCode: enabled ? null : "review_report_missing",
      reason: enabled ? null : "No latest valid Review report is available to rebuild.",
      blockers: [],
      ...source,
    };
  }
  return {
    enabled: true,
    reasonCode: null,
    reason: null,
    blockers: [],
    ...source,
  };
}
