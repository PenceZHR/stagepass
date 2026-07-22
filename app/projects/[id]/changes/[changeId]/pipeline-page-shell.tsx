"use client";

import { useEffect, useState, type ReactNode } from "react";
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
  // Closed by default: the rail used to be a permanent 13rem column, and the
  // reason to make it a drawer is that the page needs that width back.
  const [railOpen, setRailOpen] = useState(false);

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

      <div className="min-w-0">
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

        <PipelineRailDrawer
          open={railOpen}
          onOpenChange={setRailOpen}
          isRunning={isRunning}
        >
          <VerticalPhaseRail
            status={change.status}
            stages={stages}
            selectedPhase={selectedPhase}
            phaseOverviews={phaseOverviews}
            reviewCenterState={reviewCenterState}
            isRunning={isRunning}
            onSelectPhase={(phase) => {
              onSelectPhase(phase);
              setRailOpen(false);
            }}
          />
        </PipelineRailDrawer>
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

/**
 * The pipeline rail as a drawer instead of a permanent column.
 *
 * It used to be a 13rem grid column that was always on screen, which cost the
 * main content that width on every page. The rail is a navigation aid — you
 * consult it to jump stages, you do not read it while working — so it opens on
 * demand and gets out of the way again. Selecting a stage closes it, because the
 * thing you wanted is now behind it.
 */
function PipelineRailDrawer({
  open,
  onOpenChange,
  isRunning,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isRunning: boolean;
  children: ReactNode;
}) {
  // Escape closes it. A drawer that covers content and can only be dismissed by
  // hitting the same small toggle is a trap on a narrow window.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls="pipeline-rail-drawer"
        data-pipeline-rail-toggle
        title={open ? "收起 Pipeline (Esc)" : "展开 Pipeline"}
        className="fixed right-0 top-24 z-50 flex items-center gap-1.5 rounded-l-md border border-r-0 bg-background/95 px-2 py-3 text-xs font-medium shadow-sm backdrop-blur transition hover:bg-muted"
      >
        {/* The running dot has to survive the rail being closed: it is the one
            thing in there you need to see without asking for it. */}
        {isRunning && !open && (
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
        )}
        <span className="[writing-mode:vertical-rl]">Pipeline</span>
        <span aria-hidden>{open ? "›" : "‹"}</span>
      </button>

      {open && (
        <div
          data-pipeline-rail-scrim
          onClick={() => onOpenChange(false)}
          className="fixed inset-0 z-40 bg-black/20"
        />
      )}

      <aside
        id="pipeline-rail-drawer"
        data-pipeline-rail
        data-open={open ? "true" : "false"}
        aria-hidden={!open}
        className={`fixed right-0 top-0 z-40 h-full w-56 overflow-y-auto border-l bg-background p-4 shadow-lg transition-transform duration-200 ${
          open ? "translate-x-0" : "pointer-events-none translate-x-full"
        }`}
      >
        {children}
      </aside>
    </>
  );
}
