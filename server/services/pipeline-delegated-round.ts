import { createChildLogger } from "../logger";
import type { AiRunResult } from "./ai-engine-types";
import { readCodexNativeFlags } from "../config/codex-native-flags";
import { resolveLogicalTurn } from "./codex-logical-turn-service";
import {
  getPipelineEngine,
  type EngineProvider,
} from "./pipeline-engine-service";
import {
  StageAwaitingClarificationError,
  withDocumentStageWatchdog,
} from "./pipeline-document-stage-runner-service";
import { classifyStageConvergence } from "./stage-convergence-service";
import type { JobExecutionContext } from "./job-execution-context";
import type { Provider } from "./provider-selection-service";
import type { DelegatedRoundPhase } from "./delegated-round-phases";
import {
  buildAndMaterialiseRoundBriefs,
  buildRoundDispatchPrompt,
} from "./delegated-round-briefs";
import { clearRoundOutputs } from "./delegated-round-workspace";
import {
  describeDelegatedRoundViolations,
  readDelegatedRound,
  type DelegatedRound,
  type SubAgentDiscovery,
} from "./delegated-round-ingestion";
import { createSubAgentThreadReader } from "./spec-subagent-thread-reader";
import type { SubAgentThreadReader } from "./codex-subagent-attribution";

const log = createChildLogger("pipeline-delegated-round");

/**
 * Runs one round of a design phase as a single delegated turn.
 *
 * The judge spawns red, waits, spawns blue pointed at red's output, waits, and
 * writes its verdict. All three write FILES; the server reads the files and
 * takes nothing from the chat.
 *
 * ## Why the turn carries almost no prompt
 *
 * The role definitions are materialised into the repo and the turn says "read
 * `roles/judge.md`, this is round N". The Codex task for a stage persists
 * across rounds, so a full brief every round would re-teach an agent that
 * already knows its job and bury round N's actual instruction. It also keeps
 * the judge from ever retyping its sub-agents' briefs -- it hands over a path,
 * and a path cannot be paraphrased into a weaker schema.
 *
 * ## What the server refuses to take on faith
 *
 * That a side ran at all, and that the sides took turns -- both read from the
 * sub-agent threads, which the judge does not control. And that each output
 * file was written inside its own author's turn window, which is what stops a
 * judge from writing all three files itself. See delegated-round-ingestion.ts.
 */

export class DelegatedRoundError extends Error {
  readonly code = "delegated_round_invalid";
  constructor(readonly violations: string) {
    super(`Delegated round refused: ${violations}`);
    this.name = "DelegatedRoundError";
  }
}

export interface DelegatedRoundInput {
  descriptor: DelegatedRoundPhase;
  changeId: string;
  changeTitle?: string;
  repoPath: string;
  roundNo: number;
  runId: string;
  context: JobExecutionContext;
  provider: Provider;
  /** Sub-agent threads earlier rounds of this change already used. */
  usedAgentThreadIds?: ReadonlySet<string>;
  /**
   * The verdict rubric's criteria. They travel into the judge's brief (so it
   * knows the ids exist) and into the ingestion (so an invented id refuses the
   * round before anything is written).
   */
  verdictCriteria?: readonly { id: string; text: string }[];
  /** The critic rubric's criteria. Same contract, for blue. */
  criticCriteria?: readonly { id: string; text: string }[];
  /** A judge turn this task already produced, once its questions converged. */
  adoptedResult?: AiRunResult;
  /** Injected in tests; production discovers and reads sub-agent threads over the bridge. */
  ports?: DelegatedRoundPorts;
}

export async function runDelegatedRound(
  input: DelegatedRoundInput,
): Promise<{ round: DelegatedRound; result: AiRunResult }> {
  const paths = buildAndMaterialiseRoundBriefs({
    descriptor: input.descriptor,
    changeId: input.changeId,
    changeTitle: input.changeTitle,
    repoPath: input.repoPath,
    roundNo: input.roundNo,
    verdictCriteria: input.verdictCriteria,
    criticCriteria: input.criticCriteria,
  });

  const result = input.adoptedResult ?? await produceJudgeTurn(input, paths);

  // A judge that ended by opening a question card produced an acknowledgement,
  // not a round. Parking is the correct terminal -- the caller turns this into
  // `awaiting_clarification` and adoption resumes here once the human answers.
  if (classifyStageConvergence(result).kind === "asked_again") {
    throw new StageAwaitingClarificationError(`${input.descriptor.runPhase}_judge`);
  }

  // A judge turn that did not complete produced no round, and saying so here is
  // the difference between a diagnosis and a wild goose chase.
  //
  // The engine returns `success: false` rather than throwing for a whole class
  // of transport failures -- its catch only re-throws CodexDesktopEngineError,
  // so a CodexDesktopBridgeError (a different class) falls through to a soft
  // result. Nothing in this file read `success`, so a wedged Codex app-server
  // that never dispatched the turn arrived at ingestion looking exactly like a
  // judge that ran and delegated nothing. Measured on CHG-006 round 8: three
  // 30-second failures reported as 「red 方没有写出产出文件」 when the truth was
  // `desktop_follower_start_ambiguous` -- the turn never started, and no file
  // could have been written by anyone.
  if (!result.success) {
    throw new DelegatedRoundError(
      `judge turn did not complete: ${
        result.providerErrorCode ?? result.providerErrorDetail ?? "unknown provider failure"
      }`,
    );
  }

  // The judge's own thread is where its children hang off. `result.threadId`
  // is the turn's thread; without it there is nothing to enumerate children
  // against, and a round with no discoverable sides is refused rather than
  // guessed at.
  const judgeThreadId = result.threadId?.trim();
  if (!judgeThreadId || judgeThreadId.toLowerCase() === "unknown") {
    throw new DelegatedRoundError("judge turn reported no thread id, so its sub-agents cannot be found");
  }
  const ports = input.ports ?? await productionRoundPorts();
  const parsed = await readDelegatedRound({
    descriptor: input.descriptor,
    changeId: input.changeId,
    repoPath: input.repoPath,
    roundNo: input.roundNo,
    judgeThreadId,
    usedAgentThreadIds: input.usedAgentThreadIds,
    verdictCriterionIds: (input.verdictCriteria ?? []).map((criterion) => criterion.id),
    criticCriterionIds: (input.criticCriteria ?? []).map((criterion) => criterion.id),
    listSubAgents: ports.listSubAgents,
    readThread: ports.readThread,
  });
  if (!parsed.ok) {
    const described = describeDelegatedRoundViolations(parsed.violations);
    log.warn(
      {
        changeId: input.changeId,
        phase: input.descriptor.phase,
        runId: input.runId,
        violations: parsed.violations,
      },
      "Delegated round refused",
    );
    throw new DelegatedRoundError(described);
  }

  log.info(
    {
      changeId: input.changeId,
      phase: input.descriptor.phase,
      runId: input.runId,
      sideThreads: parsed.round.sideThreads,
    },
    "Delegated round assembled from its sub-agent threads and output files",
  );
  return { round: parsed.round, result };
}

async function produceJudgeTurn(
  input: DelegatedRoundInput,
  paths: ReturnType<typeof buildAndMaterialiseRoundBriefs>,
): Promise<AiRunResult> {
  if (!readCodexNativeFlags().desktopBridge) {
    // Sub-agents exist only on the Codex desktop path.
    throw new DelegatedRoundError("desktop bridge is off; sub-agents are unavailable");
  }
  // A retry that failed before a side rewrote its file must not be settled from
  // the previous attempt's output -- a document no side produced this round.
  clearRoundOutputs({
    repoPath: input.repoPath,
    changeId: input.changeId,
    phase: input.descriptor.phase,
    roundNo: input.roundNo,
  });

  const logicalTurnId = (await resolveLogicalTurn({
    owner: { kind: "pipeline_job", pipelineJobId: input.context.jobId },
    phase: input.descriptor.phase,
    role: "delegated_round_judge",
    round: input.roundNo,
    ordinal: 0,
    request: {
      prompt: buildRoundDispatchPrompt({
        descriptor: input.descriptor,
        changeId: input.changeId,
        roundNo: input.roundNo,
        paths,
      }),
      // The round writes files, so the turn cannot be read-only any more. The
      // deterministic guard is what holds the line instead: the phase's
      // writable scope covers this round's output json and nothing else, and
      // anything outside it blocks the round.
      sandboxMode: "workspace-write",
    },
  })).logicalTurnId;

  const engine = await getPipelineEngine(input.provider as EngineProvider);
  return withDocumentStageWatchdog(
    engine.run({ logicalTurnId } as never),
    input.descriptor.runPhase,
    `${input.descriptor.runPhase}_judge`,
  );
}

export interface DelegatedRoundPorts {
  listSubAgents: SubAgentDiscovery;
  readThread: SubAgentThreadReader;
}

async function productionRoundPorts(): Promise<DelegatedRoundPorts> {
  const { getProductionCodexAppServerShellControl } = await import(
    "./codex-desktop-engine"
  );
  const shellControl = await getProductionCodexAppServerShellControl();
  return {
    listSubAgents: (parentThreadId) => shellControl.listSubAgentThreads({ parentThreadId }),
    readThread: createSubAgentThreadReader(shellControl),
  };
}
