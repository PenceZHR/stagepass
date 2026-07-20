import type { AiRunResult } from "./ai-engine-types";
import {
  type JobExecutionContext,
} from "./job-execution-context";
import {
  documentStageTimeoutCleanupGraceMs,
  documentStageTimeoutMs,
  documentStageWatchdogTimeoutMs,
  resolveReviewTimeoutMs,
  setDocumentStageTimeoutMsForTest,
  setDocumentStageTimeoutCleanupGraceMsForTest,
  setPipelineEngineFactoryForTest,
  setReviewTimeoutMsForTest,
  MAX_DOCUMENT_STAGE_TIMEOUT_CLEANUP_GRACE_MS,
  MAX_NODE_TIMER_DELAY_MS,
  type EngineProvider,
} from "./pipeline-engine-service";
import {
  runDocumentStage,
  withDocumentStageExecutionContext,
} from "./pipeline-document-stage-runner-service";
import {
  assertCanRunCheck,
  runCheck as runCheckStage,
  type RunCheckOptions,
} from "./pipeline-qa-stage-service";
import {
  runTechSpec as runTechSpecStage,
  runTestPlan as runTestPlanStage,
} from "./pipeline-design-stage-service";
import {
  runRelease as runReleaseStage,
  runRetro as runRetroStage,
} from "./pipeline-release-retro-stage-service";
import type { Provider } from "./provider-selection-service";

export {
  documentStageTimeoutCleanupGraceMs,
  documentStageTimeoutMs,
  documentStageWatchdogTimeoutMs,
  MAX_DOCUMENT_STAGE_TIMEOUT_CLEANUP_GRACE_MS,
  MAX_NODE_TIMER_DELAY_MS,
  resolveReviewTimeoutMs,
  setDocumentStageTimeoutMsForTest,
  setDocumentStageTimeoutCleanupGraceMsForTest,
  setPipelineEngineFactoryForTest,
  setReviewTimeoutMsForTest,
  type EngineProvider,
};

export {
  approveBuildAbsorb,
  approveFixAbsorb,
  consumeBuildStreamWithStartupTimeout,
  formatThreadEvent,
  recoverCurrentBuildRun,
  rejectBuildRun,
  runFix,
  runFixStreamed,
  runImplement,
  runImplementStreamed,
  retryBuildStreamed,
  type FormattedEvent,
} from "./pipeline-build-stage-service";

export {
  approvePlan,
  generatePlan,
} from "./pipeline-plan-stage-service";

export {
  type RunCheckOptions,
} from "./pipeline-qa-stage-service";

export {
  emitPrdBriefingAsyncFailureProgress,
  runPrdBriefingDraft,
  runPrdBriefingFinalReview,
  runPrdBriefingQuestions,
} from "./pipeline-prd-briefing-stage-service";

export {
  preflightReviewRun,
  runReview,
} from "./pipeline-review-stage-service";
export type {
  ReviewFinding,
  ReviewResult,
  RunReviewOptions,
  ReviewRunPreflight,
} from "./pipeline-review-stage-service";

export {
  runSpec,
} from "./pipeline-spec-stage-service";
export type {
  RunSpecOptions,
} from "./pipeline-spec-stage-service";

export { assertCanRunCheck };

export async function runTechSpec(
  changeId: string,
  context: JobExecutionContext,
  provider?: Provider,
): Promise<AiRunResult> {
  return withDocumentStageExecutionContext(context, () => runTechSpecStage(changeId, context, provider));
}

export async function runTestPlan(
  changeId: string,
  context: JobExecutionContext,
  provider?: Provider,
): Promise<AiRunResult> {
  return withDocumentStageExecutionContext(context, () => runTestPlanStage(changeId, context, provider));
}

export async function runCheck(
  changeId: string,
  context: JobExecutionContext,
  options: RunCheckOptions = {},
): Promise<void> {
  return runCheckStage(changeId, context, options);
}

export async function runRelease(
  changeId: string,
  context: JobExecutionContext,
  provider?: Provider,
): Promise<void> {
  return withDocumentStageExecutionContext(context, () => runReleaseStage(changeId, context, provider));
}

export async function runRetro(
  changeId: string,
  context: JobExecutionContext,
  provider?: Provider,
): Promise<AiRunResult> {
  return withDocumentStageExecutionContext(context, () => runRetroStage(changeId, context, provider));
}

export async function runIntake(
  changeId: string,
  context: JobExecutionContext,
  provider?: Provider,
): Promise<AiRunResult> {
  return runDocumentStage(changeId, {
    phase: "intake",
    promptPhase: "intake",
    allowedStatuses: ["INTAKE_PENDING", "BLOCKED"],
    runningStatus: "INTAKE_PENDING",
    successStatus: "INTAKE_READY",
    failureStatus: "INTAKE_PENDING",
    artifactType: "change_request",
    artifactFileName: "change-request.md",
    successSummary: "Intake completed",
    provider,
  }, context);
}
