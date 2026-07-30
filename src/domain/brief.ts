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

/** 那道自由填写的 id。StagePass 无条件追加，模型碰不到。 */
export const FREE_TEXT_ID = "B0";

/** 一次最多问几件事。再多没人答得完，而答不完的问卷等于没问。 */
const MAX_ITEMS = 8;

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
    "问题？ | 选项一 | 选项二 | 选项三",
    "```",
    "每个问题**至少要给两个选项** —— 只有一个选项的不是在问。",
    "选项要具体，不要写「其他」：人总能自由补充，那一栏由系统追加。",
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
    if (options.length < 2) {
      // 一个选项不是在问，是在通知。
      throw new BriefProposalVoidError("too_few_options", question.slice(0, 40));
    }
    proposed.push({ id: `B${proposed.length + 1}`, question, options });
  }

  if (proposed.length === 0) {
    throw new BriefProposalVoidError("no_items",
      "模型一条都没提 —— 这和「不需要问」长得一样，不许当成后者");
  }
  if (proposed.length > MAX_ITEMS) {
    throw new BriefProposalVoidError("too_many", String(proposed.length));
  }

  // 无条件追加，排在最后。空 options = 没有 enum = 自由文本。
  return [...proposed, {
    id: FREE_TEXT_ID,
    question: "还有什么必须说清楚的？（可以留空）",
    options: [],
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

  const lines: string[] = [];
  for (const item of items) {
    const given = answer.content[item.id];
    const text = typeof given === "string" ? given.trim() : "";

    if (item.id === FREE_TEXT_ID) {
      // 补充，不是必答。留空就不出现在需求里。
      if (text !== "") lines.push(`- ${item.question}\n  ${text}`);
      continue;
    }
    if (text === "") return null; // 必答的没答
    lines.push(`- ${item.question}\n  ${text}`);
  }

  return lines.length === 0 ? null : lines.join("\n");
}
