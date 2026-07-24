import type {
  CodexFollowerStartAttempt,
  CodexShellProvisionFence,
  CodexTurnSnapshot,
} from "./codex-desktop-bridge-types.ts";
import type {
  CodexPhase0RestartCheckpoint,
} from "./codex-phase0-sqlite-journal.ts";

export const PHASE0_REPORT_SCHEMA_VERSION = 1;
export const PHASE0_STRICT_EVIDENCE_VERSION = 1;
export const PHASE0_RESTART_RESUME_OUTPUT =
  "PHASE0_RESTART_RESUME_OK.";

export const PHASE0_STRICT_EVIDENCE_KINDS = [
  "real_shell_materialization",
  "real_cross_process_failpoints",
  "real_visibility_lag",
  "real_snapshot_replay",
  "real_auth_negative_matrix",
  "real_durable_click",
] as const;

export type Phase0StrictEvidenceKind =
  (typeof PHASE0_STRICT_EVIDENCE_KINDS)[number];

export interface Phase0StrictEvidenceEntry {
  source: "real_client_verifier";
  satisfied: true;
  version: typeof PHASE0_STRICT_EVIDENCE_VERSION;
  facts: string[];
}

export type Phase0StrictEvidence =
  Partial<Record<Phase0StrictEvidenceKind, Phase0StrictEvidenceEntry>>;

export function assertExactCompletedOutput(
  snapshot: CodexTurnSnapshot,
  expectedOutput: string,
): void {
  if (
    snapshot.status !== "completed"
    || snapshot.terminal?.output !== expectedOutput
    || snapshot.terminal.errorCode !== undefined
    || snapshot.terminal.errorMessage !== undefined
  ) {
    throw new Error("Phase 0 turn did not produce the exact completed output");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validStrictEvidence(value: unknown): value is Phase0StrictEvidence {
  if (!record(value)) return false;
  const knownKinds = new Set<string>(PHASE0_STRICT_EVIDENCE_KINDS);
  return Object.entries(value).every(([kind, entry]) =>
    knownKinds.has(kind)
    && record(entry)
    && Object.keys(entry).length === 4
    && Object.hasOwn(entry, "source")
    && Object.hasOwn(entry, "satisfied")
    && Object.hasOwn(entry, "version")
    && Object.hasOwn(entry, "facts")
    && entry.source === "real_client_verifier"
    && entry.satisfied === true
    && entry.version === PHASE0_STRICT_EVIDENCE_VERSION
    && Array.isArray(entry.facts)
    && entry.facts.length > 0
    && entry.facts.every(
      (fact) => typeof fact === "string" && fact.length > 0,
    ));
}

export function validatePhase0ReportEnvelope(
  value: unknown,
  expected: {
    runId: string;
    registrationName: string;
    checks: ReadonlyArray<{ name: string; requiredEvidence: string }>;
  },
): asserts value is {
  phase: "phase0";
  schemaVersion: 1;
  runId: string;
  registrationName: string;
  strictEvidence: Phase0StrictEvidence;
  checks: Array<{
    name: string;
    requiredEvidence: string;
    status: "pending" | "passed" | "blocked" | "failed";
  }>;
} {
  const checks = record(value) && Array.isArray(value.checks)
    ? value.checks
    : null;
  const attemptEvidence =
    record(value) && Array.isArray(value.startAttemptEvidence)
      ? value.startAttemptEvidence
      : null;
  const validStatuses = new Set([
    "pending",
    "passed",
    "blocked",
    "failed",
  ]);
  const requiredArrays = [
    "actualStartAttempts",
    "startAttemptEvidence",
    "shellIds",
    "followerTurnIds",
    "deepLinkUrls",
    "provisioningActivationUrls",
    "followerDispatchEvidence",
    "failureCodes",
    "evidenceNotes",
  ] as const;
  const requiredRecords = [
    "protocol",
    "capabilities",
    "securityBoundary",
    "turnReadEvidence",
    "appServerMethodCounts",
    "desktopMethodCounts",
  ] as const;
  const validAttemptStates = new Set([
    "prepared",
    "dispatching",
    "no_client_found",
    "ambiguous",
    "succeeded",
    "quarantined",
  ]);
  const validRecoveryOutcomes = new Set([
    "started",
    "recovered_succeeded",
    "adopted",
    "quarantined",
  ]);
  const attemptEvidenceInvalid =
    !attemptEvidence
    || new Set(
      attemptEvidence.flatMap((entry) =>
        record(entry) && typeof entry.attemptId === "string"
          ? [entry.attemptId]
          : []),
    ).size !== attemptEvidence.length
    || attemptEvidence.some((entry) =>
      !record(entry)
      || typeof entry.logicalTurnId !== "string"
      || entry.logicalTurnId.length === 0
      || typeof entry.attemptId !== "string"
      || entry.attemptId.length === 0
      || !validAttemptStates.has(entry.state as string)
      || !Number.isSafeInteger(entry.dispatchOrdinal)
      || (entry.dispatchOrdinal as number) < 0
      || !Number.isSafeInteger(entry.baselineTurnCount)
      || !Array.isArray(entry.preStartTurnIds)
      || entry.preStartTurnIds.length !== entry.baselineTurnCount
      || entry.preStartTurnIds.some((id) => typeof id !== "string")
      || typeof entry.preStartSemanticHash !== "string"
      || entry.preStartSemanticHash.length === 0
      || typeof entry.normalizedPromptHash !== "string"
      || entry.normalizedPromptHash.length === 0
      || typeof entry.correlationMarker !== "string"
      || entry.correlationMarker.length === 0
      || (
        entry.turnId !== undefined
        && typeof entry.turnId !== "string"
      )
      || !validRecoveryOutcomes.has(entry.recoveryOutcome as string)
      || (
        entry.ambiguousReason !== undefined
        && typeof entry.ambiguousReason !== "string"
      )
      || (
        entry.correlatedTurnCount !== undefined
        && (
          !Number.isSafeInteger(entry.correlatedTurnCount)
          || (entry.correlatedTurnCount as number) < 0
        )
      )
      || (
        entry.outcome !== undefined
        && !["started", "no-client-found", "ambiguous"].includes(
          entry.outcome as string,
        )
      ))
  ;
  if (
    !record(value)
    || value.phase !== "phase0"
    || value.schemaVersion !== PHASE0_REPORT_SCHEMA_VERSION
    || value.runId !== expected.runId
    || value.registrationName !== expected.registrationName
    || !["BLOCKED", "FAILED", "PASS"].includes(value.status as string)
    || typeof value.startedAt !== "string"
    || requiredArrays.some((key) => !Array.isArray(value[key]))
    || requiredRecords.some((key) => !record(value[key]))
    || !validStrictEvidence(value.strictEvidence)
    || attemptEvidenceInvalid
    || !checks
    || checks.length !== expected.checks.length
    || checks.some((check, index) =>
      !record(check)
      || check.name !== expected.checks[index]?.name
      || check.requiredEvidence
        !== expected.checks[index]?.requiredEvidence
      || !validStatuses.has(check.status as string))
  ) {
    throw new Error("Phase 0 report schema validation failed");
  }
}

export interface BootstrapReadyCrashChildEvidence {
  provisionId: string;
  candidateThreadId: string;
  creatorBaselineTurnIds: [];
  creatorBaselineSemanticHash: string;
  fence: CodexShellProvisionFence;
  childAppServerMethodCounts: Record<string, number>;
  childThreadStartCount: 1;
}

export function parseBootstrapReadyCrashChildEvidence(
  stdout: string,
  expectedEmptyBaselineHash: string,
): BootstrapReadyCrashChildEvidence {
  const line = stdout.split("\n").filter((entry) => entry.length > 0).at(-1);
  let value: unknown;
  try {
    value = JSON.parse(line ?? "");
  } catch {
    throw new Error("Phase 0 bootstrap child evidence is not JSON");
  }
  if (
    !record(value)
    || typeof value.provisionId !== "string"
    || value.provisionId.length === 0
    || typeof value.candidateThreadId !== "string"
    || value.candidateThreadId.length === 0
    || !Array.isArray(value.creatorBaselineTurnIds)
    || value.creatorBaselineTurnIds.length !== 0
    || value.creatorBaselineSemanticHash !== expectedEmptyBaselineHash
    || !record(value.fence)
    || typeof value.fence.ownerId !== "string"
    || typeof value.fence.leaseToken !== "string"
    || typeof value.fence.leaseExpiresAt !== "string"
    || !record(value.childAppServerMethodCounts)
    || value.childAppServerMethodCounts["thread/start"] !== 1
    || (value.childAppServerMethodCounts["turn/start"] ?? 0) !== 0
    || value.childThreadStartCount !== 1
  ) {
    throw new Error("Phase 0 bootstrap child evidence is incomplete");
  }
  return value as unknown as BootstrapReadyCrashChildEvidence;
}

export interface RealCrashChildEvidence {
  window: string;
  checkpointTag: string;
  writeCommitted: boolean;
  logicalTurnId: string;
  attemptId: string;
  state: string;
  dispatchOrdinal: number;
  preStartTurnIds: string[];
  preStartSemanticHash: string;
  normalizedPromptHash: string;
  correlationMarker: string;
  turnId: string | null;
  childAppServerMethodCounts: Record<string, number>;
}

export function parseRealCrashChildEvidence(
  stdout: string,
): RealCrashChildEvidence {
  const line = stdout.split("\n").filter((entry) => entry.length > 0).at(-1);
  let value: unknown;
  try {
    value = JSON.parse(line ?? "");
  } catch {
    throw new Error("Phase 0 real crash child evidence is not JSON");
  }
  if (
    !record(value)
    || ![
      "before_dispatch_cas",
      "after_ipc_write_before_response",
      "success_before_cas",
      "unknown_response",
    ].includes(value.window as string)
    || typeof value.checkpointTag !== "string"
    || value.checkpointTag.length === 0
    || typeof value.writeCommitted !== "boolean"
    || (
      value.window === "before_dispatch_cas"
      && (
        value.checkpointTag !== "journal:after_prepare"
        || value.writeCommitted !== false
      )
    )
    || (
      value.window === "after_ipc_write_before_response"
      && (
        value.checkpointTag
          !== "transport:after_ipc_write_before_response"
        || value.writeCommitted !== true
      )
    )
    || (
      value.window === "success_before_cas"
      && (
        value.checkpointTag !== "bridge:success_before_cas"
        || value.writeCommitted !== true
      )
    )
    || (
      value.window === "unknown_response"
      && (
        value.checkpointTag !== "bridge:unknown_response"
        || value.writeCommitted !== true
      )
    )
    || typeof value.logicalTurnId !== "string"
    || typeof value.attemptId !== "string"
    || typeof value.state !== "string"
    || !Number.isSafeInteger(value.dispatchOrdinal)
    || (value.dispatchOrdinal as number) < 0
    || !Array.isArray(value.preStartTurnIds)
    || value.preStartTurnIds.some((id) => typeof id !== "string")
    || typeof value.preStartSemanticHash !== "string"
    || value.preStartSemanticHash.length === 0
    || typeof value.normalizedPromptHash !== "string"
    || value.normalizedPromptHash.length === 0
    || typeof value.correlationMarker !== "string"
    || value.correlationMarker.length === 0
    || (value.turnId !== null && typeof value.turnId !== "string")
    || !record(value.childAppServerMethodCounts)
    || (value.childAppServerMethodCounts["turn/start"] ?? 0) !== 0
  ) {
    throw new Error("Phase 0 real crash child evidence is incomplete");
  }
  return value as unknown as RealCrashChildEvidence;
}

export interface RestartCheckpointReportEvidence {
  state: "awaiting_desktop_restart";
  logicalTurnId: string;
  attemptId: string;
  correlationMarker: string;
  normalizedPromptHash: string;
  preStartTurnIds: string[];
  preStartSemanticHash: string;
  dispatchOrdinal: number;
  desktopPid: number;
  processStartedAt: string;
  socketPath: string;
  socketDevice: number;
  socketInode: number;
  shellThreadId: string;
  observedTurnId: string;
  observationCursor: number;
  lastSnapshotHash: string;
  lastNormalizedSnapshot: CodexTurnSnapshot;
}

export function restartCheckpointEvidenceFromDurable(
  checkpoint: CodexPhase0RestartCheckpoint,
): RestartCheckpointReportEvidence {
  return {
    state: "awaiting_desktop_restart",
    logicalTurnId: checkpoint.logicalTurnId,
    attemptId: checkpoint.attemptId,
    correlationMarker: checkpoint.correlationMarker,
    normalizedPromptHash: checkpoint.normalizedPromptHash,
    preStartTurnIds: [...checkpoint.preStartTurnIds],
    preStartSemanticHash: checkpoint.preStartSemanticHash,
    dispatchOrdinal: checkpoint.dispatchOrdinal,
    desktopPid: checkpoint.desktopPid,
    processStartedAt: checkpoint.processStartedAt,
    socketPath: checkpoint.socketPath,
    socketDevice: checkpoint.socketDevice,
    socketInode: checkpoint.socketInode,
    shellThreadId: checkpoint.shellThreadId,
    observedTurnId: checkpoint.turnId,
    observationCursor: checkpoint.observationCursor,
    lastSnapshotHash: checkpoint.lastSnapshotHash,
    lastNormalizedSnapshot: structuredClone(
      checkpoint.lastNormalizedSnapshot,
    ),
  };
}

export function reconcileRestartCheckpointEvidence(
  report: RestartCheckpointReportEvidence | undefined,
  checkpoint: CodexPhase0RestartCheckpoint,
): RestartCheckpointReportEvidence {
  if (checkpoint.state !== "awaiting_resume") {
    throw new Error("Phase 0 restart checkpoint is already consumed");
  }
  const rebuilt = restartCheckpointEvidenceFromDurable(checkpoint);
  if (report && JSON.stringify(report) !== JSON.stringify(rebuilt)) {
    throw new Error("Phase 0 restart checkpoint mismatch");
  }
  return rebuilt;
}

export interface RestartCompletionEvidence {
  state: "desktop_restart_completed";
  shellThreadId: string;
  checkpointTurnId: string;
  resumedTurnId: string;
  completedAt: string;
}

export function reconcileConsumedRestartCompletion(
  checkpoint: CodexPhase0RestartCheckpoint,
  resumedAttempt: CodexFollowerStartAttempt,
  resumedSnapshot: CodexTurnSnapshot,
): RestartCompletionEvidence {
  if (
    checkpoint.state !== "consumed"
    || !checkpoint.resumedLogicalTurnId
    || !checkpoint.resumedAttemptId
    || !checkpoint.resumedCorrelationMarker
    || !checkpoint.resumedNormalizedPromptHash
    || !checkpoint.resumedPreStartSemanticHash
    || !checkpoint.resumedShellThreadId
    || checkpoint.resumedDispatchOrdinal === null
    || !checkpoint.resumedTurnId
    || !checkpoint.consumedAt
    || resumedAttempt.logicalTurnId !== checkpoint.resumedLogicalTurnId
    || resumedAttempt.attemptId !== checkpoint.resumedAttemptId
    || resumedAttempt.correlationMarker
      !== checkpoint.resumedCorrelationMarker
    || resumedAttempt.normalizedPromptHash
      !== checkpoint.resumedNormalizedPromptHash
    || resumedAttempt.preStartSemanticHash
      !== checkpoint.resumedPreStartSemanticHash
    || resumedAttempt.dispatchOrdinal
      !== checkpoint.resumedDispatchOrdinal
    || resumedAttempt.turnId !== checkpoint.resumedTurnId
    || resumedAttempt.state !== "succeeded"
    || resumedAttempt.request.threadId
      !== checkpoint.resumedShellThreadId
    || checkpoint.resumedShellThreadId !== checkpoint.shellThreadId
    || resumedSnapshot.threadId !== checkpoint.resumedShellThreadId
    || resumedSnapshot.turnId !== checkpoint.resumedTurnId
  ) {
    throw new Error("Phase 0 consumed restart evidence is inconsistent");
  }
  try {
    assertExactCompletedOutput(
      resumedSnapshot,
      PHASE0_RESTART_RESUME_OUTPUT,
    );
  } catch {
    throw new Error("Phase 0 consumed restart terminal is invalid");
  }
  return {
    state: "desktop_restart_completed",
    shellThreadId: checkpoint.shellThreadId,
    checkpointTurnId: checkpoint.turnId,
    resumedTurnId: checkpoint.resumedTurnId,
    completedAt: checkpoint.consumedAt,
  };
}

export type Phase0StartAttemptRecoveryOutcome =
  | "started"
  | "recovered_succeeded"
  | "adopted"
  | "quarantined";

export interface Phase0StartAttemptEvidence {
  logicalTurnId: string;
  attemptId: string;
  state: CodexFollowerStartAttempt["state"];
  dispatchOrdinal: number;
  baselineTurnCount: number;
  preStartTurnIds: string[];
  preStartSemanticHash: string;
  normalizedPromptHash: string;
  correlationMarker: string;
  turnId?: string;
  recoveryOutcome: Phase0StartAttemptRecoveryOutcome;
  ambiguousReason?: string;
  correlatedTurnCount?: number;
  outcome?: "started" | "no-client-found" | "ambiguous";
}

export function upsertStartAttemptEvidence(
  evidence: Phase0StartAttemptEvidence[],
  attempt: CodexFollowerStartAttempt,
  recoveryOutcome: Phase0StartAttemptRecoveryOutcome,
  outcome: Phase0StartAttemptEvidence["outcome"] =
    attempt.state === "ambiguous" || attempt.state === "quarantined"
      ? "ambiguous"
      : attempt.state === "no_client_found"
        ? "no-client-found"
        : "started",
  correlatedTurnCount?: number,
): void {
  const next: Phase0StartAttemptEvidence = {
    logicalTurnId: attempt.logicalTurnId,
    attemptId: attempt.attemptId,
    state: attempt.state,
    dispatchOrdinal: attempt.dispatchOrdinal,
    baselineTurnCount: attempt.preStartTurnIds.length,
    preStartTurnIds: [...attempt.preStartTurnIds],
    preStartSemanticHash: attempt.preStartSemanticHash,
    normalizedPromptHash: attempt.normalizedPromptHash,
    correlationMarker: attempt.correlationMarker,
    ...(attempt.turnId ? { turnId: attempt.turnId } : {}),
    recoveryOutcome,
    ...(attempt.ambiguousReason
      ? { ambiguousReason: attempt.ambiguousReason }
      : {}),
    ...(correlatedTurnCount === undefined
      ? {}
      : { correlatedTurnCount }),
    outcome,
  };
  const matchingIndexes = evidence.flatMap((entry, index) =>
    entry.attemptId === attempt.attemptId ? [index] : []);
  if (matchingIndexes.length > 1) {
    throw new Error("Phase 0 attempt evidence contains duplicate ids");
  }
  const [existing] = matchingIndexes;
  if (existing === undefined) evidence.push(next);
  else evidence[existing] = next;
}

export function assertStartAttemptEvidenceMatchesJournal(
  attempts: CodexFollowerStartAttempt[],
  evidence: Phase0StartAttemptEvidence[],
): void {
  const attemptIds = new Set(attempts.map(({ attemptId }) => attemptId));
  const evidenceIds = new Set(evidence.map(({ attemptId }) => attemptId));
  if (
    attemptIds.size !== attempts.length
    || evidenceIds.size !== evidence.length
    || attemptIds.size !== evidenceIds.size
  ) {
    throw new Error("Phase 0 attempt evidence cardinality is inconsistent");
  }
  for (const attempt of attempts) {
    const observed = evidence.find(
      ({ attemptId }) => attemptId === attempt.attemptId,
    );
    if (
      !observed
      || observed.logicalTurnId !== attempt.logicalTurnId
      || observed.state !== attempt.state
      || observed.dispatchOrdinal !== attempt.dispatchOrdinal
      || observed.baselineTurnCount !== attempt.preStartTurnIds.length
      || JSON.stringify(observed.preStartTurnIds)
        !== JSON.stringify(attempt.preStartTurnIds)
      || observed.preStartSemanticHash !== attempt.preStartSemanticHash
      || observed.normalizedPromptHash !== attempt.normalizedPromptHash
      || observed.correlationMarker !== attempt.correlationMarker
      || observed.turnId !== attempt.turnId
      || observed.ambiguousReason !== attempt.ambiguousReason
    ) {
      throw new Error("Phase 0 attempt evidence does not match the journal");
    }
  }
}

export type RealCrashRecoveryWindow =
  | "before_dispatch_cas"
  | "after_ipc_write_before_response"
  | "success_before_cas"
  | "unknown_response";

export function validateRealCrashRecoveryBranch(input: {
  window: RealCrashRecoveryWindow;
  recoveredState: "succeeded" | "quarantined";
  recoveredTurnId?: string;
  createdTurnIds: string[];
  recoveryFollowerStartDelta: number;
  recoveryAppServerMethodCounts: Record<string, number>;
  exactTerminalObserved: boolean;
}): {
  outcome: "succeeded" | "quarantined";
  correlatedTurnCount: 0 | 1;
} {
  const createdCount = input.createdTurnIds.length;
  const noManagedAppServerStart =
    (input.recoveryAppServerMethodCounts["turn/start"] ?? 0) === 0;
  const succeededExactlyOnce =
    input.recoveredState === "succeeded"
    && typeof input.recoveredTurnId === "string"
    && createdCount === 1
    && input.createdTurnIds[0] === input.recoveredTurnId
    && input.exactTerminalObserved;
  const quarantinedZero =
    input.recoveredState === "quarantined"
    && input.recoveredTurnId === undefined
    && createdCount === 0
    && !input.exactTerminalObserved;
  const valid = input.window === "after_ipc_write_before_response"
    ? input.recoveryFollowerStartDelta === 0
      && (succeededExactlyOnce || quarantinedZero)
    : input.window === "before_dispatch_cas"
      ? input.recoveryFollowerStartDelta === 1 && succeededExactlyOnce
      : input.recoveryFollowerStartDelta === 0 && succeededExactlyOnce;
  if (!valid || !noManagedAppServerStart) {
    throw new Error("Phase 0 real crash recovery branch is invalid");
  }
  return quarantinedZero
    ? { outcome: "quarantined", correlatedTurnCount: 0 }
    : { outcome: "succeeded", correlatedTurnCount: 1 };
}
