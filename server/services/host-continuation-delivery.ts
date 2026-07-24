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

export async function deliverHostContinuation(
  input: PersistedHostContinuation,
  client: HostUiMessageClient | null = hostClient,
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
