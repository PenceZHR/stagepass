import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type {
  PublicInteractionEnvelope,
} from "../server/services/mcp-presentation-auth-service";
import type {
  StagePassSubmitAuthorization,
} from "./stagepass-api-client";

export const MCP_HOST_ATTESTATION_UNSUPPORTED =
  "presentation_auth_channel_unavailable" as const;

export interface McpHostLaunchEvidence {
  hostPid: number;
  hostBundleIdentifier: "com.openai.codex";
  hostTeamIdentifier: "2DC432GLL2";
  sourceThreadId: string;
  mcpBundleDigest: string;
  launchRecordId: string;
}

export interface McpHostEvidenceVerifier {
  verify(evidence: McpHostLaunchEvidence): Promise<boolean>;
}

export interface HostAttestedMcpChannel {
  readonly channelId: string;
  readonly sourceThreadId: string;
  readonly hostFingerprint: string;
}

const attestedChannels = new WeakSet<object>();
let latestEvidence: {
  status: "passed" | "missing" | "failed";
  verifiedBy: "real-mcp-fixture" | null;
  hostFingerprint: string | null;
  verifiedAt: string | null;
} = {
  status: "missing",
  verifiedBy: null,
  hostFingerprint: null,
  verifiedAt: null,
};

export class McpHostAttestationError extends Error {
  readonly code = MCP_HOST_ATTESTATION_UNSUPPORTED;

  constructor(message = MCP_HOST_ATTESTATION_UNSUPPORTED) {
    super(message);
    this.name = "McpHostAttestationError";
  }
}

export async function createHostAttestedMcpChannel(
  evidence: McpHostLaunchEvidence,
  verifier: McpHostEvidenceVerifier,
): Promise<HostAttestedMcpChannel> {
  if (
    !Number.isSafeInteger(evidence.hostPid)
    || evidence.hostPid <= 1
    || evidence.hostBundleIdentifier !== "com.openai.codex"
    || evidence.hostTeamIdentifier !== "2DC432GLL2"
    || !evidence.sourceThreadId.trim()
    || !/^[a-f0-9]{64}$/i.test(evidence.mcpBundleDigest)
    || !evidence.launchRecordId.trim()
    || !(await verifier.verify(evidence))
  ) {
    latestEvidence = {
      status: "failed",
      verifiedBy: null,
      hostFingerprint: null,
      verifiedAt: null,
    };
    throw new McpHostAttestationError();
  }
  const hostFingerprint = createHash("sha256")
    .update([
      evidence.hostPid,
      evidence.hostBundleIdentifier,
      evidence.hostTeamIdentifier,
      evidence.mcpBundleDigest,
      evidence.launchRecordId,
    ].join(":"))
    .digest("hex");
  const channel: HostAttestedMcpChannel = Object.freeze({
    channelId: randomUUID(),
    sourceThreadId: evidence.sourceThreadId,
    hostFingerprint,
  });
  attestedChannels.add(channel);
  latestEvidence = {
    status: "passed",
    verifiedBy: "real-mcp-fixture",
    hostFingerprint,
    verifiedAt: new Date().toISOString(),
  };
  return channel;
}

export function assertHostAttestedMcpChannel(
  channel: HostAttestedMcpChannel | null | undefined,
): asserts channel is HostAttestedMcpChannel {
  if (!channel || !attestedChannels.has(channel)) {
    throw new McpHostAttestationError();
  }
}

export function readMcpHostEvidence() {
  return { ...latestEvidence };
}

type BrokerResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

function brokerErrorCode(value: unknown): string {
  return (
    typeof value === "string"
    && /^[a-z][a-z0-9_]{0,79}$/.test(value)
  ) ? value : "protected_broker_failed";
}

export class FdStagePassProtectedBroker {
  readonly health = "ready" as const;
  private readonly socket: net.Socket;
  private readonly pending = new Map<string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();

  constructor(fd: number, private readonly timeoutMs = 5_000) {
    if (!Number.isSafeInteger(fd) || fd <= 2) {
      throw new McpHostAttestationError();
    }
    this.socket = new net.Socket({
      fd,
      readable: true,
      writable: true,
    });
    const lines = readline.createInterface({ input: this.socket });
    lines.on("line", (line) => {
      let response: BrokerResponse;
      try {
        response = JSON.parse(line) as BrokerResponse;
      } catch {
        return;
      }
      if (!response || typeof response.id !== "string") return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(brokerErrorCode(response.error)));
    });
    const rejectAll = () => {
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error("protected_broker_unavailable"));
      }
    };
    this.socket.once("close", rejectAll);
    this.socket.once("error", rejectAll);
  }

  async verifyLaunchEvidence(evidence: McpHostLaunchEvidence): Promise<boolean> {
    const result = await this.request("verify_launch", { evidence });
    return (
      typeof result === "object"
      && result !== null
      && "verified" in result
      && result.verified === true
    );
  }

  async authorize(
    channel: HostAttestedMcpChannel,
    input: {
      method: "POST";
      path: string;
      bodyHash: string;
      timestamp: string;
      transportNonce: string;
    },
  ): Promise<StagePassSubmitAuthorization> {
    assertHostAttestedMcpChannel(channel);
    return this.request(
      "authorize_submit",
      { channel: this.channelClaim(channel), input },
    ) as Promise<StagePassSubmitAuthorization>;
  }

  async presentInteraction(
    channel: HostAttestedMcpChannel,
    interactionId: string,
  ): Promise<{
    envelope: PublicInteractionEnvelope;
    privateInvocationNonce: string;
  }> {
    assertHostAttestedMcpChannel(channel);
    return this.request("present_interaction", {
      channel: this.channelClaim(channel),
      interactionId,
    }) as Promise<{
      envelope: PublicInteractionEnvelope;
      privateInvocationNonce: string;
    }>;
  }

  async continueInteraction(
    channel: HostAttestedMcpChannel,
    input: { interactionId: string; commandId: string },
  ): Promise<Record<string, unknown>> {
    assertHostAttestedMcpChannel(channel);
    return this.request("continue_interaction", {
      channel: this.channelClaim(channel),
      input,
    }) as Promise<Record<string, unknown>>;
  }

  private channelClaim(channel: HostAttestedMcpChannel) {
    return {
      channelId: channel.channelId,
      sourceThreadId: channel.sourceThreadId,
      hostFingerprint: channel.hostFingerprint,
    };
  }

  private request(operation: string, payload: unknown): Promise<unknown> {
    const id = randomUUID();
    const line = `${JSON.stringify({ id, operation, payload })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("protected_broker_timeout"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(line, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(new Error("protected_broker_unavailable"));
      });
    });
  }
}

function parseLaunchEvidence(value: string | undefined): McpHostLaunchEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? "");
  } catch {
    throw new McpHostAttestationError();
  }
  if (!parsed || typeof parsed !== "object") {
    throw new McpHostAttestationError();
  }
  const record = parsed as Record<string, unknown>;
  return {
    hostPid: record.hostPid as number,
    hostBundleIdentifier: record.hostBundleIdentifier as "com.openai.codex",
    hostTeamIdentifier: record.hostTeamIdentifier as "2DC432GLL2",
    sourceThreadId: record.sourceThreadId as string,
    mcpBundleDigest: record.mcpBundleDigest as string,
    launchRecordId: record.launchRecordId as string,
  };
}

export async function startStagePassMcpSupervisor(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const fd = Number(environment.STAGEPASS_MCP_BROKER_FD);
  const broker = new FdStagePassProtectedBroker(fd);
  const evidence = parseLaunchEvidence(
    environment.STAGEPASS_MCP_HOST_EVIDENCE_JSON,
  );
  const channel = await createHostAttestedMcpChannel(evidence, {
    verify: (candidate) => broker.verifyLaunchEvidence(candidate),
  });
  const { StagePassApiClient } = await import("./stagepass-api-client");
  const { createStagePassMcpServer } = await import("./server");
  const apiClient = new StagePassApiClient(
    environment.STAGEPASS_API_BASE_URL ?? "",
  );
  const server = createStagePassMcpServer({ channel, broker, apiClient });
  await server.connect(new StdioServerTransport());
}

const invokedPath = path.resolve(process.argv[1] ?? "");
const currentPath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === currentPath) {
  void startStagePassMcpSupervisor().catch((error: unknown) => {
    const code = error instanceof Error
      ? brokerErrorCode(error.message)
      : "mcp_supervisor_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
