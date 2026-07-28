/**
 * The one thing in the tree that talks to Codex.
 *
 * Everything else at L2 -- the binding, the turn record, the response contract,
 * the failure paths -- is proved offline against `ScriptedCodexTransport`. This
 * interface is deliberately the whole of the unprovable surface, and it is two
 * methods wide, so "L2 works" reduces to one question a person can answer in
 * one action: does a real turn come back.
 */

export interface CodexTransport {
  /**
   * Open the persistent thread this Change lives in, returning its id. Called
   * once per Change; afterwards the binding answers instead.
   */
  openThread(input: { changeId: string }): Promise<string>;

  /** Run one turn on an open thread and return the text it produced. */
  startTurn(input: { threadId: string; prompt: string }): Promise<string>;
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
 * carried the result contract -- the failure where a turn is dispatched without
 * telling the model what shape to answer in is silent otherwise, and shows up
 * much later as an unparsable result.
 */
export class ScriptedCodexTransport implements CodexTransport {
  readonly prompts: string[] = [];
  private readonly replies: (string | Error)[];

  constructor(
    replies: (string | Error)[],
    private readonly threadId = "THREAD-1",
  ) {
    this.replies = [...replies];
  }

  async openThread(): Promise<string> {
    return this.threadId;
  }

  async startTurn(input: { threadId: string; prompt: string }): Promise<string> {
    this.prompts.push(input.prompt);
    const next = this.replies.shift();
    if (next === undefined) {
      throw new CodexUnavailableError("scripted_transport_exhausted");
    }
    if (next instanceof Error) throw next;
    return next;
  }
}
