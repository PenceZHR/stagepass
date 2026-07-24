import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { readCodexNativeFlags } from "../config/codex-native-flags";
import {
  isCodexDecisionSurfaceEnabled,
  type CodexDecisionPhase,
} from "../config/codex-decision-rollout";
import { db } from "../db";
import {
  changes,
  events,
  findings,
  prdBriefings,
  projects,
  qaRuns,
  reviewReports,
  reviewState,
} from "../db/schema";
import {
  createPipelineCommandRepository,
  type PipelineCommandRepository,
} from "../repositories/pipeline-command-repository";
import {
  requireCurrentActionContract,
  type PipelineActionContract,
} from "./action-contract-service";
import {
  DESIGN_INTERACTION_PHASES,
  projectInteractionPhase,
  resolvePipelineCommandAction,
} from "./pipeline-command-action-map";
import { pipelineJobSelectionForAction } from "./pipeline-job-types";
import {
  approveGateWithDb,
  rejectGateWithDb,
  type GateName,
} from "./gate-service";
import {
  approvePlanSnapshotWithDb,
  confirmTestPlanWithDb,
  rejectPlanSnapshotWithDb,
  rejectTestPlanWithDb,
  waivePlanP1WithDb,
} from "./plan-approval-service";
import {
  applyBriefingQuestionCommandWithDb,
  assertPrdBriefingLockReady,
  getPrdBriefingState,
} from "./prd-briefing-service";
import { applySpecBattleDecisionWithDb } from "./spec-battle-service";
import {
  PipelineCommandUnitOfWork,
  type AuthenticatedInteractionClaim,
  type PipelineCommandCompletionContext,
} from "./pipeline-command-unit-of-work";
import {
  PipelineCommandError,
  type PipelineCommand,
  type PipelineCommandHandlerResult,
  type PipelineCommandResult,
} from "./pipeline-command-types";
import { assertActionAllowedAsync } from "./preflight-service";
import { transitionChangeStatusWithDb } from "./change-status-service";
import {
  absorbBuildPatch,
  adoptFixPatch,
  approveBuildForAbsorb,
  assertBuildAdoptionIdentity,
  rejectLatestBuildRun,
} from "./build-workspace-service";
import { resolveAdoptionCommitBranch } from "./change-service";
import { computeMergeReadiness } from "./merge-readiness-service";

const HUMAN_DECISION_ACTIONS = new Set([
  "lock_prd_briefing",
  "approve_intake",
  "reject_intake",
  "approve_spec",
  "reject_spec",
  "approve_tech_spec",
  "reject_tech_spec",
  "approve_plan",
  "request_spec_changes",
  "return_to_spec",
  "waive_spec_p1",
  "waive_plan_p1",
  "reject_plan",
  "reject_test_plan",
  "approve_merge",
  "reject_merge",
  "adopt_build",
  "adopt_fix",
  "reject_build",
  "waive_review_p1",
  "fix_blockers",
  "stop_change",
  "enter_qa",
  "record_qa_manual_check",
  "override_merge",
  "request_rework",
]);

export function isHumanDecisionAction(actionId: string): boolean {
  return HUMAN_DECISION_ACTIONS.has(
    resolvePipelineCommandAction(actionId).canonicalActionId,
  );
}

const PRD_INTERACTION_ACTIONS = new Set([
  "answer_prd_question",
  "accept_prd_assumption",
  "defer_prd_question",
  "lock_prd_briefing",
]);

export const PrdInteractionPayloads = {
  answer_prd_question: z.object({
    questionId: z.string().min(1),
    answer: z.string().trim().min(1).max(8_000),
  }).strict(),
  accept_prd_assumption: z.object({
    questionId: z.string().min(1),
    confirmation: z.literal(true),
  }).strict(),
  defer_prd_question: z.object({
    questionId: z.string().min(1),
    reason: z.string().trim().min(1).max(2_000),
  }).strict(),
  lock_prd_briefing: z.object({
    briefingId: z.string().min(1),
    confirmation: z.literal(true),
  }).strict(),
  approve_intake: z.object({
    confirmation: z.literal(true),
  }).strict(),
  reject_intake: z.object({
    reason: z.string().trim().min(1).max(2_000),
  }).strict(),
} as const;

type PrdPayloadActionId = keyof typeof PrdInteractionPayloads;

function isPrdPayloadActionId(value: string): value is PrdPayloadActionId {
  return Object.prototype.hasOwnProperty.call(PrdInteractionPayloads, value);
}

export function parsePrdInteractionPayload(
  actionId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPrdPayloadActionId(actionId)) return payload;
  const parsed = PrdInteractionPayloads[actionId].safeParse(payload);
  if (!parsed.success) {
    throw new PipelineCommandError(
      "invalid_pipeline_command",
      parsed.error.issues[0]?.message ?? `Invalid payload for ${actionId}`,
      422,
    );
  }
  return parsed.data;
}

export const DesignDecisionPayloads = {
  supply_spec_fact: z.object({
    fact: z.string().trim().min(1).max(8_000),
    affectedArtifactIds: z.array(z.string().min(1)).max(20),
  }).strict(),
  dispute_spec_gap: z.object({
    gapId: z.string().min(1),
    reason: z.string().trim().min(1).max(4_000),
    evidenceIds: z.array(z.string().min(1)).max(20),
  }).strict(),
  return_to_spec: z.object({
    reason: z.string().trim().min(1).max(4_000),
  }).strict(),
  waive_spec_p1: z.object({
    gapId: z.string().min(1),
    reason: z.string().trim().min(1).max(4_000),
  }).strict(),
  reject_plan: z.object({
    reason: z.string().trim().min(1).max(4_000),
  }).strict(),
  approve_test_plan: z.object({
    confirmation: z.literal(true),
  }).strict(),
  reject_test_plan: z.object({
    reason: z.string().trim().min(1).max(4_000),
  }).strict(),
  waive_plan_p1: z.object({
    riskId: z.string().min(1),
    reason: z.string().trim().min(1).max(4_000),
  }).strict(),
} as const;

type DesignPayloadActionId = keyof typeof DesignDecisionPayloads;

export function requireFreshDesignReport(
  currentReportHash: string | null | undefined,
  expectedReportHash: string | null | undefined,
): void {
  if (
    !currentReportHash
    || !expectedReportHash
    || currentReportHash !== expectedReportHash
  ) {
    throw new PipelineCommandError("design_report_hash_drift");
  }
}

export function parseDesignDecisionPayload(
  actionId: string,
  payload: Record<string, unknown>,
  context?: {
    currentReportHash: string;
    expectedReportHash: string;
    gapSeverity?: "P0" | "P1" | "P2";
  },
): Record<string, unknown> {
  if (
    !Object.prototype.hasOwnProperty.call(DesignDecisionPayloads, actionId)
  ) return payload;
  const schema =
    DesignDecisionPayloads[actionId as DesignPayloadActionId];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new PipelineCommandError(
      "invalid_pipeline_command",
      parsed.error.issues[0]?.message ?? `Invalid payload for ${actionId}`,
      422,
    );
  }
  if (context) {
    requireFreshDesignReport(
      context.currentReportHash,
      context.expectedReportHash,
    );
    if (
      actionId === "waive_spec_p1"
      && context.gapSeverity === "P0"
    ) {
      throw new PipelineCommandError("p0_cannot_be_waived");
    }
  }
  return parsed.data;
}

export const BuildDecisionPayloads = {
  adopt_build: z.object({
    buildRunId: z.string().min(1),
    patchHash: z.string().min(1),
    changedFilesHash: z.string().min(1),
    confirmation: z.literal(true),
  }).strict(),
  adopt_fix: z.object({
    buildRunId: z.string().min(1),
    patchHash: z.string().min(1),
    changedFilesHash: z.string().min(1),
    confirmation: z.literal(true),
  }).strict(),
  reject_build: z.object({
    buildRunId: z.string().min(1),
    patchHash: z.string().min(1),
    changedFilesHash: z.string().min(1),
    confirmation: z.literal(true),
  }).strict(),
} as const;

type BuildDecisionActionId = keyof typeof BuildDecisionPayloads;

function isBuildDecisionActionId(
  value: string,
): value is BuildDecisionActionId {
  return Object.prototype.hasOwnProperty.call(BuildDecisionPayloads, value);
}

export const ReleaseDecisionPayloads = {
  waive_review_p1: z.object({
    findingId: z.string().min(1),
    reason: z.string().trim().min(1).max(4_000),
  }).strict(),
  fix_blockers: z.object({ confirmation: z.literal(true) }).strict(),
  stop_change: z.object({
    reason: z.string().trim().min(1).max(4_000),
    confirmation: z.literal(true),
  }).strict(),
  enter_qa: z.object({ confirmation: z.literal(true) }).strict(),
  retry_qa: z.object({
    qaRunId: z.string().min(1),
    reason: z.string().trim().min(1).max(2_000),
  }).strict(),
  record_qa_manual_check: z.object({
    qaRunId: z.string().min(1),
    checkId: z.string().min(1),
    outcome: z.enum(["passed", "failed"]),
    evidenceIds: z.array(z.string().min(1)).min(1).max(20),
    notes: z.string().trim().max(4_000).default(""),
  }).strict(),
  request_qa_fix: z.object({
    qaRunId: z.string().min(1),
    reason: z.string().trim().min(1).max(4_000),
  }).strict(),
  approve_merge: z.object({ confirmation: z.literal(true) }).strict(),
  reject_merge: z.object({
    reason: z.string().trim().min(1).max(4_000),
  }).strict(),
  override_merge: z.object({
    blockerIds: z.array(z.string().min(1)).min(1).max(50),
    reason: z.string().trim().min(1).max(4_000),
    confirmation: z.literal(true),
  }).strict(),
  request_rework: z.object({
    phase: z.enum(["Plan", "TestPlan", "Build", "Implement", "Check", "Fix"]),
    reason: z.string().trim().min(1).max(4_000),
  }).strict(),
} as const;

type ReleaseDecisionActionId = keyof typeof ReleaseDecisionPayloads;

function isReleaseDecisionActionId(
  value: string,
): value is ReleaseDecisionActionId {
  return Object.prototype.hasOwnProperty.call(ReleaseDecisionPayloads, value);
}

export function parseReleaseDecisionPayload(
  actionId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!isReleaseDecisionActionId(actionId)) return payload;
  const parsed = ReleaseDecisionPayloads[actionId].safeParse(payload);
  if (!parsed.success) {
    throw new PipelineCommandError(
      "invalid_pipeline_command",
      parsed.error.issues[0]?.message ?? `Invalid payload for ${actionId}`,
      422,
    );
  }
  return parsed.data;
}

export function parseBuildDecisionPayload(
  actionId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!isBuildDecisionActionId(actionId)) return payload;
  const parsed = BuildDecisionPayloads[actionId].safeParse(payload);
  if (!parsed.success) {
    throw new PipelineCommandError(
      "invalid_pipeline_command",
      parsed.error.issues[0]?.message ?? `Invalid payload for ${actionId}`,
      422,
    );
  }
  return parsed.data;
}

const OPERATIONAL_ACTIONS = new Set([
  "start_stage",
  "retry_stage",
  "interrupt_turn",
  "recover_change",
  "open_codex",
  "update_codex_settings",
]);

const WEB_HUMAN_COMMAND_REGISTRY = {
  answer_prd_question: { phase: "PRD", kind: "prd_question" },
  accept_prd_assumption: { phase: "PRD", kind: "prd_question" },
  defer_prd_question: { phase: "PRD", kind: "prd_question" },
  lock_prd_briefing: { phase: "PRD", kind: "prd_lock" },
  approve_intake: { phase: "Intake", kind: "gate_decision" },
  reject_intake: { phase: "Intake", kind: "gate_decision" },
  approve_spec: { phase: "Spec", kind: "gate_decision" },
  reject_spec: { phase: "Spec", kind: "gate_decision" },
  approve_tech_spec: { phase: "TechSpec", kind: "gate_decision" },
  reject_tech_spec: { phase: "TechSpec", kind: "gate_decision" },
  request_spec_changes: { phase: "Spec", kind: "gate_decision" },
  return_to_spec: { phase: "Spec", kind: "gate_decision" },
  waive_spec_p1: { phase: "Spec", kind: "gate_decision" },
  waive_plan_p1: { phase: "Plan", kind: "risk_waiver" },
  reject_plan: { phase: "Plan", kind: "risk_waiver" },
  reject_test_plan: { phase: "TestPlan", kind: "gate_decision" },
  approve_merge: { phase: "Merge", kind: "merge_decision" },
  reject_merge: { phase: "Merge", kind: "merge_decision" },
  adopt_build: { phase: "Build", kind: "build_adoption" },
  adopt_fix: { phase: "Fix", kind: "build_adoption" },
  reject_build: { phase: "Build", kind: "build_adoption" },
  waive_review_p1: { phase: "Review", kind: "review_resolution" },
  fix_blockers: { phase: "Review", kind: "review_resolution" },
  stop_change: { phase: "Review", kind: "review_resolution" },
  enter_qa: { phase: "Review", kind: "review_resolution" },
  retry_qa: { phase: "QA", kind: "gate_decision" },
  record_qa_manual_check: { phase: "QA", kind: "gate_decision" },
  override_merge: { phase: "Merge", kind: "merge_decision" },
  request_rework: { phase: "Merge", kind: "merge_decision" },
} as const;

export type WebPipelineCommandClassification =
  | {
      kind: "system";
      surface: "stagepass_web_ops";
      canonicalActionId: string;
    };

export function classifyWebPipelineCommand(
  actionId: string,
  previousStatus: string,
  _decisionSurfaceEnabled: (
    phase: CodexDecisionPhase,
    kind:
      | "prd_question"
      | "prd_lock"
      | "gate_decision"
      | "risk_waiver"
      | "build_adoption"
      | "review_resolution"
      | "merge_decision",
  ) => boolean,
): WebPipelineCommandClassification {
  void _decisionSurfaceEnabled;
  const canonicalActionId =
    resolvePipelineCommandAction(actionId).canonicalActionId;
  const registered =
    actionId in DESIGN_INTERACTION_PHASES
      ? {
          phase: projectInteractionPhase(
            actionId as keyof typeof DESIGN_INTERACTION_PHASES,
          ),
          kind:
            actionId === "waive_plan_p1"
            || actionId === "approve_plan"
            || actionId === "reject_plan"
              ? "risk_waiver" as const
              : "gate_decision" as const,
        }
      : canonicalActionId === "approve_plan"
      ? previousStatus === "TESTPLAN_DONE"
        ? { phase: "TestPlan" as const, kind: "gate_decision" as const }
        : { phase: "Plan" as const, kind: "risk_waiver" as const }
      : WEB_HUMAN_COMMAND_REGISTRY[
          canonicalActionId as keyof typeof WEB_HUMAN_COMMAND_REGISTRY
        ];
  if (registered) {
    throw new PipelineCommandError(
      "actor_surface_forbidden",
      "Business decisions must use Codex MCP or the audited emergency surface",
      403,
    );
  }
  if (pipelineJobSelectionForAction(canonicalActionId)) {
    return {
      kind: "system",
      surface: "stagepass_web_ops",
      canonicalActionId,
    };
  }
  throw new PipelineCommandError(
    "unknown_action_kind",
    `Unknown Web command action: ${actionId}`,
    422,
  );
}

const ACTION_ROLLOUT_PHASE: Record<string, CodexDecisionPhase> = {
  answer_prd_question: "PRD",
  accept_prd_assumption: "PRD",
  defer_prd_question: "PRD",
  lock_prd_briefing: "PRD",
  approve_intake: "Intake",
  reject_intake: "Intake",
  approve_spec: "Spec",
  reject_spec: "Spec",
  approve_tech_spec: "TechSpec",
  reject_tech_spec: "TechSpec",
  approve_plan: "Plan",
  approve_merge: "Merge",
  reject_merge: "Merge",
  adopt_build: "Build",
  adopt_fix: "Fix",
  reject_build: "Build",
  waive_review_p1: "Review",
  fix_blockers: "Review",
  stop_change: "Review",
  enter_qa: "Review",
  retry_qa: "QA",
  record_qa_manual_check: "QA",
  override_merge: "Merge",
  request_rework: "Merge",
};

function rolloutPhaseForAction(
  externalActionId: string,
  canonicalActionId: string,
  canonicalPhase: string,
): CodexDecisionPhase {
  if (externalActionId in DESIGN_INTERACTION_PHASES) {
    return projectInteractionPhase(
      externalActionId as keyof typeof DESIGN_INTERACTION_PHASES,
    );
  }
  return ACTION_ROLLOUT_PHASE[canonicalActionId]
    ?? canonicalPhase as CodexDecisionPhase;
}

export type PipelineCommandHandler = (
  command: PipelineCommand,
  context: PipelineCommandCompletionContext,
) => PipelineCommandHandlerResult;

interface ReceiptRecord {
  commandId: string;
  requestHash: string;
  status: string;
  resultJson: string | null;
}

interface InteractionRecord {
  id: string;
  changeId: string;
  codexThreadId: string;
  phase: string;
  kind: string;
  gateVersion: number;
  sourceDbHash: string;
  payloadJson: string;
  status: string;
  expiresAt: string;
}

export interface PipelineCommandGatewayDependencies {
  repository: Pick<
    PipelineCommandRepository,
    "readReceiptByIdempotency" | "findChange" | "findInteraction"
  >;
  unitOfWork: Pick<PipelineCommandUnitOfWork, "claim" | "complete">;
  requireAction: (
    changeId: string,
    canonicalActionId: string,
  ) => PipelineActionContract;
  assertFreshAction: (
    command: PipelineCommand,
    canonicalActionId: string,
  ) => Promise<PipelineActionContract>;
  isDecisionSurfaceEnabled: (phase: CodexDecisionPhase) => boolean;
  handlers: ReadonlyMap<string, PipelineCommandHandler>;
  prepareBuildCommand?: (
    command: PipelineCommand,
    payload: Record<string, unknown>,
    context: PipelineCommandCompletionContext,
  ) => void;
  prepareReleaseCommand?: (
    command: PipelineCommand,
    canonicalActionId: string,
    payload: Record<string, unknown>,
    interaction: InteractionRecord | undefined,
  ) => void;
  now?: () => Date;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function canonicalPipelineCommandRequestHash(
  command: Omit<PipelineCommand, "requestHash"> | PipelineCommand,
  canonicalActionId = resolvePipelineCommandAction(command.actionId)
    .canonicalActionId,
): string {
  const { requestHash: _ignored, ...withoutRequestHash } =
    command as PipelineCommand;
  void _ignored;
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableValue({
          ...withoutRequestHash,
          externalActionId: command.actionId,
          canonicalActionId,
        }),
      ),
    )
    .digest("hex");
}

function requiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PipelineCommandError(
      "invalid_pipeline_command",
      `${field} is required`,
      422,
    );
  }
}

export function validatePipelineCommandShape(
  command: PipelineCommand,
): void {
  if (!command || typeof command !== "object") {
    throw new PipelineCommandError(
      "invalid_pipeline_command",
      "Command is required",
      422,
    );
  }
  for (const [field, value] of Object.entries({
    commandId: command.commandId,
    projectId: command.projectId,
    changeId: command.changeId,
    actionId: command.actionId,
    expectedGateVersion: command.expectedGateVersion,
    expectedSourceDbHash: command.expectedSourceDbHash,
    idempotencyKey: command.idempotencyKey,
    requestHash: command.requestHash,
  })) {
    requiredString(value, field);
  }
  if (
    command.expectedHeadSha !== null &&
    (typeof command.expectedHeadSha !== "string" ||
      command.expectedHeadSha.trim().length === 0)
  ) {
    throw new PipelineCommandError(
      "invalid_pipeline_command",
      "expectedHeadSha must be null or a non-empty string",
      422,
    );
  }
  if (
    !command.actor ||
    (command.actor.kind !== "human" && command.actor.kind !== "system") ||
    !command.payload ||
    typeof command.payload !== "object" ||
    Array.isArray(command.payload)
  ) {
    throw new PipelineCommandError(
      "invalid_pipeline_command",
      "actor and payload are invalid",
      422,
    );
  }
}

function duplicateResult(
  receipt: ReceiptRecord,
  requestHash: string,
): PipelineCommandResult {
  if (receipt.requestHash !== requestHash) {
    throw new PipelineCommandError(
      "idempotency_conflict",
      "Idempotency key is bound to another request",
    );
  }
  if (receipt.status !== "completed" || !receipt.resultJson) {
    throw new PipelineCommandError(
      "command_in_progress",
      "The original command has not completed",
      202,
    );
  }
  return JSON.parse(receipt.resultJson) as PipelineCommandResult;
}

function assertActorAllowed(
  command: PipelineCommand,
  canonicalActionId: string,
  rolloutPhase: CodexDecisionPhase | undefined,
  enabled: boolean,
): void {
  const forbidden = () => {
    throw new PipelineCommandError(
      "actor_surface_forbidden",
      "Actor surface cannot execute this command",
      403,
    );
  };
  const { actor } = command;
  if (actor.surface === "stagepass_web_ops") {
    if (
      actor.kind !== "system" ||
      (!OPERATIONAL_ACTIONS.has(canonicalActionId) &&
        !pipelineJobSelectionForAction(canonicalActionId)) ||
      HUMAN_DECISION_ACTIONS.has(canonicalActionId)
    ) {
      forbidden();
    }
    return;
  }
  if (actor.surface === "codex_mcp_app") {
    if (actor.kind !== "human" || !rolloutPhase || !enabled) forbidden();
    return;
  }
  if (actor.surface === "stagepass_web_emergency") {
    if (
      actor.kind !== "human"
      || (
        !HUMAN_DECISION_ACTIONS.has(canonicalActionId)
        && !PRD_INTERACTION_ACTIONS.has(canonicalActionId)
      )
    ) {
      forbidden();
    }
    return;
  }
  if (actor.surface === "recovery") {
    if (actor.kind !== "system") forbidden();
    return;
  }
  forbidden();
}

function interactionActionIds(interaction: InteractionRecord): string[] {
  try {
    const payload = JSON.parse(interaction.payloadJson) as {
      actionIds?: unknown;
    };
    return Array.isArray(payload.actionIds)
      ? payload.actionIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function assertInteractionBinding(
  command: PipelineCommand,
  canonicalActionId: string,
  interaction: InteractionRecord | undefined,
  now: Date,
): void {
  if (command.actor.surface !== "codex_mcp_app") return;
  if (!command.actor.interactionId || !command.actor.codexThreadId || !interaction) {
    throw new PipelineCommandError(
      "interaction_binding_invalid",
      "Codex decision requires its bound interaction and thread",
    );
  }
  if (
    interaction.id !== command.actor.interactionId ||
    interaction.changeId !== command.changeId ||
    interaction.codexThreadId !== command.actor.codexThreadId
  ) {
    throw new PipelineCommandError(
      "interaction_binding_invalid",
      "Interaction does not belong to this change and thread",
    );
  }
  if (
    interaction.status !== "presented" ||
    Date.parse(interaction.expiresAt) <= now.getTime()
  ) {
    throw new PipelineCommandError(
      "interaction_not_presented",
      "Interaction is expired or no longer presented",
    );
  }
  const actionIds = interactionActionIds(interaction);
  if (
    actionIds.length > 0 &&
    !actionIds.some(
      (actionId) =>
        resolvePipelineCommandAction(actionId).canonicalActionId ===
        canonicalActionId,
    )
  ) {
    throw new PipelineCommandError(
      "interaction_action_forbidden",
      "Action was not presented by this interaction",
    );
  }
}

function assertFreshness(
  command: PipelineCommand,
  action: PipelineActionContract,
  interaction: InteractionRecord | undefined,
  canonicalRequestHash: string,
): void {
  if (action.gateVersion !== command.expectedGateVersion) {
    throw new PipelineCommandError("gate_version_drift");
  }
  if (action.sourceDbHash !== command.expectedSourceDbHash) {
    throw new PipelineCommandError("source_db_hash_drift");
  }
  if (
    interaction &&
    (String(interaction.gateVersion) !== command.expectedGateVersion ||
      interaction.sourceDbHash !== command.expectedSourceDbHash)
  ) {
    throw new PipelineCommandError("interaction_freshness_drift");
  }
  if (command.requestHash !== canonicalRequestHash) {
    throw new PipelineCommandError("command_freshness_drift");
  }
}

export function createPipelineCommandGateway(
  dependencies: PipelineCommandGatewayDependencies,
) {
  return {
    async execute(
      command: PipelineCommand,
      authenticatedInteraction?: AuthenticatedInteractionClaim,
    ): Promise<PipelineCommandResult> {
      validatePipelineCommandShape(command);

      if (
        command.actor.surface === "codex_mcp_app"
        && (
          !authenticatedInteraction
          || authenticatedInteraction.sourceThreadId
            !== command.actor.codexThreadId
        )
      ) {
        throw new PipelineCommandError(
          "submit_auth_required",
          "Codex MCP commands require an authenticated interaction claim",
          401,
        );
      }

      const duplicate = dependencies.repository.readReceiptByIdempotency(
        command.changeId,
        command.idempotencyKey,
      ) as ReceiptRecord | undefined;
      if (duplicate) {
        if (authenticatedInteraction) {
          throw new PipelineCommandError(
            "invocation_nonce_consumed",
            "Interaction nonce has already been consumed",
          );
        }
        return duplicateResult(duplicate, command.requestHash);
      }

      const actionIdentity = resolvePipelineCommandAction(command.actionId);
      let action: PipelineActionContract;
      try {
        action = dependencies.requireAction(
          command.changeId,
          actionIdentity.canonicalActionId,
        );
      } catch (error) {
        throw new PipelineCommandError(
          "unknown_action",
          error instanceof Error ? error.message : "Unknown action",
          422,
        );
      }

      const rolloutPhase = rolloutPhaseForAction(
        command.actionId,
        actionIdentity.canonicalActionId,
        action.phase,
      );
      const prdPayload = parsePrdInteractionPayload(
        actionIdentity.canonicalActionId,
        command.payload,
      );
      const normalizedPayload = parseDesignDecisionPayload(
        command.actionId,
        prdPayload,
      );
      const buildPayload = parseBuildDecisionPayload(
        actionIdentity.canonicalActionId,
        normalizedPayload,
      );
      const releasePayload = parseReleaseDecisionPayload(
        isReleaseDecisionActionId(command.actionId)
          ? command.actionId
          : actionIdentity.canonicalActionId,
        buildPayload,
      );
      const decisionSurfaceEnabled =
        dependencies.isDecisionSurfaceEnabled(rolloutPhase);
      assertActorAllowed(
        command,
        actionIdentity.canonicalActionId,
        rolloutPhase,
        decisionSurfaceEnabled,
      );

      const change = dependencies.repository.findChange(command.changeId);
      if (!change || change.projectId !== command.projectId) {
        throw new PipelineCommandError("command_scope_mismatch");
      }
      const interaction = command.actor.interactionId
        ? (dependencies.repository.findInteraction(
            command.actor.interactionId,
          ) as InteractionRecord | undefined)
        : undefined;
      assertInteractionBinding(
        command,
        actionIdentity.canonicalActionId,
        interaction,
        dependencies.now?.() ?? new Date(),
      );

      const canonicalRequestHash = canonicalPipelineCommandRequestHash(
        command,
        actionIdentity.canonicalActionId,
      );
      assertFreshness(
        command,
        action,
        interaction,
        canonicalRequestHash,
      );
      let freshAction: PipelineActionContract;
      try {
        freshAction = await dependencies.assertFreshAction(
          command,
          actionIdentity.canonicalActionId,
        );
      } catch (error) {
        const reasonCode =
          error &&
          typeof error === "object" &&
          "envelope" in error &&
          error.envelope &&
          typeof error.envelope === "object" &&
          "reasonCode" in error.envelope
            ? error.envelope.reasonCode
            : null;
        if (reasonCode === "gate_version_drift") {
          throw new PipelineCommandError("gate_version_drift");
        }
        if (reasonCode === "source_db_hash_drift") {
          throw new PipelineCommandError("source_db_hash_drift");
        }
        if (
          reasonCode === "git_head_drift" ||
          reasonCode === "git_head_unavailable"
        ) {
          throw new PipelineCommandError("command_freshness_drift");
        }
        throw error;
      }
      assertFreshness(
        command,
        freshAction,
        interaction,
        canonicalRequestHash,
      );
      dependencies.prepareReleaseCommand?.(
        command,
        actionIdentity.canonicalActionId,
        releasePayload,
        interaction,
      );

      const handler = dependencies.handlers.get(
        actionIdentity.canonicalActionId,
      );
      if (!handler) {
        throw new PipelineCommandError(
          "command_handler_missing",
          `No command handler registered for ${actionIdentity.canonicalActionId}`,
          422,
        );
      }

      dependencies.unitOfWork.claim(
        command,
        actionIdentity.canonicalActionId,
        canonicalRequestHash,
        authenticatedInteraction,
      );
      return dependencies.unitOfWork.complete(command, {
        canonicalActionId: actionIdentity.canonicalActionId,
        phase: rolloutPhase,
        gateVersion: freshAction.gateVersion,
        sourceDbHash: freshAction.sourceDbHash,
        sourceHeadSha: command.expectedHeadSha,
        humanDecision: HUMAN_DECISION_ACTIONS.has(
          actionIdentity.canonicalActionId,
        ),
        mutate: (context) => {
          const normalizedCommand = { ...command, payload: releasePayload };
          if (isBuildDecisionActionId(actionIdentity.canonicalActionId)) {
            dependencies.prepareBuildCommand?.(
              normalizedCommand,
              releasePayload,
              context,
            );
          }
          return handler(normalizedCommand, context);
        },
      });
    },
  };
}

function gateHandler(gate: GateName, approve: boolean): PipelineCommandHandler {
  return (command, { tx, decisionId }) => {
    if (approve) {
      approveGateWithDb(tx, {
        changeId: command.changeId,
        gate,
        decisionId,
      });
    } else {
      rejectGateWithDb(tx, {
        changeId: command.changeId,
        gate,
        reason:
          typeof command.payload.reason === "string"
            ? command.payload.reason
            : undefined,
      });
    }
    const change = tx
      .select()
      .from(changes)
      .where(eq(changes.id, command.changeId))
      .get();
    if (!change) throw new Error(`Change not found: ${command.changeId}`);
    return { changeStatus: change.status };
  };
}

function prdQuestionHandler(
  action: "answer" | "accept_assumption" | "defer",
): PipelineCommandHandler {
  return (command, { tx }) => {
    const questionId = String(command.payload.questionId);
    const updated = applyBriefingQuestionCommandWithDb(tx, {
      changeId: command.changeId,
      questionId,
      command:
        action === "answer"
          ? { action, answer: String(command.payload.answer) }
          : action === "defer"
            ? { action, reason: String(command.payload.reason) }
            : { action },
    });
    tx.insert(events).values({
      id: `EVT-prd-question-${command.commandId}`,
      changeId: command.changeId,
      runId: null,
      type: "prd_question_updated",
      message: `PRD question ${updated.id} ${updated.status}`,
      rawJson: JSON.stringify({
        commandId: command.commandId,
        questionId: updated.id,
        status: updated.status,
      }),
      createdAt: new Date().toISOString(),
    }).run();
    const change = tx.select().from(changes)
      .where(eq(changes.id, command.changeId)).get();
    if (!change) throw new Error(`Change not found: ${command.changeId}`);
    return { changeStatus: change.status, humanDecisionId: null };
  };
}

const lockPrdBriefingHandler: PipelineCommandHandler = (
  command,
  { tx, decisionId },
) => {
  if (!decisionId) throw new Error("lock_prd_briefing requires a decision");
  const briefing = tx.select().from(prdBriefings)
    .where(eq(prdBriefings.changeId, command.changeId)).get();
  if (!briefing || briefing.id !== command.payload.briefingId) {
    throw new PipelineCommandError(
      "briefing_identity_mismatch",
      "PRD briefing identity changed",
    );
  }
  if (briefing.status === "locked") {
    throw new PipelineCommandError("prd_briefing_locked");
  }
  assertPrdBriefingLockReady(
    getPrdBriefingState(command.changeId),
    command.changeId,
  );
  const now = new Date().toISOString();
  tx.update(prdBriefings).set({
    status: "locked",
    lockedAt: now,
    updatedAt: now,
  }).where(eq(prdBriefings.id, briefing.id)).run();
  const change = transitionChangeStatusWithDb(tx, {
    changeId: command.changeId,
    to: "INTAKE_READY",
    gateState: "intake",
    message: "PRD briefing locked",
    rawJson: {
      source: "pipeline_command",
      commandId: command.commandId,
      decisionId,
    },
  });
  return { changeStatus: change.status, humanDecisionId: decisionId };
};

function completedDesignChange(
  command: PipelineCommand,
  context: PipelineCommandCompletionContext,
): PipelineCommandHandlerResult {
  const change = context.tx.select().from(changes)
    .where(eq(changes.id, command.changeId)).get();
  if (!change) throw new Error(`Change not found: ${command.changeId}`);
  return {
    changeStatus: change.status,
    humanDecisionId: context.decisionId,
  };
}

function completedReleaseChange(
  command: PipelineCommand,
  context: PipelineCommandCompletionContext,
  eventType: string,
  raw: Record<string, unknown>,
): PipelineCommandHandlerResult {
  context.tx.insert(events).values({
    id: `EVT-${eventType}-${command.commandId}`,
    changeId: command.changeId,
    runId: null,
    type: eventType,
    message: `${command.actionId} accepted`,
    rawJson: JSON.stringify({
      commandId: command.commandId,
      decisionId: context.decisionId,
      ...raw,
    }),
    createdAt: new Date().toISOString(),
  }).run();
  const change = context.tx.select().from(changes)
    .where(eq(changes.id, command.changeId)).get();
  if (!change) throw new Error(`Change not found: ${command.changeId}`);
  return {
    changeStatus: change.status,
    humanDecisionId: context.decisionId,
  };
}

const waiveReviewP1Handler: PipelineCommandHandler = (command, context) => {
  if (!context.decisionId) {
    throw new Error("waive_review_p1 requires a decision");
  }
  const findingId = String(command.payload.findingId);
  const finding = context.tx.select().from(findings)
    .where(eq(findings.id, findingId)).get();
  const state = context.tx.select().from(reviewState)
    .where(eq(reviewState.changeId, command.changeId)).get();
  const report = state?.latestValidReviewReportId
    ? context.tx.select().from(reviewReports)
        .where(eq(reviewReports.id, state.latestValidReviewReportId)).get()
    : null;
  if (
    !finding
    || finding.changeId !== command.changeId
    || finding.source !== "review"
    || finding.status !== "open"
    || finding.severity !== "P1"
    || !report
  ) throw new PipelineCommandError("review_finding_drift");
  const now = new Date().toISOString();
  context.tx.update(findings).set({
    status: "waived",
    waivedBy: "human",
    waivedAt: now,
    waiverDecisionId: context.decisionId,
    findingVersion: finding.findingVersion + 1,
    updatedAt: now,
  }).where(eq(findings.id, finding.id)).run();
  context.tx.update(reviewReports).set({
    gateStatus: "stale",
    qaAllowed: 0,
  }).where(eq(reviewReports.id, report.id)).run();
  return completedReleaseChange(command, context, "finding_waived", {
    findingId,
    reason: command.payload.reason,
    reportId: report.id,
  });
};

const recordQaManualCheckHandler: PipelineCommandHandler = (
  command,
  context,
) => completedReleaseChange(command, context, "qa_manual_check_recorded", {
  qaRunId: command.payload.qaRunId,
  checkId: command.payload.checkId,
  outcome: command.payload.outcome,
  evidenceIds: command.payload.evidenceIds,
  notes: command.payload.notes,
});

const stopChangeHandler: PipelineCommandHandler = (command, context) =>
  completedReleaseChange(command, context, "change_stop_requested", {
    reason: command.payload.reason,
  });

const requestReworkHandler: PipelineCommandHandler = (command, context) => {
  const result = completedReleaseChange(command, context, "change_rework_requested", {
    phase: command.payload.phase,
    reason: command.payload.reason,
  });
  return {
    ...result,
    outboxEffects: [{
      effectType: "change_rework",
      payload: {
        projectId: command.projectId,
        changeId: command.changeId,
        phase: command.payload.phase,
      },
    }],
  };
};

const requestSpecChangesHandler: PipelineCommandHandler = (
  command,
  context,
) => {
  if (!context.decisionId) {
    throw new Error("request_spec_changes requires a decision");
  }
  const isFact = command.actionId === "supply_spec_fact";
  applySpecBattleDecisionWithDb(context.tx, {
    changeId: command.changeId,
    action: "request_changes",
    decisionId: context.decisionId,
    targetId: isFact ? null : String(command.payload.gapId),
    reason: isFact
      ? String(command.payload.fact)
      : String(command.payload.reason),
  });
  return completedDesignChange(command, context);
};

const returnToSpecHandler: PipelineCommandHandler = (command, context) => {
  if (!context.decisionId) throw new Error("return_to_spec requires a decision");
  applySpecBattleDecisionWithDb(context.tx, {
    changeId: command.changeId,
    action: "return_to_spec",
    decisionId: context.decisionId,
    reason: String(command.payload.reason),
  });
  return completedDesignChange(command, context);
};

const waiveSpecP1Handler: PipelineCommandHandler = (command, context) => {
  if (!context.decisionId) throw new Error("waive_spec_p1 requires a decision");
  applySpecBattleDecisionWithDb(context.tx, {
    changeId: command.changeId,
    action: "waive_p1",
    decisionId: context.decisionId,
    targetId: String(command.payload.gapId),
    reason: String(command.payload.reason),
  });
  return completedDesignChange(command, context);
};

const waivePlanP1Handler: PipelineCommandHandler = (command, context) => {
  if (!context.decisionId) throw new Error("waive_plan_p1 requires a decision");
  waivePlanP1WithDb(context.tx, {
    changeId: command.changeId,
    riskId: String(command.payload.riskId),
    reason: String(command.payload.reason),
  });
  return completedDesignChange(command, context);
};

const rejectPlanHandler: PipelineCommandHandler = (command, context) => {
  if (!context.decisionId) throw new Error("reject_plan requires a decision");
  rejectPlanSnapshotWithDb(context.tx, {
    changeId: command.changeId,
    reason: String(command.payload.reason),
  });
  return completedDesignChange(command, context);
};

const rejectTestPlanHandler: PipelineCommandHandler = (command, context) => {
  if (!context.decisionId) {
    throw new Error("reject_test_plan requires a decision");
  }
  rejectTestPlanWithDb(context.tx, {
    changeId: command.changeId,
    reason: String(command.payload.reason),
  });
  return completedDesignChange(command, context);
};

function buildDecisionHandler(
  actionId: BuildDecisionActionId,
): PipelineCommandHandler {
  return (command, { tx, decisionId }) => {
    if (!decisionId) {
      throw new Error(`${actionId} requires a human decision`);
    }
    const change = tx.select().from(changes)
      .where(eq(changes.id, command.changeId)).get();
    if (!change) throw new Error(`Change not found: ${command.changeId}`);
    const project = tx.select().from(projects)
      .where(eq(projects.id, command.projectId)).get();
    if (!project) throw new Error(`Project not found: ${command.projectId}`);

    if (actionId === "reject_build") {
      rejectLatestBuildRun({
        repoPath: project.repoPath,
        changeId: command.changeId,
      });
      tx.update(changes).set({
        status: "PLAN_APPROVED",
        updatedAt: new Date().toISOString(),
      }).where(eq(changes.id, command.changeId)).run();
      return {
        changeStatus: "PLAN_APPROVED",
        humanDecisionId: decisionId,
      };
    }

    const approved = approveBuildForAbsorb({
      repoPath: project.repoPath,
      changeId: command.changeId,
    });
    const commitBranch = resolveAdoptionCommitBranch({
      changeId: command.changeId,
      gitEnabled: Boolean(project.gitEnabled),
      repoPath: project.repoPath,
      gitBranch: change.gitBranch ?? null,
    });
    const commit = { enabled: commitBranch !== null };
    const adopted = approved.status === "adopted"
      ? approved
      : actionId === "adopt_fix"
        ? adoptFixPatch({
            repoPath: project.repoPath,
            changeId: command.changeId,
            commit,
            adoptionDecisionId: decisionId,
          })
        : absorbBuildPatch({
            repoPath: project.repoPath,
            changeId: command.changeId,
            commit,
            adoptionDecisionId: decisionId,
          });
    if (
      adopted.status !== "adopted"
      || adopted.adoptionDecisionId !== decisionId
    ) {
      throw new PipelineCommandError("build_adoption_incomplete");
    }
    tx.update(changes).set({
      status: "IMPLEMENTED",
      updatedAt: new Date().toISOString(),
    }).where(eq(changes.id, command.changeId)).run();
    return {
      changeStatus: "IMPLEMENTED",
      humanDecisionId: decisionId,
    };
  };
}

export const FIRST_SLICE_PIPELINE_COMMAND_HANDLERS =
  new Map<string, PipelineCommandHandler>([
    ["answer_prd_question", prdQuestionHandler("answer")],
    ["accept_prd_assumption", prdQuestionHandler("accept_assumption")],
    ["defer_prd_question", prdQuestionHandler("defer")],
    ["lock_prd_briefing", lockPrdBriefingHandler],
    ["approve_intake", gateHandler("intake", true)],
    ["reject_intake", gateHandler("intake", false)],
    [
      "approve_spec",
      (command, { tx, decisionId }) => {
        if (!decisionId) throw new Error("approve_spec requires a decision");
        applySpecBattleDecisionWithDb(tx, {
          changeId: command.changeId,
          action: "approve",
          decisionId,
        });
        const change = tx
          .select()
          .from(changes)
          .where(eq(changes.id, command.changeId))
          .get();
        if (!change) throw new Error(`Change not found: ${command.changeId}`);
        return { changeStatus: change.status, humanDecisionId: decisionId };
      },
    ],
    ["reject_spec", gateHandler("spec", false)],
    ["approve_tech_spec", gateHandler("tech_spec", true)],
    ["reject_tech_spec", gateHandler("tech_spec", false)],
    ["request_spec_changes", requestSpecChangesHandler],
    ["return_to_spec", returnToSpecHandler],
    ["waive_spec_p1", waiveSpecP1Handler],
    ["waive_plan_p1", waivePlanP1Handler],
    ["reject_plan", rejectPlanHandler],
    ["reject_test_plan", rejectTestPlanHandler],
    ["adopt_build", buildDecisionHandler("adopt_build")],
    ["adopt_fix", buildDecisionHandler("adopt_fix")],
    ["reject_build", buildDecisionHandler("reject_build")],
    ["waive_review_p1", waiveReviewP1Handler],
    ["stop_change", stopChangeHandler],
    ["record_qa_manual_check", recordQaManualCheckHandler],
    ["override_merge", gateHandler("merge", true)],
    ["request_rework", requestReworkHandler],
    [
      "approve_plan",
      (command, { tx, decisionId }) => {
        if (!decisionId) throw new Error("approve_plan requires a decision");
        if (command.actionId === "approve_test_plan") {
          confirmTestPlanWithDb(tx, {
            changeId: command.changeId,
            confirmation: true,
            decisionId,
          });
        } else {
          approvePlanSnapshotWithDb(tx, {
            changeId: command.changeId,
            decisionId,
          });
        }
        const change = tx
          .select()
          .from(changes)
          .where(eq(changes.id, command.changeId))
          .get();
        if (!change) throw new Error(`Change not found: ${command.changeId}`);
        return { changeStatus: change.status, humanDecisionId: decisionId };
      },
    ],
    ["approve_merge", gateHandler("merge", true)],
    ["reject_merge", gateHandler("merge", false)],
  ]);

const OPERATIONAL_PIPELINE_COMMAND_HANDLERS = new Map<
  string,
  PipelineCommandHandler
>();
for (const actionId of [
  "run_prd",
  "retry_prd",
  "run_spec",
  "retry_spec",
  "run_tech_spec",
  "retry_tech_spec",
  "run_plan",
  "retry_plan",
  "run_test_plan",
  "retry_test_plan",
  "run_build",
  "retry_build",
  "run_review",
  "retry_review",
  "enter_qa",
  "run_qa",
  "retry_qa",
  "fix_blockers",
  "merge",
  "run_retro",
  "run_delivery",
]) {
  OPERATIONAL_PIPELINE_COMMAND_HANDLERS.set(
    actionId,
    (command, { tx }) => {
      const change = tx
        .select()
        .from(changes)
        .where(eq(changes.id, command.changeId))
        .get();
      if (!change) throw new Error(`Change not found: ${command.changeId}`);
      return { changeStatus: change.status };
    },
  );
}

const DEFAULT_PIPELINE_COMMAND_HANDLERS = new Map([
  ...FIRST_SLICE_PIPELINE_COMMAND_HANDLERS,
  ...OPERATIONAL_PIPELINE_COMMAND_HANDLERS,
]);

const defaultRepository = createPipelineCommandRepository(db);
const defaultUnitOfWork = new PipelineCommandUnitOfWork(db);

function prepareDefaultBuildCommand(
  command: PipelineCommand,
  payload: Record<string, unknown>,
  context: PipelineCommandCompletionContext,
): void {
  const project = context.tx.select().from(projects)
    .where(eq(projects.id, command.projectId)).get();
  if (!project) throw new PipelineCommandError("command_scope_mismatch");
  try {
    assertBuildAdoptionIdentity(
      project.repoPath,
      command.changeId,
      {
        buildRunId: String(payload.buildRunId),
        patchHash: String(payload.patchHash),
        changedFilesHash: String(payload.changedFilesHash),
        expectedHeadSha: command.expectedHeadSha,
      },
    );
  } catch (error) {
    if (
      error instanceof Error
      && /build_identity_drift|build_hash_drift|fix_hash_drift/i.test(
        error.message,
      )
    ) {
      throw new PipelineCommandError("build_identity_drift");
    }
    throw error;
  }
}

function interactionPayload(
  interaction: InteractionRecord | undefined,
): Record<string, unknown> {
  if (!interaction) return {};
  try {
    const parsed = JSON.parse(interaction.payloadJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw new PipelineCommandError("interaction_payload_invalid");
  }
}

export function prepareDefaultReleaseCommand(
  command: PipelineCommand,
  canonicalActionId: string,
  payload: Record<string, unknown>,
  interaction: InteractionRecord | undefined,
): void {
  if (
    !isReleaseDecisionActionId(command.actionId)
    && !isReleaseDecisionActionId(canonicalActionId)
  ) return;
  const projected = interactionPayload(interaction);
  if (canonicalActionId === "waive_review_p1") {
    const finding = db.select().from(findings)
      .where(eq(findings.id, String(payload.findingId))).get();
    const state = db.select().from(reviewState)
      .where(eq(reviewState.changeId, command.changeId)).get();
    const report = state?.latestValidReviewReportId
      ? db.select().from(reviewReports)
          .where(eq(reviewReports.id, state.latestValidReviewReportId)).get()
      : null;
    if (
      !finding
      || finding.changeId !== command.changeId
      || finding.source !== "review"
      || finding.status !== "open"
      || finding.severity !== "P1"
      || !report
      || report.id !== projected.reportId
      || report.reportDbHash !== projected.reportHash
    ) {
      throw new PipelineCommandError("review_finding_drift");
    }
    return;
  }
  if (
    canonicalActionId === "retry_qa"
    || canonicalActionId === "record_qa_manual_check"
    || command.actionId === "request_qa_fix"
  ) {
    const run = db.select().from(qaRuns)
      .where(eq(qaRuns.id, String(payload.qaRunId))).get();
    if (
      !run
      || run.changeId !== command.changeId
      || run.id !== projected.qaRunId
      || run.sourceHeadSha !== projected.sourceHeadSha
    ) throw new PipelineCommandError("qa_run_drift");
    return;
  }
  if (
    ["approve_merge", "reject_merge", "override_merge", "request_rework"]
      .includes(canonicalActionId)
  ) {
    const readiness = computeMergeReadiness({
      changeId: command.changeId,
      requireApproval: false,
      persist: true,
    });
    if (
      readiness.id !== projected.readinessId
      || readiness.sourceDbHash !== projected.readinessHash
      || readiness.sourceHeadSha !== projected.sourceHeadSha
    ) throw new PipelineCommandError("merge_readiness_drift");
  }
}

export const pipelineCommandGateway = createPipelineCommandGateway({
  repository: defaultRepository,
  unitOfWork: defaultUnitOfWork,
  requireAction: requireCurrentActionContract,
  assertFreshAction: (command, canonicalActionId) =>
    assertActionAllowedAsync({
      changeId: command.changeId,
      actionId: canonicalActionId,
      expectedGateVersion: command.expectedGateVersion,
      expectedSourceDbHash: command.expectedSourceDbHash,
      expectedHeadSha: command.expectedHeadSha ?? undefined,
      idempotencyKey: command.idempotencyKey,
    }),
  isDecisionSurfaceEnabled: (phase) =>
    isCodexDecisionSurfaceEnabled(phase, readCodexNativeFlags()),
  handlers: DEFAULT_PIPELINE_COMMAND_HANDLERS,
  prepareBuildCommand: prepareDefaultBuildCommand,
  prepareReleaseCommand: prepareDefaultReleaseCommand,
});

export function executePipelineCommand(
  command: PipelineCommand,
  authenticatedInteraction?: AuthenticatedInteractionClaim,
): Promise<PipelineCommandResult> {
  return pipelineCommandGateway.execute(command, authenticatedInteraction);
}
