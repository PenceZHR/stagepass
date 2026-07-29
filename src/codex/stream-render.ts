/**
 * Turning Codex's event stream into something a person can watch.
 *
 * ## Why this exists at all
 *
 * `codex mcp-server` is headless and Codex Desktop does not display a thread it
 * did not create -- measured 2026-07-28: the deep link opens an empty window
 * while the rollout on disk holds every record. So if StagePass does not render
 * the stream itself, a running turn is invisible, and "用户能看到 Codex 的执行状态"
 * is simply false.
 *
 * The stream itself was never the problem. `codex/event` carries the whole
 * thing; an earlier transport received all of it and threw everything away
 * except the thread id and the final answer, which is why the screen stayed
 * blank. This is the missing sixty lines, not a new capability.
 *
 * ## Unknown events are ignored, deliberately
 *
 * Codex adds event types; a renderer that threw on one it had not seen would
 * turn a cosmetic change into a failed turn. Degrading to silence for an
 * unrecognised type costs a line of output. Failing costs the work.
 *
 * ## This module is pure
 *
 * An event in, a piece of text out. No IO, so every branch is provable offline
 * against captured payloads rather than by running a turn and watching.
 */

export interface CodexEvent {
  readonly type?: unknown;
  readonly [key: string]: unknown;
}

export type Rendered =
  /** A complete line. */
  | { readonly kind: "line"; readonly text: string }
  /** Part of a line being streamed; write it with no newline. */
  | { readonly kind: "chunk"; readonly text: string }
  /**
   * The finished form of something that was just streamed.
   *
   * Codex sends both: the deltas as they are produced, then the whole message
   * again. Rendering both printed every sentence twice -- measured. The printer
   * drops this when it has just streamed the same text, and prints it when it
   * has not, so a turn that produces no deltas is not silent.
   */
  | { readonly kind: "final"; readonly text: string };

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function describeEvent(event: CodexEvent): Rendered | null {
  const type = str(event.type);
  if (!type) return null;

  switch (type) {
    case "task_started":
      return { kind: "line", text: "▶ turn started" };
    case "task_complete":
      return { kind: "line", text: "■ turn complete" };

    // The two streams a person actually reads: what it is thinking, and what it
    // is saying. Emitted as chunks so the text appears as it is produced --
    // that IS the thing being asked for by "I can see it outputting".
    case "agent_message_content_delta":
    case "agent_reasoning_content_delta":
    case "reasoning_content_delta": {
      const delta = str(event.delta) ?? str(event.text);
      return delta ? { kind: "chunk", text: delta } : null;
    }
    case "agent_message":
    case "agent_reasoning": {
      const message = str(event.message) ?? str(event.text);
      return message ? { kind: "final", text: message } : null;
    }

    case "mcp_startup_update": {
      const server = str(event.server);
      const state = str((event.status as { state?: unknown } | undefined)?.state);
      return server && state
        ? { kind: "line", text: `  plugin ${server}: ${state}` }
        : null;
    }
    case "mcp_tool_call_begin":
    case "mcp_tool_call_end": {
      const invocation = event.invocation as
        { server?: unknown; tool?: unknown } | undefined;
      const tool = str(invocation?.tool);
      if (!tool) return null;
      const mark = type === "mcp_tool_call_begin" ? "→" : "←";
      return {
        kind: "line",
        text: `  ${mark} ${str(invocation?.server) ?? "?"}/${tool}`,
      };
    }

    case "exec_command_begin": {
      const command = event.command;
      const shown = Array.isArray(command)
        ? command.join(" ")
        : str(command) ?? "";
      return shown ? { kind: "line", text: `  $ ${shown}` } : null;
    }
    case "exec_command_end": {
      const code = event.exit_code;
      return {
        kind: "line",
        text: `  exit ${typeof code === "number" ? code : "?"}`,
      };
    }

    case "token_count": {
      // Nested under `info` on 0.144.4; tolerate both shapes rather than
      // guessing wrong and printing nothing.
      const info = event.info as { total_token_usage?: unknown } | undefined;
      const usage = (info?.total_token_usage ?? event.total_token_usage) as
        { total_tokens?: unknown } | undefined;
      const total = usage?.total_tokens;
      return typeof total === "number"
        ? { kind: "line", text: `  ${total} tokens` }
        : null;
    }

    case "error":
    case "stream_error": {
      const message = str(event.message) ?? str(event.error) ?? type;
      return { kind: "line", text: `  ! ${message}` };
    }

    // Everything else -- including event types that do not exist yet.
    default:
      return null;
  }
}

/**
 * Write rendered events to a sink, keeping streamed chunks on one line.
 *
 * Stateful on purpose: a chunk followed by a line needs a newline between them,
 * and only something that remembers what it last wrote can know that.
 */
export class StreamPrinter {
  private midLine = false;
  private streamed = false;

  constructor(private readonly write: (text: string) => void) {}

  handle(event: CodexEvent): void {
    const rendered = describeEvent(event);
    if (!rendered) return;

    if (rendered.kind === "chunk") {
      this.write(rendered.text);
      this.midLine = true;
      this.streamed = true;
      return;
    }
    if (rendered.kind === "final") {
      // Already shown, delta by delta. Printing it again is the duplicate.
      if (this.streamed) {
        this.endLine();
        return;
      }
      this.endLine();
      this.write(`${rendered.text}\n`);
      return;
    }
    this.endLine();
    this.write(`${rendered.text}\n`);
  }

  /** Close a streamed line, and forget that anything was streamed on it. */
  private endLine(): void {
    if (this.midLine) {
      this.write("\n");
      this.midLine = false;
    }
    this.streamed = false;
  }
}
