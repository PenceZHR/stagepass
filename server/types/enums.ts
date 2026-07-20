import { z } from "zod";

export const AiProvider = z.enum(["codex", "claude"]);
export type AiProvider = z.infer<typeof AiProvider>;

export const ChangeStatus = z.enum([
  "REFINING",
  "DRAFT",
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
  "DONE",
]);
export type ChangeStatus = z.infer<typeof ChangeStatus>;

export const RunPhase = z.enum([
  "refine",
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
  "chat_user",
  "chat_assistant",
  "prd_briefing_locked",
  "stage_progress",
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

export const BattleRoundStatus = z.enum([
  "not_started",
  "red_running",
  "red_done",
  "blue_running",
  "blue_done",
  "report_ready",
  "closed",
  "superseded",
  "failed",
]);
export type BattleRoundStatus = z.infer<typeof BattleRoundStatus>;

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
