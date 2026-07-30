import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  archiveFinished, createArchiveOps, ensureResumable, type ArchiveOps,
} from "./archive";

/**
 * 归档：让「这条线程还能不能 resume」变成 StagePass 自己管的事。
 *
 * ## 这一层是被一次真事故逼出来的
 *
 * 2026-07-30 用户点「请 Codex 问我」报错。真实原因是那条绑着的裁判线程被归档了，
 * 而 `codex resume` 对一条归档会话**一起来就退**。归档不是 StagePass 干的（代码里
 * 零处），也不是进程退出触发的（实测 kill 前后 `archived` 都是 0）—— 它成批发生，
 * 而且扫得到 StagePass 派生的 `/root/red`、`/root/blue`。
 *
 * 用户拍板的形状：**批准之前遇到归档就自动解开；批准之后由 StagePass 主动归档。**
 */

/** 一个假的 Codex 归档状态。记下每一次动作，好断言「到底动没动手」。 */
function fake(initial: Record<string, boolean>, options: {
  /** 让 `codex archive/unarchive` 抛，验命令失败那条路。 */
  throws?: boolean;
  /** 让命令「成功」但那一列纹丝不动 —— 退出码骗人的那种。 */
  lies?: boolean;
} = {}): ArchiveOps & { calls: string[] } {
  const state = { ...initial };
  const calls: string[] = [];
  return {
    calls,
    isArchived: (id) => (id in state ? state[id]! : null),
    unarchive(id) {
      calls.push(`unarchive ${id}`);
      if (options.throws === true) throw new Error("failed to unarchive session");
      if (options.lies !== true) state[id] = false;
    },
    archive(id) {
      calls.push(`archive ${id}`);
      if (options.throws === true) throw new Error("failed to archive session");
      if (options.lies !== true) state[id] = true;
    },
  };
}

describe("L2 · resume 之前把线程弄成 resume 得动的", () => {
  it("没被归档 —— **一根手指都不动**", () => {
    /*
     * 这一条是承重的：`codex unarchive` 对一条没被归档的会话会报
     * `failed to unarchive session`（2026-07-30 实测）。所以不能无脑先跑一遍。
     */
    const ops = fake({ "T-1": false });
    assert.equal(ensureResumable("T-1", ops), "already_open");
    assert.deepEqual(ops.calls, []);
  });

  it("被归档了 —— 解开它", () => {
    const ops = fake({ "T-1": true });
    assert.equal(ensureResumable("T-1", ops), "unarchived");
    assert.deepEqual(ops.calls, ["unarchive T-1"]);
    assert.equal(ops.isArchived("T-1"), false);
  });

  it("**读不到状态就说读不到**，不说「没归档」", () => {
    // 读的是别人的库。读不了的时候退回加这一层之前的行为，而不是假装知道。
    const ops = fake({});
    assert.equal(ensureResumable("T-UNKNOWN", ops), "unknown");
    assert.deepEqual(ops.calls, []);
  });

  it("命令抛了 —— 老实说还是归档着", () => {
    const ops = fake({ "T-1": true }, { throws: true });
    assert.equal(ensureResumable("T-1", ops), "still_archived");
  });

  /**
   * **权威是那一列，不是命令的退出码。** 命令「成功」而状态没变时，
   * 说成 `unarchived` 就是把一次注定失败的 resume 说成没问题。
   */
  it("命令说成功、那一列却没变 —— 不许当成解开了", () => {
    const ops = fake({ "T-1": true }, { lies: true });
    assert.equal(ensureResumable("T-1", ops), "still_archived");
  });
});

describe("L2 · 阶段批准之后才归档", () => {
  it("没归档的 —— 归档它", () => {
    const ops = fake({ "T-1": false });
    assert.equal(archiveFinished("T-1", ops), "archived");
    assert.deepEqual(ops.calls, ["archive T-1"]);
  });

  it("已经归档的 —— 什么都不做", () => {
    const ops = fake({ "T-1": true });
    assert.equal(archiveFinished("T-1", ops), "already_archived");
    assert.deepEqual(ops.calls, []);
  });

  it("读不到状态 —— 不动手", () => {
    const ops = fake({});
    assert.equal(archiveFinished("T-NOPE", ops), "unknown");
    assert.deepEqual(ops.calls, []);
  });

  it("命令说成功、那一列却没变 —— 不许当成归档了", () => {
    const ops = fake({ "T-1": false }, { lies: true });
    assert.equal(archiveFinished("T-1", ops), "still_open");
  });

  /**
   * 这两个动作合起来必须是可逆的：批准归档掉的那条线程，下次再进这个阶段时
   * `ensureResumable` 要能把它解开 —— Fix 会被反复进入（PRD §6.5 规则 2）。
   */
  it("**归档完还解得开** —— Fix 会被反复进入", () => {
    const ops = fake({ "T-FIX": false });
    assert.equal(archiveFinished("T-FIX", ops), "archived");
    assert.equal(ensureResumable("T-FIX", ops), "unarchived");
    assert.deepEqual(ops.calls, ["archive T-FIX", "unarchive T-FIX"]);
  });
});

describe("L2 · 真的那一套只在真的用时才碰 Codex", () => {
  it("读不到那个库时 isArchived 是 null，而且不抛", () => {
    // 生产实现读 `~/.codex/state_5.sqlite`。指到一个不存在的文件上，它必须
    // 老实返回 null —— 一个抛出来的读会把整条 launch 路径带崩。
    const ops = createArchiveOps({ stateDbPath: "/nonexistent/state_5.sqlite" });
    assert.equal(ops.isArchived("T-1"), null);
  });

  it("命令走的是 `codex archive` / `codex unarchive`", () => {
    const ran: string[][] = [];
    const ops = createArchiveOps({
      stateDbPath: "/nonexistent/state_5.sqlite",
      run: (args) => { ran.push([...args]); },
    });
    ops.archive("T-1");
    ops.unarchive("T-1");
    assert.deepEqual(ran, [["archive", "T-1"], ["unarchive", "T-1"]]);
  });
});
