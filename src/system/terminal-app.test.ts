import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTerminalAppOps,
  terminalMarker,
  TerminalAppError,
  TERMINAL_SCRIPT,
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

describe("Codex MCP config reaches the resumed TUI", () => {
  // 2026-08-17 真机：TUI 在正确的线程上恢复了，读到了题面，然后说
  // 「无法调用：当前会话未提供 stagepass_ask 工具」。rollout 里能看到它执行
  // `ALL_TOOLS.filter(...)` 找不到那个工具就 throw 了。
  //
  // 成因：StagePass 在 thread/start 时把 mcp_servers.stagepass.* 作为**线程配置**
  // 交给 app-server，但交给 Terminal 的 `codex resume` 只带了 tui.terminal_title。
  // 官方 TUI 是另一个客户端，它拿的是全局 config.toml —— 那里面没有 stagepass。
  // 控制连接握着会话配置，而真正跑 turn 的是 TUI：配置必须跟着命令行一起过去。
  const CONFIG = {
    "mcp_servers.stagepass.command": "npx",
    "mcp_servers.stagepass.args": ["tsx", "/repo/src/plugin/server.ts"],
    "mcp_servers.stagepass.env": {
      STAGEPASS_DB: "/db/panel.db",
      STAGEPASS_CHANGE: "CHG-002",
      STAGEPASS_PHASE: "PRD",
    },
    "mcp_servers.stagepass.default_tools_approval_mode": "auto",
  } as const;

  it("passes every seat config entry as a codex -c override", async () => {
    const recorded = recordingProcess(() => response("open", 0, "opened"));
    const terminal = createTerminalAppOps({ process: recorded.process });

    await terminal.open({ ...TARGET, config: CONFIG });

    const command = recorded.calls[0]!.args.at(-1)!;
    assert.match(command, /-c 'mcp_servers\.stagepass\.command="npx"'/);
    assert.match(
      command,
      /-c 'mcp_servers\.stagepass\.args=\["tsx","\/repo\/src\/plugin\/server\.ts"\]'/,
    );
    assert.match(
      command,
      /-c 'mcp_servers\.stagepass\.env=\{STAGEPASS_DB="\/db\/panel\.db",STAGEPASS_CHANGE="CHG-002",STAGEPASS_PHASE="PRD"\}'/,
    );
    assert.match(command, /-c 'mcp_servers\.stagepass\.default_tools_approval_mode="auto"'/);
    assert.match(command, /-c 'tui\.terminal_title=\[\]'/, "原有的标题抑制不能丢");
  });

  it("keeps the envelope last so codex still reads it as the prompt", async () => {
    const recorded = recordingProcess(() => response("open", 0, "opened"));
    const terminal = createTerminalAppOps({ process: recorded.process });

    await terminal.open({ ...TARGET, config: CONFIG }, "读取文件：/tmp/prompt.md");

    const command = recorded.calls[0]!.args.at(-1)!;
    assert.match(command, /'读取文件：\/tmp\/prompt\.md'$/);
    assert.ok(
      command.indexOf("mcp_servers.stagepass.command") < command.indexOf("--cd"),
      "-c 覆盖必须排在 --cd 之前，位置参数不能被它们挤开",
    );
  });

  it("never lets a config value break out of its shell word", async () => {
    // 安全的引用**保留**危险字符，只是让它们变成字面量 —— 所以断言「字符串里没有
    // 那段文本」是错的判据。真正要问的是：交给 shell 之后它是不是一个参数。
    // 这里就用真的 shell 把命令拆开数一遍。
    const recorded = recordingProcess(() => response("open", 0, "opened"));
    const terminal = createTerminalAppOps({ process: recorded.process });
    const payload = "a'; touch /tmp/stagepass-pwned; echo '";

    await terminal.open({ ...TARGET, config: { "mcp_servers.evil.command": payload } });

    const command = recorded.calls[0]!.args.at(-1)!;
    const argv = command.replace(/^exec codex resume/, "");
    const printed = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${argv}`], {
      encoding: "utf8",
    }).split("\n");

    assert.ok(
      printed.includes(`mcp_servers.evil.command=${JSON.stringify(payload)}`),
      "整个 key=value 必须原样落成一个参数",
    );
    assert.equal(existsSync("/tmp/stagepass-pwned"), false, "shell 不该执行注入进来的命令");
  });

  it("changes nothing when a seat carries no config", async () => {
    const recorded = recordingProcess(() => response("open", 0, "opened"));
    const terminal = createTerminalAppOps({ process: recorded.process });

    await terminal.open(TARGET);

    assert.doesNotMatch(recorded.calls[0]!.args.at(-1)!, /mcp_servers/);
  });
});

describe("Terminal AppleScript source", () => {
  // 这段脚本是 100 行静态 AppleScript，只有真机会执行它：单元测试全部用假的
  // osascript，假的那个永远同意。语法错一次，开终端 / 聚焦 / 投递 / 关窗四个
  // 动作会一起死在真机上，而套件全绿 —— 和「星图从没显示过」是同一类。
  // osacompile 只编译不执行，不会碰 Terminal.app。
  it("compiles as AppleScript", (t) => {
    let osacompile: string;
    try {
      osacompile = execFileSync("/usr/bin/which", ["osacompile"], { encoding: "utf8" }).trim();
    } catch {
      t.skip("osacompile 不在这台机器上；AppleScript 语法未经检查");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "stagepass-applescript-"));
    const source = join(dir, "terminal.applescript");
    writeFileSync(source, TERMINAL_SCRIPT);
    assert.doesNotThrow(() => {
      execFileSync(osacompile, ["-l", "AppleScript", "-o", join(dir, "out.scpt"), source], {
        stdio: "pipe",
      });
    });
  });

  it("never launches Terminal just to look at it", () => {
    // 用户的界面原则：只读动作要真只读。`tell application "Terminal"` 会把没在跑的
    // Terminal.app 拉起来，所以 status / close / focus / submit 必须在进 tell 之前
    // 就用 `is not running` 短路返回；只有 open 才允许启动它。
    const guard = TERMINAL_SCRIPT.indexOf('if application "Terminal" is not running then');
    const tell = TERMINAL_SCRIPT.indexOf('tell application "Terminal"');
    assert.ok(guard > 0, "缺少 `is not running` 短路");
    assert.ok(guard < tell, "短路必须在 tell 之前，否则看一眼就把 Terminal 拉起来了");
    const shortCircuit = TERMINAL_SCRIPT.slice(guard, tell);
    for (const action of ["status", "close", "focus", "submit"]) {
      assert.match(shortCircuit, new RegExp(`is "${action}"`), `${action} 会拉起 Terminal.app`);
    }
    assert.doesNotMatch(shortCircuit, /is "open"/, "open 本来就该启动 Terminal");
  });
});
