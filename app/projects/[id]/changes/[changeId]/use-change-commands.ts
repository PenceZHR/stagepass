"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";

import type { PhaseOverview } from "./change-detail-types";
import type { ReviewPhase } from "./change-phase-map";
import type { GateStatus } from "./gate-types";
import {
  createPipelinePreflightPayload,
  findPipelineAction,
  pipelineActionDisabledReason,
} from "./pipeline-action-contract";

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
  setGateBusy: Dispatch<SetStateAction<boolean>>;
  setGateError: Dispatch<SetStateAction<string>>;
  setPhaseOverviews: Dispatch<SetStateAction<PhaseOverview[] | undefined>>;
  setSelectedPhase: Dispatch<SetStateAction<SelectedPhaseState>>;
}

/**
 * Web owns operational stage starts/retries only. Human decisions are rendered
 * and submitted from the bound Codex task (or the explicit emergency surface).
 */
export function useChangeCommands({
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
}: UseChangeCommandsOptions) {
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
      const response = await fetch(
        `/api/projects/${projectId}/changes/${changeId}/spec`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createPipelinePreflightPayload(action)),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : "Spec battle restart failed",
        );
      }
      setSelectedPhase(null);
      setPhaseOverviews(undefined);
    } catch (error) {
      setGateError(String(error));
    } finally {
      setGateBusy(false);
      void load();
      void loadGateStatus();
      void loadSpecBattleState();
    }
  }, [
    projectId,
    changeId,
    gateStatus?.actions,
    load,
    loadGateStatus,
    loadSpecBattleState,
    setGateBusy,
    setGateError,
    setPhaseOverviews,
    setSelectedPhase,
  ]);

  return { handleRestartSpecBattle };
}
