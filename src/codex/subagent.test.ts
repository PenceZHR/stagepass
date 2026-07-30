import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
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
