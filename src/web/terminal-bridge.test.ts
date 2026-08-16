import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Browser JavaScript is checked separately by tsconfig.panel.json.
// @ts-expect-error The source config deliberately excludes browser JavaScript.
import { createTerminalBridge } from "./terminal-bridge.js";

type Listener = () => void;

class FakeElement {
  readonly listeners = new Map<string, Listener[]>();
  readonly attributes = new Map<string, string>();
  textContent = "";
  hidden = false;
  disabled = false;

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

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

const status = (overrides: Record<string, unknown> = {}) => ({
  changeId: "CHG-1",
  seat: "PRD",
  threadId: "THREAD-1",
  thread: "idle",
  terminal: "closed",
  action: "resume",
  ...overrides,
});

function fixture(initial: Record<string, unknown>) {
  const primary = new FakeElement();
  const closeWindow = new FakeElement();
  const summary = new FakeElement();
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let current = initial;

  const fetchImpl = async (path: string, options: Record<string, unknown> = {}) => {
    const method = typeof options.method === "string" ? options.method : "GET";
    const body = typeof options.body === "string" ? JSON.parse(options.body) : undefined;
    calls.push({ path, method, ...(body === undefined ? {} : { body }) });
    return { ok: true, json: async () => current };
  };

  const controller = createTerminalBridge({
    changeId: "CHG-1",
    seat: "PRD",
    primary,
    closeWindow,
    summary,
    fetchImpl,
    pollMs: 2_000,
    setIntervalImpl: (callback: () => void) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearIntervalImpl: (id: number) => { timers.delete(id); },
  });
  return {
    controller,
    primary,
    closeWindow,
    summary,
    calls,
    timers,
    setStatus(value: Record<string, unknown>) { current = value; },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("native Terminal portal", () => {
  it("renders resume from a durable thread when Terminal is closed", async () => {
    const view = fixture(status());
    await view.controller.refresh();
    assert.equal(view.primary.textContent, "恢复系统终端");
    assert.match(view.summary.textContent, /同一个 Codex 线程/);
    assert.equal(view.closeWindow.hidden, true);
    assert.equal(JSON.stringify(status()).includes(["t", "mux"].join("")), false);
  });

  it("refreshes native status without opening or focusing Terminal", async () => {
    const view = fixture(status({ terminal: "open", action: "focus" }));
    await view.controller.refresh();
    assert.equal(view.calls.length, 1);
    assert.match(view.calls[0]!.path, /^\/api\/terminal\/status\?/);
    assert.equal(view.calls[0]!.method, "GET");
  });

  it("renders stale as resumable and opens it through the native API", async () => {
    const view = fixture(status({ terminal: "stale", action: "resume" }));
    await view.controller.refresh();
    view.primary.dispatch("click");
    await tick();
    assert.equal(view.calls.at(-1)?.path, "/api/terminal/open");
  });

  it("focuses an existing Terminal window without creating another thread", async () => {
    const view = fixture(status({ terminal: "open", action: "focus" }));
    await view.controller.refresh();
    assert.equal(view.primary.textContent, "聚焦系统终端");
    view.primary.dispatch("click");
    await tick();
    assert.equal(view.calls.at(-1)?.path, "/api/terminal/focus");
    assert.deepEqual(view.calls.at(-1)?.body, { changeId: "CHG-1", seat: "PRD" });
  });

  it("close window calls only the disposable-client route", async () => {
    const view = fixture(status({ terminal: "open", action: "focus" }));
    await view.controller.refresh();
    view.closeWindow.dispatch("click");
    await tick();
    assert.equal(view.calls.at(-1)?.path, "/api/terminal/close-window");
    assert.equal(view.calls.some(({ path }) => path.includes("end-session")), false);
  });

  it("shows unavailable App Server or Terminal state and stops polling on close", async () => {
    for (const unavailable of [
      status({ terminal: "unavailable" }),
      status({ thread: "unavailable" }),
    ]) {
      const view = fixture(unavailable);
      await view.controller.refresh();
      assert.equal(view.primary.disabled, true);
      assert.match(view.summary.textContent, /Codex 会话|终端自动化/);
      assert.equal(view.timers.size, 1);
      view.controller.close();
      assert.equal(view.timers.size, 0);
    }
  });
});
