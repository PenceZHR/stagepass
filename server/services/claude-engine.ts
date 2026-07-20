import { spawn } from "child_process";
import type { ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
import { createChildLogger } from "../logger";
import type {
  AiEngineAdapter,
  AiRunInput,
  AiRunItem,
  AiRunResult,
  AiStreamEvent,
} from "./ai-engine-types";
import { parseStructuredOutputText } from "./ai-structured-output-service";
import {
  processIdentityProbe,
  type ProcessIdentityProbe,
} from "./process-identity-service";
import { resolveAcceptanceInjection } from "./acceptance-injection-service";

const log = createChildLogger("claude-sdk-engine");
const CLAUDE_FORCE_KILL_GRACE_MS = 50;
const DEFAULT_CLAUDE_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

class ProviderIdentityCaptureError extends Error {
  readonly code = "provider_identity_capture_failed";

  constructor(pid: number | null, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`provider_identity_capture_failed: Claude process ${pid ?? "unknown"} identity capture failed: ${detail}`);
    this.name = "ProviderIdentityCaptureError";
  }
}

type ClaudeSpawn = typeof spawn;

let claudeSpawnForTest: ClaudeSpawn | null = null;
let claudeProcessIdentityProbeForTest: ProcessIdentityProbe | null = null;
let claudeStreamHeartbeatIntervalForTest: number | null = null;

export function setClaudeSpawnForTest(spawnImpl: ClaudeSpawn | null): () => void {
  const previous = claudeSpawnForTest;
  claudeSpawnForTest = spawnImpl;
  return () => {
    claudeSpawnForTest = previous;
  };
}

export function setClaudeProcessIdentityProbeForTest(
  probe: ProcessIdentityProbe | null,
): () => void {
  const previous = claudeProcessIdentityProbeForTest;
  claudeProcessIdentityProbeForTest = probe;
  return () => {
    claudeProcessIdentityProbeForTest = previous;
  };
}

export function setClaudeStreamHeartbeatIntervalForTest(
  intervalMs: number | null,
): () => void {
  if (intervalMs !== null && (!Number.isFinite(intervalMs) || intervalMs <= 0)) {
    throw new RangeError("Claude stream heartbeat interval must be a positive number");
  }
  const previous = claudeStreamHeartbeatIntervalForTest;
  claudeStreamHeartbeatIntervalForTest = intervalMs;
  return () => {
    claudeStreamHeartbeatIntervalForTest = previous;
  };
}

function getClaudeSpawn(): ClaudeSpawn {
  return claudeSpawnForTest ?? spawn;
}

function getClaudeProcessIdentityProbe(): ProcessIdentityProbe {
  return claudeProcessIdentityProbeForTest ?? processIdentityProbe;
}

function getClaudeStreamHeartbeatIntervalMs(): number {
  return claudeStreamHeartbeatIntervalForTest ?? DEFAULT_CLAUDE_STREAM_HEARTBEAT_INTERVAL_MS;
}

function getClaudeBin(): string {
  const acceptanceTransport = resolveAcceptanceInjection()?.claudeTransportBin;
  if (acceptanceTransport) return acceptanceTransport;
  return path.join(
    process.cwd(),
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe"
  );
}

interface AgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
}

interface ClaudeMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  isApiErrorMessage?: boolean;
  apiErrorStatus?: number;
  error?: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
    }>;
  };
  result?: string;
}

function getAgentsForPhase(phase: string): Record<string, AgentDefinition> | undefined {
  switch (phase) {
    case "implement":
      return {
        reviewer: {
          description: "Independent code reviewer that checks implementation quality",
          prompt: "You are a code reviewer. After the main implementation is done, review the changed files for bugs, security issues, and logic errors. Report findings concisely.",
          tools: ["Read", "Glob", "Grep"],
        },
      };
    case "fix":
      return {
        verifier: {
          description: "Verifies that fixes actually resolve the reported findings",
          prompt: "You verify fixes. Read the finding description and the changed code. Confirm whether the fix actually addresses the issue.",
          tools: ["Read", "Glob", "Grep"],
        },
      };
    case "plan":
      return undefined;
    default:
      return undefined;
  }
}

function buildAllowedTools(sandboxMode?: string, phase?: string): string[] {
  if (sandboxMode === "read-only") {
    return ["Read", "Grep", "Glob", "LS"];
  }
  const base = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];
  if (phase === "implement" || phase === "fix") {
    base.push("Agent");
  }
  return base;
}

function runClaudeSdk(
  prompt: string,
  cwd: string,
  options: {
    allowedTools: string[];
    agents?: Record<string, AgentDefinition>;
    sessionId?: string;
    outputSchema?: unknown;
    timeoutMs?: number;
    lifecycle?: AiRunInput["lifecycle"];
  }
): Promise<{
  messages: ClaudeMessage[];
  sessionId: string;
  result: string;
  providerPid: number | null;
  exitCode: number | null;
  signal: string | null;
}> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let proc: ChildProcessWithoutNullStreams | null = null;
    let timeoutError: Error | null = null;
    let startupComplete = !options.lifecycle;
    let startupPromise: Promise<void> = Promise.resolve();
    let pendingHeartbeat = false;
    let processClosed = false;
    let lifecycleTerminationStarted = false;
    let lifecycleChain: Promise<void> = Promise.resolve();
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];

    if (options.sessionId) {
      args.push("--resume", options.sessionId);
    }

    if (options.agents && Object.keys(options.agents).length > 0) {
      args.push("--agents", JSON.stringify(options.agents));
    }

    for (const tool of options.allowedTools) {
      args.push("--allowedTools", tool);
    }

    if (options.outputSchema) {
      args.push("--append-system-prompt",
        `You MUST respond with valid JSON matching this schema:\n${JSON.stringify(options.outputSchema)}`
      );
    }

    const bin = getClaudeBin();
    log.info({ cwd, phase: "sdk", agentCount: Object.keys(options.agents ?? {}).length }, "Starting Claude SDK");

    let buffer = "";
    const messages: ClaudeMessage[] = [];
    let sessionId = "";
    let resultText = "";
    let stderr = "";

    const stopHeartbeatInterval = () => {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    };

    const cleanup = () => {
      stopHeartbeatInterval();
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      proc?.stdout.off("data", onStdoutData);
      proc?.stderr.off("data", onStderrData);
      proc?.off("close", onClose);
      proc?.off("error", onError);
    };

    const resolveOnce = (value: Parameters<typeof resolve>[0]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const rejectOnce = (
      error: Error,
      metadata: {
        providerPid?: number | null;
        exitCode?: number | null;
        signal?: string | null;
      } = {},
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      Object.assign(error, {
        sessionId: sessionId || options.sessionId || null,
        providerPid: metadata.providerPid ?? proc?.pid ?? null,
        exitCode: metadata.exitCode ?? null,
        signal: metadata.signal ?? null,
      });
      reject(error);
    };
    const terminateForLifecycleFailure = () => {
      if (lifecycleTerminationStarted || processClosed || settled) return;
      lifecycleTerminationStarted = true;
      stopHeartbeatInterval();
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      try {
        proc?.kill("SIGTERM");
      } catch {}
      forceKillTimeout = setTimeout(() => {
        if (processClosed || settled) return;
        try {
          proc?.kill("SIGKILL");
        } catch {}
      }, CLAUDE_FORCE_KILL_GRACE_MS);
    };
    const heartbeat = () => {
      if (!startupComplete) {
        pendingHeartbeat = true;
        return;
      }
      lifecycleChain = lifecycleChain.then(async () => {
        await options.lifecycle?.onHeartbeat({
            provider: "claude",
            pid: proc?.pid ?? null,
            externalRef: sessionId || options.sessionId || null,
            observedAt: new Date().toISOString(),
          });
      });
      void lifecycleChain.catch(() => {
        terminateForLifecycleFailure();
      });
    };
    const parseBufferedLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const msg: ClaudeMessage = JSON.parse(line);
        messages.push(msg);

        if (msg.session_id) {
          sessionId = msg.session_id;
        }
        if (msg.type === "result" && msg.result) {
          resultText = msg.result;
        }
      } catch {}
    };

    function onStdoutData(chunk: Buffer) {
      heartbeat();
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        parseBufferedLine(line);
      }
    }

    function onStderrData(chunk: Buffer) {
      heartbeat();
      stderr += chunk.toString();
    }

    async function onClose(code: number | null, signal: NodeJS.Signals | null) {
      processClosed = true;
      stopHeartbeatInterval();
      try {
        await startupPromise;
        await lifecycleChain;
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)), {
          providerPid: proc?.pid ?? null,
          exitCode: code,
          signal,
        });
        return;
      }
      if (settled) return;

      // Process remaining buffer before timeout/error metadata captures sessionId.
      if (buffer.trim()) {
        parseBufferedLine(buffer);
        buffer = "";
      }

      if (timeoutError) {
        rejectOnce(timeoutError, {
          providerPid: proc?.pid ?? null,
          exitCode: code,
          signal,
        });
        return;
      }

      if (code !== 0 && !resultText) {
        log.warn({ code, stderr: stderr.slice(-500) }, "Claude SDK exited with error");
        const error = new Error(`Claude SDK exited with code ${code}: ${stderr.slice(-200)}`);
        rejectOnce(error, {
          providerPid: proc?.pid ?? null,
          exitCode: code,
          signal,
        });
        return;
      }

      if (!resultText) {
        const lastAssistant = [...messages].reverse().find(
          (m) => m.type === "assistant" && m.message?.content
        );
        if (lastAssistant?.message?.content) {
          resultText = lastAssistant.message.content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text)
            .join("\n");
        }
      }

      resolveOnce({
        messages,
        sessionId,
        result: resultText,
        providerPid: proc?.pid ?? null,
        exitCode: code,
        signal,
      });
    }

    function onError(err: Error) {
      rejectOnce(new Error(`Failed to spawn Claude SDK: ${err.message}`));
    }

    try {
      proc = getClaudeSpawn()(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      proc.stdout.on("data", onStdoutData);
      proc.stderr.on("data", onStderrData);
      proc.once("close", onClose);
      proc.once("error", onError);
      startupPromise = (async () => {
        if (options.lifecycle) {
          const providerPid = proc?.pid ?? null;
          try {
            if (providerPid === null) {
              throw new Error("spawned process did not expose a pid");
            }
            const identity = await getClaudeProcessIdentityProbe().capture(providerPid, {
              ppid: process.pid,
              cwd,
            });
            await options.lifecycle.onProcessStarted({
              provider: "claude",
              pid: providerPid,
              ppid: process.pid,
              externalRef: options.sessionId ?? null,
              identity,
              startedAt: new Date().toISOString(),
            });
          } catch (error) {
            const identityError = error instanceof ProviderIdentityCaptureError
              ? error
              : new ProviderIdentityCaptureError(providerPid, error);
            try {
              proc?.kill("SIGTERM");
            } catch {}
            forceKillTimeout = setTimeout(() => {
              if (processClosed || settled) return;
              try {
                proc?.kill("SIGKILL");
              } catch {}
              rejectOnce(identityError);
            }, CLAUDE_FORCE_KILL_GRACE_MS);
            throw identityError;
          }
        }

        startupComplete = true;
        if (pendingHeartbeat) {
          pendingHeartbeat = false;
          heartbeat();
        }
        if (processClosed || settled) return;

        if (options.lifecycle) {
          heartbeatInterval = setInterval(
            heartbeat,
            getClaudeStreamHeartbeatIntervalMs(),
          );
          heartbeatInterval.unref();
        }

        if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
          timeout = setTimeout(() => {
            const message = `provider_timeout: Claude SDK timed out after ${options.timeoutMs}ms`;
            timeoutError = new Error(message);
            log.warn({ timeoutMs: options.timeoutMs }, "Claude SDK timed out");
            try {
              proc?.kill("SIGTERM");
            } catch {}
            forceKillTimeout = setTimeout(() => {
              log.warn(
                { timeoutMs: options.timeoutMs, graceMs: CLAUDE_FORCE_KILL_GRACE_MS },
                "Claude SDK did not exit after SIGTERM; sending SIGKILL",
              );
              try {
                proc?.kill("SIGKILL");
              } catch {}
              rejectOnce(timeoutError ?? new Error(message));
            }, CLAUDE_FORCE_KILL_GRACE_MS);
          }, options.timeoutMs);
        }

        proc?.stdin.write(prompt);
        proc?.stdin.end();
      })();
      void startupPromise.catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rejectOnce(new Error(`Failed to spawn Claude SDK: ${message}`));
    }
  });
}

function extractChangedFiles(messages: ClaudeMessage[]): string[] {
  const files = new Set<string>();
  for (const msg of messages) {
    if (msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.name === "Edit" || block.name === "Write") {
          const filePath = block.input?.file_path as string | undefined;
          if (filePath) files.add(filePath);
        }
      }
    }
  }
  return Array.from(files);
}

function claudeMessagesToRunItems(messages: ClaudeMessage[]): AiRunItem[] {
  const items: AiRunItem[] = [];
  for (const msg of messages) {
    if (!msg.message?.content) continue;
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text) {
        items.push({
          type: "agent_message",
          text: block.text,
        });
        continue;
      }

      if (block.name === "Bash") {
        const command = typeof block.input?.command === "string"
          ? block.input.command
          : undefined;
        items.push({
          type: "command_execution",
          command,
        });
        continue;
      }

      if (block.name === "Edit" || block.name === "Write") {
        const filePath = typeof block.input?.file_path === "string"
          ? block.input.file_path
          : undefined;
        if (filePath) {
          items.push({
            type: "file_change",
            changes: [{ path: filePath }],
          });
        }
      }
    }
  }
  return items;
}

let runCounter = 0;

function isTimeoutMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("provider_timeout") || normalized.includes("timed out");
}

function isProviderApiErrorResult(result: string, messages: ClaudeMessage[]): boolean {
  if (/^\s*api error:/i.test(result)) return true;
  return messages.some((message) => message.isApiErrorMessage === true || typeof message.apiErrorStatus === "number");
}

/**
 * HTTP statuses that mean the request never got a usable answer out of the
 * service -- overload, rate limiting, gateway and connect failures. 4xx codes
 * that describe the ACCOUNT rather than the transport (401, 402 Insufficient
 * Balance, 403) are deliberately absent: reporting those as a transport fault
 * would send the user to check their network when the fix is their billing.
 */
const CLAUDE_TRANSPORT_ERROR_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

/** Connect-level failures the CLI reports as prose rather than a status. */
const CLAUDE_TRANSPORT_ERROR_MARKERS = [
  "unable to connect",
  "connectionrefused",
  "connection refused",
] as const;

/**
 * Recover the numeric HTTP status behind a claude API error. The CLI reports it
 * as a real field on the message (`apiErrorStatus`) when it can, but falls back
 * to prose; real-world messages interleave localized text around the number, so
 * only the digits are matched -- never the surrounding words.
 *   "API Error: 529 ..."  /  "API Error: Request rejected (429) ..."
 */
function claudeApiErrorStatus(result: string, messages: ClaudeMessage[]): number | null {
  for (const message of messages) {
    if (typeof message.apiErrorStatus === "number") return message.apiErrorStatus;
  }
  const labelled = /\bapi error:\s*(\d{3})\b/i.exec(result);
  if (labelled) return Number(labelled[1]);
  const parenthesised = /\((\d{3})\)/.exec(result);
  return parenthesised ? Number(parenthesised[1]) : null;
}

/**
 * Split a claude API error into "the transport broke" vs "the run failed". The
 * status used to be checked only for EXISTENCE and then thrown away, so a 529
 * overload and a malformed-request rejection both surfaced as
 * provider_run_failed and neither told the user whether retrying would help.
 */
function classifyClaudeApiError(
  result: string,
  messages: ClaudeMessage[],
): { providerErrorCode: string; apiErrorStatus: number | null } {
  const apiErrorStatus = claudeApiErrorStatus(result, messages);
  const normalized = result.toLowerCase();
  const isTransport =
    (apiErrorStatus !== null && CLAUDE_TRANSPORT_ERROR_STATUSES.has(apiErrorStatus))
    || CLAUDE_TRANSPORT_ERROR_MARKERS.some((marker) => normalized.includes(marker));
  return {
    providerErrorCode: isTransport ? "provider_transport_error" : "provider_run_failed",
    apiErrorStatus,
  };
}

export class ClaudeSdkEngine implements AiEngineAdapter {
  async run(input: AiRunInput): Promise<AiRunResult> {
    const allowedTools = buildAllowedTools(input.sandboxMode, input.phase);
    const agents = getAgentsForPhase(input.phase);
    const schemaDelivery = input.outputSchema ? "schema_prompt" : "none";
    const schemaCapabilityInvoked = Boolean(input.outputSchema);

    const sdkResult = await runClaudeSdk(
      input.prompt,
      input.repoPath,
      {
        allowedTools,
        agents,
        sessionId: input.threadId,
        outputSchema: input.outputSchema,
        timeoutMs: input.timeoutMs,
        lifecycle: input.lifecycle,
      }
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const metadata = err && typeof err === "object"
        ? err as {
          sessionId?: string | null;
          providerPid?: number | null;
          exitCode?: number | null;
          signal?: string | null;
          code?: string;
          }
        : {};
      runCounter++;
      return {
        messages: [],
        sessionId: metadata.sessionId || input.threadId || "unknown",
        result: `Claude SDK run failed: ${message}`,
        terminalSummary: message,
        failedRunId: `RUN-${String(runCounter).padStart(3, "0")}`,
        providerPid: metadata.providerPid ?? null,
        exitCode: metadata.exitCode ?? null,
        signal: metadata.signal ?? null,
        providerErrorCode: metadata.code ?? null,
      };
    });

    if ("failedRunId" in sdkResult) {
      const runResult: AiRunResult = {
        threadId: sdkResult.sessionId || input.threadId || "unknown",
        runId: sdkResult.failedRunId,
        summary: sdkResult.result,
        success: false,
        changedFiles: [],
        structuredOutput: undefined,
        structuredOutputSource: "none",
        schemaDelivery,
        schemaCapabilityInvoked,
        providerErrorCode: sdkResult.providerErrorCode
          ?? (isTimeoutMessage(sdkResult.result) ? "provider_timeout" : "provider_run_failed"),
        exitCode: sdkResult.exitCode,
        signal: sdkResult.signal,
        items: [],
      };
      await input.lifecycle?.onTerminal({
        provider: "claude",
        pid: sdkResult.providerPid,
        exitCode: sdkResult.exitCode,
        signal: sdkResult.signal,
        status: "failed",
        summary: sdkResult.terminalSummary,
        endedAt: new Date().toISOString(),
      });
      return runResult;
    }

    const { messages, sessionId, result } = sdkResult;
    const changedFiles = extractChangedFiles(messages);
    const parsedOutput = input.outputSchema ? parseStructuredOutputText(result) : {};
    const structuredOutput = parsedOutput.value;
    const structuredOutputSource = parsedOutput.source ? "text_extracted" : "none";

    runCounter++;
    const runId = `RUN-${String(runCounter).padStart(3, "0")}`;

    log.info(
      { changeId: input.changeId, changedFiles: changedFiles.length, hasAgents: !!agents },
      "Claude SDK run completed"
    );

    if (isProviderApiErrorResult(result, messages)) {
      const { providerErrorCode, apiErrorStatus } = classifyClaudeApiError(result, messages);
      const runResult: AiRunResult = {
        threadId: sessionId || input.threadId || "unknown",
        runId,
        summary: result,
        success: false,
        changedFiles: [],
        structuredOutput: undefined,
        structuredOutputSource: "none",
        schemaDelivery,
        schemaCapabilityInvoked,
        providerErrorCode,
        providerErrorDetail: apiErrorStatus === null ? result : `HTTP ${apiErrorStatus}: ${result}`,
        exitCode: sdkResult.exitCode,
        signal: sdkResult.signal,
        rawProviderResult: sdkResult,
        items: claudeMessagesToRunItems(messages),
      };
      await input.lifecycle?.onTerminal({
        provider: "claude",
        pid: sdkResult.providerPid,
        exitCode: sdkResult.exitCode,
        signal: sdkResult.signal,
        status: "failed",
        summary: runResult.summary,
        endedAt: new Date().toISOString(),
      });
      return runResult;
    }

    const runResult: AiRunResult = {
      threadId: sessionId || input.threadId || "unknown",
      runId,
      summary: result,
      success: true,
      changedFiles,
      structuredOutput,
      structuredOutputSource,
      schemaDelivery,
      schemaCapabilityInvoked,
      exitCode: sdkResult.exitCode,
      signal: sdkResult.signal,
      rawProviderResult: sdkResult,
      items: claudeMessagesToRunItems(messages),
    };
    await input.lifecycle?.onTerminal({
      provider: "claude",
      pid: sdkResult.providerPid,
      exitCode: sdkResult.exitCode,
      signal: sdkResult.signal,
      status: "completed",
      summary: runResult.summary || "Claude SDK run completed",
      endedAt: new Date().toISOString(),
    });
    return runResult;
  }

  runStreamed(input: AiRunInput): AsyncGenerator<AiStreamEvent> {
    const allowedTools = buildAllowedTools(input.sandboxMode, input.phase);
    const agents = getAgentsForPhase(input.phase);

    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];

    if (input.threadId) {
      args.push("--resume", input.threadId);
    }

    if (agents && Object.keys(agents).length > 0) {
      args.push("--agents", JSON.stringify(agents));
    }

    for (const tool of allowedTools) {
      args.push("--allowedTools", tool);
    }

    const proc = getClaudeSpawn()(getClaudeBin(), args, {
      cwd: input.repoPath,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const queue: AiStreamEvent[] = [];
    const pendingStartupEvents: AiStreamEvent[] = [];
    const waiters: Array<{
      resolve: (value: IteratorResult<AiStreamEvent>) => void;
      reject: (reason?: unknown) => void;
    }> = [];
    let timeoutError: Error | null = null;
    let streamError: Error | null = null;
    let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let exited = false;
    let done = false;
    let returnedEarly = false;
    let terminationStarted = false;
    let terminalPromise: Promise<void> | null = null;
    let returnPromise: Promise<IteratorResult<AiStreamEvent>> | null = null;
    let throwPromise: Promise<IteratorResult<AiStreamEvent>> | null = null;
    let resolveTerminationCompletion!: (result: { terminalError: Error | null }) => void;
    const terminationCompletion = new Promise<{ terminalError: Error | null }>((resolve) => {
      resolveTerminationCompletion = resolve;
    });
    let terminationCompleted = false;
    let startupComplete = !input.lifecycle;
    let pendingHeartbeat = false;
    let startupPromise: Promise<void> = Promise.resolve();
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let heartbeatStopped = true;
    let heartbeatInFlight = false;
    let heartbeatIdle: Promise<void> = Promise.resolve();
    let buffer = "";
    let stderrTail = "";
    let providerApiErrorText: string | null = null;
    const clearForceKillTimeout = () => {
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
    };
    const clearMainTimeout = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };
    const clearStreamHeartbeat = () => {
      heartbeatStopped = true;
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    };
    const stopStreamHeartbeat = async () => {
      clearStreamHeartbeat();
      await heartbeatIdle;
    };
    const removeProcessListeners = () => {
      proc.stdout.off("data", onStdoutData);
      proc.stderr.off("data", onStderrData);
      proc.off("error", onError);
    };
    const cleanupAfterClose = () => {
      clearMainTimeout();
      clearForceKillTimeout();
      clearStreamHeartbeat();
      removeProcessListeners();
      proc.off("close", onClose);
    };
    const settleWaiters = () => {
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        if (!waiter) continue;
        if (queue.length > 0) {
          waiter.resolve({ done: false, value: queue.shift() as AiStreamEvent });
          continue;
        }
        if (streamError) {
          waiter.reject(streamError);
          continue;
        }
        if (done) {
          waiter.resolve({ done: true, value: undefined });
          continue;
        }
        waiters.unshift(waiter);
        break;
      }
    };
    const finish = (error?: Error | null) => {
      if (done && !returnedEarly) return;
      if (!returnedEarly) {
        streamError = error ?? null;
      }
      done = true;
      cleanupAfterClose();
      settleWaiters();
    };
    const completeTermination = (terminalError: Error | null) => {
      if (terminationCompleted) return;
      terminationCompleted = true;
      resolveTerminationCompletion({ terminalError });
    };
    const terminateStreamProcess = (message: string) => {
      clearStreamHeartbeat();
      clearMainTimeout();
      if (exited || terminationStarted) return;
      terminationStarted = true;
      log.warn({ message }, "Terminating Claude SDK stream");
      try {
        proc.kill("SIGTERM");
      } catch {}
      if (!forceKillTimeout) {
        forceKillTimeout = setTimeout(() => {
          if (exited) return;
          log.warn(
            { graceMs: CLAUDE_FORCE_KILL_GRACE_MS },
            "Claude SDK stream did not exit after SIGTERM; sending SIGKILL",
          );
          try {
            proc.kill("SIGKILL");
          } catch {}
        }, CLAUDE_FORCE_KILL_GRACE_MS);
      }
    };
    const failFromLifecycle = (error: unknown) => {
      const lifecycleError = error instanceof Error ? error : new Error(String(error));
      streamError = lifecycleError;
      terminateStreamProcess(lifecycleError.message);
      settleWaiters();
    };
    const emitTerminal = async (
      event: Parameters<NonNullable<AiRunInput["lifecycle"]>["onTerminal"]>[0],
    ): Promise<void> => {
      terminalPromise ??= Promise.resolve().then(() => input.lifecycle?.onTerminal(event));
      await terminalPromise;
    };
    const onError = (err: Error) => {
      if (returnedEarly) {
        terminateStreamProcess(err.message);
        return;
      }
      streamError = new Error(`Failed to spawn Claude SDK: ${err.message}`);
      terminateStreamProcess(streamError.message);
      void stopStreamHeartbeat()
        .then(() => emitTerminal({
          provider: "claude",
          pid: proc.pid ?? null,
          status: "failed",
          summary: streamError?.message ?? "Claude SDK stream failed",
          endedAt: new Date().toISOString(),
        }))
        .then(() => {
          if (returnedEarly) return;
          finish(streamError);
          completeTermination(null);
        })
        .catch((error: unknown) => {
          if (returnedEarly) return;
          const terminalError = error instanceof Error ? error : new Error(String(error));
          finish(terminalError);
          completeTermination(terminalError);
        });
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true;
      clearStreamHeartbeat();
      if (!returnedEarly && !timeoutError && !streamError) {
        if (providerApiErrorText) {
          streamError = new Error(`provider_run_failed: ${providerApiErrorText}`);
        } else if (code !== 0) {
          const detail = stderrTail.trim();
          streamError = new Error(
            `provider_run_failed: Claude SDK stream exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`,
          );
        }
      }
      void startupPromise
        .catch(() => undefined)
        .then(() => stopStreamHeartbeat())
        .then(() => emitTerminal({
            provider: "claude",
            pid: proc.pid ?? null,
            exitCode: code,
            signal,
            status: returnedEarly || timeoutError ? "stopped" : streamError ? "failed" : "completed",
            summary: timeoutError?.message ?? streamError?.message ?? "Claude SDK stream completed",
            endedAt: new Date().toISOString(),
          }))
        .then(() => {
          finish(returnedEarly ? null : timeoutError ?? streamError);
          completeTermination(null);
        })
        .catch((error: unknown) => {
          const terminalError = error instanceof Error ? error : new Error(String(error));
          finish(terminalError);
          completeTermination(terminalError);
        });
    };
    const pushEvent = (event: AiStreamEvent) => {
      if (done) return;
      if (!startupComplete) {
        pendingStartupEvents.push(event);
        return;
      }
      queue.push(event);
      settleWaiters();
    };
    let streamSessionId = "";
    const streamHeartbeat = () => {
      if (!startupComplete) {
        pendingHeartbeat = true;
        return;
      }
      if (!input.lifecycle || heartbeatStopped || heartbeatInFlight || done || exited) return;

      const heartbeatEvent = {
        provider: "claude" as const,
        pid: proc.pid ?? null,
        externalRef: streamSessionId || input.threadId || null,
        observedAt: new Date().toISOString(),
      };
      heartbeatInFlight = true;
      heartbeatIdle = Promise.resolve()
        .then(() => input.lifecycle?.onHeartbeat(heartbeatEvent))
        .catch(failFromLifecycle)
        .finally(() => {
          heartbeatInFlight = false;
        });
    };
    const startStreamHeartbeat = () => {
      if (!input.lifecycle || done || exited || streamError || heartbeatInterval) return;
      heartbeatStopped = false;
      heartbeatInterval = setInterval(
        streamHeartbeat,
        getClaudeStreamHeartbeatIntervalMs(),
      );
      heartbeatInterval.unref();
    };
    function onStdoutData(chunk: Buffer) {
      streamHeartbeat();
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: ClaudeMessage = JSON.parse(line);
          if (msg.session_id && msg.session_id !== streamSessionId) {
            streamSessionId = msg.session_id;
            pushEvent({
              type: "thread.started",
              threadId: msg.session_id,
            });
          }
          if (msg.type === "assistant" && msg.message?.content) {
            const apiErrorText = msg.message.content
              .find((block) => block.type === "text" && block.text)
              ?.text;
            if (
              msg.isApiErrorMessage === true
              || typeof msg.apiErrorStatus === "number"
              || (apiErrorText && /^\s*API Error:/i.test(apiErrorText))
            ) {
              providerApiErrorText = apiErrorText ?? msg.error ?? "Claude provider API error";
            }
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                pushEvent({
                  type: "item.completed",
                  item: {
                    type: "agent_message",
                    text: block.text,
                  },
                });
              }
            }
          }
        } catch {}
      }
    }
    function onStderrData(chunk: Buffer) {
      streamHeartbeat();
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2000);
    };
    proc.once("close", onClose);
    proc.once("error", onError);
    proc.stdout.on("data", onStdoutData);
    proc.stderr.on("data", onStderrData);
    startupPromise = (async () => {
      if (input.lifecycle) {
        const providerPid = proc.pid ?? null;
        let identity;
        try {
          if (providerPid === null) {
            throw new Error("spawned process did not expose a pid");
          }
          identity = await getClaudeProcessIdentityProbe().capture(providerPid, {
            ppid: process.pid,
            cwd: input.repoPath,
          });
        } catch (error) {
          throw new ProviderIdentityCaptureError(providerPid, error);
        }
        if (done || streamError) return;
        await input.lifecycle.onProcessStarted({
          provider: "claude",
          pid: providerPid,
          ppid: process.pid,
          externalRef: input.threadId ?? null,
          identity,
          startedAt: new Date().toISOString(),
        });
      }

      startupComplete = true;
      if (done || exited || streamError) return;
      startStreamHeartbeat();
      if (pendingStartupEvents.length > 0) {
        queue.push(...pendingStartupEvents.splice(0));
        settleWaiters();
      }
      if (pendingHeartbeat) {
        pendingHeartbeat = false;
        streamHeartbeat();
      }

      timeout = typeof input.timeoutMs === "number" && input.timeoutMs > 0
        ? setTimeout(() => {
            timeoutError = new Error(`provider_timeout: Claude SDK timed out after ${input.timeoutMs}ms`);
            log.warn({ timeoutMs: input.timeoutMs }, "Claude SDK stream timed out");
            terminateStreamProcess(timeoutError.message);
          }, input.timeoutMs)
        : null;
      proc.stdin.write(input.prompt);
      proc.stdin.end();
    })();
    void startupPromise.catch(async (error: unknown) => {
      const startupError = error instanceof Error ? error : new Error(String(error));
      if (!returnedEarly) streamError = startupError;
      terminateStreamProcess(startupError.message);
      if (returnedEarly) return;
      try {
        await stopStreamHeartbeat();
        await emitTerminal({
          provider: "claude",
          pid: proc.pid ?? null,
          status: "failed",
          summary: startupError.message,
          endedAt: new Date().toISOString(),
        });
        finish(startupError);
        completeTermination(null);
      } catch (terminalError) {
        const persistenceError = terminalError instanceof Error
          ? terminalError
          : new Error(String(terminalError));
        finish(persistenceError);
        completeTermination(persistenceError);
      }
    });

    const stopConsumerDelivery = () => {
      returnedEarly = true;
      done = true;
      queue.length = 0;
      pendingStartupEvents.length = 0;
      clearStreamHeartbeat();
      clearMainTimeout();
      settleWaiters();
    };

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<AiStreamEvent>> {
        if (queue.length > 0) {
          return Promise.resolve({ done: false, value: queue.shift() as AiStreamEvent });
        }
        if (streamError) return Promise.reject(streamError);
        if (done) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => {
          waiters.push({ resolve, reject });
        });
      },
      return(value?: unknown): Promise<IteratorResult<AiStreamEvent>> {
        if (returnPromise) return returnPromise;
        stopConsumerDelivery();
        terminateStreamProcess("Claude SDK stream consumer stopped before completion");
        returnPromise = terminationCompletion.then(({ terminalError }) => {
          if (terminalError) throw terminalError;
          return { done: true, value: value as AiStreamEvent };
        });
        void returnPromise.catch(() => undefined);
        return returnPromise;
      },
      throw(error?: unknown): Promise<IteratorResult<AiStreamEvent>> {
        if (throwPromise) return throwPromise;
        const consumerError = error instanceof Error
          ? error
          : new Error(String(error ?? "Claude SDK stream aborted"));
        streamError = consumerError;
        stopConsumerDelivery();
        terminateStreamProcess(consumerError.message);
        throwPromise = terminationCompletion.then(() => {
          throw consumerError;
        });
        void throwPromise.catch(() => undefined);
        return throwPromise;
      },
      async [Symbol.asyncDispose](): Promise<void> {
        await this.return(undefined);
      },
    };
  }
}

let engineInstance: ClaudeSdkEngine | null = null;

export function getClaudeEngine(): AiEngineAdapter {
  if (!engineInstance) {
    engineInstance = new ClaudeSdkEngine();
  }
  return engineInstance;
}
