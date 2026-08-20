import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advancesTo,
  isPhase,
  isRetired,
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
  InvalidStateError,
  approvalTargets,
  ApprovalTargetError,
  recommendedApproval,
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

function probe(phase: Phase, status: (typeof PHASE_STATUSES)[number]): ChangeState {
  return { phase, status, returnStack: [] };
}

function representable(state: ChangeState): boolean {
  try {
    assertStateValid(state);
    return true;
  } catch {
    return false;
  }
}

/** 这些测试共用的起点夹具。生产的起点归项目的图管（`ChangeStore.create` 取
 *  `graphFor(projectId).order[0]`），全序图下就是 PRD。 */
const INITIAL_STATE: ChangeState = {
  phase: "PRD",
  status: "pending",
  returnStack: [],
};

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
      // 退休的阶段不在图上 —— `advancesTo` 对它抛，穷举它没有意义（也走不到）。
      if (isRetired(phase)) continue;
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
    // 退休的阶段整个跳过了，所以基数按「还在用的那些」算。
    const live = PHASES.filter((phase) => !isRetired(phase)).length;
    assert.equal(live, 8);
    assert.equal(
      legal + rejected + unrepresentable * CHANGE_ACTIONS.length,
      live * PHASE_STATUSES.length * CHANGE_ACTIONS.length,
    );
    // 8 phases x (start 1 + settle/fail 2 + retry 1 + approve/reject 2)
    // + sendBack：主线上除 PRD 外的 7 个（PRD 没有上游）。
    // rerun 没了：环 v3 里 reject 在每个阶段都是「原地再来一轮」，rerun 是它的
    // 第二个名字 —— 两条路一个意思，是这棵树一直在删的东西。
    assert.equal(legal, 8 * (1 + 2 + 1 + 2) + 7);
    // `closed` is representable only on the terminal phase (QA).
    assert.equal(unrepresentable, live - 1);
    assert.equal(rejected, 176);
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

describe("L0 · every phase is reachable and QA is the only exit", () => {
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
  it("reaches every phase that is still on the line", () => {
    const reached = new Set(
      [...explore().values()].map((state) => state.phase),
    );
    /*
     * 退休的阶段走不到 —— 那正是「退休」的意思（`domain/phase.ts` 的
     * `RETIRED_PHASES`：名字留给历史，主线上没有它）。名单里刨掉它们之后，
     * 剩下的每一个都必须走得到 —— 一个走不到的阶段是「看起来实现了、其实没有」，
     * 而这棵树存在的理由就是删掉那种东西。
     */
    assert.deepEqual(
      [...reached].sort(),
      PHASES.filter((phase) => !isRetired(phase)).sort(),
    );
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
      // 退休的阶段不在图上，`advancesTo` 对它抛 —— 它不参与「谁是终点」这个问题。
      if (isRetired(phase)) continue;
      assert.equal(
        advancesTo(phase) === null,
        phase === TERMINAL_PHASE,
        `${phase} disagrees with the terminal definition`,
      );
    }
  });
});

/**
 * 环 v3：**reject 在每个阶段都是「就在这儿再来一轮」。**
 *
 * 之前 Review/QA 的 reject 是「送修 → Fix」，于是原地重跑只好另设 `rerun`。
 * Fix 退休后 reject 恢复本义，rerun 连同送修机械一起拆掉 —— 「代码错了」是
 * 另一个动作（sendBack，三向归因），不再借 reject 的壳。
 */
describe("L0 · reject 处处都是原地再来一轮", () => {
  function settled(phase: Phase): ChangeState {
    return { phase, status: "settled", returnStack: [] };
  }

  it("每个主线阶段的 reject 都原地重开 —— QA 也不例外", () => {
    for (const phase of PHASES) {
      if (isRetired(phase)) continue;
      assert.deepEqual(transition(settled(phase), "reject"), {
        phase, status: "pending", returnStack: [],
      }, phase);
    }
  });

  it("QA 说「代码错了」走 sendBack，三向归因：Build / Test / Arch 都在名单上", () => {
    for (const to of ["Build", "Test", "Arch"] as const) {
      assert.deepEqual(transition(settled("QA"), "sendBack", { to }), {
        phase: to, status: "pending", returnStack: ["QA"],
      }, to);
    }
  });
});

describe("L0 · 打回上游：长回边压栈，approve 弹栈（§5.9.1 / §5.9.2）", () => {
  /*
   * 在这之前 `ADVANCES_TO` 只有向前的边 —— Build 发现 Spec 错了，模型里没有
   * 任何一条边能把工作送回去，而 §5.5 整条反馈链路全靠它。
   * `returnPhase` 是单字段，存不下嵌套回跳 —— 所以是栈。
   */
  const settled = (phase: Phase, stack: readonly Phase[] = []): ChangeState =>
    ({ phase, status: "settled", returnStack: stack });

  /**
   * §8.9（2026-08-06 反转）：**回程是重走，不是跳回。**
   *
   * Spec 改了，而 Arch / BuildPlan / TestPlan 全是照旧 Spec 建的，一个都没重跑，
   * Build 却已经拿着它们接着干了 —— 用户的原话定的这一反转：
   *
   * > 我不能默认当前 stage 之前的每个 stage 都是绝对正确的。
   */
  it("Build 发现 Spec 错了 —— 打回去，**修完沿主线一路重走回来**", () => {
    const atSpec = transition(settled("Build"), "sendBack", { to: "Spec" });
    assert.deepEqual(atSpec, {
      phase: "Spec", status: "pending", returnStack: ["Build"],
    });

    // 一路批准，每一步都走主线的下一站，栈原样带着。
    const walked: Phase[] = [];
    // 显式标类型：上面那句 `assert.deepEqual` 是 assertion 签名，会把 `atSpec`
    // 收窄成一个交叉类型，再赋一个普通 `ChangeState` 就不过检查了。
    let state: ChangeState = atSpec;
    while (state.returnStack.length > 0) {
      state = transition(transition(transition(state, "start"), "settle"), "approve");
      assertStateValid(state);
      walked.push(state.phase);
    }
    assert.deepEqual(
      walked, ["Arch", "BuildPlan", "TestPlan", "Build"],
      "中间几个阶段的产物都是照旧 Spec 建的，一个都不许跳过",
    );
    assert.deepEqual(state.returnStack, [], "走到发起方，债还清");
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
    // PRD 批准 → Spec。它同时是主线的下一站**和**栈顶，所以这一步顺带还了一笔债。
    state = transition(
      transition(transition(state, "start"), "settle"), "approve",
    );
    assert.deepEqual(state, {
      phase: "Spec", status: "pending", returnStack: ["Build"],
    });
    // Spec 批准 → Arch（§8.9：沿主线重走，不跳回 Build），栈原样带着。
    state = transition(
      transition(transition(state, "start"), "settle"), "approve",
    );
    assert.deepEqual(state, {
      phase: "Arch", status: "pending", returnStack: ["Build"],
    });
    // 一路走到 Build，债才还清。
    while (state.returnStack.length > 0) {
      state = transition(transition(transition(state, "start"), "settle"), "approve");
    }
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

  /**
   * **两轨互盲也在这儿受检**：TestPlan 在主线顺序上排在 Build 前面，但它不是
   * Build 的上游（Build 只消费 BuildPlan）——「从 Build 打回 TestPlan」是一条
   * 必然说不通的边，必须拒。
   */
  it("目标不在严格上游 —— 拒绝（下游、平行轨、退休的都一样）", () => {
    for (const to of ["Test", "QA", "TestPlan", "Fix", "Review"] as const) {
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

  it("自定义图上目标合法性跟着图走", () => {
    const graph = phaseGraphOf(["PRD", "Build", "QA"]);
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
  it("栈里躺着退休的阶段 —— 拒：没有任何一条路能弹回一个不在主线上的地方", () => {
    // 老库的送修栈帧（Fix 时代压的 Review）读回来就是这个形状。
    assert.throws(
      () => transition(
        { phase: "Spec", status: "settled", returnStack: ["Review"] },
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
        { phase: TERMINAL_PHASE, status: "closed", returnStack: ["Build"] },
      ),
      InvalidStateError,
    );
  });

  it("停在退休阶段上的历史行仍然读得出 —— 校验放行，转移才拒", () => {
    // CHG-001 在 TechSpec 退休时正停在它上面 —— 读得出是硬要求（RETIRED_PHASES
    // 存在的理由）。校验只管形状，不管「它还在不在图上」。
    assert.doesNotThrow(() => assertStateValid(
      { phase: "TechSpec", status: "settled", returnStack: [] },
    ));
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
    assert.deepEqual(visited, [
      "PRD", "Spec", "Arch", "BuildPlan", "TestPlan", "Build", "Test", "QA",
    ]);
  });

  it("子序列图上的同一条走法 —— 图是数据这句话的验收（§4.5）", () => {
    const graph = phaseGraphOf(["PRD", "Build", "QA"]);
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
    assert.deepEqual(visited, ["PRD", "Build", "QA"]);
  });
});

/**
 * §8.10：**箭头是推荐，不是强制。**
 *
 * > 系统做出来的箭头是给用户一个大概的指示，具体怎么做用户可以自己调整进哪一个
 * > 阶段 —— 我给一个 recommendation，但具体怎么做还是用户自己 decide。
 * > （用户 2026-08-05）
 *
 * 用户 2026-08-06 拍板的落法：**只补能力，不碰那两条硬校验**。所以这一组测试
 * 钉的不只是「人能选别的」，更是「**清单里每一条走过去，状态都还成立**」——
 * 后者才是那两条校验不用动的理由。
 */
describe("L0 · 批准之后去哪：推荐 + 清单（§8.10）", () => {
  const settled = (phase: Phase, stack: readonly Phase[] = []): ChangeState =>
    ({ phase, status: "settled", returnStack: stack });

  it("**推荐永远在清单里** —— 一个选不了的推荐比没有推荐更糟", () => {
    for (const state of [
      settled("PRD"), settled("Build"), settled("TestPlan", ["QA"]),
      settled("Spec", ["Build"]),
    ]) {
      const recommended = recommendedApproval(state);
      assert.ok(recommended !== null);
      assert.ok(
        approvalTargets(state).includes(recommended),
        `${state.phase}/${state.returnStack.join(">") || "-"}：推荐的 ${recommended} 不在清单里`,
      );
    }
    // 走到头了：没有推荐，清单也是空的 —— 批准就是关掉这个 Change。
    assert.equal(recommendedApproval(settled(TERMINAL_PHASE)), null);
    assert.deepEqual(approvalTargets(settled(TERMINAL_PHASE)), []);
  });

  it("栈空时推荐就是主线的下一步 —— 不许和 `advancesTo` 各算一套", () => {
    for (const phase of PHASES) {
      if (isRetired(phase)) continue;
      assert.equal(recommendedApproval(settled(phase)), advancesTo(phase), phase);
    }
  });

  it("不给目标 = 走推荐那条 —— 老调用点一个字都不用改", () => {
    for (const state of [
      settled("Spec"), settled("TestPlan", ["QA"]), settled("Build", ["QA"]),
    ]) {
      assert.equal(
        transition(state, "approve").phase, recommendedApproval(state),
        `${state.phase}/${state.returnStack.join(">") || "-"}`,
      );
    }
  });

  /**
   * **上界是栈顶，而这正是那两条硬校验不用动的原因。**
   *
   * 栈顶在等这份改完；跳到它后面去，回程栈就不再严格下游 —— 那正是
   * `assertStateValid` 挡的「一个没有出口的格子」。清单里根本不放这种选项，
   * 于是人怎么选都不会撞上它。
   */
  it("有人在等的时候，最远只能走到他那儿", () => {
    // QA 打回 TestPlan（测试方案错了）：中间能顺路重走的加上在等的 QA。
    assert.deepEqual(
      approvalTargets(settled("TestPlan", ["QA"])),
      ["Build", "Test", "QA"],
    );
    assert.deepEqual(
      approvalTargets(settled("Spec", ["Build"])),
      ["Arch", "BuildPlan", "TestPlan", "Build"],
    );
    // 推荐是主线的下一站（§8.9 反转之后），不是直接跳回在等的那个。
    assert.equal(recommendedApproval(settled("TestPlan", ["QA"])), "Build");
    // 走到发起方那一步，推荐才是他 —— 那一步既是前进也是还债。
    assert.equal(recommendedApproval(settled("Test", ["QA"])), "QA");
  });

  it("没人在等的时候，主线后面的都能挑 —— 跳过阶段是允许的", () => {
    assert.deepEqual(approvalTargets(settled("Build")), ["Test", "QA"]);
    assert.deepEqual(approvalTargets(settled(TERMINAL_PHASE)), []);
  });

  /**
   * **图是数据（§4.5），所以图会变。** 打回之后项目把在等的那个阶段从
   * `phase_order` 里去掉了 —— 那时清单不能是空的：批准是还债的唯一出口，空清单
   * 会把一个已经欠着的 Change 锁死在一个没有出口的格子里。
   */
  it("在等的那个已经不在图上了 —— 债照还，不许把 Change 锁死", () => {
    // Test 打回 TestPlan 之后，项目把 Test 从图里去掉了。
    const shrunk = phaseGraphOf(
      ["PRD", "Spec", "Arch", "BuildPlan", "TestPlan", "Build", "QA"]);
    const state = settled("TestPlan", ["Test"]);
    assert.deepEqual(approvalTargets(state, shrunk), ["Test"]);
    assert.equal(recommendedApproval(state, shrunk), "Test");
    assert.deepEqual(
      transition(state, "approve", { graph: shrunk }),
      { phase: "Test", status: "pending", returnStack: [] },
    );
  });

  /**
   * **§8.9 想要的那条路，现在是人可以选的一条。**
   *
   * `QA --sendBack--> TestPlan`，批准 TestPlan 时选 Build 而不是 QA —— 于是
   * Build / Test 会对着改过的方案重走一遍，再回 QA。默认还是推荐那条
   * （主线下一站），选哪条归人。
   */
  it("选「顺路重走」而不是「直接弹回」—— 栈原样带着，走到发起方才还", () => {
    const atTestPlan = transition(settled("QA"), "sendBack", { to: "TestPlan" });
    assert.deepEqual(atTestPlan.returnStack, ["QA"]);

    // 批准 TestPlan，但选 Build（清单里的一条）—— 栈不动，QA 还欠着。
    const atBuild = transition(
      { ...atTestPlan, status: "settled" }, "approve", { to: "Build" });
    assert.deepEqual(atBuild, {
      phase: "Build", status: "pending", returnStack: ["QA"],
    });
    // 走过来的状态必须还是合法的 —— 那两条硬校验一个字没动，这里就是它们在验。
    assertStateValid(atBuild);

    // Build 批准（不给目标）→ Test → QA，走到发起方债才还清。
    const atTest = transition({ ...atBuild, status: "settled" }, "approve");
    assert.deepEqual(atTest, {
      phase: "Test", status: "pending", returnStack: ["QA"],
    });
    assert.deepEqual(
      transition({ ...atTest, status: "settled" }, "approve"),
      { phase: "QA", status: "pending", returnStack: [] },
    );
  });

  it("嵌套打回也能一路重走回来，每一步的状态都合法", () => {
    // Build 发现 Spec 错 → 回 Spec；Spec 发现 PRD 错 → 再回 PRD。
    let state = transition(settled("Build"), "sendBack", { to: "Spec" });
    state = transition({ ...state, status: "settled" }, "sendBack", { to: "PRD" });
    assert.deepEqual(state.returnStack, ["Build", "Spec"]);

    // 一路选「顺路重走」，直到栈空回到 Build。
    const walked: Phase[] = [];
    for (let step = 0; step < 8 && state.returnStack.length > 0; step += 1) {
      // 清单按主线顺序排，所以第一条就是「往主线再走一步」= 顺路重走。
      const to = approvalTargets({ ...state, status: "settled" })[0]!;
      state = transition({ ...state, status: "settled" }, "approve", { to });
      assertStateValid(state);
      walked.push(state.phase);
    }
    assert.deepEqual(
      walked, ["Spec", "Arch", "BuildPlan", "TestPlan", "Build"],
      "中间的阶段一个都没被跳过，而栈也一路还干净了",
    );
    assert.deepEqual(state.returnStack, []);
  });

  it("**清单外的一律拒，而且把清单一起报出去**", () => {
    for (const [state, to] of [
      [settled("Spec"), "PRD"],                       // 往回走不是批准
      [settled("Spec"), "Spec"],                      // 原地不是批准
      [settled("BuildPlan", ["Build"]), "Test"],      // 越过在等的那个
    ] as const) {
      assert.throws(
        () => transition(state, "approve", { to }),
        (error: unknown) => {
          assert.ok(error instanceof ApprovalTargetError, `${state.phase} -> ${to}`);
          // 人接下来必然要问「那能选哪些」—— 少了后半句，界面只能说一句「不行」。
          assert.deepEqual([...error.targets], approvalTargets(state));
          return true;
        },
      );
    }
  });
});

/**
 * 报错要报**真正挡住它的那一条**。
 *
 * 原来一律打印 `ACCEPTS[status]`，于是没有上游的阶段上 sendBack 报出来是
 * 「不合法（accepts: … sendBack …）」—— 自己列着它，又说它不行，而真实原因
 * （没有上游可回）整句话都没出现。一条自相矛盾的报错比没有报错更贵。
 */
describe("L0 · 拒绝一个动作时，说的是真正挡住它的那条", () => {
  it("PRD 上 sendBack —— 说的是「没有上游可回」，不是甩一张状态表", () => {
    assert.throws(
      () => transition({ phase: "PRD", status: "settled", returnStack: [] },
        "sendBack", { to: "PRD" }),
      (error: unknown) => {
        assert.ok(error instanceof IllegalTransitionError);
        assert.match(error.message, /no upstream/);
        assert.doesNotMatch(
          error.message, /accepts: .*sendBack/,
          "不许一边说它不行、一边把它列在允许的动作里",
        );
        return true;
      },
    );
  });

  it("状态本身就不接受的，照旧报状态表 —— 那时它说的才是真的", () => {
    assert.throws(
      () => transition({ phase: "Spec", status: "pending", returnStack: [] }, "approve"),
      (error: unknown) => {
        assert.ok(error instanceof IllegalTransitionError);
        assert.match(error.message, /accepts: start/);
        return true;
      },
    );
  });
});
