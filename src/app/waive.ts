import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";
import { GateMovedError } from "../domain/gate";
import { waiveQuestion, waiveFrom, waiveFollowUpQuestion } from "../domain/question";
import { roundFromLedger } from "../domain/round";
import { ChangeStore } from "../store/change-store";
import { CommandStore } from "../store/command-store";
import { GapStore } from "../store/gap-store";
import { QuestionStore } from "../store/question-store";
import {
  askFollowUp, launchAskPrompt, waitForAnswer, type AskSessions, type Unanswered,
} from "./ask-human";

/**
 * **接受一条已知风险**这个用例 —— 从 `handle()` 的 HTTP 分支里搬出来（BACKLOG §4.1·J）。
 *
 * 接受意味着**问题还在**，只是不再挡闸门。所以这里没有「批准」也没有「驳回」：
 * 那两个只能走裁决那道题（PRD §1.1 —— 改标准可以在网页上，裁决不行）。
 *
 * ## 它不认识 HTTP
 *
 * 出去的是一个 `WaiveOutcome`，不是一个写好的响应。**404 也是一种下场**，不是
 * 这一层的动作 —— 谁把下场翻成状态码是 `web/` 的事。这正是「用例能单独测」的
 * 全部含义。
 */

/**
 * 起一个新会话去问人，带上这次要说的提示词。**会话怎么起是 `web/` 那层的事** ——
 * 这一层不知道 argv、不知道插件怎么注册，也就不会被那些细节绑住。
 */
export type LaunchAsk = (input: { phase: Phase; prompt: string }) => void;

export type WaiveOutcome =
  /** 没有这个 Change。调用者翻成 404。 */
  | { readonly kind: "no_such_change" }
  /** 现在不能问（阶段在跑，或者那个终端还开着）。 */
  | {
    readonly kind: "busy";
    readonly phase: Phase;
    readonly busy: { readonly reason: string; readonly busy: string; readonly jobId?: string };
  }
  /** 一条可接受的都没有 —— 一道没有选项的题比不问更糟（`domain/question.ts`）。 */
  | { readonly kind: "nothing_waivable"; readonly phase: Phase }
  /** 问出去了，但没答上来。 */
  | {
    readonly kind: "unanswered";
    readonly phase: Phase;
    readonly questionId: string;
    readonly reason: Unanswered | "session_died_before_asking";
    readonly threadId: string | null;
  }
  /** 答了，但一条都没接受（没选、按了 Esc、或者理由留空）。 */
  | { readonly kind: "none_accepted"; readonly phase: Phase; readonly questionId: string }
  /** 他看见的那份证据在他想的时候被人动过了。 */
  | { readonly kind: "gate_moved"; readonly phase: Phase; readonly questionId: string }
  /** 接了，几条都落库了。 */
  | {
    readonly kind: "waived";
    readonly phase: Phase;
    readonly questionId: string;
    /** 真的接下来了的那几条。 */
    readonly gapIds: readonly string[];
    /**
     * 想接却没接成的（在他答题的那十几分钟里被别处关掉了之类）。
     * **人已经答完走了** —— 他以为四条都接了，少接一条这件事必须有人告诉他。
     */
    readonly refused?: readonly { readonly id: string; readonly why: string }[];
  };

/** 问完人之后要不要把那个会话关掉 —— 见每个返回点上的理由。 */
export interface WaiveResult {
  readonly outcome: WaiveOutcome;
  /**
   * **放弃了就把会话关掉。** 留着它，`sessions.has()` 永远真，这个阶段的每一个
   * 动作都被闸门拒掉，而界面上没有杀掉终端的入口 —— 2026-08-03 现场复现过这个
   * 死锁。关掉是安全的：这条路已经决定不等了，那个进程再没有人会去读它。
   */
  readonly closeSession: boolean;
}

export async function waive(input: {
  database: Database.Database;
  sessions: AskSessions;
  changeId: string;
  /** 现在能不能问人。判据在 `web/` 那层（它要看活进程和账本），这里只消费结论。 */
  cannotAskNow: (phase: Phase) =>
    { reason: string; busy: string; jobId?: string } | null;
  launch: LaunchAsk;
  timeoutMs: number;
}): Promise<WaiveResult> {
  const { database, sessions, changeId } = input;
  const changes = new ChangeStore(database);
  let phase: Phase;
  try {
    phase = changes.read(changeId).state.phase;
  } catch {
    return { outcome: { kind: "no_such_change" }, closeSession: false };
  }

  const busy = input.cannotAskNow(phase);
  if (busy) return { outcome: { kind: "busy", phase, busy }, closeSession: false };

  const gaps = new GapStore(database);
  const waivable = gaps.all(changeId, phase).filter((gap) =>
    gap.status === "open" && gap.kind === "finding" && gap.severity === "P1");
  // round：标题上「第几轮提的」的分母 —— 和派发、裁决同一份算法。
  const question = waiveQuestion({
    phase, waivable, round: roundFromLedger(changes.ledger(changeId), phase),
  });
  if (!question) {
    return { outcome: { kind: "nothing_waivable", phase }, closeSession: false };
  }

  const gate = new CommandStore(database).gateFor(changeId);
  const questionId = `W-${changeId}-${phase}-${Date.now()}`;
  const questions = new QuestionStore(database);
  questions.ask({
    id: questionId, changeId, phase, kind: "waive",
    question, expectedSnapshot: gate.snapshot,
  });

  input.launch({
    phase,
    prompt: launchAskPrompt("它会把「哪几条风险可以带着走」交给我来选。",
      "不要替我做决定，不要评价这些风险，调用完就停下。"),
  });

  const waited = await waitForAnswer({
    database, questions, sessions, changeId, phase, questionId,
    timeoutMs: input.timeoutMs,
  });
  if (!waited.answered) {
    /*
     * **这条路原来漏了 `settle`。** 裁决和录需求都补过（2026-08-03 那次 63 分钟的
     * 死题），这第四份拷贝没有 —— 现在收题在 `waitForAnswer` 里，只此一份。
     */
    return {
      outcome: {
        kind: "unanswered", phase, questionId,
        reason: waited.reason, threadId: waited.threadId,
      },
      closeSession: true,
    };
  }
  const answer = waited.answer;

  /*
   * **第二趟：只问真被接受的那几条要理由。**
   *
   * 第一趟纯选项格（客户端空文本格吃回车），和裁决表、录需求那两张表同一个形状。
   * 一条都没接受就不弹 —— 全点「不接受」的人一个字都不用打。
   */
  let full = answer;
  const moreWaive = waiveFollowUpQuestion(waivable, answer);
  if (moreWaive) {
    const second = await askFollowUp({
      database, questions, sessions, changeId, phase, question: moreWaive,
      kind: "waive",
      questionId: `${questionId}-x`, expectedSnapshot: gate.snapshot,
      timeoutMs: input.timeoutMs,
    });
    if (typeof second === "string") {
      return {
        outcome: {
          kind: "unanswered", phase, questionId, reason: second, threadId: null,
        },
        closeSession: true,
      };
    }
    full = { action: answer.action, content: { ...answer.content, ...second.content } };
  }

  const accepted = waiveFrom(waivable, full);
  if (accepted.length === 0) {
    // 人一条都没选、按了 Esc、或者理由留空。三种都不是「接受了」。
    questions.settle(questionId);
    return { outcome: { kind: "none_accepted", phase, questionId }, closeSession: false };
  }

  /*
   * fence：人想了多久是他的事，但他的决定必须落在他看见过的那份证据上。
   *
   * 裁决那条路由 `questions.apply()` 把 fence 交给 command 层查；接受风险不推动
   * 状态机、没有 command 可走，所以这里显式查一次。少了它，这条防线就只覆盖一半
   * 的答案。
   */
  try {
    questions.assertFenceHolds(questionId);
  } catch (error: unknown) {
    if (!(error instanceof GateMovedError)) throw error;
    questions.settle(questionId);
    return { outcome: { kind: "gate_moved", phase, questionId }, closeSession: false };
  }

  /*
   * 一次能接多条 —— 用户 2026-08-04：接四条不该走四遍完整流程。
   *
   * **逐条兜住，而且无论如何都要把题收掉。** `accepted` 是 15 分钟前那一刻的
   * 名单快照（人还要经过两趟选择器），而 `GapStore.waive` 重新读的是现在：中间
   * 有一条被别处关掉了，它就抛 `unknown_gap`。原来那个循环裸奔，于是第 k 条抛
   * 出去时前 k-1 条已经豁免了、题永远停在 `answered`、浏览器拿到一个 500 ——
   * 和 2026-08-07 裁决那条路上栽的是同一个形状。
   *
   * 落不下去的逐条报上去（`refused`），因为**人已经答完走了**：他以为四条都接了，
   * 而实际只接了三条，这件事必须有人告诉他。
   */
  const waived: string[] = [];
  const refused: { id: string; why: string }[] = [];
  for (const each of accepted) {
    try {
      gaps.waive(changeId, phase, each.gapId, each.reason);
      waived.push(each.gapId);
    } catch (error: unknown) {
      refused.push({
        id: each.gapId,
        why: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }
  questions.settle(questionId);
  return {
    outcome: {
      kind: "waived", phase, questionId, gapIds: waived,
      ...(refused.length === 0 ? {} : { refused }),
    },
    closeSession: false,
  };
}
