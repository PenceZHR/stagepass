import type { ChangeDetail, PhaseOverview } from "./change-detail-types";
import type { ReviewPhase } from "./change-phase-map";
import type { GateStatus } from "./gate-types";
import type { PipelineActionContract } from "./pipeline-action-contract";
import type { ReviewCenterResponse, ReviewCenterGateStatus } from "./review-report-center";
import type { SpecBattleState } from "./spec-battle-types";

export type UiStageId =
  | "refine"
  | "prd"
  | "spec"
  | "tech_spec"
  | "plan"
  | "test_plan"
  | "build"
  | "review"
  | "fix"
  | "qa"
  | "merge"
  | "retro"
  | "done";

export type UiStageState =
  | "not_started"
  | "waiting"
  | "running"
  | "needs_review"
  | "blocked"
  | "failed"
  | "stale"
  | "complete";

type ActionPhase = PipelineActionContract["phase"];

export interface UiStage {
  id: UiStageId;
  label: string;
  description: string;
  state: UiStageState;
  reviewPhase: ReviewPhase | null;
  recordPhase: ReviewPhase | null;
  actionPhase: ActionPhase | null;
  actionPhases?: ActionPhase[];
  actionIds?: string[];
  selectable: boolean;
  selected: boolean;
  available: boolean;
  artifactCount: number;
  runCount: number;
  eventCount: number;
  blockerCount?: number;
}

interface StageDefinition {
  id: UiStageId;
  label: string;
  description: string;
  reviewPhase: ReviewPhase | null;
  recordPhase: ReviewPhase | null;
  actionPhase: ActionPhase | null;
  actionPhases?: ActionPhase[];
  actionIds?: string[];
}

interface StageResolution {
  id: UiStageId;
  state: UiStageState;
}

export const UI_STAGE_ORDER: UiStageId[] = [
  "refine",
  "prd",
  "spec",
  "tech_spec",
  "plan",
  "test_plan",
  "build",
  "review",
  "fix",
  "qa",
  "merge",
  "retro",
  "done",
];

const STAGE_DEFINITIONS: Record<UiStageId, StageDefinition> = {
  refine: {
    id: "refine",
    label: "Refine",
    description: "Clarify the change before it enters the PRD pipeline.",
    reviewPhase: "Refine",
    recordPhase: "Refine",
    actionPhase: null,
  },
  prd: {
    id: "prd",
    label: "PRD",
    description: "Capture and lock the product requirement for this change.",
    reviewPhase: "Intake",
    recordPhase: "Intake",
    actionPhase: "PRD",
    actionIds: ["run_prd", "retry_prd", "approve_intake"],
  },
  spec: {
    id: "spec",
    label: "Spec",
    description: "Resolve product scope and requirement gaps.",
    reviewPhase: "Spec",
    recordPhase: "Spec",
    actionPhase: "Spec",
    actionIds: ["run_spec", "retry_spec", "approve_spec", "reject_spec", "waive_spec_p1"],
  },
  tech_spec: {
    id: "tech_spec",
    label: "Tech Spec",
    description: "Generate and approve the technical design.",
    reviewPhase: "TechSpec",
    recordPhase: "TechSpec",
    actionPhase: "Plan",
    actionIds: ["run_tech_spec", "retry_tech_spec", "approve_tech_spec", "reject_tech_spec"],
  },
  plan: {
    id: "plan",
    label: "Plan",
    description: "Prepare implementation scope, risks, and validation steps.",
    reviewPhase: "Plan",
    recordPhase: "Plan",
    actionPhase: "Plan",
    actionIds: ["run_plan", "retry_plan", "approve_plan", "regenerate_plan_report", "waive_plan_p1"],
  },
  test_plan: {
    id: "test_plan",
    label: "Test Plan",
    description: "Define and confirm validation coverage before Build.",
    reviewPhase: "TestPlan",
    recordPhase: "TestPlan",
    actionPhase: "TestPlan",
    actionIds: ["run_test_plan", "retry_test_plan"],
  },
  build: {
    id: "build",
    label: "Build",
    description: "Implement the approved plan and prepare work for adoption.",
    reviewPhase: "Build",
    recordPhase: "Build",
    actionPhase: "Build",
    // init_git_repo/commit_changes ride the Build and Fix stages because those
    // are the two the working tree actually moves under: Build writes the
    // adopted patch, Fix rewrites it. Committing is the step that follows both.
    actionIds: ["run_build", "retry_build", "adopt_build", "reject_build", "init_git_repo", "commit_changes"],
  },
  review: {
    id: "review",
    label: "Review",
    description: "Inspect the adopted Build and manage findings.",
    reviewPhase: "Review",
    recordPhase: "Review",
    actionPhase: "Review",
    actionIds: [
      "run_review",
      "retry_review",
      "fix_blockers",
      "waive_review_p1",
      "enter_qa",
      "stop_change",
      "recompute_report",
      "rebuild_mirror",
    ],
  },
  fix: {
    id: "fix",
    label: "Fix",
    description: "Repair Review or QA blockers before continuing.",
    reviewPhase: "Fix",
    recordPhase: "Fix",
    actionPhase: "Build",
    actionPhases: ["Build", "Review"],
    actionIds: ["adopt_fix", "reject_build", "fix_blockers", "init_git_repo", "commit_changes"],
  },
  qa: {
    id: "qa",
    label: "QA",
    description: "Run local and scope checks before merge readiness.",
    reviewPhase: "Check",
    recordPhase: "Check",
    actionPhase: "QA",
    actionIds: ["enter_qa", "run_qa", "retry_qa"],
  },
  merge: {
    id: "merge",
    label: "Merge",
    description: "Confirm readiness and merge the completed change.",
    reviewPhase: "Merge",
    recordPhase: "Merge",
    actionPhase: "Merge",
    actionIds: ["approve_merge", "reject_merge", "merge"],
  },
  retro: {
    id: "retro",
    label: "Retro",
    description: "Capture follow-up learning after delivery.",
    reviewPhase: "Retro",
    recordPhase: "Retro",
    actionPhase: "Merge",
    actionIds: ["run_retro"],
  },
  done: {
    id: "done",
    label: "Done",
    description: "Produce the delivery note: how to run it, what changed, the file map, and what is still open.",
    reviewPhase: "Done",
    recordPhase: "Done",
    // Filed under the Merge action phase for the same reason Retro is: both run
    // after the merge and inherit the Merge stage gate as their authority.
    actionPhase: "Merge",
    actionIds: ["run_delivery"],
  },
};

const STATUS_TO_STAGE: Record<string, StageResolution> = {
  REFINING: { id: "refine", state: "running" },
  DRAFT: { id: "plan", state: "waiting" },
  INTAKE_PENDING: { id: "prd", state: "waiting" },
  INTAKE_READY: { id: "prd", state: "needs_review" },
  SPECCING: { id: "spec", state: "running" },
  SPEC_READY: { id: "spec", state: "needs_review" },
  TECHSPECCING: { id: "tech_spec", state: "running" },
  TECHSPEC_READY: { id: "tech_spec", state: "needs_review" },
  PLANNING: { id: "plan", state: "running" },
  PLAN_READY: { id: "plan", state: "needs_review" },
  PLAN_APPROVED: { id: "build", state: "waiting" },
  TESTPLANNING: { id: "test_plan", state: "running" },
  TESTPLAN_DONE: { id: "test_plan", state: "needs_review" },
  IMPLEMENTING: { id: "build", state: "running" },
  IMPLEMENTED: { id: "review", state: "waiting" },
  REVIEWING: { id: "review", state: "running" },
  CHECKING: { id: "qa", state: "running" },
  CHECK_FAILED: { id: "qa", state: "failed" },
  SCOPE_FAILED: { id: "qa", state: "failed" },
  FIXING: { id: "fix", state: "running" },
  LOCAL_READY: { id: "qa", state: "complete" },
  BLOCKED: { id: "review", state: "blocked" },
  MERGE_READY: { id: "merge", state: "needs_review" },
  MERGING: { id: "merge", state: "running" },
  RETRO_PENDING: { id: "retro", state: "waiting" },
  DELIVERY_PENDING: { id: "done", state: "waiting" },
  DONE: { id: "done", state: "complete" },
};

const REVIEW_PHASE_TO_STAGE: Record<ReviewPhase, UiStageId> = {
  Refine: "refine",
  Intake: "prd",
  Spec: "spec",
  TechSpec: "tech_spec",
  Plan: "plan",
  TestPlan: "test_plan",
  Build: "build",
  Implement: "build",
  Review: "review",
  Check: "qa",
  Fix: "fix",
  Merge: "merge",
  Retro: "retro",
  Done: "done",
};

const RUN_PHASE_TO_STAGE: Record<string, UiStageId> = {
  refine: "refine",
  intake: "prd",
  prd: "prd",
  prd_briefing_questions: "prd",
  prd_briefing_draft: "prd",
  prd_briefing_final_review: "prd",
  spec: "spec",
  spec_critic: "spec",
  spec_verdict: "spec",
  tech_spec: "tech_spec",
  plan: "plan",
  generate_plan: "plan",
  test_plan: "test_plan",
  build: "build",
  implement: "build",
  review: "review",
  fix: "fix",
  fix_findings: "fix",
  check: "qa",
  local_check: "qa",
  qa: "qa",
  merge: "merge",
  release: "merge",
  retro: "retro",
  delivery: "done",
};

const ACTIVE_SPEC_BATTLE_STATUSES = new Set(["not_started", "running", "red_running", "blue_running"]);
const REVIEW_FAILED_GATE_STATUSES = new Set<ReviewCenterGateStatus>(["invalid_output", "data_inconsistent"]);

export function buildUiPipelineState(input: {
  change: ChangeDetail;
  phaseOverviews?: PhaseOverview[];
  selectedPhase?: ReviewPhase | null;
  reviewCenterState?: ReviewCenterResponse | null;
  gateStatus?: GateStatus | null;
  specBattleState?: SpecBattleState | null;
}): {
  stages: UiStage[];
  activeStage: UiStage;
  selectedStage: UiStage;
} {
  const fallbackResolution = resolvePipelineStage(input);
  const selectedStageId = resolveExplicitSelectedStage(input, fallbackResolution.id) ?? fallbackResolution.id;
  const selectedResolution = selectedStageId === fallbackResolution.id
    ? fallbackResolution
    : { id: selectedStageId, state: stageStateForSelectedOverride(selectedStageId, fallbackResolution.id) };

  const stages = UI_STAGE_ORDER.map((stageId) =>
    createUiStage({
      stageId,
      selectedResolution,
      phaseOverviews: input.phaseOverviews,
      activeStageId: fallbackResolution.id,
      reviewCenterState: input.reviewCenterState,
    })
  );
  const selectedStage = stages.find((stage) => stage.id === selectedResolution.id) ?? stages[0];
  const activeStageBase = stages.find((stage) => stage.id === fallbackResolution.id) ?? selectedStage;
  const activeStage = {
    ...activeStageBase,
    state: fallbackResolution.state,
  };

  return {
    stages,
    activeStage,
    selectedStage,
  };
}

function resolvePipelineStage(input: {
  change: ChangeDetail;
  reviewCenterState?: ReviewCenterResponse | null;
  gateStatus?: GateStatus | null;
  specBattleState?: SpecBattleState | null;
}): StageResolution {
  const { change, reviewCenterState, specBattleState } = input;
  const specBattleActive = isActiveSpecBattle(specBattleState);

  if (change.latestRun?.status === "failed") {
    const failedStage = stageForRunPhase(change.latestRun.phase);
    if (specBattleActive && change.status === "SPECCING") {
      return { id: "spec", state: "running" };
    }
    if (failedStage) return { id: failedStage, state: "failed" };
  }

  const awaitingHumanResolution = resolveBuildFixAwaitingHuman(change);
  if (awaitingHumanResolution) return awaitingHumanResolution;

  const reviewGateResolution = resolveReviewGateStage(change, reviewCenterState);
  if (reviewGateResolution) return reviewGateResolution;

  if (specBattleActive) return { id: "spec", state: "running" };

  if (change.status === "PLAN_APPROVED") {
    const runBuild = input.gateStatus?.actions?.find((action) => action.actionId === "run_build");
    const runTestPlan = input.gateStatus?.actions?.find((action) => action.actionId === "run_test_plan");
    if (runBuild?.enabled) return { id: "build", state: "waiting" };
    if (runTestPlan?.enabled) return { id: "test_plan", state: "waiting" };
  }

  return resolveStatusStage(change);
}

function resolveExplicitSelectedStage(
  input: {
    selectedPhase?: ReviewPhase | null;
    phaseOverviews?: PhaseOverview[];
  },
  activeStageId: UiStageId,
): UiStageId | null {
  if (!input.selectedPhase) return null;
  const stageId = REVIEW_PHASE_TO_STAGE[input.selectedPhase];
  if (!stageId) return null;
  return isStageSelectable(stageId, activeStageId, input.phaseOverviews) ? stageId : null;
}

function resolveReviewGateStage(
  change: ChangeDetail,
  reviewCenterState?: ReviewCenterResponse | null,
): StageResolution | null {
  const gate = reviewCenterState?.gate.status ?? reviewCenterState?.headlineStatus;
  if (!gate) return null;

  if (gate === "blocked_p0" || gate === "blocked_p1") {
    return {
      id: isBuildOrFixTerritory(change) ? "fix" : "review",
      state: "blocked",
    };
  }

  if (gate === "passed" && isBuildOrFixTerritory(change)) {
    return { id: "qa", state: "waiting" };
  }

  if (gate === "stale") return { id: "review", state: "stale" };
  if (REVIEW_FAILED_GATE_STATUSES.has(gate)) return { id: "review", state: "failed" };
  return null;
}

function resolveBuildFixAwaitingHuman(change: ChangeDetail): StageResolution | null {
  if (change.status !== "IMPLEMENTING" || change.latestRun?.status !== "completed") return null;
  if (change.latestRun.phase === "implement") return { id: "build", state: "needs_review" };
  if (change.latestRun.phase === "fix_findings") return { id: "fix", state: "needs_review" };
  return null;
}

function resolveStatusStage(change: ChangeDetail): StageResolution {
  if (change.status === "BLOCKED") {
    const blockedStage = stageForRunPhase(change.blockedPhase);
    return { id: blockedStage ?? "review", state: "blocked" };
  }

  if (change.status === "IMPLEMENTING" && change.latestRun?.status === "running") {
    const runStage = stageForRunPhase(change.latestRun.phase);
    if (runStage === "fix") return { id: "fix", state: "running" };
    if (runStage === "build") return { id: "build", state: "running" };
  }

  return STATUS_TO_STAGE[change.status] ?? { id: "plan", state: "waiting" };
}

function createUiStage(input: {
  stageId: UiStageId;
  selectedResolution: StageResolution;
  phaseOverviews?: PhaseOverview[];
  activeStageId: UiStageId;
  reviewCenterState?: ReviewCenterResponse | null;
}): UiStage {
  const definition = STAGE_DEFINITIONS[input.stageId];
  const overview = phaseOverviewForStage(definition, input.phaseOverviews);
  const selected = input.stageId === input.selectedResolution.id;
  const state = selected
    ? input.selectedResolution.state
    : inactiveStageState(input.stageId, input.selectedResolution.id);

  return {
    ...definition,
    state,
    selectable: isStageSelectable(input.stageId, input.activeStageId, input.phaseOverviews),
    selected,
    available: isStageAvailable(input.stageId, input.activeStageId, input.phaseOverviews, selected),
    artifactCount: overview?.artifactCount ?? 0,
    runCount: overview?.runCount ?? 0,
    eventCount: overview?.eventCount ?? 0,
    blockerCount: blockerCountForStage(input.stageId, input.reviewCenterState),
  };
}

function inactiveStageState(stageId: UiStageId, selectedStageId: UiStageId): UiStageState {
  if (stageId === "done") return "not_started";
  return UI_STAGE_ORDER.indexOf(stageId) < UI_STAGE_ORDER.indexOf(selectedStageId) ? "complete" : "not_started";
}

function stageStateForSelectedOverride(stageId: UiStageId, fallbackStageId: UiStageId): UiStageState {
  if (stageId === fallbackStageId) return "waiting";
  return UI_STAGE_ORDER.indexOf(stageId) < UI_STAGE_ORDER.indexOf(fallbackStageId) ? "complete" : "waiting";
}

function isStageSelectable(stageId: UiStageId, activeStageId: UiStageId, phaseOverviews?: PhaseOverview[]): boolean {
  const definition = STAGE_DEFINITIONS[stageId];
  if (!definition.reviewPhase) return false;
  if (!phaseOverviews) return true;

  const overview = phaseOverviewForStage(definition, phaseOverviews);
  if (overview?.available) return true;
  return UI_STAGE_ORDER.indexOf(stageId) <= UI_STAGE_ORDER.indexOf(activeStageId);
}

function isStageAvailable(
  stageId: UiStageId,
  activeStageId: UiStageId,
  phaseOverviews: PhaseOverview[] | undefined,
  selected: boolean,
): boolean {
  if (selected) return true;

  const definition = STAGE_DEFINITIONS[stageId];
  if (!definition.reviewPhase) return false;
  if (!phaseOverviews) return true;

  const overview = phaseOverviewForStage(definition, phaseOverviews);
  if (overview?.available) return true;
  return UI_STAGE_ORDER.indexOf(stageId) <= UI_STAGE_ORDER.indexOf(activeStageId);
}

function phaseOverviewForStage(
  definition: StageDefinition,
  phaseOverviews?: PhaseOverview[],
): PhaseOverview | undefined {
  if (!definition.recordPhase) return undefined;
  return phaseOverviews?.find((overview) => overview.phase === definition.recordPhase);
}

function blockerCountForStage(
  stageId: UiStageId,
  reviewCenterState?: ReviewCenterResponse | null,
): number | undefined {
  if (!reviewCenterState || (stageId !== "review" && stageId !== "fix")) return undefined;
  return reviewCenterState.counts.p0 + reviewCenterState.counts.p1;
}

function stageForRunPhase(phase?: string | null): UiStageId | null {
  if (!phase) return null;
  return RUN_PHASE_TO_STAGE[phase] ?? null;
}

function isActiveSpecBattle(specBattleState?: SpecBattleState | null): boolean {
  const status = specBattleState?.latestRound?.status;
  return Boolean(status && ACTIVE_SPEC_BATTLE_STATUSES.has(status));
}

function isBuildOrFixTerritory(change: ChangeDetail): boolean {
  if (change.status === "PLAN_APPROVED" || change.status === "IMPLEMENTING" || change.status === "FIXING") {
    return true;
  }
  const latestRunStage = stageForRunPhase(change.latestRun?.phase);
  return latestRunStage === "build" || latestRunStage === "fix";
}
