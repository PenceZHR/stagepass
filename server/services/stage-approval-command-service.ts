import { randomUUID } from "node:crypto";

import { db } from "../db";
import { changes, stageGates } from "../db/schema";
import { and, desc, eq } from "drizzle-orm";
import {
  resolveStageClarificationPolicy,
  type StageClarificationId,
} from "../../lib/stage-clarification-policy";
import { canonicalPipelineCommandRequestHash } from "./pipeline-command-gateway";
import { orchestrateAfterCommand } from "./pipeline-command-orchestration";
import type { PipelineCommand } from "./pipeline-command-types";
import { STAGE_APPROVAL_QUESTION_ID } from "./stage-convergence-service";
import type { PipelinePhase } from "./stage-authority-service";

export interface StageApprovalAnswer {
  questionId: string;
  question: string;
  selectedOptionIds: string[];
  selectedLabels: string[];
}

/**
 * The gate action each stage's approval card stands for, and the gate phase
 * whose snapshot fences the command.
 */
export const STAGE_APPROVAL_ACTIONS: Partial<Record<StageClarificationId, {
  approve: string;
  reject: string;
  gatePhase: PipelinePhase;
}>> = {
  prd: { approve: "approve_intake", reject: "reject_intake", gatePhase: "PRD" },
};

/**
 * The approval card declares exactly two options, A to approve and B to send
 * back. Reading the option id rather than the label keeps the decision out of
 * the model's prose: a card that renamed its buttons still cannot turn a
 * rejection into an approval.
 */
export function approvalDecisionFromAnswers(
  phase: string,
  answers: StageApprovalAnswer[],
): { actionId: string } | null {
  if (answers.length !== 1) return null;
  const [answer] = answers;
  if (answer.questionId !== STAGE_APPROVAL_QUESTION_ID) return null;
  if (answer.selectedOptionIds.length !== 1) return null;
  const policy = resolveStageClarificationPolicy(phase);
  const actions = policy.id === "generic"
    ? undefined
    : STAGE_APPROVAL_ACTIONS[policy.id];
  if (!actions) return null;
  const selected = answer.selectedOptionIds[0]!.trim().toUpperCase();
  if (selected === "A") return { actionId: actions.approve };
  if (selected === "B") return { actionId: actions.reject };
  return null;
}

export class StageApprovalCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "StageApprovalCommandError";
  }
}

/**
 * Run a stage approval the human gave on a Codex card as a real pipeline
 * command, so it carries the same gate fence, receipt and follow-up enqueue a
 * decision made anywhere else would.
 */
export async function executeStageApproval(input: {
  changeId: string;
  phase: string;
  actionId: string;
  idempotencyKey: string;
  commandId?: string;
}): Promise<void> {
  const change = db.select().from(changes)
    .where(eq(changes.id, input.changeId)).get();
  if (!change) {
    throw new StageApprovalCommandError("change_not_found", input.changeId);
  }
  const policy = resolveStageClarificationPolicy(input.phase);
  const actions = policy.id === "generic"
    ? undefined
    : STAGE_APPROVAL_ACTIONS[policy.id];
  if (!actions) {
    throw new StageApprovalCommandError(
      "stage_approval_unsupported_phase",
      input.phase,
    );
  }
  const gate = db.select().from(stageGates).where(and(
    eq(stageGates.changeId, input.changeId),
    eq(stageGates.phase, actions.gatePhase),
  )).orderBy(desc(stageGates.computedAt), desc(stageGates.gateVersion)).get();
  if (!gate?.sourceDbHash) {
    throw new StageApprovalCommandError(
      "stage_approval_gate_missing",
      `${actions.gatePhase} gate has no snapshot to fence the decision`,
    );
  }

  const command: PipelineCommand = {
    commandId: input.commandId ?? `CMD-${randomUUID()}`,
    projectId: change.projectId,
    changeId: input.changeId,
    actionId: input.actionId,
    expectedGateVersion: String(gate.gateVersion),
    expectedSourceDbHash: gate.sourceDbHash,
    expectedHeadSha: null,
    idempotencyKey: input.idempotencyKey,
    requestHash: "",
    actor: { kind: "human", surface: "codex_mcp_app" },
    payload: {},
  };
  command.requestHash = canonicalPipelineCommandRequestHash(command);
  await orchestrateAfterCommand({
    command,
    previousStatus: change.status,
  });
}
