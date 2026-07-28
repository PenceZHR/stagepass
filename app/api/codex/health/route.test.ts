import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CodexNativeFlags } from "../../../../server/config/codex-native-flags";
import { handleCodexHealth } from "./route";

function flags(patch: Partial<CodexNativeFlags> = {}): CodexNativeFlags {
  return {
    desktopBridge: true,
    mcpInteractions: true,
    codexDecisionSurfaceMaster: true,
    codexDecisionPhases: ["Intake"],
    codexDecisionRolloutError: null,
    ...patch,
  };
}

describe("Codex health route", () => {
  it("returns structured ready health without sensitive paths", async () => {
    const response = await handleCodexHealth({
      flags: flags(),
      probe: async () => ({
        appServerVersion: "0.146",
        appServerProtocolFingerprint: "app-fingerprint",
        desktopClientVersion: "desktop",
        desktopFollowerProtocolFingerprint: "follower-fingerprint",
        shellCapabilities: [],
        followerCapabilities: [],
        shellProtocolCapabilities: ["thread/list"],
        followerProtocolCapabilities: ["deep-link:codex-thread"],
      }),
      hostEvidence: {
        status: "passed",
        verifiedBy: "real-mcp-fixture",
        hostFingerprint: "host-fingerprint",
        verifiedAt: "2026-07-24T00:00:00.000Z",
      },
      now: () => Date.parse("2026-07-24T00:00:00.000Z"),
    });
    const json = await response.json() as Record<string, unknown>;
    assert.equal(json.status, "ready");
    assert.doesNotMatch(JSON.stringify(json), /\/Users\/|socket|stderr/i);
  });

  it("reports the working Codex App bridge as ready when process-local MCP evidence is missing", async () => {
    const response = await handleCodexHealth({
      flags: flags(),
      probe: async () => ({
        appServerVersion: "0.146",
        appServerProtocolFingerprint: "app-fingerprint",
        desktopClientVersion: "desktop",
        desktopFollowerProtocolFingerprint: "follower-fingerprint",
        shellCapabilities: [],
        followerCapabilities: [],
        shellProtocolCapabilities: ["thread/list"],
        followerProtocolCapabilities: ["deep-link:codex-thread"],
      }),
      hostEvidence: {
        status: "missing",
        verifiedBy: null,
        hostFingerprint: null,
        verifiedAt: null,
      },
      now: () => Date.parse("2026-07-26T00:00:00.000Z"),
    });
    const json = await response.json() as {
      status: string;
      mcpHostEvidence: { status: string };
    };

    assert.equal(json.status, "ready");
    assert.equal(json.mcpHostEvidence.status, "missing");
  });

  it("reports disabled and invalid rollout without probing", async () => {
    let probes = 0;
    const response = await handleCodexHealth({
      flags: flags({
        desktopBridge: false,
        codexDecisionSurfaceMaster: false,
        codexDecisionPhases: [],
        codexDecisionRolloutError: "codex_decision_rollout_invalid",
      }),
      probe: async () => {
        probes += 1;
        throw new Error("unexpected");
      },
      hostEvidence: {
        status: "missing",
        verifiedBy: null,
        hostFingerprint: null,
        verifiedAt: null,
      },
      now: Date.now,
    });
    const json = await response.json() as {
      status: string;
      decisionRollout: { errorCode: string };
    };
    assert.equal(json.status, "disabled");
    assert.equal(
      json.decisionRollout.errorCode,
      "codex_decision_rollout_invalid",
    );
    assert.equal(probes, 0);
  });
});
