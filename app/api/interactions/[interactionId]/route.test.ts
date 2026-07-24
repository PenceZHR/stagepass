import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createHostAttestedMcpChannel,
} from "../../../../mcp/supervisor";
import { signStagePassSubmit } from "../../../../mcp/stagepass-submit-signer";
import {
  McpSubmitAuthService,
} from "../../../../server/services/mcp-submit-auth-service";
import type { PipelineCommand } from "../../../../server/services/pipeline-command-types";
import type { InteractionEnvelope } from "../../../../server/services/interaction-types";
import { handlePublicInteractionGet } from "./route";
import { handlePrivateInteractionSubmit } from "./submit/route";

const NOW = "2026-07-24T00:00:00.000Z";

function interaction(): InteractionEnvelope {
  return {
    schemaVersion: "stagepass.interaction/v1",
    id: "INT-1",
    projectId: "PRJ-1",
    changeId: "CHG-1",
    codexThreadId: "THREAD-1",
    phase: "Intake",
    kind: "gate_decision",
    title: "Decision",
    summary: "Choose",
    actionIds: ["reject_intake"],
    gateVersion: "7",
    sourceDbHash: "db-7",
    payload: {
      authorization: "Bearer private",
      path: "/Users/private/work",
    },
    form: { fields: [] },
    status: "presented",
    idempotencyKey: "internal-idempotency",
    expectedHeadSha: null,
    requestHash: "private-request-hash",
    presentedAt: NOW,
    completedAt: null,
    expiresAt: "2026-07-25T00:00:00.000Z",
    supersededById: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function body(patch: Record<string, unknown> = {}) {
  return {
    actionId: "reject_intake",
    expectedGateVersion: "7",
    expectedSourceDbHash: "db-7",
    expectedHeadSha: null,
    idempotencyKey: "idem-1",
    invocationNonce: "n".repeat(43),
    formValues: { reason: "not ready" },
    ...patch,
  };
}

async function hostChannel(sourceThreadId: string) {
  return createHostAttestedMcpChannel({
    hostPid: 42,
    hostBundleIdentifier: "com.openai.codex",
    hostTeamIdentifier: "2DC432GLL2",
    sourceThreadId,
    mcpBundleDigest: "a".repeat(64),
    launchRecordId: `launch-${sourceThreadId}`,
  }, { verify: async () => true });
}

describe("interaction API", () => {
  it("returns only the redacted public envelope", async () => {
    const response = await handlePublicInteractionGet("INT-1", {
      getInteraction: () => interaction(),
    });
    const json = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.equal("requestHash" in json, false);
    assert.equal("idempotencyKey" in json, false);
    assert.doesNotMatch(JSON.stringify(json), /Bearer |\/Users\//);
  });

  it("rejects unsigned and forged bodies without executing", async () => {
    let executions = 0;
    const auth = new McpSubmitAuthService(() => Date.parse(NOW));
    const dependencies = {
      auth,
      interactionRepository: { getInteraction: () => interaction() },
      readChangeStatus: () => "INTAKE_READY",
      commandId: () => "CMD-1",
      execute: async () => {
        executions += 1;
        throw new Error("unexpected");
      },
    };
    const unsigned = await handlePrivateInteractionSubmit(new Request(
      "http://stagepass.test/api/interactions/INT-1/submit",
      { method: "POST", body: JSON.stringify(body()) },
    ), "INT-1", dependencies);
    assert.equal(unsigned.status, 401);

    const forged = await handlePrivateInteractionSubmit(new Request(
      "http://stagepass.test/api/interactions/INT-1/submit",
      {
        method: "POST",
        body: JSON.stringify(body({
          actor: { kind: "system", surface: "recovery" },
        })),
      },
    ), "INT-1", dependencies);
    assert.equal(forged.status, 422);
    assert.equal(executions, 0);
  });

  it("binds source thread, forces actor, and rejects transport replay", async () => {
    const auth = new McpSubmitAuthService(() => Date.parse(NOW));
    const submitted = body();
    const path = "/api/interactions/INT-1/submit";
    const headers = signStagePassSubmit(auth, await hostChannel("THREAD-1"), {
      path,
      body: submitted,
      now: new Date(NOW),
    });
    const commands: PipelineCommand[] = [];
    const dependencies = {
      auth,
      interactionRepository: { getInteraction: () => interaction() },
      readChangeStatus: () => "INTAKE_READY",
      commandId: () => "CMD-1",
      execute: async (command: PipelineCommand) => {
        commands.push(command);
        return {
          commandId: command.commandId,
          status: "completed" as const,
          changeStatus: "BLOCKED",
          gateVersion: "7",
          sourceDbHash: "db-7",
          sourceHeadSha: null,
          interactionId: "INT-1",
          humanDecisionId: "DEC-1",
          enqueuedJobId: null,
        };
      },
    };
    const request = () => new Request(`http://stagepass.test${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(submitted),
    });
    assert.equal(
      (await handlePrivateInteractionSubmit(request(), "INT-1", dependencies))
        .status,
      200,
    );
    assert.deepEqual(commands[0]?.actor, {
      kind: "human",
      surface: "codex_mcp_app",
      codexThreadId: "THREAD-1",
      interactionId: "INT-1",
    });
    assert.equal(
      (await handlePrivateInteractionSubmit(request(), "INT-1", dependencies))
        .status,
      409,
    );

    const wrongAuth = new McpSubmitAuthService(() => Date.parse(NOW));
    const wrongHeaders = signStagePassSubmit(
      wrongAuth,
      await hostChannel("THREAD-OTHER"),
      { path, body: submitted, now: new Date(NOW) },
    );
    const wrong = await handlePrivateInteractionSubmit(new Request(
      `http://stagepass.test${path}`,
      { method: "POST", headers: wrongHeaders, body: JSON.stringify(submitted) },
    ), "INT-1", { ...dependencies, auth: wrongAuth });
    assert.equal(wrong.status, 403);
    assert.equal(commands.length, 1);
  });
});
