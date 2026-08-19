import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { JobStore } from "../work/job-store";
import { ProjectStore } from "../store/project-store";
import type { ActionDeps } from "./actions";
import type { ApiDeps } from "./api";
import { openDatabase } from "./sqlite-handle";
import { reapStaleRounds, serveRequest } from "./serve";

const AT = "2026-07-28T00:00:00.000Z";
const repo = { trackedFiles: () => null, head: () => "sha-1" } as unknown as ApiDeps["repo"];

function open() {
  const database = openDatabase(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database, () => new Date(AT)).ensure("PRJ-1", "小游戏", "/tmp/repo");
  new ChangeStore(database, { now: () => new Date(AT) }).create("CHG-1", { projectId: "PRJ-1" });
  return database;
}

/**
 * 浏览器那一面的请求边界。
 *
 * 2026-08-19 定案：状态流转回到 WebUI（Codex 的 in-app browser / Claude Code 的
 * Browser pane / 普通浏览器，同一份）。这一层是那三处共用的后端 —— 它只做分发，
 * 判据全在 `api.ts` / `actions.ts` 里，和插件用的是同一份。
 */
describe("web · 浏览器那一面的请求边界", () => {
  it("GET 走只读那半边", async () => {
    const database = open();
    try {
      const answer = await serveRequest("GET", "/api/panel?change=CHG-1", "", {
        read: { database, repo },
        write: () => { throw new Error("只看不该开可写句柄"); },
      });

      assert.equal(answer.status, 200);
      assert.equal((answer.body as { changeId: string }).changeId, "CHG-1");
    } finally {
      database.close();
    }
  });

  /*
   * **可写句柄要等到第一次真要写才开。**
   *
   * 插件那边靠这条纪律换来「看一眼在物理上就不可能写坏什么」，而开可写句柄还会
   * 顺手跑迁移 —— 一个只是打开页面看看的人，不该在库上留下任何痕迹。
   */
  it("只看的会话一次都不开可写句柄", async () => {
    const database = open();
    let opened = 0;
    try {
      for (const path of ["/api/panel?change=CHG-1", "/api/parallel?change=CHG-1"]) {
        await serveRequest("GET", path, "", {
          read: { database, repo },
          write: () => { opened += 1; throw new Error("不该走到这儿"); },
        });
      }

      assert.equal(opened, 0);
    } finally {
      database.close();
    }
  });

  it("POST 走会写那半边，而且拿的是另一个句柄", async () => {
    const database = open();
    const writable = open();
    try {
      const answer = await serveRequest(
        "POST", "/api/change?project=PRJ-1&title=新的一件事", "",
        {
          read: { database, repo },
          write: () => ({
            database: writable, repo, runtime: {} as ActionDeps["runtime"],
            workspaceFor: () => "/tmp/repo",
            briefFiles: { write: () => "/x", read: () => null },
          }),
        },
      );

      assert.equal(answer.status, 200);
      // 落在可写那个库里，只读那个一个字都没动。
      assert.equal(new ChangeStore(writable).list("PRJ-1").length, 2);
      assert.equal(new ChangeStore(database).list("PRJ-1").length, 1);
    } finally {
      database.close();
      writable.close();
    }
  });

  /*
   * 浏览器里 `fetch` 默认发 GET，写操作靠 `method: "POST"`。方法写错时**必须说**
   * —— 静默按 GET 处理会让一次「跑这个阶段」变成一次「读面板」，人看着按钮没反应。
   */
  it("认不得的方法要说清楚，不当成 GET", async () => {
    const database = open();
    try {
      const answer = await serveRequest("PUT", "/api/panel", "", {
        read: { database, repo },
        write: () => { throw new Error("不该开"); },
      });

      assert.equal(answer.status, 405);
      assert.equal(typeof (answer.body as { reason?: string }).reason, "string");
    } finally {
      database.close();
    }
  });
});

describe("web · 起来时先收尸", () => {
  /*
   * 打的是真机症状（2026-08-19 05:48）：一轮的进程被杀了，账本上它还是 `running`,
   * 而租约 9 分钟没续。于是**这个阶段永远派不动** —— 点「跑这个阶段」只会得到
   * `phase_already_running`，而那一轮早就没人在跑了。
   *
   * `recoverStuckTurns` 早就写好了（超时的判失败、Change 从 running 里出来），
   * 只是删掉面板进程之后**没人叫它**。工作台起来时该跑一次：它是这台机器上唯一
   * 长活的那个进程。
   */
  it("租约过期的轮被收掉，这个阶段重新派得动", () => {
    const database = open();
    try {
      new ChangeStore(database, { now: () => new Date(AT) }).apply("CHG-1", "start");
      const jobs = new JobStore(database);
      jobs.enqueue({
        id: "JOB-1", changeId: "CHG-1", kind: "turn",
        deadlineAt: Date.now() - 1, maxAttempts: 1, phase: "PRD",
      });
      jobs.claimNext({ owner: "死掉的进程", token: "T-1", now: Date.now() - 3_600_000, ttlMs: 60_000 });
      assert.notEqual(jobs.busyFor("CHG-1", "PRD"), null, "收尸之前它挡着");

      reapStaleRounds(database);

      assert.equal(jobs.busyFor("CHG-1", "PRD"), null, "收完就不挡了");
      assert.notEqual(new ChangeStore(database).read("CHG-1").state.status, "running");
    } finally {
      database.close();
    }
  });

  /** 活着的轮**不许**被收 —— 收尸人收错一次，人正跑着的活儿就没了。 */
  it("租约还在续的轮一根汗毛都不碰", () => {
    const database = open();
    try {
      new ChangeStore(database, { now: () => new Date(AT) }).apply("CHG-1", "start");
      const jobs = new JobStore(database);
      jobs.enqueue({
        id: "JOB-1", changeId: "CHG-1", kind: "turn",
        deadlineAt: Date.now() + 3_600_000, maxAttempts: 1, phase: "PRD",
      });
      jobs.claimNext({ owner: "活着的进程", token: "T-1", now: Date.now(), ttlMs: 60_000 });

      reapStaleRounds(database);

      assert.notEqual(jobs.busyFor("CHG-1", "PRD"), null, "它还活着，不该被收");
    } finally {
      database.close();
    }
  });
});
