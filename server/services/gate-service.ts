import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "path";

import {
  changes,
  humanDecisions,
  legacyImports,
  mergeApprovals,
  mergeDecisions,
  projects,
  requirementGaps,
} from "../db/schema";
import type { ChangeStatus } from "../types";
import { computeActions, getActions, type PipelineActionContract } from "./action-contract-service";
import {
  assertActionAllowed,
  PreflightValidationError,
  type AssertActionAllowedInput,
} from "./preflight-service";
import { applySpecBattleDecision, getSpecBattleState } from "./spec-battle-service";
import { getSpecActionAvailability, type RuleGap } from "./spec-battle-rules";
import { computeMergeReadiness, type MergeReadiness } from "./merge-readiness-service";
import { transitionChangeStatus } from "./change-status-service";
import {
  getStageAuthority,
  peekStageAuthority,
  type PipelinePhase,
  type StageAuthoritySnapshot,
} from "./stage-authority-service";

export type GateName = "intake" | "spec" | "tech_spec" | "merge";

export type GateApprovalPreflightInput = Pick<
  AssertActionAllowedInput,
  "expectedGateVersion" | "expectedSourceDbHash" | "idempotencyKey" | "expectedHeadSha"
>;

export interface MergeChecks {
  qaPassed: boolean;
  reviewPassed: boolean;
  reviewStatus: string;
  reviewWaivedP1: number;
  reviewWarnings: string[];
  docsComplete: boolean;
  requirementGapsPassed: boolean;
  mergeBlockingRequirementGaps: number;
  canMerge: boolean;
  missing: string[];
}

type GateServiceDb = typeof import("../db/index").db;

const requireDefaultDb = createRequire(import.meta.url);
let gateServiceDbForTest: GateServiceDb | null = null;
let defaultGateServiceDb: GateServiceDb | null = null;

export function setGateServiceDbForTest(nextDb: GateServiceDb): () => void {
  const previous = gateServiceDbForTest;
  gateServiceDbForTest = nextDb;
  return () => {
    gateServiceDbForTest = previous;
  };
}

function getGateServiceDb(): GateServiceDb {
  if (gateServiceDbForTest) return gateServiceDbForTest;
  if (!defaultGateServiceDb) {
    defaultGateServiceDb = (requireDefaultDb("../db/index") as typeof import("../db/index")).db;
  }
  return defaultGateServiceDb;
}

export interface GateStatus {
  atGate: boolean;
  gate: GateName | null;
  status: ChangeStatus;
  pendingArtifact: string | null;
  stageAuthority?: {
    phase: PipelinePhase;
    latestGateStatus: string | null;
    latestValidReportId: string | null;
  };
  actions?: PipelineActionContract[];
  mergeChecks?: MergeChecks;
  specBattle?: {
    roundId: string | null;
    roundStatus: string | null;
    reportFresh: boolean;
    counts: ReturnType<typeof getSpecBattleState>["counts"];
    actions: ReturnType<typeof getSpecActionAvailability>;
    staleReason: string | null;
  };
}

const GATE_STATES: Record<GateName, ChangeStatus> = {
  intake: "INTAKE_READY",
  spec: "SPEC_READY",
  tech_spec: "TECHSPEC_READY",
  merge: "MERGE_READY",
};

const GATE_REJECT_PREVIOUS: Record<GateName, ChangeStatus> = {
  intake: "INTAKE_PENDING",
  spec: "INTAKE_READY",
  tech_spec: "SPEC_READY",
  merge: "LOCAL_READY",
};

const PENDING_ARTIFACTS: Record<GateName, string | null> = {
  intake: "prd-gate.json",
  spec: "prd-delta.md",
  tech_spec: "tech-spec-delta.md",
  merge: null,
};

function nowISO(): string {
  return new Date().toISOString();
}

function getChange(changeId: string) {
  const db = getGateServiceDb();
  return db.select().from(changes).where(eq(changes.id, changeId)).get();
}

function getProject(projectId: string) {
  const db = getGateServiceDb();
  return db.select().from(projects).where(eq(projects.id, projectId)).get();
}

function gateFromStatus(status: string): GateName | null {
  for (const [gate, gateStatus] of Object.entries(GATE_STATES)) {
    if (gateStatus === status) {
      return gate as GateName;
    }
  }
  return null;
}

function gatePhase(gate: GateName | null): PipelinePhase | null {
  if (gate === "intake") return "PRD";
  if (gate === "spec") return "Spec";
  if (gate === "tech_spec") return "TechSpec";
  if (gate === "merge") return "Merge";
  return null;
}

export function gateApprovalActionId(gate: GateName): string {
  if (gate === "intake") return "approve_intake";
  if (gate === "spec") return "approve_spec";
  if (gate === "tech_spec") return "approve_tech_spec";
  return "approve_merge";
}

export function gateRejectActionId(gate: GateName): string {
  if (gate === "intake") return "reject_intake";
  if (gate === "spec") return "reject_spec";
  if (gate === "tech_spec") return "reject_tech_spec";
  return "reject_merge";
}

function stageGateBlockReason(authority: StageAuthoritySnapshot): string | null {
  const gate = authority.latestGate;
  const status = gate?.status;
  if (!status) return "missing";
  if (status === "pass" || status === "passed" || status === "passed_with_warnings") {
    if (!gate?.freshnessJson) return null;
    try {
      const freshness = JSON.parse(gate.freshnessJson) as { fresh?: unknown; staleReason?: unknown };
      return freshness.fresh === false
        ? typeof freshness.staleReason === "string" ? freshness.staleReason : "stale"
        : null;
    } catch {
      return "stale";
    }
  }
  return status;
}

function getGateAuthority(
  changeId: string,
  gate: GateName | null,
  readOnly = false,
): StageAuthoritySnapshot | null {
  const phase = gatePhase(gate);
  return phase ? (readOnly ? peekStageAuthority : getStageAuthority)(changeId, phase) : null;
}

function legacyOnlyPhases(changeId: string): Set<string> {
  const db = getGateServiceDb();
  const phases = new Set(
    db
      .select()
      .from(legacyImports)
      .where(eq(legacyImports.changeId, changeId))
      .all()
      .map((row) => row.phase),
  );
  const result = new Set<string>();
  for (const phase of phases) {
    const authority = getStageAuthority(changeId, phase as PipelinePhase);
    if (!authority.latestAttempt && !authority.latestReport && !authority.latestGate) {
      result.add(phase);
    }
  }
  return result;
}

function withLegacyOnlyReasons(
  changeId: string,
  actions: PipelineActionContract[],
): PipelineActionContract[] {
  const phases = legacyOnlyPhases(changeId);
  if (phases.size === 0) return actions;
  return actions.map((action) => {
    if (!phases.has(action.phase)) return action;
    return {
      ...action,
      enabled: false,
      reasonCode: "legacy_not_authoritative",
      reason: "Legacy import is not authoritative until restored into current DB stage rows",
    };
  });
}

function pendingArtifactPath(repoPath: string, changeId: string, gate: GateName | null): string | null {
  if (!gate) return null;
  const artifact = PENDING_ARTIFACTS[gate];
  if (!artifact) return null;
  return path.join(repoPath, ".ship", "changes", changeId, artifact);
}

function insertMergeApproval(changeId: string, readiness: MergeReadiness): MergeReadiness {
  const db = getGateServiceDb();
  const now = nowISO();
  const decisionId = `HD-MERGE-${randomUUID()}`;
  db.insert(humanDecisions).values({
    id: decisionId,
    changeId,
    roundId: null,
    gate: "merge",
    action: "approve_merge",
    targetType: "change",
    targetId: changeId,
    reason: "Merge approved",
    reportHash: readiness.sourceDbHash,
    createdBy: "human",
    createdAt: now,
  }).run();
  db.insert(mergeApprovals).values({
    id: `MAP-${randomUUID()}`,
    changeId,
    decisionId,
    actor: "human",
    approvedAt: now,
  }).run();
  const finalReadiness = computeMergeReadiness(changeId);
  db.insert(mergeDecisions).values({
    id: `MD-${randomUUID()}`,
    changeId,
    readinessId: finalReadiness.id,
    decisionType: "approve_merge",
    actor: "human",
    reason: "Merge approved",
    createdAt: now,
  }).run();
  return finalReadiness;
}

function assertAtGate(changeId: string, gate: GateName) {
  const change = getChange(changeId);
  if (!change) {
    throw new Error(`Change not found: ${changeId}`);
  }

  if (change.status !== GATE_STATES[gate]) {
    throw new Error(`Not at gate: ${gate}`);
  }

  return change;
}

function toRuleGap(gap: typeof requirementGaps.$inferSelect): RuleGap {
  return {
    id: gap.id,
    severity: gap.severity as RuleGap["severity"],
    originalSeverity: gap.originalSeverity as RuleGap["originalSeverity"],
    downgradedTo: gap.downgradedTo as RuleGap["downgradedTo"],
    status: gap.status as RuleGap["status"],
  };
}

export function getGateStatus(
  changeId: string,
  options: { refreshActions?: boolean } = {},
): GateStatus {
  const change = getChange(changeId);
  if (!change) {
    throw new Error(`Change not found: ${changeId}`);
  }

  const project = getProject(change.projectId);
  if (!project) {
    throw new Error(`Project not found: ${change.projectId}`);
  }

  const status = change.status as ChangeStatus;
  const gate = gateFromStatus(status);
  const result: GateStatus = {
    atGate: gate !== null,
    gate,
    status,
    pendingArtifact: pendingArtifactPath(project.repoPath, changeId, gate),
  };
  const authority = getGateAuthority(changeId, gate, options.refreshActions === false);
  if (authority) {
    result.stageAuthority = {
      phase: authority.phase,
      latestGateStatus: authority.latestGate?.status ?? null,
      latestValidReportId: authority.latestValidReport?.id ?? null,
    };
  }
  result.actions = withLegacyOnlyReasons(
    changeId,
    options.refreshActions === false ? computeActions(changeId) : getActions(changeId),
  );

  if (gate === "merge") {
    result.mergeChecks = canMerge(changeId, { persist: options.refreshActions !== false });
  }
  if (gate === "spec") {
    const battle = getSpecBattleState(changeId);
    let params = { maxSpecRounds: 3, allowP1Waiver: true };
    if (battle.latestRound) {
      try {
        params = { ...params, ...JSON.parse(battle.latestRound.paramsJson) };
      } catch {
        params = { maxSpecRounds: 3, allowP1Waiver: true };
      }
    }
    const actions = battle.latestRound
      ? getSpecActionAvailability({
          gaps: battle.gaps.map(toRuleGap),
          reportFresh: battle.reportFresh,
          currentRoundNo: battle.latestRound.roundNo,
          maxSpecRounds: params.maxSpecRounds,
          allowP1Waiver: params.allowP1Waiver,
        })
      : {
          approve: { available: false, reason: "not_applicable" as const },
          requestChanges: { available: false, reason: "not_applicable" as const },
          returnToSpec: { available: false, reason: "not_applicable" as const },
          waiveP1: { available: false, reason: "not_applicable" as const },
          terminalBlock: false,
          counts: battle.counts,
        };
    result.specBattle = {
      roundId: battle.latestRound?.id ?? null,
      roundStatus: battle.latestRound?.status ?? null,
      reportFresh: battle.reportFresh,
      counts: battle.counts,
      actions,
      staleReason: battle.staleReason,
    };
  }

  return result;
}

export async function approveGate(
  changeId: string,
  gate: GateName,
  preflight?: GateApprovalPreflightInput,
): Promise<void> {
  if (!preflight) {
    throw new PreflightValidationError(
      "missing_preflight_contract",
      "Gate approval requires an action contract snapshot",
    );
  }
  assertActionAllowed({
    changeId,
    actionId: gateApprovalActionId(gate),
    ...preflight,
  });

  const change = assertAtGate(changeId, gate);
  const authority = getGateAuthority(changeId, gate);
  const blockReason = gate === "merge" ? null : authority ? stageGateBlockReason(authority) : null;
  if (blockReason) {
    if (blockReason === "missing") {
      throw new Error(`Stage gate missing: ${gate}`);
    }
    throw new Error(`Stage gate blocked: ${blockReason}`);
  }

  if (gate === "merge") {
    const approvalReadiness = computeMergeReadiness({
      changeId,
      requireApproval: false,
      persist: false,
    });
    if (approvalReadiness.status !== "ready") {
      throw new Error(`Cannot approve merge: ${approvalReadiness.blockers.map((item) => item.reasonCode).join(", ")}`);
    }
    insertMergeApproval(changeId, approvalReadiness);
  }

  if (gate === "spec") {
    await applySpecBattleDecision({
      changeId,
      action: "approve",
      targetType: "gate",
      targetId: null,
      reason: null,
    });
  }

  const db = getGateServiceDb();
  db.update(changes)
    .set({
      gateState: gate,
      updatedAt: nowISO(),
    })
    .where(eq(changes.id, change.id))
    .run();
}

export async function rejectGate(changeId: string, gate: GateName, reason?: string): Promise<void> {
  assertAtGate(changeId, gate);
  transitionChangeStatus({
    changeId,
    to: GATE_REJECT_PREVIOUS[gate],
    gateState: null,
    message: `Gate rejected: ${gate}`,
    rawJson: { gate, reason: reason ?? null },
  });
}

export function canMerge(
  changeId: string,
  options: { persist?: boolean } = {},
): MergeChecks {
  const change = getChange(changeId);
  if (!change) {
    throw new Error(`Change not found: ${changeId}`);
  }

  const readiness = computeMergeReadiness({
    changeId,
    persist: options.persist ?? true,
  });
  const missing = readiness.blockers.map((blocker) => blocker.reasonCode);
  const qaPassed = !readiness.blockers.some((blocker) => blocker.blockerType === "qa" || blocker.reasonCode.startsWith("qa_"));
  const reviewPassed = !readiness.blockers.some(
    (blocker) => blocker.blockerType === "review" || blocker.reasonCode.startsWith("review_"),
  );
  const reviewWaivedP1 = 0;
  const reviewWarnings = readiness.blockers
    .filter((blocker) => blocker.blockerType === "review")
    .map((blocker) => blocker.title);
  const mergeBlockingRequirementGaps = readiness.blockers.filter(
    (blocker) => blocker.blockerType === "requirement_gap",
  ).length;
  const requirementGapsPassed = mergeBlockingRequirementGaps === 0;

  return {
    qaPassed,
    reviewPassed,
    reviewStatus: reviewPassed ? "passed" : "blocked",
    reviewWaivedP1,
    reviewWarnings,
    docsComplete: true,
    requirementGapsPassed,
    mergeBlockingRequirementGaps,
    canMerge: readiness.status === "ready",
    missing,
  };
}
