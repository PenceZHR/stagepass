import {
  parsePipelineJobPayload,
  type PipelineJobPayload,
  type PipelineJobRecord,
} from "./pipeline-job-types";
import type { JobExecutionContext } from "./job-execution-context";
import type { Provider } from "./provider-selection-service";
import { readCodexNativeFlags } from "../config/codex-native-flags";
import { db } from "../db";
import { stageJobNeedsFreshTask } from "./delegated-round-task-rotation";
import { usedSubAgentThreadIds } from "./delegated-round-side-history";
import { resolveStageClarificationPolicy } from "../../lib/stage-clarification-policy";
import { changeStageScope } from "./codex-desktop-bridge-types";
import { battleRounds, changes, codexLogicalTurns, codexTurnExecutions } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { parsePipelineJobEffect } from "../types/models";
import type { InteractionPresentationOrchestrator } from "./interaction-presentation-orchestrator";
import type { InteractionWakeupOrchestrator } from "./interaction-wakeup-orchestrator";
import type { CodexDesktopBridge } from "./codex-desktop-bridge";
import type { CodexManagedScope } from "./codex-desktop-bridge-types";

export type PipelineJobRunner = (
  job: PipelineJobRecord,
  context: JobExecutionContext,
) => Promise<unknown>;

/**
 * "phase:actionId" for exactly the pairs the authority table declares.
 *
 * Derived from PipelineJobRecord -- which carries PipelineJobSelection, the
 * discriminated union built from PIPELINE_JOB_ACTIONS_BY_PHASE in
 * pipeline-job-types.ts -- rather than restated here. The key set was previously
 * plain `string`, so adding a pair to the authority table without writing a
 * runner compiled cleanly and only threw once that job actually executed.
 */
export type PipelineJobRunnerKey =
  PipelineJobRecord extends infer Job
    ? Job extends { phase: infer P extends string; actionId: infer A extends string }
      ? `${P}:${A}`
      : never
    : never;

/**
 * Override maps (tests, the acceptance worker barrier) intentionally cover only
 * the pairs they care about, so the public shape stays partial. The built-in map
 * below is held to CompletePipelineJobRunnerMap instead.
 */
export type PipelineJobRunnerMap = Partial<Record<PipelineJobRunnerKey, PipelineJobRunner>>;

/** Every declared pair must have a runner. A missing one is a compile error. */
type CompletePipelineJobRunnerMap = Record<PipelineJobRunnerKey, PipelineJobRunner>;

export interface PipelineWorkerStageApi {
  runIntake(changeId: string, context: JobExecutionContext, provider?: Provider): Promise<unknown>;
  runPrdBriefingQuestions(changeId: string, context: JobExecutionContext, provider?: Provider): Promise<unknown>;
  runPrdBriefingDraft(changeId: string, context: JobExecutionContext, provider?: Provider): Promise<unknown>;
  runPrdBriefingFinalReview(changeId: string, context: JobExecutionContext, provider?: Provider): Promise<unknown>;
  runSpec(
    changeId: string,
    context: JobExecutionContext,
    options?: {
      idempotencyKey?: string;
      provider?: Provider;
      abandonClarification?: boolean;
    },
  ): Promise<unknown>;
  runTechSpec(changeId: string, context: JobExecutionContext, provider?: Provider): Promise<unknown>;
  generatePlan(changeId: string, context: JobExecutionContext, provider?: Provider): Promise<unknown>;
  runTestPlan(changeId: string, context: JobExecutionContext, provider?: Provider): Promise<unknown>;
  runImplementStreamed(changeId: string, context: JobExecutionContext, provider?: Provider): Promise<unknown>;
  retryBuildStreamed(changeId: string, context: JobExecutionContext, provider?: Provider): Promise<unknown>;
  runReview(
    changeId: string,
    context: JobExecutionContext,
    options?: { idempotencyKey?: string; provider?: Provider },
  ): Promise<unknown>;
  runCheck(
    changeId: string,
    context: JobExecutionContext,
    options: { entrypoint: "run_check"; actor: "system" },
  ): Promise<unknown>;
  runFixStreamed(changeId: string, context: JobExecutionContext, provider?: Provider): Promise<unknown>;
  runRelease(changeId: string, context: JobExecutionContext, provider?: Provider): Promise<unknown>;
  runRetro(changeId: string, context: JobExecutionContext, provider?: Provider): Promise<unknown>;
  runDelivery(changeId: string, context: JobExecutionContext, provider?: Provider): Promise<unknown>;
}

export interface RunPipelineJobOptions {
  runnerMap?: PipelineJobRunnerMap;
  pipeline?: PipelineWorkerStageApi;
  codexBindingPreflight?: (
    changeId: string,
    options: { freshTask: boolean },
  ) => Promise<void>;
  interactionPresentationOrchestrator?: Pick<InteractionPresentationOrchestrator, "run">;
  interactionWakeupOrchestrator?: Pick<InteractionWakeupOrchestrator, "run">;
}

// The cast is the one place a validated (phase, actionId) record is flattened
// into its key: TypeScript does not correlate the two fields across a union, so
// the raw template type would be every phase crossed with every actionId.
// parsePipelineJobPayload has already rejected undeclared pairs by this point.
function runnerKey(job: Pick<PipelineJobRecord, "phase" | "actionId">): PipelineJobRunnerKey {
  return `${job.phase}:${job.actionId}` as PipelineJobRunnerKey;
}

function runnerMapForPipeline(pipeline: PipelineWorkerStageApi): CompletePipelineJobRunnerMap {
  return {
    "intake:run_prd": (job, context) => pipeline.runIntake(job.changeId, context, job.provider),
    "intake:retry_prd": (job, context) => pipeline.runIntake(job.changeId, context, job.provider),
    "prd_briefing_questions:run_prd_briefing_questions": (job, context) =>
      pipeline.runPrdBriefingQuestions(job.changeId, context, job.provider),
    "prd_briefing_draft:run_prd_briefing_draft": (job, context) =>
      pipeline.runPrdBriefingDraft(job.changeId, context, job.provider),
    "prd_briefing_final_review:run_prd_briefing_final_review": (job, context) =>
      pipeline.runPrdBriefingFinalReview(job.changeId, context, job.provider),
    "spec:run_spec": (job, context) =>
      pipeline.runSpec(job.changeId, context, {
        idempotencyKey: job.idempotencyKey ?? undefined,
        provider: job.provider,
      }),
    // retry_spec already rotated the Codex task in the binding preflight, so
    // the questions a paused round was waiting on are gone with it. This flag
    // is what lets the claim take that round over; without it a round parked on
    // an unanswered card would have no exit at all.
    "spec:retry_spec": (job, context) =>
      pipeline.runSpec(job.changeId, context, {
        idempotencyKey: job.idempotencyKey ?? undefined,
        provider: job.provider,
        abandonClarification: true,
      }),
    "tech_spec:run_tech_spec": (job, context) => pipeline.runTechSpec(job.changeId, context, job.provider),
    "tech_spec:retry_tech_spec": (job, context) => pipeline.runTechSpec(job.changeId, context, job.provider),
    "generate_plan:run_plan": (job, context) => pipeline.generatePlan(job.changeId, context, job.provider),
    "generate_plan:retry_plan": (job, context) => pipeline.generatePlan(job.changeId, context, job.provider),
    "test_plan:run_test_plan": (job, context) => pipeline.runTestPlan(job.changeId, context, job.provider),
    "test_plan:retry_test_plan": (job, context) => pipeline.runTestPlan(job.changeId, context, job.provider),
    "implement:run_build": (job, context) => pipeline.runImplementStreamed(job.changeId, context, job.provider),
    "implement:retry_build": (job, context) => pipeline.retryBuildStreamed(job.changeId, context, job.provider),
    "review:run_review": (job, context) =>
      pipeline.runReview(job.changeId, context, {
        idempotencyKey: job.idempotencyKey ?? undefined,
        provider: job.provider,
      }),
    "review:retry_review": (job, context) =>
      pipeline.runReview(job.changeId, context, {
        idempotencyKey: job.idempotencyKey ?? undefined,
        provider: job.provider,
      }),
    "local_check:enter_qa": (job, context) =>
      pipeline.runCheck(job.changeId, context, { entrypoint: "run_check", actor: "system" }),
    "local_check:run_qa": (job, context) =>
      pipeline.runCheck(job.changeId, context, { entrypoint: "run_check", actor: "system" }),
    "local_check:retry_qa": (job, context) =>
      pipeline.runCheck(job.changeId, context, { entrypoint: "run_check", actor: "system" }),
    "fix_findings:fix_blockers": (job, context) => pipeline.runFixStreamed(job.changeId, context, job.provider),
    "fix_findings:run_fix": (job, context) => pipeline.runFixStreamed(job.changeId, context, job.provider),
    "fix_findings:retry_fix": (job, context) => pipeline.runFixStreamed(job.changeId, context, job.provider),
    "release:run_release": (job, context) => pipeline.runRelease(job.changeId, context, job.provider),
    "release:merge": (job, context) => pipeline.runRelease(job.changeId, context, job.provider),
    "retro:run_retro": (job, context) => pipeline.runRetro(job.changeId, context, job.provider),
    "delivery:run_delivery": (job, context) =>
      pipeline.runDelivery(job.changeId, context, job.provider),
  };
}

async function defaultRunnerMap(
  pipeline?: PipelineWorkerStageApi,
): Promise<PipelineJobRunnerMap> {
  return runnerMapForPipeline(pipeline ?? await import("./pipeline-service"));
}

export async function prepareVisibleCodexChangeTask(input: {
  changeId: string;
  projectId: string;
  /** Which stage's task to prepare; each stage owns its own Codex task. */
  stageId: string;
  bridge: CodexDesktopBridge;
  freshTask?: boolean;
  ensureBinding(args: {
    scope: CodexManagedScope;
    bridge: CodexDesktopBridge;
  }): Promise<unknown>;
  rotateBinding?(args: {
    scope: CodexManagedScope;
    bridge: CodexDesktopBridge;
  }): Promise<unknown>;
}): Promise<void> {
  await input.bridge.probe();
  const prepareBinding = input.freshTask
    ? input.rotateBinding
    : input.ensureBinding;
  if (!prepareBinding) {
    throw new Error("fresh Codex task rotation adapter is unavailable");
  }
  await prepareBinding({
    scope: changeStageScope({
      changeId: input.changeId,
      projectId: input.projectId,
      stageId: input.stageId,
    }),
    bridge: input.bridge,
  });
}

async function ensureVisibleCodexChangeTask(
  changeId: string,
  options: { freshTask: boolean; stageId: string },
): Promise<void> {
  const change = db.select({ projectId: changes.projectId })
    .from(changes)
    .where(eq(changes.id, changeId))
    .get();
  if (!change) throw new Error(`Change not found: ${changeId}`);

  const [
    { ensureCodexThreadBinding, rotateCodexThreadBinding },
    { getProductionCodexDesktopBridge },
  ] = await Promise.all([
    import("./codex-thread-binding-service"),
    import("./codex-desktop-engine"),
  ]);
  await prepareVisibleCodexChangeTask({
    changeId,
    projectId: change.projectId,
    stageId: options.stageId,
    bridge: await getProductionCodexDesktopBridge(),
    freshTask: options.freshTask,
    ensureBinding: ensureCodexThreadBinding,
    rotateBinding: rotateCodexThreadBinding,
  });
}

/**
 * Whether the change's CURRENT stage task has already spent sub-agents.
 *
 * Spent threads are recorded per change, and the binding's thread is the task
 * they were spent in -- so a recorded thread that is not a child of the current
 * task belongs to a task that is already gone. Comparing against the live
 * binding is what keeps a rotation from being triggered forever by history.
 */
function currentTaskSpentSubAgents(changeId: string): boolean {
  const rounds = db.select({ id: battleRounds.id, status: battleRounds.status })
    .from(battleRounds)
    .where(eq(battleRounds.changeId, changeId))
    .all();
  // No round has ever run for this change, so nothing can have been spent.
  if (rounds.length === 0) return false;
  return usedSubAgentThreadIds(changeId).size > 0
    && rounds.some((round) => round.status === "report_ready" || round.status === "closed"
      || round.status === "superseded");
}

export async function runPipelineJob(
  job: PipelineJobPayload,
  context: JobExecutionContext,
  options: RunPipelineJobOptions = {},
): Promise<void> {
  const rawJob = ("job" in job ? job.job : job) as typeof job.job & {
    jobKind?: "stage" | "interaction_present" | "interaction_wakeup";
    interactionId?: string | null;
    commandId?: string | null;
    effectSchemaVersion?: string | null;
    effectPayloadJson?: string | null;
    effectDeadlineAt?: string | null;
  };
  const jobKind = rawJob.jobKind ?? "stage";
  if (jobKind === "interaction_present") {
    const effect = parsePipelineJobEffect({
      jobKind,
      interactionId: rawJob.interactionId,
      commandId: rawJob.commandId,
      effectSchemaVersion: rawJob.effectSchemaVersion,
      effectPayloadJson: rawJob.effectPayloadJson,
    });
    if (effect?.kind !== "interaction_present") {
      throw new Error("interaction_presentation_payload_invalid");
    }
    if (
      !rawJob.effectDeadlineAt
      || !Number.isFinite(Date.parse(rawJob.effectDeadlineAt))
      || Date.parse(rawJob.effectDeadlineAt) <= Date.now()
    ) throw new Error("interaction_presentation_deadline_exhausted");
    const orchestrator = options.interactionPresentationOrchestrator
      ?? new (await import("./interaction-presentation-orchestrator"))
        .InteractionPresentationOrchestrator();
    await orchestrator.run(rawJob.id, context);
    return;
  }
  if (jobKind === "interaction_wakeup") {
    const effect = parsePipelineJobEffect({
      jobKind,
      interactionId: rawJob.interactionId,
      commandId: rawJob.commandId,
      effectSchemaVersion: rawJob.effectSchemaVersion,
      effectPayloadJson: rawJob.effectPayloadJson,
    });
    if (effect?.kind !== "interaction_wakeup") {
      throw new Error("interaction_wakeup_payload_invalid");
    }
    if (
      !rawJob.effectDeadlineAt
      || !Number.isFinite(Date.parse(rawJob.effectDeadlineAt))
      || Date.parse(rawJob.effectDeadlineAt) <= Date.now()
    ) throw new Error("interaction_wakeup_deadline_exhausted");
    const orchestrator = options.interactionWakeupOrchestrator
      ?? new (await import("./interaction-wakeup-orchestrator"))
        .InteractionWakeupOrchestrator();
    await orchestrator.run(rawJob.id, context);
    return;
  }
  if (jobKind !== "stage") {
    throw new Error(`Unsupported pipeline job kind: ${jobKind}`);
  }
  const payload = parsePipelineJobPayload(job);
  const parsedJob = payload.job;
  const runners = options.runnerMap ?? await defaultRunnerMap(options.pipeline);
  const key = runnerKey(parsedJob);
  const runner = runners[key];
  if (!runner) {
    throw new Error(`Unsupported pipeline job action: ${key}`);
  }
  const desktopBridgeEnabled = readCodexNativeFlags().desktopBridge;
  const bindingPreflight = options.codexBindingPreflight
    ?? (desktopBridgeEnabled ? ensureVisibleCodexChangeTask : null);
  if (bindingPreflight) {
    await bindingPreflight(parsedJob.changeId, {
      // Keyed off what the work needs, not off what the button was called.
      // See delegated-round-task-rotation.ts for the failure this replaces.
      freshTask: stageJobNeedsFreshTask({
        actionId: parsedJob.actionId,
        phase: parsedJob.phase,
        delegatedRoundsEnabled: readCodexNativeFlags().specJudgeSubAgents,
        // Sub-agents are recorded per change as they are spent, and the current
        // task is the one that spent them. Empty means this task has never
        // hosted a round, so it is already the fresh task the round needs --
        // rotating it would only throw away what the human is watching.
        taskHasSpentSubAgents:
          currentTaskSpentSubAgents(parsedJob.changeId),
      }),
      stageId: resolveStageClarificationPolicy(parsedJob.phase).id,
    });
  }
  if (desktopBridgeEnabled) {
    const recoverable = db.select({ id: codexLogicalTurns.logicalTurnId })
      .from(codexLogicalTurns)
      .innerJoin(
        codexTurnExecutions,
        eq(codexTurnExecutions.logicalTurnId, codexLogicalTurns.logicalTurnId),
      )
      .where(and(
        eq(codexLogicalTurns.pipelineJobId, parsedJob.id),
        eq(codexTurnExecutions.status, "running"),
      )).get();
    if (recoverable) {
      const [
        { getProductionCodexDesktopBridge },
        { recoverDesktopFollowerTurnsForPipelineJob },
      ] = await Promise.all([
        import("./codex-desktop-engine"),
        import("./stale-provider-run-recovery-service"),
      ]);
      await recoverDesktopFollowerTurnsForPipelineJob(
        parsedJob.id,
        await getProductionCodexDesktopBridge(),
      );
    }
  }
  await runner(parsedJob, context);
}
