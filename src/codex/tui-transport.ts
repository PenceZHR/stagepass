import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexArgv, codexFlags } from "./invocation";
import {
  findCompletedTurn,
  parseRollout,
  threadIdFromRolloutName,
} from "./rollout";
import {
  CodexUnavailableError,
  type CodexTransport,
  type TurnDelivery,
  type TurnDispatch,
} from "./transport";

/**
 * Codex, run where the human can watch it: a real TUI in a real window.
 *
 * ## Why not `codex mcp-server`
 *
 * mcp-server works and is simpler -- it is a child process handing back a
 * return value. It is also headless, and Codex Desktop will not display a
 * thread it did not create, so a turn run that way is invisible unless
 * StagePass draws the stream itself. That was built, and rejected: rendering
 * belongs to Codex.
 *
 * The TUI renders natively, and measured 2026-07-28:
 *
 *   codex resume <threadId> "<prompt>"   restores the history, sends with no
 *                                        keystroke, and appends to the thread's
 *                                        existing rollout file
 *
 * From inside it the human can type `/app` to continue the same session in
 * Desktop. StagePass neither knows nor needs to know when they do -- every
 * surface writes to the same rollout, which is what this class reads.
 *
 * ## The cost, stated
 *
 * A TUI is not a child whose exit means anything: it stays open after a turn,
 * waiting for more. So completion cannot be detected by waiting for a process,
 * and a hung turn cannot be detected at all from this side. Hence a timeout
 * here, which the mcp transport deliberately did not have. The job's lease
 * (L1) is still the outer bound; this one exists because nothing else would
 * ever resolve the promise.
 */

export interface CodexTuiTransportOptions {
  readonly cwd: string;
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** See `CodexInvocation.approval` for why `never` is not offered. */
  readonly approval?: "untrusted" | "on-request";
  readonly model?: string;
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * 每次启动都带上的 `-c` 配置。**从不写进人的全局配置。**
   *
   * 面板另外两条路（问人问题、录需求）一直是这么挂 `mcp_servers.stagepass` 的，
   * 对抗那条路先前没有 —— 于是裁判那个会话手上没有 StagePass 的工具。
   * 见 docs/DESIGN-no-hand-transcription-2026-08-02.md §四。
   */
  readonly config?: readonly string[];
  /** Where Codex keeps session files. */
  readonly sessionsDir?: string;
  /** How long to wait for the turn to finish. See the note above on why. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  /**
   * Opens the window. Injected so the watching half can be proved offline, and
   * so the same transport can drive a Terminal.app window or a browser pty.
   *
   * `script` is the shell form: the prompt is in a FILE and the script reads it
   * back, because a prompt that goes through a shell comes out mangled.
   * `argv` is the shell-free form for launchers that exec the binary directly --
   * the prompt is one element there, so nothing can reinterpret it.
   */
  readonly launch?: (input: {
    command: string;
    args: string[];
    script: string;
    argv: string[];
    /**
     * 这个 turn 在人眼里叫什么，`undefined` = 它就是这个阶段的主线。
     * 只是原样转交 `TurnDispatch.aside` 的标签 —— 这一层不解释它。
     */
    label?: string;
  }) => (() => void) | void;
  /**
   * 往这个 turn 的会话里补一下按键。**只在提示词根本没被提交的时候用。**
   *
   * 上面那句「sends with no keystroke」是 2026-07-28 实测的，2026-08-03 被证伪：
   * 挂上插件之后 MCP server 变成 4 个，启动更慢，Codex 把 argv 里的提示词
   * **搁进了 composer 却没发出去**（屏幕停在 `Starting MCP server (2/4)`，
   * 提示词前面带着 `›`）。rollout 一个字节没长，于是这一侧等满整个 timeout ——
   * 而界面上它和「在跑」一模一样。
   *
   * 补一下回车就发出去了。`label` 原样转交，让上面那层知道该往哪一格写。
   */
  readonly nudge?: (input: { label?: string; bytes: Uint8Array }) => void;
  /**
   * 等多久还没动静才补那一下。默认 45 秒。
   *
   * 判据是 rollout **一条记录都没长**：真的开跑了，`user_message` 立刻就落进去。
   * 所以这一下只会打在「压根没开始」上，不会打断正在跑的 turn —— 而后者正是
   * 2026-08-03 那个 `■ Conversation interrupted` 的成因，绝不能由我们自己制造。
   */
  readonly nudgeAfterMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SESSIONS = join(
  process.env.HOME ?? "", ".codex", "sessions",
);

/** Every rollout under the sessions tree, by thread id. */
function rollouts(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return; // Not created yet, which is normal before the first session.
    }
    for (const entry of entries) {
      const path = join(directory, entry);
      const threadId = threadIdFromRolloutName(entry);
      if (threadId) found.set(threadId, path);
      else if (!entry.includes(".")) walk(path);
    }
  };
  walk(root);
  return found;
}

export class CodexTuiTransport implements CodexTransport {
  private readonly sessionsDir: string;
  private readonly timeoutMs: number;
  private readonly nudgeAfterMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: CodexTuiTransportOptions) {
    this.sessionsDir = options.sessionsDir ?? DEFAULT_SESSIONS;
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.nudgeAfterMs = options.nudgeAfterMs ?? 45_000;
    this.pollMs = options.pollMs ?? 1_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep
      ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async runTurn(dispatch: TurnDispatch): Promise<TurnDelivery> {
    const before = rollouts(this.sessionsDir);
    // How much of this thread's file already existed. Everything before this
    // belongs to earlier turns, and returning one of those answers would look
    // like a turn that finished impossibly fast with the wrong content.
    const priorRecords = dispatch.threadId
      ? this.recordCount(before.get(dispatch.threadId))
      : 0;

    const dispose = this.launch(dispatch);

    try {
      const threadId = dispatch.threadId
        ?? await this.awaitNewThread(new Set(before.keys()), dispatch.prompt);
      // id 一确定就说出去，别等 awaitTurn —— 那一步是整轮里最长的（见 TurnDispatch）。
      dispatch.onThread?.(threadId);
      /*
       * 补那一下只给 `resume` 那种。新起的会话由 `awaitNewThread` 认线程 ——
       * 那一步是靠**提示词出现在 rollout 里**认出来的，所以它能走到这里就说明
       * 提示词早已提交，没有可补的东西。
       */
      const nudge = this.options.nudge !== undefined && dispatch.threadId !== null
        ? () => {
          this.options.nudge?.({
            ...(dispatch.aside === undefined ? {} : { label: dispatch.aside.label }),
            bytes: new TextEncoder().encode("\r"),
          });
        }
        : undefined;
      const text = await this.awaitTurn(threadId, priorRecords, nudge);
      return { threadId, text };
    } finally {
      /*
       * **只收 aside 那种，阶段的主线一个字都不动。**
       *
       * 阶段那个终端跑完要留着：人还要在里面看裁判说了什么、回答选择器里的问题。
       * 而补问那种是临时开的一格，用户 2026-07-31 定了「补完自动关」。
       *
       * **`finally` 而不是成功路径**：补问超时、Codex 报错，那个终端同样得收掉 ——
       * 否则失败一次就在面板上留一个再也不会更新的死格子。
       *
       * TUI **跑完不会自己退出**（实测：它一直等下一句），所以这一步不是保险，
       * 是唯一会发生的关闭。
       */
      if (dispatch.aside) dispose?.();
    }
  }

  /**
   * The prompt goes through a file, never through the shell.
   *
   * Measured the hard way: passing it as a quoted argument through osascript
   * mangled every non-ASCII character, and the model was asked a question full
   * of replacement bytes.
   */
  private launch(dispatch: TurnDispatch): (() => void) | void {
    const directory = mkdtempSync(join(tmpdir(), "stagepass-turn-"));
    const promptFile = join(directory, "prompt.txt");
    writeFileSync(promptFile, dispatch.prompt, "utf-8");

    const shape = {
      threadId: dispatch.threadId,
      sandbox: this.options.sandbox,
      approval: this.options.approval,
      model: this.options.model,
      reasoningEffort: this.options.reasoningEffort,
      ...(this.options.config === undefined
        ? {} : { config: [...this.options.config] }),
    };
    const flags = codexFlags(shape);
    const invocation = dispatch.threadId === null
      ? ["codex", ...flags, `"$(cat ${promptFile})"`]
      : ["codex", "resume", dispatch.threadId, ...flags, `"$(cat ${promptFile})"`];
    // The shell-free form, for launchers that exec the binary themselves.
    const argv = codexArgv({ ...shape, prompt: dispatch.prompt });

    const script = join(directory, "run.sh");
    writeFileSync(script, [
      "#!/bin/zsh",
      `cd ${JSON.stringify(this.options.cwd)}`,
      "export LANG=en_US.UTF-8",
      `exec ${invocation.join(" ")}`,
      "",
    ].join("\n"), { mode: 0o755 });

    const launcher = this.options.launch ?? defaultLaunch;
    return launcher({
      command: "codex", args: invocation.slice(1), script, argv,
      ...(dispatch.aside === undefined ? {} : { label: dispatch.aside.label }),
    });
  }

  private recordCount(path: string | undefined): number {
    if (!path) return 0;
    try {
      return parseRollout(readFileSync(path, "utf-8")).length;
    } catch {
      return 0;
    }
  }

  /** A brand new Change has no thread until its first turn creates one. */
  /**
   * 等我们自己那个线程出现 —— **认提示词，不认「谁先出现」**。
   *
   * 原先的做法是「启动之后第一个没见过的线程 id」。那是个竞态：只要在轮询窗口里
   * 有任何别的 Codex 建了线程，就会抓错。实测栽过一次（2026-07-29）——一轮没杀干净
   * 的对抗还在派生子 Agent，这里抓到了它的线程，于是后面去找 `/root/red` 一无所获，
   * 报出来是「裁判没有派生子 Agent」，而裁判其实好好地派生了，只是**不是这个裁判**。
   *
   * 提示词是我们自己写的，它会原样进 rollout，所以拿它来认。JSON 转义过，所以比对
   * 的是转义后的形式。
   *
   * 这挡不住「两轮同时跑、提示词一模一样」，但那一格已经由「一个阶段线程同时只许
   * 有一个进程」挡着了（PRD §6.5 规则 5）。
   */
  private async awaitNewThread(
    known: ReadonlySet<string>,
    prompt: string,
  ): Promise<string> {
    // 转义后的形式：rollout 是 JSON 行，换行和引号都不是原样。
    const needle = JSON.stringify(prompt).slice(1, -1);
    const deadline = this.now() + this.timeoutMs;
    let sawNew = false;

    while (this.now() < deadline) {
      for (const [threadId, path] of rollouts(this.sessionsDir)) {
        if (known.has(threadId)) continue;
        sawNew = true;
        let text: string;
        try {
          text = readFileSync(path, "utf-8");
        } catch {
          continue; // 正在写，下一轮再看
        }
        if (text.includes(needle)) return threadId;
      }
      await this.sleep(this.pollMs);
    }

    // 两种失败长得完全不一样，必须分开说：一种是 TUI 没起来，另一种是起来了但
    // 那些线程都不是我们的 —— 后者说明有别的 Codex 在跑，而不是这里坏了。
    throw new CodexUnavailableError(sawNew
      ? "new Codex sessions appeared but none carried this prompt;"
        + " another Codex is probably running"
      : "no new Codex session appeared; the TUI may not have started");
  }

  private async awaitTurn(
    threadId: string,
    fromIndex: number,
    nudge?: () => void,
  ): Promise<string> {
    const deadline = this.now() + this.timeoutMs;
    const nudgeAt = this.now() + this.nudgeAfterMs;
    let nudged = false;
    while (this.now() < deadline) {
      const path = rollouts(this.sessionsDir).get(threadId);
      if (path) {
        let outcome: { text: string } | null = null;
        try {
          outcome = findCompletedTurn(
            parseRollout(readFileSync(path, "utf-8")),
            fromIndex,
          );
        } catch {
          // Being written to right now; read it again.
        }
        if (outcome) return outcome.text;
      }
      /*
       * **提示词躺在 composer 里没被发出去 —— 补一下回车。**
       *
       * 三重闸都要过，因为这一下是往一个活着的 Codex 会话里塞按键，而塞错地方
       * 正是 2026-08-03 那个 `■ Conversation interrupted` 的成因：
       *
       *   1. 等够 `nudgeAfterMs`（默认 45 秒）—— 启动慢不算病
       *   2. rollout **一条记录都没长**。真开跑了 `user_message` 立刻就落进去，
       *      所以这一条把「在跑」和「压根没开始」分得干干净净
       *   3. 只补一次。补完还是不动，那就是别的毛病，让它照常超时报出来
       */
      if (!nudged && nudge !== undefined
        && this.now() >= nudgeAt && this.recordCount(path) <= fromIndex) {
        nudged = true;
        nudge();
      }
      await this.sleep(this.pollMs);
    }
    // Named, because "the window is still open and nothing happened" is
    // indistinguishable from success unless someone says so.
    throw new CodexUnavailableError(
      `turn did not complete within ${this.timeoutMs}ms on thread ${threadId}`,
    );
  }
}

/**
 * Open a Terminal window. macOS only, matching the product's stated scope
 * (local-first, single user), and isolated here so that is the only line to
 * change if that stops being true.
 */
function defaultLaunch(input: { script: string }): void {
  spawn("osascript", [
    "-e", `tell application "Terminal" to do script ${JSON.stringify(input.script)}`,
    "-e", 'tell application "Terminal" to activate',
  ], { stdio: "ignore", detached: true }).unref();
}
