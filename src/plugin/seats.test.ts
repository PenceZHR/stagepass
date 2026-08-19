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
  /** 轮询完成判定读到的轮次。`turn/start` 之后多一轮 —— 那就是「这一轮跑完了」。 */
  readonly turns: string[] = [];
  /** 这些线程 resume 会被拒（没有 rollout）。 */
  readonly noRollout = new Set<string>();
  private readonly listeners = new Set<(message: AppServerNotification) => void>();

  request(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    this.methods.push(method);
    if (method === "thread/start") return Promise.resolve({ thread: { id: "THREAD-A", turns: [] } });
    if (method === "thread/resume") {
      // 零轮次线程没有 rollout —— Codex 就是这么拒的（2026-08-18 实测原话）。
      if (this.noRollout.has(String(params.threadId))) {
        throw new Error(`no rollout found for thread id ${String(params.threadId)}`);
      }
      return Promise.resolve({ thread: { id: params.threadId, turns: [] } });
    }
    if (method === "thread/unsubscribe") return Promise.resolve({ status: "unsubscribed" });
    if (method === "thread/read") {
      return Promise.resolve({
        thread: {
          id: "THREAD-A",
          turns: this.turns.map((text) => ({
            id: "T", status: "completed", items: [{ type: "agentMessage", text }],
          })),
        },
      });
    }
    if (method === "turn/start") {
      this.turns.push("收到。");
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
  const connection = new FakeConnection();
  return new PluginSeats({
    database,
    host: new AppServerSessionHost(connection),
    /* 退订之后完成判定只能问历史 —— 这里跟着假连接的轮次数走。 */
    history: {
      readThread: async () => ({
        turnCount: connection.turns.length,
        turns: connection.turns.map((text) => ({ status: "completed", agentText: text })),
        lastCompletedText: connection.turns[connection.turns.length - 1] ?? null,
      }),
    } as never,
    pollEveryMs: 1,
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
  /*
   * 2026-08-18 之后 `has()` 问的是「手上有没有一轮在飞」，而一轮跑完它自然就不在飞了
   * —— 所以这条改成打 `release` 真正的不变量：**只放会话，不动绑定**。
   *
   * 抹掉绑定的代价很具体：下一轮会开一条新线程，而人正看着的那条从此和 StagePass
   * 失联 —— 那段历史还在 Codex 里，却再也没人认得它。
   */
  it("放掉座位只放会话，绑定原样留着 —— 下一轮回同一条线程", async () => {
    const database = open();
    try {
      const seats = seatsOn(database);
      await seats.transportFor("CHG-1", "PRD").runTurn({ threadId: null, prompt: "问一句" });
      const before = new BindingStore(database).find("CHG-1", "PRD");

      seats.release("CHG-1", "PRD");

      assert.equal(seats.has("CHG-1", "PRD"), false);
      assert.deepEqual(new BindingStore(database).find("CHG-1", "PRD"), before);
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

describe("plugin · 发完一轮就把线程还给人", () => {
  /*
   * 打的是真实症状：**人在 Codex 里点开那条线程，显示「This is open in another app」。**
   *
   * 2026-08-18 实测（`docs/DESIGN-thread-ownership-2026-08-18.md` §11）：「占用」看的是
   * **订阅**。而**关掉连接不等于退订** —— 两条线程唯一的区别就是有没有显式
   * `thread/unsubscribe`，一条打得开、一条打不开。
   *
   * 所以派完一轮必须显式退订。不退订，人全程都进不去看它跑 —— 而「人要看得见它跑」
   * 正是这套东西存在的理由。
   */
  it("turn 发出去之后显式退订，而且是在等它跑完之前", async () => {
    const database = open();
    try {
      const connection = new FakeConnection();
      const seats = new PluginSeats({
        database,
        host: new AppServerSessionHost(connection),
        history: {
          readThread: async () => ({
            turnCount: connection.turns.length,
            turns: connection.turns.map((text) => ({ status: "completed", agentText: text })),
            lastCompletedText: connection.turns[connection.turns.length - 1] ?? null,
          }),
        } as never,
        pollEveryMs: 1,
        turnTimeoutMs: 2_000,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        effort: "xhigh",
      });

      await seats.transportFor("CHG-1", "PRD").runTurn({ threadId: null, prompt: "跑一轮" });

      const started = connection.methods.indexOf("turn/start");
      const dropped = connection.methods.indexOf("thread/unsubscribe");
      assert.notEqual(dropped, -1, "一次都没退订 —— 人点开会看到「被别的 app 占着」");
      assert.equal(dropped > started, true, "退订要在发完 turn 之后");
    } finally {
      database.close();
    }
  });
});

describe("plugin · 绑着的线程在 Codex 里没了", () => {
  /*
   * 打的是真实症状：**这个阶段从此永远派不动，而错误信息说的是「no rollout found」。**
   *
   * 绑定是在 `thread/start` 那一刻就写下的（中途死掉时「线程建了但 StagePass 不知道」
   * 是最难查的状态，所以必须早写）。代价是：第一轮没跑成的话，账本上留下一条指向
   * **零轮次线程**的绑定 —— 而零轮次线程连 `threads` 表都不进，`thread/resume` 必拒
   * （2026-08-18 实测）。
   *
   * 于是这个座位被自己的绑定毒死：每一次派轮都在同一句话上失败，而那句话说的是
   * Codex 的内部状态，不是人做错了什么。
   */
  it("resume 被拒就开一条新的，而不是让这个座位永远派不动", async () => {
    const database = open();
    try {
      const connection = new FakeConnection();
      connection.noRollout.add("THREAD-DEAD");
      new BindingStore(database).bind("CHG-1", "PRD", "THREAD-DEAD");
      const seats = new PluginSeats({
        database,
        host: new AppServerSessionHost(connection),
        history: {
          readThread: async () => ({
            turnCount: connection.turns.length,
            turns: connection.turns.map((text) => ({ status: "completed", agentText: text })),
            lastCompletedText: connection.turns[connection.turns.length - 1] ?? null,
          }),
        } as never,
        pollEveryMs: 1,
        turnTimeoutMs: 2_000,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        effort: "xhigh",
      });

      const done = await seats.transportFor("CHG-1", "PRD")
        .runTurn({ threadId: null, prompt: "跑一轮" });

      assert.equal(done.threadId, "THREAD-A", "该开一条新线程");
      // 绑定要跟着换过去 —— 不换的话下一轮又撞同一条死线程。
      assert.equal(new BindingStore(database).find("CHG-1", "PRD")?.threadId, "THREAD-A");
    } finally {
      database.close();
    }
  });
});

describe("plugin · 全新线程还读不出来", () => {
  /*
   * 打的是真机症状（2026-08-18 用户截图）：
   *
   *   thread 01a017e9… is not materialized yet;
   *   includeTurns is unavailable before first user message
   *
   * 一条刚 `thread/start` 出来、还没收到第一条用户消息的线程**读不了** —— 而数基线
   * 恰恰发生在 `turn/start` 之前，正是那个读不了的窗口。
   *
   * **这不是故障，是新线程的正常状态。** 读不出来就是「它还没有轮次」，基线记 0；
   * 把它当成失败会让每一条新线程的第一轮都跑不起来 —— 也就是每个座位的第一轮。
   */
  it("第一轮：基线读不出来当作 0，不是当作失败", async () => {
    const database = open();
    try {
      const connection = new FakeConnection();
      const seats = new PluginSeats({
        database,
        host: new AppServerSessionHost(connection),
        history: {
          readThread: async () => {
            if (connection.turns.length === 0) {
              throw new Error("thread THREAD-A is not materialized yet; "
                + "includeTurns is unavailable before first user message");
            }
            return {
              turnCount: connection.turns.length,
              turns: connection.turns.map((text) => ({ status: "completed", agentText: text })),
              lastCompletedText: connection.turns[connection.turns.length - 1] ?? null,
            };
          },
        } as never,
        pollEveryMs: 1,
        turnTimeoutMs: 2_000,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        effort: "xhigh",
      });

      const done = await seats.transportFor("CHG-1", "PRD")
        .runTurn({ threadId: null, prompt: "第一轮" });

      assert.equal(done.text, "收到。");
    } finally {
      database.close();
    }
  });
});
