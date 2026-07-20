"use client";

import type { ReactNode } from "react";
import type { UiStage, UiStageState } from "./pipeline-ui-model";
import { StageActionBar, type StageActionView } from "./stage-action-bar";
import { StageStatusBadge } from "./stage-status-badge";
import type { AiProvider } from "./pipeline-action-contract";

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
  actions?: StageActionView[];
  actionError?: ReactNode;
  provider?: AiProvider;
  onProviderChange?: (provider: AiProvider) => void;
  providerDisabled?: boolean;
  providerSelectable?: boolean;
  error?: ReactNode;
  blockers?: StageBlockerView[];
  /**
   * The phase's rubric drawer. Rendered in the stage body ABOVE `evidence`,
   * never inside it: `evidence` is a collapsed `<details>`, and §7.3 requires
   * the rubric editor to be visible without a click.
   */
  rubric?: ReactNode;
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
  eyebrow = "Pipeline Stage",
  meta = [],
  actions = [],
  actionError = null,
  provider,
  onProviderChange,
  providerDisabled = false,
  providerSelectable = false,
  error = null,
  blockers = [],
  rubric = null,
  evidence = null,
  evidenceLabel = "阶段记录",
  children,
}: StageFrameProps) {
  const resolvedState = state ?? stage?.state ?? "waiting";
  const stageLabel = label ?? stage?.label ?? title;
  const stageDescription = description ?? stage?.description;

  return (
    <section className="space-y-4" data-stage-frame>
      <header className="border-b pb-4" aria-label={`${stageLabel} 阶段概览`}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {eyebrow}
            </p>
            <div className="mt-1 flex flex-wrap items-baseline gap-2">
              <span className="rounded-md border bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">
                {stageLabel}
              </span>
              <h2 className="text-xl font-semibold tracking-normal">{title}</h2>
              <StageStatusBadge state={resolvedState} />
            </div>
            {stageDescription ? (
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{stageDescription}</p>
            ) : null}
          </div>

          <div className="grid gap-3 lg:min-w-56 lg:justify-items-end lg:text-right">
            {meta.length > 0 ? (
              <dl className="grid gap-1 text-xs text-muted-foreground">
                {meta.map((item) => (
                  <div key={item.id}>
                    <dt className="inline">{item.label} </dt>
                    <dd className="inline font-semibold text-foreground">{item.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <StageActionBar
              actions={actions}
              actionError={actionError}
              ariaLabel={`${stageLabel} actions`}
              provider={provider}
              onProviderChange={onProviderChange}
              providerDisabled={providerDisabled}
              providerSelectable={providerSelectable}
            />
          </div>
        </div>

        {error ? (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
            {error}
          </div>
        ) : null}
      </header>

      {blockers.length > 0 ? (
        <section className="rounded-md border border-dashed bg-muted/30 p-3" aria-label={`${stageLabel} blockers`}>
          <h3 className="text-sm font-semibold">阻断项</h3>
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

      <div className={evidence || rubric ? "space-y-4" : ""}>
        {/*
          Above the workspace, not below it. Measured in a real browser: on the
          Plan stage the task map is long enough to push anything that follows
          it ~3900px down — the same "capability exists but sits 4.7 screens
          below the fold" failure §7.3 was written about. A blocking verdict
          nobody scrolls to is a blocking verdict nobody acts on.
        */}
        {rubric ? (
          <section className="min-w-0" aria-label={`${stageLabel} 评判标准`}>
            {rubric}
          </section>
        ) : null}

        <section className="min-w-0" role="region" aria-label={`${stageLabel} workspace`}>
          {children}
        </section>

        {evidence ? (
          <aside className="min-w-0" aria-label={evidenceLabel}>
            {evidence}
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function blockerSeverityClass(severity: StageBlockerView["severity"]): string {
  if (severity === "error") return "border-destructive";
  if (severity === "warning") return "border-amber-500";
  return "border-muted-foreground/40";
}
