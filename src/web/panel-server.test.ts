import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import { AppServerError } from "../codex/app-server-client";
import { AppServerHistory } from "../codex/app-server-history";
import type {
  AppServerNotification,
} from "../codex/app-server-protocol";
import type { AppServerConnection } from "../codex/app-server-session";
import { SCHEMA_SQL } from "../db/schema";
import { BindingStore } from "../store/binding-store";
import { ChangeStore } from "../store/change-store";
import { ProjectStore } from "../store/project-store";
import { createPanelServer } from "./panel-server";
import type {
  NativeRuntimeSessions,
  NativeSeat,
  NativeSessionStatus,
} from "./native-sessions";

class FakeConnection implements AppServerConnection {
  readonly calls: Array<{
    method: string;
    params: Readonly<Record<string, unknown>>;
  }> = [];
  readonly threads = new Map<string, {
    id: string;
    parentThreadId: null;
    status: { type: string };
    turns: Array<Record<string, unknown>>;
  }>();
  readonly archived = new Set<string>();
  private readonly listeners = new Set<
    (message: AppServerNotification) => void
  >();
  private nextThread = 1;
  private nextTurn = 1;

  async request(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      const id = `THREAD-${this.nextThread++}`;
      const thread = {
        id,
        parentThreadId: null,
        status: { type: "idle" },
        turns: [],
      };
      this.threads.set(id, thread);
      return { thread };
    }
    if (method === "thread/resume") {
      const thread = this.threads.get(String(params.threadId));
      if (thread === undefined) throw this.missing(String(params.threadId));
      return { thread };
    }
    if (method === "thread/read") {
      const thread = this.threads.get(String(params.threadId));
      if (thread === undefined) throw this.missing(String(params.threadId));
      return { thread };
    }
    if (method === "thread/list") {
      const wantArchived = params.archived === true;
      return {
        data: [...this.threads.values()].filter((thread) =>
          this.archived.has(thread.id) === wantArchived),
        nextCursor: null,
      };
    }
    if (method === "thread/archive") {
      this.archived.add(String(params.threadId));
      return {};
    }
    if (method === "thread/unarchive") {
      this.archived.delete(String(params.threadId));
      return { thread: this.threads.get(String(params.threadId)) };
    }
    if (method === "turn/start") {
      const threadId = String(params.threadId);
      const thread = this.threads.get(threadId);
      assert.ok(thread);
      const turn = {
        id: `TURN-${this.nextTurn++}`,
        status: "inProgress",
        items: [],
      };
      thread.turns.push(turn);
      thread.status = { type: "active" };
      return { turn };
    }
    if (method === "turn/interrupt") return {};
    throw new Error(`unexpected App Server request: ${method}`);
  }

  subscribeNotifications(
    listener: (message: AppServerNotification) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private missing(threadId: string): AppServerError {
    return new AppServerError(
      "app_server_request_failed",
      `thread not loaded: ${threadId}`,
      -32600,
    );
  }
}

class FakeNativeSessions implements NativeRuntimeSessions {
  readonly calls: string[] = [];
  readonly submissions: Array<{ seat: NativeSeat; prompt: string }> = [];
  readonly archivedAndEnded: Array<{ changeId: string; seat: NativeSeat }> = [];
  readonly released: Array<{ changeId: string; seat: NativeSeat }> = [];
  readonly forgotten: string[] = [];
  forgetError: Error | null = null;

  private answer(changeId: string, seat: NativeSeat, action: string): Promise<NativeSessionStatus> {
    this.calls.push(`${action}:${changeId}/${seat}`);
    return Promise.resolve({
      changeId,
      seat,
      threadId: "THREAD-NATIVE",
      thread: "idle",
      terminal: action === "close-window" ? "closed" : "open",
      action: action === "close-window" ? "resume" : "focus",
    });
  }

  status(changeId: string, seat: NativeSeat) { return this.answer(changeId, seat, "status"); }
  open(changeId: string, seat: NativeSeat) { return this.answer(changeId, seat, "open"); }
  focus(changeId: string, seat: NativeSeat) { return this.answer(changeId, seat, "focus"); }
  closeWindow(changeId: string, seat: NativeSeat) {
    return this.answer(changeId, seat, "close-window");
  }
  archiveAndEnd(changeId: string, seat: NativeSeat): Promise<void> {
    this.archivedAndEnded.push({ changeId, seat });
    return Promise.resolve();
  }
  releaseObserver(changeId: string, seat: NativeSeat): void {
    this.released.push({ changeId, seat });
  }
  forget(changeId: string): Promise<void> {
    this.forgotten.push(changeId);
    return this.forgetError === null
      ? Promise.resolve()
      : Promise.reject(this.forgetError);
  }
  closeControlConnection(): void {}
  has(): boolean { return false; }
  active(): boolean { return false; }
  quietForMs(): number | null { return null; }
  interrupt(): Promise<boolean> { return Promise.resolve(false); }
  startTurn(): Promise<string> { return Promise.resolve("TURN-NATIVE"); }
  runTurn(): Promise<string> { return Promise.resolve("done"); }
  transportFor(_changeId: string, seat: NativeSeat) {
    return {
      runTurn: async ({ prompt }: { prompt: string }) => {
        this.submissions.push({ seat, prompt });
        return {
          threadId: "THREAD-NATIVE",
          text: '```json\n{"red":{"artifactIds":[],"gaps":[],"summary":""},"blue":{"artifactIds":[],"gaps":[],"summary":""},"verdicts":[]}\n```',
        };
      },
    };
  }
}

async function withPanel(body: (input: {
  base: string;
  database: Database.Database;
  connection: FakeConnection;
  native: FakeNativeSessions;
  sessions: ReturnType<typeof createPanelServer>["sessions"];
}) => Promise<void>): Promise<void> {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_SQL);
  new ProjectStore(database).ensure("PRJ-1", "Project", "/repo");
  new ChangeStore(database).create("CHG-1", { projectId: "PRJ-1" });
  const connection = new FakeConnection();
  const history = new AppServerHistory(connection);
  const native = new FakeNativeSessions();
  const created = createPanelServer({
    database,
    history,
    nativeSessions: native,
    recoverEveryMs: 3_600_000,
    repo: {
      dirtyPaths: () => [],
      commitAll: () => null,
      commitPaths: () => null,
      show: () => null,
      head: () => null,
      trackedFiles: () => [],
    },
    trust: { isTrusted: () => null },
  });
  await new Promise<void>((resolve) => {
    created.server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${
    (created.server.address() as AddressInfo).port
  }`;
  try {
    await body({ base, database, connection, native, sessions: created.sessions });
  } finally {
    history.dispose();
    created.sessions.closeAll();
    created.server.closeAllConnections();
    await new Promise<void>((resolve) => created.server.close(() => resolve()));
    database.close();
  }
}

describe("pure App Server panel", () => {
  it("只开放归一化终端桥，旧 terminal / Codex 写路由和 PTY 都不存在", async () => {
    await withPanel(async ({ base, native }) => {
      const terminalBridge = await fetch(`${base}/terminal-bridge.js`);
      assert.equal(terminalBridge.status, 200);
      assert.match(await terminalBridge.text(), /createTerminalBridge/);
      assert.equal((await fetch(`${base}/codex-stream.js`)).status, 404);
      assert.equal((await fetch(`${base}/api/terminal?change=CHG-1&phase=PRD`, {
        method: "POST",
      })).status, 404);
      assert.equal((await fetch(`${base}/api/codex/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changeId: "CHG-1", seat: "PRD", prompt: "raw" }),
      })).status, 404);
      assert.equal((await fetch(`${base}/pty/CHG-1/PRD`)).status, 404);

      const opened = await fetch(`${base}/api/terminal/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changeId: "CHG-1", seat: "PRD" }),
      });
      assert.equal(opened.status, 200);
      assert.deepEqual(native.calls, ["open:CHG-1/PRD"]);
    });
  });

  it("启动巡检只解绑 App Server 明确认定不存在的 binding", async () => {
    await withPanel(async ({ database, sessions }) => {
      const bindings = new BindingStore(database);
      bindings.bind("CHG-1", "PRD", "THREAD-MISSING");
      const report = await sessions.reconcileBindings();
      assert.deepEqual(report.detached, [{
        changeId: "CHG-1",
        kind: "round",
        phase: "PRD",
        threadId: "THREAD-MISSING",
      }]);
      assert.equal(bindings.find("CHG-1", "PRD")?.status, "detached");
    });
  });

  it("关闭窗口只结束可丢弃的本机客户端", async () => {
    await withPanel(async ({ base, native }) => {
      const request = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changeId: "CHG-1", seat: "PRD" }),
      };
      assert.equal((await fetch(`${base}/api/terminal/close-window`, request)).status, 200);
      assert.equal((await fetch(`${base}/api/terminal/end-session`, request)).status, 404);
      assert.deepEqual(native.calls, ["close-window:CHG-1/PRD"]);
    });
  });

  it("普通收尾只释放观察者，批准收尾才归档并结束原生会话", async () => {
    await withPanel(async ({ native, sessions }) => {
      sessions.releaseObserver("CHG-1", "PRD");
      await sessions.archiveAndEnd("CHG-1", "PRD");
      assert.deepEqual(native.released, [{ changeId: "CHG-1", seat: "PRD" }]);
      assert.deepEqual(native.archivedAndEnded, [{ changeId: "CHG-1", seat: "PRD" }]);
    });
  });

  it("跑轮只把提示交给原生 TUI，不调用 App Server turn/start", async () => {
    await withPanel(async ({ base, database, connection, native }) => {
      new ChangeStore(database).setBrief("CHG-1", "按 StagePass rubric 完成这次变更");
      const response = await fetch(`${base}/api/run?change=CHG-1`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { ran: boolean }).ran, true);
      for (let attempt = 0; attempt < 20 && native.submissions.length === 0; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(connection.calls.some(({ method }) => method === "turn/start"), false);
      assert.equal(native.submissions.length, 1);
      assert.equal(native.submissions[0]!.seat, "PRD");
      const promptPath = native.submissions[0]!.prompt.match(/(\/[^\s：]+\.md)/)?.[1];
      assert.ok(promptPath, "原生 TUI 收到的应该是短文件信封");
      assert.match(readFileSync(promptPath, "utf8"), /rubric|标准/i);
    });
  });

  it("本机会话清理失败时拒绝删除并保留 Change", async () => {
    await withPanel(async ({ base, database, native }) => {
      native.forgetError = new Error("native client cleanup failed");
      const response = await fetch(`${base}/api/change?change=CHG-1`, { method: "DELETE" });
      assert.equal(response.status, 500);
      assert.match(await response.text(), /native client cleanup failed/);
      assert.deepEqual(native.forgotten, ["CHG-1"]);
      assert.equal(new ChangeStore(database).read("CHG-1").id, "CHG-1");
    });
  });
});
