import type Database from "better-sqlite3";

import type { Phase } from "../domain/phase";
import {
  briefContract, readBriefProposal, briefFrom, followUpFields, BriefProposalVoidError,
} from "../domain/brief";
import {
  clarificationQuestion, type Answer, type ClarificationItem, type Question,
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

/**
 * 问题的 schema 就是人当时真正看见的表。恢复时从它重建 items，不能重新让模型
 * 提一份问题：新问题哪怕只换了一个选项，也已经不是人回答的那一份。
 */
function itemsFromQuestion(question: Question): readonly ClarificationItem[] {
  const required = new Set(question.requestedSchema.required);
  return Object.entries(question.requestedSchema.properties).map(([id, field]) => ({
    id,
    question: field.title,
    options: field.enum ?? [],
    ...(required.has(id) ? {} : { optional: true }),
  }));
}

function landBrief(input: {
  database: Database.Database;
  changes: ChangeStore;
  questions: QuestionStore;
  changeId: string;
  questionIds: readonly string[];
  items: readonly ClarificationItem[];
  answer: Answer;
  phase: Phase;
}): BriefResult {
  const brief = briefFrom(input.items, input.answer);
  if (brief === null) {
    input.database.transaction(() => {
      input.questionIds.forEach((id) => input.questions.settle(id));
    })();
    return { outcome: { kind: "not_recorded", phase: input.phase }, closeSession: true };
  }
  /*
   * 「需求写下了」和「答案已消费」是一件事的两面，必须同一事务。否则正好在两句
   * 中间退出，下一次恢复会再次处理同一答案，或者库里出现 brief 已有、题仍 answered
   * 的两张脸。
  */
  input.database.transaction(() => {
    input.changes.setBrief(input.changeId, brief);
    input.questionIds.forEach((id) => input.questions.settle(id));
  })();
  return { outcome: { kind: "recorded", phase: input.phase, brief }, closeSession: true };
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

  const questions = new QuestionStore(database);

  const gate = new CommandStore(database).gateFor(changeId);
  /** 问一趟，等人答完。答上了给答案，没走通给一个说得清的下场。 */
  const askOnce = async (
    fields: readonly ClarificationItem[], title: string, fixedId?: string,
  ): Promise<{ answer: Answer; questionId: string } | BriefResult> => {
    const question = clarificationQuestion({ title, items: fields })!;
    const questionId = fixedId ?? `BR-${changeId}-${Date.now()}`;
    let existing = null;
    try { existing = questions.read(questionId); } catch { /* 还没登记，下面新建。 */ }
    if (existing === null) {
      questions.ask({
        id: questionId, changeId, phase, kind: "clarification",
        question, expectedSnapshot: gate.snapshot,
      });
    } else if (existing.status === "answered") {
      const answer = questions.readAnswerFor(questionId);
      if (answer !== null) return { answer, questionId };
    }

    /*
     * 不再打进会话叫模型转达 —— 和裁决、接受风险同一个理由。这张表是 StagePass
     * 起草好的（模型只写了草稿的内容，表的形状是这一侧的），题落进库里，
     * 面板画到浏览器上，人在那儿答。会话死不死跟这道题没关系了。
     */
    const waited = await waitForAnswer({
      database, questions, sessions, changeId, phase, questionId,
      timeoutMs: input.timeoutMs, waitsInBrowser: true,
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
    // 等整份 brief 原子落库时再 settle；这几毫秒里重启，下一次才能从 answered 续上。
    return { answer: waited.answer, questionId };
  };

  /*
   * MCP 的 answer 是持久事实，HTTP 请求和等待协程不是。进程若在这两者之间重启，
   * 旧实现会直接重新跑 propose，留下「题是 answered、brief 却永远没有」的死状态。
   * 题面从当时存下来的 schema 重建，绝不拿新提案套旧答案。
   */
  const interrupted = questions.answered(changeId, "clarification").find((record) =>
    record.id.startsWith(`BR-${changeId}-`)
    && !record.id.endsWith("-x")
    && record.question.message.includes("先把这次改动要什么说清楚"));
  if (interrupted !== undefined) {
    const firstAnswer = questions.readAnswerFor(interrupted.id);
    const recoveredItems = itemsFromQuestion(interrupted.question);
    if (firstAnswer !== null) {
      const more = followUpFields(recoveredItems, firstAnswer);
      if (more.length === 0) {
        return landBrief({
          database, changes, questions, changeId, questionIds: [interrupted.id],
          items: recoveredItems, answer: firstAnswer, phase,
        });
      }
      const second = await askOnce(
        more, `${changeId}：你说要自己写的那几条`, `${interrupted.id}-x`,
      );
      if ("outcome" in second) return second;
      return landBrief({
        database, changes, questions, changeId,
        questionIds: [interrupted.id, second.questionId],
        items: recoveredItems,
        answer: {
          action: firstAnswer.action,
          content: { ...firstAnswer.content, ...second.answer.content },
        },
        phase,
      });
    }
  }

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
   */

  const first = await askOnce(items, `${changeId}：先把这次改动要什么说清楚`);
  if ("outcome" in first) return first;

  /*
   * 第二趟只在真有人要写字的时候才弹。**一条都没有就不弹** —— 「全用选项答完的人
   * 一个字都不用打」如果还要他再点一次「提交」，那句话就打了折。
   */
  const more = followUpFields(items, first.answer);
  let content = first.answer.content;
  const questionIds = [first.questionId];
  if (more.length > 0) {
    const second = await askOnce(
      more, `${changeId}：你说要自己写的那几条`, `${first.questionId}-x`,
    );
    if ("outcome" in second) return second;
    questionIds.push(second.questionId);
    content = { ...content, ...second.answer.content };
  }

  return landBrief({
    database, changes, questions, changeId, questionIds,
    items,
    answer: { action: first.answer.action, content },
    phase,
  });
}
