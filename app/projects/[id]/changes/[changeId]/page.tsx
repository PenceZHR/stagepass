"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArtifactsPanel } from "./artifacts-panel";
import { ActionReasonDialog } from "./action-reason-dialog";
import {
  selectPlanRiskWaiverContext,
  selectSpecBattleDecisionContext,
  selectSpecRiskWaiverContext,
} from "./action-reason-context";
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
import { RefineChatPanel } from "./refine-chat-panel";
import { RubricPanel } from "./rubric-panel";
import { ProviderPicker } from "./provider-picker";
import { StageGitPanel } from "./stage-git-panel";
import { selectVisibleGitStageActions } from "./git-action-policy";
import { buildUiPipelineState } from "./pipeline-ui-model";
import type { StageActionView } from "./stage-action-bar";
import type { StageBlockerView } from "./stage-frame";
import {
  GatePanel,
  buildGateStageActions,
  buildRunningSpecBattleGateState,
  gateApprovalAction,
} from "./gate-panel";
import { usePipelineActions } from "./use-pipeline-actions";
import { useChangeDetailData } from "./use-change-detail-data";
import { useChangeCommands } from "./use-change-commands";
import {
  createPipelinePreflightPayload,
  findPipelineAction,
  pipelineActionDisabledReason,
  type AiProvider,
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
import type { BattleDecisionAction } from "./spec-battle-types";

const GENERAL_ACTION_IDS = [
  "approve_intake",
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
  "run_retro",
  "run_tech_spec",
  "retry_tech_spec",
  "merge",
];

const EMPTY_PIPELINE_ACTIONS: PipelineActionContract[] = [];

type ReasonDialogState =
  | {
      kind: "spec_battle_decision";
      action: BattleDecisionAction;
      targetId?: string | null;
    }
  | {
      kind: "accept_spec_risk";
      targetId: string;
    }
  | {
      kind: "waive_plan_risk";
      riskId: string;
    };

function operationalActionRole(actionId: string): StageActionView["role"] {
  if (actionId.startsWith("reject_")) return "destructive";
  if (actionId.startsWith("retry_") || actionId === "enter_qa") return "secondary";
  if (actionId.startsWith("approve_") || actionId.startsWith("run_") || actionId === "merge") {
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
  const [reasonDialog, setReasonDialog] = useState<ReasonDialogState | null>(null);
  const [buildStageActions, setBuildStageActions] = useState<StageActionView[]>([]);
  const [buildStageActionError, setBuildStageActionError] = useState<string | null>(null);
  const [reviewStageActions, setReviewStageActions] = useState<StageActionView[]>([]);
  const [reviewStageActionError, setReviewStageActionError] = useState<string | null>(null);
  const [prdStageActions, setPrdStageActions] = useState<StageActionView[]>([]);
  // This is intentionally ephemeral: a reload rehydrates from the Change default.
  const [selectedProvider, setSelectedProvider] = useState<AiProvider>("codex");
  const providerInitializedForChange = useRef<string | null>(null);
  const {
    change, phaseOverviews, setPhaseOverviews,
    gateStatus, setGateStatus, gateLoading, gateError, setGateError,
    specBattleState, planSandboxState, testPlanSandboxState, prdBriefingState,
    reviewCenterState, setReviewCenterState,
    changeError, load, loadGateStatus, loadSpecBattleState,
    loadPlanSandboxState, loadTestPlanSandboxState, loadPrdBriefingState,
    loadReviewCenterState,
    refreshChangeDetailPage, refreshAfterAction,
  } = useChangeDetailData(projectId, changeId);

  useEffect(() => {
    if (change?.id !== changeId || providerInitializedForChange.current === changeId) return;
    const initialProvider = change.provider;
    if (initialProvider !== "codex" && initialProvider !== "claude") return;
    providerInitializedForChange.current = changeId;
    queueMicrotask(() => setSelectedProvider(initialProvider));
  }, [change?.id, change?.provider, changeId]);

  const { running, actionError, handleAction } = usePipelineActions({
    projectId,
    changeId,
    actions: gateStatus?.actions,
    selectedProvider,
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

  const {
    handleApproveGate,
    handleRejectGate,
    handleRestartSpecBattle,
    handleApprovePlanSandbox,
  } = useChangeCommands({
    projectId,
    changeId,
    gateStatus,
    load,
    loadGateStatus,
    loadSpecBattleState,
    loadPlanSandboxState,
    loadTestPlanSandboxState,
    setGateBusy,
    setGateError,
    setGateStatus,
    setPhaseOverviews,
    setSelectedPhase,
    selectedProvider,
  });

  const handleStopSpecBattle = useCallback(async () => {
    setGateBusy(true);
    setGateError("");

    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/block`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase: "spec",
          reason: "Spec Battle terminated by human",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Spec Battle stop failed");
      setSelectedPhase(null);
      setPhaseOverviews(undefined);
    } catch (err) {
      setGateError(String(err));
    } finally {
      setGateBusy(false);
      load();
      loadGateStatus();
      loadSpecBattleState();
      loadPlanSandboxState();
      loadTestPlanSandboxState();
    }
  }, [projectId, changeId, load, loadGateStatus, loadSpecBattleState, loadPlanSandboxState, loadTestPlanSandboxState, setGateError, setPhaseOverviews]);


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

  const handleSpecBattleDecision = useCallback(async (
    action: BattleDecisionAction,
    targetId?: string | null,
    reason?: string
  ) => {
    if (reason === undefined) {
      setReasonDialog({ kind: "spec_battle_decision", action, targetId });
      return;
    }
    if (action === "waive_p1" && !targetId) return;
    setGateBusy(true);
    setGateError("");
    try {
      const continueActions: BattleDecisionAction[] = ["request_changes", "return_to_spec"];
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/spec-battle/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          targetType: action === "waive_p1" ? "requirement_gap" : null,
          targetId,
          reason,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Spec battle decision failed");
      if (continueActions.includes(action)) {
        const gateRes = await fetch(`/api/projects/${projectId}/changes/${changeId}/gate`);
        const latestGateStatus = (await gateRes.json()) as GateStatus;
        if (!gateRes.ok) throw new Error("Gate status refresh failed");
        const runSpecAction = findPipelineAction(latestGateStatus.actions, "run_spec");
        const disabledReason = pipelineActionDisabledReason(runSpecAction);
        if (disabledReason) throw new Error(disabledReason);
        const specRes = await fetch(`/api/projects/${projectId}/changes/${changeId}/spec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createPipelinePreflightPayload(runSpecAction, { provider: selectedProvider })),
        });
        await specRes.json().catch(() => null);
        if (!specRes.ok) {
          throw new Error("新一轮已创建，但启动失败，请点击启动本轮重试。");
        }
      }
      setSelectedPhase(null);
      setPhaseOverviews(undefined);
    } catch (err) {
      setGateError(String(err));
    } finally {
      setGateBusy(false);
      load();
      loadGateStatus();
      loadSpecBattleState();
      loadPlanSandboxState();
    }
  }, [projectId, changeId, load, loadGateStatus, loadSpecBattleState, loadPlanSandboxState, selectedProvider, setGateError, setPhaseOverviews]);

  const handleAcceptSpecBattleRisk = useCallback(async (targetId?: string | null) => {
    const needsWaiverReason = gateStatus?.specBattle?.actions.waiveP1.available
      && targetId
      && gateApprovalAction(gateStatus)?.enabled !== true
      && findPipelineAction(gateStatus?.actions, "run_tech_spec")?.enabled !== true;
    if (needsWaiverReason) {
      setReasonDialog({ kind: "accept_spec_risk", targetId });
      return;
    }
    setGateBusy(true);
    setGateError("");

    const startTechSpecAfterSpecApproval = async () => {
      const latestGateRes = await fetch(`/api/projects/${projectId}/changes/${changeId}/gate`);
      const latestGateData = await latestGateRes.json();
      if (!latestGateRes.ok) throw new Error(latestGateData.error || "Gate status refresh failed");
      const latestGateStatus = latestGateData as GateStatus;
      setGateStatus(latestGateStatus);
      const runAction = findPipelineAction(latestGateStatus.actions, "run_tech_spec");
      const disabledReason = pipelineActionDisabledReason(runAction);
      if (disabledReason) throw new Error(disabledReason);
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/tech-spec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createPipelinePreflightPayload(runAction, { provider: selectedProvider })),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "TechSpec start failed");
    };

    const postGateApprove = async (nextGateStatus: GateStatus | null) => {
      const approveAction = gateApprovalAction(nextGateStatus);
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/gate/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gate: "spec",
          expectedGateVersion: approveAction?.gateVersion,
          expectedSourceDbHash: approveAction?.sourceDbHash,
          idempotencyKey:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `spec-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data.action?.reason ??
            data.action?.reasonCode ??
            data.error ??
            "Spec gate approval failed",
        );
      }
    };

    try {
      const runTechSpecAction = findPipelineAction(gateStatus?.actions, "run_tech_spec");
      const canRunTechSpec = runTechSpecAction?.enabled === true;
      const canApprove = gateApprovalAction(gateStatus)?.enabled === true;
      const canWaiveP1 = gateStatus?.specBattle?.actions.waiveP1.available;
      let techSpecStarted = false;

      if (canApprove) {
        await postGateApprove(gateStatus);
      } else if (canRunTechSpec) {
        await startTechSpecAfterSpecApproval();
        techSpecStarted = true;
      } else if (canWaiveP1 && targetId) {
        throw new Error("接受 P1 风险需要填写理由");
      } else {
        throw new Error("当前战况不能接受风险并通过");
      }

      if (!techSpecStarted) {
        await startTechSpecAfterSpecApproval();
      }
      setSelectedPhase(null);
      setPhaseOverviews(undefined);
    } catch (err) {
      setGateError(String(err));
    } finally {
      setGateBusy(false);
      load();
      loadGateStatus();
      loadSpecBattleState();
      loadPlanSandboxState();
    }
  }, [projectId, changeId, gateStatus, load, loadGateStatus, loadSpecBattleState, loadPlanSandboxState, selectedProvider, setGateError, setGateStatus, setPhaseOverviews]);

  const submitAcceptSpecBattleRisk = useCallback(async (targetId: string, reason: string) => {
    setGateBusy(true);
    setGateError("");

    const startTechSpecAfterSpecApproval = async () => {
      const latestGateRes = await fetch(`/api/projects/${projectId}/changes/${changeId}/gate`);
      const latestGateData = await latestGateRes.json();
      if (!latestGateRes.ok) throw new Error(latestGateData.error || "Gate status refresh failed");
      const latestGateStatus = latestGateData as GateStatus;
      setGateStatus(latestGateStatus);
      const runAction = findPipelineAction(latestGateStatus.actions, "run_tech_spec");
      const disabledReason = pipelineActionDisabledReason(runAction);
      if (disabledReason) throw new Error(disabledReason);
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/tech-spec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createPipelinePreflightPayload(runAction, { provider: selectedProvider })),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "TechSpec start failed");
    };

    const postGateApprove = async (nextGateStatus: GateStatus | null) => {
      const approveAction = gateApprovalAction(nextGateStatus);
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/gate/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gate: "spec",
          expectedGateVersion: approveAction?.gateVersion,
          expectedSourceDbHash: approveAction?.sourceDbHash,
          idempotencyKey:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `spec-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data.action?.reason ??
            data.action?.reasonCode ??
            data.error ??
            "Spec gate approval failed",
        );
      }
    };

    const postDecision = async (payload: {
      action: BattleDecisionAction;
      targetType: "gate" | "requirement_gap" | "finding" | null;
      targetId: string | null;
      reason: string | null;
    }) => {
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/spec-battle/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Spec battle decision failed");
    };

    try {
      const canWaiveP1 = gateStatus?.specBattle?.actions.waiveP1.available;
      if (!canWaiveP1) throw new Error("当前战况不能接受风险并通过");
      await postDecision({
        action: "waive_p1",
        targetType: "requirement_gap",
        targetId,
        reason,
      });

      const reportRes = await fetch(`/api/projects/${projectId}/changes/${changeId}/spec-battle/report`, {
        method: "POST",
      });
      const reportData = await reportRes.json();
      if (!reportRes.ok) throw new Error(reportData.error || "Report generation failed");

      const gateRes = await fetch(`/api/projects/${projectId}/changes/${changeId}/gate`);
      const latestGateStatus = (await gateRes.json()) as GateStatus;
      if (!gateRes.ok) throw new Error("Gate status refresh failed");
      await postGateApprove(latestGateStatus);
      await startTechSpecAfterSpecApproval();
      setSelectedPhase(null);
      setPhaseOverviews(undefined);
    } catch (err) {
      setGateError(String(err));
    } finally {
      setGateBusy(false);
      load();
      loadGateStatus();
      loadSpecBattleState();
      loadPlanSandboxState();
    }
  }, [projectId, changeId, gateStatus, load, loadGateStatus, loadSpecBattleState, loadPlanSandboxState, selectedProvider, setGateError, setGateStatus, setPhaseOverviews]);

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

  const handleWaivePlanRisk = useCallback(async (riskId: string, reason?: string) => {
    const waiveAction = findPipelineAction(gateStatus?.actions, "waive_plan_p1");
    const disabledReason = pipelineActionDisabledReason(waiveAction);
    if (disabledReason) {
      setGateError(disabledReason);
      return;
    }
    if (reason === undefined) {
      setReasonDialog({ kind: "waive_plan_risk", riskId });
      return;
    }

    setGateBusy(true);
    setGateError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/plan-sandbox/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createPipelinePreflightPayload(waiveAction, { riskId, reason })),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Plan risk decision failed");
      loadPlanSandboxState();
    } catch (err) {
      setGateError(String(err));
    } finally {
      setGateBusy(false);
    }
  }, [projectId, changeId, gateStatus?.actions, loadPlanSandboxState, setGateError]);

  const planStageBusy = gateBusy || running;
  const planStageActionError = gateError || actionError;
  const providerControlProps = {
    provider: selectedProvider,
    onProviderChange: setSelectedProvider,
    providerDisabled: running || gateBusy,
    providerSelectable: Boolean(
      selectedStage?.actionIds?.some((actionId) =>
        findPipelineAction(pipelineActions, actionId)?.providerSelectable === true,
      ),
    ),
  } as const;
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
        makePlanStageAction("approve_plan", "确认测试计划", "primary", handleApprovePlanSandbox),
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
        makePlanStageAction("approve_plan", "批准计划", "primary", handleApprovePlanSandbox),
        makePlanStageAction("regenerate_plan_report", "刷新计划审查", "secondary", handleRegeneratePlanSandboxReport),
      ];
    }

    return [];
  }, [
    activeSelectedPhase,
    gateStatus?.actions,
    planStageBusy,
    handleAction,
    handleApprovePlanSandbox,
    handleRegeneratePlanSandboxReport,
  ]);

  /**
   * The git actions on the Build/Fix stage bar -- the "next step" after the
   * working tree has moved. Which ones are visible is decided by
   * selectVisibleGitStageActions; see git-action-policy for the rule.
   */
  const gitStageActions = useMemo<StageActionView[]>(() => {
    return selectVisibleGitStageActions(pipelineActions).map((action) => {
      const disabledReason = pipelineActionDisabledReason(action);
      return {
        id: `git-${action.actionId}`,
        label: action.label,
        role: "secondary" as const,
        enabled: disabledReason === null,
        busy: running,
        disabledReason,
        sourceActionId: action.actionId,
        onAction: () => handleAction(action.actionId),
      };
    });
  }, [handleAction, pipelineActions, running]);

  const buildOrFixStageActions = useMemo<StageActionView[]>(() => {
    if (activeSelectedPhase !== "Fix") return [...buildStageActions, ...gitStageActions];

    const fixBlockersAction = findPipelineAction(gateStatus?.actions, "fix_blockers");
    const disabledReason = pipelineActionDisabledReason(fixBlockersAction);
    const hasFixBlockerAction = disabledReason === null;
    if (!hasFixBlockerAction) return [...buildStageActions, ...gitStageActions];

    const fixBlockersStageAction: StageActionView = {
      id: "fix-fix_blockers",
      label: fixBlockersAction?.label ?? "修复阻断项",
      role: "primary",
      enabled: disabledReason === null,
      busy: running,
      disabledReason,
      sourceActionId: "fix_blockers",
      onAction: () => handleAction("fix_blockers"),
    };

    return [fixBlockersStageAction, ...buildStageActions, ...gitStageActions];
  }, [
    activeSelectedPhase,
    buildStageActions,
    gateStatus?.actions,
    gitStageActions,
    handleAction,
    running,
  ]);
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
  const gateApproveLabel = activeSelectedPhase === "Spec"
    ? "批准 Spec"
    : activeSelectedPhase === "TechSpec"
      ? "批准 Tech Spec"
      : "批准 PRD";
  const gateRejectLabel = activeSelectedPhase === "Spec"
    ? "退回 Spec"
    : activeSelectedPhase === "TechSpec"
      ? "退回 Tech Spec"
      : "退回 PRD";
  const gateStageActions = useMemo<StageActionView[]>(
    () => buildGateStageActions({
      phase: activeSelectedPhase,
      gateStatus,
      approveLabel: gateApproveLabel,
      rejectLabel: gateRejectLabel,
      gateBusy: gateBusy || gateLoading,
      runBusy: running || gateBusy,
      onApprove: handleApproveGate,
      onReject: handleRejectGate,
      onRunAction: handleAction,
    }),
    [
      activeSelectedPhase,
      gateApproveLabel,
      gateBusy,
      gateLoading,
      gateRejectLabel,
      gateStatus,
      handleAction,
      handleApproveGate,
      handleRejectGate,
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
      : [],
    [operationalActionIds, operationalContractPhase, pipelineActions],
  );
  const operationalStageBusy = running || (activeSelectedPhase === "Merge" && (gateBusy || gateLoading));
  const operationalStageActions = useMemo<StageActionView[]>(() => {
    return operationalActions.map((action) => {
      const disabledReason = pipelineActionDisabledReason(action);
      const onAction =
        action.actionId === "approve_merge"
          ? handleApproveGate
          : action.actionId === "reject_merge"
            ? handleRejectGate
            : () => handleAction(action.actionId);

      return {
        id: `operational-${action.actionId}`,
        label: action.label,
        role: operationalActionRole(action.actionId),
        enabled: disabledReason === null,
        busy: operationalStageBusy,
        disabledReason,
        sourceActionId: action.actionId,
        onAction,
      };
    });
  }, [handleAction, handleApproveGate, handleRejectGate, operationalActions, operationalStageBusy]);
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

  const handleEnterQaAction = useCallback(() => {
    handleAction("enter_qa");
  }, [handleAction]);

  const handleFixBlockersAction = useCallback(() => {
    handleAction("fix_blockers");
  }, [handleAction]);

  const handleStopChangeAction = useCallback(() => {
    handleAction("stop_change");
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

  const handleReasonConfirm = useCallback(async (reason: string) => {
    const pending = reasonDialog;
    if (!pending) return;
    setReasonDialog(null);
    if (pending.kind === "spec_battle_decision") {
      await handleSpecBattleDecision(pending.action, pending.targetId, reason);
      return;
    }
    if (pending.kind === "accept_spec_risk") {
      await submitAcceptSpecBattleRisk(pending.targetId, reason);
      return;
    }
    await handleWaivePlanRisk(pending.riskId, reason);
  }, [handleSpecBattleDecision, handleWaivePlanRisk, reasonDialog, submitAcceptSpecBattleRisk]);

  // The reason is a binding judgement, so the dialog has to carry the findings it
  // rules on. Each kind gets only what it acts on: a waiver shows its single
  // target, continuing the battle shows every still-open gap.
  const reasonDialogContext = useMemo(() => {
    if (!reasonDialog) return null;
    const gaps = specBattleState?.gaps;
    if (reasonDialog.kind === "spec_battle_decision") {
      return reasonDialog.action === "waive_p1"
        ? selectSpecRiskWaiverContext(gaps, reasonDialog.targetId)
        : selectSpecBattleDecisionContext(gaps);
    }
    if (reasonDialog.kind === "accept_spec_risk") {
      return selectSpecRiskWaiverContext(gaps, reasonDialog.targetId);
    }
    return selectPlanRiskWaiverContext(planSandboxState?.risks, reasonDialog.riskId);
  }, [reasonDialog, specBattleState?.gaps, planSandboxState?.risks]);

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
  const reasonDialogTitle = reasonDialog?.kind === "spec_battle_decision" && reasonDialog.action !== "waive_p1"
    ? "填写处理意见"
    : "填写 P1 风险接受理由";
  const reasonDialogRequired = reasonDialog?.kind !== "spec_battle_decision"
    || reasonDialog.action === "waive_p1";
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
  const renderPhaseRecords = (phase: ReviewPhase, keySuffix = "records") => (
    <PhaseReviewPanel
      key={`${phase}-${keySuffix}`}
      projectId={projectId}
      changeId={changeId}
      phase={phase}
      changeStatus={change.status}
      latestRunStatus={latestRunStatusLabel}
      onReviewLoaded={setPhaseOverviews}
      onReworked={handleReworked}
    />
  );

  return (
    <>
      <ActionReasonDialog
        open={reasonDialog !== null}
        title={reasonDialogTitle}
        description="提交前请写明本次人工处理依据。"
        confirmLabel="提交"
        required={reasonDialogRequired}
        context={reasonDialogContext}
        busy={gateBusy}
        onOpenChange={(open) => {
          if (!open) setReasonDialog(null);
        }}
        onConfirm={handleReasonConfirm}
      />
      <PipelinePageShell
        projectId={projectId}
        change={change}
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
        selectedProvider={selectedProvider}
      >
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
        {showingRetroStage ? (
              <PhaseStageShell
                {...providerControlProps}
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
                {...providerControlProps}
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
                {...providerControlProps}
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
                  selectedProvider={selectedProvider}
                  refreshToken={`${change.status}:${change.latestRun?.id ?? "none"}:${change.latestRun?.status ?? "none"}:${change.updatedAt ?? ""}`}
                  onStageActionsChange={setBuildStageActions}
                  onStageActionError={setBuildStageActionError}
                  onChanged={handleBuildSandboxChanged}
                />
              </PhaseStageShell>
            ) : showingTestPlanSandbox ? (
              <PhaseStageShell
                {...providerControlProps}
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
                {...providerControlProps}
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
                  actions={pipelineActions}
                  busy={gateBusy || running}
                  loading={gateLoading}
                  onWaiveRisk={handleWaivePlanRisk}
                />
              </PhaseStageShell>
            ) : showingPrdBriefingRoom ? (
              <PhaseStageShell
                {...providerControlProps}
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
                  selectedProvider={selectedProvider}
                  onLocked={handlePrdBriefingLocked}
                  onStageActionsChange={setPrdStageActions}
                />
              </PhaseStageShell>
            ) : showingSpecOrTechSpecGate ? (
              <PhaseStageShell
                {...providerControlProps}
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
                  onStopBattle={handleStopSpecBattle}
                  onAcceptRisk={handleAcceptSpecBattleRisk}
                  onBattleDecision={handleSpecBattleDecision}
                  onRestartBattle={handleRestartSpecBattle}
                  onRegenerateReport={handleRegenerateSpecBattleReport}
                  specBattleState={specBattleState}
                />
              </PhaseStageShell>
            ) : showingReviewReportCenter ? (
              <PhaseStageShell
                {...providerControlProps}
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
                  selectedProvider={selectedProvider}
                  busy={gateBusy || running}
                  onRunReview={handleRunReviewAction}
                  onEnterQa={handleEnterQaAction}
                  onFixBlockers={handleFixBlockersAction}
                  onBlockChange={handleStopChangeAction}
                  onStateChange={setReviewCenterState}
                  onStageActionsChange={setReviewStageActions}
                  onStageActionError={setReviewStageActionError}
                />
              </PhaseStageShell>
            ) : showingReviewPhase ? (
              showingOperationalPhaseSummary ? (
                <PhaseStageShell
                  {...providerControlProps}
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
                  {...providerControlProps}
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
            ) : change.status === "REFINING" ? (
              <PhaseStageShell
                {...providerControlProps}
                projectId={projectId}
                changeId={changeId}
                phase={activeSelectedPhase}
                state={selectedStageState}
                statusLabel={stageStatusLabel}
                latestRunStatus={latestRunStatusLabel}
              >
                <div className="h-[calc(100vh-16rem)]">
                  <RefineChatPanel
                    projectId={projectId}
                    changeId={changeId}
                    onSpecReady={load}
                    selectedProvider={selectedProvider}
                    onProviderChange={setSelectedProvider}
                  />
                </div>
              </PhaseStageShell>
            ) : (
              <>
                {/* Action Buttons */}
                {providerControlProps.providerSelectable && (
                  <div className="mb-3">
                    <ProviderPicker
                      value={selectedProvider}
                      onChange={setSelectedProvider}
                      disabled={providerControlProps.providerDisabled}
                    />
                  </div>
                )}
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
        {/*
          Deliberately outside every stage branch: the panel is on screen for
          every phase of the change, so committing never means leaving the stage
          you are working on. The Build/Fix stage bar additionally carries the
          same two actions as one-click contract actions (gitStageActions).
        */}
        <StageGitPanel
          projectId={projectId}
          changeId={changeId}
          selectedPhase={activeSelectedPhase}
          commitAction={findPipelineAction(pipelineActions, "commit_changes")}
          initAction={findPipelineAction(pipelineActions, "init_git_repo")}
        />
      </PipelinePageShell>
    </>
  );
}
