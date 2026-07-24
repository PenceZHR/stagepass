import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  codexPhase0VerificationArgumentsHash,
  createCodexAppServerShellControl,
  verifyAttestedAppServerBinary,
  type CodexAppServerShellControl,
  type CodexPhase0VerificationToolEvidence,
} from "../server/services/codex-app-server-shell-control.ts";
import {
  CodexAppServerClient,
} from "../server/services/codex-app-server-client.ts";
import {
  CodexDesktopBridgeError,
  codexTurnSetSemanticHash,
  createCodexDesktopBridge,
  evaluateCodexSnapshotReplayMatrix,
} from "../server/services/codex-desktop-bridge.ts";
import {
  createCodexPhase0SqliteJournal,
  type CodexPhase0JournalFailpoint,
  type CodexPhase0SqliteJournal,
} from "../server/services/codex-phase0-sqlite-journal.ts";
import {
  orchestratePhase0RestartResume,
} from "../server/services/codex-phase0-restart-resume.ts";
import {
  defaultCodexDesktopDiscoveryDependencies,
  discoverCodexDesktopIpcEndpoint,
  type CodexDesktopAttestedAppServerBinary,
  type CodexDesktopAttestedIpcEndpoint,
} from "../server/services/codex-desktop-ipc-discovery.ts";
import {
  createObservedCodexDesktopFollowerTransport,
  type CodexDesktopFollowerTransport,
} from "../server/services/codex-desktop-ipc-transport.ts";
import {
  assertStartAttemptEvidenceMatchesJournal,
  assertExactCompletedOutput,
  parseBootstrapReadyCrashChildEvidence,
  parseRealCrashChildEvidence,
  PHASE0_REPORT_SCHEMA_VERSION,
  PHASE0_STRICT_EVIDENCE_VERSION,
  reconcileConsumedRestartCompletion,
  reconcileRestartCheckpointEvidence,
  restartCheckpointEvidenceFromDurable,
  upsertStartAttemptEvidence,
  validateRealCrashRecoveryBranch,
  validatePhase0ReportEnvelope,
  type BootstrapReadyCrashChildEvidence,
  type Phase0StartAttemptEvidence,
  type Phase0StrictEvidence,
  type Phase0StrictEvidenceKind,
  type RestartCheckpointReportEvidence,
} from "../server/services/codex-phase0-verifier-contract.ts";
import type {
  CodexDesktopTurnRequest,
  CodexFollowerStartAttempt,
  CodexPhase0McpHostEvidence,
  CodexShellProvisionFence,
  CodexTurnSnapshot,
} from "../server/services/codex-desktop-bridge-types.ts";

const execFileAsync = promisify(execFile);
const verifierScriptPath = fileURLToPath(import.meta.url);

const CHECK_MANIFEST = [
  { name: "persistent_shell_provisioned_and_named", evidence: "real_shell" },
  {
    name: "shell_materialized_and_independently_proved",
    evidence: "real_shell_materialization",
  },
  { name: "deep_link_visible_and_persistent", evidence: "real_shell" },
  {
    name: "durable_follower_start_exactly_once_all_crash_windows",
    evidence: "real_cross_process_failpoints",
  },
  { name: "managed_turn_started_only_by_follower", evidence: "real_method_counts" },
  {
    name: "turn_visibility_lag_and_terminal_read_observed",
    evidence: "real_visibility_lag",
  },
  { name: "same_shell_second_follower_turn_completed", evidence: "real_turns" },
  { name: "shell_reused_after_follower_timeout", evidence: "real_fault" },
  {
    name: "ambiguous_provision_reconciled_or_failed_closed",
    evidence: "real_fault",
  },
  {
    name: "read_reconnect_and_semantic_snapshot_rules",
    evidence: "real_snapshot_replay",
  },
  { name: "two_changes_named_and_isolated", evidence: "real_shells" },
  { name: "target_interrupt_and_detach_handled", evidence: "real_interrupts" },
  {
    name: "model_effort_sandbox_and_worktree_forwarded",
    evidence: "real_forwarding",
  },
  {
    name: "mcp_app_presented_without_host_tool_dependency",
    evidence: "real_mcp_host",
  },
  {
    name: "present_status_submit_source_attested_and_cross_task_isolated",
    evidence: "real_auth_negative_matrix",
  },
  {
    name: "user_click_saved_once_and_woke_same_shell",
    evidence: "real_durable_click",
  },
  {
    name: "managed_turn_cannot_mint_submit_auth",
    evidence: "real_auth_negative",
  },
  {
    name: "ordinary_process_cannot_authorize_submit",
    evidence: "real_auth_negative",
  },
  { name: "host_mcp_channel_can_submit", evidence: "real_durable_click" },
  {
    name: "shell_control_read_list_and_model_catalog_work",
    evidence: "real_shell_control",
  },
  {
    name: "app_server_managed_turn_start_count_zero",
    evidence: "real_method_counts",
  },
] as const;

const CHECK_NAMES = CHECK_MANIFEST.map(({ name }) => name);

type CheckName = typeof CHECK_MANIFEST[number]["name"];
type CheckStatus = "pending" | "passed" | "blocked" | "failed";

interface VerificationCheck {
  name: CheckName;
  requiredEvidence: typeof CHECK_MANIFEST[number]["evidence"];
  status: CheckStatus;
  failureCode?: string;
}

interface VerificationReport {
  phase: "phase0";
  schemaVersion: typeof PHASE0_REPORT_SCHEMA_VERSION;
  status: "BLOCKED" | "FAILED" | "PASS";
  runId: string;
  registrationName: string;
  startedAt: string;
  finishedAt?: string;
  protocol: {
    appServerVersion?: string;
    appServerFingerprint?: string;
    desktopClientVersion?: string;
    desktopFollowerFingerprint?: string;
  };
  capabilities: {
    shellControlObserved: string[];
    desktopFollowerObserved: string[];
    shellControlProtocolSupported: string[];
    desktopFollowerProtocolSupported: string[];
  };
  securityBoundary: {
    supervisorDirectParentAttestation: "signed_codex_direct_parent";
    protectedChannel: "instance_local_inherited_fd";
    serverLaunchAttestation: "supported" | "unsupported";
    serverLaunchRecordTrust: "unsupported";
    serverBundleDigestTrust: "integrity_only_not_peer_identity";
    serverBundleSha256?: string;
    failureCode: "phase0_server_launch_attestation_unsupported";
  };
  mcpHostEvidence?: CodexPhase0McpHostEvidence;
  strictEvidence: Phase0StrictEvidence;
  checks: VerificationCheck[];
  actualStartAttempts: Array<{
    at: string;
    outcome: "started" | "no-client-found";
  }>;
  startAttemptEvidence: Phase0StartAttemptEvidence[];
  turnReadEvidence: {
    includeTurnsCalls: number;
    turnNotYetVisibleCount: number;
    semanticObservations: number;
    reconnects: number;
  };
  shellIds: string[];
  followerTurnIds: string[];
  deepLinkUrls: string[];
  provisioningActivationUrls: string[];
  shellMaterializationEvidence?: {
    provisionId: string;
    candidateThreadId: string;
    bootstrapState: "bootstrap_ready";
    creatorBaselineTurnIds: string[];
    creatorBaselineSemanticHash: string;
    preMaterializationIndependentVisible: false;
    durableState: "durable_ready";
    materializationLogicalTurnId: string;
    attemptId: string;
    attemptState: "succeeded";
    dispatchOrdinal: number;
    turnId: string;
    correlationMarker: string;
    threadStartCount: 1;
    initialInvocationThreadStartCount: 1;
    resumeInvocationThreadStartCount?: 0;
    candidateCount: 1;
    attemptCount: 1;
    executionCount: 1;
  };
  bootstrapCrashRecoveryEvidence?: {
    journalId: string;
    scopeKind: "project_prd";
    scopeId: string;
    projectId: string;
    cwd: string;
    title: string;
    provisionId: string;
    candidateThreadId: string;
    creatorBaselineTurnIds: [];
    creatorBaselineSemanticHash: string;
    materializationLogicalTurnId: string;
    attemptId: string;
    attemptState: "succeeded";
    dispatchOrdinal: number;
    turnId: string;
    preStartTurnIds: string[];
    preStartSemanticHash: string;
    normalizedPromptHash: string;
    correlationMarker: string;
    recoveryOutcome: "started";
    correlatedTurnCount: 1;
    childAppServerMethodCounts: Record<string, number>;
    recoveryAppServerMethodCounts: Record<string, number>;
    childThreadStartCount: 1;
    recoveryThreadStartCount: 0;
    candidateCount: 1;
    attemptCount: 1;
    executionCount: 1;
    resumeReconciliationCount: 0 | 1;
  };
  appServerMethodCounts: Record<string, number>;
  desktopMethodCounts: Record<string, number>;
  followerDispatchEvidence: Array<{
    threadId: string;
    cwd: string;
    model?: string;
    reasoningEffort?: string;
    approvalPolicy: string;
    sandboxPolicyType: string;
  }>;
  failureCodes: string[];
  evidenceNotes: string[];
  restartCheckpoint?: RestartCheckpointReportEvidence;
  restartCompletion?: {
    state: "desktop_restart_completed";
    shellThreadId: string;
    checkpointTurnId: string;
    resumedTurnId: string;
    completedAt: string;
  };
}

class Phase0VerificationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "Phase0VerificationError";
  }
}

async function expectBridgeErrorCode(
  body: () => Promise<unknown>,
  code: CodexDesktopBridgeError["code"],
): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (error instanceof CodexDesktopBridgeError && error.code === code) {
      return;
    }
    throw error;
  }
  throw new Phase0VerificationError(
    "expected_bridge_error_missing",
    `expected Codex bridge error ${code}`,
  );
}

function sanitizedToken(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value
    .replace(/\/Users\/[^/\s]+/g, "/Users/[REDACTED]")
    .replace(/\b(?:Bearer|token|secret)\s+\S+/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400) || fallback;
}

function recordDesktopRequest(
  report: VerificationReport,
  method: string,
  params: Record<string, unknown>,
): void {
  report.desktopMethodCounts[method] =
    (report.desktopMethodCounts[method] ?? 0) + 1;
  if (method !== "thread-follower-start-turn") return;
  const turnStartParams = (
    typeof params.turnStartParams === "object"
    && params.turnStartParams !== null
  ) ? params.turnStartParams as Record<string, unknown> : {};
  const sandboxPolicy = (
    typeof turnStartParams.sandboxPolicy === "object"
    && turnStartParams.sandboxPolicy !== null
  ) ? turnStartParams.sandboxPolicy as Record<string, unknown> : {};
  report.followerDispatchEvidence.push({
    threadId: typeof params.conversationId === "string"
      ? params.conversationId
      : "invalid",
    cwd: typeof turnStartParams.cwd === "string"
      ? turnStartParams.cwd
      : "invalid",
    ...(typeof turnStartParams.model === "string"
      ? { model: turnStartParams.model }
      : {}),
    ...(typeof turnStartParams.effort === "string"
      ? { reasoningEffort: turnStartParams.effort }
      : {}),
    approvalPolicy: typeof turnStartParams.approvalPolicy === "string"
      ? turnStartParams.approvalPolicy
      : "invalid",
    sandboxPolicyType: typeof sandboxPolicy.type === "string"
      ? sandboxPolicy.type
      : "invalid",
  });
}

async function readDesktopIdentity(
  endpoint: CodexDesktopAttestedIpcEndpoint,
): Promise<{
  desktopPid: number;
  processStartedAt: string;
  socketPath: string;
  socketDevice: number;
  socketInode: number;
}> {
  if (
    !Number.isInteger(endpoint.socket.device)
    || !Number.isInteger(endpoint.socket.inode)
  ) {
    throw new Phase0VerificationError(
      "desktop_restart_socket_identity_unavailable",
      "Desktop socket device/inode identity is unavailable",
    );
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "/bin/ps",
      ["-p", String(endpoint.pid), "-o", "lstart="],
      { encoding: "utf8", timeout: 2_000 },
    ));
  } catch (error) {
    const observed = error as { code?: string | number; message?: string };
    if (
      observed.code === "EPERM"
      || /operation not permitted|eperm/i.test(observed.message ?? "")
    ) {
      throw new Phase0VerificationError(
        "desktop_process_probe_unsupported",
        "sandbox does not permit /bin/ps process-start identity probing",
      );
    }
    throw error;
  }
  const processStartedAt = stdout.trim();
  if (!processStartedAt) {
    throw new Phase0VerificationError(
      "desktop_restart_process_identity_unavailable",
      "Desktop process start identity is unavailable",
    );
  }
  return {
    desktopPid: endpoint.pid,
    processStartedAt,
    socketPath: endpoint.path,
    socketDevice: endpoint.socket.device,
    socketInode: endpoint.socket.inode,
  };
}

function sameDesktopIdentity(
  left: Awaited<ReturnType<typeof readDesktopIdentity>>,
  right: NonNullable<VerificationReport["restartCheckpoint"]>,
): boolean {
  return left.desktopPid === right.desktopPid
    && left.processStartedAt === right.processStartedAt
    && left.socketPath === right.socketPath
    && left.socketDevice === right.socketDevice
    && left.socketInode === right.socketInode;
}

async function ensureFixtureBuilt(root: string): Promise<void> {
  for (const artifact of ["supervisor.mjs", "server.mjs"]) {
    const stat = await fs.stat(
      path.join(root, ".stagepass", "phase0-mcp", artifact),
    );
    if (!stat.isFile() || stat.size === 0) {
      throw new CodexDesktopBridgeError(
        "desktop_bridge_unavailable",
        `Phase 0 fixture artifact is unavailable: ${artifact}`,
      );
    }
  }
}

function blockPending(report: VerificationReport, code: string): void {
  for (const check of report.checks) {
    if (check.status === "pending") {
      check.status = "blocked";
      check.failureCode = code;
    }
  }
  if (!report.failureCodes.includes(code)) report.failureCodes.push(code);
  report.status = "BLOCKED";
}

function markPassed(report: VerificationReport, name: CheckName): void {
  const check = report.checks.find((candidate) => candidate.name === name);
  if (!check) throw new Error(`unknown Phase 0 check: ${name}`);
  const evidence = check.requiredEvidence;
  if (
    (
      evidence === "real_cross_process_failpoints"
      || evidence === "real_shell_materialization"
      || evidence === "real_visibility_lag"
      || evidence === "real_snapshot_replay"
      || evidence === "real_auth_negative_matrix"
      || evidence === "real_durable_click"
    )
    && !report.strictEvidence[evidence]?.satisfied
  ) {
    markBlocked(report, name, `${evidence}_missing`);
    return;
  }
  const previousCode = check.failureCode;
  check.status = "passed";
  delete check.failureCode;
  if (
    previousCode
    && !report.checks.some(({ failureCode }) => failureCode === previousCode)
  ) {
    report.failureCodes = report.failureCodes.filter(
      (code) => code !== previousCode,
    );
  }
}

function satisfyStrictEvidence(
  report: VerificationReport,
  kind: Phase0StrictEvidenceKind,
  facts: string[],
): void {
  if (
    facts.length === 0
    || facts.some((fact) => fact.length === 0)
  ) {
    throw new Phase0VerificationError(
      `${kind}_invalid`,
      `strict evidence ${kind} must come from non-empty real-client facts`,
    );
  }
  report.strictEvidence[kind] = {
    source: "real_client_verifier",
    satisfied: true,
    version: PHASE0_STRICT_EVIDENCE_VERSION,
    facts,
  };
}

function markBlocked(
  report: VerificationReport,
  name: CheckName,
  code: string,
): void {
  const check = report.checks.find((candidate) => candidate.name === name);
  if (!check) throw new Error(`unknown Phase 0 check: ${name}`);
  check.status = "blocked";
  check.failureCode = code;
  if (!report.failureCodes.includes(code)) report.failureCodes.push(code);
}

function passedCount(report: VerificationReport): number {
  return report.checks.filter(({ status }) => status === "passed").length;
}

function printBlocked(
  report: VerificationReport,
  code: string,
  message: string,
): void {
  report.status = "BLOCKED";
  if (!report.failureCodes.includes(code)) report.failureCodes.push(code);
  process.stderr.write(
    `PHASE0 BLOCKED: ${passedCount(report)}/${CHECK_NAMES.length} (${code}: ${
      sanitizedToken(message, "verification blocked")
    })\n`,
  );
  process.exitCode = 2;
}

async function codexMcpJson(
  codexBin: string,
  args: string[],
): Promise<unknown> {
  const { stdout } = await execFileAsync(codexBin, ["mcp", ...args], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 15_000,
  });
  return JSON.parse(stdout);
}

function isExactTemporaryRegistration(
  installed: unknown,
  input: { name: string; supervisorPath: string },
): boolean {
  const value = (
    typeof installed === "object"
    && installed !== null
  )
    ? installed as Record<string, unknown>
    : {};
  const transport = (
    typeof value.transport === "object"
    && value.transport !== null
  )
    ? value.transport as Record<string, unknown>
    : {};
  return (
    value.name === input.name
    && transport.command === process.execPath
    && Array.isArray(transport.args)
    && transport.args.length === 1
    && transport.args[0] === input.supervisorPath
  );
}

async function installTemporaryRegistration(input: {
  codexBin: string;
  name: string;
  supervisorPath: string;
  onAdded(): void;
}): Promise<void> {
  const configured = await codexMcpJson(input.codexBin, ["list", "--json"]);
  if (
    Array.isArray(configured)
    && configured.some(
      (entry) =>
        typeof entry === "object"
        && entry !== null
        && "name" in entry
        && entry.name === input.name,
    )
  ) {
    throw new Phase0VerificationError(
      "mcp_registration_collision",
      "unique temporary MCP registration already exists",
    );
  }
  try {
    await execFileAsync(
      input.codexBin,
      [
        "mcp",
        "add",
        input.name,
        "--",
        process.execPath,
        input.supervisorPath,
      ],
      {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: 15_000,
      },
    );
  } catch (error) {
    const maybeInstalled = await codexMcpJson(input.codexBin, [
      "get",
      input.name,
      "--json",
    ]).catch(() => null);
    if (isExactTemporaryRegistration(maybeInstalled, input)) {
      input.onAdded();
    }
    throw error;
  }
  input.onAdded();
  const installed = await codexMcpJson(
    input.codexBin,
    ["get", input.name, "--json"],
  );
  if (!isExactTemporaryRegistration(installed, input)) {
    throw new Phase0VerificationError(
      "mcp_registration_invalid",
      "temporary MCP registration did not round-trip exactly",
    );
  }
}

async function removeTemporaryRegistration(input: {
  codexBin: string;
  name: string;
  supervisorPath: string;
}): Promise<void> {
  const installed = await codexMcpJson(
    input.codexBin,
    ["get", input.name, "--json"],
  );
  if (!isExactTemporaryRegistration(installed, input)) {
    throw new Error("temporary MCP registration identity changed");
  }
  await execFileAsync(input.codexBin, ["mcp", "remove", input.name], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 15_000,
  });
  const configured = await codexMcpJson(input.codexBin, ["list", "--json"]);
  if (
    Array.isArray(configured)
    && configured.some(
      (entry) =>
        typeof entry === "object"
        && entry !== null
        && "name" in entry
        && entry.name === input.name,
    )
  ) {
    throw new Error("temporary MCP registration remained after remove");
  }
}

function toolResultText(snapshot: CodexTurnSnapshot): string {
  return snapshot.items
    .flatMap((item) =>
      item.kind === "tool_call" ? [item.semantic.result ?? ""] : [])
    .join("\n");
}

function hasPresentedCard(
  snapshot: CodexTurnSnapshot,
  registrationName: string,
): boolean {
  return snapshot.items.some(
    (item) =>
      item.kind === "tool_call"
      && (
        item.semantic.name === `${registrationName}/present_phase0_card`
        || item.semantic.name === "present_phase0_card"
        || item.semantic.name.endsWith("/present_phase0_card")
      )
      && item.semantic.status === "completed",
  );
}

function strictAuthNegativeToolFacts(input: {
  registrationName: string;
  evidence: CodexPhase0VerificationToolEvidence[];
  cases: Array<{
    caseId:
      | "cross_source_present"
      | "cross_source_status"
      | "cross_binding_present";
    arguments: Record<string, string | number>;
  }>;
}): string[] {
  const toolName = `${input.registrationName}/present_phase0_card`;
  return input.cases.map((expected) => {
    const expectedArguments = {
      verificationCaseId: expected.caseId,
      ...expected.arguments,
    };
    const matches = input.evidence.filter((item) =>
      item.toolName === toolName
      && item.caseId === expected.caseId);
    if (matches.length !== 1) {
      throw new Phase0VerificationError(
        "real_auth_negative_tool_identity_invalid",
        `${expected.caseId} did not produce exactly one target MCP tool item`,
      );
    }
    const item = matches[0]!;
    if (
      item.status !== "failed"
      || item.canonicalArgumentsHash
        !== codexPhase0VerificationArgumentsHash(expectedArguments)
      || item.errorCode !== "source_thread_mismatch"
    ) {
      throw new Phase0VerificationError(
        "real_auth_negative_tool_result_invalid",
        `${expected.caseId} MCP call/result binding is incomplete`,
      );
    }
    return `auth_case=${expected.caseId}:tool_item=${item.itemId}`
      + ":tool=present_phase0_card:code=source_thread_mismatch";
  });
}

async function readTerminalTurn(input: {
  bridge: ReturnType<typeof createCodexDesktopBridge>;
  threadId: string;
  turnId: string;
  deadlineAt: string;
  report: VerificationReport;
  expectedOutput?: string;
}): Promise<{
  terminal: CodexTurnSnapshot;
  cursor: number;
  lastSnapshotHash: string;
}> {
  let terminal: CodexTurnSnapshot | undefined;
  let cursor = 0;
  let lastSnapshotHash: string | undefined;
  for await (const observation of input.bridge.pollTurn({
    threadId: input.threadId,
    turnId: input.turnId,
    deadlineAt: input.deadlineAt,
  })) {
    if (observation.kind === "turn_not_yet_visible") {
      input.report.turnReadEvidence.turnNotYetVisibleCount += 1;
      continue;
    }
    input.report.turnReadEvidence.semanticObservations += 1;
    terminal = observation.snapshot;
    cursor = observation.cursor;
    lastSnapshotHash = observation.semanticSnapshotHash;
  }
  if (!terminal || !lastSnapshotHash) {
    throw new Phase0VerificationError(
      "desktop_turn_terminal_not_observed",
      "the Desktop-started turn did not produce a terminal app-server snapshot",
    );
  }
  if (input.expectedOutput !== undefined) {
    try {
      assertExactCompletedOutput(terminal, input.expectedOutput);
    } catch {
      throw new Phase0VerificationError(
        "desktop_turn_exact_output_mismatch",
        "the Desktop-started turn did not produce the expected byte-exact completed output",
      );
    }
  }
  return { terminal, cursor, lastSnapshotHash };
}

async function proveRealVisibilityLag(input: {
  shellControl: CodexAppServerShellControl;
  follower: CodexDesktopFollowerTransport;
  journal: CodexPhase0SqliteJournal;
  threadId: string;
  turnId: string;
  report: VerificationReport;
}): Promise<void> {
  let hiddenPolls = 0;
  const startCountBefore = input.report.actualStartAttempts.length;
  const laggedControl: CodexAppServerShellControl = {
    ...input.shellControl,
    async readThreadWithTurns(request) {
      const real = await input.shellControl.readThreadWithTurns(request);
      if (
        request.threadId === input.threadId
        && hiddenPolls < 2
        && real.turns.some(({ turnId }) => turnId === input.turnId)
      ) {
        hiddenPolls += 1;
        return {
          ...real,
          turns: real.turns.filter(({ turnId }) => turnId !== input.turnId),
        };
      }
      return real;
    },
  };
  const laggedBridge = createCodexDesktopBridge({
    shellControl: laggedControl,
    follower: input.follower,
    logicalTurnPort: input.journal.logicalTurnPort,
    startAttemptPort: input.journal.startAttemptPort,
    shellProvisionPort: input.journal.shellProvisionPort,
  });
  let missingObservations = 0;
  let semanticObservations = 0;
  let firstCursor: number | undefined;
  for await (const observation of laggedBridge.pollTurn({
    threadId: input.threadId,
    turnId: input.turnId,
    afterCursor: 0,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  })) {
    if (observation.kind === "turn_not_yet_visible") {
      missingObservations += 1;
      continue;
    }
    semanticObservations += 1;
    firstCursor ??= observation.cursor;
  }
  const startCountAfter = input.report.actualStartAttempts.length;
  if (
    hiddenPolls !== 2
    || missingObservations !== 2
    || semanticObservations < 1
    || firstCursor !== 1
    || startCountAfter !== startCountBefore
  ) {
    throw new Phase0VerificationError(
      "real_visibility_lag_invalid",
      "real turn visibility fault injection advanced a cursor or redispatched",
    );
  }
  input.report.turnReadEvidence.turnNotYetVisibleCount += missingObservations;
  input.report.turnReadEvidence.semanticObservations += semanticObservations;
  satisfyStrictEvidence(input.report, "real_visibility_lag", [
    `real_turn=${input.turnId}`,
    `hidden_real_reads=${hiddenPolls}`,
    `turn_not_yet_visible=${missingObservations}`,
    `first_semantic_cursor=${firstCursor}`,
    `follower_start_delta=${startCountAfter - startCountBefore}`,
  ]);
}

async function forceInFlightAppServerReadDisconnect(input: {
  appServerBinary: CodexDesktopAttestedAppServerBinary;
  threadId: string;
  cwd: string;
  report: VerificationReport;
}): Promise<Error> {
  await verifyAttestedAppServerBinary(input.appServerBinary);
  const client = CodexAppServerClient.spawn({
    bin: input.appServerBinary.path,
    cwd: input.cwd,
    onNotification() {},
    async onServerRequest() {
      return {};
    },
  });
  try {
    await verifyAttestedAppServerBinary(input.appServerBinary);
    input.report.appServerMethodCounts.initialize =
      (input.report.appServerMethodCounts.initialize ?? 0) + 1;
    await client.initialize();
    input.report.appServerMethodCounts["thread/read"] =
      (input.report.appServerMethodCounts["thread/read"] ?? 0) + 1;
    input.report.turnReadEvidence.includeTurnsCalls += 1;
    const pendingRead = client.request("thread/read", {
      threadId: input.threadId,
      includeTurns: true,
    }, 5_000);
    client.kill("SIGKILL");
    try {
      await pendingRead;
      return new Phase0VerificationError(
        "app_server_read_disconnect_raced",
        "the forced in-flight app-server thread/read completed before disconnect",
      );
    } catch (error) {
      return error instanceof Error
        ? error
        : new Error("app-server thread/read disconnected");
    }
  } finally {
    await client.close(50).catch(() => undefined);
  }
}

function withForcedReadDisconnect(input: {
  appServerBinary: CodexDesktopAttestedAppServerBinary;
  shellControl: CodexAppServerShellControl;
  cwd: string;
  report: VerificationReport;
}): {
  shellControl: CodexAppServerShellControl;
  arm(): void;
  wasObserved(): boolean;
} {
  let armed = false;
  let observed = false;
  return {
    shellControl: {
      ...input.shellControl,
      async readThreadWithTurns(request) {
        if (armed) {
          armed = false;
          const disconnect = await forceInFlightAppServerReadDisconnect({
            appServerBinary: input.appServerBinary,
            threadId: request.threadId,
            cwd: input.cwd,
            report: input.report,
          });
          if (disconnect instanceof Phase0VerificationError) {
            throw disconnect;
          }
          observed = true;
          input.report.turnReadEvidence.reconnects += 1;
          throw disconnect;
        }
        return input.shellControl.readThreadWithTurns(request);
      },
    },
    arm() {
      armed = true;
    },
    wasObserved() {
      return observed;
    },
  };
}

async function waitForUiSentinel(input: {
  shellControl: ReturnType<typeof createCodexAppServerShellControl>;
  threadId: string;
  deadlineAt: number;
}): Promise<string> {
  const prefix = `STAGEPASS_PHASE0_WAKEUP ${input.threadId} `;
  while (Date.now() < input.deadlineAt) {
    const snapshot = await input.shellControl.readThreadWithTurns({
      threadId: input.threadId,
      includeTurns: true,
    });
    for (const turn of snapshot.turns) {
      const message = turn.items.find(
        (item) =>
          item.kind === "user_message"
          && item.semantic.text.startsWith(prefix),
      );
      if (message?.kind === "user_message") return message.semantic.text;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Phase0VerificationError(
    "mcp_ui_message_not_observed",
    "same-thread MCP ui/message sentinel was not observed before the deadline",
  );
}

async function assertOrdinaryProcessRejected(
  supervisorPath: string,
): Promise<void> {
  try {
    await execFileAsync(process.execPath, [supervisorPath], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 512 * 1024,
    });
  } catch (error) {
    const observed = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const text = `${observed.stdout ?? ""}\n${observed.stderr ?? ""}\n${
      observed.message ?? ""
    }`;
    if (
      /phase0_host_launch_untrusted/.test(text)
    ) {
      return;
    }
    if (
      /EPERM|operation not permitted|phase0_host_launch_attestation_unsupported/i
        .test(text)
    ) {
      throw new Phase0VerificationError(
        "desktop_process_probe_unsupported",
        "sandbox does not permit ordinary-process ancestry probing",
      );
    }
    throw new Phase0VerificationError(
      "ordinary_process_rejection_unproven",
      sanitizedToken(text, "ordinary supervisor launch failed without attestation code"),
    );
  }
  throw new Phase0VerificationError(
    "ordinary_process_authorized",
    "ordinary Node process unexpectedly launched the protected MCP supervisor",
  );
}

function recordingFollower(
  follower: CodexDesktopFollowerTransport,
  report: VerificationReport,
): CodexDesktopFollowerTransport {
  return {
    probe: () => follower.probe(),
    async openThreadDeepLink(input) {
      await follower.openThreadDeepLink(input);
      report.deepLinkUrls.push(input.url);
    },
    async startFollowerTurn(input: CodexDesktopTurnRequest) {
      const result = await follower.startFollowerTurn(input);
      report.actualStartAttempts.push({
        at: new Date().toISOString(),
        outcome: result.status === "started" ? "started" : "no-client-found",
      });
      return result;
    },
    interruptTurn: (input) => follower.interruptTurn(input),
  };
}

function recordStartAttemptEvidence(
  report: VerificationReport,
  attempt: CodexFollowerStartAttempt,
  recoveryOutcome: VerificationReport["startAttemptEvidence"][number][
    "recoveryOutcome"
  ],
  outcome: VerificationReport["startAttemptEvidence"][number]["outcome"] =
    attempt.state === "ambiguous"
      ? "ambiguous"
      : attempt.state === "no_client_found"
        ? "no-client-found"
        : "started",
): void {
  upsertStartAttemptEvidence(
    report.startAttemptEvidence,
    attempt,
    recoveryOutcome,
    outcome,
  );
}

async function inspectAndRecordStartAttempt(input: {
  journal: CodexPhase0SqliteJournal;
  report: VerificationReport;
  attemptId: string;
  recoveryOutcome: Phase0StartAttemptEvidence["recoveryOutcome"];
  outcome?: Phase0StartAttemptEvidence["outcome"];
  correlatedTurnCount?: number;
}): Promise<CodexFollowerStartAttempt> {
  const attempt = await input.journal.inspectAttempt(input.attemptId);
  if (!attempt) {
    throw new Phase0VerificationError(
      "start_attempt_evidence_missing",
      "a verifier start/recovery attempt was not durably readable",
    );
  }
  upsertStartAttemptEvidence(
    input.report.startAttemptEvidence,
    attempt,
    input.recoveryOutcome,
    input.outcome,
    input.correlatedTurnCount,
  );
  return attempt;
}

async function writeReport(
  root: string,
  report: VerificationReport,
): Promise<void> {
  report.finishedAt = new Date().toISOString();
  const directory = path.join(root, ".stagepass", "verification");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(directory, `codex-desktop-bridge-phase0-${report.runId}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.writeFile(
    path.join(directory, "codex-desktop-bridge-phase0.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

type RealCrashWindow =
  | "before_dispatch_cas"
  | "after_ipc_write_before_response"
  | "success_before_cas"
  | "unknown_response";

async function runBootstrapReadyCrashChild(input: {
  databasePath: string;
  runId: string;
}): Promise<void> {
  const root = process.cwd();
  const methodCounts: Record<string, number> = {};
  const endpoint = await discoverCodexDesktopIpcEndpoint(
    defaultCodexDesktopDiscoveryDependencies(),
  );
  const shellControl = createCodexAppServerShellControl({
    appServerBinary: endpoint.appServerBinary,
    onRequest(method) {
      methodCounts[method] = (methodCounts[method] ?? 0) + 1;
    },
  });
  const follower = createObservedCodexDesktopFollowerTransport(endpoint);
  const journal = createCodexPhase0SqliteJournal({
    databasePath: input.databasePath,
    async readBaseline(request) {
      const snapshot = await shellControl.readThreadWithTurns({
        threadId: request.threadId,
        includeTurns: true,
      });
      return {
        turnIds: snapshot.turns.map(({ turnId }) => turnId),
        semanticHash: codexTurnSetSemanticHash(snapshot.turns),
      };
    },
  });
  const scope = {
    kind: "project_prd" as const,
    scopeId: `phase0-bootstrap-crash-${input.runId}`,
    projectId: `phase0-bootstrap-crash-${input.runId}`,
  };
  const fence: CodexShellProvisionFence = {
    ownerId: `phase0-bootstrap-crash-worker-${input.runId}`,
    leaseToken: `phase0-bootstrap-crash-lease-${input.runId}`,
    leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    ownerAttempt: 1,
    ownerEpoch: 1,
  };
  const durablePort = journal.shellProvisionPort;
  const bridge = createCodexDesktopBridge({
    shellControl,
    follower,
    logicalTurnPort: journal.logicalTurnPort,
    startAttemptPort: journal.startAttemptPort,
    shellProvisionPort: {
      ...durablePort,
      async recordBootstrapReady(request) {
        await durablePort.recordBootstrapReady(request);
        throw new Error("phase0 child crash after bootstrap_ready CAS");
      },
    },
  });
  try {
    await bridge.ensurePersistentShell({
      projectPath: root,
      scope,
      title: `[PHASE0 BOOTSTRAP CRASH ${input.runId}]`,
      provisionFence: fence,
    });
    throw new Error("bootstrap_ready crash checkpoint was not reached");
  } catch (error) {
    if (!String(error).includes("crash after bootstrap_ready CAS")) {
      throw error;
    }
    const inspected = journal.inspectShellProvision(
      scope.kind,
      scope.scopeId,
    );
    if (
      inspected.state !== "bootstrap_ready"
      || !inspected.candidateThreadId
      || inspected.threadId !== null
      || inspected.creatorBaselineTurnIds?.length !== 0
      || inspected.creatorBaselineSemanticHash
        !== codexTurnSetSemanticHash([])
      || inspected.materializationLogicalTurnId !== null
      || inspected.attemptCount !== 0
      || inspected.executionCount !== 0
      || methodCounts["thread/start"] !== 1
      || (methodCounts["turn/start"] ?? 0) !== 0
    ) {
      throw new Error(
        "bootstrap_ready child did not persist an exact zero-turn checkpoint",
      );
    }
    const evidence: BootstrapReadyCrashChildEvidence = {
      provisionId: inspected.provisionId,
      candidateThreadId: inspected.candidateThreadId,
      creatorBaselineTurnIds: [],
      creatorBaselineSemanticHash:
        inspected.creatorBaselineSemanticHash,
      fence,
      childAppServerMethodCounts: methodCounts,
      childThreadStartCount: 1,
    };
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    journal.close();
  }
}

async function proveBootstrapReadyCrashRecovery(input: {
  root: string;
  databasePath: string;
  runId: string;
  shellControl: CodexAppServerShellControl;
  follower: CodexDesktopFollowerTransport;
  report: VerificationReport;
}): Promise<void> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      verifierScriptPath,
      "--phase0-bootstrap-ready-crash-child",
      input.databasePath,
      input.runId,
    ],
    {
      cwd: input.root,
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const childEvidence = parseBootstrapReadyCrashChildEvidence(
    stdout,
    codexTurnSetSemanticHash([]),
  );
  const scope = {
    kind: "project_prd" as const,
    scopeId: `phase0-bootstrap-crash-${input.runId}`,
    projectId: `phase0-bootstrap-crash-${input.runId}`,
  };
  const methodCountsBefore = { ...input.report.appServerMethodCounts };
  const recoveryJournal = createCodexPhase0SqliteJournal({
    databasePath: input.databasePath,
    async readBaseline(request) {
      const snapshot = await input.shellControl.readThreadWithTurns({
        threadId: request.threadId,
        includeTurns: true,
      });
      return {
        turnIds: snapshot.turns.map(({ turnId }) => turnId),
        semanticHash: codexTurnSetSemanticHash(snapshot.turns),
      };
    },
  });
  try {
    const bridge = createCodexDesktopBridge({
      shellControl: input.shellControl,
      follower: input.follower,
      logicalTurnPort: recoveryJournal.logicalTurnPort,
      startAttemptPort: recoveryJournal.startAttemptPort,
      shellProvisionPort: recoveryJournal.shellProvisionPort,
    });
    const shell = await bridge.ensurePersistentShell({
      projectPath: input.root,
      scope,
      title: `[PHASE0 BOOTSTRAP CRASH ${input.runId}]`,
      provisionFence: childEvidence.fence,
    });
    const inspected = recoveryJournal.inspectShellProvision(
      scope.kind,
      scope.scopeId,
    );
    const recoveryAppServerMethodCounts = Object.fromEntries(
      Object.entries(input.report.appServerMethodCounts).map(
        ([method, count]) => [
          method,
          count - (methodCountsBefore[method] ?? 0),
        ],
      ),
    );
    if (
      shell.threadId !== childEvidence.candidateThreadId
      || inspected.provisionId !== childEvidence.provisionId
      || inspected.state !== "durable_ready"
      || inspected.candidateThreadId !== childEvidence.candidateThreadId
      || inspected.threadId !== childEvidence.candidateThreadId
      || inspected.creatorBaselineTurnIds?.length !== 0
      || inspected.creatorBaselineSemanticHash
        !== childEvidence.creatorBaselineSemanticHash
      || !inspected.materializationLogicalTurnId
      || inspected.attempt?.state !== "succeeded"
      || inspected.attempt.dispatchOrdinal < 1
      || !inspected.attempt.turnId
      || inspected.candidateCount !== 1
      || inspected.attemptCount !== 1
      || inspected.executionCount !== 1
      || (recoveryAppServerMethodCounts["thread/start"] ?? 0) !== 0
      || (recoveryAppServerMethodCounts["turn/start"] ?? 0) !== 0
    ) {
      throw new Phase0VerificationError(
        "bootstrap_ready_crash_recovery_invalid",
        "bootstrap_ready recovery did not materialize the same candidate with zero new thread starts",
      );
    }
    input.report.bootstrapCrashRecoveryEvidence = {
      journalId: path.basename(input.databasePath),
      scopeKind: scope.kind,
      scopeId: scope.scopeId,
      projectId: scope.projectId,
      cwd: input.root,
      title: `[PHASE0 BOOTSTRAP CRASH ${input.runId}]`,
      provisionId: inspected.provisionId,
      candidateThreadId: childEvidence.candidateThreadId,
      creatorBaselineTurnIds: [],
      creatorBaselineSemanticHash:
        inspected.creatorBaselineSemanticHash,
      materializationLogicalTurnId:
        inspected.materializationLogicalTurnId,
      attemptId: inspected.attempt.attemptId,
      attemptState: "succeeded",
      dispatchOrdinal: inspected.attempt.dispatchOrdinal,
      turnId: inspected.attempt.turnId,
      preStartTurnIds: [...inspected.attempt.preStartTurnIds],
      preStartSemanticHash: inspected.attempt.preStartSemanticHash,
      normalizedPromptHash: inspected.attempt.normalizedPromptHash,
      correlationMarker: inspected.attempt.correlationMarker,
      recoveryOutcome: "started",
      correlatedTurnCount: 1,
      childAppServerMethodCounts:
        childEvidence.childAppServerMethodCounts,
      recoveryAppServerMethodCounts,
      childThreadStartCount: 1,
      recoveryThreadStartCount: 0,
      candidateCount: 1,
      attemptCount: 1,
      executionCount: 1,
      resumeReconciliationCount: 0,
    };
    const strict = input.report.strictEvidence.real_shell_materialization;
    if (!strict) {
      throw new Phase0VerificationError(
        "real_shell_materialization_missing",
        "primary materialization evidence must precede crash recovery evidence",
      );
    }
    strict.facts.push(
      `bootstrap_crash_candidate=${childEvidence.candidateThreadId}`,
      "bootstrap_crash_child_thread_start_count=1",
      "bootstrap_crash_recovery_thread_start_count=0",
      `bootstrap_crash_dispatch_ordinal=${
        inspected.attempt.dispatchOrdinal
      }`,
      "bootstrap_crash_candidate_count=1",
      "bootstrap_crash_attempt_count=1",
      "bootstrap_crash_execution_count=1",
      `bootstrap_crash_journal_id=${path.basename(input.databasePath)}`,
      "bootstrap_crash_resume_reconciliation_count=0",
    );
  } finally {
    recoveryJournal.close();
  }
}

async function reconcileBootstrapCrashRecoveryJournal(input: {
  root: string;
  verificationDirectory: string;
  runId: string;
  evidence: NonNullable<
    VerificationReport["bootstrapCrashRecoveryEvidence"]
  >;
}): Promise<void> {
  const expectedJournalId =
    `codex-desktop-bridge-phase0-${input.runId}-bootstrap-ready-crash.sqlite`;
  if (
    input.evidence.journalId !== expectedJournalId
    || path.basename(input.evidence.journalId) !== input.evidence.journalId
    || input.evidence.scopeKind !== "project_prd"
    || input.evidence.scopeId !== `phase0-bootstrap-crash-${input.runId}`
    || input.evidence.projectId !== input.evidence.scopeId
    || input.evidence.cwd !== input.root
    || input.evidence.title
      !== `[PHASE0 BOOTSTRAP CRASH ${input.runId}]`
  ) {
    throw new Phase0VerificationError(
      "bootstrap_crash_journal_identity_mismatch",
      "bootstrap crash report does not identify the expected independent journal",
    );
  }
  const journalPath = path.join(
    input.verificationDirectory,
    input.evidence.journalId,
  );
  let journalStat;
  try {
    journalStat = await fs.lstat(journalPath);
  } catch (cause) {
    throw new Phase0VerificationError(
      "bootstrap_crash_journal_missing",
      `independent bootstrap crash journal is unavailable: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (!journalStat.isFile() || journalStat.isSymbolicLink()) {
    throw new Phase0VerificationError(
      "bootstrap_crash_journal_invalid",
      "independent bootstrap crash journal must be a regular non-symlink file",
    );
  }
  const recoveryJournal = createCodexPhase0SqliteJournal({
    databasePath: journalPath,
    async readBaseline() {
      throw new Error(
        "resume reconciliation must not perform a new shell baseline read",
      );
    },
  });
  try {
    const inspected = recoveryJournal.inspectShellProvision(
      input.evidence.scopeKind,
      input.evidence.scopeId,
    );
    const binding = recoveryJournal.readBinding(
      input.evidence.scopeKind,
      input.evidence.scopeId,
    );
    const attempts = await recoveryJournal.listAttempts();
    const attempt = inspected.attempt;
    if (
      inspected.provisionId !== input.evidence.provisionId
      || inspected.state !== "durable_ready"
      || inspected.cwd !== input.evidence.cwd
      || inspected.title !== input.evidence.title
      || inspected.candidateThreadId
        !== input.evidence.candidateThreadId
      || inspected.threadId !== input.evidence.candidateThreadId
      || binding.projectId !== input.evidence.projectId
      || binding.changeId !== null
      || binding.threadId !== input.evidence.candidateThreadId
      || JSON.stringify(inspected.creatorBaselineTurnIds)
        !== JSON.stringify(input.evidence.creatorBaselineTurnIds)
      || inspected.creatorBaselineSemanticHash
        !== input.evidence.creatorBaselineSemanticHash
      || inspected.materializationLogicalTurnId
        !== input.evidence.materializationLogicalTurnId
      || !attempt
      || attempt.logicalTurnId
        !== input.evidence.materializationLogicalTurnId
      || attempt.attemptId !== input.evidence.attemptId
      || attempt.state !== input.evidence.attemptState
      || attempt.dispatchOrdinal !== input.evidence.dispatchOrdinal
      || attempt.turnId !== input.evidence.turnId
      || attempt.request.threadId !== input.evidence.candidateThreadId
      || attempt.request.cwd !== input.evidence.cwd
      || JSON.stringify(attempt.preStartTurnIds)
        !== JSON.stringify(input.evidence.preStartTurnIds)
      || attempt.preStartSemanticHash
        !== input.evidence.preStartSemanticHash
      || attempt.normalizedPromptHash
        !== input.evidence.normalizedPromptHash
      || attempt.correlationMarker !== input.evidence.correlationMarker
      || input.evidence.recoveryOutcome !== "started"
      || input.evidence.correlatedTurnCount !== 1
      || input.evidence.candidateCount !== 1
      || input.evidence.attemptCount !== 1
      || input.evidence.executionCount !== 1
      || inspected.attemptCount !== input.evidence.attemptCount
      || inspected.candidateCount !== input.evidence.candidateCount
      || inspected.executionCount !== input.evidence.executionCount
      || attempts.length !== 1
      || attempts[0]?.attemptId !== input.evidence.attemptId
      || input.evidence.childThreadStartCount !== 1
      || input.evidence.recoveryThreadStartCount !== 0
    ) {
      throw new Phase0VerificationError(
        "bootstrap_crash_resume_reconciliation_invalid",
        "independent bootstrap crash journal does not match its persisted report evidence",
      );
    }
    input.evidence.resumeReconciliationCount = 1;
  } finally {
    recoveryJournal.close();
  }
}

async function runRealCrashWindowChild(input: {
  databasePath: string;
  logicalTurnId: string;
  window: RealCrashWindow;
}): Promise<void> {
  const endpoint = await discoverCodexDesktopIpcEndpoint(
    defaultCodexDesktopDiscoveryDependencies(),
  );
  const childAppServerMethodCounts: Record<string, number> = {};
  const shellControl = createCodexAppServerShellControl({
    appServerBinary: endpoint.appServerBinary,
    onRequest(method) {
      childAppServerMethodCounts[method] =
        (childAppServerMethodCounts[method] ?? 0) + 1;
    },
  });
  let writeCommitted = false;
  const realFollower = createObservedCodexDesktopFollowerTransport(endpoint, {
    onWriteCommitted(method) {
      if (method === "thread-follower-start-turn") {
        writeCommitted = true;
      }
      if (
        input.window === "after_ipc_write_before_response"
        && method === "thread-follower-start-turn"
      ) {
        throw Object.assign(
          new Error("phase0 child exit after IPC write commit"),
          { phase0CrashCheckpoint: "after_ipc_write_before_response" },
        );
      }
    },
  });
  const follower: CodexDesktopFollowerTransport =
    input.window === "unknown_response"
      ? {
          probe: () => realFollower.probe(),
          openThreadDeepLink: (request) =>
            realFollower.openThreadDeepLink(request),
          async startFollowerTurn(request) {
            const result = await realFollower.startFollowerTurn(request);
            if (result.status === "no-client-found") return result;
            throw new Error(
              "phase0 real follower response intentionally discarded",
            );
          },
          interruptTurn: (request) => realFollower.interruptTurn(request),
        }
      : realFollower;
  const journal = createCodexPhase0SqliteJournal({
    databasePath: input.databasePath,
    async readBaseline(request) {
      const snapshot = await shellControl.readThreadWithTurns({
        threadId: request.threadId,
        includeTurns: true,
      });
      return {
        turnIds: snapshot.turns.map(({ turnId }) => turnId),
        semanticHash: codexTurnSetSemanticHash(snapshot.turns),
      };
    },
  });
  const journalFailpoint: CodexPhase0JournalFailpoint | undefined =
    input.window === "before_dispatch_cas"
      ? "after_prepare"
      : undefined;
  if (journalFailpoint) journal.setFailpoint(journalFailpoint);
  const bridge = createCodexDesktopBridge({
    shellControl,
    follower,
    logicalTurnPort: journal.logicalTurnPort,
    startAttemptPort: journal.startAttemptPort,
    shellProvisionPort: journal.shellProvisionPort,
    followerStartFailpoint(checkpoint) {
      if (
        checkpoint === input.window
        || (
          input.window === "unknown_response"
          && checkpoint === "unknown_response"
        )
      ) {
        throw new Error(`phase0 child exit at ${input.window}`);
      }
    },
  });
  try {
    await bridge.startTurn({ logicalTurnId: input.logicalTurnId });
    throw new Error(`real crash window ${input.window} was not reached`);
  } catch (error) {
    const actualCheckpoint =
      typeof error === "object"
        && error !== null
        && "phase0CrashCheckpoint" in error
        && typeof error.phase0CrashCheckpoint === "string"
        ? error.phase0CrashCheckpoint
        : null;
    const expectedCheckpoint = input.window === "before_dispatch_cas"
      ? "after_prepare"
      : input.window;
    if (actualCheckpoint !== expectedCheckpoint) {
      throw new Error(
        `real crash window ${input.window} rejected an untagged or unexpected error`,
        { cause: error },
      );
    }
    const checkpointTag = input.window === "before_dispatch_cas"
      ? "journal:after_prepare"
      : input.window === "after_ipc_write_before_response"
        ? "transport:after_ipc_write_before_response"
        : `bridge:${input.window}`;
    if (
      input.window === "after_ipc_write_before_response"
      && !writeCommitted
    ) {
      throw new Error(
        "after_ipc_write_before_response did not reach the write-commit callback",
      );
    }
    const attempt = await journal.inspectAttemptByLogicalTurn(
      input.logicalTurnId,
    );
    if (
      !attempt
      || (
        input.window === "before_dispatch_cas"
          ? attempt.state !== "prepared"
          : attempt.state !== "dispatching"
      )
    ) {
      throw new Error(
        `real crash window ${input.window} did not persist its checkpoint`,
      );
    }
    process.stdout.write(`${JSON.stringify({
      window: input.window,
      checkpointTag,
      writeCommitted,
      logicalTurnId: attempt.logicalTurnId,
      attemptId: attempt.attemptId,
      state: attempt.state,
      dispatchOrdinal: attempt.dispatchOrdinal,
      preStartTurnIds: attempt.preStartTurnIds,
      preStartSemanticHash: attempt.preStartSemanticHash,
      normalizedPromptHash: attempt.normalizedPromptHash,
      correlationMarker: attempt.correlationMarker,
      turnId: attempt.turnId ?? null,
      childAppServerMethodCounts,
    })}\n`);
  } finally {
    journal.close();
  }
}

async function proveRealCrossProcessCrashWindows(input: {
  root: string;
  databasePath: string;
  shell: { threadId: string; title: string };
  shellControl: CodexAppServerShellControl;
  follower: CodexDesktopFollowerTransport;
  journal: CodexPhase0SqliteJournal;
  model: string;
  reasoningEffort?: string;
  runId: string;
  report: VerificationReport;
}): Promise<void> {
  const facts: string[] = [];
  for (
    const [ordinal, window] of ([
      "before_dispatch_cas",
      "after_ipc_write_before_response",
      "success_before_cas",
      "unknown_response",
    ] as const).entries()
  ) {
    const deadlineMs = 10 * 60_000;
    const seed = await input.journal.seedManagedRun({
      ownerKind: "project_ai_run",
      ownerId: `phase0-real-crash-${window}-${input.runId}`,
      projectId: `phase0-${input.runId}`,
      scopeKind: "project_context",
      scopeId: `phase0-${input.runId}`,
      phase: `RealCrash-${window}`,
      role: "stage",
      round: 0,
      ordinal,
      purpose: "stage_run",
      binding: {
        threadId: input.shell.threadId,
        cwd: input.root,
        title: input.shell.title,
      },
      request: {
        cwd: input.root,
        prompt: `Reply exactly PHASE0_REAL_CRASH_${window.toUpperCase()}`,
        model: input.model,
        ...(input.reasoningEffort
          ? { reasoningEffort: input.reasoningEffort }
          : {}),
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
      leaseExpiresAt: new Date(Date.now() + deadlineMs).toISOString(),
    });
    const before = await input.shellControl.readThreadWithTurns({
      threadId: input.shell.threadId,
      includeTurns: true,
    });
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        verifierScriptPath,
        "--phase0-crash-child",
        input.databasePath,
        seed.logicalTurnId,
        window,
      ],
      {
        cwd: input.root,
        encoding: "utf8",
        timeout: 90_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const childEvidence = parseRealCrashChildEvidence(stdout);
    if (
      childEvidence.window !== window
      || childEvidence.logicalTurnId !== seed.logicalTurnId
      || (childEvidence.childAppServerMethodCounts["turn/start"] ?? 0) !== 0
      || (
        window === "after_ipc_write_before_response"
        && (
          !childEvidence.writeCommitted
          || childEvidence.checkpointTag
            !== "transport:after_ipc_write_before_response"
        )
      )
      || (
        window === "before_dispatch_cas"
          ? childEvidence.state !== "prepared"
            || childEvidence.dispatchOrdinal !== 0
          : childEvidence.state !== "dispatching"
            || childEvidence.dispatchOrdinal !== 1
      )
    ) {
      throw new Phase0VerificationError(
        "real_cross_process_failpoint_invalid",
        `child process did not persist the ${window} crash checkpoint`,
      );
    }
    const recoveryJournal = createCodexPhase0SqliteJournal({
      databasePath: input.databasePath,
      async readBaseline(request) {
        const snapshot = await input.shellControl.readThreadWithTurns({
          threadId: request.threadId,
          includeTurns: true,
        });
        return {
          turnIds: snapshot.turns.map(({ turnId }) => turnId),
          semanticHash: codexTurnSetSemanticHash(snapshot.turns),
        };
      },
    });
    let recovered: Awaited<ReturnType<
      ReturnType<typeof createCodexDesktopBridge>["recoverTurn"]
    >>;
    let exactTerminalObserved = false;
    let recoveredAttempt: CodexFollowerStartAttempt | null = null;
    const recoveryFollowerStartsBefore =
      input.report.actualStartAttempts.length;
    const recoveryMethodCountsBefore = {
      ...input.report.appServerMethodCounts,
    };
    try {
      const recoveryBridge = createCodexDesktopBridge({
        shellControl: input.shellControl,
        follower: input.follower,
        logicalTurnPort: recoveryJournal.logicalTurnPort,
        startAttemptPort: recoveryJournal.startAttemptPort,
        shellProvisionPort: recoveryJournal.shellProvisionPort,
      });
      recovered = await recoveryBridge.recoverTurn({
        logicalTurnId: seed.logicalTurnId,
      });
      if (recovered.state === "succeeded" && recovered.turnId) {
        await readTerminalTurn({
          bridge: recoveryBridge,
          threadId: input.shell.threadId,
          turnId: recovered.turnId,
          deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
          report: input.report,
          expectedOutput:
            `PHASE0_REAL_CRASH_${window.toUpperCase()}`,
        });
        exactTerminalObserved = true;
      }
      recoveredAttempt =
        await recoveryJournal.inspectAttempt(recovered.attemptId);
      if (!recoveredAttempt) {
        throw new Phase0VerificationError(
          "real_cross_process_attempt_missing",
          `${window} recovery attempt was not durably readable`,
        );
      }
    } finally {
      recoveryJournal.close();
    }
    const after = await input.shellControl.readThreadWithTurns({
      threadId: input.shell.threadId,
      includeTurns: true,
    });
    const beforeIds = new Set(before.turns.map(({ turnId }) => turnId));
    const created = after.turns.filter(({ turnId }) => !beforeIds.has(turnId));
    const recoveryMethodCounts = Object.fromEntries(
      Object.entries(input.report.appServerMethodCounts).map(
        ([method, count]) => [
          method,
          count - (recoveryMethodCountsBefore[method] ?? 0),
        ],
      ),
    );
    let branch: ReturnType<typeof validateRealCrashRecoveryBranch>;
    try {
      branch = validateRealCrashRecoveryBranch({
        window,
        recoveredState: recovered.state,
        ...(recovered.turnId ? { recoveredTurnId: recovered.turnId } : {}),
        createdTurnIds: created.map(({ turnId }) => turnId),
        recoveryFollowerStartDelta:
          input.report.actualStartAttempts.length
          - recoveryFollowerStartsBefore,
        recoveryAppServerMethodCounts: recoveryMethodCounts,
        exactTerminalObserved,
      });
    } catch {
      throw new Phase0VerificationError(
        "real_cross_process_recovery_invalid",
        `${window} did not preserve its allowed 0|1 recovery branch`,
      );
    }
    recordStartAttemptEvidence(
      input.report,
      recoveredAttempt!,
      branch.outcome === "quarantined"
        ? "quarantined"
        : window === "before_dispatch_cas"
          ? "started"
          : "adopted",
      branch.outcome === "quarantined" ? "ambiguous" : "started",
    );
    const evidenceIndex = input.report.startAttemptEvidence.findIndex(
      ({ attemptId }) => attemptId === recoveredAttempt!.attemptId,
    );
    input.report.startAttemptEvidence[evidenceIndex] = {
      ...input.report.startAttemptEvidence[evidenceIndex]!,
      correlatedTurnCount: branch.correlatedTurnCount,
    };
    facts.push(
      `${window}:child_attempt=${childEvidence.attemptId}`
      + `:checkpoint=${childEvidence.state}`
      + `:dispatch_ordinal=${childEvidence.dispatchOrdinal}`
      + `:recovered=${recovered.state}`
      + `:real_turn_delta=${created.length}`
      + `:recovery_follower_start_delta=${
        input.report.actualStartAttempts.length - recoveryFollowerStartsBefore
      }`
      + `:recovery_method_counts=${JSON.stringify(recoveryMethodCounts)}`
      + `:pre_start_turn_ids=${JSON.stringify(
        childEvidence.preStartTurnIds,
      )}`
      + `:pre_start_hash=${childEvidence.preStartSemanticHash}`
      + `:prompt_hash=${childEvidence.normalizedPromptHash}`
      + `:marker=${childEvidence.correlationMarker}`
      + `:child_method_counts=${JSON.stringify(
        childEvidence.childAppServerMethodCounts,
      )}`,
    );
  }
  satisfyStrictEvidence(
    input.report,
    "real_cross_process_failpoints",
    facts,
  );
}

async function main(): Promise<void> {
  const root = process.cwd();
  const resumeIndex = process.argv.indexOf("--resume");
  const resumeRunId = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined;
  if (resumeIndex >= 0 && !/^[0-9a-f-]{36}$/i.test(resumeRunId ?? "")) {
    throw new Phase0VerificationError(
      "desktop_restart_resume_id_invalid",
      "--resume requires the prior Phase 0 run UUID",
    );
  }
  const runId = resumeRunId ?? randomUUID();
  const freshReport: VerificationReport = {
    phase: "phase0",
    schemaVersion: PHASE0_REPORT_SCHEMA_VERSION,
    status: "BLOCKED",
    runId,
    registrationName: `stagepass-phase0-${runId}`,
    startedAt: new Date().toISOString(),
    protocol: {},
    capabilities: {
      shellControlObserved: [],
      desktopFollowerObserved: [],
      shellControlProtocolSupported: [],
      desktopFollowerProtocolSupported: [],
    },
    securityBoundary: {
      supervisorDirectParentAttestation: "signed_codex_direct_parent",
      protectedChannel: "instance_local_inherited_fd",
      serverLaunchAttestation: "unsupported",
      serverLaunchRecordTrust: "unsupported",
      serverBundleDigestTrust: "integrity_only_not_peer_identity",
      failureCode: "phase0_server_launch_attestation_unsupported",
    },
    checks: CHECK_MANIFEST.map(({ name, evidence }) => ({
      name,
      requiredEvidence: evidence,
      status: "pending",
    })),
    strictEvidence: {},
    actualStartAttempts: [],
    startAttemptEvidence: [],
    turnReadEvidence: {
      includeTurnsCalls: 0,
      turnNotYetVisibleCount: 0,
      semanticObservations: 0,
      reconnects: 0,
    },
    shellIds: [],
    followerTurnIds: [],
    deepLinkUrls: [],
    provisioningActivationUrls: [],
    appServerMethodCounts: {
      "initialize": 0,
      "thread/start": 0,
      "thread/name/set": 0,
      "thread/list": 0,
      "thread/read": 0,
      "model/list": 0,
      "turn/start": 0,
    },
    desktopMethodCounts: {
      "initialize": 0,
      "thread-follower-start-turn": 0,
      "thread-follower-interrupt-turn": 0,
    },
    followerDispatchEvidence: [],
    failureCodes: [],
    evidenceNotes: [
      "Prior observation only, not counted: persistent app-server shell plus name was deep-linkable.",
      "Prior observation only, not counted: about 1 second produced no-client-found; about 10 seconds reached the Desktop follower and completed.",
      "Prior observation only, not counted: a second Desktop follower turn completed on the same persistent shell.",
      "Prior observation only, not counted: an independent app-server thread/read(includeTurns:true) observed both Desktop-started turns and terminal metadata.",
      "Conversation-only host tools are not treated as backend capabilities.",
      "This run uses a disposable file-backed SQLite journal under .stagepass/verification; it does not claim the later production migration.",
      "A requested turn missing from thread/read is recorded as turn_not_yet_visible and never triggers a start.",
      "Server launch attestation is explicitly unsupported: public Node/macOS APIs used here expose no peer PID or audit token for inherited fd 3, so the verifier does not claim Server-side peer identity.",
      "The generated Server bundle SHA-256 is recorded only as an integrity observation; neither it nor a Server-authored launch record authenticates the process at the peer channel.",
    ],
  };
  const reportPath = path.join(
    root,
    ".stagepass",
    "verification",
    `codex-desktop-bridge-phase0-${runId}.json`,
  );
  const expectedRegistrationName = `stagepass-phase0-${runId}`;
  let report: VerificationReport;
  if (resumeRunId) {
    const persistedReport: unknown = JSON.parse(
      await fs.readFile(reportPath, "utf8"),
    );
    validatePhase0ReportEnvelope(persistedReport, {
      runId,
      registrationName: expectedRegistrationName,
      checks: CHECK_MANIFEST.map(({ name, evidence }) => ({
        name,
        requiredEvidence: evidence,
      })),
    });
    report = persistedReport as VerificationReport;
  } else {
    report = freshReport;
  }
  report.provisioningActivationUrls ??= [];
  report.strictEvidence ??= {};
  report.checks = CHECK_MANIFEST.map(({ name, evidence }) => {
    const persisted = report.checks.find((check) => check.name === name);
    const requiresStrictEvidence = (
      evidence === "real_cross_process_failpoints"
      || evidence === "real_shell_materialization"
      || evidence === "real_visibility_lag"
      || evidence === "real_snapshot_replay"
      || evidence === "real_auth_negative_matrix"
      || evidence === "real_durable_click"
    );
    const strictEvidenceMissing = requiresStrictEvidence
      && !report.strictEvidence[evidence]?.satisfied;
    return {
      name,
      requiredEvidence: evidence,
      status: strictEvidenceMissing && persisted?.status === "passed"
        ? "blocked"
        : persisted?.status ?? "pending",
      ...(strictEvidenceMissing && persisted?.status === "passed"
        ? { failureCode: `${evidence}_missing` }
        : persisted?.failureCode
        ? { failureCode: persisted.failureCode }
        : {}),
    };
  });
  report.securityBoundary ??= freshReport.securityBoundary;
  report.securityBoundary.serverLaunchRecordTrust ??= "unsupported";
  report.securityBoundary.serverBundleDigestTrust ??=
    "integrity_only_not_peer_identity";

  const supervisorPath = path.join(
    root,
    ".stagepass",
    "phase0-mcp",
    "supervisor.mjs",
  );
  let registrationAdded = false;
  let attestedCodexBin: string | undefined;
  let journal: CodexPhase0SqliteJournal | undefined;
  try {
    await ensureFixtureBuilt(root);
    report.securityBoundary.serverBundleSha256 = createHash("sha256")
      .update(await fs.readFile(
        path.join(root, ".stagepass", "phase0-mcp", "server.mjs"),
      ))
      .digest("hex");
    const verificationDirectory = path.join(
      root,
      ".stagepass",
      "verification",
    );
    await fs.mkdir(verificationDirectory, { recursive: true, mode: 0o700 });
    const verificationDatabasePath = path.join(
      verificationDirectory,
      `codex-desktop-bridge-phase0-${runId}.sqlite`,
    );
    const discoveryDependencies =
      defaultCodexDesktopDiscoveryDependencies();
    const endpoint = await discoverCodexDesktopIpcEndpoint(
      discoveryDependencies,
    );
    attestedCodexBin = endpoint.appServerBinary.path;
    const shellControl = createCodexAppServerShellControl({
      appServerBinary: endpoint.appServerBinary,
      onRequest(method) {
        report.appServerMethodCounts[method] =
          (report.appServerMethodCounts[method] ?? 0) + 1;
        if (method === "thread/read") {
          report.turnReadEvidence.includeTurnsCalls += 1;
        }
      },
    });
    journal = createCodexPhase0SqliteJournal({
      databasePath: verificationDatabasePath,
      async readBaseline(request) {
        const snapshot = await shellControl.readThreadWithTurns({
          threadId: request.threadId,
          includeTurns: true,
        });
        return {
          turnIds: snapshot.turns.map(({ turnId }) => turnId),
          semanticHash: codexTurnSetSemanticHash(snapshot.turns),
        };
      },
    });
    const durableRestartCheckpoint =
      journal.readRestartCheckpoint(runId);
    let restartCheckpointConsumed = false;
    if (resumeRunId) {
      if (!durableRestartCheckpoint) {
        throw new Phase0VerificationError(
          "desktop_restart_checkpoint_missing",
          "the Phase 0 SQLite journal has no restart checkpoint to resume",
        );
      }
      if (durableRestartCheckpoint.state === "consumed") {
        const rebuiltCheckpoint =
          restartCheckpointEvidenceFromDurable(
            durableRestartCheckpoint,
          );
        if (
          report.restartCheckpoint
          && JSON.stringify(report.restartCheckpoint)
            !== JSON.stringify(rebuiltCheckpoint)
        ) {
          throw new Phase0VerificationError(
            "desktop_restart_report_sqlite_mismatch",
            "persisted report and consumed SQLite checkpoint identity differ",
          );
        }
        report.restartCheckpoint = rebuiltCheckpoint;
        delete report.restartCompletion;
        restartCheckpointConsumed = true;
      } else if (report.restartCompletion) {
        throw new Phase0VerificationError(
          "desktop_restart_report_sqlite_mismatch",
          "the report claims completion while SQLite is awaiting resume",
        );
      } else {
        try {
          report.restartCheckpoint = reconcileRestartCheckpointEvidence(
            report.restartCheckpoint,
            durableRestartCheckpoint,
          );
        } catch {
          throw new Phase0VerificationError(
            "desktop_restart_report_sqlite_mismatch",
            "persisted report and SQLite restart checkpoint evidence differ",
          );
        }
      }
    } else if (durableRestartCheckpoint) {
      throw new Phase0VerificationError(
        "desktop_restart_checkpoint_unexpected",
        "a fresh Phase 0 run unexpectedly found a durable restart checkpoint",
      );
    }
    const desktopIdentity = await readDesktopIdentity(endpoint);
    const follower = recordingFollower(
      createObservedCodexDesktopFollowerTransport(endpoint, {
        onRequest(method, params) {
          recordDesktopRequest(report, method, params);
        },
      }),
      report,
    );
    const readDisconnect = withForcedReadDisconnect({
      appServerBinary: endpoint.appServerBinary,
      shellControl,
      cwd: root,
      report,
    });
    const primaryScope = {
      kind: "project_context" as const,
      scopeId: `phase0-${runId}`,
      projectId: `phase0-${runId}`,
    };
    const primaryTitle =
      `[PHASE0 ${runId}] Codex MCP Host verification`;
    let bootstrapProof: {
      provisionId: string;
      candidateThreadId: string;
      creatorBaselineTurnIds: string[];
      creatorBaselineSemanticHash: string;
      materializationLogicalTurnId: null;
    } | undefined;
    const durableShellProvisionPort = journal.shellProvisionPort;
    const shellProvisionPort = {
      ...durableShellProvisionPort,
      async recordBootstrapReady(
        input: Parameters<
          typeof durableShellProvisionPort.recordBootstrapReady
        >[0],
      ) {
        await durableShellProvisionPort.recordBootstrapReady(input);
        const inspected = journal!.inspectShellProvision(
          primaryScope.kind,
          primaryScope.scopeId,
        );
        const independentlyListed =
          await shellControl.listPersistentShells({ cwd: root });
        if (
          inspected.state !== "bootstrap_ready"
          || inspected.candidateThreadId !== input.threadId
          || inspected.threadId !== null
          || inspected.materializationLogicalTurnId !== null
          || inspected.creatorBaselineTurnIds?.length !== 0
          || !inspected.creatorBaselineSemanticHash
          || independentlyListed.some(
            ({ threadId }) => threadId === input.threadId,
          )
        ) {
          throw new Phase0VerificationError(
            "creator_bootstrap_proof_invalid",
            "creator proof did not persist an independently invisible zero-turn candidate",
          );
        }
        bootstrapProof = {
          provisionId: inspected.provisionId,
          candidateThreadId: input.threadId,
          creatorBaselineTurnIds: inspected.creatorBaselineTurnIds,
          creatorBaselineSemanticHash:
            inspected.creatorBaselineSemanticHash,
          materializationLogicalTurnId: null,
        };
        markPassed(report, "persistent_shell_provisioned_and_named");
      },
    };
    if (resumeRunId) {
      if (!report.bootstrapCrashRecoveryEvidence) {
        throw new Phase0VerificationError(
          "bootstrap_crash_resume_evidence_missing",
          "resume requires persisted independent bootstrap crash evidence",
        );
      }
      await reconcileBootstrapCrashRecoveryJournal({
        root,
        verificationDirectory,
        runId,
        evidence: report.bootstrapCrashRecoveryEvidence,
      });
      const persistedEvidence = report.shellMaterializationEvidence;
      const persistedCheckpoint = report.restartCheckpoint;
      const inspected = journal.inspectShellProvision(
        primaryScope.kind,
        primaryScope.scopeId,
      );
      const stableEmptyBaselineHash = codexTurnSetSemanticHash([]);
      if (
        !persistedEvidence
        || !persistedCheckpoint
        || inspected.state !== "durable_ready"
        || inspected.cwd !== root
        || inspected.title !== primaryTitle
        || inspected.candidateThreadId !== persistedEvidence.candidateThreadId
        || inspected.threadId !== persistedEvidence.candidateThreadId
        || inspected.creatorBaselineTurnIds?.length !== 0
        || inspected.creatorBaselineSemanticHash !== stableEmptyBaselineHash
        || !Array.isArray(persistedEvidence.creatorBaselineTurnIds)
        || persistedEvidence.creatorBaselineTurnIds.length !== 0
        || persistedEvidence.creatorBaselineSemanticHash
          !== stableEmptyBaselineHash
        || inspected.materializationLogicalTurnId
          !== persistedEvidence.materializationLogicalTurnId
        || inspected.attempt?.attemptId !== persistedEvidence.attemptId
        || inspected.attempt?.state !== "succeeded"
        || inspected.attempt?.dispatchOrdinal
          !== persistedEvidence.dispatchOrdinal
        || inspected.attempt?.turnId !== persistedEvidence.turnId
        || inspected.attempt?.correlationMarker
          !== persistedEvidence.correlationMarker
        || inspected.candidateCount !== 1
        || inspected.attemptCount !== 1
        || inspected.executionCount !== 1
        || persistedEvidence.attemptState !== "succeeded"
        || persistedEvidence.dispatchOrdinal < 1
        || persistedEvidence.threadStartCount !== 1
        || persistedEvidence.initialInvocationThreadStartCount !== 1
        || (report.appServerMethodCounts["thread/start"] ?? 0) !== 1
        || persistedCheckpoint.shellThreadId
          !== persistedEvidence.candidateThreadId
        || !persistedCheckpoint.lastNormalizedSnapshot
        || persistedCheckpoint.observedTurnId
          !== persistedCheckpoint.lastNormalizedSnapshot.turnId
        || persistedCheckpoint.shellThreadId
          !== persistedCheckpoint.lastNormalizedSnapshot.threadId
        || !report.shellIds.includes(persistedEvidence.candidateThreadId)
        || !report.followerTurnIds.includes(
          persistedCheckpoint.observedTurnId,
        )
        || !report.bootstrapCrashRecoveryEvidence
        || !report.bootstrapCrashRecoveryEvidence.childAppServerMethodCounts
        || !report.bootstrapCrashRecoveryEvidence
          .recoveryAppServerMethodCounts
        || report.bootstrapCrashRecoveryEvidence.childThreadStartCount !== 1
        || report.bootstrapCrashRecoveryEvidence
          .recoveryThreadStartCount !== 0
        || report.bootstrapCrashRecoveryEvidence
          .childAppServerMethodCounts["thread/start"] !== 1
        || report.bootstrapCrashRecoveryEvidence.preStartTurnIds.length !== 0
        || report.bootstrapCrashRecoveryEvidence.preStartSemanticHash
          !== stableEmptyBaselineHash
        || !report.bootstrapCrashRecoveryEvidence.normalizedPromptHash
        || !report.bootstrapCrashRecoveryEvidence.correlationMarker
        || report.bootstrapCrashRecoveryEvidence.recoveryOutcome !== "started"
        || report.bootstrapCrashRecoveryEvidence.correlatedTurnCount !== 1
        || report.bootstrapCrashRecoveryEvidence.candidateCount !== 1
        || report.bootstrapCrashRecoveryEvidence.attemptCount !== 1
        || report.bootstrapCrashRecoveryEvidence.executionCount !== 1
        || report.bootstrapCrashRecoveryEvidence
          .resumeReconciliationCount !== 1
        || (
          report.bootstrapCrashRecoveryEvidence
            .recoveryAppServerMethodCounts["thread/start"] ?? 0
        ) !== 0
      ) {
        throw new Phase0VerificationError(
          "desktop_restart_resume_evidence_mismatch",
          "persisted bootstrap, materialization, report, and restart checkpoint identities do not match",
        );
      }
      bootstrapProof = {
        provisionId: inspected.provisionId,
        candidateThreadId: persistedEvidence.candidateThreadId,
        creatorBaselineTurnIds: [...inspected.creatorBaselineTurnIds],
        creatorBaselineSemanticHash:
          inspected.creatorBaselineSemanticHash,
        materializationLogicalTurnId: null,
      };
      markPassed(report, "persistent_shell_provisioned_and_named");
    }
    const bridge = createCodexDesktopBridge({
      shellControl: readDisconnect.shellControl,
      follower,
      startAttemptPort: journal.startAttemptPort,
      logicalTurnPort: journal.logicalTurnPort,
      shellProvisionPort,
    });
    const [shellProbe, followerProbe] = await Promise.all([
      shellControl.probe(),
      follower.probe(),
    ]);
    report.protocol = {
      appServerVersion: sanitizedToken(shellProbe.version, "unreported"),
      appServerFingerprint: sanitizedToken(
        shellProbe.protocolFingerprint,
        "unreported",
      ),
      desktopClientVersion: sanitizedToken(
        followerProbe.clientVersion,
        "unreported",
      ),
      desktopFollowerFingerprint: sanitizedToken(
        followerProbe.protocolFingerprint,
        "unreported",
      ),
    };

    // Probe only the two backend runtime boundaries before any task or MCP
    // registration mutation. Host/App claims are assessed independently below.
    const bridgeProbe = await bridge.probe();
    report.capabilities = {
      shellControlObserved: bridgeProbe.shellCapabilities,
      desktopFollowerObserved: bridgeProbe.followerCapabilities,
      shellControlProtocolSupported: bridgeProbe.shellProtocolCapabilities,
      desktopFollowerProtocolSupported:
        bridgeProbe.followerProtocolCapabilities,
    };

    const primaryThreadStartsBefore =
      report.appServerMethodCounts["thread/start"] ?? 0;
    const shell = await bridge.ensurePersistentShell({
      projectPath: root,
      scope: primaryScope,
      title: primaryTitle,
      provisionFence: {
        ownerId: `phase0-shell-worker-${runId}`,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    });
    const durableProof = journal.inspectShellProvision(
      primaryScope.kind,
      primaryScope.scopeId,
    );
    const primaryInvocationThreadStartCount =
      (report.appServerMethodCounts["thread/start"] ?? 0)
      - primaryThreadStartsBefore;
    const expectedPrimaryInvocationThreadStartCount =
      resumeRunId ? 0 : 1;
    if (
      !bootstrapProof
      || durableProof.state !== "durable_ready"
      || durableProof.candidateThreadId !== shell.threadId
      || durableProof.threadId !== shell.threadId
      || !durableProof.materializationLogicalTurnId
      || durableProof.attempt?.state !== "succeeded"
      || !durableProof.attempt.turnId
      || durableProof.attempt.dispatchOrdinal < 1
      || durableProof.creatorBaselineTurnIds?.length !== 0
      || durableProof.creatorBaselineSemanticHash
        !== codexTurnSetSemanticHash([])
      || durableProof.candidateCount !== 1
      || durableProof.attemptCount !== 1
      || durableProof.executionCount !== 1
      || primaryInvocationThreadStartCount
        !== expectedPrimaryInvocationThreadStartCount
      || (report.appServerMethodCounts["thread/start"] ?? 0) !== 1
    ) {
      throw new Phase0VerificationError(
        "shell_materialization_proof_invalid",
        "durable shell materialization journal proof or exact counts are invalid",
      );
    }
    recordStartAttemptEvidence(
      report,
      durableProof.attempt,
      resumeRunId ? "recovered_succeeded" : "started",
    );
    report.shellMaterializationEvidence = {
      provisionId: durableProof.provisionId,
      candidateThreadId: shell.threadId,
      bootstrapState: "bootstrap_ready",
      creatorBaselineTurnIds: [...bootstrapProof.creatorBaselineTurnIds],
      creatorBaselineSemanticHash:
        bootstrapProof.creatorBaselineSemanticHash,
      preMaterializationIndependentVisible: false,
      durableState: "durable_ready",
      materializationLogicalTurnId:
        durableProof.materializationLogicalTurnId,
      attemptId: durableProof.attempt.attemptId,
      attemptState: "succeeded",
      dispatchOrdinal: durableProof.attempt.dispatchOrdinal,
      turnId: durableProof.attempt.turnId,
      correlationMarker: durableProof.attempt.correlationMarker,
      threadStartCount: 1,
      initialInvocationThreadStartCount: 1,
      ...(resumeRunId ? { resumeInvocationThreadStartCount: 0 as const } : {}),
      candidateCount: 1,
      attemptCount: durableProof.attemptCount as 1,
      executionCount: durableProof.executionCount as 1,
    };
    satisfyStrictEvidence(report, "real_shell_materialization", [
      `candidate=${shell.threadId}`,
      `logical_turn=${durableProof.materializationLogicalTurnId}`,
      `attempt=${durableProof.attempt.attemptId}`,
      "attempt_state=succeeded",
      `dispatch_ordinal=${durableProof.attempt.dispatchOrdinal}`,
      `turn=${durableProof.attempt.turnId}`,
      `marker=${durableProof.attempt.correlationMarker}`,
      `creator_baseline_ids=${JSON.stringify(
        bootstrapProof.creatorBaselineTurnIds,
      )}`,
      `creator_baseline_hash=${
        bootstrapProof.creatorBaselineSemanticHash
      }`,
      "pre_materialization_independent_visible=false",
      "thread_start_count=1",
      `invocation_thread_start_count=${
        primaryInvocationThreadStartCount
      }`,
      "candidate_count=1",
      "attempt_count=1",
      "execution_count=1",
      "promotion=durable_ready",
    ]);
    if (report.bootstrapCrashRecoveryEvidence) {
      report.strictEvidence.real_shell_materialization!.facts.push(
        `bootstrap_crash_candidate=${
          report.bootstrapCrashRecoveryEvidence.candidateThreadId
        }`,
        "bootstrap_crash_child_thread_start_count=1",
        "bootstrap_crash_recovery_thread_start_count=0",
        `bootstrap_crash_dispatch_ordinal=${
          report.bootstrapCrashRecoveryEvidence.dispatchOrdinal
        }`,
        `bootstrap_crash_journal_id=${
          report.bootstrapCrashRecoveryEvidence.journalId
        }`,
        "bootstrap_crash_candidate_count=1",
        "bootstrap_crash_attempt_count=1",
        "bootstrap_crash_execution_count=1",
        `bootstrap_crash_resume_reconciliation_count=${
          report.bootstrapCrashRecoveryEvidence.resumeReconciliationCount
        }`,
      );
    }
    markPassed(report, "shell_materialized_and_independently_proved");
    if (!report.shellIds.includes(shell.threadId)) {
      report.shellIds.push(shell.threadId);
    }
    if (!report.bootstrapCrashRecoveryEvidence) {
      await proveBootstrapReadyCrashRecovery({
        root,
        databasePath: path.join(
          verificationDirectory,
          `codex-desktop-bridge-phase0-${runId}-bootstrap-ready-crash.sqlite`,
        ),
        runId,
        shellControl,
        follower,
        report,
      });
    }
    const provisioningActivationUrl =
      `codex://threads/${shell.threadId}` as const;
    if (!report.deepLinkUrls.includes(provisioningActivationUrl)) {
      throw new Phase0VerificationError(
        "provision_activation_not_observed",
        "persistent shell provisioning did not record its Desktop activation",
      );
    }
    report.provisioningActivationUrls.push(provisioningActivationUrl);
    const models = await shellControl.listModels();
    if (models.length === 0) {
      throw new Phase0VerificationError(
        "model_list_empty",
        "real app-server model/list returned no models",
      );
    }
    markPassed(report, "shell_control_read_list_and_model_catalog_work");
    const selectedModel = models[0]!;
    const selectedEffort = selectedModel.supportedReasoningEfforts?.[0]
      ?? selectedModel.defaultReasoningEffort;

    if (!report.restartCheckpoint) {
      const checkpointSeed = await journal.seedManagedRun({
        ownerKind: "project_ai_run",
        ownerId: `phase0-restart-checkpoint-${runId}`,
        projectId: `phase0-${runId}`,
        scopeKind: "project_context",
        scopeId: `phase0-${runId}`,
        phase: "Phase0",
        role: "context_select",
        round: 0,
        ordinal: 0,
        purpose: "stage_run",
        binding: {
          threadId: shell.threadId,
          cwd: root,
          title: shell.title,
        },
        request: {
          cwd: root,
          prompt: "Reply exactly PHASE0_RESTART_CHECKPOINT_READY",
          model: selectedModel.model,
          ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
          approvalPolicy: "never",
          sandboxMode: "read-only",
        },
        deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
      const checkpointTurn = await bridge.startTurn({
        logicalTurnId: checkpointSeed.logicalTurnId,
      });
      report.followerTurnIds.push(checkpointTurn.turnId);
      await inspectAndRecordStartAttempt({
        journal,
        report,
        attemptId: checkpointTurn.attemptId,
        recoveryOutcome: "started",
      });
      const checkpointObservation = await readTerminalTurn({
        bridge,
        threadId: shell.threadId,
        turnId: checkpointTurn.turnId,
        deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        report,
        expectedOutput: "PHASE0_RESTART_CHECKPOINT_READY",
      });
      await journal.saveRestartCheckpoint({
        runId,
        logicalTurnId: checkpointSeed.logicalTurnId,
        shellThreadId: shell.threadId,
        ...desktopIdentity,
        observationCursor: checkpointObservation.cursor,
        lastSnapshotHash: checkpointObservation.lastSnapshotHash,
        lastNormalizedSnapshot: checkpointObservation.terminal,
      });
      const savedRestartCheckpoint =
        journal.readRestartCheckpoint(runId);
      if (!savedRestartCheckpoint) {
        throw new Phase0VerificationError(
          "desktop_restart_checkpoint_not_durable",
          "SQLite did not persist the restart checkpoint",
        );
      }
      report.restartCheckpoint = reconcileRestartCheckpointEvidence(
        undefined,
        savedRestartCheckpoint,
      );
      markBlocked(
        report,
        "read_reconnect_and_semantic_snapshot_rules",
        "awaiting_desktop_restart",
      );
      report.evidenceNotes.push(
        `Restart Codex Desktop, then run: pnpm verify:codex-desktop-bridge -- --resume ${runId}`,
      );
      printBlocked(
        report,
        "awaiting_desktop_restart",
        `restart Codex Desktop and resume run ${runId}`,
      );
      return;
    }

    if (restartCheckpointConsumed) {
      const consumedCheckpoint = journal.readRestartCheckpoint(runId);
      if (
        !consumedCheckpoint
        || consumedCheckpoint.state !== "consumed"
        || !consumedCheckpoint.resumedAttemptId
        || !consumedCheckpoint.resumedTurnId
      ) {
        throw new Phase0VerificationError(
          "desktop_restart_tombstone_invalid",
          "the durable restart tombstone is incomplete",
        );
      }
      const resumedAttempt = await journal.inspectAttempt(
        consumedCheckpoint.resumedAttemptId,
      );
      if (!resumedAttempt) {
        throw new Phase0VerificationError(
          "desktop_restart_resume_attempt_missing",
          "the consumed resume attempt is absent from SQLite",
        );
      }
      const resumedThread = await shellControl.readThreadWithTurns({
        threadId: consumedCheckpoint.shellThreadId,
        includeTurns: true,
      });
      const resumedSnapshot = resumedThread.turns.find(
        ({ turnId }) => turnId === consumedCheckpoint.resumedTurnId,
      );
      if (!resumedSnapshot) {
        throw new Phase0VerificationError(
          "desktop_restart_resume_terminal_missing",
          "the consumed resume turn is not observable in its canonical shell",
        );
      }
      let downstreamSentinelCount = 0;
      try {
        const disposition = await orchestratePhase0RestartResume({
          checkpoint: consumedCheckpoint,
          persistedReportCheckpoint: report.restartCheckpoint,
          consumedExecution: {
            attempt: resumedAttempt,
            snapshot: resumedSnapshot,
          },
          async startRestart() {
            throw new Error(
              "consumed restart must not start or recover another turn",
            );
          },
          async consumeRestart() {
            throw new Error(
              "consumed restart must not consume its checkpoint twice",
            );
          },
          async continueDownstream(completion) {
            downstreamSentinelCount += 1;
            return completion;
          },
        });
        report.restartCompletion = disposition.completion;
      } catch {
        throw new Phase0VerificationError(
          "desktop_restart_tombstone_invalid",
          "the consumed resume attempt or exact terminal evidence drifted",
        );
      }
      if (downstreamSentinelCount !== 1) {
        throw new Phase0VerificationError(
          "desktop_restart_downstream_not_authorized",
          "consumed restart did not authorize downstream Phase 0 exactly once",
        );
      }
      recordStartAttemptEvidence(
        report,
        resumedAttempt,
        "recovered_succeeded",
      );
      if (!report.followerTurnIds.includes(resumedSnapshot.turnId)) {
        report.followerTurnIds.push(resumedSnapshot.turnId);
      }
      markPassed(
        report,
        "read_reconnect_and_semantic_snapshot_rules",
      );
      report.evidenceNotes.push(
        "Restart completion rebuilt from the SQLite tombstone with zero follower redispatch.",
      );
      delete report.restartCheckpoint;
    } else {
      if (sameDesktopIdentity(desktopIdentity, report.restartCheckpoint)) {
      markBlocked(
        report,
        "read_reconnect_and_semantic_snapshot_rules",
        "desktop_restart_not_observed",
      );
      printBlocked(
        report,
        "desktop_restart_not_observed",
        "Codex Desktop process and socket identity have not changed",
      );
      return;
      }
      const duplicateCursor = report.restartCheckpoint.observationCursor;
      readDisconnect.arm();
      let duplicateObservations = 0;
      for await (const observation of bridge.pollTurn({
      threadId: report.restartCheckpoint.shellThreadId,
      turnId: report.restartCheckpoint.observedTurnId,
      afterCursor: report.restartCheckpoint.observationCursor,
      lastSnapshotHash: report.restartCheckpoint.lastSnapshotHash,
      lastNormalizedSnapshot: report.restartCheckpoint.lastNormalizedSnapshot,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      })) {
        if (observation.kind === "observation") {
          duplicateObservations += 1;
          if (observation.cursor !== duplicateCursor) {
            throw new Phase0VerificationError(
              "restart_duplicate_cursor_advanced",
              "a duplicate recovered snapshot advanced the persisted cursor",
            );
          }
        }
      }
      if (
        !readDisconnect.wasObserved()
        || report.turnReadEvidence.reconnects < 1
        || duplicateObservations !== 0
      ) {
        throw new Phase0VerificationError(
          "app_server_read_reconnect_not_observed",
          "restart verification did not recover from a real read disconnect without duplicating the persisted snapshot",
        );
      }
      const prior = await shellControl.readThreadWithTurns({
      threadId: report.restartCheckpoint.shellThreadId,
      includeTurns: true,
      });
      if (
        prior.shell.threadId !== shell.threadId
        || !prior.turns.some(
          ({ turnId }) => turnId === report.restartCheckpoint?.observedTurnId,
        )
      ) {
        throw new Phase0VerificationError(
          "desktop_restart_shell_not_recovered",
          "canonical shell or prior observed turn did not survive Desktop restart",
        );
      }
      const resumedSeed = await journal.seedManagedRun({
      ownerKind: "project_ai_run",
      ownerId: `phase0-restart-resumed-${runId}`,
      projectId: `phase0-${runId}`,
      scopeKind: "project_context",
      scopeId: `phase0-${runId}`,
      phase: "Phase0",
      role: "context_generate",
      round: 0,
      ordinal: 0,
      purpose: "stage_run",
      binding: {
        threadId: shell.threadId,
        cwd: root,
        title: shell.title,
      },
      request: {
        cwd: root,
        prompt: "Reply exactly PHASE0_RESTART_RESUME_OK",
        model: selectedModel.model,
        ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
      const existingResumedAttempt =
        await journal.inspectAttemptByLogicalTurn(resumedSeed.logicalTurnId);
      let resumedTurn: { attemptId: string; turnId: string };
      let resumedRecoveryOutcome: "started" | "recovered_succeeded";
      if (existingResumedAttempt) {
        const recovered = await bridge.recoverTurn({
        logicalTurnId: resumedSeed.logicalTurnId,
        });
        if (recovered.state !== "succeeded" || !recovered.turnId) {
          throw new Phase0VerificationError(
            "desktop_restart_resume_recovery_invalid",
            "the existing durable resume attempt was not successfully recoverable",
          );
        }
        resumedTurn = {
          attemptId: recovered.attemptId,
          turnId: recovered.turnId,
        };
        resumedRecoveryOutcome = "recovered_succeeded";
      } else {
        resumedTurn = await bridge.startTurn({
          logicalTurnId: resumedSeed.logicalTurnId,
        });
        resumedRecoveryOutcome = "started";
      }
      report.followerTurnIds.push(resumedTurn.turnId);
      await readTerminalTurn({
        bridge,
        threadId: shell.threadId,
        turnId: resumedTurn.turnId,
        deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        report,
        expectedOutput: "PHASE0_RESTART_RESUME_OK",
      });
      const durableResumedAttempt = await inspectAndRecordStartAttempt({
        journal,
        report,
        attemptId: resumedTurn.attemptId,
        recoveryOutcome: resumedRecoveryOutcome,
      });
      const restartCheckpointBeforeConsume =
        journal.readRestartCheckpoint(runId);
      if (
        !restartCheckpointBeforeConsume
        || restartCheckpointBeforeConsume.state !== "awaiting_resume"
      ) {
        throw new Phase0VerificationError(
          "desktop_restart_checkpoint_not_awaiting",
          "the durable restart checkpoint was not awaiting consumption",
        );
      }
      await journal.consumeRestartCheckpoint({
        runId,
        expectedAttemptId: restartCheckpointBeforeConsume.attemptId,
        expectedDispatchOrdinal:
          restartCheckpointBeforeConsume.dispatchOrdinal,
        expectedTurnId: restartCheckpointBeforeConsume.turnId,
        expectedResumedLogicalTurnId: resumedSeed.logicalTurnId,
        expectedResumedAttemptId: durableResumedAttempt.attemptId,
        expectedResumedThreadId:
          durableResumedAttempt.request.threadId,
        expectedResumedCanonicalBindingThreadId: shell.threadId,
        expectedResumedNormalizedPromptHash:
          durableResumedAttempt.normalizedPromptHash,
      });
      const restartTombstone = journal.readRestartCheckpoint(runId);
      if (
        !restartTombstone
        || restartTombstone.state !== "consumed"
        || restartTombstone.resumedAttemptId !== resumedTurn.attemptId
        || restartTombstone.resumedTurnId !== resumedTurn.turnId
      ) {
        throw new Phase0VerificationError(
          "desktop_restart_tombstone_invalid",
          "SQLite did not durably consume the restart checkpoint",
        );
      }
      report.restartCompletion = reconcileConsumedRestartCompletion(
        restartTombstone,
        durableResumedAttempt,
        (
          await shellControl.readThreadWithTurns({
            threadId: restartTombstone.shellThreadId,
            includeTurns: true,
          })
        ).turns.find(({ turnId }) => turnId === resumedTurn.turnId)!,
      );
      report.evidenceNotes.push(
        `Restart checkpoint consumed from SQLite via ${resumedRecoveryOutcome}.`,
      );
      markPassed(
        report,
        "read_reconnect_and_semantic_snapshot_rules",
      );
      delete report.restartCheckpoint;
    }
    if (!report.strictEvidence.real_cross_process_failpoints?.satisfied) {
      await proveRealCrossProcessCrashWindows({
        root,
        databasePath: verificationDatabasePath,
        shell,
        shellControl,
        follower,
        journal,
        model: selectedModel.model,
        ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
        runId,
        report,
      });
    }

    const isolatedChanges = [];
    for (const ordinal of [1, 2]) {
      const changeId = `phase0-${runId}-change-${ordinal}`;
      const isolated = await bridge.ensurePersistentShell({
        projectPath: root,
        scope: {
          kind: "change",
          scopeId: changeId,
          projectId: `phase0-${runId}`,
          changeId,
        },
        title: `[${changeId}] Isolated`,
        provisionFence: {
          ownerId: `phase0-change-shell-worker-${ordinal}`,
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      });
      const isolatedProvision = journal.inspectShellProvision(
        "change",
        changeId,
      );
      if (!isolatedProvision.attempt) {
        throw new Phase0VerificationError(
          "change_materialization_attempt_missing",
          "isolated Change materialization attempt was not durable",
        );
      }
      recordStartAttemptEvidence(
        report,
        isolatedProvision.attempt,
        "started",
      );
      isolatedChanges.push(isolated);
      report.shellIds.push(isolated.threadId);
    }
    if (
      isolatedChanges[0]?.threadId === isolatedChanges[1]?.threadId
      || isolatedChanges.some(
        (candidate, index) =>
          candidate.title
            !== `[phase0-${runId}-change-${index + 1}] Isolated`,
      )
    ) {
      throw new Phase0VerificationError(
        "change_shell_isolation_failed",
        "two Change shell bindings were not distinctly named and isolated",
      );
    }
    const isolatedTurns: Array<{
      shellId: string;
      turnId: string;
      marker: string;
    }> = [];
    for (const [index, isolated] of isolatedChanges.entries()) {
      const ordinal = index + 1;
      const changeId = `phase0-${runId}-change-${ordinal}`;
      const isolatedSeed = await journal.seedManagedRun({
        ownerKind: "pipeline_job",
        ownerId: `phase0-change-owner-${ordinal}-${runId}`,
        projectId: `phase0-${runId}`,
        scopeKind: "change",
        scopeId: changeId,
        changeId,
        phase: "Isolation",
        role: "stage",
        round: 0,
        ordinal: 0,
        purpose: "stage_run",
        binding: {
          threadId: isolated.threadId,
          cwd: root,
          title: isolated.title,
        },
        request: {
          cwd: root,
          prompt: `Reply exactly PHASE0_CHANGE_ISOLATION_${ordinal}`,
          approvalPolicy: "never",
          sandboxMode: "read-only",
        },
        deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
      const started = await bridge.startTurn({
        logicalTurnId: isolatedSeed.logicalTurnId,
      });
      report.followerTurnIds.push(started.turnId);
      await readTerminalTurn({
        bridge,
        threadId: isolated.threadId,
        turnId: started.turnId,
        deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        report,
        expectedOutput: `PHASE0_CHANGE_ISOLATION_${ordinal}`,
      });
      const attempt = await inspectAndRecordStartAttempt({
        journal,
        report,
        attemptId: started.attemptId,
        recoveryOutcome: "started",
      });
      isolatedTurns.push({
        shellId: isolated.threadId,
        turnId: started.turnId,
        marker: attempt.correlationMarker,
      });
    }
    for (const own of isolatedTurns) {
      const ownSnapshot = await shellControl.readThreadWithTurns({
        threadId: own.shellId,
        includeTurns: true,
      });
      const other = isolatedTurns.find(
        ({ shellId }) => shellId !== own.shellId,
      )!;
      if (
        !ownSnapshot.turns.some(({ turnId }) => turnId === own.turnId)
        || ownSnapshot.turns.some(({ turnId }) => turnId === other.turnId)
        || !JSON.stringify(ownSnapshot.turns).includes(own.marker)
        || JSON.stringify(ownSnapshot.turns).includes(other.marker)
      ) {
        throw new Phase0VerificationError(
          "change_turn_cross_thread_leak",
          "Change turn id or correlation marker crossed canonical shell bindings",
        );
      }
    }
    markPassed(report, "two_changes_named_and_isolated");

    const provisionDatabasePath = path.join(
      verificationDirectory,
      `codex-desktop-bridge-phase0-provision-${runId}.sqlite`,
    );
    let provisionJournal = createCodexPhase0SqliteJournal({
      databasePath: provisionDatabasePath,
    });
    const provisionFence = {
      ownerId: `phase0-provision-worker-${runId}`,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    const provisionRequest = {
      projectPath: root,
      scope: {
        kind: "project_prd" as const,
        scopeId: `phase0-provision-${runId}`,
        projectId: `phase0-provision-${runId}`,
      },
      title: `[PHASE0 PROVISION ${runId}]`,
      provisionFence,
    };
    const threadStartsBeforeFault =
      report.appServerMethodCounts["thread/start"] ?? 0;
    try {
      const crashingProvisionBridge = createCodexDesktopBridge({
        shellControl,
        follower,
        logicalTurnPort: provisionJournal.logicalTurnPort,
        startAttemptPort: provisionJournal.startAttemptPort,
        shellProvisionPort: provisionJournal.shellProvisionPort,
        shellProvisionFailpoint(point) {
          if (point === "after_thread_start") {
            throw new Error("phase0 controlled crash after thread/start");
          }
        },
      });
      await crashingProvisionBridge.ensurePersistentShell(provisionRequest);
      throw new Phase0VerificationError(
        "provision_failpoint_not_reached",
        "controlled shell provision crash did not occur",
      );
    } catch (error) {
      if (
        error instanceof Phase0VerificationError
        || !String(error).includes("phase0 controlled crash")
      ) {
        throw error;
      }
    } finally {
      provisionJournal.close();
    }
    provisionJournal = createCodexPhase0SqliteJournal({
      databasePath: provisionDatabasePath,
    });
    try {
      const recoveredProvisionBridge = createCodexDesktopBridge({
        shellControl,
        follower,
        logicalTurnPort: provisionJournal.logicalTurnPort,
        startAttemptPort: provisionJournal.startAttemptPort,
        shellProvisionPort: provisionJournal.shellProvisionPort,
      });
      await expectBridgeErrorCode(
        () => recoveredProvisionBridge.ensurePersistentShell(provisionRequest),
        "shell_provision_ambiguous",
      );
      const failedClosed = provisionJournal.inspectShellProvision(
        provisionRequest.scope.kind,
        provisionRequest.scope.scopeId,
      );
      if (
        (report.appServerMethodCounts["thread/start"] ?? 0)
          !== threadStartsBeforeFault + 1
        || failedClosed.state !== "ambiguous"
        || !failedClosed.candidateThreadId
        || failedClosed.materializationLogicalTurnId !== null
        || failedClosed.attemptCount !== 0
        || failedClosed.executionCount !== 0
      ) {
        throw new Phase0VerificationError(
          "provision_crash_not_failed_closed",
          "after-thread-start recovery did not preserve one candidate and block materialization",
        );
      }
      markPassed(
        report,
        "ambiguous_provision_reconciled_or_failed_closed",
      );
      report.evidenceNotes.push(
        "Controlled fault evidence: verifier threw after a real app-server thread/start, preserved its exact journal candidate, then reopened fail-closed with one start and zero materialization attempts.",
      );
    } finally {
      provisionJournal.close();
    }

    const timeoutSeed = await journal.seedManagedRun({
      ownerKind: "project_ai_run",
      ownerId: `phase0-timeout-${runId}`,
      projectId: `phase0-${runId}`,
      scopeKind: "project_context",
      scopeId: `phase0-${runId}`,
      phase: "Timeout",
      role: "build",
      round: 0,
      ordinal: 0,
      purpose: "stage_run",
      binding: {
        threadId: shell.threadId,
        cwd: root,
        title: shell.title,
      },
      request: {
        cwd: root,
        prompt: "This request must be stopped by the injected follower timeout.",
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      deadlineAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
    });
    const timeoutFollower: CodexDesktopFollowerTransport = {
      probe: () => follower.probe(),
      openThreadDeepLink: (input) => follower.openThreadDeepLink(input),
      async startFollowerTurn() {
        throw new Error("phase0 injected follower timeout");
      },
      interruptTurn: (input) => follower.interruptTurn(input),
    };
    const timeoutBridge = createCodexDesktopBridge({
      shellControl,
      follower: timeoutFollower,
      logicalTurnPort: journal.logicalTurnPort,
      startAttemptPort: journal.startAttemptPort,
      shellProvisionPort: journal.shellProvisionPort,
      readinessDeadlineMs: 1_000,
    });
    try {
      await timeoutBridge.startTurn({
        logicalTurnId: timeoutSeed.logicalTurnId,
      });
      throw new Phase0VerificationError(
        "follower_timeout_not_enforced",
        "controlled follower timeout unexpectedly returned a turn",
      );
    } catch (error) {
      if (
        error instanceof Phase0VerificationError
        || !(error instanceof CodexDesktopBridgeError)
        || error.code !== "desktop_follower_start_ambiguous"
      ) {
        throw error;
      }
    }
    const timeoutAttempt = await journal.inspectAttemptByLogicalTurn(
      timeoutSeed.logicalTurnId,
    );
    if (!timeoutAttempt) {
      throw new Phase0VerificationError(
        "timeout_attempt_missing",
        "the injected timeout attempt was not durable",
      );
    }
    recordStartAttemptEvidence(
      report,
      timeoutAttempt,
      "quarantined",
      "ambiguous",
    );
    const reusedAfterTimeout = await bridge.ensurePersistentShell({
      projectPath: root,
      scope: {
        kind: "project_context",
        scopeId: `phase0-${runId}`,
        projectId: `phase0-${runId}`,
      },
      title: shell.title,
      provisionFence: {
        ownerId: `phase0-shell-worker-${runId}`,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    });
    if (reusedAfterTimeout.threadId !== shell.threadId) {
      throw new Phase0VerificationError(
        "shell_changed_after_follower_timeout",
        "follower timeout detached the canonical persistent shell",
      );
    }
    markPassed(report, "shell_reused_after_follower_timeout");
    report.evidenceNotes.push(
      "Controlled fault evidence: verifier injected a follower timeout before IPC dispatch, observed durable quarantine, then reused the same real persistent shell.",
    );

    const alternateWorktreePath = path.join(
      verificationDirectory,
      `alternate-worktree-${runId}`,
    );
    await fs.mkdir(alternateWorktreePath, {
      recursive: true,
      mode: 0o700,
    });
    const forwardingSeed = await journal.seedManagedRun({
      ownerKind: "project_ai_run",
      ownerId: `phase0-forwarding-${runId}`,
      projectId: `phase0-${runId}`,
      scopeKind: "project_context",
      scopeId: `phase0-${runId}`,
      phase: "Forwarding",
      role: "fix",
      round: 0,
      ordinal: 0,
      purpose: "stage_run",
      binding: {
        threadId: shell.threadId,
        cwd: root,
        title: shell.title,
      },
      request: {
        cwd: alternateWorktreePath,
        prompt: "Run `pwd`, then report the exact directory.",
        model: selectedModel.model,
        ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    const forwardingTurn = await bridge.startTurn({
      logicalTurnId: forwardingSeed.logicalTurnId,
    });
    report.followerTurnIds.push(forwardingTurn.turnId);
    const forwardingTerminal = await readTerminalTurn({
      bridge,
      threadId: shell.threadId,
      turnId: forwardingTurn.turnId,
      deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      report,
    });
    const forwardingOutput = JSON.stringify(forwardingTerminal.terminal);
    if (!forwardingOutput.includes(alternateWorktreePath)) {
      throw new Phase0VerificationError(
        "alternate_worktree_runtime_unproven",
        "Desktop-started turn did not report the alternate working directory",
      );
    }
    await inspectAndRecordStartAttempt({
      journal,
      report,
      attemptId: forwardingTurn.attemptId,
      recoveryOutcome: "started",
    });

    await installTemporaryRegistration({
      codexBin: endpoint.appServerBinary.path,
      name: report.registrationName,
      supervisorPath,
      onAdded() {
        registrationAdded = true;
      },
    });

    const clickInteractionId = randomUUID();
    const clickWakeSeed = await journal.seedManagedRun({
      ownerKind: "project_ai_run",
      ownerId: `phase0-click-wakeup-${runId}`,
      projectId: `phase0-${runId}`,
      scopeKind: "project_context",
      scopeId: `phase0-${runId}`,
      phase: "InteractionWakeup",
      role: "interaction_wakeup",
      round: 0,
      ordinal: 0,
      purpose: "interaction_wakeup",
      binding: {
        threadId: shell.threadId,
        cwd: root,
        title: shell.title,
      },
      request: {
        cwd: root,
        prompt: "Phase 0 Host ui/message wakeup",
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    await journal.createInteractionWakeup({
      interactionId: clickInteractionId,
      logicalTurnId: clickWakeSeed.logicalTurnId,
      cardVersion: 1,
    });

    const firstSeed = await journal.seedManagedRun({
      ownerKind: "project_ai_run",
      ownerId: `phase0-owner-${runId}`,
      projectId: `phase0-${runId}`,
      scopeKind: "project_context",
      scopeId: `phase0-${runId}`,
      phase: "Interaction",
      role: "interaction_present",
      round: 0,
      ordinal: 0,
      purpose: "interaction_present",
      binding: {
        threadId: shell.threadId,
        cwd: root,
        title: shell.title,
      },
      request: {
        cwd: root,
        prompt: [
          `Call the MCP tool ${report.registrationName}/present_phase0_card exactly once.`,
          `Pass ${JSON.stringify({
            threadId: shell.threadId,
            verificationJournalPath: verificationDatabasePath,
            verificationRunId: runId,
            interactionId: clickInteractionId,
            cardVersion: 1,
          })}.`,
          "Do not call submit_phase0_card and do not simulate a click.",
          "After the tool result, briefly tell the user the card is ready.",
        ].join(" "),
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    const first = await bridge.startTurn({
      logicalTurnId: firstSeed.logicalTurnId,
    });
    report.followerTurnIds.push(first.turnId);
    const persistedShell = await shellControl.readPersistentShell(
      shell.threadId,
    );
    if (
      !persistedShell
      || persistedShell.ephemeral !== false
      || !report.provisioningActivationUrls.includes(
        `codex://threads/${shell.threadId}`,
      )
    ) {
      throw new Phase0VerificationError(
        "deep_link_persistence_not_observed",
        "successful deep-link open and persistent shell read were not both observed",
      );
    }
    markPassed(report, "deep_link_visible_and_persistent");
    const forwarded = report.followerDispatchEvidence.find(
      (entry) =>
        entry.threadId === shell.threadId
        && entry.cwd === alternateWorktreePath
        && entry.model === selectedModel.model
        && (
          selectedEffort === undefined
          || entry.reasoningEffort === selectedEffort
        )
        && entry.approvalPolicy === "never"
        && entry.sandboxPolicyType === "readOnly",
    );
    if (forwarded) {
      markPassed(report, "model_effort_sandbox_and_worktree_forwarded");
    } else {
      markBlocked(
        report,
        "model_effort_sandbox_and_worktree_forwarded",
        selectedEffort
          ? "follower_forwarding_not_observed"
          : "model_reasoning_effort_unavailable",
      );
    }
    await inspectAndRecordStartAttempt({
      journal,
      report,
      attemptId: first.attemptId,
      recoveryOutcome: "started",
    });
    await proveRealVisibilityLag({
      shellControl,
      follower,
      journal,
      threadId: shell.threadId,
      turnId: first.turnId,
      report,
    });
    const firstTerminal = await readTerminalTurn({
      bridge,
      threadId: shell.threadId,
      turnId: first.turnId,
      deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      report,
    });
    const replayMatrix = evaluateCodexSnapshotReplayMatrix(
      firstTerminal.terminal,
    );
    if (!Object.values(replayMatrix).every((value) => value === true)) {
      throw new Phase0VerificationError(
        "real_snapshot_replay_invalid",
        "real normalized snapshot did not satisfy the complete replay matrix",
      );
    }
    satisfyStrictEvidence(report, "real_snapshot_replay", [
      `captured_real_turn=${first.turnId}`,
      ...Object.keys(replayMatrix).map((name) => `${name}=passed`),
      `forced_read_reconnects=${report.turnReadEvidence.reconnects}`,
    ]);
    markPassed(report, "read_reconnect_and_semantic_snapshot_rules");
    markPassed(report, "turn_visibility_lag_and_terminal_read_observed");
    if (!hasPresentedCard(firstTerminal.terminal, report.registrationName)) {
      const actualError = toolResultText(firstTerminal.terminal)
        || firstTerminal.terminal.terminal?.errorMessage
        || firstTerminal.terminal.terminal?.errorCode
        || "present_phase0_card was not completed";
      const actualCode = actualError.match(
        /source_thread_attestation_missing|caller_attestation_missing|[a-z][a-z0-9_]{3,}/,
      )?.[0] ?? "mcp_present_failed";
      throw new Phase0VerificationError(
        actualCode,
        actualError,
      );
    }
    markPassed(report, "mcp_app_presented_without_host_tool_dependency");
    if (
      !/"modelSubmitRejected":true/.test(toolResultText(firstTerminal.terminal))
      || !/"presentMissing":true/.test(
        toolResultText(firstTerminal.terminal),
      )
      || !/"statusCrossThread":true/.test(
        toolResultText(firstTerminal.terminal),
      )
      || !/"submitMissing":true/.test(
        toolResultText(firstTerminal.terminal),
      )
      || !/"submitCrossThread":true/.test(
        toolResultText(firstTerminal.terminal),
      )
    ) {
      throw new Phase0VerificationError(
        "managed_submit_auth_rejection_unproven",
        "real Host-attested present call did not prove the source/auth negative matrix",
      );
    }
    markPassed(report, "managed_turn_cannot_mint_submit_auth");
    await assertOrdinaryProcessRejected(supervisorPath);
    markPassed(report, "ordinary_process_cannot_authorize_submit");
    const crossThreadId = isolatedChanges[0]!.threadId;
    const crossBindingChangeId = `phase0-${runId}-change-1`;
    const crossBindingInteractionId = randomUUID();
    const crossBindingWakeSeed = await journal.seedManagedRun({
      ownerKind: "pipeline_job",
      ownerId: `phase0-cross-binding-${runId}`,
      projectId: `phase0-${runId}`,
      scopeKind: "change",
      scopeId: crossBindingChangeId,
      changeId: crossBindingChangeId,
      phase: "InteractionWakeupCrossBinding",
      role: "interaction_wakeup",
      round: 0,
      ordinal: 0,
      purpose: "interaction_wakeup",
      binding: {
        threadId: crossThreadId,
        cwd: root,
        title: isolatedChanges[0]!.title,
      },
      request: {
        cwd: root,
        prompt: "Phase 0 cross-binding rejection target",
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    await journal.createInteractionWakeup({
      interactionId: crossBindingInteractionId,
      logicalTurnId: crossBindingWakeSeed.logicalTurnId,
      cardVersion: 1,
    });
    const authNegativeSeed = await journal.seedManagedRun({
      ownerKind: "project_ai_run",
      ownerId: `phase0-auth-negative-${runId}`,
      projectId: `phase0-${runId}`,
      scopeKind: "project_context",
      scopeId: `phase0-${runId}`,
      phase: "InteractionAuthNegative",
      role: "interaction_present",
      round: 0,
      ordinal: 0,
      purpose: "interaction_present",
      binding: {
        threadId: shell.threadId,
        cwd: root,
        title: shell.title,
      },
      request: {
        cwd: root,
        prompt: [
          `Call ${report.registrationName}/present_phase0_card with`,
          `${JSON.stringify({
            action: "present",
            verificationCaseId: "cross_source_present",
            threadId: crossThreadId,
          })}, then call it with`,
          `${JSON.stringify({
            action: "status",
            verificationCaseId: "cross_source_status",
            threadId: crossThreadId,
          })}.`,
          "Then call it once with the exact arguments",
          `${JSON.stringify({
            action: "present",
            verificationCaseId: "cross_binding_present",
            threadId: shell.threadId,
            verificationJournalPath: verificationDatabasePath,
            verificationRunId: runId,
            interactionId: crossBindingInteractionId,
            cardVersion: 1,
          })}.`,
          "Report all three exact tool error codes. Do not retry or call any other tool.",
        ].join(" "),
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    const authNegativeTurn = await bridge.startTurn({
      logicalTurnId: authNegativeSeed.logicalTurnId,
    });
    report.followerTurnIds.push(authNegativeTurn.turnId);
    await readTerminalTurn({
      bridge,
      threadId: shell.threadId,
      turnId: authNegativeTurn.turnId,
      deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      report,
    });
    if (!shellControl.readPhase0VerificationToolEvidence) {
      throw new Phase0VerificationError(
        "real_auth_negative_evidence_unavailable",
        "app-server shell control lacks verifier-only MCP evidence extraction",
      );
    }
    const authNegativeEvidence =
      await shellControl.readPhase0VerificationToolEvidence({
        threadId: shell.threadId,
        turnId: authNegativeTurn.turnId,
        registrationName: report.registrationName,
      });
    await inspectAndRecordStartAttempt({
      journal,
      report,
      attemptId: authNegativeTurn.attemptId,
      recoveryOutcome: "started",
    });
    const authNegativeToolFacts = strictAuthNegativeToolFacts({
      registrationName: report.registrationName,
      evidence: authNegativeEvidence,
      cases: [{
        caseId: "cross_source_present",
        arguments: {
          action: "present",
          threadId: crossThreadId,
        },
      }, {
        caseId: "cross_source_status",
        arguments: {
          action: "status",
          threadId: crossThreadId,
        },
      }, {
        caseId: "cross_binding_present",
        arguments: {
          action: "present",
          threadId: shell.threadId,
          verificationJournalPath: verificationDatabasePath,
          verificationRunId: runId,
          interactionId: crossBindingInteractionId,
          cardVersion: 1,
        },
      }],
    });
    const crossBindingEvidence = journal.inspectInteractionWakeup(
      crossBindingInteractionId,
    );
    if (
      crossBindingEvidence.decisionCount !== 0
      || crossBindingEvidence.jobCount !== 0
      || crossBindingEvidence.attemptCount !== 0
      || crossBindingEvidence.outboxCount !== 0
      || crossBindingEvidence.dispatchCount !== 0
    ) {
      throw new Phase0VerificationError(
        "real_cross_binding_mutated",
        "cross-binding verification call mutated its target interaction journal",
      );
    }
    process.stdout.write(
      `Click “MCP ui/message” in the Phase 0 card for task ${shell.threadId}.\n`,
    );
    const sentinel = await waitForUiSentinel({
      shellControl,
      threadId: shell.threadId,
      deadlineAt: Date.now() + 2 * 60_000,
    });
    const sentinelParts = sentinel.split(/\s+/);
    const nonceId = sentinelParts[2] ?? "";
    const wakeupJobId = sentinelParts[3] ?? "";
    const wakeupAttemptId = sentinelParts[4] ?? "";
    if (
      !/^[0-9a-f-]{36}$/i.test(nonceId)
      || !/^[0-9a-f-]{36}$/i.test(wakeupJobId)
      || !/^[0-9a-f-]{36}$/i.test(wakeupAttemptId)
      || sentinelParts.length !== 5
    ) {
      throw new Phase0VerificationError(
        "mcp_ui_message_invalid",
        "same-thread MCP ui/message marker lacked its durable job or attempt identity",
      );
    }
    const sentinelSnapshot = await shellControl.readThreadWithTurns({
      threadId: shell.threadId,
      includeTurns: true,
    });
    const sentinelCount = sentinelSnapshot.turns.flatMap(({ items }) => items)
      .filter(
        (item) =>
          item.kind === "user_message"
          && item.semantic.text === sentinel,
      ).length;
    if (
      sentinelCount !== 1
      || /nonce/i.test(toolResultText(firstTerminal.terminal))
      || toolResultText(firstTerminal.terminal).includes(nonceId)
    ) {
      throw new Phase0VerificationError(
        "mcp_private_or_exactly_once_evidence_invalid",
        "private nonce metadata leaked or ui/message sentinel was not exactly once",
      );
    }
    let durableClick = journal.inspectInteractionWakeup(clickInteractionId);
    const durableClickDeadline = Date.now() + 30_000;
    while (
      Date.now() < durableClickDeadline
      && (
        durableClick.executionCount !== 1
        || durableClick.effectCount !== 1
        || durableClick.receiptCount !== 1
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      durableClick = journal.inspectInteractionWakeup(clickInteractionId);
    }
    if (
      durableClick.decisionCount !== 1
      || durableClick.jobCount !== 1
      || durableClick.attemptCount !== 1
      || durableClick.executionCount !== 1
      || durableClick.effectCount !== 1
      || durableClick.outboxCount !== 1
      || durableClick.receiptCount !== 1
      || durableClick.dispatchCount !== 1
      || durableClick.jobId !== wakeupJobId
      || durableClick.attemptId !== wakeupAttemptId
      || durableClick.dispatchSurfaces.some(
        (surface) => surface !== "host_ui_message",
      )
    ) {
      throw new Phase0VerificationError(
        "real_durable_click_invalid",
        "real App click did not settle exactly one durable Host wakeup chain",
      );
    }
    await inspectAndRecordStartAttempt({
      journal,
      report,
      attemptId: wakeupAttemptId,
      recoveryOutcome: "started",
    });
    satisfyStrictEvidence(report, "real_durable_click", [
      `interaction_id=${clickInteractionId}`,
      `job_id=${wakeupJobId}`,
      `attempt_id=${wakeupAttemptId}`,
      "decision_count=1",
      "job_count=1",
      "attempt_count=1",
      "outbox_count=1",
      "receipt_count=1",
      "execution_count=1",
      "effect_count=1",
      "dispatch_count=1",
      `real_same_thread_marker_count=${sentinelCount}`,
    ]);
    satisfyStrictEvidence(report, "real_auth_negative_matrix", [
      `same_source_present_turn=${first.turnId}`,
      `cross_source_present_status_turn=${authNegativeTurn.turnId}`,
      ...authNegativeToolFacts,
      `cross_binding_interaction=${crossBindingInteractionId}`,
      "cross_binding_decision_count=0",
      "cross_binding_job_count=0",
      "cross_binding_attempt_count=0",
      "cross_binding_outbox_count=0",
      "cross_binding_dispatch_count=0",
      "missing_source_present=source_thread_mismatch",
      "missing_source_submit=source_thread_mismatch",
      "cross_source_submit=source_thread_mismatch",
      "managed_submit=model_invocation_forbidden",
      "ordinary_process=submit_auth_channel_unavailable",
      `same_thread_host_marker=${sentinel}`,
    ]);
    markPassed(
      report,
      "present_status_submit_source_attested_and_cross_task_isolated",
    );
    markBlocked(
      report,
      "user_click_saved_once_and_woke_same_shell",
      "real_view_marker_crash_windows_unobserved",
    );
    markBlocked(
      report,
      "host_mcp_channel_can_submit",
      "real_view_marker_crash_windows_unobserved",
    );
    report.evidenceNotes.push(
      "ack-before-receipt and receipt-before-settlement remain BLOCKED until "
      + "both are observed through the real view App.sendMessage transport "
      + "and app-server marker/receipt reads; SQLite transport simulation is "
      + "unit coverage only and is not real-client strict evidence.",
    );
    report.mcpHostEvidence = {
      verifiedBy: "real-mcp-fixture",
      checks: {
        "app/source-thread-attestation": "passed",
        "app/protected-submit-channel": "passed",
        "ui-message/same-thread": "passed",
      },
      hostFingerprint: [
        report.protocol.desktopFollowerFingerprint,
        report.registrationName,
      ].join(":"),
      verifiedAt: new Date().toISOString(),
    };

    const secondSeed = await journal.seedManagedRun({
      ownerKind: "project_ai_run",
      ownerId: `phase0-followup-${runId}`,
      projectId: `phase0-${runId}`,
      scopeKind: "project_context",
      scopeId: `phase0-${runId}`,
      phase: "Phase0",
      role: "context_generate",
      round: 0,
      ordinal: 0,
      purpose: "stage_run",
      binding: {
        threadId: shell.threadId,
        cwd: root,
        title: shell.title,
      },
      request: {
        cwd: root,
        prompt: `Acknowledge the verified UI sentinel nonce ${nonceId}.`,
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    const second = await bridge.startTurn({
      logicalTurnId: secondSeed.logicalTurnId,
    });
    report.followerTurnIds.push(second.turnId);
    await readTerminalTurn({
      bridge,
      threadId: shell.threadId,
      turnId: second.turnId,
      deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      report,
    });
    await inspectAndRecordStartAttempt({
      journal,
      report,
      attemptId: second.attemptId,
      recoveryOutcome: "started",
    });
    markPassed(report, "same_shell_second_follower_turn_completed");

    const interruptSeed = await journal.seedManagedRun({
      ownerKind: "project_ai_run",
      ownerId: `phase0-interrupt-${runId}`,
      projectId: `phase0-${runId}`,
      scopeKind: "project_context",
      scopeId: `phase0-${runId}`,
      phase: "Interrupt",
      role: "stage",
      round: 0,
      ordinal: 0,
      purpose: "stage_run",
      binding: {
        threadId: shell.threadId,
        cwd: root,
        title: shell.title,
      },
      request: {
        cwd: root,
        prompt: "Run `/bin/sleep 30`, then reply PHASE0_INTERRUPT_MISSED.",
        approvalPolicy: "never",
        sandboxMode: "read-only",
      },
      deadlineAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
    });
    const interruptTarget = await bridge.startTurn({
      logicalTurnId: interruptSeed.logicalTurnId,
    });
    report.followerTurnIds.push(interruptTarget.turnId);
    await bridge.interruptTurn({
      threadId: shell.threadId,
      turnId: interruptTarget.turnId,
    });
    const interrupted = await readTerminalTurn({
      bridge,
      threadId: shell.threadId,
      turnId: interruptTarget.turnId,
      deadlineAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      report,
    });
    await inspectAndRecordStartAttempt({
      journal,
      report,
      attemptId: interruptTarget.attemptId,
      recoveryOutcome: "started",
    });
    let detachedObserved = false;
    try {
      await bridge.interruptTurn({
        threadId: "00000000-0000-4000-8000-000000000000",
        turnId: "00000000-0000-4000-8000-000000000000",
      });
    } catch (error) {
      detachedObserved = error instanceof CodexDesktopBridgeError
        && error.code === "desktop_thread_detached";
    }
    if (interrupted.terminal.status === "interrupted" && detachedObserved) {
      markPassed(report, "target_interrupt_and_detach_handled");
    } else {
      markBlocked(
        report,
        "target_interrupt_and_detach_handled",
        interrupted.terminal.status !== "interrupted"
          ? "target_interrupt_terminal_not_observed"
          : "detached_interrupt_mapping_not_observed",
      );
    }

    const journalAttempts = await journal.listAttempts();
    try {
      assertStartAttemptEvidenceMatchesJournal(
        journalAttempts,
        report.startAttemptEvidence,
      );
    } catch {
      throw new Phase0VerificationError(
        "start_attempt_evidence_incomplete",
        "report attempt evidence does not exactly cover the SQLite journal",
      );
    }
    report.evidenceNotes.push(
      `SQLite/report attempt evidence matched for ${journalAttempts.length} unique attempts.`,
    );

    if (report.strictEvidence.real_cross_process_failpoints?.satisfied) {
      markPassed(
        report,
        "durable_follower_start_exactly_once_all_crash_windows",
      );
    } else {
      markBlocked(
        report,
        "durable_follower_start_exactly_once_all_crash_windows",
        "real_cross_process_failpoints_missing",
      );
    }
    if (
      (report.appServerMethodCounts["turn/start"] ?? 0) === 0
      && (report.desktopMethodCounts["thread-follower-start-turn"] ?? 0) > 0
    ) {
      markPassed(report, "managed_turn_started_only_by_follower");
      markPassed(report, "app_server_managed_turn_start_count_zero");
    } else {
      markBlocked(
        report,
        "managed_turn_started_only_by_follower",
        "turn_start_surface_count_invalid",
      );
      markBlocked(
        report,
        "app_server_managed_turn_start_count_zero",
        "app_server_turn_start_nonzero",
      );
    }
    for (const check of report.checks) {
      if (check.status === "pending") {
        markBlocked(report, check.name, "phase0_check_not_executed");
      }
    }
    if (passedCount(report) !== CHECK_NAMES.length) {
      const code = report.failureCodes[0] ?? "phase0_check_not_executed";
      printBlocked(report, code, "one or more Phase 0 checks did not pass");
    } else if (
      report.securityBoundary.serverLaunchAttestation === "unsupported"
    ) {
      printBlocked(
        report,
        report.securityBoundary.failureCode,
        "Node/macOS exposes no peer PID or audit token for the Server inherited channel; Server-side launch identity cannot be attested",
      );
    } else {
      report.status = "PASS";
      process.stdout.write(
        `PHASE0 PASS: ${CHECK_NAMES.length}/${CHECK_NAMES.length}\n`,
      );
      process.exitCode = 0;
    }
  } catch (error) {
    const code = error instanceof CodexDesktopBridgeError
      ? error.code
      : error instanceof Phase0VerificationError
        ? error.code
      : "desktop_bridge_unavailable";
    blockPending(report, code);
    printBlocked(
      report,
      code,
      sanitizedToken(
        error instanceof Error ? error.message : error,
        "verification failed closed",
      ),
    );
  } finally {
    if (registrationAdded) {
      try {
        if (!attestedCodexBin) {
          throw new Error("attested Codex binary path is unavailable");
        }
        await removeTemporaryRegistration({
          codexBin: attestedCodexBin,
          name: report.registrationName,
          supervisorPath,
        });
      } catch (error) {
        blockPending(report, "mcp_registration_restore_failed");
        report.evidenceNotes.push(
          sanitizedToken(
            error instanceof Error ? error.message : error,
            "temporary MCP registration cleanup failed",
          ),
        );
        report.status = "FAILED";
        process.stderr.write(
          "PHASE0 FAILED: temporary MCP registration cleanup could not be proven\n",
        );
        process.exitCode = 1;
      }
    }
    journal?.close();
    await writeReport(root, report);
  }
}

async function entrypoint(): Promise<void> {
  const bootstrapCrashIndex = process.argv.indexOf(
    "--phase0-bootstrap-ready-crash-child",
  );
  if (bootstrapCrashIndex >= 0) {
    const databasePath = process.argv[bootstrapCrashIndex + 1];
    const runId = process.argv[bootstrapCrashIndex + 2];
    if (
      !databasePath
      || !path.isAbsolute(databasePath)
      || !/^[0-9a-f-]{36}$/i.test(runId ?? "")
    ) {
      throw new Error("invalid Phase 0 bootstrap-ready crash-child arguments");
    }
    await runBootstrapReadyCrashChild({
      databasePath,
      runId: runId!,
    });
    return;
  }
  const childIndex = process.argv.indexOf("--phase0-crash-child");
  if (childIndex >= 0) {
    const databasePath = process.argv[childIndex + 1];
    const logicalTurnId = process.argv[childIndex + 2];
    const window = process.argv[childIndex + 3] as RealCrashWindow | undefined;
    if (
      !databasePath
      || !logicalTurnId
      || !window
      || ![
        "before_dispatch_cas",
        "after_ipc_write_before_response",
        "success_before_cas",
        "unknown_response",
      ].includes(window)
    ) {
      throw new Error("invalid Phase 0 crash-child arguments");
    }
    await runRealCrashWindowChild({
      databasePath,
      logicalTurnId,
      window,
    });
    return;
  }
  await main();
}

void entrypoint().catch((error) => {
  if (process.exitCode === 1) {
    process.stderr.write(
      `PHASE0 FAILED: ${
        sanitizedToken(
          error instanceof Error ? error.message : error,
          "verification report could not be finalized",
        )
      }\n`,
    );
    return;
  }
  process.stderr.write(
    `PHASE0 BLOCKED: 0/${CHECK_NAMES.length} (phase0_verifier_bootstrap_blocked: ${
      sanitizedToken(
        error instanceof Error ? error.message : error,
        "verifier could not initialize",
      )
    })\n`,
  );
  process.exitCode = 2;
});
