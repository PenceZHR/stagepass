import { spawn } from "node:child_process";

/**
 * Putting a running turn in front of the human.
 *
 * `codex mcp-server` is headless by design -- no terminal, no window -- so a
 * turn StagePass started is invisible unless something says where it is. The
 * `codex` URL scheme is registered by the Codex app at the system level, and
 * opening a thread makes Desktop show it: measured 2026-07-28, including while
 * the turn was still streaming, so this is live viewing and not a replay.
 *
 * This is the answer to "I cannot see it in Codex". Printing the URL was not.
 *
 * ## What this does NOT solve
 *
 * Watching is not owning. A card rendered by an MCP app only appears in the
 * client that OWNS the turn, and a thread opened this way is owned by the
 * mcp-server process. To get a card in front of someone, the turn has to be
 * started by Desktop itself -- `codex://threads/new?cwd=...&prompt=...`, which
 * prefills the box and waits for a human to press Enter. That keystroke cannot
 * be skipped; nothing in the binary auto-sends.
 */

export function threadUrl(threadId: string): string {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

/**
 * A new Desktop-owned thread with the prompt already typed in.
 *
 * The human presses Enter. From then on Desktop owns the turn, which is the
 * only arrangement in which a StagePass card renders.
 */
export function newThreadUrl(input: { cwd: string; prompt: string }): string {
  const params = new URLSearchParams({
    cwd: input.cwd,
    prompt: input.prompt,
  });
  return `codex://threads/new?${params.toString()}`;
}

export interface DesktopOpener {
  (url: string): void;
}

/**
 * Hand the URL to the operating system.
 *
 * Failure is swallowed on purpose: not being able to show someone a thread must
 * not fail the turn that is running in it. Losing the window costs a click;
 * losing the turn costs the work.
 */
export const openInDesktop: DesktopOpener = (url) => {
  try {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Nothing to do and nothing worth failing for.
  }
};
