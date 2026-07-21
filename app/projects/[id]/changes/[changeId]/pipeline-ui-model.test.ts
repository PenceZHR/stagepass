import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  UI_STAGE_ORDER,
  buildUiPipelineState,
  type UiStageId,
  type UiStageState,
} from "./pipeline-ui-model";
import { NON_POST_ROUTED_ACTION_IDS, isPostRoutedAction } from "./pipeline-action-commands";
import type { ChangeDetail, PhaseOverview } from "./change-detail-types";
import type { ReviewPhase } from "./change-phase-map";
import type { ReviewCenterResponse, ReviewCenterGateStatus } from "./review-report-center";
import type { SpecBattleState } from "./spec-battle-types";
import type { PipelineActionContract } from "./pipeline-action-contract";

function change(overrides: Partial<ChangeDetail> = {}): ChangeDetail {
  return {
    id: "change-1",
    projectId: "project-1",
    title: "Unify pipeline UI",
    status: "DRAFT",
    codexThreadId: null,
    fixIterations: 0,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

function overviews(phases: ReviewPhase[] = []): PhaseOverview[] {
  return phases.map((phase, index) => ({
    phase,
    available: true,
    artifactCount: index + 1,
    runCount: index + 2,
    eventCount: index + 3,
  }));
}

function reviewCenter(gateStatus: ReviewCenterGateStatus): ReviewCenterResponse {
  return {
    headlineStatus: gateStatus,
    qaAllowed: gateStatus === "passed",
    latestAttempt: null,
    latestValidReview: null,
    counts: { p0: 1, p1: 2, p2: 3, waived: 0 },
    gate: {
      status: gateStatus,
      canEnterQa: gateStatus === "passed",
      reason: null,
      sourceBuildRunId: null,
      latestBuildRunId: null,
    },
    findings: [],
    waivers: [],
    mirrorWarnings: [],
    actions: {
      canRunReview: true,
      canRetryReview: false,
      canFixBlockers: gateStatus === "blocked_p0" || gateStatus === "blocked_p1",
      canWaiveP1: gateStatus === "blocked_p1",
      canEnterQa: gateStatus === "passed",
      canStopChange: true,
    },
    advancedDetails: {
      latestAttempt: null,
      latestValidReview: null,
    },
  } as ReviewCenterResponse;
}

function specBattle(status: string): SpecBattleState {
  return {
    latestRound: {
      id: "round-1",
      roundNo: 1,
      status,
      redUnit: "red",
      blueUnit: "blue",
      redArtifactPath: null,
      blueArtifactPath: null,
      reportPath: null,
      startedAt: "2026-07-07T00:00:00.000Z",
      endedAt: null,
    },
    rounds: [],
    gaps: [],
    fixClaims: [],
    gapReviews: [],
    decisions: [],
    reportFresh: true,
    staleReason: null,
    counts: {
      blockingP0: 0,
      blockingP1: 0,
      nonBlockingP2: 0,
      overriddenP0: 0,
      openRequirementGaps: 0,
      mergeBlockingRequirementGaps: 0,
    },
    roundDelta: {
      resolvedThisRound: 0,
      stillOpen: 0,
      newlyFound: 0,
      notRechecked: 0,
    },
  };
}

function selected(changeDetail: ChangeDetail, extra: Parameters<typeof buildUiPipelineState>[0] = {}) {
  return buildUiPipelineState({ change: changeDetail, ...extra }).selectedStage;
}

function pipelineAction(actionId: string, phase: PipelineActionContract["phase"], enabled: boolean): PipelineActionContract {
  return {
    actionId,
    phase,
    label: actionId,
    enabled,
    reasonCode: enabled ? null : "not_at_gate",
    reason: enabled ? null : "not_at_gate",
    blockers: [],
    warnings: [],
    gateVersion: "1",
    sourceDbHash: "hash",
    requiresIdempotencyKey: true,
  };
}

describe("pipeline UI model", () => {
  it("defines the user-facing stage order, labels, and separated integration phases", () => {
    assert.deepEqual(UI_STAGE_ORDER, [
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
    ]);

    const state = buildUiPipelineState({ change: change({ status: "DONE" }) });
    const labels = Object.fromEntries(state.stages.map((stage) => [stage.id, stage.label]));
    assert.equal(labels.prd, "PRD");
    assert.equal(labels.qa, "QA");
    assert.equal(labels.done, "Done");

    const prd = state.stages.find((stage) => stage.id === "prd");
    assert.equal(prd?.reviewPhase, "Intake");
    assert.equal(prd?.recordPhase, "Intake");
    assert.equal(prd?.actionPhase, "PRD");
    assert.notEqual(prd?.id, prd?.reviewPhase);

    // This used to assert reviewPhase/recordPhase/actionPhase all null and no
    // actionIds, on the reading that Done was a completion screen rather than a
    // stage. Design §3 made it a real stage: it runs `delivery`, writes
    // delivery.md and answers the Done producer rubric. Keeping the old
    // assertions would pin the exact defect the design set out to remove -- a
    // stage whose records, artifact and rubric exist on the server with no way
    // to reach any of them from the interface.
    const done = state.stages.find((stage) => stage.id === "done");
    assert.equal(done?.reviewPhase, "Done");
    assert.equal(done?.recordPhase, "Done");
    assert.equal(done?.actionPhase, "Merge");
    assert.deepEqual(done?.actionIds, ["run_delivery"]);
    assert.equal(done?.available, true);
  });

  it("routes every stage action id through an endpoint or a declared dedicated route", () => {
    const state = buildUiPipelineState({ change: change({ status: "DONE" }) });
    const undeclared = state.stages.flatMap((stage) =>
      (stage.actionIds ?? [])
        .filter((actionId) => !isPostRoutedAction(actionId) && !NON_POST_ROUTED_ACTION_IDS.has(actionId))
        .map((actionId) => `${stage.id}:${actionId}`),
    );

    // An action id in neither ACTION_ENDPOINTS nor NON_POST_ROUTED_ACTION_IDS has
    // no way to reach the server. Sending it through handleAction would render a
    // button that silently does nothing, so a new one has to declare its route.
    assert.deepEqual(undeclared, []);
  });

  // Was "keeps Done as the final read-only completion stage". Done is still the
  // final stage, but it is no longer read-only: the delivery note is produced
  // here, and a stage with an artifact and a rubric has to be selectable or its
  // records are unreachable.
  it("keeps Done last, and makes it a selectable stage that owns the delivery note", () => {
    const state = buildUiPipelineState({ change: change({ status: "DONE" }) });
    const done = state.selectedStage;

    assert.equal(UI_STAGE_ORDER.at(-1), "done");
    assert.equal(done.id, "done");
    assert.equal(done.label, "Done");
    assert.equal(done.state, "complete");
    assert.equal(done.reviewPhase, "Done");
    assert.equal(done.recordPhase, "Done");
    assert.equal(done.actionPhase, "Merge");
    assert.deepEqual(done.actionIds, ["run_delivery"]);
    assert.equal(done.selectable, true);
    assert.equal(done.available, true);
  });

  it("parks a change at Done while the delivery note is still pending", () => {
    const state = buildUiPipelineState({ change: change({ status: "DELIVERY_PENDING" }) });
    assert.equal(state.activeStage.id, "done");
    assert.equal(state.activeStage.state, "waiting");
  });

  it("maps every current change status to a user-facing stage and canonical UI state", () => {
    const cases: Array<[string, UiStageId, UiStageState]> = [
      ["REFINING", "refine", "running"],
      ["DRAFT", "plan", "waiting"],
      ["INTAKE_PENDING", "prd", "waiting"],
      ["INTAKE_READY", "prd", "needs_review"],
      ["SPECCING", "spec", "running"],
      ["SPEC_READY", "spec", "needs_review"],
      ["TECHSPECCING", "tech_spec", "running"],
      ["TECHSPEC_READY", "tech_spec", "needs_review"],
      ["PLANNING", "plan", "running"],
      ["PLAN_READY", "plan", "needs_review"],
      ["PLAN_APPROVED", "build", "waiting"],
      ["TESTPLANNING", "test_plan", "running"],
      ["TESTPLAN_DONE", "test_plan", "needs_review"],
      ["IMPLEMENTING", "build", "running"],
      ["IMPLEMENTED", "review", "waiting"],
      ["REVIEWING", "review", "running"],
      ["CHECKING", "qa", "running"],
      ["CHECK_FAILED", "qa", "failed"],
      ["SCOPE_FAILED", "qa", "failed"],
      ["FIXING", "fix", "running"],
      ["LOCAL_READY", "qa", "complete"],
      ["BLOCKED", "review", "blocked"],
      ["MERGE_READY", "merge", "needs_review"],
      ["MERGING", "merge", "running"],
      ["RETRO_PENDING", "retro", "waiting"],
      ["DELIVERY_PENDING", "done", "waiting"],
      ["DONE", "done", "complete"],
    ];

    for (const [status, id, stageState] of cases) {
      const stage = selected(change({ status }));
      assert.equal(stage.id, id, status);
      assert.equal(stage.state, stageState, status);
    }
  });

  it("keeps PLAN_APPROVED in Test Plan until its real backend action has completed", () => {
    const stage = selected(change({ status: "PLAN_APPROVED" }), {
      gateStatus: {
        atGate: true,
        gate: null,
        status: "PLAN_APPROVED",
        pendingArtifact: null,
        actions: [
          pipelineAction("run_test_plan", "TestPlan", true),
          pipelineAction("run_build", "Build", false),
        ],
      },
    });

    assert.equal(stage.id, "test_plan");
    assert.equal(stage.state, "waiting");
  });

  it("moves PLAN_APPROVED to Build only when the backend allows run_build", () => {
    const stage = selected(change({ status: "PLAN_APPROVED" }), {
      gateStatus: {
        atGate: true,
        gate: null,
        status: "PLAN_APPROVED",
        pendingArtifact: null,
        actions: [
          pipelineAction("run_test_plan", "TestPlan", false),
          pipelineAction("run_build", "Build", true),
        ],
      },
    });

    assert.equal(stage.id, "build");
    assert.equal(stage.state, "waiting");
  });

  it("maps QA and Merge readiness statuses to explicit user-facing stages", () => {
    const localReady = selected(change({ status: "LOCAL_READY" }));
    assert.equal(localReady.id, "qa");
    assert.equal(localReady.label, "QA");
    assert.equal(localReady.reviewPhase, "Check");
    assert.equal(localReady.state, "complete");

    const blocked = selected(change({ status: "BLOCKED" }));
    assert.equal(blocked.id, "review");
    assert.equal(blocked.label, "Review");
    assert.equal(blocked.reviewPhase, "Review");
    assert.equal(blocked.state, "blocked");

    const mergeReady = selected(change({ status: "MERGE_READY" }));
    assert.equal(mergeReady.id, "merge");
    assert.equal(mergeReady.label, "Merge");
    assert.equal(mergeReady.reviewPhase, "Merge");
    assert.equal(mergeReady.state, "needs_review");

    const merging = selected(change({ status: "MERGING" }));
    assert.equal(merging.id, "merge");
    assert.equal(merging.label, "Merge");
    assert.equal(merging.reviewPhase, "Merge");
    assert.equal(merging.state, "running");
  });

  it("drives PRD lock and ready states through the selected-stage UI state", () => {
    const pending = selected(change({ status: "INTAKE_PENDING" }));
    assert.equal(pending.id, "prd");
    assert.equal(pending.label, "PRD");
    assert.equal(pending.reviewPhase, "Intake");
    assert.equal(pending.recordPhase, "Intake");
    assert.equal(pending.state, "waiting");

    const ready = selected(change({ status: "INTAKE_READY" }));
    assert.equal(ready.id, "prd");
    assert.equal(ready.label, "PRD");
    assert.equal(ready.reviewPhase, "Intake");
    assert.equal(ready.recordPhase, "Intake");
    assert.equal(ready.state, "needs_review");

    const blocked = selected(change({ status: "BLOCKED", blockedPhase: "prd_briefing_final_review" }));
    assert.equal(blocked.id, "prd");
    assert.equal(blocked.label, "PRD");
    assert.equal(blocked.reviewPhase, "Intake");
    assert.equal(blocked.recordPhase, "Intake");
    assert.equal(blocked.state, "blocked");
  });

  it("keeps workflow active stage separate from the user-selected stage", () => {
    const result = buildUiPipelineState({
      change: change({
        status: "CHECKING",
        latestRun: { id: "run-1", phase: "review", status: "failed" },
      }),
      selectedPhase: "Plan",
      phaseOverviews: overviews(["Plan"]),
    });

    assert.equal(result.selectedStage.id, "plan");
    assert.equal(result.selectedStage.state, "complete");
    assert.equal(result.activeStage.id, "review");
    assert.equal(result.activeStage.state, "failed");
    assert.equal(result.stages.find((stage) => stage.id === "plan")?.selected, true);
    assert.equal(result.stages.find((stage) => stage.id === "review")?.selectable, true);
    assert.equal(result.stages.filter((stage) => stage.selected).length, 1);
  });

  it("does not mark missing future phase overviews as available", () => {
    const result = buildUiPipelineState({
      change: change({ status: "PLAN_READY" }),
      phaseOverviews: overviews(["Plan"]),
    });

    const plan = result.stages.find((stage) => stage.id === "plan");
    const build = result.stages.find((stage) => stage.id === "build");

    assert.equal(plan?.available, true);
    assert.equal(plan?.selectable, true);
    assert.equal(build?.available, false);
    assert.equal(build?.selectable, false);
  });

  it("falls back to the failed run phase unless a newer active Spec Battle is the active fact", () => {
    const failedRefine = selected(change({
      status: "REFINING",
      latestRun: { id: "run-refine", phase: "refine", status: "failed" },
    }));
    assert.equal(failedRefine.id, "refine");
    assert.equal(failedRefine.state, "failed");

    assert.equal(
      selected(change({
        status: "TECHSPECCING",
        latestRun: { id: "run-1", phase: "tech_spec", status: "failed" },
      })).id,
      "tech_spec",
    );
    assert.equal(
      selected(change({
        status: "SPECCING",
        latestRun: { id: "run-2", phase: "tech_spec", status: "failed" },
      }), {
        specBattleState: specBattle("red_running"),
      }).id,
      "spec",
    );
  });

  it("maps Build and Fix awaiting-human completed runs to needs_review", () => {
    const build = selected(change({
      status: "IMPLEMENTING",
      latestRun: { id: "run-build", phase: "implement", status: "completed" },
    }));
    assert.equal(build.id, "build");
    assert.equal(build.state, "needs_review");

    const fix = selected(change({
      status: "IMPLEMENTING",
      latestRun: { id: "run-fix", phase: "fix_findings", status: "completed" },
    }));
    assert.equal(fix.id, "fix");
    assert.equal(fix.state, "needs_review");
  });

  it("keeps awaiting-human Build/Fix absorption ahead of stale Review blockers", () => {
    const build = selected(change({
      status: "IMPLEMENTING",
      latestRun: { id: "run-build", phase: "implement", status: "completed" },
    }), {
      reviewCenterState: reviewCenter("blocked_p0"),
    });
    assert.equal(build.id, "build");
    assert.equal(build.state, "needs_review");

    const fix = selected(change({
      status: "IMPLEMENTING",
      latestRun: { id: "run-fix", phase: "fix_findings", status: "completed" },
    }), {
      reviewCenterState: reviewCenter("blocked_p0"),
    });
    assert.equal(fix.id, "fix");
    assert.equal(fix.state, "needs_review");
  });

  it("uses review gate attention overrides for Review, Fix, stale, and QA pass-through", () => {
    assert.equal(
      selected(change({ status: "IMPLEMENTED" }), { reviewCenterState: reviewCenter("blocked_p0") }).id,
      "review",
    );
    assert.equal(
      selected(change({ status: "IMPLEMENTING" }), { reviewCenterState: reviewCenter("blocked_p1") }).id,
      "fix",
    );
    assert.equal(
      selected(change({ status: "IMPLEMENTING" }), { reviewCenterState: reviewCenter("passed") }).id,
      "qa",
    );

    const stale = selected(change({ status: "IMPLEMENTED" }), { reviewCenterState: reviewCenter("stale") });
    assert.equal(stale.id, "review");
    assert.equal(stale.state, "stale");

    const invalid = selected(change({ status: "IMPLEMENTED" }), { reviewCenterState: reviewCenter("invalid_output") });
    assert.equal(invalid.id, "review");
    assert.equal(invalid.state, "failed");
  });

  it("selects active Spec Battle when no higher-precedence fact wins", () => {
    const stage = selected(change({ status: "SPECCING" }), { specBattleState: specBattle("not_started") });
    assert.equal(stage.id, "spec");
    assert.equal(stage.state, "running");
  });

  it("maps BLOCKED.blockedPhase to the corresponding UI stage when possible", () => {
    const cases: Array<[string, UiStageId]> = [
      ["refine", "refine"],
      ["intake", "prd"],
      ["prd", "prd"],
      ["prd_briefing_questions", "prd"],
      ["prd_briefing_draft", "prd"],
      ["prd_briefing_final_review", "prd"],
      ["spec", "spec"],
      ["spec_critic", "spec"],
      ["tech_spec", "tech_spec"],
      ["plan", "plan"],
      ["generate_plan", "plan"],
      ["test_plan", "test_plan"],
      ["build", "build"],
      ["implement", "build"],
      ["review", "review"],
      ["fix", "fix"],
      ["fix_findings", "fix"],
      ["check", "qa"],
      ["local_check", "qa"],
      ["qa", "qa"],
      ["merge", "merge"],
      ["release", "merge"],
      ["retro", "retro"],
    ];

    for (const [blockedPhase, id] of cases) {
      const stage = selected(change({ status: "BLOCKED", blockedPhase }));
      assert.equal(stage.id, id, blockedPhase);
      assert.equal(stage.state, "blocked", blockedPhase);
    }
  });

  it("keeps unknown statuses compatible with the current default review phase behavior", () => {
    assert.equal(selected(change({ status: "TOTALLY_NEW_STATUS" })).id, "plan");
  });
});
