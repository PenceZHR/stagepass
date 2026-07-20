import type { PlanRisk } from "./plan-sandbox-types";
import type { RequirementGap } from "./spec-battle-types";

/**
 * A written human decision is binding, so the findings being ruled on have to be
 * on screen while the reason is typed. These selectors turn domain records
 * (requirement gaps, plan risks, review findings) into the generic shape
 * `ActionReasonDialog` renders, so the shared dialog never learns about any one
 * domain and other call sites can supply their own context later.
 */
export interface ActionReasonContextItem {
  id: string;
  /** Free-form severity label ("P0" / "P1" / "P2"); omitted when not applicable. */
  severity?: string | null;
  /** Short mono-spaced locator: canonical gap id, `file:line`, risk category. */
  reference?: string | null;
  title: string;
  /** The evidence / why-it-matters body. Rendered in full, never truncated. */
  detail?: string | null;
  /** Secondary line: required fix, downgrade history, affected steps. */
  note?: string | null;
}

export interface ActionReasonContext {
  heading: string;
  summary?: string | null;
  items: ActionReasonContextItem[];
}

/**
 * Statuses that still count as "on the battlefield". Mirrors
 * ACTIVE_GAP_STATUSES in server/services/spec-battle-rules.ts.
 */
export const ACTIVE_GAP_STATUSES = ["open", "downgraded", "overridden"] as const;

/** A P1 can only be waived while it is still open or has been downgraded to P1. */
export const WAIVABLE_GAP_STATUSES = ["open", "downgraded"] as const;

export function effectiveSeverity(gap: Pick<RequirementGap, "severity" | "downgradedTo">): string {
  return gap.downgradedTo ?? gap.severity;
}

export function isActiveGap(gap: Pick<RequirementGap, "status">): boolean {
  return (ACTIVE_GAP_STATUSES as readonly string[]).includes(gap.status);
}

export function severityRank(severity: string | null | undefined): number {
  if (severity === "P0") return 0;
  if (severity === "P1") return 1;
  if (severity === "P2") return 2;
  return 3;
}

export function severityTone(severity: string | null | undefined): string {
  if (severity === "P0") return "border-red-200 bg-red-50 text-red-900";
  if (severity === "P1") return "border-orange-200 bg-orange-50 text-orange-900";
  if (severity === "P2") return "border-yellow-200 bg-yellow-50 text-yellow-900";
  return "border-slate-200 bg-slate-50 text-slate-900";
}

function joinNotes(parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((part): part is string => Boolean(part && part.trim()));
  return kept.length > 0 ? kept.join(" · ") : null;
}

/** Severity first (P0 → P1 → P2 → unknown), input order preserved within a severity. */
function bySeverity(items: ActionReasonContextItem[]): ActionReasonContextItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const rankDelta = severityRank(a.item.severity) - severityRank(b.item.severity);
      return rankDelta !== 0 ? rankDelta : a.index - b.index;
    })
    .map((entry) => entry.item);
}

function gapToItem(gap: RequirementGap): ActionReasonContextItem {
  const severity = effectiveSeverity(gap);
  return {
    id: gap.id,
    severity,
    reference: `${gap.canonicalGapId} · ${gap.status}`,
    title: gap.title,
    detail: gap.evidence,
    note: joinNotes([
      gap.downgradedTo ? `已从 ${gap.originalSeverity} 降级为 ${gap.downgradedTo}` : null,
      gap.proposedSpecPatch ? `建议补丁: ${gap.proposedSpecPatch}` : null,
    ]),
  };
}

/**
 * "Continue the battle" rules on everything still unclosed, so the subject is
 * every active gap — resolved and waived gaps are already off the table.
 */
export function selectSpecBattleDecisionContext(
  gaps: RequirementGap[] | null | undefined,
): ActionReasonContext | null {
  const items = bySeverity((gaps ?? []).filter(isActiveGap).map(gapToItem));
  if (items.length === 0) return null;
  return {
    heading: "本轮未关闭的 Requirement Gap",
    summary: `共 ${items.length} 项`,
    items,
  };
}

/** Accepting a Spec risk waives exactly one P1 — show that one, never the rest. */
export function selectSpecRiskWaiverContext(
  gaps: RequirementGap[] | null | undefined,
  targetId: string | null | undefined,
): ActionReasonContext | null {
  if (!targetId) return null;
  const target = (gaps ?? []).find((gap) => gap.id === targetId);
  if (!target) return null;
  return {
    heading: "你正在接受的 P1 风险",
    summary: "只对这一项生效",
    items: [gapToItem(target)],
  };
}

/** Waiving a Plan risk waives exactly one risk. */
export function selectPlanRiskWaiverContext(
  risks: PlanRisk[] | null | undefined,
  riskId: string | null | undefined,
): ActionReasonContext | null {
  if (!riskId) return null;
  const target = (risks ?? []).find((risk) => risk.id === riskId);
  if (!target) return null;
  return {
    heading: "你正在接受的 Plan 风险",
    summary: "只对这一项生效",
    items: [
      {
        id: target.id,
        severity: target.severity,
        reference: `${target.category} · ${target.status}`,
        title: target.title,
        detail: target.evidence,
        note: joinNotes([
          target.requiredPlanChange ? `必须修改: ${target.requiredPlanChange}` : null,
          target.affectedStepNumbers.length > 0
            ? `影响步骤: ${target.affectedStepNumbers.join(", ")}`
            : null,
        ]),
      },
    ],
  };
}

/**
 * Structural shape of a waivable Review finding. Declared here rather than
 * imported from review-report-center.tsx so this module stays free of component
 * imports; `ReviewFindingView` satisfies it structurally at the call site.
 */
export interface WaivableFinding {
  id: string;
  severity: string;
  category: string;
  title: string;
  file: string | null;
  line: number | null;
  evidence: string;
  requiredFix: string | null;
  status: string;
}

/** Waiving a Review P1 waives exactly one finding. */
export function selectReviewFindingWaiverContext(
  findings: WaivableFinding[] | null | undefined,
  findingId: string | null | undefined,
): ActionReasonContext | null {
  if (!findingId) return null;
  const target = (findings ?? []).find((finding) => finding.id === findingId);
  if (!target) return null;
  const location = target.file
    ? `${target.file}${target.line ? `:${target.line}` : ""}`
    : target.category;
  return {
    heading: "你正在接受的 Review P1 发现",
    summary: "只对这一项生效",
    items: [
      {
        id: target.id,
        severity: target.severity,
        reference: `${location} · ${target.status}`,
        title: target.title,
        detail: target.evidence,
        note: target.requiredFix ? `必须修复: ${target.requiredFix}` : null,
      },
    ],
  };
}
