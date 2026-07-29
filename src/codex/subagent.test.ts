import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BLUE, RED } from "../domain/round";
import {
  readRoleTranscript,
  SubAgentNotFoundError,
  SubAgentUnfinishedError,
  type SubAgentLookup,
} from "./subagent";

const JUDGE = "019fabe0-0bc4-73b1-be75-20471ba7f229";

const line = (payload: object) =>
  JSON.stringify({ type: "event_msg", payload });
const finished = (text: string) => [
  line({ type: "task_started" }),
  line({ type: "agent_message", message: text }),
  line({ type: "task_complete" }),
].join("\n");

/** Shaped like the real join: parent id in, agent_path plus rollout out. */
function lookup(children: { agentPath: string; rolloutPath: string }[]): SubAgentLookup {
  return {
    children: (parentThreadId) =>
      parentThreadId === JUDGE
        ? children.map((child, index) => ({ ...child, threadId: `T-${index}` }))
        : [],
  };
}

describe("L4 · each role is read from its own file", () => {
  it("returns what that role said, and only that role", () => {
    const files: Record<string, string> = {
      "/r/red.jsonl": finished("红方的产出"),
      "/r/blue.jsonl": finished("蓝方的质疑"),
    };
    const deps = {
      lookup: lookup([
        { agentPath: RED, rolloutPath: "/r/red.jsonl" },
        { agentPath: BLUE, rolloutPath: "/r/blue.jsonl" },
      ]),
      parentThreadId: JUDGE,
      read: (path: string) => files[path]!,
    };
    assert.equal(readRoleTranscript({ ...deps, agentPath: RED }), "红方的产出");
    assert.equal(readRoleTranscript({ ...deps, agentPath: BLUE }), "蓝方的质疑");
  });

  /**
   * The misreading this guards against is the worst one available: an empty
   * result would reach the gate as "blue found nothing", which is a clean bill
   * of health issued because a lookup failed.
   */
  it("fails loudly when a role is missing", () => {
    assert.throws(
      () => readRoleTranscript({
        lookup: lookup([{ agentPath: RED, rolloutPath: "/r/red.jsonl" }]),
        parentThreadId: JUDGE,
        agentPath: BLUE,
        read: () => finished("x"),
      }),
      (error: unknown) =>
        error instanceof SubAgentNotFoundError && error.agentPath === BLUE,
    );
  });

  it("fails loudly when a role has not finished", () => {
    assert.throws(
      () => readRoleTranscript({
        lookup: lookup([{ agentPath: BLUE, rolloutPath: "/r/blue.jsonl" }]),
        parentThreadId: JUDGE,
        agentPath: BLUE,
        // Started, never completed.
        read: () => line({ type: "task_started" }),
      }),
      SubAgentUnfinishedError,
    );
  });

  it("finds nothing under a thread that spawned nothing", () => {
    assert.throws(
      () => readRoleTranscript({
        lookup: lookup([{ agentPath: RED, rolloutPath: "/r/red.jsonl" }]),
        parentThreadId: "SOME-OTHER-THREAD",
        agentPath: RED,
        read: () => finished("x"),
      }),
      SubAgentNotFoundError,
    );
  });

  it("joins everything a role said across one turn", () => {
    assert.equal(
      readRoleTranscript({
        lookup: lookup([{ agentPath: BLUE, rolloutPath: "/r/blue.jsonl" }]),
        parentThreadId: JUDGE,
        agentPath: BLUE,
        read: () => [
          line({ type: "task_started" }),
          line({ type: "agent_message", message: "第一点" }),
          line({ type: "agent_message", message: "第二点" }),
          line({ type: "task_complete" }),
        ].join("\n"),
      }),
      "第一点\n第二点",
    );
  });
});
