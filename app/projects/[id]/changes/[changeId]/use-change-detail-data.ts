"use client";

import { useCallback, useEffect, useState } from "react";

import { changeApi } from "./change-api-client";
import { useChangeEventRefresh } from "./use-change-event-refresh";
import type { ChangeDetail, PhaseOverview } from "./change-detail-types";
import type { GateStatus } from "./gate-types";
import type { ReviewCenterResponse } from "./review-report-center";
import type { SpecBattleState } from "./spec-battle-types";
import type { CodexHealthProjection } from "./codex-task-control";

export function useChangeDetailData(
  projectId: string,
  changeId: string,
  /** The stage whose Codex task state the page is showing. */
  stageId?: string,
) {
  const [change, setChange] = useState<ChangeDetail | null>(null);
  const [phaseOverviews, setPhaseOverviews] = useState<PhaseOverview[] | undefined>();
  const [gateStatus, setGateStatus] = useState<GateStatus | null>(null);
  const [specBattleState, setSpecBattleState] = useState<SpecBattleState | null>(null);
  const [reviewCenterState, setReviewCenterState] = useState<ReviewCenterResponse | null>(null);
  const [gateLoading, setGateLoading] = useState(false);
  const [gateError, setGateError] = useState("");
  const [changeError, setChangeError] = useState("");
  const [codexHealth, setCodexHealth] = useState<CodexHealthProjection | null>(null);

  const load = useCallback(() => {
    const query = stageId ? `?stage=${encodeURIComponent(stageId)}` : "";
    return fetch(`/api/projects/${projectId}/changes/${changeId}${query}`)
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
  }, [projectId, changeId, stageId]);

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
      loadReviewCenterState();
    }
  }, [load, loadGateStatus, loadSpecBattleState, loadReviewCenterState]);

  const refreshAfterAction = useCallback(() => {
    load();
    loadGateStatus();
    loadSpecBattleState();
    loadReviewCenterState();
  }, [load, loadGateStatus, loadSpecBattleState, loadReviewCenterState]);

  useEffect(() => {
    const refresh = async () => {
      await refreshChangeDetailPage();
    };
    void refresh();
  }, [refreshChangeDetailPage]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const refreshHealth = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const health = await changeApi(projectId, changeId).getCodexHealth();
        if (active) setCodexHealth(health);
      } catch {
        if (active) setCodexHealth({ status: "unavailable" });
      } finally {
        inFlight = false;
      }
    };
    void refreshHealth();
    const interval = window.setInterval(() => {
      void refreshHealth();
    }, 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [projectId, changeId]);

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
    reviewCenterState,
    setReviewCenterState,
    gateLoading,
    gateError,
    setGateError,
    changeError,
    codexHealth,
    load,
    loadGateStatus,
    loadSpecBattleState,
    loadReviewCenterState,
    refreshChangeDetailPage,
    refreshAfterAction,
  };
}
