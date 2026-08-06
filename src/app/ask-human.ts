import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";
import type { Answer, Question, QuestionKind } from "../domain/question";
import { BindingStore } from "../store/binding-store";
import type { QuestionStore } from "../store/question-store";

/**
 * **把一道题交给人，然后等他答。** 三条问人的路（裁决 / 录需求 / 接受风险）
 * 共用的那一段，只此一份。
 *
 * ## 这一层为什么存在
 *
 * BACKLOG §4.1：`handle()` 里**没有一层介于「HTTP 请求」和「domain/store」之间**，
 * 于是每个用例都直接写在 HTTP 分支里 —— 用例没法单独测，换界面等于重写全部用例，
 * 而同一条规则会有好几份手写的拷贝。这个文件是那一层的第一块。
 *
 * ## 它不认识 HTTP
 *
 * 进来的是题和会话，出去的是**答案或者一个说得清的下场**。一个
 * `IncomingMessage` / `ServerResponse` 都不碰 —— 谁把下场翻成 HTTP 是调用者的事。
 */

/**
 * 会话在这一层只需要这四个动作。
 *
 * **故意是结构类型，不是 `PanelSessions`。** 那个类住在 `web/`（L5），这一层在
 * 它下面；照着接口写，这一层就不知道自己被谁用，测试也能塞一个假的进来。
 */
export interface AskSessions {
  /** 往**同一个**会话里打字。另起进程会打掉人眼前正画着的选择器。 */
  type(changeId: string, phase: Phase, line: string): Promise<boolean>;
  /** 那个进程还活着吗。判据是**进程状态**，不是 pty 的输出（PRD §9.3）。 */
  has(changeId: string, phase: Phase): boolean;
}

/**
 * 打进 composer 那一行，叫模型去调 `stagepass_ask`。
 *
 * **必须是一行** —— composer 里一个换行就是提交（`PanelSessions.type`）。
 */
const ASK_TOOL_LINE =
  "调用 stagepass 这个 MCP 服务器的 stagepass_ask 工具一次。**它不收任何参数** ——"
  + "问哪一个由 StagePass 决定。不要替我做决定、不要猜我想选什么，调用完就停下。";

/**
 * 起会话（`launchInto`）时带的提示词：调 `stagepass_ask`、别替人答。
 *
 * 前两句在每个落点一字不差 —— 拷贝必然漂移，而漂移的那一天某条路上的模型会说
 * 「没有这个工具」。后两句跟着这次问的是什么走。多行没关系：这是 argv 的 prompt，
 * 不进 composer（composer 那条路用 `ASK_TOOL_LINE`，一行是它的硬约束）。
 */
export const launchAskPrompt = (hands: string, dont: string): string => [
  "调用 stagepass 这个 MCP 服务器的 stagepass_ask 工具一次。**它不收任何参数** ——",
  "问哪一个由 StagePass 决定。",
  hands,
  dont,
].join("\n");

/**
 * 没答上的两种。**它们要做的事完全不同** —— 一种是人还没去答，另一种是那边的
 * 进程早就没了；原来两种回来的都是同一个空结果。
 */
export type Unanswered = "session_died_before_answering" | "no_answer_in_time";

/** `waitForAnswer` 的下场。没答上时连「为什么」和解药需要的线程 id 一起给出去。 */
export type AnswerWait =
  | { readonly answered: true; readonly answer: Answer }
  | {
    readonly answered: false;
    readonly reason: Unanswered;
    /** 只有进程死了才有 —— 最常见的原因是线程被归档了，而解药要这个 id。 */
    readonly threadId: string | null;
  };

/**
 * 等一道已经问出去的题被答上来。
 *
 * ## 为什么必须只有一份
 *
 * 裁决（`/api/ask`）、录需求（`/api/brief`）、接受风险（`/api/waive`）各自手写过
 * 一遍这个循环，于是同一条规则有四份拷贝，而**治只治了三份**：
 *
 * > 2026-08-03 真机撞到：裁决表挂了 63 分钟（截止 45 分钟），会话被收掉了，而
 * > 那道题在库里还是 `open` —— 一道**没有任何人在等**的题。人这时候开个终端让
 * > 模型调 `stagepass_ask`，就会被端出这道死题；答了还会被 fence 以
 * > `GateMovedError` 拒掉。
 *
 * 裁决和录需求当时都补上了 `settle`，**接受风险那份没有**（2026-08-05 发现）。
 * 四份拷贝里漏掉一份，是这种形状的错误的默认结局 —— 所以这里不是「再补一份」，
 * 是把四份合成一份。
 *
 * ## 两条硬约束
 *
 * - **进程没了就别再等了。** 2026-07-30 实测：阶段绑的线程被 Codex 归档，
 *   `codex resume` 一起来就退，而这里原来只盯答案 —— 对着一个死掉的终端等满 15
 *   分钟，界面上一句话都没有。「在等你选」和「那边早就没了」长得一模一样，正是
 *   这个项目从头到尾在防的那种。
 * - **没答上就把题收掉**，在返回之前。答上了**不收** —— 裁决那条路后面还要
 *   `assertFenceHolds` / `apply` 拿着这道题走闸门，提前收掉就把它抽走了。
 *   要在成功之后也收的（录需求、第二趟追问）自己收，那是它们的事。
 */
export async function waitForAnswer(input: {
  database: Database.Database;
  questions: QuestionStore;
  sessions: AskSessions;
  changeId: string;
  phase: Phase;
  questionId: string;
  timeoutMs: number;
}): Promise<AnswerWait> {
  const { questions, sessions, changeId, phase, questionId } = input;
  const deadline = Date.now() + input.timeoutMs;
  let sessionDied = false;
  while (Date.now() < deadline && !questions.readAnswerFor(questionId)) {
    if (!sessions.has(changeId, phase)) { sessionDied = true; break; }
    await new Promise((resolve) => { setTimeout(resolve, 1_000); });
  }
  const answer = questions.readAnswerFor(questionId);
  if (answer) return { answered: true, answer };
  questions.settle(questionId);
  return {
    answered: false,
    reason: sessionDied ? "session_died_before_answering" : "no_answer_in_time",
    threadId: sessionDied
      ? new BindingStore(input.database).find(changeId, phase)?.threadId ?? null
      : null,
  };
}

/**
 * 第二趟追问：登记、送进**同一个**会话（另起会打掉画着的选择器）、等答案。
 * 返回答案，或一个「没答上」的原因字符串 —— 返回前题已收尾，不留永远 open 的行。
 *
 * 裁决和接受风险的第二趟**除了 `kind` 一个字之外逐字相同**，所以它收两条路，
 * 不是一条路一份。
 */
export async function askFollowUp(input: {
  database: Database.Database;
  questions: QuestionStore;
  sessions: AskSessions;
  changeId: string;
  phase: Phase;
  kind: QuestionKind;
  question: Question;
  questionId: string;
  expectedSnapshot: string;
  timeoutMs: number;
}): Promise<Answer | "session_died_before_asking" | Unanswered> {
  const { questions, changeId, phase, questionId } = input;
  questions.ask({
    id: questionId, changeId, phase, kind: input.kind,
    question: input.question, expectedSnapshot: input.expectedSnapshot,
  });
  if (!await input.sessions.type(changeId, phase, ASK_TOOL_LINE)) {
    questions.settle(questionId);
    return "session_died_before_asking";
  }
  const waited = await waitForAnswer({ ...input });
  if (!waited.answered) return waited.reason;
  // 第二趟的答案没有下一步要拿着这道题走，所以这里就收掉。
  questions.settle(questionId);
  return waited.answer;
}
