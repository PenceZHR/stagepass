import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import type { AppServerNotification } from "../codex/app-server-protocol";
import type {
  HistoryTurn,
  ThreadAvailability,
  ThreadHistory,
} from "../codex/app-server-history";
import type { AppServerConnection } from "../codex/app-server-session";
import { AppServerSessionHost } from "../codex/app-server-transport";
import type { ArchiveOps } from "../codex/archive";
import { createPromptFiles } from "../codex/prompt-file";
import {
  TerminalAppError,
  type TerminalAppOps,
  type TerminalTarget,
  type TerminalWindowState,
} from "../system/terminal-app";
import { SCHEMA_SQL } from "../db/schema";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import {
  NativeSessions,
  NativeSessionsError,
} from "./native-sessions";

const THREAD_ONE = "019f0000-0000-7000-8000-000000000001";
const ARCHIVED_THREAD = "019f0000-0000-7000-8000-000000000077";

class FakeRuntime implements AppServerConnection, ArchiveOps {
  readonly calls: string[] = [];
  readonly archived: string[] = [];
  readonly unarchived: string[] = [];
  startedThreads = 0;
  private nextThread = 1;
  private readonly states = new Map<string, ThreadAvailability | "unavailable">();
  private readonly histories = new Map<string, HistoryTurn[]>();
  private readonly notifications = new Set<(message: AppServerNotification) => void>();
  private readonly disconnects = new Set<(error: Error) => void>();

  request(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    this.calls.push(method);
    if (method === "thread/start") {
      this.startedThreads += 1;
      const id = `019f0000-0000-7000-8000-${String(this.nextThread++).padStart(12, "0")}`;
      this.states.set(id, "open");
      this.histories.set(id, []);
      return Promise.resolve({ thread: { id, turns: [] } });
    }
    if (method === "thread/resume") {
      const id = String(params.threadId);
      if (!this.histories.has(id)) this.histories.set(id, []);
      return Promise.resolve({ thread: { id, turns: [] } });
    }
    if (method === "thread/unsubscribe") return Promise.resolve({ status: "unsubscribed" });
    if (method === "turn/interrupt") return Promise.resolve({});
    throw new Error(`unexpected request ${method}`);
  }

  subscribeNotifications(listener: (message: AppServerNotification) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  subscribeDisconnect(listener: (error: Error) => void): () => void {
    this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
  }

  availability(threadId: string): Promise<ThreadAvailability> {
    const state = this.states.get(threadId) ?? "missing";
    if (state === "unavailable") return Promise.reject(new Error("app-server disconnected"));
    return Promise.resolve(state);
  }

  archive(threadId: string): Promise<void> {
    this.archived.push(threadId);
    this.states.set(threadId, "archived");
    return Promise.resolve();
  }

  unarchive(threadId: string): Promise<void> {
    this.unarchived.push(threadId);
    this.states.set(threadId, "open");
    return Promise.resolve();
  }

  readThread(threadId: string): Promise<ThreadHistory | null> {
    const turns = this.histories.get(threadId);
    if (turns === undefined) return Promise.resolve(null);
    return Promise.resolve({
      id: threadId,
      parentThreadId: null,
      status: turns.some((turn) => turn.status === "inProgress") ? "active" : "idle",
      turns,
      turnCount: turns.length,
      userMessages: turns.flatMap((turn) => turn.userMessages),
      allText: turns.map((turn) => turn.allText).filter(Boolean).join("\n"),
      lastCompletedText: [...turns].reverse().find(
        (turn) => turn.status === "completed",
      )?.agentText ?? null,
      childThreadIds: [],
      contextUsage: null,
    });
  }

  async readThreadStatus(threadId: string): Promise<string | null> {
    return (await this.readThread(threadId))?.status ?? null;
  }

  async readRecentTurns(threadId: string, limit = 20): Promise<readonly HistoryTurn[]> {
    return [...(this.histories.get(threadId) ?? [])].reverse().slice(0, limit);
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    await this.request("thread/unsubscribe", { threadId });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  set(threadId: string, state: ThreadAvailability | "unavailable"): void {
    this.states.set(threadId, state);
  }

  emit(method: string, params: Readonly<Record<string, unknown>>): void {
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const rawTurn = params.turn !== null && typeof params.turn === "object"
      ? params.turn as Readonly<Record<string, unknown>>
      : {};
    const turnId = typeof rawTurn.id === "string" ? rawTurn.id : "";
    const items = Array.isArray(rawTurn.items)
      ? rawTurn.items as ReadonlyArray<Readonly<Record<string, unknown>>>
      : [];
    if (method === "turn/started" && threadId !== "" && turnId !== "") {
      const userMessages = items.flatMap((item) => item.type === "userMessage"
        && Array.isArray(item.content)
        ? (item.content as ReadonlyArray<Readonly<Record<string, unknown>>>).flatMap(
          (part) => part.type === "text" && typeof part.text === "string" ? [part.text] : [],
        )
        : []);
      const turns = this.histories.get(threadId) ?? [];
      this.histories.set(threadId, [...turns, {
        id: turnId,
        status: "inProgress",
        userMessages,
        agentText: "",
        allText: userMessages.join("\n"),
      }]);
    }
    if (method === "turn/completed" && threadId !== "" && turnId !== "") {
      const turns = this.histories.get(threadId) ?? [];
      const agentText = items.flatMap((item) => item.type === "agentMessage"
        && typeof item.text === "string" ? [item.text] : []).join("\n");
      this.histories.set(threadId, turns.map((turn) => turn.id === turnId
        ? {
            ...turn,
            status: rawTurn.status === "failed" || rawTurn.status === "interrupted"
              ? rawTurn.status
              : "completed",
            agentText,
            allText: [...turn.userMessages, agentText].filter(Boolean).join("\n"),
          }
        : turn));
    }
    for (const listener of this.notifications) listener({ method, params });
  }
}

interface TerminalDelivery {
  readonly target: TerminalTarget;
  readonly envelope: string;
  readonly kind: "open" | "submit";
}

class FakeTerminal implements TerminalAppOps {
  readonly states = new Map<string, TerminalWindowState>();
  readonly opened: Array<{ target: TerminalTarget; prompt?: string }> = [];
  readonly submitted: Array<{ target: TerminalTarget; envelope: string }> = [];
  readonly focused: TerminalTarget[] = [];
  readonly closed: TerminalTarget[] = [];
  onDeliver: (delivery: TerminalDelivery) => void = () => {};
  beforeSubmit: (target: TerminalTarget) => void = () => {};

  status(target: TerminalTarget): Promise<TerminalWindowState> {
    return Promise.resolve(this.states.get(target.marker) ?? "closed");
  }

  open(target: TerminalTarget, prompt?: string): Promise<"opened" | "focused" | "resumed"> {
    const state = this.states.get(target.marker) ?? "closed";
    this.opened.push({ target, ...(prompt === undefined ? {} : { prompt }) });
    this.states.set(target.marker, "open");
    if (prompt !== undefined) this.onDeliver({ target, envelope: prompt, kind: "open" });
    if (state === "open") return Promise.resolve("focused");
    return Promise.resolve(state === "stale" ? "resumed" : "opened");
  }

  focus(target: TerminalTarget): Promise<void> {
    if (this.states.get(target.marker) !== "open") throw new Error("missing");
    this.focused.push(target);
    return Promise.resolve();
  }

  submit(target: TerminalTarget, envelope: string): Promise<"submitted"> {
    this.beforeSubmit(target);
    if (this.states.get(target.marker) !== "open") {
      throw new TerminalAppError("terminal_window_missing", "closed during submit");
    }
    this.submitted.push({ target, envelope });
    this.onDeliver({ target, envelope, kind: "submit" });
    return Promise.resolve("submitted");
  }

  close(target: TerminalTarget): Promise<"closed" | "already_closed"> {
    const existed = this.states.get(target.marker) !== undefined;
    this.states.delete(target.marker);
    if (existed) this.closed.push(target);
    return Promise.resolve(existed ? "closed" : "already_closed");
  }
}

function fixture(root: string) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ChangeStore(database).create("CHG-1");
  new ChangeStore(database).create("CHG-2");
  const runtime = new FakeRuntime();
  const terminal = new FakeTerminal();
  const make = () => new NativeSessions({
    database,
    host: new AppServerSessionHost(runtime),
    history: runtime,
    terminal,
    promptFiles: createPromptFiles({ root }),
    cwdFor: () => "/repo",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    effort: "xhigh",
    pollIntervalMs: 1,
  });
  return { database, runtime, terminal, make };
}

const config = { mcpServers: { stagepass: { enabled: true } } };

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

function promptPath(envelope: string): string {
  return envelope.slice(envelope.indexOf("：") + 1);
}

function envelopeItem(envelope: string): Readonly<Record<string, unknown>> {
  return {
    type: "userMessage",
    content: [{ type: "text", text: envelope }],
  };
}

function finish(runtime: FakeRuntime, threadId: string, turnId: string, text = "done"): void {
  runtime.emit("turn/completed", {
    threadId,
    turn: {
      id: turnId,
      status: "completed",
      items: [{ type: "agentMessage", id: "ITEM-1", text }],
    },
  });
}

describe("native StagePass sessions", () => {
  it("rejects an unknown Change", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      await assert.rejects(
        f.make().status("CHG-MISSING", "PRD"),
        (error) => error instanceof NativeSessionsError && error.code === "no_such_change",
      );
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds once, closes only the disposable client, and resumes the same thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const sessions = f.make();
      const [first, second] = await Promise.all([
        sessions.open("CHG-1", "PRD", config, { showTerminal: true }),
        sessions.open("CHG-1", "PRD", config, { showTerminal: true }),
      ]);

      assert.equal(first.threadId, second.threadId);
      assert.equal(f.runtime.startedThreads, 1);
      assert.equal(f.terminal.opened.length, 1);
      assert.deepEqual(first, {
        changeId: "CHG-1",
        seat: "PRD",
        threadId: THREAD_ONE,
        thread: "idle",
        terminal: "open",
        action: "focus",
      });

      const closed = await sessions.closeWindow("CHG-1", "PRD");
      assert.equal(closed.terminal, "closed");
      assert.equal(closed.action, "resume");
      assert.equal(new BindingStore(f.database).find("CHG-1", "PRD")?.threadId, first.threadId);
      assert.deepEqual(f.runtime.archived, []);

      const resumed = await sessions.open("CHG-1", "PRD", config, { showTerminal: true });
      assert.equal(resumed.threadId, first.threadId);
      assert.equal(f.runtime.startedThreads, 1);
      assert.equal(resumed.terminal, "open");
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses archived bindings, replaces only missing, and preserves unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const bindings = new BindingStore(f.database);
      bindings.bind("CHG-1", "Spec", ARCHIVED_THREAD);
      f.runtime.set(ARCHIVED_THREAD, "archived");
      const sessions = f.make();
      assert.equal(
        (await sessions.open("CHG-1", "Spec", config, { showTerminal: false })).threadId,
        ARCHIVED_THREAD,
      );
      assert.deepEqual(f.runtime.unarchived, [ARCHIVED_THREAD]);

      const missing = "019f0000-0000-7000-8000-000000000099";
      bindings.bind("CHG-1", "Arch", missing);
      f.runtime.set(missing, "missing");
      const replacement = await sessions.open("CHG-1", "Arch", config, { showTerminal: false });
      assert.notEqual(replacement.threadId, missing);
      assert.equal(bindings.find("CHG-1", "Arch")?.threadId, replacement.threadId);

      const unavailable = "019f0000-0000-7000-8000-000000000088";
      bindings.bind("CHG-1", "BuildPlan", unavailable);
      f.runtime.set(unavailable, "unavailable");
      await assert.rejects(
        sessions.open("CHG-1", "BuildPlan", config, { showTerminal: false }),
        (error) => error instanceof NativeSessionsError && error.code === "thread_unavailable",
      );
      assert.equal(bindings.find("CHG-1", "BuildPlan")?.threadId, unavailable);
      assert.equal(f.terminal.closed.length, 0);
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconstructs a closed client from binding after StagePass restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const opened = await f.make().open("CHG-1", "PRD", config, { showTerminal: false });
      const restarted = f.make();
      const before = await restarted.status("CHG-1", "PRD");
      assert.equal(before.threadId, opened.threadId);
      assert.equal(before.terminal, "closed");
      assert.equal(before.action, "resume");

      const restored = await restarted.open("CHG-1", "PRD", config, { showTerminal: true });
      assert.equal(restored.threadId, opened.threadId);
      assert.equal(restored.terminal, "open");
      assert.equal(f.runtime.startedThreads, 1);
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hands the seat config to Terminal so the TUI gets the StagePass MCP tools", async () => {
    // 2026-08-17 真机：TUI 在正确的线程上恢复、读到了题面，然后回
    // 「无法调用：当前会话未提供 stagepass_ask 工具」。控制连接在 thread/start
    // 时给了 mcp_servers.stagepass.*，但官方 TUI 是另一个客户端，拿的是全局
    // config.toml —— 那里没有 stagepass。配置必须跟着 Terminal 命令一起过去。
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const sessions = f.make();
      await sessions.open("CHG-1", "PRD", config, { showTerminal: true });
      assert.deepEqual(f.terminal.opened.at(-1)!.target.config, config);
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries the seat config on the turn-dispatch path too", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const sessions = f.make();
      let delivered: TerminalDelivery | null = null;
      f.terminal.onDeliver = (entry) => {
        delivered = entry;
        f.runtime.emit("turn/started", {
          threadId: entry.target.threadId,
          turn: { id: "TURN-CFG", status: "inProgress", items: [envelopeItem(entry.envelope)] },
        });
      };
      const transport = sessions.transportFor("CHG-1", "PRD", config, 500);
      const running = transport.runTurn({ threadId: null, prompt: "task" });
      await until(() => delivered !== null);
      assert.deepEqual(delivered!.target.config, config);
      finish(f.runtime, THREAD_ONE, "TURN-CFG");
      await running;
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("opens closed or stale clients with the private-file envelope and holds the lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const sessions = f.make();
      let path = "";
      f.terminal.onDeliver = ({ target, envelope, kind }) => {
        assert.equal(kind, "open");
        assert.equal(target.threadId, THREAD_ONE);
        assert.equal(
          f.runtime.calls.at(-1),
          "thread/unsubscribe",
          "control connection must release MCP ownership before Terminal input",
        );
        path = promptPath(envelope);
        assert.equal(existsSync(path), true);
        assert.match(readFileSync(path, "utf8"), /FULL RUBRIC/);
        f.runtime.emit("turn/started", {
          threadId: target.threadId,
          turn: {
            id: "TURN-NATIVE",
            status: "inProgress",
            items: [envelopeItem(envelope)],
          },
        });
      };

      const transport = sessions.transportFor("CHG-1", "PRD", config, 500);
      const running = transport.runTurn({ threadId: null, prompt: "FULL RUBRIC task" });
      await until(() => f.terminal.opened.some(({ prompt }) => prompt !== undefined));
      sessions.releaseObserver("CHG-1", "PRD");
      assert.equal(existsSync(path), true);
      await assert.rejects(
        transport.runTurn({ threadId: null, prompt: "must not interleave" }),
        (error) => error instanceof NativeSessionsError && error.code === "turn_busy",
      );

      finish(f.runtime, THREAD_ONE, "TURN-NATIVE");
      assert.equal((await running).text, "done");
      assert.equal(existsSync(path), false);
      assert.equal(f.terminal.closed.length, 0, "observer release must not close Terminal");
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("submits the file envelope into an already-running native client", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const sessions = f.make();
      const opened = await sessions.open("CHG-1", "PRD", config, { showTerminal: true });
      f.terminal.onDeliver = ({ target, envelope, kind }) => {
        assert.equal(kind, "submit");
        assert.equal(
          f.runtime.calls.at(-1),
          "thread/unsubscribe",
          "a live TUI must still be the only MCP reverse-request owner",
        );
        f.runtime.emit("turn/started", {
          threadId: target.threadId,
          turn: {
            id: "TURN-SUBMIT",
            status: "inProgress",
            items: [envelopeItem(envelope)],
          },
        });
      };

      const running = sessions.runTurn("CHG-1", "PRD", "details", config, 500);
      await until(() => f.terminal.submitted.length === 1);
      assert.equal(f.terminal.opened.length, 1, "dispatch must not reopen a live client");
      finish(f.runtime, opened.threadId!, "TURN-SUBMIT", "submitted");
      assert.equal(await running, "submitted");
      assert.equal(
        f.runtime.calls.filter((method) => method === "thread/resume").length,
        0,
        "polling a live TUI must never resubscribe the control connection",
      );
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resumes the same thread if the native client closes between status and submit", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const sessions = f.make();
      const opened = await sessions.open("CHG-1", "PRD", config, { showTerminal: true });
      let raced = false;
      f.terminal.beforeSubmit = (target) => {
        if (raced) return;
        raced = true;
        f.terminal.states.delete(target.marker);
      };
      f.terminal.onDeliver = ({ target, envelope, kind }) => {
        assert.equal(kind, "open");
        f.runtime.emit("turn/started", {
          threadId: target.threadId,
          turn: {
            id: "TURN-RESUMED",
            status: "inProgress",
            items: [envelopeItem(envelope)],
          },
        });
      };

      const running = sessions.runTurn("CHG-1", "PRD", "details", config, 500);
      await until(() => f.terminal.opened.length === 2);
      assert.equal(f.terminal.opened[1]!.target.threadId, opened.threadId);
      assert.equal(f.runtime.startedThreads, 1);
      finish(f.runtime, opened.threadId!, "TURN-RESUMED", "resumed");
      assert.equal(await running, "resumed");
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("interrupts the exact active App Server turn without owning Terminal bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const sessions = f.make();
      f.terminal.onDeliver = ({ target, envelope }) => {
        f.runtime.emit("turn/started", {
          threadId: target.threadId,
          turn: {
            id: "TURN-INTERRUPT",
            status: "inProgress",
            items: [envelopeItem(envelope)],
          },
        });
      };
      await sessions.startTurn("CHG-1", "PRD", "details", config, 500);

      assert.equal(await sessions.interrupt("CHG-1", "PRD"), true);
      assert.equal(f.runtime.calls.includes("turn/interrupt"), true);
      f.runtime.emit("turn/completed", {
        threadId: THREAD_ONE,
        turn: { id: "TURN-INTERRUPT", status: "interrupted", items: [] },
      });
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("startTurn returns at external start while prompt cleanup waits for completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const sessions = f.make();
      let path = "";
      f.terminal.onDeliver = ({ target, envelope }) => {
        path = promptPath(envelope);
        f.runtime.emit("turn/started", {
          threadId: target.threadId,
          turn: {
            id: "TURN-STARTED",
            status: "inProgress",
            items: [envelopeItem(envelope)],
          },
        });
      };

      assert.equal(
        await sessions.startTurn("CHG-1", "PRD", "detailed prompt", config, 500),
        "TURN-STARTED",
      );
      assert.equal(sessions.active("CHG-1", "PRD"), true);
      assert.equal(existsSync(path), true);
      sessions.releaseObserver("CHG-1", "PRD");

      finish(f.runtime, THREAD_ONE, "TURN-STARTED", "finished later");
      await until(() => !existsSync(path));
      assert.equal(sessions.active("CHG-1", "PRD"), false);
      assert.equal(sessions.has("CHG-1", "PRD"), false);
      assert.ok((sessions.quietForMs("CHG-1", "PRD") ?? -1) >= 0);
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("archive-and-end and Change-scoped forget close only their owned clients", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const sessions = f.make();
      const one = await sessions.open("CHG-1", "PRD", config, { showTerminal: true });
      const two = await sessions.open("CHG-2", "Spec", config, { showTerminal: true });

      await sessions.archiveAndEnd("CHG-1", "PRD");
      assert.ok(f.runtime.archived.includes(one.threadId!));
      assert.equal(f.terminal.states.has(f.terminal.opened[0]!.target.marker), false);
      assert.equal(new BindingStore(f.database).find("CHG-1", "PRD")?.status, "bound");
      assert.equal(f.terminal.states.has(f.terminal.opened[1]!.target.marker), true);

      await sessions.forget("CHG-2");
      assert.ok(f.runtime.archived.includes(two.threadId!));
      assert.equal(f.terminal.states.has(f.terminal.opened[1]!.target.marker), false);
      assert.equal(f.terminal.closed.length, 2);
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
