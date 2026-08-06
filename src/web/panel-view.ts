import type Database from "better-sqlite3";

import { PHASES, type Phase } from "../domain/phase";
import type { Gap } from "../domain/gap";
import type { ChangeState } from "../domain/change-state";
import { jumpsFrom, optionsFrom } from "../domain/journey";
import { roundFromLedger } from "../domain/round";
import { createSubAgentLookup, threadContextUsage } from "../codex/subagent";
import { BindingStore } from "../store/binding-store";
import { ChangeStore, type LedgerEntry } from "../store/change-store";
import { CommandStore } from "../store/command-store";
import { EvidenceStore } from "../store/evidence-store";
import { GapStore } from "../store/gap-store";
import { ProjectStore } from "../store/project-store";
import { QuestionStore } from "../store/question-store";
import { RubricStore } from "../store/rubric-store";
import { JobStore } from "../work/job-store";

/**
 * **面板那两屏读出来的东西** —— 从 `handle()` 里搬出来（BACKLOG §4.1·J）。
 *
 * ## 为什么它在 `web/` 而不在 `app/`
 *
 * 三条问人的路是**用例**：它们有下场（批准了 / 接受了 / 录进去了），换个界面
 * 那些下场一个字都不用改。这两屏不是 —— 它们出去的东西按**界面要画什么**组织
 * （`workspace`、`currentPhase`、`journey`、`mark`），换个界面就是另一份形状。
 *
 * 把它塞进 `app/` 会把界面的词汇拖进那一层，而那正是 `waiveBody` 一族存在的
 * 理由的反面。所以它搬出 `panel-server.ts`（`handle()` 要瘦、配料单要小），
 * 但**不假装自己是用例**。
 *
 * ## 只读
 *
 * 这个文件里没有一处写。看状态不该有副作用 —— 打开面板不许起进程、不许动闸门。
 */

/**
 * 会话在这一层只需要一个动作：那个进程还活着吗。
 *
 * 结构类型而不是 `PanelSessions` —— 那个类住在 `panel-server.ts`，而这个文件
 * 被它 import。照着接口写，两边就没有环。
 */
export interface LiveSessions {
  has(changeId: string, phase: Phase): boolean;
}

/**
 * The phases that can hold a thread: eleven of the twelve.
 *
 * `Done` is excluded because it is terminal -- nothing is dispatched there, so
 * a terminal for it would be a tab that can never show anything. Eleven is a
 * fixed number, which is what lets the panel be enumerated rather than being a
 * list that grows (PRD §6.5 rule 1). Do not introduce a third count.
 */
const THREADED_PHASES: readonly Phase[] = PHASES.filter((phase) => phase !== "Done");

/** Passed, failed, or neither yet. */
type PhaseMark = "approved" | "problem" | null;

/**
 * Whether a phase has passed or failed, for the colour on its node.
 *
 * ## Green is read from the ledger, never from the evidence
 *
 * A phase is approved because a PERSON approved it, and `change_events` is the
 * only place that is recorded. The tempting alternative -- green when the round
 * reported no blockers -- puts the model's own opinion of its work on the
 * screen as a pass, which is the exact substitution StagePass exists to
 * prevent (PRD §1). Decided with the user on 2026-07-29.
 *
 * ## Amber outranks green
 *
 * A gap opened on a phase that was already approved makes the green a false
 * statement, so the open gap wins. Approval is not a permanent property of a
 * phase; it is what was true the last time somebody looked.
 *
 * ## Neither is `null`, not a third word
 *
 * Where the Change is sitting is already carried by `current`, and whether a
 * phase has a thread by `threadId`. A mark that repeated either would be a
 * second name for a concept that already has one.
 */
function markOf(
  phase: Phase,
  ledger: readonly LedgerEntry[],
  state: ChangeState | null,
  gaps: readonly Gap[],
): PhaseMark {
  if (gaps.some((gap) => gap.status === "open")) return "problem";
  if (state?.phase === phase && state.status === "blocked") return "problem";

  // The last thing that happened TO this phase wins. `start` / `settle` /
  // `fail` / `retry` never leave the phase they act on, so they fall through
  // every branch and leave the verdict alone -- only a departure or an arrival
  // changes it.
  let verdict: PhaseMark = null;
  for (const entry of ledger) {
    if (entry.from?.phase === phase && entry.action === "approve") verdict = "approved";
    else if (entry.from?.phase === phase && entry.action === "reject") verdict = "problem";
    // Arriving from somewhere else makes whatever was decided here stale. Fix
    // is the phase this matters for: it is the only one the line re-enters, and
    // a green Fix while the work is back inside it would be last visit's news.
    else if (entry.to.phase === phase && entry.from?.phase !== phase) verdict = null;
  }
  return verdict;
}

/**
 * 面板上每个阶段那一格：线程、进程、问题、判定、产出、上次裁决的下场。
 *
 * 十一个阶段各查各的，没有任何写。
 */
function phasesFor(input: {
  database: Database.Database;
  sessions: LiveSessions;
  changeId: string;
  state: ChangeState | null;
  ledger: readonly LedgerEntry[];
}): unknown[] {
  const { database, changeId, state, ledger } = input;
  const bindings = new BindingStore(database);
  const gapStore = new GapStore(database);
  const evidence = new EvidenceStore(database);
  const rubricRounds = new RubricStore(database);
  const questions = new QuestionStore(database);

  return THREADED_PHASES.map((phase) => {
    /*
     * 这个阶段最近一轮的 rubric 判定。
     *
     * 一条 `no` 会派生出 standard gap，那个在 gaps 里看得到；但 `yes` 和
     * `not_assessed` **不会留下任何痕迹** —— 而「这一轮到底判了没有」正是人
     * 最需要看见的：全是 not_assessed 意味着模型压根没照契约作答，而那和
     * 「都通过了」在 gaps 里长得一模一样（两边都没有 standard）。
     */
    const rounds = rubricRounds.latestRound(changeId, phase);
    /*
     * 红方这一阶段产出了什么。
     *
     * 「红蓝双方主张摘要」（设计稿 §4.4）落到新树上就是这两样：**蓝方的主张
     * 是 gaps 里那些 finding**（已经在显示了），**红方的主张是它产出的东西** ——
     * 而后者面板从来没读过。只看得见「有人挑了三条毛病」而看不见「他挑的是
     * 什么东西」，那个列表就悬着。
     */
    const produced = evidence.read(changeId, phase).artifactIds;
    // Every phase's whole gap history, closed and waived included -- the
    // popup has to be able to show "we fixed it, and here is the reason"
    // rather than only what is still blocking.
    const gaps = gapStore.all(changeId, phase);
    return {
      phase,
      // 只报真的绑着的：一条 detached 的绑定仍然留着 threadId，报出去界面会
      // 说「有线程，点开会恢复它的历史」—— 而它恢复不了。
      threadId: (() => {
        const bound = bindings.find(changeId, phase);
        return bound?.status === "bound" ? bound.threadId : null;
      })(),
      live: input.sessions.has(changeId, phase),
      current: state?.phase === phase,
      mark: markOf(phase, ledger, state, gaps),
      gaps,
      /**
       * 这个阶段跑过几轮 —— 环上那个节点的刻度就是它（§5.9.4）。
       *
       * 和派发、题面同一个算法（`roundFromLedger`）。真实形状不是 12 个节点的环，
       * 是 12 个各自带自环的节点：每个节点上花的轮数（3~4）比它在环上的位置
       * （1/12）更能说明「你在哪」。
       */
      rounds: roundFromLedger(ledger, phase),
      /** 最近一轮，按角色分。没跑过就是 null。 */
      assessed: rounds,
      /** 红方产出了什么。空数组 = 这个阶段还没产出任何东西。 */
      produced,
      /** 上次裁决的下场（§3.2·5）。留得住的状态，不是弹窗里一闪而过的那句。 */
      lastOutcome: questions.latestOutcomeFor(changeId, phase),
    };
  });
}

/**
 * 主屏那一份：工作区两栏 + 这个 Change 的环。
 *
 * **只读**：选一个项目只是把 Change 列表收窄，它不起任何一轮、不动任何一道闸门。
 */
export function panelView(input: {
  database: Database.Database;
  sessions: LiveSessions;
  changeId: string;
  /** `?project=` 带来的那个。null = 没显式指定。 */
  askedProject: string | null;
  /** 面板顶上显示的工作区名字。 */
  workspace: string;
}): unknown {
  const { database, changeId } = input;
  const changeStore = new ChangeStore(database);
  let state: ChangeState | null = null;
  let brief: string | null = null;
  let ledger: readonly LedgerEntry[] = [];
  try {
    const change = changeStore.read(changeId);
    state = change.state;
    brief = change.brief;
    ledger = changeStore.ledger(changeId);
  } catch {
    state = null; // No such Change; the panel shows an empty orbit.
  }

  /*
   * **没指定项目时，跟着当前这个 Change 走 —— 不是「全都给你」。**
   *
   * 用户 2026-08-03：「我点了某个 Project 只能显示这个 Project 的 change，不是所有
   * Project 的 changes。」而正常打开面板的地址是 `?change=CHG-002`（启动横幅印的
   * 就是这个，不带 project），于是这里读到 null、下面那句 `list(undefined)` 就把
   * 全库的 change 摊开了 —— 项目多起来之后，那一栏就没法看了。
   *
   * 显式带了 `?project=` 就听它的（点项目那条路会带），一个 Change 都没有的新库
   * 也仍然回退到「全都列」，否则第一次打开是一片空白。
   */
  const selectedProject = input.askedProject
    ?? (() => {
      try {
        return changeStore.read(changeId).projectId;
      } catch {
        return null;   // 没有这个 Change —— 那就没有「它的项目」可跟
      }
    })();
  const projects = new ProjectStore(database).list().map((project) => ({
    ...project,
    changes: changeStore.list(project.id).length,
  }));
  const changes = changeStore.list(selectedProject ?? undefined).map((change) => ({
    id: change.id,
    title: change.title,
    projectId: change.projectId,
    phase: change.state.phase,
    status: change.state.status,
  }));

  return {
    changeId,
    projects,
    selectedProject,
    changes,
    workspace: input.workspace,
    // Which phase the Change is actually at. Clicking a future node opens a
    // terminal to look at; it does NOT let you run that phase out of order,
    // because the phase a turn runs in comes from the state machine.
    currentPhase: state?.phase ?? null,
    status: state?.status ?? null,
    /** 人答出来的需求，null = 还没录。界面靠它决定能不能跑。 */
    brief,
    // Read-only, and it stays that way. The panel shows what the gate says;
    // it never offers a control that changes it (PRD §1).
    //
    // The risks the gate is holding are NOT repeated here: they are the
    // current phase's open gaps, and every phase already carries its own
    // below. One concept, one place to read it from.
    gate: state ? (() => {
      const verdict = new CommandStore(database).gateFor(changeId);
      return { permitted: verdict.permitted, refusals: verdict.refusals };
    })() : null,
    journey: jumpsFrom(ledger), // 跳转表 = 账本投影（§5.9.2），G 档只许读这一份
    /**
     * 从当前阶段能去哪（§5.9.3 的活箭头）。**边由闸门长出来，前端不许自己推。**
     * 空数组 = 现在没有可走的边（closed，或者没有这个 Change）。
     */
    options: state === null ? [] : optionsFrom(
      state,
      new CommandStore(database).gateFor(changeId),
      changeStore.graphOf(changeId),
    ),
    phases: phasesFor({ database, sessions: input.sessions, changeId, state, ledger }),
  };
}

/**
 * 一轮跑到哪了。
 *
 * ## 为什么非要有它
 *
 * 用户 2026-07-30 的原话：「跑一轮的时候界面几分钟不说话，我以为它挂了。」而这不是
 * 舒适度问题 —— 同一天撞上了更糟的那一格：`changes.status = running`，而那个阶段
 * **一个活进程都没有**。派出去的 Codex 早就没了，面板会一直坐到 30 分钟超时才报
 * 一句「超时」，而真正的原因永远不出现。**「在跑」和「已经死了」在界面上是同一
 * 个样子。**
 *
 * ## 两条硬约束都守住
 *
 * - **不解析 pty 输出**（PRD §9.3）。这里一个字节都不碰 pty。
 * - 进度只来自**库**和**进程状态**，外加 Codex 自己的 `state_5.sqlite`
 *   （`codex/subagent.ts` 早就在读它，读的是「这个线程派生了哪几个子 Agent」，
 *   和读 rollout 同一类动作）。
 *
 * ## 说不出来就说不出来
 *
 * `stage` 要靠裁判的 threadId 去查子 Agent，而 id 要等 transport 认出线程才有 ——
 * 第一轮的开头几十秒它就是 `null`，界面照实说「还看不出走到哪一步」。
 * **不编一个阶段名**：这一屏存在的意义就是不再让人猜，编一个就白做了。
 *
 * 只读，不写任何东西（M5）。
 */
export function progressView(input: {
  database: Database.Database;
  sessions: LiveSessions;
  changeId: string;
}): unknown | null {
  const { database, sessions, changeId } = input;
  let state: ChangeState;
  try {
    state = new ChangeStore(database).read(changeId).state;
  } catch {
    return null;   // 没有这个 Change。调用者翻成 404。
  }
  const phase = state.phase;
  const live = sessions.has(changeId, phase);
  const job = new JobStore(database).latestFor(changeId);

  /*
   * 裁判派生了哪几个子 Agent —— 这是唯一能说出「红方在写 / 蓝方在挑」的信号。
   *
   * 整段包在 try 里：它读的是别人的库，Codex 改了表名这里就该**报不知道**，
   * 而不是把整个进度端点带崩。
   */
  let spawned = 0;
  let stageKnown = false;
  let context: { used: number; window: number } | null = null;
  try {
    const bound = new BindingStore(database).find(changeId, phase);
    if (bound?.status === "bound") {
      spawned = createSubAgentLookup().spawnCount(bound.threadId);
      stageKnown = true;
      // 裁判线程离上下文墙多远（§3.3·11）。null = rollout 里还没有 token_count。
      context = threadContextUsage({ threadId: bound.threadId });
    }
  } catch {
    stageKnown = false; // 查不到就是查不到，不猜
  }

  return {
    phase,
    status: state.status,
    live,
    job: job === null ? null : {
      id: job.id,
      status: job.status,
      startedAt: job.createdAt,
      elapsedMs: Date.now() - Date.parse(job.createdAt),
    },
    /** 这一轮派生了几个子 Agent。原样给出去 —— 界面自己决定怎么说。 */
    spawned,
    /** 裁判线程离墙多远：{used, window}。null = 没绑线程或还读不出，不编。 */
    context,
    /**
     * 走到哪一步。`null` = 说不出来（第一轮，或者查不到子 Agent）。
     *
     * 只报**看得见的东西**：红方出现了、蓝方也出现了。蓝方出现之后是「蓝方还在挑」
     * 还是「裁判在裁」，这一侧分不出来 —— 所以不报第三档。
     */
    stage: !stageKnown
      ? null
      // **数个数，不看 agent_path** —— 那一列只有一个派生入口会设，而它不是每个
      // 会话都有（codex/subagent.ts 开头）。派生了 1 个 = 红方在写，2 个 = 轮到
      // 蓝方了。蓝方之后是「还在挑」还是「裁判在裁」这一侧分不出来，不报第三档。
      : spawned >= 2 ? "blue_attacking"
        : spawned === 1 ? "red_writing" : "judge_starting",
    /**
     * **承重的那一格**：状态说在跑，可是没有活进程 —— 派出去的那个 Codex 已经没了。
     *
     * 今天这一格会静默烧掉 30 分钟。它必须有名字，界面才说得出这句话。
     */
    processGone: state.status === "running" && !live,
  };
}
