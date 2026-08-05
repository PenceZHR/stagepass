import { createHash } from "node:crypto";

import {
  assertStateValid,
  isLegal,
  type ChangeAction,
  type ChangeState,
} from "./change-state";
import type { PhaseGraph } from "./phase";

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
  /**
   * 这个问题在哪儿，原文照抄报的人写的那一串。
   *
   * ## 它为什么必须存在（用户 2026-08-04：「绝对不能出现语义损失」）
   *
   * 在这之前，一个 blocker 只有 `id / severity / title`。而 Review 的 rubric 明写着
   * 「每条意见都指明了**文件和位置**」—— **一件被要求、也被判的东西，在结构化的
   * 那份里没有容身之处**，只能待在报告散文里。于是链子是这样断的：
   *
   *   红方读 commit，找到 foo.ts:42 →  写进报告散文 →  报一个只有标题的 blocker
   *   →  gaps 表只存标题 →  下一轮的红方和 Fix 拿到的就是一个标题
   *
   * 位置信息在**红方已经知道它**的那一刻被扔掉了，下游谁要用都得回去重新解析散文
   * —— 而「转述必然改写」正是这棵树到处在防的事。
   *
   * ## 为什么是自由文本而不是 file + line
   *
   * 契约是**十一个阶段共用**的。代码阶段写 `src/foo.ts:42`，设计阶段写「PRD §3.2」
   * ——后者塞不进 `{file, line}`，硬塞会逼出一堆空值或者编出来的行号。
   *
   * 用户 2026-08-04 明确说了这是**过渡形态**：「先用 where+why 的方式，后续我会改成
   * 结构化的方式」。所以这里不做任何解析、不做格式假设，只原样存、原样传 ——
   * 换成结构化时，这一列是可以逐条读出来再拆的。
   *
   * `standard` 一律为 null：那是 StagePass 拿 rubric 条目生成的，没有「在哪儿」。
   */
  readonly where: string | null;
  /**
   * 为什么它是个问题，报的人自己的话。
   *
   * 和 `where` 同一个理由：critic 的 rubric 第 2 条判「每条问题都说明了它为什么是
   * 问题，而不只是说它存在」—— 而 `title` 装不下一句解释。少了它，下一轮的红方看到
   * 的是一句判语，不是一个可以据以动手的问题。
   */
  readonly why: string | null;
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
    // **不排序** —— 栈的顺序本身是事实（回程的次序），重排它就是另一份证据。
    returnStack: state.returnStack,
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
  /** 这个 Change 走的图（§4.5）。缺省全序。sendBack 的合法性跟着它走。 */
  graph?: PhaseGraph,
): Gate {
  assertStateValid(state);
  const permitted: ChangeAction[] = [];
  const refusals: Record<string, RefusalReason> = {};
  const blocking = unresolved(evidence);

  // `isLegal` 而不是查 ACCEPTS 表：sendBack 多一道「得有上游」的判据（PRD 没有，
  // Fix 不在主线上），那一半在状态机里，这里不另算一套。
  for (const action of [
    "start", "settle", "fail", "retry", "approve", "reject", "sendBack", "rerun",
  ] as const) {
    if (!isLegal(state, action, graph)) {
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
