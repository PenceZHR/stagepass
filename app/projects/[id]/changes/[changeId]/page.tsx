"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CodexTaskControl } from "./codex-task-control";
import { EmergencyInteractionPanel } from "./emergency-interaction-panel";
import { changeApi } from "./change-api-client";
import { ArtifactsPanel } from "./artifacts-panel";
import { BuildSandbox } from "./build-sandbox";
import { ChangedFilesPanel } from "./changed-files-panel";
import { EventStreamPanel } from "./event-stream-panel";
import { FindingsPanel } from "./findings-panel";
import { PlanSandbox } from "./plan-sandbox";
import { PrdBriefingRoom } from "./prd-briefing-room";
import { ReviewReportCenter } from "./review-report-center";
import { TestPlanSandbox } from "./testplan-sandbox";
import { FailedRunBanner } from "./failed-run-banner";
import { OperationalPhasePanel } from "./operational-phase-panel";
import { PhaseReviewPanel, type PhaseReviewResponse } from "./phase-review-panel";
import { PipelinePageShell } from "./pipeline-page-shell";
import { PhaseStageShell } from "./phase-stage-shell";
import { RubricPanel } from "./rubric-panel";
import { buildUiPipelineState, UI_STAGE_ORDER } from "./pipeline-ui-model";
import type { StageActionView } from "./stage-action-bar";
import type { StageBlockerView } from "./stage-frame";
import {
  GatePanel,
  buildRunningSpecBattleGateState,
  selectRoutableStageRunActions,
} from "./gate-panel";
import { usePipelineActions } from "./use-pipeline-actions";
import { useChangeDetailData } from "./use-change-detail-data";
import { useChangeCommands } from "./use-change-commands";
import {
  createPipelinePreflightPayload,
  findPipelineAction,
  pipelineActionDisabledReason,
  type PipelineActionContract,
} from "./pipeline-action-contract";
import { buildDeliveryStageActions } from "./delivery-stage-actions";
import {
  getReviewPhaseForRunPhase,
  reviewPhaseToRubricPhase,
  shouldPollChangeDetailParent,
  visibleChangeStatus,
  type ReviewPhase,
} from "./change-phase-map";
import type { ChangeDetail } from "./change-detail-types";
import type { GateStatus } from "./gate-types";

const GENERAL_ACTION_IDS = [
  "run_plan",
  "retry_plan",
  "run_test_plan",
  "retry_test_plan",
  "run_build",
  "retry_build",
  "run_review",
  "retry_review",
  "run_qa",
  "retry_qa",
  "run_retro",
  "run_tech_spec",
  "retry_tech_spec",
];

const EMPTY_PIPELINE_ACTIONS: PipelineActionContract[] = [];

function operationalActionRole(actionId: string): StageActionView["role"] {
  if (actionId.startsWith("retry_")) return "secondary";
  if (actionId.startsWith("run_")) {
    return "primary";
  }
  return "secondary";
}

function buildMergeReadinessBlockers(mergeChecks: GateStatus["mergeChecks"] | undefined): StageBlockerView[] {
  if (!mergeChecks) return [];

  const missing = mergeChecks.missing.length > 0
    ? `Missing: ${mergeChecks.missing.join(", ")}`
    : undefined;
  const blockers: StageBlockerView[] = [];

  if (!mergeChecks.qaPassed) {
    blockers.push({
      id: "merge-readiness-qa",
      label: "QA 未通过",
      description: missing,
      severity: "warning",
    });
  }
  if (!mergeChecks.reviewPassed) {
    blockers.push({
      id: "merge-readiness-review",
      label: "Review 未通过",
      description: missing,
      severity: "warning",
    });
  }
  if (!mergeChecks.docsComplete) {
    blockers.push({
      id: "merge-readiness-docs",
      label: "Docs 未完成",
      description: missing,
      severity: "info",
    });
  }
  if (mergeChecks.requirementGapsPassed === false || (mergeChecks.mergeBlockingRequirementGaps ?? 0) > 0) {
    blockers.push({
      id: "merge-readiness-requirements",
      label: `Requirements ${mergeChecks.mergeBlockingRequirementGaps ?? 0} blocking`,
      description: missing,
      severity: "warning",
    });
  }
  if (blockers.length === 0 && mergeChecks.missing.length > 0) {
    blockers.push({
      id: "merge-readiness-missing",
      label: "缺少 Merge readiness 项",
      description: missing,
      severity: "info",
    });
  }

  return blockers;
}

function DoneCompletionPanel({ change }: { change: ChangeDetail }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-4" data-done-completion-panel>
      <h3 className="text-sm font-semibold">Completion summary</h3>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Change id</dt>
          <dd className="font-mono font-medium">{change.id}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="font-medium">{visibleChangeStatus(change)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Updated</dt>
          <dd className="font-medium">{change.updatedAt}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Branch</dt>
          <dd className="font-mono font-medium">{change.gitBranch ?? "none"}</dd>
        </div>
      </dl>
    </div>
  );
}

export default function ChangeDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string; changeId: string }>();
  const { id: projectId, changeId } = params;
  const [selectedPhase, setSelectedPhase] = useState<{
    changeId: string;
    phase: ReviewPhase;
  } | null>(null);
  const [gateBusy, setGateBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [buildStageActions, setBuildStageActions] = useState<StageActionView[]>([]);
  const [buildStageActionError, setBuildStageActionError] = useState<string | null>(null);
  const [reviewStageActions, setReviewStageActions] = useState<StageActionView[]>([]);
  const [reviewStageActionError, setReviewStageActionError] = useState<string | null>(null);
  const [prdStageActions, setPrdStageActions] = useState<StageActionView[]>([]);
  const [codexBusy, setCodexBusy] = useState(false);
  const {
    change, phaseOverviews, setPhaseOverviews,
    gateStatus, gateLoading, gateError, setGateError,
    specBattleState, planSandboxState, testPlanSandboxState, prdBriefingState,
    reviewCenterState, setReviewCenterState,
    changeError, codexHealth, currentInteraction,
    load, loadGateStatus, loadSpecBattleState,
    loadPlanSandboxState, loadTestPlanSandboxState, loadPrdBriefingState,
    loadReviewCenterState,
    refreshChangeDetailPage, refreshAfterAction,
  } = useChangeDetailData(projectId, changeId);

  const { running, actionError, handleAction } = usePipelineActions({
    projectId,
    changeId,
    actions: gateStatus?.actions,
    refresh: refreshAfterAction,
  });
  const pipelineActions = gateStatus?.actions ?? EMPTY_PIPELINE_ACTIONS;

  const shouldPollParent = shouldPollChangeDetailParent({
    change,
    running,
    gateBusy,
    specBattleState,
    reviewCenterState,
  });
  const explicitSelectedPhase =
    selectedPhase?.changeId === changeId ? selectedPhase.phase : null;
  const uiPipelineState = useMemo(() => change ? buildUiPipelineState({
    change,
    selectedPhase: explicitSelectedPhase,
    phaseOverviews,
    reviewCenterState,
    gateStatus,
    specBattleState,
  }) : null, [
    change,
    explicitSelectedPhase,
    phaseOverviews,
    reviewCenterState,
    gateStatus,
    specBattleState,
  ]);
  const selectedStage = uiPipelineState?.selectedStage ?? null;
  const activeSelectedPhase = selectedStage?.reviewPhase ?? "Retro";
  const fallbackRubricPhase = reviewPhaseToRubricPhase(activeSelectedPhase);
  const fetchPhase = selectedStage?.recordPhase ?? null;
  const showingBuildSandbox = activeSelectedPhase === "Build" || activeSelectedPhase === "Fix";

  useEffect(() => {
    if (!shouldPollParent) return;
    const interval = setInterval(() => {
      void refreshChangeDetailPage();
    }, 3000);
    return () => clearInterval(interval);
  }, [shouldPollParent, refreshChangeDetailPage]);

  useEffect(() => {
    if (!change || !fetchPhase) return;
    fetch(`/api/projects/${projectId}/changes/${changeId}/phases?phase=${encodeURIComponent(fetchPhase)}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data: PhaseReviewResponse | null) => {
        if (data?.phases) setPhaseOverviews(data.phases);
      })
      .catch(() => {});
  }, [projectId, changeId, change, fetchPhase, setPhaseOverviews]);

  const { handleRestartSpecBattle } = useChangeCommands({
    projectId,
    changeId,
    gateStatus,
    load,
    loadGateStatus,
    loadSpecBattleState,
    setGateBusy,
    setGateError,
    setPhaseOverviews,
    setSelectedPhase,
  });


  const handleRegenerateSpecBattleReport = useCallback(async () => {
    setGateBusy(true);
    setGateError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/spec-battle/report`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Report generation failed");
    } catch (err) {
      setGateError(String(err));
    } finally {
      setGateBusy(false);
      loadGateStatus();
      loadSpecBattleState();
      loadPlanSandboxState();
      loadTestPlanSandboxState();
    }
  }, [projectId, changeId, loadGateStatus, loadSpecBattleState, loadPlanSandboxState, loadTestPlanSandboxState, setGateError]);

  const handleRegeneratePlanSandboxReport = useCallback(async () => {
    const reportAction = findPipelineAction(gateStatus?.actions, "regenerate_plan_report");
    const disabledReason = pipelineActionDisabledReason(reportAction);
    if (disabledReason) {
      setGateError(disabledReason);
      return;
    }
    setGateBusy(true);
    setGateError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/plan-sandbox/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createPipelinePreflightPayload(reportAction)),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Plan sandbox report failed");
    } catch (err) {
      setGateError(String(err));
    } finally {
      setGateBusy(false);
      loadPlanSandboxState();
    }
  }, [projectId, changeId, gateStatus?.actions, loadPlanSandboxState, setGateError]);

  const planStageBusy = gateBusy || running;
  const planStageActionError = gateError || actionError;
  const planStageActions = useMemo<StageActionView[]>(() => {
    const makePlanStageAction = (
      actionId: string,
      label: string,
      role: StageActionView["role"],
      onAction: StageActionView["onAction"],
    ): StageActionView => {
      const action = findPipelineAction(gateStatus?.actions, actionId);
      const disabledReason = pipelineActionDisabledReason(action);

      return {
        id: `${activeSelectedPhase}-${actionId}`,
        label,
        role,
        enabled: disabledReason === null,
        busy: planStageBusy,
        disabledReason,
        sourceActionId: actionId,
        onAction,
      };
    };

    if (activeSelectedPhase === "TestPlan") {
      return [
        makePlanStageAction("run_test_plan", "生成测试计划", "primary", () => handleAction("run_test_plan")),
        // The only way out of a TestPlan run killed mid-flight. TESTPLANNING
        // resolves to this same sandbox panel (pipeline-ui-model), where
        // run_test_plan and approve_plan are both correctly disabled -- so
        // without this the user sees a fully disabled bar and no path forward,
        // the 63db7793 dead end one stage earlier. retry_test_plan is declared
        // on the stage and in GENERAL_ACTION_IDS, but that fallback bar is
        // unreachable here: showingTestPlanSandbox short-circuits ahead of it.
        makePlanStageAction("retry_test_plan", "重新生成测试计划", "secondary", () => handleAction("retry_test_plan")),
      ];
    }

    if (activeSelectedPhase === "Plan") {
      return [
        makePlanStageAction("run_plan", "生成计划", "primary", () => handleAction("run_plan")),
        // The only way out of a Plan run killed mid-flight. PLANNING resolves to
        // this same sandbox panel (pipeline-ui-model), where run_plan and
        // approve_plan are both correctly disabled -- so without this the user
        // sees a fully disabled bar and no path forward, the 0d6d6d6b dead end
        // one stage over. retry_plan is in GENERAL_ACTION_IDS but that fallback
        // bar is unreachable here: showingPlanSandbox short-circuits ahead of it.
        makePlanStageAction("retry_plan", "重新生成计划", "secondary", () => handleAction("retry_plan")),
        makePlanStageAction("regenerate_plan_report", "刷新计划审查", "secondary", handleRegeneratePlanSandboxReport),
      ];
    }

    return [];
  }, [
    activeSelectedPhase,
    gateStatus?.actions,
    planStageBusy,
    handleAction,
    handleRegeneratePlanSandboxReport,
  ]);

  const buildOrFixStageActions = buildStageActions;
  const buildOrFixStageActionError = activeSelectedPhase === "Fix"
    ? [buildStageActionError, actionError].filter(Boolean).join("；") || null
    : buildStageActionError;
  const prdBriefingStageActions = useMemo<StageActionView[]>(() => {
    const runSpecAction = findPipelineAction(gateStatus?.actions, "run_spec");
    if (!runSpecAction) return prdStageActions;

    const disabledReason = pipelineActionDisabledReason(runSpecAction);
    const baseActions = prdStageActions.filter(
      (action) => action.sourceActionId !== "lock_prd" || action.enabled,
    );

    return [
      ...baseActions,
      {
        id: "prd-run_spec",
        label: runSpecAction.label ?? "开始 Spec 对抗",
        role: "primary",
        enabled: disabledReason === null,
        busy: gateBusy || running,
        disabledReason,
        sourceActionId: "run_spec",
        onAction: handleRestartSpecBattle,
      },
    ];
  }, [gateBusy, gateStatus?.actions, handleRestartSpecBattle, prdStageActions, running]);
  const retroStageAction = findPipelineAction(pipelineActions, "run_retro");
  const retroStageActions = useMemo<StageActionView[]>(() => {
    const disabledReason = pipelineActionDisabledReason(retroStageAction);

    return [{
      id: "retro-run_retro",
      label: retroStageAction?.label ?? "Run Retro",
      role: "primary",
      enabled: disabledReason === null,
      busy: running,
      disabledReason,
      sourceActionId: "run_retro",
      onAction: () => handleAction("run_retro"),
    }];
  }, [handleAction, retroStageAction, running]);
  const deliveryStageAction = findPipelineAction(pipelineActions, "run_delivery");
  const deliveryStageActions = useMemo<StageActionView[]>(
    () => buildDeliveryStageActions({
      deliveryAction: deliveryStageAction,
      busy: running,
      onAction: handleAction,
    }),
    [deliveryStageAction, handleAction, running],
  );
  const gateStageActions = useMemo<StageActionView[]>(
    () => selectRoutableStageRunActions(
      gateStatus?.actions,
      activeSelectedPhase === "TechSpec"
        ? ["run_tech_spec", "retry_tech_spec"]
        : ["run_spec", "retry_spec"],
    ).map((action) => {
      const disabledReason = pipelineActionDisabledReason(action);
      return {
        id: `gate-${action.actionId}`,
        label: action.label,
        role: operationalActionRole(action.actionId),
        enabled: disabledReason === null,
        busy: running || gateBusy,
        disabledReason,
        sourceActionId: action.actionId,
        onAction: () => handleAction(action.actionId),
      };
    }),
    [
      activeSelectedPhase,
      gateBusy,
      gateStatus?.actions,
      handleAction,
      running,
    ],
  );
  const operationalContractPhase = activeSelectedPhase === "Check"
    ? "QA"
    : activeSelectedPhase === "Merge"
      ? "Merge"
      : null;
  const operationalActionIds = useMemo(() => selectedStage?.actionIds ?? [], [selectedStage?.actionIds]);
  const operationalActions = useMemo(
    () => operationalContractPhase
      ? pipelineActions.filter((action) => action.phase === operationalContractPhase)
        .filter((action) => operationalActionIds.includes(action.actionId))
        .filter((action) => action.actionId.startsWith("run_") || action.actionId.startsWith("retry_"))
      : [],
    [operationalActionIds, operationalContractPhase, pipelineActions],
  );
  const operationalStageBusy = running || (activeSelectedPhase === "Merge" && (gateBusy || gateLoading));
  const operationalStageActions = useMemo<StageActionView[]>(() => {
    return operationalActions.map((action) => {
      const disabledReason = pipelineActionDisabledReason(action);
      return {
        id: `operational-${action.actionId}`,
        label: action.label,
        role: operationalActionRole(action.actionId),
        enabled: disabledReason === null,
        busy: operationalStageBusy,
        disabledReason,
        sourceActionId: action.actionId,
        onAction: () => handleAction(action.actionId),
      };
    });
  }, [handleAction, operationalActions, operationalStageBusy]);
  const operationalStageActionError = activeSelectedPhase === "Merge"
    ? [actionError, gateError].filter(Boolean).join("；") || null
    : actionError;
  const operationalStageBlockers = useMemo<StageBlockerView[]>(() => {
    const actionBlockers = operationalActions.flatMap((action) => {
      const disabledReason = pipelineActionDisabledReason(action);
      const reasonBlocker: StageBlockerView[] = disabledReason
        ? [{
            id: `operational-blocker-${action.actionId}`,
            label: `${action.label} 不可用`,
            description: disabledReason,
            severity: "warning",
          }]
        : [];
      const contractBlockers: StageBlockerView[] = action.blockers.map((blocker) => ({
        id: `operational-contract-blocker-${action.actionId}-${blocker.id}`,
        label: `${blocker.severity}: ${blocker.title}`,
        description: `${action.label} readiness check`,
        severity: blocker.severity === "P0" ? "error" : "warning",
      }));
      const warningBlockers: StageBlockerView[] = action.warnings.map((warning) => ({
        id: `operational-contract-warning-${action.actionId}-${warning.id}`,
        label: warning.title,
        description: `${action.label} readiness warning`,
        severity: "info",
      }));

      return [...contractBlockers, ...warningBlockers, ...reasonBlocker];
    });
    const mergeReadinessBlockers = activeSelectedPhase === "Merge"
      ? buildMergeReadinessBlockers(gateStatus?.mergeChecks)
      : [];

    return [...actionBlockers, ...mergeReadinessBlockers];
  }, [activeSelectedPhase, gateStatus?.mergeChecks, operationalActions]);
  const reviewStageBlockers = useMemo<StageBlockerView[]>(() => {
    const findings = reviewCenterState?.findings ?? [];
    return findings
      .filter((finding) => finding.status === "open" && (finding.severity === "P0" || finding.severity === "P1"))
      .map((finding) => {
        const location = finding.file
          ? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
          : "未绑定文件";
        const details = [
          location,
          finding.evidence ? `证据: ${finding.evidence}` : null,
          finding.requiredFix ? `必须修复: ${finding.requiredFix}` : null,
        ].filter(Boolean).join("；");

        return {
          id: finding.id,
          label: `${finding.severity}: ${finding.title}`,
          description: details,
          severity: finding.severity === "P0" ? "error" : "warning",
        };
      });
  }, [reviewCenterState?.findings]);

  const handleRunReviewAction = useCallback((actionId: "run_review" | "retry_review") => {
    handleAction(actionId);
  }, [handleAction]);

  const handleBuildSandboxChanged = useCallback(() => {
    setPhaseOverviews(undefined);
    load();
    loadGateStatus();
    loadSpecBattleState();
    loadPlanSandboxState();
    loadTestPlanSandboxState();
    loadReviewCenterState();
  }, [load, loadGateStatus, loadSpecBattleState, loadPlanSandboxState, loadTestPlanSandboxState, loadReviewCenterState, setPhaseOverviews]);

  const handleSelectPhase = useCallback(
    (phase: ReviewPhase) => {
      setSelectedPhase({ changeId, phase });
    },
    [changeId]
  );

  const handleReworked = useCallback(() => {
    setSelectedPhase(null);
    setPhaseOverviews(undefined);
    load();
    loadPlanSandboxState();
    loadTestPlanSandboxState();
  }, [load, loadPlanSandboxState, loadTestPlanSandboxState, setPhaseOverviews]);

  const handlePrdBriefingLocked = useCallback(() => {
    setSelectedPhase(null);
    setPhaseOverviews(undefined);
    load();
    loadGateStatus();
    loadSpecBattleState();
    loadPlanSandboxState();
    loadTestPlanSandboxState();
    loadPrdBriefingState();
  }, [load, loadGateStatus, loadSpecBattleState, loadPlanSandboxState, loadTestPlanSandboxState, loadPrdBriefingState, setPhaseOverviews]);

  if (!change && changeError) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <Link
          href={`/projects/${projectId}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Change Board
        </Link>
        <div className="mt-6 rounded-lg border bg-background p-6">
          <h1 className="text-lg font-semibold">Change not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">{changeError}</p>
        </div>
      </div>
    );
  }

  if (!change) {
    return <div className="p-8">Loading...</div>;
  }

  const currentChange = change;
  const visibleContractActions = pipelineActions.filter(
    (action) => GENERAL_ACTION_IDS.includes(action.actionId) && action.enabled,
  );
  const hasActiveRun = change.latestRun?.status === "running";
  const isRunning = hasActiveRun || [
    "PLANNING",
    "REVIEWING",
    "FIXING",
    "CHECKING",
    "SPECCING",
    "TECHSPECCING",
    "TESTPLANNING",
    "MERGING",
  ].includes(change.status);
  const codexControl = change.codexControl ?? {
    bindingTitle: null,
    bindingStatus: "detached",
    threadId: null,
    lastTurnId: null,
    lastObservationCursor: null,
    lastSeenAt: null,
    lastErrorCode: null,
    currentInteractionId: null,
    codexDecisionEnabled: false,
    model: null,
    reasoningEffort: null,
    decisionPhase: null,
    interactionKind: null,
  };
  const codexApi = changeApi(projectId, changeId);
  const startControlAction = pipelineActions.find(
    (action) => action.enabled && action.actionId.startsWith("run_"),
  );
  const retryControlAction = pipelineActions.find(
    (action) => action.enabled && action.actionId.startsWith("retry_"),
  );

  async function runCodexControlAction(action: () => Promise<unknown>) {
    setCodexBusy(true);
    setGateError("");
    try {
      await action();
      await refreshChangeDetailPage();
    } catch (error) {
      setGateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCodexBusy(false);
    }
  }

  async function handleDeleteChange() {
    if (isRunning || deleteBusy) return;
    if (!window.confirm(`确定删除 ${currentChange.id}？相关文件也会被清除。`)) return;

    setDeleteBusy(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${currentChange.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "删除失败");
      }
      router.push(`/projects/${projectId}`);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
    }
  }

  if (!uiPipelineState || !selectedStage) {
    return <div className="p-8">Loading...</div>;
  }

  const selectedStageState = selectedStage.state;
  const selectedIsFuture =
    UI_STAGE_ORDER.indexOf(selectedStage.id)
    > UI_STAGE_ORDER.indexOf(uiPipelineState.activeStage.id);
  const showingRetroStage = selectedStage.id === "retro";
  const showingDoneStage = selectedStage.id === "done";
  const latestFailedRun = change.latestRun?.status === "failed" ? change.latestRun : null;
  const latestFailedPhase = latestFailedRun ? getReviewPhaseForRunPhase(latestFailedRun.phase) : null;
  const showingOperationalPhaseSummary = activeSelectedPhase === "Check" || activeSelectedPhase === "Merge";
  // Fix phase should also show PhaseReviewPanel
  const showingReviewPhase = explicitSelectedPhase !== null || change.status === "BLOCKED" || showingOperationalPhaseSummary || activeSelectedPhase === "Fix";
  const showingReviewReportCenter = activeSelectedPhase === "Review";
  const showingPrdBriefingRoom = activeSelectedPhase === "Intake";
  const showingPlanSandbox = activeSelectedPhase === "Plan";
  const showingTestPlanSandbox = activeSelectedPhase === "TestPlan";
  const showingSpecOrTechSpecGate = activeSelectedPhase === "Spec" || activeSelectedPhase === "TechSpec";
  const activeSpecBattleFallback = change.status === "SPECCING" ||
    (change.status === "BLOCKED" && change.blockedPhase === "spec") ||
    ["not_started", "red_running", "blue_running", "failed"].includes(specBattleState?.latestRound?.status ?? "")
    ? buildRunningSpecBattleGateState(specBattleState)
    : null;
  const isSpecBattleMode = Boolean(
    (gateStatus?.atGate && gateStatus.gate === "spec" && gateStatus.specBattle) ||
    activeSpecBattleFallback
  );
  const stageStatusLabel = visibleChangeStatus(change);
  const latestRunStatusLabel = change.latestRun?.status ?? null;
  const renderPhaseRecords = (
    phase: ReviewPhase,
    keySuffix = "records",
    readOnly = false,
  ) => (
    <PhaseReviewPanel
      key={`${phase}-${keySuffix}`}
      projectId={projectId}
      changeId={changeId}
      phase={phase}
      changeStatus={change.status}
      latestRunStatus={latestRunStatusLabel}
      readOnly={readOnly}
      onReviewLoaded={setPhaseOverviews}
      onReworked={readOnly ? undefined : handleReworked}
    />
  );

  return (
    <>
      <PipelinePageShell
        key={changeId}
        projectId={projectId}
        change={change}
        activeStage={uiPipelineState.activeStage}
        selectedStage={selectedStage}
        stages={uiPipelineState.stages}
        selectedPhase={activeSelectedPhase}
        phaseOverviews={phaseOverviews}
        reviewCenterState={reviewCenterState}
        isSpecBattleMode={isSpecBattleMode}
        isRunning={isRunning}
        deleteBusy={deleteBusy}
        deleteError={deleteError}
        onDeleteChange={handleDeleteChange}
        onSelectPhase={handleSelectPhase}
      >
        <CodexTaskControl
          control={codexControl}
          health={codexHealth}
          readOnly={selectedIsFuture}
          busy={codexBusy}
          onOpen={() => runCodexControlAction(() => codexApi.openCodexTask())}
          onInterrupt={() => runCodexControlAction(() => codexApi.interruptCodexTurn())}
          onStart={() => runCodexControlAction(async () => {
            if (!startControlAction) throw new Error("No start action is available");
            await handleAction(startControlAction.actionId);
          })}
          onRetry={() => runCodexControlAction(async () => {
            if (!retryControlAction) throw new Error("No retry action is available");
            await handleAction(retryControlAction.actionId);
          })}
          onRepair={() => runCodexControlAction(refreshChangeDetailPage)}
          onSaveSettings={(settings) =>
            runCodexControlAction(() => codexApi.saveCodexSettings(settings))}
        />
        {!selectedIsFuture ? (
          <EmergencyInteractionPanel
            health={codexHealth}
            codexDecisionEnabled={codexControl.codexDecisionEnabled}
            interaction={currentInteraction}
            busy={codexBusy}
            onSubmit={({ actionId, reason }) => runCodexControlAction(async () => {
              if (
                !currentInteraction?.gateVersion
                || !currentInteraction.sourceDbHash
              ) {
                throw new Error("Emergency interaction envelope is incomplete");
              }
              await codexApi.executeCommand({
                actionId,
                expectedGateVersion: currentInteraction.gateVersion,
                expectedSourceDbHash: currentInteraction.sourceDbHash,
                expectedHeadSha: currentInteraction.expectedHeadSha ?? null,
                idempotencyKey: `web-emergency:${currentInteraction.id}:${actionId}`,
                payload: { reason, interactionId: currentInteraction.id },
              });
            })}
          />
        ) : null}
        {latestFailedRun && (
          <FailedRunBanner
            run={latestFailedRun}
            phase={latestFailedPhase}
            explicitSelectedPhase={explicitSelectedPhase}
            onSelectPhase={(phase) => setSelectedPhase({ changeId, phase })}
            changeId={changeId}
          />
        )}

        {/* Refining: Chat UI — constrained to viewport */}
        {selectedIsFuture ? (
              <PhaseStageShell
                projectId={projectId}
                changeId={changeId}
                phase={activeSelectedPhase}
                state={selectedStageState}
                statusLabel={stageStatusLabel}
                latestRunStatus={latestRunStatusLabel}
                readOnly
                records={renderPhaseRecords(
                  activeSelectedPhase,
                  "future-preview-records",
                  true,
                )}
              >
                <div
                  className="rounded-lg border border-dashed bg-muted/10 p-4"
                  data-future-stage-overview
                >
                  <h3 className="text-sm font-semibold">未来阶段概览</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    当前 Change 尚未进入此阶段。这里仅展示阶段目标、评判标准和已有记录；
                    执行工作区会在流程到达后开放。
                  </p>
                </div>
              </PhaseStageShell>
            ) : showingRetroStage ? (
              <PhaseStageShell
                projectId={projectId}
                changeId={changeId}
                phase="Retro"
                state={selectedStageState}
                statusLabel={stageStatusLabel}
                latestRunStatus={latestRunStatusLabel}
                actions={retroStageActions}
                actionError={actionError}
                records={renderPhaseRecords("Retro", "retro-records")}
              >
                <div className="rounded-lg border bg-muted/20 p-4" data-retro-stage>
                  <h3 className="text-sm font-semibold">Retro waiting</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    The change is delivered and waiting for the final retro action.
                  </p>
                </div>
              </PhaseStageShell>
            ) : showingDoneStage ? (
              // Done is a stage now, not a completion screen (design §3): it runs
              // the delivery stage, owns delivery.md and answers the Done producer
              // rubric. It therefore goes through PhaseStageShell like every other
              // stage -- that shell is what carries the action bar, the phase
              // records and the rubric drawer, all three of which a StageFrame has
              // no way to render.
              <PhaseStageShell
                projectId={projectId}
                changeId={changeId}
                phase="Done"
                state={selectedStageState}
                statusLabel={stageStatusLabel}
                latestRunStatus={latestRunStatusLabel}
                actions={deliveryStageActions}
                actionError={actionError}
                records={renderPhaseRecords("Done", "done-records")}
              >
                {change.status === "DONE" ? (
                  <DoneCompletionPanel change={change} />
                ) : (
                  <div className="rounded-lg border bg-muted/20 p-4" data-delivery-stage>
                    <h3 className="text-sm font-semibold">交付单待生成</h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Retro 已完成。运行交付阶段产出交付单：怎么跑起来、这次改了什么、
                      文件地图、以及还有哪些没做。
                    </p>
                  </div>
                )}
              </PhaseStageShell>
            ) : showingBuildSandbox ? (
              <PhaseStageShell
                projectId={projectId}
                changeId={changeId}
                phase={activeSelectedPhase === "Fix" ? "Fix" : "Build"}
                state={selectedStageState}
                statusLabel={stageStatusLabel}
                latestRunStatus={latestRunStatusLabel}
                actions={buildOrFixStageActions}
                actionError={buildOrFixStageActionError}
                records={renderPhaseRecords(activeSelectedPhase === "Fix" ? "Fix" : "Build", "build-records")}
              >
                <BuildSandbox
                  projectId={projectId}
                  changeId={changeId}
                  actions={pipelineActions}
                  refreshToken={`${change.status}:${change.latestRun?.id ?? "none"}:${change.latestRun?.status ?? "none"}:${change.updatedAt ?? ""}`}
                  onStageActionsChange={setBuildStageActions}
                  onStageActionError={setBuildStageActionError}
                  onChanged={handleBuildSandboxChanged}
                />
              </PhaseStageShell>
            ) : showingTestPlanSandbox ? (
              <PhaseStageShell
                projectId={projectId}
                changeId={changeId}
                phase="TestPlan"
                state={selectedStageState}
                statusLabel={stageStatusLabel}
                latestRunStatus={latestRunStatusLabel}
                actions={planStageActions}
                actionError={planStageActionError}
                records={renderPhaseRecords("TestPlan", "testplan-records")}
              >
                <TestPlanSandbox
                  state={testPlanSandboxState}
                  loading={gateLoading}
                />
              </PhaseStageShell>
            ) : showingPlanSandbox ? (
              <PhaseStageShell
                projectId={projectId}
                changeId={changeId}
                phase="Plan"
                state={selectedStageState}
                statusLabel={stageStatusLabel}
                latestRunStatus={latestRunStatusLabel}
                actions={planStageActions}
                actionError={planStageActionError}
                records={renderPhaseRecords("Plan", "plan-records")}
              >
                <PlanSandbox
                  projectId={projectId}
                  changeId={changeId}
                  state={planSandboxState}
                  loading={gateLoading}
                />
              </PhaseStageShell>
            ) : showingPrdBriefingRoom ? (
              <PhaseStageShell
                projectId={projectId}
                changeId={changeId}
                phase="Intake"
                state={selectedStageState}
                statusLabel={stageStatusLabel}
                latestRunStatus={latestRunStatusLabel}
                actions={prdBriefingStageActions}
                records={renderPhaseRecords("Intake", "prd-records")}
              >
                <PrdBriefingRoom
                  projectId={projectId}
                  changeId={changeId}
                  initialState={prdBriefingState}
                  onLocked={handlePrdBriefingLocked}
                  onStageActionsChange={setPrdStageActions}
                  codexDecisionEnabled={codexControl.codexDecisionEnabled}
                  interactionStatus={currentInteraction ? "pending" : null}
                  onOpenInCodex={() => {
                    void runCodexControlAction(() => codexApi.openCodexTask());
                  }}
                />
              </PhaseStageShell>
            ) : showingSpecOrTechSpecGate ? (
              <PhaseStageShell
                projectId={projectId}
                changeId={changeId}
                phase={activeSelectedPhase}
                state={selectedStageState}
                statusLabel={stageStatusLabel}
                latestRunStatus={latestRunStatusLabel}
                actions={gateStageActions}
                actionError={gateError}
                records={renderPhaseRecords(activeSelectedPhase, "gate-records")}
              >
                <GatePanel
                  projectId={projectId}
                  changeId={changeId}
                  gateStatus={gateStatus}
                  specBattleFallback={activeSpecBattleFallback}
                  loading={gateLoading}
                  busy={gateBusy}
                  error={gateError}
                  onRestartBattle={handleRestartSpecBattle}
                  onRegenerateReport={handleRegenerateSpecBattleReport}
                  specBattleState={specBattleState}
                />
              </PhaseStageShell>
            ) : showingReviewReportCenter ? (
              <PhaseStageShell
                projectId={projectId}
                changeId={changeId}
                phase="Review"
                state={selectedStageState}
                statusLabel={stageStatusLabel}
                latestRunStatus={latestRunStatusLabel}
                actions={reviewStageActions}
                actionError={reviewStageActionError || actionError}
                blockers={reviewStageBlockers}
                records={renderPhaseRecords("Review", "review-records")}
              >
                <ReviewReportCenter
                  projectId={projectId}
                  changeId={changeId}
                  initialState={reviewCenterState}
                  actions={pipelineActions}
                  busy={gateBusy || running}
                  onRunReview={handleRunReviewAction}
                  onStateChange={setReviewCenterState}
                  onStageActionsChange={setReviewStageActions}
                  onStageActionError={setReviewStageActionError}
                />
              </PhaseStageShell>
            ) : showingReviewPhase ? (
              showingOperationalPhaseSummary ? (
                <PhaseStageShell
                  projectId={projectId}
                  changeId={changeId}
                  phase={activeSelectedPhase}
                  state={selectedStageState}
                  statusLabel={stageStatusLabel}
                  latestRunStatus={latestRunStatusLabel}
                  actions={operationalStageActions}
                  actionError={operationalStageActionError}
                  blockers={operationalStageBlockers}
                  records={renderPhaseRecords(activeSelectedPhase, "operational-records")}
                >
                  <OperationalPhasePanel
                    phase={activeSelectedPhase === "Check" ? "Check" : "Merge"}
                    actionCount={operationalActions.length}
                    mergeChecks={activeSelectedPhase === "Merge" ? gateStatus?.mergeChecks : undefined}
                  />
                </PhaseStageShell>
              ) : (
                <PhaseStageShell
                  projectId={projectId}
                  changeId={changeId}
                  phase={activeSelectedPhase}
                  state={selectedStageState}
                  statusLabel={stageStatusLabel}
                  latestRunStatus={latestRunStatusLabel}
                >
                  {renderPhaseRecords(activeSelectedPhase, "phase-review")}
                </PhaseStageShell>
              )
            ) : (
              <>
                {/* Action Buttons */}
                <div className="mb-8 flex flex-wrap gap-2">
                  {visibleContractActions.map((action) => (
                    <Button
                      key={action.actionId}
                      variant="outline"
                      size="sm"
                      disabled={running}
                      onClick={() => handleAction(action.actionId)}
                    >
                      {action.label}
                    </Button>
                  ))}
                </div>
                {actionError && (
                  <p className="mb-4 text-sm text-red-500">{actionError}</p>
                )}

                {/*
                  The one branch that renders no PhaseStageShell, so the rubric
                  drawer the shell would otherwise supply is placed by hand.
                  §7.1 says every phase panel carries the entry point, and "this
                  status has no dedicated panel" is not a reason for a phase to
                  lose it.
                */}
                {fallbackRubricPhase ? (
                  <div className="mb-6">
                    <RubricPanel
                      projectId={projectId}
                      changeId={changeId}
                      phase={fallbackRubricPhase}
                    />
                  </div>
                ) : null}

                {/* Live Panels */}
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                  <EventStreamPanel projectId={projectId} changeId={changeId} />
                  <FindingsPanel projectId={projectId} changeId={changeId} />
                  <ChangedFilesPanel projectId={projectId} changeId={changeId} files={change.changedFiles || []} />
                  <ArtifactsPanel projectId={projectId} changeId={changeId} changeStatus={change.status} />
                </div>
              </>
            )}
      </PipelinePageShell>
    </>
  );
}
