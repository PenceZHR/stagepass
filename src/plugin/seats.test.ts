import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppServerNotification } from "../codex/app-server-protocol";
import type { AppServerConnection } from "../codex/app-server-session";
import { AppServerSessionHost } from "../codex/app-server-transport";
import { SCHEMA_SQL } from "../db/schema";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { PluginSeats } from "./seats";
import { openDatabase } from "./sqlite-handle";

const AT = "2026-07-28T00:00:00.000Z";

/**
 * 一条假的控制连接：开线程、发一轮、**一轮当场完成**。
 *
 * `turn/start` 之后用 `setTimeout(0)` 回传 `turn/completed` —— 早一步（同步回传）
 * 时 `awaitTurn` 还没订上，那一轮会永远等下去。
 */
class FakeConnection implements AppServerConnection {
  readonly methods: string[] = [];
  private readonly listeners = new Set<(message: AppServerNotification) => void>();

  request(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    this.methods.push(method);
    if (method === "thread/start") return Promise.resolve({ thread: { id: "THREAD-A", turns: [] } });
    if (method === "thread/resume") {
      return Promise.resolve({ thread: { id: params.threadId, turns: [] } });
    }
    if (method === "turn/start") {
      setTimeout(() => {
        this.emit("turn/completed", {
          threadId: "THREAD-A",
          turn: {
            id: "TURN-1",
            status: "completed",
            items: [{ type: "agentMessage", id: "ITEM-1", text: "收到。" }],
          },
        });
      }, 0);
      return Promise.resolve({ turn: { id: "TURN-1", status: "inProgress", items: [] } });
    }
    throw new Error(`unexpected request: ${method}`);
  }

  subscribeNotifications(listener: (message: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method: string, params: Record<string, unknown>): void {
    for (const listener of this.listeners) listener({ method, params });
  }
}

function open() {
  const database = openDatabase(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database, () => new Date(AT)).ensure("PRJ-1", "海战小游戏", "/tmp/x");
  new ChangeStore(database, { now: () => new Date(AT) }).create("CHG-1", { projectId: "PRJ-1" });
  return database;
}

function seatsOn(database: ReturnType<typeof open>) {
  return new PluginSeats({
    database,
    host: new AppServerSessionHost(new FakeConnection()),
    turnTimeoutMs: 2_000,
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    effort: "xhigh",
  });
}

describe("plugin · 旁路座位", () => {
  /*
   * 打的是真实症状：**在旁路里聊了半天，按「起草」永远说「先去开旁路窗口谈」。**
   *
   * 起草（`app/converge-brief.ts`）是按 `findAside` 去认那段对话的。旁路的线程不
   * 落进 aside 绑定，那道闸就永远放行不了 —— 而人看到的只是一句自相矛盾的话。
   */
  it("旁路跑完一轮，线程记进 aside 绑定 —— 起草是照这条去找那段对话的", async () => {
    const database = open();
    try {
      const done = await seatsOn(database).asideTransport("CHG-1").runTurn({ threadId: null, prompt: "聊聊" });

      assert.equal(done.text, "收到。");
      assert.equal(new BindingStore(database).findAside("CHG-1")?.threadId, "THREAD-A");
    } finally {
      database.close();
    }
  });

  /*
   * 旁路和阶段座位是两条账，绑在同一张表的两种行上。旁路的线程落进阶段那一行，
   * 「同一阶段只许一轮」会把一次闲聊当成一轮在跑，从此这个阶段派不动。
   */
  /*
   * 打的是真实症状：**录完需求，界面一直显示「在跑」。**
   *
   * 干完活不放掉会话，`has()` 就永远是真 —— 进度那一屏的 `live` 跟着一直真，
   * 而账本上早就没有活儿了。人只能自己起疑，界面一个字都不会说。
   */
  it("座位放掉之后就不再算活着", async () => {
    const database = open();
    try {
      const seats = seatsOn(database);
      await seats.transportFor("CHG-1", "PRD").runTurn({ threadId: null, prompt: "问一句" });
      assert.equal(seats.has("CHG-1", "PRD"), true);

      seats.release("CHG-1", "PRD");

      assert.equal(seats.has("CHG-1", "PRD"), false);
    } finally {
      database.close();
    }
  });

  it("旁路的线程不占阶段座位", async () => {
    const database = open();
    try {
      await seatsOn(database).asideTransport("CHG-1").runTurn({ threadId: null, prompt: "聊聊" });

      assert.equal(new BindingStore(database).find("CHG-1", "PRD"), null);
    } finally {
      database.close();
    }
  });
});
