import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertHostAttestedMcpChannel,
  createHostAttestedMcpChannel,
  McpHostAttestationError,
} from "./supervisor";

describe("StagePass MCP supervisor", () => {
  it("fails closed without verified Host launch evidence", async () => {
    await assert.rejects(
      () => createHostAttestedMcpChannel({
        hostPid: 42,
        hostBundleIdentifier: "com.openai.codex",
        hostTeamIdentifier: "2DC432GLL2",
        sourceThreadId: "THREAD-1",
        mcpBundleDigest: "a".repeat(64),
        launchRecordId: "launch-1",
      }, { verify: async () => false }),
      (error: unknown) => error instanceof McpHostAttestationError,
    );
    assert.throws(
      () => assertHostAttestedMcpChannel({} as never),
      (error: unknown) => error instanceof McpHostAttestationError,
    );
  });
});
