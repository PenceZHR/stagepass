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
    const missing = new FakeConnection().reply(new AppServerError(
      "app_server_request_failed",
      "thread not loaded: T-MISSING",
      -32600,
    ));
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

  it("通过 thread/list 的公开分页语义区分 open / archived / missing", async () => {
    const open = new FakeConnection().reply({
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
    assert.equal(open.calls[0]?.method, "thread/list");
    assert.equal(open.calls[1]?.params.cursor, "NEXT");

    const archived = new FakeConnection().reply(
      { data: [], nextCursor: null },
      { data: [{ id: "T-WANTED" }], nextCursor: null },
    );
    assert.equal(
      await new AppServerHistory(archived).availability("T-WANTED"),
      "archived",
    );
    assert.deepEqual(archived.calls.map((call) => call.params.archived), [false, true]);

    const absent = new FakeConnection().reply(
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
});
