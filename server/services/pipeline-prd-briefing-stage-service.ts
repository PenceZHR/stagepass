import { eq } from "drizzle-orm";
import { db } from "../db";
import { runLedgerRepository } from "../repositories/run-ledger-repository";
import { changes, events, projects, runs } from "../db/schema";
import type { Change, ChangeStatus, Project, RunPhase } from "../types";
import type { AiRunResult } from "./ai-engine-types";
import type { JobExecutionContext } from "./job-execution-context";
import { withExecutionFence } from "./execution-fence-service";
import {
  createProviderLifecycleSink,
  documentStageTimeoutMs,
  getPipelineEngine,
  type EngineProvider,
} from "./pipeline-engine-service";
import { defaultScopeForPhase } from "./pipeline-document-stage-runner-service";
import {
  assertNoRunningPrdBriefingRun,
  completeFinalReview,
  completePrdDraft,
  completeQuestionGeneration,
  getPrdBriefingState,
} from "./prd-briefing-service";
import {
  BriefingQuestionsOutputSchema,
  FinalReviewOutputSchema,
  PrdBriefingDraftOutputSchema,
  type BriefingQuestionsOutput,
  type FinalReviewOutput,
  type PrdBriefingDraftOutput,
} from "./prd-briefing-ledger";
import {
  beginStageRun,
  blockStageViolation,
  createRun,
  endRun,
  StageBoundaryViolationError,
} from "./pipeline-run-ledger-service";
import { assemblePrompt, type PromptPhase } from "./prompt-service";
import {
  applyLineProtocol,
  guardLineProtocolSchema,
  type LineProtocolContext,
  type LineProtocolParseResult,
  type LineProtocolState,
} from "./ai-line-protocol";
import {
  parseBriefingQuestionsLineProtocol,
  parseFinalReviewLineProtocol,
  parsePrdBriefingDraftLineProtocol,
} from "./prd-briefing-line-protocol";
import {
  ingestStageAiOutput,
  type StageAiOutputIngestionAiResult,
} from "./stage-ai-output-ingestion-service";
import { persistStageRawCapture } from "./stage-raw-capture-service";
import {
  recordProviderSession,
  resolveProviderSession,
} from "./provider-session-service";
import type { Provider } from "./provider-selection-service";
import { terminalStageProgressStatus } from "./stage-ai-output-contract";
import type {
  AiOutputMode,
  StageProgressEventPayload,
  StructuredOutputSource,
} from "./stage-ai-output-contract";
import { emitStageProgress } from "./stage-progress-service";
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  validatePlannedChanges,
} from "./stage-guard-service";

interface PrdBriefingStageConfig {
  promptPhase: Extract<PromptPhase, "prd_briefing_questions" | "prd_briefing_draft" | "prd_briefing_final_review">;
  progressPhase: "prd_briefing_questions" | "prd_briefing_draft" | "prd_briefing_final_review";
  label: string;
  outputMode: AiOutputMode;
  outputSchema: Record<string, unknown>;
  complete: (changeId: string, output: unknown) => Promise<unknown>;
  provider?: Provider;
  /**
   * When set, the model writes protocol lines instead of JSON: stagepass parses
   * them and assembles the payload, the engine is handed no outputSchema, and
   * `outputSchema` above demotes to a server-side second gate.
   */
  lineProtocol?: {
    parse: (rawText: string, ctx: LineProtocolContext) => LineProtocolParseResult;
  };
}

class PipelineRunStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineRunStoppedError";
  }
}

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

function assertRunStillRunning(runId: string): void {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run || run.status !== "running") {
    throw new PipelineRunStoppedError(`Run was stopped before completion: ${runId}`);
  }
}

function assertChangeNotBlocked(changeId: string, phase: RunPhase): void {
  const change = getChange(changeId);
  if (change?.status === "BLOCKED") {
    throw new PipelineRunStoppedError(`${phase} stage stopped because change is blocked`);
  }
}

function okValidation(result: { success: boolean; error?: unknown }) {
  return result.success ? { ok: true } : { ok: false, error: result.error };
}

function questionOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      unit: { type: "string" },
      changeId: { type: "string" },
      phase: { type: "string" },
      questions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            category: {
              type: "string",
              enum: ["goal", "user", "scope", "success", "negative_case", "risk", "constraint", "spec_blocker"],
            },
            severity: { type: "string", enum: ["critical", "important", "optional"] },
            question: { type: "string", minLength: 1 },
            whyItMatters: { type: "string", minLength: 1 },
            suggestedDefault: { type: ["string", "null"] },
          },
          required: ["category", "severity", "question", "whyItMatters", "suggestedDefault"],
        },
      },
    },
    required: ["unit", "changeId", "phase", "questions"],
  };
}

function draftOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      markdown: { type: "string", minLength: 1 },
    },
    required: ["markdown"],
  };
}

function finalReviewOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      unit: { type: "string" },
      verdict: { type: "string", enum: ["ready", "needs_answer", "risky_but_allowed"] },
      blockingQuestionIds: { type: "array", items: { type: "string" } },
      riskSummary: { type: "string" },
      recommendedNextAction: { type: "string", enum: ["lock_prd", "answer_questions", "cancel_change"] },
    },
    required: ["unit", "verdict", "blockingQuestionIds", "riskSummary", "recommendedNextAction"],
  };
}

function prepareAiResultForIngestion(
  result: AiRunResult,
  config: PrdBriefingStageConfig,
): StageAiOutputIngestionAiResult {
  if (
    config.outputMode === "markdown"
    && result.success
    && result.structuredOutput === undefined
    && result.summary.trim().length > 0
  ) {
    return {
      ...result,
      structuredOutput: { markdown: result.summary },
      structuredOutputSource: "text_extracted",
    };
  }

  return result;
}

async function emitProgress(input: {
  changeId: string;
  repoPath: string;
  phase: PrdBriefingStageConfig["progressPhase"];
  runId: string;
  status: StageProgressEventPayload["status"];
  source: StageProgressEventPayload["source"];
  message?: string;
}): Promise<void> {
  await emitStageProgress({
    changeId: input.changeId,
    repoPath: input.repoPath,
    payload: {
      schemaVersion: "stage_progress/v1",
      phase: input.phase,
      runId: input.runId,
      status: input.status,
      source: input.source,
      message: input.message,
    },
  });
}

function latestIntakeRunId(changeId: string): string | null {
  return db.select().from(runs)
    .where(eq(runs.changeId, changeId))
    .all()
    .filter((run) => run.phase === "intake")
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || b.id.localeCompare(a.id))[0]?.id ?? null;
}

function isTerminalProgress(progress: StageProgressEventPayload): boolean {
  return ["completed", "failed", "invalid_output"].includes(progress.status);
}

function latestProgress(changeId: string, phase: PrdBriefingStageConfig["progressPhase"]): StageProgressEventPayload | null {
  const rows = db.select().from(events).where(eq(events.changeId, changeId)).all()
    .filter((event) => event.type === "stage_progress" && event.rawJson)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.rawJson ?? "") as { stageProgress?: StageProgressEventPayload };
      const progress = parsed.stageProgress;
      if (progress?.phase === phase) {
        return progress;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function latestTerminalProgressForRun(
  changeId: string,
  phase: PrdBriefingStageConfig["progressPhase"],
  runId: string,
): StageProgressEventPayload | null {
  const progress = latestProgress(changeId, phase);
  if (progress?.runId === runId && isTerminalProgress(progress)) {
    return progress;
  }
  return null;
}

export async function emitPrdBriefingAsyncFailureProgress(input: {
  changeId: string;
  phase: PrdBriefingStageConfig["progressPhase"];
  message: string;
}): Promise<void> {
  const latest = latestProgress(input.changeId, input.phase);
  if (latest && isTerminalProgress(latest)) return;
  await emitStageProgress({
    changeId: input.changeId,
    payload: {
      schemaVersion: "stage_progress/v1",
      phase: input.phase,
      runId: latestIntakeRunId(input.changeId) ?? `prd-briefing-${input.phase}`,
      status: "failed",
      source: "none",
      message: input.message,
    },
  });
}

async function runPrdBriefingStage(
  changeId: string,
  context: JobExecutionContext,
  config: PrdBriefingStageConfig,
): Promise<AiRunResult> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  assertStatus(change, "INTAKE_PENDING", "BLOCKED");
  assertNoRunningPrdBriefingRun(changeId);

  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);

  const provider = config.provider ?? context.provider ?? (change.provider as Provider);
  // A briefing run resumed from BLOCKED must transition the change out of BLOCKED
  // at run-start -- BLOCKED -> INTAKE_PENDING and the run row in one transaction --
  // before assertChangeNotBlocked fires later in this function. createRun alone
  // never touches changes.status, so it would leave the change BLOCKED and kill the
  // run mid-flight (matching legacy runIntake, which self-unblocks via beginStageRun
  // inside runStageWithLedger). The normal INTAKE_PENDING path stays on createRun so
  // it is byte-identical -- no redundant INTAKE_PENDING -> INTAKE_PENDING status event.
  const runId = change.status === "BLOCKED"
    ? beginStageRun({ changeId, phase: "intake", runningStatus: "INTAKE_PENDING", provider })
    : await createRun(changeId, "intake", provider);
  const scope = defaultScopeForPhase("intake");

  try {
    const prompt = assemblePrompt(config.promptPhase, {
      changeId,
      repoPath: project.repoPath,
    }, scope);

    const beforeAi = captureWorkspaceSnapshot(project.repoPath);
    const engine = await getPipelineEngine(provider as EngineProvider);
    const stageTimeoutMs = documentStageTimeoutMs();
    await emitProgress({
      changeId,
      repoPath: project.repoPath,
      phase: config.progressPhase,
      runId,
      status: "provider_running",
      source: "none",
      message: `${config.label} provider running`,
    });
    const result = await engine.run({
      changeId,
      repoPath: project.repoPath,
      phase: "intake",
      threadId: resolveProviderSession({ changeId, provider, sessionKind: "general" }) ?? undefined,
      prompt,
      // Line-protocol stages hand the engine no schema: a schema in the request
      // is the invitation to author JSON by hand. config.outputSchema stays
      // server-side as the second gate over the assembled payload.
      outputSchema: config.lineProtocol ? undefined : config.outputSchema,
      outputMode: config.outputMode,
      sandboxMode: "read-only",
      timeoutMs: stageTimeoutMs,
      lifecycle: createProviderLifecycleSink({
        ...context,
        changeId,
        runId,
        phase: "intake",
        provider: provider as EngineProvider,
        closeBusinessRunOnProviderFailure: false,
      }),
    });
    assertRunStillRunning(runId);
    assertChangeNotBlocked(changeId, "intake");

    const afterAi = captureWorkspaceSnapshot(project.repoPath);
    const mutations = diffWorkspaceSnapshots(beforeAi, afterAi);
    const violation = validatePlannedChanges(mutations, scope);
    if (violation.blocked) {
      await blockStageViolation(changeId, runId, violation);
    }

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

    assertRunStillRunning(runId);
    assertChangeNotBlocked(changeId, "intake");
    await emitProgress({
      changeId,
      repoPath: project.repoPath,
      phase: config.progressPhase,
      runId,
      status: "ingesting",
      source: "none",
      message: `${config.label} output ingesting`,
    });

    let lineProtocolState: LineProtocolState | undefined;
    let aiResultForIngestion: StageAiOutputIngestionAiResult;
    if (config.lineProtocol) {
      const applied = applyLineProtocol(result, config.lineProtocol.parse, {
        changeId,
        repoPath: project.repoPath,
      });
      lineProtocolState = applied.state;
      aiResultForIngestion = applied.result;
    } else {
      aiResultForIngestion = prepareAiResultForIngestion(result, config);
    }

    const ingestion = await ingestStageAiOutput({
      changeId,
      runId,
      phase: config.progressPhase,
      provider,
      outputSchema: config.outputSchema,
      aiResult: aiResultForIngestion,
      contract: {
        // No candidate-file recovery on these stages. The provider runs under
        // sandboxMode: "read-only" (above), so it physically cannot author
        // prd-draft.md / briefing-questions.json / prd-final-review.json --
        // every file this contract could ever find is stagepass's OWN DB mirror,
        // written by refreshPrdBriefingMirrors. Adopting one promoted a stale
        // mirror to DB authority and re-stamped draftInputHash against the new
        // inputs, silently clearing the "PRD draft is stale" blocker. The
        // contract was written for "provider wrote the file then timed out",
        // a shape read-only sandboxing makes unreachable. Matches the plan,
        // spec and document stages.
        allowedCandidateFiles: [],
        safeRoot: `.ship/changes/${changeId}`,
        sandboxReadOnly: true,
        validateSchema: (value) => {
          // A failed provider run has no trustworthy reply to parse, and with
          // no candidate files there is nothing else left to trust. Fail closed
          // so the guarantee does not rest on allowedCandidateFiles staying
          // empty -- the spec and review stages hold the same belt.
          if (!result.success) {
            return {
              ok: false,
              message: result.providerErrorDetail
                || result.providerErrorCode
                || `${config.label} provider failed`,
            };
          }
          const validate = (candidate: unknown) => {
            if (config.progressPhase === "prd_briefing_questions") {
              return okValidation(BriefingQuestionsOutputSchema.safeParse(candidate));
            }
            if (config.progressPhase === "prd_briefing_draft") {
              return okValidation(PrdBriefingDraftOutputSchema.safeParse(candidate));
            }
            return okValidation(FinalReviewOutputSchema.safeParse(candidate));
          };
          // The line protocol governs what the model *wrote*, so it is
          // authoritative for every reply that reaches here -- the failed-run
          // case, whose state would be empty, returned above.
          if (lineProtocolState) {
            const base = (candidate: unknown): true | { ok: false; message: string } => {
              const outcome = validate(candidate);
              if (outcome.ok) return true;
              const error = (outcome as { error?: unknown }).error;
              return { ok: false, message: error instanceof Error ? error.message : String(error) };
            };
            return guardLineProtocolSchema(lineProtocolState, base, config.progressPhase)(value);
          }
          return validate(value);
        },
        validateBusiness: (value) => {
          // Defense in depth. The final-review known-id cross-check lives in the
          // parser, so it guards only what the line protocol assembled;
          // validateSchema's fallback is bare FinalReviewOutputSchema —
          // `z.array(z.string())`, no cross-check. A blockingQuestionId that
          // names no real question is a permanent phantom blocker
          // (computePrdGate blocks on any non-empty set, and only ids mapping to
          // open questions can ever be cleared). Enforcing it here keeps the
          // second gate as strong as the parser on every path that reaches it.
          if (config.progressPhase !== "prd_briefing_final_review") return true;
          const blocking = (value as { blockingQuestionIds?: unknown }).blockingQuestionIds;
          if (!Array.isArray(blocking)) return true;
          const known = new Set(getPrdBriefingState(changeId).questions.map((question) => question.id));
          const phantom = blocking.filter((id): id is string => typeof id === "string" && !known.has(id));
          if (phantom.length > 0) {
            return { ok: false, message: `final review references unknown question id(s): ${phantom.join(", ")}` };
          }
          return true;
        },
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
      await emitProgress({
        changeId,
        repoPath: project.repoPath,
        phase: config.progressPhase,
        runId,
        status: terminalStageProgressStatus(ingestion.errorCode),
        source: ingestion.structuredOutputSource,
        message: ingestion.sanitizedErrorSummary,
      });
      throw new Error(ingestion.sanitizedErrorSummary || `${config.label} output invalid`);
    }

    await config.complete(changeId, ingestion.structuredOutput);
    // A failed provider run can no longer reach here: every accepting path in
    // ingestStageAiOutput is gated on provider success once the candidate-file
    // list is empty, so ingestion.ok implies result.success and the old
    // "recovered from provider failure via file candidate" warning is dead.
    await emitProgress({
      changeId,
      repoPath: project.repoPath,
      phase: config.progressPhase,
      runId,
      status: "completed",
      source: ingestion.structuredOutputSource as StructuredOutputSource,
      message: `${config.label} completed`,
    });
    endRun(runId, `${config.label} completed`, true);
    return result;
  } catch (err) {
    if (err instanceof StageBoundaryViolationError || err instanceof PipelineRunStoppedError) {
      throw err;
    }
    if (!latestTerminalProgressForRun(changeId, config.progressPhase, runId)) {
      await emitProgress({
        changeId,
        repoPath: project.repoPath,
        phase: config.progressPhase,
        runId,
        status: "failed",
        source: "none",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    endRun(runId, String(err), false);
    throw err;
  }
}

export async function runPrdBriefingQuestions(
  changeId: string,
  context: JobExecutionContext,
  provider?: Provider,
): Promise<AiRunResult> {
  return withExecutionFence(context, () => runPrdBriefingStage(changeId, context, {
    promptPhase: "prd_briefing_questions",
    progressPhase: "prd_briefing_questions",
    label: "PRD briefing questions",
    outputMode: "json_schema",
    outputSchema: questionOutputSchema(),
    lineProtocol: {
      parse: (rawText, ctx) => parseBriefingQuestionsLineProtocol(rawText, ctx) as LineProtocolParseResult,
    },
    complete: (id, output) => completeQuestionGeneration({
      changeId: id,
      questionsOutput: output as BriefingQuestionsOutput,
      provider,
    }),
    provider,
  }));
}

export async function runPrdBriefingDraft(
  changeId: string,
  context: JobExecutionContext,
  provider?: Provider,
): Promise<AiRunResult> {
  return withExecutionFence(context, () => runPrdBriefingStage(changeId, context, {
    promptPhase: "prd_briefing_draft",
    progressPhase: "prd_briefing_draft",
    label: "PRD briefing draft",
    outputMode: "markdown",
    outputSchema: draftOutputSchema(),
    lineProtocol: {
      parse: (rawText) => parsePrdBriefingDraftLineProtocol(rawText) as LineProtocolParseResult,
    },
    complete: (id, output) => completePrdDraft({
      changeId: id,
      markdown: (output as PrdBriefingDraftOutput).markdown,
      provider,
    }),
    provider,
  }));
}

export async function runPrdBriefingFinalReview(
  changeId: string,
  context: JobExecutionContext,
  provider?: Provider,
): Promise<AiRunResult> {
  return withExecutionFence(context, () => runPrdBriefingStage(changeId, context, {
    promptPhase: "prd_briefing_final_review",
    progressPhase: "prd_briefing_final_review",
    label: "PRD briefing final review",
    outputMode: "json_schema",
    outputSchema: finalReviewOutputSchema(),
    lineProtocol: {
      // Question ids are opaque (BQ-<base36>-<hex>) and every id the model
      // names blocks the PRD lock, so they are validated against the real set
      // read at parse time -- a mis-transcribed id would be a phantom blocker
      // no one can ever answer away.
      parse: (rawText) => parseFinalReviewLineProtocol(
        rawText,
        getPrdBriefingState(changeId).questions.map((question) => question.id),
      ) as LineProtocolParseResult,
    },
    complete: (id, output) => completeFinalReview({
      changeId: id,
      reviewOutput: output as FinalReviewOutput,
      provider,
    }),
    provider,
  }));
}
