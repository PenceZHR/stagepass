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

export const QUESTION_KINDS = ["gate_decision", "clarification"] as const;
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
