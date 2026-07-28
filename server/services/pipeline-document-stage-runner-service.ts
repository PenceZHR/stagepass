import { and, eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { db } from "../db";
import { runLedgerRepository } from "../repositories/run-ledger-repository";
import { changes, projects, runs } from "../db/schema";
import { createChildLogger } from "../logger";
import type { Change, ChangeStatus, Project, RunPhase } from "../types";
import {
  applyLineProtocol,
  guardLineProtocolSchema,
  type LineProtocolContext,
  type LineProtocolParseResult,
  type LineProtocolState,
} from "./ai-line-protocol";
import type { AiRunResult } from "./ai-engine-types";
import type { JobExecutionContext } from "./job-execution-context";
import {
  assertCurrentExecutionFence,
  currentExecutionFenceContext,
  withExecutionFence,
} from "./execution-fence-service";
import {
  createProviderLifecycleSink,
  documentStageWatchdogTimeoutMs,
  documentStageTimeoutMs,
  getPipelineEngine,
  type EngineProvider,
} from "./pipeline-engine-service";
import { withTimeout } from "./ai-timeout-policy";
import {
  blockStageViolation,
  stopRun,
  writeRunArtifactBestEffort,
} from "./pipeline-run-ledger-service";
import { markdownArtifactContentFromResult } from "./markdown-artifact-content-service";
import { classifyStageConvergence } from "./stage-convergence-service";
import { validateOutputSchema } from "./output-schema-validator";
import { assemblePrompt, type PromptPhase } from "./prompt-service";
import type { RubricPhase } from "./rubric-assessment";
import { harvestStageRubric, resolveStageRubric } from "./rubric-stage-service";
import { transitionChangeStatus } from "./change-status-service";
import { runStageWithLedger } from "./stage-orchestrator-service";
import {
  recordProviderSession,
  resolveCanonicalChangeThread,
  resolveCodexStageThreadRoute,
  resolveProviderSession,
  type ProviderSessionKind,
} from "./provider-session-service";
import { readCodexNativeFlags } from "../config/codex-native-flags";
import { resolveLogicalTurn } from "./codex-logical-turn-service";
import type { CodexLogicalTurnRole } from "./codex-desktop-bridge-types";
import type { Provider } from "./provider-selection-service";
import { ingestStageAiOutput } from "./stage-ai-output-ingestion-service";
import { persistStageRawCapture } from "./stage-raw-capture-service";
import {
  captureWorkspaceSnapshot,
  DEFAULT_STAGE_SCOPES,
  diffWorkspaceSnapshots,
  validatePlannedChanges,
  type StageScope,
} from "./stage-guard-service";

const log = createChildLogger("pipeline-service");

export function withDocumentStageExecutionContext<T>(
  context: JobExecutionContext,
  run: () => Promise<T>,
): Promise<T> {
  return withExecutionFence(context, run);
}

export interface DocumentStageConfig {
  phase: RunPhase;
  promptPhase: PromptPhase;
  allowedStatuses: ChangeStatus[];
  runningStatus: ChangeStatus;
  successStatus: ChangeStatus;
  failureStatus: ChangeStatus;
  artifactType: string;
  artifactFileName: string;
  successSummary: string;
  /** Immutable provider selected for this execution. */
  provider?: Provider;
  /** Provider-scoped session slot. Defaults to the shared general session. */
  sessionKind?: ProviderSessionKind;
  logicalRole?: Exclude<CodexLogicalTurnRole, "shell_materialization">;
  logicalRound?: number;
  logicalOrdinal?: number;
  runId?: string;
  deferRunCompletion?: boolean;
  additionalPromptFileName?: string;
  outputSchema?: Record<string, unknown>;
  /**
   * Line-oriented output protocol: the model writes prefixed plain-text lines
   * (never JSON) and parse() deterministically assembles the structured
   * payload, which outputSchema then validates as a second gate. When set,
   * the engine gets NO output schema (no --output-schema, no JSON guidance)
   * and the parsed payload is the ONLY structured output the ingestion will
   * accept — model-authored JSON found in prose is refused instead of
   * resurrected by the text-extraction/repair fallbacks.
   */
  lineProtocol?: {
    parse: (rawText: string, ctx: LineProtocolContext) => LineProtocolParseResult;
    /**
     * The named blocks this stage's protocol declares (`NAME<<` … `>>NAME`),
     * empty for record-only stages.
     *
     * Required whenever the stage ALSO has a rubric, and it lives here rather
     * than as a sibling field so it sits next to the parser that owns the names.
     * A rubric rides inside the host stage's reply and its harvest runs FIRST,
     * over the whole reply, through the same `findStructuralBlockError`. With no
     * block names it rejects the stage's own block as off-script -- so a stage
     * with a non-empty rubric would fail every single run before its own parser
     * ever saw the text. Spec's red draft already hit this and passes
     * `expectedBlockNames` by hand at its call site; this field is what makes
     * the `rubricPhase` shortcut carry the same information.
     */
    blockNames?: readonly string[];
  };
  /**
   * Rubric judging for this stage (docs/RUBRIC-DESIGN.md). `promptSection` is
   * appended to the assembled prompt; `harvest` parses the RUBRIC lines out of
   * the reply, stores one verdict per criterion, and returns the reply with
   * those lines removed.
   *
   * The harvest deliberately runs BEFORE the stage's own line protocol, schema
   * validation and artifact write, and its cleaned text replaces `result.summary`
   * for all of them. A rubric rides inside the host stage's reply, so leaving the
   * lines in would feed protocol text to a parser and to a document artifact that
   * both belong to a different contract.
   *
   * A malformed rubric reply throws, which lands as a retryable invalid-output
   * failure for the stage -- the same treatment every line protocol gives
   * unattributable output. A reply with no RUBRIC lines does NOT throw; it stores
   * `not_assessed` per criterion and continues.
   */
  rubric?: {
    promptSection: string | null;
    harvest: (input: { runId: string; rawText: string }) => { cleanedText: string };
  };
  /**
   * The phase whose PRODUCER rubric this stage answers, for the stages that need
   * nothing more than that.
   *
   * `rubric` above stays for callers that cannot use this -- Spec passes rounds
   * and roles the runner knows nothing about. Everything else gets its rubric by
   * naming a phase, because the alternative is copying the same six lines into
   * every stage and getting the run id, the round id or the role wrong in one of
   * them. `resolveStageRubric` is called INSIDE the run so the version pin
   * records the run that actually asked.
   *
   * Ignored when `rubric` is set; passing both is a caller bug, not a merge.
   */
  rubricPhase?: RubricPhase;
  resumeThread?: boolean;
  threadId?: string;
  afterAiResult?: (input: { runId: string; result: AiRunResult }) => void | Promise<void>;
  afterSuccessfulResult?: (input: {
    changeId: string;
    project: Project;
    runId: string;
    result: AiRunResult;
  }) => Promise<{ skipDefaultArtifactWrite?: boolean } | void>;
  /**
   * A reply this stage's Codex task already produced, to be ingested instead of
   * starting a turn.
   *
   * The clarification loop keeps one Codex task open across many question
   * batches, so the stage's answer arrives on a turn the wakeup orchestrator
   * dispatched, not on one this call could start. Adoption runs the identical
   * ingest path -- rubric, schema, artifact, gate -- so an adopted stage result
   * is held to the same contract as a directly produced one.
   *
   * The workspace mutation guard is the one thing it cannot reproduce: the
   * snapshot pair straddles this call, and the adopted turn ran before it. The
   * clarification turns run read-only, so there is nothing for it to catch.
   */
  adoptedResult?: AiRunResult;
}

/**
 * The stage handed its decisions to the human and is waiting for them. Not a
 * result, so nothing may be written and no gate may move.
 */
export class StageAwaitingClarificationError extends Error {
  readonly code = "stage_awaiting_clarification";
  constructor(phase: string) {
    super(
      `${phase} stage is waiting for the human to answer its questions in Codex`,
    );
    this.name = "StageAwaitingClarificationError";
  }
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

export type StrandedRunningStatusRecovery = {
  recovered: boolean;
  reason:
    | "status_already_allowed"
    | "not_the_running_status"
    | "no_rollback_target"
    | "run_in_flight"
    | "stranded_running_status_recovered";
};

/**
 * Rolls a change back off a running status that no run is actually backing.
 *
 * `runningStatus` is a claim: "a run of this phase is in flight". A run killed
 * outside its own try/catch -- machine sleep, SIGTERM, an OOM -- never reaches
 * `runStageWithLedger`'s catch, so `failureStatus` is never applied and the
 * claim outlives the run. The stale-provider sweeper normally repairs that, but
 * it declines whenever `ownsChange` is false (recovery-executors.ts), which is
 * exactly what happens when the job's own fence has already moved on: run
 * attempt 1 and job attempt 2 look like a superseded run to
 * `determineRecoveryOwnership`, so the run and job are failed and the change
 * status is left behind.
 *
 * That combination is a permanent dead end, because `assertStatus` runs BEFORE
 * `runStageWithLedger`: every retry throws "Invalid status" outside the ledger,
 * so no run is created and nothing rolls the status back. Observed live on
 * CHG-015, stuck at TECHSPECCING across three dispatches (RUN-245 failed
 * `stale_lease_fenced`, PJOB-122c2b44 failed `pipeline_job_failed`).
 *
 * Repairing the claim -- rather than teaching `assertStatus` to accept the
 * running status -- keeps the "running status implies a live run" invariant
 * true and leaves the guard exactly as tight as it was: a change at any other
 * status still fails the assert. The rollback only fires when the claim is
 * provably false, i.e. no run of this phase is still `running`. When one is, the
 * assert throws as before; the sweeper will terminate that run and the next
 * retry recovers, so blocking here is a wait, not a dead end.
 *
 * Mirrors `retryBuildStreamed`'s IMPLEMENTING branch (pipeline-build-stage-service),
 * which recovers a stale Build run before retrying, and reuses the same rollback
 * target the sweeper would have used (`fallbackStatusByProviderPhase`).
 *
 * Not every stage reaches this through `runDocumentStage`: Plan is dispatched
 * straight to `generatePlan` (pipeline-job-runner-service), so it calls this
 * itself and passes its own `eventSource`. Keep that label accurate -- it is
 * what a live post-mortem greps the events table for.
 */
export function recoverStrandedRunningStatus(input: {
  changeId: string;
  phase: RunPhase;
  status: ChangeStatus;
  allowedStatuses: ChangeStatus[];
  runningStatus: ChangeStatus;
  failureStatus: ChangeStatus;
  eventSource?: string;
}): StrandedRunningStatusRecovery {
  if (input.allowedStatuses.includes(input.status)) {
    return { recovered: false, reason: "status_already_allowed" };
  }
  if (input.status !== input.runningStatus) {
    return { recovered: false, reason: "not_the_running_status" };
  }
  // A stage whose failure lands back on its own running status has nothing to
  // roll back to; `retro` is shaped that way and already accepts it directly.
  if (input.failureStatus === input.runningStatus) {
    return { recovered: false, reason: "no_rollback_target" };
  }

  const liveRun = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(
      eq(runs.changeId, input.changeId),
      eq(runs.phase, input.phase),
      eq(runs.status, "running"),
    ))
    .get();
  if (liveRun) return { recovered: false, reason: "run_in_flight" };

  transitionChangeStatus({
    changeId: input.changeId,
    to: input.failureStatus,
    message: `Recovered stranded ${input.runningStatus}: no ${input.phase} run in flight`,
    rawJson: {
      source: input.eventSource ?? "document_stage_stranded_status_recovery",
      phase: input.phase,
      from: input.status,
    },
  });
  log.warn(
    { changeId: input.changeId, phase: input.phase, from: input.status, to: input.failureStatus },
    "Recovered change stranded at a running status with no run in flight",
  );
  return { recovered: true, reason: "stranded_running_status_recovered" };
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

async function validateStructuredDocumentOutput(input: {
  changeId: string;
  project: Project;
  runId: string;
  executionContext: JobExecutionContext;
  provider: string;
  phase: RunPhase;
  outputSchema: Record<string, unknown>;
  result: AiRunResult;
  /**
   * Present when the stage uses a line protocol. `payload` is the only value
   * validateSchema will accept (reference equality — the injected object flows
   * through ingestion unchanged); `failure` forces every candidate to fail so
   * the run ends as retryable invalid output with the raw text captured.
   */
  lineProtocol?: { payload?: Record<string, unknown>; failure?: string };
}): Promise<AiRunResult> {
  const providerFailed = !input.result.success;
  const ingestion = await ingestStageAiOutput({
    changeId: input.changeId,
    runId: input.runId,
    phase: input.phase,
    provider: input.provider,
    outputSchema: input.outputSchema,
    aiResult: providerFailed
      ? {
          ...input.result,
          structuredOutput: undefined,
          structuredOutputSource: undefined,
        }
      : input.result,
    contract: {
      allowedCandidateFiles: [],
      safeRoot: `.ship/changes/${input.changeId}`,
      sandboxReadOnly: true,
      validateSchema: (value) => {
        if (providerFailed) {
          return {
            ok: false,
            message:
              input.result.providerErrorDetail
              || input.result.providerErrorCode
              || `${input.phase} provider failed`,
          };
        }
        const base = (candidate: unknown) => validateOutputSchema(input.outputSchema, candidate);
        if (input.lineProtocol) {
          return guardLineProtocolSchema(input.lineProtocol, base, input.phase)(value);
        }
        return base(value);
      },
      validateBusiness: () => true,
      writeRawCapture: (envelope) => {
        assertCurrentExecutionFence(input.executionContext, input.runId);
        return persistStageRawCapture({
          repoPath: input.project.repoPath,
          changeId: input.changeId,
          runId: input.runId,
          envelope,
        });
      },
    },
  });

  if (!ingestion.ok) {
    throw new Error(
      ingestion.sanitizedErrorSummary || `${input.phase} stage requires valid structuredOutput`,
    );
  }

  return {
    ...input.result,
    structuredOutput: ingestion.structuredOutput,
    structuredOutputSource: ingestion.structuredOutputSource,
  };
}

export function withDocumentStageWatchdog<T>(
  promise: Promise<T>,
  phase: RunPhase,
  label: string = phase,
): Promise<T> {
  return withTimeout(
    promise,
    documentStageWatchdogTimeoutMs(phase),
    `${label} stage watchdog`,
  );
}

export function defaultScopeForPhase(phase: RunPhase): StageScope {
  return {
    phase,
    ...DEFAULT_STAGE_SCOPES[phase],
  };
}

function appendAdditionalPrompt(
  prompt: string,
  config: DocumentStageConfig,
  input: { changeId: string; repoPath: string },
): string {
  if (!config.additionalPromptFileName) return prompt;
  const promptPath = path.join(
    process.cwd(),
    "server",
    "templates",
    "prompts",
    config.additionalPromptFileName,
  );
  if (!fs.existsSync(promptPath)) return prompt;
  const shipDir = path.join(input.repoPath, ".ship");
  const changeArtifactDir = path.join(shipDir, "changes", input.changeId);
  const additional = fs.readFileSync(promptPath, "utf-8")
    .replace(/\{changeId\}/g, input.changeId)
    .replace(/\{repoPath\}/g, input.repoPath)
    .replace(/\{apiSpecDeltaPath\}/g, path.join(changeArtifactDir, "api-spec-delta.md"));
  return `${prompt}\n\n--- ${config.additionalPromptFileName} ---\n\n${additional}`;
}

/**
 * Turns a `rubricPhase` into the same `{ promptSection, harvest }` pair a caller
 * would otherwise hand-build.
 *
 * `roundId` is deliberately absent rather than defaulted: these phases have no
 * rounds, and the null round is what `selectLatestAssessmentBatch` filters on.
 * Every phase reachable through here answers the PRODUCER rubric -- a document
 * stage IS the author of its artifact. The one phase whose critic also runs
 * through a stage (PRD's final review) passes its own `rubric` because the role
 * differs.
 */
function resolveConfiguredRubric(input: {
  changeId: string;
  projectId: string;
  phase: RubricPhase | undefined;
  runId: string;
  /** See DocumentStageConfig["lineProtocol"].blockNames for why this is here. */
  expectedBlockNames: readonly string[];
}): DocumentStageConfig["rubric"] | undefined {
  if (!input.phase) return undefined;
  const stageRubric = resolveStageRubric(
    {
      projectId: input.projectId,
      changeId: input.changeId,
      phase: input.phase,
      role: "producer",
    },
    { runId: input.runId, roundId: null },
  );
  if (!stageRubric) return undefined;
  return {
    promptSection: stageRubric.promptSection,
    harvest: ({ runId, rawText }) =>
      harvestStageRubric({
        stageRubric,
        changeId: input.changeId,
        runId,
        roundId: null,
        rawText,
        expectedBlockNames: input.expectedBlockNames,
      }),
  };
}

export async function runDocumentStage(
  changeId: string,
  config: DocumentStageConfig,
  context?: JobExecutionContext,
): Promise<AiRunResult> {
  if (context) {
    return withExecutionFence(context, () => runDocumentStage(changeId, config));
  }
  const executionContext = currentExecutionFenceContext();
  if (!executionContext) {
    throw new Error("Document stage requires a complete JobExecutionContext");
  }
  const initialChange = getChange(changeId);
  if (!initialChange) throw new Error(`Change not found: ${changeId}`);
  // Repair a running status no run is backing before the guard reads it,
  // otherwise a retry can never get past assertStatus to create one.
  const recovery = recoverStrandedRunningStatus({
    changeId,
    phase: config.phase,
    status: initialChange.status as ChangeStatus,
    allowedStatuses: config.allowedStatuses,
    runningStatus: config.runningStatus,
    failureStatus: config.failureStatus,
  });
  const change = recovery.recovered ? getChange(changeId) ?? initialChange : initialChange;
  assertStatus(change, ...config.allowedStatuses);

  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);

  const provider = config.provider ?? executionContext.provider ?? (change.provider as Provider);
  // Captured for the awaiting-clarification path below, which settles a run the
  // ledger deliberately leaves alone. The ledger only hands `runId` to
  // `execute`, and a caller that did not reserve one has no other way back to it.
  let startedRunId: string | undefined = config.runId;
  try {
    return await runStageWithLedger({
    changeId,
    phase: config.phase,
    runningStatus: config.runningStatus,
    successStatus: config.successStatus,
    failureStatus: config.failureStatus,
    runId: config.runId,
    provider,
    deferRunCompletion: config.deferRunCompletion,
    execute: async ({ runId }) => {
      startedRunId = runId;
      const scope = defaultScopeForPhase(config.phase);
      const basePrompt = appendAdditionalPrompt(assemblePrompt(config.promptPhase, {
        changeId,
        changeTitle: change.title,
        repoPath: project.repoPath,
      }, scope), config, { changeId, repoPath: project.repoPath });
      const rubric = config.rubric ?? resolveConfiguredRubric({
        changeId,
        projectId: change.projectId,
        phase: config.rubricPhase,
        runId,
        expectedBlockNames: config.lineProtocol?.blockNames ?? [],
      });
      const prompt = rubric?.promptSection
        ? `${basePrompt}\n\n${rubric.promptSection}`
        : basePrompt;

      const beforeAi = captureWorkspaceSnapshot(project.repoPath);
      // Declared here because the ingest step below reads it and adoption
      // never reaches the block that assigns it.
      let logicalTurnId: string | undefined;
      const ingest = async (
        initial: AiRunResult,
      ): Promise<{ result: AiRunResult; successSummary: string }> => {
        let result = initial;
        // A turn that ended by asking the human another batch produced an
        // acknowledgement, not a stage result. Ingesting it writes "I have
        // shown you ten questions" as the stage artifact and clears the gate
        // on it. The clarification loop finishes this stage later, through
        // adoption, once the task stops asking.
        if (classifyStageConvergence(result).kind === "asked_again") {
          throw new StageAwaitingClarificationError(config.phase);
        }
        assertCurrentExecutionFence(executionContext, runId);
        assertRunStillRunning(runId);
        assertChangeNotBlocked(changeId, config.phase);
        await config.afterAiResult?.({ runId, result });
        // Rubric first: its lines are not part of this stage's contract, so the
        // stage's own parser, schema and artifact must all see the reply without
        // them. Skipped for a failed or empty reply -- there is nothing to judge,
        // and attributing silence to the model when the provider never spoke is
        // the same false provenance applyLineProtocol() guards against.
        if (rubric && result.success && (result.summary ?? "").trim().length > 0) {
          const harvested = rubric.harvest({ runId, rawText: result.summary ?? "" });
          assertCurrentExecutionFence(executionContext, runId);
          result = { ...result, summary: harvested.cleanedText };
        }
        if (config.outputSchema) {
          let lineProtocol: LineProtocolState | undefined;
          if (config.lineProtocol) {
            const applied = applyLineProtocol(result, config.lineProtocol.parse, {
              changeId,
              repoPath: project.repoPath,
            });
            result = applied.result;
            lineProtocol = applied.state;
          }
          result = await validateStructuredDocumentOutput({
            changeId,
            project,
            runId,
            executionContext,
            provider,
            phase: config.phase,
            outputSchema: config.outputSchema,
            result,
            lineProtocol,
          });
        }
        // No document stage may finish on silence. A provider killed mid-flight
        // returns success:true with an empty summary (macOS sleep -> supervisor
        // SIGTERM -> codex emits reasoning items but no agent_message), and
        // applyLineProtocol turns that into an EMPTY state on the stated grounds
        // that "callers already handle it".
        //
        // Only callers with an outputSchema actually do: the schema rejects the
        // empty payload above. Nothing pairs the two fields, so a stage configured
        // without a schema -- Retro is the one today -- skips the whole
        // ingest/validate block, skips the rubric harvest (which is correct on its
        // own terms: blaming a model that never spoke is false provenance), and
        // writes an empty artifact on its way to successStatus. Retro reached DONE
        // carrying an empty retro.md with zero of its criteria judged.
        //
        // Refusing here rather than at each caller makes the contract true for
        // every stage, including ones not written yet.
        // Failure first: a run that failed AND came back empty must report the
        // failure, not the emptiness. The empty guard is for the reply that claims
        // to have succeeded.
        if (!result.success) {
          throw new Error(result.summary || `${config.phase} stage failed`);
        }
        if ((result.summary ?? "").trim().length === 0) {
          throw new Error(
            `${config.phase} stage returned an empty reply (provider produced no output)`,
          );
        }
        const afterAi = captureWorkspaceSnapshot(project.repoPath);
        const mutations = diffWorkspaceSnapshots(beforeAi, afterAi);
        const violation = validatePlannedChanges(mutations, scope);
        if (violation.blocked) {
          await blockStageViolation(changeId, runId, violation);
        }

        assertCurrentExecutionFence(executionContext, runId);
        const threadId = result.threadId?.trim();
        // An adopted reply came from the canonical bridge thread, which the
        // binding already owns; recording it as the legacy general session
        // would hand a second owner the same thread.
        const managedByBinding = logicalTurnId !== undefined
          || config.adoptedResult !== undefined;
        if (!managedByBinding && threadId && threadId.toLowerCase() !== "unknown") {
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

        assertCurrentExecutionFence(executionContext, runId);
        const hookResult = await config.afterSuccessfulResult?.({ changeId, project, runId, result });
        const skipDefaultArtifactWrite =
          typeof hookResult === "object"
          && hookResult !== null
          && hookResult.skipDefaultArtifactWrite === true;
        if (!skipDefaultArtifactWrite) {
          assertCurrentExecutionFence(executionContext, runId);
          const artifactContent = path.extname(config.artifactFileName) === ".md"
            ? markdownArtifactContentFromResult(result)
            : result.summary;
          await writeRunArtifactBestEffort(
            project.repoPath,
            changeId,
            runId,
            config.phase,
            config.artifactType,
            config.artifactFileName,
            artifactContent
          );
        }

        assertRunStillRunning(runId);
        assertChangeNotBlocked(changeId, config.phase);

        log.info({ changeId, phase: config.phase }, `${config.phase} completed`);
        return { result, successSummary: config.successSummary };
      };
      if (config.adoptedResult) {
        // The stage's own turn already ran, elsewhere: the clarification loop
        // owns the Codex task until the questions converge, and hands back the
        // reply it converged on. Everything after this point -- rubric harvest,
        // schema and line-protocol validation, artifact write, gate transition
        // -- is the stage's contract and must apply to an adopted reply exactly
        // as it applies to one this call produced.
        return ingest(config.adoptedResult);
      }
      const engine = await getPipelineEngine(provider as EngineProvider);
      const desktopBridgeEnabled = readCodexNativeFlags().desktopBridge;
      const { executableThreadId } = resolveCodexStageThreadRoute({
        desktopBridgeEnabled,
        resolveCanonicalThread: () => resolveCanonicalChangeThread(changeId, config.phase),
        resolveLegacyGeneralThread: () => resolveProviderSession({
          changeId,
          provider: "codex",
          sessionKind: "general",
        }),
      });
      logicalTurnId = desktopBridgeEnabled
        ? (await resolveLogicalTurn({
            owner: {
              kind: "pipeline_job",
              pipelineJobId: executionContext.jobId,
            },
            phase: config.phase,
            role: config.logicalRole ?? "stage",
            round: config.logicalRound ?? 0,
            ordinal: config.logicalOrdinal ?? 0,
            request: { prompt, sandboxMode: "read-only" },
          })).logicalTurnId
        : undefined;
      const stageTimeoutMs = documentStageTimeoutMs(config.phase);
      const produced = await withDocumentStageWatchdog(
        engine.run(desktopBridgeEnabled ? {
          logicalTurnId: logicalTurnId!,
        } as never : {
          changeId,
          repoPath: project.repoPath,
          phase: config.phase,
          logicalTurnId,
          threadId: executableThreadId,
          prompt,
          // Line-protocol stages keep the schema server-side only: the model
          // must never see JSON guidance, it writes protocol lines instead.
          outputSchema: config.lineProtocol ? undefined : config.outputSchema,
          sandboxMode: "read-only",
          timeoutMs: stageTimeoutMs,
          lifecycle: createProviderLifecycleSink({
            ...executionContext,
            changeId,
            runId,
            phase: config.phase,
            provider: provider as EngineProvider,
            closeBusinessRunOnProviderFailure: false,
          }),
        }),
        config.phase,
      );
      return ingest(produced);
    },
    });
  } catch (err) {
    // The stage handed the human another batch of questions. Nothing failed:
    // the run settles as stopped, the change keeps its status, and the job
    // reports success so the worker does not retry a turn whose answer is
    // sitting on the user's screen in Codex. The clarification loop finishes
    // this stage later through adoption -- what the Spec round already does,
    // and what every other document stage was missing: the error escaped to
    // the failure ledger, so a stage that had correctly parked on a card
    // reported itself broken and the UI said 失败.
    if (err instanceof StageAwaitingClarificationError && startedRunId) {
      stopRun(startedRunId, err.message);
      log.info(
        { changeId, phase: config.phase, runId: startedRunId },
        "document stage paused awaiting human clarification",
      );
      return {
        threadId: `${changeId}-${config.phase}-awaiting-clarification`,
        runId: startedRunId,
        summary: "stage_awaiting_clarification",
        success: true,
        changedFiles: [],
        structuredOutput: undefined,
        items: [],
      };
    }
    throw err;
  }
}
