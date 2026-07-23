import fs from "node:fs";

import { createChildLogger } from "../logger";
import { parseStructuredOutputText } from "./ai-structured-output-service";
import {
  CodexAppServerClient,
  CodexAppServerError,
} from "./codex-app-server-client";
import {
  buildMultiAgentPrompt,
  cleanupAgentFiles,
  codexStderrTail,
  CodexRunFailure,
  ensureAgentFiles,
  extractChangedFiles,
  generateRunId,
  getCodexProcessIdentityProbe,
  hasCodexTransportEvidence,
  isTimeoutMessage,
  resolveCodexBin,
  sanitizeCodexErrorMessage,
  startCodexHeartbeat,
} from "./codex-cli-engine";
import type {
  AiEngineAdapter,
  AiRunInput,
  AiRunItem,
  AiRunResult,
  AiSandboxMode,
  AiStreamEvent,
} from "./ai-engine-types";

const log = createChildLogger("codex-app-server-engine");
const INTERRUPT_GRACE_MS = 100;
const CLOSE_GRACE_MS = 2_000;

interface ExitFacts {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface RawExecution {
  threadId: string;
  summary: string;
  items: AiRunItem[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

interface ExecutionControl {
  client: CodexAppServerClient | null;
  cancel: ((error: Error) => void) | null;
}

interface QueueWaiter<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: Error) => void;
}

class CodexStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexStoppedError";
  }
}

class AsyncEventQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<QueueWaiter<T>> = [];
  private ended = false;
  private failure: Error | null = null;

  push(value: T): void {
    if (this.ended || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  end(): void {
    if (this.ended || this.failure) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    if (this.ended || this.failure) return;
    this.failure = error;
    if (this.values.length === 0) {
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sandboxMode(input: AiRunInput): AiSandboxMode {
  return input.sandboxMode ?? "workspace-write";
}

function turnSandboxPolicy(
  mode: AiSandboxMode,
  repoPath: string,
): Record<string, unknown> {
  if (mode === "read-only") return { type: "readOnly" };
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  return {
    type: "workspaceWrite",
    writableRoots: [repoPath],
  };
}

function normalizeItem(value: unknown): AiRunItem {
  const item = asRecord(value);
  const typeMap: Record<string, string> = {
    agentMessage: "agent_message",
    commandExecution: "command_execution",
    fileChange: "file_change",
    mcpToolCall: "mcp_tool_call",
  };
  const type = asString(item.type) ?? "unknown";
  return {
    ...item,
    type: typeMap[type] ?? type,
  } as AiRunItem;
}

function itemId(params: Record<string, unknown>): string {
  return asString(params.itemId)
    ?? asString(asRecord(params.item).id)
    ?? "unknown";
}

function turnStatus(params: Record<string, unknown>): string | null {
  return asString(asRecord(params.turn).status);
}

function turnErrorMessage(params: Record<string, unknown>): string {
  const error = asRecord(asRecord(params.turn).error);
  return asString(error.message) ?? "codex turn failed";
}

function processCwd(repoPath: string): string {
  try {
    return fs.realpathSync(repoPath);
  } catch {
    return repoPath;
  }
}

function schemaFlags(input: AiRunInput): {
  schemaDelivery: "provider_native" | "none";
  schemaCapabilityInvoked: boolean;
} {
  return {
    schemaDelivery: input.outputSchema ? "provider_native" : "none",
    schemaCapabilityInvoked: Boolean(input.outputSchema),
  };
}

function failureWithFacts(
  error: unknown,
  facts: ExitFacts,
  stderrTail: string,
  timedOut: boolean,
): CodexRunFailure {
  const processFacts = {
    exitCode: facts.code,
    signal: facts.signal,
    stderrTail,
  };
  if (timedOut) {
    return new CodexRunFailure(
      `provider_timeout: codex app-server timed out`,
      { ...processFacts, providerErrorCode: "provider_timeout" },
    );
  }
  if (error instanceof CodexAppServerError && error.code === -32001) {
    return new CodexRunFailure(
      `provider_overloaded: ${error.message}`,
      { ...processFacts, providerErrorCode: "provider_overloaded" },
    );
  }
  if (error instanceof CodexRunFailure) {
    return new CodexRunFailure(error.message, {
      ...processFacts,
      providerErrorCode: error.providerErrorCode,
    });
  }
  const message = sanitizeCodexErrorMessage(error);
  return new CodexRunFailure(message, {
    ...processFacts,
    providerErrorCode: hasCodexTransportEvidence(`${message} ${stderrTail}`)
      ? "provider_transport_error"
      : isTimeoutMessage(message)
        ? "provider_timeout"
        : "provider_run_failed",
  });
}

function turnParams(
  input: AiRunInput,
  threadId: string,
  prompt: string,
): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: "text", text: prompt }],
    cwd: input.repoPath,
    approvalPolicy: "never",
    sandboxPolicy: turnSandboxPolicy(sandboxMode(input), input.repoPath),
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
  };
}

export class CodexAppServerEngine implements AiEngineAdapter {
  async run(input: AiRunInput): Promise<AiRunResult> {
    const flags = schemaFlags(input);
    try {
      const raw = await this.execute(input, () => {}, true, {
        client: null,
        cancel: null,
      });
      const parsed = input.outputSchema
        ? parseStructuredOutputText(raw.summary)
        : { value: undefined, source: null as string | null };
      return {
        threadId: raw.threadId,
        runId: generateRunId(),
        summary: raw.summary,
        success: true,
        changedFiles: extractChangedFiles(raw.items),
        structuredOutput: parsed.value,
        structuredOutputSource: parsed.source ? "text_extracted" : "none",
        ...flags,
        exitCode: raw.exitCode,
        signal: raw.signal,
        stderrTail: raw.stderrTail,
        items: raw.items,
      };
    } catch (error) {
      const failure = error instanceof CodexRunFailure ? error : null;
      const message = sanitizeCodexErrorMessage(error);
      return {
        threadId: input.threadId ?? "unknown",
        runId: generateRunId(),
        summary: `Codex run failed: ${message}`,
        success: false,
        changedFiles: [],
        structuredOutputSource: "none",
        ...flags,
        providerErrorCode: failure?.providerErrorCode
          ?? (isTimeoutMessage(message) ? "provider_timeout" : "provider_run_failed"),
        providerErrorDetail: message,
        exitCode: failure?.exitCode ?? null,
        signal: failure?.signal ?? null,
        stderrTail: failure?.stderrTail,
        items: [],
      };
    }
  }

  async *runStreamed(input: AiRunInput): AsyncGenerator<AiStreamEvent> {
    const queue = new AsyncEventQueue<AiStreamEvent>();
    const control: ExecutionControl = { client: null, cancel: null };
    let settled = false;
    const execution = this.execute(input, (event) => queue.push(event), false, control)
      .then(
        () => {
          settled = true;
          queue.end();
        },
        (error: unknown) => {
          settled = true;
          queue.fail(error instanceof Error ? error : new Error(String(error)));
        },
      );

    try {
      for await (const event of queue) yield event;
      await execution;
    } finally {
      if (!settled) {
        control.cancel?.(new Error("Codex stream stopped by consumer"));
        control.client?.kill("SIGTERM");
      }
    }
  }

  private async execute(
    input: AiRunInput,
    onEvent: (event: AiStreamEvent) => void,
    requireAssistantMessage: boolean,
    control: ExecutionControl,
  ): Promise<RawExecution> {
    const agentNames = ensureAgentFiles(input.repoPath, input.phase);
    const prompt = buildMultiAgentPrompt(input.prompt, agentNames, input.phase);
    const cwd = processCwd(input.repoPath);
    const itemText = new Map<string, string>();
    const commandOutput = new Map<string, string>();
    const reasoningText = new Map<string, string>();
    const completedItems: AiRunItem[] = [];
    let threadId = input.threadId ?? "";
    let turnId = "";
    let summary = "";
    let latestUsage: Record<string, unknown> | undefined;
    let threadEventEmitted = false;
    let turnSettled = false;
    let timedOut = false;
    let lifecycleFailure: Error | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let client: CodexAppServerClient | null = null;
    let exitFacts: ExitFacts = { code: null, signal: null };
    let stderr = "";
    let resolveTurn!: () => void;
    let rejectTurn!: (error: Error) => void;
    const turnCompleted = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    // Timeout/lifecycle cancellation can settle this while initialize or
    // thread/start is still pending. The execution path awaits it below; this
    // observer prevents Node from reporting that interim rejection as unhandled.
    void turnCompleted.catch(() => {});
    const settleTurn = (error?: Error) => {
      if (turnSettled) return;
      turnSettled = true;
      if (error) rejectTurn(error);
      else resolveTurn();
    };
    control.cancel = (error) => {
      settleTurn(new CodexStoppedError(error.message));
      client?.kill("SIGTERM");
    };

    let terminalEmitted = false;
    const emitTerminal = async (
      status: "completed" | "failed" | "stopped",
      terminalSummary: string,
    ): Promise<void> => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      await input.lifecycle?.onTerminal({
        provider: "codex",
        pid: null,
        exitCode: exitFacts.code,
        signal: exitFacts.signal,
        status,
        summary: terminalSummary,
        endedAt: new Date().toISOString(),
      });
    };

    const handleNotification = (
      method: string,
      params: Record<string, unknown>,
    ) => {
      try {
        if (method === "thread/started") {
          threadId = asString(asRecord(params.thread).id) ?? threadId;
          threadEventEmitted = true;
          onEvent({ type: "thread.started", threadId });
          return;
        }
        if (method === "turn/started") {
          turnId = asString(asRecord(params.turn).id) ?? turnId;
          onEvent({ type: "turn.started", ...params });
          return;
        }
        if (method === "item/started" || method === "item/completed") {
          const item = normalizeItem(params.item);
          if (method === "item/completed") {
            completedItems.push(item);
            if (item.type === "agent_message" && typeof item.text === "string") {
              summary = item.text;
            }
          }
          onEvent({
            type: method === "item/started" ? "item.started" : "item.completed",
            item,
          });
          return;
        }
        if (method === "item/agentMessage/delta") {
          const id = itemId(params);
          const text = `${itemText.get(id) ?? ""}${asString(params.delta) ?? ""}`;
          itemText.set(id, text);
          summary = text;
          onEvent({
            type: "item.updated",
            item: { id, type: "agent_message", text },
          });
          return;
        }
        if (method === "item/commandExecution/outputDelta") {
          const id = itemId(params);
          const aggregatedOutput =
            `${commandOutput.get(id) ?? ""}${asString(params.delta) ?? ""}`;
          commandOutput.set(id, aggregatedOutput);
          onEvent({
            type: "item.updated",
            item: { id, type: "command_execution", aggregatedOutput },
          });
          return;
        }
        if (method === "item/reasoning/summaryTextDelta") {
          const id = itemId(params);
          const text =
            `${reasoningText.get(id) ?? ""}${asString(params.delta) ?? ""}`;
          reasoningText.set(id, text);
          onEvent({
            type: "item.updated",
            item: { id, type: "reasoning", text },
          });
          return;
        }
        if (method === "thread/tokenUsage/updated") {
          latestUsage = asRecord(params.tokenUsage ?? params.usage);
          return;
        }
        if (method === "turn/diff/updated") {
          onEvent({ type: "turn.diff.updated", ...params });
          return;
        }
        if (method === "turn/completed") {
          onEvent({ type: "turn.completed", usage: latestUsage, ...params });
          const status = turnStatus(params);
          if (status === "failed") {
            settleTurn(new CodexRunFailure(turnErrorMessage(params), {
              providerErrorCode: "provider_run_failed",
            }));
          } else if (status === "interrupted") {
            settleTurn(
              timedOut
                ? new CodexRunFailure("codex turn interrupted after timeout", {
                  providerErrorCode: "provider_timeout",
                })
                : new CodexStoppedError("codex turn interrupted"),
            );
          } else if (status === "completed") {
            settleTurn();
          }
        }
      } catch (error) {
        settleTurn(error instanceof Error ? error : new Error(String(error)));
      }
    };

    try {
      client = CodexAppServerClient.spawn({
        bin: resolveCodexBin(),
        cwd,
        env: process.env,
        onNotification: handleNotification,
        onServerRequest: async (method) => {
          log.warn({ method }, "Declined codex app-server approval request");
          return { decision: "decline" };
        },
        onStderr: (chunk) => {
          stderr += chunk;
        },
      });
      control.client = client;
      const pid = client.pid;

      if (input.lifecycle) {
        if (pid === null) {
          client.kill("SIGKILL");
          throw new Error("spawned codex app-server did not expose a pid");
        }
        const identity = await getCodexProcessIdentityProbe().capture(pid, {
          ppid: process.pid,
          cwd,
        });
        await input.lifecycle.onProcessStarted({
          provider: "codex",
          pid,
          ppid: process.pid,
          externalRef: threadId || null,
          identity,
          startedAt: new Date().toISOString(),
        });
        heartbeat = startCodexHeartbeat({
          lifecycle: input.lifecycle,
          pid,
          externalRef: () => threadId || null,
          onLifecycleFailure: (error) => {
            lifecycleFailure ??= error;
            settleTurn(error);
            client?.kill("SIGTERM");
          },
        });
      }

      if (typeof input.timeoutMs === "number" && input.timeoutMs > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          settleTurn(new Error(`provider_timeout: ${input.timeoutMs}ms`));
          if (threadId && turnId) {
            void client?.request(
              "turn/interrupt",
              { threadId, turnId },
              INTERRUPT_GRACE_MS,
            ).catch(() => {}).finally(() => client?.kill("SIGTERM"));
          } else {
            client?.kill("SIGTERM");
          }
        }, input.timeoutMs);
        timeout.unref();
      }

      await client.initialize();
      const mode = sandboxMode(input);
      const mayResume = Boolean(input.threadId) && mode !== "workspace-write";
      const threadResult = asRecord(
        await client.request(
          mayResume ? "thread/resume" : "thread/start",
          mayResume
            ? {
              threadId: input.threadId,
              cwd: input.repoPath,
              sandbox: mode,
              approvalPolicy: "never",
            }
            : {
              cwd: input.repoPath,
              sandbox: mode,
              approvalPolicy: "never",
            },
        ),
      );
      threadId = asString(asRecord(threadResult.thread).id)
        ?? threadId
        ?? "unknown";
      if (!threadEventEmitted) {
        threadEventEmitted = true;
        onEvent({ type: "thread.started", threadId });
      }

      const turnResult = asRecord(
        await client.request("turn/start", turnParams(input, threadId, prompt)),
      );
      const responseTurn = asRecord(turnResult.turn);
      turnId = asString(responseTurn.id) ?? turnId;
      if (!turnSettled && responseTurn.status === "completed") settleTurn();
      if (!turnSettled && responseTurn.status === "failed") {
        settleTurn(new CodexRunFailure("codex turn failed", {
          providerErrorCode: "provider_run_failed",
        }));
      }
      await turnCompleted;
      if (lifecycleFailure) throw lifecycleFailure;
      if (timedOut) {
        throw new CodexRunFailure(
          `provider_timeout: codex app-server timed out after ${input.timeoutMs}ms`,
          { providerErrorCode: "provider_timeout" },
        );
      }
      if (requireAssistantMessage && !summary) {
        throw new CodexRunFailure("codex produced no assistant message", {
          providerErrorCode: "provider_empty_response",
        });
      }

      exitFacts = await client.close(CLOSE_GRACE_MS);
      if (exitFacts.signal) {
        throw new CodexRunFailure(
          `codex app-server was killed after turn completion: ${exitFacts.signal}`,
          {
            providerErrorCode: "provider_run_failed",
            exitCode: exitFacts.code,
            signal: exitFacts.signal,
            stderrTail: codexStderrTail(stderr),
          },
        );
      }
      await emitTerminal("completed", summary || "Codex stream completed");
      return {
        threadId: threadId || input.threadId || "unknown",
        summary,
        items: completedItems,
        exitCode: exitFacts.code,
        signal: exitFacts.signal,
        stderrTail: codexStderrTail(stderr),
      };
    } catch (error) {
      client?.kill("SIGTERM");
      if (client) {
        try {
          exitFacts = await client.close(INTERRUPT_GRACE_MS);
        } catch {
          // The classified error below retains the original cause.
        }
      }
      const failure = failureWithFacts(
        error,
        exitFacts,
        codexStderrTail(stderr),
        timedOut,
      );
      log.error(
        {
          changeId: input.changeId,
          phase: input.phase,
          err: failure.message,
          exitCode: failure.exitCode,
          signal: failure.signal,
        },
        "Codex app-server run failed",
      );
      await emitTerminal(
        error instanceof CodexStoppedError ? "stopped" : "failed",
        `Codex run failed: ${failure.message}`,
      );
      if (lifecycleFailure && error === lifecycleFailure) throw lifecycleFailure;
      throw failure;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      cleanupAgentFiles(input.repoPath);
      control.client = null;
      control.cancel = null;
    }
  }
}

let engineInstance: AiEngineAdapter | null = null;

export function getCodexAppServerEngine(): AiEngineAdapter {
  if (!engineInstance) engineInstance = new CodexAppServerEngine();
  return engineInstance;
}
