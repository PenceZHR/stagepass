import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DECISION_FIELD } from "../domain/question";
import {
  elicitationParams,
  handleMessage,
  PROTOCOL_VERSION,
  TOOL_DEFINITION,
  TOOL_NAME,
  type OpenQuestion,
  type PluginDependencies,
} from "./protocol";

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
  const base: PluginDependencies = {
    readQuestion: () => QUESTION,
    recordAnswer: (questionId, result) => { recorded.push({ questionId, result }); },
    elicit: async (question) => {
      asked.push(question);
      return { action: "accept", content: { [DECISION_FIELD]: "approve" } };
    },
  };
  return { deps: { ...base, ...overrides }, recorded, asked };
}

const call = (questionId: unknown = "Q-1") => ({
  jsonrpc: "2.0", id: 7, method: "tools/call",
  params: { name: TOOL_NAME, arguments: { questionId } },
});

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

  it("lists exactly one tool, taking only a question id", async () => {
    const reply = await handleMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" }, deps().deps);
    const tools = (reply?.result as { tools: typeof TOOL_DEFINITION[] }).tools;
    assert.equal(tools.length, 1);
    assert.deepEqual(tools[0]?.inputSchema.required, ["questionId"]);
    assert.deepEqual(
      Object.keys(tools[0]?.inputSchema.properties ?? {}), ["questionId"],
    );
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
    const { deps: d, recorded, asked } = deps({ readQuestion: () => null });
    const reply = await handleMessage(call(), d);
    const result = reply?.result as { isError: boolean; content: { text: string }[] };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /not open; nothing was asked/);
    assert.deepEqual(asked, []);
    assert.deepEqual(recorded, []);
  });

  it("refuses a call with no question id", async () => {
    // Built by hand rather than through `call()`: passing `undefined` to a
    // parameter with a default silently substitutes the default, so the test
    // would have asserted against a perfectly valid id.
    const missing = {
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: TOOL_NAME, arguments: {} },
    };
    for (const message of [missing, call(""), call(7), {
      jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: TOOL_NAME },
    }]) {
      const reply = await handleMessage(message, deps().deps);
      assert.equal(
        (reply?.result as { isError?: boolean }).isError, true,
        JSON.stringify(message.params),
      );
    }
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
