export type ReviewRunStatus =
  | "running"
  | "passed"
  | "issues_found"
  | "failed"
  | "invalid_output"
  | "data_inconsistent";

export interface ParsedReviewSummary {
  valid: boolean;
  reviewStatus: Exclude<ReviewRunStatus, "running"> | null;
  sourceBuildRunId: string | null;
  reportPath: string | null;
  findingsPath: string | null;
  rawOutputPath: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  findingCount: number;
}

export const REVIEW_SUMMARY_STATUSES = new Set<Exclude<ReviewRunStatus, "running">>([
  "failed",
  "invalid_output",
  "data_inconsistent",
  "issues_found",
  "passed",
]);

export const VALID_REVIEW_STATUSES = new Set<ReviewRunStatus>(["passed", "issues_found"]);

export function runSequence(runId: string): number {
  const match = runId.match(/^RUN-(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export function compareRunsDesc(
  left: { id: string; startedAt: string | null; endedAt: string | null },
  right: { id: string; startedAt: string | null; endedAt: string | null }
): number {
  const sequenceDelta = runSequence(right.id) - runSequence(left.id);
  if (sequenceDelta !== 0) return sequenceDelta;
  const rightTime = right.startedAt ?? right.endedAt ?? "";
  const leftTime = left.startedAt ?? left.endedAt ?? "";
  return rightTime.localeCompare(leftTime);
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseReviewSummary(summary: string | null): ParsedReviewSummary {
  if (!summary) {
    return emptyParsedSummary(false);
  }

  try {
    const parsed = JSON.parse(summary) as {
      reviewStatus?: unknown;
      sourceBuildRunId?: unknown;
      reportPath?: unknown;
      findingsPath?: unknown;
      rawOutputPath?: unknown;
      errorCode?: unknown;
      errorMessage?: unknown;
      sanitizedErrorSummary?: unknown;
      findingCount?: unknown;
    };
    if (
      typeof parsed.reviewStatus !== "string" ||
      !REVIEW_SUMMARY_STATUSES.has(parsed.reviewStatus as Exclude<ReviewRunStatus, "running">)
    ) {
      return emptyParsedSummary(false);
    }
    if (
      (parsed.reviewStatus === "passed" || parsed.reviewStatus === "issues_found") &&
      (typeof parsed.findingCount !== "number" || !Number.isFinite(parsed.findingCount))
    ) {
      return emptyParsedSummary(false);
    }

    return {
      valid: true,
      reviewStatus: parsed.reviewStatus as Exclude<ReviewRunStatus, "running">,
      sourceBuildRunId: stringOrNull(parsed.sourceBuildRunId),
      reportPath: stringOrNull(parsed.reportPath),
      findingsPath: stringOrNull(parsed.findingsPath),
      rawOutputPath: stringOrNull(parsed.rawOutputPath),
      errorCode: stringOrNull(parsed.errorCode),
      errorMessage: stringOrNull(parsed.sanitizedErrorSummary),
      findingCount: typeof parsed.findingCount === "number" && Number.isFinite(parsed.findingCount) ? parsed.findingCount : 0,
    };
  } catch {
    return emptyParsedSummary(false);
  }
}

export function emptyParsedSummary(valid: boolean): ParsedReviewSummary {
  return {
    valid,
    reviewStatus: null,
    sourceBuildRunId: null,
    reportPath: null,
    findingsPath: null,
    rawOutputPath: null,
    errorCode: null,
    errorMessage: null,
    findingCount: 0,
  };
}
