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
  /** 那个会话还有活跃 turn 吗。判据是 App Server 状态，不是渲染文本（PRD §9.3）。 */
  has(changeId: string, phase: Phase): boolean;
  /**
   * 这个阶段绑的线程，App Server 现在返回几条 turn。**认不出线程就说 null** ——
   * 「读不出来」返回 0 会被当成「整个文件都是新的」，那正是 2026-08-08
   * `recordCount` 那个 bug 的形状。
   *
   * 可选：读得到 App Server history 的实现（`PanelSessions`）才有；测试的假会话可以不给，
   * 不给就等于探不了，`waitForAnswer` 退回「答案 + 进程」两个判据。
   */
  recordCount?(
    changeId: string,
    phase: Phase,
  ): number | null | Promise<number | null>;
  /**
   * 从 `fromIndex` 起，**装着这句提示词的那一轮**在 App Server history 里已经跑完了没有。
   * 判据和 transport 认轮一字不差（认提示词，不认「谁先出现」）。
   */
  turnEnded?(
    changeId: string,
    phase: Phase,
    fromIndex: number,
    prompt: string,
  ): boolean | Promise<boolean>;
  /**
   * 同一个判据，按**线程 id** 读会话 —— 「上一轮死而复生」的探测用（那条 turn
   * 记着自己当时跑在哪条线程上，而阶段的绑定此后可能已经换了）。
   */
  threadTurnEnded?(
    threadId: string,
    fromIndex: number,
    prompt: string,
  ): boolean | Promise<boolean>;
}

/**
 * 打进 composer 那一行，叫模型去调 `stagepass_ask`。
 *
 * **必须是一行** —— composer 里一个换行就是提交（`PanelSessions.type`）。
 */
export const ASK_TOOL_LINE =
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
export type Unanswered =
  | "session_died_before_answering"
  | "no_answer_in_time"
  /**
   * ask 那一轮自己结束了，一个答案都没留下 —— 模型抽风（2026-08-09 真机：
   * 一个工具都没调、吐了条空 agent_message 就完了 turn）。人对表单的任何动作
   * （含 Esc）都会落一条答案（`plugin/protocol.ts`），所以这个形状**只可能**是
   * 上游抽风，不可能是人的决定。
   */
  | "ask_turn_ended_without_answer";

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
  /**
   * 把这道题送进会话的**那句话**（argv 的提示词，或打进 composer 的 ask 行）。
   * 给了才开「turn 已死」探测 —— 探测认的就是这句话装在哪一轮里。
   */
  prompt?: string;
  /**
   * 这道题**在浏览器里等人**（C 方案），没往任何会话里送过。
   *
   * 送进过会话的题，会话就是它的命 —— 会话没了，答案永远不会来，所以 `has()` 是
   * 活性判据。而落在库里等人的题**压根没有会话这回事**：再拿 `has()` 判活，
   * 会把每一道题都在第一圈当场判死。
   *
   * 默认 false：老调用方（包括不递 `prompt` 那一种）行为一个字不变。
   */
  waitsInBrowser?: boolean;
  /**
   * 补问时打进 composer 的那一行。默认 `ASK_TOOL_LINE`；录需求要递自己那句 ——
   * 两句调的是同一个工具，但措辞对着不同的事，混用会让模型收到一句不对题的指令
   * （`record-brief.ts` 顶上的理由）。**必须是一行**：composer 里换行就是提交。
   */
  retypeLine?: string;
}): Promise<AnswerWait> {
  const { questions, sessions, changeId, phase, questionId } = input;
  const deadline = Date.now() + input.timeoutMs;
  let reason: Unanswered = "no_answer_in_time";
  /*
   * **「turn 结束了而题没答」是第三种死法**，前两个判据都看不见它：进程活着
   * （会话仍可恢复），答案永远不会来（人对表单的任何动作都会落答案，所以没答案
   * = 模型压根没把题端给人）。2026-08-09 真机：模型一个工具都没调、吐了条空话
   * 就完了 turn，人对着静止的 composer 干等了 12 分钟。
   *
   * 治法和 transport 的「补一下回车」同一个形状，三重闸：那一轮**确实结束**
   * （App Server turn 已结束）、答案**确实没有**、只补一次。补的那句是
   * `ASK_TOOL_LINE` —— 新的一轮，探测的起点和认的话都要跟着换。
   */
  let needle = input.prompt ?? null;
  let from = needle !== null
    ? await sessions.recordCount?.(changeId, phase) ?? null
    : null;
  // 见 `waitsInBrowser` 那条注释。默认仍是「会话就是这道题的命」，老调用方一个字不用改。
  const relayed = input.waitsInBrowser !== true;
  let retyped = false;
  while (Date.now() < deadline && !questions.readAnswerFor(questionId)) {
    if (relayed && !sessions.has(changeId, phase)) {
      reason = "session_died_before_answering";
      break;
    }
    if (from !== null && needle !== null
      && await sessions.turnEnded?.(changeId, phase, from, needle) === true
      // 答案和 task_complete 之间隔着模型收尾的那几秒，但还是再看一眼 —— 有了
      // 答案就不该补，多打的那一轮只会白白弹一次「此刻没有在等任何问题」。
      && !questions.readAnswerFor(questionId)) {
      if (retyped) {
        reason = "ask_turn_ended_without_answer";
        break;
      }
      retyped = true;
      const line = input.retypeLine ?? ASK_TOOL_LINE;
      // 起点先取、再打字：打进去的那句话之后的记录才算新一轮的。
      from = await sessions.recordCount?.(changeId, phase) ?? from;
      needle = line;
      if (!await sessions.type(changeId, phase, line)) {
        reason = "session_died_before_answering";
        break;
      }
    }
    await new Promise((resolve) => { setTimeout(resolve, 1_000); });
  }
  const answer = questions.readAnswerFor(questionId);
  if (answer) return { answered: true, answer };
  questions.settle(questionId);
  // 「没答上」也是下场，必须留得住（§3.2·5）—— `applied` + 空下场和一次正常
  // 落地在库里长得一模一样，事后谁也说不清这道题发生过什么。
  questions.recordOutcome(questionId, { kind: "unanswered", reason });
  return {
    answered: false,
    reason,
    threadId: reason === "session_died_before_answering"
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
  /** 这一趟也在浏览器里答（C 方案）：不往会话里打字，也不拿会话判活。 */
  waitsInBrowser?: boolean;
}): Promise<Answer | "session_died_before_asking" | Unanswered> {
  const { questions, changeId, phase, questionId } = input;
  let existing = null;
  try { existing = questions.read(questionId); } catch { /* 还没登记。 */ }
  if (existing?.status === "answered") {
    const answer = questions.readAnswerFor(questionId);
    if (answer !== null) {
      questions.settle(questionId);
      return answer;
    }
  }
  if (existing === null) {
    questions.ask({
      id: questionId, changeId, phase, kind: input.kind,
      question: input.question, expectedSnapshot: input.expectedSnapshot,
    });
  }
  /*
   * 浏览器那条路上第二趟和第一趟一样：题登记完就摆在页面上，没有谁要被打字唤醒。
   * 往一个不存在的会话里打字只会得到一个假的 `session_died_before_asking`。
   */
  if (input.waitsInBrowser !== true) {
    if (!await input.sessions.type(changeId, phase, ASK_TOOL_LINE)) {
      questions.settle(questionId);
      questions.recordOutcome(questionId,
        { kind: "unanswered", reason: "session_died_before_asking" });
      return "session_died_before_asking";
    }
  }
  // 第二趟是打进 composer 的那句 ask 行送出去的 —— 探测认它。
  const waited = input.waitsInBrowser === true
    ? await waitForAnswer({ ...input, waitsInBrowser: true })
    : await waitForAnswer({ ...input, prompt: ASK_TOOL_LINE });
  if (!waited.answered) return waited.reason;
  // 第二趟的答案没有下一步要拿着这道题走，所以这里就收掉。
  questions.settle(questionId);
  return waited.answer;
}
