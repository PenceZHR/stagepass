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

/**
 * 两类挡门的东西，它们不是一回事。
 *
 * - `finding` —— **发现的一个问题**。模型报的，所以带严重度：问的是"这有多糟"。
 * - `standard` —— **一条没被满足的标准**。rubric 判的，所以**没有**严重度：问的是
 *   "满足了没有"，二元。硬给它编一个 P0/P1/P2，等于凭空发明一个不存在的维度。
 *
 * 两者的**出口也不同**，这才是它们必须分开的硬理由：
 *
 *   finding(P1) 靠 waive 出去 —— 人接受这个风险
 *   standard    靠撤下那条标准出去 —— 人说这件事本来就不该要求
 *
 * 「接受风险」和「撤销要求」是两句不同的话，让 waive 能关掉一条 standard，就是让
 * 人用前者去说后者。所以 `waive` 明确拒绝 standard（见 domain/gap.ts）。
 */
export const BLOCKER_KINDS = ["finding", "standard"] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

/**
 * 一条 finding：必带严重度。
 *
 * 单独有个名字，是因为**有些地方只收得下 finding** —— 一轮报出来的问题、模型的
 * 自述，都属于「我发现了什么，有多糟」。一条 standard 是二元的，没有严重度，塞进
 * 那些地方会当场没有值可填。用类型挡住，比在注释里嘱咐可靠。
 */
export type Finding = Blocker & {
  readonly kind: "finding";
  readonly severity: BlockerSeverity;
};

export interface Blocker {
  readonly id: string;
  readonly kind: BlockerKind;
  /** `finding` 必有；`standard` 必无 —— 二元的东西没有严重度。 */
  readonly severity: BlockerSeverity | null;
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
    // 一条没满足的标准照挡，而且 waive 名单对它无效 —— 它的出口是撤下这条标准
    // 本身，不是有人接受它（见上面 BLOCKER_KINDS 的注释）。
    blocker.kind === "standard"
    || blocker.severity === "P0"
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
    // kind 也进哈希：同一个 id 从 finding 变成 standard，出口就从「可以 waive」
    // 变成了「只能撤标准」—— 那是决策依据变了，不是换个标签。
    blockers: [...evidence.blockers]
      .map((blocker) => `${blocker.kind}:${blocker.severity ?? "-"}:${blocker.id}`)
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
