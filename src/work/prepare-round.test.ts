import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GapStore } from "../store/gap-store";
import { SCHEMA_SQL } from "../db/schema";
import { openDatabase } from "../web/sqlite-handle";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { prepareRubricRound } from "./rubric-round";

const AT = "2026-07-28T00:00:00.000Z";

function open() {
  const database = openDatabase(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database, () => new Date(AT)).ensure("PRJ-1", "小游戏", "/tmp/repo");
  new ChangeStore(database, { now: () => new Date(AT) }).create("CHG-1", { projectId: "PRJ-1" });
  return database;
}

/**
 * **备一轮但不派** —— 2026-08-19 定案「甲」那条路的落点。
 *
 * StagePass 不再自己跑轮：谁执行 turn，谁就占着那条 Codex 线程，人在 App 里就
 * 打不开它。改成把题面交给人，他在自己的会话里跑 —— 那一轮从第一秒起就是他的。
 *
 * 备的东西必须和真跑那条**一模一样**（同一份代码），否则「人手跑的那一轮」和
 * StagePass 记的账会对不上，而那种错要到结算时才发作。
 */
describe("work · 备一轮但不派", () => {
  const files = new Map<string, string>();
  /** 铺过哪几份格子。备一轮该铺，结算不该。 */
  const laid: string[] = [];
  const deps = () => ({
    writeRoundFile: (name: string, content: string) => {
      files.set(name, content);
      return `/tmp/rounds/${name}`;
    },
    readRoundFile: (path: string) => files.get(path.split("/").pop()!) ?? null,
    /*
     * 格子文件的替身要**分得清「路径」和「铺一份」**（2026-08-19）。
     *
     * 备一轮时铺（覆盖写，重放要幂等），结算时只取路径去读 —— 结算时再铺一次就是
     * 把人刚跑出来的产出抹掉，然后报「模型没填」。替身合成一个方法，那条判据就
     * 测不到了。
     */
    slotFiles: {
      pathOf: (header: { role: string }) => `/tmp/rounds/slot-${header.role}.json`,
      lay: (header: { role: string }) => {
        laid.push(header.role);
        return `/tmp/rounds/slot-${header.role}.json`;
      },
      collect: () => ({ ok: false as const, reason: "not_here" }),
      discard: () => {},
    },
  });

  it("交出信封和题面路径，而且一个 turn 都没派", () => {
    const database = open();
    files.clear();
    let dispatched = 0;
    try {
      const prepared = prepareRubricRound(
        { projectId: "PRJ-1", changeId: "CHG-1", phase: "PRD", round: 1, task: "写 PRD", judgeThreadId: null },
        {
          ...deps(),
          gaps: new GapStore(database, () => new Date(AT)),
          rubrics: { effective: () => null },
          worklist: { open: () => {}, close: () => {} },
          transport: { runTurn: async () => { dispatched += 1; throw new Error("不该派"); } },
        } as never,
      );

      assert.equal(dispatched, 0, "备一轮不许碰 transport");
      assert.equal(prepared.envelope.includes("你是本轮的裁判"), true);
      assert.equal(prepared.envelope.includes("阶段：PRD"), true);
      assert.equal(prepared.envelope.includes(prepared.scriptPath), true, "信封里带着题面路径");
      assert.notEqual(files.size, 0, "题面要真落成文件");
    } finally {
      database.close();
    }
  });

  /*
   * 信封第一句就是**认回那条线程**的依据：它会成为 Codex 会话的标题
   * （2026-08-19 实测：`thread/list` 回的 title 就是第一条用户消息）。
   * 所以阶段和轮次必须在第一句里 —— 少了它，人跑完之后 StagePass 认不回来，
   * 而唯一的补救是让人手抄线程 id（用户明令禁止的那件事）。
   */
  it("信封第一句带着阶段和轮次 —— 那是认回线程的唯一依据", () => {
    const database = open();
    files.clear();
    try {
      const prepared = prepareRubricRound(
        { projectId: "PRJ-1", changeId: "CHG-1", phase: "Spec", round: 7, task: "写 Spec", judgeThreadId: null },
        {
          ...deps(),
          gaps: new GapStore(database, () => new Date(AT)),
          rubrics: { effective: () => null },
          worklist: { open: () => {}, close: () => {} },
          transport: { runTurn: async () => { throw new Error("不该派"); } },
        } as never,
      );

      assert.equal(prepared.envelope.split("\n")[0], "你是本轮的裁判。阶段：Spec，第 7 轮。");
    } finally {
      database.close();
    }
  });
});
