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

/**
 * 认回人自己跑的那条线程（2026-08-19 甲）。
 *
 * 判据是真机实测的（见 `findThreads` 的注释）：`thread/list` 每条**没有 `title`**，
 * 第一条用户消息在 `preview` 里，而且不截断。
 */
describe("AppServerHistory · 按 (工作目录, 标记) 认回线程", () => {
  const listing = (...threads: unknown[]) => ({ data: threads, nextCursor: null });
  const thread = (input: {
    id: string; cwd: string; preview: string; updatedAt?: number; parent?: string;
  }) => ({
    id: input.id, cwd: input.cwd, preview: input.preview,
    updatedAt: input.updatedAt ?? 1, name: null, turns: [],
    parentThreadId: input.parent ?? null,
  });

  const SCRIPT = "/var/folders/T/stagepass-round-9OSOMq/round-script-Spec-r10.md";
  const envelope = (path: string) =>
    `你是本轮的裁判。阶段：Spec，第 10 轮。\n这一轮的完整题面在这个文件里：${path}\n读完照它执行。`;

  it("**认的是 preview，不是 name** —— StagePass 开的线程上 name 是 null", async () => {
    const connection = new FakeConnection().reply(listing(
      thread({ id: "T-1", cwd: "/repo", preview: envelope(SCRIPT) }),
    ));

    const found = await new AppServerHistory(connection)
      .findThreads({ cwd: "/repo", marker: SCRIPT });

    assert.deepEqual(found.map((each) => each.id), ["T-1"]);
  });

  it("**同一份题面在别的仓库里不算** —— 工作目录是判据的一半", async () => {
    const connection = new FakeConnection().reply(listing(
      thread({ id: "T-1", cwd: "/别人的仓库", preview: envelope(SCRIPT) }),
    ));

    const found = await new AppServerHistory(connection)
      .findThreads({ cwd: "/repo", marker: SCRIPT });

    assert.deepEqual(found, []);
  });

  it("**别的轮次不会被认成这一轮** —— 题面路径每轮一个随机目录", async () => {
    const other = "/var/folders/T/stagepass-round-3M4n70/round-script-Spec-r1.md";
    const connection = new FakeConnection().reply(listing(
      thread({ id: "T-旧", cwd: "/repo", preview: envelope(other) }),
      thread({ id: "T-新", cwd: "/repo", preview: envelope(SCRIPT) }),
    ));

    const found = await new AppServerHistory(connection)
      .findThreads({ cwd: "/repo", marker: SCRIPT });

    assert.deepEqual(found.map((each) => each.id), ["T-新"]);
  });

  it("**贴了两次就给两条，按新到旧** —— 这一层不替人挑", async () => {
    // 人第一次跑挂了、把同一个信封又贴进一条新线程。替他挑一条，挑错的那次
    // 他永远看不见 —— 所以全给出去，怎么办归上面那层。
    const connection = new FakeConnection().reply(listing(
      thread({ id: "T-先", cwd: "/repo", preview: envelope(SCRIPT), updatedAt: 100 }),
      thread({ id: "T-后", cwd: "/repo", preview: envelope(SCRIPT), updatedAt: 200 }),
    ));

    const found = await new AppServerHistory(connection)
      .findThreads({ cwd: "/repo", marker: SCRIPT });

    assert.deepEqual(found.map((each) => each.id), ["T-后", "T-先"]);
  });

  it("**子 Agent 认不进来** —— 它那句开场白和信封一字不差", async () => {
    /*
     * 2026-08-19 真机：一个 marker 认回 3 条。裁判把信封**原样转达**给正反两方
     * （题面就是这么要求它的），于是两条子线程的 preview 和裁判那条逐字节相同 ——
     * 按正文根本分不开。真机上第二个 marker 认回的第一条就是红方那条。
     *
     * 收错了：拿子 Agent 当裁判去数它的孩子，一个都没有 → 整轮报
     * `round_agents_not_found`，而人看到的是「我明明跑完了」。
     */
    const connection = new FakeConnection().reply(listing(
      thread({ id: "T-裁判", cwd: "/repo", preview: envelope(SCRIPT), updatedAt: 100 }),
      // 红方：父亲是裁判，开场白一字不差，而且**更新得更晚**（它后出生）。
      thread({ id: "T-红", cwd: "/repo", preview: envelope(SCRIPT), updatedAt: 200, parent: "T-裁判" }),
      thread({ id: "T-蓝", cwd: "/repo", preview: envelope(SCRIPT), updatedAt: 300, parent: "T-裁判" }),
    ));

    const found = await new AppServerHistory(connection)
      .findThreads({ cwd: "/repo", marker: SCRIPT });

    assert.deepEqual(found.map((each) => each.id), ["T-裁判"],
      "按新到旧排的话，两条子 Agent 会排在裁判前面");
  });

  it("翻完所有分页 —— 人那条线程可能压在第三页", async () => {
    const connection = new FakeConnection().reply(
      { data: [thread({ id: "T-别的", cwd: "/repo", preview: "无关" })], nextCursor: "c2" },
      { data: [thread({ id: "T-要的", cwd: "/repo", preview: envelope(SCRIPT) })], nextCursor: null },
    );

    const found = await new AppServerHistory(connection)
      .findThreads({ cwd: "/repo", marker: SCRIPT });

    assert.deepEqual(found.map((each) => each.id), ["T-要的"]);
  });
});
