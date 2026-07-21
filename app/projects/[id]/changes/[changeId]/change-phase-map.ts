import type { RunPhase } from "@/server/types/enums";
import type { ChangeDetail } from "./change-detail-types";
import type { ReviewCenterResponse } from "./review-report-center";
import type { RubricPhase } from "./rubric-types";
import type { SpecBattleState } from "./spec-battle-types";

export const PHASES = [
  "Intake",
  "Spec",
  "TechSpec",
  "Plan",
  "TestPlan",
  "Build",
  "Review",
  "Check",
  "Fix",
  "Merge",
  "Retro",
  "Done",
] as const;

export type PhaseName = (typeof PHASES)[number];
export type ReviewPhase =
  | "Refine"
  | "Plan"
  | "Implement"
  | PhaseName;

export const REVIEW_PHASES: ReviewPhase[] = [
  "Refine",
  "Intake",
  "Spec",
  "TechSpec",
  "Plan",
  "TestPlan",
  "Build",
  "Implement",
  "Review",
  "Check",
  "Fix",
  "Merge",
  "Retro",
  "Done",
];

/**
 * Which rubric a UI phase edits (§3, §7.1).
 *
 * The two vocabularies do not line up, and the mismatches are not spelling:
 *
 *  - `Intake` is the PRD phase and `Check` is QA; those are display renames.
 *  - `Implement` and `Build` are the same stage under two ids.
 *  - `Review` is NOT a phase in §3's table — it is Build's CRITIC. The Review
 *    stage panel therefore edits the Build rubric, the same object the Build
 *    panel edits. That is informative rather than confusing only because the
 *    drawer names the rubric phase it is editing; the alternative, showing
 *    nothing on Review, would hide the very tab whose verdicts that stage
 *    produces.
 *
 * `Done` used to have no entry, on the grounds that it was a completion screen
 * rather than a pipeline stage. Design §3 made it one: it runs the delivery
 * stage, produces delivery.md and answers the Done producer rubric, so it now
 * maps like every other stage.
 */
const REVIEW_PHASE_TO_RUBRIC_PHASE: Partial<Record<ReviewPhase, RubricPhase>> = {
  Refine: "Refine",
  Intake: "PRD",
  Spec: "Spec",
  TechSpec: "TechSpec",
  Plan: "Plan",
  TestPlan: "TestPlan",
  Build: "Build",
  Implement: "Build",
  Review: "Build",
  Check: "QA",
  Fix: "Fix",
  Merge: "Merge",
  Retro: "Retro",
  Done: "Done",
};

export function reviewPhaseToRubricPhase(phase: ReviewPhase): RubricPhase | null {
  return REVIEW_PHASE_TO_RUBRIC_PHASE[phase] ?? null;
}

// Phases the /rework endpoint actually supports — see change-rework-service.ts's
// ReworkReviewPhase (and its PHASE_TO_RUN_PHASE / PHASE_TO_READY_STATUS maps).
// Rework is only implemented for these document-producing phases; the other
// ReviewPhases (Intake, Spec, TechSpec, Review, Merge, Retro) have no rework path
// and the endpoint rejects them with 400. Keep this list in sync with ReworkReviewPhase.
export const REWORKABLE_REVIEW_PHASES: ReviewPhase[] = [
  "Refine",
  "Plan",
  "TestPlan",
  "Build",
  "Implement",
  "Check",
  "Fix",
];

export const STATUS_TO_PHASE: Record<string, { phase: string; state: string }> = {
  REFINING: { phase: "Intake", state: "running" },
  DRAFT: { phase: "Plan", state: "waiting" },
  PLANNING: { phase: "Plan", state: "running" },
  PLAN_READY: { phase: "Plan", state: "done" },
  PLAN_APPROVED: { phase: "Plan", state: "done" },
  IMPLEMENTING: { phase: "Build", state: "running" },
  IMPLEMENTED: { phase: "Review", state: "waiting" },
  REVIEWING: { phase: "Review", state: "running" },
  CHECKING: { phase: "Check", state: "running" },
  CHECK_FAILED: { phase: "Check", state: "failed" },
  FIXING: { phase: "Fix", state: "running" },
  SCOPE_FAILED: { phase: "Check", state: "failed" },
  LOCAL_READY: { phase: "Check", state: "done" },
  BLOCKED: { phase: "Check", state: "blocked" },
  INTAKE_PENDING: { phase: "Intake", state: "waiting" },
  INTAKE_READY: { phase: "Intake", state: "waiting" },
  SPECCING: { phase: "Spec", state: "running" },
  SPEC_READY: { phase: "Spec", state: "waiting" },
  TECHSPECCING: { phase: "TechSpec", state: "running" },
  TECHSPEC_READY: { phase: "TechSpec", state: "waiting" },
  TESTPLANNING: { phase: "TestPlan", state: "running" },
  TESTPLAN_DONE: { phase: "TestPlan", state: "done" },
  MERGE_READY: { phase: "Merge", state: "waiting" },
  MERGING: { phase: "Merge", state: "running" },
  RETRO_PENDING: { phase: "Retro", state: "waiting" },
  DELIVERY_PENDING: { phase: "Done", state: "waiting" },
  DONE: { phase: "Done", state: "done" },
};

export function getCurrentPhase(status: string, reviewCenterState?: ReviewCenterResponse | null): PhaseName {
  // Special handling for IMPLEMENTING: depends on Review state
  if (status === "IMPLEMENTING" && reviewCenterState?.gate) {
    const gateStatus = reviewCenterState.gate.status;
    // If Review has blockers, we're in Fix phase
    if (gateStatus === "blocked_p1" || gateStatus === "blocked_p0") {
      return "Fix";
    }
    // If Review passed, we're ready for Check
    if (gateStatus === "passed") {
      return "Check";
    }
    // Otherwise, still in Build phase
    return "Build";
  }

  const current = STATUS_TO_PHASE[status] || { phase: "Plan", state: "waiting" };
  return current.phase as PhaseName;
}

export function toReviewPhase(phase: PhaseName): ReviewPhase | null {
  return REVIEW_PHASES.includes(phase as ReviewPhase) ? (phase as ReviewPhase) : null;
}

export function getDefaultReviewPhase(status: string, reviewCenterState?: ReviewCenterResponse | null): ReviewPhase {
  const currentReview = toReviewPhase(getCurrentPhase(status, reviewCenterState));
  if (currentReview) return currentReview;
  if (status === "PLAN_APPROVED") return "Plan";
  if (status === "LOCAL_READY" || status === "BLOCKED") return "Check";
  return "Plan";
}

/**
 * The client half of the run-phase -> review-phase mapping. The server half,
 * RUN_PHASE_TO_REVIEW_PHASE in change-phase-service.ts, is the authority; this
 * must agree with it for every RunPhase.
 *
 * Typed as a total Record over RunPhase (type-only import, erased at compile
 * time -- no server code reaches the client bundle) so that adding a RunPhase
 * without adding it here is a type error rather than a silent null. As an
 * if-chain it had silently drifted twice: `refine` and `delivery` both fell
 * through to null while the server mapped them to "Refine" and "Done", which
 * sent a failed run of either phase to the wrong stage tab.
 */
const RUN_PHASE_TO_REVIEW_PHASE: Record<RunPhase, ReviewPhase> = {
  refine: "Refine",
  intake: "Intake",
  spec: "Spec",
  tech_spec: "TechSpec",
  generate_plan: "Plan",
  test_plan: "TestPlan",
  implement: "Build",
  review: "Review",
  local_check: "Check",
  fix_findings: "Fix",
  release: "Merge",
  retro: "Retro",
  delivery: "Done",
};

/**
 * Sub-phase run strings that are not RunPhase members but do reach this
 * function: the PRD briefing rounds, the spec battle's red/blue legs, and the
 * legacy `fix` spelling of fix_findings. They fold into the stage that owns
 * them, so the tab lands on that stage rather than nowhere.
 */
const SUB_PHASE_TO_REVIEW_PHASE: Record<string, ReviewPhase> = {
  prd_briefing_questions: "Intake",
  prd_briefing_draft: "Intake",
  prd_briefing_final_review: "Intake",
  spec_critic: "Spec",
  spec_verdict: "Spec",
  fix: "Fix",
};

export function getReviewPhaseForRunPhase(phase?: string | null): ReviewPhase | null {
  if (!phase) return null;
  return (
    RUN_PHASE_TO_REVIEW_PHASE[phase as RunPhase] ??
    SUB_PHASE_TO_REVIEW_PHASE[phase] ??
    null
  );
}

export function getDefaultReviewPhaseForChange(change: ChangeDetail, reviewCenterState?: ReviewCenterResponse | null): ReviewPhase {
  if (change.latestRun?.status === "failed") {
    return getReviewPhaseForRunPhase(change.latestRun.phase) ?? getDefaultReviewPhase(change.status, reviewCenterState);
  }
  if (hasFailedBuildRun(change)) return "Build";
  return getDefaultReviewPhase(change.status, reviewCenterState);
}

export function hasFailedBuildRun(change: ChangeDetail): boolean {
  return change.latestRun?.phase === "implement" && change.latestRun.status === "failed";
}

export function isBuildOrFixAwaitingHuman(change: ChangeDetail): boolean {
  return change.status === "IMPLEMENTING" &&
    (change.latestRun?.phase === "implement" || change.latestRun?.phase === "fix_findings") &&
    change.latestRun.status === "completed";
}

export function visibleChangeStatus(change: ChangeDetail): string {
  if (change.status === "PLAN_APPROVED") return "Build 待开工";
  if (isBuildOrFixAwaitingHuman(change)) return "Build/Fix 待收编";
  if (change.status === "IMPLEMENTING") return "Build 施工中";
  if (change.status === "IMPLEMENTED") return "Build 已收编";
  return change.status;
}

export const PARENT_POLLING_CHANGE_STATUSES = new Set([
  "PLANNING",
  "REVIEWING",
  "FIXING",
  "CHECKING",
  "SPECCING",
  "TECHSPECCING",
  "TESTPLANNING",
  "MERGING",
]);

export function shouldPollChangeDetailParent({
  change,
  running,
  gateBusy,
  specBattleState,
  reviewCenterState,
}: {
  change: ChangeDetail | null;
  running: boolean;
  gateBusy: boolean;
  specBattleState: SpecBattleState | null;
  reviewCenterState: ReviewCenterResponse | null;
}): boolean {
  if (running || gateBusy) return true;
  if (!change) return false;
  if (change.latestRun?.status === "running") return true;
  if (change.status === "SPECCING" && specBattleState?.latestRound?.status === "not_started") return false;
  if (PARENT_POLLING_CHANGE_STATUSES.has(change.status)) return true;
  if (["red_running", "blue_running"].includes(specBattleState?.latestRound?.status ?? "")) return true;
  return reviewCenterState?.headlineStatus === "running" ||
    reviewCenterState?.latestAttempt?.runStatus === "running" ||
    reviewCenterState?.latestAttempt?.reviewStatus === "running";
}

export const FAILED_RUN_FALLBACK_SUMMARY = "后台任务失败，请查看该阶段记录。";
export const ABSOLUTE_PATH_PATTERN = /(^|[\s"'(:=])(?:\/(?:Users|home|private|var|tmp|Volumes|opt|Applications)\/[^\s"',)}\]]+|[A-Za-z]:\\[^\s"',)}\]]+)/g;
export const BLOCKED_FAILED_SUMMARY_KEYS = new Set([
  "reportPath",
  "findingsPath",
  "sourcePath",
  "content",
  "rawJson",
]);
export const BLOCKED_FAILED_SUMMARY_KEY_PATTERN = new RegExp(
  `\\b(${Array.from(BLOCKED_FAILED_SUMMARY_KEYS).join("|")})\\b`
);
export const SAFE_FAILED_SUMMARY_KEYS = [
  "sanitizedErrorSummary",
  "summary",
  "errorMessage",
  "message",
  "errorCode",
  "reason",
  "reasonCode",
] as const;

export function redactAbsolutePaths(value: string): string {
  return value.replace(ABSOLUTE_PATH_PATTERN, (_match, prefix: string) => `${prefix}[已隐藏路径]`);
}

export function summarizeFailedRunObject(value: Record<string, unknown>): string | null {
  for (const key of SAFE_FAILED_SUMMARY_KEYS) {
    const field = value[key];
    if (typeof field !== "string" && typeof field !== "number") continue;
    const text = String(field).trim();
    if (!text) continue;
    if (key === "errorCode" || key === "reasonCode") {
      return `错误代码：${redactAbsolutePaths(text)}`;
    }
    return sanitizeFailedRunSummary(text);
  }

  return null;
}

export function sanitizeFailedRunSummary(summary: string | null | undefined): string | null {
  const text = summary?.trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "string") return sanitizeFailedRunSummary(parsed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return summarizeFailedRunObject(parsed as Record<string, unknown>);
    }
    return null;
  } catch {}

  if (/^[\[{]/.test(text)) return null;
  if (BLOCKED_FAILED_SUMMARY_KEY_PATTERN.test(text)) return null;
  return redactAbsolutePaths(text);
}

export function summarizeFailedRunForBanner(run: ChangeDetail["latestRun"]): string {
  return sanitizeFailedRunSummary(run?.summary) ?? FAILED_RUN_FALLBACK_SUMMARY;
}
