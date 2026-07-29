import type { ChangeAction } from "./change-state";
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
}): Question | null {
  // `start`, `settle` and `fail` are the system reporting what happened. Only
  // these three are ever put to a person.
  const decisions: readonly ChangeAction[] = ["approve", "reject", "retry"];
  const offered = decisions.filter((action) => input.gate.permitted.includes(action));
  if (offered.length === 0) return null;

  return {
    message: `${input.phase}：${input.summary}`,
    requestedSchema: {
      type: "object",
      required: [DECISION_FIELD],
      properties: {
        [DECISION_FIELD]: {
          type: "string",
          title: "请裁决",
          enum: offered,
        },
      },
    },
  };
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

  return {
    // 选择器里 enum 显示的是值本身，所以把标题列在正文里 —— 只让人看见一串 id
    // 去选，等于让他凭记忆决定。
    message: [
      `${input.phase}：接受哪一条风险？`,
      ...input.waivable.map((gap) => `- ${gap.id}　${gap.title}`),
      "",
      "接受它意味着**问题还在**，你决定带着它往下走。这会留在交付说明里。",
    ].join("\n"),
    requestedSchema: {
      type: "object",
      required: [WAIVE_GAP_FIELD, WAIVE_REASON_FIELD],
      properties: {
        [WAIVE_GAP_FIELD]: {
          type: "string",
          title: "哪一条",
          enum: input.waivable.map((gap) => gap.id),
        },
        [WAIVE_REASON_FIELD]: {
          type: "string",
          title: "为什么可以带着它走",
        },
      },
    },
  };
}

export interface ClarificationItem {
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
}

/**
 * The elicitation for a batch of open questions: one field each, all asked and
 * answered in a single pass.
 *
 * Measured, and the reason a batch needs no round trips: three fields including
 * a boolean came back together as
 * `{"action":"accept","content":{"q1":"…","q2":"…","q3":true}}`.
 */
export function clarificationQuestion(input: {
  title: string;
  items: readonly ClarificationItem[];
}): Question | null {
  if (input.items.length === 0) return null;
  const properties: Record<string, {
    type: "string"; title: string; enum: readonly string[];
  }> = {};
  for (const item of input.items) {
    properties[item.id] = {
      type: "string",
      title: item.question,
      enum: item.options,
    };
  }
  return {
    message: input.title,
    requestedSchema: {
      type: "object",
      required: input.items.map((item) => item.id),
      properties,
    },
  };
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
