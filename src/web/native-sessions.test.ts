import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import type { AppServerNotification } from "../codex/app-server-protocol";
import type { AppServerConnection } from "../codex/app-server-session";
import { AppServerSessionHost } from "../codex/app-server-transport";
import type { ArchiveOps } from "../codex/archive";
import type { ThreadAvailability } from "../codex/app-server-history";
import { createPromptFiles } from "../codex/prompt-file";
import {
  tmuxSessionName,
  type TmuxIdentity,
  type TmuxOps,
  type TmuxSession,
} from "../codex/tmux";
import type {
  TerminalAppOps,
  TerminalTarget,
  TerminalWindowState,
} from "../system/terminal-app";
import { SCHEMA_SQL } from "../db/schema";
import { ChangeStore } from "../store/change-store";
import { BindingStore } from "../store/binding-store";
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

class FakeTmux implements TmuxOps {
  readonly created: string[] = [];
  readonly submitted: Array<{ name: string; envelope: string }> = [];
  readonly ended: string[] = [];
  readonly sessions = new Map<string, "detached" | "attached">();
  onSubmit: (envelope: string) => void = () => {};

  version(): Promise<string> { return Promise.resolve("tmux 3.7b"); }

  status(identity: TmuxIdentity): Promise<"absent" | "detached" | "attached"> {
    return Promise.resolve(this.sessions.get(
      tmuxSessionName(identity.changeId, identity.seat),
    ) ?? "absent");
  }

  ensureSession(identity: TmuxIdentity, _threadId: string, _cwd: string): Promise<TmuxSession> {
    const name = tmuxSessionName(identity.changeId, identity.seat);
    if (!this.sessions.has(name)) {
      this.created.push(name);
      this.sessions.set(name, "detached");
    }
    return Promise.resolve({ name, marker: `STAGEPASS:${name}` });
  }

  submit(name: string, envelope: string): Promise<void> {
    this.submitted.push({ name, envelope });
    this.onSubmit(envelope);
    return Promise.resolve();
  }

  detach(name: string): Promise<void> {
    if (this.sessions.has(name)) this.sessions.set(name, "detached");
    return Promise.resolve();
  }

  endSession(name: string): Promise<void> {
    if (this.sessions.delete(name)) this.ended.push(name);
    return Promise.resolve();
  }
}

class FakeTerminal implements TerminalAppOps {
  readonly openMarkers = new Set<string>();
  readonly closed: string[] = [];

  constructor(private readonly tmux: FakeTmux) {}

  status(target: TerminalTarget): Promise<TerminalWindowState> {
    return Promise.resolve(this.openMarkers.has(target.marker) ? "open" : "closed");
  }

  open(target: TerminalTarget): Promise<"opened" | "focused"> {
    const existed = this.openMarkers.has(target.marker);
    this.openMarkers.add(target.marker);
    if (this.tmux.sessions.has(target.sessionName)) {
      this.tmux.sessions.set(target.sessionName, "attached");
    }
    return Promise.resolve(existed ? "focused" : "opened");
  }

  focus(target: TerminalTarget): Promise<void> {
    if (!this.openMarkers.has(target.marker)) throw new Error("missing");
    return Promise.resolve();
  }

  close(target: TerminalTarget): Promise<"closed" | "already_closed"> {
    const existed = this.openMarkers.delete(target.marker);
    if (existed) this.closed.push(target.marker);
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
  const tmux = new FakeTmux();
  const terminal = new FakeTerminal(tmux);
  const make = () => new NativeSessions({
    database,
    host: new AppServerSessionHost(runtime),
    history: runtime,
    tmux,
    terminal,
    promptFiles: createPromptFiles({ root }),
    cwdFor: () => "/repo",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    effort: "xhigh",
  });
  return { database, runtime, tmux, terminal, make };
}

const config = { mcpServers: { stagepass: { enabled: true } } };

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

describe("native StagePass sessions", () => {
  it("rejects an unknown Change before reporting a synthetic empty status", async () => {
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

  it("binds on explicit open and concurrent calls reuse one thread and tmux", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const sessions = f.make();
      const [first, second] = await Promise.all([
        sessions.open("CHG-1", "PRD", config, { showTerminal: true }),
        sessions.open("CHG-1", "PRD", config, { showTerminal: true }),
      ]);

      assert.equal(first.threadId, second.threadId);
      assert.equal(first.tmuxSession, second.tmuxSession);
      assert.equal(f.runtime.startedThreads, 1);
      assert.equal(f.tmux.created.length, 1);
      assert.equal(first.thread, "idle");
      assert.equal(first.tmux, "attached");
      assert.equal(first.terminal, "open");

      const closed = await sessions.closeWindow("CHG-1", "PRD");
      assert.equal(closed.tmux, "detached");
      assert.equal(closed.terminal, "closed");
      assert.equal(new BindingStore(f.database).find("CHG-1", "PRD")?.threadId, first.threadId);
      assert.deepEqual(f.runtime.archived, []);
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
      assert.equal(f.tmux.ended.length, 0);
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconstructs from binding after restart and recreates missing tmux on the same thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const first = f.make();
      const opened = await first.open("CHG-1", "PRD", config, { showTerminal: false });
      f.tmux.sessions.delete(opened.tmuxSession);

      const restarted = f.make();
      const before = await restarted.status("CHG-1", "PRD");
      assert.equal(before.threadId, opened.threadId);
      assert.equal(before.tmux, "absent");
      const restored = await restarted.open("CHG-1", "PRD", config, { showTerminal: false });
      assert.equal(restored.threadId, opened.threadId);
      assert.equal(restored.tmux, "detached");
      assert.equal(f.runtime.startedThreads, 1);
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leases one input per seat and releaseObserver keeps prompt and tmux until completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const sessions = f.make();
      let promptPath = "";
      f.tmux.onSubmit = (envelope) => {
        promptPath = envelope.slice(envelope.indexOf("：") + 1);
        assert.equal(existsSync(promptPath), true);
        assert.match(readFileSync(promptPath, "utf8"), /FULL RUBRIC/);
        f.runtime.emit("turn/started", {
          threadId: THREAD_ONE,
          turn: { id: "TURN-NATIVE", status: "inProgress", items: [] },
        });
      };
      const transport = sessions.transportFor("CHG-1", "PRD", config, 500);
      const running = transport.runTurn({ threadId: null, prompt: "FULL RUBRIC task" });
      await until(() => f.tmux.submitted.length === 1);
      sessions.releaseObserver("CHG-1", "PRD");
      assert.equal(existsSync(promptPath), true);

      await assert.rejects(
        transport.runTurn({ threadId: null, prompt: "must not interleave" }),
        (error) => error instanceof NativeSessionsError && error.code === "turn_busy",
      );
      const bound = new BindingStore(f.database).find("CHG-1", "PRD")!.threadId;
      f.runtime.emit("turn/completed", {
        threadId: bound,
        turn: {
          id: "TURN-NATIVE",
          status: "completed",
          items: [{ type: "agentMessage", id: "ITEM-1", text: "done" }],
        },
      });
      assert.equal((await running).text, "done");
      assert.equal(existsSync(promptPath), false);
      assert.equal(f.tmux.sessions.size, 1, "releaseObserver 不得 kill tmux");

      const ended = await sessions.endSession("CHG-1", "PRD");
      assert.equal(ended.tmux, "absent");
      assert.equal(new BindingStore(f.database).find("CHG-1", "PRD")?.status, "bound");
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("archive-and-end and Change-scoped forget clean only their owned runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-sessions-test-"));
    const f = fixture(root);
    try {
      const sessions = f.make();
      const one = await sessions.open("CHG-1", "PRD", config, { showTerminal: true });
      const two = await sessions.open("CHG-2", "Spec", config, { showTerminal: true });

      await sessions.archiveAndEnd("CHG-1", "PRD");
      assert.ok(f.runtime.archived.includes(one.threadId!));
      assert.equal(f.tmux.sessions.has(one.tmuxSession), false);
      assert.equal(new BindingStore(f.database).find("CHG-1", "PRD")?.status, "bound");
      assert.equal(f.tmux.sessions.has(two.tmuxSession), true);

      await sessions.forget("CHG-2");
      assert.ok(f.runtime.archived.includes(two.threadId!));
      assert.equal(f.tmux.sessions.has(two.tmuxSession), false);
      assert.equal(f.tmux.ended.filter((name) => name === one.tmuxSession).length, 1);
    } finally {
      f.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
