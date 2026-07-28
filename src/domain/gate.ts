import { createHash } from "node:crypto";

import {
  accepts,
  assertStateValid,
  type ChangeAction,
  type ChangeState,
} from "./change-state";

/**
 * Which actions are permitted right now, and why the rest are not.
 *
 * ## Two different questions
 *
 * L0 answers "is this action the right SHAPE here" -- `approve` means nothing
 * in a phase that has not settled. The gate answers "is it permitted given what
 * we actually know" -- a settled phase with an unresolved P0 must not be
 * approved even though `approve` is shape-legal.
 *
 * Keeping them apart matters because they fail differently. A shape violation
 * is a bug in the caller. A gate refusal is the normal, expected answer, and it
 * has to carry a reason a human can read.
 *
 * ## The gate never asks the model
 *
 * Everything here is computed from facts the system holds. A phase is not
 * approvable because a model said it went well; it is approvable because it
 * produced something and nothing blocking is outstanding. That is the whole
 * point of having a gate rather than a summary.
 *
 * ## This module is pure
 *
 * No database, no clock, no IO. `snapshot` is a deterministic hash of exactly
 * the inputs the decision was made from, which is what makes it usable as a
 * fence: if any input changes, the hash changes, and a decision computed
 * against the old one can be refused instead of silently applied to the new.
 */

/**
 * Exported because L2 validates a model's answer against it. It was demoted to
 * internal when nothing else used it -- the standing orphan guard said so -- and
 * is public again now that something does.
 */
export const BLOCKER_SEVERITIES = ["P0", "P1", "P2"] as const;
export type BlockerSeverity = (typeof BLOCKER_SEVERITIES)[number];

export interface Blocker {
  readonly id: string;
  readonly severity: BlockerSeverity;
  readonly title: string;
}

export interface Evidence {
  /** What this phase produced. A phase that produced nothing cannot be approved. */
  readonly artifactIds: readonly string[];
  readonly blockers: readonly Blocker[];
  /**
   * Blockers a human has explicitly accepted, by id.
   *
   * Only P1 can be waived. A waiver naming a P0 is ignored rather than honoured
   * -- see `unresolved`. The reason text belongs to the decision that recorded
   * the waiver, not here; this is only the gate's view of what is outstanding.
   */
  readonly waivedBlockerIds: readonly string[];
}

export const EMPTY_EVIDENCE: Evidence = {
  artifactIds: [],
  blockers: [],
  waivedBlockerIds: [],
};

const REFUSAL_REASONS = [
  "not_legal_in_this_status",
  "nothing_was_produced",
  "blocking_problem_outstanding",
] as const;

export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface Gate {
  /** Actions that may be applied right now. */
  readonly permitted: readonly ChangeAction[];
  /** Every action that may not, with the reason. Never empty-by-omission. */
  readonly refusals: Readonly<Record<string, RefusalReason>>;
  /**
   * Fingerprint of the exact inputs this gate was computed from. A decision
   * carries it; applying the decision compares it. Different hash means the
   * ground moved while the human was thinking.
   */
  readonly snapshot: string;
}

/**
 * Blockers that still stand: every P0, plus any P1 nobody has accepted.
 *
 * P0 is deliberately un-waivable. "严重到不可接受的问题不能通过普通确认绕过" is a
 * product rule, and a waiver list that could silence a P0 would make the
 * severity meaningless.
 */
export function unresolved(evidence: Evidence): readonly Blocker[] {
  const waived = new Set(evidence.waivedBlockerIds);
  return evidence.blockers.filter((blocker) =>
    blocker.severity === "P0"
    || (blocker.severity === "P1" && !waived.has(blocker.id)));
}

function canonical(state: ChangeState, evidence: Evidence): string {
  // Sorted so that a reordering -- which changes nothing about the decision --
  // does not invalidate a fence and force a human to decide twice.
  return JSON.stringify({
    phase: state.phase,
    status: state.status,
    returnPhase: state.returnPhase,
    artifactIds: [...evidence.artifactIds].sort(),
    blockers: [...evidence.blockers]
      .map((blocker) => `${blocker.severity}:${blocker.id}`)
      .sort(),
    waived: [...evidence.waivedBlockerIds].sort(),
  });
}

export function snapshotOf(state: ChangeState, evidence: Evidence): string {
  return createHash("sha256").update(canonical(state, evidence)).digest("hex");
}

export function computeGate(
  state: ChangeState,
  evidence: Evidence,
): Gate {
  assertStateValid(state);
  const legal = new Set<ChangeAction>(accepts(state.status));
  const permitted: ChangeAction[] = [];
  const refusals: Record<string, RefusalReason> = {};
  const blocking = unresolved(evidence);

  for (const action of ["start", "settle", "fail", "retry", "approve", "reject"] as const) {
    if (!legal.has(action)) {
      refusals[action] = "not_legal_in_this_status";
      continue;
    }
    // Only approval is gated on evidence. Rejecting, retrying and failing are
    // how a Change gets OUT of a bad place -- gating them on the evidence being
    // good is how a Change gets stuck with no legal move at all.
    if (action === "approve") {
      if (evidence.artifactIds.length === 0) {
        refusals[action] = "nothing_was_produced";
        continue;
      }
      if (blocking.length > 0) {
        refusals[action] = "blocking_problem_outstanding";
        continue;
      }
    }
    permitted.push(action);
  }

  return {
    permitted,
    refusals,
    snapshot: snapshotOf(state, evidence),
  };
}

export class GateRefusedError extends Error {
  constructor(
    readonly action: ChangeAction,
    readonly reason: RefusalReason,
  ) {
    super(`${action} refused: ${reason}`);
    this.name = "GateRefusedError";
  }
}

export class GateMovedError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      "The gate moved while this decision was open"
      + ` (expected snapshot ${expected.slice(0, 12)}, found ${actual.slice(0, 12)})`,
    );
    this.name = "GateMovedError";
  }
}

/**
 * The fence. A decision made against one snapshot must not be applied to
 * another -- silently applying it is how a human's "approve" lands on evidence
 * they never saw.
 */
export function assertFence(expected: string, gate: Gate): void {
  if (expected !== gate.snapshot) {
    throw new GateMovedError(expected, gate.snapshot);
  }
}

export function assertPermitted(gate: Gate, action: ChangeAction): void {
  if (gate.permitted.includes(action)) return;
  throw new GateRefusedError(
    action,
    gate.refusals[action] ?? "not_legal_in_this_status",
  );
}
