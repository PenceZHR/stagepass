import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CodexDecisionInteractionKind, CodexDecisionPhase } from "@/server/config/codex-decision-rollout";
import type { PipelineCommand } from "@/server/services/pipeline-command-types";
import {
  handlePublicPipelineCommand,
  type PublicPipelineCommandRouteDependencies,
} from "./route";

function request(
  patch: Record<string, unknown> = {},
): Request {
  return new Request("http://stagepass.test/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actionId: "approve_spec",
      expectedGateVersion: "7",
      expectedSourceDbHash: "db-7",
      expectedHeadSha: null,
      idempotencyKey: "idem-1",
      payload: {},
      ...patch,
    }),
  });
}

function dependencies(options: {
  status?: string;
  enabled?: (
    phase: CodexDecisionPhase,
    kind: CodexDecisionInteractionKind,
  ) => boolean;
  commands?: PipelineCommand[];
} = {}): PublicPipelineCommandRouteDependencies {
  return {
    guard: async () => ({
      change: {
        id: "CHG-1",
        projectId: "PRJ-1",
        status: options.status ?? "SPEC_READY",
      } as never,
    }),
    commandId: () => "CMD-route-1",
    decisionSurfaceEnabled: options.enabled ?? (() => false),
    orchestrate: async (input) => {
      options.commands?.push(input.command);
      return {
        commandId: input.command.commandId,
        status: "completed",
        changeStatus: "NEXT",
        gateVersion: input.command.expectedGateVersion,
        sourceDbHash: input.command.expectedSourceDbHash,
        sourceHeadSha: input.command.expectedHeadSha,
        interactionId: null,
        humanDecisionId: "DEC-1",
        enqueuedJobId: null,
        enqueued: [],
      };
    },
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("public pipeline command route", () => {
  it("does not accept a forged actor or request hash", async () => {
    for (const forged of [
      { actor: { kind: "system", surface: "stagepass_web_ops" } },
      { requestHash: "forged" },
    ]) {
      const response = await handlePublicPipelineCommand(
        request(forged),
        { id: "PRJ-1", changeId: "CHG-1" },
        dependencies(),
      );
      assert.equal(response.status, 422);
      assert.equal((await json(response)).error, "invalid_pipeline_command");
    }
  });

  it("requires an explicit expected HEAD, including null", async () => {
    const body = {
      actionId: "approve_spec",
      expectedGateVersion: "7",
      expectedSourceDbHash: "db-7",
      idempotencyKey: "idem-1",
      payload: {},
    };
    const response = await handlePublicPipelineCommand(
      new Request("http://stagepass.test/commands", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { id: "PRJ-1", changeId: "CHG-1" },
      dependencies(),
    );
    assert.equal(response.status, 422);
  });

  it("server-classifies operations and cannot forge approve_merge as ops", async () => {
    const commands: PipelineCommand[] = [];
    const operational = await handlePublicPipelineCommand(
      request({ actionId: "run_spec" }),
      { id: "PRJ-1", changeId: "CHG-1" },
      dependencies({ commands }),
    );
    assert.equal(operational.status, 200);
    assert.deepEqual(commands[0]?.actor, {
      kind: "system",
      surface: "stagepass_web_ops",
    });

    const mergeCommands: PipelineCommand[] = [];
    const merge = await handlePublicPipelineCommand(
      request({ actionId: "approve_merge" }),
      { id: "PRJ-1", changeId: "CHG-1" },
      dependencies({ status: "MERGE_READY", commands: mergeCommands }),
    );
    assert.equal(merge.status, 403);
    assert.equal((await json(merge)).error, "actor_surface_forbidden");
    assert.equal(mergeCommands.length, 0);
  });

  it("does not create legacy Web decisions for enabled or disabled phases", async () => {
    const enabled = (phase: CodexDecisionPhase) => phase === "Intake";
    const intake = await handlePublicPipelineCommand(
      request({ actionId: "approve_intake" }),
      { id: "PRJ-1", changeId: "CHG-1" },
      dependencies({ status: "INTAKE_READY", enabled }),
    );
    assert.equal(intake.status, 403);
    assert.equal((await json(intake)).error, "actor_surface_forbidden");

    const spec = await handlePublicPipelineCommand(
      request({ actionId: "approve_spec" }),
      { id: "PRJ-1", changeId: "CHG-1" },
      dependencies({ enabled }),
    );
    assert.equal(spec.status, 403);
    assert.equal((await json(spec)).error, "actor_surface_forbidden");
  });

  it("fails closed for an unknown kind and after a phase is enabled", async () => {
    const unknown = await handlePublicPipelineCommand(
      request({ actionId: "invented_action" }),
      { id: "PRJ-1", changeId: "CHG-1" },
      dependencies(),
    );
    assert.equal(unknown.status, 422);
    assert.equal((await json(unknown)).error, "unknown_action_kind");

    const enabled = await handlePublicPipelineCommand(
      request({ actionId: "approve_spec" }),
      { id: "PRJ-1", changeId: "CHG-1" },
      dependencies({ enabled: () => true }),
    );
    assert.equal(enabled.status, 403);
    assert.equal((await json(enabled)).error, "actor_surface_forbidden");
  });
});
