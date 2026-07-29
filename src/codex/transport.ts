/**
 * The one thing in the tree that talks to Codex.
 *
 * ## One method, and it is a public one
 *
 * Measured against `codex mcp-server` 0.144.4 on 2026-07-28: a thread is
 * created BY its first turn, not opened beforehand. So this is a single call
 * that takes the thread it is continuing, or null to start one, and returns the
 * thread it ran on. An earlier two-method shape (openThread + startTurn)
 * described an API that does not exist.
 *
 * The whole unproven surface of L2 is this interface. Everything around it --
 * binding, turn records, the response contract, every failure path -- is proved
 * offline against `ScriptedCodexTransport`.
 *
 * ## No private protocol
 *
 * `codex mcp-server` is a documented subcommand speaking MCP 2025-06-18 over
 * stdio. The tree this replaces drove Codex through a private `le32-json` IPC
 * socket and pinned `bundleVersion` fingerprints in an allowlist, so every
 * Desktop release could break it -- a 4000-line verifier existed to hedge that
 * risk. Nothing here depends on an interface Codex does not publish.
 */

export interface TurnDispatch {
  /** The thread to continue, or null to start one. */
  readonly threadId: string | null;
  readonly prompt: string;
}

export interface TurnDelivery {
  /** The thread it ran on. For a new thread this is the id that was created. */
  readonly threadId: string;
  readonly text: string;
}

export interface CodexTransport {
  runTurn(dispatch: TurnDispatch): Promise<TurnDelivery>;
}

export class CodexUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`codex_unavailable: ${detail}`);
    this.name = "CodexUnavailableError";
  }
}

/**
 * A scripted stand-in, for proving everything around the transport.
 *
 * It records what it was asked, so a test can assert that the prompt actually
 * carried the result contract -- dispatching a turn without telling the model
 * what shape to answer in is silent here and surfaces much later as an
 * unparsable result.
 */
export class ScriptedCodexTransport implements CodexTransport {
  readonly dispatches: TurnDispatch[] = [];
  private readonly replies: (string | Error)[];

  constructor(
    replies: (string | Error)[],
    private readonly threadId = "THREAD-1",
  ) {
    this.replies = [...replies];
  }

  async runTurn(dispatch: TurnDispatch): Promise<TurnDelivery> {
    this.dispatches.push(dispatch);
    const next = this.replies.shift();
    if (next === undefined) {
      throw new CodexUnavailableError("scripted_transport_exhausted");
    }
    if (next instanceof Error) throw next;
    return { threadId: dispatch.threadId ?? this.threadId, text: next };
  }
}
