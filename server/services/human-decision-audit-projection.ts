import type { ActorSurface } from "../types/enums";

export interface HumanDecisionAuditSource {
  readonly actorSurface?: ActorSurface | null;
}

export type HumanDecisionAuditProjection =
  | { readonly actorSurface: ActorSurface; readonly provenance: "recorded" }
  | { readonly actorSurface: "legacy"; readonly provenance: "historical_null" };

/**
 * Projects provenance for display without rewriting historical rows.
 * A NULL is evidence that the decision predates surface attribution, not a
 * durable actor value that may be silently backfilled.
 */
export function projectHumanDecisionAudit(
  row: HumanDecisionAuditSource,
): HumanDecisionAuditProjection {
  return row.actorSurface == null
    ? { actorSurface: "legacy", provenance: "historical_null" }
    : { actorSurface: row.actorSurface, provenance: "recorded" };
}
