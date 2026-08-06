import { createRequire } from "node:module";

import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from "node-pty";

import type { Phase } from "../domain/phase";

/**
 * A Codex TUI running in a pseudo-terminal StagePass holds the other end of.
 *
 * ## Bytes, never text -- and this is the load-bearing rule
 *
 * Everything that comes out of the pty leaves here as `Uint8Array` and is
 * forwarded unchanged. No `toString()`, no regex, no `JSON.parse`, no branching
 * on content. The browser hands those same bytes to xterm.js, which turns
 * escape sequences into pixels without knowing what a "thinking block" or a
 * "selector" is.
 *
 * That is what separates this from the approach the user rejected (PRD §2.4,
 * third row): StagePass parsing Codex's stream, understanding it, and drawing
 * its own interface. The ONLY difference between the two is "does not interpret"
 * -- both put the bytes through StagePass, both put the picture in a browser.
 *
 * So the rule cannot be a matter of taste, because it would slide: first a
 * highlight when a turn ends (needs a parse), then a hint at the top when the
 * selector scrolls away (needs a parse), and then it is the rejected approach.
 * Here it is a type: `onBytes` hands out `Uint8Array` and nothing in this file
 * can produce a string from the pty, so "let me just check what it says" does
 * not compile. See PRD §9.3, and the standing test that enforces it.
 *
 * ## Why node-pty is given `encoding: null`
 *
 * Its default decodes to a JavaScript string. That would hand every caller the
 * very thing this module exists to withhold -- and worse, decoding a stream that
 * can split a UTF-8 sequence across chunk boundaries corrupts it. Bytes are both
 * the disciplined choice and the correct one.
 *
 * ## The panel holds the handle, which the Terminal.app route did not
 *
 * Launching through osascript meant StagePass discarded the child entirely and
 * could not tell a finished turn from a dead one; §6.4's first pit could only be
 * covered by a timeout. Here a process that dies is an `onExit`, immediately.
 *
 * ## 为什么 `node-pty` 是**用到才加载**的
 *
 * 它是原生模块，而且只带 darwin / win32 的预编译产物 —— Linux 上要现编。于是
 * 一句模块顶部的 `import` 就让**整条注入的路一起废掉**：`panel-server.test.ts`
 * 明明塞的是假 pty（`options.spawn`），却因为加载不了原生模块而整个文件跑不起来。
 * 2026-08-06 CI 第一次真跑就撞上这个 —— 那 114 条测试一条都没执行。
 *
 * **那道缝原来是假的**：注入点在，可依赖仍然是硬加载的。改成用到才拿，
 * 「不碰 Codex 也能证明这一半」这句话才第一次成立，而且哪个平台都跑得动。
 *
 * 类型仍然从 `node-pty` 来（`import type` 编译后不留任何东西），所以下面那个
 * `encoding: null` 和 `IPty` 该管的一样都没少。
 */

/**
 * `node-pty` 的 `spawn`。
 *
 * 照着它的 `.d.ts` 写一份，而不是 `typeof ptySpawn` —— 后者要一个**值**导入，
 * 也就是要在模块顶部加载原生模块，正是这里要避开的那件事。
 */
export type PtySpawn = (
  file: string,
  args: string[] | string,
  options: IPtyForkOptions | IWindowsPtyForkOptions,
) => IPty;

/**
 * 真的那一个，第一次要用时才加载。
 *
 * `createRequire` 而不是 `await import()`：`startPtySession` 是同步的，而它同步
 * 是有理由的 —— 调用方拿到的必须是一个立刻能挂监听的句柄。
 */
let realSpawn: PtySpawn | null = null;
function nodePtySpawn(): PtySpawn {
  realSpawn ??= (createRequire(import.meta.url)("node-pty") as { spawn: PtySpawn }).spawn;
  return realSpawn;
}

export interface PtySessionOptions {
  readonly cwd: string;
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** See `CodexInvocation.approval` for why `never` is not offered. */
  readonly approval?: "untrusted" | "on-request";
  readonly model?: string;
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly cols?: number;
  readonly rows?: number;
  /** Injected so the server half can be proved without spawning Codex. */
  readonly spawn?: PtySpawn;
}

export interface PtySession {
  readonly changeId: string;
  readonly phase: Phase;
  /** Raw pty output. Forwarded, never read. */
  onBytes(listener: (bytes: Uint8Array) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  /** Keystrokes from the browser, as bytes. */
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  readonly alive: boolean;
}

/**
 * Start Codex for one (Change, phase).
 *
 * `argv` is built by `codex/invocation.ts` -- the one place that knows what
 * flags an invocation carries -- and passed straight to the binary. No shell,
 * so the quoting and non-ASCII mangling that the osascript path had to work
 * around cannot happen here at all.
 */
export function startPtySession(input: {
  changeId: string;
  phase: Phase;
  argv: string[];
  options: PtySessionOptions;
}): PtySession {
  const { options } = input;
  // 注入的优先。没注入才去拿真的 —— 也就是**只有真要起进程时才加载原生模块**。
  const spawn = options.spawn ?? nodePtySpawn();
  const terminal: IPty = spawn("codex", input.argv, {
    name: "xterm-256color",
    cols: options.cols ?? 120,
    rows: options.rows ?? 32,
    cwd: options.cwd,
    env: { ...process.env, LANG: "en_US.UTF-8" } as Record<string, string>,
    // See the note above: this is what makes onData yield bytes, not text.
    encoding: null,
  });

  let alive = true;
  terminal.onExit(() => { alive = false; });

  return {
    changeId: input.changeId,
    phase: input.phase,
    onBytes(listener) {
      // `encoding: null` makes this a Buffer, which IS a Uint8Array. It is
      // typed as the narrower thing on purpose: Buffer carries toString().
      terminal.onData((data) => { listener(data as unknown as Uint8Array); });
    },
    onExit(listener) {
      terminal.onExit(({ exitCode }) => { listener(exitCode); });
    },
    write(bytes) {
      terminal.write(bytes as unknown as string);
    },
    resize(cols, rows) {
      if (alive) terminal.resize(cols, rows);
    },
    kill() {
      if (alive) terminal.kill();
    },
    get alive() {
      return alive;
    },
  };
}
