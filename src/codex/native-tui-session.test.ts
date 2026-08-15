import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { AppServerNotification, AppServerRequest } from "./app-server-protocol";
import type { AppServerConnection } from "./app-server-session";
import { AppServerSessionError } from "./app-server-session";
import { AppServerSessionHost, CodexTurnError } from "./app-server-transport";
import {
  NativeTuiCodexTransport,
  nativeTuiServerRequest,
  type NativeTuiTurnPort,
} from "./native-tui-session";
import {
  createPromptFiles,
  type PromptFile,
  type PromptFiles,
} from "./prompt-file";
import type { TmuxIdentity, TmuxSession } from "./tmux";
import { CodexUnavailableError } from "./transport";

const THREAD_ID = "019f0000-0000-7000-8000-000000000001";
const IDENTITY = { changeId: "CHG-1", seat: "PRD" } as const;
const TMUX_SESSION: TmuxSession = {
  name: "sp_0123456789abcdef0123",
  marker: "STAGEPASS:sp_0123456789abcdef0123",
};

class FakeConnection implements AppServerConnection {
  readonly calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
  turns: readonly unknown[] = [];
  private readonly notificationListeners = new Set<(message: AppServerNotification) => void>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();

  request(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      return Promise.resolve({ thread: { id: THREAD_ID, turns: this.turns } });
    }
    if (method === "thread/resume") {
      return Promise.resolve({ thread: { id: params.threadId, turns: this.turns } });
    }
    throw new Error(`unexpected request: ${method}`);
  }

  subscribeNotifications(listener: (message: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  subscribeDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  emit(method: string, params: Readonly<Record<string, unknown>>): void {
    for (const listener of this.notificationListeners) listener({ method, params });
  }

  disconnect(): void {
    for (const listener of this.disconnectListeners) listener(new Error("disconnected"));
  }
}

class FakeTui implements NativeTuiTurnPort {
  readonly ensured: Array<{ identity: TmuxIdentity; threadId: string; cwd: string }> = [];
  readonly submitted: Array<{ sessionName: string; envelope: string }> = [];
  onSubmit: (envelope: string) => void = () => {};

  ensure(identity: TmuxIdentity, threadId: string, cwd: string): Promise<TmuxSession> {
    this.ensured.push({ identity, threadId, cwd });
    return Promise.resolve(TMUX_SESSION);
  }

  submit(sessionName: string, envelope: string): Promise<void> {
    this.submitted.push({ sessionName, envelope });
    this.onSubmit(envelope);
    return Promise.resolve();
  }
}

function trackedPromptFiles(root: string): {
  readonly files: PromptFiles;
  readonly created: PromptFile[];
} {
  const backing = createPromptFiles({ root });
  const created: PromptFile[] = [];
  return {
    created,
    files: {
      create(prompt) {
        const file = backing.create(prompt);
        created.push(file);
        return file;
      },
    },
  };
}

function runtime(
  connection: FakeConnection,
  tui: FakeTui,
  promptFiles: PromptFiles,
  timeoutMs = 100,
): NativeTuiCodexTransport {
  return new NativeTuiCodexTransport(
    new AppServerSessionHost(connection),
    tui,
    promptFiles,
    {
      identity: IDENTITY,
      cwd: "/repo",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      effort: "xhigh",
      timeoutMs,
      turnStartTimeoutMs: timeoutMs,
    },
  );
}

function complete(
  connection: FakeConnection,
  status: "completed" | "failed" | "interrupted" = "completed",
): void {
  connection.emit("turn/started", {
    threadId: THREAD_ID,
    turn: { id: "TURN-TUI", status: "inProgress", items: [] },
  });
  connection.emit("turn/started", {
    threadId: THREAD_ID,
    turn: { id: "TURN-TUI", status: "inProgress", items: [] },
  });
  connection.emit("turn/completed", {
    threadId: THREAD_ID,
    turn: {
      id: "TURN-TUI",
      status,
      items: status === "completed"
        ? [{ type: "agentMessage", id: "ITEM-1", text: "done" }]
        : [],
    },
  });
}

describe("native TUI Codex transport", () => {
  it("submits only the file envelope through tmux and observes its exact turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-tui-test-"));
    try {
      const connection = new FakeConnection();
      const tui = new FakeTui();
      const prompts = trackedPromptFiles(root);
      const timeline: string[] = [];
      tui.onSubmit = (envelope) => {
        timeline.push("submit");
        const prompt = prompts.created[0]!;
        assert.equal(existsSync(prompt.path), true);
        assert.match(readFileSync(prompt.path, "utf8"), /FULL_SECRET_PROMPT/);
        assert.ok(!envelope.includes("FULL_SECRET_PROMPT"));
        complete(connection);
      };

      const delivery = await runtime(connection, tui, prompts.files).runTurn({
        threadId: THREAD_ID,
        prompt: "FULL_SECRET_PROMPT with detailed rubric",
        onThread: (threadId) => timeline.push(`thread:${threadId}`),
      });

      assert.deepEqual(delivery, { threadId: THREAD_ID, text: "done" });
      assert.deepEqual(timeline, [`thread:${THREAD_ID}`, "submit"]);
      assert.deepEqual(tui.ensured, [{ identity: IDENTITY, threadId: THREAD_ID, cwd: "/repo" }]);
      assert.equal(tui.submitted[0]!.sessionName, TMUX_SESSION.name);
      assert.equal(connection.calls.some(({ method }) => method === "turn/start"), false);
      assert.equal(existsSync(prompts.created[0]!.path), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const status of ["failed", "interrupted"] as const) {
    it(`preserves the externally owned ${status} outcome and releases its prompt`, async () => {
      const root = mkdtempSync(join(tmpdir(), "stagepass-native-tui-test-"));
      try {
        const connection = new FakeConnection();
        const tui = new FakeTui();
        const prompts = trackedPromptFiles(root);
        tui.onSubmit = () => complete(connection, status);

        await assert.rejects(
          runtime(connection, tui, prompts.files).runTurn({ threadId: THREAD_ID, prompt: "go" }),
          (error) => error instanceof CodexTurnError
            && error.code === `codex_turn_${status}`,
        );
        assert.equal(existsSync(prompts.created[0]!.path), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("rejects a busy baseline without creating a prompt or submitting", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-tui-test-"));
    try {
      const connection = new FakeConnection();
      connection.turns = [{ id: "TURN-ACTIVE", status: "inProgress", items: [] }];
      const tui = new FakeTui();
      const prompts = trackedPromptFiles(root);

      await assert.rejects(
        runtime(connection, tui, prompts.files).runTurn({ threadId: THREAD_ID, prompt: "go" }),
        (error) => error instanceof AppServerSessionError && error.code === "turn_busy",
      );
      assert.equal(prompts.created.length, 0);
      assert.equal(tui.submitted.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("times out waiting for the TUI to start a turn and releases the prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-tui-test-"));
    try {
      const connection = new FakeConnection();
      const tui = new FakeTui();
      const prompts = trackedPromptFiles(root);

      await assert.rejects(
        runtime(connection, tui, prompts.files, 5).runTurn({ threadId: THREAD_ID, prompt: "go" }),
        (error) => error instanceof CodexTurnError && error.code === "codex_turn_timeout",
      );
      assert.equal(existsSync(prompts.created[0]!.path), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases the prompt when App Server disconnects while waiting", async () => {
    const root = mkdtempSync(join(tmpdir(), "stagepass-native-tui-test-"));
    try {
      const connection = new FakeConnection();
      const tui = new FakeTui();
      const prompts = trackedPromptFiles(root);
      tui.onSubmit = () => queueMicrotask(() => connection.disconnect());

      await assert.rejects(
        runtime(connection, tui, prompts.files, 1_000).runTurn({
          threadId: THREAD_ID,
          prompt: "go",
        }),
        (error) => error instanceof CodexUnavailableError
          && error.detail === "app_server_disconnected",
      );
      assert.equal(existsSync(prompts.created[0]!.path), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves approval and MCP interaction ownership with the native client", async () => {
    const request: AppServerRequest = {
      id: 9,
      method: "mcpServer/elicitation/request",
      params: { threadId: THREAD_ID, turnId: "TURN-TUI" },
    };

    await assert.rejects(
      nativeTuiServerRequest(request),
      (error) => error instanceof AppServerSessionError
        && error.code === "interaction_owner_is_native_tui",
    );
  });
});
