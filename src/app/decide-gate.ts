import type Database from "better-sqlite3";

import { upstreamOf, type Phase } from "../domain/phase";
import { GateMovedError, GateRefusedError } from "../domain/gate";
import type { GapResponse } from "../domain/gap";
import {
  gateDecisionQuestion, responseFollowUpQuestion, responsesFrom, runsAgainHere,
  DECISION_FIELD, sendBackReasonFrom, type Answer,
} from "../domain/question";
import { roundFromLedger, summariseConvergence, summariseRoundNotes } from "../domain/round";
import { summariseAssessments } from "../domain/rubric";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { CommandStore } from "../store/command-store";
import { GapStore } from "../store/gap-store";
import { QuestionStore } from "../store/question-store";
import { RoundNoteStore } from "../store/round-note-store";
import { RubricStore } from "../store/rubric-store";
import {
  askFollowUp, launchAskPrompt, waitForAnswer, type AskSessions, type Unanswered,
} from "./ask-human";

/**
 * **把这一轮的裁决交给人**这个用例 —— 从 `handle()` 的 HTTP 分支里搬出来
 * （BACKLOG §4.1·J）。三条问人的路里最绕的一条。
 *
 * 它同时做四件事，而**顺序是承重的**（见下面那段「三步」）：把闸门状态和这一轮
 * 的判定组成一道题、等人选、把他对每条问题的表态落库、再推闸门。
 *
 * ## 这里没有第二条能推动闸门的路
 *
 * 表态只改 gaps；推动状态机的仍然只有 `decision` 那一格，走 `questions.apply`
 * （§5.3）。网页上永远不会有 approve / reject 的按钮（PRD §1.1）。
 */

export type DecideOutcome =
  /** 没有这个 Change。调用者翻成 404。 */
  | { readonly kind: "no_such_change" }
  /** 现在不能问（阶段在跑，或者那个终端还开着）。 */
  | {
    readonly kind: "busy";
    readonly phase: Phase;
    readonly busy: { readonly reason: string; readonly busy: string; readonly jobId?: string };
  }
  /**
   * 组不出一道他做得了的题。**一道做不了的决定比不问更糟**
   * （`domain/question.ts`）。
   */
  | { readonly kind: "no_decision"; readonly phase: Phase }
  /** 问出去了，但没答上来。 */
  | {
    readonly kind: "unanswered";
    readonly phase: Phase;
    readonly questionId: string;
    readonly reason: Unanswered | "session_died_before_asking";
    readonly threadId: string | null;
  }
  /** 他看见的那份证据在他想的时候被人动过了 —— 决定不落地。 */
  | {
    readonly kind: "gate_moved";
    readonly phase: Phase;
    readonly questionId: string;
    readonly answer: Answer;
  }
  /** 答案落地了。`outcome` 里装着闸门的下场（推进了、还是被拒了）。 */
  | {
    readonly kind: "decided";
    readonly phase: Phase;
    readonly questionId: string;
    readonly answer: Answer;
    /** 每一条表态落地了没有，没落地的说清是为什么 —— 人已经走了，不许静默丢掉。 */
    readonly responses: Readonly<Record<string, GapResponse>>;
    readonly refused: readonly { id: string; code: string }[];
    readonly raised: string | null;
    readonly outcome: unknown;
    /** 续跑了没有，以及那一轮的结果。null = 这次裁决不是「再来一轮」。 */
    readonly continued: unknown;
    readonly state: unknown;
  };

export interface DecideResult {
  readonly outcome: DecideOutcome;
  /** 放弃了就把会话关掉 —— 理由和录需求那条一样（见 `record-brief.ts`）。 */
  readonly closeSession: boolean;
}

export async function decideGate(input: {
  database: Database.Database;
  sessions: AskSessions;
  changeId: string;
  /** 现在能不能问人。判据在 `web/` 那层（它要看活进程和账本），这里只消费结论。 */
  cannotAskNow: (phase: Phase) =>
    { reason: string; busy: string; jobId?: string } | null;
  launch: (input: { phase: Phase; prompt: string }) => void;
  /**
   * 「再来一轮」时续跑那一轮。**先关会话再跑** —— 那个阶段的终端这时还活着
   * （题就是送进去的），不关 `runRound` 会撞上 §6.5 规则 5 直接拒。这不是绕过
   * 那条规则：那一轮的活干完了，它只是坐在 composer 上没事干。
   */
  rerun: (phase: Phase) => Promise<unknown>;
  /**
   * 批准之后归档这个阶段的线程（用户 2026-07-30 拍板的那一半）。
   *
   * **只由批准触发**，别的地方一概不许调 —— 一个还没批准的阶段的线程被归档，
   * 下一次 resume 就会一起来就死，那正是这条路要收拾的事。
   */
  onApproved: (input: { phase: Phase; threadId: string }) => void;
  /** 一个阶段最多跑几轮。跑满之后把收敛数据摊出来，**不拦人** —— 阻断归人管。 */
  roundBudget: number;
  timeoutMs: number;
}): Promise<DecideResult> {
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

  const gate = new CommandStore(database).gateFor(changeId);
  const gaps = new GapStore(database);
  const blockers = gaps.blockers(changeId, phase);
  /*
   * 「回应蓝方」和裁决**同一次问出来**。
   *
   * 顺序是 open gap 在库里的顺序（`GapStore.all` 按 `opened_round, id` 排），而
   * `responsesFrom` 靠位置对应回来 —— 所以这个名单必须和读答案时用的是同一个。
   * 名单变了 snapshot 就变了，fence 会在落地之前拒掉，不会把答案套到别的问题上。
   */
  const allGaps = gaps.all(changeId, phase);
  const openGaps = allGaps.filter((gap) => gap.status === "open");
  /*
   * 人提的那条算第几轮发现的。取现有 gap 里最大的那个轮次 —— 他是**看着这一轮的
   * 产出**提出来的，所以和这一轮报出来的问题记同一个号。一条 gap 都没有时是第 1 轮。
   */
  const raiseRound = Math.max(1, ...allGaps.map((gap) => gap.openedRound));
  /*
   * 这一轮的标准判成什么样，**写进题面**。
   *
   * 用户 2026-07-30：要不要继续对抗由人决定，不做成全自动。那么人就得看得见这一轮
   * 判成什么样 —— 否则「再来一轮还是批准」是在没有信息的情况下按的。
   *
   * 为什么它不能只留在网页的「标准」页签里：**裁决发生在 Codex 画的选择器里**
   * （§5.2b），人按下去的那一刻眼前只有那张表。要他判断的信息不在那张表上，就等于
   * 要他凭记忆判断。
   *
   * 非阻断的 `no` 也照报：它不挡闸门，但它正是「要不要再来一轮」的原料 —— 闸门放
   * 不放行和这一轮做得好不好是两个问题。
   */
  const assessed = new RubricStore(database).latestRound(changeId, phase);
  /*
   * 裁判的结论和反方的整体判断，也写进题面（用户 2026-07-31）。逐条判定说得出
   * 「第 3 条没勾上」，说不出「加起来还差在哪」—— 而后者正是他按按钮之前想知道的。
   *
   * 和 `assessed` 取自同一轮：`latestRound` 和 `latest` 都取最大的那个 round，
   * 各取各的轮次就是把两轮的东西并排摆着当成一轮，那是在骗人。
   */
  const notes = new RoundNoteStore(database).latest(changeId, phase);
  // 轮次和派发同一份算法 —— 各算一套迟早说出两个「第几轮」，而人正拿它做决定。
  const round = roundFromLedger(changes.ledger(changeId), phase);
  const question = gateDecisionQuestion({
    phase,
    gate,
    // 「什么挡着、出口、批准会怎样」由 gateDecisionQuestion 从 gate+openGaps 算
    // （§3.2：判据和闸门同一份）。这里只拼「这一轮判成什么样」。
    summary: summariseAssessments(assessed?.byRole ?? null)
      + summariseRoundNotes(notes)
      + summariseConvergence({
        round, budget: input.roundBudget,
        raised: allGaps.length, open: blockers.length,
      }),
    openGaps,
    round,
    // 打回上游（§5.9.1）的合法目标，按这个 Change 自己的图算。
    sendBackTargets: upstreamOf(phase, changes.graphOf(changeId)),
  });
  // No question rather than an empty one: putting a decision to someone that
  // they cannot make is worse than not asking (domain/question.ts).
  if (!question) {
    return { outcome: { kind: "no_decision", phase }, closeSession: false };
  }

  const questionId = `Q-${changeId}-${phase}-${Date.now()}`;
  const questions = new QuestionStore(database);
  questions.ask({
    id: questionId, changeId, phase, kind: "gate_decision",
    question, expectedSnapshot: gate.snapshot,
  });

  input.launch({
    phase,
    prompt: launchAskPrompt("它会把 StagePass 的问题交给我来选。",
      "不要替我做决定，不要解释我该选什么，调用完就停下。"),
  });

  const waited = await waitForAnswer({
    database, questions, sessions, changeId, phase, questionId,
    timeoutMs: input.timeoutMs,
  });
  if (!waited.answered) {
    // 题已经被 waitForAnswer 收掉了（那条规则只此一份）。
    return {
      outcome: {
        kind: "unanswered", phase, questionId,
        reason: waited.reason, threadId: waited.threadId,
      },
      closeSession: true,
    };
  }
  const first = waited.answer;

  /*
   * **第二趟：只问那几条真的需要理由的。**
   *
   * 第一趟纯选项格（客户端空文本格吃回车，`optional` 也不管用）。2026-08-03 真机上
   * 用户在八个格子里各打了一个「1」纯粹为了过去 —— 和录需求那张表被治好之前一模
   * 一样。哪几条要进第二趟由语义定：同意不用说话；不同意 / 先接受风险要落进
   * `resolution`（一次没有理由的关闭和「这一轮忘了提」在库里长得一模一样）；
   * 「我自己说」是他自己要求的。
   *
   * 一条都不需要就不弹 —— 全点「同意」的人一个字都不用打。
   */
  let answer = first;
  const more = responseFollowUpQuestion(openGaps, first);
  if (more) {
    const second = await askFollowUp({
      database, questions, sessions, changeId, phase, question: more,
      kind: "gate_decision",
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
    answer = { action: first.action, content: { ...first.content, ...second.content } };
  }

  /*
   * ── 三步，顺序是承重的 ────────────────────────────────
   *
   * 1. **先查 fence。** 问的是「人回答的这段时间里，别人动过这份证据吗」。这一步
   *    必须在自己动手之前，否则查的就只是「我刚写完的东西还在不在」。
   * 2. **落人对每一条问题的表态。** 一次驳回或接受会把一条 blocker 从名单里拿掉，
   *    而闸门算的正是那个名单 —— 先裁决就是拿着旧名单裁决，人刚说的话对这一次没有
   *    任何影响。
   * 3. **再走闸门**，对着表态之后的新快照（`rebaseFence`）。存下来的那份 fence
   *    必然对不上，而对不上的原因是**人自己刚说的话** —— 那不是 fence 要防的东西。
   *
   * 表态本身**不推动闸门**：它只改 gaps。推动闸门的仍然只有 `decision` 那一格，
   * 走 `questions.apply` 这一条路（§5.3：没有第二条能推动闸门的路）。
   */
  try {
    questions.assertFenceHolds(questionId);
  } catch (error: unknown) {
    if (!(error instanceof GateMovedError)) throw error;
    questions.settle(questionId);
    return {
      outcome: { kind: "gate_moved", phase, questionId, answer },
      closeSession: false,
    };
  }

  const responded = responsesFrom({ question, answer, openGaps });
  const applied = Object.keys(responded.responses).length === 0
    ? { refused: [] as { id: string; code: string }[] }
    : gaps.respond(changeId, phase, responded.responses);
  // 人自己提的那一条 —— 它挡闸门，所以要在裁决之前落进去。
  const raised = responded.raised === ""
    ? null
    : gaps.raise(changeId, phase, responded.raised, raiseRound);

  /*
   * 裁决可能在人自己的表态之后就不合法了 —— 最典型的是他刚提了一条新要求，又选了
   * 「批准」。**那时闸门该拒，而且要说出来**：默默当成没发生，人会以为批准了。
   */
  let outcome: unknown;
  try {
    // 打回的理由在合并后的答案里（Tx 在第二趟），store 重读不到 —— 递进去。
    outcome = questions.apply(
      questionId, { rebaseFence: true, sendBackReason: sendBackReasonFrom(answer) });
  } catch (error: unknown) {
    if (!(error instanceof GateRefusedError)) throw error;
    questions.settle(questionId);
    outcome = { kind: "refused", action: error.action, reason: error.reason };
  }
  // 下场落库 ——「闸门拒了」必须留得住（§3.2·5），不能只活在这一次响应里。
  questions.recordOutcome(questionId, outcome);

  /*
   * **批准了就归档这个阶段的线程。**
   *
   * `phase` 是转移**之前**的那个，也就是刚被批准的那个，正好是要归档的那一条。
   * Fix 会被反复进入（§6.5 规则 2），但它被批准时活儿也确实完了；下次再进 Fix，
   * `launchInto` 那边会自动把它解开。
   */
  if (
    typeof outcome === "object" && outcome !== null
    && (outcome as { kind?: unknown }).kind === "advanced"
    && (outcome as { action?: unknown }).action === "approve"
  ) {
    const bound = new BindingStore(database).find(changeId, phase);
    if (bound?.status === "bound") input.onApproved({ phase, threadId: bound.threadId });
  }

  /*
   * 选了「再来一轮」就**直接续跑**，不用人再回面板按一次「跑这个阶段」。
   *
   * 用户 2026-07-30：「把现在的两步合成一步。」两步之所以是坑，不只是多点一下 ——
   * 中间那一步**看不出来还需要它**：裁决落完之后 Change 回到 pending，界面上没有
   * 任何东西说「还差一次派发」，人会以为下一轮已经在跑了。
   *
   * 「再来一轮」和「重跑一次」都续 —— 两条路上活儿都留在这个阶段，中间那一步一样
   * 看不出来。**「打回去修」不续**：那时 Change 已经换到 Fix 了，自动在一个刚到的
   * 阶段上开跑，等于替人决定了 Fix 该做什么。
   */
  const decided = answer.content[DECISION_FIELD];
  const continued = runsAgainHere(decided) ? await input.rerun(phase) : null;

  return {
    outcome: {
      kind: "decided", phase, questionId, answer,
      responses: responded.responses,
      refused: applied.refused,
      raised: raised?.id ?? null,
      outcome,
      continued,
      state: changes.read(changeId).state,
    },
    closeSession: false,
  };
}
