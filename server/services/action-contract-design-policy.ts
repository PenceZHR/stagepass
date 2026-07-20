import { eq } from "drizzle-orm";

import { requirementGaps } from "../db/schema";
import type {
  ActionContractDb,
  ActionDecision,
  Blocker,
} from "./action-contract-types";
import type { StageAuthoritySnapshot } from "./stage-authority-service";
import { getSpecBattleState } from "./spec-battle-service";
import {
  gateDecision,
  MISSING_GATE_SOURCE_DB_HASH,
  normalizeSeverity,
  withSnapshotGateFields,
} from "./action-contract-common-policy";

/**
 * Design-phase action policy: PRD, Spec (including the red/blue battle's
 * requirement-gap blockers and its approval gate) and TechSpec. Extracted from
 * the action-contract facade so the central service no longer has to know the
 * evidence shape of these phases.
 *
 * Per the policy-module convention, DB-reading functions take the
 * ActionContractDb as their first argument rather than reaching for a
 * module-level holder.
 */

function effectiveSpecGapSeverity(gap: {
  severity: string;
  downgradedTo: string | null;
}): Blocker["severity"] {
  return normalizeSeverity(gap.downgradedTo ?? gap.severity);
}

function specBattleBlockers(db: ActionContractDb, changeId: string): Blocker[] {
  return db
    .select()
    .from(requirementGaps)
    .where(eq(requirementGaps.changeId, changeId))
    .all()
    .filter((gap) => {
      const severity = effectiveSpecGapSeverity(gap);
      return (severity === "P0" || severity === "P1") && ["open", "downgraded"].includes(gap.status);
    })
    .map((gap) => ({
      id: gap.id,
      severity: effectiveSpecGapSeverity(gap),
      title: gap.title,
    }));
}

export function approveSpecDecision(db: ActionContractDb, changeId: string, current: ActionDecision): ActionDecision {
  if (!current.enabled) return current;

  const battle = getSpecBattleState(changeId);
  if (!battle.latestRound || battle.latestRound.status !== "report_ready") {
    return {
      enabled: false,
      reasonCode: "round_not_ready",
      reason: "round_not_ready",
      blockers: [],
    };
  }
  if (!battle.reportFresh) {
    return {
      enabled: false,
      reasonCode: battle.staleReason ?? "report_stale",
      reason: battle.staleReason ?? "report_stale",
      blockers: [],
    };
  }
  if (battle.counts.blockingP0 > 0 || battle.counts.blockingP1 > 0) {
    return {
      enabled: false,
      reasonCode: "gate_blocked",
      reason: "gate_blocked",
      blockers: specBattleBlockers(db, changeId),
    };
  }

  return current;
}

export function specRunDecision(
  actionId: string,
  changeId: string,
  changeStatus: string,
  changeGateState: string | null,
  snapshot: StageAuthoritySnapshot,
): ActionDecision {
  const disabled = (reasonCode: string, reason: string = reasonCode): ActionDecision =>
    withSnapshotGateFields({
      enabled: false,
      reasonCode,
      reason,
      blockers: [],
    }, snapshot);

  const prdGate = gateDecision("PRD", snapshot);
  if (!prdGate.enabled) return prdGate;
  if (changeGateState !== "intake") {
    return {
      enabled: false,
      reasonCode: "intake_gate_unapproved",
      reason: "Intake gate must be approved before Spec generation",
      blockers: [],
    };
  }
  const latestRound = getSpecBattleState(changeId).latestRound;
  const latestStatus = latestRound?.status ?? null;

  if (latestStatus === "red_running" || latestStatus === "blue_running") {
    return disabled("spec_round_running");
  }
  if (latestStatus === "failed") {
    // For retry_spec, always allow retrying failed rounds
    return actionId === "retry_spec"
      ? prdGate
      : disabled("spec_round_failed_retry_required");
  }
  if (actionId === "retry_spec") {
    // retry_spec is only for failed rounds - keep the original logic
    return disabled("spec_round_not_failed");
  }
  if (latestStatus === null) {
    return ["INTAKE_READY", "SPECCING"].includes(changeStatus)
      ? prdGate
      : disabled("not_at_gate");
  }
  if (latestStatus === "not_started") {
    return changeStatus === "SPECCING" ? prdGate : disabled("not_at_gate");
  }
  if (latestStatus === "report_ready") {
    return disabled("spec_battle_human_decision_required");
  }
  if (latestStatus === "closed") {
    return disabled("spec_battle_closed");
  }
  if (latestStatus === "superseded") {
    return disabled("spec_round_superseded");
  }
  return disabled("spec_round_not_actionable");
}

export function techSpecRunDecision(
  changeId: string,
  changeGateState: string | null,
  snapshot: StageAuthoritySnapshot,
): ActionDecision {
  const specGate = gateDecision("Spec", snapshot);
  if (!specGate.enabled) return specGate;
  if (changeGateState !== "spec") {
    return {
      enabled: false,
      reasonCode: "spec_gate_unapproved",
      reason: "Spec gate must be approved before TechSpec generation",
      blockers: [],
    };
  }
  const battle = getSpecBattleState(changeId);
  if (battle.latestRound?.status !== "closed") {
    const latestGate = snapshot.latestGate;
    return {
      enabled: false,
      reasonCode: "spec_battle_not_closed",
      reason: "Spec battle must be closed before TechSpec generation",
      blockers: [],
      gateVersion: latestGate ? String(latestGate.gateVersion) : undefined,
      sourceDbHash: latestGate?.sourceDbHash ?? undefined,
    };
  }
  return specGate;
}

export function prdRunDecision(snapshot: StageAuthoritySnapshot): ActionDecision {
  if (!snapshot.latestGate) {
    return {
      enabled: true,
      reasonCode: null,
      reason: null,
      blockers: [],
      gateVersion: "0",
      sourceDbHash: MISSING_GATE_SOURCE_DB_HASH,
    };
  }
  return gateDecision("PRD", snapshot);
}
