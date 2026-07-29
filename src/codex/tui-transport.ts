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
  }) => void;
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
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: CodexTuiTransportOptions) {
    this.sessionsDir = options.sessionsDir ?? DEFAULT_SESSIONS;
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
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

    this.launch(dispatch);

    const threadId = dispatch.threadId
      ?? await this.awaitNewThread(new Set(before.keys()));
    const text = await this.awaitTurn(threadId, priorRecords);
    return { threadId, text };
  }

  /**
   * The prompt goes through a file, never through the shell.
   *
   * Measured the hard way: passing it as a quoted argument through osascript
   * mangled every non-ASCII character, and the model was asked a question full
   * of replacement bytes.
   */
  private launch(dispatch: TurnDispatch): void {
    const directory = mkdtempSync(join(tmpdir(), "stagepass-turn-"));
    const promptFile = join(directory, "prompt.txt");
    writeFileSync(promptFile, dispatch.prompt, "utf-8");

    const shape = {
      threadId: dispatch.threadId,
      sandbox: this.options.sandbox,
      approval: this.options.approval,
      model: this.options.model,
      reasoningEffort: this.options.reasoningEffort,
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
    launcher({ command: "codex", args: invocation.slice(1), script, argv });
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
  private async awaitNewThread(known: ReadonlySet<string>): Promise<string> {
    const deadline = this.now() + this.timeoutMs;
    while (this.now() < deadline) {
      for (const threadId of rollouts(this.sessionsDir).keys()) {
        if (!known.has(threadId)) return threadId;
      }
      await this.sleep(this.pollMs);
    }
    throw new CodexUnavailableError(
      "no new Codex session appeared; the TUI may not have started",
    );
  }

  private async awaitTurn(
    threadId: string,
    fromIndex: number,
  ): Promise<string> {
    const deadline = this.now() + this.timeoutMs;
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
