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
 * Where an approval moves the Change.
 *
 * `Fix` is deliberately absent from this map. It is not a step in the line: it
 * is entered when Review or QA sends work back, and leaving it returns to
 * whichever of the two sent it. That target is state, not a constant, so it
 * lives on the Change (`returnPhase`) rather than here. Encoding it as a fixed
 * edge would silently send every QA failure back through Review.
 */
const ADVANCES_TO: Readonly<Record<Phase, Phase | null>> = {
  PRD: "Spec",
  Spec: "TechSpec",
  TechSpec: "Plan",
  Plan: "TestPlan",
  TestPlan: "Build",
  Build: "Review",
  Review: "QA",
  Fix: null,
  QA: "Merge",
  Merge: "Retro",
  Retro: "Done",
  Done: null,
};

export function advancesTo(phase: Phase): Phase | null {
  return ADVANCES_TO[phase];
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
