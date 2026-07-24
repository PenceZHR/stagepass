import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PipelineActionContract } from "./action-contract-types";
import { canonicalPipelineCommandRequestHash } from "./pipeline-command-gateway";
import {
  orchestrateAfterCommand,
  type OrchestrateAfterCommandInput,
} from "./pipeline-command-orchestration";
import type {
  PipelineCommand,
  PipelineCommandResult,
} from "./pipeline-command-types";

function fixture(
  actionId: string,
  patch: Partial<OrchestrateAfterCommandInput> = {},
): OrchestrateAfterCommandInput & {
  refreshed: string[];
  enqueues: Array<{ actionId: string; contractActionId: string }>;
} {
  const command: PipelineCommand = {
    commandId: "CMD-1",
    projectId: "PRJ-1",
    changeId: "CHG-1",
    actionId,
    expectedGateVersion: "7",
    expectedSourceDbHash: "db-7",
    expectedHeadSha: null,
    idempotencyKey: "idem-1",
    requestHash: "",
    actor: { kind: "human", surface: "stagepass_web_emergency" },
    payload: {},
  };
  command.requestHash = canonicalPipelineCommandRequestHash(command);
  const refreshed: string[] = [];
  const enqueues: Array<{ actionId: string; contractActionId: string }> = [];
  const result: PipelineCommandResult = {
    commandId: command.commandId,
    status: "completed",
    changeStatus: "NEXT",
    gateVersion: "8",
    sourceDbHash: "db-8",
    sourceHeadSha: null,
    interactionId: null,
    humanDecisionId: "DEC-1",
    enqueuedJobId: null,
  };
  return {
    command,
    previousStatus: "INTAKE_READY",
    execute: async () => result,
    refreshAction: (_changeId, nextActionId) => {
      refreshed.push(nextActionId);
      return {
        actionId: nextActionId,
        phase: "Spec",
        label: nextActionId,
        enabled: true,
        reasonCode: null,
        reason: null,
        blockers: [],
        warnings: [],
        gateVersion: "8",
        sourceDbHash: "db-8",
        requiresIdempotencyKey: true,
        requiresProvider: true,
        providerSelectable: true,
        defaultProvider: "codex",
      } satisfies PipelineActionContract;
    },
    enqueue: (input, contract) => {
      enqueues.push({
        actionId: input.actionId,
        contractActionId: contract.actionId,
      });
      return { job: { id: "PJOB-1" } };
    },
    refreshed,
    enqueues,
    ...patch,
  };
}

describe("pipeline command orchestration", () => {
  it("approving intake enqueues Spec from a freshly recomputed contract", async () => {
    const input = fixture("approve_intake");
    const result = await orchestrateAfterCommand(input);
    assert.deepEqual(result.enqueued, [
      { actionId: "run_spec", phase: "spec" },
    ]);
    assert.deepEqual(input.refreshed, ["run_spec"]);
    assert.deepEqual(input.enqueues, [
      { actionId: "run_spec", contractActionId: "run_spec" },
    ]);
  });

  it("approving a test plan enqueues Build exactly once", async () => {
    const input = fixture("approve_plan", {
      previousStatus: "TESTPLAN_DONE",
    });
    const result = await orchestrateAfterCommand(input);
    assert.deepEqual(result.enqueued, [
      { actionId: "run_build", phase: "implement" },
    ]);
    assert.equal(input.enqueues.length, 1);
  });

  it("approving a plan does not skip TestPlan", async () => {
    const input = fixture("approve_plan", {
      previousStatus: "PLAN_READY",
    });
    const result = await orchestrateAfterCommand(input);
    assert.deepEqual(result.enqueued, [
      { actionId: "run_test_plan", phase: "test-plan" },
    ]);
    assert.deepEqual(input.refreshed, ["run_test_plan"]);
    assert.deepEqual(input.enqueues, [
      { actionId: "run_test_plan", contractActionId: "run_test_plan" },
    ]);
  });
});
