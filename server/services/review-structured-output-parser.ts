export type ReviewFindingSeverity = "P0" | "P1" | "P2";
export type PriorFindingReviewVerdict =
  | "still_open"
  | "fixed"
  | "downgraded"
  | "not_reviewable"
  | "not_rechecked";

export interface ReviewStructuredFinding {
  severity: ReviewFindingSeverity;
  category: string;
  file: string | null;
  line: number | null;
  title: string;
  evidence: string;
  requiredFix: string | null;
}

export interface ReviewStructuredPriorFindingReview {
  priorFindingId: string;
  verdict: PriorFindingReviewVerdict;
  evidence: string | null;
  requiredFix?: string | null;
  replacementFindingId?: string | null;
  reviewerNotes?: string | null;
}

export interface ReviewStructuredOutput {
  findings: ReviewStructuredFinding[];
  priorFindingReviews: ReviewStructuredPriorFindingReview[];
  approved: boolean;
  summary: string;
}

export class InvalidReviewOutputError extends Error {
  constructor(message: string) {
    super(`invalid_review_output: ${message}`);
    this.name = "InvalidReviewOutputError";
  }
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidReviewOutputError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new InvalidReviewOutputError(`${label} has unsupported fields: ${unknown.join(", ")}`);
  }
}

export function parseReviewSeverity(value: unknown): ReviewFindingSeverity {
  if (value === "P0" || value === "P1" || value === "P2") return value;
  throw new InvalidReviewOutputError("finding severity must be P0, P1, or P2");
}

export function parseReviewFinding(value: unknown, index: number): ReviewStructuredFinding {
  const finding = requirePlainObject(value, `findings[${index}]`);
  rejectUnknownKeys(
    finding,
    ["severity", "category", "file", "line", "title", "evidence", "requiredFix"],
    `findings[${index}]`,
  );
  if ("suggestion" in finding || "recommendation" in finding) {
    throw new InvalidReviewOutputError("new findings must use requiredFix, not suggestion or recommendation");
  }

  const severity = parseReviewSeverity(finding.severity);
  const category = nonEmptyString(finding.category);
  const title = nonEmptyString(finding.title);
  const evidence = nonEmptyString(finding.evidence);
  if (!category || !title) {
    throw new InvalidReviewOutputError("finding requires severity, category, and title");
  }
  if (!evidence) {
    throw new InvalidReviewOutputError("findings require evidence");
  }
  if (!Object.prototype.hasOwnProperty.call(finding, "requiredFix")) {
    throw new InvalidReviewOutputError("findings require requiredFix");
  }
  if (finding.requiredFix !== null && typeof finding.requiredFix !== "string") {
    throw new InvalidReviewOutputError("requiredFix must be a string or null");
  }
  const requiredFix = nonEmptyString(finding.requiredFix);
  if ((severity === "P0" || severity === "P1") && !requiredFix) {
    throw new InvalidReviewOutputError("P0/P1 findings require a required fix");
  }
  if (finding.file !== null && typeof finding.file !== "string") {
    throw new InvalidReviewOutputError("finding file must be a string or null");
  }
  if (finding.line !== null && typeof finding.line !== "number") {
    throw new InvalidReviewOutputError("finding line must be a number or null");
  }

  return {
    severity,
    category,
    file: finding.file,
    line: finding.line,
    title,
    evidence,
    requiredFix,
  };
}

export function parsePriorVerdict(value: unknown): PriorFindingReviewVerdict {
  if (
    value === "still_open" ||
    value === "fixed" ||
    value === "downgraded" ||
    value === "not_reviewable" ||
    value === "not_rechecked"
  ) {
    return value;
  }
  throw new InvalidReviewOutputError("priorFindingReviews verdict is not allowed");
}

export function parsePriorFindingReview(
  value: unknown,
  index: number,
): ReviewStructuredPriorFindingReview {
  const review = requirePlainObject(value, `priorFindingReviews[${index}]`);
  rejectUnknownKeys(
    review,
    ["priorFindingId", "verdict", "evidence", "requiredFix", "replacementFindingId", "reviewerNotes"],
    `priorFindingReviews[${index}]`,
  );
  const priorFindingId = nonEmptyString(review.priorFindingId);
  if (!priorFindingId) {
    throw new InvalidReviewOutputError("priorFindingReviews require priorFindingId");
  }
  const verdict = parsePriorVerdict(review.verdict);
  const evidence = review.evidence === null ? null : nonEmptyString(review.evidence);
  if (verdict === "fixed" && !evidence) {
    throw new InvalidReviewOutputError("fixed priorFindingReviews require evidence");
  }
  const requiredFix =
    review.requiredFix === undefined || review.requiredFix === null
      ? null
      : nonEmptyString(review.requiredFix);
  const replacementFindingId =
    review.replacementFindingId === undefined || review.replacementFindingId === null
      ? null
      : nonEmptyString(review.replacementFindingId);
  const reviewerNotes =
    review.reviewerNotes === undefined || review.reviewerNotes === null
      ? null
      : nonEmptyString(review.reviewerNotes);
  if (!evidence && !reviewerNotes) {
    throw new InvalidReviewOutputError("priorFindingReviews require evidence or reviewerNotes");
  }
  if ((verdict === "still_open" || verdict === "downgraded") && !requiredFix) {
    throw new InvalidReviewOutputError("still_open and downgraded priorFindingReviews require requiredFix");
  }

  return {
    priorFindingId,
    verdict,
    evidence,
    requiredFix,
    replacementFindingId,
    reviewerNotes,
  };
}

export function parsePriorBlockingFindingIds(attempt: {
  priorBlockingFindingIdsJson: string | null;
}): string[] {
  try {
    const parsed = JSON.parse(attempt.priorBlockingFindingIdsJson ?? "[]") as unknown;
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
      return [...parsed].sort();
    }
  } catch {
    // Fall through to the normalized invalid output error below.
  }
  throw new InvalidReviewOutputError("attempt prior blocking finding snapshot is invalid");
}

export function parseReviewStructuredOutput(output: unknown): ReviewStructuredOutput {
  const candidate = requirePlainObject(output, "structuredOutput");
  rejectUnknownKeys(
    candidate,
    ["findings", "priorFindingReviews", "approved", "summary"],
    "structuredOutput",
  );
  if (!Array.isArray(candidate.findings)) {
    throw new InvalidReviewOutputError("findings must be an array");
  }
  if (!Array.isArray(candidate.priorFindingReviews)) {
    throw new InvalidReviewOutputError("priorFindingReviews must be an array");
  }
  if (typeof candidate.approved !== "boolean" || typeof candidate.summary !== "string") {
    throw new InvalidReviewOutputError("summary and approved are required");
  }

  return {
    findings: candidate.findings.map(parseReviewFinding),
    priorFindingReviews: candidate.priorFindingReviews.map(parsePriorFindingReview),
    approved: candidate.approved,
    summary: candidate.summary,
  };
}

export function completePriorFindingCoverage(
  frozenPriorFindingIds: string[],
  priorFindingReviews: ReviewStructuredPriorFindingReview[],
): ReviewStructuredPriorFindingReview[] {
  const expected = new Set(frozenPriorFindingIds);
  const seen = new Set<string>();
  for (const review of priorFindingReviews) {
    if (!expected.has(review.priorFindingId)) {
      throw new InvalidReviewOutputError(`priorFindingReviews included non-frozen finding ${review.priorFindingId}`);
    }
    if (seen.has(review.priorFindingId)) {
      throw new InvalidReviewOutputError(`priorFindingReviews duplicated finding ${review.priorFindingId}`);
    }
    seen.add(review.priorFindingId);
  }
  const missing = frozenPriorFindingIds.filter((id) => !seen.has(id));
  return [
    ...priorFindingReviews,
    ...missing.map((priorFindingId) => ({
      priorFindingId,
      verdict: "not_rechecked" as const,
      evidence: null,
      requiredFix: null,
      replacementFindingId: null,
      reviewerNotes:
        "Review output omitted an explicit recheck; prior blocker remains authoritative.",
    })),
  ];
}
