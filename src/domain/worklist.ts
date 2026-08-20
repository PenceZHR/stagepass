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

/**
 * 一条答案在文件里长什么样。序号之外，模型写的全是散文和枚举。
 *
 * 和反方那份判定（`readBlueRubricAnswers`）逐字同形，那是故意的：一个人手里
 * 两种格式，就是两次答错的机会。
 */
const ANSWER_LINE = /^(\d+)\s*[:：]\s*([^\s—–-]+)\s*(.*)$/;

/** 序号映射回来之后的一条。`ordinal` 由 StagePass 换回 `target`，模型看不到那一步。 */
export interface WorklistAnswer {
  readonly ordinal: number;
  readonly answer: string;
  readonly reason: string;
}

export interface WorklistAnswers {
  readonly answers: readonly WorklistAnswer[];
  /**
   * 这一份读下来有什么不对。**每一条都带序号**，人拿着它能直接翻到那一项。
   *
   * 不叫「错误」是因为它不作废任何东西：答上的照样算数，没答上的照旧保持原样。
   */
  readonly problems: readonly string[];
}

/**
 * 名单印成一份文件 —— **裁判读它，然后把答案写进另一份。**
 *
 * ## 为什么是文件，不是 `stagepass_next`
 *
 * 原来这份名单走 MCP 工具：裁判反复调 `stagepass_next` 取下一条、用
 * `stagepass_answer` 回答。那条路 2026-08-19 随 `src/plugin/` 一起没了 ——
 * StagePass 不再是插件，而**人自己的会话里没有这两个工具**（甲那条路的前提就是
 * 那一轮跑在他的会话里）。工具还在题面上写着，而没有一个生产调用者去接答案：
 * 后果是每一轮的 gap 表态全丢、每一条标准记 `not_assessed` —— 而标了阻断的
 * `not_assessed` 是把闸门关死的。**沉默地关死**，那是最坏的一种。
 *
 * 走的是树上已经验过的那个形状（`blueRubricFiles` / `readBlueRubricAnswers`）：
 * 正文进文件、**按序号答**、key 由 StagePass 映射回去。七个手抄面仍然是零 ——
 * `target` 一个字都不进这份文件。
 *
 * ## 代价说清楚：它一次看得见全部
 *
 * 工具那条路一次只给一条，模型「不需要、也无法指定答的是哪一条」。文件做不到这一点。
 * 换来的是它在**任何一个 Codex 会话里都跑得动**，不需要装、不需要注册、不需要每轮
 * 按一次 MCP 许可。反方那份判定早就付过同样的代价（那份也是一次看全 N 条）。
 */
export function renderWorklist(items: readonly WorkItemDraft[]): string {
  return [
    `# 这一轮要你逐条表态的（共 ${items.length} 条）`,
    "",
    "一条一条看完，把答案写进题面指定的那份答案文件。**这里的编号不要抄进别的地方。**",
    "",
    ...items.flatMap((item, index) => [
      // 正文可能有好几行（gap 带标题和人说的话），除第一行外都缩进 ——
      // 不缩进的话，第二行顶格会被人和模型都读成下一条。
      `${index + 1}. ${item.prompt.split("\n").join("\n   ")}`,
      `   → 答 ${item.choices.map((choice) => `\`${choice}\``).join(" 或 ")}，`
      + "后面写一句为什么。",
      "",
    ]),
  ].join("\n");
}

/**
 * 答案文件读回来，**按序号映射**。
 *
 * ## 为什么答一半不作废（和反方那份不一样）
 *
 * 反方那份数不对就整份作废，理由是它按序号**映射位置**，错位会让一条判定挂到别的
 * 标准上。这里不会：每一行自带序号，映射是逐条独立的 —— 少一行就是少一条，不会
 * 让别的条错位。
 *
 * 而「沉默」在这套东西里早就有意思了：**没答上的保持 open / `not_assessed`**，
 * 那是裁判的判断，不是故障。为几行没写就把它答对的那几条一起扔掉，是拿它做过的
 * 判断去惩罚它没做的。
 *
 * ## 但答错要说出来
 *
 * 越界、重号、不在选项里、没写理由 —— 四种都进 `problems`，而 `problems` 会跟着
 * `malformed` 走到下一轮。静默地丢掉一条表态，人看到的是「它说这个问题还在」，
 * 而真相是「它说了，我没收下」。
 */
export function readWorklistAnswers(
  text: string | null,
  items: readonly WorkItemDraft[],
): WorklistAnswers {
  if (items.length === 0) return { answers: [], problems: [] };
  if (text === null) {
    return { answers: [], problems: ["worklist_answers_missing"] };
  }

  const answers: WorklistAnswer[] = [];
  const problems: string[] = [];
  const seen = new Set<number>();

  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*]\s*/, "");
    const matched = ANSWER_LINE.exec(line);
    // 读不懂的行不是问题：它可能写了标题、说明或者空行。
    if (!matched) continue;

    const ordinal = Number(matched[1]);
    const answer = matched[2]!;
    // 依据前面那串破折号/空格是排版，不是内容。
    const reason = (matched[3] ?? "").replace(/^[—–-]+\s*/, "").trim();

    const item = items[ordinal - 1];
    if (item === undefined) {
      problems.push(`worklist_answer_out_of_range:${ordinal}`);
      continue;
    }
    if (seen.has(ordinal)) {
      problems.push(`worklist_answer_duplicated:${ordinal}`);
      continue;
    }
    if (!item.choices.includes(answer)) {
      problems.push(`worklist_answer_not_a_choice:${ordinal}`);
      continue;
    }
    // 理由必须非空，和 `WorklistStore.answer` 那条判据同一个理由：一句「已修复」
    // 和沉默的信息量是一样的。
    if (reason === "") {
      problems.push(`worklist_answer_has_no_reason:${ordinal}`);
      continue;
    }
    seen.add(ordinal);
    answers.push({ ordinal, answer, reason });
  }

  return { answers, problems };
}
