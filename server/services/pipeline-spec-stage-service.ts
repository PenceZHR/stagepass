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

  const prompt = assemblePrompt("spec_critic", {
    changeId,
    repoPath: project.repoPath,
  }, defaultScopeForPhase("spec"));

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
  const lineProtocol = applyLineProtocol(
    result,
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
