import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createTerminalAppOps,
  terminalMarker,
  TerminalAppError,
} from "./terminal-app";
import type {
  ProcessOps,
  ProcessRequest,
  ProcessResult,
} from "./process";

const TARGET = {
  marker: "STAGEPASS:sp_0123456789abcdef0123",
  threadId: "019f0000-0000-7000-8000-000000000001",
  cwd: "/repo with space",
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

describe("Terminal.app disposable Codex client", () => {
  it("passes a shell-safe native resume command through fixed osascript argv", async () => {
    const recorded = recordingProcess(() => response("open", 0, "opened"));
    const terminal = createTerminalAppOps({ process: recorded.process });

    assert.equal(await terminal.open(TARGET), "opened");
    assert.equal(recorded.calls[0]!.command, "/usr/bin/osascript");
    assert.equal(recorded.calls[0]!.args[0], "-e");
    const [action, marker, command] = recorded.calls[0]!.args.slice(-3);
    assert.equal(action, "open");
    assert.equal(marker, TARGET.marker);
    assert.match(
      command!,
      /^exec codex resume -c 'tui\.terminal_title=\[\]' --remote unix:\/\//,
    );
    assert.match(command!, /--cd '\/repo with space'/);
    assert.match(command!, /'019f0000-0000-7000-8000-000000000001'/);
    assert.equal(command!.includes(["t", "mux"].join("")), false);
    const script = recorded.calls[0]!.args[1]!;
    assert.match(script, /custom title of candidateTab is markerValue/);
    assert.match(script, /set custom title of markedTab to markerValue/);
    assert.doesNotMatch(script, /custom title of candidateWindow is markerValue/);
    assert.doesNotMatch(script, /set custom title of markedWindow to markerValue/);
    assert.doesNotMatch(script, /set openedTty to tty of markedTab/);
    const openStart = script.indexOf('if actionName is "open" then');
    const openBranch = script.slice(
      openStart,
      script.indexOf('if actionName is "focus" then', openStart),
    );
    assert.match(
      openBranch,
      /if \(processes of markedTab\) contains "codex" then return my jsonResult\(actionName, 1, "focused"\)\s+close markedWindow\s+set markedTab to do script payloadValue/,
      "a completed exec tab must be replaced before resuming the same thread",
    );
    assert.doesNotMatch(openBranch, /do script payloadValue in markedTab/);
  });

  it("quotes the optional file envelope without expanding shell syntax", async () => {
    const recorded = recordingProcess(() => response("open", 0, "opened"));
    const terminal = createTerminalAppOps({ process: recorded.process });

    await terminal.open(TARGET, "读取文件：/tmp/a'b $(touch nope).md");
    const command = recorded.calls[0]!.args.at(-1)!;
    assert.match(command, /'读取文件：\/tmp\/a'\"'\"'b \$\(touch nope\)\.md'$/);
  });

  it("maps closed, live, and stale Terminal states", async () => {
    const outcomes = ["closed", "open", "stale"];
    const recorded = recordingProcess(() => response("status", 1, outcomes.shift()!));
    const terminal = createTerminalAppOps({ process: recorded.process });

    assert.equal(await terminal.status(TARGET), "closed");
    assert.equal(await terminal.status(TARGET), "open");
    assert.equal(await terminal.status(TARGET), "stale");
  });

  it("opens a missing tab, focuses a live client, and resumes a stale tab", async () => {
    const outcomes = ["opened", "focused", "resumed"];
    const recorded = recordingProcess(() => response("open", 1, outcomes.shift()!));
    const terminal = createTerminalAppOps({ process: recorded.process });

    assert.equal(await terminal.open(TARGET), "opened");
    assert.equal(await terminal.open(TARGET), "focused");
    assert.equal(await terminal.open(TARGET, "读取文件：/tmp/prompt.md"), "resumed");
    assert.match(recorded.calls[2]!.args.at(-1)!, /prompt\.md/);
  });

  it("submits only to a unique live marked tab", async () => {
    const recorded = recordingProcess(() => response("submit", 1, "submitted"));
    const terminal = createTerminalAppOps({ process: recorded.process });

    assert.equal(
      await terminal.submit(TARGET, "读取详细任务文件：/tmp/prompt.md"),
      "submitted",
    );
    assert.deepEqual(recorded.calls[0]!.args.slice(-3), [
      "submit",
      TARGET.marker,
      "读取详细任务文件：/tmp/prompt.md",
    ]);
    const script = recorded.calls[0]!.args[1]!;
    assert.match(
      script,
      /if \(processes of markedTab\) contains "codex" then return my jsonResult\(actionName, 1, "open"\)/,
    );
    assert.match(
      script,
      /do script payloadValue in markedTab\s+delay 0\.2\s+do script "" in markedTab/,
      "Codex bracketed paste requires a separate Enter to submit",
    );
  });

  it("fails closed on an ambiguous marker before mutating a window", async () => {
    const recorded = recordingProcess(({ args }) => response(args.at(-3)!, 2, "ambiguous"));
    const terminal = createTerminalAppOps({ process: recorded.process });

    await assert.rejects(
      terminal.open(TARGET),
      (error) => error instanceof TerminalAppError
        && error.code === "terminal_window_ambiguous",
    );
    await assert.rejects(
      terminal.submit(TARGET, "读取详细任务文件：/tmp/prompt.md"),
      (error) => error instanceof TerminalAppError
        && error.code === "terminal_window_ambiguous",
    );
  });

  it("closes only a dedicated marked window", async () => {
    const recorded = recordingProcess(() => response("close", 1, "closed"));
    await createTerminalAppOps({ process: recorded.process }).close(TARGET);

    const script = recorded.calls[0]!.args[1]!;
    assert.match(script, /count tabs of markedWindow/);
    assert.match(script, /close markedWindow/);
    assert.doesNotMatch(script, /close markedTab/);
  });

  it("rediscovers by marker and never reuses an OS window id", async () => {
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
    assert.equal(recorded.calls[1]!.args.some((value) => value.includes("987654")), false);
  });

  it("maps denied Apple events", async () => {
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
  });

  it("rejects malformed targets and unsafe envelopes before invoking osascript", async () => {
    const recorded = recordingProcess(() => response("open", 0, "opened"));
    const terminal = createTerminalAppOps({ process: recorded.process });
    const invalidTargets = [
      { ...TARGET, marker: "STAGEPASS:sp_bad" },
      { ...TARGET, threadId: "not-a-thread" },
      { ...TARGET, cwd: "relative/repo" },
      { ...TARGET, cwd: "/repo\nmalicious" },
    ];
    for (const target of invalidTargets) {
      await assert.rejects(
        terminal.open(target),
        (error) => error instanceof TerminalAppError
          && error.code === "invalid_terminal_target",
      );
    }
    for (const envelope of ["line one\nline two", "bad\0payload"]) {
      await assert.rejects(
        terminal.submit(TARGET, envelope),
        (error) => error instanceof TerminalAppError
          && error.code === "invalid_terminal_target",
      );
    }
    assert.equal(recorded.calls.length, 0);
  });

  it("generates a stable opaque marker per change and seat", () => {
    const marker = terminalMarker("CHG-1", "PRD");
    assert.match(marker, /^STAGEPASS:sp_[0-9a-f]{20}$/);
    assert.equal(marker, terminalMarker("CHG-1", "PRD"));
    assert.notEqual(marker, terminalMarker("CHG-1", "Tech"));
  });
});
