import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { jumpsFrom, type JourneyEntry } from "./journey";

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
