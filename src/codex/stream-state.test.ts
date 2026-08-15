import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  StreamState,
  type StreamNotification,
} from "./stream-state";

function notification(
  method: string,
  params: Record<string, unknown>,
): StreamNotification {
  return { method, params };
}

const runningTurn = {
  id: "TURN-1",
  items: [],
  itemsView: { type: "full" },
  status: "inProgress",
  error: null,
  startedAt: 1,
  completedAt: null,
  durationMs: null,
};

describe("StreamState", () => {
  it("materializes agent deltas and lets completed payload become final truth", () => {
    const state = new StreamState("THREAD-1");
    state.accept(notification("turn/started", {
      threadId: "THREAD-1",
      turn: runningTurn,
    }));
    state.accept(notification("item/started", {
      threadId: "THREAD-1",
      turnId: "TURN-1",
      item: { type: "agentMessage", id: "ITEM-1", text: "" },
      startedAtMs: 1,
    }));
    state.accept(notification("item/agentMessage/delta", {
      threadId: "THREAD-1",
      turnId: "TURN-1",
      itemId: "ITEM-1",
      delta: "你好，",
    }));
    state.accept(notification("item/agentMessage/delta", {
      threadId: "THREAD-1",
      turnId: "TURN-1",
      itemId: "ITEM-1",
      delta: "StagePass",
    }));
    state.accept(notification("item/completed", {
      threadId: "THREAD-1",
      turnId: "TURN-1",
      item: {
        type: "agentMessage",
        id: "ITEM-1",
        text: "你好，StagePass。",
        phase: "final_answer",
        memoryCitation: null,
      },
      completedAtMs: 2,
    }));

    const item = state.snapshot().items[0];
    assert.equal(item?.kind, "agentMessage");
    assert.equal(item?.text, "你好，StagePass。");
    assert.equal(item?.status, "completed");
    assert.equal(state.snapshot().lastSeq, 5);
  });

  it("keeps command output separate from command metadata", () => {
    const state = new StreamState("THREAD-1");
    state.accept(notification("item/started", {
      threadId: "THREAD-1",
      turnId: "TURN-1",
      item: {
        type: "commandExecution",
        id: "ITEM-CMD",
        command: "pnpm typecheck",
        cwd: "/repo",
        status: "inProgress",
      },
      startedAtMs: 1,
    }));
    state.accept(notification("item/commandExecution/outputDelta", {
      threadId: "THREAD-1",
      turnId: "TURN-1",
      itemId: "ITEM-CMD",
      delta: "checking...\n",
    }));

    const item = state.snapshot().items[0];
    assert.equal(item?.kind, "commandExecution");
    assert.equal(item?.title, "pnpm typecheck");
    assert.equal(item?.output, "checking...\n");
  });

  it("ignores another thread and does not re-emit duplicate completion", () => {
    const state = new StreamState("THREAD-1");
    assert.equal(state.accept(notification("turn/started", {
      threadId: "THREAD-2",
      turn: runningTurn,
    })), false);
    const completed = notification("turn/completed", {
      threadId: "THREAD-1",
      turn: { ...runningTurn, status: "completed", completedAt: 2 },
    });

    assert.equal(state.accept(completed), true);
    const seq = state.snapshot().lastSeq;
    assert.equal(state.accept(completed), false);
    assert.equal(state.snapshot().lastSeq, seq);
  });

  it("reports a replay gap instead of returning a misleading suffix", () => {
    const state = new StreamState("THREAD-1", { replayLimit: 2 });
    for (let index = 0; index < 3; index += 1) {
      state.accept(notification("error", {
        threadId: "THREAD-1",
        message: `error-${index}`,
      }));
    }

    assert.equal(state.eventsAfter(0), null);
    assert.deepEqual(
      state.eventsAfter(1)?.map((event) => event.seq),
      [2, 3],
    );
  });

  it("materializes and resolves an interaction without exposing the rpc id", () => {
    const state = new StreamState("THREAD-1");
    const opened = state.openInteraction({
      kind: "commandApproval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "THREAD-1",
        turnId: "TURN-1",
        itemId: "ITEM-CMD",
        command: "git status --short",
      },
    });

    assert.equal(opened.id.startsWith("interaction-"), true);
    assert.equal("rpcId" in opened, false);
    assert.equal(state.snapshot().interactions[0]?.status, "pending");

    state.resolveInteraction(opened.id);

    assert.equal(state.snapshot().interactions[0]?.status, "resolved");
    assert.deepEqual(
      state.eventsAfter(0)?.map((event) => event.kind),
      ["interaction.requested", "interaction.resolved"],
    );
  });
});
