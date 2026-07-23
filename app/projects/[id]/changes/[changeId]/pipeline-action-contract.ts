export interface PipelineActionContract {
  actionId: string;
  phase: "PRD" | "Spec" | "Plan" | "TestPlan" | "Build" | "Review" | "QA" | "Merge";
  label: string;
  enabled: boolean;
  reasonCode: string | null;
  reason: string | null;
  blockers: Array<{ id: string; severity: "P0" | "P1" | "P2"; title: string }>;
  warnings: Array<{ id: string; severity: "warning"; title: string }>;
  gateVersion: string;
  sourceDbHash: string;
  requiresIdempotencyKey: boolean;
  requiresProvider: boolean;
  providerSelectable: boolean;
  defaultProvider: "codex";
}

export function findPipelineAction(
  actions: PipelineActionContract[] | undefined,
  actionId: string,
): PipelineActionContract | null {
  return actions?.find((action) => action.actionId === actionId) ?? null;
}

export function pipelineActionDisabledReason(action: PipelineActionContract | null): string | null {
  if (!action) return "Action contract unavailable.";
  if (action.enabled) return null;
  if (action.reason) return action.reason;
  if (action.reasonCode) return action.reasonCode;
  if (action.blockers.length > 0) {
    return action.blockers.map((blocker) => `${blocker.severity}: ${blocker.title}`).join("; ");
  }
  return "Action is not available.";
}

export function createIdempotencyKey(actionId: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${actionId}-${crypto.randomUUID()}`;
  }
  return `${actionId}-${Date.now()}`;
}

export function createPipelinePreflightPayload(
  action: PipelineActionContract | null,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const { provider: _provider, ...safeExtra } = extra ?? {};
  return {
    actionId: action?.actionId,
    expectedGateVersion: action?.gateVersion,
    expectedSourceDbHash: action?.sourceDbHash,
    idempotencyKey: createIdempotencyKey(action?.actionId ?? "missing-action"),
    ...safeExtra,
  };
}
