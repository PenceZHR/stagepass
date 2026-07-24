import { eq } from "drizzle-orm";

import { db } from "../db";
import { codexFollowerStartAttempts } from "../db/schema";
import { parseStructuredOutputText } from "./ai-structured-output-service";
import {
  attachCodexBindingRunAttempt,
  releaseCodexBindingRunLease,
  renewCodexBindingRunLease,
  waitForCodexBindingRunLease,
} from "./codex-binding-run-lease-service";
import type { CodexDesktopBridge } from "./codex-desktop-bridge";
import { createCodexDesktopBridge } from "./codex-desktop-bridge";
import type {
  CodexTurnObservation,
  CodexTurnSnapshot,
  NormalizedCodexTurnItem,
} from "./codex-desktop-bridge-types";
import {
  extractChangedFiles,
  sanitizeCodexErrorMessage,
} from "./codex-engine-shared";
import {
  readLogicalTurnForStart,
  productionCodexLogicalTurnPort,
} from "./codex-logical-turn-service";
import { createCodexDesktopRunContext } from "./codex-desktop-run-context";
import { createCodexFollowerStartAttemptPort } from "./codex-follower-start-attempt-service";
import { createCodexAppServerShellControl } from "./codex-app-server-shell-control";
import {
  defaultCodexDesktopDiscoveryDependencies,
  discoverCodexDesktopIpcEndpoint,
} from "./codex-desktop-ipc-discovery";
import { createObservedCodexDesktopFollowerTransport } from "./codex-desktop-ipc-transport";
import {
  readCodexTurnExecution,
  recordCodexTurnNotYetVisible,
  recordCodexTurnSnapshot,
  startCodexTurnExecution,
} from "./codex-turn-lifecycle-service";
import type {
  AiEngineAdapter,
  AiRunInput,
  AiRunItem,
  AiRunResult,
  AiStreamEvent,
} from "./ai-engine-types";

const ALLOWED_INPUT_KEYS = new Set(["logicalTurnId"]);

export class CodexDesktopEngineError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodexDesktopEngineError";
  }
}

function validateCallerInput(input: AiRunInput): string {
  const keys = Object.keys(input);
  const forbidden = keys.filter((key) => !ALLOWED_INPUT_KEYS.has(key));
  if (
    forbidden.length > 0
    || typeof input.logicalTurnId !== "string"
    || input.logicalTurnId.length === 0
  ) {
    throw new CodexDesktopEngineError(
      "caller_identity_override",
      forbidden.length > 0
        ? `Desktop engine forbids caller-controlled fields: ${forbidden.join(", ")}`
        : "Desktop engine requires only a Server-owned logicalTurnId",
    );
  }
  return input.logicalTurnId;
}

function toAiItem(item: NormalizedCodexTurnItem): AiRunItem {
  switch (item.kind) {
    case "agent_message":
      return { type: "agent_message", text: item.semantic.text, id: item.id };
    case "user_message":
      return { type: "user_message", text: item.semantic.text, id: item.id };
    case "command_execution":
      return {
        type: "command_execution",
        command: item.semantic.command,
        exitCode: item.semantic.exitCode ?? undefined,
        output: item.semantic.output,
        status: item.semantic.status,
        id: item.id,
      };
    case "file_change":
      return {
        type: "file_change",
        changes: [{ path: item.semantic.path, change: item.semantic.change }],
        id: item.id,
      };
    case "tool_call":
      return {
        type: "mcp_tool_call",
        name: item.semantic.name,
        status: item.semantic.status,
        result: item.semantic.result,
        id: item.id,
      };
    case "error":
      return {
        type: "error",
        code: item.semantic.code,
        text: item.semantic.message,
        id: item.id,
      };
  }
}

function summaryFrom(snapshot: CodexTurnSnapshot): string {
  if (snapshot.terminal?.output) return snapshot.terminal.output;
  return [...snapshot.items].reverse().find(
    (item) => item.kind === "agent_message",
  )?.semantic.text ?? "";
}

function streamEvents(observation: CodexTurnObservation): AiStreamEvent[] {
  const events: AiStreamEvent[] = [];
  for (const item of observation.snapshot.items) {
    events.push({ type: "item.completed", item: toAiItem(item) });
  }
  if (observation.snapshot.status !== "inProgress") {
    events.push({
      type: "turn.completed",
      status: observation.snapshot.status,
    });
  }
  return events;
}

export class CodexDesktopEngine implements AiEngineAdapter {
  constructor(
    private readonly bridge: CodexDesktopBridge,
    private readonly workerId = `desktop-engine:${process.pid}`,
  ) {}

  async run(input: AiRunInput): Promise<AiRunResult> {
    return this.execute(input);
  }

  async *runStreamed(input: AiRunInput): AsyncGenerator<AiStreamEvent> {
    const events: AiStreamEvent[] = [];
    let complete = false;
    let failure: unknown;
    let wake: (() => void) | null = null;
    const signal = () => {
      const pending = wake;
      wake = null;
      pending?.();
    };
    const execution = this.execute(input, (event) => {
      events.push(event);
      signal();
    }).then(
      () => {
        complete = true;
        signal();
      },
      (error: unknown) => {
        failure = error;
        complete = true;
        signal();
      },
    );
    while (!complete || events.length > 0) {
      if (events.length > 0) {
        yield events.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    await execution;
    if (failure) throw failure;
  }

  private async execute(
    input: AiRunInput,
    onEvent: (event: AiStreamEvent) => void = () => {},
  ): Promise<AiRunResult> {
    let logicalTurnId: string;
    try {
      logicalTurnId = validateCallerInput(input);
    } catch (error) {
      // Task 5 introduces the durable migration event writer. Until then this
      // fail-closed error deliberately occurs before every external call.
      throw error;
    }
    const logical = await readLogicalTurnForStart(logicalTurnId);
    if (logical.dispatchSurface !== "follower_ipc") {
      throw new CodexDesktopEngineError(
        "dispatch_surface_mismatch",
        "Logical turn is not assigned to follower IPC",
      );
    }
    let bindingLease = await waitForCodexBindingRunLease({
      logicalTurnId,
      workerId: logical.fence.workerId || this.workerId,
      ownerLeaseToken: logical.fence.leaseToken,
      ownerAttempt: logical.fence.ownerAttempt,
      ownerEpoch: logical.fence.ownerEpoch,
      deadlineAt: logical.fence.deadlineAt,
    });
    let leaseHeartbeatFailure: unknown;
    let leaseHeartbeatInFlight = false;
    const leaseHeartbeat = setInterval(() => {
      if (leaseHeartbeatInFlight || leaseHeartbeatFailure) return;
      leaseHeartbeatInFlight = true;
      try {
        bindingLease = renewCodexBindingRunLease(bindingLease);
      } catch (error) {
        leaseHeartbeatFailure = error;
      } finally {
        leaseHeartbeatInFlight = false;
      }
    }, 10_000);
    leaseHeartbeat.unref?.();
    let terminal: CodexTurnSnapshot | null = null;
    let attemptId = "";
    try {
      const existing = db.select().from(codexFollowerStartAttempts)
        .where(eq(codexFollowerStartAttempts.logicalTurnId, logicalTurnId)).get();
      let turnId: string;
      if (existing) {
        if (existing.dispatchSurface !== logical.dispatchSurface) {
          throw new CodexDesktopEngineError(
            "dispatch_surface_mismatch",
            "Follower attempt surface differs from logical turn",
          );
        }
        if (existing.state === "succeeded" && existing.followerTurnId) {
          attemptId = existing.attemptId;
          turnId = existing.followerTurnId;
        } else {
          const recovered = await this.bridge.recoverTurn({ logicalTurnId });
          if (recovered.state !== "succeeded" || !recovered.turnId) {
            throw new CodexDesktopEngineError(
              "desktop_follower_start_ambiguous",
              "Follower start is quarantined",
            );
          }
          attemptId = recovered.attemptId;
          turnId = recovered.turnId;
        }
      } else {
        const started = await this.bridge.startTurn({ logicalTurnId });
        attemptId = started.attemptId;
        turnId = started.turnId;
      }
      attachCodexBindingRunAttempt(bindingLease, attemptId);
      startCodexTurnExecution({
        logicalTurnId,
        attemptId,
        threadId: logical.request.threadId,
        turnId,
      });
      onEvent({ type: "thread.started", threadId: logical.request.threadId });
      const execution = readCodexTurnExecution(logicalTurnId)!;
      for await (const result of this.bridge.pollTurn({
        threadId: logical.request.threadId,
        turnId,
        afterCursor: execution.lastObservationCursor,
        lastSnapshotHash: execution.lastSemanticSnapshotHash ?? undefined,
        lastNormalizedSnapshot: execution.normalizedItemsJson === "[]"
          ? undefined
          : {
              threadId: execution.threadId,
              turnId: execution.turnId,
              status: "inProgress",
              items: JSON.parse(execution.normalizedItemsJson),
              metadata: { observedAt: execution.lastObservedAt ?? execution.updatedAt },
            },
        deadlineAt: logical.fence.deadlineAt,
      })) {
        if (leaseHeartbeatFailure) throw leaseHeartbeatFailure;
        if (result.kind === "turn_not_yet_visible") {
          recordCodexTurnNotYetVisible(logicalTurnId);
          continue;
        }
        const recorded = recordCodexTurnSnapshot({
          logicalTurnId,
          snapshot: result.snapshot,
          cursor: result.cursor,
          semanticHash: result.semanticSnapshotHash,
        });
        if (!recorded.changed) continue;
        for (const event of streamEvents(result)) onEvent(event);
        if (result.snapshot.status !== "inProgress") {
          terminal = result.snapshot;
          break;
        }
      }
      if (!terminal) {
        return {
          threadId: logical.request.threadId,
          runId: attemptId,
          summary: "Codex turn observation ended without a proved terminal snapshot",
          success: false,
          changedFiles: [],
          items: [],
          providerErrorCode: "app_server_turn_observation_lost",
        };
      }
      const items = terminal.items.map(toAiItem);
      const summary = summaryFrom(terminal);
      const parsed = parseStructuredOutputText(summary);
      return {
        threadId: logical.request.threadId,
        runId: attemptId,
        summary,
        success: terminal.status === "completed",
        changedFiles: extractChangedFiles(items),
        structuredOutput: parsed.value,
        structuredOutputSource: parsed.source ? "text_extracted" : "none",
        schemaDelivery: "none",
        schemaCapabilityInvoked: false,
        providerErrorCode: terminal.terminal?.errorCode ?? null,
        providerErrorDetail: terminal.terminal?.errorMessage,
        items,
      };
    } catch (error) {
      if (error instanceof CodexDesktopEngineError) throw error;
      const message = sanitizeCodexErrorMessage(error);
      return {
        threadId: logical.request.threadId,
        runId: attemptId || logical.runCorrelationId,
        summary: `Codex run failed: ${message}`,
        success: false,
        changedFiles: [],
        items: [],
        providerErrorCode: (error as { code?: string }).code
          ?? "desktop_follower_run_failed",
        providerErrorDetail: message,
      };
    } finally {
      clearInterval(leaseHeartbeat);
      releaseCodexBindingRunLease(bindingLease);
    }
  }
}

let productionBridge: Promise<CodexDesktopBridge> | null = null;

export function getProductionCodexDesktopBridge():
Promise<CodexDesktopBridge> {
  productionBridge ??= createProductionCodexDesktopBridge();
  return productionBridge;
}

async function createProductionCodexDesktopBridge():
Promise<CodexDesktopBridge> {
  const endpoint = await discoverCodexDesktopIpcEndpoint(
    defaultCodexDesktopDiscoveryDependencies(),
  );
  const shellControl = createCodexAppServerShellControl({
    appServerBinary: endpoint.appServerBinary,
  });
  const follower = createObservedCodexDesktopFollowerTransport(endpoint);
  const roleScopedLogicalTurnPort = {
    resolve: productionCodexLogicalTurnPort.resolve.bind(
      productionCodexLogicalTurnPort,
    ),
    async readForStart(logicalTurnId: string) {
      const logical = await productionCodexLogicalTurnPort.readForStart(
        logicalTurnId,
      );
      const runContext = createCodexDesktopRunContext({
        logicalTurnId,
        role: logical.role,
        prompt: logical.request.prompt,
      });
      return {
        ...logical,
        request: { ...logical.request, prompt: runContext.prompt },
      };
    },
  };
  const startAttemptPort = createCodexFollowerStartAttemptPort(
    roleScopedLogicalTurnPort,
    shellControl,
  );
  const unavailableShellProvision = {
    claim: async () => {
      throw new CodexDesktopEngineError(
        "binding_not_ready",
        "Task 4 execution requires a Task 3 durable binding",
      );
    },
    recordCandidate: async () => {},
    recordBootstrapReady: async () => {},
    beginMaterialization: async () => {
      throw new CodexDesktopEngineError("binding_not_ready", "Binding is not materialized");
    },
    finalizeDurableReady: async () => {},
    failMaterializationProof: async () => {},
    markAmbiguous: async () => {},
    expireProvisionVisibility: async () => {},
  };
  return createCodexDesktopBridge({
    shellControl,
    follower,
    logicalTurnPort: roleScopedLogicalTurnPort,
    startAttemptPort,
    shellProvisionPort: unavailableShellProvision,
  });
}

export async function createProductionCodexDesktopEngine():
Promise<CodexDesktopEngine> {
  return new CodexDesktopEngine(await getProductionCodexDesktopBridge());
}

export class LazyCodexDesktopEngine implements AiEngineAdapter {
  private engine: Promise<CodexDesktopEngine> | null = null;

  private get(): Promise<CodexDesktopEngine> {
    this.engine ??= createProductionCodexDesktopEngine();
    return this.engine;
  }

  async run(input: AiRunInput): Promise<AiRunResult> {
    return (await this.get()).run(input);
  }

  async *runStreamed(input: AiRunInput): AsyncGenerator<AiStreamEvent> {
    yield* (await this.get()).runStreamed(input);
  }
}
