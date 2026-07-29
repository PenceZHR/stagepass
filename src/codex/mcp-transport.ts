import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { openInDesktop, threadUrl } from "./desktop-link";
import {
  CodexUnavailableError,
  type CodexTransport,
  type TurnDelivery,
  type TurnDispatch,
} from "./transport";

/**
 * Codex, driven through its published MCP server.
 *
 * `codex mcp-server` is a documented subcommand that speaks MCP 2025-06-18 over
 * stdio. Two tools, both measured on 0.144.4:
 *
 *   codex        {prompt, cwd?, sandbox?, ...}  -> starts a thread, returns its id
 *   codex-reply  {prompt, threadId}             -> continues that thread
 *
 * and the result carries `structuredContent: {threadId, content}`. That is the
 * whole integration. No private socket, no framing protocol, no bundle-version
 * allowlist that a Codex release can invalidate.
 *
 * ## The process is long-lived
 *
 * One server serves many turns; starting one per turn would pay the handshake
 * every time and lose nothing in return. It is started lazily on the first turn
 * so that constructing a runner costs nothing, and `close()` ends it.
 *
 * ## Turns are not bounded here
 *
 * A design turn can legitimately run for minutes. The bound on how long is the
 * job's lease deadline (L1), which already fails the work with a reason a
 * person can read. A second timeout here would race that one and report the
 * same event under two different names.
 */

interface PendingCall {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

interface ToolResult {
  structuredContent?: { threadId?: unknown; content?: unknown };
  content?: { type?: string; text?: string }[];
  isError?: boolean;
}

export interface CodexMcpTransportOptions {
  /** Working directory the turn runs in. */
  readonly cwd: string;
  /** Codex sandbox policy. Read-only unless a phase is meant to write code. */
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  readonly command?: string;
  /**
   * Codex model and reasoning effort.
   *
   * Plumbed rather than hardcoded because the product requires them to be the
   * user's choice ("用户可以为 Codex 选择模型和推理强度"), and because the default
   * is `xhigh` -- measured: a one-word answer cost 20k tokens and two design
   * turns did not finish inside ten minutes. A caller that does not care what
   * the model thinks, only that the chain works, must be able to say so.
   */
  readonly model?: string;
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * Show each thread in Codex Desktop as it starts. Default ON.
   *
   * Defaulted rather than wired by each caller because "every turn is visible"
   * is a product requirement, and a requirement that depends on every call site
   * remembering to opt in is a requirement that will be false somewhere. Set
   * false only for runs nobody is watching.
   */
  readonly showInDesktop?: boolean;
  /** Also told the id, for a caller that wants to log or link it itself. */
  readonly onThread?: (threadId: string) => void;
}

export class CodexMcpTransport implements CodexTransport {
  private process: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingCall>();
  private readonly announced = new Set<string>();
  private buffer = "";
  private nextId = 1;

  constructor(private readonly options: CodexMcpTransportOptions) {}

  async runTurn(dispatch: TurnDispatch): Promise<TurnDelivery> {
    await this.start();
    // A thread is created by its first turn, so which tool to call is decided
    // by whether we already have one -- not by a separate "open" step.
    const result = await this.call(
      dispatch.threadId === null ? "codex" : "codex-reply",
      dispatch.threadId === null
        ? {
            prompt: dispatch.prompt,
            cwd: this.options.cwd,
            sandbox: this.options.sandbox ?? "read-only",
            ...(this.options.model ? { model: this.options.model } : {}),
            ...(this.options.reasoningEffort
              ? { config: { model_reasoning_effort: this.options.reasoningEffort } }
              : {}),
          }
        : { prompt: dispatch.prompt, threadId: dispatch.threadId },
    ) as ToolResult;

    if (result.isError) {
      throw new CodexUnavailableError(
        result.content?.[0]?.text ?? "codex reported an error with no text",
      );
    }
    const threadId = result.structuredContent?.threadId ?? dispatch.threadId;
    const text = result.structuredContent?.content
      ?? result.content?.map((part) => part.text ?? "").join("");
    if (typeof threadId !== "string" || typeof text !== "string") {
      // The contract moved. Say so by name rather than returning a half-read
      // answer that would fail much later as an unparsable turn result.
      throw new CodexUnavailableError(
        `unexpected tool result shape: ${JSON.stringify(result).slice(0, 200)}`,
      );
    }
    return { threadId, text };
  }

  close(): void {
    for (const call of this.pending.values()) {
      call.reject(new CodexUnavailableError("transport closed"));
    }
    this.pending.clear();
    this.process?.kill();
    this.process = null;
    this.ready = null;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command ?? "codex", ["mcp-server"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.process = child;

      child.stdout.on("data", (chunk: Buffer) => this.consume(chunk.toString()));
      child.on("error", (error) => {
        this.failAll(new CodexUnavailableError(error.message));
        reject(new CodexUnavailableError(error.message));
      });
      child.on("exit", (code) => {
        // Every waiting turn has to be told, or a worker holds a lease on work
        // whose far end is gone until the deadline expires.
        this.failAll(new CodexUnavailableError(`mcp-server exited (${code})`));
        this.process = null;
        this.ready = null;
      });

      this.call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stagepass", version: "0.1.0" },
      }, "initialize").then(() => resolve()).catch(reject);
    });
    return this.ready;
  }

  private consume(text: string): void {
    this.buffer += text;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: {
        id?: number;
        result?: unknown;
        error?: { message?: string };
        method?: string;
        params?: { _meta?: { threadId?: unknown } };
      };
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Not framing we own; ignore rather than crash the worker.
      }
      // Thread ids arrive on progress notifications while the turn is still
      // running, which is what makes opening the Desktop deep link mid-turn
      // possible rather than only after it finishes.
      //
      // Reported once per thread, not once per notification. A design turn
      // emits hundreds of deltas, and a callback that fired on each of them
      // drowned its caller in identical lines -- measured, not imagined.
      const streamed = message.params?._meta?.threadId;
      if (typeof streamed === "string" && !this.announced.has(streamed)) {
        this.announced.add(streamed);
        if (this.options.showInDesktop !== false) {
          openInDesktop(threadUrl(streamed));
        }
        this.options.onThread?.(streamed);
      }

      if (typeof message.id !== "number") continue;
      const call = this.pending.get(message.id);
      if (!call) continue;
      this.pending.delete(message.id);
      if (message.error) {
        call.reject(new CodexUnavailableError(message.error.message ?? "rpc error"));
      } else {
        call.resolve(message.result);
      }
    }
  }

  private call(
    method: string,
    params: unknown,
    rpcMethod?: string,
  ): Promise<unknown> {
    const id = this.nextId++;
    const payload = rpcMethod === "initialize"
      ? { jsonrpc: "2.0", id, method, params }
      : { jsonrpc: "2.0", id, method: "tools/call", params: { name: method, arguments: params } };
    return new Promise((resolve, reject) => {
      const child = this.process;
      if (!child) {
        reject(new CodexUnavailableError("mcp-server is not running"));
        return;
      }
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private failAll(error: Error): void {
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }
}
