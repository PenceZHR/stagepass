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
  /**
   * 就在这儿再来一轮 —— **只有 Review/QA 有**（2026-08-02 记的旧账 F）。
   *
   * 那两个阶段的 `reject` 语义是**送修**（→ Fix），于是「这一轮方法不对，
   * 再跑一次」没有自己的动作：唯一出路是绕道 Fix，在一份根本没问题的代码上
   * 跑一轮修理，只为了回到 Review 再审一次。
   *
   * **别的阶段没有这个动作**：那儿的 `reject` 已经就是这个意思，两条路一个
   * 意思是这棵树一直在删的东西。
   */
  "rerun",
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
  settled: ["approve", "reject", "sendBack", "rerun"],
  blocked: ["retry"],
  closed: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly state: ChangeState,
    readonly action: ChangeAction,
  ) {
    /*
     * **报的必须是真正挡住它的那一条。**
     *
     * 原来一律打印 `ACCEPTS[status]`，于是 Fix 上 sendBack 报出来是
     * 「sendBack is not legal …（accepts: approve, reject, **sendBack**, rerun）」
     * —— 自己列着它，又说它不行。真实原因是阶段的属性（Fix 不在主线上，没有
     * 上游可回），而它整句话都没出现（2026-08-06 查 §8.10 时撞到）。
     *
     * 一条自相矛盾的报错比没有报错更贵：读的人会去查状态表，而错不在那儿。
     */
    const acceptsIt = ACCEPTS[state.status].includes(action);
    super(
      `${action} is not legal in ${state.phase}/${state.status}`
      + (acceptsIt
        ? ` (${state.status} accepts it, but ${state.phase} does not:`
          + ` ${action === "sendBack"
            ? "no upstream to send back to -- PRD has none, Fix is not on the line"
            : "only Review/QA can rerun in place"})`
        : ` (accepts: ${ACCEPTS[state.status].join(", ") || "nothing"})`),
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

/**
 * 人选的批准目标不在清单里。
 *
 * **把清单一起报出去**：这条错误是「你选的这条不行」，而人接下来要问的必然是
 * 「那能选哪些」。少了后半句，界面只能说一句「不行」，人得再猜一次。
 */
export class ApprovalTargetError extends Error {
  constructor(
    readonly detail: string,
    readonly targets: readonly Phase[],
  ) {
    super(`approve target not available: ${detail}`
      + ` (available: ${targets.join(", ") || "nothing"})`);
    this.name = "ApprovalTargetError";
  }
}

export interface TransitionOptions {
  /**
   * `sendBack` 和 `approve` 的目标。别的动作不读它。
   *
   * `approve` **不给就是走推荐的那条**（`approvalTargets` 的第一条），也就是这个
   * 参数出现之前的行为 —— 所有老调用点一个字都不用改。
   */
  readonly to?: Phase | undefined;
  /** 这个 Change 走的图。缺省 = 全序（DEFAULT_GRAPH）。 */
  readonly graph?: PhaseGraph | undefined;
}

/**
 * 批准之后能去哪。**第一条是推荐，其余是人可以自己选的**（BACKLOG §8.10）。
 *
 * > 系统做出来的箭头是给用户一个大概的指示，具体怎么做用户可以自己调整进哪一个
 * > 阶段 —— 我给一个 recommendation，但具体怎么做还是用户自己 decide。
 * > （用户 2026-08-05）
 *
 * ## 清单里每一条都是合法的，所以两条硬校验一个字不用动
 *
 * 用户 2026-08-06 拍板「只补能力，不碰那两条校验」。这个函数就是那句话的落点：
 * 它**只列出走过去之后状态仍然成立的阶段**，于是 `assertStateValid` 那条「回程栈
 * 必须严格下游」永远不会因为人的选择而红。
 *
 * 上界因此是**栈顶**：栈顶在等这份改完，跳到它后面去，回程栈就不再严格下游 ——
 * 那正是「一个没有出口的格子」。栈空时没人在等，上界是主线末尾。
 *
 * ## 清单按**主线顺序**排，推荐是另一个具名的东西
 *
 * 第一版把推荐排到第一位，于是「沿主线走一步」变成了靠位置去数 —— 栈空时是
 * `[0]`，栈非空时是 `[1]`。这棵树已经有一条被这个咬过的记录（裁决表「靠位置
 * 对应回来」）。所以顺序就是顺序，「推荐哪一条」问 `recommendedApproval`。
 */
export function approvalTargets(
  state: ChangeState,
  graph: PhaseGraph = DEFAULT_GRAPH,
): Phase[] {
  const top = state.returnStack[state.returnStack.length - 1];
  /*
   * **主线的下一步只有一份实现**（`advancesTo`），这里从它接着往下数。
   *
   * 它同时替我们处理了 Fix：`advancesTo("Fix")` 是 null —— Fix 不在主线上，
   * 没有「往下一个阶段走」可言，唯一的出口就是还债。
   */
  const next = advancesTo(state.phase, graph);
  if (next === null) return top === undefined ? [] : [top];

  const from = graph.order.indexOf(next);
  const until = top === undefined
    ? graph.order.length - 1          // 没人在等 —— 主线末尾之内随便挑
    : graph.order.indexOf(top);       // 有人在等 —— 最远只能到他那儿（含）
  return graph.order.slice(from, until + 1);
}

/**
 * 批准时**推荐**走哪一条：欠着回程就还债（栈顶），否则沿主线走一步。
 * `null` = 主线走到头了、也没人在等 —— 那时批准就是关掉这个 Change。
 *
 * **这是「批准默认去哪」的唯一一份实现。** 在它之前 `transition` 和
 * `optionsFrom` 各写了一遍（后者的注释还写着「和 transition 的 approve 同一条
 * 规则」—— 一句只能靠人记得的话）。
 *
 * §8.9 想改的正是这一条。它想要的那条路（沿主线重走回去）已经在
 * `approvalTargets` 里了，人选得到，只是还不是推荐。
 */
export function recommendedApproval(
  state: ChangeState,
  graph: PhaseGraph = DEFAULT_GRAPH,
): Phase | null {
  return state.returnStack[state.returnStack.length - 1]
    ?? advancesTo(state.phase, graph);
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
  // 原地再来一轮只有 Review/QA 有 —— 别处的 `reject` 已经就是这个意思。
  // 同一个判据（`sendsToFix`）在这儿和 `reject` 的落点上各用一次，不另算一套。
  if (action === "rerun") return sendsToFix(state.phase);
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
    case "rerun":
      // 阶段不动、栈不动 —— 和设计阶段的 `reject` 落点逐字一样。被打回来的
      // Review 原地再跑一轮，它欠着的回程照旧欠着。
      return { ...state, status: "pending" };
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
      const targets = approvalTargets(state, graph);
      /*
       * **不给目标 = 走推荐的那条**，也就是这个参数出现之前的行为。
       *
       * 给了目标就按人选的走 —— 清单里每一条都合法（见 `approvalTargets`），
       * 所以这里只需要确认他选的确实在清单里。
       */
      const to = options?.to ?? recommendedApproval(state, graph);
      if (to === null || to === undefined) {
        // 主线走到头了：没有下一个阶段，也没人在等 —— 这个 Change 结束了。
        return { ...state, status: "closed" };
      }
      if (!targets.includes(to)) {
        throw new ApprovalTargetError(
          `${state.phase} -> ${to}`, targets,
        );
      }
      /*
       * **走到栈顶就是还债，弹掉它；没走到就是沿路重走，栈原样带着。**
       *
       * 后者是 §8.10 补出来的新路：`Review --sendBack--> TestPlan`，批准 TestPlan
       * 时选 Build 而不是 Review，于是 Build 会对着改过的测试重跑一次，再回 Review。
       * 那正是 §8.9 想要的形状 —— 现在它是**人可以选的一条**，还不是默认。
       */
      const top = state.returnStack[state.returnStack.length - 1];
      return {
        phase: to,
        status: "pending",
        returnStack: to === top ? state.returnStack.slice(0, -1) : state.returnStack,
      };
    }
  }
}
