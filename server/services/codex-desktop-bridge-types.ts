const FOLLOWER_START_CAPABILITY = [
  "thread",
  "follower",
  "start",
  "turn",
].join("-");

export const REQUIRED_APP_SERVER_SHELL_CAPABILITIES = [
  "thread/start:persistent",
  "thread/name/set",
  "thread/read:includeTurns",
  "thread/list",
  "model/list",
] as const;

export const REQUIRED_DESKTOP_FOLLOWER_CAPABILITIES = [
  "deep-link:codex-thread",
  FOLLOWER_START_CAPABILITY,
  "turn/interrupt",
  "project/alternate-cwd",
] as const;

export const REQUIRED_PHASE0_MCP_HOST_EVIDENCE = [
  "app/source-thread-attestation",
  "app/protected-submit-channel",
  "ui-message/same-thread",
] as const;

export interface CodexDesktopProbe {
  appServerVersion: string;
  appServerProtocolFingerprint: string;
  desktopClientVersion: string;
  desktopFollowerProtocolFingerprint: string;
  shellCapabilities: string[];
  followerCapabilities: string[];
  shellProtocolCapabilities: string[];
  followerProtocolCapabilities: string[];
}

export interface CodexPhase0McpHostEvidence {
  verifiedBy: "real-mcp-fixture";
  checks: Record<
    (typeof REQUIRED_PHASE0_MCP_HOST_EVIDENCE)[number],
    "passed"
  >;
  hostFingerprint: string;
  verifiedAt: string;
}

export interface CodexPersistentShell {
  threadId: string;
  title: string;
  cwd: string;
  ephemeral: false;
}

/**
 * A thread another thread spawned as a sub-agent.
 *
 * The app-server writes `parentThreadId`, so this is the one record of a spawn
 * that the spawning agent cannot fabricate.
 *
 * `agentPath` and `agentRole` are both routinely NULL here even when the spawn
 * named a task -- observed on a real round whose two sides carried only
 * auto-generated nicknames ("Linnaeus", "Raman"). So a side's ROLE cannot be
 * read off this record, and the round works out which child is which from
 * evidence instead: whose turn window contains which output file's write time.
 */
export interface CodexSubAgentThread {
  threadId: string;
  parentThreadId: string;
  agentNickname: string | null;
  agentRole: string | null;
}

export interface CodexShellProvisionFence {
  ownerId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  deadlineAt?: string;
  ownerAttempt?: number;
  ownerEpoch?: number;
}

export interface CodexShellProvisionIntent {
  provisionId: string;
  cwd: string;
  title: string;
  baselineThreadIds: string[];
  state:
    | "provisioning"
    | "bootstrap_ready"
    | "materializing"
    | "durable_ready"
    | "ambiguous";
  created: boolean;
  candidateThreadId?: string;
  materializationLogicalTurnId?: string;
  threadId?: string;
  ambiguousReason?: string;
}

export interface CodexShellProvisionPort {
  claim(input: {
    scope: CodexManagedScope;
    cwd: string;
    title: string;
    baselineThreadIds: string[];
    fence: CodexShellProvisionFence;
  }): Promise<CodexShellProvisionIntent>;
  recordCandidate(input: {
    provisionId: string;
    threadId: string;
    fence: CodexShellProvisionFence;
  }): Promise<void>;
  recordBootstrapReady(input: {
    provisionId: string;
    threadId: string;
    activationRequested: boolean;
    fence: CodexShellProvisionFence;
  }): Promise<void>;
  beginMaterialization(input: {
    provisionId: string;
    fence: CodexShellProvisionFence;
  }): Promise<{ logicalTurnId: string }>;
  finalizeDurableReady(input: {
    provisionId: string;
    threadId: string;
    logicalTurnId: string;
    attemptId: string;
    turnId: string;
    correlationMarker: string;
    fence: CodexShellProvisionFence;
  }): Promise<void>;
  failMaterializationProof(input: {
    provisionId: string;
    reason: string;
    fence: CodexShellProvisionFence;
  }): Promise<void>;
  markAmbiguous(input: {
    provisionId: string;
    reason: string;
    fence: CodexShellProvisionFence;
  }): Promise<void>;
  expireProvisionVisibility(input: {
    provisionId: string;
    fence: CodexShellProvisionFence;
  }): Promise<void>;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export interface CodexDesktopTurnRequest {
  threadId: string;
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  approvalPolicy: "never";
  sandboxMode: "read-only" | "workspace-write";
  /**
   * A JSON Schema the runtime enforces on this turn's final assistant message.
   *
   * The server owns the schema; the model only fills it in. Verified against a
   * real app-server: a turn asked for free prose came back as a document
   * matching the schema exactly, so this is enforcement and not a hint.
   *
   * Only the ROOT turn can carry one -- `spawn_agent` has no equivalent
   * parameter, so a sub-agent's schema must travel in its prompt and be
   * validated server-side instead (server-owned-json-output.ts).
   */
  outputSchema?: Record<string, unknown>;
  /**
   * Which tools this turn may see, derived from its role's output contract.
   *
   * It travels on the request rather than being looked up by the transport
   * because the role is known only to the logical turn, and the transport must
   * not have to re-derive a decision the contract table already made. Absent
   * means the full surface -- the behaviour before contracts existed.
   */
  toolSurface?: "full" | "no-stagepass-plugins";
}

export type CodexManagedOwner =
  | { kind: "pipeline_job"; pipelineJobId: string }
  | { kind: "project_ai_run"; projectAiRunId: string };

export type CodexManagedScope =
  | {
      kind: "change";
      scopeId: string;
      projectId: string;
      changeId: string;
    }
  | {
      /**
       * One Codex task per stage. A change-wide task made every stage share
       * one conversation, so a stage could not tell whether it had started
       * yet and each one inherited the previous stage's context.
       */
      kind: "change_stage";
      scopeId: string;
      projectId: string;
      changeId: string;
      stageId: string;
    }
  | { kind: "project_prd"; scopeId: string; projectId: string }
  | { kind: "project_context"; scopeId: string; projectId: string };

/** The scope id a stage-scoped binding is keyed by. */
export function changeStageScopeId(changeId: string, stageId: string): string {
  return `${changeId}:${stageId}`;
}

export function changeStageScope(input: {
  changeId: string;
  projectId: string;
  stageId: string;
}): CodexManagedScope {
  return {
    kind: "change_stage",
    scopeId: changeStageScopeId(input.changeId, input.stageId),
    projectId: input.projectId,
    changeId: input.changeId,
    stageId: input.stageId,
  };
}

export interface CodexFollowerStartFence {
  logicalTurnId: string;
  owner: CodexManagedOwner;
  projectId: string;
  scopeKind: CodexManagedScope["kind"];
  scopeId: string;
  workerId: string;
  leaseToken: string;
  ownerAttempt: number;
  ownerEpoch: number;
  dispatchSurface: Exclude<CodexDispatchSurface, "app_server_control">;
  purpose:
    | "shell_materialization"
    | "stage_run"
    | "interaction_present"
    | "interaction_wakeup";
  deadlineAt: string;
  leaseExpiresAt: string;
}

export type CodexLogicalTurnRole =
  | "shell_materialization"
  | "stage"
  | "spec_writer"
  | "spec_critic"
  | "spec_verdict"
  /**
   * The delegated Spec round: one turn whose agent judges, and whose red and
   * blue are sub-agents it spawns rather than turns the server dispatches.
   */
  | "spec_judge"
  /**
   * The delegated round's judge, for every phase that runs one. `spec_judge`
   * stays valid because rows already carry it; new rounds use this.
   */
  | "delegated_round_judge"
  | "build"
  | "fix"
  | "prd_turn"
  | "context_select"
  | "context_generate"
  | "interaction_present"
  | "interaction_wakeup";

export type CodexDispatchSurface =
  | "app_server_control"
  | "follower_ipc"
  | "host_ui_message";

export function dispatchSurfaceForRole(
  role: CodexLogicalTurnRole,
): Exclude<CodexDispatchSurface, "app_server_control"> {
  switch (role) {
    case "interaction_wakeup":
      return "host_ui_message";
    case "shell_materialization":
    case "stage":
    case "spec_writer":
    case "spec_critic":
    case "spec_verdict":
    case "spec_judge":
    case "delegated_round_judge":
    case "build":
    case "fix":
    case "prd_turn":
    case "context_select":
    case "context_generate":
    case "interaction_present":
      return "follower_ipc";
  }
}

export interface CodexLogicalTurnIdentity {
  logicalTurnId: string;
  owner: CodexManagedOwner;
  projectId: string;
  scopeKind: CodexManagedScope["kind"];
  scopeId: string;
  phase: string;
  role: CodexLogicalTurnRole;
  round: number;
  ordinal: number;
  turnSlot: string;
  runCorrelationId: string;
  dispatchSurface: Exclude<CodexDispatchSurface, "app_server_control">;
}

export interface CodexLogicalTurnStartContext
  extends CodexLogicalTurnIdentity {
  request: CodexDesktopTurnRequest;
  fence: CodexFollowerStartFence;
}

export interface CodexLogicalTurnPort {
  resolve(input: {
    owner: CodexManagedOwner;
    projectId: string;
    scopeKind: CodexManagedScope["kind"];
    scopeId: string;
    phase: string;
    role: CodexLogicalTurnRole;
    round: number;
    ordinal: number;
  }): Promise<CodexLogicalTurnIdentity>;
  readForStart(logicalTurnId: string): Promise<CodexLogicalTurnStartContext>;
}

type CodexItemMetadata = {
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
};

export type NormalizedCodexTurnItem =
  | {
    id: string;
    kind: "user_message";
    semantic: { text: string };
    metadata?: CodexItemMetadata;
  }
  | {
    id: string;
    kind: "agent_message";
    semantic: { text: string };
    metadata?: CodexItemMetadata;
  }
  | {
    id: string;
    kind: "command_execution";
    semantic: {
      command: string;
      status: "running" | "completed" | "failed";
      exitCode: number | null;
      output: string | null;
    };
    metadata?: CodexItemMetadata;
  }
  | {
    id: string;
    kind: "tool_call";
    semantic: {
      name: string;
      status: "running" | "completed" | "failed";
      result: string | null;
    };
    metadata?: CodexItemMetadata;
  }
  | {
    id: string;
    kind: "file_change";
    semantic: {
      path: string;
      change: "added" | "modified" | "deleted";
    };
    metadata?: CodexItemMetadata;
  }
  | {
    id: string;
    /**
     * A sub-agent this turn really started, as reported by the app-server.
     *
     * The only trustworthy record that a delegated side exists. A failed spawn
     * is silent and the main agent answers in the sub-agent's place, so "红方跑
     * 过了" may never be taken from the main agent's own text -- it is taken
     * from here, and the side's output is then read off `agentThreadId`, a
     * thread the main agent cannot forge.
     */
    kind: "sub_agent_activity";
    semantic: {
      activity: "started" | "interacted" | "interrupted";
      agentThreadId: string;
      agentPath: string;
    };
    metadata?: CodexItemMetadata;
  }
  | {
    id: string;
    kind: "error";
    semantic: { code: string; message: string };
    metadata?: CodexItemMetadata;
  };

export interface CodexTurnSnapshot {
  threadId: string;
  turnId: string;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  items: NormalizedCodexTurnItem[];
  terminal?: {
    output?: string;
    errorCode?: string;
    errorMessage?: string;
  };
  metadata: {
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    observedAt: string;
  };
}

export interface CodexTurnObservation {
  kind: "observation";
  cursor: number;
  semanticSnapshotHash: string;
  snapshot: CodexTurnSnapshot;
}

export type CodexTurnPollResult =
  | CodexTurnObservation
  | {
    kind: "turn_not_yet_visible";
    threadId: string;
    turnId: string;
    observedAt: string;
  };

export type CodexFollowerStartAttemptState =
  | "prepared"
  | "dispatching"
  | "no_client_found"
  | "ambiguous"
  | "succeeded"
  | "quarantined";

export interface CodexFollowerStartAttempt {
  attemptId: string;
  logicalTurnId: string;
  request: CodexDesktopTurnRequest;
  fence: CodexFollowerStartFence;
  originalDeadlineAt: string;
  correlationMarker: string;
  normalizedPromptHash: string;
  preStartTurnIds: string[];
  preStartSemanticHash: string;
  state: CodexFollowerStartAttemptState;
  dispatchOrdinal: number;
  turnId?: string;
  code?: "desktop_follower_start_ambiguous";
  ambiguousReason?:
    | "timeout"
    | "disconnect"
    | "unknown_response"
    | "visibility_timeout"
    | "multiple_candidates";
  recoveryFence?: CodexFollowerStartRecoveryFence;
}

export interface CodexFollowerStartRecoveryFence {
  ownerFence: CodexFollowerStartFence;
  recoveryLeaseToken: string;
  recoveryEpoch: number;
}

export interface CodexFollowerStartAttemptPort {
  inspect(attemptId: string): Promise<CodexFollowerStartAttempt | null>;
  inspectByLogicalTurn(
    logicalTurnId: string,
  ): Promise<CodexFollowerStartAttempt | null>;
  prepare(input: {
    attemptId: string;
    logicalTurnId: string;
  }): Promise<{
    attemptId: string;
    state: "prepared";
    fence: CodexFollowerStartFence;
    request: CodexDesktopTurnRequest;
    correlationMarker: string;
    normalizedPromptHash: string;
    requestWithMarker: CodexDesktopTurnRequest;
    preStartTurnIds: string[];
    preStartSemanticHash: string;
  }>;
  claimDispatch(input: {
    attemptId: string;
    fence: CodexFollowerStartFence;
  }): Promise<number>;
  claimSafeAttemptForWorker(input: {
    attemptId: string;
    expectedState: "prepared" | "no_client_found";
    expectedOldFence: CodexFollowerStartFence;
    newFence: CodexFollowerStartFence;
  }): Promise<void>;
  recordNoClientFound(input: {
    attemptId: string;
    dispatchOrdinal: number;
    fence: CodexFollowerStartFence;
  }): Promise<void>;
  recordSuccess(input: {
    attemptId: string;
    dispatchOrdinal: number;
    turnId: string;
    fence: CodexFollowerStartFence;
  }): Promise<void>;
  recordAmbiguous(input: {
    attemptId: string;
    dispatchOrdinal: number;
    reason: "timeout" | "disconnect" | "unknown_response";
    fence: CodexFollowerStartFence;
  }): Promise<void>;
  claimReconciliation(input: {
    attemptId: string;
    ownerFence: CodexFollowerStartFence;
  }): Promise<CodexFollowerStartRecoveryFence>;
  adoptSuccess(input: {
    attemptId: string;
    dispatchOrdinal: number;
    turnId: string;
    fence: CodexFollowerStartRecoveryFence;
  }): Promise<void>;
  quarantine(input: {
    attemptId: string;
    dispatchOrdinal: number;
    code: "desktop_follower_start_ambiguous";
    reason: "multiple_candidates";
    fence: CodexFollowerStartRecoveryFence;
  }): Promise<void>;
  expireVisibility(input: {
    attemptId: string;
    dispatchOrdinal: number;
    code: "desktop_follower_start_ambiguous";
    fence: CodexFollowerStartRecoveryFence;
  }): Promise<void>;
}
