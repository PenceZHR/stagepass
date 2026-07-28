"use client";

import type { ReactNode } from "react";
import type { UiStage, UiStageState } from "./pipeline-ui-model";
import { StageStatusBadge } from "./stage-status-badge";

export interface StageMetaItem {
  id: string;
  label: string;
  value: ReactNode;
}

export interface StageBlockerView {
  id: string;
  label: string;
  description?: ReactNode;
  severity?: "info" | "warning" | "error";
}

type StageFrameStage = Pick<UiStage, "label" | "description" | "state">;

export interface StageFrameProps {
  stage?: StageFrameStage;
  state?: UiStageState;
  label?: string;
  title: string;
  description?: ReactNode;
  eyebrow?: string;
  meta?: StageMetaItem[];
  error?: ReactNode;
  blockers?: StageBlockerView[];
  evidence?: ReactNode;
  evidenceLabel?: string;
  children: ReactNode;
}

export function StageFrame({
  stage,
  state,
  label,
  title,
  description,
  eyebrow = "当前阶段",
  meta = [],
  error = null,
  blockers = [],
  evidence = null,
  evidenceLabel = "阶段记录",
  children,
}: StageFrameProps) {
  const resolvedState = state ?? stage?.state ?? "waiting";
  const stageLabel = label ?? stage?.label ?? title;
  const stageDescription = description ?? stage?.description;
  const hasMore = meta.length > 0 || evidence;

  return (
    <section className="space-y-5" data-stage-frame>
      <header aria-label={`${stageLabel} 阶段概览`}>
        <p className="stagepass-kicker">{eyebrow}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h2 className="stagepass-serif text-2xl font-normal tracking-normal">{title}</h2>
          <StageStatusBadge state={resolvedState} />
        </div>
        {stageDescription ? (
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            {stageDescription}
          </p>
        ) : null}

        {error ? (
          <div
            className="mt-3 border-l-2 border-destructive bg-destructive/[0.045] px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {error}
          </div>
        ) : null}
      </header>

      {blockers.length > 0 ? (
        <section className="border-l-2 border-destructive/60 bg-destructive/[0.045] px-4 py-3" aria-label={`${stageLabel} blockers`}>
          <h3 className="stagepass-kicker text-destructive">阻断项</h3>
          <ul className="mt-2 space-y-2">
            {blockers.map((blocker) => (
              <li
                key={blocker.id}
                className={`border-l-2 pl-2 text-sm ${blockerSeverityClass(blocker.severity)}`}
                data-blocker-severity={blocker.severity ?? "info"}
              >
                <span className="font-medium text-foreground">{blocker.label}</span>
                {blocker.description ? (
                  <p className="mt-0.5 text-muted-foreground">{blocker.description}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        className="min-w-0"
        role="region"
        aria-label={`${stageLabel} workspace`}
        data-stage-workspace
      >
        {children}
      </section>

      {hasMore ? (
        <details className="border-t border-white/10 pt-4" data-stage-more>
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
            更多阶段信息
          </summary>
          <div className="mt-4 space-y-5">
            {meta.length > 0 ? (
              <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                {meta.map((item) => (
                  <div key={item.id}>
                    <dt>{item.label}</dt>
                    <dd className="mt-0.5 font-semibold text-foreground">{item.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {evidence ? (
              <aside className="min-w-0" aria-label={evidenceLabel}>
                {evidence}
              </aside>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function blockerSeverityClass(severity: StageBlockerView["severity"]): string {
  if (severity === "error") return "border-destructive";
  if (severity === "warning") return "border-amber-500";
  return "border-muted-foreground/40";
}
