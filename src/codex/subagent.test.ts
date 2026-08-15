import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ThreadHistory } from "./app-server-history";
import {
  childThreadsOf,
  readThreadTranscript,
  readThreadUserMessages,
  readThreadWholeText,
  SubAgentNotFoundError,
  SubAgentUnfinishedError,
  threadContextUsage,
} from "./subagent";

const turn = (id: string, status: "completed" | "inProgress", user: string, agent: string) => ({
  id,
  status,
  userMessages: [user],
  agentText: agent,
  allText: [user, agent].filter(Boolean).join("\n"),
});

function thread(overrides: Partial<ThreadHistory> = {}): ThreadHistory {
  const turns = [
    turn("TURN-1", "completed", "第一问", "第一答"),
    turn("TURN-2", "completed", "第二问", "第二答"),
  ];
  return {
    id: "T-1",
    parentThreadId: null,
    status: "idle",
    turns,
    turnCount: turns.length,
    userMessages: ["第一问", "第二问"],
    allText: "第一问\n第一答\n第二问\n第二答",
    lastCompletedText: "第二答",
    childThreadIds: ["T-RED", "T-BLUE"],
    contextUsage: { used: 100, window: 1_000 },
    ...overrides,
  };
}

const reader = (value: ThreadHistory | null | Error) => ({
  async readThread(): Promise<ThreadHistory | null> {
    if (value instanceof Error) throw value;
    return value;
  },
});

describe("App Server subagent evidence", () => {
  it("读最后完整回答、全部文本和用户输入", async () => {
    const history = reader(thread());
    assert.equal(await readThreadTranscript({ history, threadId: "T-1" }), "第二答");
    assert.equal(
      await readThreadWholeText({ history, threadId: "T-1" }),
      "第一问\n第一答\n第二问\n第二答",
    );
    assert.deepEqual(
      await readThreadUserMessages({ history, threadId: "T-1" }),
      ["第一问", "第二问"],
    );
  });

  it("missing 和 unfinished 是两个不同错误", async () => {
    await assert.rejects(
      readThreadTranscript({ history: reader(null), threadId: "T-X" }),
      SubAgentNotFoundError,
    );
    await assert.rejects(
      readThreadTranscript({
        history: reader(thread({ lastCompletedText: null })),
        threadId: "T-1",
      }),
      SubAgentUnfinishedError,
    );
  });

  it("父线程直接给出按出生顺序排列、已去重的子线程", async () => {
    assert.deepEqual(await childThreadsOf({
      history: reader(thread()),
      parentThreadId: "T-1",
    }), ["T-RED", "T-BLUE"]);
  });

  it("上下文用量来自官方事件缓存；missing 返回 null", async () => {
    assert.deepEqual(await threadContextUsage({
      history: reader(thread()),
      threadId: "T-1",
    }), { used: 100, window: 1_000 });
    assert.equal(await threadContextUsage({
      history: reader(null),
      threadId: "T-X",
    }), null);
  });

  it("用户输入读取失败返回 null，不伪装成一句都没有", async () => {
    assert.equal(await readThreadUserMessages({
      history: reader(new Error("app-server disconnected")),
      threadId: "T-1",
    }), null);
  });
});
