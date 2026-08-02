import type { Answer, ClarificationItem } from "./question";

/**
 * 录入需求：模型读完仓库提问题，人在选择器里答，答出来的那一段就是需求。
 *
 * ## 这一层补的是什么洞
 *
 * 在这之前，PRD 阶段的红方收到的是一句写死的通用指令（`Write the product
 * requirement for this change…`），而「this change」是哪个 change **从来没被告知**。
 * 于是那份 PRD 只能是编的 —— 而下游每个阶段都写着「Turn the approved PRD into…」，
 * 整条流水线建在一份凭空产生的需求上。
 *
 * 需求文档 §2.1 列的第一条职责就是「引导用户表达需求」。这一层就是它。
 *
 * ## 谁定什么（用户 2026-07-29 拍板）
 *
 *   **问什么** —— 模型定。它先读仓库，所以问题贴这个项目，而不是一份放之四海的
 *                 通用问卷。
 *   **信封**   —— StagePass 定。id 由这里分配，条数上下限、每题至少几个选项，
 *                 都由这里校验。
 *
 * 这个分法和项目的成文规则不冲突：判据始终是「**结构**由谁决定」。结构在这里，
 * 内容在那边。
 *
 * ## 两条承重的规则
 *
 * 1. **一条都没提 = 作废。** 「模型没提问题」和「这个改动不需要问」都是空的，长得
 *    一模一样。放过去，需求录入就被静默跳过了 —— 而下游那份 PRD 仍然会被生成出来，
 *    看着一切正常。这是这个项目从头到尾在防的那一种失败。
 * 2. **总是多一道自由填写，模型删不掉。** 模型的想象力不该限定你能说什么。它列的
 *    选项里没有你要的那个时，你仍然说得出来。
 *
 * ## 这个模块是纯的
 */

/**
 * 那道自由填写的 id。StagePass 无条件追加，模型碰不到。
 *
 * **`Y` 不是随便挑的字母 —— 排序就是显示顺序。** 见下面 `fieldId`：选择器按字段名
 * 排序，`Y` 大于任何数字，所以它落在 `B08x` 之后；又小于 `Z`，所以提交那格
 * （`CONFIRM_ID`）压轴。原来叫 `B0`，于是「还有什么必须说清楚的？」成了人看见的
 * **第一格**（2026-07-30 实测：`Field 1/17`）—— 在被问到任何一个具体问题之前，
 * 先被问「还有什么」。
 */
export const FREE_TEXT_ID = "BY";

/**
 * 压轴那格「提交」的 id。**它是一个选项格，这是它存在的全部理由。**
 *
 * 表单有两条实测的硬约束（2026-07-30）：**空的自由文本格会吃掉回车**（optional
 * 也不管用），而**整张表只能从最后一格提交**。合起来：最后一格要么是选项格
 * （回车总有个值可提交），要么必填。
 *
 * 第一版选了必填 —— 于是每次录需求都被逼着亲手写一句。用户 2026-07-31 明确否掉：
 * 「我明明已选了，但它还是让我输入一些我自己的话，这是不对的。」选项该是选项，
 * 想自己说的人自然会去补充格写。所以换到另一条路：自由填写那格放开成可留空，
 * 末尾**加一格只有一个选项的提交格**，回车永远有值、表永远交得上去。
 */
export const CONFIRM_ID = "BZ";

/** 提交格里唯一的选项。它不进需求正文 —— 它是门把手，不是回答。 */
export const CONFIRM_OPTION = "都答完了，提交";

/** 一次最多问几件事。再多没人答得完，而答不完的问卷等于没问。 */
const MAX_ITEMS = 8;

/**
 * 每题至少几个选项。
 *
 * 2026-07-30 从 2 提到 3：用户原话是「三个选项不够，应该由模型自己定给几个」。
 * **两个选项的题几乎总是一个假二分** —— 它把一个开放的问题伪装成一次表态。
 * 上限刻意不设：几个够用由模型判断，它读过仓库，这件事它比这里清楚。
 */
const MIN_OPTIONS = 3;

/**
 * StagePass 无条件塞进每一题的最后一个选项。
 *
 * **模型列的选项不该限定你能说什么。** 有了它，「四个都不满意」是一个可以点下去的
 * 答案，而不是一个只能靠留空表达的沉默。
 */
export const ESCAPE_OPTION = "都不对，我自己写";

/**
 * 第 n 题的字段 id。**两位数补零，因为字段名就是显示顺序。**
 *
 * 2026-07-30 在 Codex TUI 实测：`clarificationQuestion` 按 `B1, B1x, …, B8, B8x, B0`
 * 写出去，选择器画出来的第一格是 `B0` —— 客户端**按字段名排序**，不按 schema 里
 * properties 的书写顺序。所以顺序只能编码在名字里。
 *
 * 补零管的是 `MAX_ITEMS` 哪天被提上去：`B1 < B10 < B1x`，不补零的话第 10 题会插到
 * 第 1 题和它自己那格自由文本中间，而**每一题和它的「你自己怎么说」必须相邻** ——
 * 隔开了，人就得在十几格里自己找配对。`brief.test.ts` 里那条「顺序等于排序」的
 * 测试盯着这件事。
 */
const fieldId = (n: number): string => `B${String(n).padStart(2, "0")}`;

/** 每题跟着的那格自由文本的 id：问题 id 加个 x。排序上它紧跟自己那题。 */
export const ownFieldId = (id: string): string => `${id}x`;

const FENCE = /```brief\s*([\s\S]*?)```/g;

export class BriefProposalVoidError extends Error {
  constructor(
    readonly code:
      | "no_items"
      | "too_many"
      | "question_empty"
      | "too_few_options",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "BriefProposalVoidError";
  }
}

/**
 * 发给模型的契约：读完仓库，提几个要问人的问题。
 *
 * 里面那句「可能和仓库里现在有什么无关」不是客套。读仓库有一个真实的副作用：模型
 * 容易开始问「现有代码怎么样」，而人想做的事**可能和仓库里现在有什么毫无关系** ——
 * 尤其是一个全新的功能。不写这句，问出来的会是一份代码导览而不是需求。
 */
export function briefContract(input: { changeTitle: string | null }): string {
  return [
    "先读一遍这个仓库，搞清楚它是什么、现在能做什么。",
    input.changeTitle === null
      ? "然后想清楚：要把这次改动说清楚，还缺哪些只有人能回答的信息？"
      : `这次改动，人给的线索只有一句话：「${input.changeTitle}」。`
        + "想清楚：要把它说清楚，还缺哪些只有人能回答的信息？",
    "",
    "**注意：人想做的事可能和仓库里现在有什么无关。** 不要只问现有代码怎么样，",
    "要问的是他要什么结果、给谁用、什么明确不做。",
    "",
    `按下面的格式提 1 到 ${MAX_ITEMS} 个问题，一行一个，用 | 分隔：`,
    "```brief",
    "问题？ | 选项一 | 选项二 | 选项三 | 选项四",
    "```",
    `每个问题**至少 ${MIN_OPTIONS} 个选项，上限没有** —— 几个够用你自己判断，`,
    "你读过这个仓库，这件事你比我清楚。**两个选项通常是把开放问题伪装成一次表态**，",
    "不要那样做；真实的取舍有几种就列几种。",
    "",
    "选项要具体，不要写「其他」或「都不对」：**那一项和一格自由输入都由系统追加**，",
    "人总能越过你的选项直接说他要什么。你的任务是把真实的取舍列全，不是替他收口。",
  ].join("\n");
}

/**
 * 读模型提的问题清单。
 *
 * 散文忽略、最后一个 fence 赢 —— 和这棵树里其它读模型输出的地方同一套路子
 * （`parseTurnResult`、`readAssessments`）：改主意的模型会再写一个，取第一个就是
 * 照着它已经作废的草稿办事。
 *
 * **id 由这里分配，模型写什么都不看。** 它决定不了的东西就撞不上任何东西。
 */
export function readBriefProposal(text: string): ClarificationItem[] {
  const fences = [...text.matchAll(FENCE)].map((match) => match[1]!);
  const body = fences.length > 0 ? fences[fences.length - 1]! : text;

  const proposed: ClarificationItem[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "" || !line.includes("|")) continue; // 散文

    const parts = line.split("|").map((part) => part.trim());
    const question = parts[0] ?? "";
    const options = parts.slice(1).filter((part) => part !== "");

    if (question === "") {
      throw new BriefProposalVoidError("question_empty", line.slice(0, 60));
    }
    if (options.length < MIN_OPTIONS) {
      // 一个选项不是在问，是在通知；两个几乎总是一个假二分。
      throw new BriefProposalVoidError("too_few_options", question.slice(0, 40));
    }
    proposed.push({ id: fieldId(proposed.length + 1), question, options });
  }

  if (proposed.length === 0) {
    throw new BriefProposalVoidError("no_items",
      "模型一条都没提 —— 这和「不需要问」长得一样，不许当成后者");
  }
  if (proposed.length > MAX_ITEMS) {
    throw new BriefProposalVoidError("too_many", String(proposed.length));
  }

  /*
   * 每一题都摊成**两个字段**：选项一格，自己写一格。
   *
   * 这不是排版偏好，是 elicitation 的硬约束：一个字段有 `enum` 就是下拉选一个，
   * 没有就是自由输入 —— **没有「选项 + 或者自己写」那种字段**。所以想让人在选项
   * 之外还能说话，只能给他第二格。
   *
   * 顺带一个好处：选了某一项之后**仍然可以补充**。选项和自己写不是二选一。
   *
   * **那第二格必须是 `optional`。** 客户端把 `required` 当硬闸门：还有必填没答时
   * 按回车**什么都不会发生**（2026-07-30 实测）。摊成两格却让两格都必填，等于把
   * 一次 8 下回车的问卷变成 17 格全要动手，而其中 8 格标着「选了也可以补充」——
   * 那句话就成了假话。
   */
  const asked: ClarificationItem[] = [];
  for (const item of proposed) {
    asked.push({
      id: item.id,
      question: item.question,
      // 逃逸项排在最后，模型碰不到它。
      options: [...item.options, ESCAPE_OPTION],
    });
    asked.push({
      id: ownFieldId(item.id),
      question: `↑ 上面这题，你自己怎么说？（选了也可以补充；选「${ESCAPE_OPTION}」就必须写）`,
      options: [],
      // 「必须写」由 briefFrom 兑现（选了逃逸项又没写字 = 这题没答），不由客户端 ——
      // 它只会数必填，数不出「B03 选了什么所以 B03x 才必填」这种条件。
      optional: true,
    });
  }

  /*
   * 全局那一格还留着：它管的是**模型压根没问到**的东西，和每题的补充不是一回事。
   * **可以留空** —— 全部用选项答完的人一格字都不用打（用户 2026-07-31 拍板：
   * 「我明明已选了，但它还是让我输入一些我自己的话，这是不对的」）。
   *
   * 它敢留空，是因为它**不再是最后一格**：空文本格吃回车、只有最后一格能提交那两条
   * 实测约束（2026-07-30）现在由压轴那格提交格扛着 —— 一个只有一个选项的选项格，
   * 回车永远有值。第一版在这里选的是「必填」，被用户否掉，见 `CONFIRM_ID` 那段。
   */
  return [...asked, {
    id: FREE_TEXT_ID,
    question: "上面没问到、但你想说的（可以留空）",
    options: [],
    optional: true,
  }, {
    id: CONFIRM_ID,
    question: "确认",
    options: [CONFIRM_OPTION],
  }];
}

/**
 * 人答完之后，那一段就是需求。
 *
 * 问题和答案都留着：只留答案的话，下游读到「团队里的人」根本不知道它在答什么。
 *
 * 返回 null 而不是一段空白 —— **「没答」和「答了但内容为空」是两件事**，让调用方
 * 去决定怎么办。拿一段空白往下走，等于又回到了那份编出来的 PRD。
 */
export function briefFrom(
  items: readonly ClarificationItem[],
  answer: Answer,
): string | null {
  if (answer.action !== "accept") return null;

  const read = (id: string): string => {
    const given = answer.content[id];
    return typeof given === "string" ? given.trim() : "";
  };

  const lines: string[] = [];
  for (const item of items) {
    // 自由文本那些格子由它们的题一起处理，自己不单独成行。
    if (item.options.length === 0 && item.id !== FREE_TEXT_ID) continue;
    // 提交格是门把手，不是回答 —— 「都答完了，提交」写进需求里只是噪音。
    if (item.id === CONFIRM_ID) continue;

    if (item.id === FREE_TEXT_ID) {
      // 补充，不是必答。留空就不出现在需求里。
      const text = read(item.id);
      if (text !== "") lines.push(`- ${item.question}\n  ${text}`);
      continue;
    }

    /*
     * **自己写的优先于选项。**
     *
     * 选项是模型给的备选，自己写的是人的原话 —— 两者冲突时后者说了算，否则那一格
     * 就是装饰。选了某一项又补充了文字，两句都留着：备选说明他大致同意哪一档，
     * 补充说明他到底要什么。
     */
    const chosen = read(item.id);
    const own = read(ownFieldId(item.id));

    if (own !== "") {
      lines.push(chosen === "" || chosen === ESCAPE_OPTION
        ? `- ${item.question}\n  ${own}`
        : `- ${item.question}\n  ${chosen}\n  （他补充：${own}）`);
      continue;
    }
    // 说了「都不对」却什么也没写 —— 这一题等于没答，不许拿一个空的逃逸项充数。
    if (chosen === "" || chosen === ESCAPE_OPTION) return null;
    lines.push(`- ${item.question}\n  ${chosen}`);
  }

  return lines.length === 0 ? null : lines.join("\n");
}
