import type { ChangeAction } from "./change-state";
import type { Gap, GapResponse } from "./gap";
import type { Gate } from "./gate";

/**
 * A question StagePass puts to the human, and the answer it will accept.
 *
 * ## The shape is StagePass's, always
 *
 * The model never composes a decision. It is handed an opaque id and told to
 * ask it; the wording, the options and the fence all come from here. That is
 * not caution about the model -- it is that the legal options at a gate are a
 * fact only the state machine knows, and a model free to write the option list
 * is free to offer one the pipeline would refuse.
 *
 * ## Options are a JSON Schema enum, not a list of buttons
 *
 * A question becomes an MCP `elicitation/create` request, and the client
 * renders the selector from `requestedSchema`. Measured 2026-07-28 in the Codex
 * TUI: an `enum` renders as a native picker, several properties render as one
 * form answered in a single pass, and a human who declines comes back as
 * `{"action":"cancel"}` with no content.
 *
 * So "the human cannot choose an option that does not exist" is enforced by the
 * client's renderer rather than by StagePass trusting anyone -- which is the
 * strongest version of that rule available.
 *
 * ## This module is pure
 */

export const QUESTION_KINDS = ["gate_decision", "clarification", "waive"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** The field a gate decision's answer arrives under. */
export const DECISION_FIELD = "decision";

export interface RequestedSchema {
  readonly type: "object";
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, {
    readonly type: "string" | "boolean";
    readonly title: string;
    readonly enum?: readonly string[];
  }>>;
}

export interface Question {
  readonly message: string;
  readonly requestedSchema: RequestedSchema;
}

/** 一格。`options` 空 = 自由文本；`optional` = 可以留空。 */
interface Field {
  readonly id: string;
  readonly title: string;
  readonly options?: readonly string[] | undefined;
  readonly optional?: boolean | undefined;
}

export class BadQuestionShapeError extends Error {
  constructor(
    readonly code: "order_not_sorted" | "last_field_unsubmittable",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "BadQuestionShapeError";
  }
}

/**
 * 一批格子变成一次 elicitation。**所有问题都从这里出去，只此一处。**
 *
 * 它挡住两件 2026-07-30 在 Codex TUI 上实测出来的事。两条都是**客户端的行为**，
 * 不是产品选择 —— 所以判据放在这里，而不是靠每个组题的人自己记得。
 *
 * ## 一、显示顺序 = 字段名排序，不是这里的书写顺序
 *
 * 实测：按 `B1, B1x, …, B8, B8x, B0` 写出去，选择器画出来的第一格是 `B0`。
 * 所以要控制顺序只能控制**名字**。这里要求传进来的顺序**已经等于排序后的顺序** ——
 * 不自己悄悄排：那样组题的人写下的顺序和人看到的顺序就永远对不上，而他不会知道。
 *
 * ## 二、最后一格必须能被回车提交
 *
 * 实测：光标停在一个**空的自由文本格**上按回车，屏幕上什么都不发生 —— `optional`
 * 不管用，必填项全答完也不管用，底下写着 `enter to submit all` 也不管用。而整张表
 * 只能从最后一格提交。**所以最后一格是「可留空的自由文本」= 这张表交不上去。**
 *
 * 选项格总有一个高亮着的候选值，回车提交得动；必填的自由文本会把「还差 1 个」显示
 * 出来，人知道该干什么。这两种都行，第三种不行。
 */
function compose(message: string, fields: readonly Field[]): Question {
  const ids = fields.map((field) => field.id);
  const sorted = [...ids].sort();
  if (ids.some((id, index) => id !== sorted[index])) {
    throw new BadQuestionShapeError("order_not_sorted",
      `${ids.join(",")} -> ${sorted.join(",")}`);
  }

  const last = fields[fields.length - 1];
  if (last && (last.options ?? []).length === 0 && last.optional === true) {
    throw new BadQuestionShapeError("last_field_unsubmittable", last.id);
  }

  const properties: Record<string, {
    type: "string"; title: string; enum?: readonly string[];
  }> = {};
  for (const field of fields) {
    const options = field.options ?? [];
    // **选项为空就不发 enum** —— 那是一道自由填写。无条件发 enum 的话，它会变成
    // 一个零个选项的下拉框：人打不开、也填不进去，看着像界面坏了。
    properties[field.id] = options.length === 0
      ? { type: "string", title: field.title }
      : { type: "string", title: field.title, enum: options };
  }
  return {
    message,
    requestedSchema: {
      type: "object",
      required: fields.filter((field) => field.optional !== true)
        .map((field) => field.id),
      properties,
    },
  };
}

/**
 * The elicitation for a settled phase: one field, whose enum is exactly the
 * actions the gate permits right now.
 *
 * Returns null when the gate permits no decision. A question with nothing to
 * choose is worse than no question -- it interrupts someone to show them a
 * decision they cannot make, which is how the tree this replaces produced cards
 * whose every button was refused.
 */
export function gateDecisionQuestion(input: {
  phase: string;
  gate: Gate;
  summary: string;
  /**
   * 这个阶段还开着的问题。给了就一条一道题，和裁决**同一次**问出来。
   *
   * 缺席时行为和加这个参数之前逐字一致 —— 一个 `decision` 字段，别的什么都没有。
   */
  openGaps?: readonly Gap[] | undefined;
}): Question | null {
  // `start`, `settle` and `fail` are the system reporting what happened. Only
  // these three are ever put to a person.
  const decisions: readonly ChangeAction[] = ["approve", "reject", "retry"];
  const offered = decisions.filter((action) => input.gate.permitted.includes(action));
  if (offered.length === 0) return null;

  return compose(`${input.phase}：${input.summary}`, [
    ...responseFields(input.openGaps ?? []),
    // `decision` 排在最后，因为小写 `d` 在 `R` 之后 —— 而它是选项格，所以整张表
    // 提交得动（见 `compose` 的第二条）。**这不是巧合，是挑名字时挑的。**
    { id: DECISION_FIELD, title: "请裁决", options: offered },
  ]);
}

/**
 * 「回应蓝方」那四个选项。
 *
 * 值就是选择器里显示的字，也是回来要匹配的字 —— 中间没有第二张映射表（§5.2b：
 * 选项集合就是 schema 里的 enum）。
 */
export const RESPONSE_AGREE = "同意，红方下轮必须改";
export const RESPONSE_DISMISS = "不同意，这条不成立";
export const RESPONSE_WAIVE = "先接受这个风险";
export const RESPONSE_OWN = "我自己说";

/** 人自己提一个新问题那一格。排在所有 `R0n` 之后、`decision` 之前。 */
const RAISE_FIELD = "RY";

/** 第 n 条 open gap 那一对格子的 id。补零，理由和 `domain/brief.ts` 里那条一样。 */
const responseFieldId = (n: number): string => `R${String(n).padStart(2, "0")}`;

/**
 * 一条 open gap 一道题，形状和录需求那道一样：选项一格，自己写一格。
 *
 * ## 为什么这一步必须存在
 *
 * 用户 2026-07-30 的原话：「⑤ 我决定再来一轮还是接受 —— 路径存在但要两步、词是
 * `reject`、**我说的话没有容器**。」他觉得反方第一条提错了、第二条可以带着走、
 * 第三条必须改 —— 三种意思在这之前只能压成一个 `reject`，而下一轮的红方什么也不
 * 知道。
 *
 * ## 选项之外总有一格自己写
 *
 * 和录需求那道题同一个理由：elicitation 的一个字段有 enum 就是下拉、没有就是自由
 * 输入，**没有「选项 + 或者自己写」那种字段**。所以想让人越过四个选项说话，只能
 * 给第二格。
 */
function responseFields(openGaps: readonly Gap[]): Field[] {
  if (openGaps.length === 0) return [];
  const fields: Field[] = [];
  openGaps.forEach((gap, index) => {
    const id = responseFieldId(index + 1);
    fields.push({
      id,
      title: `${gap.id}　${gap.title}`,
      options: [RESPONSE_AGREE, RESPONSE_DISMISS, RESPONSE_WAIVE, RESPONSE_OWN],
    });
    fields.push({
      id: `${id}x`,
      // 「不同意」和「接受风险」都要落进 resolution，而一次没有理由的关闭和「这一轮
      // 忘了提」在库里长得一模一样（domain/gap.ts 开头）。所以这里把话说明白。
      title: `↑ 这一条你想说什么？（选「${RESPONSE_DISMISS}」`
        + `或「${RESPONSE_WAIVE}」必须写理由，否则这一条留着不动）`,
      optional: true,
    });
  });
  fields.push({
    id: RAISE_FIELD,
    title: "除了上面这些，你自己还要提什么问题？"
      + "（可留空；写了就作为你的要求进下一轮，红方不许当成建议）",
    optional: true,
  });
  return fields;
}

/**
 * 人对每一条 open gap 说了什么。
 *
 * ## 位置对应，而 fence 兜着
 *
 * 第 n 条 gap ↔ `R{nn}`。位置耦合能成立是因为 **gap 名单变了 snapshot 就变了**
 * （`snapshotOf` 哈希 blockers 的 `id`），于是答案在落地之前会被 fence 拒掉 ——
 * 而不是被套到一条他没看见的问题上。
 *
 * ## 认不出来的就跳过，不猜
 *
 * 一个不在四个选项里的值、或者一道压根没有 `R{nn}` 的问题（普通闸门裁决就是），
 * 这里都当成「这一条没表态」。**沉默什么都不改**，和 `domain/gap.ts` 的规矩一致。
 */
export function responsesFrom(input: {
  question: Question;
  answer: Answer;
  openGaps: readonly Gap[];
}): { responses: Record<string, GapResponse>; raised: string } {
  if (input.answer.action !== "accept") return { responses: {}, raised: "" };

  const read = (id: string): string => {
    const given = input.answer.content[id];
    return typeof given === "string" ? given.trim() : "";
  };

  const responses: Record<string, GapResponse> = {};
  input.openGaps.forEach((gap, index) => {
    const id = responseFieldId(index + 1);
    // 这道题里压根没有这一格 —— 那它不是一次「回应蓝方」，什么都不做。
    if (!(id in input.question.requestedSchema.properties)) return;

    const chosen = read(id);
    const own = read(`${id}x`);
    if (chosen === RESPONSE_DISMISS) {
      responses[gap.id] = { kind: "dismiss", reason: own };
      return;
    }
    if (chosen === RESPONSE_WAIVE) {
      responses[gap.id] = { kind: "waive", reason: own };
      return;
    }
    // 「我自己说」等同「同意」：他的文字进下一轮，这一条留着。
    if (chosen === RESPONSE_AGREE || chosen === RESPONSE_OWN) {
      responses[gap.id] = { kind: "agree", note: own };
      return;
    }
    // 认不出来的值：只当他写了字（写了就留着），没写就什么都不做。
    if (own !== "") responses[gap.id] = { kind: "agree", note: own };
  });

  return { responses, raised: read(RAISE_FIELD) };
}

/*
 * 接受风险这道题的两个字段。**两个都必填**，理由见 `waiveQuestion`。
 *
 * 不导出：`waiveQuestion` 和 `waiveFrom` 都在这个文件里，外面拿不到字段名也不需要
 * 拿到 —— 调用方给的是问题和答案，不是字段。（`DECISION_FIELD` 导出是因为插件那
 * 边真的要用它。）
 */
const WAIVE_GAP_FIELD = "gapId";
const WAIVE_REASON_FIELD = "reason";

/**
 * 接受一条已知风险：**哪一条**，以及**为什么可以带着它走**。
 *
 * ## 为什么必须是一道题、两个字段
 *
 * 老树在这里失败过，而且失败得很典型：`waive_spec_p1` 的 schema 要 `gapId`，
 * 但它挂在一张**点一下就完事**的卡片上 —— 一次点击给不出「哪一条」，更给不出
 * 理由。于是那个动作有标签、有 contract 条目、有渲染，**永远执行不了**（§2.3）。
 *
 * elicitation 的表单能一次收多个字段（§5.2b 实测：三个字段含一个布尔一次返回），
 * 所以这道题问得出来。**理由是必填的** —— 「接受风险时必须留下理由」是产品规则，
 * 而一个没有理由的 waive 和「忘了处理」在库里长得一模一样。
 *
 * ## 只有 P1 的 finding 可以被接受
 *
 * P0 不许豁免（严重到不可接受的问题不能靠普通确认绕过）。一条 `standard` 也不许
 * —— 它的出口是撤下那条标准，不是接受风险，两句话不是一回事（见 domain/gap.ts）。
 * 所以候选名单由调用方筛好传进来，这里不猜。
 *
 * 名单为空返回 null：一道没有选项的题比不问更糟，它打断人来展示一个做不了的决定。
 */
export function waiveQuestion(input: {
  phase: string;
  waivable: readonly { id: string; title: string }[];
}): Question | null {
  if (input.waivable.length === 0) return null;

  return compose([
    // 选择器里 enum 显示的是值本身，所以把标题列在正文里 —— 只让人看见一串 id
    // 去选，等于让他凭记忆决定。
    `${input.phase}：接受哪一条风险？`,
    ...input.waivable.map((gap) => `- ${gap.id}　${gap.title}`),
    "",
    "接受它意味着**问题还在**，你决定带着它往下走。这会留在交付说明里。",
  ].join("\n"), [
    // `gapId` < `reason`，而最后那格是必填的自由文本 —— 两条都满足 compose。
    {
      id: WAIVE_GAP_FIELD,
      title: "哪一条",
      options: input.waivable.map((gap) => gap.id),
    },
    { id: WAIVE_REASON_FIELD, title: "为什么可以带着它走" },
  ]);
}

export interface ClarificationItem {
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
  /**
   * 这一格可以留空吗。默认不可以 —— 一道问出去的题默认是要答的。
   *
   * **这不是排版偏好，`required` 在客户端是硬闸门**（2026-07-30 在 Codex TUI 实测）：
   * 选择器右上角写着 `Field 3/17 (17 required unanswered)`，而在还有必填没答的时候
   * 按回车 —— **屏幕上什么都不会发生**，没有报错、没有提示。人只会以为终端卡住了。
   *
   * 所以「可以留空」这句话必须落到 schema 上，否则它是一句假话：批次 A 把每题摊成
   * 两格之后，17 格全进了 `required`，标着「（可以留空）」和「选了也可以补充」的
   * 那 9 格一个都留不了空。
   */
  readonly optional?: boolean;
}

/**
 * The elicitation for a batch of open questions: one field each, all asked and
 * answered in a single pass.
 *
 * Measured, and the reason a batch needs no round trips: three fields including
 * a boolean came back together as
 * `{"action":"accept","content":{"q1":"…","q2":"…","q3":true}}`.
 *
 * **字段的显示顺序不由这里决定 —— 客户端按字段名排序。** 2026-07-30 实测：这里按
 * `B1, B1x, …, B8, B8x, B0` 的顺序写出去，选择器画出来的第一格是 `B0`。所以要让
 * 顺序符合预期，只能让**字段名本身**排出那个顺序（见 `domain/brief.ts`）。
 */
export function clarificationQuestion(input: {
  title: string;
  items: readonly ClarificationItem[];
}): Question | null {
  if (input.items.length === 0) return null;
  return compose(input.title, input.items.map((item) => ({
    id: item.id,
    title: item.question,
    options: item.options,
    optional: item.optional,
  })));
}

export const ANSWER_ACTIONS = ["accept", "decline", "cancel"] as const;
export type AnswerAction = (typeof ANSWER_ACTIONS)[number];

export interface ElicitationResult {
  readonly action?: unknown;
  readonly content?: unknown;
}

export interface Answer {
  readonly action: AnswerAction;
  readonly content: Readonly<Record<string, string | boolean>>;
}

export class UnreadableAnswerError extends Error {
  constructor(readonly code: "answer_action_unknown" | "answer_content_invalid") {
    super(code);
    this.name = "UnreadableAnswerError";
  }
}

/**
 * Read what came back from the client.
 *
 * A decline is a real answer with `action` set and no content -- not an error,
 * not a timeout, not an empty accept. StagePass would mistake all three for
 * something else, and treating a decline as a timeout turns "I will decide
 * later" into "that round was wasted".
 */
export function readAnswer(result: ElicitationResult): Answer {
  const action = result.action;
  if (typeof action !== "string"
    || !(ANSWER_ACTIONS as readonly string[]).includes(action)) {
    throw new UnreadableAnswerError("answer_action_unknown");
  }
  if (action !== "accept") return { action: action as AnswerAction, content: {} };

  const content = result.content;
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    throw new UnreadableAnswerError("answer_content_invalid");
  }
  const read: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(content as Record<string, unknown>)) {
    if (typeof value !== "string" && typeof value !== "boolean") {
      throw new UnreadableAnswerError("answer_content_invalid");
    }
    read[key] = value;
  }
  return { action: "accept", content: read };
}

/**
 * The action a gate decision's answer stands for, or null if it is not one.
 *
 * Checked against the question's own enum rather than against the action list,
 * because the enum is what the human was actually shown. An answer naming
 * something that was not offered is refused here, before it can become a
 * command.
 */
export function decisionFrom(
  question: Question,
  answer: Answer,
): ChangeAction | null {
  if (answer.action !== "accept") return null;
  const offered = question.requestedSchema.properties[DECISION_FIELD]?.enum;
  if (!offered) return null;
  const chosen = answer.content[DECISION_FIELD];
  if (typeof chosen !== "string" || !offered.includes(chosen)) return null;
  return chosen as ChangeAction;
}

/**
 * 一次接受风险的答案：哪一条 + 为什么。不是一次合法的接受就返回 null。
 *
 * 和 `decisionFrom` 一样，**对着问题自己的 enum 校验**，不是对着当前还有哪些 gap
 * —— enum 是人当时真正看见的东西。名单在他想的时候变了，这里就该拒绝，而不是把
 * 他的选择套到一条他没看见的问题上。
 *
 * 理由要求非空：一个没有理由的 waive 和「忘了处理」在库里长得一模一样。
 */
export function waiveFrom(
  question: Question,
  answer: Answer,
): { gapId: string; reason: string } | null {
  if (answer.action !== "accept") return null;
  const offered = question.requestedSchema.properties[WAIVE_GAP_FIELD]?.enum;
  if (!offered) return null;

  const gapId = answer.content[WAIVE_GAP_FIELD];
  const reason = answer.content[WAIVE_REASON_FIELD];
  if (typeof gapId !== "string" || !offered.includes(gapId)) return null;
  if (typeof reason !== "string" || reason.trim() === "") return null;

  return { gapId, reason };
}
