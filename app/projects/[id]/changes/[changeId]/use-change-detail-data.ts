"use client";

import { useCallback, useEffect, useState } from "react";

import { changeApi } from "./change-api-client";
import { useChangeEventRefresh } from "./use-change-event-refresh";
import type { ChangeDetail, PhaseOverview } from "./change-detail-types";
import type { GateStatus } from "./gate-types";
import type { PlanSandboxState } from "./plan-sandbox-types";
import type { PrdBriefingState } from "./prd-briefing-types";
import type { ReviewCenterResponse } from "./review-report-center";
import type { SpecBattleState } from "./spec-battle-types";
import type { TestPlanSandboxState } from "./testplan-sandbox-types";

export function useChangeDetailData(projectId: string, changeId: string) {
  const [change, setChange] = useState<ChangeDetail | null>(null);
  const [phaseOverviews, setPhaseOverviews] = useState<PhaseOverview[] | undefined>();
  const [gateStatus, setGateStatus] = useState<GateStatus | null>(null);
  const [specBattleState, setSpecBattleState] = useState<SpecBattleState | null>(null);
  const [planSandboxState, setPlanSandboxState] = useState<PlanSandboxState | null>(null);
  const [testPlanSandboxState, setTestPlanSandboxState] = useState<TestPlanSandboxState | null>(null);
  const [prdBriefingState, setPrdBriefingState] = useState<PrdBriefingState | null>(null);
  const [reviewCenterState, setReviewCenterState] = useState<ReviewCenterResponse | null>(null);
  const [gateLoading, setGateLoading] = useState(false);
  const [gateError, setGateError] = useState("");
  const [changeError, setChangeError] = useState("");

  const load = useCallback(() => {
    return fetch(`/api/projects/${projectId}/changes/${changeId}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setChange(null);
          setChangeError(typeof data.error === "string" ? data.error : "Change not found");
          return false;
        }
        setChange(data as ChangeDetail);
        setChangeError("");
        return true;
      })
      .catch((err) => {
        setChange(null);
        setChangeError(String(err));
        return false;
      });
  }, [projectId, changeId]);

  const loadGateStatus = useCallback(() => {
    setGateLoading(true);
    changeApi(projectId, changeId)
      .getGate()
      .then((data) => {
        setGateStatus(data);
        setGateError("");
      })
      .catch((err) => setGateError(String(err)))
      .finally(() => setGateLoading(false));
  }, [projectId, changeId]);

  const loadSpecBattleState = useCallback(() => {
    changeApi(projectId, changeId)
      .getSpecBattle()
      .then((data) => setSpecBattleState(data))
      .catch(() => setSpecBattleState(null));
  }, [projectId, changeId]);

  const loadPlanSandboxState = useCallback(() => {
    return changeApi(projectId, changeId)
      .getPlanSandbox()
      .then((data) => {
        setPlanSandboxState(data);
        return data;
      })
      .catch(() => {
        setPlanSandboxState(null);
        return null;
      });
  }, [projectId, changeId]);

  const loadTestPlanSandboxState = useCallback(() => {
    return changeApi(projectId, changeId)
      .getTestPlanSandbox()
      .then((data) => {
        setTestPlanSandboxState(data);
        return data;
      })
      .catch(() => {
        setTestPlanSandboxState(null);
        return null;
      });
  }, [projectId, changeId]);

  const loadPrdBriefingState = useCallback(() => {
    return changeApi(projectId, changeId)
      .getPrdBriefing()
      .then((data) => {
        setPrdBriefingState(data);
        return data;
      })
      .catch(() => {
        setPrdBriefingState(null);
        return null;
      });
  }, [projectId, changeId]);

  const loadReviewCenterState = useCallback(() => {
    return changeApi(projectId, changeId)
      .getReviewCenter()
      .then((data) => {
        setReviewCenterState(data);
        return data;
      })
      .catch(() => {
        setReviewCenterState(null);
        return null;
      });
  }, [projectId, changeId]);

  const refreshChangeDetailPage = useCallback(async () => {
    const loaded = await load();
    if (loaded) {
      loadGateStatus();
      loadSpecBattleState();
      loadPlanSandboxState();
      loadTestPlanSandboxState();
      loadPrdBriefingState();
      loadReviewCenterState();
    }
  }, [load, loadGateStatus, loadSpecBattleState, loadPlanSandboxState, loadTestPlanSandboxState, loadPrdBriefingState, loadReviewCenterState]);

  const refreshAfterAction = useCallback(() => {
    load();
    loadGateStatus();
    loadSpecBattleState();
    loadPlanSandboxState();
    loadTestPlanSandboxState();
    loadReviewCenterState();
  }, [load, loadGateStatus, loadSpecBattleState, loadPlanSandboxState, loadTestPlanSandboxState, loadReviewCenterState]);

  useEffect(() => {
    const refresh = async () => {
      await refreshChangeDetailPage();
    };
    void refresh();
  }, [refreshChangeDetailPage]);

  // The server announces every state write on the event stream, so re-read on
  // it. Without this the page only refreshes while `shouldPollChangeDetailParent`
  // sees work already in flight, which misses both the dispatch window and the
  // moment a stage finishes and hands the decision back to a human.
  useChangeEventRefresh({
    projectId,
    changeId,
    onRefresh: refreshChangeDetailPage,
  });

  return {
    change,
    setChange,
    phaseOverviews,
    setPhaseOverviews,
    gateStatus,
    setGateStatus,
    specBattleState,
    setSpecBattleState,
    planSandboxState,
    setPlanSandboxState,
    testPlanSandboxState,
    setTestPlanSandboxState,
    prdBriefingState,
    setPrdBriefingState,
    reviewCenterState,
    setReviewCenterState,
    gateLoading,
    gateError,
    setGateError,
    changeError,
    load,
    loadGateStatus,
    loadSpecBattleState,
    loadPlanSandboxState,
    loadTestPlanSandboxState,
    loadPrdBriefingState,
    loadReviewCenterState,
    refreshChangeDetailPage,
    refreshAfterAction,
  };
}
