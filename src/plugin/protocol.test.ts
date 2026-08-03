import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DECISION_FIELD } from "../domain/question";
import {
  elicitationParams,
  handleMessage,
  ANSWER_TOOL,
  NEXT_TOOL,
  PROTOCOL_VERSION,
  TOOL_DEFINITIONS,
  TOOL_NAME,
  type OpenQuestion,
  type PluginDependencies,
} from "./protocol";
import type { WorkItemView } from "../domain/worklist";

const QUESTION: OpenQuestion = {
  message: "PRD：第 1 轮已结算",
  requestedSchema: {
    type: "object",
    required: [DECISION_FIELD],
    properties: {
      [DECISION_FIELD]: {
        type: "string", title: "请裁决", enum: ["approve", "reject"],
      },
    },
  },
};

function deps(overrides: Partial<PluginDependencies> = {}) {
  const recorded: { questionId: string; result: unknown }[] = [];
  const asked: OpenQuestion[] = [];
  const items: { answer: string; reason: string }[] = [];
  const base: PluginDependencies = {
    openQuestion: () => ({ id: "Q-1", question: QUESTION }),
    recordAnswer: (questionId, result) => { recorded.push({ questionId, result }); },
    elicit: async (question) => {
      asked.push(question);
      return { action: "accept", content: { [DECISION_FIELD]: "approve" } };
    },
    nextItem: () => ITEM,
    recordItem: (answer, reason) => {
      items.push({ answer, reason });
      return { kind: "recorded", remaining: 1 };
    },
  };
  return { deps: { ...base, ...overrides }, recorded, asked, items };
}

const ITEM: WorkItemView = {
  ordinal: 2, total: 5,
  prompt: "这一条还成不成立：验收标准不可测",
  choices: ["closed", "still_open"],
};

/** 三个工具**都不收入参**，所以这里一个参数都不给。 */
const call = () => ({
  jsonrpc: "2.0", id: 7, method: "tools/call",
  params: { name: TOOL_NAME, arguments: {} },
});
const nextCall = () => ({
  jsonrpc: "2.0", id: 8, method: "tools/call",
  params: { name: NEXT_TOOL, arguments: {} },
});
const answerCall = (args: unknown) => ({
  jsonrpc: "2.0", id: 9, method: "tools/call",
  params: { name: ANSWER_TOOL, arguments: args },
});
const said = (reply: { result?: unknown } | null) =>
  (reply?.result as { content: { text: string }[] }).content[0]!.text;
const failed = (reply: { result?: unknown } | null) =>
  (reply?.result as { isError?: boolean }).isError === true;

describe("L3 · the plugin speaks MCP and offers one tool", () => {
  it("answers initialize with the version Codex speaks", async () => {
    const reply = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize" }, deps().deps);
    const result = reply?.result as { protocolVersion: string };
    assert.equal(result.protocolVersion, PROTOCOL_VERSION);
    // The version Codex actually spoke on 0.144.4, measured at its own
    // initialize. Asserted as a literal too, so bumping the constant is a
    // deliberate act rather than a silent one.
    assert.equal(PROTOCOL_VERSION, "2025-06-18");
  });

  it("**没有一个工具收标识符** —— 这是整套机制在协议上的样子", async () => {
    const reply = await handleMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" }, deps().deps);
    const tools = (reply?.result as { tools: typeof TOOL_DEFINITIONS[number][] }).tools;
    assert.deepEqual(tools.map((tool) => tool.name),
      [TOOL_NAME, NEXT_TOOL, ANSWER_TOOL]);

    for (const tool of tools) {
      const properties = Object.keys(tool.inputSchema.properties ?? {});
      // 只允许 answer / reason —— 一个枚举值和一句散文。别的一律是标识符。
      assert.deepEqual(properties.filter((name) =>
        name !== "answer" && name !== "reason"), [], `${tool.name} 多收了参数`);
    }
  });

  it("ignores a notification", async () => {
    assert.equal(
      await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, deps().deps),
      null,
    );
  });

  it("reports an unknown method rather than pretending", async () => {
    const reply = await handleMessage(
      { jsonrpc: "2.0", id: 3, method: "resources/list" }, deps().deps);
    assert.equal((reply?.error as { code: number }).code, -32601);
  });
});

describe("L3 · asking, and writing down what was said", () => {
  it("puts StagePass's own wording and options to the human", async () => {
    const { deps: d, asked, recorded } = deps();
    const reply = await handleMessage(call(), d);

    assert.deepEqual(asked, [QUESTION]);
    assert.deepEqual(recorded, [{
      questionId: "Q-1",
      result: { action: "accept", content: { [DECISION_FIELD]: "approve" } },
    }]);
    assert.match(
      ((reply?.result as { content: { text: string }[] }).content[0]!).text,
      /Recorded/,
    );
  });

  it("sends the schema through unchanged", () => {
    assert.deepEqual(elicitationParams(QUESTION), {
      message: QUESTION.message,
      requestedSchema: QUESTION.requestedSchema,
    });
  });

  it("records a decline as faithfully as an acceptance", async () => {
    const { deps: d, recorded } = deps({ elicit: async () => ({ action: "cancel" }) });
    await handleMessage(call(), d);
    assert.deepEqual(recorded, [{ questionId: "Q-1", result: { action: "cancel" } }]);
  });
});

describe("L3 · the plugin refuses rather than inventing", () => {
  /**
   * The worst possible response to "there is no such question" is to answer it
   * anyway. StagePass may have superseded it, or it may already be answered --
   * both normal, neither the model's problem to route around.
   */
  it("says nothing was asked when the question is not open", async () => {
    const { deps: d, recorded, asked } = deps({ openQuestion: () => null });
    const reply = await handleMessage(call(), d);
    assert.ok(failed(reply));
    assert.match(said(reply), /没有在等任何问题/);
    assert.deepEqual(asked, []);
    assert.deepEqual(recorded, []);
  });

  it("**模型硬塞一个 id 进来也没用** —— 问哪一个由 StagePass 定", async () => {
    // 它见过老的形状（自己的历史里、别处的文档里），可能照着塞一个。塞了不该报错，
    // 但更不该被采信 —— 采信就等于把选择权还回去了。
    const { deps: d, recorded } = deps();
    const reply = await handleMessage({
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: TOOL_NAME, arguments: { questionId: "Q-别的" } },
    }, d);

    assert.equal(failed(reply), false);
    assert.deepEqual(recorded.map((each) => each.questionId), ["Q-1"]);
  });

  it("参数整个缺席也照跑 —— 它本来就不需要参数", async () => {
    const { deps: d, recorded } = deps();
    await handleMessage({
      jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: TOOL_NAME },
    }, d);
    assert.deepEqual(recorded.map((each) => each.questionId), ["Q-1"]);
  });

  it("refuses a tool it does not have", async () => {
    const reply = await handleMessage({
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "something_else", arguments: {} },
    }, deps().deps);
    assert.equal((reply?.result as { isError: boolean }).isError, true);
  });

  it("does not record anything when the human could not be asked", async () => {
    const { deps: d, recorded } = deps({
      elicit: async () => { throw new Error("client has no elicitation capability"); },
    });
    const reply = await handleMessage(call(), d);
    const result = reply?.result as { isError: boolean; content: { text: string }[] };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /could not ask the human/);
    assert.deepEqual(recorded, []);
  });

  /**
   * A decision that was made and then lost is the worst outcome available, so
   * it must never be reported as success.
   */
  it("says so when the human answered but the answer could not be stored", async () => {
    const { deps: d } = deps({
      recordAnswer: () => { throw new Error("question is superseded, not open"); },
    });
    const reply = await handleMessage(call(), d);
    const result = reply?.result as { isError: boolean; content: { text: string }[] };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /answered but StagePass could not record it/);
  });
});

/**
 * 裁判逐条表态那条路。
 *
 * 它取代的东西：裁判把 50 字符的 gap id 和 40 字符的 criterion key 手抄进一个 json
 * 块的 key 位置上，而 StagePass 拿它们做精确匹配。抄漏一段就一整份判定作废
 * （2026-08-02 实测连抄三轮）。
 */
describe("L3 · 逐条问、只收内容", () => {
  it("**念出来的那段话里没有任何标识符** —— 没得抄，就抄不错", async () => {
    const reply = await handleMessage(nextCall(), deps().deps);
    const text = said(reply);

    assert.match(text, /第 2 条，共 5 条/);
    assert.match(text, /验收标准不可测/);
    assert.match(text, /closed \/ still_open/);
    // 这一条才是重点：条目的身份（gap id / criterion key）一个字都不往这边走。
    assert.equal(/RB:|RBC-|GAP-/.test(text), false);
  });

  it("答案和理由记下去，而模型无法指定答的是哪一条", async () => {
    const { deps: d, items } = deps();
    const reply = await handleMessage(
      answerCall({ answer: "closed", reason: "第 3 节补上了可测的验收标准" }), d);

    assert.deepEqual(items, [
      { answer: "closed", reason: "第 3 节补上了可测的验收标准" },
    ]);
    assert.match(said(reply), /还剩 1 条/);
  });

  it("答完最后一条会说「答完了」—— 否则它会一直调下去", async () => {
    const { deps: d } = deps({
      recordItem: () => ({ kind: "recorded", remaining: 0 }),
    });
    assert.match(said(await handleMessage(answerCall({ answer: "yes", reason: "有依据" }), d)),
      /答完了/);
  });

  it("没有下一条时说得明明白白 —— 和「出错了」分得开", async () => {
    const reply = await handleMessage(nextCall(), deps({ nextItem: () => null }).deps);
    assert.equal(failed(reply), false, "答完不是错");
    assert.match(said(reply), /没有要你表态的东西了/);
  });

  it("**值答错了，把允许的值原样回给它** —— 那是它当场改得过来的错", async () => {
    const { deps: d } = deps({
      recordItem: () => ({ kind: "bad_answer", choices: ["closed", "still_open"] }),
    });
    const reply = await handleMessage(answerCall({ answer: "满足", reason: "我觉得行" }), d);

    assert.ok(failed(reply));
    assert.match(said(reply), /closed \/ still_open/);
    assert.match(said(reply), /这一条还没记上/);
  });

  it("**没写理由不算答** —— 一句沉默和一句「已修复」信息量一样", async () => {
    const { deps: d, items } = deps();
    const reply = await handleMessage(answerCall({ answer: "closed", reason: "  " }), d);
    assert.ok(failed(reply));
    assert.deepEqual(items, [], "空理由不该被记下去");
  });

  it("四种结局各说各的 —— 合成一句「失败」它只会原样重试", async () => {
    const cases: [ReturnType<PluginDependencies["recordItem"]>, RegExp][] = [
      [{ kind: "nothing_open" }, /没有等着被回答的条目/],
      [{ kind: "no_reason" }, /不能是空白/],
      [{ kind: "bad_answer", choices: ["yes", "no"] }, /yes \/ no/],
    ];
    for (const [outcome, expected] of cases) {
      const { deps: d } = deps({ recordItem: () => outcome });
      const reply = await handleMessage(answerCall({ answer: "x", reason: "y" }), d);
      assert.match(said(reply), expected);
    }
  });
});
