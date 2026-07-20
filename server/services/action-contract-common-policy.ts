import { and, eq } from "drizzle-orm";

import { legacyImports } from "../db/schema";
import type {
  ActionContractDb,
  ActionDecision,
  Blocker,
  ContractPhase,
} from "./action-contract-types";
import type { StageAuthoritySnapshot } from "./stage-authority-service";
import { getReviewCenterState, getQABlockers } from "./review-center-state-service";

const PASSING_GATE_STATUSES = new Set([
  "pass",
  "passed",
  "passed_with_warnings",
  "passed_with_waived_p1",
]);

/** Stands in for a gate's source hash when the change has no gate row yet. */
export const MISSING_GATE_SOURCE_DB_HASH = "__missing_gate__";

/** Stamps a decision with the gate identity of the snapshot it was computed from. */
export function withSnapshotGateFields(
  decision: ActionDecision,
  snapshot: StageAuthoritySnapshot,
): ActionDecision {
  return {
    ...decision,
    gateVersion: String(snapshot.latestGate?.gateVersion ?? 0),
    sourceDbHash: snapshot.latestGate?.sourceDbHash ?? MISSING_GATE_SOURCE_DB_HASH,
  };
}

/** Newest row wins, by endedAt/startedAt then id — a stable tiebreak for run-like rows. */
export function sortNewestRun<T extends { startedAt: string | null; endedAt?: string | null; id: string }>(
  rows: T[],
): T | null {
  return [...rows].sort((left, right) => {
    const rightTime = right.endedAt ?? right.startedAt ?? "";
    const leftTime = left.endedAt ?? left.startedAt ?? "";
    const byTime = rightTime.localeCompare(leftTime);
    if (byTime !== 0) return byTime;
    return right.id.localeCompare(left.id);
  })[0] ?? null;
}

export function phaseReasonPrefix(phase: ContractPhase): string {
  const prefixes: Record<ContractPhase, string> = {
    PRD: "prd",
    Spec: "spec",
    Plan: "plan",
    TestPlan: "test_plan",
    Build: "build",
    Review: "review",
    QA: "qa",
    Merge: "merge",
  };
  return prefixes[phase];
}

export function readJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function normalizeSeverity(value: unknown): Blocker["severity"] {
  return value === "P0" || value === "P1" || value === "P2" ? value : "P1";
}

export function normalizeBlockers(raw: unknown): Blocker[] {
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return rows.map((row, index) => {
    const record = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    return {
      id: String(record.id ?? record.findingId ?? record.gapId ?? `blocker-${index + 1}`),
      severity: normalizeSeverity(record.severity),
      title: String(record.title ?? record.reason ?? record.message ?? "Gate blocker"),
    };
  });
}

export function gateDecision(phase: ContractPhase, snapshot: StageAuthoritySnapshot): ActionDecision {
  const gate = snapshot.latestGate;
  if (!gate) {
    // For QA gate, check ReviewCenterState (Invariant #7 from state-machine.md)
    if (phase === "QA") {
      const reviewState = getReviewCenterState(snapshot.changeId);

      if (!reviewState.canEnterQA) {
        const blockers = getQABlockers(snapshot.changeId);
        return {
          enabled: false,
          reasonCode: `qa_blocked_by_review_${reviewState.gate}`,
          reason: reviewState.reason,
          blockers,
        };
      }
    }

    return {
      enabled: false,
      reasonCode: `${phaseReasonPrefix(phase)}_gate_missing`,
      reason: `${phase} gate snapshot is missing`,
      blockers: [],
    };
  }

  const blockers = normalizeBlockers(readJson(gate.blockersJson));
  if (!PASSING_GATE_STATUSES.has(gate.status)) {
    const reasonCode =
      gate.status === "stale"
        ? `${phaseReasonPrefix(phase)}_stale`
        : `${phaseReasonPrefix(phase)}_${gate.status}`;
    return {
      enabled: false,
      reasonCode,
      reason: `${phase} gate is ${gate.status}`,
      blockers,
    };
  }

  return { enabled: true, reasonCode: null, reason: null, blockers };
}

/**
 * A phase whose only evidence is a legacy import has no authoritative stage
 * rows, so every action on it is disabled until the import is restored. Phase
 * agnostic, hence here rather than in a phase policy.
 */
export function legacyOnlyDecision(
  db: ActionContractDb,
  changeId: string,
  snapshot: StageAuthoritySnapshot,
): ActionDecision | null {
  if (snapshot.latestAttempt || snapshot.latestReport || snapshot.latestGate) return null;
  const legacyRow = db
    .select({ id: legacyImports.id })
    .from(legacyImports)
    .where(and(eq(legacyImports.changeId, changeId), eq(legacyImports.phase, snapshot.phase)))
    .get();
  if (!legacyRow) return null;
  return {
    enabled: false,
    reasonCode: "legacy_not_authoritative",
    reason: "Legacy import is not authoritative until restored into current DB stage rows",
    blockers: [],
  };
}
