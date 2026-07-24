"use client";

import { ArrowLeft, ChevronLeft, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

import type { ChangeDetail } from "./change-detail-types";
import type { ReviewPhase } from "./change-phase-map";
import { visibleChangeStatus } from "./change-phase-map";
import type { ReviewCenterResponse } from "./review-report-center";
import { StageOrbit } from "./stage-orbit";
import { UI_STAGE_ORDER, type UiStage, type UiStageId } from "./pipeline-ui-model";
import { useWorkspaceNavigation } from "./use-workspace-navigation";
import { WorkspaceNavigationColumns } from "./workspace-navigation-columns";

type PipelineView = "orbit" | "detail";

export function PipelinePageShell({
  projectId,
  change,
  activeStage,
  selectedStage,
  stages,
  isRunning,
  deleteBusy,
  deleteError,
  onDeleteChange,
  onSelectPhase,
  children,
}: {
  projectId: string;
  change: ChangeDetail;
  activeStage: UiStage;
  selectedStage: UiStage;
  stages: UiStage[];
  selectedPhase: ReviewPhase;
  phaseOverviews?: unknown[];
  reviewCenterState?: ReviewCenterResponse | null;
  isSpecBattleMode: boolean;
  isRunning: boolean;
  deleteBusy: boolean;
  deleteError: string;
  onDeleteChange: () => void;
  onSelectPhase: (phase: ReviewPhase) => void;
  children: ReactNode;
}) {
  const [view, setView] = useState<PipelineView>("orbit");
  const [transitionTargetId, setTransitionTargetId] = useState<UiStageId | null>(null);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workspaceNavigation = useWorkspaceNavigation(projectId, change.id);

  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    };
  }, []);

  function enterStage(stage: UiStage) {
    if (!stage.reviewPhase || transitionTargetId) return;
    setTransitionTargetId(stage.id);

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    transitionTimerRef.current = setTimeout(() => {
      onSelectPhase(stage.reviewPhase!);
      setView("detail");
      setTransitionTargetId(null);
      transitionTimerRef.current = null;
    }, reduceMotion ? 20 : 680);
  }

  function returnToOrbit() {
    setView("orbit");
  }

  const riskCount = activeStage.blockerCount ?? change.findingsSummary?.open ?? 0;
  const selectedIsFuture =
    UI_STAGE_ORDER.indexOf(selectedStage.id) > UI_STAGE_ORDER.indexOf(activeStage.id);

  return (
    <div className="stagepass-page">
      <StagepassTopbar
        projectId={projectId}
        change={change}
        isRunning={isRunning}
      />

      <div
        data-stagepass-workspace
        className="grid min-h-[calc(100vh-4rem)] grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,6fr)]"
      >
        <WorkspaceNavigationColumns
          projects={workspaceNavigation.projects}
          changes={workspaceNavigation.changes}
          selectedProjectId={workspaceNavigation.selectedProjectId}
          selectedChangeId={workspaceNavigation.selectedChangeId}
          loadingProjects={workspaceNavigation.loadingProjects}
          loadingChanges={workspaceNavigation.loadingChanges}
          error={workspaceNavigation.error}
          onSelectProject={(nextProjectId) => {
            void workspaceNavigation.selectProject(nextProjectId);
          }}
          onSelectChange={workspaceNavigation.selectChange}
        />

        <section data-workspace-orbit className="min-w-0 overflow-hidden">
          {view === "orbit" ? (
            <StageOrbit
              stages={stages}
              activeStage={activeStage}
              selectedStage={selectedStage}
              changeTitle={change.title}
              changeStatus={visibleChangeStatus(change)}
              riskCount={riskCount}
              transitioning={transitionTargetId !== null}
              transitionTargetId={transitionTargetId}
              onSelectStage={enterStage}
            />
          ) : (
            <main className="stagepass-detail-enter min-w-0 px-4 py-6 sm:px-6 sm:py-8">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={returnToOrbit}
                  className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/12 bg-black/10 px-4 text-sm text-foreground transition hover:bg-white/8"
                  data-return-to-stage-orbit
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                  返回阶段环
                </button>
                <p className="text-xs text-muted-foreground">
                  <span className="text-foreground">{selectedStage.label}</span>
                  {" · "}
                  {selectedIsFuture ? "未来阶段只读预览" : "可查看当前证据"}
                </p>
              </div>

              <section className="stagepass-surface overflow-hidden rounded-2xl">
                <PipelinePageHeader
                  change={change}
                  selectedStage={selectedStage}
                  activeStage={activeStage}
                  isRunning={isRunning}
                  readOnly={selectedIsFuture}
                  deleteBusy={deleteBusy}
                  deleteError={deleteError}
                  onDeleteChange={onDeleteChange}
                />
                <div className="p-4 sm:p-6">
                  {selectedIsFuture ? (
                    <div className="mb-6 border-l-2 border-primary/60 bg-primary/[0.045] px-4 py-3 text-sm">
                      <p className="font-medium text-foreground">未来阶段 · 只读预览</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        此页面只展示预期门禁与交付要求；所有决定动作均已锁定。
                      </p>
                    </div>
                  ) : null}
                  <div data-future-preview={selectedIsFuture ? "true" : "false"}>
                    {children}
                  </div>
                </div>
              </section>
            </main>
          )}
        </section>
      </div>
    </div>
  );
}

function StagepassTopbar({
  projectId,
  change,
  isRunning,
}: {
  projectId: string;
  change: ChangeDetail;
  isRunning: boolean;
}) {
  return (
    <header className="stagepass-topbar">
      <Link href="/projects" className="stagepass-wordmark shrink-0">
        stagepass
      </Link>

      <nav
        className="min-w-0 text-center text-xs text-muted-foreground"
        aria-label="Current project and change"
      >
        <Link href={`/projects/${projectId}`} className="hover:text-foreground">
          {projectId}
        </Link>
        <span className="mx-2 text-white/25">/</span>
        <span className="text-foreground">{change.id}</span>
      </nav>

      <span className="stagepass-local-state shrink-0">
        {isRunning ? "Codex running" : "Local synced"}
      </span>
    </header>
  );
}

function PipelinePageHeader({
  change,
  selectedStage,
  activeStage,
  isRunning,
  readOnly,
  deleteBusy,
  deleteError,
  onDeleteChange,
}: {
  change: ChangeDetail;
  selectedStage: UiStage;
  activeStage: UiStage;
  isRunning: boolean;
  readOnly: boolean;
  deleteBusy: boolean;
  deleteError: string;
  onDeleteChange: () => void;
}) {
  return (
    <header className="border-b border-white/10 px-4 py-5 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="stagepass-kicker">
            {selectedStage.id === activeStage.id ? "Current gate" : "Stage preview"}
          </p>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-xs text-primary/80">{change.id}</span>
            <h1 className="stagepass-serif text-balance text-2xl leading-tight sm:text-3xl">
              {change.title}
            </h1>
          </div>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            {selectedStage.description}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs">
            {selectedStage.label}
          </span>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-muted-foreground">
            {visibleChangeStatus(change)}
          </span>
          {!readOnly && !isRunning && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={onDeleteChange}
              disabled={deleteBusy}
              aria-label={`删除 ${change.id}`}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {deleteBusy ? "删除中..." : "删除"}
            </Button>
          )}
        </div>
      </div>

      {!readOnly && deleteError ? (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {deleteError}
        </p>
      ) : null}

      <Link
        href={`/projects/${change.projectId}`}
        className="mt-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Change Board
      </Link>
    </header>
  );
}
