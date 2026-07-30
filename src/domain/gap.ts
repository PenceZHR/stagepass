import type { Blocker, BlockerKind, BlockerSeverity } from "./gate";

/**
 * A problem found in one round that outlives it.
 *
 * ## The rule this whole module exists for
 *
 * 「旧问题必须被明确复核，不能因为重新生成文档而消失」. A round that regenerates
 * its document and simply does not mention last round's problem must not
 * thereby resolve it. So:
 *
 *   silence keeps a gap open. closing one requires saying so, with a reason.
 *
 * Stated that way round deliberately. The opposite default -- "not re-reported
 * means fixed" -- is what makes a second round able to open a gate by
 * forgetting, and forgetting is the single most likely thing a model does.
 *
 * ## Why a waiver is not a close
 *
 * Closing says the problem is gone. Waiving says it is still there and someone
 * decided to live with it. Collapsing them would erase the difference between
 * "we fixed it" and "we shipped with it", which is precisely the distinction a
 * delivery note has to carry.
 *
 * ## This module is pure
 */

export const GAP_STATUSES = ["open", "closed", "waived"] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

export interface Gap {
  readonly id: string;
  /**
   * 发现的一个问题，还是一条没被满足的标准。见 `domain/gate.ts` 的 BLOCKER_KINDS。
   *
   * 决定两件事：有没有严重度，以及能不能被 waive。
   */
  readonly kind: BlockerKind;
  /** `finding` 必有；`standard` 必无 —— rubric 是二元判断，没有严重度这一维。 */
  readonly severity: BlockerSeverity | null;
  readonly title: string;
  readonly status: GapStatus;
  /** The round that found it. */
  readonly openedRound: number;
  /** Why it was closed or waived. Never empty once it leaves `open`. */
  readonly resolution: string | null;
}

export type Verdict =
  /** The round checked and the problem is gone. */
  | { readonly kind: "closed"; readonly reason: string }
  /** The round checked and it still stands. */
  | { readonly kind: "still_open"; readonly reason: string };

export class InvalidVerdictError extends Error {
  constructor(readonly code:
    | "reason_missing"
    | "unknown_gap"
    | "standard_not_waivable"
    | "title_missing") {
    super(code);
    this.name = "InvalidVerdictError";
  }
}

/**
 * 人自己开的问题，靠 id 前缀区分。
 *
 * ## 为什么是前缀，而不是新加一列
 *
 * 用户 2026-07-30 拍板：「人开的 gap 兼容现有结构，别新增 kind。」`kind` 答的是
 * 「这是一个发现的问题，还是一条没被满足的标准」—— 那是**问题的性质**，而「谁提的」
 * 是另一个维度。塞进 `kind` 会让 `finding` 的两条不变量（必带严重度、可以 waive）
 * 对第三个值意味着什么变成一道新题。
 *
 * 前缀已经是这棵树里的先例：rubric 派生的 gap 是 `RB:<role>:<key>`（REMAP §五）。
 * 同一个办法用第二次，不是新机制。
 *
 * 落到字段上：`kind: "finding"`、`severity: "P1"`。
 * - `finding` —— schema 那条配对 CHECK 要求 finding 必有严重度，standard 必无。
 * - `P1` 而不是 P0 —— P0 不可豁免，而这是**我自己**提的要求；「我改主意了」
 *   必须还能走 waive，否则人给自己设了一道自己也打不开的闸门。
 */
const HUMAN_GAP_PREFIX = "HUMAN-";

/** 人开的第 n 个问题的 id。 */
export const humanGapId = (n: number): string => `${HUMAN_GAP_PREFIX}${n}`;

/** 这条 gap 是人提的吗。判据只有 id 前缀，别在别处另算一套。 */
export const isHumanGap = (gap: { readonly id: string }): boolean =>
  gap.id.startsWith(HUMAN_GAP_PREFIX);

/**
 * 人自己提一个问题。
 *
 * ## 它和一轮报出来的问题差在哪
 *
 * 差在**谁不许把它当建议**。模型报的问题，裁判下一轮可以判它 `closed`；人提的问题
 * 也一样能被判 closed —— 但提示词里必须把两者分开列（见 `domain/round.ts` 的
 * `judgePrompt`），否则「用户明确要求的」和「反方顺口提的」在裁判眼里一模一样。
 *
 * ## id 由这里分配
 *
 * 和 `domain/brief.ts` 里那条同一个理由：人写的是标题，编号不是他要操心的东西。
 * 顺号取现有 `HUMAN-` 里最大的加一 —— **算所有的，不只 open 的**：一个被关掉的
 * `HUMAN-3` 如果把号让出去，新问题会顶着旧问题的 id，而 `applyRound` 里
 * 「re-finding 一个 closed 的会重开它」当场就把两者混成一条。
 */
export function raise(
  gaps: readonly Gap[],
  input: { readonly title: string; readonly round: number },
): Gap[] {
  const title = input.title.trim();
  // 一个没有正文的问题，下一轮没人知道该改什么。
  if (title === "") throw new InvalidVerdictError("title_missing");

  const used = gaps
    .filter(isHumanGap)
    .map((gap) => Number(gap.id.slice(HUMAN_GAP_PREFIX.length)))
    .filter((n) => Number.isInteger(n) && n > 0);
  const next = used.length === 0 ? 1 : Math.max(...used) + 1;

  return [...gaps, {
    id: humanGapId(next),
    kind: "finding",
    severity: "P1",
    title,
    status: "open",
    openedRound: input.round,
    resolution: null,
  }];
}

export interface RoundOutcome {
  readonly round: number;
  /**
   * Problems this round found. Ids are stable, so re-finding is not re-adding.
   *
   * 一律是 `finding` 且必须带严重度 —— 这是模型在报「它发现了什么」。
   * `standard` 进不来这条路，理由见 `applyRound` 里那段注释。
   */
  readonly found: readonly { id: string; severity: BlockerSeverity; title: string }[];
  /** What this round says about gaps that were already open. */
  readonly verdicts: Readonly<Record<string, Verdict>>;
}

/**
 * The gaps after a round, given the gaps before it.
 *
 * Every previously-open gap is carried forward unless this round explicitly
 * closed it. A verdict naming a gap that is not open is refused rather than
 * ignored -- a round claiming to have closed something that was never there is
 * a round whose other claims are worth less.
 */
export function applyRound(
  before: readonly Gap[],
  outcome: RoundOutcome,
): Gap[] {
  const byId = new Map(before.map((gap) => [gap.id, gap]));

  for (const [gapId, verdict] of Object.entries(outcome.verdicts)) {
    const gap = byId.get(gapId);
    if (!gap || gap.status !== "open") {
      throw new InvalidVerdictError("unknown_gap");
    }
    if (verdict.reason.trim() === "") {
      // A close with no reason is indistinguishable from forgetting, and the
      // whole point here is that those two must not look the same.
      throw new InvalidVerdictError("reason_missing");
    }
    if (verdict.kind === "closed") {
      byId.set(gapId, { ...gap, status: "closed", resolution: verdict.reason });
    }
    // `still_open` changes nothing about the gap -- which is the point: it is
    // the same outcome as silence, and it is recorded on the round rather than
    // on the gap.
  }

  for (const found of outcome.found) {
    const existing = byId.get(found.id);
    if (existing) {
      // Re-finding a gap that was closed reopens it: the round looked and it is
      // there. Re-finding an open one changes nothing.
      if (existing.status === "closed") {
        byId.set(found.id, {
          ...existing,
          status: "open",
          resolution: null,
          openedRound: outcome.round,
        });
      }
      continue;
    }
    byId.set(found.id, {
      id: found.id,
      // 一轮报出来的都是 finding。standard 不从这条路进来 —— 它由 rubric 判定
      // 派生（L5-3），而一轮"没提到某条标准"绝不等于那条标准满足了。
      kind: "finding",
      severity: found.severity,
      title: found.title,
      status: "open",
      openedRound: outcome.round,
      resolution: null,
    });
  }

  return [...byId.values()];
}

/**
 * A human deciding to live with a problem.
 *
 * Separate from `applyRound` because it is a different kind of act: a round
 * reports what it found, a person decides what to tolerate. The reason is
 * required -- 「用户接受已知风险时，必须能够看到风险并留下理由」.
 *
 * ## 一条 standard 不能被 waive
 *
 * waive 说的是「这个问题还在，我接受这个风险」。而一条没被满足的标准，人能说的是
 * 另一句话：「这件事本来就不该要求」—— 那是**撤下这条标准**，不是接受风险。
 *
 * 让 waive 能关掉 standard，就是让人用前一句去说后一句。它的出口在 rubric 那边：
 * 取消勾选阻断或删掉那条 criterion（PRD §1.1、RUBRIC-DESIGN §4.3.1）。
 */
export function waive(gaps: readonly Gap[], gapId: string, reason: string): Gap[] {
  if (reason.trim() === "") throw new InvalidVerdictError("reason_missing");
  const gap = gaps.find((candidate) => candidate.id === gapId);
  if (!gap || gap.status !== "open") throw new InvalidVerdictError("unknown_gap");
  if (gap.kind === "standard") throw new InvalidVerdictError("standard_not_waivable");
  return gaps.map((candidate) =>
    candidate.id === gapId
      ? { ...candidate, status: "waived" as const, resolution: reason }
      : candidate);
}

/**
 * 人驳回一条问题：**这条不成立。**
 *
 * ## 它是 waive 的镜像，而两者说的是三句不同的话
 *
 * ```
 * waive    问题还在，我接受这个风险          -> waived
 * dismiss  这条不成立，别再拿它挡我          -> closed
 * 撤下标准  这件事本来就不该要求              -> rubric 那边，也落 closed
 * ```
 *
 * 用户 2026-07-30 拍板：「人允许驳回蓝方的发现，**以人为主**。」在这之前人没有这条
 * 路 —— 一条蓝方提错的问题只能等模型下一轮自己改主意，而模型不一定会。那时人唯一的
 * 出口是 waive，也就是被迫说「问题还在但我接受」去表达「你搞错了」。**两句话不是
 * 一回事，而账本记的是他说了哪一句。**
 *
 * ## 落 closed 而不是 waived
 *
 * `waived` 的语义是「问题还在，有人决定带着它走」，交付说明里要列出来。驳回说的是
 * 它压根不成立，没有什么要带着走的。这和 REMAP §3.1 给「撤下一条标准」定的是同一
 * 个理由。
 *
 * ## 和 waive 一样拒绝 standard
 *
 * 一条没被满足的标准，出口是**撤下那条 criterion**，不是在这里驳回它 —— 那条标准
 * 还挂着，下一轮判定还会再开一条一模一样的 gap 出来（REMAP §3.4：退休需要正面证据）。
 * 让 dismiss 关掉 standard，等于给了一条这一轮有效、下一轮就失效的假出口。
 */
export function dismiss(gaps: readonly Gap[], gapId: string, reason: string): Gap[] {
  // 理由必填，和 applyRound 拒绝一个没有 reason 的 close 完全同构：一次没有理由的
  // 驳回，和「这一轮忘了提」在库里长得一模一样。
  if (reason.trim() === "") throw new InvalidVerdictError("reason_missing");
  const gap = gaps.find((candidate) => candidate.id === gapId);
  if (!gap || gap.status !== "open") throw new InvalidVerdictError("unknown_gap");
  if (gap.kind === "standard") throw new InvalidVerdictError("standard_not_waivable");
  return gaps.map((candidate) =>
    candidate.id === gapId
      ? { ...candidate, status: "closed" as const, resolution: reason }
      : candidate);
}

/**
 * What the gate sees.
 *
 * Only open gaps. A waived one is not a blocker -- somebody accepted it, on the
 * record -- and a closed one is not a problem. P2 is carried too, because the
 * gate is what decides which severities block, not this.
 */
export function blockersFrom(gaps: readonly Gap[]): Blocker[] {
  return gaps
    .filter((gap) => gap.status === "open")
    .map((gap) => ({
      id: gap.id, kind: gap.kind, severity: gap.severity, title: gap.title,
    }));
}

/** Gaps a human accepted, for the delivery note that has to list them. */
export function waivedFrom(gaps: readonly Gap[]): Gap[] {
  return gaps.filter((gap) => gap.status === "waived");
}
