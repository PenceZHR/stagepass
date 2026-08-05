import {
  advancesTo,
  DEFAULT_GRAPH,
  sendsToFix,
  upstreamOf,
  FIRST_PHASE,
  TERMINAL_PHASE,
  type Phase,
  type PhaseGraph,
} from "./phase";

/**
 * Where a Change is, and what may happen to it next.
 *
 * ## Why one status vocabulary instead of per-phase statuses
 *
 * The tree this replaces spelled the same four ideas differently in every
 * phase: `INTAKE_PENDING` / `SPECCING` / `TECHSPECCING` / `IMPLEMENTING` all
 * mean "a turn is running", and `INTAKE_READY` / `SPEC_READY` / `PLAN_READY` /
 * `TESTPLAN_DONE` all mean "there is a result and a human has to look at it".
 * Twenty-odd names for five ideas, each needing its own branch, each a place
 * for the branches to disagree.
 *
 * Here a Change is `(phase, status)`. The phase says where; the status says
 * what may happen next, and it means the same thing in every phase.
 *
 * ## This module is pure
 *
 * No database, no clock, no IO. Every legal and illegal transition can be
 * enumerated and proved offline, which is what L0 has to deliver before
 * anything is allowed to be built on top of it.
 */

export const PHASE_STATUSES = [
  /** Nothing has run in this phase yet. */
  "pending",
  /** A turn is executing. */
  "running",
  /** A turn produced a result and a human has to decide. */
  "settled",
  /** The turn failed. Nothing advances until someone retries. */
  "blocked",
  /** The terminal phase was approved. The Change is finished; nothing follows. */
  "closed",
] as const;

export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export const CHANGE_ACTIONS = [
  "start",
  "settle",
  "fail",
  "retry",
  "approve",
  "reject",
  /**
   * 打回上游（长回边，§5.9.1）：这个阶段发现某份**上游文档**错了，把工作送回去改。
   * 带目标（`TransitionOptions.to`），目标必须在严格上游。
   */
  "sendBack",
] as const;

export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

export interface ChangeState {
  readonly phase: Phase;
  readonly status: PhaseStatus;
  /**
   * 回程栈：「这儿完了之后回哪去」，后进先出（§5.9.2）。
   *
   * 空栈 = 正常沿主线走。两种动作压栈：打回上游（`sendBack`，压发起的阶段），
   * 和 Review/QA 送修（`reject` → Fix，压发起的阶段）—— **同一个机制，不是两个**。
   * 被打回/送修的阶段 approve 时弹栈回去，而不是沿主线前进。
   *
   * 原来是单字段 `returnPhase`，而单字段存不下嵌套回跳：Build 打回 Spec 之后，
   * Spec 又发现 PRD 错了 —— 这时「回来之后去哪」有两个答案要记（§5.9.2 的例子）。
   *
   * 不变量（`assertStateValid`）：自底向顶严格递减（后压进来的必然更靠上游）、
   * 每一层都在当前阶段的严格下游、Fix 的栈非空且顶是 Review/QA、closed 时栈空。
   */
  readonly returnStack: readonly Phase[];
}

/**
 * The only actions each status accepts. This table IS the state machine; the
 * transition function below decides where an accepted action lands, never
 * whether it was allowed.
 *
 * `sendBack` 在表里挂在 `settled` 下，但它还多一道判据：**当前阶段得有上游**
 * （PRD 没有，Fix 不在主线上）—— 那一半在 `isLegal` 里，因为它取决于阶段，
 * 不取决于状态。
 */
const ACCEPTS: Readonly<Record<PhaseStatus, readonly ChangeAction[]>> = {
  pending: ["start"],
  running: ["settle", "fail"],
  settled: ["approve", "reject", "sendBack"],
  blocked: ["retry"],
  closed: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly state: ChangeState,
    readonly action: ChangeAction,
  ) {
    super(
      `${action} is not legal in ${state.phase}/${state.status}`
      + ` (accepts: ${ACCEPTS[state.status].join(", ") || "nothing"})`,
    );
    this.name = "IllegalTransitionError";
  }
}

export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateError";
  }
}

export const INITIAL_STATE: ChangeState = {
  phase: FIRST_PHASE,
  status: "pending",
  returnStack: [],
};

export function accepts(status: PhaseStatus): readonly ChangeAction[] {
  return ACCEPTS[status];
}

/**
 * `sendBack` 的目标不合法时抛这个，不抛 `IllegalTransitionError` ——
 * 后者说「这一步在这儿不合法」，这个说「这一步合法，但你指的地方不对」。
 * 两句话的收拾方式不同：前者是调用方的 bug，后者要把名单摆给人重选。
 */
export class SendBackTargetError extends Error {
  constructor(
    readonly code: "target_missing" | "target_not_upstream",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "SendBackTargetError";
  }
}

export interface TransitionOptions {
  /** `sendBack` 的目标。别的动作不读它。 */
  readonly to?: Phase | undefined;
  /** 这个 Change 走的图。缺省 = 全序（DEFAULT_GRAPH）。 */
  readonly graph?: PhaseGraph | undefined;
}

export function isLegal(
  state: ChangeState,
  action: ChangeAction,
  graph: PhaseGraph = DEFAULT_GRAPH,
): boolean {
  if (!ACCEPTS[state.status].includes(action)) return false;
  // 打回要有地方可回：PRD 没有上游，Fix 不在主线上。这一半是阶段的属性，
  // 不是状态的属性，所以不在 ACCEPTS 表里。
  if (action === "sendBack") return upstreamOf(state.phase, graph).length > 0;
  return true;
}

/** 栈序校验用全序的下标 —— 子序列图保持相对顺序，所以这里不需要知道图。 */
const ORDER_INDEX: ReadonlyMap<Phase, number> =
  new Map(DEFAULT_GRAPH.order.map((phase, index) => [phase, index]));

/**
 * A state that could never have been produced by `transition` must not be
 * accepted back into it -- otherwise a corrupted row becomes a legal starting
 * point and the machine's guarantees stop meaning anything.
 */
export function assertStateValid(state: ChangeState): void {
  if (state.phase === "Fix") {
    const top = state.returnStack[state.returnStack.length - 1];
    if (top === undefined) {
      throw new InvalidStateError(
        "Fix has an empty returnStack, so nothing can say where approving it leads",
      );
    }
    // 只有 Review 和 QA 送修。栈顶是别人，说明这一行不是 transition 写出来的。
    if (!sendsToFix(top)) {
      throw new InvalidStateError(`Fix's return target is ${top}; only Review/QA send work there`);
    }
  }
  /*
   * 栈的形状：自底向顶严格递减（后压进来的必然更靠上游），且每一层都在当前阶段
   * 的严格下游（Fix 不在主线上，跳过和当前阶段的比较）。破了任何一条，弹栈就是
   * 往回抄近道 —— 一个「从 Spec 打回到 Build」的状态必须造不出来。
   */
  let below = state.phase === "Fix" ? -1 : ORDER_INDEX.get(state.phase)!;
  for (let level = state.returnStack.length - 1; level >= 0; level -= 1) {
    const entry = state.returnStack[level]!;
    const index = ORDER_INDEX.get(entry);
    if (index === undefined) {
      throw new InvalidStateError(`${entry} is not on the line and cannot be returned to`);
    }
    if (index <= below) {
      throw new InvalidStateError(
        `returnStack ${state.returnStack.join(">")} is not strictly downstream of ${state.phase}`,
      );
    }
    below = index;
  }
  // Terminal by name, not by "has no outgoing edge". Fix has no forward edge
  // either -- it leaves via the stack -- so deriving terminality from edges
  // would make `Fix/closed` representable, and a Change stranded there could
  // never be touched again.
  if (state.status === "closed" && state.phase !== TERMINAL_PHASE) {
    throw new InvalidStateError(
      `${state.phase} is closed but ${TERMINAL_PHASE} is the only terminal phase`,
    );
  }
  if (state.status === "closed" && state.returnStack.length > 0) {
    throw new InvalidStateError(
      "a closed Change still owes a return; the stack must be empty",
    );
  }
}

/**
 * The next state, or a throw. Total over legal input, and the single place
 * where a Change's position may change.
 */
export function transition(
  state: ChangeState,
  action: ChangeAction,
  options?: TransitionOptions,
): ChangeState {
  assertStateValid(state);
  const graph = options?.graph ?? DEFAULT_GRAPH;
  if (!isLegal(state, action, graph)) {
    throw new IllegalTransitionError(state, action);
  }

  switch (action) {
    case "start":
    case "retry":
      return { ...state, status: "running" };
    case "settle":
      return { ...state, status: "settled" };
    case "fail":
      return { ...state, status: "blocked" };
    case "reject":
      // Rejecting a design phase means "run another round here". Rejecting
      // Review or QA means the code is wrong, which is Fix's job -- and the
      // way back rides the same return stack every send-back rides.
      return sendsToFix(state.phase)
        ? {
            phase: "Fix",
            status: "pending",
            returnStack: [...state.returnStack, state.phase],
          }
        : { ...state, status: "pending" };
    case "sendBack": {
      const to = options?.to;
      if (to === undefined) {
        throw new SendBackTargetError("target_missing", state.phase);
      }
      if (!upstreamOf(state.phase, graph).includes(to)) {
        throw new SendBackTargetError("target_not_upstream", `${state.phase} -> ${to}`);
      }
      return {
        phase: to,
        status: "pending",
        returnStack: [...state.returnStack, state.phase],
      };
    }
    case "approve": {
      /*
       * 欠着回程就先还：栈非空说明**下游有阶段在等这份上游改完** —— 沿主线前进
       * 会把等的人晾在原地。Fix 的「回到发起方」是同一条规则的特例，不再特判。
       */
      const top = state.returnStack[state.returnStack.length - 1];
      if (top !== undefined) {
        return {
          phase: top,
          status: "pending",
          returnStack: state.returnStack.slice(0, -1),
        };
      }
      const next = advancesTo(state.phase, graph);
      return next === null
        ? { ...state, status: "closed" }
        : { phase: next, status: "pending", returnStack: [] };
    }
  }
}
