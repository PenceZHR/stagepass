import type { UiStageState } from "./pipeline-ui-model";

export const STAGE_STATUS_BADGE_COPY: Record<
  UiStageState,
  { label: string; tone: string; dot: string }
> = {
  not_started: {
    label: "未开始",
    tone: "border-border bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
  waiting: {
    label: "等待中",
    tone: "border-border bg-background text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  running: {
    label: "运行中",
    tone: "border-primary/30 bg-primary/10 text-primary",
    dot: "bg-primary",
  },
  needs_review: {
    label: "待审核",
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  blocked: {
    label: "已阻断",
    tone: "border-destructive/30 bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
  failed: {
    label: "失败",
    tone: "border-destructive/30 bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
  stale: {
    label: "已过期",
    tone: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
    dot: "bg-orange-500",
  },
  complete: {
    label: "已完成",
    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
};

export function StageStatusBadge({
  state,
  className = "",
}: {
  state: UiStageState;
  className?: string;
}) {
  const copy = STAGE_STATUS_BADGE_COPY[state];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold ${copy.tone} ${className}`}
      data-stage-state={state}
      aria-label={`阶段状态：${copy.label}`}
    >
      <span className={`size-1.5 rounded-full ${copy.dot}`} aria-hidden="true" />
      <span>{copy.label}</span>
    </span>
  );
}
