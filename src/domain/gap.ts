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
  /**
   * 人对这一条说的话，跟着它进下一轮。null = 人还没说过。
   *
   * 和 `resolution` 分开，因为它们答的是两个问题：`resolution` 说「它为什么不再
   * 挡着」，`note` 说「它还挡着，而这是我要红方注意的」。合成一个字段，「我驳回了
   * 它」和「我要求照我说的改」就成了同一行。
   */
  readonly note: string | null;
  /**
   * 这一条是**谁**关掉的。`"human"` = 人驳回的，`null` = 一轮判它修好了（或者它还开着）。
   *
   * 两者在 `status` 上都是 `closed`，而该怎么对待它们正好相反 —— 见 `applyRound`
   * 里那段重开的注释。用户 2026-07-30 拍的「以人为主」，2026-08-03 明确到「一直管」。
   */
  readonly closedBy: "human" | null;
  /**
   * 报的人说它在哪儿、为什么是问题，原文照抄。定义和理由见 `domain/gate.ts` 的
   * `Blocker.where` —— 用户 2026-08-04：「绝对不能出现语义损失」。
   *
   * `standard` 一律是 null（rubric 派生的，没有「在哪儿」），人自己提的那条也是
   * null（他的话就是标题本身）。
   */
  readonly where: string | null;
  readonly why: string | null;
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
    | "p0_not_waivable"
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
    // 标题就是他的话，不用再抄一份到 note 里（E3：一份实现，一处存放）。
    note: null,
    closedBy: null,
    // 人自己提的：他的话就是标题本身，没有「在哪儿」和「为什么」这两问。
    where: null,
    why: null,
  }];
}

/**
 * 人对每一条 open gap 的表态 —— 「回应蓝方」这个动作的落点。
 *
 * ## 为什么要有这一步
 *
 * 用户 2026-07-30 的五步场景，第 ⑤ 步是「我要么再开一轮，要么接受」。在这之前那一步
 * 只有一个 approve / reject，人对**具体哪一条**的看法没有容器：他觉得反方第一条提错
 * 了、第二条可以带着走、第三条必须改 —— 三种意思只能压成一个 reject，然后下一轮的
 * 红方什么也不知道。
 *
 * ```
 * agree     这条成立，红方下轮必须改   -> 保持 open，我的话落在 note 上进下一轮
 * dismiss   这条不成立                 -> closed（以人为主）
 * waive     问题还在，我接受这个风险   -> waived
 * ```
 *
 * ## 落不下去的**报回去**，不静默丢掉
 *
 * 一次驳回或接受没有理由就落不下去（那是 `dismiss` / `waive` 的规矩）。而这时人已经
 * 答完走了，所以**必须报回去**：静默跳过等于他点了一下什么都没发生，而那正是这一整
 * 轮排查花掉的时间。
 */
export type GapResponse =
  | { readonly kind: "agree"; readonly note: string }
  | { readonly kind: "dismiss"; readonly reason: string }
  | { readonly kind: "waive"; readonly reason: string };

export interface RespondResult {
  readonly gaps: Gap[];
  /** 没能落地的那些，以及为什么。 */
  readonly refused: readonly {
    readonly id: string;
    readonly code: InvalidVerdictError["code"];
  }[];
}

export function respond(
  before: readonly Gap[],
  responses: Readonly<Record<string, GapResponse>>,
): RespondResult {
  let gaps = [...before];
  const refused: { id: string; code: InvalidVerdictError["code"] }[] = [];

  for (const [gapId, response] of Object.entries(responses)) {
    try {
      if (response.kind === "dismiss") {
        gaps = dismiss(gaps, gapId, response.reason);
        continue;
      }
      if (response.kind === "waive") {
        gaps = waive(gaps, gapId, response.reason);
        continue;
      }
      // agree：这条留着，只是带上人的话。
      const gap = gaps.find((candidate) => candidate.id === gapId);
      if (!gap || gap.status !== "open") throw new InvalidVerdictError("unknown_gap");
      const note = response.note.trim();
      // 没写字就什么都不改。**沉默不覆盖上一轮写过的话** —— 这个模块从头到尾的
      // 规矩就是沉默什么都不改。
      if (note === "") continue;
      gaps = gaps.map((candidate) =>
        candidate.id === gapId ? { ...candidate, note } : candidate);
    } catch (error) {
      if (!(error instanceof InvalidVerdictError)) throw error;
      refused.push({ id: gapId, code: error.code });
    }
  }

  return { gaps, refused };
}

export interface RoundOutcome {
  readonly round: number;
  /**
   * Problems this round found. Ids are stable, so re-finding is not re-adding.
   *
   * 一律是 `finding` 且必须带严重度 —— 这是模型在报「它发现了什么」。
   * `standard` 进不来这条路，理由见 `applyRound` 里那段注释。
   */
  readonly found: readonly {
    id: string;
    severity: BlockerSeverity;
    title: string;
    /** 在哪儿、为什么。缺就是 null —— 见 `domain/gate.ts` 的 `Blocker.where`。 */
    where: string | null;
    why: string | null;
  }[];
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

  const foundThisRound = new Set(outcome.found.map((each) => each.id));
  for (const [gapId, verdict] of Object.entries(outcome.verdicts)) {
    const gap = byId.get(gapId);
    if (!gap || gap.status !== "open") {
      /*
       * **裁判对本轮的事表态，一律无效力；凭空编的 id 才作废整轮。**（2026-08-02，
       * 真机三连实测后定形）
       *
       * 三次「unknown」全是同一个系统性倾向：裁判对**蓝方这一轮刚报**的问题当场
       * 裁决 —— 一次 still_open（Spec 第 2 轮）、一次有理有据的 closed（TechSpec
       * 第 1 轮，它驳回了蓝方两条）。模型不共享我们的轮次边界模型，提示词拦不住。
       *
       * 三段处理，各有各的理由：
       *
       * - `still_open`（对谁都一样）→ 跳过。按定义就是无操作 —— 下面那段注释自己
       *   写着：still_open 和沉默是同一个结果。
       * - `closed` 且 id 在**本轮 found 名单**里 → 跳过，而发现照常落地 open。
       *   **蓝方的发现不经裁判过滤**是这套机制的立身之本 —— 让同轮 closed 生效，
       *   一个想省事的裁判就能在人看见之前掐掉蓝方的话。它的异议留在它的 rollout
       *   里，下一轮这条 gap 在名单上，它自然可以正式表态。
       * - `closed` 且**谁都不认识** → 照旧作废。对一个既不开着、也不是本轮报出来
       *   的东西宣称关闭，是凭空抹掉一个从来没有过的东西 —— 这样的轮别的话也
       *   不值钱（原注释的本意，原样保留）。
       */
      if (verdict.kind === "still_open") continue;
      if (foundThisRound.has(gapId)) continue;
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
      /*
       * 一轮关掉的东西被重新发现 → 重开：那一轮看了，它还在。开着的重新发现，
       * 什么都不变。
       *
       * **人驳回的不在此列。** 人是带着依据裁的（`dismiss` 强制 `reason`），而模型
       * 没读过那个依据 —— 它「又看见了」不是新信息，它本来就不知情。让它重开，等于
       * 让一个不知情的人一遍遍推翻知情的人。2026-08-02 实测 `QA-007` 被这样重开
       * 三次、跨两个阶段，而人第一次为什么驳它，三次之后已经查不到（重开抹掉了
       * `resolution`）。
       *
       * 用户 2026-07-30 拍板「以人为主」，2026-08-03 明确到「**一直管**」——
       * 任何阶段任何轮都不自动重开。裁判仍然看得见这一条和人的理由
       * （`judgePrompt` 会列出来），它可以在有新证据时**建议**重提，但重提是人的动作。
       */
      if (existing.status === "closed" && existing.closedBy !== "human") {
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
      note: null,
      closedBy: null,
      where: found.where,
      why: found.why,
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
  /*
   * P0 不许豁免（gate.ts：「严重到不可接受的问题不能靠普通确认绕过」）。这道闸必须
   * 在这里而不是只在挑候选名单的地方：`/api/waive` 筛了 P1，但裁决表「回应蓝方」
   * 对每条 open gap 都给「先接受这个风险」—— 2026-08-05 发现对 P0 选它会一路落到
   * 这里，P0 落成 waived 就从 blockers 里消失，闸门就开了。名单是每个入口自己挑的，
   * 规则只有这一份。
   */
  if (gap.severity === "P0") throw new InvalidVerdictError("p0_not_waivable");
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
      ? {
        ...candidate,
        status: "closed" as const,
        resolution: reason,
        // 这一笔是这条 gap 从此不再被模型重开的**唯一**依据。见 `applyRound`。
        closedBy: "human" as const,
      }
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
      where: gap.where, why: gap.why,
    }));
}

/** Gaps a human accepted, for the delivery note that has to list them. */
export function waivedFrom(gaps: readonly Gap[]): Gap[] {
  return gaps.filter((gap) => gap.status === "waived");
}
