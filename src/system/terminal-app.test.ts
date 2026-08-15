import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createTerminalAppOps,
  TerminalAppError,
} from "./terminal-app";
import { createProcessOps } from "./process";
import type {
  ProcessOps,
  ProcessRequest,
  ProcessResult,
} from "./process";

const TARGET = {
  marker: "STAGEPASS:sp_0123456789abcdef0123",
  sessionName: "sp_0123456789abcdef0123",
} as const;

function result(code = 0, stdout = "", stderr = ""): ProcessResult {
  return { code, signal: null, stdout, stderr };
}

function recordingProcess(
  answer: (request: ProcessRequest) => ProcessResult | Promise<ProcessResult>,
): { readonly process: ProcessOps; readonly calls: ProcessRequest[] } {
  const calls: ProcessRequest[] = [];
  return {
    calls,
    process: {
      run: async (request) => {
        calls.push(request);
        return answer(request);
      },
      spawn: () => { throw new Error("not used"); },
    },
  };
}

function response(action: string, matches: number, outcome: string): ProcessResult {
  return result(0, `${JSON.stringify({ action, matches, result: outcome })}\n`);
}

describe("Terminal.app controller", () => {
  it("passes action, marker, and fixed attach command as osascript argv", async () => {
    const recorded = recordingProcess(() => response("open", 0, "opened"));
    const terminal = createTerminalAppOps({ process: recorded.process });

    assert.equal(await terminal.open(TARGET), "opened");
    assert.equal(recorded.calls[0]!.command, "/usr/bin/osascript");
    assert.equal(recorded.calls[0]!.args[0], "-e");
    assert.deepEqual(recorded.calls[0]!.args.slice(-3), [
      "open",
      "STAGEPASS:sp_0123456789abcdef0123",
      "exec tmux attach-session -t sp_0123456789abcdef0123",
    ]);
  });

  it("maps status and idempotent open/close outcomes", async () => {
    const recorded = recordingProcess(({ args }) => {
      const action = args.at(-3);
      if (action === "status") return response("status", 0, "closed");
      if (action === "open") return response("open", 1, "focused");
      return response("close", 0, "already_closed");
    });
    const terminal = createTerminalAppOps({ process: recorded.process });

    assert.equal(await terminal.status(TARGET), "closed");
    assert.equal(await terminal.open(TARGET), "focused");
    assert.equal(await terminal.close(TARGET), "already_closed");
  });

  it("fails closed on an ambiguous marker before mutating any window", async () => {
    const recorded = recordingProcess(({ args }) => response(args.at(-3)!, 2, "ambiguous"));
    const terminal = createTerminalAppOps({ process: recorded.process });

    await assert.rejects(
      terminal.focus(TARGET),
      (error) => error instanceof TerminalAppError
        && error.code === "terminal_window_ambiguous",
    );
    await assert.rejects(
      terminal.close(TARGET),
      (error) => error instanceof TerminalAppError
        && error.code === "terminal_window_ambiguous",
    );
    assert.equal(recorded.calls.length, 2, "每次只允许一次发现+操作脚本调用");
  });

  it("closes only a dedicated marked window, never an individual or shared tab", async () => {
    const recorded = recordingProcess(() => response("close", 1, "closed"));
    await createTerminalAppOps({ process: recorded.process }).close(TARGET);

    const script = recorded.calls[0]!.args[1]!;
    assert.match(script, /count tabs of markedWindow/);
    assert.match(script, /close markedWindow/);
    assert.doesNotMatch(script, /close markedTab/);
  });

  it("rediscovers by marker on every call and never reuses an OS window id", async () => {
    let call = 0;
    const recorded = recordingProcess(({ args }) => {
      call += 1;
      return result(0, JSON.stringify({
        action: args.at(-3),
        matches: 1,
        result: call === 1 ? "open" : "focused",
        windowId: 987654,
      }));
    });
    const terminal = createTerminalAppOps({ process: recorded.process });

    assert.equal(await terminal.status(TARGET), "open");
    await terminal.focus(TARGET);

    assert.deepEqual(recorded.calls[1]!.args.slice(-3), [
      "focus", TARGET.marker, `exec tmux attach-session -t ${TARGET.sessionName}`,
    ]);
    assert.equal(recorded.calls[1]!.args.some((value) => value.includes("987654")), false);
  });

  it("maps denied Apple events and rejects untrusted targets", async () => {
    const denied = recordingProcess(() => result(
      1,
      "",
      "execution error: Not authorized to send Apple events to Terminal. (-1743)",
    ));
    await assert.rejects(
      createTerminalAppOps({ process: denied.process }).open(TARGET),
      (error) => error instanceof TerminalAppError
        && error.code === "terminal_automation_denied",
    );

    const untouched = recordingProcess(() => response("open", 0, "opened"));
    await assert.rejects(
      createTerminalAppOps({ process: untouched.process }).open({
        marker: "STAGEPASS:sp_0123456789abcdef0123; close every window",
        sessionName: TARGET.sessionName,
      }),
      (error) => error instanceof TerminalAppError
        && error.code === "invalid_terminal_target",
    );
    assert.equal(untouched.calls.length, 0);
  });

  it("real marked window survives close", { timeout: 30_000 }, async (context) => {
    if (process.env.STAGEPASS_TERMINAL_SMOKE !== "1") {
      context.skip("set STAGEPASS_TERMINAL_SMOKE=1 to control Terminal.app");
      return;
    }

    const sessionName = "sp_00000000000000000000";
    const target = { marker: `STAGEPASS:${sessionName}`, sessionName };
    const processes = createProcessOps();
    const terminal = createTerminalAppOps({ process: processes });
    await processes.run({
      command: "tmux",
      args: ["new-session", "-d", "-s", sessionName, "sleep", "300"],
    });
    try {
      assert.equal(await terminal.open(target), "opened");
      assert.equal(await terminal.open(target), "focused");
      await terminal.focus(target);
      assert.equal(await terminal.close(target), "closed");
      assert.equal(await terminal.status(target), "closed");
      assert.equal((await processes.run({
        command: "tmux",
        args: ["has-session", "-t", sessionName],
      })).code, 0);
    } finally {
      try { await terminal.close(target); } catch { /* best-effort smoke cleanup */ }
      await processes.run({
        command: "tmux",
        args: ["kill-session", "-t", sessionName],
      });
    }
  });
});
