import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  childThreadsOf,
  readThreadTranscript,
  SubAgentNotFoundError,
  SubAgentUnfinishedError,
} from "./subagent";


const RED_TID = "019fb428-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
const BLUE_TID = "019fb429-bbbb-7bbb-bbbb-bbbbbbbbbbbb";

const line = (payload: object) =>
  JSON.stringify({ type: "event_msg", payload });
const finished = (text: string) => [
  line({ type: "task_started" }),
  line({ type: "agent_message", message: text }),
  line({ type: "task_complete" }),
].join("\n");

describe("L4 · 按线程 id 读它自己的话", () => {
  const files: Record<string, string> = {
    [`/s/2026/07/30/rollout-2026-07-30T09-18-06-${RED_TID}.jsonl`]:
      [finished("第一轮"), finished("第二轮")].join("\n"),
    [`/s/2026/07/30/rollout-2026-07-30T09-19-06-${BLUE_TID}.jsonl`]: finished("蓝方说的"),
  };
  const list = () => Object.keys(files);
  const read = (path: string) => files[path]!;

  it("找到那一条，而且读的是**最后**一轮", () => {
    assert.equal(
      readThreadTranscript({ threadId: RED_TID, list, read }),
      "第二轮",
    );
  });

  it("大小写不敏感 —— 文件名里的 id 可能是大写", () => {
    assert.equal(
      readThreadTranscript({ threadId: BLUE_TID.toUpperCase(), list, read }),
      "蓝方说的",
    );
  });

  it("**没有这条线程 —— 抛，不返回空**", () => {
    // 空字符串会被上游读成「这一方什么都没说」，而那和「找不到」是两件事。
    assert.throws(
      () => readThreadTranscript({ threadId: "019fb999-9999-7999-9999-999999999999", list, read }),
      SubAgentNotFoundError,
    );
  });

  it("**一轮都没跑完 —— 抛**", () => {
    assert.throws(
      () => readThreadTranscript({
        threadId: RED_TID, list,
        read: () => [line({ type: "task_started" })].join("\n"),
      }),
      SubAgentUnfinishedError,
    );
  });
});

describe("L4 · 按血缘认这一轮的两条子线程", () => {
  const JUDGE = "019fc396-0000-7000-8000-000000000000";
  const RED = "019fc39f-1111-7111-8111-111111111111";
  const BLUE = "019fc3a2-2222-7222-8222-222222222222";
  const OTHER = "019fc3a5-3333-7333-8333-333333333333";

  const meta = (payload: object) =>
    JSON.stringify({ type: "session_meta", payload });
  const child = (id: string, parent: string, at: string) =>
    meta({ id, parent_thread_id: parent, thread_source: "subagent", timestamp: at });

  const at = (second: string) => `2026-08-02T09:${second}:00.000Z`;
  const file = (id: string) => `/s/2026/08/02/rollout-2026-08-02T09-00-00-${id}.jsonl`;

  const from = (files: Record<string, string>) => ({
    list: () => Object.keys(files),
    read: (path: string) => files[path]!,
  });

  it("**先出生的是红方，后出生的是蓝方** —— 顺序就是身份", () => {
    // 故意让文件的排列顺序和出生顺序相反：认的是 session_meta 里的时刻，
    // 不是目录给出来的次序。
    const files = {
      [file(BLUE)]: child(BLUE, JUDGE, at("20")),
      [file(RED)]: child(RED, JUDGE, at("10")),
    };
    assert.deepEqual(
      childThreadsOf({ parentThreadId: JUDGE, ...from(files) }),
      [RED, BLUE],
    );
  });

  it("别人家的孩子不算", () => {
    const files = {
      [file(RED)]: child(RED, JUDGE, at("10")),
      [file(OTHER)]: child(OTHER, "019fc999-9999-7999-8999-999999999999", at("15")),
    };
    assert.deepEqual(childThreadsOf({ parentThreadId: JUDGE, ...from(files) }), [RED]);
  });

  it("裁判自己那条不算 —— 它是 user，不是 subagent", () => {
    const files = {
      [file(JUDGE)]: meta({ id: JUDGE, thread_source: "user" }),
      [file(RED)]: child(RED, JUDGE, at("10")),
    };
    assert.deepEqual(childThreadsOf({ parentThreadId: JUDGE, ...from(files) }), [RED]);
  });

  it("**一条线程两个文件只算一条** —— 补问 resume 会另起一个", () => {
    const files = {
      [file(RED)]: child(RED, JUDGE, at("10")),
      [`${file(BLUE)}.1`]: child(BLUE, JUDGE, at("20")),
      // 补问那次 resume 落成了第二个文件，出生时刻更晚。
      [`${file(BLUE)}.2`]: child(BLUE, JUDGE, at("40")),
    };
    const found = childThreadsOf({ parentThreadId: JUDGE, ...from(files) });
    assert.deepEqual(found, [RED, BLUE]);
  });

  it("**去重取最早的那次** —— 否则 resume 会把蓝方排到别人后面", () => {
    const files = {
      [`${file(BLUE)}.1`]: child(BLUE, JUDGE, at("10")),
      [`${file(BLUE)}.2`]: child(BLUE, JUDGE, at("40")),
      [file(OTHER)]: child(OTHER, JUDGE, at("20")),
    };
    assert.deepEqual(
      childThreadsOf({ parentThreadId: JUDGE, ...from(files) }),
      [BLUE, OTHER],
    );
  });

  it("读坏一个文件不让整次扫描失败", () => {
    const files = { [file(RED)]: child(RED, JUDGE, at("10")), [file(OTHER)]: "" };
    const read = (path: string) => {
      if (path === file(OTHER)) throw new Error("文件正在被写");
      return files[path]!;
    };
    assert.deepEqual(
      childThreadsOf({ parentThreadId: JUDGE, list: () => Object.keys(files), read }),
      [RED],
    );
  });

  it("一个都没有就是空 —— 是不是错由上层判", () => {
    assert.deepEqual(childThreadsOf({ parentThreadId: JUDGE, ...from({}) }), []);
  });
});
