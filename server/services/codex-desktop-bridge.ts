import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type {
  CodexAppServerShellControl,
} from "./codex-app-server-shell-control";
import {
  CodexDesktopFollowerRoutingError,
  type CodexDesktopFollowerTransport,
} from "./codex-desktop-ipc-transport";
import {
  dispatchSurfaceForRole,
  REQUIRED_APP_SERVER_SHELL_CAPABILITIES,
  REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES,
  type CodexDesktopProbe,
  type CodexDesktopTurnRequest,
  type CodexFollowerStartAttempt,
  type CodexFollowerStartAttemptPort,
  type CodexFollowerStartFence,
  type CodexFollowerStartRecoveryFence,
  type CodexLogicalTurnIdentity,
  type CodexLogicalTurnPort,
  type CodexLogicalTurnStartContext,
  type CodexPersistentShell,
  type CodexShellProvisionFence,
  type CodexShellProvisionPort,
  type CodexTurnPollResult,
  type CodexTurnSnapshot,
} from "./codex-desktop-bridge-types";

export type CodexDesktopBridgeErrorCode =
  | "desktop_bridge_disabled"
  | "desktop_bridge_unavailable"
  | "codex_hybrid_bridge_unsupported"
  | "desktop_protocol_invalid"
  | "desktop_follower_not_ready"
  | "desktop_follower_start_ambiguous"
  | "app_server_turn_observation_lost"
  | "turn_observation_timeout"
  | "turn_snapshot_invalid"
  | "shell_provision_ambiguous"
  | "desktop_thread_detached";

export class CodexDesktopBridgeError extends Error {
  constructor(
    readonly code: CodexDesktopBridgeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexDesktopBridgeError";
  }
}

export interface CodexDesktopBridge {
  probe(): Promise<CodexDesktopProbe>;
  /**
   * Task-binding control plane adapter. These methods use app-server shell
   * control only; they never deep-link or start a managed turn.
   */
  provisionPersistentShell?(input: {
    projectPath: string;
    title: string;
  }): Promise<CodexPersistentShell>;
  findPersistentShells?(input: {
    projectPath: string;
    title: string;
  }): Promise<CodexPersistentShell[]>;
  readPersistentShell?(threadId: string): Promise<CodexPersistentShell | null>;
  ensurePersistentShell(input: {
    projectPath: string;
    scope: import("./codex-desktop-bridge-types").CodexManagedScope;
    title: string;
    provisionFence: CodexShellProvisionFence;
  }): Promise<CodexPersistentShell>;
  startTurn(input: { logicalTurnId: string }): Promise<{
    attemptId: string;
    turnId: string;
  }>;
  recoverTurn(input: { logicalTurnId: string }): Promise<{
    attemptId: string;
    state: "succeeded" | "quarantined";
    turnId?: string;
  }>;
  interruptTurn(input: { threadId: string; turnId: string }): Promise<void>;
  pollTurn(input: {
    threadId: string;
    turnId: string;
    afterCursor?: number;
    lastSnapshotHash?: string;
    lastNormalizedSnapshot?: CodexTurnSnapshot;
    deadlineAt: string;
  }): AsyncIterable<CodexTurnPollResult>;
}

export interface BridgeOptions {
  shellControl: CodexAppServerShellControl;
  follower: CodexDesktopFollowerTransport;
  logicalTurnPort: CodexLogicalTurnPort;
  startAttemptPort: CodexFollowerStartAttemptPort;
  shellProvisionPort: CodexShellProvisionPort;
  shellProvisionFailpoint?: (
    point:
      | "after_thread_start"
      | "after_thread_activation"
      | "after_thread_name",
  ) => void;
  readinessDeadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  allocateCursor?: (afterCursor: number) => Promise<number>;
  readRpcDeadlineMs?: number;
  readOutageBudgetMs?: number;
  followerStartFailpoint?: (
    checkpoint:
      | "after_dispatch_cas_before_send"
      | "unknown_response"
      | "success_before_cas",
  ) => void;
}

export type Phase0InspectableStartAttemptPort = CodexFollowerStartAttemptPort;

export interface Phase0MutableLogicalTurnPort extends CodexLogicalTurnPort {
  bindStartContext(input: {
    logicalTurnId: string;
    request: CodexDesktopTurnRequest;
    fence: CodexFollowerStartFence;
  }): Promise<void>;
}

const phase0LogicalContexts = new Map<string, CodexLogicalTurnStartContext>();

function phase0LogicalTurnId(identityKey: string): string {
  const digest = createHash("sha256").update(identityKey).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function phase0RunCorrelationId(logicalTurnId: string): string {
  return `sp-${createHash("sha256")
    .update(logicalTurnId)
    .digest("base64url")}`;
}

export function createPhase0InMemoryLogicalTurnPort():
Phase0MutableLogicalTurnPort {
  const rowsByKey = new Map<string, CodexLogicalTurnIdentity>();
  const rowsById = new Map<string, CodexLogicalTurnIdentity>();
  const contexts = new Map<string, CodexLogicalTurnStartContext>();
  return {
    async resolve(input) {
      if (
        !Number.isSafeInteger(input.round)
        || input.round < 0
        || !Number.isSafeInteger(input.ordinal)
        || input.ordinal < 0
        || input.phase.length === 0
      ) {
        throw new Error("logical turn identity is invalid");
      }
      const canonicalInput = {
        owner: input.owner,
        projectId: input.projectId,
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        phase: input.phase,
        role: input.role,
        round: input.round,
        ordinal: input.ordinal,
      };
      const key = JSON.stringify(canonicalize(canonicalInput));
      const existing = rowsByKey.get(key);
      if (existing) return existing;
      const logicalTurnId = phase0LogicalTurnId(key);
      const turnSlot = [
        input.owner.kind === "pipeline_job"
          ? input.owner.pipelineJobId
          : input.owner.projectAiRunId,
        input.phase,
        input.role,
        `round-${input.round}`,
        `ordinal-${input.ordinal}`,
      ].join("/");
      const row: CodexLogicalTurnIdentity = {
        ...canonicalInput,
        logicalTurnId,
        turnSlot,
        runCorrelationId: phase0RunCorrelationId(logicalTurnId),
        dispatchSurface: dispatchSurfaceForRole(canonicalInput.role),
      };
      rowsByKey.set(key, row);
      rowsById.set(logicalTurnId, row);
      return row;
    },
    async bindStartContext(input) {
      const row = rowsById.get(input.logicalTurnId);
      if (
        !row
        || input.fence.logicalTurnId !== row.logicalTurnId
        || stableOwner(input.fence.owner) !== stableOwner(row.owner)
        || input.fence.projectId !== row.projectId
        || input.fence.scopeKind !== row.scopeKind
        || input.fence.scopeId !== row.scopeId
        || input.fence.dispatchSurface !== row.dispatchSurface
      ) {
        throw new Error("logical turn start context identity mismatch");
      }
      contexts.set(row.logicalTurnId, {
        ...row,
        request: { ...input.request },
        fence: { ...input.fence },
      });
      phase0LogicalContexts.set(
        row.logicalTurnId,
        contexts.get(row.logicalTurnId)!,
      );
    },
    async readForStart(logicalTurnId) {
      const context = contexts.get(logicalTurnId);
      if (!context) throw new Error("logical turn start context not found");
      return {
        ...context,
        request: { ...context.request },
        fence: { ...context.fence },
      };
    },
  };
}

export function createPhase0InMemoryStartAttemptPort(
  logicalTurnPort: Pick<CodexLogicalTurnPort, "readForStart"> = {
    async readForStart(logicalTurnId) {
      const context = phase0LogicalContexts.get(logicalTurnId);
      if (!context) throw new Error("logical turn start context not found");
      return context;
    },
  },
  readBaseline: (
    request: CodexDesktopTurnRequest,
  ) => Promise<{ turnIds: string[]; semanticHash: string }> = async () => ({
    turnIds: [],
    semanticHash: createHash("sha256").update("[]").digest("hex"),
  }),
):
Phase0InspectableStartAttemptPort {
  const attempts = new Map<string, CodexFollowerStartAttempt>();
  const activeByLogicalTurn = new Map<string, string>();
  function sameFence(
    left: CodexFollowerStartFence,
    right: CodexFollowerStartFence,
  ): boolean {
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
  }
  function sameRecoveryFence(
    left: CodexFollowerStartRecoveryFence,
    right: CodexFollowerStartRecoveryFence,
  ): boolean {
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
  }
  return {
    async prepare(input) {
      const logical = await logicalTurnPort.readForStart(
        input.logicalTurnId,
      );
      const baseline = logical.role === "shell_materialization"
        ? {
            turnIds: [],
            semanticHash: createHash("sha256").update("[]").digest("hex"),
          }
        : await readBaseline(logical.request);
      if (attempts.has(input.attemptId)) {
        throw new Error("follower start attempt already exists");
      }
      if (activeByLogicalTurn.has(logical.logicalTurnId)) {
        throw new Error("logical turn already has an active start attempt");
      }
      const correlationMarker =
        `[stagepass-run:${logical.runCorrelationId}:attempt:${input.attemptId}]`;
      const requestWithMarker = {
        ...logical.request,
        prompt: `${logical.request.prompt}\n\n${correlationMarker}`,
      };
      const normalizedPromptHash = createHash("sha256")
        .update(requestWithMarker.prompt)
        .digest("hex");
      const attempt: CodexFollowerStartAttempt = {
        attemptId: input.attemptId,
        logicalTurnId: logical.logicalTurnId,
        request: requestWithMarker,
        fence: logical.fence,
        originalDeadlineAt: logical.fence.deadlineAt,
        correlationMarker,
        normalizedPromptHash,
        preStartTurnIds: [...baseline.turnIds],
        preStartSemanticHash: baseline.semanticHash,
        state: "prepared",
        dispatchOrdinal: 0,
      };
      attempts.set(input.attemptId, attempt);
      activeByLogicalTurn.set(logical.logicalTurnId, input.attemptId);
      return {
        attemptId: input.attemptId,
        state: "prepared",
        fence: logical.fence,
        request: logical.request,
        correlationMarker,
        normalizedPromptHash,
        requestWithMarker,
        preStartTurnIds: [...baseline.turnIds],
        preStartSemanticHash: baseline.semanticHash,
      };
    },
    async claimDispatch(input) {
      const current = attempts.get(input.attemptId);
      if (
        !current
        || !sameFence(current.fence, input.fence)
        || (
          current.state !== "prepared"
          && current.state !== "no_client_found"
        )
      ) {
        throw new Error("follower start attempt is not dispatchable");
      }
      const dispatchOrdinal = current.dispatchOrdinal + 1;
      attempts.set(input.attemptId, {
        ...current,
        state: "dispatching",
        dispatchOrdinal,
      });
      return dispatchOrdinal;
    },
    async claimSafeAttemptForWorker(input) {
      const current = attempts.get(input.attemptId);
      if (
        !current
        || current.state !== input.expectedState
        || !sameFence(current.fence, input.expectedOldFence)
        || (
          current.state !== "prepared"
          && current.state !== "no_client_found"
        )
        || input.newFence.logicalTurnId !== current.logicalTurnId
        || stableOwner(input.newFence.owner) !== stableOwner(current.fence.owner)
        || input.newFence.projectId !== current.fence.projectId
        || input.newFence.scopeKind !== current.fence.scopeKind
        || input.newFence.scopeId !== current.fence.scopeId
        || input.newFence.purpose !== current.fence.purpose
        || input.newFence.ownerAttempt <= current.fence.ownerAttempt
        || input.newFence.ownerEpoch <= current.fence.ownerEpoch
        || Date.parse(input.newFence.deadlineAt)
          > Date.parse(current.originalDeadlineAt)
        || Date.parse(input.newFence.leaseExpiresAt)
          > Date.parse(current.originalDeadlineAt)
      ) {
        throw new Error("follower start ownership cannot be handed off");
      }
      attempts.set(input.attemptId, {
        ...current,
        fence: input.newFence,
      });
    },
    async recordNoClientFound(input) {
      const current = attempts.get(input.attemptId);
      if (
        current?.state === "no_client_found"
        && current.dispatchOrdinal === input.dispatchOrdinal
        && sameFence(current.fence, input.fence)
      ) {
        return;
      }
      if (
        !current
        || current.state !== "dispatching"
        || current.dispatchOrdinal !== input.dispatchOrdinal
        || !sameFence(current.fence, input.fence)
      ) {
        throw new Error("no-client-found checkpoint does not own dispatch");
      }
      attempts.set(input.attemptId, {
        ...current,
        state: "no_client_found",
      });
    },
    async recordSuccess(input) {
      const current = attempts.get(input.attemptId);
      if (
        current?.state === "succeeded"
        && current.turnId === input.turnId
        && current.dispatchOrdinal === input.dispatchOrdinal
        && sameFence(current.fence, input.fence)
      ) {
        return;
      }
      if (
        !current
        || current.state !== "dispatching"
        || current.dispatchOrdinal !== input.dispatchOrdinal
        || !sameFence(current.fence, input.fence)
      ) {
        throw new Error("success checkpoint does not own dispatch");
      }
      attempts.set(input.attemptId, {
        ...current,
        state: "succeeded",
        turnId: input.turnId,
      });
    },
    async recordAmbiguous(input) {
      const current = attempts.get(input.attemptId);
      if (
        !current
        || current.state !== "dispatching"
        || current.dispatchOrdinal !== input.dispatchOrdinal
        || !sameFence(current.fence, input.fence)
      ) {
        throw new Error("ambiguous checkpoint does not own dispatch");
      }
      attempts.set(input.attemptId, {
        ...current,
        state: "ambiguous",
        ambiguousReason: input.reason,
      });
    },
    async claimReconciliation(input) {
      const current = attempts.get(input.attemptId);
      if (
        !current
        || (
          current.state !== "dispatching"
          && current.state !== "ambiguous"
        )
      ) {
        throw new Error("follower start attempt is not reconcilable");
      }
      if (
        stableOwner(input.ownerFence.owner) !== stableOwner(current.fence.owner)
        || input.ownerFence.logicalTurnId !== current.logicalTurnId
        || input.ownerFence.projectId !== current.fence.projectId
        || input.ownerFence.scopeKind !== current.fence.scopeKind
        || input.ownerFence.scopeId !== current.fence.scopeId
        || input.ownerFence.purpose !== current.fence.purpose
        || input.ownerFence.dispatchSurface !== current.fence.dispatchSurface
        || Date.parse(input.ownerFence.deadlineAt)
          > Date.parse(current.originalDeadlineAt)
        || Date.parse(input.ownerFence.leaseExpiresAt)
          > Date.parse(current.originalDeadlineAt)
        || Date.parse(input.ownerFence.deadlineAt) <= Date.now()
        || Date.parse(input.ownerFence.leaseExpiresAt) <= Date.now()
      ) {
        throw new Error("recovery owner fence is not concrete or compatible");
      }
      if (
        current.recoveryFence
        && input.ownerFence.ownerEpoch
          <= current.recoveryFence.ownerFence.ownerEpoch
      ) {
        throw new Error("stale follower reconciliation lease");
      }
      const recoveryFence: CodexFollowerStartRecoveryFence = {
        ownerFence: input.ownerFence,
        recoveryLeaseToken: randomUUID(),
        recoveryEpoch:
          (current.recoveryFence?.recoveryEpoch ?? 0) + 1,
      };
      attempts.set(input.attemptId, {
        ...current,
        recoveryFence,
      });
      return recoveryFence;
    },
    async adoptSuccess(input) {
      const current = attempts.get(input.attemptId);
      if (
        !current
        || (
          current.state !== "dispatching"
          && current.state !== "ambiguous"
        )
        || current.dispatchOrdinal !== input.dispatchOrdinal
        || !current.recoveryFence
        || !sameRecoveryFence(current.recoveryFence, input.fence)
      ) {
        throw new Error("recovery lease cannot adopt follower success");
      }
      attempts.set(input.attemptId, {
        ...current,
        state: "succeeded",
        turnId: input.turnId,
      });
    },
    async quarantine(input) {
      const current = attempts.get(input.attemptId);
      if (
        !current
        || current.state === "succeeded"
        || current.dispatchOrdinal !== input.dispatchOrdinal
        || !current.recoveryFence
        || !sameRecoveryFence(current.recoveryFence, input.fence)
      ) {
        throw new Error("follower start attempt cannot be quarantined");
      }
      attempts.set(input.attemptId, {
        ...current,
        state: "quarantined",
        code: input.code,
        ...(input.reason ? { ambiguousReason: input.reason } : {}),
      });
    },
    async expireVisibility(input) {
      const current = attempts.get(input.attemptId);
      if (
        !current
        || current.state === "succeeded"
        || current.dispatchOrdinal !== input.dispatchOrdinal
        || !current.recoveryFence
        || !sameRecoveryFence(current.recoveryFence, input.fence)
      ) {
        throw new Error("follower start visibility expiry is not due");
      }
      attempts.set(input.attemptId, {
        ...current,
        state: "quarantined",
        code: input.code,
        ambiguousReason: "visibility_timeout",
      });
    },
    async inspect(attemptId) {
      const attempt = attempts.get(attemptId);
      return attempt
        ? { ...attempt, preStartTurnIds: [...attempt.preStartTurnIds] }
        : null;
    },
    async inspectByLogicalTurn(logicalTurnId) {
      const attemptId = activeByLogicalTurn.get(logicalTurnId);
      if (!attemptId) return null;
      const attempt = attempts.get(attemptId);
      return attempt
        ? { ...attempt, preStartTurnIds: [...attempt.preStartTurnIds] }
        : null;
    },
  };
}

function detached(message: string): CodexDesktopBridgeError {
  return new CodexDesktopBridgeError("desktop_thread_detached", message);
}

function isShellProvisionCheckpointCrash(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "phase0ShellProvisionCheckpoint" in error;
}

function missingCapabilities(
  required: readonly string[],
  actual: readonly string[],
): string[] {
  const available = new Set(actual);
  return required.filter((capability) => !available.has(capability));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function stableOwner(
  owner: import("./codex-desktop-bridge-types").CodexManagedOwner,
): string {
  return JSON.stringify(canonicalize(owner));
}

function sameStartFence(
  left: CodexFollowerStartFence,
  right: CodexFollowerStartFence,
): boolean {
  return JSON.stringify(canonicalize(left))
    === JSON.stringify(canonicalize(right));
}

function phase0InjectedCrash(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "phase0CrashCheckpoint" in error;
}

function tripFollowerStartFailpoint(
  options: BridgeOptions,
  checkpoint:
    | "after_dispatch_cas_before_send"
    | "unknown_response"
    | "success_before_cas",
): void {
  if (!options.followerStartFailpoint) return;
  try {
    options.followerStartFailpoint(checkpoint);
  } catch (cause) {
    const error = new Error(`injected phase0 crash: ${checkpoint}`, { cause });
    Object.assign(error, { phase0CrashCheckpoint: checkpoint });
    throw error;
  }
}

function snapshotHash(snapshot: CodexTurnSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(turnSemanticValue(snapshot))))
    .digest("hex");
}

function turnSemanticValue(snapshot: CodexTurnSnapshot): {
  threadId: string;
  turnId: string;
  status: CodexTurnSnapshot["status"];
  items: Array<{
    id: string;
    kind: string;
    semantic: unknown;
  }>;
  terminal: CodexTurnSnapshot["terminal"];
} {
  return {
    threadId: snapshot.threadId,
    turnId: snapshot.turnId,
    status: snapshot.status,
    items: snapshot.items.map(({ id, kind, semantic }) => ({
      id,
      kind,
      semantic,
    })),
    terminal: snapshot.terminal,
  };
}

export function codexTurnSetSemanticHash(
  turns: CodexTurnSnapshot[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(
      turns.map((turn) => turnSemanticValue(turn)),
    )))
    .digest("hex");
}

function terminal(status: CodexTurnSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function assertSnapshotTransition(
  previous: CodexTurnSnapshot | undefined,
  current: CodexTurnSnapshot,
): void {
  if (!previous) return;
  if (
    previous.threadId !== current.threadId
    || previous.turnId !== current.turnId
  ) {
    throw new CodexDesktopBridgeError(
      "turn_snapshot_invalid",
      "Codex turn snapshot identity changed",
    );
  }
  const previousIds = snapshotItemIds(previous);
  const currentIds = snapshotItemIds(current);
  if (
    currentIds.length < previousIds.length
    || previousIds.some((id, index) => currentIds[index] !== id)
    || previous.items.some(
      (item, index) => current.items[index]?.kind !== item.kind,
    )
  ) {
    throw new CodexDesktopBridgeError(
      "turn_snapshot_invalid",
      "Codex turn items were deleted, reordered, or changed kind",
    );
  }
  if (terminal(previous.status)) {
    throw new CodexDesktopBridgeError(
      "turn_snapshot_invalid",
      "Codex terminal turn snapshot changed",
    );
  }
  if (
    previous.status !== "inProgress"
    || (current.status !== "inProgress" && !terminal(current.status))
  ) {
    throw new CodexDesktopBridgeError(
      "turn_snapshot_invalid",
      "Codex turn status regressed",
    );
  }
}

function snapshotItemIds(snapshot: CodexTurnSnapshot): string[] {
  const allowedKinds = new Set([
    "user_message",
    "agent_message",
    "command_execution",
    "tool_call",
    "file_change",
    "error",
  ]);
  const ids = snapshot.items.map((item) => {
    if (
      typeof item !== "object"
      || item === null
      || !("id" in item)
      || typeof item.id !== "string"
      || item.id.length === 0
      || !("kind" in item)
      || typeof item.kind !== "string"
      || !allowedKinds.has(item.kind)
    ) {
      throw new CodexDesktopBridgeError(
        "turn_snapshot_invalid",
        "Codex turn item is missing a stable id or known kind",
      );
    }
    return item.id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new CodexDesktopBridgeError(
      "turn_snapshot_invalid",
      "Codex turn snapshot contains duplicate item ids",
    );
  }
  return ids;
}

function changedSemanticItem(
  item: CodexTurnSnapshot["items"][number],
): CodexTurnSnapshot["items"][number] {
  switch (item.kind) {
    case "user_message":
    case "agent_message":
      return {
        ...item,
        semantic: { text: `${item.semantic.text} [semantic-update]` },
      };
    case "command_execution":
      return {
        ...item,
        semantic: {
          ...item.semantic,
          output: `${item.semantic.output ?? ""}[semantic-update]`,
        },
      };
    case "tool_call":
      return {
        ...item,
        semantic: {
          ...item.semantic,
          result: `${item.semantic.result ?? ""}[semantic-update]`,
        },
      };
    case "file_change":
      return {
        ...item,
        semantic: {
          ...item.semantic,
          path: `${item.semantic.path}.semantic-update`,
        },
      };
    case "error":
      return {
        ...item,
        semantic: {
          ...item.semantic,
          message: `${item.semantic.message} [semantic-update]`,
        },
      };
  }
}

/**
 * Replays the Phase 0 semantic transition matrix against items captured from
 * a real app-server `thread/read(includeTurns:true)` snapshot.
 */
export function evaluateCodexSnapshotReplayMatrix(
  captured: CodexTurnSnapshot,
): {
  append: true;
  sameIdSemanticUpdate: true;
  reorderRejected: true;
  removalRejected: true;
  duplicateIdRejected: true;
  unknownKindRejected: true;
  volatileDurationDeduped: true;
  identicalReconnectDeduped: true;
  terminalDriftRejected: true;
} {
  if (captured.items.length === 0) {
    throw new CodexDesktopBridgeError(
      "turn_snapshot_invalid",
      "real snapshot replay requires at least one captured item",
    );
  }
  const base: CodexTurnSnapshot = {
    ...captured,
    status: "inProgress",
    terminal: undefined,
    items: captured.items.map((item) => ({ ...item })),
  };
  const first = base.items[0]!;
  const appended: CodexTurnSnapshot = {
    ...base,
    items: [
      ...base.items,
      { ...first, id: `${first.id}:phase0-append` },
    ],
  };
  assertSnapshotTransition(base, appended);
  const updated: CodexTurnSnapshot = {
    ...base,
    items: [
      changedSemanticItem(first),
      ...base.items.slice(1),
    ],
  };
  assertSnapshotTransition(base, updated);
  if (snapshotHash(base) === snapshotHash(updated)) {
    throw new Error("same-id semantic update did not change semantic hash");
  }
  const rejects = (next: CodexTurnSnapshot): true => {
    try {
      snapshotItemIds(next);
      assertSnapshotTransition(base, next);
    } catch (error) {
      if (
        error instanceof CodexDesktopBridgeError
        && error.code === "turn_snapshot_invalid"
      ) return true;
      throw error;
    }
    throw new Error("invalid snapshot transition was accepted");
  };
  const dedupes = (
    previous: CodexTurnSnapshot,
    next: CodexTurnSnapshot,
    message: string,
  ): true => {
    if (snapshotHash(previous) !== snapshotHash(next)) {
      throw new Error(message);
    }
    return true;
  };
  const reordered = base.items.length > 1
    ? [base.items[1]!, base.items[0]!, ...base.items.slice(2)]
    : [
        { ...first, id: `${first.id}:phase0-prefix` },
        first,
      ];
  const duplicate = [...base.items, { ...first }];
  const unknown = [
    ...base.items,
    {
      id: `${first.id}:phase0-unknown`,
      kind: "phase0_unknown_kind",
      semantic: {},
    } as unknown as CodexTurnSnapshot["items"][number],
  ];
  const volatile: CodexTurnSnapshot = {
    ...base,
    metadata: {
      ...base.metadata,
      durationMs: (base.metadata.durationMs ?? 0) + 1,
      observedAt: new Date(
        Date.parse(base.metadata.observedAt) + 1,
      ).toISOString(),
    },
  };
  const terminalBase: CodexTurnSnapshot = {
    ...base,
    status: "completed",
    terminal: { output: "phase0-terminal" },
  };
  return {
    append: true,
    sameIdSemanticUpdate: true,
    reorderRejected: rejects({ ...base, items: reordered }),
    removalRejected: rejects({ ...base, items: base.items.slice(0, -1) }),
    duplicateIdRejected: rejects({ ...base, items: duplicate }),
    unknownKindRejected: rejects({ ...base, items: unknown }),
    volatileDurationDeduped: dedupes(
      base,
      volatile,
      "volatile duration changed semantic hash",
    ),
    identicalReconnectDeduped: dedupes(
      base,
      structuredClone(base),
      "identical reconnect changed semantic hash",
    ),
    terminalDriftRejected: ((): true => {
      try {
        assertSnapshotTransition(terminalBase, {
          ...terminalBase,
          terminal: { output: "phase0-terminal-drift" },
        });
      } catch (error) {
        if (
          error instanceof CodexDesktopBridgeError
          && error.code === "turn_snapshot_invalid"
        ) return true;
        throw error;
      }
      throw new Error("terminal semantic drift was accepted");
    })(),
  };
}

function containsMarker(value: unknown, marker: string): boolean {
  if (typeof value === "string") return value.includes(marker);
  if (Array.isArray(value)) {
    return value.some((entry) => containsMarker(entry, marker));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((entry) => containsMarker(entry, marker));
  }
  return false;
}

function validateTurnRequestShape(request: CodexDesktopTurnRequest): void {
  if (
    typeof request.threadId !== "string"
    || request.threadId.length === 0
    || typeof request.cwd !== "string"
    || !path.isAbsolute(request.cwd)
    || typeof request.prompt !== "string"
    || request.prompt.trim().length === 0
    || request.approvalPolicy !== "never"
    || (
      request.sandboxMode !== "read-only"
      && request.sandboxMode !== "workspace-write"
    )
    || (
      request.model !== undefined
      && (typeof request.model !== "string" || request.model.length === 0)
    )
    || (
      request.reasoningEffort !== undefined
      && (
        typeof request.reasoningEffort !== "string"
        || request.reasoningEffort.length === 0
        || request.model === undefined
      )
    )
  ) {
    throw new CodexDesktopBridgeError(
      "desktop_protocol_invalid",
      "server-owned follower request is invalid",
    );
  }
}

export function createCodexDesktopBridge(
  options: BridgeOptions,
): CodexDesktopBridge {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const readinessDeadlineMs = Math.max(
    1,
    Math.floor(options.readinessDeadlineMs ?? 15_000),
  );
  const allocateCursor = options.allocateCursor
    ?? (async (afterCursor: number) => afterCursor + 1);
  const readRpcDeadlineMs = Math.max(
    1,
    Math.floor(options.readRpcDeadlineMs ?? 5_000),
  );
  const readOutageBudgetMs = Math.max(
    1,
    Math.floor(options.readOutageBudgetMs ?? 15_000),
  );

  async function probe(): Promise<CodexDesktopProbe> {
    let shell;
    let desktop;
    try {
      [shell, desktop] = await Promise.all([
        options.shellControl.probe(),
        options.follower.probe(),
      ]);
    } catch (error) {
      if (error instanceof CodexDesktopBridgeError) throw error;
      throw new CodexDesktopBridgeError(
        "desktop_bridge_unavailable",
        "hybrid Codex bridge probe failed",
        { cause: error },
      );
    }
    const shellObservedRequired = ["model/list", "thread/list"];
    const missingObserved = missingCapabilities(
      shellObservedRequired,
      shell.capabilities,
    );
    const missingProtocol = [
      ...missingCapabilities(
        REQUIRED_APP_SERVER_SHELL_CAPABILITIES,
        shell.protocolCapabilities,
      ),
      ...missingCapabilities(
        REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES,
        desktop.protocolCapabilities,
      ),
    ];
    if (missingObserved.length > 0 || missingProtocol.length > 0) {
      throw new CodexDesktopBridgeError(
        "codex_hybrid_bridge_unsupported",
        [
          missingObserved.length > 0
            ? `unobserved runtime capabilities: ${missingObserved.join(", ")}`
            : "",
          missingProtocol.length > 0
            ? `unsupported protocol capabilities: ${missingProtocol.join(", ")}`
            : "",
        ].filter(Boolean).join("; "),
      );
    }
    return {
      appServerVersion: shell.version,
      appServerProtocolFingerprint: shell.protocolFingerprint,
      desktopClientVersion: desktop.clientVersion,
      desktopFollowerProtocolFingerprint: desktop.protocolFingerprint,
      shellCapabilities: [...shell.capabilities],
      followerCapabilities: [...desktop.capabilities],
      shellProtocolCapabilities: [...shell.protocolCapabilities],
      followerProtocolCapabilities: [...desktop.protocolCapabilities],
    };
  }

  async function ensurePersistentShell(input: {
    projectPath: string;
    scope: import("./codex-desktop-bridge-types").CodexManagedScope;
    title: string;
    provisionFence: CodexShellProvisionFence;
  }): Promise<CodexPersistentShell> {
    await probe();
    if (
      input.scope.scopeId.length === 0
      || input.scope.projectId.length === 0
      || (
        input.scope.kind === "change"
        && (
          input.scope.changeId.length === 0
          || input.scope.changeId !== input.scope.scopeId
        )
      )
      || (
        input.scope.kind !== "change"
        && input.scope.scopeId !== input.scope.projectId
      )
    ) {
      throw new CodexDesktopBridgeError(
        "desktop_protocol_invalid",
        "Codex persistent shell scope is invalid",
      );
    }
    const observed = await options.shellControl.listPersistentShells({
      cwd: input.projectPath,
    });
    const intent = await options.shellProvisionPort.claim({
      scope: input.scope,
      cwd: input.projectPath,
      title: input.title,
      baselineThreadIds: observed.map(({ threadId }) => threadId),
      fence: input.provisionFence,
    });
    if (intent.state === "ambiguous") {
      throw new CodexDesktopBridgeError(
        "shell_provision_ambiguous",
        "persistent Codex shell provision is durably ambiguous",
      );
    }
    if (intent.state === "durable_ready") {
      const shell = intent.threadId
        ? await options.shellControl.readPersistentShell(intent.threadId)
        : null;
      if (
        !shell
        || shell.cwd !== input.projectPath
        || shell.title !== input.title
      ) {
        throw detached("durable persistent Codex shell binding is detached");
      }
      return shell;
    }

    if (!Number.isFinite(Date.parse(input.provisionFence.leaseExpiresAt))) {
      throw new CodexDesktopBridgeError(
        "desktop_protocol_invalid",
        "persistent Codex shell provision fence deadline is invalid",
      );
    }

    async function ambiguous(reason: string, cause?: unknown): Promise<never> {
      await options.shellProvisionPort.markAmbiguous({
        provisionId: intent.provisionId,
        reason,
        fence: input.provisionFence,
      });
      throw new CodexDesktopBridgeError(
        "shell_provision_ambiguous",
        reason,
        cause === undefined ? undefined : { cause },
      );
    }

    async function failMaterializationProof(): Promise<never> {
      await options.shellProvisionPort.failMaterializationProof({
        provisionId: intent.provisionId,
        reason: "materialization_proof_timeout",
        fence: input.provisionFence,
      });
      throw new CodexDesktopBridgeError(
        "shell_provision_ambiguous",
        "independent shell materialization visibility timeout",
      );
    }

    async function expireProvisionDeadline(): Promise<never> {
      await options.shellProvisionPort.expireProvisionVisibility({
        provisionId: intent.provisionId,
        fence: input.provisionFence,
      });
      throw new CodexDesktopBridgeError(
        "shell_provision_ambiguous",
        "persistent shell provision deadline expired",
      );
    }

    if (
      intent.state === "provisioning"
      && !intent.created
    ) {
      return ambiguous(
        intent.candidateThreadId
          ? "creator-session shell proof was not durably completed"
          : "thread start may have committed without a recorded candidate",
      );
    }

    let candidateThreadId = intent.candidateThreadId;
    if (intent.state === "provisioning") {
      let startedThreadId: string | undefined;
      let candidateRecorded = false;
      let activationRequested = false;
      let creatorProof: CodexPersistentShell;
      try {
        creatorProof = await options.shellControl.startPersistentThreadAndName({
          cwd: input.projectPath,
          ephemeral: false,
          name: input.title,
          deadlineAt: input.provisionFence.leaseExpiresAt,
          async onStarted(threadId) {
            startedThreadId = threadId;
            await options.shellProvisionPort.recordCandidate({
              provisionId: intent.provisionId,
              threadId,
              fence: input.provisionFence,
            });
            candidateRecorded = true;
            candidateThreadId = threadId;
          },
          async activate(threadId) {
            await options.follower.openThreadDeepLink({
              url: `codex://threads/${threadId}`,
            });
            activationRequested = true;
          },
          onCheckpoint(point) {
            if (!options.shellProvisionFailpoint) return;
            try {
              options.shellProvisionFailpoint(point);
            } catch (cause) {
              const error = cause instanceof Error
                ? cause
                : new Error(`injected shell provision crash: ${point}`);
              Object.assign(error, {
                phase0ShellProvisionCheckpoint: point,
              });
              throw error;
            }
          },
        });
      } catch (error) {
        if (isShellProvisionCheckpointCrash(error)) throw error;
        if (startedThreadId && !candidateRecorded) throw error;
        return ambiguous(
          startedThreadId
            ? "creator-session shell proof failed after candidate recording"
            : "thread start result is unknown and has no recorded candidate",
          error,
        );
      }
      if (
        !startedThreadId
        || creatorProof.threadId !== startedThreadId
        || creatorProof.cwd !== input.projectPath
        || creatorProof.title !== input.title
        || creatorProof.ephemeral !== false
        || !activationRequested
      ) {
        return ambiguous("creator-session persistent shell proof is invalid");
      }
      await options.shellProvisionPort.recordBootstrapReady({
        provisionId: intent.provisionId,
        threadId: creatorProof.threadId,
        activationRequested: true,
        fence: input.provisionFence,
      });
    }

    return materializePersistentShell({
      provisionId: intent.provisionId,
      candidateThreadId,
      projectPath: input.projectPath,
      title: input.title,
      fence: input.provisionFence,
      ambiguous,
      failMaterializationProof,
      expireProvisionDeadline,
    });
  }

  async function provisionPersistentShell(input: {
    projectPath: string;
    title: string;
  }): Promise<CodexPersistentShell> {
    const cwd = path.resolve(input.projectPath);
    const started = await options.shellControl.startPersistentThread({
      cwd,
      ephemeral: false,
    });
    await options.shellControl.setThreadName({
      threadId: started.threadId,
      name: input.title,
    });
    const shell = await options.shellControl.readPersistentShell(started.threadId);
    if (
      !shell
      || shell.ephemeral !== false
      || path.resolve(shell.cwd) !== cwd
      || shell.title !== input.title
    ) {
      throw new CodexDesktopBridgeError(
        "shell_provision_ambiguous",
        "persistent shell identity could not be proved after creation",
      );
    }
    return shell;
  }

  async function startFollowerWithRetry(
    input: CodexDesktopTurnRequest,
    attempt: CodexFollowerStartAttempt,
  ): Promise<{ turnId: string }> {
    const fenceDeadline = Date.parse(attempt.fence.deadlineAt);
    const deadline = Math.min(
      now() + readinessDeadlineMs,
      Number.isFinite(fenceDeadline) ? fenceDeadline : Number.NEGATIVE_INFINITY,
    );
    if (deadline <= now()) {
      throw new CodexDesktopBridgeError(
        "desktop_follower_not_ready",
        "Codex follower start fence deadline has elapsed",
      );
    }
    let delayMs = 250;
    await options.follower.openThreadDeepLink({
      url: `codex://threads/${input.threadId}`,
    });
    while (true) {
      let dispatchOrdinal: number;
      try {
        dispatchOrdinal = await options.startAttemptPort.claimDispatch({
          attemptId: attempt.attemptId,
          fence: attempt.fence,
        });
      } catch (error) {
        throw new CodexDesktopBridgeError(
          "desktop_follower_start_ambiguous",
          "Codex follower start attempt could not claim dispatch",
          { cause: error },
        );
      }
      tripFollowerStartFailpoint(
        options,
        "after_dispatch_cas_before_send",
      );
      try {
        const result = await options.follower.startFollowerTurn(input);
        if (result.status === "started") {
          tripFollowerStartFailpoint(options, "success_before_cas");
          await options.startAttemptPort.recordSuccess({
            attemptId: attempt.attemptId,
            dispatchOrdinal,
            turnId: result.turnId,
            fence: attempt.fence,
          });
          return { turnId: result.turnId };
        }
        await options.startAttemptPort.recordNoClientFound({
          attemptId: attempt.attemptId,
          dispatchOrdinal,
          fence: attempt.fence,
        });
      } catch (error) {
        if (phase0InjectedCrash(error)) throw error;
        tripFollowerStartFailpoint(options, "unknown_response");
        const raw = error instanceof Error
          ? `${error.name} ${error.message}`.toLowerCase()
          : String(error).toLowerCase();
        const reason = raw.includes("timeout") || raw.includes("timed out")
          ? "timeout" as const
          : raw.includes("disconnect")
              || raw.includes("closed")
              || (
                error instanceof CodexDesktopBridgeError
                && error.code === "desktop_bridge_unavailable"
              )
            ? "disconnect" as const
            : "unknown_response" as const;
        let recoveryFence: CodexFollowerStartRecoveryFence;
        try {
          await options.startAttemptPort.recordAmbiguous({
            attemptId: attempt.attemptId,
            dispatchOrdinal,
            reason,
            fence: attempt.fence,
          });
          recoveryFence = await options.startAttemptPort.claimReconciliation({
            attemptId: attempt.attemptId,
            ownerFence: attempt.fence,
          });
        } catch (checkpointError) {
          throw new CodexDesktopBridgeError(
            "desktop_follower_start_ambiguous",
            "Codex ambiguous follower start could not claim recovery",
            { cause: checkpointError },
          );
        }
        let adopted: CodexTurnSnapshot[] = [];
        let reconcileDelayMs = 250;
        while (true) {
          if (now() >= deadline) {
            await options.startAttemptPort.expireVisibility({
              attemptId: attempt.attemptId,
              dispatchOrdinal,
              fence: recoveryFence,
              code: "desktop_follower_start_ambiguous",
            });
            break;
          }
          try {
            const latest = await readWithDeadline(input.threadId);
            const baseline = new Set(attempt.preStartTurnIds);
            adopted = latest.turns.filter(
              (turn) =>
                !baseline.has(turn.turnId)
                && containsMarker(turn.items, attempt.correlationMarker)
                && turn.items.some(
                  (item) =>
                    item.kind === "user_message"
                    && typeof item.semantic.text === "string"
                    && createHash("sha256")
                      .update(item.semantic.text)
                      .digest("hex") === attempt.normalizedPromptHash,
                ),
            );
          } catch {
            adopted = [];
          }
          if (adopted.length > 1) {
            await options.startAttemptPort.quarantine({
              attemptId: attempt.attemptId,
              dispatchOrdinal,
              fence: recoveryFence,
              code: "desktop_follower_start_ambiguous",
              reason: "multiple_candidates",
            });
            break;
          }
          if (adopted.length === 1 && now() < deadline) break;
          await sleep(Math.max(
            0,
            Math.min(reconcileDelayMs, deadline - now()),
          ));
          reconcileDelayMs = Math.min(reconcileDelayMs * 2, 2_000);
        }
        if (adopted.length === 1) {
          const turnId = adopted[0]!.turnId;
          try {
            await options.startAttemptPort.adoptSuccess({
              attemptId: attempt.attemptId,
              dispatchOrdinal,
              turnId,
              fence: recoveryFence,
            });
            return { turnId };
          } catch {
            // The attempt no longer owns this dispatch checkpoint.
          }
        }
        throw new CodexDesktopBridgeError(
          "desktop_follower_start_ambiguous",
          adopted.length > 1
            ? "multiple correlated Codex turns require quarantine"
            : "Codex Desktop follower start result could not be uniquely reconciled",
          { cause: error },
        );
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new CodexDesktopBridgeError(
          "desktop_follower_not_ready",
          "Codex Desktop follower routing remained unavailable",
        );
      }
      await sleep(Math.min(delayMs, remaining));
      delayMs = Math.min(delayMs * 2, 1_000);
    }
  }

  async function readWithDeadline(
    threadId: string,
    outerDeadline = now() + readRpcDeadlineMs,
  ): Promise<{
    shell: CodexPersistentShell;
    turns: CodexTurnSnapshot[];
  }> {
    const deadline = Math.min(now() + readRpcDeadlineMs, outerDeadline);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, deadline - now()),
    );
    try {
      return await options.shellControl.readThreadWithTurns({
        threadId,
        includeTurns: true,
        deadlineAt: new Date(deadline).toISOString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function materializePersistentShell(input: {
    provisionId: string;
    candidateThreadId?: string;
    projectPath: string;
    title: string;
    fence: CodexShellProvisionFence;
    ambiguous: (reason: string, cause?: unknown) => Promise<never>;
    failMaterializationProof: () => Promise<never>;
    expireProvisionDeadline: () => Promise<never>;
  }): Promise<CodexPersistentShell> {
    const candidateThreadId = input.candidateThreadId;
    if (!candidateThreadId) {
      return input.ambiguous(
        "bootstrap-ready shell is missing its immutable candidate identity",
      );
    }
    const { logicalTurnId } =
      await options.shellProvisionPort.beginMaterialization({
        provisionId: input.provisionId,
        fence: input.fence,
      });
    const logical = await options.logicalTurnPort.readForStart(logicalTurnId);
    if (
      logical.role !== "shell_materialization"
      || logical.request.threadId !== candidateThreadId
      || logical.request.cwd !== input.projectPath
      || logical.request.approvalPolicy !== "never"
      || logical.request.sandboxMode !== "read-only"
      || logical.fence.purpose !== "shell_materialization"
    ) {
      return input.ambiguous(
        "shell materialization logical-turn contract is inconsistent",
      );
    }

    let attempt = await options.startAttemptPort.inspectByLogicalTurn(
      logicalTurnId,
    );
    if (!attempt) {
      const attemptId = randomUUID();
      const prepared = await options.startAttemptPort.prepare({
        attemptId,
        logicalTurnId,
      });
      attempt = {
        attemptId,
        logicalTurnId,
        request: prepared.requestWithMarker,
        fence: prepared.fence,
        originalDeadlineAt: prepared.fence.deadlineAt,
        correlationMarker: prepared.correlationMarker,
        normalizedPromptHash: prepared.normalizedPromptHash,
        preStartTurnIds: prepared.preStartTurnIds,
        preStartSemanticHash: prepared.preStartSemanticHash,
        state: "prepared",
        dispatchOrdinal: 0,
      };
    }
    assertRecoveryRequestIntegrity(attempt, logical);

    if (
      attempt.state === "prepared"
      || attempt.state === "no_client_found"
    ) {
      if (!sameStartFence(attempt.fence, logical.fence)) {
        await options.startAttemptPort.claimSafeAttemptForWorker({
          attemptId: attempt.attemptId,
          expectedState: attempt.state,
          expectedOldFence: attempt.fence,
          newFence: logical.fence,
        });
        const handedOff = await options.startAttemptPort.inspect(
          attempt.attemptId,
        );
        if (!handedOff) {
          return input.ambiguous(
            "shell materialization attempt handoff disappeared",
          );
        }
        attempt = handedOff;
      }
      const started = await startFollowerWithRetry(attempt.request, attempt);
      attempt = await options.startAttemptPort.inspect(attempt.attemptId);
      if (!attempt || attempt.turnId !== started.turnId) {
        return input.ambiguous(
          "shell materialization success was not durably recorded",
        );
      }
    } else if (
      attempt.state === "dispatching"
      || attempt.state === "ambiguous"
    ) {
      let recoveryFence = attempt.recoveryFence
        && sameStartFence(
          attempt.recoveryFence.ownerFence,
          logical.fence,
        )
        ? attempt.recoveryFence
        : undefined;
      if (
        attempt.state === "dispatching"
        && sameStartFence(attempt.fence, logical.fence)
      ) {
        await options.startAttemptPort.recordAmbiguous({
          attemptId: attempt.attemptId,
          dispatchOrdinal: attempt.dispatchOrdinal,
          reason: "unknown_response",
          fence: attempt.fence,
        });
      }
      recoveryFence ??=
        await options.startAttemptPort.claimReconciliation({
          attemptId: attempt.attemptId,
          ownerFence: logical.fence,
        });
      const deadline = Math.min(
        Date.parse(attempt.originalDeadlineAt),
        now() + readinessDeadlineMs,
      );
      let delayMs = 25;
      while (true) {
        const candidates = await correlatedRecoveryCandidates(attempt)
          .catch(() => []);
        if (candidates.length > 1) {
          await options.startAttemptPort.quarantine({
            attemptId: attempt.attemptId,
            dispatchOrdinal: attempt.dispatchOrdinal,
            code: "desktop_follower_start_ambiguous",
            reason: "multiple_candidates",
            fence: recoveryFence,
          });
          return input.ambiguous(
            "multiple shell materialization turns require quarantine",
          );
        }
        if (candidates.length === 1) {
          await options.startAttemptPort.adoptSuccess({
            attemptId: attempt.attemptId,
            dispatchOrdinal: attempt.dispatchOrdinal,
            turnId: candidates[0]!.turnId,
            fence: recoveryFence,
          });
          attempt = await options.startAttemptPort.inspect(attempt.attemptId);
          break;
        }
        if (now() >= deadline) {
          await options.startAttemptPort.expireVisibility({
            attemptId: attempt.attemptId,
            dispatchOrdinal: attempt.dispatchOrdinal,
            code: "desktop_follower_start_ambiguous",
            fence: recoveryFence,
          });
          return input.ambiguous(
            "shell materialization result could not be uniquely reconciled",
          );
        }
        await sleep(Math.min(delayMs, deadline - now()));
        delayMs = Math.min(delayMs * 2, 250);
      }
    }
    if (
      !attempt
      || attempt.state !== "succeeded"
      || !attempt.turnId
    ) {
      return input.ambiguous(
        attempt?.state === "quarantined"
          ? "shell materialization attempt is quarantined"
          : "shell materialization attempt is not durably successful",
      );
    }

    const proofStartedAt = now();
    const leaseDeadline = Date.parse(input.fence.leaseExpiresAt);
    const readinessProofDeadline = proofStartedAt + readinessDeadlineMs;
    const immutableProvisionDeadline = Date.parse(
      input.fence.deadlineAt ?? input.fence.leaseExpiresAt,
    );
    const proofDeadline = Math.min(
      leaseDeadline,
      readinessProofDeadline,
    );
    let delayMs = 25;
    while (true) {
      let provedShell: CodexPersistentShell | undefined;
      try {
        const durableRead: {
          shell: CodexPersistentShell;
          turns: CodexTurnSnapshot[];
        } = await readWithDeadline(candidateThreadId, proofDeadline);
        const listed: CodexPersistentShell[] =
          await options.shellControl.listPersistentShells({
            cwd: input.projectPath,
          });
        const listedMatches = listed.filter(
          ({ threadId }) => threadId === candidateThreadId,
        );
        const matchingTurns = durableRead.turns.filter(
          ({ turnId }) => turnId === attempt!.turnId,
        );
        const turn = matchingTurns[0];
        const exactTurn = matchingTurns.length === 1
          && turn
          && turn.threadId === candidateThreadId
          && turn.status === "completed"
          && turn.terminal?.output === "STAGEPASS_SHELL_MATERIALIZED"
          && !turn.items.some((item) =>
            item.kind === "command_execution"
            || item.kind === "tool_call"
            || item.kind === "file_change"
            || item.kind === "error")
          && containsMarker(turn.items, attempt.correlationMarker)
          && turn.items.some(
            (item) =>
              item.kind === "user_message"
              && createHash("sha256")
                .update(item.semantic.text)
                .digest("hex") === attempt!.normalizedPromptHash,
          );
        if (
          durableRead.shell.threadId === candidateThreadId
          && durableRead.shell.title === input.title
          && durableRead.shell.cwd === input.projectPath
          && durableRead.shell.ephemeral === false
          && listedMatches.length === 1
          && listedMatches[0]!.title === input.title
          && listedMatches[0]!.cwd === input.projectPath
          && listedMatches[0]!.ephemeral === false
          && exactTurn
        ) {
          provedShell = durableRead.shell;
        }
      } catch {
        // A just-materialized shell may lag on a new app-server session.
      }
      if (provedShell) {
        await options.shellProvisionPort.finalizeDurableReady({
          provisionId: input.provisionId,
          threadId: candidateThreadId,
          logicalTurnId,
          attemptId: attempt.attemptId,
          turnId: attempt.turnId,
          correlationMarker: attempt.correlationMarker,
          fence: input.fence,
        });
        return provedShell;
      }
      if (now() >= proofDeadline) {
        if (leaseDeadline <= readinessProofDeadline) {
          if (now() >= immutableProvisionDeadline) {
            return input.expireProvisionDeadline();
          }
          throw new CodexDesktopBridgeError(
            "shell_provision_ambiguous",
            "shell materialization lease expired; fenced takeover is required",
          );
        }
        return input.failMaterializationProof();
      }
      await sleep(Math.min(delayMs, proofDeadline - now()));
      delayMs = Math.min(delayMs * 2, 250);
    }
  }

  async function* pollTurn(input: {
    threadId: string;
    turnId: string;
    afterCursor?: number;
    lastSnapshotHash?: string;
    lastNormalizedSnapshot?: CodexTurnSnapshot;
    deadlineAt: string;
  }): AsyncIterable<CodexTurnPollResult> {
    const deadline = Date.parse(input.deadlineAt);
    if (!Number.isFinite(deadline)) {
      throw new CodexDesktopBridgeError(
        "turn_observation_timeout",
        "Codex turn observation deadline is invalid",
      );
    }
    let cursor = input.afterCursor ?? 0;
    let lastHash = input.lastSnapshotHash;
    let previous = input.lastNormalizedSnapshot;
    if ((lastHash === undefined) !== (previous === undefined)) {
      throw new CodexDesktopBridgeError(
        "turn_snapshot_invalid",
        "Codex poll resume requires both normalized snapshot and hash",
      );
    }
    if (previous) {
      if (
        previous.threadId !== input.threadId
        || previous.turnId !== input.turnId
        || snapshotHash(previous) !== lastHash
      ) {
        throw new CodexDesktopBridgeError(
          "turn_snapshot_invalid",
          "Codex poll resume snapshot does not match its identity or hash",
        );
      }
      snapshotItemIds(previous);
    }
    let pollDelayMs = 500;
    let outageStartedAt: number | undefined;
    let outageDelayMs = 250;

    async function confirmTerminalSnapshot(hash: string): Promise<void> {
      const outageStarted = now();
      let delayMs = 250;
      while (true) {
        try {
          const confirmation = await readWithDeadline(
            input.threadId,
            deadline,
          );
          const confirmed = confirmation.turns.find(
            (turn) => turn.turnId === input.turnId,
          );
          if (!confirmed || snapshotHash(confirmed) !== hash) {
            throw new CodexDesktopBridgeError(
              "turn_snapshot_invalid",
              "Codex terminal snapshot changed after observation",
            );
          }
          return;
        } catch (error) {
          if (error instanceof CodexDesktopBridgeError) throw error;
          if (now() - outageStarted >= readOutageBudgetMs) {
            throw new CodexDesktopBridgeError(
              "app_server_turn_observation_lost",
              "Codex terminal confirmation could not reconnect",
              { cause: error },
            );
          }
          if (now() >= deadline) {
            throw new CodexDesktopBridgeError(
              "turn_observation_timeout",
              "Codex turn observation deadline elapsed",
            );
          }
          await sleep(Math.min(delayMs, deadline - now()));
          delayMs = Math.min(delayMs * 2, 2_000);
        }
      }
    }

    while (true) {
      if (now() >= deadline) {
        throw new CodexDesktopBridgeError(
          "turn_observation_timeout",
          "Codex turn observation deadline elapsed",
        );
      }
      let result;
      try {
        result = await readWithDeadline(input.threadId, deadline);
        outageStartedAt = undefined;
        outageDelayMs = 250;
      } catch (error) {
        outageStartedAt ??= now();
        if (now() - outageStartedAt >= readOutageBudgetMs) {
          throw new CodexDesktopBridgeError(
            "app_server_turn_observation_lost",
            "Codex app-server turn observation could not reconnect",
            { cause: error },
          );
        }
        const remaining = deadline - now();
        if (remaining <= 0) continue;
        await sleep(Math.min(outageDelayMs, remaining));
        outageDelayMs = Math.min(outageDelayMs * 2, 2_000);
        continue;
      }

      const snapshot = result.turns.find(
        (turn) => turn.turnId === input.turnId,
      );
      if (snapshot) {
        if (
          snapshot.threadId !== input.threadId
          || snapshot.turnId !== input.turnId
        ) {
          throw new CodexDesktopBridgeError(
            "turn_snapshot_invalid",
            "Codex turn snapshot belongs to another thread or turn",
          );
        }
        snapshotItemIds(snapshot);
        const hash = snapshotHash(snapshot);
        if (hash !== lastHash) {
          assertSnapshotTransition(previous, snapshot);
          if (terminal(snapshot.status)) {
            await confirmTerminalSnapshot(hash);
          }
          const previousCursor = cursor;
          cursor = await allocateCursor(previousCursor);
          if (!Number.isSafeInteger(cursor) || cursor <= previousCursor) {
            throw new CodexDesktopBridgeError(
              "turn_snapshot_invalid",
              "Codex observation cursor allocator returned an invalid value",
            );
          }
          previous = snapshot;
          lastHash = hash;
          yield {
            kind: "observation",
            cursor,
            semanticSnapshotHash: hash,
            snapshot,
          };
          pollDelayMs = 500;
          if (terminal(snapshot.status)) return;
        } else {
          if (terminal(snapshot.status)) return;
          pollDelayMs = Math.min(pollDelayMs * 2, 2_000);
        }
      } else {
        yield {
          kind: "turn_not_yet_visible",
          threadId: input.threadId,
          turnId: input.turnId,
          observedAt: new Date(now()).toISOString(),
        };
        pollDelayMs = Math.min(pollDelayMs * 2, 2_000);
      }
      await sleep(Math.min(pollDelayMs, Math.max(0, deadline - now())));
    }
  }

  async function correlatedRecoveryCandidates(
    attempt: CodexFollowerStartAttempt,
  ): Promise<CodexTurnSnapshot[]> {
    const latest = await readWithDeadline(attempt.request.threadId);
    const baseline = new Set(attempt.preStartTurnIds);
    return latest.turns.filter(
      (turn) =>
        !baseline.has(turn.turnId)
        && containsMarker(turn.items, attempt.correlationMarker)
        && turn.items.some(
          (item) =>
            item.kind === "user_message"
            && typeof item.semantic.text === "string"
            && createHash("sha256")
              .update(item.semantic.text)
              .digest("hex") === attempt.normalizedPromptHash,
        ),
    );
  }

  function assertRecoveryRequestIntegrity(
    attempt: CodexFollowerStartAttempt,
    logical: CodexLogicalTurnStartContext,
  ): void {
    const expected = {
      ...logical.request,
      prompt: `${logical.request.prompt}\n\n${attempt.correlationMarker}`,
    };
    if (
      JSON.stringify(canonicalize(attempt.request))
        !== JSON.stringify(canonicalize(expected))
      || createHash("sha256").update(attempt.request.prompt).digest("hex")
        !== attempt.normalizedPromptHash
      || attempt.request.threadId !== logical.request.threadId
      || attempt.request.cwd !== logical.request.cwd
      || attempt.request.model !== logical.request.model
      || attempt.request.reasoningEffort !== logical.request.reasoningEffort
      || attempt.request.approvalPolicy !== logical.request.approvalPolicy
      || attempt.request.sandboxMode !== logical.request.sandboxMode
      || attempt.preStartSemanticHash.length === 0
      || new Set(attempt.preStartTurnIds).size
        !== attempt.preStartTurnIds.length
    ) {
      throw new CodexDesktopBridgeError(
        "desktop_follower_start_ambiguous",
        "durable recovery request or baseline is inconsistent",
      );
    }
  }

  return {
    probe,
    provisionPersistentShell,
    findPersistentShells: ({ projectPath, title }) =>
      options.shellControl.findPersistentShell({
        cwd: path.resolve(projectPath),
        title,
      }),
    readPersistentShell: (threadId) =>
      options.shellControl.readPersistentShell(threadId),
    ensurePersistentShell,
    async startTurn(input) {
      let logical: CodexLogicalTurnStartContext;
      try {
        logical = await options.logicalTurnPort.readForStart(
          input.logicalTurnId,
        );
      } catch (error) {
        throw new CodexDesktopBridgeError(
          "desktop_follower_start_ambiguous",
          "server-owned logical turn context could not be loaded",
          { cause: error },
        );
      }
      if (
        logical.logicalTurnId !== input.logicalTurnId
        || logical.fence.logicalTurnId !== logical.logicalTurnId
        || stableOwner(logical.fence.owner) !== stableOwner(logical.owner)
        || logical.fence.projectId !== logical.projectId
        || logical.fence.scopeKind !== logical.scopeKind
        || logical.fence.scopeId !== logical.scopeId
        || logical.fence.dispatchSurface !== logical.dispatchSurface
      ) {
        throw new CodexDesktopBridgeError(
          "desktop_follower_start_ambiguous",
          "server-owned logical turn context is inconsistent",
        );
      }
      if (logical.dispatchSurface !== "follower_ipc") {
        throw new CodexDesktopBridgeError(
          "desktop_protocol_invalid",
          "logical turn is not dispatchable through Desktop follower IPC",
        );
      }
      validateTurnRequestShape(logical.request);
      await probe();
      if (logical.request.model) {
        const models = await options.shellControl.listModels();
        const selected = models.find(
          (model) => model.model === logical.request.model,
        );
        if (
          !selected
          || (
            logical.request.reasoningEffort !== undefined
            && !selected.supportedReasoningEfforts?.includes(
              logical.request.reasoningEffort,
            )
          )
        ) {
          throw new CodexDesktopBridgeError(
            "desktop_protocol_invalid",
            "requested model or reasoning effort is not in the observed catalog",
          );
        }
      }
      const attemptId = randomUUID();
      let prepared: Awaited<
        ReturnType<CodexFollowerStartAttemptPort["prepare"]>
      >;
      try {
        prepared = await options.startAttemptPort.prepare({
          attemptId,
          logicalTurnId: logical.logicalTurnId,
        });
      } catch (error) {
        throw new CodexDesktopBridgeError(
          "desktop_follower_start_ambiguous",
          "logical turn already has an active follower-start attempt",
          { cause: error },
        );
      }
      const attempt: CodexFollowerStartAttempt = {
        attemptId,
        logicalTurnId: logical.logicalTurnId,
        request: prepared.requestWithMarker,
        fence: prepared.fence,
        originalDeadlineAt: prepared.fence.deadlineAt,
        correlationMarker: prepared.correlationMarker,
        normalizedPromptHash: prepared.normalizedPromptHash,
        preStartTurnIds: prepared.preStartTurnIds,
        preStartSemanticHash: prepared.preStartSemanticHash,
        state: "prepared",
        dispatchOrdinal: 0,
      };
      const started = await startFollowerWithRetry(
        prepared.requestWithMarker,
        attempt,
      );
      return { attemptId, turnId: started.turnId };
    },
    async recoverTurn(input) {
      const logical = await options.logicalTurnPort.readForStart(
        input.logicalTurnId,
      ).catch((error) => {
        throw new CodexDesktopBridgeError(
          "desktop_follower_start_ambiguous",
          "server-owned logical turn context could not be loaded for recovery",
          { cause: error },
        );
      });
      const attempt = await options.startAttemptPort.inspectByLogicalTurn(
        input.logicalTurnId,
      );
      const ownerFence = logical.fence;
      if (
        !attempt
        || attempt.logicalTurnId !== input.logicalTurnId
        || logical.logicalTurnId !== input.logicalTurnId
        || ownerFence.logicalTurnId !== input.logicalTurnId
        || stableOwner(attempt.fence.owner) !== stableOwner(ownerFence.owner)
        || attempt.fence.projectId !== ownerFence.projectId
        || attempt.fence.scopeKind !== ownerFence.scopeKind
        || attempt.fence.scopeId !== ownerFence.scopeId
        || attempt.fence.purpose !== ownerFence.purpose
        || attempt.fence.dispatchSurface !== ownerFence.dispatchSurface
        || Date.parse(ownerFence.deadlineAt)
          > Date.parse(attempt.originalDeadlineAt)
        || Date.parse(ownerFence.leaseExpiresAt)
          > Date.parse(attempt.originalDeadlineAt)
      ) {
        throw new CodexDesktopBridgeError(
          "desktop_follower_start_ambiguous",
          "durable follower-start recovery identity is inconsistent",
        );
      }
      assertRecoveryRequestIntegrity(attempt, logical);
      if (attempt.state === "succeeded") {
        return {
          attemptId: attempt.attemptId,
          state: "succeeded",
          turnId: attempt.turnId,
        };
      }
      if (attempt.state === "quarantined") {
        return { attemptId: attempt.attemptId, state: "quarantined" };
      }
      if (
        attempt.state === "prepared"
        || attempt.state === "no_client_found"
      ) {
        if (!sameStartFence(attempt.fence, ownerFence)) {
          await options.startAttemptPort.claimSafeAttemptForWorker({
            attemptId: attempt.attemptId,
            expectedState: attempt.state,
            expectedOldFence: attempt.fence,
            newFence: ownerFence,
          });
        }
        const recovered = await options.startAttemptPort.inspect(
          attempt.attemptId,
        );
        if (
          !recovered
          || (
            recovered.state !== "prepared"
            && recovered.state !== "no_client_found"
          )
        ) {
          throw new CodexDesktopBridgeError(
            "desktop_follower_start_ambiguous",
            "safe follower-start recovery state changed",
          );
        }
        const started = await startFollowerWithRetry(
          recovered.request,
          recovered,
        );
        return {
          attemptId: recovered.attemptId,
          state: "succeeded",
          turnId: started.turnId,
        };
      }

      let recoveryFence: CodexFollowerStartRecoveryFence;
      try {
        recoveryFence = attempt.recoveryFence
          && sameStartFence(attempt.recoveryFence.ownerFence, ownerFence)
          ? attempt.recoveryFence
          : await options.startAttemptPort.claimReconciliation({
            attemptId: attempt.attemptId,
            ownerFence,
          });
      } catch (error) {
        throw new CodexDesktopBridgeError(
          "desktop_follower_start_ambiguous",
          "ambiguous follower start could not claim recovery",
          { cause: error },
        );
      }
      const immutableDeadline = Date.parse(attempt.originalDeadlineAt);
      const recoveryDeadline = Math.min(
        immutableDeadline,
        Date.parse(ownerFence.deadlineAt),
        Date.parse(ownerFence.leaseExpiresAt),
      );
      let delayMs = 25;
      while (true) {
        if (now() >= recoveryDeadline) {
          await options.startAttemptPort.expireVisibility({
            attemptId: attempt.attemptId,
            dispatchOrdinal: attempt.dispatchOrdinal,
            fence: recoveryFence,
            code: "desktop_follower_start_ambiguous",
          });
          return { attemptId: attempt.attemptId, state: "quarantined" };
        }
        const candidates = await correlatedRecoveryCandidates(attempt)
          .catch(() => []);
        if (candidates.length === 1 && now() < recoveryDeadline) {
          await options.startAttemptPort.adoptSuccess({
            attemptId: attempt.attemptId,
            dispatchOrdinal: attempt.dispatchOrdinal,
            turnId: candidates[0]!.turnId,
            fence: recoveryFence,
          });
          return {
            attemptId: attempt.attemptId,
            state: "succeeded",
            turnId: candidates[0]!.turnId,
          };
        }
        if (candidates.length > 1) {
          await options.startAttemptPort.quarantine({
            attemptId: attempt.attemptId,
            dispatchOrdinal: attempt.dispatchOrdinal,
            fence: recoveryFence,
            code: "desktop_follower_start_ambiguous",
            reason: "multiple_candidates",
          });
          return { attemptId: attempt.attemptId, state: "quarantined" };
        }
        await sleep(Math.min(delayMs, recoveryDeadline - now()));
        delayMs = Math.min(delayMs * 2, 250);
      }
    },
    async interruptTurn(input) {
      try {
        await options.follower.interruptTurn(input);
      } catch (error) {
        if (
          error instanceof CodexDesktopFollowerRoutingError
          && error.code === "thread-detached"
        ) {
          throw detached("Codex Desktop interrupt target is detached");
        }
        throw error;
      }
    },
    pollTurn,
  };
}
