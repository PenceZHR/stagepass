import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { jumpsFrom, optionsFrom, pendingSendBack, type JourneyEntry } from "./journey";
import { computeGate, EMPTY_EVIDENCE } from "./gate";
import { PHASES } from "./phase";
import type { ChangeState } from "./change-state";

/**
 * L1 · 跳转表 = 事件流的投影（BACKLOG §4.3 / §5.9.2）。
 *
 * `change_events` 就是那条事件流（append-only、触发器强制）。这张表**不另建**：
 * 「从哪 · 去哪 · 什么理由 · 哪一轮」全部从账本一行行算出来。G 档画历史箭头
 * 读的必须是这一份 —— 模型和 UI 是同一件事，做一次。
 */
describe("L1 · 跳转表从账本投影出来", () => {
  let seq = 0;
  const entry = (
    action: string,
    from: { phase: string; status: string } | null,
    to: { phase: string; status: string },
    reason: string | null = null,
  ): JourneyEntry => ({ seq: seq++, action, from, to, reason, at: `t${seq}` });

  /** PRD 跑两轮（第一轮被驳回）批准，Build 打回 Spec，Review 送修。 */
  const walk = (): JourneyEntry[] => {
    seq = 0;
    return [
      entry("create", null, { phase: "PRD", status: "pending" }),
      entry("start", { phase: "PRD", status: "pending" }, { phase: "PRD", status: "running" }),
      entry("settle", { phase: "PRD", status: "running" }, { phase: "PRD", status: "settled" }),
      entry("reject", { phase: "PRD", status: "settled" }, { phase: "PRD", status: "pending" }),
      entry("start", { phase: "PRD", status: "pending" }, { phase: "PRD", status: "running" }),
      entry("settle", { phase: "PRD", status: "running" }, { phase: "PRD", status: "settled" }),
      entry("approve", { phase: "PRD", status: "settled" }, { phase: "Spec", status: "pending" }),
      entry("start", { phase: "Spec", status: "pending" }, { phase: "Spec", status: "running" }),
      entry("settle", { phase: "Spec", status: "running" }, { phase: "Spec", status: "settled" }),
      entry("sendBack", { phase: "Spec", status: "settled" }, { phase: "PRD", status: "pending" },
        "验收口径在 PRD 里就写反了"),
      entry("start", { phase: "PRD", status: "pending" }, { phase: "PRD", status: "running" }),
      entry("settle", { phase: "PRD", status: "running" }, { phase: "PRD", status: "settled" }),
      entry("approve", { phase: "PRD", status: "settled" }, { phase: "Spec", status: "pending" }),
    ];
  };

  it("只留人推动的那几步：批准、驳回（自环也算）、打回 —— 系统步不是跳", () => {
    assert.deepEqual(jumpsFrom(walk()).map((jump) => jump.action), [
      "reject", "approve", "sendBack", "approve",
    ]);
  });

  it("每一跳带上从哪、去哪、什么理由、哪一轮（§5.9.2 要的四样）", () => {
    const back = jumpsFrom(walk()).find((jump) => jump.action === "sendBack")!;
    assert.equal(back.fromPhase, "Spec");
    assert.equal(back.toPhase, "PRD");
    assert.equal(back.reason, "验收口径在 PRD 里就写反了");
    // 跳的那一刻 Spec 跑到第 1 轮 —— 和派发、题面同一个算法（roundFromLedger）。
    assert.equal(back.round, 1);
  });

  it("自环是频率最高的那条边，必须在场（§5.9.3：现在完全隐形）", () => {
    const loop = jumpsFrom(walk())[0]!;
    assert.equal(loop.action, "reject");
    assert.equal(loop.fromPhase, "PRD");
    assert.equal(loop.toPhase, "PRD");
    assert.equal(loop.kind, "self");
    assert.equal(loop.round, 1);
  });

  it("方向从全序判：向前是推进，向后是回头 —— 弦和环的两种画法靠它分", () => {
    const kinds = jumpsFrom(walk()).map((jump) => [jump.action, jump.kind]);
    assert.deepEqual(kinds, [
      ["reject", "self"],
      ["approve", "forward"],
      ["sendBack", "backward"],
      ["approve", "forward"],
    ]);
  });

  it("送修与修完：进 Fix 是回头，出 Fix 是向前 —— Fix 不在全序上，按语义判", () => {
    seq = 0;
    const jumps = jumpsFrom([
      entry("create", null, { phase: "Review", status: "pending" }),
      entry("reject", { phase: "Review", status: "settled" }, { phase: "Fix", status: "pending" }),
      entry("approve", { phase: "Fix", status: "settled" }, { phase: "Review", status: "pending" }),
    ]);
    assert.deepEqual(jumps.map((jump) => [jump.action, jump.kind]), [
      ["reject", "backward"],
      ["approve", "forward"],
    ]);
  });

  it("第二轮里发生的跳，轮次是 2 —— 不是从 1 数起的老毛病", () => {
    const jumps = jumpsFrom(walk());
    // 第二个 approve 前 PRD 已经因打回又跑了一轮：PRD 一共落进 running 三次。
    assert.equal(jumps[3]!.round, 3);
    assert.equal(jumps[1]!.round, 2);
  });

  it("空账本 —— 空表，不编", () => {
    assert.deepEqual(jumpsFrom([]), []);
  });
});

describe("L1 · 这个阶段现在欠着谁的回程（反馈闭环的取数口）", () => {
  let seq = 0;
  const e = (action: string, from: [string, string] | null, to: [string, string], reason: string | null = null): JourneyEntry =>
    ({ seq: seq++, action, from: from && { phase: from[0], status: from[1] },
       to: { phase: to[0], status: to[1] }, reason, at: `t${seq}` });
  const walkToSpecViaSendBack = (): JourneyEntry[] => {
    seq = 0;
    return [
      e("create", null, ["PRD", "pending"]),
      e("start", ["PRD", "pending"], ["PRD", "running"]),
      e("settle", ["PRD", "running"], ["PRD", "settled"]),
      e("approve", ["PRD", "settled"], ["Spec", "pending"]),
      e("start", ["Spec", "pending"], ["Spec", "running"]),
      e("settle", ["Spec", "running"], ["Spec", "settled"]),
      e("approve", ["Spec", "settled"], ["Build", "pending"]),
      e("start", ["Build", "pending"], ["Build", "running"]),
      e("settle", ["Build", "running"], ["Build", "settled"]),
      e("sendBack", ["Build", "settled"], ["Spec", "pending"], "接口边界在 Spec 里就画错了"),
    ];
  };

  it("被打回的阶段：说出是谁、原话、打回方当时第几轮", () => {
    assert.deepEqual(
      pendingSendBack(walkToSpecViaSendBack(), { phase: "Spec", returnStack: ["Build"] }),
      { from: "Build", reason: "接口边界在 Spec 里就画错了", round: 1 },
    );
  });

  it("欠的不是这一跳就不算 —— 栈顶说了算，不是「账本里有过打回」", () => {
    // 同一份账本，但 Change 已经不在 Spec 欠 Build 的那个状态里了。
    assert.equal(
      pendingSendBack(walkToSpecViaSendBack(), { phase: "Spec", returnStack: [] }), null);
    assert.equal(
      pendingSendBack(walkToSpecViaSendBack(), { phase: "PRD", returnStack: ["Spec"] }), null);
  });

  it("送修（reject → Fix）不算打回上游 —— 那是另一句话，而且没有理由可带", () => {
    seq = 0;
    const ledger = [
      e("create", null, ["Review", "pending"]),
      e("reject", ["Review", "settled"], ["Fix", "pending"]),
    ];
    assert.equal(pendingSendBack(ledger, { phase: "Fix", returnStack: ["Review"] }), null);
  });

  it("同一个阶段被打回两次 —— 取最近那次的理由", () => {
    const ledger = [...walkToSpecViaSendBack()];
    ledger.push(
      e("start", ["Spec", "pending"], ["Spec", "running"]),
      e("settle", ["Spec", "running"], ["Spec", "settled"]),
      e("approve", ["Spec", "settled"], ["Build", "pending"]),
      e("start", ["Build", "pending"], ["Build", "running"]),
      e("settle", ["Build", "running"], ["Build", "settled"]),
      e("sendBack", ["Build", "settled"], ["Spec", "pending"], "第二次：验收口径还是对不上"),
    );
    assert.equal(
      pendingSendBack(ledger, { phase: "Spec", returnStack: ["Build"] })?.reason,
      "第二次：验收口径还是对不上");
  });
});

describe("L1 · 从这儿能去哪：环上的活箭头（§5.9.3）", () => {
  /*
   * 用户 2026-08-04：「环的形状还是要的，只是不能暗示用户下个阶段一定是这个，
   * 可以用箭头指示，不管是向前还是跳转到别的阶段。」
   *
   * 所以是**复数**，每条带理由。判据必须和闸门是同一份 —— 前端自己算第二份，
   * 就会画出闸门不认的箭头，那正是老树那五个死按钮的形状。
   */
  const settled = (phase: string, stack: readonly string[] = []): ChangeState =>
    ({ phase: phase as never, status: "settled", returnStack: stack as never });
  const optionsOf = (state: ChangeState) =>
    optionsFrom(state, computeGate(state, { artifactIds: ["x.md"], blockers: [], waivedBlockerIds: [] }));

  it("一个干净的设计阶段：批准往前、再来一轮回自己、打回上游各一条", () => {
    const edges = optionsOf(settled("TechSpec"));
    /*
     * **打回那条只画最近的一个上游（Spec），不铺开 PRD。**
     *
     * 4 条上限是硬的（§5.9.3③）：TestPlan 铺开就是四条 sendBack 加批准加自环，
     * 当场破限。环上摆「最可能的那一条」，全名单在裁决表那一格里 —— 环是地图，
     * 不是选单。
     */
    assert.deepEqual(edges.map((edge) => [edge.action, edge.to, edge.kind]), [
      ["approve", "Plan", "forward"],
      ["reject", "TechSpec", "self"],
      ["sendBack", "Spec", "backward"],
    ]);
    assert.match(edges[2]!.why, /裁决表里可以挑更远的/);
    // 每条都说得出「按下去会怎样」—— 光画箭头不说后果等于又要人猜。
    assert.ok(edges.every((edge) => edge.why.length > 0));
  });

  it("**自环必须在** —— 它是频率最高的那条边，现在完全隐形（§5.9.4）", () => {
    assert.ok(optionsOf(settled("Spec")).some((edge) => edge.kind === "self"));
  });

  it("Review 的驳回指向 Fix，不是指向自己 —— 同一个动作两句话", () => {
    const back = optionsOf(settled("Review")).find((edge) => edge.action === "reject")!;
    assert.equal(back.to, "Fix");
    assert.equal(back.kind, "backward");
  });

  it("欠着回程时，批准那条指向栈顶，不是主线的下一站", () => {
    const forward = optionsOf(settled("Spec", ["Build"])).find((e) => e.action === "approve")!;
    assert.equal(forward.to, "Build");
    assert.match(forward.why, /Build/);
  });

  it("闸门拒的不画 —— 什么都没产出时没有「批准」那条箭头（§5.4）", () => {
    const state = settled("Spec");
    const edges = optionsFrom(state, computeGate(state, EMPTY_EVIDENCE));
    assert.ok(!edges.some((edge) => edge.action === "approve"));
    assert.ok(edges.some((edge) => edge.action === "reject"));
  });

  it("blocked 只剩重跑一次，closed 一条都没有", () => {
    const blocked: ChangeState = { phase: "Build", status: "blocked", returnStack: [] };
    assert.deepEqual(
      optionsFrom(blocked, computeGate(blocked, EMPTY_EVIDENCE)).map((e) => e.action),
      ["retry"]);
    const done: ChangeState = { phase: "Done", status: "closed", returnStack: [] };
    assert.deepEqual(optionsFrom(done, computeGate(done, EMPTY_EVIDENCE)), []);
  });

  it("**护栏：任一时刻活箭头不超过 4 条**（§5.9.3③，防它以后悄悄涨到 8）", () => {
    let worst = 0;
    for (const phase of PHASES) {
      for (const status of ["pending", "running", "settled", "blocked"] as const) {
        for (const stack of [[], ["Build"], ["QA"]]) {
          const state = { phase, status, returnStack: stack } as ChangeState;
          let gate;
          try { gate = computeGate(state, { artifactIds: ["x"], blockers: [], waivedBlockerIds: [] }); }
          catch { continue; }   // 造不出来的状态（Fix 空栈之类）跳过
          worst = Math.max(worst, optionsFrom(state, gate).length);
        }
      }
    }
    assert.ok(worst <= 4, `活箭头涨到了 ${worst} 条`);
  });
});
