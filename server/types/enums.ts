import { z } from "zod";

import {
  BATTLE_ROUND_STATUSES,
} from "./battle-round-status";

export const AiProvider = z.enum(["codex"]);
export type AiProvider = z.infer<typeof AiProvider>;

export const ChangeStatus = z.enum([
  "PLANNING",
  "PLAN_READY",
  "PLAN_APPROVED",
  "IMPLEMENTING",
  "IMPLEMENTED",
  "REVIEWING",
  "CHECKING",
  "CHECK_FAILED",
  "FIXING",
  "SCOPE_FAILED",
  "LOCAL_READY",
  "BLOCKED",
  "INTAKE_PENDING",
  "INTAKE_READY",
  "SPECCING",
  "SPEC_READY",
  "TECHSPECCING",
  "TECHSPEC_READY",
  "TESTPLANNING",
  "TESTPLAN_DONE",
  "MERGE_READY",
  "MERGING",
  "RETRO_PENDING",
  // Retro is finished, the delivery note has not been produced yet. Like
  // RETRO_PENDING this is a WAITING status, not a running one: the human presses
  // the button. See RUNNING_CHANGE_STATUSES in state-machine/transitions.ts.
  "DELIVERY_PENDING",
  "DONE",
]);
export type ChangeStatus = z.infer<typeof ChangeStatus>;

export const RunPhase = z.enum([

  "generate_plan",
  "implement",
  "review",
  "local_check",
  "fix_findings",
  "intake",
  "spec",
  "tech_spec",
  "test_plan",
  "release",
  "retro",
  "delivery",
]);
export type RunPhase = z.infer<typeof RunPhase>;

export const RunStatus = z.enum(["running", "completed", "failed", "stopped"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const EventType = z.enum([
  "project_created",
  "change_created",
  "change_status_changed",
  "run_started",
  "run_completed",
  "run_failed",
  "codex_output",
  "ai_reasoning",
  "ai_message",
  "check_started",
  "check_passed",
  "check_failed",
  "finding_created",
  "finding_waived",
  "scope_check_passed",
  "scope_check_failed",
  "prd_briefing_locked",
  "stage_progress",
  "interaction_created",
  "interaction_presented",
  "interaction_expired",
  "interaction_completed",
  "interaction_failed",
]);
export type EventType = z.infer<typeof EventType>;

export const FindingSeverity = z.enum(["P0", "P1", "P2"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const FindingSource = z.enum([
  "lint",
  "typecheck",
  "test",
  "build",
  "semgrep",
  "scope",
  "review",
  "human",
  "requirement_critic",
]);
export type FindingSource = z.infer<typeof FindingSource>;

export const FindingStatus = z.enum(["open", "fixed", "waived"]);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const PrdStatus = z.enum(["none", "drafting", "ready", "revising", "failed"]);
export type PrdStatus = z.infer<typeof PrdStatus>;

export const ArtifactType = z.enum([
  "spec",
  "plan",
  "plan_json",
  "plan_md",
  "log",
  "diff",
  "check_report",
  "implement_summary",
  "changed_files",
  "local_check",
  "scope_check",
  "findings",
  "semgrep",
  "change_request",
  "prd_intent",
  "briefing_questions",
  "prd_draft",
  "prd_gate",
  "prd_delta",
  "tech_spec_delta",
  "api_spec_delta",
  "test_plan_delta",
  "review_report",
  "review_raw_output",
  "release_note",
  "retro",
  "stage_scope",
  "spec_report",
  "war_report",
  "requirement_gaps",
  "battle_round",
  "human_decisions",
  "delivery",
]);
export type ArtifactType = z.infer<typeof ArtifactType>;

export const BattleUnit = z.enum([
  "SPEC_WRITER",
  "REQUIREMENT_CRITIC",
  "BATTLE_REPORTER",
  "HUMAN_COMMANDER",
]);
export type BattleUnit = z.infer<typeof BattleUnit>;

export const BattleTemplate = z.enum(["SPEC_BATTLE_MVP"]);
export type BattleTemplate = z.infer<typeof BattleTemplate>;

// Derived from the dependency-free canonical list so the two cannot drift, and
// so client components can import the predicates without pulling zod. See
// battle-round-status.ts.
export const BattleRoundStatus = z.enum(BATTLE_ROUND_STATUSES);
export type BattleRoundStatus = z.infer<typeof BattleRoundStatus>;

export {
  BATTLE_ROUND_STATUSES,
  RUNNING_BATTLE_ROUND_STATUSES,
  OCCUPIED_BATTLE_ROUND_STATUSES,
  isRunningBattleRoundStatus,
  isOccupiedBattleRoundStatus,
} from "./battle-round-status";

export const RequirementGapStatus = z.enum([
  "open",
  "resolved",
  "waived",
  "downgraded",
  "overridden",
]);
export type RequirementGapStatus = z.infer<typeof RequirementGapStatus>;

export const HumanDecisionAction = z.enum([
  "approve",
  "request_changes",
  "return_to_spec",
  "waive_p1",
]);
export type HumanDecisionAction = z.infer<typeof HumanDecisionAction>;

export const CodexBindingStatus = z.enum([
  "provisioning",
  "ready",
  "running",
  "waiting_human",
  "failed",
  "detached",
]);
export type CodexBindingStatus = z.infer<typeof CodexBindingStatus>;

export const CodexInteractionStatus = z.enum([
  "pending",
  "presented",
  "submitting",
  "completed",
  "expired",
  "superseded",
  "cancelled",
  "failed",
]);
export type CodexInteractionStatus = z.infer<typeof CodexInteractionStatus>;

export const ActorSurface = z.enum([
  "codex_mcp_app",
  "stagepass_web_emergency",
  "stagepass_web_ops",
  "legacy_web_migration",
  "recovery",
]);
export type ActorSurface = z.infer<typeof ActorSurface>;

export const PipelineCommandReceiptStatus = z.enum([
  "accepted",
  "completed",
  "rejected",
  "failed",
]);
export type PipelineCommandReceiptStatus = z.infer<typeof PipelineCommandReceiptStatus>;

export const DispatchSurfaceSchema = z.enum(["follower_ipc", "host_ui_message"]);
export type DispatchSurface = z.infer<typeof DispatchSurfaceSchema>;

export const CodexLogicalRoleSchema = z.enum([
  "stage",
  "spec_writer",
  "spec_critic",
  "spec_verdict",
  "build",
  "fix",
  "prd_turn",
  "context_select",
  "context_generate",
  "interaction_present",
  "interaction_wakeup",
]);
export type CodexLogicalRole = z.infer<typeof CodexLogicalRoleSchema>;

export const STAGEPASS_DISPATCH_SURFACE_BY_ROLE = {
  stage: "follower_ipc",
  spec_writer: "follower_ipc",
  spec_critic: "follower_ipc",
  spec_verdict: "follower_ipc",
  build: "follower_ipc",
  fix: "follower_ipc",
  prd_turn: "follower_ipc",
  context_select: "follower_ipc",
  context_generate: "follower_ipc",
  interaction_present: "follower_ipc",
  interaction_wakeup: "host_ui_message",
} as const satisfies Record<CodexLogicalRole, DispatchSurface>;

export const PipelineJobEffectPayload = z.discriminatedUnion("kind", [
  z.object({
    schemaVersion: z.literal("stagepass.pipeline-effect/v1"),
    kind: z.literal("interaction_present"),
    interactionId: z.string().min(1),
  }).strict(),
  z.object({
    schemaVersion: z.literal("stagepass.pipeline-effect/v1"),
    kind: z.literal("interaction_wakeup"),
    interactionId: z.string().min(1),
    commandId: z.string().min(1),
  }).strict(),
]);
export type PipelineJobEffectPayload = z.infer<typeof PipelineJobEffectPayload>;

export const WarReportStatus = z.enum(["generated", "stale", "approved"]);
export type WarReportStatus = z.infer<typeof WarReportStatus>;

export const Phase = z.enum([
  "Intake",
  "Refine",
  "Spec",
  "TechSpec",
  "TestPlan",
  "Plan",
  "Approve",
  "Build",
  "Implement",
  "Review",
  "QA",
  "Check",
  "Fix",
  "Merge",
  "Retro",
  "Done",
  "Ready",
]);
export type Phase = z.infer<typeof Phase>;

export const PhaseState = z.enum([
  "waiting",
  "done",
  "running",
  "failed",
  "blocked",
]);
export type PhaseState = z.infer<typeof PhaseState>;
