import { eq } from "drizzle-orm";
import { db } from "../db";
import { runLedgerRepository } from "../repositories/run-ledger-repository";
import { changes, projects } from "../db/schema";
import { createChildLogger } from "../logger";
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
  approvePlanSnapshot,
  assertPlanCanApprove,
  persistGeneratedPlanSnapshot,
  writeGeneratedPlanArtifactsFromDbBestEffort,
} from "./plan-sandbox-service";
import {
  createProviderLifecycleSink,
  getPipelineEngine,
  type EngineProvider,
} from "./pipeline-engine-service";
import { recoverStrandedRunningStatus } from "./pipeline-document-stage-runner-service";
import {
  beginStageRun,
  blockStageViolation,
  endStageRun,
  setStatus,
  StageBoundaryViolationError,
} from "./pipeline-run-ledger-service";
import { ingestStageAiOutput } from "./stage-ai-output-ingestion-service";
import { persistStageRawCapture } from "./stage-raw-capture-service";
import { applyLineProtocol, guardLineProtocolSchema } from "./ai-line-protocol";
import { parsePlanLineProtocol } from "./plan-line-protocol";
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  validateReadOnlyStage,
} from "./stage-guard-service";
import type { Change, ChangeStatus, Project } from "../types";
import type { Provider } from "./provider-selection-service";
import {
  recordProviderSession,
  resolveProviderSession,
} from "./provider-session-service";

const log = createChildLogger("pipeline-service");

function getProject(projectId: string): Project | undefined {
  return db.select().from(projects).where(eq(projects.id, projectId)).get() as Project | undefined;
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

export interface PlanStep {
  step: number;
  description: string;
  file?: string;
  status?: "pending" | "blocked" | "done";
}

export interface PlanJson {
  planName?: string;
  expectedFiles?: string[];
  forbiddenFiles?: string[];
  implementationSteps?: PlanStep[];
  testPlan?: string[];
  validationCommands?: string[];
  risks?: string[];
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isPlanStepStatus(value: unknown): value is PlanStep["status"] {
  return value === "pending" || value === "blocked" || value === "done";
}

export function requireValidPlanStructuredOutput(value: unknown): PlanJson {
  if (!value || typeof value !== "object") {
    throw new Error("Plan generation requires a structured plan object");
  }

  const plan = value as PlanJson;
  if (typeof plan.planName !== "string" || !plan.planName.trim()) {
    throw new Error("Plan structuredOutput missing planName");
  }
  if (!isStringArray(plan.expectedFiles)) {
    throw new Error("Plan structuredOutput missing expectedFiles");
  }
  if (!isStringArray(plan.forbiddenFiles)) {
    throw new Error("Plan structuredOutput missing forbiddenFiles");
  }
  if (!Array.isArray(plan.implementationSteps) || plan.implementationSteps.length === 0) {
    throw new Error("Plan structuredOutput missing implementationSteps");
  }
  for (const step of plan.implementationSteps) {
    if (
      !step ||
      typeof step !== "object" ||
      typeof step.step !== "number" ||
      typeof step.description !== "string" ||
      typeof step.file !== "string" ||
      !isPlanStepStatus(step.status)
    ) {
      throw new Error("Plan structuredOutput implementationSteps require step, file, description, and status");
    }
  }
  if (!isStringArray(plan.testPlan)) {
    throw new Error("Plan structuredOutput missing testPlan");
  }
  if (!isStringArray(plan.validationCommands)) {
    throw new Error("Plan structuredOutput missing validationCommands");
  }
  if (!isStringArray(plan.risks)) {
    throw new Error("Plan structuredOutput missing risks");
  }

  return plan;
}

function validatePlanStructuredOutput(value: unknown): true | { ok: false; message: string } {
  try {
    requireValidPlanStructuredOutput(value);
    return true;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export const PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    planName: { type: "string" },
    expectedFiles: { type: "array", items: { type: "string" } },
    forbiddenFiles: { type: "array", items: { type: "string" } },
    implementationSteps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step: { type: "number" },
          description: { type: "string" },
          file: { type: "string" },
          status: { type: "string", enum: ["pending", "blocked", "done"] },
        },
        required: ["step", "description", "file", "status"],
        additionalProperties: false,
      },
    },
    testPlan: { type: "array", items: { type: "string" } },
    validationCommands: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
  },
  required: [
    "planName",
    "expectedFiles",
    "forbiddenFiles",
    "implementationSteps",
    "testPlan",
    "validationCommands",
    "risks",
  ],
  additionalProperties: false,
};

export async function generatePlan(
  changeId: string,
  context: JobExecutionContext,
  requestedProvider?: Provider,
): Promise<AiRunResult> {
  return withExecutionFence(context, () => generatePlanInExecutionScope(changeId, context, requestedProvider));
}

/**
 * Exactly what `assertStatus` below accepts, named so the action contract can
 * mirror it instead of guessing (`retry_plan`'s requiredStatus).
 *
 * PLANNING is deliberately absent: it is the stage's own running status, and
 * letting the guard accept it would make "PLANNING" stop meaning "a
 * generate_plan run is in flight". A change stranded there is repaired first,
 * then runs through this guard unchanged.
 */
const PLAN_ALLOWED_STATUSES: ChangeStatus[] = ["PLAN_READY", "TECHSPEC_READY"];

async function generatePlanInExecutionScope(
  changeId: string,
  context: JobExecutionContext,
  requestedProvider?: Provider,
): Promise<AiRunResult> {
  const initialChange = getChange(changeId);
  if (!initialChange) throw new Error(`Change not found: ${changeId}`);
  const provider = requestedProvider ?? context.provider ?? (initialChange.provider as Provider);
  // Repair a PLANNING claim no run is backing before the guard reads it,
  // otherwise a retry can never get past assertStatus to create one -- the
  // permanent dead end 8ac5c4ec fixed for TechSpec. Plan is dispatched straight
  // to generatePlan rather than through runDocumentStage, so that commit's
  // recovery never reached this stage; it has to be invoked here.
  const recovery = recoverStrandedRunningStatus({
    changeId,
    phase: "generate_plan",
    status: initialChange.status as ChangeStatus,
    allowedStatuses: PLAN_ALLOWED_STATUSES,
    runningStatus: "PLANNING",
    // The sweeper's own rollback target for this phase
    // (fallbackStatusByProviderPhase.generate_plan) and, apart from PLAN_READY
    // and BLOCKED, the only exit ALLOWED_TRANSITIONS grants PLANNING.
    failureStatus: "TECHSPEC_READY",
    eventSource: "plan_stage_stranded_status_recovery",
  });
  const change = recovery.recovered ? getChange(changeId) ?? initialChange : initialChange;
  assertStatus(change, ...PLAN_ALLOWED_STATUSES);

  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);

  const runId = beginStageRun({ changeId, phase: "generate_plan", runningStatus: "PLANNING", provider });

  try {
    const prompt = assemblePrompt("plan", {
      changeId,
      repoPath: project.repoPath,
    });

    const beforeAi = captureWorkspaceSnapshot(project.repoPath);
    const engine = await getPipelineEngine(provider as "codex" | "claude");
    const result = await engine.run({
      changeId,
      repoPath: project.repoPath,
      phase: "plan",
      threadId: resolveProviderSession({ changeId, provider, sessionKind: "general" }) ?? undefined,
      prompt,
      // Line-protocol stage: the model writes protocol lines, never JSON;
      // PLAN_JSON_SCHEMA stays server-side as the second gate.
      sandboxMode: "read-only",
      lifecycle: createProviderLifecycleSink({
        ...context,
        changeId,
        runId,
        phase: "generate_plan",
        provider: provider as EngineProvider,
        closeBusinessRunOnProviderFailure: false,
      }),
    });
    assertCurrentExecutionFence(context, runId);
    const afterAi = captureWorkspaceSnapshot(project.repoPath);
    const mutations = diffWorkspaceSnapshots(beforeAi, afterAi);
    const violation = validateReadOnlyStage("generate_plan", mutations);
    if (violation.blocked) {
      await blockStageViolation(changeId, runId, violation);
    }

    // Persist a provider-scoped session; only Codex/general mirrors the legacy field.
    const threadId = result.threadId?.trim();
    if (threadId && threadId.toLowerCase() !== "unknown") {
      recordProviderSession({
        changeId,
        provider,
        sessionKind: "general",
        externalSessionId: threadId,
        lastRunId: runId,
      });
      if (provider === "codex") {
        runLedgerRepository.patchChange(changeId, { codexThreadId: threadId }, { runId });
      }
    }

    const providerFailed = !result.success;
    const lineProtocol = applyLineProtocol(
      result,
      (rawText, ctx) => {
        const parsed = parsePlanLineProtocol(rawText, ctx);
        return parsed.ok
          ? { ok: true, payload: parsed.payload as unknown as Record<string, unknown> }
          : parsed;
      },
      { changeId, repoPath: project.repoPath },
    );
    const ingestion = await ingestStageAiOutput({
      changeId,
      runId,
      phase: "generate_plan",
      provider,
      outputSchema: PLAN_JSON_SCHEMA,
      aiResult: providerFailed
        ? {
            ...result,
            structuredOutput: undefined,
            structuredOutputSource: undefined,
          }
        : lineProtocol.result,
      contract: {
        allowedCandidateFiles: [],
        safeRoot: `.ship/changes/${changeId}`,
        sandboxReadOnly: true,
        validateSchema: (value) => {
          if (providerFailed) {
            return {
              ok: false,
              message: result.providerErrorDetail || result.providerErrorCode || "Plan provider failed",
            };
          }
          return guardLineProtocolSchema(
            lineProtocol.state,
            validatePlanStructuredOutput,
            "generate_plan",
          )(value);
        },
        validateBusiness: () => true,
        writeRawCapture: (envelope) =>
          persistStageRawCapture({
            repoPath: project.repoPath,
            changeId,
            runId,
            envelope,
          }),
      },
    });
    if (!ingestion.ok) {
      throw new Error(`Plan generation produced invalid stage output: ${ingestion.sanitizedErrorSummary}`);
    }
    const structuredPlan = requireValidPlanStructuredOutput(ingestion.structuredOutput);

    assertCurrentExecutionFence(context, runId);
    const snapshotId = persistGeneratedPlanSnapshot({
      changeId,
      repoPath: project.repoPath,
      plan: structuredPlan,
    });
    await writeGeneratedPlanArtifactsFromDbBestEffort({ changeId, runId, snapshotId });

    endStageRun({ changeId, runId, status: "PLAN_READY", summary: "Plan generated", success: true });

    log.info({ changeId }, "Plan generated");
    return { ...result, structuredOutput: structuredPlan };
  } catch (err) {
    if (err instanceof StaleLeaseFenceError) {
      throw err;
    }
    if (err instanceof StageBoundaryViolationError) {
      throw err;
    }
    endStageRun({
      changeId, runId, status: change.status as ChangeStatus,
      summary: String(err), success: false,
    });
    throw err;
  }
}

export type PlanApprovalContext = {
  source: "route_preflight";
};

function assertPlanApprovalContext(context?: PlanApprovalContext): asserts context is PlanApprovalContext {
  if (context?.source !== "route_preflight") {
    throw new Error("Plan approval requires route preflight context");
  }
}

export async function approvePlan(changeId: string, context?: PlanApprovalContext): Promise<void> {
  assertPlanApprovalContext(context);
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  assertStatus(change, "PLAN_READY", "TESTPLAN_DONE");

  if (change.status === "TESTPLAN_DONE") {
    await setStatus(changeId, "PLAN_APPROVED");
    log.info({ changeId }, "TestPlan completion reconciled to Plan approved");
    return;
  }

  assertPlanCanApprove(changeId);
  approvePlanSnapshot(changeId);

  await setStatus(changeId, "PLAN_APPROVED");
  log.info({ changeId }, "Plan approved");
}
