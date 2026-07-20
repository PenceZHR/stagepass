export interface SpecBattleAction {
  available: boolean;
  reason: string | null;
}

export interface SpecBattleCounts {
  blockingP0: number;
  blockingP1: number;
  nonBlockingP2: number;
  overriddenP0: number;
  openRequirementGaps: number;
  mergeBlockingRequirementGaps: number;
}

export interface SpecBattleGateState {
  roundId: string | null;
  roundStatus: string | null;
  reportFresh: boolean;
  staleReason: string | null;
  counts: SpecBattleCounts;
  actions: {
    approve: SpecBattleAction;
    requestChanges: SpecBattleAction;
    returnToSpec: SpecBattleAction;
    waiveP1: SpecBattleAction;
    terminalBlock: boolean;
  };
}

export interface SpecBattleRound {
  id: string;
  roundNo: number;
  status: string;
  redUnit: string;
  blueUnit: string;
  redArtifactPath: string | null;
  blueArtifactPath: string | null;
  reportPath: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface RequirementGap {
  id: string;
  canonicalGapId: string;
  title: string;
  category: string;
  severity: string;
  originalSeverity: string;
  downgradedTo: string | null;
  status: string;
  evidence: string;
  proposedSpecPatch: string | null;
}

export interface HumanDecision {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  reportHash: string | null;
  createdAt: string;
}

export interface RedFixClaim {
  id: string;
  changeId: string;
  roundId: string;
  gapId: string | null;
  canonicalGapId: string;
  claimStatus: string;
  claimSummary: string;
  evidence: string;
  artifactPath: string | null;
  sourceHashesJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface BlueGapReview {
  id: string;
  changeId: string;
  roundId: string;
  gapId: string | null;
  canonicalGapId: string;
  verdict: string;
  reviewSummary: string;
  evidence: string;
  resolutionEvidence: string | null;
  downgradedTo: string | null;
  sourceHashesJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpecBattleRoundDelta {
  resolvedThisRound: number;
  stillOpen: number;
  newlyFound: number;
  notRechecked: number;
}

export interface SpecBattleState {
  latestRound: SpecBattleRound | null;
  rounds: SpecBattleRound[];
  gaps: RequirementGap[];
  fixClaims: RedFixClaim[];
  gapReviews: BlueGapReview[];
  decisions: HumanDecision[];
  reportFresh: boolean;
  staleReason: string | null;
  counts: SpecBattleCounts;
  roundDelta: SpecBattleRoundDelta;
}

export type BattleDecisionAction = "request_changes" | "return_to_spec" | "waive_p1";
