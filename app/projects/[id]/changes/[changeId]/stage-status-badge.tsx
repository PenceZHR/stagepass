import type { UiStageState } from "./pipeline-ui-model";

export const STAGE_STATUS_BADGE_COPY: Record<
  UiStageState,
  { label: string; tone: string; dot: string }
> = {
  not_started: {
    label: "未开始",
    tone: "border-white/10 bg-white/5 text-muted-foreground",
    dot: "border border-muted-foreground/60 bg-transparent",
  },
  waiting: {
    label: "等待中",
    tone: "border-white/12 bg-black/10 text-muted-foreground",
    dot: "bg-muted-foreground/70",
  },
  running: {
    label: "运行中",
    tone: "border-primary/35 bg-primary/10 text-primary",
    dot: "bg-primary",
  },
  needs_review: {
    label: "待审核",
    tone: "border-primary/35 bg-primary/10 text-primary",
    dot: "bg-primary",
  },
  blocked: {
    label: "已阻断",
    tone: "border-destructive/35 bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
  failed: {
    label: "失败",
    tone: "border-destructive/35 bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
  stale: {
    label: "已过期",
    tone: "border-primary/25 bg-primary/5 text-primary/80",
    dot: "bg-primary/70",
  },
  complete: {
    label: "已完成",
    tone: "border-success/35 bg-success/10 text-success",
    dot: "bg-success",
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
