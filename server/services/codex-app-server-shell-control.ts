import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  CodexAppServerClient,
} from "./codex-app-server-client";
import { CodexDesktopBridgeError } from "./codex-desktop-bridge";
import type {
  CodexDesktopAttestedAppServerBinary,
  CodexDesktopSocketStat,
} from "./codex-desktop-ipc-discovery";
import {
  type CodexModel,
  type CodexPersistentShell,
  type NormalizedCodexTurnItem,
  type CodexTurnSnapshot,
} from "./codex-desktop-bridge-types";

/**
 * Installed-schema evidence captured and regenerated on 2026-07-23 with:
 *   /Applications/ChatGPT.app/Contents/Resources/codex app-server
 *     generate-ts --experimental --out <disposable-directory>
 * Installed CLI: codex-cli 0.146.0-alpha.3.
 * Sorted relative paths without a leading "./", then per-file SHA-256:
 * fd6f8bb9872165ce1e991c7ec175aa370bf1b4bbf797b5574b53eafd194711a1.
 * v2/Turn.ts SHA-256: 5a0852e46a13446ccb3aa3f493c06a9151a43772d530521789ac741ed115da5f.
 * The generated Turn fields are exactly id, items, itemsView, status, error,
 * startedAt, completedAt, durationMs; itemsView is
 * notLoaded | summary | full. FileUpdateChange is path/kind/diff and
 * TurnError is message/codexErrorInfo/additionalDetails.
 * Initialize, thread start/name/list/read, model list, Turn, ThreadItem, and
 * Model request/response shapes are byte-identical to 0.145.0-alpha.18.
 * Thread adds canAcceptDirectInput, which this read-only shell adapter ignores.
 */
const APP_SERVER_PROTOCOL_SCHEMA_FINGERPRINT =
  "codex-cli-0.146.0-alpha.3-generate-ts:fd6f8bb9872165ce1e991c7ec175aa370bf1b4bbf797b5574b53eafd194711a1";
const PAGE_LIMIT = 100;
const SYSTEM_CODESIGN = "/usr/bin/codesign";
const EXPECTED_APP_SERVER_BINARY_VERSION =
  "codex-cli 0.146.0-alpha.3";
const TRUSTED_OPENAI_TEAM_IDENTIFIER = "2DC432GLL2";
const CANONICAL_DESKTOP_BUNDLES = new Set([
  "/Applications/ChatGPT.app",
  "/Applications/Codex.app",
]);
const ALLOWED_CODEX_PATH_ALIAS_WARNING =
  "WARNING: proceeding, even though we could not create PATH aliases: "
  + "Operation not permitted (os error 1)";
const execFileAsync = promisify(execFile);

const ALLOWED_SHELL_METHODS = new Set([
  "thread/start",
  "thread/name/set",
  "thread/list",
  "thread/read",
  "model/list",
]);
const SHELL_PROTOCOL_CAPABILITIES = [
  "thread/start:persistent",
  "thread/name/set",
  "thread/read:includeTurns",
  "thread/list",
  "model/list",
] as const;
const KNOWN_APP_SERVER_RUNTIMES = new Set([
  "Codex Desktop/0.146.0-alpha.3 (Mac OS 26.5.1; arm64) dumb (stagepass; 0.1.0)",
]);

export interface CodexProtocolBehaviorEvidence {
  protocolFingerprint: string;
  capabilities: string[];
}

const PHASE0_VERIFICATION_CASE_IDS = [
  "cross_source_present",
  "cross_source_status",
  "cross_binding_present",
] as const;

export type CodexPhase0VerificationCaseId =
  (typeof PHASE0_VERIFICATION_CASE_IDS)[number];

export interface CodexPhase0VerificationToolEvidence {
  itemId: string;
  toolName: string;
  caseId: CodexPhase0VerificationCaseId;
  canonicalArgumentsHash: string;
  status: "running" | "completed" | "failed";
  errorCode: "source_thread_mismatch" | null;
}

export interface AppServerShellClient {
  initialize(): Promise<Record<string, unknown>>;
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  close(graceMs?: number): Promise<unknown>;
}

export interface CodexAppServerShellControl {
  probe(): Promise<{
    version: string;
    protocolFingerprint: string;
    capabilities: string[];
    protocolCapabilities: string[];
  }>;
  startPersistentThread(input: {
    cwd: string;
    ephemeral: false;
  }): Promise<{ threadId: string }>;
  startPersistentThreadAndName(input: {
    cwd: string;
    ephemeral: false;
    name: string;
    deadlineAt: string;
    onStarted: (threadId: string) => Promise<void>;
    activate: (threadId: string) => Promise<void>;
    onCheckpoint?: (
      point:
        | "after_thread_start"
        | "after_thread_activation"
        | "after_thread_name",
    ) => void;
  }): Promise<CodexPersistentShell>;
  setThreadName(input: { threadId: string; name: string }): Promise<void>;
  findPersistentShell(input: {
    cwd: string;
    title: string;
  }): Promise<CodexPersistentShell[]>;
  listPersistentShells(input: {
    cwd: string;
  }): Promise<CodexPersistentShell[]>;
  readPersistentShell(threadId: string): Promise<CodexPersistentShell | null>;
  readThreadWithTurns(input: {
    threadId: string;
    includeTurns: true;
    deadlineAt?: string;
    signal?: AbortSignal;
  }): Promise<{
    shell: CodexPersistentShell;
    turns: CodexTurnSnapshot[];
  }>;
  readPhase0VerificationToolEvidence?(input: {
    threadId: string;
    turnId: string;
    registrationName: string;
  }): Promise<CodexPhase0VerificationToolEvidence[]>;
  listModels(): Promise<CodexModel[]>;
}

export interface ShellControlOptions {
  appServerBinary: CodexDesktopAttestedAppServerBinary;
  clientFactory?: (
    cwd: string | undefined,
    codexBin: string,
  ) => AppServerShellClient;
  verifyAppServerBinary?: (
    identity: CodexDesktopAttestedAppServerBinary,
    phase: "before_spawn" | "after_spawn",
  ) => Promise<void>;
  now?: () => number;
  onRequest?: (method: string, params: Record<string, unknown>) => void;
  behaviorEvidence?: CodexProtocolBehaviorEvidence;
  maxActiveClients?: number;
  sleep?: (ms: number) => Promise<void>;
}

function fileIdentity(stat: Stats): CodexDesktopSocketStat {
  return {
    isSocket: stat.isSocket(),
    isDirectory: stat.isDirectory(),
    isSymbolicLink: stat.isSymbolicLink(),
    uid: stat.uid,
    mode: stat.mode,
    device: stat.dev,
    inode: stat.ino,
  };
}

function sameFileIdentity(
  left: CodexDesktopSocketStat,
  right: CodexDesktopSocketStat,
): boolean {
  return left.isSocket === right.isSocket
    && left.isDirectory === right.isDirectory
    && left.isSymbolicLink === right.isSymbolicLink
    && left.uid === right.uid
    && left.mode === right.mode
    && left.device === right.device
    && left.inode === right.inode;
}

function exactVersionOutput(output: string): string | null {
  const value = output.endsWith("\n") ? output.slice(0, -1) : output;
  return value.length > 0
      && value.length <= 128
      && !value.includes("\0")
      && !value.includes("\r")
      && !value.includes("\n")
    ? value
    : null;
}

function isProvisionVisibilityLag(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.trim().toLowerCase();
  return message === "thread not loaded" || message === "thread not found";
}

function hasCanonicalAppServerIdentity(
  identity: CodexDesktopAttestedAppServerBinary,
): boolean {
  return CANONICAL_DESKTOP_BUNDLES.has(identity.bundlePath)
    && identity.bundleIdentifier === "com.openai.codex"
    && identity.teamIdentifier === TRUSTED_OPENAI_TEAM_IDENTIFIER
    && identity.version === EXPECTED_APP_SERVER_BINARY_VERSION
    && identity.path === path.join(
      identity.bundlePath,
      "Contents",
      "Resources",
      "codex",
    );
}

export async function verifyAttestedAppServerBinary(
  identity: CodexDesktopAttestedAppServerBinary,
): Promise<void> {
  const expectedPath = path.join(
    identity.bundlePath,
    "Contents",
    "Resources",
    "codex",
  );
  if (
    !path.isAbsolute(identity.path)
    || identity.path !== expectedPath
    || !path.isAbsolute(identity.bundlePath)
    || !hasCanonicalAppServerIdentity(identity)
  ) {
    throw new CodexDesktopBridgeError(
      "desktop_bridge_unavailable",
      "attested Codex app-server binary path is invalid",
    );
  }
  const [resolvedBefore, bundleResolvedBefore, fileBefore, bundleBefore] =
    await Promise.all([
      fs.realpath(identity.path),
      fs.realpath(identity.bundlePath),
      fs.lstat(identity.path).then(fileIdentity),
      fs.lstat(identity.bundlePath).then(fileIdentity),
    ]);
  if (
    resolvedBefore !== identity.path
    || bundleResolvedBefore !== identity.bundlePath
    || !sameFileIdentity(fileBefore, identity.file)
    || !sameFileIdentity(bundleBefore, identity.bundleFile)
  ) {
    throw new CodexDesktopBridgeError(
      "desktop_bridge_unavailable",
      "attested Codex app-server binary identity changed",
    );
  }
  await execFileAsync(
    SYSTEM_CODESIGN,
    ["--verify", "--deep", "--strict", identity.bundlePath],
    { encoding: "utf8", timeout: 5_000 },
  );
  const codesign = await execFileAsync(
    SYSTEM_CODESIGN,
    ["-dv", "--verbose=4", identity.bundlePath],
    { encoding: "utf8", timeout: 5_000 },
  );
  const fields = new Set(
    `${codesign.stdout}\n${codesign.stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim()),
  );
  if (
    !fields.has(`Identifier=${identity.bundleIdentifier}`)
    || !fields.has(`TeamIdentifier=${identity.teamIdentifier}`)
  ) {
    throw new CodexDesktopBridgeError(
      "desktop_bridge_unavailable",
      "attested Codex app-server bundle signature changed",
    );
  }
  const version = await execFileAsync(identity.path, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  const versionStderr = version.stderr.endsWith("\n")
    ? version.stderr.slice(0, -1)
    : version.stderr;
  if (
    exactVersionOutput(version.stdout) !== identity.version
    || (
      versionStderr !== ""
      && versionStderr !== ALLOWED_CODEX_PATH_ALIAS_WARNING
    )
  ) {
    throw new CodexDesktopBridgeError(
      "desktop_bridge_unavailable",
      "attested Codex app-server binary version changed",
    );
  }
  const [resolvedAfter, bundleResolvedAfter, fileAfter, bundleAfter] =
    await Promise.all([
      fs.realpath(identity.path),
      fs.realpath(identity.bundlePath),
      fs.lstat(identity.path).then(fileIdentity),
      fs.lstat(identity.bundlePath).then(fileIdentity),
    ]);
  if (
    resolvedAfter !== identity.path
    || bundleResolvedAfter !== identity.bundlePath
    || !sameFileIdentity(fileAfter, identity.file)
    || !sameFileIdentity(bundleAfter, identity.bundleFile)
    || !sameFileIdentity(fileBefore, fileAfter)
    || !sameFileIdentity(bundleBefore, bundleAfter)
  ) {
    throw new CodexDesktopBridgeError(
      "desktop_bridge_unavailable",
      "attested Codex app-server binary identity changed",
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Codex app-server response is missing ${key}`);
  }
  return field;
}

function parseShell(value: unknown): CodexPersistentShell | null {
  const thread = asRecord(value);
  if (thread.ephemeral !== false) return null;
  const id = thread.id;
  const cwd = thread.cwd;
  if (typeof id !== "string" || typeof cwd !== "string") return null;
  return {
    threadId: id,
    title: typeof thread.name === "string" ? thread.name : "",
    cwd,
    ephemeral: false,
  };
}

function parseModel(value: unknown): CodexModel {
  const model = asRecord(value);
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map((value) => {
      const option = asRecord(value);
      return requiredString(option, "reasoningEffort");
    })
    : undefined;
  return {
    id: requiredString(model, "id"),
    model: requiredString(model, "model"),
    displayName: requiredString(model, "displayName"),
    ...(efforts ? { supportedReasoningEfforts: efforts } : {}),
    ...(typeof model.defaultReasoningEffort === "string"
      ? { defaultReasoningEffort: model.defaultReasoningEffort }
      : {}),
  };
}

function timestamp(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
    return new Date(milliseconds).toISOString();
  }
  throw snapshotInvalid(`Codex app-server turn has invalid ${field}`);
}

function optionalTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return timestamp(value, "completedAt");
}

function snapshotInvalid(message: string): CodexDesktopBridgeError {
  return new CodexDesktopBridgeError("turn_snapshot_invalid", message);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !accepted.has(key));
  if (unknown.length > 0) {
    throw snapshotInvalid(
      `Codex item contains unknown fields: ${unknown.join(", ")}`,
    );
  }
}

function jsonSemantic(value: unknown): string {
  return JSON.stringify(value);
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

export function codexPhase0VerificationArgumentsHash(
  value: unknown,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function exactSourceThreadMismatchCode(value: unknown): boolean {
  if (value === "source_thread_mismatch") return true;
  if (Array.isArray(value)) return value.some(exactSourceThreadMismatchCode);
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.code === "source_thread_mismatch") return true;
  if (typeof record.text === "string") {
    try {
      return exactSourceThreadMismatchCode(JSON.parse(record.text));
    } catch {
      return false;
    }
  }
  return ["error", "content", "structuredContent"].some((key) =>
    exactSourceThreadMismatchCode(record[key]));
}

function phase0VerificationEvidenceFromTurn(
  turnValue: unknown,
  registrationName: string,
): CodexPhase0VerificationToolEvidence[] {
  const turn = asRecord(turnValue);
  if (!Array.isArray(turn.items)) {
    throw snapshotInvalid("Codex verification turn items are missing");
  }
  const allowedCases = new Set<string>(PHASE0_VERIFICATION_CASE_IDS);
  const toolName = `${registrationName}/present_phase0_card`;
  return turn.items.flatMap((value) => {
    const item = asRecord(value);
    if (
      item.type !== "mcpToolCall"
      || `${String(item.server)}/${String(item.tool)}` !== toolName
    ) return [];
    const args = asRecord(item.arguments);
    if (
      typeof args.verificationCaseId !== "string"
      || !allowedCases.has(args.verificationCaseId)
    ) return [];
    const status = normalizeProgressStatus(item.status);
    const errorValue = item.result === null ? item.error : item.result;
    return [{
      itemId: itemString(item, "id"),
      toolName,
      caseId: args.verificationCaseId as CodexPhase0VerificationCaseId,
      canonicalArgumentsHash: codexPhase0VerificationArgumentsHash(args),
      status,
      errorCode: exactSourceThreadMismatchCode(errorValue)
        ? "source_thread_mismatch" as const
        : null,
    }];
  });
}

function itemString(
  item: Record<string, unknown>,
  field: string,
): string {
  const value = item[field];
  if (typeof value !== "string" || value.length === 0) {
    throw snapshotInvalid(`Codex item has invalid ${field}`);
  }
  return value;
}

function textFromUserContent(value: unknown): string {
  if (!Array.isArray(value)) {
    throw snapshotInvalid("Codex user message content must be an array");
  }
  const texts: string[] = [];
  for (const content of value) {
    const entry = asRecord(content);
    assertOnlyKeys(entry, ["type", "text", "text_elements"]);
    if (
      entry.type !== "text"
      || typeof entry.text !== "string"
      || !Array.isArray(entry.text_elements)
    ) {
      throw snapshotInvalid("Codex user message contains non-text input");
    }
    texts.push(entry.text);
  }
  return texts.join("\n");
}

function normalizeProgressStatus(
  value: unknown,
): "running" | "completed" | "failed" {
  if (value === "inProgress") return "running";
  if (value === "completed") return "completed";
  if (value === "failed" || value === "declined") return "failed";
  throw snapshotInvalid("Codex item has an invalid status");
}

function normalizeItem(value: unknown): NormalizedCodexTurnItem {
  const item = asRecord(value);
  const id = item.id;
  if (typeof id !== "string" || id.length === 0) {
    throw snapshotInvalid("Codex turn item is missing a stable id");
  }
  switch (item.type) {
    case "userMessage":
      assertOnlyKeys(item, ["type", "id", "clientId", "content"]);
      return {
        id,
        kind: "user_message",
        semantic: { text: textFromUserContent(item.content) },
      };
    case "agentMessage":
      assertOnlyKeys(item, [
        "type",
        "id",
        "text",
        "phase",
        "memoryCitation",
      ]);
      return {
        id,
        kind: "agent_message",
        semantic: { text: itemString(item, "text") },
      };
    case "commandExecution":
      assertOnlyKeys(item, [
        "type",
        "id",
        "command",
        "cwd",
        "processId",
        "source",
        "status",
        "commandActions",
        "aggregatedOutput",
        "exitCode",
        "durationMs",
      ]);
      return {
        id,
        kind: "command_execution",
        semantic: {
          command: itemString(item, "command"),
          status: normalizeProgressStatus(item.status),
          output: typeof item.aggregatedOutput === "string"
            ? item.aggregatedOutput
            : null,
          exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
        },
        ...(typeof item.durationMs === "number"
          ? { metadata: { durationMs: item.durationMs } }
          : {}),
      };
    case "fileChange":
      assertOnlyKeys(item, ["type", "id", "changes", "status"]);
      if (!Array.isArray(item.changes) || item.changes.length === 0) {
        throw snapshotInvalid("Codex file change has no paths");
      }
      normalizeProgressStatus(item.status);
      {
        const changes = item.changes.map((value) => {
          const change = asRecord(value);
          assertOnlyKeys(change, ["path", "kind", "diff"]);
          const kind = asRecord(change.kind);
          const kindType = kind.type;
          if (kindType === "add" || kindType === "delete") {
            assertOnlyKeys(kind, ["type"]);
          } else if (kindType === "update") {
            assertOnlyKeys(kind, ["type", "move_path"]);
            if (
              kind.move_path !== null
              && typeof kind.move_path !== "string"
            ) {
              throw snapshotInvalid("Codex file change has invalid move_path");
            }
          } else {
            throw snapshotInvalid("Codex file change has invalid kind");
          }
          if (typeof change.diff !== "string") {
            throw snapshotInvalid("Codex file change has invalid diff");
          }
          return { path: itemString(change, "path"), kind: kindType };
        });
        const paths = changes.map(({ path }) => path);
        const kinds = changes.map(({ kind }) => kind);
        const change = kinds.every((kind) => kind === "add")
          ? "added" as const
          : kinds.every((kind) => kind === "delete")
            ? "deleted" as const
            : "modified" as const;
        return {
          id,
          kind: "file_change",
          semantic: {
            path: paths.join("\n"),
            change,
          },
        };
      }
    case "mcpToolCall":
      assertOnlyKeys(item, [
        "type",
        "id",
        "server",
        "tool",
        "status",
        "arguments",
        "appContext",
        "mcpAppResourceUri",
        "pluginId",
        "result",
        "error",
        "durationMs",
      ]);
      {
        const result = item.result === null ? null : asRecord(item.result);
        if (result) {
          assertOnlyKeys(result, ["content", "structuredContent", "_meta"]);
        }
        return {
          id,
          kind: "tool_call",
          semantic: {
            name: `${itemString(item, "server")}/${itemString(item, "tool")}`,
            status: normalizeProgressStatus(item.status),
            result: result === null
              ? item.error === null
                ? null
                : jsonSemantic(item.error)
              : jsonSemantic({
                content: result.content,
                structuredContent: result.structuredContent,
              }),
          },
          ...(typeof item.durationMs === "number"
            ? { metadata: { durationMs: item.durationMs } }
            : {}),
        };
      }
    case "dynamicToolCall":
      assertOnlyKeys(item, [
        "type",
        "id",
        "namespace",
        "tool",
        "arguments",
        "status",
        "contentItems",
        "success",
        "durationMs",
      ]);
      return {
        id,
        kind: "tool_call",
        semantic: {
          name: typeof item.namespace === "string"
            ? `${item.namespace}/${itemString(item, "tool")}`
            : itemString(item, "tool"),
          status: normalizeProgressStatus(item.status),
          result: item.contentItems === null
            ? null
            : jsonSemantic(item.contentItems),
        },
        ...(typeof item.durationMs === "number"
          ? { metadata: { durationMs: item.durationMs } }
          : {}),
      };
    default:
      throw snapshotInvalid("Codex turn contains an unknown item kind");
  }
}

const CODEX_ERROR_CODES = new Set([
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "usageLimitExceeded",
  "serverOverloaded",
  "cyberPolicy",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "threadRollbackFailed",
  "sandboxError",
  "other",
]);

function normalizeCodexErrorInfo(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (typeof value === "string") {
    if (!CODEX_ERROR_CODES.has(value)) {
      throw snapshotInvalid("Codex terminal error has unknown code");
    }
    return value;
  }
  const info = asRecord(value);
  const keys = Object.keys(info);
  if (keys.length !== 1) {
    throw snapshotInvalid("Codex terminal error info is malformed");
  }
  const code = keys[0]!;
  const details = asRecord(info[code]);
  if (
    code === "httpConnectionFailed"
    || code === "responseStreamConnectionFailed"
    || code === "responseStreamDisconnected"
    || code === "responseTooManyFailedAttempts"
  ) {
    assertOnlyKeys(details, ["httpStatusCode"]);
    if (
      details.httpStatusCode !== null
      && (
        typeof details.httpStatusCode !== "number"
        || !Number.isInteger(details.httpStatusCode)
      )
    ) {
      throw snapshotInvalid("Codex terminal HTTP status is malformed");
    }
    return code;
  }
  if (code === "activeTurnNotSteerable") {
    assertOnlyKeys(details, ["turnKind"]);
    if (typeof details.turnKind !== "string" || details.turnKind.length === 0) {
      throw snapshotInvalid("Codex terminal turn kind is malformed");
    }
    return code;
  }
  throw snapshotInvalid("Codex terminal error has unknown code");
}

function parseTurn(
  threadId: string,
  turnValue: unknown,
  observedAt: string,
): CodexTurnSnapshot {
  const turn = asRecord(turnValue);
  assertOnlyKeys(turn, [
    "id",
    "items",
    "itemsView",
    "status",
    "error",
    "startedAt",
    "completedAt",
    "durationMs",
  ]);
  const turnId = turn.id;
  if (typeof turnId !== "string" || turnId.length === 0) {
    throw snapshotInvalid("Codex turn is missing id");
  }
  if (!Array.isArray(turn.items) || turn.itemsView !== "full") {
    throw snapshotInvalid("Codex turn items are not a full snapshot");
  }
  const values = turn.items;
  const items = values.map(normalizeItem);
  const itemIds = items.map(({ id }) => id);
  if (new Set(itemIds).size !== itemIds.length) {
    throw snapshotInvalid("Codex app-server turn contains duplicate item ids");
  }
  const status = turn.status;
  if (
    status !== "inProgress"
    && status !== "completed"
    && status !== "failed"
    && status !== "interrupted"
  ) {
    throw snapshotInvalid("Codex app-server turn has an invalid status");
  }
  const agentMessage = [...items].reverse().find(
    (item) => item.kind === "agent_message",
  );
  const completedAt = optionalTimestamp(turn.completedAt);
  const durationMs = turn.durationMs;
  if (
    turn.startedAt !== null
    && turn.startedAt !== undefined
    && typeof turn.startedAt !== "number"
  ) {
    throw snapshotInvalid("Codex turn has invalid startedAt");
  }
  if (
    durationMs !== null
    && (
      typeof durationMs !== "number"
      || !Number.isFinite(durationMs)
      || durationMs < 0
    )
  ) {
    throw snapshotInvalid("Codex turn has invalid durationMs");
  }
  if (status === "inProgress") {
    if (
      turn.error !== null
      || turn.completedAt !== null
      || turn.durationMs !== null
    ) {
      throw snapshotInvalid("Codex in-progress turn has terminal fields");
    }
  } else if (
    turn.completedAt === null
    || turn.completedAt === undefined
    || typeof durationMs !== "number"
  ) {
    throw snapshotInvalid("Codex terminal turn is missing completion fields");
  }
  let terminal: CodexTurnSnapshot["terminal"];
  if (status === "completed") {
    if (
      turn.error !== null
      || typeof agentMessage?.semantic.text !== "string"
    ) {
      throw snapshotInvalid("Codex completed turn has malformed terminal output");
    }
    terminal = { output: agentMessage.semantic.text };
  } else if (status === "failed") {
    const error = asRecord(turn.error);
    assertOnlyKeys(error, ["message", "codexErrorInfo", "additionalDetails"]);
    if (
      typeof error.message !== "string"
      || error.message.length === 0
      || (
        error.additionalDetails !== null
        && typeof error.additionalDetails !== "string"
      )
    ) {
      throw snapshotInvalid("Codex failed turn has malformed terminal error");
    }
    const errorCode = normalizeCodexErrorInfo(error.codexErrorInfo);
    terminal = {
      errorMessage: error.message,
      ...(errorCode ? { errorCode } : {}),
    };
  } else if (status === "interrupted") {
    if (turn.error !== null) {
      throw snapshotInvalid("Codex interrupted turn unexpectedly has an error");
    }
    terminal = {
      errorCode: "interrupted",
      errorMessage: "Codex turn interrupted",
    };
  }
  return {
    threadId,
    turnId,
    status,
    items,
    ...(terminal ? { terminal } : {}),
    metadata: {
      ...(turn.startedAt === null || turn.startedAt === undefined
        ? {}
        : { startedAt: timestamp(turn.startedAt, "startedAt") }),
      ...(completedAt ? { completedAt } : {}),
      ...(typeof durationMs === "number"
        ? { durationMs }
        : {}),
      observedAt,
    },
  };
}

export function createCodexAppServerShellControl(
  options: ShellControlOptions,
): CodexAppServerShellControl {
  if (
    !options.appServerBinary
    || !hasCanonicalAppServerIdentity(options.appServerBinary)
  ) {
    throw new CodexDesktopBridgeError(
      "desktop_bridge_unavailable",
      "an attested Codex app-server binary is required",
    );
  }
  const clientFactory = options.clientFactory
    ?? ((cwd: string | undefined, codexBin: string) => {
      return CodexAppServerClient.spawn({
        bin: codexBin,
        cwd: cwd ?? process.cwd(),
        env: process.env,
        onNotification: () => {},
        onServerRequest: async () => ({ decision: "decline" }),
      });
    });
  const verifyAppServerBinary = options.verifyAppServerBinary
    ?? (async (identity: CodexDesktopAttestedAppServerBinary) => {
      await verifyAttestedAppServerBinary(identity);
    });
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxActiveClients = options.maxActiveClients ?? 32;
  let activeClients = 0;
  async function withClient<T>(
    cwd: string | undefined,
    body: (
      client: AppServerShellClient,
      initialized: Record<string, unknown>,
    ) => Promise<T>,
    lifecycle: { deadlineAt?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (activeClients >= maxActiveClients) {
      throw new CodexDesktopBridgeError(
        "desktop_bridge_unavailable",
        "Codex app-server active client limit reached",
      );
    }
    const deadlineMs = lifecycle.deadlineAt === undefined
      ? undefined
      : Date.parse(lifecycle.deadlineAt) - now();
    if (
      deadlineMs !== undefined
      && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
    ) {
      throw new CodexDesktopBridgeError(
        "desktop_bridge_unavailable",
        "Codex app-server read deadline elapsed",
      );
    }
    if (lifecycle.signal?.aborted) {
      throw new CodexDesktopBridgeError(
        "desktop_bridge_unavailable",
        "Codex app-server read aborted",
      );
    }
    activeClients += 1;
    let client: AppServerShellClient | undefined;
    try {
      await verifyAppServerBinary(
        options.appServerBinary,
        "before_spawn",
      );
      client = clientFactory(cwd, options.appServerBinary.path);
      await verifyAppServerBinary(
        options.appServerBinary,
        "after_spawn",
      );
    } catch (error) {
      if (client) await client.close(0).catch(() => {});
      activeClients -= 1;
      throw error;
    }
    const activeClient = client!;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let rejectLifecycle: ((error: Error) => void) | undefined;
    let closePromise: Promise<unknown> | undefined;
    const beginClose = (graceMs: number) => {
      closePromise ??= activeClient.close(graceMs).catch(() => {});
      return closePromise;
    };
    const lifecycleFailure = new Promise<never>((_, reject) => {
      rejectLifecycle = reject;
    });
    const abort = () => {
      void beginClose(0);
      rejectLifecycle?.(new CodexDesktopBridgeError(
        "desktop_bridge_unavailable",
        "Codex app-server read aborted",
      ));
    };
    try {
      lifecycle.signal?.addEventListener("abort", abort, { once: true });
      if (deadlineMs !== undefined) {
        deadlineTimer = setTimeout(() => {
          void beginClose(0);
          rejectLifecycle?.(new CodexDesktopBridgeError(
            "desktop_bridge_unavailable",
            "Codex app-server read deadline elapsed",
          ));
        }, deadlineMs);
      }
      options.onRequest?.("initialize", {});
      const initialized = await Promise.race([
        activeClient.initialize(),
        lifecycleFailure,
      ]);
      return await Promise.race([
        body(activeClient, initialized),
        lifecycleFailure,
      ]);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      lifecycle.signal?.removeEventListener("abort", abort);
      await (closePromise ?? beginClose(2_000));
      activeClients -= 1;
    }
  }

  function request(
    client: AppServerShellClient,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<unknown> {
    if (!ALLOWED_SHELL_METHODS.has(method)) {
      throw new Error(`app-server shell method is not allowlisted: ${method}`);
    }
    options.onRequest?.(method, params);
    return client.request(method, params, timeoutMs);
  }

  return {
    probe() {
      return withClient(undefined, async (client, initialized) => {
        const version = requiredString(initialized, "userAgent");
        const protocolFingerprint =
          `${APP_SERVER_PROTOCOL_SCHEMA_FINGERPRINT};runtime=${version}`;
        const modelResponse = asRecord(await request(client, "model/list", {
          cursor: null,
          includeHidden: false,
          limit: 1,
        }));
        if (!Array.isArray(modelResponse.data)) {
          throw new Error("Codex model/list probe response is missing data");
        }
        modelResponse.data.forEach(parseModel);
        const threadResponse = asRecord(await request(client, "thread/list", {
          cursor: null,
          limit: 1,
          cwd: process.cwd(),
          searchTerm: "",
        }));
        if (!Array.isArray(threadResponse.data)) {
          throw new Error("Codex thread/list probe response is missing data");
        }
        return {
          version,
          protocolFingerprint,
          capabilities: ["model/list", "thread/list"],
          protocolCapabilities: (
            KNOWN_APP_SERVER_RUNTIMES.has(version)
            || (
              options.behaviorEvidence?.protocolFingerprint
                === protocolFingerprint
              && SHELL_PROTOCOL_CAPABILITIES.every((capability) =>
                options.behaviorEvidence!.capabilities.includes(capability))
            )
          )
            ? [...SHELL_PROTOCOL_CAPABILITIES]
            : [],
        };
      });
    },
    startPersistentThread(input) {
      if (input.ephemeral !== false) {
        throw new Error("Codex shell must be persistent");
      }
      return withClient(input.cwd, async (client) => {
        const response = asRecord(await request(client, "thread/start", {
          cwd: input.cwd,
          ephemeral: false,
        }));
        const thread = asRecord(response.thread);
        return { threadId: requiredString(thread, "id") };
      });
    },
    startPersistentThreadAndName(input) {
      if (input.ephemeral !== false) {
        throw new Error("Codex shell must be persistent");
      }
      if (!input.name) {
        throw new Error("Codex persistent shell name is required");
      }
      return withClient(input.cwd, async (client) => {
        const deadline = Date.parse(input.deadlineAt);
        if (!Number.isFinite(deadline) || deadline <= now()) {
          throw new CodexDesktopBridgeError(
            "desktop_bridge_unavailable",
            "Codex persistent shell provision deadline elapsed",
          );
        }
        const startResponse = asRecord(await request(
          client,
          "thread/start",
          {
            cwd: input.cwd,
            ephemeral: false,
          },
          Math.min(15_000, Math.max(1, deadline - now())),
        ));
        const started = asRecord(startResponse.thread);
        const threadId = requiredString(started, "id");
        await input.onStarted(threadId);
        input.onCheckpoint?.("after_thread_start");
        await input.activate(threadId);
        input.onCheckpoint?.("after_thread_activation");

        let delayMs = 25;
        while (true) {
          if (now() >= deadline) {
            throw new CodexDesktopBridgeError(
              "desktop_bridge_unavailable",
              "Codex persistent shell name deadline elapsed",
            );
          }
          try {
            await request(client, "thread/name/set", {
              threadId,
              name: input.name,
            }, Math.min(15_000, Math.max(1, deadline - now())));
            break;
          } catch (error) {
            if (!isProvisionVisibilityLag(error)) throw error;
          }
          await sleep(Math.max(0, Math.min(delayMs, deadline - now())));
          delayMs = Math.min(delayMs * 2, 250);
        }
        input.onCheckpoint?.("after_thread_name");

        delayMs = 25;
        while (true) {
          if (now() >= deadline) {
            throw new CodexDesktopBridgeError(
              "desktop_bridge_unavailable",
              "Codex persistent shell proof deadline elapsed",
            );
          }
          try {
            const readResponse = asRecord(await request(
              client,
              "thread/read",
              { threadId, includeTurns: true },
              Math.min(15_000, Math.max(1, deadline - now())),
            ));
            const readThread = asRecord(readResponse.thread);
            if (
              !Array.isArray(readThread.turns)
              || readThread.turns.length !== 0
            ) {
              throw new Error(
                "Codex creator-session bootstrap thread is not empty",
              );
            }
            const read = parseShell(readThread);
            if (
              !read
              || read.threadId !== threadId
              || read.cwd !== input.cwd
              || read.title !== input.name
            ) {
              throw new Error(
                "Codex creator-session thread/read proof is invalid",
              );
            }
            return read;
          } catch (error) {
            if (!isProvisionVisibilityLag(error)) throw error;
          }
          await sleep(Math.max(0, Math.min(delayMs, deadline - now())));
          delayMs = Math.min(delayMs * 2, 250);
        }
      }, { deadlineAt: input.deadlineAt });
    },
    setThreadName(input) {
      return withClient(undefined, async (client) => {
        await request(client, "thread/name/set", input);
      });
    },
    findPersistentShell(input) {
      return withClient(input.cwd, async (client) => {
        const matches: CodexPersistentShell[] = [];
        const seen = new Set<string>();
        let cursor: string | null = null;
        do {
          const response = asRecord(await request(client, "thread/list", {
            cursor,
            limit: PAGE_LIMIT,
            cwd: input.cwd,
            searchTerm: input.title,
          }));
          const data = Array.isArray(response.data) ? response.data : [];
          for (const value of data) {
            const shell = parseShell(value);
            if (
              shell
              && shell.cwd === input.cwd
              && shell.title === input.title
            ) {
              matches.push(shell);
            }
          }
          const next = typeof response.nextCursor === "string"
            && response.nextCursor.length > 0
            ? response.nextCursor
            : null;
          if (next && seen.has(next)) {
            throw new Error("Codex thread/list repeated a cursor");
          }
          if (next) seen.add(next);
          cursor = next;
        } while (cursor);
        return matches;
      });
    },
    listPersistentShells(input) {
      return withClient(input.cwd, async (client) => {
        const shells: CodexPersistentShell[] = [];
        const seen = new Set<string>();
        let cursor: string | null = null;
        do {
          const response = asRecord(await request(client, "thread/list", {
            cursor,
            limit: PAGE_LIMIT,
            cwd: input.cwd,
            searchTerm: "",
          }));
          if (!Array.isArray(response.data)) {
            throw new Error("Codex thread/list response is missing data");
          }
          for (const value of response.data) {
            const shell = parseShell(value);
            if (shell && shell.cwd === input.cwd) shells.push(shell);
          }
          const next = typeof response.nextCursor === "string"
            && response.nextCursor.length > 0
            ? response.nextCursor
            : null;
          if (next && seen.has(next)) {
            throw new Error("Codex thread/list repeated a cursor");
          }
          if (next) seen.add(next);
          cursor = next;
        } while (cursor);
        return shells;
      });
    },
    readPersistentShell(threadId) {
      return withClient(undefined, async (client) => {
        const response = asRecord(await request(client, "thread/read", {
          threadId,
          includeTurns: false,
        }));
        return parseShell(response.thread);
      });
    },
    readThreadWithTurns(input) {
      if (input.includeTurns !== true) {
        throw new Error("Codex lifecycle reads must include turns");
      }
      return withClient(undefined, async (client) => {
        const remaining = input.deadlineAt === undefined
          ? 15_000
          : Math.max(1, Date.parse(input.deadlineAt) - now());
        const response = asRecord(await request(client, "thread/read", {
          threadId: input.threadId,
          includeTurns: true,
        }, Math.min(15_000, remaining)));
        const shell = parseShell(response.thread);
        if (!shell || shell.threadId !== input.threadId) {
          throw new Error("Codex thread/read returned another shell");
        }
        const thread = asRecord(response.thread);
        const values = Array.isArray(thread.turns) ? thread.turns : [];
        const turns = values.map((value) =>
          parseTurn(shell.threadId, value, new Date(now()).toISOString()));
        if (
          new Set(turns.map(({ turnId }) => turnId)).size !== turns.length
        ) {
          throw snapshotInvalid("Codex thread/read returned duplicate turn ids");
        }
        return {
          shell,
          turns,
        };
      }, {
        deadlineAt: input.deadlineAt,
        signal: input.signal,
      });
    },
    readPhase0VerificationToolEvidence(input) {
      return withClient(undefined, async (client) => {
        const response = asRecord(await request(client, "thread/read", {
          threadId: input.threadId,
          includeTurns: true,
        }));
        const shell = parseShell(response.thread);
        if (!shell || shell.threadId !== input.threadId) {
          throw new Error("Codex thread/read returned another shell");
        }
        const thread = asRecord(response.thread);
        const turns = Array.isArray(thread.turns) ? thread.turns : [];
        const matching = turns.filter(
          (turn) => asRecord(turn).id === input.turnId,
        );
        if (matching.length !== 1) {
          throw new Error("Codex verification turn identity is ambiguous");
        }
        return phase0VerificationEvidenceFromTurn(
          matching[0],
          input.registrationName,
        );
      });
    },
    listModels() {
      return withClient(undefined, async (client) => {
        const models: CodexModel[] = [];
        const seen = new Set<string>();
        let cursor: string | null = null;
        do {
          const response = asRecord(await request(client, "model/list", {
            cursor,
            includeHidden: false,
            limit: PAGE_LIMIT,
          }));
          if (!Array.isArray(response.data)) {
            throw new Error("Codex model/list response is missing data");
          }
          models.push(...response.data.map(parseModel));
          const next = typeof response.nextCursor === "string"
            && response.nextCursor.length > 0
            ? response.nextCursor
            : null;
          if (next && seen.has(next)) {
            throw new Error("Codex model/list repeated a cursor");
          }
          if (next) seen.add(next);
          cursor = next;
        } while (cursor);
        return models;
      });
    },
  };
}
