import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import type {
  NativeSeat,
  NativeSessionStatus,
  NativeSessionsPort,
} from "./native-sessions";
import { serveTerminalApi } from "./terminal-api";

function state(
  changeId = "CHG-1",
  seat: NativeSeat = "PRD",
): NativeSessionStatus {
  return {
    changeId,
    seat,
    threadId: "THREAD-1",
    thread: "idle",
    tmuxSession: "sp_0123456789abcdef0123",
    tmux: "detached",
    terminal: "closed",
    action: "reopen",
  };
}

class FakeNative implements NativeSessionsPort {
  readonly calls: string[] = [];
  failure: { code: string } | null = null;

  private answer(changeId: string, seat: NativeSeat, action: string): Promise<NativeSessionStatus> {
    this.calls.push(`${action}:${changeId}/${seat}`);
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(state(changeId, seat));
  }

  status(changeId: string, seat: NativeSeat) { return this.answer(changeId, seat, "status"); }
  open(changeId: string, seat: NativeSeat) { return this.answer(changeId, seat, "open"); }
  focus(changeId: string, seat: NativeSeat) { return this.answer(changeId, seat, "focus"); }
  closeWindow(changeId: string, seat: NativeSeat) {
    return this.answer(changeId, seat, "close-window");
  }
  endSession(changeId: string, seat: NativeSeat) {
    return this.answer(changeId, seat, "end-session");
  }
  archiveAndEnd(): Promise<void> { return Promise.resolve(); }
  releaseObserver(): void {}
  forget(): Promise<void> { return Promise.resolve(); }
  closeControlConnection(): void {}
}

async function withApi(
  run: (base: string, sessions: FakeNative, configured: string[]) => Promise<void>,
): Promise<void> {
  const sessions = new FakeNative();
  const configured: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://panel.invalid");
    void serveTerminalApi(url, request, response, {
      sessions,
      configFor: (changeId, seat) => {
        configured.push(`${changeId}/${seat}`);
        return { configured: true };
      },
    }).then((handled) => {
      if (!handled) response.writeHead(404).end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base, sessions, configured);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("native terminal HTTP API", () => {
  it("serves normalized status and all four lifecycle actions", async () => {
    await withApi(async (base, sessions, configured) => {
      const status = await fetch(`${base}/api/terminal/status?change=CHG-1&seat=PRD`);
      assert.equal(status.status, 200);
      assert.deepEqual(Object.keys(await status.json() as object).sort(), [
        "action", "changeId", "seat", "terminal", "thread", "threadId", "tmux", "tmuxSession",
      ]);

      for (const action of ["open", "focus", "close-window", "end-session"]) {
        assert.equal((await post(base, `/api/terminal/${action}`, {
          changeId: "CHG-1", seat: "PRD",
        })).status, 200);
      }
      assert.deepEqual(sessions.calls, [
        "status:CHG-1/PRD",
        "open:CHG-1/PRD",
        "focus:CHG-1/PRD",
        "close-window:CHG-1/PRD",
        "end-session:CHG-1/PRD",
      ]);
      assert.deepEqual(configured, ["CHG-1/PRD"]);
    });
  });

  it("rejects invalid identity, method, JSON, and oversized bodies", async () => {
    await withApi(async (base, sessions) => {
      assert.equal((await fetch(
        `${base}/api/terminal/status?change=&seat=PRD`,
      )).status, 400);
      assert.equal((await post(base, "/api/terminal/open", {
        changeId: "CHG-1", seat: "Done",
      })).status, 400);
      assert.equal((await fetch(`${base}/api/terminal/open`, { method: "PUT" })).status, 405);
      assert.equal((await fetch(`${base}/api/terminal/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{broken",
      })).status, 400);
      assert.equal((await post(base, "/api/terminal/open", {
        changeId: "x".repeat(20_000), seat: "PRD",
      })).status, 413);
      assert.equal(sessions.calls.length, 0);
    });
  });

  it("maps stable runtime failures without exposing raw terminal data", async () => {
    await withApi(async (base, sessions) => {
      const cases = [
        ["tmux_unavailable", 503],
        ["terminal_automation_denied", 503],
        ["terminal_window_ambiguous", 409],
        ["turn_busy", 409],
        ["no_such_change", 404],
        ["invalid_terminal_target", 400],
      ] as const;
      for (const [code, expected] of cases) {
        sessions.failure = { code };
        const response = await post(base, "/api/terminal/open", {
          changeId: "CHG-1", seat: "PRD",
        });
        assert.equal(response.status, expected, code);
        assert.deepEqual(await response.json(), { code });
      }
    });
  });

  it("does not claim the legacy terminal or Codex write routes", async () => {
    await withApi(async (base) => {
      assert.equal((await fetch(`${base}/api/terminal?change=CHG-1&phase=PRD`, {
        method: "POST",
      })).status, 404);
      assert.equal((await post(base, "/api/codex/turn", {
        changeId: "CHG-1", seat: "PRD", prompt: "raw",
      })).status, 404);
    });
  });
});
