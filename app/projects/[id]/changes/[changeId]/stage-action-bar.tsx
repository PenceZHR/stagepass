"use client";

import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ProviderPicker } from "./provider-picker";
import type { AiProvider } from "./pipeline-action-contract";

export interface StageActionView {
  id: string;
  label: string;
  role: "primary" | "secondary" | "destructive";
  enabled: boolean;
  busy?: boolean;
  providerBusy?: boolean;
  disabledReason: string | null;
  sourceActionId?: string;
  onAction: () => void | Promise<void>;
}

export interface OrderedStageAction {
  action: StageActionView;
  renderRole: StageActionView["role"];
}

export function getOrderedStageActions(actions: StageActionView[]): OrderedStageAction[] {
  let primarySeen = false;
  const normalized = actions.map((action) => {
    let renderRole: StageActionView["role"] = action.role;

    if (action.role === "primary") {
      if (primarySeen) {
        renderRole = "secondary";
      } else {
        primarySeen = true;
      }
    }

    return { action, renderRole };
  });

  return [
    ...normalized.filter((item) => item.renderRole === "primary"),
    ...normalized.filter((item) => item.renderRole === "secondary"),
    ...normalized.filter((item) => item.renderRole === "destructive"),
  ];
}

export function StageActionBar({
  actions = [],
  actionError = null,
  ariaLabel = "Stage actions",
  provider,
  onProviderChange,
  providerDisabled = false,
  providerSelectable = true,
}: {
  actions?: StageActionView[];
  actionError?: ReactNode;
  ariaLabel?: string;
  provider?: AiProvider;
  onProviderChange?: (provider: AiProvider) => void;
  providerDisabled?: boolean;
  providerSelectable?: boolean;
}) {
  const helpId = useId();
  const errorId = useId();
  const orderedActions = getOrderedStageActions(actions);
  const disabledReasons = orderedActions
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.action.enabled && item.action.disabledReason)
    .map(({ item, index }) => ({
      id: item.action.id,
      label: item.action.label,
      reason: item.action.disabledReason,
      elementId: `${helpId}-${index}`,
    }));
  const disabledReasonIds = new Map(disabledReasons.map((item) => [item.id, item.elementId]));
  const hasDisabledReasons = disabledReasons.length > 0;
  const actionBusy = actions.some((action) => action.busy === true || action.providerBusy === true);

  const showProviderPicker = providerSelectable && Boolean(onProviderChange);

  if (orderedActions.length === 0 && !actionError && !showProviderPicker) return null;

  return (
    <div className="space-y-2" role="group" aria-label={ariaLabel}>
      {showProviderPicker ? (
        <ProviderPicker
          value={provider ?? "codex"}
          onChange={onProviderChange!}
          disabled={providerDisabled || actionBusy}
          id={`${helpId}-provider`}
        />
      ) : null}
      {orderedActions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {orderedActions.map((item, index) => {
            const { action } = item;
            const disabled = !action.enabled || action.busy === true;
            const disabledReasonId = disabledReasonIds.get(action.id);
            const describedBy = [
              !action.enabled ? disabledReasonId : null,
              actionError ? errorId : null,
            ]
              .filter(Boolean)
              .join(" ") || undefined;
            const variant =
              item.renderRole === "primary"
                ? "default"
                : item.renderRole === "destructive"
                  ? "destructive"
                  : "outline";
            const separated = item.renderRole === "destructive" && index > 0;

            return (
              <Button
                key={action.id}
                type="button"
                size="sm"
                variant={variant}
                className={separated ? "ml-0 md:ml-3" : undefined}
                disabled={disabled}
                aria-busy={action.busy === true ? "true" : undefined}
                aria-describedby={describedBy}
                data-action-id={action.id}
                data-source-action-id={action.sourceActionId}
                data-render-role={item.renderRole}
                onClick={() => {
                  void action.onAction();
                }}
              >
                {action.busy ? "处理中..." : action.label}
              </Button>
            );
          })}
        </div>
      ) : null}

      {hasDisabledReasons ? (
        <div
          id={helpId}
          className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          aria-live="polite"
        >
          <span className="font-medium text-foreground">不可用原因：</span>
          <span>
            {disabledReasons.map((item, index) => (
              <span key={item.id} id={item.elementId}>
                {index > 0 ? "；" : null}
                {item.label}: {item.reason}
              </span>
            ))}
          </span>
        </div>
      ) : null}

      {actionError ? (
        <div id={errorId} role="alert" className="text-sm font-medium text-destructive">
          {actionError}
        </div>
      ) : null}
    </div>
  );
}
