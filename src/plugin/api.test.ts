import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { JobStore } from "../work/job-store";
import { ProjectStore } from "../store/project-store";
import { handleApi, type ApiDeps } from "./api";
import { openDatabase } from "./sqlite-handle";

const AT = "2026-07-28T00:00:00.000Z";

/** 图谱那两条路要 git；这一组不测图谱，给一个不会被调到的桩。 */
const repo = {
  trackedFiles: () => null,
} as unknown as ApiDeps["repo"];

function open() {
  const database = openDatabase(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database, () => new Date(AT)).ensure("PRJ-1", "海战小游戏", "/tmp/x");
  new ChangeStore(database, { now: () => new Date(AT) })
    .create("CHG-1", { projectId: "PRJ-1" });
  return database;
}

describe("plugin · 数据口", () => {
  it("面板那一屏从库里读出来，不需要任何进程在后面跑", async () => {
    const database = open();
    try {
      const answer = await handleApi("/api/panel?change=CHG-1", { database, repo });

      assert.equal(answer.status, 200);
      assert.equal((answer.body as { changeId: string }).changeId, "CHG-1");
    } finally {
      database.close();
    }
  });

  it("query 里带项目时按项目过滤", async () => {
    const database = open();
    try {
      const answer = await handleApi("/api/panel?change=CHG-1&project=PRJ-1", { database, repo });

      assert.equal((answer.body as { selectedProject: string }).selectedProject, "PRJ-1");
    } finally {
      database.close();
    }
  });

  /*
   * 打的是真实症状：**人点了一下，界面一动不动，看不出是坏了还是没做。**
   * 没接上的路径必须回一个说得出理由的答案，不能静默成功或静默失败。
   */
  it("还没接上的路径明着说，不静默", async () => {
    const database = open();
    try {
      const answer = await handleApi("/api/run?change=CHG-1", { database, repo });

      assert.equal(answer.status, 501);
      assert.equal((answer.body as { error: string }).error, "not_wired_yet");
    } finally {
      database.close();
    }
  });

  it("并行座位在没有执行通道时是空的，不是报错", async () => {
    const database = open();
    try {
      const answer = await handleApi("/api/parallel?change=CHG-1", { database, repo });

      assert.equal(answer.status, 200);
      assert.deepEqual(answer.body, { seats: [] });
    } finally {
      database.close();
    }
  });
});

describe("plugin · 产物那条路", () => {
  /*
   * 打的是真实症状：**界面上一个空白的正文框**。
   * 「不是这个阶段报出来的」「项目没路径」「文件不见了」在屏幕上都长成空白，
   * 所以每一种都必须带着自己的 reason 回来 —— 那是人唯一能据此行动的东西。
   */
  it("不是这个阶段报出来的东西，不猜也不去别处找", async () => {
    const database = open();
    try {
      const answer = await handleApi(
        "/api/artifact?change=CHG-1&phase=PRD&id=docs/随便一个.md", { database, repo });

      assert.equal(answer.status, 200);
      assert.deepEqual(answer.body, {
        path: "docs/随便一个.md", readable: false, reason: "not_produced_here",
      });
    } finally {
      database.close();
    }
  });

  it("阶段名不合法时说清楚，不当成「没有产物」", async () => {
    const database = open();
    try {
      const answer = await handleApi("/api/artifact?change=CHG-1&phase=不存在", { database, repo });

      assert.equal(answer.status, 404);
      assert.deepEqual(answer.body, { error: "no_such_phase" });
    } finally {
      database.close();
    }
  });

  it("rubric 认阶段名", async () => {
    const database = open();
    try {
      assert.equal((await handleApi("/api/rubric?change=CHG-1&phase=乱写", { database, repo })).status, 400);
      assert.equal((await handleApi("/api/rubric?change=CHG-1&phase=PRD", { database, repo })).status, 200);
    } finally {
      database.close();
    }
  });
});

/*
 * 这一条是被咬过才写的。
 *
 * 2026-08-18 用户点「请 Codex 问我」，报「没反应」。服务端其实答了 501，界面也确实
 * 把消息画出来了 —— 画出来的是 **「没问成：undefined」**。因为面板每一处失败都写成
 * `没问成：${result.reason}`，而 501 的体里没有那个字段。
 *
 * **回一个正确的状态码不等于把话说清楚了。** 守的是那句人话在不在，不是状态码。
 */
describe("plugin · 没接上的路要说人话", () => {
  it("每一条未接的路都带着能直接显示的 reason", async () => {
    const database = open();
    try {
      for (const path of ["/api/ask", "/api/run", "/api/waive", "/api/answer", "/api/brief"]) {
        const answer = await handleApi(`${path}?change=CHG-1`, { database, repo });
        const body = answer.body as { reason?: string };

        assert.equal(answer.status, 501, path);
        assert.equal(typeof body.reason, "string", `${path} 少了 reason`);
        assert.equal(body.reason !== undefined && body.reason.length > 8, true,
          `${path} 的 reason 太短，等于没说`);
      }
    } finally {
      database.close();
    }
  });
});

/**
 * `/api/progress` —— 一轮在跑的时候，界面每两秒问一次「它到哪了」。
 *
 * 这一屏存在的理由（`panel-view.ts` 的 `progressView`）：**「在跑」和「已经死了」
 * 在界面上是同一个样子**。插件这一面还多一种死法 —— app-server daemon 是插件进程
 * 的孩子，插件重启它就没了，而库里那条 `running` 还挂着。
 */
describe("plugin · 进度", () => {
  it("没有活着的座位时，库里那条 running 报「进程没了」，不报「在跑」", async () => {
    const database = open();
    try {
      new ChangeStore(database, { now: () => new Date(AT) }).apply("CHG-1", "start");

      const answer = await handleApi("/api/progress?change=CHG-1", { database, repo });

      assert.equal(answer.status, 200);
      const view = answer.body as { status: string; live: boolean; processGone: boolean };
      assert.equal(view.status, "running");
      assert.equal(view.live, false);
      assert.equal(view.processGone, true);
    } finally {
      database.close();
    }
  });

  it("座位活着就照实说，并把「多久没动静」原样带上", async () => {
    const database = open();
    try {
      new ChangeStore(database, { now: () => new Date(AT) }).apply("CHG-1", "start");

      const answer = await handleApi("/api/progress?change=CHG-1", {
        database,
        repo,
        live: () => ({
          sessions: { has: () => true, quietForMs: () => 42_000 },
          history: { readThread: async () => null },
        }),
      });

      const view = answer.body as { live: boolean; processGone: boolean; quietForMs: number | null };
      assert.equal(view.live, true);
      assert.equal(view.processGone, false);
      assert.equal(view.quietForMs, 42_000);
    } finally {
      database.close();
    }
  });

  it("没有这个 Change 就是 404 —— 不是一份空进度", async () => {
    const database = open();
    try {
      const answer = await handleApi("/api/progress?change=CHG-404", { database, repo });

      assert.equal(answer.status, 404);
    } finally {
      database.close();
    }
  });
});

describe("plugin · 「进程没了」要跨进程说得准", () => {
  /*
   * 打的是真机症状（2026-08-19 04:54）：一轮跑了 47 分钟、租约 20 秒前还在续，
   * 而工作台报 `processGone: true`。
   *
   * 判据原来问的是「**我这个进程**手上有没有这一轮」。同时开着工作台和插件之后，
   * 那句话就成了假话：轮归另一个进程，这个进程当然没有 —— 于是屏幕上说「它死了」，
   * 而它正跑得好好的。人照着这句话按「中止这一轮」，会把一轮真活儿掐掉。
   *
   * **跨进程唯一说得准的是租约**：谁在续，谁就活着。那本来就是账本的用途。
   */
  it("租约还在续 —— 不管归哪个进程，都不许说「进程没了」", async () => {
    const database = open();
    try {
      new ChangeStore(database, { now: () => new Date(AT) }).apply("CHG-1", "start");
      const jobs = new JobStore(database);
      jobs.enqueue({
        id: "JOB-1", changeId: "CHG-1", kind: "turn",
        deadlineAt: Date.now() + 3_600_000, maxAttempts: 1, phase: "PRD",
      });
      // 别的进程领走并且正在续租。
      jobs.claimNext({ owner: "别的进程", token: "T-1", now: Date.now(), ttlMs: 60_000 });

      const answer = await handleApi("/api/progress?change=CHG-1", { database, repo });

      const view = answer.body as { processGone: boolean; live: boolean };
      assert.equal(view.processGone, false, "租约在续，它没死");
      assert.equal(view.live, true, "有人在跑它");
    } finally {
      database.close();
    }
  });

  it("租约过期了才叫「进程没了」", async () => {
    const database = open();
    try {
      new ChangeStore(database, { now: () => new Date(AT) }).apply("CHG-1", "start");
      const jobs = new JobStore(database);
      jobs.enqueue({
        id: "JOB-1", changeId: "CHG-1", kind: "turn",
        deadlineAt: Date.now() + 3_600_000, maxAttempts: 1, phase: "PRD",
      });
      // 领走了，但租约是很久以前到期的 —— 收尸人还没来得及收。
      jobs.claimNext({ owner: "死掉的进程", token: "T-1", now: Date.now() - 600_000, ttlMs: 60_000 });

      const answer = await handleApi("/api/progress?change=CHG-1", { database, repo });

      assert.equal((answer.body as { processGone: boolean }).processGone, true);
    } finally {
      database.close();
    }
  });
});
