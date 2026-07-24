import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  callSubmitTool,
  createStagePassMcpServer,
  type StagePassMcpServerOptions,
  type StagePassProtectedBroker,
} from "./server";
import { StagePassApiClient } from "./stagepass-api-client";
import {
  createHostAttestedMcpChannel,
  type HostAttestedMcpChannel,
} from "./supervisor";
import {
  PRESENT_TOOL_META,
  STAGEPASS_INTERACTION_RESOURCE_URI,
  SUBMIT_TOOL_META,
} from "./tool-metadata";
import type {
  PublicInteractionEnvelope,
} from "../server/services/mcp-presentation-auth-service";
import {
  McpSubmitAuthService,
} from "../server/services/mcp-submit-auth-service";

const THREAD_ID = "THREAD-9";
const NOW = "2026-07-24T00:00:00.000Z";

function envelope(
  codexThreadId = THREAD_ID,
): PublicInteractionEnvelope {
  return {
    schemaVersion: "stagepass.interaction/v1",
    id: "INT-9",
    changeId: "CHG-9",
    projectId: "PRJ-9",
    codexThreadId,
    phase: "Intake",
    kind: "gate_decision",
    title: "Decision",
    summary: "Choose",
    actionIds: ["reject_intake"],
    gateVersion: "9",
    sourceDbHash: "db-9",
    payload: {},
    form: { fields: [] },
    status: "presented",
    expectedHeadSha: null,
    presentedAt: NOW,
    completedAt: null,
    expiresAt: "2026-07-25T00:00:00.000Z",
    supersededById: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function channel(sourceThreadId = THREAD_ID) {
  return createHostAttestedMcpChannel({
    hostPid: 42,
    hostBundleIdentifier: "com.openai.codex",
    hostTeamIdentifier: "2DC432GLL2",
    sourceThreadId,
    mcpBundleDigest: "a".repeat(64),
    launchRecordId: `launch-${sourceThreadId}`,
  }, { verify: async () => true });
}

function options(
  hostChannel: HostAttestedMcpChannel,
): StagePassMcpServerOptions {
  const auth = new McpSubmitAuthService();
  const broker: StagePassProtectedBroker = {
    health: "ready",
    authorize: (claim, input) => auth.authorize(claim, input),
    presentInteraction: async () => ({
      envelope: envelope(hostChannel.sourceThreadId),
      privateInvocationNonce: "n".repeat(43),
    }),
    continueInteraction: async (_claim, input) => ({
      status: "dispatched",
      ...input,
    }),
  };
  const apiClient = new StagePassApiClient("http://127.0.0.1:3210", {
    fetchImpl: async (_url, init) => {
      if (init?.method === "POST") {
        return Response.json({
          commandId: "CMD-9",
          status: "completed",
          changeStatus: "BLOCKED",
          gateVersion: "9",
          sourceDbHash: "db-9",
          sourceHeadSha: null,
          interactionId: "INT-9",
          humanDecisionId: "DEC-9",
          enqueuedJobId: null,
          enqueued: [],
        });
      }
      return Response.json(envelope(hostChannel.sourceThreadId));
    },
  });
  return { channel: hostChannel, broker, apiClient };
}

function submission() {
  return {
    interactionId: "INT-9",
    actionId: "reject_intake",
    expectedGateVersion: "9",
    expectedSourceDbHash: "db-9",
    expectedHeadSha: null,
    idempotencyKey: "idem-9",
    invocationNonce: "n".repeat(43),
    formValues: { reason: "not ready", evidenceIds: ["EV-9"] },
  };
}

function meta(
  caller: "model" | "app",
  sourceThreadId = THREAD_ID,
) {
  return {
    "stagepass/caller": caller,
    "stagepass/source-thread-attestation": sourceThreadId,
  };
}

describe("StagePass MCP server", () => {
  it("registers exactly four tools and one UI resource with pinned visibility", async () => {
    const server = createStagePassMcpServer(options(await channel()));
    const client = new Client(
      { name: "task9-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const [{ tools }, { resources }] = await Promise.all([
      client.listTools(),
      client.listResources(),
    ]);

    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "continue_stagepass_interaction",
      "get_stagepass_interaction_status",
      "present_stagepass_interaction",
      "submit_stagepass_interaction",
    ]);
    assert.deepEqual(resources.map((resource) => resource.uri), [
      STAGEPASS_INTERACTION_RESOURCE_URI,
    ]);
    assert.deepEqual(
      tools.find((tool) => tool.name === "submit_stagepass_interaction")
        ?._meta?.ui,
      SUBMIT_TOOL_META.ui,
    );
    assert.equal(
      tools.find((tool) => tool.name === "submit_stagepass_interaction")
        ?._meta?.["openai/visibility"],
      "private",
    );
    assert.deepEqual(
      tools.find((tool) => tool.name === "present_stagepass_interaction")
        ?._meta?.ui,
      PRESENT_TOOL_META.ui,
    );
    assert.equal(
      tools.find((tool) => tool.name === "present_stagepass_interaction")
        ?._meta?.["openai/widgetAccessible"],
      true,
    );
  });

  it("rejects model submit and a valid source nonce from the wrong task", async () => {
    const configured = options(await channel());
    await assert.rejects(
      callSubmitTool(
        submission(),
        { invocationSurface: "model", sourceThreadId: THREAD_ID },
        configured,
      ),
      (error: unknown) => (
        error instanceof Error && error.message === "app_invocation_required"
      ),
    );
    await assert.rejects(
      callSubmitTool(
        submission(),
        { invocationSurface: "app", sourceThreadId: "THREAD-OTHER" },
        configured,
      ),
      (error: unknown) => (
        error instanceof Error && error.message === "source_thread_mismatch"
      ),
    );
  });

  it("keeps the invocation nonce only in private result metadata", async () => {
    const server = createStagePassMcpServer(options(await channel()));
    const client = new Client(
      { name: "task9-nonce-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const result = await client.callTool({
      name: "present_stagepass_interaction",
      arguments: { interactionId: "INT-9" },
      _meta: meta("model"),
    });
    const nonce = (
      result._meta?.stagepass as { invocationNonce?: string } | undefined
    )?.invocationNonce;
    assert.equal(nonce, "n".repeat(43));
    assert.equal(JSON.stringify({
      content: result.content,
      structuredContent: result.structuredContent,
    }).includes(nonce!), false);
  });
});
