/**
 * The twelve phases a Change moves through, and where approval leads.
 *
 * ## One phase, one name
 *
 * These identifiers are the ONLY names for these phases anywhere in the tree --
 * in code, in the database, in a card, in a log line. No aliases, no casing
 * variants, no per-layer vocabulary.
 *
 * The tree this replaces had three names for the first phase alone: the stage
 * was `intake`, its gate was `PRD`, and the decision allowlist called it
 * `Intake`. A receipt carrying one of them was compared against a binding
 * holding another, and the comparison could never succeed -- that was the first
 * structurally-impossible check found on 2026-07-28, and it cost a day.
 *
 * It also disagreed with itself about how many phases exist: `CONTENT_PHASES`
 * listed thirteen (including `Implement` and `Check`), while `PipelinePhase`
 * declared nine. Neither matched the product definition. This list does.
 */
export const PHASES = [
  "PRD",
  "Spec",
  "TechSpec",
  "Plan",
  "TestPlan",
  "Build",
  "Review",
  "Fix",
  "QA",
  "Merge",
  "Retro",
  "Done",
] as const;

export type Phase = (typeof PHASES)[number];

const PHASE_SET: ReadonlySet<string> = new Set(PHASES);

export function isPhase(value: string): value is Phase {
  return PHASE_SET.has(value);
}

/**
 * 阶段图：主线的顺序，作为**值**（BACKLOG §4.5）。
 *
 * ## 为什么从常量变成数据
 *
 * bootstrap 框架下「只有一个 Change，YAGNI」不成立 —— 不是每个项目都值得走
 * 12 个阶段（§1.5·④）。图变成值之后，一个项目可以只走
 * `PRD → Build → Review → Done`，而状态机一行不改。
 *
 * ## 自定义图 = 全序的子序列，不许重排
 *
 * 「上游」这个词建立在全序上，而长回边（sendBack）整个建在「上游」上。允许重排，
 * `upstreamOf` 就说不清 TestPlan 和 Plan 谁先谁后 —— 那不是灵活性，是把一个
 * 有语义的顺序退化成一个列表。跳过阶段可以，交换阶段不行。
 *
 * ## `Fix` 永远不在主线上
 *
 * 它由打回进入（Review/QA 的 reject），由弹栈离开。写进主线等于每个 Change
 * 都要路过修理厂。
 */
export interface PhaseGraph {
  readonly order: readonly Phase[];
}

/** 默认图：除 Fix 外的 11 个阶段，全序。 */
export const DEFAULT_GRAPH: PhaseGraph = {
  order: PHASES.filter((phase) => phase !== "Fix"),
};

/**
 * **每个阶段真正消费谁的产物。**「上游」按这张表算，不按顺序上谁在前面（§8.6·①）。
 *
 * ## 为什么顺序前缀是错的
 *
 * `upstreamOf` 原来取的是主线顺序的前缀，于是 `upstreamOf("TestPlan")` 里有
 * `Plan` —— 面板今天就摆着「从 TestPlan 打回 Plan」这个选项，而 **TestPlan 从来
 * 没消费过 Plan 的任何东西**。一个必然说不通的打回摆在人眼前，和一个假选项没有
 * 区别（§5.4：选项里不许出现选不动的东西）。
 *
 * 同一个错误有第二份拷贝：任务书里「已批准的上游产物」也是按顺序前缀取的
 * （`work/round-turn-runner.ts`），于是 TestPlan 的红方还会收到一份 Plan 的文档
 * 当输入。**两处现在读同一张表。**
 *
 * ## 顺序没有变松
 *
 * 这张表只改「谁是谁的上游」，**不改执行顺序** —— 主线仍然是全序，一个 Change
 * 仍然一次只在一个阶段上。让 Plan 和 TestPlan 真正并行是 §8.6·③，那要动
 * `ChangeState.phase` 是单数这件事，是另一回事。
 *
 * ## 只有 TestPlan 那一行改变了行为
 *
 * 其余逐条和顺序前缀一致：Build 消费 Plan 和 TestPlan，传递下去仍然够得着
 * TechSpec / Spec / PRD；Review 之后的每一个都通过 Build 够得着全部。
 *
 * `Fix` 是空的，**不是漏了**：它不在主线上，`sendBack` 对它从来就不合法（它的
 * 出口是弹栈还债）。给它填上游会让打回从 Fix 变得合法，而那要求 Fix 进
 * `returnStack` —— 正是 `assertStateValid` 明令禁止的。
 */
const CONSUMES: Readonly<Record<Phase, readonly Phase[]>> = {
  PRD: [],
  Spec: ["PRD"],
  TechSpec: ["Spec"],
  Plan: ["TechSpec"],
  // **不含 Plan**：两者都只消费 TechSpec，互不消费（BACKLOG §8.6·①/③）。
  TestPlan: ["TechSpec"],
  Build: ["Plan", "TestPlan"],

  /*
   * ── 下面这四行**没有验证过**（2026-08-06 用户拍：等真走到那儿再填）─────────
   *
   * 填的是线性链，理由是**它让行为和改这张表之前逐字一致**，不是因为我知道它对。
   * CHG-001 到今天只走到 Build —— Review / QA / Merge / Retro 从来没产出过任何
   * 东西，所以一条经验依据都没有。
   *
   * **承重的那个问题：从 QA 能不能打回 Review。** 现在能（`QA ← Review`）。而
   * 审查阶段产出的是 findings 不是文档，「打回 Review 说它错了」可能根本没有
   * 含义 —— 重审的出口是 `rerun`，代码错的出口是 `reject`→Fix。真是那样的话，
   * 这几行该改成 `QA ← Build + TestPlan`、`Merge ← Build`，Review / QA 就掉出
   * 各自下游的上游名单。
   *
   * **走到那儿的那一轮，回来把这四行定了。** 在那之前它们是有意的过渡，不是遗漏。
   */
  Review: ["Build"],
  Fix: [],
  QA: ["Review"],
  Merge: ["QA"],
  Retro: ["Merge"],
  Done: ["Retro"],
};

export class InvalidPhaseGraphError extends Error {
  constructor(readonly code:
    | "must_end_with_done"
    | "fix_not_on_the_line"
    | "unknown_phase"
    | "not_a_subsequence",
  readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "InvalidPhaseGraphError";
  }
}

/**
 * 从一串阶段名构造一张图。**拒绝发生在构造时，不在走到一半时** —— 一张走到
 * Build 才发现没有出口的图，比一张建不出来的图贵得多。
 */
export function phaseGraphOf(order: readonly string[]): PhaseGraph {
  if (order.length === 0 || order[order.length - 1] !== TERMINAL_PHASE) {
    throw new InvalidPhaseGraphError("must_end_with_done", order.join(","));
  }
  const phases: Phase[] = [];
  for (const name of order) {
    if (!isPhase(name)) throw new InvalidPhaseGraphError("unknown_phase", name);
    if (name === "Fix") {
      throw new InvalidPhaseGraphError("fix_not_on_the_line", order.join(","));
    }
    phases.push(name);
  }
  // 子序列判定：在全序里按序找得到每一个。找不到 = 重排或重复。
  let cursor = 0;
  const full = DEFAULT_GRAPH.order;
  for (const phase of phases) {
    const found = full.indexOf(phase, cursor);
    if (found === -1) {
      throw new InvalidPhaseGraphError("not_a_subsequence", order.join(","));
    }
    cursor = found + 1;
  }
  return { order: phases };
}

/**
 * Where an approval moves the Change.
 *
 * `Fix` is deliberately absent: it is not a step in the line -- it is entered
 * when Review or QA sends work back, and leaving it pops the return stack.
 * That target is state, not a constant, so it lives on the Change
 * (`returnStack`) rather than here.
 */
export function advancesTo(
  phase: Phase,
  graph: PhaseGraph = DEFAULT_GRAPH,
): Phase | null {
  if (phase === "Fix") return null;
  const index = graph.order.indexOf(phase);
  if (index === -1) {
    // 一个不在图上的阶段没有「下一步」可言。返回 null 会让 transition 把它
    // 当成终点直接 closed —— 静默失败往危险那边倒，所以抛。
    throw new InvalidPhaseGraphError("unknown_phase", phase);
  }
  return graph.order[index + 1] ?? null;
}

/**
 * `phase` 真正的上游 —— **它消费的，以及它消费的东西所消费的**（`CONSUMES` 的
 * 传递闭包）。sendBack（长回边，§5.9.1）的合法目标名单就是它。
 *
 * 出去的按**主线顺序**排 —— 调用方靠这个取「最近的那个上游」（`journey.ts` 画环
 * 时用 `.at(-1)`）。跳过的阶段不出现在名单里，但它的上游照样传递得过来：把
 * TechSpec 跳掉，Plan 的上游仍然是 Spec / PRD。
 *
 * 第一个阶段和 Fix 都是空名单：前者没有上游，后者不在主线上。空名单的含义由
 * 调用方判 —— 一道没有选项的题不该问出去（domain/question.ts 那条规矩）。
 */
export function upstreamOf(
  phase: Phase,
  graph: PhaseGraph = DEFAULT_GRAPH,
): Phase[] {
  const seen = new Set<Phase>();
  const walk = (each: Phase): void => {
    for (const source of CONSUMES[each]) {
      if (seen.has(source)) continue;
      seen.add(source);
      walk(source);   // 传递：消费的东西所消费的，也是上游
    }
  };
  walk(phase);
  /*
   * **按这个 Change 自己的图过滤并排序。**
   *
   * 过滤：跳过的阶段没有产出，打回到它没有含义。
   * 排序：名单的顺序是有语义的（`.at(-1)` = 最近的那个上游），而闭包的遍历顺序
   * 不是 —— 靠遍历顺序等于靠巧合。
   */
  return graph.order.filter((each) => seen.has(each));
}

/**
 * The phases that send work to Fix instead of simply reopening themselves.
 *
 * Rejecting a design phase means "run another round here". Rejecting Review or
 * QA means the code is wrong, which is a different phase's job.
 */
const SENDS_TO_FIX: ReadonlySet<Phase> = new Set<Phase>(["Review", "QA"]);

export function sendsToFix(phase: Phase): boolean {
  return SENDS_TO_FIX.has(phase);
}

/**
 * 这些阶段里，**红方审的是别人的东西**，所以它报出来的问题算数。
 *
 * ## 它推翻的是哪条规矩
 *
 * 一轮对抗默认忽略红方报的问题（`readRound`）：产出者报告自己作品的毛病不是对抗性
 * 发现，让红方决定自己的东西有多糟，正是蓝方存在的理由。
 *
 * **到 Review 这条理由不成立** —— 红方审的是 Build 的产出，不是自己写的。而 Review
 * 的活儿就是找缺陷，照旧丢掉等于这个阶段什么都不产出（用户 2026-07-30 拍板）。
 *
 * ## 为什么是这两个，而不是别的
 *
 * 用户 2026-07-30 定的通则：「红方写或者审，但绝对不能自审，然后蓝方来纠错。」
 * 判据就是**红方交出来的东西是不是对它自己作品的评价**：
 *
 *   Review  审 Build 写的代码      -> 不是自审，算数
 *   QA      跑 Build 写的代码      -> 不是自审，算数
 *   Fix     改自己要交的代码        -> 自审，不算
 *   Merge   写自己这一次的总结      -> 自审，不算
 *   Retro   写自己这一程的复盘      -> 自审，不算
 *   设计阶段 写自己那份文档          -> 自审，不算
 *
 * 这个名单里少一个，最坏是那个阶段的红方白报一次；多一个，就是让一个模型对自己
 * 产出的评价直接变成挡门的东西。所以判据要能一句话说清，而上面那一列就是它。
 */
const RED_REVIEWS_OTHERS: ReadonlySet<Phase> = new Set<Phase>(["Review", "QA"]);

export function redReviewsOthers(phase: string): boolean {
  return isPhase(phase) && RED_REVIEWS_OTHERS.has(phase);
}

/** The phase every Change starts in. */
export const FIRST_PHASE: Phase = "PRD";

/** The phase a Change ends in. Nothing leaves it. */
export const TERMINAL_PHASE: Phase = "Done";

/**
 * 这些阶段的产出是一个 **commit**，不是一份文档。
 *
 * 判据只有一条：**红方在这一阶段写的是代码**。一组改动天然对应一个 commit ——
 * 文件列表说不出「改了什么」（同一个路径改前改后都是它），diff 说不出「基于哪一版」，
 * commit 两样都有，还多了稳定 id、能 revert、能进 fence（用户 2026-07-30 拍板）。
 *
 *   Build  按 Plan 实现          -> 写代码，记 commit
 *   Fix    改掉被报出来的问题     -> 写代码，记 commit
 *   别的    写文档 / 写报告        -> 一个路径就说全了
 *
 * 这个名单还决定**要不要查干净树**：StagePass 提交的是工作树里所有的改动，它分不出
 * 哪一行是红方写的、哪一行是人自己写了一半的。所以凡是要 commit 的阶段，派发之前
 * 必须先确认树是干净的 —— 两件事同一个名单，不许分开。
 *
 * **名单外的阶段轮末也 commit，但那不违反上面这条**（E，2026-08-05）：它们走的是
 * `repo.commitPaths`，只提交 `docs/stagepass/<change>/` —— 逐个点名，结构上卷不走
 * 没点到的东西，所以不需要干净树。上面那条约束的前提是「分不出哪行是谁写的」，
 * 而一个 StagePass 独占的目录就是那条分界。意思是「整树提交」的名单，仍然精确
 * 等于意思是「要求干净树」的名单。
 */
const PRODUCES_COMMIT: ReadonlySet<Phase> = new Set<Phase>(["Build", "Fix"]);

export function producesCommit(phase: string): boolean {
  return isPhase(phase) && PRODUCES_COMMIT.has(phase);
}
