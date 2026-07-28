import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import vm from "node:vm";

const serverUrl = new URL("./server.mjs", import.meta.url);
const source = readFileSync(serverUrl, "utf8");
const widgetScript = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
const uiCapabilities = {
  extensions: {
    "io.modelcontextprotocol/ui": {
      mimeTypes: ["text/html;profile=mcp-app"],
    },
  },
};

assert.ok(widgetScript, "widget script should be embedded in server.mjs");

let callbackBaseUrl = "";
let callbackBodies = [];
let callbackServer;

before(async () => {
  callbackServer = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      callbackBodies.push(parsed);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "recorded",
        receiptId: parsed.receiptId,
        acceptedAt: "2026-07-26T12:00:01.000Z",
        duplicate: false,
        continuationConfirmed: true,
        continuationThreadId: parsed.threadId,
        continuationTurnId: "turn-card-continuation",
      }));
    });
  });
  await new Promise((resolve, reject) => {
    callbackServer.once("error", reject);
    callbackServer.listen(0, "127.0.0.1", resolve);
  });
  const address = callbackServer.address();
  assert.ok(address && typeof address === "object");
  callbackBaseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    callbackServer.close((error) => error ? reject(error) : resolve());
  });
});

async function callServer(requests, env = {}) {
  const child = spawn(process.execPath, [serverUrl.pathname], {
    env: {
      ...process.env,
      STAGEPASS_API_BASE_URL: callbackBaseUrl,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }
  child.stdin.end();
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, stderr);
  return new Map(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((message) => message.id !== undefined)
      .map((message) => [message.id, message]),
  );
}

function initializeRequest(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: uiCapabilities,
      clientInfo: { name: "stagepass-card-tests", version: "1.0.0" },
    },
  };
}

function presentArguments(overrides = {}) {
  return {
    interactionId: "requirements-spec-1",
    logicalTurnId: "logical-spec-1",
    projectId: "PRJ-004",
    changeId: "CHG-006",
    threadId: "thread-visible-in-codex",
    project: "StagePass",
    stage: "Spec",
    batchTitle: "运行前确认",
    helperText: "勾选后会回到当前 Codex 任务继续执行。",
    questions: [
      {
        id: "scope",
        question: "这轮需求按哪种范围执行？",
        selectionMode: "single",
        options: [
          {
            id: "focused",
            label: "聚焦当前阶段",
            description: "只完成当前阶段的必需范围。",
          },
          {
            id: "extended",
            label: "连同后续准备",
            description: "同时补齐下一阶段需要的输入。",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function batchPresentArguments(overrides = {}) {
  return {
    interactionId: "requirements-spec-batch-1",
    logicalTurnId: "logical-spec-1",
    projectId: "PRJ-004",
    changeId: "CHG-006",
    threadId: "thread-visible-in-codex",
    project: "StagePass",
    stage: "PRD",
    batchTitle: "第 1 批 · 运行前必须确认",
    helperText: "请逐题选择；提交后会在当前 Codex 任务中继续检查剩余阻塞项。",
    questions: [
      {
        id: "target-player",
        question: "这个小游戏第一版主要给谁玩？",
        selectionMode: "single",
        options: [
          { id: "solo", label: "单人玩家", description: "先保证单人完整体验。" },
          { id: "local", label: "本地双人", description: "同屏或轮流操作。" },
        ],
      },
      {
        id: "lose-condition",
        question: "哪些情况应立即判定失败？",
        selectionMode: "multiple",
        minSelections: 1,
        maxSelections: 2,
        options: [
          { id: "timeout", label: "倒计时结束" },
          { id: "collision", label: "碰到障碍" },
        ],
      },
    ],
    ...overrides,
  };
}

test("choice tool contract accepts one to ten concrete questions in one batch", async () => {
  const responses = await callServer([
    initializeRequest(),
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  const present = responses.get(2).result.tools.find(
    (tool) => tool.name === "present_stagepass_choices",
  );
  const record = responses.get(2).result.tools.find(
    (tool) => tool.name === "record_stagepass_choice",
  );

  assert.equal(present.inputSchema.properties.questions.minItems, 1);
  assert.equal(present.inputSchema.properties.questions.maxItems, 10);
  assert.equal(
    present.inputSchema.properties.questions.items.properties.options.maxItems,
    8,
  );
  assert.equal(record.inputSchema.properties.answers.maxItems, 10);
  assert.match(present.description, /concrete requirement questions/i);
});

test("present returns a concrete question batch instead of a dimension checklist", async () => {
  const responses = await callServer([
    initializeRequest(),
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "present_stagepass_choices",
        arguments: batchPresentArguments(),
      },
    },
  ]);
  const result = responses.get(2).result;

  assert.equal(result.structuredContent.schemaVersion, "stagepass.requirement-choice/v2");
  assert.equal(result.structuredContent.questions.length, 2);
  assert.equal(
    result.structuredContent.questions[0].question,
    "这个小游戏第一版主要给谁玩？",
  );
});

test("present rejects a batch with more than ten concrete questions", async () => {
  const questions = Array.from({ length: 11 }, (_, index) => ({
    id: `question-${index + 1}`,
    question: `具体问题 ${index + 1}？`,
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  }));
  const responses = await callServer([
    initializeRequest(),
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "present_stagepass_choices",
        arguments: batchPresentArguments({ questions }),
      },
    },
  ]);

  assert.equal(responses.get(2).result.isError, true);
  assert.match(responses.get(2).result.content[0].text, /invalid_questions/);
});

test("exposes a real choice card and an app-only durable record tool", async () => {
  const responses = await callServer([
    initializeRequest(),
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "resources/list", params: {} },
  ]);
  const tools = responses.get(2).result.tools;
  const present = tools.find((tool) => tool.name === "present_stagepass_choices");
  const record = tools.find((tool) => tool.name === "record_stagepass_choice");

  assert.equal(
    present?._meta?.ui?.resourceUri,
    "ui://stagepass/requirement-choice-v2",
  );
  assert.equal(present?.inputSchema?.properties?.questions?.minItems, 1);
  assert.equal(
    present?.inputSchema?.properties?.questions?.items?.properties
      ?.selectionMode?.enum?.[0],
    "single",
  );
  assert.deepEqual(record?._meta?.ui?.visibility, ["app"]);
  assert.equal(record?._meta?.["openai/visibility"], "private");
  assert.equal(
    responses.get(3).result.resources[0].mimeType,
    "text/html;profile=mcp-app",
  );
});

test("present returns the exact options for the card instead of a diagnostic prompt", async () => {
  const responses = await callServer([
    initializeRequest(),
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "present_stagepass_choices",
        arguments: presentArguments(),
      },
    },
  ]);
  const result = responses.get(2).result;

  assert.equal(result.structuredContent.status, "awaiting_selection");
  assert.equal(
    result.structuredContent.questions[0].question,
    "这轮需求按哪种范围执行？",
  );
  assert.deepEqual(
    result.structuredContent.questions[0].options.map((option) => option.id),
    ["focused", "extended"],
  );
  assert.match(result.content[0].text, /waiting for the user's answers/i);
  assert.doesNotMatch(source, /发送并启动 turn|兼容桥|textarea id="prompt"/);
});

test("record validates choices, is idempotent, and persists an authoritative receipt", async () => {
  callbackBodies = [];
  const dataDirectory = mkdtempSync(join(tmpdir(), "stagepass-card-test-"));
  const requests = [
    initializeRequest(),
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "present_stagepass_choices",
        arguments: presentArguments(),
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "record_stagepass_choice",
        arguments: {
          interactionId: "requirements-spec-1",
          idempotencyKey: "requirements-spec-1:focused",
          answers: [{ questionId: "scope", selectedOptionIds: ["focused"] }],
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "record_stagepass_choice",
        arguments: {
          interactionId: "requirements-spec-1",
          idempotencyKey: "requirements-spec-1:focused",
          answers: [{ questionId: "scope", selectedOptionIds: ["focused"] }],
        },
      },
    },
  ];
  const responses = await callServer(requests, { PLUGIN_DATA: dataDirectory });
  const first = responses.get(3).result.structuredContent;
  const duplicate = responses.get(4).result.structuredContent;
  const receipts = readFileSync(
    join(dataDirectory, "stagepass-choice-receipts.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(first.status, "recorded");
  assert.equal(first.backendConfirmed, true);
  assert.equal(first.continuationConfirmed, true);
  assert.equal(first.continuationTurnId, "turn-card-continuation");
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.status, "recorded");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.receiptId, first.receiptId);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].answers[0].selectedOptionIds, ["focused"]);
  assert.equal(callbackBodies.length, 2);
  assert.equal(callbackBodies[0].logicalTurnId, "logical-spec-1");
  assert.equal(callbackBodies[0].projectId, "PRJ-004");
  assert.equal(callbackBodies[0].changeId, "CHG-006");
  assert.equal(callbackBodies[0].threadId, "thread-visible-in-codex");
  assert.deepEqual(
    callbackBodies[0].answers[0].selectedOptionIds,
    ["focused"],
  );
});

test("record rejects an unknown option and a second payload for one idempotency key", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "stagepass-card-test-"));
  const responses = await callServer([
    initializeRequest(),
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "present_stagepass_choices",
        arguments: presentArguments(),
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "record_stagepass_choice",
        arguments: {
          interactionId: "requirements-spec-1",
          idempotencyKey: "requirements-spec-1:bad",
          answers: [{ questionId: "scope", selectedOptionIds: ["missing"] }],
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "record_stagepass_choice",
        arguments: {
          interactionId: "requirements-spec-1",
          idempotencyKey: "requirements-spec-1:focused",
          answers: [{ questionId: "scope", selectedOptionIds: ["focused"] }],
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "record_stagepass_choice",
        arguments: {
          interactionId: "requirements-spec-1",
          idempotencyKey: "requirements-spec-1:focused",
          answers: [{ questionId: "scope", selectedOptionIds: ["extended"] }],
        },
      },
    },
  ], { PLUGIN_DATA: dataDirectory });

  assert.equal(responses.get(3).result.isError, true);
  assert.match(responses.get(3).result.content[0].text, /unknown_option/);
  assert.equal(responses.get(5).result.isError, true);
  assert.match(responses.get(5).result.content[0].text, /idempotency_conflict/);
});

function createElement(id, tagName = "DIV") {
  const listeners = new Map();
  const attributes = new Map();
  return {
    id,
    tagName,
    value: "",
    checked: false,
    disabled: false,
    textContent: "",
    className: "",
    dataset: {},
    children: [],
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = [...children];
    },
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    dispatch(name) {
      return listeners.get(name)?.({
        preventDefault() {},
        target: this,
      });
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    focus() {},
  };
}

function createWidgetHarness({
  recordResult = {
    structuredContent: {
      status: "recorded",
      receiptId: "receipt-1",
      acceptedAt: "2026-07-26T12:00:00.000Z",
      duplicate: false,
      backendConfirmed: true,
      continuationConfirmed: true,
      continuationThreadId: "thread-1",
      continuationTurnId: "turn-2",
    },
  },
  messageResult = {},
  openAiAliases = true,
} = {}) {
  const elements = new Map();
  const posted = [];
  const aliasCalls = [];
  const windowListeners = new Map();
  let nextElement = 0;
  const document = {
    documentElement: { lang: "zh-CN" },
    createElement(tagName) {
      const element = createElement(`generated-${++nextElement}`, tagName.toUpperCase());
      if (tagName === "input") element.type = "text";
      elements.set(element.id, element);
      return element;
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    },
  };
  const window = {
    parent: {
      postMessage(message) {
        posted.push(message);
        if (message.id === undefined) return;
        const result =
          message.method === "ui/initialize"
            ? { hostInfo: { name: "Codex" }, hostContext: {} }
            : message.method === "tools/call"
              ? recordResult
              : messageResult;
        queueMicrotask(() => {
          windowListeners.get("message")?.({
            source: window.parent,
            data: { jsonrpc: "2.0", id: message.id, result },
          });
        });
      },
    },
    addEventListener(name, listener) {
      windowListeners.set(name, listener);
    },
    openai: {
      widgetState: null,
      setWidgetState(state) {
        window.openai.widgetState = state;
      },
      ...(openAiAliases
        ? {
            async callTool(name, argumentsValue) {
              aliasCalls.push({
                method: "callTool",
                name,
                arguments: argumentsValue,
              });
              return recordResult;
            },
            async sendFollowUpMessage(message) {
              aliasCalls.push({
                method: "sendFollowUpMessage",
                message,
              });
              return messageResult;
            },
          }
        : {}),
    },
  };
  const context = vm.createContext({
    document,
    Error,
    Map,
    Object,
    Promise,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    String,
    window,
  });
  vm.runInContext(widgetScript, context);
  return {
    elements,
    posted,
    aliasCalls,
    notify(method, params) {
      windowListeners.get("message")?.({
        source: window.parent,
        data: { jsonrpc: "2.0", method, params },
      });
    },
    state() {
      return window.openai.widgetState;
    },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("widget uses the Codex App compatibility host without a redundant initialize handshake", async () => {
  const harness = createWidgetHarness();
  await settle();

  assert.equal(
    harness.posted.some((message) => message.method === "ui/initialize"),
    false,
  );
  assert.doesNotMatch(
    harness.elements.get("card-status").textContent,
    /宿主初始化失败/,
  );
});

test("widget uses the requested input mode and trusts only the backend-proved same-task continuation", async () => {
  const harness = createWidgetHarness();
  harness.notify("ui/notifications/tool-result", {
    structuredContent: {
      status: "awaiting_selection",
      ...presentArguments(),
    },
  });
  await settle();

  const options = [...harness.elements.values()].filter(
    (element) => element.tagName === "INPUT" && element.type === "radio",
  );
  assert.equal(options.length, 2);
  options[0].checked = true;
  options[0].dispatch("change");
  const submit = harness.elements.get("submit-choice");
  assert.equal(submit.disabled, false);
  submit.dispatch("click");
  await settle();

  const methods = harness.aliasCalls.map((call) => call.method);
  const recordIndex = methods.indexOf("callTool");
  assert.ok(recordIndex >= 0);
  assert.equal(methods.includes("sendFollowUpMessage"), false);
  const recordCall = harness.aliasCalls[recordIndex];
  assert.equal(recordCall.name, "record_stagepass_choice");
  assert.deepEqual(
    JSON.parse(JSON.stringify(recordCall.arguments.answers)),
    [{ questionId: "scope", selectedOptionIds: ["focused"] }],
  );
  assert.equal(harness.elements.get("card-status").dataset.state, "success");
  assert.match(harness.elements.get("card-status").textContent, /已生效/);
  assert.equal(options[0].disabled, true);
  assert.equal(harness.state().privateContent.status, "completed");
});

test("widget renders each concrete question as a card and submits one answer per question", async () => {
  const harness = createWidgetHarness();
  harness.notify("ui/notifications/tool-result", {
    structuredContent: {
      status: "awaiting_selection",
      ...batchPresentArguments(),
    },
  });
  await settle();

  const inputs = [...harness.elements.values()].filter(
    (element) => element.tagName === "INPUT",
  );
  const radios = inputs.filter((element) => element.type === "radio");
  const checkboxes = inputs.filter((element) => element.type === "checkbox");
  assert.equal(radios.length, 2);
  assert.equal(checkboxes.length, 2);
  assert.equal(harness.elements.get("submit-choice").disabled, true);

  radios[0].checked = true;
  radios[0].dispatch("change");
  assert.equal(harness.elements.get("submit-choice").disabled, true);
  checkboxes[1].checked = true;
  checkboxes[1].dispatch("change");
  assert.equal(harness.elements.get("submit-choice").disabled, false);

  harness.elements.get("submit-choice").dispatch("click");
  await settle();
  const recordCall = harness.aliasCalls.find(
    (call) => call.method === "callTool",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(recordCall.arguments.answers)),
    [
      { questionId: "target-player", selectedOptionIds: ["solo"] },
      { questionId: "lose-condition", selectedOptionIds: ["collision"] },
    ],
  );
  assert.match(harness.elements.get("card-status").textContent, /已生效/);
});

test("widget never says success when the backend has not proved same-task continuation", async () => {
  const harness = createWidgetHarness({
    recordResult: {
      structuredContent: {
        status: "recorded",
        receiptId: "receipt-1",
        acceptedAt: "2026-07-26T12:00:00.000Z",
        duplicate: false,
        backendConfirmed: true,
        continuationConfirmed: false,
        continuationThreadId: "thread-1",
        continuationTurnId: null,
      },
    },
  });
  harness.notify("ui/notifications/tool-result", {
    structuredContent: {
      status: "awaiting_selection",
      ...presentArguments(),
    },
  });
  await settle();
  const option = [...harness.elements.values()].find(
    (element) => element.tagName === "INPUT" && element.type === "radio",
  );
  option.checked = true;
  option.dispatch("change");
  harness.elements.get("submit-choice").dispatch("click");
  await settle();

  assert.notEqual(harness.elements.get("card-status").dataset.state, "success");
  // The run behind this card is gone, so the answer is recorded but can go
  // nowhere. It used to say 「请重试」, which is advice the user cannot act on:
  // retrying the card cannot revive the run, so the same click fails forever.
  // The message has to send them back to StagePass instead.
  assert.match(
    harness.elements.get("card-status").textContent,
    /已记录.*运行已经结束/,
  );
  assert.match(
    harness.elements.get("card-status").textContent,
    /重跑该阶段/,
  );
  assert.doesNotMatch(harness.elements.get("card-status").textContent, /请重试/);
  assert.equal(harness.state().privateContent.status, "recorded_only");
});

test("widget keeps the MCP Apps request bridge as a fallback host", async () => {
  const harness = createWidgetHarness({ openAiAliases: false });
  await settle();

  assert.ok(
    harness.posted.some((message) => message.method === "ui/initialize"),
  );
  assert.ok(
    harness.posted.some(
      (message) => message.method === "ui/notifications/initialized",
    ),
  );
});

test("manifest and skill describe the selection flow, not the old bridge probe", () => {
  const root = new URL("../", serverUrl);
  const manifest = JSON.parse(
    readFileSync(new URL(".codex-plugin/plugin.json", root), "utf8"),
  );
  const skill = readFileSync(
    new URL("skills/stagepass-card/SKILL.md", root),
    "utf8",
  );

  assert.equal(manifest.name, "stagepass-card");
  assert.ok(Array.isArray(manifest.interface.defaultPrompt));
  assert.match(manifest.description, /requirement/i);
  assert.match(skill, /present_stagepass_choices/);
  assert.match(skill, /1–10 个具体问题/);
  assert.match(skill, /阻塞项/);
  assert.match(skill, /继续.*下一批/);
  assert.doesNotMatch(skill, /show_stagepass_card/);
});
