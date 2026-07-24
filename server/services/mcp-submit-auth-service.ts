import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  assertHostAttestedMcpChannel,
  type HostAttestedMcpChannel,
} from "../../mcp/supervisor";

const MAX_CLOCK_SKEW_MS = 30_000;

export interface McpSubmitAuthorizationInput {
  method: "POST";
  path: string;
  bodyHash: string;
  sourceThreadId: string;
  timestamp: string;
  transportNonce: string;
}

export interface McpSubmitAuthorizationHeaders {
  authorization: string;
  "x-stagepass-mcp-source-thread": string;
  "x-stagepass-mcp-timestamp": string;
  "x-stagepass-mcp-transport-nonce": string;
}

export class McpSubmitAuthError extends Error {
  constructor(
    readonly code:
      | "submit_auth_channel_unavailable"
      | "submit_auth_invalid"
      | "submit_auth_expired"
      | "submit_auth_replayed",
    readonly status = 401,
  ) {
    super(code);
    this.name = "McpSubmitAuthError";
  }
}

function canonical(input: McpSubmitAuthorizationInput): string {
  return [
    input.method,
    input.path,
    input.bodyHash,
    input.sourceThreadId,
    input.timestamp,
    input.transportNonce,
  ].join("\n");
}

export function canonicalMcpBodyHash(value: unknown): string {
  const stable = (child: unknown): unknown => {
    if (Array.isArray(child)) return child.map(stable);
    if (child && typeof child === "object") {
      return Object.fromEntries(
        Object.entries(child as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, stable(nested)]),
      );
    }
    return child;
  };
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export class McpSubmitAuthService {
  private readonly secret = randomBytes(32);
  private readonly replayed = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  authorize(
    channel: HostAttestedMcpChannel,
    input: Omit<McpSubmitAuthorizationInput, "sourceThreadId">,
  ): McpSubmitAuthorizationHeaders {
    try {
      assertHostAttestedMcpChannel(channel);
    } catch {
      throw new McpSubmitAuthError("submit_auth_channel_unavailable");
    }
    const authorized: McpSubmitAuthorizationInput = {
      ...input,
      sourceThreadId: channel.sourceThreadId,
    };
    const mac = createHmac("sha256", this.secret)
      .update(canonical(authorized))
      .digest("hex");
    return {
      authorization: `StagePass-MCP ${mac}`,
      "x-stagepass-mcp-source-thread": authorized.sourceThreadId,
      "x-stagepass-mcp-timestamp": authorized.timestamp,
      "x-stagepass-mcp-transport-nonce": authorized.transportNonce,
    };
  }

  verify(
    request: Pick<Request, "method" | "headers">,
    path: string,
    bodyHash: string,
  ): { sourceThreadId: string } {
    const authorization = request.headers.get("authorization");
    const sourceThreadId = request.headers.get("x-stagepass-mcp-source-thread");
    const timestamp = request.headers.get("x-stagepass-mcp-timestamp");
    const transportNonce = request.headers.get("x-stagepass-mcp-transport-nonce");
    if (
      request.method !== "POST"
      || !authorization?.startsWith("StagePass-MCP ")
      || !sourceThreadId?.trim()
      || !timestamp
      || !transportNonce?.trim()
    ) throw new McpSubmitAuthError("submit_auth_invalid");

    const at = Date.parse(timestamp);
    const now = this.now();
    if (!Number.isFinite(at) || Math.abs(now - at) > MAX_CLOCK_SKEW_MS) {
      throw new McpSubmitAuthError("submit_auth_expired");
    }
    for (const [nonce, expiresAt] of this.replayed) {
      if (expiresAt <= now) this.replayed.delete(nonce);
    }
    if (this.replayed.has(transportNonce)) {
      throw new McpSubmitAuthError("submit_auth_replayed", 409);
    }
    const input: McpSubmitAuthorizationInput = {
      method: "POST",
      path,
      bodyHash,
      sourceThreadId,
      timestamp,
      transportNonce,
    };
    const actual = authorization.slice("StagePass-MCP ".length);
    const expected = createHmac("sha256", this.secret)
      .update(canonical(input))
      .digest("hex");
    if (
      actual.length !== expected.length
      || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    ) throw new McpSubmitAuthError("submit_auth_invalid");

    this.replayed.set(transportNonce, now + MAX_CLOCK_SKEW_MS);
    return { sourceThreadId };
  }
}

export const mcpSubmitAuthService = new McpSubmitAuthService();
