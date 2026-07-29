/**
 * Rubric：一份可编辑的「是 / 否」标准，以及一次编辑对它做了什么。
 *
 * ## 为什么判定只有是与否
 *
 * 用户拍板，不可推翻（`RUBRIC-DESIGN.md` §2.4）：**不许打分。** 原话是「否则 AI
 * 打分会出幻觉，用大量的 yes or no 来规范模型」。所以这里没有分数、没有权重、没有
 * 阈值 —— 一条 criterion 只有满足与不满足两种答案，外加一种「模型没回答」的记账。
 *
 * ## `not_assessed` 不是第三个答案
 *
 * 它是漏答的记账。**模型自己不许写这个值** —— 能写就等于给了它一条「跳过这题」的
 * 路，而漏答被静默当成通过正是这套机制要防的事。它由解析器在发现缺行时填。
 *
 * ## criterion_key 是承重结构，不是整洁
 *
 * `gate.snapshotOf` 哈希的是 blocker 的 **id**，而 rubric 派生的 gap id 从
 * `criterion_key` 派生。key 一动，snapshot 就动，**每一个 open question 的 fence
 * 当场作废**，人正在回答的问题被拒绝。
 *
 * 所以 `nextVersion` 的第一优先级规则是「用编辑器回传的 key」，正文匹配只做后备：
 * 只按正文匹配的话，**改一个错别字仍会孤立已开的 gap**，病一样，只是触发条件变窄。
 * 见 docs/RUBRIC-REMAP-2026-07-29.md §3.2。
 *
 * ## 这个模块是纯的
 *
 * 没有数据库、没有时钟、没有 IO。铸新 key 由调用方注入，所以「同样的输入得到同样
 * 的版本」可以离线穷举证明。
 */

export const RUBRIC_ROLES = ["producer", "critic", "verdict"] as const;
export type RubricRole = (typeof RUBRIC_ROLES)[number];

export const RUBRIC_VERDICTS = ["yes", "no", "not_assessed"] as const;
export type RubricVerdict = (typeof RUBRIC_VERDICTS)[number];

/** 一个版本里的一条标准。`key` 跨版本稳定，`ordinal` 不稳定。 */
export interface Criterion {
  readonly key: string;
  readonly ordinal: number;
  readonly text: string;
  /** 判定为 `no` 时是否生成一条挡闸门的 gap。 */
  readonly blocking: boolean;
}

/**
 * 编辑器交回来的一条。
 *
 * `key` 缺席表示「这是新写的」；带着 key 表示「这是原来那条」。**带来的 key 必须
 * 属于本 scope 的上一版**，否则拒绝整次编辑 —— 信了它，就等于允许一个请求把一条
 * 新写的 criterion 绑到别人已经开着的 gap 上。
 */
export interface CriterionDraft {
  readonly key?: string | null;
  readonly text: string;
  readonly blocking: boolean;
}

/**
 * 一轮对一条标准的判定，连同**判定当时**的快照。
 *
 * 快照那两个字段是整套不对称的根：**开启一条阻断项读它们，退休才读当前 rubric。**
 * 所以改一次 rubric 的措辞不会移动任何已经开出去的东西，而撤下一条标准会。
 *
 * 定义在 domain 而不是 store，是因为「判定长什么样」是领域概念，store 只是把它
 * 存下来 —— 两边各定义一份迟早会打架。
 */
export interface Assessment {
  readonly criterionKey: string;
  readonly verdict: RubricVerdict;
  readonly evidence: string | null;
  /** 判定当时那条 criterion 的正文。**永不回溯派生。** */
  readonly criterionText: string;
  /** 判定当时它是否标着阻断。 */
  readonly blockingThen: boolean;
}

export class UntrustedKeyError extends Error {
  constructor(readonly key: string) {
    super(`criterion key ${key} does not belong to this rubric`);
    this.name = "UntrustedKeyError";
  }
}

export class InvalidCriterionError extends Error {
  constructor(readonly code: "text_empty" | "key_reused") {
    super(code);
    this.name = "InvalidCriterionError";
  }
}

/**
 * 下一个版本的 criteria。
 *
 * 不原地改旧版本 —— 编辑产生新版本行（§4.4）。key 的解析顺序：
 *
 *   1. 编辑器回传的 key，且它在上一版里 —— **第一优先级**
 *   2. 正文与上一版某条完全相同，且那条还没被认领 —— 后备
 *   3. 其余：铸一个新的
 *
 * 第 2 条是「先到先得」：同一条旧 criterion 不许被两个 draft 认领，否则一个 gap
 * 会有两个来源。
 */
export function nextVersion(
  previous: readonly Criterion[],
  drafts: readonly CriterionDraft[],
  mintKey: (index: number) => string,
): Criterion[] {
  const byKey = new Map(previous.map((entry) => [entry.key, entry]));
  // 正文 -> 还没被认领的旧 key。认领一次就删掉，实现「先到先得」。
  const byText = new Map<string, string[]>();
  for (const entry of previous) {
    byText.set(entry.text, [...(byText.get(entry.text) ?? []), entry.key]);
  }

  const taken = new Set<string>();
  const claimByText = (text: string): string | null => {
    const queue = byText.get(text);
    while (queue && queue.length > 0) {
      const key = queue.shift()!;
      if (!taken.has(key)) return key;
    }
    return null;
  };

  return drafts.map((entry, index) => {
    if (entry.text.trim() === "") throw new InvalidCriterionError("text_empty");

    let key: string;
    if (entry.key !== undefined && entry.key !== null) {
      if (!byKey.has(entry.key)) throw new UntrustedKeyError(entry.key);
      key = entry.key;
    } else {
      key = claimByText(entry.text) ?? mintKey(index);
    }

    if (taken.has(key)) throw new InvalidCriterionError("key_reused");
    taken.add(key);

    return { key, ordinal: index, text: entry.text, blocking: entry.blocking };
  });
}

/**
 * 这次编辑退休掉了哪些**阻断**标准。
 *
 * 两件事各要用到它：
 *
 * 1. **出口**（§4.3.1）：rubric 派生的阻断项，只在它背后那条 criterion 仍被标为
 *    阻断时才活着。名单里的每一条，其派生的 gap 要跟着退休。
 * 2. **理由**（PRD §1.1）：网页可以改标准，但一次会退休掉活着的阻断项的编辑必须
 *    带理由。名单空着就不需要理由。
 *
 * 只看 `blocking` 从真变假或整条消失。**改正文不算退休** —— 标准还在，只是话说得
 * 清楚了；把它算成退休，就等于每次润色措辞都要人写一遍理由。
 *
 * 本来就 `blocking: false` 的那些也不算：它们从没派生过阻断项，没有东西可退。
 */
export function retiredBy(
  previous: readonly Criterion[],
  next: readonly Criterion[],
): Criterion[] {
  const stillBlocking = new Set(
    next.filter((entry) => entry.blocking).map((entry) => entry.key),
  );
  return previous.filter((entry) => entry.blocking && !stillBlocking.has(entry.key));
}
