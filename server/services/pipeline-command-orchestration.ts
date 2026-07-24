import {
  requireCurrentActionContract,
  type PipelineActionContract,
} from "./action-contract-service";
import { enqueueProviderActionAtomically } from "./job-dispatch-service";
import { resolvePipelineCommandAction } from "./pipeline-command-action-map";
import {
  pipelineJobSelectionForAction,
  type EnqueuePipelineJobInput,
} from "./pipeline-job-types";
import {
  executePipelineCommand,
} from "./pipeline-command-gateway";
import type {
  PipelineCommand,
  PipelineCommandResult,
} from "./pipeline-command-types";

export interface PipelineCommandFollowUp {
  actionId: string;
  phase: string;
}

const FOLLOW_UP: Readonly<
  Record<string, PipelineCommandFollowUp | null>
> = {
  approve_intake: { actionId: "run_spec", phase: "spec" },
  approve_spec: { actionId: "run_tech_spec", phase: "tech-spec" },
  approve_tech_spec: { actionId: "run_plan", phase: "plan" },
  approve_plan: { actionId: "run_test_plan", phase: "test-plan" },
  approve_merge: { actionId: "merge", phase: "release" },
};

export interface OrchestrateAfterCommandInput {
  command: PipelineCommand;
  previousStatus: string;
  execute?: (command: PipelineCommand) => Promise<PipelineCommandResult>;
  refreshAction?: (
    changeId: string,
    actionId: string,
  ) => PipelineActionContract;
  enqueue?: (
    input: EnqueuePipelineJobInput,
    contract: PipelineActionContract,
  ) => { job: { id: string } };
}

export interface OrchestratedPipelineCommandResult
  extends PipelineCommandResult {
  enqueued: PipelineCommandFollowUp[];
}

function followUpFor(
  command: PipelineCommand,
  previousStatus: string,
): PipelineCommandFollowUp | null {
  const canonicalActionId = resolvePipelineCommandAction(
    command.actionId,
  ).canonicalActionId;
  if (
    canonicalActionId === "approve_plan" &&
    previousStatus === "TESTPLAN_DONE"
  ) {
    return { actionId: "run_build", phase: "implement" };
  }

  const approvalFollowUp = FOLLOW_UP[canonicalActionId];
  if (approvalFollowUp !== undefined) return approvalFollowUp;

  // Operational commands use the same public route. They enqueue themselves
  // after the Gateway has accepted their canonical command envelope.
  const selection = pipelineJobSelectionForAction(canonicalActionId);
  return selection
    ? { actionId: selection.actionId, phase: selection.phase }
    : null;
}

export async function orchestrateAfterCommand(
  input: OrchestrateAfterCommandInput,
): Promise<OrchestratedPipelineCommandResult> {
  const result = await (input.execute ?? executePipelineCommand)(input.command);
  const followUp = followUpFor(input.command, input.previousStatus);
  if (!followUp) return { ...result, enqueued: [] };

  // The approval has already changed authoritative state. Recompute now and
  // use only this post-command contract as the enqueue fence.
  const freshContract = (input.refreshAction ?? requireCurrentActionContract)(
    input.command.changeId,
    followUp.actionId,
  );
  const selection = pipelineJobSelectionForAction(followUp.actionId);
  if (!selection) {
    throw new Error(
      `No pipeline job selection for follow-up ${followUp.actionId}`,
    );
  }
  const enqueueResult = (
    input.enqueue ?? enqueueProviderActionAtomically
  )(
    {
      ...selection,
      changeId: input.command.changeId,
      idempotencyKey: `${input.command.idempotencyKey}:follow-up:${followUp.actionId}`,
    },
    freshContract,
  );

  return {
    ...result,
    enqueuedJobId: enqueueResult.job.id,
    enqueued: [followUp],
  };
}
