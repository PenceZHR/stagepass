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
  pauseSpecBattleRoundForClarification,
  resumeSpecBattleRoundFromClarification,
} from "./spec-battle-service";
import { classifyStageConvergence } from "./stage-convergence-service";
import { runDelegatedRound } from "./pipeline-delegated-round";
import { presentDesignGateDecision } from "./design-gate-decision-presenter";
import { SPEC_DELEGATED_ROUND } from "./delegated-round-phases";
import {
  recordDelegatedRoundSideThreads,
  usedSubAgentThreadIds,
} from "./delegated-round-side-history";
import { recordRubricAssessmentsFromVerdicts } from "./rubric-service";
import { generateSpecReport, generateWarReport } from "./spec-battle-report-service";
import {
  createProviderLifecycleSink,
  documentStageTimeoutMs,
  getPipelineEngine,
  type EngineProvider,
} from "./pipeline-engine-service";
import {
  parseSpecRedLineProtocol,
  type SpecRedLinePayload,
} from "./spec-red-line-protocol";
import {
  defaultScopeForPhase,
  runDocumentStage,
  StageAwaitingClarificationError,
  withDocumentStageWatchdog,
} from "./pipeline-document-stage-runner-service";
import {
  endRun,
  setStatus,
  StageBoundaryViolationError,
  stopRun,
} from "./pipeline-run-ledger-service";
import {
  ingestStageAiOutput,
} from "./stage-ai-output-ingestion-service";
import {
  persistStageRawCapture,
} from "./stage-raw-capture-service";
import {
  BLUE_CRITIQUE_OUTPUT_JSON_SCHEMA,
  RED_SPEC_OUTPUT_JSON_SCHEMA,
  validateBlueCritiqueOutput,
} from "./spec-battle-ledger";
import {
  applyLineProtocol,
  guardLineProtocolSchema,
  type LineProtocolParseResult,
} from "./ai-line-protocol";
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
  resolveCanonicalChangeThread,
  resolveCodexStageThreadRoute,
  resolveProviderSession,
} from "./provider-session-service";
import { readCodexNativeFlags } from "../config/codex-native-flags";
import { resolveLogicalTurn } from "./codex-logical-turn-service";

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
  /**
   * Set by `retry_spec` only. Lets the claim take over a round parked on the
   * human's unanswered questions; see claimSpecBattleRedRun's parameter of the
   * same name for why `run_spec` must not.
   */
  abandonClarification?: boolean;
  /**
   * A reply this round's Codex task already produced, once its questions
   * converged.
   *
   * The round is parked, not claimable, so this path resumes it instead of
   * claiming it, and hands the reply to whichever leg parked. Everything after
   * that is the ordinary round: same rubric harvest, same protocol, same
   * artifacts, same reports, same gate.
   */
  adoptedResult?: AiRunResult;
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

/**
 * What the job returns when the round parked on the human.
 *
 * `success: true` is about the JOB, not the stage: the turn ran, it asked its
 * questions, and nothing went wrong. Reporting it as a failure is what used to
 * mark the round `failed` and close `run_spec` every time the model opened a
 * question card.
 */
function awaitingClarificationSpecResult(changeId: string, roundId: string, runId: string): AiRunResult {
  return {
    threadId: `${changeId}-spec-awaiting-clarification`,
    runId,
    summary: "spec_round_awaiting_clarification",
    success: true,
    changedFiles: [],
    structuredOutput: undefined,
    items: [],
  };
}

/**
 * How this call got hold of the round it is about to run.
 *
 * Two entry paths converge here. A normal dispatch CLAIMS a round; an adoption
 * RESUMES one that parked on the human. They differ in nothing else -- same run
 * ledger, same legs, same reports -- so they are normalised into one shape
 * rather than duplicating the body.
 */
type SpecRoundEntry =
  | {
      kind: "running";
      roundId: string;
      roundNo: number;
      runId: string;
      previousStatus: string;
      /** The leg to execute. Adoption may resume either; a claim always starts red. */
      leg: "red_running" | "blue_running";
    }
  | {
      kind: "declined";
      roundId: string;
      runId: string | null;
      reason: "spec_round_running" | "spec_round_awaiting_clarification";
    };

function claimSpecRound(
  changeId: string,
  provider: Provider,
  options: RunSpecOptions,
): SpecRoundEntry {
  const claim = claimSpecBattleRedRun({
    changeId,
    idempotencyKey: options.idempotencyKey,
    provider,
    abandonClarification: options.abandonClarification,
  });
  if (!claim.claimed) {
    return {
      kind: "declined",
      roundId: claim.roundId,
      runId: claim.runId,
      reason: claim.reason === "spec_round_awaiting_clarification"
        ? "spec_round_awaiting_clarification"
        : "spec_round_running",
    };
  }
  if (!claim.runId) throw new Error("Claimed Spec battle round has no business run");
  return {
    kind: "running",
    roundId: claim.roundId,
    roundNo: claim.roundNo,
    runId: claim.runId,
    previousStatus: claim.previousStatus,
    leg: "red_running",
  };
}

function resumeParkedSpecRound(changeId: string, provider: Provider): SpecRoundEntry {
  const resumed = resumeSpecBattleRoundFromClarification({ changeId, roundId: currentRoundId(changeId), provider });
  if (!resumed.resumed || !resumed.runId) {
    // Not parked any more: the same converged reply already settled this round,
    // or a retry took it over. Either way re-running the leg would duplicate
    // work the round already carries.
    return {
      kind: "declined",
      roundId: resumed.roundId,
      runId: null,
      reason: "spec_round_awaiting_clarification",
    };
  }
  return {
    kind: "running",
    roundId: resumed.roundId,
    roundNo: resumed.roundNo,
    runId: resumed.runId,
    previousStatus: "awaiting_clarification",
    leg: resumed.leg,
  };
}

function currentRoundId(changeId: string): string {
  const round = getSpecBattleState(changeId).latestRound;
  if (!round) throw new Error(`No Spec battle round to adopt a reply into: ${changeId}`);
  return round.id;
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
    const entry = options.adoptedResult
      ? resumeParkedSpecRound(changeId, provider)
      : claimSpecRound(changeId, provider, options);
    if (entry.kind === "declined") {
      assertCurrentExecutionFence(context);
      return entry.reason === "spec_round_running"
        ? alreadyRunningSpecResult(changeId, entry.roundId, entry.runId)
        : awaitingClarificationSpecResult(changeId, entry.roundId, entry.runId ?? entry.roundId);
    }
    const round = entry;
    assertCurrentExecutionFence(context);
    runLedgerRepository.bindRunToCurrentExecution(round.runId);
    assertCurrentExecutionFence(context, round.runId);

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

      // The delegated form settles red, blue AND the verdict rubric from one
      // turn, so it replaces all three legs below rather than sitting beside
      // them. Everything after -- gap sync, reports, gate -- is shared and runs
      // exactly as it does for the three-turn form.
      if (readCodexNativeFlags().specJudgeSubAgents) {
        result = await runDelegatedSpecRound({
          changeId,
          context,
          provider,
          roundId: round.roundId,
          roundNo: round.roundNo,
          runId: round.runId,
          adoptedResult: options.adoptedResult,
        });
      } else if (currentRound.status === "red_running") {
        const redChange = getChange(changeId);
        if (!redChange) throw new Error(`Change not found: ${changeId}`);
        const redProvider = provider as EngineProvider;
        // §3: red (SPEC_WRITER) is the Spec phase's producer, so it answers the
        // producer rubric as part of its own reply. The runner strips the
        // RUBRIC lines back out before anything else reads the reply -- red's
        // output is parsed as a line protocol and its PRD_DELTA block becomes
        // prd-delta.md, neither of which may contain foreign protocol text.
        const redRubric = resolveStageRubric(
          { projectId: redChange.projectId, changeId, phase: "Spec", role: "producer" },
          { runId: round.runId, roundId: round.roundId },
        );
        // Historical stage session is audit-only; it never selects execution.
        void latestSpecRetryThread({
          role: "writer",
          changeId,
          roundId: round.roundId,
          provider: redProvider,
          currentRunId: round.runId,
        });
        result = await runDocumentStage(changeId, {
          // Present only on the adoption path, and only when red is the leg
          // that parked -- the runner then ingests this reply instead of
          // starting a turn, through the identical rubric/protocol/artifact
          // path a directly produced one takes.
          adoptedResult: round.leg === "red_running" ? options.adoptedResult : undefined,
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
          logicalRole: "spec_writer",
          logicalRound: round.roundNo,
          runId: round.runId ?? undefined,
          deferRunCompletion: true,
          // Line-protocol stage: the model writes a PRD_DELTA block plus
          // FIXCLAIM/SPEC_DONE lines, never JSON. The schema must be supplied
          // even though the model never sees it -- the runner gates the whole
          // ingestion block on `config.outputSchema`, so a lineProtocol without
          // one parses nothing and lets the raw reply through untouched.
          outputSchema: RED_SPEC_OUTPUT_JSON_SCHEMA,
          lineProtocol: {
            parse: (rawText) => parseSpecRedLineProtocol(rawText) as LineProtocolParseResult,
          },
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
                    // parseSpecRedLineProtocol declares PRD_DELTA. The rubric
                    // guard runs the same structural check and runs FIRST, so
                    // without this it rejects the stage's own block as off
                    // script -- and since the Spec producer rubric ships with
                    // six factory criteria, the empty-rubric early return never
                    // fires and every red run would go BLOCKED.
                    expectedBlockNames: ["PRD_DELTA"],
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
        // The validated payload, not the reply text. The claims and the PRD
        // delta now travel as one object instead of being re-derived from a
        // string whose parseability decided, silently, whether the round kept
        // its fix claims at all.
        //
        // validateStructuredDocumentOutput has already rejected anything the
        // protocol or the schema refused, so this is a payload. Assert it here
        // regardless: completeRedSpecRound's union reads a missing redOutput as
        // the literal-markdown variant, so an undefined structuredOutput would
        // not fail -- it would settle a claim-free round hashing the string
        // "undefined". That is the exact silent shape this stage just stopped
        // producing, and the invariant holding it shut lives two files away.
        const redPayload = result.structuredOutput as unknown as SpecRedLinePayload | undefined;
        if (!redPayload) {
          throw new Error("spec red stage produced no line-protocol payload");
        }
        await completeRedSpecRound({
          changeId,
          roundId: round.roundId,
          redOutput: redPayload,
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
          // Blue asks too, and a round parked from its critique resumes here.
          // Handing red's adopted reply to blue would file an acknowledgement
          // as a gap list, so the reply only travels to the leg that parked.
          round.leg === "blue_running" ? options.adoptedResult : undefined,
        );
        assertCurrentExecutionFence(context, round.runId);
        result ??= blueResult;
      }
      assertCurrentExecutionFence(context, round.runId);
      assertChangeNotBlocked(changeId, "spec");
      // §2.3: after both sides have produced, a third agent judges the verdict
      // rubric against the two outputs. Deliberately before the reports: it
      // judges what red and blue produced, not stagepass's summary of them.
      //
      // Skipped for the delegated form, where the judge already answered this
      // rubric inside its own turn. Running it anyway would open a FOURTH turn
      // to re-ask a question that has been answered, and its verdicts would
      // overwrite the judge's for the same run and round.
      if (!readCodexNativeFlags().specJudgeSubAgents) await runSpecVerdictRubric({
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
      // The round produced a result; the human now has a decision to make, and
      // the web deliberately does not route it (NON_POST_ROUTED_ACTION_IDS). This
      // is what puts it on the Codex decision surface. Last, and after the status
      // move, so the card is built from the contract the human will actually act
      // against. Never throws -- see the presenter.
      presentDesignGateDecision({
        changeId,
        phase: "Spec",
        roundNo: round.roundNo,
        reportHash: `${round.roundId}:${round.runId}`,
      });
      if (!result) {
        throw new Error("Spec battle round had no executable work");
      }
      return result;
    } catch (err) {
      if (err instanceof StaleLeaseFenceError) {
        throw err;
      }
      // The turn ended by handing its questions to the human. Nothing failed:
      // the round parks, the run settles as produced-nothing, the change stays
      // at SPECCING, and the job reports success so the worker does not retry a
      // turn whose answer is with the user. The converged reply completes this
      // same round later, through adoption.
      if (err instanceof StageAwaitingClarificationError) {
        assertCurrentExecutionFence(context, round.runId);
        stopRun(round.runId, err.message);
        pauseSpecBattleRoundForClarification({ changeId, roundId: round.roundId });
        log.info(
          { changeId, roundId: round.roundId, runId: round.runId },
          "Spec round paused awaiting human clarification",
        );
        return awaitingClarificationSpecResult(changeId, round.roundId, round.runId);
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
 * Settles one round from a single delegated turn.
 *
 * The judge's turn produces all three parts, but only its own judgment comes
 * from its text: red's and blue's payloads are read off the sub-agent threads
 * that produced them, and the order they ran in is checked against those same
 * threads (readSpecJudgeRound). Nothing is written until all of it validates --
 * a half-settled round would leave a committed red leg with no critic, which
 * reads to every later query as a critic that found nothing.
 */
async function runDelegatedSpecRound(input: {
  changeId: string;
  context: JobExecutionContext;
  provider: Provider;
  roundId: string;
  roundNo: number;
  runId: string;
  adoptedResult?: AiRunResult;
}): Promise<AiRunResult> {
  const change = getChange(input.changeId);
  if (!change) throw new Error(`Change not found: ${input.changeId}`);
  const project = getProject(change.projectId);
  if (!project) throw new Error(`Project not found: ${change.projectId}`);

  // Resolved BEFORE the round: the judge needs the criterion ids in its brief,
  // and the ingestion needs them to refuse an invented id before red and blue
  // are committed.
  const verdictRubric = resolveStageRubric(
    { projectId: change.projectId, changeId: input.changeId, phase: "Spec", role: "verdict" },
    { runId: input.runId, roundId: input.roundId },
  );
  const { round, result } = await runDelegatedRound({
    descriptor: SPEC_DELEGATED_ROUND,
    verdictCriteria: verdictRubric?.rubric.criteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
    })) ?? [],
    changeId: input.changeId,
    changeTitle: change.title,
    repoPath: project.repoPath,
    roundNo: input.roundNo,
    runId: input.runId,
    context: input.context,
    provider: input.provider,
    adoptedResult: input.adoptedResult,
    // Threads earlier rounds already spent. The judge task stays open across
    // rounds, so without this round 2 could be attributed from round 1's
    // sub-agents without spawning anything.
    usedAgentThreadIds: usedSubAgentThreadIds(input.changeId),
  });

  assertCurrentExecutionFence(input.context, input.runId);
  assertChangeNotBlocked(input.changeId, "spec");
  // Recorded before the ledger writes: a round that settles red and then fails
  // must still have burned its sub-agent threads, or a retry could re-attribute
  // the very threads whose output it just refused.
  recordDelegatedRoundSideThreads({
    changeId: input.changeId,
    runId: input.runId,
    phase: SPEC_DELEGATED_ROUND.phase,
    roundId: input.roundId,
    roundNo: input.roundNo,
    sideThreads: round.sideThreads,
  });
  await completeRedSpecRound({
    changeId: input.changeId,
    roundId: input.roundId,
    redOutput: round.red as unknown as SpecRedLinePayload,
    provider: input.provider,
  });

  assertCurrentExecutionFence(input.context, input.runId);
  assertChangeNotBlocked(input.changeId, "spec");
  await completeBlueCritique({
    changeId: input.changeId,
    roundId: input.roundId,
    blueCritique: round.blue,
    provider: input.provider,
  });

  assertCurrentExecutionFence(input.context, input.runId);
  // The judge answers the VERDICT rubric, the same scope the third turn used to
  // answer. A missing criterion still lands as `not_assessed` and still blocks:
  // recordRubricAssessmentsFromVerdicts iterates criteria, not the judge's list.
  if (verdictRubric && verdictRubric.rubric.criteria.length > 0) {
    recordRubricAssessmentsFromVerdicts({
      changeId: input.changeId,
      runId: input.runId,
      roundId: input.roundId,
      rubric: verdictRubric.rubric,
      verdicts: round.judge.rubric,
    });
  }
  return result;
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
    const desktopBridgeEnabled = readCodexNativeFlags().desktopBridge;
    const { executableThreadId } = resolveCodexStageThreadRoute({
      desktopBridgeEnabled,
      resolveCanonicalThread: () => resolveCanonicalChangeThread(input.changeId),
      resolveLegacyGeneralThread: () => resolveProviderSession({
        changeId: input.changeId,
        provider: "codex",
        sessionKind: "general",
      }),
    });
    const logicalTurnId = desktopBridgeEnabled
      ? (await resolveLogicalTurn({
          owner: {
            kind: "pipeline_job",
            pipelineJobId: input.context.jobId,
          },
          phase: "Spec",
          role: "spec_verdict",
          round: round.roundNo,
          ordinal: 0,
          request: { prompt, sandboxMode: "read-only" },
        })).logicalTurnId
      : undefined;
    const result = await withDocumentStageWatchdog(engine.run(desktopBridgeEnabled ? {
      logicalTurnId: logicalTurnId!,
    } as never : {
      changeId: input.changeId,
      repoPath: project.repoPath,
      phase: "spec_verdict",
      logicalTurnId,
      threadId: executableThreadId,
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
  /**
   * A critique this round's Codex task already produced, once its questions
   * converged. Ingested in place of starting a turn; everything downstream --
   * rubric harvest, critique protocol, schema, gap ledger -- is unchanged, so
   * an adopted critique is held to exactly the contract a produced one is.
   */
  adoptedResult?: AiRunResult,
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
  const produceCritique = async (): Promise<AiRunResult> => {
    const prompt = appendRubricPromptSection(assemblePrompt("spec_critic", {
      changeId,
      repoPath: project.repoPath,
    }, defaultScopeForPhase("spec")), blueRubric);

    const engine = await getPipelineEngine(provider as EngineProvider);
    const stageTimeoutMs = documentStageTimeoutMs();
    // Historical stage session is audit-only; it never selects execution.
    void latestSpecRetryThread({
      role: "critic",
      changeId,
      roundId,
      provider: provider as EngineProvider,
      currentRunId: dbRunId,
    });
    const desktopBridgeEnabled = readCodexNativeFlags().desktopBridge;
    const { executableThreadId } = resolveCodexStageThreadRoute({
      desktopBridgeEnabled,
      resolveCanonicalThread: () => resolveCanonicalChangeThread(changeId),
      resolveLegacyGeneralThread: () => resolveProviderSession({
        changeId,
        provider: "codex",
        sessionKind: "general",
      }),
    });
    const logicalTurnId = desktopBridgeEnabled
      ? (await resolveLogicalTurn({
          owner: { kind: "pipeline_job", pipelineJobId: context.jobId },
          phase: "Spec",
          role: "spec_critic",
          round: round.roundNo,
          ordinal: 0,
          request: { prompt, sandboxMode: "read-only" },
        })).logicalTurnId
      : undefined;
    return withDocumentStageWatchdog(engine.run(desktopBridgeEnabled ? {
      logicalTurnId: logicalTurnId!,
    } as never : {
      changeId,
      repoPath: project.repoPath,
      phase: "spec_critic",
      logicalTurnId,
      threadId: executableThreadId,
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
  };
  // The whole engine block is skipped on adoption, not merely ignored: it
  // resolves a logical turn and a thread route as side effects, and creating a
  // second turn for a reply that already exists would hand this round a turn
  // nobody will ever run.
  const result = adoptedResult ?? await produceCritique();
  // Blue can hand its questions to the human too, and a turn that did produced
  // an acknowledgement, not a critique. Ingesting it would file "I have shown
  // you ten questions" as this round's gap list and settle the round on it --
  // the same false provenance runDocumentStage refuses for red. runSpec's catch
  // parks the round from blue_running and adoption resumes it here.
  if (classifyStageConvergence(result).kind === "asked_again") {
    throw new StageAwaitingClarificationError("spec_critic");
  }
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
  // result.threadId is historical provider metadata only; binding stays authoritative.
  assertChangeNotBlocked(changeId, "spec");
  await completeBlueCritique({
    changeId,
    roundId,
    blueCritique: validatedOutput.data,
    provider,
  });
  return result;
}
