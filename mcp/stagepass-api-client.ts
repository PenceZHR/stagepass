import type {
  PublicInteractionEnvelope,
} from "../server/services/mcp-presentation-auth-service";
import type {
  OrchestratedPipelineCommandResult,
} from "../server/services/pipeline-command-orchestration";
import type { CodexInteractionStatus } from "../server/types/enums";

export interface SubmitInteractionInput {
  actionId: string;
  expectedGateVersion: string;
  expectedSourceDbHash: string;
  expectedHeadSha: string | null;
  idempotencyKey: string;
  invocationNonce: string;
  formValues: Record<string, unknown>;
}

export type SubmitInteractionResult = OrchestratedPipelineCommandResult;

export interface StagePassSubmitAuthorization {
  authorization: string;
  "x-stagepass-mcp-source-thread": string;
  "x-stagepass-mcp-timestamp": string;
  "x-stagepass-mcp-transport-nonce": string;
}

export class StagePassApiError extends Error {
  constructor(
    readonly code:
      | "stagepass_api_invalid_base_url"
      | "stagepass_api_timeout"
      | "stagepass_api_unavailable"
      | "stagepass_api_rejected"
      | "stagepass_api_invalid_response",
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = "StagePassApiError";
  }
}

export interface StagePassApiClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function requireLoopbackBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new StagePassApiError("stagepass_api_invalid_base_url");
  }
  if (
    parsed.protocol !== "http:"
    || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")
    || !parsed.port
    || parsed.username
    || parsed.password
    || (parsed.pathname !== "/" && parsed.pathname !== "")
    || parsed.search
    || parsed.hash
  ) {
    throw new StagePassApiError("stagepass_api_invalid_base_url");
  }
  return parsed;
}

function interactionPath(id: string, suffix = ""): string {
  if (!id.trim()) throw new StagePassApiError("stagepass_api_rejected");
  return `/api/interactions/${encodeURIComponent(id)}${suffix}`;
}

function sanitizedStatusCode(value: unknown): StagePassApiError["code"] {
  if (
    value
    && typeof value === "object"
    && "error" in value
    && typeof value.error === "string"
    && /^[a-z][a-z0-9_]{0,79}$/.test(value.error)
  ) {
    return "stagepass_api_rejected";
  }
  return "stagepass_api_rejected";
}

export class StagePassApiClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, options: StagePassApiClientOptions = {}) {
    this.baseUrl = requireLoopbackBaseUrl(baseUrl);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new StagePassApiError("stagepass_api_rejected");
    }
  }

  async getInteraction(id: string): Promise<PublicInteractionEnvelope> {
    return this.request(interactionPath(id), { method: "GET" });
  }

  async submitInteraction(
    id: string,
    input: SubmitInteractionInput,
    authorization: StagePassSubmitAuthorization,
  ): Promise<SubmitInteractionResult> {
    return this.request(interactionPath(id, "/submit"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authorization,
      },
      body: JSON.stringify(input),
    });
  }

  async getInteractionStatus(
    id: string,
  ): Promise<{ status: CodexInteractionStatus }> {
    const interaction = await this.getInteraction(id);
    return { status: interaction.status };
  }

  private async request<T>(pathname: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        new URL(pathname, this.baseUrl),
        { ...init, signal: controller.signal },
      );
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new StagePassApiError(
          "stagepass_api_invalid_response",
          response.status,
        );
      }
      if (!response.ok) {
        throw new StagePassApiError(
          sanitizedStatusCode(payload),
          response.status,
        );
      }
      if (!payload || typeof payload !== "object") {
        throw new StagePassApiError(
          "stagepass_api_invalid_response",
          response.status,
        );
      }
      return payload as T;
    } catch (error) {
      if (error instanceof StagePassApiError) throw error;
      if (
        error instanceof DOMException && error.name === "AbortError"
      ) {
        throw new StagePassApiError("stagepass_api_timeout");
      }
      throw new StagePassApiError("stagepass_api_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}
