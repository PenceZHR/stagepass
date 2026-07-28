"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useCallback } from "react";

import { changeApi } from "./change-api-client";
import { CodexTaskControl } from "./codex-task-control";
import type { PhaseReviewResponse } from "./phase-review-panel";
import { PhaseReviewPanel } from "./phase-review-panel";
import { PhaseStageShell } from "./phase-stage-shell";
import { PipelinePageShell } from "./pipeline-page-shell";
import { StageCodexWorkspace } from "./stage-codex-workspace";
import { REVIEW_PHASE_TO_STAGE, UI_STAGE_ORDER, buildUiPipelineState } from "./pipeline-ui-model";
import { NEXT_ROUND_ACTION_IDS } from "./pipeline-action-commands";
import {
  shouldPollChangeDetailParent,
  visibleChangeStatus,
  type ReviewPhase,
} from "./change-phase-map";
import { useChangeDetailData } from "./use-change-detail-data";
import { usePipelineActions } from "./use-pipeline-actions";

export default function ChangeDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string; changeId: string }>();
  const { id: projectId, changeId } = params;
  const [selectedPhase, setSelectedPhase] = useState<{
    changeId: string;
    phase: ReviewPhase;
  } | null>(null);
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexError, setCodexError] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const {
    change,
    phaseOverviews,
    setPhaseOverviews,
    gateStatus,
    specBattleState,
    reviewCenterState,
    changeError,
    codexHealth,
    refreshChangeDetailPage,
    refreshAfterAction,
  } = useChangeDetailData(
    projectId,
    changeId,
    // The Codex task state belongs to the stage on screen, not to the change.
    selectedPhase?.changeId === changeId
      ? REVIEW_PHASE_TO_STAGE[selectedPhase.phase]
      : undefined,
  );
  const { running, actionError, handleAction } = usePipelineActions({
    projectId,
    changeId,
    actions: gateStatus?.actions,
    refresh: refreshAfterAction,
  });

  const explicitSelectedPhase =
    selectedPhase?.changeId === changeId ? selectedPhase.phase : null;
  const uiPipelineState = useMemo(
    () =>
      change
        ? buildUiPipelineState({
            change,
            selectedPhase: explicitSelectedPhase,
            phaseOverviews,
            reviewCenterState,
            gateStatus,
            specBattleState,
          })
        : null,
    [
      change,
      explicitSelectedPhase,
      phaseOverviews,
      reviewCenterState,
      gateStatus,
      specBattleState,
    ],
  );
  const selectedStage = uiPipelineState?.selectedStage ?? null;
  const activeSelectedPhase = selectedStage?.reviewPhase ?? "Retro";
  const fetchPhase = selectedStage?.recordPhase ?? null;
  const shouldPollParent = shouldPollChangeDetailParent({
    change,
    running,
    gateBusy: codexBusy,
    specBattleState,
    reviewCenterState,
  });

  useEffect(() => {
    if (!shouldPollParent) return;
    const interval = setInterval(() => {
      void refreshChangeDetailPage();
    }, 3000);
    return () => clearInterval(interval);
  }, [shouldPollParent, refreshChangeDetailPage]);

  useEffect(() => {
    if (!change || !fetchPhase) return;
    fetch(
      `/api/projects/${projectId}/changes/${changeId}/phases?phase=${encodeURIComponent(fetchPhase)}`,
    )
      .then((response) => (response.ok ? response.json() : null))
      .then((data: PhaseReviewResponse | null) => {
        if (data?.phases) setPhaseOverviews(data.phases);
      })
      .catch(() => {});
  }, [projectId, changeId, change, fetchPhase, setPhaseOverviews]);

  const handleSelectPhase = useCallback(
    (phase: ReviewPhase) => {
      setSelectedPhase({ changeId, phase });
    },
    [changeId],
  );

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

  if (!change || !uiPipelineState || !selectedStage) {
    return <div className="p-8">Loading...</div>;
  }

  const currentChange = change;
  const pipelineActions = gateStatus?.actions ?? [];
  const selectedIsFuture =
    UI_STAGE_ORDER.indexOf(selectedStage.id) >
    UI_STAGE_ORDER.indexOf(uiPipelineState.activeStage.id);
  // The stage declares how it starts. Matching a `run_`/`retry_` prefix left
  // Fix and Merge unstartable, because their start actions are named for what
  // they do rather than for being a run.
  const enabledActionIds = new Set(
    pipelineActions.filter((action) => action.enabled).map((action) => action.actionId),
  );
  // Every stage lists `retry_*` before `run_*`, and both are enabled while a
  // stage is still waiting -- so the first enabled entry was always the retry,
  // and a brand new change offered 「重新生成 PRD」 for a PRD that had never been
  // generated. Ordering alone cannot express this: which verb is true depends
  // on whether the stage has run, not on a fixed preference. A stage that is
  // merely waiting has not, so it starts rather than retries.
  const startCandidates = selectedStage.state === "waiting"
    ? [...selectedStage.startActionIds].sort((a, b) =>
      Number(b.startsWith("run_")) - Number(a.startsWith("run_")))
    : selectedStage.startActionIds;
  const startActionId = startCandidates.find((actionId) =>
    enabledActionIds.has(actionId),
  );
  const startControlAction = startActionId
    ? pipelineActions.find((action) => action.actionId === startActionId)
    : undefined;
  const retryControlAction = startControlAction?.actionId.startsWith("retry_")
    ? startControlAction
    : undefined;

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
  const hasActiveRun = change.latestRun?.status === "running";
  const isRunning =
    hasActiveRun ||
    [
      "PLANNING",
      "REVIEWING",
      "FIXING",
      "CHECKING",
      "SPECCING",
      "TECHSPECCING",
      "TESTPLANNING",
      "MERGING",
    ].includes(change.status);
  const stageError = [codexError, actionError].filter(Boolean).join("；");
  const recordsPhase = selectedStage.recordPhase ?? activeSelectedPhase;

  async function runCodexControlAction(action: () => Promise<unknown>) {
    setCodexBusy(true);
    setCodexError("");
    try {
      await action();
      await refreshChangeDetailPage();
    } catch (error) {
      setCodexError(error instanceof Error ? error.message : String(error));
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
      const response = await fetch(
        `/api/projects/${projectId}/changes/${currentChange.id}`,
        { method: "DELETE" },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : "删除失败",
        );
      }
      router.push(`/projects/${projectId}`);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
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
      isSpecBattleMode={false}
      isRunning={isRunning}
      deleteBusy={deleteBusy}
      deleteError={deleteError}
      onDeleteChange={handleDeleteChange}
      onSelectPhase={handleSelectPhase}
    >
      <PhaseStageShell
        projectId={projectId}
        changeId={changeId}
        phase={activeSelectedPhase}
        state={selectedStage.state}
        statusLabel={visibleChangeStatus(change)}
        latestRunStatus={change.latestRun?.status ?? null}
        error={stageError || null}
        records={
          <PhaseReviewPanel
            projectId={projectId}
            changeId={changeId}
            phase={recordsPhase}
            changeStatus={change.status}
            latestRunStatus={change.latestRun?.status ?? null}
            readOnly
            onReviewLoaded={setPhaseOverviews}
          />
        }
      >
        <StageCodexWorkspace
          stageId={selectedStage.id}
          isFuture={selectedIsFuture}
          isWaitingForInput={Boolean(codexControl.currentInteractionId)}
        >
          <CodexTaskControl
            control={codexControl}
            health={codexHealth}
            readOnly={!startControlAction}
            // Named by the contract, so the button says what it will do. Left
            // undefined only when there is no action, where the control's own
            // default copy is the right thing.
            startLabel={startControlAction?.label}
            busy={codexBusy || running}
            onOpen={() =>
              runCodexControlAction(() => codexApi.openCodexTask())
            }
            onStart={() =>
              runCodexControlAction(async () => {
                if (!startControlAction) {
                  throw new Error("当前阶段没有可启动的 Codex 动作");
                }
                // Another round supersedes the settled one and costs a full
                // red/blue cycle, so the service refuses it without a reason --
                // and the reason is what tells the next round's judge why a
                // human sent it back. Asked for here rather than defaulted:
                // a server-filled reason would keep the guard and lose the
                // record it exists to keep.
                if (NEXT_ROUND_ACTION_IDS.has(startControlAction.actionId)) {
                  const reason = window.prompt(
                    "再打一轮的理由（会记入人工决策，并交给下一轮的裁决者）：",
                  )?.trim();
                  if (!reason) return;
                  await handleAction(startControlAction.actionId, true, { reason });
                  return;
                }
                await handleAction(startControlAction.actionId);
              })
            }
          />
        </StageCodexWorkspace>
      </PhaseStageShell>
    </PipelinePageShell>
  );
}
