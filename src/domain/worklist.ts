/**
 * 「逐条问、只收内容」这件事的形状。
 *
 * ## 为什么它是一个独立的纯模块
 *
 * 两边要用同一套词：**插件**（`plugin/protocol.ts`，L3）把条目念给模型、把答案收
 * 回来；**store**（`store/worklist-store.ts`）把它们落库。插件在 L3，所以这些类型
 * 不能住在更高的地方 —— 而它们本来也不该带任何存储或 SQL 的味道。
 *
 * ## 这套东西存在的理由
 *
 * 在它之前，裁判把 gap id（50 字符）和 criterion key（40 字符）**手抄**进一个 json
 * 块的 key 位置上，而 StagePass 拿它们做精确相等匹配。抄漏一段，一整份判定作废
 * （2026-08-02 实测：同一个抄错的 UUID 连抄三轮）。
 *
 * 用户 2026-08-02 立的规矩：**凡是 StagePass 会拿去做精确匹配的字符串，都不许出现
 * 在模型必须生成的文本里。** 推论是模型的输出里只允许有两种东西 —— 枚举里的选择，
 * 和散文。这个模块就是那条推论的类型形式：`choices` 是枚举，`reason` 是散文，
 * 而身份（`target`）根本不往那边走。
 *
 * 见 docs/DESIGN-no-hand-transcription-2026-08-02.md。
 */

export type WorkItemKind = "gap" | "criterion";

export interface WorkItemDraft {
  readonly kind: WorkItemKind;
  /** gap id 或 criterion key。**从不发给模型。** */
  readonly target: string;
  /**
   * 模型看得到的那段话。
   *
   * **里面不许出现 `target`。** 出现了模型就会去抄它，而这一整套改动就是为了让它
   * 没有东西可抄。这一条由造名单的那一层保证（`work/` 那两处），并有测试盯着。
   */
  readonly prompt: string;
  /** 允许的答案。答别的会被当场拒掉，并把这几个值原样回给它。 */
  readonly choices: readonly string[];
}

/** 念给模型听的那一条 —— 只有序号、总数、正文和可选项，没有身份。 */
export interface WorkItemView {
  readonly ordinal: number;
  readonly total: number;
  readonly prompt: string;
  readonly choices: readonly string[];
}

/**
 * 一次作答的结局。
 *
 * **答错了不抛，返回一个值。** 插件要把「你只能答这几个」原样回给模型 —— 那是它
 * 自己改得过来的错。抛异常会变成一句 MCP 层的错误文本，模型只知道「失败了」，
 * 而不知道该怎么办。
 */
export type AnswerOutcome =
  | { readonly kind: "recorded"; readonly remaining: number }
  | { readonly kind: "nothing_open" }
  | { readonly kind: "bad_answer"; readonly choices: readonly string[] }
  | { readonly kind: "no_reason" };
