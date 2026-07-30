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

/**
 * 同一个阶段跑第二轮时，读到的必须是**这一轮**红蓝说的话。
 *
 * 2026-07-30 在真 Codex 上撞到的那个 bug 就长在这儿：子 Agent 的线程跨轮复用，
 * 一条 `/root/red` 的 rollout 里躺着这个阶段每一轮的答案，而这里从头读。后果是
 * **第二轮起，读到的一直是第一轮说的话** —— 轮次照常结算、gap 看着也合理，
 * 内容却永远停在第一轮。当天实测：红方第 3 轮报出的新 P0 一个字都没进库。
 */
describe("L4 · 第二轮读到的是第二轮", () => {
  const twoRounds = [finished("第一轮：文件不存在"), finished("第二轮：按 Plan 实现了")].join("\n");

  it("**一条 rollout 里有两轮 —— 读后面那一轮**", () => {
    assert.equal(
      readRoleTranscript({
        lookup: lookup([{ agentPath: RED, rolloutPath: "/r/red.jsonl" }]),
        parentThreadId: JUDGE, agentPath: RED,
        read: () => twoRounds,
      }),
      "第二轮：按 Plan 实现了",
    );
  });

  it("**同一个路径下有两条子 Agent —— 挑新的那条**", () => {
    /*
     * 实测里 Codex 是复用同一条线程的，所以这一条今天走不到。留着是因为它和上面
     * 那条是**同一个坑的两种形状**：一旦哪天 Codex 改成每轮新建一条，`find` 取到的
     * 就是第一轮那条，而症状和上面一模一样 —— 悄悄读旧的。
     *
     * `children` 按 created_at 升序（store 那边定的），所以「新的」是最后一条。
     */
    assert.equal(
      readRoleTranscript({
        lookup: lookup([
          { agentPath: RED, rolloutPath: "/r/red-1.jsonl" },
          { agentPath: BLUE, rolloutPath: "/r/blue.jsonl" },
          { agentPath: RED, rolloutPath: "/r/red-2.jsonl" },
        ]),
        parentThreadId: JUDGE, agentPath: RED,
        read: (path) => finished(path === "/r/red-2.jsonl" ? "新的那一轮" : "旧的那一轮"),
      }),
      "新的那一轮",
    );
  });
});
