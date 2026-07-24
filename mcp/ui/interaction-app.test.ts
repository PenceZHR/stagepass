import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  canSubmit,
  submitCard,
  type InteractionCardPrivateState,
} from "./interaction-app";

function state(
  required = true,
): InteractionCardPrivateState {
  return {
    invocationNonce: "n".repeat(43),
    envelope: {
      schemaVersion: "stagepass.interaction/v1",
      id: "INT-1",
      changeId: "CHG-1",
      projectId: "PRJ-1",
      codexThreadId: "THREAD-1",
      phase: "Intake",
      kind: "gate_decision",
      title: "Decision",
      summary: "Choose",
      actionIds: ["waive_risk"],
      gateVersion: "1",
      sourceDbHash: "db",
      payload: {},
      form: {
        fields: [{
          id: "reason",
          type: "textarea",
          label: "Reason",
          required,
        }],
      },
      status: "presented",
      expectedHeadSha: null,
      presentedAt: "2026-07-24T00:00:00.000Z",
      completedAt: null,
      expiresAt: "2026-07-25T00:00:00.000Z",
      supersededById: null,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    },
  };
}

function result(structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [], structuredContent };
}

describe("MCP interaction card", () => {
  it("derives required validation and destructive confirmation from schema", () => {
    const envelope = state().envelope;
    assert.equal(canSubmit(envelope, { reason: "" }, "waive_risk"), false);
    assert.equal(
      canSubmit(
        envelope,
        { reason: "accepted", __confirmation: true },
        "waive_risk",
      ),
      true,
    );
  });

  it("never continues when private submit fails", async () => {
    const calls: string[] = [];
    await assert.rejects(() => submitCard({
      async callServerTool(input) {
        calls.push(input.name);
        if (input.name === "get_stagepass_interaction_status") {
          return result({ status: "presented" });
        }
        throw new Error("submit_failed");
      },
    }, state(), {
      actionId: "waive_risk",
      formValues: { reason: "accepted", __confirmation: true },
    }));
    assert.deepEqual(calls, [
      "get_stagepass_interaction_status",
      "submit_stagepass_interaction",
    ]);
  });

  it("submits then privately continues the same interaction", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    await submitCard({
      async callServerTool(input) {
        calls.push(input);
        if (input.name === "get_stagepass_interaction_status") {
          return result({ status: "presented" });
        }
        if (input.name === "submit_stagepass_interaction") {
          return result({ status: "completed", commandId: "CMD-1" });
        }
        return result({ status: "dispatched" });
      },
    }, state(), {
      actionId: "waive_risk",
      formValues: { reason: "accepted", __confirmation: true },
    });
    assert.deepEqual(calls.map((call) => call.name), [
      "get_stagepass_interaction_status",
      "submit_stagepass_interaction",
      "continue_stagepass_interaction",
    ]);
    assert.deepEqual(calls.at(-1)?.arguments, {
      interactionId: "INT-1",
      commandId: "CMD-1",
    });
  });
});
