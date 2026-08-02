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
  /**
   * 线程 id 一确定就叫一声，**别等 turn 跑完**。
   *
   * 一个 turn 要跑几分钟，而线程在开头就建出来了。等到 `runTurn` 返回才拿 id 的
   * 后果实测过两个：进度端点在第一轮全程说不出「走到哪了」（子 Agent 要从这个 id
   * 查）；一轮中途死掉时线程明明建了、StagePass 却什么都没记下来。
   *
   * 回调抛出的异常不吞 —— 记录失败就该让这一轮失败，静默丢掉等于回到没有它的样子。
   */
  readonly onThread?: (threadId: string) => void;
  /**
   * 这个 turn **不是这个阶段的主线**：它自己有个名字，跑完就收。
   *
   * 补问反方走的是这条（L5 的 `runRubricRound`）：那一 turn 跑在**另一条线程**上
   * （反方的），所以不能挤掉阶段那个终端 —— 而它又必须让人看得见，因为
   * 「所有 turn 都在面板里看得见」是这个产品的前提。
   *
   * **字符串是不透明的。** 这一层不知道「标签页」是什么东西，也不该知道；面板拿它
   * 当标签名，别的 launcher 可以完全忽略它。缺席 = 这就是阶段的主线，行为和加这个
   * 字段之前逐字一致。
   */
  readonly aside?: { readonly label: string };
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
    // 和真 transport 同一个顺序：线程先出现，然后 turn 才有下文 —— 失败也一样。
    dispatch.onThread?.(dispatch.threadId ?? this.threadId);
    const next = this.replies.shift();
    if (next === undefined) {
      throw new CodexUnavailableError("scripted_transport_exhausted");
    }
    if (next instanceof Error) throw next;
    return { threadId: dispatch.threadId ?? this.threadId, text: next };
  }
}
