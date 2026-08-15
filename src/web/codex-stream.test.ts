import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { join } from "node:path";

// The implementation is browser JavaScript and is checked by tsconfig.panel.json.
// @ts-expect-error TypeScript's source config deliberately excludes browser JavaScript.
import { createCodexStream } from "./codex-stream.js";

type Listener = (event: Record<string, unknown>) => void;

class FakeClassList {
  constructor(private readonly owner: FakeElement) {}
  add(...names: string[]): void {
    const values = new Set(this.owner.className.split(/\s+/).filter(Boolean));
    for (const name of names) values.add(name);
    this.owner.className = [...values].join(" ");
  }
  remove(...names: string[]): void {
    const rejected = new Set(names);
    this.owner.className = this.owner.className
      .split(/\s+/).filter((name) => name && !rejected.has(name)).join(" ");
  }
  toggle(name: string, force?: boolean): boolean {
    const has = this.contains(name);
    const next = force ?? !has;
    if (next) this.add(name); else this.remove(name);
    return next;
  }
  contains(name: string): boolean {
    return this.owner.className.split(/\s+/).includes(name);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly classList = new FakeClassList(this);
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  className = "";
  hidden = false;
  disabled = false;
  open = false;
  value = "";
  type = "";
  name = "";
  scrollTop = 0;
  scrollHeight = 0;
  private ownText = "";

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.length = 0;
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        const text = new FakeElement("#text");
        text.textContent = node;
        this.children.push(text);
      } else this.children.push(node);
    }
    this.scrollHeight = this.children.length;
  }

  appendChild(node: FakeElement): FakeElement {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.ownText = "";
    this.children.splice(0, this.children.length, ...nodes);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
    );
  }

  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    const event = {
      preventDefault() {},
      target: this,
      currentTarget: this,
      ...extra,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
  focus(): void {}
}

class FakeDocument {
  createElement(tag: string): FakeElement { return new FakeElement(tag.toUpperCase()); }
}

class FakeEventSource {
  readonly listeners = new Map<string, Listener[]>();
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }
  close(): void { this.closed = true; }
}

const item = (
  id: string,
  kind: string,
  text = "",
  output = "",
): Record<string, unknown> => ({
  id,
  turnId: "TURN-1",
  kind,
  status: "inProgress",
  title: kind === "commandExecution" ? "pnpm check" : kind,
  text,
  output,
  truncated: false,
});

const snapshot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  threadId: "THREAD-1",
  activeTurnId: null,
  lastTurnId: null,
  turnStatus: null,
  items: [],
  interactions: [],
  lastSeq: 0,
  ...overrides,
});

function fixture(initial: Record<string, unknown>) {
  const document = new FakeDocument();
  const surface = new FakeElement("SECTION");
  const form = new FakeElement("FORM");
  const input = new FakeElement("TEXTAREA");
  const send = new FakeElement("BUTTON");
  const interrupt = new FakeElement("BUTTON");
  const interaction = new FakeElement("DIALOG");
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const sources: FakeEventSource[] = [];
  let current = initial;

  const fetchImpl = async (path: string, options: Record<string, unknown> = {}) => {
    const body = typeof options.body === "string" ? JSON.parse(options.body) : {};
    calls.push({ path, body });
    if (path === "/api/codex/open" || path.startsWith("/api/codex/snapshot")) {
      return { ok: true, json: async () => current };
    }
    return { ok: true, json: async () => ({ turnId: "TURN-NEW" }) };
  };

  const controller = createCodexStream({
    changeId: "CHG-1",
    seat: "PRD",
    surface,
    form,
    input,
    send,
    interrupt,
    interaction,
    document,
    fetchImpl,
    eventSourceFactory: (url: string) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
  });
  return {
    controller, surface, form, input, interrupt, interaction, calls, sources,
    setSnapshot(value: Record<string, unknown>) { current = value; },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

describe("StagePass-native Codex stream", () => {
  it("appends text deltas to the existing semantic item node", async () => {
    const page = fixture(snapshot({
      activeTurnId: "TURN-1",
      items: [item("ITEM-1", "agentMessage")],
    }));
    await page.controller.open();
    const before = page.surface.children.find((child) => child.dataset.itemId === "ITEM-1");

    page.sources[0]!.emit("item.delta", {
      seq: 1,
      kind: "item.delta",
      threadId: "THREAD-1",
      turnId: "TURN-1",
      itemId: "ITEM-1",
      payload: { delta: "原生流式输出" },
    });

    const after = page.surface.children.find((child) => child.dataset.itemId === "ITEM-1");
    assert.equal(after, before, "delta 不该替换已挂载的 DOM 节点");
    assert.match(after?.textContent ?? "", /原生流式输出/);
  });

  it("renders reasoning, command, file and MCP work as semantic disclosures", async () => {
    const page = fixture(snapshot({
      items: [
        item("R", "reasoning", "分析"),
        item("C", "commandExecution", "", "checking"),
        item("F", "fileChange", "patch"),
        item("M", "mcpToolCall", "tool result"),
      ],
    }));
    await page.controller.open();

    const work = page.surface.children.filter((child) => child.dataset.itemId);
    assert.deepEqual(work.map((child) => child.tagName), ["DETAILS", "DETAILS", "DETAILS", "DETAILS"]);
    assert.deepEqual(work.map((child) => child.dataset.kind), [
      "reasoning", "commandExecution", "fileChange", "mcpToolCall",
    ]);
  });

  it("shows when App Server output was bounded", async () => {
    const page = fixture(snapshot({
      items: [{ ...item("C", "commandExecution", "", "partial"), truncated: true }],
    }));
    await page.controller.open();

    assert.match(page.surface.textContent, /已截断/);
  });

  it("renders sub-agent activity as named StagePass work instead of an unknown item", async () => {
    const subAgent = {
      ...item("S", "subAgentActivity"),
      status: "completed",
      title: "/root/proponent",
    };
    const page = fixture(snapshot({ items: [subAgent] }));
    await page.controller.open();

    const work = page.surface.children.find((child) => child.dataset.itemId === "S");
    assert.match(work?.textContent ?? "", /子 Agent · \/root\/proponent/);
    assert.doesNotMatch(work?.textContent ?? "", /未识别项目/);
  });

  it("sends idle composer input to turn/start and running input to steer", async () => {
    const page = fixture(snapshot());
    await page.controller.open();
    page.input.value = "开始这一轮";
    page.form.dispatch("submit");
    await tick();
    assert.deepEqual(page.calls.at(-1), {
      path: "/api/codex/turn",
      body: { changeId: "CHG-1", seat: "PRD", prompt: "开始这一轮" },
    });

    page.sources[0]!.emit("turn.started", {
      seq: 1,
      kind: "turn.started",
      threadId: "THREAD-1",
      turnId: "TURN-1",
      payload: {},
    });
    page.input.value = "往这个方向继续";
    page.form.dispatch("submit");
    await tick();
    assert.deepEqual(page.calls.at(-1), {
      path: "/api/codex/steer",
      body: {
        changeId: "CHG-1",
        seat: "PRD",
        direction: "往这个方向继续",
        expectedTurnId: "TURN-1",
      },
    });
  });

  it("interrupts the exact active turn", async () => {
    const page = fixture(snapshot({ activeTurnId: "TURN-7" }));
    await page.controller.open();
    page.interrupt.dispatch("click");
    await tick();
    assert.deepEqual(page.calls.at(-1), {
      path: "/api/codex/interrupt",
      body: { changeId: "CHG-1", seat: "PRD", turnId: "TURN-7" },
    });
  });

  it("removes composer listeners when leaving a seat", async () => {
    const page = fixture(snapshot());
    await page.controller.open();
    page.controller.close();

    assert.equal(page.form.listeners.get("submit")?.length, 0);
    assert.equal(page.input.listeners.get("keydown")?.length, 0);
    assert.equal(page.interrupt.listeners.get("click")?.length, 0);
  });

  it("opens a real dialog when App Server requests human interaction", async () => {
    const page = fixture(snapshot());
    await page.controller.open();
    page.setSnapshot(snapshot({
      interactions: [{
        id: "interaction-1",
        kind: "commandApproval",
        method: "item/commandExecution/requestApproval",
        status: "pending",
        params: { command: "git status --short" },
      }],
    }));
    page.sources[0]!.emit("interaction.requested", {
      seq: 1,
      kind: "interaction.requested",
      threadId: "THREAD-1",
      interactionId: "interaction-1",
      payload: {},
    });
    await tick();

    assert.equal(page.interaction.open, true);
    assert.match(page.interaction.textContent, /git status --short/);
  });

  it("never turns an untrusted MCP elicitation URL into an executable link", async () => {
    const page = fixture(snapshot());
    await page.controller.open();
    page.setSnapshot(snapshot({
      interactions: [{
        id: "interaction-unsafe",
        kind: "mcpElicitation",
        method: "mcpServer/elicitation/request",
        status: "pending",
        params: { mode: "url", url: "javascript:globalThis.compromised=true" },
      }],
    }));
    page.sources[0]!.emit("interaction.requested", {
      seq: 1,
      kind: "interaction.requested",
      threadId: "THREAD-1",
      interactionId: "interaction-unsafe",
      payload: {},
    });
    await tick();

    assert.equal(
      descendants(page.interaction).some((element) => element.tagName === "A"),
      false,
    );
    assert.match(page.interaction.textContent, /不安全|无法打开/);
  });

  it("removes xterm and the browser PTY path from the panel", () => {
    const root = join(process.cwd(), "src", "web");
    const html = readFileSync(join(root, "panel.html"), "utf8");
    const panel = readFileSync(join(root, "panel.js"), "utf8");
    assert.doesNotMatch(html, /xterm|addon-fit/);
    assert.doesNotMatch(panel, /\/pty\/|new Terminal|FitAddon/);
    assert.match(html, /id="codex-stream"/);
    assert.match(html, /id="codex-composer"/);
    assert.match(html, /id="codex-interaction"/);
  });

  it("stacks the workspace and keeps the full orbit on phone-sized screens", () => {
    const html = readFileSync(join(process.cwd(), "src", "web", "panel.html"), "utf8");

    assert.match(html, /@media \(max-width: 820px\)[\s\S]*body \{[\s\S]*overflow-y: auto/);
    assert.match(html, /@media \(max-width: 820px\)[\s\S]*\.columns, \.columns\.collapsed \{[\s\S]*display: block/);
    assert.match(html, /@media \(max-width: 820px\)[\s\S]*#orbit-view \{[\s\S]*grid-template-columns: 1fr/);
    assert.match(html, /@media \(max-width: 820px\)[\s\S]*\.col\.stage \{[\s\S]*min-height:/);
    assert.match(html, /@media \(max-width: 1180px\)[\s\S]*\.status-facts dd \{[\s\S]*overflow-wrap: anywhere/);
  });
});
