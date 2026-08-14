import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

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

type FakeState = "open" | "archived" | "missing" | "no-rollout" | "unavailable";

/** 一个假的 Codex 线程事实。记下每一次动作，好断言「到底动没动手」。 */
function fake(initial: Record<string, FakeState>, options: {
  /** 让 `codex archive/unarchive` 抛，验命令失败那条路。 */
  throws?: boolean;
  /** 让命令「成功」但那一列纹丝不动 —— 退出码骗人的那种。 */
  lies?: boolean;
} = {}): ArchiveOps & {
  calls: string[];
  /** RED 阶段兼容旧接口；生产实现切到 availability 后不再消费它。 */
  isArchived(threadId: string): boolean | null;
  availability(threadId: string):
    | { readonly kind: "open"; readonly rolloutPath: string }
    | { readonly kind: "archived"; readonly rolloutPath: string }
    | { readonly kind: "missing"; readonly reason: "no-row" | "no-rollout" }
    | { readonly kind: "unavailable"; readonly reason: string };
} {
  const state = { ...initial };
  const calls: string[] = [];
  return {
    calls,
    availability(id) {
      const current = state[id] ?? "missing";
      if (current === "open") {
        return { kind: "open", rolloutPath: `/rollouts/${id}.jsonl` };
      }
      if (current === "archived") {
        return { kind: "archived", rolloutPath: `/rollouts/${id}.jsonl` };
      }
      if (current === "no-rollout") {
        return { kind: "missing", reason: "no-rollout" };
      }
      if (current === "unavailable") {
        return { kind: "unavailable", reason: "state database is locked" };
      }
      return { kind: "missing", reason: "no-row" };
    },
    isArchived(id) {
      const current = state[id] ?? "missing";
      if (current === "open") return false;
      if (current === "archived") return true;
      return null;
    },
    unarchive(id) {
      calls.push(`unarchive ${id}`);
      if (options.throws === true) throw new Error("failed to unarchive session");
      if (options.lies !== true) state[id] = "open";
    },
    archive(id) {
      calls.push(`archive ${id}`);
      if (options.throws === true) throw new Error("failed to archive session");
      if (options.lies !== true) state[id] = "archived";
    },
  };
}

describe("L2 · resume 之前把线程弄成 resume 得动的", () => {
  it("没被归档 —— **一根手指都不动**", () => {
    /*
     * 这一条是承重的：`codex unarchive` 对一条没被归档的会话会报
     * `failed to unarchive session`（2026-07-30 实测）。所以不能无脑先跑一遍。
     */
    const ops = fake({ "T-1": "open" });
    assert.equal(ensureResumable("T-1", ops), "already_open");
    assert.deepEqual(ops.calls, []);
  });

  it("被归档了 —— 解开它", () => {
    const ops = fake({ "T-1": "archived" });
    assert.equal(ensureResumable("T-1", ops), "unarchived");
    assert.deepEqual(ops.calls, ["unarchive T-1"]);
    assert.equal(ops.availability("T-1").kind, "open");
  });

  it("查询成功但没有 thread 行 —— 说 missing，不伪装成环境错误", () => {
    const ops = fake({ "T-MISSING": "missing" });
    assert.equal(ensureResumable("T-MISSING", ops), "missing");
    assert.deepEqual(ops.calls, []);
  });

  it("状态库读不了 —— 说 unavailable，不把仍存在的 binding 拆掉", () => {
    const ops = fake({ "T-UNKNOWN": "unavailable" });
    assert.equal(ensureResumable("T-UNKNOWN", ops), "unavailable");
    assert.deepEqual(ops.calls, []);
  });

  it("命令抛了 —— 老实说还是归档着", () => {
    const ops = fake({ "T-1": "archived" }, { throws: true });
    assert.equal(ensureResumable("T-1", ops), "still_archived");
  });

  /**
   * **权威是那一列，不是命令的退出码。** 命令「成功」而状态没变时，
   * 说成 `unarchived` 就是把一次注定失败的 resume 说成没问题。
   */
  it("命令说成功、那一列却没变 —— 不许当成解开了", () => {
    const ops = fake({ "T-1": "archived" }, { lies: true });
    assert.equal(ensureResumable("T-1", ops), "still_archived");
  });
});

describe("L2 · 阶段批准之后才归档", () => {
  it("没归档的 —— 归档它", () => {
    const ops = fake({ "T-1": "open" });
    assert.equal(archiveFinished("T-1", ops), "archived");
    assert.deepEqual(ops.calls, ["archive T-1"]);
  });

  it("已经归档的 —— 什么都不做", () => {
    const ops = fake({ "T-1": "archived" });
    assert.equal(archiveFinished("T-1", ops), "already_archived");
    assert.deepEqual(ops.calls, []);
  });

  it("读不到状态 —— 不动手", () => {
    const ops = fake({ "T-NOPE": "missing" });
    assert.equal(archiveFinished("T-NOPE", ops), "unknown");
    assert.deepEqual(ops.calls, []);
  });

  it("命令说成功、那一列却没变 —— 不许当成归档了", () => {
    const ops = fake({ "T-1": "open" }, { lies: true });
    assert.equal(archiveFinished("T-1", ops), "still_open");
  });

  /**
   * 这两个动作合起来必须是可逆的：批准归档掉的那条线程，下次再进这个阶段时
   * `ensureResumable` 要能把它解开 —— Fix 会被反复进入（PRD §6.5 规则 2）。
   */
  it("**归档完还解得开** —— Fix 会被反复进入", () => {
    const ops = fake({ "T-FIX": "open" });
    assert.equal(archiveFinished("T-FIX", ops), "archived");
    assert.equal(ensureResumable("T-FIX", ops), "unarchived");
    assert.deepEqual(ops.calls, ["archive T-FIX", "unarchive T-FIX"]);
  });
});

describe("L2 · 真的那一套只在真的用时才碰 Codex", () => {
  it("读不到状态库是 unavailable，而且保留原始原因", () => {
    const ops = createArchiveOps({ stateDbPath: "/nonexistent/state_5.sqlite" });
    const result = ops.availability("T-1");
    assert.equal(result.kind, "unavailable");
    assert.match(result.kind === "unavailable" ? result.reason : "", /state_5\.sqlite/);
  });

  it("把 row、archive 标记和 rollout 文件合成四态事实", () => {
    const directory = mkdtempSync(join(tmpdir(), "stagepass-archive-"));
    const stateDbPath = join(directory, "state_5.sqlite");
    const openRollout = join(directory, "open.jsonl");
    const archivedRollout = join(directory, "archived.jsonl");
    writeFileSync(openRollout, "{}\n", "utf8");
    writeFileSync(archivedRollout, "{}\n", "utf8");
    const database = new Database(stateDbPath);
    try {
      database.exec(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL, rollout_path TEXT NOT NULL)",
      );
      database.prepare(
        "INSERT INTO threads (id, archived, rollout_path) VALUES (?, ?, ?)",
      ).run("T-OPEN", 0, openRollout);
      database.prepare(
        "INSERT INTO threads (id, archived, rollout_path) VALUES (?, ?, ?)",
      ).run("T-ARCHIVED", 1, archivedRollout);
    } finally {
      database.close();
    }

    try {
      const ops = createArchiveOps({ stateDbPath });
      assert.deepEqual(ops.availability("T-OPEN"), {
        kind: "open", rolloutPath: openRollout,
      });
      assert.deepEqual(ops.availability("T-ARCHIVED"), {
        kind: "archived", rolloutPath: archivedRollout,
      });
      assert.deepEqual(ops.availability("T-NO-ROW"), {
        kind: "missing", reason: "no-row",
      });

      unlinkSync(openRollout);
      assert.deepEqual(ops.availability("T-OPEN"), {
        kind: "missing", reason: "no-rollout",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
