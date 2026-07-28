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
import {
  createCodexAppServerShellControl,
  type CodexAppServerShellControl,
} from "./codex-app-server-shell-control";
import {
  defaultCodexDesktopDiscoveryDependencies,
  discoverCodexDesktopIpcEndpoint,
} from "./codex-desktop-ipc-discovery";
import { createObservedCodexDesktopFollowerTransport } from "./codex-desktop-ipc-transport";
import { createGatewayFollowerTransport } from "./codex-gateway-follower-transport";
import { CodexSessionGateway } from "./codex-session-gateway";
import { readCodexNativeFlags } from "../config/codex-native-flags";
import { toolSurfaceForRole } from "./stage-output-contract";
import {
  ensureCodexHomeProfile,
  type CodexToolSurface,
} from "./codex-home-profile";
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
    // Carried through to `result.items` verbatim. This is what the Spec round
    // reads to decide whether a delegated side actually exists, so it must not
    // be collapsed into a tool_call or dropped as uninteresting -- a dropped
    // item here reads downstream as "no sub-agent ran", which is precisely the
    // claim a silent spawn failure would also produce.
    case "sub_agent_activity":
      return {
        type: "sub_agent_activity",
        activity: item.semantic.activity,
        agentThreadId: item.semantic.agentThreadId,
        agentPath: item.semantic.agentPath,
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

  /**
   * Observe a turn this process already dispatched, without starting one.
   *
   * The clarification loop dispatches its continuation turns over
   * `host_ui_message`, which `run` refuses, and it dispatches them itself --
   * so the only thing left to do is watch that turn to a terminal snapshot and
   * report what it produced. Everything else (binding lease, heartbeat, cursor
   * resume, snapshot recording) is the same machinery a stage turn uses, so it
   * stays in one place rather than being copied into the orchestrator.
   */
  async observeDispatchedTurn(
    logicalTurnId: string,
    onEvent: (event: AiStreamEvent) => void = () => {},
  ): Promise<AiRunResult> {
    return this.observe(logicalTurnId, { allowStart: false }, onEvent);
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
    return this.observe(logicalTurnId, { allowStart: true }, onEvent);
  }

  private async observe(
    logicalTurnId: string,
    options: { allowStart: boolean },
    onEvent: (event: AiStreamEvent) => void = () => {},
  ): Promise<AiRunResult> {
    const logical = await readLogicalTurnForStart(logicalTurnId);
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
    let observedThreadId = logical.request.threadId;
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
          // Observe the turn where it was dispatched. A binding that rotated
          // to a fresh task since then still owns the scope, but this turn
          // lives in the old one, and polling the new task for it finds
          // nothing until the deadline and reports a settled turn as lost.
          observedThreadId = existing.threadId;
        } else {
          if (!options.allowStart) {
            // Follower recovery re-dispatches over IPC. An observer whose turn
            // was delivered some other way must not resurrect it that way.
            throw new CodexDesktopEngineError(
              "desktop_follower_start_missing",
              "Observation requires a proved dispatched turn",
            );
          }
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
        if (!options.allowStart) {
          throw new CodexDesktopEngineError(
            "desktop_follower_start_missing",
            "Observation requires a turn this owner already dispatched",
          );
        }
        const started = await this.bridge.startTurn({ logicalTurnId });
        attemptId = started.attemptId;
        turnId = started.turnId;
      }
      attachCodexBindingRunAttempt(bindingLease, attemptId);
      startCodexTurnExecution({
        logicalTurnId,
        attemptId,
        threadId: observedThreadId,
        turnId,
      });
      onEvent({ type: "thread.started", threadId: observedThreadId });
      const execution = readCodexTurnExecution(logicalTurnId)!;
      for await (const result of this.bridge.pollTurn({
        threadId: observedThreadId,
        turnId,
        afterCursor: execution.status === "running"
          ? execution.lastObservationCursor
          : 0,
        // Resume only from an observation still in flight. A recorded terminal
        // snapshot cannot be replayed as `inProgress` -- that rewrite changes
        // the hash the bridge checks the resume against, and the whole
        // observation is refused as an invalid snapshot.
        lastSnapshotHash: execution.status === "running"
          ? execution.lastSemanticSnapshotHash ?? undefined
          : undefined,
        lastNormalizedSnapshot: execution.status !== "running"
          || execution.normalizedItemsJson === "[]"
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
        // `changed` only decides whether there is anything new to stream. A
        // retry re-observes a turn this owner already recorded as terminal, so
        // treating an unchanged snapshot as "keep waiting" would run to the
        // deadline and report a settled turn as lost.
        if (recorded.changed) {
          for (const event of streamEvents(result)) onEvent(event);
        }
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

export class RetryablePromiseCache<T> {
  private current: Promise<T> | null = null;

  constructor(private readonly factory: () => Promise<T>) {}

  get(): Promise<T> {
    if (this.current) return this.current;
    const attempt = this.factory();
    this.current = attempt;
    void attempt.catch(() => {
      if (this.current === attempt) this.current = null;
    });
    return attempt;
  }
}

const productionBridge = new RetryablePromiseCache(
  createProductionCodexDesktopBridge,
);

export function getProductionCodexDesktopBridge():
Promise<CodexDesktopBridge> {
  return productionBridge.get();
}

const productionShellControl = new RetryablePromiseCache(
  async () => {
    const endpoint = await retryDesktopDiscovery(
      () => discoverCodexDesktopIpcEndpoint(
        defaultCodexDesktopDiscoveryDependencies(),
      ),
    );
    return createCodexAppServerShellControl({
      appServerBinary: endpoint.appServerBinary,
    });
  },
);

/**
 * The app-server shell control on its own, for readers that need a thread the
 * bridge does not own.
 *
 * The delegated Spec round reads its sub-agents' threads, and those threads
 * belong to no binding: the judge spawned them, so nothing in the bridge's
 * scope/binding model refers to them. The bridge keeps its shell control
 * private as a construction detail, which is right for turn dispatch and wrong
 * for this -- hence a sibling accessor over the same discovery rather than a
 * hole punched through the bridge interface.
 */
export function getProductionCodexAppServerShellControl():
Promise<CodexAppServerShellControl> {
  return productionShellControl.get();
}

export async function retryDesktopDiscovery<T>(
  discover: () => Promise<T>,
  options: {
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const maxAttempts = Math.max(
    1,
    Math.floor(options.maxAttempts ?? 3),
  );
  const sleep = options.sleep ?? ((ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let delayMs = 250;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await discover();
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 2_000);
    }
  }
}

/**
 * One long-lived gateway per tool surface, created on first use.
 *
 * CODEX_HOME is read when the app-server process starts, so a surface cannot be
 * changed on an existing connection -- each one needs its own process. They are
 * kept rather than spawned per turn because a fresh app-server reloads config,
 * MCP servers and plugins before the first token.
 *
 * `bin` is the attested path discovery resolved, not a bare `codex` off PATH:
 * that binary's signature and team identifier have been checked, and no surface
 * should quietly run a different one.
 */
function gatewayPoolBySurface(bin: string) {
  const pool = new Map<CodexToolSurface, CodexSessionGateway>();
  return (surface: CodexToolSurface): CodexSessionGateway => {
    const existing = pool.get(surface);
    if (existing) return existing;
    const gateway = new CodexSessionGateway({
      bin,
      cwd: process.cwd(),
      env: { CODEX_HOME: ensureCodexHomeProfile({ surface }) },
    });
    pool.set(surface, gateway);
    return gateway;
  };
}

async function createProductionCodexDesktopBridge():
Promise<CodexDesktopBridge> {
  const endpoint = await retryDesktopDiscovery(
    () => discoverCodexDesktopIpcEndpoint(
      defaultCodexDesktopDiscoveryDependencies(),
    ),
  );
  const shellControl = createCodexAppServerShellControl({
    appServerBinary: endpoint.appServerBinary,
  });
  // Discovery still runs on both paths: the gateway does not need Codex Desktop
  // to start a turn, but it does need the same `codex` binary discovery already
  // resolves, and shell control needs it regardless. Dropping the Desktop
  // dependency entirely is a separate step from changing which door turns use.
  const follower = readCodexNativeFlags().turnTransport === "gateway"
    ? createGatewayFollowerTransport({
      gatewayFor: gatewayPoolBySurface(endpoint.appServerBinary.path),
    })
    : createObservedCodexDesktopFollowerTransport(endpoint);
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
        phase: logical.phase,
        prompt: logical.request.prompt,
        projectId: logical.projectId,
        scopeKind: logical.scopeKind,
        scopeId: logical.scopeId,
        threadId: logical.request.threadId,
      });
      return {
        ...logical,
        request: {
          ...logical.request,
          prompt: runContext.prompt,
          // The one place the role is known and the request is still mutable,
          // so it is where the contract table gets consulted.
          toolSurface: toolSurfaceForRole(logical.role),
        },
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
  private readonly engine = new RetryablePromiseCache(
    createProductionCodexDesktopEngine,
  );

  private get(): Promise<CodexDesktopEngine> {
    return this.engine.get();
  }

  async run(input: AiRunInput): Promise<AiRunResult> {
    return (await this.get()).run(input);
  }

  async *runStreamed(input: AiRunInput): AsyncGenerator<AiStreamEvent> {
    yield* (await this.get()).runStreamed(input);
  }
}
