import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { and, eq } from "drizzle-orm";

import {
  apiSnapshots,
  buildRunRecords,
  findings,
  planRisks,
  planSnapshots,
  planSteps,
  requiredValidationCommands,
  reviewAttempts,
  reviewPriorFindingReviews,
  techspecSnapshots,
  testplanCoverageItems,
  testplanManualChecks,
  testplanRiskMappings,
  testplanSnapshots,
} from "../db/schema";
import {
  completePriorFindingCoverage,
  InvalidReviewOutputError,
  parsePriorBlockingFindingIds,
  parseReviewStructuredOutput,
} from "./review-structured-output-parser";
import type {
  ReviewFindingSeverity,
  ReviewStructuredOutput,
  ReviewStructuredPriorFindingReview,
} from "./review-structured-output-parser";

export { parseReviewStructuredOutput } from "./review-structured-output-parser";
export type {
  PriorFindingReviewVerdict,
  ReviewFindingSeverity,
  ReviewStructuredFinding,
  ReviewStructuredOutput,
  ReviewStructuredPriorFindingReview,
} from "./review-structured-output-parser";

type ReviewRunDb = typeof import("../db/index").db;

export type ReviewAttempt = typeof reviewAttempts.$inferSelect;
export type ReviewAttemptReviewStatus =
  | "running"
  | "failed"
  | "invalid_output"
  | "data_inconsistent"
  | "passed"
  | "issues_found";

export interface StartReviewRunInput {
  changeId: string;
  idempotencyKey?: string;
  provider?: string;
  runId?: string | null;
  sourceBuildRunId?: string | null;
  sourceHeadSha?: string | null;
}

interface ReviewInputSnapshot {
  sourceBuildRunId: string | null;
  sourceHeadSha: string | null;
  inputSourceDbHash: string;
  inputSourceLineageJson: string;
}

export interface StartReviewRunResult {
  attempt: ReviewAttempt;
  idempotencyKey: string;
  started: boolean;
  resumed: boolean;
  conflict: boolean;
}

export interface CompleteReviewAttemptInput {
  attemptId: string;
  reviewStatus: "passed" | "issues_found";
  rawOutputArtifactId?: string | null;
}

export interface CompleteReviewAttemptFromStructuredOutputInput {
  attemptId: string;
  runId: string;
  structuredOutput: unknown;
  rawOutputArtifactId?: string | null;
}

export interface CompletedReviewStructuredOutput {
  attempt: ReviewAttempt;
  reviewStatus: "passed" | "issues_found";
  approved: boolean;
  summary: string;
  findings: Array<{
    findingId: string;
    sourceReviewRunId: string;
    severity: ReviewFindingSeverity;
    status: "open";
    category: string;
    file: string | null;
    line: number | null;
    title: string;
    evidence: string;
    requiredFix: string | null;
    waivable: boolean;
  }>;
}

export interface FailReviewAttemptInput {
  attemptId: string;
  errorCode: string;
  sanitizedErrorSummary: string;
  rawOutputArtifactId?: string | null;
}

export interface InvalidReviewOutputInput {
  attemptId: string;
  sanitizedErrorSummary: string;
  rawOutputArtifactId?: string | null;
}

const requireDefaultDb = createRequire(import.meta.url);
let reviewRunDbForTest: ReviewRunDb | null = null;
let defaultReviewRunDb: ReviewRunDb | null = null;

export function setReviewRunServiceDbForTest(nextDb: ReviewRunDb): () => void {
  const previous = reviewRunDbForTest;
  reviewRunDbForTest = nextDb;
  return () => {
    reviewRunDbForTest = previous;
  };
}

function getReviewRunDb(): ReviewRunDb {
  if (reviewRunDbForTest) return reviewRunDbForTest;
  if (!defaultReviewRunDb) {
    defaultReviewRunDb = (requireDefaultDb("../db/index") as typeof import("../db/index")).db;
  }
  return defaultReviewRunDb;
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

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function nextReviewAttemptId(db: ReviewRunDb): string {
  return nextPrefixedId(
    db.select({ id: reviewAttempts.id }).from(reviewAttempts).all().map((row) => row.id),
    "RAT",
  );
}

function nextPriorReviewId(db: ReviewRunDb): string {
  return nextPrefixedId(
    db
      .select({ id: reviewPriorFindingReviews.id })
      .from(reviewPriorFindingReviews)
      .all()
      .map((row) => row.id),
    "RPF",
  );
}

function nextFindingId(db: ReviewRunDb): string {
  return nextPrefixedId(
    db.select({ id: findings.id }).from(findings).all().map((row) => row.id),
    "FND",
  );
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

function nextAttemptNo(db: ReviewRunDb, changeId: string): number {
  return db
    .select({ attemptNo: reviewAttempts.attemptNo })
    .from(reviewAttempts)
    .where(eq(reviewAttempts.changeId, changeId))
    .all()
    .reduce((max, row) => Math.max(max, row.attemptNo), 0) + 1;
}

function findAttemptByIdempotencyKey(
  db: ReviewRunDb,
  changeId: string,
  idempotencyKey: string,
): ReviewAttempt | null {
  return (
    db
      .select()
      .from(reviewAttempts)
      .where(
        and(
          eq(reviewAttempts.changeId, changeId),
          eq(reviewAttempts.idempotencyKey, idempotencyKey),
        ),
      )
      .get() ?? null
  );
}

function findRunningAttempt(db: ReviewRunDb, changeId: string): ReviewAttempt | null {
  return (
    db
      .select()
      .from(reviewAttempts)
      .where(and(eq(reviewAttempts.changeId, changeId), eq(reviewAttempts.status, "running")))
      .get() ?? null
  );
}

function updateAttemptStartMetadata(
  db: ReviewRunDb,
  attempt: ReviewAttempt,
  input: StartReviewRunInput,
): ReviewAttempt {
  const shouldUpdate =
    (input.runId !== undefined && attempt.runId !== input.runId) ||
    (input.provider !== undefined && attempt.provider !== input.provider);

  if (!shouldUpdate || attempt.status !== "running") return attempt;

  const updatedAt = nowISO();
  db.update(reviewAttempts)
    .set({
      runId: input.runId ?? attempt.runId,
      provider: input.provider ?? attempt.provider,
      updatedAt,
    })
    .where(eq(reviewAttempts.id, attempt.id))
    .run();

  return db.select().from(reviewAttempts).where(eq(reviewAttempts.id, attempt.id)).get() ?? attempt;
}

function latestByCreatedAt<T extends { createdAt: string; id: string }>(rows: T[]): T | null {
  return [...rows].sort((left, right) => {
    const created = right.createdAt.localeCompare(left.createdAt);
    if (created !== 0) return created;
    return right.id.localeCompare(left.id);
  })[0] ?? null;
}

function latestApprovedPlanSnapshot(db: ReviewRunDb, changeId: string) {
  const rows = db
    .select()
    .from(planSnapshots)
    .where(eq(planSnapshots.changeId, changeId))
    .all()
    .filter((row) => row.status === "approved");
  return [...rows].sort((left, right) => {
    const approved = (right.approvedAt ?? "").localeCompare(left.approvedAt ?? "");
    if (approved !== 0) return approved;
    const created = right.createdAt.localeCompare(left.createdAt);
    if (created !== 0) return created;
    return right.id.localeCompare(left.id);
  })[0] ?? null;
}

function latestApprovedTestPlanSnapshot(db: ReviewRunDb, changeId: string) {
  const rows = db
    .select()
    .from(testplanSnapshots)
    .where(eq(testplanSnapshots.changeId, changeId))
    .all()
    .filter((row) => row.approvalState === "approved" || row.status === "approved");
  return [...rows].sort((left, right) => {
    const approved = (right.approvedAt ?? "").localeCompare(left.approvedAt ?? "");
    if (approved !== 0) return approved;
    const created = right.createdAt.localeCompare(left.createdAt);
    if (created !== 0) return created;
    return right.id.localeCompare(left.id);
  })[0] ?? null;
}

function latestDesignSnapshot<T extends { status: string; createdAt: string; id: string }>(
  rows: T[],
): T | null {
  const authoritative = rows.filter((row) =>
    ["approved", "pass", "passed"].includes(row.status),
  );
  return latestByCreatedAt(authoritative);
}

function latestApprovedBuildRun(db: ReviewRunDb, changeId: string) {
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

function buildIdentity(record: typeof buildRunRecords.$inferSelect | null): string | null {
  if (!record) return null;
  return record.buildRunId ?? record.id;
}

function planInputRows(db: ReviewRunDb, snapshotId: string | null) {
  if (!snapshotId) return { steps: [], risks: [], commands: [] };
  return {
    steps: db.select().from(planSteps).where(eq(planSteps.planSnapshotId, snapshotId)).all(),
    risks: db.select().from(planRisks).where(eq(planRisks.planSnapshotId, snapshotId)).all(),
    commands: db
      .select()
      .from(requiredValidationCommands)
      .where(eq(requiredValidationCommands.sourceSnapshotId, snapshotId))
      .all()
      .filter((command) => command.phase === "Plan")
      .sort((left, right) => left.commandOrder - right.commandOrder || left.id.localeCompare(right.id)),
  };
}

function testPlanInputRows(db: ReviewRunDb, snapshotId: string | null) {
  if (!snapshotId) {
    return { coverageItems: [], riskMappings: [], manualChecks: [], commands: [] };
  }
  return {
    coverageItems: db
      .select()
      .from(testplanCoverageItems)
      .where(eq(testplanCoverageItems.testplanSnapshotId, snapshotId))
      .all(),
    riskMappings: db
      .select()
      .from(testplanRiskMappings)
      .where(eq(testplanRiskMappings.testplanSnapshotId, snapshotId))
      .all(),
    manualChecks: db
      .select()
      .from(testplanManualChecks)
      .where(eq(testplanManualChecks.testplanSnapshotId, snapshotId))
      .all(),
    commands: db
      .select()
      .from(requiredValidationCommands)
      .where(eq(requiredValidationCommands.sourceSnapshotId, snapshotId))
      .all()
      .filter((command) => command.phase === "TestPlan")
      .sort((left, right) => left.commandOrder - right.commandOrder || left.id.localeCompare(right.id)),
  };
}

export function buildReviewInputSnapshot(
  db: ReviewRunDb,
  changeId: string,
  priorFindingIds: string[],
): ReviewInputSnapshot {
  const latestBuild = latestApprovedBuildRun(db, changeId);
  const planSnapshot = latestApprovedPlanSnapshot(db, changeId);
  const testPlanSnapshot = latestApprovedTestPlanSnapshot(db, changeId);
  const techSpecSnapshot = latestDesignSnapshot(
    db.select().from(techspecSnapshots).where(eq(techspecSnapshots.changeId, changeId)).all(),
  );
  const apiSnapshot = latestDesignSnapshot(
    db.select().from(apiSnapshots).where(eq(apiSnapshots.changeId, changeId)).all(),
  );
  const priorFindingIdSet = new Set(priorFindingIds);
  const historicalFindings = db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all()
    .filter((finding) => finding.source === "review" && priorFindingIdSet.has(finding.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((finding) => ({
      id: finding.id,
      source: finding.source,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      file: finding.file,
      line: finding.line,
      evidence: finding.evidence,
      requiredFix: finding.requiredFix,
      reviewAttemptId: finding.reviewAttemptId,
      sourceBuildRunId: finding.sourceBuildRunId,
      sourceHeadSha: finding.sourceHeadSha,
      waivable: finding.waivable,
      createdAt: finding.createdAt,
    }));
  const planRows = planInputRows(db, planSnapshot?.id ?? null);
  const testPlanRows = testPlanInputRows(db, testPlanSnapshot?.id ?? null);

  const lineage = {
    latestApprovedBuildRun: latestBuild
      ? {
          id: latestBuild.id,
          buildRunId: buildIdentity(latestBuild),
          status: latestBuild.status,
          headSha: latestBuild.headSha,
          baseCommit: latestBuild.baseCommit,
          patchHash: latestBuild.patchHash,
          changedFilesHash: latestBuild.changedFilesHash,
          adoptedHeadSha: latestBuild.adoptedHeadSha,
          adoptedAt: latestBuild.adoptedAt,
        }
      : null,
    planSnapshot: planSnapshot
      ? { id: planSnapshot.id, snapshotDbHash: planSnapshot.snapshotDbHash }
      : null,
    testPlanSnapshot: testPlanSnapshot
      ? { id: testPlanSnapshot.id, snapshotDbHash: testPlanSnapshot.snapshotDbHash }
      : null,
    techSpecSnapshot: techSpecSnapshot
      ? { id: techSpecSnapshot.id, contentDbHash: techSpecSnapshot.contentDbHash }
      : null,
    apiSnapshot: apiSnapshot
      ? { id: apiSnapshot.id, contractDbHash: apiSnapshot.contractDbHash }
      : null,
    historicalFindingIds: priorFindingIds,
  };
  const sourceFacts = {
    latestApprovedBuildRun: latestBuild,
    planSnapshot,
    planRows,
    testPlanSnapshot,
    testPlanRows,
    techSpecSnapshot,
    apiSnapshot,
    historicalFindings,
    frozenPriorFindingIds: priorFindingIds,
  };

  return {
    sourceBuildRunId: buildIdentity(latestBuild),
    sourceHeadSha: latestBuild?.status === "approved_for_absorb"
      ? latestBuild.baseCommit ?? latestBuild.baseHeadSha ?? null
      : latestBuild?.adoptedHeadSha ?? latestBuild?.headSha ?? latestBuild?.baseCommit ?? null,
    inputSourceDbHash: sha256(sourceFacts),
    inputSourceLineageJson: stableJson(lineage),
  };
}

function openBlockingReviewFindingIds(db: ReviewRunDb, changeId: string): string[] {
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
    .map((finding) => finding.id)
    .sort();
}

function ensurePendingPriorReviews(
  db: ReviewRunDb,
  attemptId: string,
  frozenPriorFindingIds: string[],
): void {
  const pendingRows = db
    .select()
    .from(reviewPriorFindingReviews)
    .where(eq(reviewPriorFindingReviews.attemptId, attemptId))
    .all();
  const pendingByFindingId = new Map(pendingRows.map((row) => [row.priorFindingId, row]));
  for (const findingId of frozenPriorFindingIds) {
    const row = pendingByFindingId.get(findingId);
    if (!row || row.verdict !== "pending") {
      throw new InvalidReviewOutputError(`pending prior review missing for ${findingId}`);
    }
  }
}

function validateReplacementFindingReferences(
  db: ReviewRunDb,
  priorFindingReviews: ReviewStructuredPriorFindingReview[],
): void {
  for (const priorReview of priorFindingReviews) {
    if (!priorReview.replacementFindingId) continue;
    const replacement = db
      .select({ id: findings.id })
      .from(findings)
      .where(eq(findings.id, priorReview.replacementFindingId))
      .get();
    if (!replacement) {
      throw new InvalidReviewOutputError(
        `priorFindingReviews replacementFindingId does not exist: ${priorReview.replacementFindingId}`,
      );
    }
  }
}

function insertPendingPriorReviews(
  db: ReviewRunDb,
  attemptId: string,
  priorFindingIds: string[],
): void {
  for (const priorFindingId of priorFindingIds) {
    db.insert(reviewPriorFindingReviews)
      .values({
        id: nextPriorReviewId(db),
        attemptId,
        priorFindingId,
        verdict: "pending",
        evidence: null,
        requiredFix: null,
        replacementFindingId: null,
        reviewerNotes: null,
        createdAt: nowISO(),
      })
      .onConflictDoNothing()
      .run();
    const pendingReview = db
      .select({ id: reviewPriorFindingReviews.id })
      .from(reviewPriorFindingReviews)
      .where(
        and(
          eq(reviewPriorFindingReviews.attemptId, attemptId),
          eq(reviewPriorFindingReviews.priorFindingId, priorFindingId),
        ),
      )
      .get();
    if (!pendingReview) {
      throw new Error(
        `Failed to create pending prior review for attempt ${attemptId} and finding ${priorFindingId}`,
      );
    }
  }
}

function sqliteConstraintConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    ("code" in error ? (error as Error & { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" : false)
  );
}

export function startReviewRun(input: StartReviewRunInput): StartReviewRunResult {
  const db = getReviewRunDb();
  const idempotencyKey = input.idempotencyKey?.trim() || `review-${randomUUID()}`;

  const existingForKey = findAttemptByIdempotencyKey(db, input.changeId, idempotencyKey);
  if (existingForKey) {
    return {
      attempt: updateAttemptStartMetadata(db, existingForKey, input),
      idempotencyKey,
      started: false,
      resumed: true,
      conflict: false,
    };
  }

  const runningAttempt = findRunningAttempt(db, input.changeId);
  if (runningAttempt) {
    return {
      attempt: runningAttempt,
      idempotencyKey,
      started: false,
      resumed: false,
      conflict: true,
    };
  }

  const priorFindingIds = openBlockingReviewFindingIds(db, input.changeId);
  const inputSnapshot = buildReviewInputSnapshot(db, input.changeId, priorFindingIds);
  const now = nowISO();
  const id = nextReviewAttemptId(db);
  const values = {
    id,
    changeId: input.changeId,
    runId: input.runId ?? null,
    attemptNo: nextAttemptNo(db, input.changeId),
    status: "running",
    provider: input.provider ?? "codex",
    reviewStatus: "running",
    idempotencyKey,
    sourceBuildRunId: inputSnapshot.sourceBuildRunId,
    sourceHeadSha: inputSnapshot.sourceHeadSha,
    inputSourceDbHash: inputSnapshot.inputSourceDbHash,
    inputSourceLineageJson: inputSnapshot.inputSourceLineageJson,
    priorBlockingFindingIdsJson: JSON.stringify(priorFindingIds),
    rawOutputArtifactId: null,
    errorCode: null,
    sanitizedErrorSummary: null,
    startedAt: now,
    endedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    db.transaction((tx) => {
      const txDb = tx as unknown as ReviewRunDb;
      tx.insert(reviewAttempts).values(values).run();
      insertPendingPriorReviews(txDb, id, priorFindingIds);
    });
  } catch (error) {
    if (!sqliteConstraintConflict(error)) throw error;
    const sameKey = findAttemptByIdempotencyKey(db, input.changeId, idempotencyKey);
    if (sameKey) {
      return {
        attempt: updateAttemptStartMetadata(db, sameKey, input),
        idempotencyKey,
        started: false,
        resumed: true,
        conflict: false,
      };
    }
    const existingRunning = findRunningAttempt(db, input.changeId);
    if (existingRunning) {
      return {
        attempt: existingRunning,
        idempotencyKey,
        started: false,
        resumed: false,
        conflict: true,
      };
    }
    throw error;
  }

  const attempt = db.select().from(reviewAttempts).where(eq(reviewAttempts.id, id)).get();
  if (!attempt) throw new Error(`Failed to create review attempt for change ${input.changeId}`);
  return { attempt, idempotencyKey, started: true, resumed: false, conflict: false };
}

export function completeReviewAttemptFromStructuredOutput(
  input: CompleteReviewAttemptFromStructuredOutputInput,
): CompletedReviewStructuredOutput {
  const db = getReviewRunDb();
  const rawOutputArtifactId = requireRawOutputArtifactId(input.rawOutputArtifactId, input.attemptId);
  const attempt = db.select().from(reviewAttempts).where(eq(reviewAttempts.id, input.attemptId)).get();
  if (!attempt) throw new Error(`Review attempt not found: ${input.attemptId}`);
  if (attempt.status !== "running") {
    throw new Error(`review_attempt_not_running: ${input.attemptId}`);
  }

  let parsed: ReviewStructuredOutput;
  let frozenPriorFindingIds: string[];
  try {
    parsed = parseReviewStructuredOutput(input.structuredOutput);
    frozenPriorFindingIds = parsePriorBlockingFindingIds(attempt);
    parsed = {
      ...parsed,
      priorFindingReviews: completePriorFindingCoverage(
        frozenPriorFindingIds,
        parsed.priorFindingReviews,
      ),
    };
    ensurePendingPriorReviews(db, input.attemptId, frozenPriorFindingIds);
    validateReplacementFindingReferences(db, parsed.priorFindingReviews);
  } catch (error) {
    if (error instanceof InvalidReviewOutputError) {
      recordInvalidReviewOutput({
        attemptId: input.attemptId,
        sanitizedErrorSummary: error.message,
        rawOutputArtifactId,
      });
    }
    throw error;
  }

  let nextIdSeed = nextFindingId(db);
  const allocatedFindingIds: string[] = [];
  const allocateFindingId = () => {
    const id = nextIdSeed;
    allocatedFindingIds.push(id);
    nextIdSeed = nextPrefixedId(allocatedFindingIds.concat([nextIdSeed]), "FND");
    return id;
  };

  const stagedFindings = parsed.findings.map((finding) => ({
    findingId: allocateFindingId(),
    sourceReviewRunId: input.runId,
    severity: finding.severity,
    status: "open" as const,
    category: finding.category,
    file: finding.file,
    line: finding.line,
    title: finding.title,
    evidence: finding.evidence,
    requiredFix: finding.requiredFix,
    waivable: finding.severity === "P1",
  }));
  const leavesPriorBlockerOpen = parsed.priorFindingReviews.some(
    (review) => review.verdict !== "fixed",
  );
  const hasNewBlockingFinding = stagedFindings.some(
    (finding) => finding.severity === "P0" || finding.severity === "P1",
  );
  const approved = parsed.approved && !hasNewBlockingFinding && !leavesPriorBlockerOpen;
  const reviewStatus: "passed" | "issues_found" = approved ? "passed" : "issues_found";
  const completedAt = nowISO();

  db.transaction((tx) => {
    for (const finding of stagedFindings) {
      tx.insert(findings).values({
        id: finding.findingId,
        changeId: attempt.changeId,
        runId: input.runId,
        source: "review",
        severity: finding.severity,
        category: finding.category,
        title: finding.title,
        file: finding.file,
        line: finding.line,
        evidence: finding.evidence,
        requiredFix: finding.requiredFix,
        status: "open",
        createdAt: completedAt,
        updatedAt: completedAt,
        reviewAttemptId: input.attemptId,
        sourceBuildRunId: attempt.sourceBuildRunId,
        sourceHeadSha: attempt.sourceHeadSha,
        waivable: finding.waivable ? 1 : 0,
      }).run();
    }

    for (const priorReview of parsed.priorFindingReviews) {
      tx.update(reviewPriorFindingReviews)
        .set({
          verdict: priorReview.verdict,
          evidence: priorReview.evidence,
          requiredFix: priorReview.requiredFix ?? null,
          replacementFindingId: priorReview.replacementFindingId ?? null,
          reviewerNotes: priorReview.reviewerNotes ?? null,
        })
        .where(
          and(
            eq(reviewPriorFindingReviews.attemptId, input.attemptId),
            eq(reviewPriorFindingReviews.priorFindingId, priorReview.priorFindingId),
          ),
        )
        .run();

      if (priorReview.verdict === "fixed") {
        tx.update(findings)
          .set({
            status: "fixed",
            updatedAt: completedAt,
          })
          .where(eq(findings.id, priorReview.priorFindingId))
          .run();
      }
    }

    tx.update(reviewAttempts)
      .set({
        status: "completed",
        reviewStatus,
        errorCode: null,
        sanitizedErrorSummary: null,
        rawOutputArtifactId,
        endedAt: completedAt,
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(reviewAttempts.id, input.attemptId))
      .run();
  });

  const completedAttempt = db.select().from(reviewAttempts).where(eq(reviewAttempts.id, input.attemptId)).get();
  if (!completedAttempt) throw new Error(`Review attempt not found after completion: ${input.attemptId}`);
  return {
    attempt: completedAttempt,
    reviewStatus,
    approved,
    summary: parsed.summary,
    findings: stagedFindings,
  };
}

function requireRawOutputArtifactId(rawOutputArtifactId: string | null | undefined, attemptId: string): string {
  if (typeof rawOutputArtifactId === "string" && rawOutputArtifactId.trim()) {
    return rawOutputArtifactId;
  }
  throw new Error(`review_attempt_raw_output_artifact_required: ${attemptId}`);
}

export function completeReviewAttempt(input: CompleteReviewAttemptInput): ReviewAttempt {
  return finishReviewAttempt(input.attemptId, {
    status: "completed",
    reviewStatus: input.reviewStatus,
    errorCode: null,
    sanitizedErrorSummary: null,
    rawOutputArtifactId: input.rawOutputArtifactId ?? null,
    completedAt: nowISO(),
  });
}

export function failReviewAttempt(input: FailReviewAttemptInput): ReviewAttempt {
  return finishReviewAttempt(input.attemptId, {
    status: "failed",
    reviewStatus: "failed",
    errorCode: input.errorCode,
    sanitizedErrorSummary: input.sanitizedErrorSummary,
    rawOutputArtifactId: input.rawOutputArtifactId ?? null,
    completedAt: null,
  });
}

export function recordInvalidReviewOutput(input: InvalidReviewOutputInput): ReviewAttempt {
  return finishReviewAttempt(input.attemptId, {
    status: "failed",
    reviewStatus: "invalid_output",
    errorCode: "invalid_review_output",
    sanitizedErrorSummary: input.sanitizedErrorSummary,
    rawOutputArtifactId: input.rawOutputArtifactId ?? null,
    completedAt: null,
  });
}

function finishReviewAttempt(
  attemptId: string,
  values: {
    status: string;
    reviewStatus: ReviewAttemptReviewStatus;
    errorCode: string | null;
    sanitizedErrorSummary: string | null;
    rawOutputArtifactId: string | null;
    completedAt: string | null;
  },
): ReviewAttempt {
  const db = getReviewRunDb();
  const endedAt = nowISO();
  db.update(reviewAttempts)
    .set({
      status: values.status,
      reviewStatus: values.reviewStatus,
      errorCode: values.errorCode,
      sanitizedErrorSummary: values.sanitizedErrorSummary,
      rawOutputArtifactId: values.rawOutputArtifactId,
      endedAt,
      completedAt: values.completedAt,
      updatedAt: endedAt,
    })
    .where(eq(reviewAttempts.id, attemptId))
    .run();

  const attempt = db.select().from(reviewAttempts).where(eq(reviewAttempts.id, attemptId)).get();
  if (!attempt) throw new Error(`Review attempt not found: ${attemptId}`);
  return attempt;
}
