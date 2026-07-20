import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { db } from "../db";
import {
  changes,
  runs,
  findings,
  projects,
  reviewAttempts,
  buildRunRecords,
} from "../db/schema";
import { createChildLogger } from "../logger";
import { runLedgerRepository } from "../repositories/run-ledger-repository";
import type { AiRunResult } from "./ai-engine-types";
import {
  StaleLeaseFenceError,
  type JobExecutionContext,
} from "./job-execution-context";
import {
  assertCurrentExecutionFence,
  withExecutionFence,
} from "./execution-fence-service";
import { assemblePrompt } from "./prompt-service";
import {
  completeReviewAttemptFromStructuredOutput,
  failReviewAttempt,
  recordInvalidReviewOutput,
  startReviewRun,
} from "./review-run-service";
import {
  parseReviewStructuredOutput,
  type ReviewStructuredOutput,
} from "./review-structured-output-parser";
import {
  createProviderLifecycleSink,
  getPipelineEngine,
  resolveReviewTimeoutMs,
  type EngineProvider,
} from "./pipeline-engine-service";
import {
  sanitizeReviewError,
  safeString,
  writeReviewRunSummary,
  type ReviewRunStatus,
} from "./pipeline-review-artifact-service";
import {
  beginStageRun,
  recordPostCommitSideEffectFailure,
  runArtifactDir,
  setStatus,
  writeRunArtifact,
} from "./pipeline-run-ledger-service";
import { recomputeReviewReport } from "./review-report-service";
import { rebuildReviewMirrors } from "./review-artifact-mirror-service";
import type { BuildRunRecord } from "./build-run-record-service";
import {
  assertTrustedAdoptedBuildState,
  buildRunId,
  resolveApprovedBuildRun,
} from "./build-workspace-service";
import {
  type ApiSnapshot,
  type TechSpecSnapshot,
} from "./techspec-api-snapshot-service";
import {
  ingestStageAiOutput,
  type CandidateFileReadResult,
} from "./stage-ai-output-ingestion-service";
import {
  isProviderFailureStageErrorCode,
  STAGE_AI_RAW_CAPTURE_SCHEMA_VERSION,
  type StageAiOutputErrorCode,
  type StageAiRawCaptureEnvelope,
} from "./stage-ai-output-contract";
import {
  persistStageRawCapture,
  type PersistStageRawCaptureResult,
} from "./stage-raw-capture-service";
import { applyLineProtocol, guardLineProtocolSchema } from "./ai-line-protocol";
import { parseReviewLineProtocol } from "./review-line-protocol";
import {
  loadReviewDesignInputs,
  renderDbPlanScopeForPrompt,
  renderDesignInputsForPrompt,
} from "./pipeline-prompt-context-service";
import type { Change, ChangeStatus } from "../types";
import type { Provider } from "./provider-selection-service";
import {
  recordProviderSession,
  resolveProviderSession,
} from "./provider-session-service";

const log = createChildLogger("pipeline-review-stage-service");

// Generic pipeline helpers duplicated per the established stage-service
// convention (see pipeline-build/qa-stage-service) to keep this module free of
// a back-dependency on pipeline-service.
function getProject(projectId: string) {
  return db.select().from(projects).where(eq(projects.id, projectId)).get();
}

function getChange(changeId: string): Change | undefined {
  return db.select().from(changes).where(eq(changes.id, changeId)).get() as Change | undefined;
}

function assertStatus(change: Change, ...allowed: ChangeStatus[]) {
  if (!allowed.includes(change.status as ChangeStatus)) {
    throw new Error(
      `Invalid status: ${change.status}. Expected: ${allowed.join(", ")}`
    );
  }
}

function normalizedProviderThreadId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "unknown" ? trimmed : undefined;
}

// --- Review build-source resolution ---

function latestApprovedBuildRecord(changeId: string): BuildRunRecord | null {
  const records = db
    .select()
    .from(buildRunRecords)
    .where(eq(buildRunRecords.changeId, changeId))
    .all()
    .filter((record) => record.status === "approved_for_absorb" || record.status === "adopted")
    .sort((left, right) => {
      const byTime = (right.adoptedAt ?? right.updatedAt ?? "").localeCompare(left.adoptedAt ?? left.updatedAt ?? "");
      if (byTime !== 0) return byTime;
      return right.id.localeCompare(left.id);
    });
  return records[0] ?? null;
}

function buildRecordSourceHead(record: BuildRunRecord): string | null {
  if (record.status === "approved_for_absorb") return record.baseCommit ?? record.baseHeadSha ?? null;
  return record.adoptedHeadSha ?? record.headSha ?? record.baseCommit ?? null;
}

function resolveReviewBuildSource(repoPath: string, changeId: string): {
  record: BuildRunRecord;
  repoPath: string;
  sourceHeadSha: string | null;
} {
  // Resolve the newest *approved* BuildRun, not the newest run on disk. Every
  // failed 修复阻断项 attempt leaves a higher-numbered build-N.json behind, and
  // picking by number let those shadow the adopted build the change carries: the
  // DB-side gate reads build_run_records filtered to approved/adopted and kept
  // offering 重新反方审查, while this executor refused it every time.
  //
  // A newer run is only skippable once it is dead. One that is still running, or
  // parked on a human decision, may yet become the deliverable -- reviewing the
  // older build then would validate a workspace about to be superseded.
  const { run: approvedRun, blockedBy } = resolveApprovedBuildRun(repoPath, changeId);
  if (blockedBy) {
    throw new Error(
      `Build must be approved before Review: ${buildRunId(blockedBy)} is ${blockedBy.status}`,
    );
  }
  const record = latestApprovedBuildRecord(changeId);
  if (!approvedRun || !record) {
    throw new Error("Build must be approved before Review: no approved BuildRun found");
  }
  if ((record.buildRunId ?? record.id) !== buildRunId(approvedRun)) {
    throw new Error("Build must be approved before Review: BuildRun DB record is stale");
  }
  if (approvedRun.status === "adopted") {
    // Pin the run: this check reads the filesystem too, and unpinned it would
    // re-resolve to the same shadowing failed run and dead-end all over again.
    assertTrustedAdoptedBuildState({ repoPath, changeId, runNumber: approvedRun.runNumber });
  }
  return {
    record,
    repoPath: approvedRun.status === "adopted" ? repoPath : approvedRun.workspacePath,
    sourceHeadSha: buildRecordSourceHead(record),
  };
}

function hasOpenBlockingReviewFindings(changeId: string): boolean {
  return db
    .select()
    .from(findings)
    .where(eq(findings.changeId, changeId))
    .all()
    .some(
      (finding) =>
        finding.source === "review" &&
        finding.status === "open" &&
        (finding.severity === "P0" || finding.severity === "P1"),
    );
}

// --- Review stage (independent AI agent reviews implementation) ---

export interface ReviewFinding {
  severity: string;
  category: string;
  file?: string | null;
  line?: number | null;
  title: string;
  evidence?: string | null;
  requiredFix?: string | null;
  findingId?: string;
  sourceReviewRunId?: string;
  status?: string;
  waivable?: boolean;
}

export interface ReviewResult {
  approved: boolean;
  findings: ReviewFinding[];
  summary: string;
}

export interface RunReviewOptions {
  idempotencyKey?: string;
  provider?: Provider;
}

type ReviewSeverity = "P0" | "P1" | "P2";

interface PersistedReviewFinding {
  findingId: string;
  sourceReviewRunId: string;
  severity: ReviewSeverity;
  status: "open" | "waived" | "fixed";
  category: string;
  file: string | null;
  line: number | null;
  title: string;
  evidence: string | null;
  requiredFix: string | null;
  waivable: boolean;
}

export interface ReviewRunPreflight {
  project: NonNullable<ReturnType<typeof getProject>>;
  reviewRepoPath: string;
  reviewProvider: EngineProvider;
  sourceBuildRunId: string;
  sourceHeadSha: string | null;
  designInputs: { techSpec: TechSpecSnapshot; api: ApiSnapshot };
  sourceDesignDbHash: string;
}

const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string" },
          category: { type: "string" },
          file: { type: ["string", "null"] },
          line: { type: ["number", "null"] },
          title: { type: "string" },
          evidence: { type: ["string", "null"] },
          requiredFix: { type: ["string", "null"] },
        },
        required: ["severity", "category", "file", "line", "title", "evidence", "requiredFix"],
        additionalProperties: false,
      },
    },
    priorFindingReviews: {
      type: "array",
      items: {
        type: "object",
        properties: {
          priorFindingId: { type: "string" },
          verdict: {
            type: "string",
            enum: ["still_open", "fixed", "downgraded", "not_reviewable", "not_rechecked"],
          },
          evidence: { type: ["string", "null"] },
          requiredFix: { type: ["string", "null"] },
          replacementFindingId: { type: ["string", "null"] },
          reviewerNotes: { type: ["string", "null"] },
        },
        required: [
          "priorFindingId",
          "verdict",
          "evidence",
          "requiredFix",
          "replacementFindingId",
          "reviewerNotes",
        ],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
    approved: { type: "boolean" },
  },
  required: ["findings", "priorFindingReviews", "summary", "approved"],
  additionalProperties: false,
};

const REVIEW_OUTPUT_CANDIDATE_FILE = "review-output.json";
const MAX_REVIEW_CANDIDATE_BYTES = 1024 * 1024;

interface ReviewRawValidationResult {
  schemaValid: boolean;
  businessValid: boolean;
  message: string | null;
  normalizedPayload: ReviewStructuredOutput | null;
}

type ReviewCandidateFileState =
  | {
      exists: false;
      safe: boolean;
    }
  | {
      exists: true;
      safe: true;
      path: string;
      realPath: string;
      size: number;
      mtimeMs: number;
      hash: string;
    };

function reviewOutputCandidatePath(changeId: string): string {
  return `.ship/changes/${changeId}/${REVIEW_OUTPUT_CANDIDATE_FILE}`;
}

function hashString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function pathIsInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeReviewCandidateLocation(repoPath: string, changeId: string): {
  candidatePath: string;
  fullPath: string;
  allowedDirRealPath: string;
} | null {
  const candidatePath = reviewOutputCandidatePath(changeId);
  const repoRealPath = fs.realpathSync(repoPath);
  const allowedDir = path.join(repoPath, ".ship", "changes", changeId);
  const checkedDirs = [
    path.join(repoPath, ".ship"),
    path.join(repoPath, ".ship", "changes"),
    allowedDir,
  ];

  for (const dir of checkedDirs) {
    if (!fs.existsSync(dir)) {
      return null;
    }
    const dirStats = fs.lstatSync(dir);
    if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
      return null;
    }
  }

  const allowedDirRealPath = fs.realpathSync(allowedDir);
  if (!pathIsInside(repoRealPath, allowedDirRealPath)) {
    return null;
  }

  return {
    candidatePath,
    fullPath: path.join(repoPath, candidatePath),
    allowedDirRealPath,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateReviewOutputForRawArtifact(output: unknown): ReviewRawValidationResult {
  if (!isPlainRecord(output)) {
    return {
      schemaValid: false,
      businessValid: false,
      message: "structuredOutput must be an object",
      normalizedPayload: null,
    };
  }
  if (
    !Array.isArray(output.findings)
    || !Array.isArray(output.priorFindingReviews)
    || typeof output.approved !== "boolean"
    || typeof output.summary !== "string"
  ) {
    return {
      schemaValid: false,
      businessValid: false,
      message: "findings, priorFindingReviews, approved, and summary are required",
      normalizedPayload: null,
    };
  }

  try {
    return {
      schemaValid: true,
      businessValid: true,
      message: null,
      normalizedPayload: parseReviewStructuredOutput(output),
    };
  } catch (error) {
    return {
      schemaValid: true,
      businessValid: false,
      message: safeString(error),
      normalizedPayload: null,
    };
  }
}

function readReviewCandidateFileState(repoPath: string, changeId: string): ReviewCandidateFileState {
  try {
    const location = safeReviewCandidateLocation(repoPath, changeId);
    if (!location || !fs.existsSync(location.fullPath)) {
      return { exists: false, safe: Boolean(location) };
    }

    const stats = fs.lstatSync(location.fullPath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_REVIEW_CANDIDATE_BYTES) {
      return { exists: false, safe: false };
    }

    const candidateRealPath = fs.realpathSync(location.fullPath);
    if (!pathIsInside(location.allowedDirRealPath, candidateRealPath)) {
      return { exists: false, safe: false };
    }

    const content = fs.readFileSync(location.fullPath, "utf-8");
    return {
      exists: true,
      safe: true,
      path: location.candidatePath,
      realPath: candidateRealPath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      hash: hashString(content),
    };
  } catch {
    return { exists: false, safe: false };
  }
}

function reviewCandidateFileStateChanged(
  before: ReviewCandidateFileState,
  after: ReviewCandidateFileState,
): boolean {
  if (!after.exists) return false;
  if (!before.exists) return true;
  return (
    before.hash !== after.hash ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.realPath !== after.realPath
  );
}

function readReviewFileCandidateForIngestion(
  repoPath: string,
  changeId: string,
  beforeState: ReviewCandidateFileState,
  requestedPath: string,
): CandidateFileReadResult | null {
  if (requestedPath !== reviewOutputCandidatePath(changeId)) {
    return null;
  }
  const afterState = readReviewCandidateFileState(repoPath, changeId);
  if (!afterState.exists) return null;

  try {
    const content = fs.readFileSync(afterState.realPath, "utf-8");
    return {
      path: afterState.path,
      content,
      sizeBytes: afterState.size,
      isSymlink: false,
      changed: reviewCandidateFileStateChanged(beforeState, afterState),
    };
  } catch {
    return null;
  }
}

function reviewRejectedCandidateAudit(
  repoPath: string,
  changeId: string,
  beforeState: ReviewCandidateFileState,
  result: AiRunResult,
): NonNullable<StageAiRawCaptureEnvelope["candidateAudit"]> {
  const candidatePath = reviewOutputCandidatePath(changeId);
  const reportedByProvider = (result.changedFiles ?? [])
    .map((filePath) => filePath.replace(/\\/g, "/").replace(/^\.\//, ""))
    .includes(candidatePath);
  const location = safeReviewCandidateLocation(repoPath, changeId);
  if (!location || !fs.existsSync(location.fullPath)) {
    return {
      path: candidatePath, sha256: null, sizeBytes: null, changed: false,
      freshness: location ? "missing" : "unsafe", symlinkDisposition: "unknown",
      reportedByProvider,
      rejectionReason: location ? "candidate_missing" : "candidate_path_unsafe",
    };
  }
  try {
    const stats = fs.lstatSync(location.fullPath);
    if (stats.isSymbolicLink()) {
      return {
        path: candidatePath, sha256: null, sizeBytes: stats.size, changed: true,
        freshness: "unsafe", symlinkDisposition: "rejected_symlink", reportedByProvider,
        rejectionReason: "candidate_symlink_rejected",
      };
    }
  } catch {
    return {
      path: candidatePath, sha256: null, sizeBytes: null, changed: false,
      freshness: "unsafe", symlinkDisposition: "unknown", reportedByProvider,
      rejectionReason: "candidate_inspection_failed",
    };
  }
  const afterState = readReviewCandidateFileState(repoPath, changeId);
  if (!afterState.exists) {
    return {
      path: candidatePath, sha256: null, sizeBytes: null, changed: false,
      freshness: "unsafe", symlinkDisposition: "not_symlink", reportedByProvider,
      rejectionReason: "candidate_file_unsafe",
    };
  }
  const changed = reviewCandidateFileStateChanged(beforeState, afterState);
  return {
    path: candidatePath,
    sha256: afterState.hash,
    sizeBytes: afterState.size,
    changed,
    freshness: changed ? "fresh" : "stale",
    symlinkDisposition: "not_symlink",
    reportedByProvider,
    rejectionReason: !changed
      ? "candidate_stale"
      : !reportedByProvider
        ? "candidate_unreported_by_provider"
        : "candidate_missing_run_bound_authorship",
  };
}

function reviewRawArtifactPath(repoPath: string, changeId: string, runId: string): string {
  return path.join(runArtifactDir(repoPath, changeId, runId), "raw-ai-output.json");
}

function reviewIngestionErrorCode(input: {
  providerFailed: boolean;
  providerErrorCode?: string | null;
  ingestionErrorCode?: string;
}): string {
  if (input.providerFailed) {
    return input.providerErrorCode ?? input.ingestionErrorCode ?? "provider_run_failed";
  }
  return input.ingestionErrorCode ?? "invalid_review_output";
}

function reviewProviderFailureRawCaptureEnvelope(
  envelope: StageAiRawCaptureEnvelope,
  result: AiRunResult,
  timeoutMs: number,
  candidateAudit: NonNullable<StageAiRawCaptureEnvelope["candidateAudit"]>,
): StageAiRawCaptureEnvelope {
  const { errorCode, summary } = sanitizeReviewError(
    result.providerErrorDetail || result.summary,
    result.providerErrorCode ?? "provider_run_failed",
    { timeoutMs },
  );
  if (envelope.errorCode === "provider_timeout_recovered_from_file") {
    return {
      ...envelope,
      providerErrorCode: errorCode,
      sanitizedErrorSummary: envelope.sanitizedErrorSummary ?? summary,
      candidateAudit,
    };
  }
  return {
    ...envelope,
    // Keep whichever provider-side code the engine actually determined. Pinning
    // everything except a timeout to provider_run_failed threw away the two
    // codes that say WHY nothing came back, in the one artifact a post-mortem
    // reads first. Non-provider codes still collapse, as before.
    errorCode: isProviderFailureStageErrorCode(errorCode)
      ? (errorCode as StageAiOutputErrorCode)
      : "provider_run_failed",
    providerErrorCode: errorCode,
    sanitizedErrorSummary: summary,
    rawText: summary,
    rawTextHash: hashString(summary),
    rawTextPreview: summary,
    rawTextLength: summary.length,
    rawTextTruncated: false,
    candidateAudit,
  };
}

async function writeReviewPostCommitArtifact(input: {
  repoPath: string;
  changeId: string;
  runId: string;
  type: string;
  fileName: string;
  content: string;
  sideEffect: "review_findings_write" | "review_report_write";
}): Promise<{ currentPath: string; runPath: string } | null> {
  try {
    return await writeRunArtifact(
      input.repoPath,
      input.changeId,
      input.runId,
      input.type,
      input.fileName,
      input.content,
    );
  } catch (error) {
    if (error instanceof StaleLeaseFenceError) {
      throw error;
    }
    await recordPostCommitSideEffectFailure({
      changeId: input.changeId,
      runId: input.runId,
      phase: "review",
      sideEffect: input.sideEffect,
      message: `Review post-commit side-effect failed: ${input.sideEffect}`,
      error,
      rawJson: {
        artifactType: input.type,
        fileName: input.fileName,
      },
    });
    return null;
  }
}

export function preflightReviewRun(changeId: string, provider?: Provider): ReviewRunPreflight {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  if (change.status === "CHECK_FAILED") {
    if (!hasOpenBlockingReviewFindings(changeId)) {
      throw new Error("Review rerun requires open Review P0/P1 findings");
    }
  } else {
    assertStatus(change, "IMPLEMENTED");
  }

  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);

  const buildSource = resolveReviewBuildSource(project.repoPath, changeId);
  const reviewDesign = loadReviewDesignInputs(changeId);
  return {
    project,
    reviewRepoPath: buildSource.repoPath,
    reviewProvider: provider ?? (change.provider === "claude" ? "claude" : "codex") as EngineProvider,
    sourceBuildRunId: buildSource.record.buildRunId ?? buildSource.record.id,
    sourceHeadSha: buildSource.sourceHeadSha,
    designInputs: reviewDesign.designInputs,
    sourceDesignDbHash: reviewDesign.sourceDbHash,
  };
}

export async function runReview(
  changeId: string,
  context: JobExecutionContext,
  options: RunReviewOptions = {},
): Promise<ReviewResult> {
  return withExecutionFence(context, async () => {
    const {
      project,
      reviewRepoPath,
      reviewProvider,
      sourceBuildRunId,
      sourceHeadSha,
      designInputs,
      sourceDesignDbHash,
    } = preflightReviewRun(changeId, options.provider ?? context.provider);
    const attemptStart = startReviewRun({
      changeId,
      idempotencyKey: options.idempotencyKey,
      provider: reviewProvider,
      sourceBuildRunId,
      sourceHeadSha,
    });
    assertCurrentExecutionFence(context);
    if (attemptStart.conflict) {
      throw new Error(`review_attempt_conflict: running review attempt ${attemptStart.attempt.id}`);
    }
    if (attemptStart.attempt.status !== "running") {
      throw new Error(`review_attempt_not_running: ${attemptStart.attempt.id}`);
    }
    const attemptId = attemptStart.attempt.id;
    const idempotencyKey = attemptStart.idempotencyKey;
    let runId: string | null = null;
    let dbReviewCompleted = false;
    const reviewTimeoutMs = resolveReviewTimeoutMs();

    try {
      assertCurrentExecutionFence(context);
      // D6 audit: REVIEWING has no action-contract coverage at all -- every
      // action returns notAtGate() from this status. A crash between setting it
      // and the run row landing used to strand the change with no forward path
      // and nothing for recovery to find. One transaction closes that.
      runId = beginStageRun({ changeId, phase: "review", runningStatus: "REVIEWING", provider: reviewProvider });
      assertCurrentExecutionFence(context, runId);
      startReviewRun({
        changeId,
        idempotencyKey,
        provider: reviewProvider,
        runId,
        sourceBuildRunId,
        sourceHeadSha,
      });
      assertCurrentExecutionFence(context, runId);

      const prompt = `${assemblePrompt("review", {
        changeId,
        repoPath: reviewRepoPath,
      })}\n\n${renderDbPlanScopeForPrompt(changeId)}\n\n${renderDesignInputsForPrompt(designInputs)}\n\nReview designSourceDbHash: ${sourceDesignDbHash}`;
      const priorBlockingFindingIds = JSON.parse(
        attemptStart.attempt.priorBlockingFindingIdsJson ?? "[]",
      ) as string[];
      const priorBlockingFindings = priorBlockingFindingIds.length
        ? db
            .select()
            .from(findings)
            .where(eq(findings.changeId, changeId))
            .all()
            .filter((finding) => priorBlockingFindingIds.includes(finding.id))
            .map(
              (finding) =>
                `- ${finding.id} ${finding.severity}: ${finding.title}\n  evidence: ${finding.evidence ?? ""}\n  requiredFix: ${finding.requiredFix ?? ""}`,
            )
            .join("\n")
        : "None. Output priorFindingReviews as an empty array.";

      const reviewPrompt = `You are an independent code reviewer. Review the changes made for change ${changeId}.

  ${prompt}

  ## Instructions
  Review only the adopted Build product files and the DB Plan Scope expectedFiles for this change. Treat pipeline metadata and agent runtime files as out of review scope, including .ship/**, .codex/agents/**, and other generated run artifacts.
  Do not use raw git status, untracked pipeline artifacts, or generated mirrors as evidence for scope findings. Scope findings must name an adopted product file that violates the DB Plan Scope; system metadata paths are not valid Review findings.
  If a prior finding only complained about .ship/**, .codex/agents/**, or other generated pipeline metadata, mark that priorFindingReviews item as fixed because those paths are excluded from Review scope.
  Read the adopted product files that were modified. Look for bugs, security issues, logic errors, and code quality problems.
  Output your findings using the line protocol described above (FINDING/PRIOR/APPROVED lines plus a SUMMARY<< … >> block). Never output JSON.
  Use requiredFix for any required remediation. P0/P1 findings must include non-empty evidence and non-empty requiredFix.
  P2 findings must include non-empty evidence and may set requiredFix to - (null).
  Do not output suggestion or recommendation fields.

  ## Prior open P0/P1 findings to recheck
  ${priorBlockingFindings}

  For every prior finding listed above, output exactly one PRIOR line using verdict still_open, fixed, downgraded, not_reviewable, or not_rechecked. Missing prior verdicts are recorded as not_rechecked and keep the old blocker open; unknown prior verdicts invalidate the whole Review output.
  Every PRIOR line must include non-empty evidence or reviewerNotes. still_open and downgraded verdicts must include a meaningful requiredFix for the remaining remediation.`;

      const engine = await getPipelineEngine(reviewProvider);
      const reviewCandidateBeforeRun = readReviewCandidateFileState(project.repoPath, changeId);

      const result = await engine.run({
        changeId,
        repoPath: reviewRepoPath,
        phase: "review",
        threadId: resolveProviderSession({
          changeId,
          provider: reviewProvider,
          sessionKind: "general",
        }) ?? undefined,
        prompt: reviewPrompt,
        sandboxMode: "read-only",
        // Line-protocol stage: the model writes FINDING/PRIOR/APPROVED/SUMMARY
        // lines, never JSON. REVIEW_OUTPUT_SCHEMA stays server-side as the
        // second gate over the deterministically assembled payload.
        timeoutMs: reviewTimeoutMs,
        lifecycle: createProviderLifecycleSink({
          ...context,
          changeId,
          runId,
          phase: "review",
          provider: reviewProvider,
          closeBusinessRunOnProviderFailure: false,
        }),
      });
      assertCurrentExecutionFence(context, runId);
      const reviewThreadId = normalizedProviderThreadId(result.threadId);
      if (reviewThreadId) {
        recordProviderSession({
          changeId,
          provider: reviewProvider,
          sessionKind: "general",
          externalSessionId: reviewThreadId,
          lastRunId: runId,
        });
        if (reviewProvider === "codex") {
          runLedgerRepository.patchChange(changeId, { codexThreadId: reviewThreadId }, { runId });
        }
      }
      const providerFailed = !result.success;
      const lineProtocol = applyLineProtocol(
        result,
        (rawText) => {
          const parsed = parseReviewLineProtocol(rawText);
          return parsed.ok
            ? { ok: true, payload: parsed.payload as unknown as Record<string, unknown> }
            : parsed;
        },
        { changeId, repoPath: project.repoPath },
      );
      const rawCaptureBox: { current: PersistStageRawCaptureResult | null } = { current: null };
      const ingestion = await ingestStageAiOutput({
        changeId,
        runId,
        phase: "review",
        provider: reviewProvider,
        outputSchema: REVIEW_OUTPUT_SCHEMA,
        aiResult: providerFailed
          ? {
              ...result,
              structuredOutput: undefined,
              structuredOutputSource: undefined,
            }
          : lineProtocol.result,
        contract: {
          allowedCandidateFiles: [reviewOutputCandidatePath(changeId)],
          safeRoot: `.ship/changes/${changeId}`,
          sandboxReadOnly: false,
          // A changed Review candidate proves freshness, but not authorship by this
          // provider run. Without run/session/process-bound evidence, a timed-out
          // provider must fail closed instead of promoting a mirror file to DB authority.
          allowSource: () => !providerFailed,
          readCandidateFile: (candidatePath) =>
            readReviewFileCandidateForIngestion(
              project.repoPath,
              changeId,
              reviewCandidateBeforeRun,
              candidatePath,
            ),
          validateSchema: (value) => {
            if (providerFailed) {
              return {
                ok: false,
                message:
                  result.providerErrorDetail || result.providerErrorCode || "Review provider failed",
              };
            }
            const base = (candidate: unknown) => {
              const validation = validateReviewOutputForRawArtifact(candidate);
              return validation.schemaValid
                ? true
                : { ok: false as const, message: validation.message ?? "Review output schema invalid" };
            };
            return guardLineProtocolSchema(lineProtocol.state, base, "review")(value);
          },
          validateBusiness: (value) => {
            const validation = validateReviewOutputForRawArtifact(value);
            return validation.businessValid
              ? true
              : { ok: false, message: validation.message ?? "Review output business rules invalid" };
          },
          writeRawCapture: async (envelope) => {
            assertCurrentExecutionFence(context, runId as string);
            const safeEnvelope = providerFailed && envelope.structuredOutputSource !== "file_candidate"
              ? reviewProviderFailureRawCaptureEnvelope(
                envelope,
                result,
                reviewTimeoutMs,
                reviewRejectedCandidateAudit(project.repoPath, changeId, reviewCandidateBeforeRun, result),
              )
              : envelope;
            rawCaptureBox.current = await persistStageRawCapture({
              repoPath: project.repoPath,
              changeId,
              runId: runId as string,
              envelope: safeEnvelope,
            });
            assertCurrentExecutionFence(context, runId as string);
          },
        },
      });
      assertCurrentExecutionFence(context, runId);
      const rawCaptureResult = rawCaptureBox.current;
      if (!rawCaptureResult) {
        throw new Error("review_raw_capture_missing");
      }
      const rawOutputArtifactId = rawCaptureResult.artifactId;
      const rawOutputPath = rawCaptureResult.artifactPath;
      if (!ingestion.ok) {
        const fallbackErrorCode = reviewIngestionErrorCode({
          providerFailed,
          providerErrorCode: result.providerErrorCode,
          ingestionErrorCode: ingestion.errorCode,
        });
        const { errorCode, summary } = sanitizeReviewError(
          result.providerErrorDetail || ingestion.sanitizedErrorSummary || result.summary,
          fallbackErrorCode,
          { timeoutMs: reviewTimeoutMs },
        );
        assertCurrentExecutionFence(context, runId);
        const reportArtifact = await writeReviewPostCommitArtifact({
          repoPath: project.repoPath,
          changeId,
          runId,
          type: "review_report",
          fileName: "review-report.md",
          content: `# Review Failed\n\nProvider: ${reviewProvider}\n\nError: ${summary}\n`,
          sideEffect: "review_report_write",
        });
        assertCurrentExecutionFence(context, runId);
        writeReviewRunSummary(
          runId,
          {
            reviewStatus: providerFailed ? "failed" : "invalid_output",
            provider: reviewProvider,
            errorCode,
            sanitizedErrorSummary: summary,
            sourceBuildRunId,
            sourceHeadSha,
            reportPath: reportArtifact?.runPath ?? null,
            findingsPath: null,
            rawOutputPath,
            findingCount: 0,
            summary,
          },
          false,
        );
        assertCurrentExecutionFence(context, runId);
        if (providerFailed) {
          failReviewAttempt({
            attemptId,
            errorCode,
            sanitizedErrorSummary: summary,
            rawOutputArtifactId,
          });
        } else {
          recordInvalidReviewOutput({
            attemptId,
            sanitizedErrorSummary: summary,
            rawOutputArtifactId,
          });
        }
        assertCurrentExecutionFence(context, runId);
        await setStatus(changeId, "IMPLEMENTED");
        throw new Error(summary);
      }
      let completedReview: ReturnType<typeof completeReviewAttemptFromStructuredOutput>;
      try {
        assertCurrentExecutionFence(context, runId);
        completedReview = completeReviewAttemptFromStructuredOutput({
          attemptId,
          runId,
          rawOutputArtifactId,
          structuredOutput: ingestion.structuredOutput,
        });
        assertCurrentExecutionFence(context, runId);
        const recomputed = recomputeReviewReport(changeId, attemptId);
        assertCurrentExecutionFence(context, runId);
        // Project the settled report/findings into their mirrors, so review
        // evidence has a hash-verifiable file loop. Best-effort: a filesystem
        // problem must not undo a review that already settled in the DB.
        try {
          rebuildReviewMirrors(recomputed.report.id);
        } catch (mirrorError) {
          log.warn(
            { changeId, reportId: recomputed.report.id, err: String(mirrorError) },
            "Failed to materialize review artifact mirrors; review settlement stands",
          );
        }
        assertCurrentExecutionFence(context, runId);
        dbReviewCompleted = true;
      } catch (error) {
        if (error instanceof StaleLeaseFenceError) {
          throw error;
        }
        assertCurrentExecutionFence(context, runId);
        const { summary } = sanitizeReviewError(error, "invalid_review_output");
        recordInvalidReviewOutput({
          attemptId,
          sanitizedErrorSummary: summary,
          rawOutputArtifactId,
        });
        assertCurrentExecutionFence(context, runId);
        const reportArtifact = await writeReviewPostCommitArtifact({
          repoPath: project.repoPath,
          changeId,
          runId,
          type: "review_report",
          fileName: "review-report.md",
          content: `# Review Failed\n\nProvider: ${reviewProvider}\n\nError: ${summary}\n`,
          sideEffect: "review_report_write",
        });
        assertCurrentExecutionFence(context, runId);
        writeReviewRunSummary(
          runId,
          {
            reviewStatus: "invalid_output",
            provider: reviewProvider,
            errorCode: "invalid_review_output",
            errorMessage: summary,
            sanitizedErrorSummary: summary,
            sourceBuildRunId,
            sourceHeadSha,
            reportPath: reportArtifact?.runPath ?? null,
            findingsPath: null,
            rawOutputPath,
            findingCount: 0,
            summary,
          },
          false
        );
        assertCurrentExecutionFence(context, runId);
        await setStatus(changeId, "IMPLEMENTED");
        throw new Error(summary);
      }

      const persistedFindings: PersistedReviewFinding[] = completedReview.findings;
      const summary = completedReview.summary;
      const approved = completedReview.approved;
      const reviewStatus: ReviewRunStatus = completedReview.reviewStatus;
      assertCurrentExecutionFence(context, runId);
      const findingsArtifact = await writeReviewPostCommitArtifact({
        repoPath: project.repoPath,
        changeId,
        runId,
        type: "findings",
        fileName: "review-findings.json",
        content: JSON.stringify(persistedFindings, null, 2),
        sideEffect: "review_findings_write",
      });
      assertCurrentExecutionFence(context, runId);

      const reportLines = [
        `# Review ${approved ? "Passed" : "Issues Found"}`,
        "",
        `Provider: ${reviewProvider}`,
        `Approved: ${String(approved)}`,
        "",
        "## Summary",
        "",
        summary,
        "",
        "## Findings",
        "",
        persistedFindings.length === 0
          ? "No findings."
          : persistedFindings
              .map(
                (finding) =>
                  `- ${finding.severity} ${finding.findingId}: ${finding.title} (${finding.status}, waivable=${String(finding.waivable)})`
              )
              .join("\n"),
        "",
      ];
      const reportArtifact = await writeReviewPostCommitArtifact({
        repoPath: project.repoPath,
        changeId,
        runId,
        type: "review_report",
        fileName: "review-report.md",
        content: reportLines.join("\n"),
        sideEffect: "review_report_write",
      });
      assertCurrentExecutionFence(context, runId);
      const secondaryArtifactsComplete = Boolean(findingsArtifact && reportArtifact);
      const secondarySummary = secondaryArtifactsComplete
        ? null
        : "secondary_artifact_write_failed: Review post-commit artifact write failed";
      writeReviewRunSummary(
        runId,
        {
          reviewStatus,
          provider: reviewProvider,
          errorCode: secondarySummary ? "secondary_artifact_write_failed" : null,
          sanitizedErrorSummary: secondarySummary,
          sourceBuildRunId,
          sourceHeadSha,
          reportPath: reportArtifact?.runPath ?? null,
          findingsPath: findingsArtifact?.runPath ?? null,
          rawOutputPath,
          errorMessage: secondarySummary,
          findingCount: persistedFindings.length,
          summary,
        },
        true,
      );
      assertCurrentExecutionFence(context, runId);

      if (approved) {
        assertCurrentExecutionFence(context, runId);
        await setStatus(changeId, "IMPLEMENTED");
        log.info({ changeId }, "Review passed");
      } else {
        assertCurrentExecutionFence(context, runId);
        await setStatus(changeId, "CHECK_FAILED");
        log.info({ changeId, findingCount: persistedFindings.length }, "Review found issues");
      }

      return { approved, findings: persistedFindings, summary };
    } catch (err) {
      if (err instanceof StaleLeaseFenceError) {
        throw err;
      }
      assertCurrentExecutionFence(context, runId ?? undefined);
      const attemptAlreadyCompleted =
        dbReviewCompleted ||
        db.select({ status: reviewAttempts.status })
          .from(reviewAttempts)
          .where(eq(reviewAttempts.id, attemptId))
          .get()?.status === "completed";
      if (attemptAlreadyCompleted) {
        throw err;
      }
      const existingRun = runId ? db.select().from(runs).where(eq(runs.id, runId)).get() : null;
      if (runId && existingRun?.status === "running") {
        assertCurrentExecutionFence(context, runId);
        const { errorCode, summary } = sanitizeReviewError(err, "provider_run_failed", {
          timeoutMs: reviewTimeoutMs,
        });
        let fallbackRawCapture: PersistStageRawCaptureResult | null = null;
        try {
          assertCurrentExecutionFence(context, runId);
          fallbackRawCapture = await persistStageRawCapture({
            repoPath: project.repoPath,
            changeId,
            runId,
            envelope: {
              schemaVersion: STAGE_AI_RAW_CAPTURE_SCHEMA_VERSION,
              changeId,
              runId,
              phase: "review",
              provider: reviewProvider,
              schemaDelivery: "none",
              structuredOutputSource: "none",
              errorCode: errorCode === "provider_timeout" ? "provider_timeout" : "provider_run_failed",
              providerErrorCode: errorCode,
              sanitizedErrorSummary: summary,
              rawText: safeString(err),
            },
          });
          assertCurrentExecutionFence(context, runId);
        } catch (rawCaptureError) {
          if (rawCaptureError instanceof StaleLeaseFenceError) {
            throw rawCaptureError;
          }
          log.warn(
            { changeId, attemptId, error: safeString(rawCaptureError) },
            "Review fallback raw capture failed",
          );
        }
        assertCurrentExecutionFence(context, runId);
        writeReviewRunSummary(
          runId,
          {
            reviewStatus: "failed",
            provider: reviewProvider,
            errorCode,
            sanitizedErrorSummary: summary,
            sourceBuildRunId,
            sourceHeadSha,
            reportPath: null,
            findingsPath: null,
            rawOutputPath: fallbackRawCapture?.artifactPath ?? reviewRawArtifactPath(project.repoPath, changeId, runId),
            summary,
          },
          false
        );
        assertCurrentExecutionFence(context, runId);
        failReviewAttempt({
          attemptId,
          errorCode,
          sanitizedErrorSummary: summary,
          rawOutputArtifactId: fallbackRawCapture?.artifactId ?? null,
        });
        if (errorCode === "provider_timeout") {
          err = new Error(summary);
        }
      } else if (!existingRun) {
        assertCurrentExecutionFence(context);
        const { errorCode, summary } = sanitizeReviewError(err, "provider_run_failed", {
          timeoutMs: reviewTimeoutMs,
        });
        failReviewAttempt({
          attemptId,
          errorCode,
          sanitizedErrorSummary: summary,
        });
        if (errorCode === "provider_timeout") {
          err = new Error(summary);
        }
      }
      assertCurrentExecutionFence(context, runId ?? undefined);
      await setStatus(changeId, "IMPLEMENTED");
      throw err;
    }
  });
}
