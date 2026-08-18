import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { handleAction, type ActionDeps } from "./actions";
import { openDatabase } from "./sqlite-handle";

const AT = "2026-07-28T00:00:00.000Z";

/** 动作这一层不碰 git，除了旁路记 HEAD 那一处 —— 给一个说得出话的桩。 */
const repo = { head: () => "sha-1" } as unknown as ActionDeps["repo"];

/**
 * 这一组测的都是**不派轮**的路，所以执行通道给一个会当场炸的桩 ——
 * 万一哪条路悄悄开始派轮，测试要红，而不是安静地起一个 codex 子进程。
 */
const runtime = {
  runRound: () => { throw new Error("这一组不该派轮"); },
  roundBudget: 5,
  archiveOps: () => null,
} as unknown as ActionDeps["runtime"];

function open(): ActionDeps {
  const database = openDatabase(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database, () => new Date(AT)).ensure("PRJ-1", "小游戏", "/tmp/repo");
  new ChangeStore(database, { now: () => new Date(AT) }).create("CHG-1", { projectId: "PRJ-1" });
  return { database, repo, runtime, workspaceFor: () => "/tmp/repo" };
}

const call = (path: string, deps: ActionDeps, body = ""): ReturnType<typeof handleAction> => {
  const [pathname = "", query = ""] = path.split("?");
  return handleAction(pathname, new URLSearchParams(query), body, deps);
};

describe("plugin · 会改库的那些路", () => {
  it("建 Change 落库，并且说得出它落在哪个阶段", async () => {
    const deps = open();
    try {
      const answer = await call("/api/change?project=PRJ-1&title=新的一件事", deps);

      assert.equal(answer.status, 200);
      const body = answer.body as { created: boolean; id: string; phase: string };
      assert.equal(body.created, true);
      assert.equal(body.phase, "PRD");
      assert.equal(new ChangeStore(deps.database).read(body.id).title, "新的一件事");
    } finally {
      deps.database.close();
    }
  });

  /*
   * 打的是真实症状：**建了一个没有名字的 Change，列表里认不出它是哪个。**
   * 拒绝要带着能显示的理由回去，不是静默创建一个空标题。
   */
  it("没有标题就不建，并说出是哪一条不满足", async () => {
    const deps = open();
    try {
      const answer = await call("/api/change?project=PRJ-1&title=", deps);

      assert.equal(answer.status, 400);
      assert.deepEqual(answer.body, { error: "title_required" });
    } finally {
      deps.database.close();
    }
  });

  it("项目不在库里时是 404，不是把 Change 建在空气上", async () => {
    const deps = open();
    try {
      assert.equal((await call("/api/change?project=PRJ-NOPE&title=x", deps)).status, 404);
    } finally {
      deps.database.close();
    }
  });

  /*
   * 打的是真实症状：**一次迟到的点击落到了另一道题上。**
   * 人看到的那道题和此刻在等的必须是同一道 —— 界面可能停在旧状态上。
   */
  it("没有在等的题时不落任何答案", async () => {
    const deps = open();
    try {
      const answer = await call("/api/answer?change=CHG-1&question=Q-旧的", deps);

      assert.equal(answer.status, 409);
      assert.deepEqual(answer.body, { error: "nothing_to_answer" });
    } finally {
      deps.database.close();
    }
  });

  it("豁免：一条可接受的都没有时说清楚，不摆一道没有选项的题", async () => {
    const deps = open();
    try {
      const answer = await call("/api/waive?change=CHG-1", deps);

      assert.equal(answer.status, 200);
      const body = answer.body as { asked: boolean; reason?: string };
      assert.equal(body.asked, false);
      assert.equal(body.reason, "nothing_waivable");
    } finally {
      deps.database.close();
    }
  });

  it("进旁路记一趟账，再进不重记", async () => {
    const deps = open();
    try {
      const first = await call("/api/aside?change=CHG-1", deps);
      const again = await call("/api/aside?change=CHG-1", deps);

      assert.equal(first.status, 200);
      assert.deepEqual(again.body, first.body);
    } finally {
      deps.database.close();
    }
  });

  it("判据表：阶段或角色不合法就拒，不写一份挂在错地方的标准", async () => {
    const deps = open();
    try {
      assert.equal((await call("/api/rubric?change=CHG-1&phase=乱写&role=producer", deps)).status, 400);
      assert.equal((await call("/api/rubric?change=CHG-1&phase=PRD&role=乱写", deps)).status, 400);
    } finally {
      deps.database.close();
    }
  });

  it("还没接上的动作照样说人话", async () => {
    const deps = open();
    try {
      // brief 那条要执行通道里的「起草」，还没接 —— 它必须带着能显示的理由回来。
      const answer = await call("/api/brief?change=CHG-1", deps);

      assert.equal(answer.status, 501);
      const body = answer.body as { reason?: string };
      assert.equal(typeof body.reason, "string");
    } finally {
      deps.database.close();
    }
  });

  /*
   * 派轮的判据全在 `runtime.runRound` 里，这里只守**路由到没到**。
   * 用一个会记账的桩：真调到了才记，于是「点了没反应」和「派出去了」分得开。
   */
  it("派轮走执行通道，带着这个阶段过去", async () => {
    const database = openDatabase(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(SCHEMA_SQL);
    new ProjectStore(database, () => new Date(AT)).ensure("PRJ-1", "小游戏", "/tmp/repo");
    new ChangeStore(database, { now: () => new Date(AT) }).create("CHG-1", { projectId: "PRJ-1" });
    const seen: { changeId: string; phase: string }[] = [];
    const deps = {
      database, repo, workspaceFor: () => "/tmp/repo",
      runtime: {
        runRound: (changeId: string, phase: string) => {
          seen.push({ changeId, phase });
          return Promise.resolve({ ran: true, phase, jobId: "JOB-1" });
        },
        roundBudget: 5,
        archiveOps: () => null,
      },
    } as unknown as ActionDeps;
    try {
      const answer = await call("/api/run?change=CHG-1", deps);

      assert.deepEqual(seen, [{ changeId: "CHG-1", phase: "PRD" }]);
      assert.deepEqual(answer.body, { ran: true, phase: "PRD", jobId: "JOB-1" });
    } finally {
      database.close();
    }
  });
});
