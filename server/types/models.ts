import { z } from "zod";
import {
  AiProvider,
  ChangeStatus,
  PrdStatus,
  RunPhase,
  RunStatus,
  EventType,
  FindingSeverity,
  FindingSource,
  FindingStatus,
  ArtifactType,
  BattleRoundStatus,
  BattleTemplate,
  HumanDecisionAction,
  ActorSurface,
  CodexBindingStatus,
  CodexInteractionStatus,
  DispatchSurfaceSchema,
  CodexLogicalRoleSchema,
  PipelineCommandReceiptStatus,
  PipelineJobEffectPayload,
  RequirementGapStatus,
  WarReportStatus,
} from "./enums";

export const ContextStatus = z.enum(["pending", "generating", "ready", "failed"]);
export type ContextStatus = z.infer<typeof ContextStatus>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  repoPath: z.string().min(1),
  contextStatus: ContextStatus.default("pending"),
  contextProvider: AiProvider.default("codex"),
  prdStatus: PrdStatus.default("none"),
  prdProvider: AiProvider.default("codex"),
  prdJson: z.string().nullable().optional(),
  prdMarkdown: z.string().nullable().optional(),
  gitEnabled: z.number().int().default(0),
  gitDefaultBranch: z.string().nullable().optional(),
  defaultCodexModel: z.string().nullable().optional(),
  defaultReasoningEffort: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ChangeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string().min(1),
  status: ChangeStatus,
  provider: AiProvider,
  codexThreadId: z.string().nullable(),
  codexModel: z.string().nullable().optional(),
  reasoningEffort: z.string().nullable().optional(),
  fixIterations: z.number().int().min(0),
  blockedPhase: RunPhase.nullable().optional(),
  reworkFromPhase: RunPhase.nullable().optional(),
  suspendedByPrd: z.number().int().default(0),
  preSuspendStatus: ChangeStatus.nullable().optional(),
  gitBranch: z.string().nullable().optional(),
  gateState: z.string().nullable().optional(),
  docsComplete: z.number().int().default(0).optional(),
  retroDone: z.number().int().default(0).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Change = z.infer<typeof ChangeSchema>;

export const RunSchema = z.object({
  id: z.string(),
  changeId: z.string(),
  phase: RunPhase,
  status: RunStatus,
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  summary: z.string().nullable(),
});
export type Run = z.infer<typeof RunSchema>;

export const EventSchema = z.object({
  id: z.string(),
  changeId: z.string(),
  runId: z.string().nullable(),
  type: EventType,
  message: z.string().nullable(),
  rawJson: z.string().nullable(),
  createdAt: z.string(),
});
export type Event = z.infer<typeof EventSchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  changeId: z.string(),
  runId: z.string().nullable(),
  type: ArtifactType,
  path: z.string(),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  changeId: z.string(),
  runId: z.string().nullable(),
  roundId: z.string().nullable().optional(),
  phase: z.string().nullable().optional(),
  source: FindingSource,
  severity: FindingSeverity,
  category: z.string(),
  title: z.string(),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  evidence: z.string().nullable(),
  requiredFix: z.string().nullable(),
  status: FindingStatus,
  createdAt: z.string(),
  updatedAt: z.string().nullable().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const BattleRoundSchema = z.object({
  id: z.string(),
  changeId: z.string(),
  phase: z.literal("Spec"),
  template: BattleTemplate,
  roundNo: z.number().int().min(1),
  status: BattleRoundStatus,
  redUnit: z.literal("SPEC_WRITER"),
  blueUnit: z.literal("REQUIREMENT_CRITIC"),
  inputSnapshotJson: z.string(),
  paramsJson: z.string(),
  redArtifactPath: z.string().nullable(),
  redArtifactHash: z.string().nullable(),
  blueArtifactPath: z.string().nullable(),
  blueArtifactHash: z.string().nullable(),
  reportPath: z.string().nullable(),
  supersededByRoundId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BattleRound = z.infer<typeof BattleRoundSchema>;

export const RequirementGapSchema = z.object({
  id: z.string(),
  changeId: z.string(),
  canonicalGapId: z.string(),
  firstSeenRoundId: z.string(),
  lastEvaluatedRoundId: z.string(),
  resolvedByRoundId: z.string().nullable(),
  /**
   * Which phase's critic raised this gap.
   *
   * Was `z.literal("Spec")` while Spec was the only phase with a critic. The
   * delegated round gives TechSpec, Plan and TestPlan one each, and every reader
   * that decides something about a SINGLE phase now scopes on this column --
   * see battle-round-phase-scope.ts. Readers that legitimately span phases
   * (merge readiness, the delivery note's known limits) still do not.
   */
  sourcePhase: z.enum(["Spec", "TechSpec", "Plan", "TestPlan"]),
  /**
   * A plain string rather than an enum, because the writers do not share one
   * closed vocabulary: each phase's critic writes its own codename
   * (`REQUIREMENT_CRITIC`, `TECH_SPEC_CRITIC`, ...), a human writes
   * `HUMAN_COMMANDER`, and rubric-gate-adapters writes `RUBRIC_<ROLE>` computed
   * from the role. The enum here already excluded that last group, so it was
   * describing rows the database does not actually contain.
   */
  sourceUnit: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  evidence: z.string().min(1),
  affectedArtifactsJson: z.string(),
  proposedSpecPatch: z.string().nullable(),
  severity: FindingSeverity,
  originalSeverity: FindingSeverity,
  downgradedTo: z.enum(["P1", "P2"]).nullable(),
  status: RequirementGapStatus,
  resolutionEvidence: z.string().nullable(),
  waiverReason: z.string().nullable(),
  downgradeReason: z.string().nullable(),
  overrideReason: z.string().nullable(),
  specBlocking: z.number().int(),
  mergeBlocking: z.number().int(),
  sourceHashesJson: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
});
export type RequirementGap = z.infer<typeof RequirementGapSchema>;

export const HumanDecisionSchema = z.object({
  id: z.string(),
  changeId: z.string(),
  roundId: z.string().nullable(),
  gate: z.enum(["spec", "merge"]),
  action: HumanDecisionAction,
  targetType: z.enum(["gate", "requirement_gap", "finding"]).nullable(),
  targetId: z.string().nullable(),
  reason: z.string().nullable(),
  reportHash: z.string().nullable(),
  createdBy: z.literal("human"),
  interactionId: z.string().nullable().optional(),
  actorSurface: ActorSurface.nullable().optional(),
  codexThreadId: z.string().nullable().optional(),
  commandId: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type HumanDecision = z.infer<typeof HumanDecisionSchema>;

export const CodexBindingScopeSchema = z.discriminatedUnion("scopeKind", [
  z.object({
    scopeKind: z.literal("change"),
    scopeId: z.string(),
    projectId: z.string(),
    changeId: z.string(),
  }),
  z.object({
    scopeKind: z.enum(["project_prd", "project_context"]),
    scopeId: z.string(),
    projectId: z.string(),
    changeId: z.null(),
  }),
]);
export type CodexBindingScope = z.infer<typeof CodexBindingScopeSchema>;

export const CodexThreadBindingSchema = z.object({
  bindingId: z.string(),
  codexProjectId: z.string().nullable(),
  threadId: z.string().nullable(),
  title: z.string(),
  status: CodexBindingStatus,
  bridgeProtocolVersion: z.string(),
  provisionClaimToken: z.string().nullable(),
  provisionLeaseOwner: z.string().nullable(),
  provisionLeaseExpiresAt: z.string().nullable(),
  followerStartProvedAt: z.string().nullable(),
  lastTurnId: z.string().nullable(),
  lastObservationCursor: z.number().int().min(0),
  lastSemanticSnapshotHash: z.string().nullable(),
  lastSeenAt: z.string(),
  lastErrorCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).and(CodexBindingScopeSchema);
export type CodexThreadBinding = z.infer<typeof CodexThreadBindingSchema>;

export const CodexLogicalTurnOwnerSchema = z.union([
  z.object({ pipelineJobId: z.string(), projectAiRunId: z.null() }),
  z.object({ pipelineJobId: z.null(), projectAiRunId: z.string() }),
]);
export type CodexLogicalTurnOwner = z.infer<typeof CodexLogicalTurnOwnerSchema>;

export const CodexLogicalTurnSchema = z.object({
  logicalTurnId: z.string().uuid(),
  bindingId: z.string(),
  interactionId: z.string().nullable(),
  commandId: z.string().nullable(),
  phase: z.string(),
  role: CodexLogicalRoleSchema,
  round: z.number().int().min(0),
  ordinal: z.number().int().min(0),
  turnSlot: z.string(),
  runCorrelationId: z.string(),
  canonicalRequestJson: z.string(),
  canonicalRequestHash: z.string(),
  dispatchSurface: DispatchSurfaceSchema,
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).and(CodexLogicalTurnOwnerSchema);
export type CodexLogicalTurn = z.infer<typeof CodexLogicalTurnSchema>;

export const CodexFollowerStartAttemptSchema = z.object({
  attemptId: z.string(),
  logicalTurnId: z.string().uuid(),
  runCorrelationId: z.string(),
  workerId: z.string(),
  leaseToken: z.string(),
  ownerAttempt: z.number().int().min(0),
  ownerEpoch: z.number().int().min(0),
  threadId: z.string(),
  purpose: z.string(),
  dispatchSurface: DispatchSurfaceSchema,
  normalizedPromptHash: z.string(),
  correlationMarker: z.string(),
  cwd: z.string(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  sandboxMode: z.string(),
  approvalPolicy: z.string(),
  preStartTurnIdsJson: z.string(),
  preStartSemanticHash: z.string(),
  state: z.enum([
    "prepared",
    "dispatching",
    "no_client_found",
    "ambiguous",
    "succeeded",
    "quarantined",
  ]),
  dispatchOrdinal: z.number().int().min(0),
  dispatchCount: z.number().int().min(0),
  budgetDeadline: z.string(),
  followerTurnId: z.string().nullable(),
  recoveryOwnerId: z.string().nullable(),
  recoveryLeaseToken: z.string().nullable(),
  recoveryEpoch: z.number().int().min(0),
  lastResult: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  preparedAt: z.string(),
  dispatchedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
}).and(CodexLogicalTurnOwnerSchema);
export type CodexFollowerStartAttempt = z.infer<typeof CodexFollowerStartAttemptSchema>;

export const CodexTurnExecutionSchema = z.object({
  id: z.string(),
  startAttemptId: z.string(),
  logicalTurnId: z.string().uuid(),
  threadId: z.string(),
  turnId: z.string(),
  dispatchSurface: DispatchSurfaceSchema,
  leaseToken: z.string(),
  ownerAttempt: z.number().int().min(0),
  ownerEpoch: z.number().int().min(0),
  lastObservationCursor: z.number().int().min(0),
  normalizedItemsJson: z.string(),
  lastSemanticSnapshotHash: z.string().nullable(),
  status: z.string(),
  lastObservedAt: z.string().nullable(),
  terminalSemanticHash: z.string().nullable(),
  reconnectCount: z.number().int().min(0),
  notYetVisibleCount: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
}).and(CodexLogicalTurnOwnerSchema);
export type CodexTurnExecution = z.infer<typeof CodexTurnExecutionSchema>;

export const CodexInteractionSchema = z.object({
  id: z.string(),
  changeId: z.string(),
  bindingId: z.string(),
  codexThreadId: z.string(),
  phase: z.string(),
  kind: z.string(),
  gateVersion: z.number().int(),
  sourceDbHash: z.string(),
  payloadJson: z.string(),
  formJson: z.string().nullable(),
  status: CodexInteractionStatus,
  idempotencyKey: z.string(),
  invocationNonceHash: z.string().nullable(),
  sourceThreadId: z.string().nullable(),
  nonceExpiresAt: z.string().nullable(),
  nonceConsumedAt: z.string().nullable(),
  expectedHeadSha: z.string().nullable(),
  requestHash: z.string(),
  supersededById: z.string().nullable(),
  presentedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  expiresAt: z.string(),
  supersededAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CodexInteraction = z.infer<typeof CodexInteractionSchema>;

export const PipelineCommandReceiptSchema = z.object({
  commandId: z.string(),
  changeId: z.string(),
  interactionId: z.string().nullable(),
  codexThreadId: z.string().nullable(),
  action: z.string(),
  actorKind: z.string(),
  actorSurface: ActorSurface,
  idempotencyKey: z.string(),
  requestHash: z.string(),
  status: PipelineCommandReceiptStatus,
  resultJson: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type PipelineCommandReceipt = z.infer<typeof PipelineCommandReceiptSchema>;

export interface ProjectAiRunLeaseLike {
  readonly status: string;
  readonly workerId?: string | null;
  readonly leaseToken?: string | null;
  readonly leaseExpiresAt?: string | null;
  readonly deadlineAt: string;
}

export function isLiveProjectAiRunLease(
  run: ProjectAiRunLeaseLike,
  now: string | Date,
  expected?: { readonly workerId: string; readonly leaseToken: string },
): boolean {
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  const leaseMs = run.leaseExpiresAt == null ? Number.NaN : Date.parse(run.leaseExpiresAt);
  const deadlineMs = Date.parse(run.deadlineAt);
  return (
    (run.status === "leased" || run.status === "running") &&
    run.workerId != null &&
    run.leaseToken != null &&
    (!expected ||
      (run.workerId === expected.workerId && run.leaseToken === expected.leaseToken)) &&
    Number.isFinite(nowMs) &&
    leaseMs > nowMs &&
    deadlineMs > nowMs
  );
}

export interface PipelineJobEffectRow {
  readonly jobKind: "stage" | "interaction_present" | "interaction_wakeup";
  readonly interactionId?: string | null;
  readonly commandId?: string | null;
  readonly effectSchemaVersion?: string | null;
  readonly effectPayloadJson?: string | null;
}

export function parsePipelineJobEffect(
  row: PipelineJobEffectRow,
): z.infer<typeof PipelineJobEffectPayload> | null {
  if (row.jobKind === "stage") {
    if (
      row.interactionId != null ||
      row.commandId != null ||
      row.effectSchemaVersion != null ||
      row.effectPayloadJson != null
    ) {
      throw new Error("pipeline_job_effect_identity_mismatch");
    }
    return null;
  }
  if (row.effectSchemaVersion !== "stagepass.pipeline-effect/v1" || row.effectPayloadJson == null) {
    throw new Error("pipeline_job_effect_identity_mismatch");
  }
  const payload = PipelineJobEffectPayload.parse(JSON.parse(row.effectPayloadJson));
  if (
    payload.kind !== row.jobKind ||
    payload.interactionId !== row.interactionId ||
    (payload.kind === "interaction_wakeup" && payload.commandId !== row.commandId) ||
    (payload.kind === "interaction_present" && row.commandId != null)
  ) {
    throw new Error("pipeline_job_effect_identity_mismatch");
  }
  return payload;
}

export const WarReportSchema = z.object({
  id: z.string(),
  changeId: z.string(),
  roundId: z.string().nullable(),
  phase: z.enum(["Spec", "Change"]),
  type: z.enum(["phase_report", "change_report"]),
  status: WarReportStatus,
  path: z.string(),
  sourceHashesJson: z.string(),
  reportHash: z.string(),
  blockingP0: z.number().int(),
  blockingP1: z.number().int(),
  nonBlockingP2: z.number().int(),
  overriddenP0: z.number().int(),
  openRequirementGaps: z.number().int(),
  generatedBy: z.literal("BATTLE_REPORTER"),
  aiPolished: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WarReport = z.infer<typeof WarReportSchema>;
