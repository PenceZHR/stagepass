import { and, eq, inArray } from "drizzle-orm";

import { events, pipelineJobs, reviewAttempts, runs, stageRuns } from "../db/schema";
import type {
  ActionContractDb,
  ActionContractWarning,
  ActionDefinition,
  ActionDecision,
} from "./action-contract-types";
import type { PipelinePhase, StageAuthoritySnapshot } from "./stage-authority-service";
import type {
  StageAiOutputErrorCode,
  StageProgressEventPayload,
} from "./stage-ai-output-contract";
import { readJson, sortNewestRun } from "./action-contract-common-policy";

/**
 * The stage-output signal engine: it reads the newest stage run, its progress
 * events and the legacy runs/events fallback for a phase, and distills them into
 * a single StageOutputSignal (retryable error code, warnings, source hash, gate
 * version). applyStageOutputRetry then uses that signal to re-enable a retry_*
 * action. Extracted from the action-contract facade so the central service no
 * longer has to understand every phase's error/progress shape.
 *
 * Per the policy-module convention, every DB-reading function takes the
 * ActionContractDb as its first argument rather than reaching for a module-level
 * holder — that is what keeps setActionContractServiceDbForTest working from the
 * facade.
 */

const RETRYABLE_STAGE_OUTPUT_ERROR_CODES = new Set<string>([
  "provider_timeout",
  "provider_run_failed",
  // A broken transport and an empty reply are the MOST retryable failures there
  // are -- nothing about the change or the prompt is wrong, the run just never
  // landed. Omitting them here would leave the user staring at a failed stage
  // with no Retry button, which is worse than the misattribution itself.
  "provider_transport_error",
  "provider_empty_response",
  "invalid_stage_output",
  "invalid_review_output",
  "file_candidate_invalid",
  "repair_failed",
]);

const STAGE_OUTPUT_WARNING_TITLES: Record<string, string> = {
  provider_timeout_recovered_from_file: "Provider timed out, but output was recovered from file.",
  mirror_write_failed: "Mirror write failed after DB persistence.",
};
const STAGE_OUTPUT_TEXT_CODES = [
  ...RETRYABLE_STAGE_OUTPUT_ERROR_CODES,
  ...Object.keys(STAGE_OUTPUT_WARNING_TITLES),
].sort((left, right) => right.length - left.length);

export interface StageOutputSignal {
  retryableErrorCode: StageAiOutputErrorCode | null;
  warnings: ActionContractWarning[];
  sourceDbHash: string | null;
  gateVersion: string | null;
}

function sortNewestStageRun(
  rows: Array<typeof stageRuns.$inferSelect>,
): typeof stageRuns.$inferSelect | null {
  return [...rows].sort((left, right) => {
    const rightTime = right.completedAt ?? right.startedAt ?? "";
    const leftTime = left.completedAt ?? left.startedAt ?? "";
    const byTime = rightTime.localeCompare(leftTime);
    if (byTime !== 0) return byTime;
    if (right.attemptNo !== left.attemptNo) return right.attemptNo - left.attemptNo;
    return right.id.localeCompare(left.id);
  })[0] ?? null;
}

function latestReviewAttempt(
  db: ActionContractDb,
  changeId: string,
): typeof reviewAttempts.$inferSelect | null {
  return [...db.select().from(reviewAttempts).where(eq(reviewAttempts.changeId, changeId)).all()]
    .sort((left, right) => {
      if (right.attemptNo !== left.attemptNo) return right.attemptNo - left.attemptNo;
      const byStarted = right.startedAt.localeCompare(left.startedAt);
      if (byStarted !== 0) return byStarted;
      return right.id.localeCompare(left.id);
    })[0] ?? null;
}

export function retryOutputPhase(actionId: string): PipelinePhase | null {
  const phases: Record<string, PipelinePhase> = {
    retry_prd: "PRD",
    retry_spec: "Spec",
    retry_tech_spec: "TechSpec",
    retry_plan: "Plan",
    retry_test_plan: "TestPlan",
    retry_build: "Build",
    retry_review: "Review",
    retry_qa: "QA",
  };
  return phases[actionId] ?? null;
}

export function activePipelineJobPhases(db: ActionContractDb, changeId: string): Set<string> {
  return new Set(db.select({ phase: pipelineJobs.phase }).from(pipelineJobs).where(and(
    eq(pipelineJobs.changeId, changeId),
    inArray(pipelineJobs.status, ["queued", "leased", "running"]),
  )).all().map((job) => job.phase));
}

export function activeJobPhaseForAction(db: ActionContractDb, actionId: string): string | null {
  const phaseByAction: Record<string, string> = {
    run_prd: "intake",
    retry_prd: "intake",
    run_spec: "spec",
    retry_spec: "spec",
    run_tech_spec: "tech_spec",
    retry_tech_spec: "tech_spec",
    run_plan: "generate_plan",
    retry_plan: "generate_plan",
    run_test_plan: "test_plan",
    retry_test_plan: "test_plan",
    run_build: "implement",
    retry_build: "implement",
    run_review: "review",
    retry_review: "review",
    fix_blockers: "fix_findings",
    enter_qa: "local_check",
    run_qa: "local_check",
    retry_qa: "local_check",
    merge: "release",
    run_retro: "retro",
    run_delivery: "delivery",
  };
  return phaseByAction[actionId] ?? null;
}

export function warningPhaseForDefinition(
  definition: ActionDefinition,
  retryPhase: PipelinePhase | null,
): PipelinePhase {
  return retryPhase ?? ((definition.snapshotPhase ?? definition.phase) as PipelinePhase);
}

function signalSourceDbHash(
  row: Pick<typeof stageRuns.$inferSelect, "outputDbHash" | "inputDbHash" | "id">,
): string {
  return row.outputDbHash ?? row.inputDbHash ?? row.id;
}

function normalizeRunPhase(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function runPhaseMatches(value: string, phase: PipelinePhase): boolean {
  const aliases: Record<PipelinePhase, string[]> = {
    PRD: ["prd", "generateprd", "prdbriefing"],
    Spec: ["spec", "specbattle"],
    TechSpec: ["techspec", "generatetechspec"],
    Plan: ["plan", "generateplan"],
    TestPlan: ["testplan", "generatetestplan"],
    Build: ["build"],
    Review: ["review"],
    QA: ["qa", "localcheck"],
    Merge: ["merge"],
  };
  const normalized = normalizeRunPhase(value);
  return aliases[phase].some((alias) => normalized === alias || normalized.startsWith(alias));
}

function progressPhaseMatches(value: string, phase: PipelinePhase): boolean {
  if (value === phase) return true;
  return runPhaseMatches(value, phase);
}

function stageOutputWarning(code: string): ActionContractWarning | null {
  const title = STAGE_OUTPUT_WARNING_TITLES[code];
  return title ? { id: code, severity: "warning", title } : null;
}

function dedupeWarnings(warnings: ActionContractWarning[]): ActionContractWarning[] {
  const seen = new Set<string>();
  const unique: ActionContractWarning[] = [];
  for (const warning of warnings) {
    if (seen.has(warning.id)) continue;
    seen.add(warning.id);
    unique.push(warning);
  }
  return unique;
}

function asStageOutputErrorCode(value: unknown): StageAiOutputErrorCode | null {
  return typeof value === "string" ? (value as StageAiOutputErrorCode) : null;
}

function retryableErrorCode(value: unknown): StageAiOutputErrorCode | null {
  const code = asStageOutputErrorCode(value);
  return code && RETRYABLE_STAGE_OUTPUT_ERROR_CODES.has(code) ? code : null;
}

function extractKnownCodeFromText(value: string | null | undefined): StageAiOutputErrorCode | null {
  if (!value) return null;
  for (const code of STAGE_OUTPUT_TEXT_CODES) {
    if (value.includes(code)) return code as StageAiOutputErrorCode;
  }
  return null;
}

function lineageErrorCode(sourceLineageJson: string | null): StageAiOutputErrorCode | null {
  const parsed = readJson(sourceLineageJson);
  if (!parsed || typeof parsed !== "object") return null;
  return asStageOutputErrorCode((parsed as { errorCode?: unknown }).errorCode);
}

function progressPayload(row: typeof events.$inferSelect): StageProgressEventPayload | null {
  if (row.type !== "stage_progress") return null;
  const parsed = readJson(row.rawJson);
  if (!parsed || typeof parsed !== "object") return null;
  const payload = (parsed as { stageProgress?: unknown }).stageProgress;
  if (!payload || typeof payload !== "object") return null;
  return payload as StageProgressEventPayload;
}

function stageProgressCode(
  phase: PipelinePhase,
  payload: StageProgressEventPayload,
): StageAiOutputErrorCode | null {
  const fromMessage = extractKnownCodeFromText(payload.message);
  if (fromMessage) return fromMessage;
  if (payload.status === "invalid_output") {
    return phase === "Review" ? "invalid_review_output" : "invalid_stage_output";
  }
  if (payload.status === "failed") return "provider_run_failed";
  if (payload.status === "mirror_write_failed") return "mirror_write_failed";
  return null;
}

function stageRunStatusCode(
  phase: PipelinePhase,
  row: typeof stageRuns.$inferSelect | null,
): StageAiOutputErrorCode | null {
  if (!row) return null;
  if (row.status === "invalid_output") {
    return phase === "Review" ? "invalid_review_output" : "invalid_stage_output";
  }
  if (row.status === "failed") return "provider_run_failed";
  return null;
}

function latestStageProgress(
  db: ActionContractDb,
  changeId: string,
  phase: PipelinePhase,
): { row: typeof events.$inferSelect; payload: StageProgressEventPayload } | null {
  return db
    .select()
    .from(events)
    .where(and(eq(events.changeId, changeId), eq(events.type, "stage_progress")))
    .all()
    .map((row) => ({ row, payload: progressPayload(row) }))
    .filter(
      (candidate): candidate is { row: typeof events.$inferSelect; payload: StageProgressEventPayload } =>
        Boolean(candidate.payload && progressPhaseMatches(candidate.payload.phase, phase)),
    )
    .sort((left, right) => {
      const byCreated = right.row.createdAt.localeCompare(left.row.createdAt);
      if (byCreated !== 0) return byCreated;
      return right.row.id.localeCompare(left.row.id);
    })[0] ?? null;
}

function progressBelongsToLatestStageRun(
  progress: { row: typeof events.$inferSelect; payload: StageProgressEventPayload } | null,
  stageRun: typeof stageRuns.$inferSelect | null,
): boolean {
  if (!progress) return false;
  if (!stageRun) return true;
  if (progress.payload.stageRunId && progress.payload.stageRunId === stageRun.id) return true;
  const runTime = stageRun.completedAt ?? stageRun.startedAt ?? "";
  return progress.row.createdAt >= runTime;
}

function latestLegacyOutputSignal(
  db: ActionContractDb,
  changeId: string,
  phase: PipelinePhase,
): Pick<StageOutputSignal, "retryableErrorCode" | "sourceDbHash"> {
  const legacyRun = sortNewestRun(
    db
      .select()
      .from(runs)
      .where(eq(runs.changeId, changeId))
      .all()
      .filter((run) => runPhaseMatches(run.phase, phase)),
  );
  const runCode = retryableErrorCode(extractKnownCodeFromText(legacyRun?.summary ?? null));
  if (runCode || (legacyRun?.status === "failed" && phase !== "QA")) {
    return {
      retryableErrorCode: runCode ?? "provider_run_failed",
      sourceDbHash: legacyRun?.id ?? null,
    };
  }

  const eventRow = db
    .select()
    .from(events)
    .where(eq(events.changeId, changeId))
    .all()
    .filter((event) => event.type !== "stage_progress")
    .filter((event) => {
      if (event.runId && legacyRun?.id === event.runId) return true;
      const haystack = `${event.type} ${event.message ?? ""} ${event.rawJson ?? ""}`;
      return haystack.includes(`"phase":"${phase}"`) || haystack.includes(`phase:${phase}`);
    })
    .sort((left, right) => {
      const byCreated = right.createdAt.localeCompare(left.createdAt);
      if (byCreated !== 0) return byCreated;
      return right.id.localeCompare(left.id);
    })[0] ?? null;
  const eventCode = retryableErrorCode(extractKnownCodeFromText(`${eventRow?.message ?? ""} ${eventRow?.rawJson ?? ""}`));
  return {
    retryableErrorCode: eventCode,
    sourceDbHash: eventCode ? eventRow?.id ?? null : null,
  };
}

export function latestStageOutputSignal(db: ActionContractDb, changeId: string, phase: PipelinePhase): StageOutputSignal {
  const stageRun = sortNewestStageRun(
    db
      .select()
      .from(stageRuns)
      .where(and(eq(stageRuns.changeId, changeId), eq(stageRuns.phase, phase)))
      .all(),
  );
  const rawProgress = latestStageProgress(db, changeId, phase);
  const progress = progressBelongsToLatestStageRun(rawProgress, stageRun) ? rawProgress : null;
  const warnings: ActionContractWarning[] = [];

  const runCode =
    retryableErrorCode(stageRun?.errorCode) ??
    retryableErrorCode(lineageErrorCode(stageRun?.sourceLineageJson ?? null)) ??
    retryableErrorCode(stageRunStatusCode(phase, stageRun));
  const runWarning = stageOutputWarning(stageRun?.errorCode ?? lineageErrorCode(stageRun?.sourceLineageJson ?? null) ?? "");
  if (runWarning) warnings.push(runWarning);

  const progressCode = progress ? stageProgressCode(phase, progress.payload) : null;
  const progressRetryCode = retryableErrorCode(progressCode);
  const progressWarning = stageOutputWarning(progressCode ?? "");
  if (progressWarning) warnings.push(progressWarning);

  let retryable = runCode ?? progressRetryCode;
  let sourceDbHash = stageRun ? signalSourceDbHash(stageRun) : null;
  let gateVersion = stageRun ? String(stageRun.attemptNo) : null;
  if (!sourceDbHash && progress) {
    sourceDbHash = progress.row.runId ?? progress.row.id;
  }

  if (!retryable && phase === "Review") {
    const attempt = latestReviewAttempt(db, changeId);
    const attemptCode = retryableErrorCode(attempt?.errorCode);
    retryable = attemptCode;
    if (attemptCode) {
      sourceDbHash = attempt?.inputSourceDbHash ?? attempt?.id ?? sourceDbHash;
      gateVersion = attempt ? String(attempt.attemptNo) : gateVersion;
    }
    const attemptWarning = stageOutputWarning(attempt?.errorCode ?? "");
    if (attemptWarning) warnings.push(attemptWarning);
  }

  if (!retryable) {
    const legacy = latestLegacyOutputSignal(db, changeId, phase);
    retryable = legacy.retryableErrorCode;
    sourceDbHash = legacy.sourceDbHash ?? sourceDbHash;
  }

  return {
    retryableErrorCode: retryable,
    warnings: dedupeWarnings(warnings),
    sourceDbHash,
    gateVersion,
  };
}

export function applyStageOutputRetry(
  decision: ActionDecision,
  signal: StageOutputSignal | null,
  snapshot: StageAuthoritySnapshot,
): ActionDecision {
  if (!signal?.retryableErrorCode) return decision;
  const sourceDbHash: string | undefined =
    decision.sourceDbHash ??
    snapshot.latestGate?.sourceDbHash ??
    signal.sourceDbHash ??
    undefined;
  return {
    enabled: true,
    reasonCode: null,
    reason: null,
    blockers: [],
    gateVersion:
      decision.gateVersion
      ?? (snapshot.latestGate ? String(snapshot.latestGate.gateVersion) : signal.gateVersion)
      ?? undefined,
    sourceDbHash,
  };
}
