import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import type { AppServerNotification } from "../codex/app-server-protocol";
import type { ThreadAvailability } from "../codex/app-server-history";
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
  private readonly notifications = new Set<(message: AppServerNotification) => void>();
  private readonly disconnects = new Set<(error: Error) => void>();

  request(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    this.calls.push(method);
    if (method === "thread/start") {
      this.startedThreads += 1;
      const id = `019f0000-0000-7000-8000-${String(this.nextThread++).padStart(12, "0")}`;
      this.states.set(id, "open");
      return Promise.resolve({ thread: { id, turns: [] } });
    }
    if (method === "thread/resume") {
      const id = String(params.threadId);
      return Promise.resolve({ thread: { id, turns: [] } });
    }
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

  set(threadId: string, state: ThreadAvailability | "unavailable"): void {
    this.states.set(threadId, state);
  }

  emit(method: string, params: Readonly<Record<string, unknown>>): void {
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

  it("opens closed or stale clients with the private-file envelope and holds the lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const sessions = f.make();
      let path = "";
      f.terminal.onDeliver = ({ target, envelope, kind }) => {
        assert.equal(kind, "open");
        assert.equal(target.threadId, THREAD_ONE);
        path = promptPath(envelope);
        assert.equal(existsSync(path), true);
        assert.match(readFileSync(path, "utf8"), /FULL RUBRIC/);
        f.runtime.emit("turn/started", {
          threadId: target.threadId,
          turn: { id: "TURN-NATIVE", status: "inProgress", items: [] },
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
      f.terminal.onDeliver = ({ target, kind }) => {
        assert.equal(kind, "submit");
        f.runtime.emit("turn/started", {
          threadId: target.threadId,
          turn: { id: "TURN-SUBMIT", status: "inProgress", items: [] },
        });
      };

      const running = sessions.runTurn("CHG-1", "PRD", "details", config, 500);
      await until(() => f.terminal.submitted.length === 1);
      assert.equal(f.terminal.opened.length, 1, "dispatch must not reopen a live client");
      finish(f.runtime, opened.threadId!, "TURN-SUBMIT", "submitted");
      assert.equal(await running, "submitted");
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
      f.terminal.onDeliver = ({ target, kind }) => {
        assert.equal(kind, "open");
        f.runtime.emit("turn/started", {
          threadId: target.threadId,
          turn: { id: "TURN-RESUMED", status: "inProgress", items: [] },
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
      f.terminal.onDeliver = ({ target }) => {
        f.runtime.emit("turn/started", {
          threadId: target.threadId,
          turn: { id: "TURN-INTERRUPT", status: "inProgress", items: [] },
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
          turn: { id: "TURN-STARTED", status: "inProgress", items: [] },
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
