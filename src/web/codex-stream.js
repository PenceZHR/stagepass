/**
 * StagePass-native renderer for one Codex App Server thread.
 *
 * This module knows the browser projection only. It never sees JSON-RPC ids,
 * terminal bytes, rollout files, or gate state. The server owns those borders.
 */

const EVENT_KINDS = [
  "turn.started",
  "turn.completed",
  "item.started",
  "item.delta",
  "item.completed",
  "interaction.requested",
  "interaction.resolved",
  "error",
  "notification.unknown",
  "snapshot.required",
];

const ITEM_WORDS = {
  reasoning: "推理",
  reasoningSummary: "推理摘要",
  plan: "计划",
  commandExecution: "命令",
  fileChange: "文件变更",
  mcpToolCall: "MCP 工具",
  dynamicToolCall: "工具",
  webSearch: "搜索",
  imageView: "图像",
  subAgentActivity: "子 Agent",
  unknown: "未识别项目",
};

const TURN_WORDS = {
  inProgress: "正在回应",
  completed: "这一轮已完成",
  failed: "这一轮失败",
  interrupted: "这一轮已中断",
};

const INTERACTION_WORDS = {
  commandApproval: "命令需要你的许可",
  fileChangeApproval: "文件变更需要你的许可",
  permissionsApproval: "Codex 请求额外权限",
  mcpElicitation: "StagePass 正在问你",
  toolUserInput: "Codex 需要你的选择",
};

const record = (value) => value && typeof value === "object" && !Array.isArray(value)
  ? value : {};

const string = (value, fallback = "") => typeof value === "string" ? value : fallback;

const endpoint = (path) => `/api/codex/${path}`;

function jsonBody(value) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}

async function jsonResponse(response) {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(string(body.message, string(body.code, "Codex 请求失败")));
  }
  return body;
}

function node(document, tag, className = "", text = "") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function itemFromEvent(event, previous = {}) {
  const wire = record(event.payload);
  const kind = string(wire.type, string(previous.kind, "unknown"));
  return {
    id: string(event.itemId, string(wire.id, string(previous.id))),
    turnId: string(event.turnId, string(previous.turnId)),
    kind,
    status: string(wire.status, string(previous.status, "inProgress")),
    title: string(
      wire.command,
      string(wire.name, string(wire.agentPath, string(previous.title, kind))),
    ),
    text: string(wire.text, string(previous.text)),
    output: string(wire.output, string(previous.output)),
    data: wire,
  };
}

function bodyText(item) {
  return item.kind === "commandExecution" || item.kind === "fileChange"
    ? string(item.output, string(item.text))
    : string(item.text, string(item.output));
}

function itemLabel(item) {
  const word = ITEM_WORDS[item.kind] ?? ITEM_WORDS.unknown;
  const title = string(item.title);
  return title && title !== item.kind ? `${word} · ${title}` : word;
}

function makeItemNode(document, item) {
  const prose = item.kind === "agentMessage";
  const root = node(
    document,
    prose ? "article" : "details",
    prose ? "stream-item stream-agent" : "stream-item stream-work",
  );
  root.dataset.itemId = item.id;
  root.dataset.kind = item.kind;
  root.dataset.status = item.status;
  let body;
  if (prose) {
    body = node(document, "div", "stream-prose", bodyText(item));
    root.append(body);
  } else {
    const summary = node(document, "summary", "stream-work-title", itemLabel(item));
    const state = node(document, "span", "stream-work-state", item.status);
    summary.append(state);
    body = node(document, "pre", "stream-work-body", bodyText(item));
    root.append(summary, body);
  }
  return { root, body };
}

function describeInteraction(interaction) {
  const params = record(interaction.params);
  if (interaction.kind === "commandApproval") {
    return string(params.command, string(params.reason, "Codex 想运行一条命令。"));
  }
  if (interaction.kind === "fileChangeApproval") {
    return string(params.reason, string(params.grantRoot, "Codex 想修改文件。"));
  }
  if (interaction.kind === "permissionsApproval") {
    return string(params.reason, `工作目录：${string(params.cwd, "未提供")}`);
  }
  if (interaction.kind === "mcpElicitation") {
    return string(params.message, "StagePass 需要你的回答。");
  }
  const questions = Array.isArray(params.questions) ? params.questions : [];
  return questions.map((question) => string(record(question).question)).filter(Boolean).join("\n")
    || "Codex 需要你的回答。";
}

function addAction(document, parent, label, value, act, primary = false) {
  const button = node(
    document,
    "button",
    primary ? "interaction-action primary" : "interaction-action",
    label,
  );
  button.type = "button";
  button.addEventListener("click", () => { void act(value); });
  parent.append(button);
  return button;
}

function scalarInput(document, key, schema) {
  const wrap = node(document, "label", "interaction-field");
  const title = node(
    document,
    "span",
    "interaction-label",
    string(schema.title, key),
  );
  const choices = Array.isArray(schema.enum)
    ? schema.enum
    : Array.isArray(schema.oneOf)
      ? schema.oneOf.map((option) => record(option).const)
      : [];
  const field = choices.length > 0
    ? node(document, "select", "interaction-input")
    : node(document, "input", "interaction-input");
  field.name = key;
  if (schema.type === "boolean") field.type = "checkbox";
  else if (schema.type === "number" || schema.type === "integer") field.type = "number";
  else field.type = "text";
  for (const choice of choices) {
    const option = node(document, "option", "", String(choice));
    option.value = String(choice);
    field.append(option);
  }
  if (schema.default !== undefined) {
    if (field.type === "checkbox") field.checked = Boolean(schema.default);
    else field.value = String(schema.default);
  }
  wrap.append(title, field);
  if (schema.description) {
    wrap.append(node(document, "small", "interaction-help", String(schema.description)));
  }
  return { wrap, field, schema };
}

function scalarValue(entry) {
  if (entry.field.type === "checkbox") return Boolean(entry.field.checked);
  if (entry.schema.type === "number" || entry.schema.type === "integer") {
    return Number(entry.field.value);
  }
  return entry.field.value;
}

function mcpForm(document, interaction, respond) {
  const params = record(interaction.params);
  if (params.mode === "url" && typeof params.url === "string") {
    const link = node(document, "a", "interaction-link", "在浏览器中继续");
    link.href = params.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    return { content: [link], actions: (footer) => {
      addAction(document, footer, "取消", { action: "cancel", _meta: null }, respond);
    } };
  }
  const schema = record(params.requestedSchema);
  const properties = record(schema.properties);
  const fields = Object.entries(properties).map(([key, raw]) =>
    scalarInput(document, key, record(raw)));
  const form = node(document, "div", "interaction-fields");
  form.append(...fields.map((entry) => entry.wrap));
  return {
    content: [form],
    actions: (footer) => {
      addAction(document, footer, "不回答", { action: "decline", _meta: null }, respond);
      addAction(document, footer, "交给 StagePass", null, () => respond({
        action: "accept",
        content: Object.fromEntries(fields.map((entry) => [
          entry.field.name,
          scalarValue(entry),
        ])),
        _meta: null,
      }), true);
    },
  };
}

function toolInputForm(document, interaction, respond) {
  const params = record(interaction.params);
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const fields = questions.map((rawQuestion) => {
    const question = record(rawQuestion);
    const wrap = node(document, "label", "interaction-field");
    wrap.append(node(document, "span", "interaction-label", string(question.question)));
    const options = Array.isArray(question.options) ? question.options : [];
    const field = options.length > 0
      ? node(document, "select", "interaction-input")
      : node(document, "input", "interaction-input");
    field.name = string(question.id);
    field.type = question.isSecret ? "password" : "text";
    for (const rawOption of options) {
      const option = record(rawOption);
      const choice = node(document, "option", "", string(option.label));
      choice.value = string(option.label);
      field.append(choice);
    }
    wrap.append(field);
    return { wrap, field };
  });
  const form = node(document, "div", "interaction-fields");
  form.append(...fields.map((entry) => entry.wrap));
  return {
    content: [form],
    actions: (footer) => addAction(document, footer, "提交回答", null, () => respond({
      answers: Object.fromEntries(fields.map(({ field }) => [
        field.name,
        { answers: [field.value] },
      ])),
    }), true),
  };
}

/**
 * @param {object} options
 * @returns {{open(): Promise<void>, close(): void}}
 */
export function createCodexStream(options) {
  const {
    changeId,
    seat,
    surface,
    form,
    input,
    send,
    interrupt,
    interaction,
    document = globalThis.document,
    fetchImpl = globalThis.fetch.bind(globalThis),
    eventSourceFactory = (url) => new EventSource(url),
    onStatus = () => {},
  } = options;
  const identity = { changeId, seat };
  const itemNodes = new Map();
  const items = new Map();
  let source = null;
  let activeTurnId = null;
  let lastSeq = 0;
  let busy = false;
  let statusNode = null;

  const status = (text, kind = "idle") => {
    if (statusNode) {
      statusNode.textContent = text;
      statusNode.dataset.status = kind;
    }
    onStatus({ text, kind, activeTurnId });
  };

  const updateControls = () => {
    interrupt.hidden = activeTurnId === null;
    interrupt.disabled = busy || activeTurnId === null;
    send.disabled = busy;
    send.textContent = activeTurnId === null ? "发送" : "介入";
    input.setAttribute(
      "placeholder",
      activeTurnId === null ? "给 Codex 一个新任务…" : "向正在运行的这一轮补充方向…",
    );
  };

  const putItem = (item) => {
    if (!item.id) return;
    items.set(item.id, item);
    let mounted = itemNodes.get(item.id);
    if (!mounted) {
      mounted = makeItemNode(document, item);
      itemNodes.set(item.id, mounted);
      surface.append(mounted.root);
    }
    mounted.root.dataset.kind = item.kind;
    mounted.root.dataset.status = item.status;
    mounted.body.textContent = bodyText(item);
    surface.scrollTop = surface.scrollHeight;
  };

  const renderSnapshot = (snapshot) => {
    activeTurnId = typeof snapshot.activeTurnId === "string"
      ? snapshot.activeTurnId : null;
    lastSeq = Number.isSafeInteger(snapshot.lastSeq) ? snapshot.lastSeq : 0;
    itemNodes.clear();
    items.clear();
    statusNode = node(document, "p", "stream-status");
    surface.replaceChildren(statusNode);
    for (const rawItem of Array.isArray(snapshot.items) ? snapshot.items : []) {
      const item = record(rawItem);
      putItem(item);
    }
    const turnStatus = string(snapshot.turnStatus);
    status(
      activeTurnId ? TURN_WORDS.inProgress : TURN_WORDS[turnStatus] ?? "会话已连接",
      activeTurnId ? "running" : turnStatus || "idle",
    );
    updateControls();
    showPendingInteraction(snapshot);
  };

  const post = async (path, body) => jsonResponse(await fetchImpl(endpoint(path), jsonBody({
    ...identity,
    ...body,
  })));

  const respond = async (pending, response) => {
    busy = true;
    updateControls();
    try {
      await post("respond", { interactionId: pending.id, response });
      if (interaction.open) interaction.close();
    } catch (error) {
      status(`没能交回答：${error.message}`, "error");
    } finally {
      busy = false;
      updateControls();
    }
  };

  function showPendingInteraction(snapshot) {
    const pending = (Array.isArray(snapshot.interactions) ? snapshot.interactions : [])
      .map(record)
      .find((candidate) => candidate.status === "pending");
    if (!pending) {
      if (interaction.open) interaction.close();
      return;
    }
    const header = node(document, "header", "interaction-head");
    const title = node(
      document,
      "h2",
      "interaction-title",
      INTERACTION_WORDS[pending.kind] ?? "Codex 需要你的回答",
    );
    title.id = "codex-interaction-title";
    header.append(
      node(document, "small", "interaction-kicker", "Human checkpoint"),
      title,
      node(document, "p", "interaction-message", describeInteraction(pending)),
    );
    const footer = node(document, "footer", "interaction-actions");
    const answer = (value) => respond(pending, value);
    const body = [];
    if (pending.kind === "mcpElicitation") {
      const built = mcpForm(document, pending, answer);
      body.push(...built.content);
      built.actions(footer);
    } else if (pending.kind === "toolUserInput") {
      const built = toolInputForm(document, pending, answer);
      body.push(...built.content);
      built.actions(footer);
    } else if (pending.kind === "permissionsApproval") {
      const requested = record(record(pending.params).permissions);
      addAction(document, footer, "拒绝", { permissions: {}, scope: "turn" }, answer);
      addAction(document, footer, "仅这一轮", {
        permissions: requested, scope: "turn",
      }, answer, true);
      addAction(document, footer, "本会话", {
        permissions: requested, scope: "session",
      }, answer);
    } else {
      addAction(document, footer, "拒绝", { decision: "decline" }, answer);
      addAction(document, footer, "仅这一次", { decision: "accept" }, answer, true);
      addAction(document, footer, "本会话允许", {
        decision: "acceptForSession",
      }, answer);
    }
    interaction.replaceChildren(header, ...body, footer);
    if (!interaction.open) interaction.showModal();
  }

  const refreshInteraction = async () => {
    const query = new URLSearchParams({ change: changeId, seat });
    const snapshot = await jsonResponse(await fetchImpl(
      `${endpoint("snapshot")}?${query.toString()}`,
    ));
    activeTurnId = typeof snapshot.activeTurnId === "string"
      ? snapshot.activeTurnId : null;
    lastSeq = Number.isSafeInteger(snapshot.lastSeq) ? snapshot.lastSeq : lastSeq;
    updateControls();
    showPendingInteraction(snapshot);
  };

  const applyEvent = (event) => {
    lastSeq = Number.isSafeInteger(event.seq) ? event.seq : lastSeq;
    if (event.kind === "turn.started") {
      activeTurnId = string(event.turnId) || null;
      status(TURN_WORDS.inProgress, "running");
      updateControls();
      return;
    }
    if (event.kind === "turn.completed") {
      activeTurnId = null;
      const outcome = string(record(event.payload).status, "completed");
      status(TURN_WORDS[outcome] ?? TURN_WORDS.completed, outcome);
      updateControls();
      return;
    }
    if (event.kind === "item.started" || event.kind === "item.completed") {
      const previous = items.get(string(event.itemId)) ?? {};
      const item = itemFromEvent(event, previous);
      if (event.kind === "item.completed" && item.status === "inProgress") {
        item.status = "completed";
      }
      putItem(item);
      return;
    }
    if (event.kind === "item.delta") {
      const id = string(event.itemId);
      const previous = items.get(id) ?? {
        id,
        turnId: string(event.turnId),
        kind: "unknown",
        status: "inProgress",
        title: "",
        text: "",
        output: "",
        data: {},
      };
      const delta = string(record(event.payload).delta);
      const output = previous.kind === "commandExecution" || previous.kind === "fileChange";
      const next = {
        ...previous,
        text: output ? previous.text : `${string(previous.text)}${delta}`,
        output: output ? `${string(previous.output)}${delta}` : previous.output,
      };
      items.set(id, next);
      const mounted = itemNodes.get(id);
      if (mounted) {
        mounted.body.textContent += delta;
        surface.scrollTop = surface.scrollHeight;
      } else putItem(next);
      return;
    }
    if (event.kind === "interaction.requested" || event.kind === "interaction.resolved") {
      void refreshInteraction().catch((error) => {
        status(`交互状态刷新失败：${error.message}`, "error");
      });
      return;
    }
    if (event.kind === "error") {
      status(string(record(event.payload).message, "Codex 报告了一个错误"), "error");
    }
  };

  const connect = () => {
    if (source) source.close();
    const query = new URLSearchParams({
      change: changeId,
      seat,
      after: String(lastSeq),
    });
    source = eventSourceFactory(`${endpoint("events")}?${query.toString()}`);
    for (const kind of EVENT_KINDS) {
      source.addEventListener(kind, (message) => {
        if (kind === "snapshot.required") {
          source.close();
          void refresh().then(connect).catch((error) => {
            status(`会话重连失败：${error.message}`, "error");
          });
          return;
        }
        try {
          applyEvent(JSON.parse(message.data));
        } catch (error) {
          status(`读不懂一条流事件：${error.message}`, "error");
        }
      });
    }
  };

  const refresh = async () => {
    const query = new URLSearchParams({ change: changeId, seat });
    renderSnapshot(await jsonResponse(await fetchImpl(
      `${endpoint("snapshot")}?${query.toString()}`,
    )));
  };

  const submit = async () => {
    const prompt = input.value.trim();
    if (!prompt || busy) return;
    busy = true;
    updateControls();
    try {
      if (activeTurnId === null) {
        const result = await post("turn", { prompt });
        activeTurnId = string(result.turnId) || null;
        status(TURN_WORDS.inProgress, "running");
      } else {
        await post("steer", { direction: prompt, expectedTurnId: activeTurnId });
        status("方向已送进正在运行的这一轮", "running");
      }
      input.value = "";
    } catch (error) {
      status(`没有送出去：${error.message}`, "error");
    } finally {
      busy = false;
      updateControls();
    }
  };

  const submitListener = (event) => {
    event.preventDefault();
    void submit();
  };
  const keyListener = (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void submit();
  };
  const interruptListener = () => {
    const turnId = activeTurnId;
    if (turnId === null || busy) return;
    busy = true;
    updateControls();
    void post("interrupt", { turnId })
      .catch((error) => status(`没有中断成功：${error.message}`, "error"))
      .finally(() => {
        busy = false;
        updateControls();
      });
  };
  form.addEventListener("submit", submitListener);
  input.addEventListener("keydown", keyListener);
  interrupt.addEventListener("click", interruptListener);

  return {
    async open() {
      renderSnapshot(await jsonResponse(await fetchImpl(
        endpoint("open"),
        jsonBody(identity),
      )));
      connect();
      input.focus();
    },
    close() {
      if (source) source.close();
      source = null;
      form.removeEventListener("submit", submitListener);
      input.removeEventListener("keydown", keyListener);
      interrupt.removeEventListener("click", interruptListener);
      if (interaction.open) interaction.close();
    },
  };
}
