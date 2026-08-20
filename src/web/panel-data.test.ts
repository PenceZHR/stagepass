import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { panelPayload } from "./panel-data";
import { openDatabase } from "./sqlite-handle";

/**
 * 这一组守的是「插件读到的和面板读到的是同一份事实」，以及**没有的东西不许编**。
 *
 * 跑在 `node:sqlite` 句柄上 —— 那正是插件进程里的那个驱动，不是测试专用的另一个。
 */

const AT = "2026-07-28T00:00:00.000Z";

function open() {
  const database = openDatabase(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database, () => new Date(AT))
    .ensure("PRJ-1", "海战小游戏", "/Users/somebody/Desktop/海战小游戏");
  const changes = new ChangeStore(database, { now: () => new Date(AT) });
  changes.create("CHG-1", { projectId: "PRJ-1" });
  return { database, changes };
}

describe("plugin · 面板数据", () => {
  it("读出的是库里那个 Change，而且工作区名字取自项目路径", () => {
    const { database } = open();
    try {
      const payload = panelPayload({
        database, changeId: "CHG-1", askedProject: null,
      }) as Record<string, unknown>;

      assert.equal(payload.changeId, "CHG-1");
      assert.equal(payload.workspace, "海战小游戏");
      assert.equal((payload.phases as unknown[]).length > 0, true);
    } finally {
      database.close();
    }
  });

  /*
   * 打的是真实症状：**环上画出「这个阶段在跑」，而实际上一个 turn 都没有。**
   * 第 1 步的插件没有执行通道，看不见任何座位 —— 那就必须一律显示没在跑。
   * 少说是诚实的，说错会让人照着它做决定。
   */
  it("没有执行通道时，每个阶段都显示没在跑", () => {
    const { database } = open();
    try {
      const payload = panelPayload({
        database, changeId: "CHG-1", askedProject: null,
      }) as { phases: readonly { live: boolean }[] };

      assert.deepEqual(payload.phases.map((phase) => phase.live), payload.phases.map(() => false));
    } finally {
      database.close();
    }
  });

  /*
   * 同上：`blocked` 是「现在派发会被哪条预检拒」。插件还不能派发，这个问题就没有
   * 答案 —— 给 null，不给一个编出来的「可以派」。
   */
  it("还不能派发时，blocked 是 null 而不是编一个", () => {
    const { database, changes } = open();
    try {
      changes.setBrief("CHG-1", "一句需求");
      const payload = panelPayload({
        database, changeId: "CHG-1", askedProject: null,
      }) as Record<string, unknown>;

      assert.equal(payload.blocked, null);
    } finally {
      database.close();
    }
  });

  it("库里没有这个 Change 也不抛 —— 那一屏本来就空着", () => {
    const { database } = open();
    try {
      const payload = panelPayload({
        database, changeId: "CHG-NOPE", askedProject: null,
      }) as Record<string, unknown>;

      assert.equal(payload.changeId, "CHG-NOPE");
      assert.equal(payload.currentPhase, null);
    } finally {
      database.close();
    }
  });
});
