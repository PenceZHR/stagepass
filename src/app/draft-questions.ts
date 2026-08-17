import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";
import { DRAFTED_OPTIONS, draftedQuestions } from "../domain/question";
import {
  QUESTION_SHAPE,
  slotContract,
  type SlotHeader,
} from "../domain/round-slots";
import type { SlotFiles } from "../system/slot-files";
import type { QuestionStore } from "../store/question-store";

/**
 * 模型起草一批问题，落进账本，等人在浏览器里答。
 *
 * ## 和旧路的差别
 *
 * 旧路要模型**挂着一轮**把表单端给人（MCP elicitation），于是有两种死法：
 * `session_died_before_answering`（会话没了）和 `ask_turn_ended_without_answer`
 * （它一个工具都没调就结束了 turn，人对着静止的选择器干等）。两条都是 2026 年
 * 8 月真机撞出来的。
 *
 * 现在模型只是把问题填进格子文件，然后结束这一轮。题落进库里等人，**人什么时候
 * 答都行** —— 没有谁需要挂着，那两种死法整类消失。
 */
export interface DraftQuestionsInput {
  readonly database: Database.Database;
  readonly questions: QuestionStore;
  readonly files: SlotFiles;
  readonly changeId: string;
  readonly phase: Phase;
  readonly round: number;
  /**
   * 把这一轮跑出去。收到的是完整题面（里面带着格子文件的路径和规矩）。
   *
   * 它**不需要**返回什么 —— 这一轮说了什么不算数，算数的只有文件里填了什么。
   * 这正是格子文件的意义：产出不再从自由文本里捞。
   */
  readonly runTurn: (prompt: string) => Promise<void>;
  /** 题面里除了格子契约还要说的话（阶段自己的那部分）。 */
  readonly preamble?: string;
  /**
   * 落题时钉住的状态快照。答案在落地之前会拿它对一次 —— 中途状态变了就该被拒。
   * **由调用方算**（和 `askFollowUp` 同一个形状）：这一层不认识闸门。
   */
  readonly expectedSnapshot: string;
}

export type DraftQuestionsResult =
  | { readonly ok: true; readonly questionId: string | null }
  | { readonly ok: false; readonly reason: string };

export async function draftQuestions(
  input: DraftQuestionsInput,
): Promise<DraftQuestionsResult> {
  const header: SlotHeader = {
    changeId: input.changeId,
    phase: input.phase,
    round: input.round,
    // 起草问题的是反方那一侧的座位；红蓝各一份，抬头里认得出来。
    role: "blue",
    shape: QUESTION_SHAPE,
    // 起草问题这一轮不产出文档，所以没有要预填的产出路径。
    artifacts: [],
    options: [...DRAFTED_OPTIONS],
  };

  const path = input.files.lay(header);
  await input.runTurn([
    ...(input.preamble === undefined ? [] : [input.preamble]),
    slotContract(path, QUESTION_SHAPE),
  ].join("\n\n"));

  const collected = input.files.collect(header);
  if (!collected.ok) return { ok: false, reason: collected.reason };

  const question = draftedQuestions({ phase: input.phase, drafted: collected.filled });
  if (question === null) {
    // 一个字都没填是合法状态。不凭空造一道题出来。
    input.files.discard(header);
    return { ok: true, questionId: null };
  }

  const questionId = `Q-${input.changeId}-${input.phase}-r${input.round}`;
  input.questions.ask({
    id: questionId,
    changeId: input.changeId,
    phase: input.phase,
    kind: "clarification",
    question,
    expectedSnapshot: input.expectedSnapshot,
  });
  input.files.discard(header);
  return { ok: true, questionId };
}
