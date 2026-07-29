/**
 * How StagePass invokes Codex. One implementation, because it is one rule.
 *
 * Two launch paths need this argument vector -- the Terminal.app one, which
 * feeds it through a shell script, and the pty one, which passes it straight to
 * the binary. Building it twice would be the shape M2 exists to prevent: two
 * copies of a rule that can disagree, and the disagreement here is invisible
 * until a turn silently runs under the wrong permissions.
 */

/**
 * `| undefined` is spelled out on every optional field on purpose: the tree
 * builds with `exactOptionalPropertyTypes`, and callers forward options they
 * may not have. Without it, "I have no model set" cannot be passed along.
 */
export interface CodexInvocation {
  /** The thread to continue, or null to start one. */
  readonly threadId: string | null;
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access" | undefined;
  /**
   * `never` is deliberately absent.
   *
   * Measured 2026-07-29 and reproduced (`pnpm probe:elicit`): `-a never` makes
   * Codex auto-decline every MCP `elicitation/create`, which is the only channel
   * StagePass has for reaching a person. It fails silently -- what comes back is
   * a legal `{"action":"decline"}`, identical to someone pressing Esc. Leaving
   * the value out of the type is what keeps a future edit from reaching it.
   * See PRD §6.6.
   */
  readonly approval?: "untrusted" | "on-request" | undefined;
  readonly model?: string | undefined;
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
  /**
   * The prompt, when this invocation is dispatching a turn.
   *
   * Omitted means "open Codex and leave it at the composer" -- what the panel
   * does when someone opens a phase to look rather than to run it. No turn is
   * sent, so nothing is dispatched and no model is called.
   */
  readonly prompt?: string | undefined;
}

/** The flags, without the subcommand or the prompt. */
export function codexFlags(input: CodexInvocation): string[] {
  return [
    "-s", input.sandbox ?? "read-only",
    // Always explicit, never left to the client default: what StagePass needs
    // from this flag is that elicitation keeps working.
    "-a", input.approval ?? "on-request",
    ...(input.model ? ["-m", input.model] : []),
    ...(input.reasoningEffort
      ? ["-c", `model_reasoning_effort="${input.reasoningEffort}"`]
      : []),
  ];
}

/**
 * The full argument vector, ready to hand to the binary.
 *
 * Shell-free by construction: the prompt is one element, so quoting, `$VAR` and
 * backticks in it are inert. The Terminal.app path cannot use this directly --
 * it goes through a shell -- and passes the prompt via a file instead.
 */
export function codexArgv(input: CodexInvocation): string[] {
  return [
    ...(input.threadId === null ? [] : ["resume", input.threadId]),
    ...codexFlags(input),
    ...(input.prompt === undefined ? [] : [input.prompt]),
  ];
}
