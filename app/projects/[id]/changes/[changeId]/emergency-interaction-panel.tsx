"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

export type BridgeHealthStatus =
  | "ready"
  | "disabled"
  | "unavailable"
  | "unsupported"
  | "detached";

export function shouldShowEmergency(
  health: { status: BridgeHealthStatus } | null,
  codexDecisionEnabled: boolean,
): boolean {
  return codexDecisionEnabled
    && health !== null
    && health.status !== "ready";
}

export interface EmergencyInteraction {
  id: string;
  title: string;
  summary: string;
  actionIds: string[];
  gateVersion?: string;
  sourceDbHash?: string;
  expectedHeadSha?: string | null;
}

export function EmergencyInteractionPanel({
  health,
  codexDecisionEnabled,
  interaction,
  busy = false,
  onSubmit,
}: {
  health: { status: BridgeHealthStatus } | null;
  codexDecisionEnabled: boolean;
  interaction: EmergencyInteraction | null;
  busy?: boolean;
  onSubmit: (input: {
    interactionId: string;
    actionId: string;
    reason: string;
    disclosureAccepted: true;
  }) => Promise<void>;
}) {
  const [disclosed, setDisclosed] = useState(false);
  const [reason, setReason] = useState("");
  const [selectedAction, setSelectedAction] = useState(
    interaction?.actionIds[0] ?? "",
  );

  if (!interaction || !shouldShowEmergency(health, codexDecisionEnabled)) {
    return null;
  }

  return (
    <section
      className="rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm dark:bg-amber-950/20"
      aria-labelledby="emergency-interaction-title"
      data-emergency-interaction
    >
      <h3 id="emergency-interaction-title" className="font-semibold">
        Emergency decision fallback
      </h3>
      <p className="mt-1 text-muted-foreground">
        Codex/MCP bridge is {health?.status}. This fallback records the decision
        as <code>stagepass_web_emergency</code>.
      </p>
      <p className="mt-2 font-medium">{interaction.title}</p>
      <p className="text-muted-foreground">{interaction.summary}</p>
      <label className="mt-3 block">
        <span className="text-xs font-medium">Decision</span>
        <select
          className="mt-1 block w-full rounded-md border bg-background px-2 py-1.5"
          value={selectedAction}
          onChange={(event) => setSelectedAction(event.target.value)}
        >
          {interaction.actionIds.map((actionId) => (
            <option key={actionId} value={actionId}>{actionId}</option>
          ))}
        </select>
      </label>
      <label className="mt-3 block">
        <span className="text-xs font-medium">Reason</span>
        <textarea
          className="mt-1 block min-h-20 w-full rounded-md border bg-background px-2 py-1.5"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
        />
      </label>
      <label className="mt-3 flex items-start gap-2">
        <input
          type="checkbox"
          checked={disclosed}
          onChange={(event) => setDisclosed(event.target.checked)}
        />
        <span>
          I understand this bypasses the unavailable Codex MCP presentation
          surface and will be explicitly audited.
        </span>
      </label>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        className="mt-3"
        disabled={busy || !disclosed || !selectedAction || reason.trim().length === 0}
        onClick={() => onSubmit({
          interactionId: interaction.id,
          actionId: selectedAction,
          reason: reason.trim(),
          disclosureAccepted: true,
        })}
      >
        Submit emergency decision
      </Button>
    </section>
  );
}
