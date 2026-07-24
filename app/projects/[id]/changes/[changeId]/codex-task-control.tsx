"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { BridgeHealthStatus } from "./emergency-interaction-panel";

export interface CodexControlProjection {
  bindingTitle: string | null;
  bindingStatus: string;
  threadId: string | null;
  lastTurnId: string | null;
  lastObservationCursor: number | null;
  lastSeenAt: string | null;
  lastErrorCode: string | null;
  currentInteractionId: string | null;
  codexDecisionEnabled: boolean;
  model: string | null;
  reasoningEffort: string | null;
}

export interface CodexHealthProjection {
  status: BridgeHealthStatus;
  desktopClientVersion?: string | null;
  mcpHostEvidence?: { status?: string } | null;
}

export function viewFor(input: {
  phase: string;
  codexDecisionEnabled: boolean;
}) {
  return {
    isReadOnly: input.codexDecisionEnabled,
    showsLegacyDecision: !input.codexDecisionEnabled,
  };
}

export function CodexTaskControl({
  control,
  health,
  busy = false,
  readOnly = false,
  onOpen,
  onInterrupt,
  onStart,
  onRetry,
  onRepair,
  onSaveSettings,
}: {
  control: CodexControlProjection;
  health: CodexHealthProjection | null;
  busy?: boolean;
  readOnly?: boolean;
  onOpen: () => Promise<void>;
  onInterrupt: () => Promise<void>;
  onStart: () => Promise<void>;
  onRetry: () => Promise<void>;
  onRepair: () => Promise<void>;
  onSaveSettings: (settings: {
    model: string | null;
    reasoningEffort: string | null;
  }) => Promise<void>;
}) {
  const [model, setModel] = useState(control.model ?? "");
  const [effort, setEffort] = useState(control.reasoningEffort ?? "");
  const hasBoundTask = Boolean(control.threadId);

  return (
    <section
      className="stagepass-surface-subtle mb-6 rounded-xl border-l-2 border-l-primary/60 p-4 sm:p-5"
      aria-labelledby="codex-task-control-title"
      data-codex-task-control
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="stagepass-kicker">Execution surface</p>
          <h2 id="codex-task-control-title" className="stagepass-serif mt-1 text-lg">
            {control.bindingTitle ?? "Codex task"}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            完整推演与 Agent 输出保留在 Codex；Stagepass 只显示门禁事实。
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={`size-1.5 rounded-full ${health?.status === "ready" ? "bg-success" : "bg-destructive"}`} aria-hidden="true" />
          <span>Desktop {health?.status ?? "checking"}</span>
          <span className="text-white/25">·</span>
          <span>MCP {health?.mcpHostEvidence?.status ?? "unknown"}</span>
        </div>
      </div>

      {control.lastErrorCode && (
        <p className="mt-4 border-l-2 border-destructive/70 pl-3 text-xs text-muted-foreground">
          Bridge reported <span className="font-mono text-foreground">{control.lastErrorCode}</span>.
          Repair the binding before retrying this stage.
        </p>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        {hasBoundTask ? (
          <Button type="button" size="sm" disabled={busy} onClick={onOpen}>
            Open in Codex
          </Button>
        ) : !readOnly ? (
          <Button type="button" size="sm" disabled={busy} onClick={onStart}>
            Start stage in Codex
          </Button>
        ) : null}
        {!readOnly ? (
          <>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRetry}>
              Retry
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || control.bindingStatus !== "running"}
              onClick={onInterrupt}
            >
              Interrupt current turn
            </Button>
          </>
        ) : null}
        <a
          href="#stage-evidence"
          className="inline-flex h-9 items-center rounded-md border border-white/12 px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          View evidence
        </a>
      </div>

      <details className="mt-4 border-t border-white/10 pt-3">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          Task diagnostics and model settings
        </summary>
        <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Last turn</dt>
            <dd className="mt-1 break-all font-mono">{control.lastTurnId ?? "none"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Observation</dt>
            <dd className="mt-1">{control.lastObservationCursor ?? 0}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Interaction</dt>
            <dd className="mt-1 break-all font-mono">{control.currentInteractionId ?? "none"}</dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="text-xs">
            <span className="block text-muted-foreground">Model override</span>
            <input
              className="mt-1 rounded-md border bg-background/60 px-2 py-1.5"
              value={model}
              placeholder="Codex default"
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          <label className="text-xs">
            <span className="block text-muted-foreground">Reasoning effort</span>
            <input
              className="mt-1 rounded-md border bg-background/60 px-2 py-1.5"
              value={effort}
              placeholder="Model default"
              onChange={(event) => setEffort(event.target.value)}
            />
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onSaveSettings({
              model: model.trim() || null,
              reasoningEffort: effort.trim() || null,
            })}
          >
            Save settings
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onRepair}>
            Repair binding
          </Button>
        </div>
      </details>
    </section>
  );
}
