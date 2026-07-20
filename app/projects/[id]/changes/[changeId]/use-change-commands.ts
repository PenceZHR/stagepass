"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";

import type { PhaseOverview } from "./change-detail-types";
import type { ReviewPhase } from "./change-phase-map";
import { gateApprovalAction, gateRejectAction } from "./gate-panel";
import type { GateName, GateStatus } from "./gate-types";
import {
  createPipelinePreflightPayload,
  findPipelineAction,
  pipelineActionDisabledReason,
  type AiProvider,
} from "./pipeline-action-contract";

const GATE_NEXT_STAGE_ENDPOINTS: Record<GateName, string> = {
  intake: "spec",
  spec: "tech-spec",
  tech_spec: "plan",
  merge: "release",
};

const GATE_NEXT_STAGE_ACTION_IDS: Partial<Record<GateName, string>> = {
  intake: "run_spec",
  spec: "run_tech_spec",
  tech_spec: "run_plan",
  merge: "merge",
};

/**
 * Start the stage that follows an approval, using a freshly issued contract.
 *
 * handleApproveGate does this inline, keyed on GateName -- which is why the
 * TestPlan approval could not reuse it: TestPlan is not a gate, so there was no
 * entry to add and the approval simply ended, leaving Build unstarted. That
 * inline copy is left where it is; it carries merge-specific handling and an
 * optional next action that this path does not have.
 *
 * The contract is re-fetched rather than carried over, because the approval just
 * moved the change and the version issued before it is already stale. A next
 * stage that the backend will not allow throws, so its reason reaches the
 * operator -- an approval that quietly leads nowhere is what left three
 * identical test-plan runs in the ledger.
 */
export async function startNextStage(input: {
  projectId: string;
  changeId: string;
  actionId: string;
  endpoint: string;
  selectedProvider?: AiProvider;
  setGateStatus: Dispatch<SetStateAction<GateStatus | null>>;
}): Promise<void> {
  const gateRes = await fetch(`/api/projects/${input.projectId}/changes/${input.changeId}/gate`);
  const gateData = await gateRes.json();
  if (!gateRes.ok) throw new Error(gateData.error || "Gate status refresh failed");
  const latestGateStatus = gateData as GateStatus;
  input.setGateStatus(latestGateStatus);

  const nextAction = findPipelineAction(latestGateStatus.actions, input.actionId);
  const nextDisabledReason = pipelineActionDisabledReason(nextAction);
  if (nextDisabledReason) throw new Error(nextDisabledReason);

  const payload = createPipelinePreflightPayload(nextAction);
  if (nextAction?.requiresProvider && nextAction.providerSelectable && input.selectedProvider) {
    payload.provider = input.selectedProvider;
  }
  const stageRes = await fetch(
    `/api/projects/${input.projectId}/changes/${input.changeId}/${input.endpoint}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
  );
  const stageData = await stageRes.json();
  if (!stageRes.ok) throw new Error(stageData.error || "Next stage failed");
}

type SelectedPhaseState = {
  changeId: string;
  phase: ReviewPhase;
} | null;

type RefreshFn = () => void | Promise<unknown>;

interface UseChangeCommandsOptions {
  projectId: string;
  changeId: string;
  gateStatus: GateStatus | null;
  load: RefreshFn;
  loadGateStatus: RefreshFn;
  loadSpecBattleState: RefreshFn;
  loadPlanSandboxState: RefreshFn;
  loadTestPlanSandboxState: RefreshFn;
  setGateBusy: Dispatch<SetStateAction<boolean>>;
  setGateError: Dispatch<SetStateAction<string>>;
  setGateStatus: Dispatch<SetStateAction<GateStatus | null>>;
  setPhaseOverviews: Dispatch<SetStateAction<PhaseOverview[] | undefined>>;
  setSelectedPhase: Dispatch<SetStateAction<SelectedPhaseState>>;
  selectedProvider?: AiProvider;
}

export function useChangeCommands({
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
}: UseChangeCommandsOptions) {
  const refreshGateSurfaces = useCallback(() => {
    load();
    loadGateStatus();
    loadSpecBattleState();
    loadPlanSandboxState();
    loadTestPlanSandboxState();
  }, [load, loadGateStatus, loadSpecBattleState, loadPlanSandboxState, loadTestPlanSandboxState]);

  const resetPhaseReview = useCallback(() => {
    setSelectedPhase(null);
    setPhaseOverviews(undefined);
  }, [setSelectedPhase, setPhaseOverviews]);

  const handleApproveGate = useCallback(async () => {
    if (!gateStatus?.gate) return;
    const approveAction = gateApprovalAction(gateStatus);
    setGateBusy(true);
    setGateError("");

    try {
      const approveRes = await fetch(
        `/api/projects/${projectId}/changes/${changeId}/gate/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            gate: gateStatus.gate,
            expectedGateVersion: approveAction?.gateVersion,
            expectedSourceDbHash: approveAction?.sourceDbHash,
            idempotencyKey:
              typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `${gateStatus.gate}-${Date.now()}`,
          }),
        }
      );
      const approveData = await approveRes.json();
      if (!approveRes.ok) {
        throw new Error(
          approveData.action?.reason ??
            approveData.action?.reasonCode ??
            approveData.error ??
            "Gate approval failed",
        );
      }

      if (gateStatus.gate !== "spec") {
        const nextEndpoint = GATE_NEXT_STAGE_ENDPOINTS[gateStatus.gate];
        const nextActionId = GATE_NEXT_STAGE_ACTION_IDS[gateStatus.gate];
        const latestGateRes = await fetch(`/api/projects/${projectId}/changes/${changeId}/gate`);
        const latestGateData = await latestGateRes.json();
        if (!latestGateRes.ok) throw new Error(latestGateData.error || "Gate status refresh failed");
        const latestGateStatus = latestGateData as GateStatus;
        setGateStatus(latestGateStatus);
        const nextAction = nextActionId ? findPipelineAction(latestGateStatus.actions, nextActionId) : null;
        const mergeAction = findPipelineAction(latestGateStatus.actions, "merge");
        const contractAction = gateStatus.gate === "merge" ? mergeAction : nextAction;
        const nextDisabledReason = nextActionId ? pipelineActionDisabledReason(contractAction) : null;
        if (nextDisabledReason) throw new Error(nextDisabledReason);
        const nextStagePayload = nextAction ? createPipelinePreflightPayload(nextAction) : null;
        if (nextStagePayload && nextAction?.requiresProvider && nextAction.providerSelectable && selectedProvider) {
          nextStagePayload.provider = selectedProvider;
        }
        const nextStageBody = nextStagePayload ? JSON.stringify(nextStagePayload) : undefined;
        const stageRes = await fetch(
          `/api/projects/${projectId}/changes/${changeId}/${nextEndpoint}`,
          {
            method: "POST",
            headers: nextStageBody ? { "Content-Type": "application/json" } : undefined,
            body: nextStageBody,
          }
        );
        const stageData = await stageRes.json();
        if (!stageRes.ok) throw new Error(stageData.error || "Next stage failed");
      }

      resetPhaseReview();
    } catch (err) {
      setGateError(String(err));
    } finally {
      setGateBusy(false);
      refreshGateSurfaces();
    }
  }, [projectId, changeId, gateStatus, refreshGateSurfaces, resetPhaseReview, selectedProvider, setGateBusy, setGateError, setGateStatus]);

  const handleRejectGate = useCallback(async () => {
    if (!gateStatus?.gate) return;
    const rejectAction = gateRejectAction(gateStatus);
    const disabledReason = pipelineActionDisabledReason(rejectAction);
    if (disabledReason) {
      setGateError(disabledReason);
      return;
    }
    setGateBusy(true);
    setGateError("");

    try {
      const res = await fetch(
        `/api/projects/${projectId}/changes/${changeId}/gate/reject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createPipelinePreflightPayload(rejectAction, { gate: gateStatus.gate })),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.action?.reason ?? data.action?.reasonCode ?? data.error ?? "Gate rejection failed");
      }
      resetPhaseReview();
    } catch (err) {
      setGateError(String(err));
    } finally {
      setGateBusy(false);
      refreshGateSurfaces();
    }
  }, [projectId, changeId, gateStatus, refreshGateSurfaces, resetPhaseReview, setGateBusy, setGateError]);

  const handleRestartSpecBattle = useCallback(async () => {
    const runAction = findPipelineAction(gateStatus?.actions, "run_spec");
    const retryAction = findPipelineAction(gateStatus?.actions, "retry_spec");
    const action = retryAction?.enabled ? retryAction : runAction;
    const disabledReason = pipelineActionDisabledReason(action);
    if (disabledReason) {
      setGateError(disabledReason);
      return;
    }
    setGateBusy(true);
    setGateError("");
    try {
      const specRes = await fetch(`/api/projects/${projectId}/changes/${changeId}/spec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createPipelinePreflightPayload(action, { provider: selectedProvider })),
      });
      const specData = await specRes.json();
      if (!specRes.ok) throw new Error(specData.error || "Spec battle restart failed");
      resetPhaseReview();
    } catch (err) {
      setGateError(String(err));
    } finally {
      setGateBusy(false);
      refreshGateSurfaces();
    }
  }, [projectId, changeId, gateStatus?.actions, refreshGateSurfaces, resetPhaseReview, selectedProvider, setGateBusy, setGateError]);

  const handleApprovePlanSandbox = useCallback(async () => {
    const approveAction = findPipelineAction(gateStatus?.actions, "approve_plan");
    const disabledReason = pipelineActionDisabledReason(approveAction);
    if (disabledReason) {
      setGateError(disabledReason);
      return;
    }
    // approve_plan serves two approvals that both land on PLAN_APPROVED, so the
    // hand-off has to be chosen from where the change is coming FROM. Only the
    // TestPlan one continues on its own: approving the plan itself is followed
    // by a test plan the human asks for, while confirming the test plan is the
    // last gate before Build and used to continue to nothing at all -- the
    // change sat at PLAN_APPROVED with no Build enqueued, and the only enabled
    // forward action left was running the test plan again, which is exactly the
    // loop that produced three identical test-plan runs.
    const chainToBuild = gateStatus?.status === "TESTPLAN_DONE";
    setGateBusy(true);
    setGateError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/approve-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createPipelinePreflightPayload(approveAction)),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.action?.reason ?? data.action?.reasonCode ?? data.error ?? "Plan approval failed");
      }
      if (chainToBuild) {
        await startNextStage({
          projectId,
          changeId,
          actionId: "run_build",
          endpoint: "implement",
          selectedProvider,
          setGateStatus,
        });
      }
      resetPhaseReview();
    } catch (err) {
      setGateError(String(err));
    } finally {
      setGateBusy(false);
      load();
      loadGateStatus();
      loadPlanSandboxState();
      loadTestPlanSandboxState();
    }
  }, [projectId, changeId, gateStatus?.actions, gateStatus?.status, load, loadGateStatus, loadPlanSandboxState, loadTestPlanSandboxState, resetPhaseReview, selectedProvider, setGateBusy, setGateError, setGateStatus]);

  return {
    handleApproveGate,
    handleRejectGate,
    handleRestartSpecBattle,
    handleApprovePlanSandbox,
  };
}
