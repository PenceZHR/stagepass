import type { EngineProvider } from "./pipeline-engine-service";
import { endRun } from "./pipeline-run-ledger-service";

export type ReviewRunStatus = "failed" | "invalid_output" | "data_inconsistent" | "issues_found" | "passed";

export interface ReviewRunSummary {
  reviewStatus: ReviewRunStatus;
  provider: EngineProvider;
  errorCode: string | null;
  errorMessage?: string | null;
  sanitizedErrorSummary: string | null;
  sourceBuildRunId: string | null;
  sourceHeadSha: string | null;
  reportPath: string | null;
  findingsPath: string | null;
  rawOutputPath?: string | null;
  findingCount?: number;
  summary: string;
}

export function safeString(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function redactSecrets(input: string): string {
  return input
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_API_KEY]")
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, "$1[REDACTED_TOKEN]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED_TOKEN]")
    .replace(/(api[_-]?key|token|cookie|authorization)(["'\s:=]+)[^"'\s,;]+/gi, "$1$2[REDACTED_SECRET]");
}

function isReviewTimeoutError(raw: string): boolean {
  const lower = raw.toLowerCase();
  return (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("aborterror") ||
    lower.includes("operation was aborted") ||
    lower.includes("was aborted")
  );
}

export function classifyReviewError(raw: string): string {
  const lower = raw.toLowerCase();
  if (isReviewTimeoutError(raw)) {
    return "provider_timeout";
  }
  if (lower.includes("403") || lower.includes("auth") || lower.includes("api key")) {
    return "provider_auth_failed";
  }
  if (lower.includes("quota") || lower.includes("rate limit")) {
    return "provider_quota_failed";
  }
  if (lower.includes("stream")) {
    return "provider_stream_failed";
  }
  return "provider_run_failed";
}

export function sanitizeReviewError(error: unknown, fallbackCode = "provider_run_failed", options?: {
  timeoutMs?: number;
}): {
  errorCode: string;
  summary: string;
} {
  const raw = safeString(error);
  const errorCode = fallbackCode === "provider_run_failed" && raw ? classifyReviewError(raw) : fallbackCode;
  if (errorCode === "provider_timeout") {
    const timeoutText = typeof options?.timeoutMs === "number"
      ? ` after ${options.timeoutMs} ms`
      : "";
    return {
      errorCode,
      summary: `${errorCode}: Review provider timed out or was aborted${timeoutText}`,
    };
  }
  const redacted = redactSecrets(raw).slice(0, 500);
  const summary = redacted ? `${errorCode}: ${redacted}` : `${errorCode}: Review provider failed`;
  return { errorCode, summary };
}

export function writeReviewRunSummary(runId: string, summary: ReviewRunSummary, success: boolean) {
  endRun(runId, JSON.stringify(summary, null, 2), success);
}
