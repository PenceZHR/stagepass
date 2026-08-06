import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advancesTo,
  isPhase,
  PHASES,
  phaseGraphOf,
  TERMINAL_PHASE,
  upstreamOf,
  type Phase,
} from "./phase";
import {
  accepts,
  assertStateValid,
  CHANGE_ACTIONS,
  IllegalTransitionError,
  INITIAL_STATE,
  InvalidStateError,
  isLegal,
  PHASE_STATUSES,
  SendBackTargetError,
  transition,
  type ChangeState,
} from "./change-state";

/**
 * L0's acceptance evidence.
 *
 * Every assertion here runs with no database, no clock, no network and no
 * model. That is the whole point of the layer: if the foundation cannot be
 * proved without the things built on top of it, then nothing built on top can
 * be trusted to have a foundation.
 */

/** A state to probe from. Fix is the one phase that requires a return stack. */
function probe(phase: Phase, status: (typeof PHASE_STATUSES)[number]): ChangeState {
  return {
    phase,
    status,
    returnStack: phase === "Fix" ? ["Review"] : [],
  };
}

function representable(state: ChangeState): boolean {
  try {
    assertStateValid(state);
    return true;
  } catch {
    return false;
  }
}

describe("L0 · the state machine is exhaustively decided", () => {
  /**
   * The headline: every (phase, status, action) triple has a decided outcome,
   * and no triple is left to chance. A machine that is only tested on its happy
   * path is a machine whose illegal transitions are undefined behaviour.
   *
   * `sendBack` 要目标才走得动，穷举时给**最近的那个上游** —— 哪个上游不影响
   * 「这一步合法与否」，那由 upstreamOf 是不是空决定。
   */
  it("decides every phase x status x action triple", () => {
    let legal = 0;
    let rejected = 0;
    let unrepresentable = 0;

    for (const phase of PHASES) {
      for (const status of PHASE_STATUSES) {
        const state = probe(phase, status);
        if (!representable(state)) {
          unrepresentable += 1;
          continue;
        }
        for (const action of CHANGE_ACTIONS) {
          if (isLegal(state, action)) {
            const options = action === "sendBack"
              ? { to: upstreamOf(phase).at(-1) }
              : undefined;
            const next = transition(state, action, options);
            // Whatever comes out must itself be a state the machine would
            // accept back. Without this, one transition can strand the Change
            // somewhere no further transition can leave.
            assert.doesNotThrow(
              () => assertStateValid(next),
              `${phase}/${status} --${action}--> produced an invalid state`,
            );
            assert.ok(isPhase(next.phase));
            legal += 1;
          } else {
            assert.throws(
              () => transition(state, action),
              IllegalTransitionError,
              `${phase}/${status} must refuse ${action}`,
            );
            rejected += 1;
          }
        }
      }
    }

    // Stated so a shrinking machine is visible rather than silent: if a future
    // edit removes a phase, a status or an action, these numbers move and the
    // test says so instead of quietly covering less.
    assert.equal(
      legal + rejected + unrepresentable * CHANGE_ACTIONS.length,
      PHASES.length * PHASE_STATUSES.length * CHANGE_ACTIONS.length,
    );
    // 12 phases x (start 1 + settle/fail 2 + retry 1 + approve/reject 2)
    // + sendBack：主线上除 PRD 外的 10 个（PRD 没有上游，Fix 不在主线上）
    // + rerun：只有 Review 和 QA 两个（别处的 reject 已经是这个意思）。
    assert.equal(legal, 12 * (1 + 2 + 1 + 2) + 10 + 2);
    // `closed` is representable only on Done, so 11 phases contribute no state.
    assert.equal(unrepresentable, PHASES.length - 1);
    assert.equal(rejected, 308);
  });

  it("accepts nothing at all once closed", () => {
    assert.deepEqual(accepts("closed"), []);
    for (const action of CHANGE_ACTIONS) {
      assert.throws(
        () => transition(
          { phase: TERMINAL_PHASE, status: "closed", returnStack: [] },
          action,
        ),
        IllegalTransitionError,
      );
    }
  });
});

describe("L0 · every phase is reachable and Done is the only exit", () => {
  /** Breadth-first over the whole machine from the state a Change is created in. */
  function explore(): Map<string, ChangeState> {
    const seen = new Map<string, ChangeState>();
    const queue: ChangeState[] = [INITIAL_STATE];
    const key = (state: ChangeState) =>
      `${state.phase}/${state.status}/${state.returnStack.join(">") || "-"}`;
    seen.set(key(INITIAL_STATE), INITIAL_STATE);
    while (queue.length > 0) {
      const state = queue.shift()!;
      for (const action of CHANGE_ACTIONS) {
        if (!isLegal(state, action)) continue;
        // sendBack 的每个合法目标都是一条边，全走一遍 —— 图要探索完整。
        const nexts = action === "sendBack"
          ? upstreamOf(state.phase).map((to) => transition(state, action, { to }))
          : [transition(state, action)];
        for (const next of nexts) {
          if (seen.has(key(next))) continue;
          seen.set(key(next), next);
          queue.push(next);
        }
      }
    }
    return seen;
  }

  /**
   * A phase no walk can reach is a phase that exists only in the list. That is
   * exactly the shape of the thing this rebuild is removing: something that
   * looks implemented and is not.
   */
  it("reaches all twelve phases from a fresh Change", () => {
    const reached = new Set(
      [...explore().values()].map((state) => state.phase),
    );
    assert.deepEqual([...reached].sort(), [...PHASES].sort());
  });

  it("has exactly one state that nothing leaves", () => {
    const dead = [...explore().values()].filter(
      (state) => !CHANGE_ACTIONS.some((action) => isLegal(state, action)),
    );
    assert.deepEqual(dead, [
      { phase: TERMINAL_PHASE, status: "closed", returnStack: [] },
    ]);
  });

  it("only the terminal phase can close", () => {
    for (const phase of PHASES) {
      const terminal = advancesTo(phase) === null && phase !== "Fix";
      assert.equal(
        terminal,
        phase === TERMINAL_PHASE,
        `${phase} disagrees with the terminal definition`,
      );
    }
  });
});

describe("L0 · Fix returns to whoever sent it", () => {
  function settled(phase: Phase): ChangeState {
    return { phase, status: "settled", returnStack: [] };
  }

  /**
   * The bug this forbids: encoding Fix's exit as a constant edge, which sends
   * every QA failure back through Review.
   */
  for (const origin of ["Review", "QA"] as const) {
    it(`${origin} rejection goes to Fix and comes back to ${origin}`, () => {
      const toFix = transition(settled(origin), "reject");
      assert.deepEqual(toFix, {
        phase: "Fix",
        status: "pending",
        returnStack: [origin],
      });

      const fixed = transition(
        transition(transition(toFix, "start"), "settle"),
        "approve",
      );
      assert.deepEqual(fixed, {
        phase: origin,
        status: "pending",
        returnStack: [],
      });
    });
  }

  it("reopens a design phase in place rather than sending it to Fix", () => {
    for (const phase of ["PRD", "Spec", "TechSpec", "Plan", "TestPlan"] as const) {
      assert.deepEqual(transition(settled(phase), "reject"), {
        phase,
        status: "pending",
        returnStack: [],
      });
    }
  });

  it("reopens Fix in place when its own result is rejected", () => {
    assert.deepEqual(
      transition(
        { phase: "Fix", status: "settled", returnStack: ["QA"] },
        "reject",
      ),
      { phase: "Fix", status: "pending", returnStack: ["QA"] },
    );
  });
});

describe("L0 · 打回上游：长回边压栈，approve 弹栈（§5.9.1 / §5.9.2）", () => {
  /*
   * 在这之前 `ADVANCES_TO` 只有向前的边 —— Build 发现 Spec 错了，模型里没有
   * 任何一条边能把工作送回去，而 §5.5 整条反馈链路全靠它。
   * `returnPhase` 是单字段，存不下嵌套回跳 —— 所以是栈。Fix 用的是同一个栈。
   */
  const settled = (phase: Phase, stack: readonly Phase[] = []): ChangeState =>
    ({ phase, status: "settled", returnStack: stack });

  it("Build 发现 Spec 错了 —— 打回去，修完弹回 Build", () => {
    const atSpec = transition(settled("Build"), "sendBack", { to: "Spec" });
    assert.deepEqual(atSpec, {
      phase: "Spec", status: "pending", returnStack: ["Build"],
    });

    // Spec 重新跑完、批准 —— 不沿主线去 TechSpec，弹栈回 Build。
    const back = transition(
      transition(transition(atSpec, "start"), "settle"),
      "approve",
    );
    assert.deepEqual(back, {
      phase: "Build", status: "pending", returnStack: [],
    });
  });

  it("嵌套回跳 —— §5.9.2 的那个例子，单字段存不下的正是它", () => {
    // Build 发现 Spec 错 → 回 Spec。
    let state = transition(settled("Build"), "sendBack", { to: "Spec" });
    // Spec 改着改着发现 PRD 也错 → 再回 PRD。「回来之后去哪」现在有两个答案。
    state = transition(
      transition(transition(state, "start"), "settle"),
      "sendBack", { to: "PRD" },
    );
    assert.deepEqual(state, {
      phase: "PRD", status: "pending", returnStack: ["Build", "Spec"],
    });
    // PRD 批准 → 弹回 Spec（不是 Build，也不是主线的下一个）。
    state = transition(
      transition(transition(state, "start"), "settle"), "approve",
    );
    assert.deepEqual(state, {
      phase: "Spec", status: "pending", returnStack: ["Build"],
    });
    // Spec 批准 → 弹回 Build。栈空了，Build 从此照常走主线。
    state = transition(
      transition(transition(state, "start"), "settle"), "approve",
    );
    assert.deepEqual(state, {
      phase: "Build", status: "pending", returnStack: [],
    });
  });

  it("被打回的阶段「再来一轮」—— 栈原样带着，不丢", () => {
    assert.deepEqual(
      transition(settled("Spec", ["Build"]), "reject"),
      { phase: "Spec", status: "pending", returnStack: ["Build"] },
    );
  });

  it("没给目标 —— 拒绝，说清缺的是什么", () => {
    assert.throws(
      () => transition(settled("Build"), "sendBack"),
      (error: unknown) => error instanceof SendBackTargetError
        && error.code === "target_missing",
    );
  });

  it("目标不在严格上游 —— 拒绝（往下游「打回」不是回头，是抄近道）", () => {
    for (const to of ["Review", "Build", "Fix", "Done"] as const) {
      assert.throws(
        () => transition(settled("Build"), "sendBack", { to }),
        (error: unknown) => error instanceof SendBackTargetError
          && error.code === "target_not_upstream",
        `Build -> ${to} 应当被拒`,
      );
    }
  });

  it("PRD 没有上游 —— sendBack 根本不合法，和按钮死在界面上是两回事", () => {
    assert.equal(isLegal(settled("PRD"), "sendBack"), false);
    assert.throws(
      () => transition(settled("PRD"), "sendBack", { to: "PRD" }),
      IllegalTransitionError,
    );
  });

  it("Fix 不在主线上 —— sendBack 不合法（它的出口是弹栈）", () => {
    assert.equal(
      isLegal({ phase: "Fix", status: "settled", returnStack: ["QA"] }, "sendBack"),
      false,
    );
  });

  it("自定义图上目标合法性跟着图走", () => {
    const graph = phaseGraphOf(["PRD", "Build", "Review", "Done"]);
    // 全序里 Spec 在 Build 上游，但这张图没有 Spec —— 拒。
    assert.throws(
      () => transition(settled("Build"), "sendBack", { to: "Spec", graph }),
      (error: unknown) => error instanceof SendBackTargetError
        && error.code === "target_not_upstream",
    );
    assert.deepEqual(
      transition(settled("Build"), "sendBack", { to: "PRD", graph }),
      { phase: "PRD", status: "pending", returnStack: ["Build"] },
    );
  });
});

describe("L0 · a corrupted state cannot re-enter the machine", () => {
  it("refuses Fix without a return stack", () => {
    assert.throws(
      () => transition(
        { phase: "Fix", status: "settled", returnStack: [] },
        "approve",
      ),
      InvalidStateError,
    );
  });

  it("Fix 的栈顶必须是 Review 或 QA —— 只有它们送修", () => {
    assert.throws(
      () => transition(
        { phase: "Fix", status: "settled", returnStack: ["Build"] },
        "approve",
      ),
      InvalidStateError,
    );
  });

  it("栈里的每一层都必须在当前阶段的严格下游 —— 否则弹栈就是往回抄近道", () => {
    // Spec 在 Build 的上游：一个「从 Spec 打回到 Build」的状态造不出来，
    // 也不许从库里读回来。
    assert.throws(
      () => transition(
        { phase: "Build", status: "settled", returnStack: ["Spec"] },
        "approve",
      ),
      InvalidStateError,
    );
  });

  it("栈自底向顶必须严格递减 —— 后压进来的必然更靠上游", () => {
    assert.throws(
      () => transition(
        { phase: "PRD", status: "settled", returnStack: ["Build", "QA"] },
        "approve",
      ),
      InvalidStateError,
    );
  });

  it("refuses a closed status on a non-terminal phase", () => {
    assert.throws(
      () => transition(
        { phase: "Spec", status: "closed", returnStack: [] },
        "start",
      ),
      InvalidStateError,
    );
  });

  it("closed 不许带栈 —— 有人还在等回程的 Change 关不了", () => {
    assert.throws(
      () => assertStateValid(
        { phase: "Done", status: "closed", returnStack: ["Build"] },
      ),
      InvalidStateError,
    );
  });
});

describe("L0 · the walk a real Change takes", () => {
  it("goes from a fresh Change to closed with no illegal step", () => {
    let state = INITIAL_STATE;
    const visited: string[] = [state.phase];
    // Approve straight through: every phase runs once, settles once, passes.
    for (let guard = 0; guard < 100; guard += 1) {
      if (state.status === "closed") break;
      state = transition(state, "start");
      state = transition(state, "settle");
      state = transition(state, "approve");
      if (state.phase !== visited[visited.length - 1]) visited.push(state.phase);
    }
    assert.equal(state.status, "closed");
    assert.equal(state.phase, TERMINAL_PHASE);
    // Fix is absent: nothing was rejected, so nothing was sent back.
    assert.deepEqual(visited, [
      "PRD", "Spec", "TechSpec", "Plan", "TestPlan",
      "Build", "Review", "QA", "Merge", "Retro", "Done",
    ]);
  });

  it("子序列图上的同一条走法 —— 图是数据这句话的验收（§4.5）", () => {
    const graph = phaseGraphOf(["PRD", "Build", "Review", "Done"]);
    let state: ChangeState = INITIAL_STATE;
    const visited: string[] = [state.phase];
    for (let guard = 0; guard < 20; guard += 1) {
      if (state.status === "closed") break;
      state = transition(state, "start", { graph });
      state = transition(state, "settle", { graph });
      state = transition(state, "approve", { graph });
      if (state.phase !== visited[visited.length - 1]) visited.push(state.phase);
    }
    assert.equal(state.status, "closed");
    assert.deepEqual(visited, ["PRD", "Build", "Review", "Done"]);
  });
});

describe("L0 · Review/QA 也要能「就在这儿再来一轮」（旧账 F）", () => {
  /*
   * `reject` 在这两个阶段的语义是**送修**（→ Fix）。于是「这一轮方法不对，
   * 再跑一次」没有自己的动作 —— 唯一出路是绕道 Fix：在一份根本没问题的代码上
   * 跑一轮修理，只为了回到 Review 再审一次。2026-08-02 记下的账，一直没还。
   */
  const settled = (phase: Phase): ChangeState =>
    ({ phase, status: "settled", returnStack: [] });

  for (const phase of ["Review", "QA"] as const) {
    it(`${phase} 可以原地再来一轮 —— 阶段、栈都不动`, () => {
      assert.deepEqual(transition(settled(phase), "rerun"), {
        phase, status: "pending", returnStack: [],
      });
    });
  }

  it("**设计阶段没有这个动作** —— 那儿的 reject 已经是这个意思，两条路一个意思不许并存", () => {
    for (const phase of ["PRD", "Spec", "TechSpec", "Plan", "TestPlan", "Build"] as const) {
      assert.equal(isLegal(settled(phase), "rerun"), false, phase);
      assert.throws(() => transition(settled(phase), "rerun"), IllegalTransitionError);
    }
  });

  it("被打回的 Review 原地再来一轮 —— 欠着的回程还欠着", () => {
    assert.deepEqual(
      transition({ phase: "QA", status: "settled", returnStack: [] }, "rerun"),
      { phase: "QA", status: "pending", returnStack: [] },
    );
    // Fix 自己不在此列：它的 reject 已经是原地重开（上面那条测试盯着）。
    assert.equal(
      isLegal({ phase: "Fix", status: "settled", returnStack: ["Review"] }, "rerun"), false);
  });

  it("只有 settled 能再来一轮 —— running / blocked 各有各的动作", () => {
    for (const status of ["pending", "running", "blocked"] as const) {
      assert.equal(isLegal({ phase: "Review", status, returnStack: [] }, "rerun"), false, status);
    }
  });
});
