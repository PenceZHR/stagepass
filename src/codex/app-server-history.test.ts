import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppServerError } from "./app-server-client";
import type { AppServerConnection } from "./app-server-session";
import {
  AppServerHistory,
  threadTurnEnded,
} from "./app-server-history";
import type { AppServerNotification } from "./app-server-protocol";

class FakeConnection implements AppServerConnection {
  readonly calls: Array<{
    method: string;
    params: Readonly<Record<string, unknown>>;
  }> = [];
  private readonly replies: unknown[] = [];
  private listener: ((message: AppServerNotification) => void) | null = null;

  reply(...values: unknown[]): this {
    this.replies.push(...values);
    return this;
  }

  async request(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
    this.calls.push({ method, params });
    const next = this.replies.shift();
    if (next instanceof Error) throw next;
    return next;
  }

  subscribeNotifications(
    listener: (message: AppServerNotification) => void,
  ): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }

  notify(message: AppServerNotification): void {
    this.listener?.(message);
  }
}

const user = (id: string, text: string) => ({
  id,
  type: "userMessage",
  content: [
    { type: "text", text, text_elements: [] },
    { type: "image", url: "data:image/png;base64,ignored" },
  ],
});

const agent = (id: string, text: string) => ({
  id,
  type: "agentMessage",
  text,
});

function readResponse(): unknown {
  return {
    thread: {
      id: "T-JUDGE",
      parentThreadId: null,
      status: { type: "idle" },
      turns: [
        {
          id: "TURN-1",
          status: "completed",
          items: [
            user("U-1", "第一问"),
            agent("A-1", "第一答"),
            {
              id: "SPAWN-RED",
              type: "collabAgentToolCall",
              tool: "spawnAgent",
              senderThreadId: "T-JUDGE",
              receiverThreadIds: ["T-RED"],
              agentsStates: {},
              status: "completed",
            },
          ],
        },
        {
          id: "TURN-2",
          status: "failed",
          items: [
            user("U-2", "第二问"),
            agent("A-2", "失败前半句"),
            {
              id: "LEGACY-BLUE",
              type: "subAgentActivity",
              kind: "started",
              agentPath: "/root/blue",
              agentThreadId: "T-BLUE",
            },
            {
              id: "LEGACY-BLUE-DUP",
              type: "subAgentActivity",
              kind: "interacted",
              agentPath: "/root/blue",
              agentThreadId: "T-BLUE",
            },
          ],
        },
        {
          id: "TURN-3",
          status: "completed",
          items: [user("U-3", "第三问"), agent("A-3", "最后完整答案")],
        },
        {
          id: "TURN-4",
          status: "inProgress",
          items: [user("U-4", "尚未回答")],
        },
      ],
    },
  };
}

describe("App Server history", () => {
  it("用 thread/read 归一化完整历史、最后完整回答和子 Agent 血缘", async () => {
    const connection = new FakeConnection().reply(readResponse());
    const history = new AppServerHistory(connection);

    const found = await history.readThread("T-JUDGE");

    assert.deepEqual(connection.calls, [{
      method: "thread/read",
      params: { threadId: "T-JUDGE", includeTurns: true },
    }]);
    assert.ok(found !== null);
    assert.equal(found.id, "T-JUDGE");
    assert.equal(found.turnCount, 4);
    assert.deepEqual(found.userMessages, [
      "第一问", "第二问", "第三问", "尚未回答",
    ]);
    assert.equal(
      found.allText,
      "第一问\n第一答\n第二问\n失败前半句\n第三问\n最后完整答案\n尚未回答",
    );
    assert.equal(found.lastCompletedText, "最后完整答案");
    assert.deepEqual(found.childThreadIds, ["T-RED", "T-BLUE"]);
    assert.equal(found.contextUsage, null);
  });

  it("只把明确的 thread not loaded 当 missing，断线和别的协议错误继续抛", async () => {
    /*
     * 2026-08-18 起 `thread not loaded` 会先**借回来**读一次（让出订阅权之后，
     * 线程被卸载是常态，见下面那组）。所以这里让借也借不到 —— resume 就拒 ——
     * 那才是真的没有这条线程，仍然是 null。
     */
    const missing = new FakeConnection().reply(
      new AppServerError("app_server_request_failed", "thread not loaded: T-MISSING", -32600),
      new AppServerError("app_server_request_failed", "thread not loaded: T-MISSING", -32600),
    );
    assert.equal(await new AppServerHistory(missing).readThread("T-MISSING"), null);

    const disconnected = new AppServerError(
      "app_server_disconnected",
      "codex app-server exited",
    );
    const broken = new FakeConnection().reply(disconnected);
    await assert.rejects(
      new AppServerHistory(broken).readThread("T-UNKNOWN"),
      (error) => error === disconnected,
    );

    const badRequest = new AppServerError(
      "app_server_request_failed",
      "invalid thread id",
      -32600,
    );
    const invalid = new FakeConnection().reply(badRequest);
    await assert.rejects(
      new AppServerHistory(invalid).readThread("not-an-id"),
      (error) => error === badRequest,
    );
  });

  it("缓存官方 tokenUsage 通知，并把最近请求用量映射为上下文占用", async () => {
    const connection = new FakeConnection().reply(readResponse(), readResponse());
    const history = new AppServerHistory(connection);
    assert.equal((await history.readThread("T-JUDGE"))?.contextUsage, null);

    connection.notify({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "T-JUDGE",
        turnId: "TURN-3",
        tokenUsage: {
          last: {
            inputTokens: 90,
            cachedInputTokens: 10,
            outputTokens: 9,
            reasoningOutputTokens: 1,
            totalTokens: 100,
          },
          total: {
            inputTokens: 190,
            cachedInputTokens: 10,
            outputTokens: 19,
            reasoningOutputTokens: 1,
            totalTokens: 210,
          },
          modelContextWindow: 258400,
        },
      },
    });

    assert.deepEqual((await history.readThread("T-JUDGE"))?.contextUsage, {
      used: 100,
      window: 258400,
    });
  });

  it("零轮次线程只在 loaded/list 里，照样算 open", async () => {
    // thread/list 看不见还没落盘的线程。2026-08-17 真机：面板据此报 missing →
    // detach → 重绑，而 daemon 内存里它一直在。判据得先问 loaded。
    const connection = new FakeConnection().reply({
      data: ["T-OTHER", "T-WANTED"],
      nextCursor: null,
    });

    assert.equal(
      await new AppServerHistory(connection).availability("T-WANTED"),
      "open",
    );
    assert.deepEqual(
      connection.calls.map((call) => call.method),
      ["thread/loaded/list"],
      "loaded 命中就不该再去翻 thread/list",
    );
  });

  it("loaded 里没有时，thread/list 的公开分页语义区分 open / archived / missing", async () => {
    const notLoaded = { data: [], nextCursor: null };

    const open = new FakeConnection().reply(notLoaded, {
      data: [{ id: "T-OTHER" }],
      nextCursor: "NEXT",
    }, {
      data: [{ id: "T-WANTED" }],
      nextCursor: null,
    });
    assert.equal(
      await new AppServerHistory(open).availability("T-WANTED"),
      "open",
    );
    assert.deepEqual(
      open.calls.map((call) => call.method),
      ["thread/loaded/list", "thread/list", "thread/list"],
    );
    assert.equal(open.calls[2]?.params.cursor, "NEXT");

    const archived = new FakeConnection().reply(
      notLoaded,
      { data: [], nextCursor: null },
      { data: [{ id: "T-WANTED" }], nextCursor: null },
    );
    assert.equal(
      await new AppServerHistory(archived).availability("T-WANTED"),
      "archived",
    );
    assert.deepEqual(
      archived.calls
        .filter((call) => call.method === "thread/list")
        .map((call) => call.params.archived),
      [false, true],
    );

    const absent = new FakeConnection().reply(
      notLoaded,
      { data: [], nextCursor: null },
      { data: [], nextCursor: null },
    );
    assert.equal(
      await new AppServerHistory(absent).availability("T-WANTED"),
      "missing",
    );
  });

  it("归档和解归档只走 App Server 请求", async () => {
    const connection = new FakeConnection().reply({}, { thread: { id: "T-1" } });
    const history = new AppServerHistory(connection);

    await history.archive("T-1");
    await history.unarchive("T-1");

    assert.deepEqual(connection.calls, [
      { method: "thread/archive", params: { threadId: "T-1" } },
      { method: "thread/unarchive", params: { threadId: "T-1" } },
    ]);
  });

  it("交给原生 TUI 前解除 thread 订阅，并可从控制连接精确中断 turn", async () => {
    const connection = new FakeConnection().reply(
      { status: "unsubscribed" },
      {},
    );
    const history = new AppServerHistory(connection);

    await history.unsubscribeThread("T-1");
    await history.interruptTurn("T-1", "TURN-1");

    assert.deepEqual(connection.calls, [
      { method: "thread/unsubscribe", params: { threadId: "T-1" } },
      { method: "turn/interrupt", params: { threadId: "T-1", turnId: "TURN-1" } },
    ]);
  });

  it("只读状态不拉完整历史，轮询 turn 只取最近一页", async () => {
    const response = readResponse() as {
      thread: { turns: unknown[] };
    };
    const connection = new FakeConnection().reply(
      {
        thread: {
          id: "T-JUDGE",
          status: { type: "active", activeFlags: [] },
        },
      },
      {
        data: [response.thread.turns[3]],
        nextCursor: "OLDER",
        backwardsCursor: "NEWER",
      },
    );
    const history = new AppServerHistory(connection);

    assert.equal(await history.readThreadStatus("T-JUDGE"), "active");
    assert.deepEqual(
      (await history.readRecentTurns("T-JUDGE", 20)).map((turn) => turn.id),
      ["TURN-4"],
    );
    assert.deepEqual(connection.calls, [
      {
        method: "thread/read",
        params: { threadId: "T-JUDGE", includeTurns: false },
      },
      {
        method: "thread/turns/list",
        params: {
          threadId: "T-JUDGE",
          limit: 20,
          sortDirection: "desc",
          itemsView: "full",
        },
      },
    ]);
  });

  it("能判断 checkpoint 之后是否有含指定提示词的终态 turn", async () => {
    const connection = new FakeConnection().reply(readResponse());
    const found = await new AppServerHistory(connection).readThread("T-JUDGE");
    assert.ok(found !== null);
    assert.equal(threadTurnEnded(found, 1, "第三问"), true);
    assert.equal(threadTurnEnded(found, 3, "尚未回答"), false);
    assert.equal(threadTurnEnded(found, 4, "第三问"), false);
  });

  it("一条还没跑过 turn 的新线程，问它有几轮就是零轮，不是失败", async () => {
    /*
     * 2026-08-17 真机：裁决选了「再来一轮」，续跑那一刀新建了线程，紧接着
     * `readRecentTurns` 去问它有没有在跑的 turn —— app-server 回
     * `thread ... is not materialized yet; thread/turns/list is unavailable
     * before first user message`，整个 job 当场 failed。
     *
     * 一条还没收到过第一条用户消息的线程，**可证明**有零轮 turn。那是答案，不是错误。
     */
    const fresh = new FakeConnection().reply(new AppServerError(
      "app_server_request_failed",
      "thread 01a00f16-1cca-7303-a489-fc90d225ae5a is not materialized yet; "
      + "thread/turns/list is unavailable before first user message",
      -32600,
    ));
    assert.deepEqual(
      await new AppServerHistory(fresh).readRecentTurns("01a00f16-1cca-7303-a489-fc90d225ae5a", 5),
      [],
    );

    // 别的协议错误照抛 —— 不能拿这条把所有失败都吞掉。
    const other = new AppServerError("app_server_request_failed", "invalid limit", -32600);
    await assert.rejects(
      new AppServerHistory(new FakeConnection().reply(other)).readRecentTurns("T-X", 5),
      (error) => error === other,
    );
  });
});

/**
 * 退订之后，线程会被 app-server **卸载**，而卸载和「不存在」在错误里长得一样。
 *
 * 2026-08-18 真机：StagePass 让出订阅权（线程还给人）之后，一轮跑完紧接着去读红蓝
 * 两方，扑了个空 —— `thread not loaded` → `readThread` 返回 null →
 * `no App Server thread …`，整轮判失败。而那一轮其实跑完了。
 *
 * turn 在跑的时候线程是加载着的（所以轮询读得到），turn 一结束、没人订阅，它就被
 * 卸载了。**「没加载」是可以自己解决的**：借回来、读、放掉。
 */
class UnloadedThenLoaded implements AppServerConnection {
  readonly methods: string[] = [];
  private served = false;

  async request(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
    this.methods.push(method);
    if (method === "thread/read") {
      if (!this.served) {
        this.served = true;
        throw new AppServerError(
          "app_server_request_failed",
          `thread not loaded: ${String(params.threadId)}`,
          -32600,
        );
      }
      return {
        thread: {
          id: params.threadId,
          turns: [{ id: "T-1", status: "completed", items: [] }],
        },
      };
    }
    if (method === "thread/resume") return { thread: { id: params.threadId, turns: [] } };
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    throw new Error(`unexpected: ${method}`);
  }

  subscribeNotifications(): () => void { return () => {}; }
}

describe("AppServerHistory · 线程被卸载了就借回来读", () => {
  it("`thread not loaded` 不是「不存在」—— resume 一下再读，读完放掉", async () => {
    const connection = new UnloadedThenLoaded();
    const history = new AppServerHistory(connection);

    const thread = await history.readThread("T-1");

    assert.notEqual(thread, null, "被卸载不等于不存在，不该返回 null");
    assert.deepEqual(connection.methods, [
      "thread/read", "thread/resume", "thread/read", "thread/unsubscribe",
    ], "借回来读完要放掉 —— 不放就等于把线程从人手里抢回来了");
  });
});
