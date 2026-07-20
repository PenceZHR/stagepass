"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { ChangeDetail, PhaseOverview } from "./change-detail-types";
import type { ReviewPhase } from "./change-phase-map";
import { visibleChangeStatus } from "./change-phase-map";
import { PhaseBar, VerticalPhaseRail } from "./phase-rail";
import type { UiStage } from "./pipeline-ui-model";
import type { ReviewCenterResponse } from "./review-report-center";
import type { AiProvider } from "./pipeline-action-contract";

export function PipelinePageShell({
  projectId,
  change,
  selectedStage,
  stages,
  selectedPhase,
  phaseOverviews,
  reviewCenterState,
  isRunning,
  deleteBusy,
  deleteError,
  onDeleteChange,
  onSelectPhase,
  selectedProvider,
  children,
}: {
  projectId: string;
  change: ChangeDetail;
  selectedStage: UiStage;
  stages: UiStage[];
  selectedPhase: ReviewPhase;
  phaseOverviews?: PhaseOverview[];
  reviewCenterState?: ReviewCenterResponse | null;
  isSpecBattleMode: boolean;
  isRunning: boolean;
  deleteBusy: boolean;
  deleteError: string;
  onDeleteChange: () => void;
  onSelectPhase: (phase: ReviewPhase) => void;
  selectedProvider?: AiProvider;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      <div className="mb-2">
        <Link
          href={`/projects/${projectId}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Change Board
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_13rem]">
        <main className="min-w-0">
          <PipelinePageHeader
            change={change}
            selectedStage={selectedStage}
            isRunning={isRunning}
            deleteBusy={deleteBusy}
            deleteError={deleteError}
            onDeleteChange={onDeleteChange}
            selectedProvider={selectedProvider}
          />

          <div className="mb-5 lg:hidden">
            <PhaseBar
              status={change.status}
              stages={stages}
              selectedPhase={selectedPhase}
              phaseOverviews={phaseOverviews}
              reviewCenterState={reviewCenterState}
              onSelectPhase={onSelectPhase}
            />
            {isRunning && (
              <div className="mt-2 flex items-center gap-2 text-xs text-yellow-700">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
                Running...
              </div>
            )}
          </div>

          {children}
        </main>

        <aside className="hidden lg:block">
          <div className="sticky top-6">
            <VerticalPhaseRail
              status={change.status}
              stages={stages}
              selectedPhase={selectedPhase}
              phaseOverviews={phaseOverviews}
              reviewCenterState={reviewCenterState}
              isRunning={isRunning}
              onSelectPhase={onSelectPhase}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

function PipelinePageHeader({
  change,
  selectedStage,
  isRunning,
  deleteBusy,
  deleteError,
  onDeleteChange,
  selectedProvider,
}: {
  change: ChangeDetail;
  selectedStage: UiStage;
  isRunning: boolean;
  deleteBusy: boolean;
  deleteError: string;
  onDeleteChange: () => void;
  selectedProvider?: AiProvider;
}) {
  return (
    <div className="mb-5">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
        <h1 className="min-w-0 flex-1 text-lg font-bold leading-snug sm:text-2xl">
          <span className="mb-1 block shrink-0 font-mono text-sm font-normal text-muted-foreground sm:text-base">
            {change.id}
          </span>
          <span className="block min-w-0 break-words">
            {change.title}
          </span>
        </h1>
        {!isRunning && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="shrink-0"
            onClick={onDeleteChange}
            disabled={deleteBusy}
            aria-label={`删除 ${change.id}`}
          >
            {deleteBusy ? "删除中..." : "删除 Change"}
          </Button>
        )}
      </div>
      {deleteError && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{deleteError}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-4 text-sm text-muted-foreground">
        <span>Status: <strong className="text-foreground">{visibleChangeStatus(change)}</strong></span>
        <span>Stage: <strong className="text-foreground">{selectedStage.label}</strong></span>
        {change.provider && (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
              change.provider === "claude"
                ? "bg-orange-100 text-orange-700"
                : "bg-blue-100 text-blue-700"
            }`}
          >
            Change 默认 Provider: {change.provider === "claude" ? "Claude" : "Codex"}
          </span>
        )}
        {selectedProvider && (
          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium text-foreground">
            本次运行 Provider: {selectedProvider === "claude" ? "Claude" : "Codex"}
          </span>
        )}
        <span>Fix Iterations: {change.fixIterations}</span>
        {change.gitBranch && (
          <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
            ⎇ {change.gitBranch}
          </span>
        )}
        {change.codexThreadId && (
          <span>Thread: {change.codexThreadId}</span>
        )}
        <span>Created: {new Date(change.createdAt).toLocaleString()}</span>
        <span>Updated: {new Date(change.updatedAt).toLocaleString()}</span>
      </div>
    </div>
  );
}
