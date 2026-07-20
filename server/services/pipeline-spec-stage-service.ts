import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
  changes,
  projects,
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
import { emitIdempotentEvent } from "./event-service";
import { assemblePrompt } from "./prompt-service";
import {
  claimSpecBattleRedRun,
  completeBlueCritique,
  completeRedSpecRound,
  failSpecBattleRound,
  getSpecBattleState,
  markSpecBattleReportsStale,
} from "./spec-battle-service";
import { generateSpecReport, generateWarReport } from "./spec-battle-report-service";
import {
  createProviderLifecycleSink,
  documentStageTimeoutMs,
  getPipelineEngine,
  type EngineProvider,
} from "./pipeline-engine-service";
import { markdownArtifactContentFromResult } from "./markdown-artifact-content-service";
import {
  defaultScopeForPhase,
  runDocumentStage,
  withDocumentStageWatchdog,
} from "./pipeline-document-stage-runner-service";
import {
  endRun,
  setStatus,
  StageBoundaryViolationError,
} from "./pipeline-run-ledger-service";
import {
  ingestStageAiOutput,
} from "./stage-ai-output-ingestion-service";
import {
  persistStageRawCapture,
} from "./stage-raw-capture-service";
import {
  BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA,
  validateBlueCritiqueOutput,
} from "./spec-battle-ledger";
import { applyLineProtocol, guardLineProtocolSchema } from "./ai-line-protocol";
import { parseSpecCritiqueLineProtocol } from "./spec-critique-line-protocol";
import {
  appendRubricPromptSection,
  harvestStageRubric,
  recordUnansweredStageRubric,
  resolveStageRubric,
} from "./rubric-stage-service";
import { syncSpecRubricGaps } from "./rubric-gate-adapters";
import type { Change, RunPhase } from "../types";
import type { Provider } from "./provider-selection-service";
import {
  recordProviderSession,
  resolveProviderSession,
} from "./provider-session-service";

const log = createChildLogger("pipeline-spec-stage-service");

// Generic pipeline helpers duplicated per the established stage-service
// convention to keep this module free of a back-dependency on pipeline-service.
function getProject(projectId: string) {
  return db.select().from(projects).where(eq(projects.id, projectId)).get();
}

function getChange(changeId: string): Change | undefined {
  return db.select().from(changes).where(eq(changes.id, changeId)).get() as Change | undefined;
}

function selectedProvider(
  change: Change,
  context: JobExecutionContext,
  requested?: Provider,
): Provider {
  return requested ?? context.provider ?? (change.provider as Provider);
}

class PipelineRunStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineRunStoppedError";
  }
}

function assertChangeNotBlocked(changeId: string, phase: RunPhase): void {
  const change = getChange(changeId);
  if (change?.status === "BLOCKED") {
    throw new PipelineRunStoppedError(`${phase} stage stopped because change is blocked`);
  }
}

// --- Spec red/blue battle stage ---

export interface RunSpecOptions {
  idempotencyKey?: string;
  provider?: Provider;
}

const SPEC_RETRY_SESSION_CONTRACT = {
  writer: {
    eventType: "spec_writer_retry_session",
    envelopeKey: "specWriterRetrySession",
    schemaVersion: "spec_writer_retry_session/v1",
    label: "writer",
  },
  critic: {
    eventType: "spec_critic_retry_session",
    envelopeKey: "specCriticRetrySession",
    schemaVersion: "spec_critic_retry_session/v1",
    label: "critic",
  },
} as const;
type SpecRetryRole = keyof typeof SPEC_RETRY_SESSION_CONTRACT;

function normalizedProviderThreadId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "unknown" ? trimmed : undefined;
}

function recordSpecRetrySession(input: {
  role: SpecRetryRole;
  changeId: string;
  runId: string;
  roundId: string;
  provider: EngineProvider;
  result: AiRunResult;
}): void {
  const errorCode = input.result.providerErrorCode ?? "provider_run_failed";
  const threadId = normalizedProviderThreadId(input.result.threadId) ?? null;
  const contract = SPEC_RETRY_SESSION_CONTRACT[input.role];
  const eventId = `EVT-spec-${contract.label}-retry-${createHash("sha256")
    .update(`${input.role}\0${input.runId}\0${input.roundId}\0${input.provider}\0${errorCode}\0${threadId ?? ""}`)
    .digest("hex")}`;
  try {
    emitIdempotentEvent({
      id: eventId,
      changeId: input.changeId,
      runId: input.runId,
      type: contract.eventType,
      message: `Spec ${contract.label} failure continuity marker captured for retry`,
      rawJson: {
        [contract.envelopeKey]: {
          schemaVersion: contract.schemaVersion,
          roundId: input.roundId,
          provider: input.provider,
          threadId,
          errorCode,
        },
      },
    });
  } catch (error) {
    log.warn({
      changeId: input.changeId,
      runId: input.runId,
      roundId: input.roundId,
      error: error instanceof Error ? error.message : String(error),
    }, `Failed to persist Spec ${contract.label} retry session; preserving provider failure`);
  }
}

function latestSpecRetryThread(input: {
  role: SpecRetryRole;
  changeId: string;
  roundId: string;
  provider: EngineProvider;
  currentRunId: string;
}): string | undefined {
  const contract = SPEC_RETRY_SESSION_CONTRACT[input.role];
  const providerPhase = input.role === "writer" ? "spec" : "spec_critic";
  const priorRuns = sqlite.prepare(`
    SELECT
      r.id,
      r.status,
      (
        SELECT e.raw_json
        FROM events e
        WHERE e.change_id = r.change_id
          AND e.run_id = r.id
          AND e.type = ?
        ORDER BY e.rowid DESC
        LIMIT 1
      ) AS rawJson,
      EXISTS (
        SELECT 1
        FROM provider_run_processes p
        WHERE p.run_id = r.id
          AND p.phase = ?
          AND p.provider = ?
          AND p.status = 'stopped'
          AND UPPER(COALESCE(p.signal, '')) = 'SIGTERM'
      ) AS infrastructureInterrupted
    FROM runs r
    WHERE r.change_id = ?
      AND r.phase = 'spec'
      AND r.id <> ?
    ORDER BY r.rowid DESC
  `).all(
    contract.eventType,
    providerPhase,
    input.provider,
    input.changeId,
    input.currentRunId,
  ) as Array<{
    id: string;
    status: string;
    rawJson: string | null;
    infrastructureInterrupted: number;
  }>;
  for (const priorRun of priorRuns) {
    if (priorRun.status !== "failed") return undefined;
    if (!priorRun.rawJson) {
      if (priorRun.infrastructureInterrupted === 1) continue;
      return undefined;
    }
    try {
      const envelope = JSON.parse(priorRun.rawJson) as Record<string, {
        schemaVersion?: unknown;
        roundId?: unknown;
        provider?: unknown;
        threadId?: unknown;
        errorCode?: unknown;
      } | undefined> | null;
      const session = envelope?.[contract.envelopeKey];
      if (
        session?.schemaVersion !== contract.schemaVersion
        || session.roundId !== input.roundId
        || session.provider !== input.provider
      ) return undefined;
      if (session.errorCode === "provider_timeout") {
        return normalizedProviderThreadId(session.threadId);
      }
      if (priorRun.infrastructureInterrupted === 1) continue;
      return undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function alreadyRunningSpecResult(changeId: string, roundId: string, runId: string | null): AiRunResult {
  return {
    threadId: `${changeId}-spec-running`,
    runId: runId ?? `${roundId}-running`,
    summary: "spec_round_running",
    success: true,
    changedFiles: [],
    structuredOutput: undefined,
    items: [],
  };
}

export async function runSpec(
  changeId: string,
  context: JobExecutionContext,
  options: RunSpecOptions = {},
): Promise<AiRunResult> {
  return withExecutionFence(context, async () => {
    const initialChange = getChange(changeId);
    if (!initialChange) throw new Error(`Change not found: ${changeId}`);
    const provider = selectedProvider(initialChange, context, options.provider);
    const claim = claimSpecBattleRedRun({
      changeId,
      idempotencyKey: options.idempotencyKey,
      provider,
    });
    if (!claim.claimed) {
      assertCurrentExecutionFence(context);
      return alreadyRunningSpecResult(changeId, claim.roundId, claim.runId);
    }
    if (!claim.runId) {
      throw new Error("Claimed Spec battle round has no business run");
    }
    assertCurrentExecutionFence(context);
    runLedgerRepository.bindRunToCurrentExecution(claim.runId);
    assertCurrentExecutionFence(context, claim.runId);
    const round = {
      roundId: claim.roundId,
      roundNo: claim.roundNo,
      status: "red_running",
      previousStatus: claim.previousStatus,
      runId: claim.runId,
    };

    try {
      let result: AiRunResult | null = null;
      if (round.previousStatus === "failed") {
        assertCurrentExecutionFence(context, round.runId);
        markSpecBattleReportsStale(changeId, "retry_failed_round");
        assertCurrentExecutionFence(context, round.runId);
        await setStatus(changeId, "SPECCING");
      }

      const currentRound = getSpecBattleState(changeId).latestRound;
      if (!currentRound || currentRound.id !== round.roundId) {
        throw new Error("Spec battle round is no longer current");
      }

      if (currentRound.status === "red_running") {
        const redChange = getChange(changeId);
        if (!redChange) throw new Error(`Change not found: ${changeId}`);
        const redProvider = provider as EngineProvider;
        // §3: red (SPEC_WRITER) is the Spec phase's producer, so it answers the
        // producer rubric as part of its own reply. The runner strips the
        // RUBRIC lines back out before anything else reads the reply -- red's
        // output is parsed as JSON and becomes prd-delta.md, neither of which
        // may contain protocol text.
        const redRubric = resolveStageRubric(
          { projectId: redChange.projectId, changeId, phase: "Spec", role: "producer" },
          { runId: round.runId, roundId: round.roundId },
        );
        const redRetryThreadId = latestSpecRetryThread({
          role: "writer",
          changeId,
          roundId: round.roundId,
          provider: redProvider,
          currentRunId: round.runId,
        });
        result = await runDocumentStage(changeId, {
          phase: "spec",
          promptPhase: "spec",
          allowedStatuses: ["INTAKE_READY", "SPECCING"],
          runningStatus: "SPECCING",
          successStatus: "SPECCING",
          failureStatus: "BLOCKED",
          artifactType: "prd_delta",
          artifactFileName: "prd-delta.md",
          successSummary: "Spec red draft completed",
          provider,
          sessionKind: "spec_writer",
          runId: round.runId ?? undefined,
          deferRunCompletion: true,
          resumeThread: false,
          threadId: redRetryThreadId,
          rubric: redRubric
            ? {
                promptSection: redRubric.promptSection,
                harvest: ({ runId, rawText }) =>
                  harvestStageRubric({
                    stageRubric: redRubric,
                    changeId,
                    runId,
                    roundId: round.roundId,
                    rawText,
                  }),
              }
            : undefined,
          afterAiResult: ({ runId, result: aiResult }) => {
            if (!aiResult.success) {
              recordSpecRetrySession({
                role: "writer",
                changeId,
                runId,
                roundId: round.roundId,
                provider: redProvider,
                result: aiResult,
              });
            }
          },
        }, context);

        assertCurrentExecutionFence(context, round.runId);
        assertChangeNotBlocked(changeId, "spec");
        await completeRedSpecRound({
          changeId,
          roundId: round.roundId,
          markdown: markdownArtifactContentFromResult(result),
          provider,
        });
      }

      const afterRed = getSpecBattleState(changeId).latestRound;
      if (afterRed?.id === round.roundId && afterRed.status === "blue_running") {
        assertChangeNotBlocked(changeId, "spec");
        const blueResult = await runSpecCritic(
          changeId,
          round.roundId,
          context,
          round.runId,
          provider,
        );
        assertCurrentExecutionFence(context, round.runId);
        result ??= blueResult;
      }
      assertCurrentExecutionFence(context, round.runId);
      assertChangeNotBlocked(changeId, "spec");
      // §2.3: after both sides have produced, a third agent judges the verdict
      // rubric against the two outputs. Deliberately before the reports: it
      // judges what red and blue produced, not stagepass's summary of them.
      await runSpecVerdictRubric({
        changeId,
        roundId: round.roundId,
        context,
        runId: round.runId,
        provider,
      });
      assertCurrentExecutionFence(context, round.runId);
      assertChangeNotBlocked(changeId, "spec");
      // §4.3: a blocking criterion answered `no`, or left unanswered, becomes a
      // requirement gap. Deliberately AFTER all three rubrics have landed and
      // BEFORE generateSpecReport -- the report's syncSpecReportStageAuthority
      // is what reads requirement_gaps back out and recomputes the Spec gate,
      // so a gap written after it would not block anything until some later
      // event happened to resync the stage.
      syncSpecRubricGaps(changeId);
      assertCurrentExecutionFence(context, round.runId);
      assertChangeNotBlocked(changeId, "spec");
      await generateSpecReport(changeId);
      assertCurrentExecutionFence(context, round.runId);
      assertChangeNotBlocked(changeId, "spec");
      await generateWarReport(changeId);
      assertCurrentExecutionFence(context, round.runId);
      assertChangeNotBlocked(changeId, "spec");
      endRun(round.runId, "Spec battle completed", true);
      await setStatus(changeId, "SPEC_READY");
      if (!result) {
        throw new Error("Spec battle round had no executable work");
      }
      return result;
    } catch (err) {
      if (err instanceof StaleLeaseFenceError) {
        throw err;
      }
      if (
        !(err instanceof StageBoundaryViolationError)
        && !(err instanceof Error && err.name === "PipelineRunStoppedError")
      ) {
        assertCurrentExecutionFence(context, round.runId);
        endRun(round.runId, err instanceof Error ? err.message : String(err), false);
      }
      failSpecBattleRound({
        changeId,
        roundId: round.roundId,
        reason: err instanceof Error ? err.message : String(err),
      });
      await setStatus(changeId, "BLOCKED", "spec");
      throw err;
    }
  });
}

/**
 * Runs the Spec round's VERDICT rubric: a third provider call whose input is
 * what red and blue each produced (§2.3, §3).
 *
 * ## Why this call is never allowed to throw
 *
 * It runs after completeBlueCritique has already committed the round
 * (report_ready) and moved the change to SPEC_READY. Letting a judging call
 * fail the round would mean a rubric someone edited, or a provider hiccup,
 * could destroy a finished round's business state -- runSpec's catch calls
 * failSpecBattleRound and sets BLOCKED. So every failure here (provider error,
 * empty reply, malformed protocol) is recorded as `not_assessed` on every
 * criterion and the round continues.
 *
 * That is not a softening of §4.2. `not_assessed` is blocking under
 * rubricOutcome(), and batch 5 is what turns it into a gate blocker; storing
 * NOTHING is the only outcome that would read as a pass. It does depart from
 * "an unknown criterion id voids the output, and void is retryable": red and
 * blue have a retry vehicle (the round retries and re-runs them), and the
 * verdict, running last, has none -- so for this one role void degrades to
 * unanswered rather than to a lost round.
 *
 * StaleLeaseFenceError is the one exception that propagates: a worker that has
 * lost its lease must stop, not swallow the fence and write anyway.
 */
async function runSpecVerdictRubric(input: {
  changeId: string;
  roundId: string;
  context: JobExecutionContext;
  runId: string;
  provider: Provider;
}): Promise<void> {
  const change = getChange(input.changeId);
  if (!change) return;
  const stageRubric = resolveStageRubric(
    { projectId: change.projectId, changeId: input.changeId, phase: "Spec", role: "verdict" },
    { runId: input.runId, roundId: input.roundId },
  );
  // No verdict rubric, or an empty one, means this phase does no verdict judging
  // (§4.5) and the round behaves exactly as it did before rubrics existed.
  if (!stageRubric?.promptSection) return;

  const round = getSpecBattleState(input.changeId).latestRound;
  if (!round || round.id !== input.roundId || round.status !== "report_ready") {
    // Both sides must actually have produced. A round that is not terminal has
    // no pair of outputs to judge, so there is no question to leave unanswered.
    return;
  }

  const project = getProject(change.projectId);
  if (!project) return;

  const recordUnanswered = (reason: string): void => {
    recordUnansweredStageRubric({
      stageRubric,
      changeId: input.changeId,
      runId: input.runId,
      roundId: input.roundId,
      reason,
    });
  };

  try {
    const prompt = appendRubricPromptSection(
      assemblePrompt("spec_verdict", {
        changeId: input.changeId,
        repoPath: project.repoPath,
      }, defaultScopeForPhase("spec")),
      stageRubric,
    );
    const engine = await getPipelineEngine(input.provider as EngineProvider);
    const result = await withDocumentStageWatchdog(engine.run({
      changeId: input.changeId,
      repoPath: project.repoPath,
      phase: "spec_verdict",
      prompt,
      // No outputSchema: the model writes RUBRIC lines, never JSON.
      sandboxMode: "read-only",
      timeoutMs: documentStageTimeoutMs(),
      lifecycle: createProviderLifecycleSink({
        ...input.context,
        changeId: input.changeId,
        runId: input.runId,
        phase: "spec_verdict",
        provider: input.provider as EngineProvider,
        roundId: input.roundId,
        closeBusinessRunOnProviderFailure: false,
      }),
    }), "spec", "spec_verdict");
    assertCurrentExecutionFence(input.context, input.runId);

    if (!result.success || (result.summary ?? "").trim().length === 0) {
      recordUnanswered(
        result.providerErrorCode
        || (result.success ? "provider_empty_response" : "provider_run_failed"),
      );
      return;
    }
    harvestStageRubric({
      stageRubric,
      changeId: input.changeId,
      runId: input.runId,
      roundId: input.roundId,
      rawText: result.summary ?? "",
    });
  } catch (err) {
    if (err instanceof StaleLeaseFenceError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { changeId: input.changeId, roundId: input.roundId, runId: input.runId, error: message },
      "Spec verdict rubric did not settle; recording every criterion as not_assessed",
    );
    recordUnanswered(message);
  }
}

async function runSpecCritic(
  changeId: string,
  roundId: string,
  context: JobExecutionContext,
  dbRunId: string,
  provider: Provider,
): Promise<AiRunResult> {
  const change = getChange(changeId);
  if (!change) throw new Error(`Change not found: ${changeId}`);
  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);
  const round = getSpecBattleState(changeId).latestRound;
  if (!round || round.id !== roundId) {
    throw new Error("Spec battle round is no longer current");
  }

  // §3: blue (REQUIREMENT_CRITIC) is the Spec phase's critic, so it answers the
  // critic rubric independently of whatever red claimed about the producer one.
  const blueRubric = resolveStageRubric(
    { projectId: change.projectId, changeId, phase: "Spec", role: "critic" },
    { runId: dbRunId, roundId },
  );
  const prompt = appendRubricPromptSection(assemblePrompt("spec_critic", {
    changeId,
    repoPath: project.repoPath,
  }, defaultScopeForPhase("spec")), blueRubric);

  const engine = await getPipelineEngine(provider as EngineProvider);
  const stageTimeoutMs = documentStageTimeoutMs();
  const retryThreadId = latestSpecRetryThread({
    role: "critic",
    changeId,
    roundId,
    provider: provider as EngineProvider,
    currentRunId: dbRunId,
  });
  const result = await withDocumentStageWatchdog(engine.run({
    changeId,
    repoPath: project.repoPath,
    phase: "spec_critic",
    threadId: retryThreadId ?? resolveProviderSession({
      changeId,
      provider,
      sessionKind: "spec_critic",
    }) ?? undefined,
    prompt,
    // Line-protocol stage: the model writes REVIEW/GAP/ARTIFACT/CRITIQUE_DONE
    // lines, never JSON. BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA stays server-side as
    // the second gate over the deterministically assembled payload.
    sandboxMode: "read-only",
    timeoutMs: stageTimeoutMs,
    lifecycle: createProviderLifecycleSink({
      ...context,
      changeId,
      runId: dbRunId,
      phase: "spec_critic",
      provider: provider as EngineProvider,
      roundId,
      closeBusinessRunOnProviderFailure: false,
    }),
  }), "spec", "spec_critic");
  assertCurrentExecutionFence(context, dbRunId);
  const runScopedArtifactId = dbRunId;
  const providerFailed = !result.success;
  if (providerFailed) {
    recordSpecRetrySession({
      role: "critic",
      changeId,
      runId: dbRunId,
      roundId,
      provider: provider as EngineProvider,
      result,
    });
  }
  // Harvest before the critique protocol runs, so the assembled gap payload and
  // the blue artifact are built from a reply with no RUBRIC lines in it. Skipped
  // for a failed or empty reply: there is nothing to judge, and calling a
  // silent provider "unanswered by the model" is false provenance.
  const judgedResult = blueRubric && !providerFailed && (result.summary ?? "").trim().length > 0
    ? {
        ...result,
        summary: harvestStageRubric({
          stageRubric: blueRubric,
          changeId,
          runId: dbRunId,
          roundId,
          rawText: result.summary ?? "",
        }).cleanedText,
      }
    : result;
  const lineProtocol = applyLineProtocol(
    judgedResult,
    (rawText) => {
      const parsed = parseSpecCritiqueLineProtocol(rawText);
      return parsed.ok
        ? { ok: true, payload: parsed.payload as unknown as Record<string, unknown> }
        : parsed;
    },
    { changeId, repoPath: project.repoPath },
  );
  const ingestion = await ingestStageAiOutput({
    changeId,
    runId: runScopedArtifactId,
    phase: "spec_critic",
    provider,
    outputSchema: BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA,
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
            message: result.providerErrorDetail || result.providerErrorCode || "Spec critic provider failed",
          };
        }
        const base = (candidate: unknown): true | { ok: false; message: string } => {
          const validation = validateBlueCritiqueOutput(candidate);
          return validation.success ? true : { ok: false, message: validation.error.message };
        };
        return guardLineProtocolSchema(lineProtocol.state, base, "spec_critic")(value);
      },
      validateBusiness: () => true,
      writeRawCapture: (envelope) =>
        persistStageRawCapture({
          repoPath: project.repoPath,
          changeId,
          runId: runScopedArtifactId,
          envelope,
        }),
    },
  });

  if (providerFailed) {
    throw new Error(
      ingestion.sanitizedErrorSummary
      || result.providerErrorDetail
      || result.providerErrorCode
      || result.summary
      || "Spec critic provider failed",
    );
  }
  if (!ingestion.ok) {
    throw new Error(ingestion.sanitizedErrorSummary || ingestion.errorCode || "Spec critic output invalid");
  }
  const validatedOutput = validateBlueCritiqueOutput(ingestion.structuredOutput);
  if (!validatedOutput.success) {
    throw new Error(`invalid_stage_output: ${validatedOutput.error.message}`);
  }
  assertCurrentExecutionFence(context, dbRunId);
  const threadId = normalizedProviderThreadId(result.threadId);
  if (threadId) {
    recordProviderSession({
      changeId,
      provider,
      sessionKind: "spec_critic",
      externalSessionId: threadId,
      lastRunId: dbRunId,
    });
  }
  assertChangeNotBlocked(changeId, "spec");
  await completeBlueCritique({
    changeId,
    roundId,
    blueCritique: validatedOutput.data,
    provider,
  });
  return result;
}
