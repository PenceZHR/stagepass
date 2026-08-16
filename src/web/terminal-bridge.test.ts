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
  tmuxSession: "sp_0123456789abcdef0123",
  tmux: "detached",
  terminal: "closed",
  action: "reopen",
  ...overrides,
});

function fixture(initial: Record<string, unknown>) {
  const primary = new FakeElement();
  const closeWindow = new FakeElement();
  const endSession = new FakeElement();
  const summary = new FakeElement();
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const confirmations: string[] = [];
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
    endSession,
    summary,
    fetchImpl,
    confirmImpl: (message: string) => {
      confirmations.push(message);
      return true;
    },
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
    endSession,
    summary,
    calls,
    confirmations,
    timers,
    setStatus(value: Record<string, unknown>) { current = value; },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("native Terminal portal", () => {
  it("renders reopen when tmux lives but Terminal is closed", async () => {
    const view = fixture(status());
    await view.controller.refresh();
    assert.equal(view.primary.textContent, "重新打开终端");
    assert.match(view.summary.textContent, /Codex 仍在后台继续/);
    assert.equal(view.closeWindow.hidden, true);
  });

  it("focuses an existing Terminal window without creating another session", async () => {
    const view = fixture(status({ tmux: "attached", terminal: "open", action: "focus" }));
    await view.controller.refresh();
    assert.equal(view.primary.textContent, "聚焦系统终端");
    view.primary.dispatch("click");
    await tick();
    assert.equal(view.calls.at(-1)?.path, "/api/terminal/focus");
    assert.deepEqual(view.calls.at(-1)?.body, { changeId: "CHG-1", seat: "PRD" });
  });

  it("close window never calls end-session", async () => {
    const view = fixture(status({ tmux: "attached", terminal: "open", action: "focus" }));
    await view.controller.refresh();
    view.closeWindow.dispatch("click");
    await tick();
    assert.equal(view.calls.at(-1)?.path, "/api/terminal/close-window");
    assert.equal(view.calls.some(({ path }) => path === "/api/terminal/end-session"), false);
  });

  it("requires a destructive confirmation before ending tmux", async () => {
    const view = fixture(status({ terminal: "open", action: "focus" }));
    await view.controller.refresh();
    view.endSession.dispatch("click");
    await tick();
    assert.match(view.confirmations[0] ?? "", /结束.*会话/);
    assert.equal(view.calls.at(-1)?.path, "/api/terminal/end-session");
  });

  it("shows an actionable unavailable state and stops polling on close", async () => {
    const view = fixture(status({ tmux: "unavailable", terminal: "unavailable" }));
    await view.controller.refresh();
    assert.equal(view.primary.disabled, true);
    assert.match(view.summary.textContent, /tmux|终端自动化/);
    assert.equal(view.timers.size, 1);
    view.controller.close();
    assert.equal(view.timers.size, 0);
  });
});
