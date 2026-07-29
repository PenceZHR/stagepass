import { spawn as ptySpawn, type IPty } from "node-pty";

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
 */

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
  readonly spawn?: typeof ptySpawn;
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
  const spawn = options.spawn ?? ptySpawn;
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
