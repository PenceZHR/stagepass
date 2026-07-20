export type Severity = "P0" | "P1" | "P2";
export type GapStatus = "open" | "resolved" | "waived" | "downgraded" | "overridden";
export type SpecActionBlockReason =
  | "gate_blocked"
  | "report_stale"
  | "max_round_blocked"
  | "no_blocker"
  | "p1_waiver_disabled"
  | "not_applicable";

export interface RuleGap {
  id: string;
  severity: Severity;
  originalSeverity: Severity;
  downgradedTo: "P1" | "P2" | null;
  status: GapStatus;
}

export interface GapCounts {
  blockingP0: number;
  blockingP1: number;
  nonBlockingP2: number;
  overriddenP0: number;
  openRequirementGaps: number;
  mergeBlockingRequirementGaps: number;
}

export interface ActionAvailabilityInput {
  gaps: RuleGap[];
  reportFresh: boolean;
  currentRoundNo: number;
  maxSpecRounds: number;
  allowP1Waiver: boolean;
}

export interface ActionAvailabilityItem {
  available: boolean;
  reason: SpecActionBlockReason | null;
}

export interface ActionAvailability {
  approve: ActionAvailabilityItem;
  requestChanges: ActionAvailabilityItem;
  returnToSpec: ActionAvailabilityItem;
  waiveP1: ActionAvailabilityItem;
  terminalBlock: boolean;
  counts: GapCounts;
}

const ACTIVE_GAP_STATUSES = new Set<GapStatus>(["open", "downgraded", "overridden"]);

export function effectiveSeverity(gap: RuleGap): Severity {
  return gap.downgradedTo ?? gap.severity;
}

export function isSpecBlockingGap(gap: RuleGap): boolean {
  const severity = effectiveSeverity(gap);

  if (gap.status === "resolved") return false;
  if (gap.status === "overridden") return false;
  if (gap.status === "waived" && severity === "P1") return false;

  return severity === "P0" || severity === "P1";
}

export function isMergeBlockingGap(gap: RuleGap): boolean {
  const severity = effectiveSeverity(gap);

  if (gap.status === "resolved") return false;
  if (gap.status === "waived" && severity === "P1") return false;
  if (gap.status === "overridden" && gap.originalSeverity === "P0") return true;

  return severity === "P0" || severity === "P1";
}

export function isLegalDowngrade(from: Severity, to: "P1" | "P2"): boolean {
  if (from === "P0") return to === "P1";
  if (from === "P1") return to === "P2";
  return false;
}

export function computeGapCounts(gaps: RuleGap[]): GapCounts {
  return gaps.reduce<GapCounts>(
    (counts, gap) => {
      const severity = effectiveSeverity(gap);

      if (isSpecBlockingGap(gap) && severity === "P0") counts.blockingP0 += 1;
      if (isSpecBlockingGap(gap) && severity === "P1") counts.blockingP1 += 1;
      if (gap.status !== "resolved" && !isSpecBlockingGap(gap) && severity === "P2") {
        counts.nonBlockingP2 += 1;
      }
      if (gap.status === "overridden" && gap.originalSeverity === "P0") counts.overriddenP0 += 1;
      if (ACTIVE_GAP_STATUSES.has(gap.status)) counts.openRequirementGaps += 1;
      if (isMergeBlockingGap(gap)) counts.mergeBlockingRequirementGaps += 1;

      return counts;
    },
    {
      blockingP0: 0,
      blockingP1: 0,
      nonBlockingP2: 0,
      overriddenP0: 0,
      openRequirementGaps: 0,
      mergeBlockingRequirementGaps: 0,
    }
  );
}

export function getSpecActionAvailability(input: ActionAvailabilityInput): ActionAvailability {
  const counts = computeGapCounts(input.gaps);
  const hasSpecBlocker = counts.blockingP0 > 0 || counts.blockingP1 > 0;
  const hasOpenNonBlockingGap = input.gaps.some((gap) => {
    return ACTIVE_GAP_STATUSES.has(gap.status) && !isSpecBlockingGap(gap);
  });
  const hasWaivableP1 = input.gaps.some((gap) => {
    const severity = effectiveSeverity(gap);
    return severity === "P1" && (gap.status === "open" || gap.status === "downgraded");
  });
  const approve: ActionAvailabilityItem = !input.reportFresh
    ? { available: false, reason: "report_stale" }
    : hasSpecBlocker
      ? { available: false, reason: "gate_blocked" }
      : { available: true, reason: null };

  const canRequestChanges =
    hasSpecBlocker || hasOpenNonBlockingGap;
  const canReturnToSpec =
    hasSpecBlocker;
  const requestChanges: ActionAvailabilityItem = canRequestChanges
    ? { available: true, reason: null }
    : {
        available: false,
        reason: "no_blocker",
      };

  const returnToSpec: ActionAvailabilityItem = canReturnToSpec
    ? { available: true, reason: null }
    : {
        available: false,
        reason: "no_blocker",
      };

  const waiveP1: ActionAvailabilityItem =
    input.allowP1Waiver && hasWaivableP1
      ? { available: true, reason: null }
      : {
          available: false,
          reason: hasWaivableP1 ? "p1_waiver_disabled" : "not_applicable",
        };

  return {
    approve,
    requestChanges,
    returnToSpec,
    waiveP1,
    terminalBlock: false,
    counts,
  };
}
