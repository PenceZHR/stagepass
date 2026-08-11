import {
  advancesTo,
  DEFAULT_GRAPH,
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
  /**
   * `reject` 在**每个**阶段都是「就在这儿再来一轮」。
   *
   * 环 v3 之前 Review/QA 的 reject 被「送修」（→ Fix）占用，于是原地重跑只好
   * 另设一个 `rerun` 动作。Fix 退休后 reject 恢复本义，rerun 变成它的第二个
   * 名字 —— 两条路一个意思，是这棵树一直在删的东西，所以 rerun 一起删了。
   * QA 的「代码错了」走 `sendBack`（三向归因：Build / Test / Arch，人选目标）。
   */
  "approve",
  "reject",
  /**
   * 打回上游（长回边，§5.9.1）：这个阶段发现某份**上游产物**错了，把工作送回去改。
   * 带目标（`TransitionOptions.to`），目标必须在严格上游。
   * 环 UI 上它就是「Fix 交互」：打回箭头 + 重开座位，不占站位。
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
   * 空栈 = 正常沿主线走。只有一种动作压栈：打回上游（`sendBack`，压发起的
   * 阶段）。被打回的阶段 approve 时沿主线重走（§8.9），走到栈顶就是还债。
   * （环 v3 之前 Review/QA 送修 → Fix 也压这个栈 —— Fix 退休后那条路没了。）
   *
   * 原来是单字段 `returnPhase`，而单字段存不下嵌套回跳：Build 打回 Spec 之后，
   * Spec 又发现 PRD 错了 —— 这时「回来之后去哪」有两个答案要记（§5.9.2 的例子）。
   *
   * 不变量（`assertStateValid`）：自底向顶严格递减（后压进来的必然更靠上游）、
   * 每一层都在当前阶段的严格下游、closed 时栈空。
   */
  readonly returnStack: readonly Phase[];
}

/**
 * The only actions each status accepts. This table IS the state machine; the
 * transition function below decides where an accepted action lands, never
 * whether it was allowed.
 *
 * `sendBack` 在表里挂在 `settled` 下，但它还多一道判据：**当前阶段得有上游**
 * （PRD 没有）—— 那一半在 `isLegal` 里，因为它取决于阶段，不取决于状态。
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
          + " no upstream to send back to -- the first phase has none)"
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
  // **主线的下一步只有一份实现**（`advancesTo`），这里从它接着往下数。
  const next = advancesTo(state.phase, graph);
  if (next === null) return top === undefined ? [] : [top];

  const from = graph.order.indexOf(next);
  const until = top === undefined
    ? graph.order.length - 1          // 没人在等 —— 主线末尾之内随便挑
    : graph.order.indexOf(top);       // 有人在等 —— 最远只能到他那儿（含）
  /*
   * **在等的那个已经不在这个 Change 的图上了** —— 项目的 `phase_order` 在打回
   * 之后被改过（阶段图是数据，§4.5）。那时唯一走得通的就是还债：清单空着而推荐
   * 指着他，`transition` 会当场拒，而批准正是还债的唯一出口 —— **一个没有出口
   * 的格子**，恰恰是那两条硬校验存在的理由。
   *
   * 债照还，栈照弹。图变了不该把一个已经欠着的 Change 锁死。
   */
  if (top !== undefined && until === -1) return [top];
  return graph.order.slice(from, until + 1);
}

/**
 * 批准时**推荐**走哪一条：**沿主线走一步**，走到发起方就还债。
 * `null` = 主线走到头了、也没人在等 —— 那时批准就是关掉这个 Change。
 *
 * **这是「批准默认去哪」的唯一一份实现。** 在它之前 `transition` 和
 * `optionsFrom` 各写了一遍（后者的注释还写着「和 transition 的 approve 同一条
 * 规则」—— 一句只能靠人记得的话）。
 *
 * ## §8.9：回程是**重走**，不是跳回（2026-08-06 反转）
 *
 * 这里原来的规则是「欠着回程就先还债」—— 栈非空直接弹到栈顶。理由写着
 * 「沿主线前进会把等的人晾在原地」。**那个理由是错的**，代价是：
 *
 * ```
 * QA --sendBack--> TestPlan --approve--> QA        ← Test 被跳过
 * ```
 *
 * 测试方案改了，而 **Test 从来没对着新方案重写过测试**，QA 接着跑的就是那套
 * 按旧方案写出来的用例。不止 TestPlan 这一处：主线本身是一条依赖链，打回到任何
 * 阶段，中间被跳过的阶段**没有任何「你的产物过期了」的标记**。
 *
 * 用户 2026-08-06 的原话定的这一条：
 *
 * > **我现在不能默认当前 stage 之前的每个 stage 都是绝对正确的。**
 *
 * 跳回正是那个「默认它们是对的」。所以改成沿主线重走 —— 走到栈顶时 `advancesTo`
 * 自然就等于栈顶，那一步同时也是还债，不用特判。
 *
 * **代价是越早打回越贵**：QA 打回到 Spec 就要重走 Arch / BuildPlan / TestPlan /
 * Build / Test 再回 QA。缓解不在这一层，在**提示词**：重走那一轮的题面该说
 * 「按这条改动**更新**你已有的产物」，而不是「重写一份」（BACKLOG §8.9）。
 */
export function recommendedApproval(
  state: ChangeState,
  graph: PhaseGraph = DEFAULT_GRAPH,
): Phase | null {
  const top = state.returnStack[state.returnStack.length - 1];
  /*
   * 在等的那个已经不在这个 Change 的图上了（`phase_order` 在打回之后被改过）——
   * 那时只剩还债一条路。判断和 `approvalTargets` 里那处是同一条，两边必须一致：
   * 推荐要是不在清单里，`transition` 会当场拒，而批准是还债的唯一出口。
   */
  if (top !== undefined && graph.order.indexOf(top) === -1) return top;
  return advancesTo(state.phase, graph) ?? top ?? null;
}

export function isLegal(
  state: ChangeState,
  action: ChangeAction,
  graph: PhaseGraph = DEFAULT_GRAPH,
): boolean {
  if (!ACCEPTS[state.status].includes(action)) return false;
  // 打回要有地方可回：PRD 没有上游。这一半是阶段的属性，
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
  /*
   * 栈的形状：自底向顶严格递减（后压进来的必然更靠上游），且每一层都在当前阶段
   * 的严格下游。破了任何一条，弹栈就是往回抄近道 —— 一个「从 Spec 打回到
   * Build」的状态必须造不出来。
   * （环 v3 之前这里还有一段 Fix 专属校验 —— 栈非空、栈顶必须 Review/QA。
   * Fix 退休后它成了普通的「不在主线上」，下面那句通用报错接管。）
   */
  /*
   * 不在主线图上的阶段（退休的）没有下标 —— 用 -1，让栈上每一层都算在它下游。
   * 原来写的是 `ORDER_INDEX.get(...)!`，那个 `!` 在退休阶段上会拿到 undefined，
   * 于是下面每次比较都是 false —— **整条栈序校验被静默关掉**，而它守的正是
   * 「弹栈不许往回抄近道」。
   */
  let below = ORDER_INDEX.get(state.phase) ?? -1;
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
      // 每个阶段的 reject 都是「就在这儿再来一轮」：阶段不动、栈不动 ——
      // 欠着的回程照旧欠着。「产物没错、是别人错了」不走这儿，走 sendBack。
      return { ...state, status: "pending" };
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
       * 后者是 §8.10 补出来的新路：`QA --sendBack--> TestPlan`，批准 TestPlan
       * 时选 Test 而不是 QA，于是 Test 会对着改过的方案重写一次，再回 QA。
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
