import type { Answer, Question, QuestionKind } from "../domain/question";
import type { Phase } from "../domain/phase";
import type { QuestionStore } from "../store/question-store";

/**
 * **问 = 起草，答 = 消费。** 三条问人的路（裁决 / 录需求 / 接受风险）共用的
 * 那一小段，只此一份。
 *
 * ## 这里没有等待
 *
 * 旧形状是一个每秒轮询、15 分钟死线的 HTTP 协程（`waitForAnswer`）—— 那是
 * MCP 信使时代的遗物：会话可能死，所以要有人盯着。C 方案之后题就摆在页面上，
 * 跟会话活不活着没关系，「等」这个动作本身没有了：
 *
 * - 问的那一侧起草完**立刻返回**（`pending`），浏览器把题画出来；
 * - 答的那一侧（`/api/answer`）落完答案**再走一遍同一个用例**，用例从账本里
 *   捡起答案接着往下走 —— 和进程重启后的恢复路径是同一条路。
 *
 * 于是 `no_answer_in_time` / `session_died_before_answering` /
 * `ask_turn_ended_without_answer` 三类下场整类消失：一道没答的题不是失败，
 * 是一道还摆在页面上的题。
 *
 * ## 它不认识 HTTP
 *
 * 进来的是题，出去的是**答案或者「题挂着呢」**。谁把下场翻成 HTTP 是调用者的事。
 */

/**
 * 会话在这一层只剩一个用途：探「上一轮死而复生」（`decide-gate.ts` 的
 * `revivedTurnNote`）。问答本身不再碰会话。
 */
export interface AskSessions {
  /**
   * 按**线程 id** 问：装着这句提示词的那一轮在 App Server history 里跑完了没有。
   * 那条 turn 记着自己当时跑在哪条线程上，而阶段的绑定此后可能已经换了。
   */
  threadTurnEnded?(
    threadId: string,
    fromIndex: number,
    prompt: string,
  ): boolean | Promise<boolean>;
}

/**
 * 起草一道题，或从账本里捡起它的答案。**同步，不等。**
 *
 * 四种此刻：没登记（起草 → 挂着）、open（已经摆在页面上 → 挂着）、
 * answered（把答案给回去）、applied / superseded（当没登记 —— 那道题的一生
 * 已经结束，这是一次新的问）。
 *
 * `settleOnAnswer`：第二趟追问（`-x`）拿到答案就没有下一步要拿着这道题走了，
 * 当场收掉；第一趟不收 —— 裁决后面还要 `assertFenceHolds` / `apply` 拿着它走闸门。
 */
export function draftOrRead(input: {
  questions: QuestionStore;
  changeId: string;
  phase: Phase;
  kind: QuestionKind;
  question: Question;
  questionId: string;
  expectedSnapshot: string;
  settleOnAnswer?: boolean;
}): { readonly kind: "pending" } | { readonly kind: "answered"; readonly answer: Answer } {
  const { questions, questionId } = input;
  let existing = null;
  try { existing = questions.read(questionId); } catch { /* 还没登记。 */ }
  if (existing?.status === "answered") {
    const answer = questions.readAnswerFor(questionId);
    if (answer !== null) {
      if (input.settleOnAnswer === true) questions.settle(questionId);
      return { kind: "answered", answer };
    }
  }
  if (existing === null) {
    questions.ask({
      id: questionId, changeId: input.changeId, phase: input.phase,
      kind: input.kind, question: input.question,
      expectedSnapshot: input.expectedSnapshot,
    });
  }
  // open（刚登记的，或早就摆在页面上的）：挂着，等 /api/answer 再把用例喊回来。
  return { kind: "pending" };
}
