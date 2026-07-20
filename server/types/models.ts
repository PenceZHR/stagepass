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
  sourcePhase: z.literal("Spec"),
  sourceUnit: z.enum(["REQUIREMENT_CRITIC", "HUMAN_COMMANDER"]),
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
  createdAt: z.string(),
});
export type HumanDecision = z.infer<typeof HumanDecisionSchema>;

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
