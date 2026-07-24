import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createHostAttestedMcpChannel,
  type HostAttestedMcpChannel,
} from "../../mcp/supervisor";
import { signStagePassSubmit } from "../../mcp/stagepass-submit-signer";
import {
  canonicalMcpBodyHash,
  McpSubmitAuthError,
  McpSubmitAuthService,
} from "./mcp-submit-auth-service";

async function channel(sourceThreadId = "THREAD-1") {
  return createHostAttestedMcpChannel({
    hostPid: 42,
    hostBundleIdentifier: "com.openai.codex",
    hostTeamIdentifier: "2DC432GLL2",
    sourceThreadId,
    mcpBundleDigest: "a".repeat(64),
    launchRecordId: `launch-${sourceThreadId}`,
  }, { verify: async () => true });
}

describe("MCP submit authorization", () => {
  it("rejects ordinary callers and accepts only a Host-attested channel", async () => {
    const service = new McpSubmitAuthService(
      () => Date.parse("2026-07-24T00:00:00.000Z"),
    );
    assert.throws(
      () => service.authorize({} as HostAttestedMcpChannel, {
        method: "POST",
        path: "/api/interactions/INT-1/submit",
        bodyHash: "a".repeat(64),
        timestamp: "2026-07-24T00:00:00.000Z",
        transportNonce: "transport-1",
      }),
      (error: unknown) =>
        error instanceof McpSubmitAuthError
        && error.code === "submit_auth_channel_unavailable",
    );

    const body = { actionId: "reject_intake" };
    const headers = signStagePassSubmit(service, await channel(), {
      path: "/api/interactions/INT-1/submit",
      body,
      now: new Date("2026-07-24T00:00:00.000Z"),
    });
    const request = new Request(
      "http://stagepass.test/api/interactions/INT-1/submit",
      { method: "POST", headers },
    );
    assert.deepEqual(service.verify(
      request,
      "/api/interactions/INT-1/submit",
      canonicalMcpBodyHash(body),
    ), { sourceThreadId: "THREAD-1" });
    assert.throws(
      () => service.verify(
        request,
        "/api/interactions/INT-1/submit",
        canonicalMcpBodyHash(body),
      ),
      (error: unknown) =>
        error instanceof McpSubmitAuthError
        && error.code === "submit_auth_replayed",
    );
  });
});
