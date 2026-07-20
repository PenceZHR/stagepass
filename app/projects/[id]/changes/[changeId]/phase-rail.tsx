import type { ChangeDetail, PhaseOverview } from "./change-detail-types";
import type { ReviewCenterResponse } from "./review-report-center";
import type { ReviewPhase } from "./change-phase-map";
import { buildUiPipelineState, type UiStage, type UiStageState } from "./pipeline-ui-model";

type PhaseRailInput = {
  status: string;
  selectedPhase?: ReviewPhase | null;
  phaseOverviews?: PhaseOverview[];
  reviewCenterState?: ReviewCenterResponse | null;
};

type PipelineStageItemVariant = "mobile" | "desktop";

export function buildPhaseRailStages({
  status,
  selectedPhase,
  phaseOverviews,
  reviewCenterState,
}: PhaseRailInput): UiStage[] {
  return buildUiPipelineState({
    change: minimalChangeForStatus(status),
    selectedPhase,
    phaseOverviews,
    reviewCenterState,
  }).stages;
}

export function PhaseBar({
  status,
  selectedPhase,
  phaseOverviews,
  reviewCenterState,
  stages: providedStages,
  onSelectPhase,
}: {
  status: string;
  selectedPhase: ReviewPhase;
  phaseOverviews?: PhaseOverview[];
  reviewCenterState?: ReviewCenterResponse | null;
  stages?: UiStage[];
  onSelectPhase: (phase: ReviewPhase) => void;
}) {
  const stages = providedStages ?? buildPhaseRailStages({ status, selectedPhase, phaseOverviews, reviewCenterState });

  return (
    <div className="flex flex-wrap items-center gap-1">
      {stages.map((stage) => (
        <PipelineStageItem
          key={stage.id}
          stage={stage}
          variant="mobile"
          onSelectPhase={onSelectPhase}
        />
      ))}
    </div>
  );
}

export function VerticalPhaseRail({
  status,
  selectedPhase,
  phaseOverviews,
  reviewCenterState,
  stages: providedStages,
  isRunning,
  onSelectPhase,
}: {
  status: string;
  selectedPhase: ReviewPhase;
  phaseOverviews?: PhaseOverview[];
  reviewCenterState?: ReviewCenterResponse | null;
  stages?: UiStage[];
  isRunning: boolean;
  onSelectPhase: (phase: ReviewPhase) => void;
}) {
  const stages = providedStages ?? buildPhaseRailStages({ status, selectedPhase, phaseOverviews, reviewCenterState });

  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Pipeline</h2>
        {isRunning && (
          <span className="inline-flex items-center gap-1 text-xs text-yellow-700">
            <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
            Running
          </span>
        )}
      </div>
      <div className="space-y-1">
        {stages.map((stage) => (
          <PipelineStageItem
            key={stage.id}
            stage={stage}
            variant="desktop"
            onSelectPhase={onSelectPhase}
          />
        ))}
      </div>
    </div>
  );
}

function PipelineStageItem({
  stage,
  variant,
  onSelectPhase,
}: {
  stage: UiStage;
  variant: PipelineStageItemVariant;
  onSelectPhase: (phase: ReviewPhase) => void;
}) {
  const canSelect = stage.selectable && stage.reviewPhase !== null;
  const selectedStyle = stage.selected ? selectedClassName(variant) : "";
  const disabledStyle = canSelect ? interactiveClassName(variant) : "cursor-default opacity-50";
  const stateStyle = stateClassName(stage.state, variant);
  const baseClassName = variant === "mobile"
    ? "h-7 rounded px-3 text-xs font-medium transition"
    : "grid h-9 w-full grid-cols-[1rem_1fr] items-center gap-2 rounded border px-2 text-left text-xs font-medium transition";

  return (
    <button
      type="button"
      className={`${baseClassName} ${stateStyle.button} ${selectedStyle} ${disabledStyle}`}
      disabled={!canSelect}
      onClick={() => {
        if (stage.reviewPhase) onSelectPhase(stage.reviewPhase);
      }}
      aria-pressed={stage.selected}
    >
      {variant === "desktop" && <span className={`h-2 w-2 rounded-full ${stateStyle.dot}`} />}
      <span className="truncate">{stage.label}</span>
    </button>
  );
}

function minimalChangeForStatus(status: string): ChangeDetail {
  return {
    id: "phase-rail-change",
    projectId: "phase-rail-project",
    title: "Pipeline",
    status,
    codexThreadId: null,
    fixIterations: 0,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
  };
}

function stateClassName(
  state: UiStageState,
  variant: PipelineStageItemVariant,
): { button: string; dot: string } {
  const palette = stagePalette(state);
  if (variant === "mobile") {
    return {
      button: palette.mobile,
      dot: palette.dot,
    };
  }
  return {
    button: palette.desktop,
    dot: palette.dot,
  };
}

function stagePalette(state: UiStageState): { mobile: string; desktop: string; dot: string } {
  switch (state) {
    case "complete":
      return {
        mobile: "bg-green-200 text-green-900",
        desktop: "border-green-200 bg-green-50 text-green-900",
        dot: "bg-green-500",
      };
    case "running":
      return {
        mobile: "bg-yellow-200 text-yellow-900",
        desktop: "border-yellow-200 bg-yellow-50 text-yellow-900",
        dot: "bg-yellow-500",
      };
    case "failed":
      return {
        mobile: "bg-red-200 text-red-900",
        desktop: "border-red-200 bg-red-50 text-red-900",
        dot: "bg-red-500",
      };
    case "blocked":
      return {
        mobile: "bg-purple-200 text-purple-900",
        desktop: "border-purple-200 bg-purple-50 text-purple-900",
        dot: "bg-purple-500",
      };
    case "needs_review":
    case "stale":
    case "waiting":
      return {
        mobile: "bg-blue-100 text-blue-800",
        desktop: "border-blue-200 bg-blue-50 text-blue-900",
        dot: "bg-blue-500",
      };
    case "not_started":
      return {
        mobile: "bg-muted text-muted-foreground",
        desktop: "border-transparent text-muted-foreground",
        dot: "bg-muted-foreground/30",
      };
  }
}

function selectedClassName(variant: PipelineStageItemVariant): string {
  return variant === "mobile" ? "ring-2 ring-foreground/30 ring-offset-1" : "ring-2 ring-foreground/20";
}

function interactiveClassName(variant: PipelineStageItemVariant): string {
  return variant === "mobile" ? "hover:brightness-95" : "hover:bg-muted/60";
}
