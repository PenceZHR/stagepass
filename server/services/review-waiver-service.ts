import { createRequire } from "node:module";

import { and, eq } from "drizzle-orm";

import {
  events,
  findings,
  humanDecisions,
  reviewAttempts,
  reviewReports,
  reviewState,
} from "../db/schema";
import { settlementFindingsForReviewAttempt } from "./review-report-service";

type ReviewWaiverDb = typeof import("../db/index").db;

export class ReviewWaiverError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReviewWaiverError";
  }
}

export interface WaiveReviewFindingInput {
  changeId: string;
  findingId: string;
  reason?: string | null;
  actor?: string | null;
}

export interface WaiveReviewFindingResult {
  findingId: string;
  decisionId: string;
  status: "waived";
  waiverVersion: number;
  reportStale: true;
}

const requireDefaultDb = createRequire(import.meta.url);
let reviewWaiverDbForTest: ReviewWaiverDb | null = null;
let defaultReviewWaiverDb: ReviewWaiverDb | null = null;

const UNWAIVABLE_SOURCES = new Set(["scope"]);
const UNWAIVABLE_FILES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

export function setReviewWaiverServiceDbForTest(nextDb: ReviewWaiverDb): () => void {
  const previous = reviewWaiverDbForTest;
  reviewWaiverDbForTest = nextDb;
  return () => {
    reviewWaiverDbForTest = previous;
  };
}

function getReviewWaiverDb(): ReviewWaiverDb {
  if (reviewWaiverDbForTest) return reviewWaiverDbForTest;
  if (!defaultReviewWaiverDb) {
    defaultReviewWaiverDb = (requireDefaultDb("../db/index") as typeof import("../db/index")).db;
  }
  return defaultReviewWaiverDb;
}

function nowISO(): string {
  return new Date().toISOString();
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

function nextHumanDecisionId(db: ReviewWaiverDb): string {
  return nextPrefixedId(
    db.select({ id: humanDecisions.id }).from(humanDecisions).all().map((row) => row.id),
    "HD",
  );
}

function nextEventId(db: ReviewWaiverDb): string {
  return nextPrefixedId(
    db.select({ id: events.id }).from(events).all().map((row) => row.id),
    "EVT",
  );
}

function staleReasonWith(existing: string | null, reason: string): string {
  let reasons: string[] = [];
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      reasons = Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [existing];
    } catch {
      reasons = [existing];
    }
  }
  if (!reasons.includes(reason)) reasons.push(reason);
  return JSON.stringify(reasons);
}

function maxFindingVersion(rows: Array<typeof findings.$inferSelect>): number {
  return rows.reduce((max, finding) => Math.max(max, finding.findingVersion), 1);
}

function currentWaiverVersion(rows: Array<typeof findings.$inferSelect>): number {
  const waiverRows = rows.filter(
    (finding) =>
      finding.status === "waived" ||
      Boolean(finding.waivedAt) ||
      Boolean(finding.waiverDecisionId),
  );
  return waiverRows.length > 0 ? maxFindingVersion(waiverRows) : 1;
}

function fail(code: string, status: number, message: string): never {
  throw new ReviewWaiverError(code, status, message);
}

function latestValidReportForChange(db: ReviewWaiverDb, changeId: string) {
  const state = db.select().from(reviewState).where(eq(reviewState.changeId, changeId)).get();
  if (!state?.latestValidReviewReportId) return { state, report: null, attempt: null };
  const report =
    db
      .select()
      .from(reviewReports)
      .where(eq(reviewReports.id, state.latestValidReviewReportId))
      .get() ?? null;
  const attempt = report
    ? db.select().from(reviewAttempts).where(eq(reviewAttempts.id, report.attemptId)).get() ?? null
    : null;
  return { state, report, attempt };
}

function assertReviewP1IsInLatestSettlement(
  db: ReviewWaiverDb,
  changeId: string,
  findingId: string,
) {
  const { state, report, attempt } = latestValidReportForChange(db, changeId);
  if (!state || !report || !attempt || attempt.changeId !== changeId || report.changeId !== changeId) {
    fail(
      "review_latest_valid_report_missing",
      409,
      "P1 review finding is not from the latest valid review report",
    );
  }
  const reviewFindings = db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all()
    .filter((finding) => finding.source === "review");
  const settlement = settlementFindingsForReviewAttempt(attempt, reviewFindings);
  if (!settlement.some((finding) => finding.id === findingId)) {
    fail(
      "review_finding_not_latest",
      409,
      "P1 review finding is not from the latest valid review report",
    );
  }
  return { state, report, attempt };
}

function markRelatedReportsStale(
  db: ReviewWaiverDb,
  changeId: string,
  state: typeof reviewState.$inferSelect | null,
  latestAttempt: typeof reviewAttempts.$inferSelect,
  findingId: string,
  now: string,
) {
  const candidateIds = new Set<string>();
  if (state?.latestReportId) candidateIds.add(state.latestReportId);
  if (state?.latestValidReviewReportId) candidateIds.add(state.latestValidReviewReportId);

  const reviewFindings = db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all()
    .filter((finding) => finding.source === "review");
  const latestSettlement = settlementFindingsForReviewAttempt(latestAttempt, reviewFindings);
  const nextFindingVersion = maxFindingVersion(latestSettlement);
  const nextWaiverVersion = currentWaiverVersion(latestSettlement);

  for (const report of db.select().from(reviewReports).where(eq(reviewReports.changeId, changeId)).all()) {
    if (report.gateStatus === "stale" || candidateIds.has(report.id)) continue;
    const attempt = db
      .select()
      .from(reviewAttempts)
      .where(eq(reviewAttempts.id, report.attemptId))
      .get();
    if (!attempt || attempt.changeId !== changeId) continue;
    const settlement = settlementFindingsForReviewAttempt(attempt, reviewFindings);
    if (settlement.some((finding) => finding.id === findingId)) candidateIds.add(report.id);
  }

  for (const reportId of candidateIds) {
    const report = db.select().from(reviewReports).where(eq(reviewReports.id, reportId)).get();
    if (!report || report.changeId !== changeId) continue;
    db.update(reviewReports)
      .set({
        gateStatus: "stale",
        qaAllowed: 0,
        staleReason: staleReasonWith(report.staleReason, "p1_waiver_changed_findings"),
      })
      .where(eq(reviewReports.id, report.id))
      .run();
  }

  if (state) {
    db.update(reviewState)
      .set({
        gateStatus: "stale",
        waiverVersion: nextWaiverVersion,
        findingVersion: nextFindingVersion,
        updatedAt: now,
      })
      .where(eq(reviewState.changeId, changeId))
      .run();
  } else {
    db.insert(reviewState)
      .values({
        changeId,
        latestAttemptId: null,
        latestAttemptNo: null,
        latestReportId: null,
        latestValidReviewReportId: null,
        latestValidAttemptNo: null,
        gateStatus: "stale",
        reviewStatus: null,
        sourceBuildRunId: null,
        sourceHeadSha: null,
        reportDbHash: null,
        findingVersion: nextFindingVersion,
        waiverVersion: nextWaiverVersion,
        updatedAt: now,
      })
      .run();
  }
}

export function waiveReviewFinding(
  input: WaiveReviewFindingInput,
): WaiveReviewFindingResult {
  const db = getReviewWaiverDb();
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  const actor = typeof input.actor === "string" && input.actor.trim() ? input.actor.trim() : "human";

  let result: WaiveReviewFindingResult | null = null;
  db.transaction((tx) => {
    const txDb = tx as unknown as ReviewWaiverDb;
    const finding = txDb
      .select()
      .from(findings)
      .where(and(eq(findings.id, input.findingId), eq(findings.changeId, input.changeId)))
      .get();

    if (!finding) fail("finding_not_found", 404, "Finding not found");
    if (finding.status !== "open") {
      fail("finding_not_open", 400, `Finding is ${finding.status}, not open`);
    }
    if (UNWAIVABLE_SOURCES.has(finding.source)) {
      fail("finding_unwaivable_source", 403, "Scope findings cannot be waived");
    }
    if (finding.file && UNWAIVABLE_FILES.has(finding.file)) {
      fail("finding_unwaivable_file", 403, `Findings on ${finding.file} cannot be waived`);
    }

    let decisionId: string | null = null;
    let state = txDb.select().from(reviewState).where(eq(reviewState.changeId, input.changeId)).get() ?? null;
    let reviewAttemptId = finding.reviewAttemptId;
    let sourceBuildRunId = finding.sourceBuildRunId;
    let latestSettlementAttempt: typeof reviewAttempts.$inferSelect | null = null;

    if (finding.source === "review") {
      if (finding.severity === "P0") {
        fail("review_p0_waiver_not_allowed", 403, "P0 review findings cannot be waived");
      }
      if (finding.severity !== "P1") {
        fail("review_finding_not_waivable", 422, "Only P1 review findings can be waived");
      }
      if (!reason) {
        fail("review_p1_waiver_reason_required", 422, "P1 review findings require a waiver reason");
      }
      const latest = assertReviewP1IsInLatestSettlement(txDb, input.changeId, input.findingId);
      state = latest.state;
      latestSettlementAttempt = latest.attempt;
      reviewAttemptId = finding.reviewAttemptId ?? latest.attempt.id;
      sourceBuildRunId = finding.sourceBuildRunId ?? latest.attempt.sourceBuildRunId;

      decisionId = nextHumanDecisionId(txDb);
      txDb.insert(humanDecisions).values({
        id: decisionId,
        changeId: input.changeId,
        roundId: null,
        gate: "review",
        action: "review_p1_waiver",
        targetType: "finding",
        targetId: input.findingId,
        reason,
        reportHash: latest.report.reportDbHash,
        createdBy: actor,
        createdAt: nowISO(),
      }).run();
    }

    const now = nowISO();
    const nextFindingVersion = finding.findingVersion + 1;
    txDb.update(findings)
      .set({
        status: "waived",
        waivedBy: finding.source === "review" ? actor : finding.waivedBy,
        waivedAt: finding.source === "review" ? now : finding.waivedAt,
        waiverDecisionId: decisionId,
        updatedAt: now,
        findingVersion: nextFindingVersion,
      })
      .where(eq(findings.id, input.findingId))
      .run();

    let waiverVersion = state?.waiverVersion ?? 1;
    if (finding.source === "review") {
      if (!latestSettlementAttempt) fail("review_attempt_missing", 409, "Review attempt is missing");
      markRelatedReportsStale(txDb, input.changeId, state, latestSettlementAttempt, input.findingId, now);
      const updatedState = txDb
        .select()
        .from(reviewState)
        .where(eq(reviewState.changeId, input.changeId))
        .get();
      waiverVersion = updatedState?.waiverVersion ?? waiverVersion + 1;
    }

    const eventId = nextEventId(txDb);
    txDb.insert(events).values({
      id: eventId,
      changeId: input.changeId,
      runId: null,
      type: "finding_waived",
      message: `Finding ${input.findingId} waived`,
      rawJson: JSON.stringify({
        findingId: input.findingId,
        changeId: input.changeId,
        actor,
        reason: reason || null,
        decisionId,
        reviewAttemptId: finding.source === "review" ? reviewAttemptId : null,
        reviewRunId: finding.source === "review" ? finding.runId : null,
        sourceReviewRunId: finding.source === "review" ? finding.runId : null,
        sourceBuildRunId: finding.source === "review" ? sourceBuildRunId : null,
        createdAt: now,
      }),
      createdAt: now,
    }).run();

    result = {
      findingId: input.findingId,
      decisionId: decisionId ?? "",
      status: "waived",
      waiverVersion,
      reportStale: true,
    };
  });

  if (!result) throw new Error("Failed to waive review finding");
  return result;
}
