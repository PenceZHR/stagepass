export interface PersistedHostContinuation {
  logicalTurnId: string;
  attemptId: string;
  interactionId: string;
  commandId: string;
  sourceThreadId: string;
  correlationMarker: string;
  message: string;
}

export interface HostUiMessageClient {
  sendUiMessage(input: {
    sourceThreadId: string;
    text: string;
    logicalTurnId: string;
    attemptId: string;
  }): Promise<{ turnId: string }>;
}

let hostClient: HostUiMessageClient | null = null;

export function registerHostUiMessageClient(
  client: HostUiMessageClient,
): () => void {
  const previous = hostClient;
  hostClient = client;
  return () => {
    hostClient = previous;
  };
}

export class HostContinuationDeliveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HostContinuationDeliveryError";
  }
}

interface HostContinuationStartAttempt {
  logicalTurnId: string;
  threadId: string;
  state: string;
  normalizedPromptHash: string;
}

export interface CodexDesktopHostUiMessageClientDependencies {
  readForStart?(
    logicalTurnId: string,
  ): Promise<{ request: CodexDesktopTurnRequest }>;
  readAttempt?(attemptId: string): HostContinuationStartAttempt | null;
  startFollowerTurn?(
    request: CodexDesktopTurnRequest,
  ): Promise<
    { status: "started"; turnId: string }
    | { status: "no-client-found" }
  >;
}

async function startProductionFollowerTurn(
  request: CodexDesktopTurnRequest,
): Promise<
  { status: "started"; turnId: string }
  | { status: "no-client-found" }
> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const endpoint = await productionEndpoint();
      return createObservedCodexDesktopFollowerTransport(endpoint)
        .startFollowerTurn(request);
    } catch (error) {
      lastError = error;
      productionEndpointPromise = null;
      if (attempt < 2) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, 250 * (2 ** attempt)));
      }
    }
  }
  throw lastError;
}

let productionEndpointPromise: ReturnType<
  typeof discoverCodexDesktopIpcEndpoint
> | null = null;

function productionEndpoint() {
  productionEndpointPromise ??= discoverCodexDesktopIpcEndpoint(
    defaultCodexDesktopDiscoveryDependencies(),
  );
  void productionEndpointPromise.catch(() => {
    productionEndpointPromise = null;
  });
  return productionEndpointPromise;
}

export function createCodexDesktopHostUiMessageClient(
  dependencies: CodexDesktopHostUiMessageClientDependencies = {},
): HostUiMessageClient {
  const readForStart = dependencies.readForStart
    ?? readLogicalTurnForStart;
  const readAttempt = dependencies.readAttempt
    ?? ((attemptId: string) =>
      db.select().from(codexFollowerStartAttempts)
        .where(eq(codexFollowerStartAttempts.attemptId, attemptId)).get()
      ?? null);
  const startFollowerTurn = dependencies.startFollowerTurn
    ?? startProductionFollowerTurn;
  return {
    async sendUiMessage(input) {
      const [logical, attempt] = await Promise.all([
        readForStart(input.logicalTurnId),
        Promise.resolve(readAttempt(input.attemptId)),
      ]);
      const promptHash = createHash("sha256")
        .update(input.text)
        .digest("hex");
      if (
        logical.request.threadId !== input.sourceThreadId
        || !attempt
        || attempt.logicalTurnId !== input.logicalTurnId
        || attempt.threadId !== input.sourceThreadId
        || attempt.state !== "dispatching"
        || attempt.normalizedPromptHash !== promptHash
      ) {
        throw new HostContinuationDeliveryError(
          "host_continuation_identity_mismatch",
        );
      }
      const started = await startFollowerTurn({
        ...logical.request,
        threadId: input.sourceThreadId,
        prompt: input.text,
      });
      if (started.status !== "started" || !started.turnId.trim()) {
        throw new HostContinuationDeliveryError(
          "host_continuation_no_client",
        );
      }
      return { turnId: started.turnId };
    },
  };
}

const productionHostClient = createCodexDesktopHostUiMessageClient();

export async function deliverHostContinuation(
  input: PersistedHostContinuation,
  client: HostUiMessageClient | null = hostClient ?? productionHostClient,
): Promise<{ turnId: string }> {
  if (
    !client
    || !input.sourceThreadId.trim()
    || !input.message.includes(input.correlationMarker)
    || !input.logicalTurnId.trim()
    || !input.attemptId.trim()
  ) {
    throw new HostContinuationDeliveryError("host_continuation_unavailable");
  }
  const delivered = await client.sendUiMessage({
    sourceThreadId: input.sourceThreadId,
    text: input.message,
    logicalTurnId: input.logicalTurnId,
    attemptId: input.attemptId,
  });
  if (!delivered.turnId?.trim()) {
    throw new HostContinuationDeliveryError("host_continuation_unproved");
  }
  return delivered;
}
import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import { db } from "../db";
import { codexFollowerStartAttempts } from "../db/schema";
import type {
  CodexDesktopTurnRequest,
} from "./codex-desktop-bridge-types";
import {
  defaultCodexDesktopDiscoveryDependencies,
  discoverCodexDesktopIpcEndpoint,
} from "./codex-desktop-ipc-discovery";
import {
  createObservedCodexDesktopFollowerTransport,
} from "./codex-desktop-ipc-transport";
import { readLogicalTurnForStart } from "./codex-logical-turn-service";
