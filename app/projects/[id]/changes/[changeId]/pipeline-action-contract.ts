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
  defaultProvider: AiProvider;
}

/** Browser-safe provider type shared by action payloads and UI controls. */
export type AiProvider = "codex" | "claude";

export function isAiProvider(value: unknown): value is AiProvider {
  return value === "codex" || value === "claude";
}

export function actionAcceptsProvider(action: PipelineActionContract | null | undefined): boolean {
  return action?.requiresProvider === true && action.providerSelectable === true;
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
  const { provider, ...safeExtra } = extra ?? {};
  return {
    actionId: action?.actionId,
    expectedGateVersion: action?.gateVersion,
    expectedSourceDbHash: action?.sourceDbHash,
    idempotencyKey: createIdempotencyKey(action?.actionId ?? "missing-action"),
    ...safeExtra,
    ...(actionAcceptsProvider(action) && isAiProvider(provider) ? { provider } : {}),
  };
}
