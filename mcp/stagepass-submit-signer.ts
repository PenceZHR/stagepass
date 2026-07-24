import { randomBytes } from "node:crypto";

import type { HostAttestedMcpChannel } from "./supervisor";
import {
  canonicalMcpBodyHash,
} from "../server/services/mcp-submit-auth-service";

export interface StagePassSubmitSigningBroker {
  authorize(
    channel: HostAttestedMcpChannel,
    input: {
      method: "POST";
      path: string;
      bodyHash: string;
      timestamp: string;
      transportNonce: string;
    },
  ): Promise<{
    authorization: string;
    "x-stagepass-mcp-source-thread": string;
    "x-stagepass-mcp-timestamp": string;
    "x-stagepass-mcp-transport-nonce": string;
  }> | {
    authorization: string;
    "x-stagepass-mcp-source-thread": string;
    "x-stagepass-mcp-timestamp": string;
    "x-stagepass-mcp-transport-nonce": string;
  };
}

export function signStagePassSubmit(
  broker: StagePassSubmitSigningBroker,
  channel: HostAttestedMcpChannel,
  input: { path: string; body: unknown; now?: Date },
) {
  return broker.authorize(channel, {
    method: "POST",
    path: input.path,
    bodyHash: canonicalMcpBodyHash(input.body),
    timestamp: (input.now ?? new Date()).toISOString(),
    transportNonce: randomBytes(24).toString("base64url"),
  });
}
