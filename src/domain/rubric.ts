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
  /**
   * 它判的是产出模板的哪一节（`domain/phase-template.ts` 的 `TemplateSection.key`）。
   *
   * `null` = 不挂节 —— 老数据、以及还没有模板的那十一个阶段。
   *
   * **这一格是「越界」的机械判据。** 用户 2026-08-06：「PRD 阶段只能留 PRD 的，
   * 就算漏了也不能留。」一条标准说不清自己管哪一节，就没有任何东西能判它越没越界。
   */
  readonly section: string | null;
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
  /** 挂哪一节。缺席和 `null` 一样，都是「不挂」。 */
  readonly section?: string | null;
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
  /**
   * 它判的是模板的哪一节。`null` = 这条标准没挂节。
   *
   * **不新增列**：从 `rubric_criteria` 按 `(rubric_id, criterion_key)` join 出来 ——
   * `rubric_id` 记的就是判定当时那一版，所以 join 出来的天然是快照，和
   * `criterionText` / `blockingThen` 同一个语义，只是不用再存一遍。
   */
  readonly section: string | null;
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

    return {
      key, ordinal: index, text: entry.text, blocking: entry.blocking,
      // 缺席和 null 统一成 null —— 两种「没挂」在库里长成一样，在类型里也该一样。
      section: entry.section ?? null,
    };
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

/**
 * 一份标准是谁的活儿，写给人看的那几个字。
 *
 * **不导出。** `panel.js` 是浏览器里的纯 JS，导不进 TS，所以那边有它自己的一份 ——
 * 导出成「大家共用」只是句空话，而护栏会当场抓住一个没人引用的导出（它抓到过）。
 * 两份字面量一样的标签是已知的、可接受的重复；把它说成不重复才是问题。
 */
const ROLE_LABEL: Readonly<Record<RubricRole, string>> = {
  producer: "正方", critic: "反方", verdict: "裁判",
};

/** 一句话里最多点几条名。再多就只报总数 —— 题面是标题，不是报告。 */
const NAMED_AT_MOST = 2;

/**
 * 这一轮的标准判定，写成人在裁决前要读的那一句。
 *
 * ## 为什么它必须存在
 *
 * 用户 2026-07-30 拍板：**要不要继续对抗由人决定，不做成全自动**。那么人就得看得见
 * 这一轮判成什么样 —— 否则「再来一轮还是批准」是在没有信息的情况下按的，而这一屏
 * 存在的全部意义就是不让人猜。
 *
 * ## `no` 和 `not_assessed` 分开说
 *
 * 前者是判了不满足（东西要改），后者是模型压根没照契约作答（**这一轮的判定本身
 * 不可信**）。混成一句「没通过」，就把「东西不好」和「判定坏了」说成了同一件事，
 * 而人对这两件事该做的反应完全不同。
 *
 * ## 为什么截断，以及截断时必须先说总数
 *
 * 这句话会变成选择器整张表的标题，长了没人读得完。所以只点前两条的名，**但总数
 * 写在最前面** —— 截断可以吃掉细节，不许吃掉「还差多少」。
 */
export function summariseAssessments(
  byRole: Readonly<Partial<Record<RubricRole, readonly Assessment[]>>> | null,
): string {
  const all = byRole === null ? [] : (Object.keys(byRole) as RubricRole[])
    .flatMap((role) => (byRole[role] ?? []).map((entry) => ({ role, entry })));
  if (all.length === 0) return "这一轮没有标准判定。";

  const missed = all.filter(({ entry }) => entry.verdict !== "yes");
  if (missed.length === 0) return `标准 ${all.length} 条全部满足。`;

  const named = missed.slice(0, NAMED_AT_MOST).map(({ role, entry }) =>
    `${ROLE_LABEL[role]}「${entry.criterionText}」`
    + (entry.verdict === "no" ? "不满足" : "模型漏答"));
  const rest = missed.length - named.length;
  /*
   * **卡在哪一节**（用户 2026-08-06：「人的耐心也是要有依据的」）。
   *
   * 点名两条之后就截断了，而「还差多少、差在哪个方向」不该跟着被截掉 —— 节的数量
   * 是个位数，摆全了也就一行。人按「再来一轮还是批准」时，这一行才是他真正在读的：
   * 三条全卡在验收标准上，和三条散在三节里，是完全不同的两种局面。
   */
  const sections = [...new Set(missed
    .map(({ entry }) => entry.section)
    .filter((each): each is string => each !== null))];
  const where = sections.length === 0 ? "" : `（卡在 ${sections.join("、")}）`;
  return `标准 ${all.length} 条里 ${missed.length} 条没勾上${where}：`
    + named.join("；") + (rest > 0 ? `；另有 ${rest} 条` : "") + "。";
}
