import {
  resolveStageClarificationPolicy,
  type StageClarificationId,
} from "../../lib/stage-clarification-policy";
import type { AiRunResult } from "./ai-engine-types";
import type { JobExecutionContext } from "./job-execution-context";
import { sealClarifiedStageGate } from "./clarified-stage-gate-service";

export class StageResultAdoptionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "StageResultAdoptionError";
  }
}

export type StageAdopter = (
  changeId: string,
  context: JobExecutionContext,
  adoptedResult: AiRunResult,
) => Promise<AiRunResult>;

export type StageAdopterMap = Partial<Record<StageClarificationId, StageAdopter>>;

/**
 * Stages whose formal result the clarification loop can persist on its own.
 *
 * Only document stages belong here. A stage that writes code or runs commands
 * produces its result by acting on the repository, so a reply text is not its
 * output and adopting one would record a document the run never made.
 */
export async function productionStageAdopters(): Promise<StageAdopterMap> {
  const pipeline = await import("./pipeline-service");
  return {
    prd: (changeId, context, adoptedResult) =>
      pipeline.runIntake(changeId, context, undefined, adoptedResult),
    // Spec's round is parked, not claimable, while its questions are open, so
    // runSpec resumes it rather than claiming it and hands the reply to
    // whichever leg parked. Without this entry a Spec round that asked anything
    // could only ever be abandoned by `retry_spec` -- the answers the human
    // gave would have nothing to complete.
    spec: (changeId, context, adoptedResult) =>
      pipeline.runSpec(changeId, context, { adoptedResult }),
    // The same shape one phase over. A delegated TechSpec / Plan / TestPlan
    // round parks on `awaiting_clarification` rather than failing, so the round
    // is still there when the human answers -- and `runDelegatedPhaseStage`
    // resumes it in place rather than opening a second one beside it.
    //
    // Without these entries `adoptConvergedStageResult` throws
    // `stage_adoption_unsupported_phase`, which means the answers the human
    // typed have nothing to complete and the only remaining exit is `retry_*`:
    // abandoning the round and burning a full red/blue/judge cycle to ask the
    // same questions again.
    tech_spec: (changeId, context, adoptedResult) =>
      pipeline.runTechSpec(changeId, context, undefined, adoptedResult),
    plan: (changeId, context, adoptedResult) =>
      pipeline.generatePlan(changeId, context, undefined, adoptedResult),
    test_plan: (changeId, context, adoptedResult) =>
      pipeline.runTestPlan(changeId, context, undefined, adoptedResult),
  };
}

/**
 * Persist a converged clarification reply as the stage's formal result.
 *
 * The reply arrives on a turn owned by the Codex task, not by a stage job, so
 * it is handed to the stage's own runner in adoption mode: same ledger, same
 * validation, same artifact, same gate transition.
 */
export async function adoptConvergedStageResult(input: {
  changeId: string;
  phase: string;
  result: AiRunResult;
  context: JobExecutionContext;
  stages?: StageAdopterMap;
  seal?: (input: {
    changeId: string;
    phase: string;
    document?: string;
  }) => void;
}): Promise<AiRunResult> {
  const policy = resolveStageClarificationPolicy(input.phase);
  const stages = input.stages ?? await productionStageAdopters();
  const adopt = policy.id === "generic"
    ? undefined
    : stages[policy.id];
  if (!adopt) {
    throw new StageResultAdoptionError(
      "stage_adoption_unsupported_phase",
      `No stage can adopt a converged result for phase: ${input.phase}`,
    );
  }
  const adopted = await adopt(input.changeId, input.context, input.result);
  // The stage wrote its artifact; its gate has to agree, or the change lands
  // in a state whose only remaining action is to throw the work away.
  (input.seal ?? sealClarifiedStageGate)({
    changeId: input.changeId,
    phase: input.phase,
    document: adopted.summary ?? input.result.summary ?? "",
  });
  return adopted;
}
