import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { promisify } from "node:util";

import { CodexDesktopBridgeError } from "./codex-desktop-bridge";
import {
  defaultCodexDesktopDiscoveryDependencies,
  type CodexDesktopAttestedIpcEndpoint,
  type CodexDesktopDiscoveryFileSystem,
  type CodexDesktopSignedBundleIdentity,
  type CodexDesktopSocketStat,
} from "./codex-desktop-ipc-discovery";
import type {
  CodexDesktopTurnRequest,
} from "./codex-desktop-bridge-types";

const execFileAsync = promisify(execFile);
const DESKTOP_START_METHOD = "thread-follower-start-turn";
const DESKTOP_INTERRUPT_METHOD = "thread-follower-interrupt-turn";
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const OBSERVABLE_FOLLOWER_CAPABILITIES = new Set([
  "deep-link:codex-thread",
  DESKTOP_START_METHOD,
  "turn/interrupt",
  "project/alternate-cwd",
]);
const FOLLOWER_PROTOCOL_CAPABILITIES = [
  "deep-link:codex-thread",
  DESKTOP_START_METHOD,
  "turn/interrupt",
  "project/alternate-cwd",
] as const;
const CURRENT_DESKTOP_FOLLOWER_PROTOCOL_FINGERPRINT = [
  "initialize-v0+le32-json+desktop-follower-v1",
  "bundleIdentifier=com.openai.codex",
  "bundleShortVersion=26.721.41059",
  "bundleVersion=5848",
  "chromiumBaseVersion=150.0.7871.128",
].join(";");
const KNOWN_DESKTOP_FOLLOWER_PROTOCOL_FINGERPRINTS = new Set([
  CURRENT_DESKTOP_FOLLOWER_PROTOCOL_FINGERPRINT,
]);

export interface CodexDesktopProtocolBehaviorEvidence {
  protocolFingerprint: string;
  capabilities: string[];
}

export function desktopFollowerProtocolFingerprint(
  identity: CodexDesktopSignedBundleIdentity,
): string {
  return [
    "initialize-v0+le32-json+desktop-follower-v1",
    `bundleIdentifier=${identity.bundleIdentifier}`,
    `bundleShortVersion=${identity.bundleShortVersion}`,
    `bundleVersion=${identity.bundleVersion}`,
    `chromiumBaseVersion=${identity.chromiumBaseVersion}`,
  ].join(";");
}

export function desktopFollowerProtocolCapabilities(input: {
  clientVersion: string;
  signedBundleIdentity: CodexDesktopSignedBundleIdentity;
  protocolFingerprint: string;
  behaviorEvidence?: CodexDesktopProtocolBehaviorEvidence;
}): string[] {
  const attestedFingerprint = desktopFollowerProtocolFingerprint(
    input.signedBundleIdentity,
  );
  if (
    input.protocolFingerprint === attestedFingerprint
    && (
      KNOWN_DESKTOP_FOLLOWER_PROTOCOL_FINGERPRINTS.has(attestedFingerprint)
    || (
      input.behaviorEvidence?.protocolFingerprint === input.protocolFingerprint
      && FOLLOWER_PROTOCOL_CAPABILITIES.every((capability) =>
        input.behaviorEvidence!.capabilities.includes(capability))
    )
    )
  ) {
    return [...FOLLOWER_PROTOCOL_CAPABILITIES];
  }
  return [];
}

export interface CodexDesktopFollowerTransport {
  probe(): Promise<{
    clientVersion: string;
    protocolFingerprint: string;
    capabilities: string[];
    protocolCapabilities: string[];
  }>;
  openThreadDeepLink(input: {
    url: `codex://threads/${string}`;
  }): Promise<void>;
  startFollowerTurn(
    input: CodexDesktopTurnRequest,
  ): Promise<
    { status: "started"; turnId: string }
    | { status: "no-client-found" }
  >;
  interruptTurn(input: { threadId: string; turnId: string }): Promise<void>;
}

export class CodexDesktopFollowerRoutingError extends Error {
  constructor(readonly code: "no-client-found" | "thread-detached") {
    super(code);
    this.name = "CodexDesktopFollowerRoutingError";
  }
}

function protocolInvalid(message: string): CodexDesktopBridgeError {
  return new CodexDesktopBridgeError("desktop_protocol_invalid", message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

export async function assertCodexDesktopEndpointIdentity(
  endpoint: CodexDesktopAttestedIpcEndpoint,
  fileSystem: CodexDesktopDiscoveryFileSystem,
): Promise<void> {
  const [socket, parent] = await Promise.all([
    fileSystem.lstat(endpoint.path),
    fileSystem.lstat(endpoint.parentPath),
  ]);
  const same = (
    actual: CodexDesktopSocketStat,
    expected: CodexDesktopSocketStat,
  ) => (
    actual.device === expected.device
    && actual.inode === expected.inode
    && actual.uid === expected.uid
    && actual.mode === expected.mode
    && actual.isSocket === expected.isSocket
    && actual.isDirectory === expected.isDirectory
    && actual.isSymbolicLink === expected.isSymbolicLink
  );
  if (
    socket.isSymbolicLink
    || parent.isSymbolicLink
    || !socket.isSocket
    || !parent.isDirectory
    || !same(socket, endpoint.socket)
    || !same(parent, endpoint.parent)
  ) {
    throw new CodexDesktopBridgeError(
      "desktop_bridge_unavailable",
      "Codex Desktop IPC endpoint identity changed",
    );
  }
}

class DesktopIpcConnection {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private sourceClientId = "initializing-client";
  private readonly pending = new Map<string, {
    method: string;
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private readonly endpoint: CodexDesktopAttestedIpcEndpoint,
    private readonly fileSystem: CodexDesktopDiscoveryFileSystem,
    private readonly onWriteCommitted?: (method: string) => void,
  ) {}

  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request(
      "initialize",
      { clientType: "stagepass-hybrid-desktop-bridge-phase0" },
      0,
      5_000,
    );
    const clientId = result.clientId;
    if (typeof clientId !== "string" || clientId.length === 0) {
      throw protocolInvalid("Desktop initialize omitted clientId");
    }
    this.sourceClientId = clientId;
    return result;
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    version = 1,
    timeoutMs = 25_000,
  ): Promise<Record<string, unknown>> {
    await this.connect();
    const requestId = randomUUID();
    const encoded = Buffer.from(JSON.stringify({
      type: "request",
      requestId,
      sourceClientId: this.sourceClientId,
      version,
      method,
      params,
      timeoutMs,
    }), "utf8");
    if (encoded.length > MAX_FRAME_BYTES) {
      throw protocolInvalid("Desktop request frame exceeds size limit");
    }
    const frame = Buffer.allocUnsafe(4 + encoded.length);
    frame.writeUInt32LE(encoded.length, 0);
    encoded.copy(frame, 4);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex Desktop IPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(requestId, { method, resolve, reject, timer });
      this.socket?.write(frame, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(error);
          return;
        }
        try {
          this.onWriteCommitted?.(method);
        } catch (cause) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(cause instanceof Error ? cause : new Error(String(cause)));
          this.socket?.destroy();
        }
      });
    });
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.socket) return;
    await this.verifyEndpointIdentity();
    const socket = net.createConnection(this.endpoint.path);
    this.socket = socket;
    socket.on("data", (chunk) => this.consume(chunk));
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("close", () => {
      this.rejectAll(new Error("Codex Desktop IPC connection closed"));
      this.socket = null;
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    try {
      await this.verifyEndpointIdentity();
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  private async verifyEndpointIdentity(): Promise<void> {
    await assertCodexDesktopEndpointIdentity(this.endpoint, this.fileSystem);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        this.rejectAll(protocolInvalid("Desktop response frame exceeds limit"));
        this.socket?.destroy();
        return;
      }
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let message: Record<string, unknown>;
      try {
        message = asRecord(JSON.parse(payload.toString("utf8"))) ?? {};
      } catch {
        this.rejectAll(protocolInvalid("Desktop response frame is not JSON"));
        this.socket?.destroy();
        return;
      }
      if (message.type === "client-discovery-request") {
        this.respondToDiscovery(message);
        continue;
      }
      if (message.type !== "response" || typeof message.requestId !== "string") {
        continue;
      }
      const pending = this.pending.get(message.requestId);
      if (!pending) continue;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.resultType !== "success") {
        const raw = typeof message.error === "string"
          ? message.error
          : JSON.stringify(message.error ?? "");
        const normalized = raw.toLowerCase();
        pending.reject(
          normalized.includes("no-client-found")
            ? new CodexDesktopFollowerRoutingError("no-client-found")
            : normalized.includes("thread not found")
                || normalized.includes("conversation not found")
                || normalized.includes("thread-detached")
              ? new CodexDesktopFollowerRoutingError("thread-detached")
            : new CodexDesktopBridgeError(
              "desktop_bridge_unavailable",
              `Codex Desktop rejected ${pending.method}`,
            ),
        );
        continue;
      }
      pending.resolve(asRecord(message.result) ?? {});
    }
  }

  private respondToDiscovery(message: Record<string, unknown>): void {
    if (!this.socket || typeof message.requestId !== "string") return;
    const payload = Buffer.from(JSON.stringify({
      type: "client-discovery-response",
      requestId: message.requestId,
      response: { canHandle: false },
    }), "utf8");
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    this.socket.write(frame);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function sandboxPolicy(
  request: CodexDesktopTurnRequest,
): Record<string, unknown> {
  return request.sandboxMode === "read-only"
    ? { type: "readOnly", networkAccess: false }
    : {
      type: "workspaceWrite",
      writableRoots: [request.cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
}

export function createObservedCodexDesktopFollowerTransport(
  endpoint: CodexDesktopAttestedIpcEndpoint,
  options: {
    openDeepLink?: (url: `codex://threads/${string}`) => Promise<void>;
    onRequest?: (
      method: string,
      params: Record<string, unknown>,
    ) => void;
    behaviorEvidence?: CodexDesktopProtocolBehaviorEvidence;
    onWriteCommitted?: (method: string) => void;
    fileSystem?: CodexDesktopDiscoveryFileSystem;
  } = {},
): CodexDesktopFollowerTransport {
  const fileSystem = options.fileSystem
    ?? defaultCodexDesktopDiscoveryDependencies().fileSystem;
  const openDeepLink = options.openDeepLink ?? (async (url) => {
    await execFileAsync("/usr/bin/open", [url], { timeout: 5_000 });
  });
  return {
    async probe() {
      const connection = new DesktopIpcConnection(
        endpoint,
        fileSystem,
        options.onWriteCommitted,
      );
      try {
        options.onRequest?.("initialize", {});
        const initialized = await connection.initialize();
        const capabilities = Array.isArray(initialized.capabilities)
          ? initialized.capabilities.filter(
            (value): value is string =>
              typeof value === "string"
              && OBSERVABLE_FOLLOWER_CAPABILITIES.has(value),
          )
          : [];
        const clientVersion = typeof initialized.clientVersion === "string"
          ? initialized.clientVersion
          : "unreported";
        const protocolFingerprint = desktopFollowerProtocolFingerprint(
          endpoint.desktopBundleIdentity,
        );
        return {
          clientVersion,
          protocolFingerprint,
          capabilities,
          protocolCapabilities: desktopFollowerProtocolCapabilities({
            clientVersion,
            signedBundleIdentity: endpoint.desktopBundleIdentity,
            protocolFingerprint,
            behaviorEvidence: options.behaviorEvidence,
          }),
        };
      } finally {
        connection.close();
      }
    },
    openThreadDeepLink(input) {
      if (!/^codex:\/\/threads\/[A-Za-z0-9-]+$/.test(input.url)) {
        throw protocolInvalid("invalid Codex thread deep link");
      }
      return openDeepLink(input.url);
    },
    async startFollowerTurn(request) {
      const connection = new DesktopIpcConnection(
        endpoint,
        fileSystem,
        options.onWriteCommitted,
      );
      try {
        options.onRequest?.("initialize", {});
        await connection.initialize();
        const params = {
          conversationId: request.threadId,
          turnStartParams: {
            input: [{ type: "text", text: request.prompt }],
            cwd: request.cwd,
            approvalPolicy: request.approvalPolicy,
            sandboxPolicy: sandboxPolicy(request),
            ...(request.model ? { model: request.model } : {}),
            ...(request.reasoningEffort
              ? { effort: request.reasoningEffort }
              : {}),
            // Passed straight through to the app-server's TurnStartParams,
            // where it is enforced on the final assistant message. Whether the
            // Desktop follower wrapper forwards it is NOT provable from here --
            // it may whitelist fields and drop this one silently. Any caller
            // relying on it must still validate the reply server-side.
            ...(request.outputSchema
              ? { outputSchema: request.outputSchema }
              : {}),
          },
        };
        options.onRequest?.(DESKTOP_START_METHOD, params);
        const result = await connection.request(DESKTOP_START_METHOD, params);
        const nested = asRecord(result.result) ?? result;
        const turn = asRecord(nested.turn);
        if (typeof turn?.id !== "string" || turn.id.length === 0) {
          throw protocolInvalid("Desktop follower response omitted turn id");
        }
        return { status: "started", turnId: turn.id };
      } catch (error) {
        if (
          error instanceof CodexDesktopFollowerRoutingError
          && error.code === "no-client-found"
        ) {
          return { status: "no-client-found" };
        }
        throw error;
      } finally {
        connection.close();
      }
    },
    async interruptTurn(input) {
      const connection = new DesktopIpcConnection(
        endpoint,
        fileSystem,
        options.onWriteCommitted,
      );
      try {
        options.onRequest?.("initialize", {});
        await connection.initialize();
        const params = {
          conversationId: input.threadId,
          turnId: input.turnId,
        };
        options.onRequest?.(DESKTOP_INTERRUPT_METHOD, params);
        await connection.request(DESKTOP_INTERRUPT_METHOD, params);
      } finally {
        connection.close();
      }
    },
  };
}
