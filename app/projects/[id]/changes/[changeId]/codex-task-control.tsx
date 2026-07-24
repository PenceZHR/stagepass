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

  return (
    <section
      className="mb-5 rounded-md border bg-muted/20 p-4"
      aria-labelledby="codex-task-control-title"
      data-codex-task-control
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="codex-task-control-title" className="text-sm font-semibold">
            Codex task control
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {control.bindingTitle ?? "No bound task"} · {control.bindingStatus}
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p>Desktop: {health?.status ?? "checking"}</p>
          <p>MCP: {health?.mcpHostEvidence?.status ?? "unknown"}</p>
        </div>
      </div>

      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Last turn</dt>
          <dd className="break-all font-mono">{control.lastTurnId ?? "none"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Observation</dt>
          <dd>{control.lastObservationCursor ?? 0}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Current interaction</dt>
          <dd className="break-all font-mono">
            {control.currentInteractionId ?? "none"}
          </dd>
        </div>
      </dl>

      {control.lastErrorCode && (
        <p className="mt-3 rounded border border-amber-500/40 px-2 py-1.5 text-xs">
          Recovery guidance: bridge reported {control.lastErrorCode}. Repair
          the binding, then retry the stage.
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy || !control.threadId} onClick={onOpen}>
          Open in Codex
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onStart}>
          Start stage
        </Button>
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
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRepair}>
          Repair binding
        </Button>
        <a
          href="#stage-evidence"
          className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium"
        >
          Evidence
        </a>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
        <label className="text-xs">
          <span className="block text-muted-foreground">Model override</span>
          <input
            className="mt-1 rounded-md border bg-background px-2 py-1.5"
            value={model}
            placeholder="Codex default"
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <label className="text-xs">
          <span className="block text-muted-foreground">Reasoning effort</span>
          <input
            className="mt-1 rounded-md border bg-background px-2 py-1.5"
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
          Save model settings
        </Button>
      </div>
    </section>
  );
}
