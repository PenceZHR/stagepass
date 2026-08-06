import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";
import {
  briefContract, readBriefProposal, briefFrom, followUpFields, BriefProposalVoidError,
} from "../domain/brief";
import {
  clarificationQuestion, type Answer, type ClarificationItem,
} from "../domain/question";
import { ChangeStore } from "../store/change-store";
import { CommandStore } from "../store/command-store";
import { QuestionStore } from "../store/question-store";
import { waitForAnswer, type AskSessions, type Unanswered } from "./ask-human";

/**
 * **把「这次改动要什么」问出来**这个用例 —— 从 `handle()` 的 HTTP 分支里搬出来
 * （BACKLOG §4.1·J）。
 *
 * 两步：先让模型读仓库提问题（一次普通 turn，不用对抗轮 —— 提问题不需要有人
 * 反驳它，而一轮对抗要好几分钟），再把它组成题问人。
 *
 * ## 它不认识 HTTP，也不认识 Codex
 *
 * 「跑一次 turn」和「起一个会话」都是**注进来的**（`propose`）。这一层因此能在
 * 没有 Codex 的情况下整条跑完 —— 而它是这条路唯一能被单独验的方式。
 */

/**
 * 打进 composer 那一行，叫模型去调 `stagepass_ask`。
 *
 * **和 `ask-human.ts` 里那一行不是同一句**，两边说的不是同一件事：那边是「问哪
 * 一个由 StagePass 决定」（裁决 / 接受风险），这边是「把这次改动要什么交给我来
 * 答」。合成一句会让其中一条路的模型收到一句不对题的指令。
 *
 * **必须是一行** —— composer 里一个换行就是提交。
 */
const BRIEF_ASK_LINE =
  "调用 stagepass 这个 MCP 服务器的 stagepass_ask 工具一次。**它不收任何参数**。"
  + "它会把「这次改动要什么」交给我来答。不要替我回答，不要猜我想要什么，调用完就停下。";

/**
 * 跑一次普通 turn 让模型读仓库、提问题，回它说的那段话。
 *
 * **会话怎么起、超时多少、插件怎么注册，全在 `web/` 那层。** 这一层只知道
 * 「给它这段合同，它会说点什么回来」。
 */
export type ProposeBrief = (prompt: string) => Promise<string>;

export type BriefOutcome =
  /** 没有这个 Change。调用者翻成 404。 */
  | { readonly kind: "no_such_change" }
  /** 现在不能问（阶段在跑，或者那个终端还开着）。 */
  | {
    readonly kind: "busy";
    readonly phase: Phase;
    readonly busy: { readonly reason: string; readonly busy: string; readonly jobId?: string };
  }
  /**
   * 模型一条都没提、或者提得不成形。**不许降级成「不需要问」** —— 那样需求录入
   * 就被静默跳过了，而下游那份 PRD 仍然会生成出来，看着一切正常。
   */
  | {
    readonly kind: "proposal_failed";
    readonly phase: Phase;
    readonly reason: string;
    readonly detail: string;
  }
  /** 会话在问出去之前就死了。**不许假装问出去了** —— 题落了库，人却永远看不到。 */
  | { readonly kind: "not_asked"; readonly phase: Phase }
  /** 问出去了，但没答上来。 */
  | {
    readonly kind: "unanswered";
    readonly phase: Phase;
    readonly questionId: string;
    readonly reason: Unanswered;
    readonly threadId: string | null;
  }
  /** 答了，但答不出一份需求（按了 Esc，或者必答的没答完）。 */
  | { readonly kind: "not_recorded"; readonly phase: Phase }
  /** 录进去了。 */
  | { readonly kind: "recorded"; readonly phase: Phase; readonly brief: string };

export interface BriefResult {
  readonly outcome: BriefOutcome;
  /**
   * 要不要把那个会话关掉。**两种情况都要关，但理由不同**：
   *
   * - 放弃了要关 —— 留着它 `sessions.has()` 永远真，这个阶段的每一个动作都被闸门
   *   拒掉，而界面上没有杀掉终端的入口（2026-08-03 现场复现过这个死锁：录需求说
   *   「阶段在跑」，跑阶段说「还没有需求」，而挡着的是 StagePass 自己忘了关的僵尸）。
   * - 办完了也要关 —— 不关它一直 `live`，§6.5 规则 5 会挡住下一次派发，
   *   「跑这个阶段」永远是灰的（2026-07-30 实测到这个死角）。
   *
   * **中途关和办完关是两件事**，别合并：中途关会掐断浏览器正在读的流，让人看不见
   * 选择器。所以「什么时候关」由下场决定，不是每条路都关。
   */
  readonly closeSession: boolean;
}

export async function recordBrief(input: {
  database: Database.Database;
  sessions: AskSessions;
  changeId: string;
  /** 现在能不能问人。判据在 `web/` 那层（它要看活进程和账本），这里只消费结论。 */
  cannotAskNow: (phase: Phase) =>
    { reason: string; busy: string; jobId?: string } | null;
  propose: ProposeBrief;
  timeoutMs: number;
}): Promise<BriefResult> {
  const { database, sessions, changeId } = input;
  const changes = new ChangeStore(database);
  let change: { title: string | null; state: { phase: Phase } };
  try {
    change = changes.read(changeId);
  } catch {
    return { outcome: { kind: "no_such_change" }, closeSession: false };
  }
  const phase = change.state.phase;

  const busy = input.cannotAskNow(phase);
  if (busy) return { outcome: { kind: "busy", phase, busy }, closeSession: false };

  // 第一步：让模型读仓库，提问题。
  let items: readonly ClarificationItem[];
  try {
    items = readBriefProposal(await input.propose(briefContract({
      changeTitle: change.title,
    })));
  } catch (error: unknown) {
    return {
      outcome: {
        kind: "proposal_failed", phase,
        reason: error instanceof BriefProposalVoidError ? error.code : "proposal_failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      closeSession: false,
    };
  }

  /*
   * 第二步：把它组成题问人。**两趟。**
   *
   * 第一趟纯选项格，一路回车就答得完；只有点了「都不对，我自己写」的那几题，才有
   * 第二趟给他写字（`followUpFields`）。全用选项答完的人一个字都不用打。
   *
   * 为什么非分两趟不可：客户端**空的自由文本格会吃掉回车**，`optional` 不管用
   * （2026-07-30 实测）。所以「选了就不用打字」只有在第一趟里根本没有文本格时才
   * 是真的 —— 用户 2026-08-03 明确要求过这件事。
   */
  const gate = new CommandStore(database).gateFor(changeId);
  const questions = new QuestionStore(database);

  /** 问一趟，等人答完。答上了给答案，没走通给一个说得清的下场。 */
  const askOnce = async (
    fields: readonly ClarificationItem[], title: string,
  ): Promise<Answer | BriefResult> => {
    const question = clarificationQuestion({ title, items: fields })!;
    const questionId = `BR-${changeId}-${Date.now()}`;
    questions.ask({
      id: questionId, changeId, phase, kind: "clarification",
      question, expectedSnapshot: gate.snapshot,
    });

    /*
     * **打进同一个会话，不另起进程。** 完整理由在 `PanelSessions.type` 那段注释里，
     * 两句话：`launchInto` 会把活着会话的 argv 丢掉；`close` 再起会掐断浏览器正在
     * 读的流。两条都踩过。
     */
    if (!await sessions.type(changeId, phase, BRIEF_ASK_LINE)) {
      // 会话在这中间死了。**不许假装问出去了** —— 题已经落库，人却永远看不到它。
      questions.settle(questionId);
      return { outcome: { kind: "not_asked", phase }, closeSession: false };
    }

    const waited = await waitForAnswer({
      database, questions, sessions, changeId, phase, questionId,
      timeoutMs: input.timeoutMs,
    });
    if (!waited.answered) {
      // 题已经被 waitForAnswer 收掉了。
      return {
        outcome: {
          kind: "unanswered", phase, questionId,
          reason: waited.reason, threadId: waited.threadId,
        },
        closeSession: true,
      };
    }
    // 录需求拿到答案就用完了，没有下一步要拿着这道题走 —— 收掉。
    questions.settle(questionId);
    return waited.answer;
  };

  const first = await askOnce(items, `${changeId}：先把这次改动要什么说清楚`);
  if ("outcome" in first) return first;

  /*
   * 第二趟只在真有人要写字的时候才弹。**一条都没有就不弹** —— 「全用选项答完的人
   * 一个字都不用打」如果还要他再点一次「提交」，那句话就打了折。
   */
  const more = followUpFields(items, first);
  let content = first.content;
  if (more.length > 0) {
    const second = await askOnce(more, `${changeId}：你说要自己写的那几条`);
    if ("outcome" in second) return second;
    content = { ...content, ...second.content };
  }

  const brief = briefFrom(items, { action: first.action, content });
  if (brief === null) {
    // 按了 Esc，或者必答的没答完。**不拿一段空白往下走** —— 那等于又回到那份
    // 编出来的 PRD。
    return { outcome: { kind: "not_recorded", phase }, closeSession: true };
  }
  changes.setBrief(changeId, brief);
  return { outcome: { kind: "recorded", phase, brief }, closeSession: true };
}
