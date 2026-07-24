import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PipelineActionContract } from "./action-contract-types";
import {
  canonicalPipelineCommandRequestHash,
  createPipelineCommandGateway,
  FIRST_SLICE_PIPELINE_COMMAND_HANDLERS,
  type PipelineCommandGatewayDependencies,
} from "./pipeline-command-gateway";
import {
  PipelineCommandError,
  type PipelineCommand,
  type PipelineCommandResult,
} from "./pipeline-command-types";

const action = (
  patch: Partial<PipelineActionContract> = {},
): PipelineActionContract => ({
  actionId: "approve_intake",
  phase: "PRD",
  label: "Approve",
  enabled: true,
  reasonCode: null,
  reason: null,
  blockers: [],
  warnings: [],
  gateVersion: "7",
  sourceDbHash: "db-7",
  requiresIdempotencyKey: true,
  requiresProvider: false,
  providerSelectable: false,
  defaultProvider: "codex",
  ...patch,
});

function command(
  patch: Partial<PipelineCommand> = {},
): PipelineCommand {
  const base: PipelineCommand = {
    commandId: "CMD-1",
    projectId: "PRJ-1",
    changeId: "CHG-1",
    actionId: "approve_intake",
    expectedGateVersion: "7",
    expectedSourceDbHash: "db-7",
    expectedHeadSha: null,
    idempotencyKey: "idem-1",
    requestHash: "",
    actor: { kind: "human", surface: "stagepass_web_emergency" },
    payload: { confirmation: true },
  };
  const next = { ...base, ...patch };
  next.requestHash =
    patch.requestHash ?? canonicalPipelineCommandRequestHash(next);
  return next;
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof PipelineCommandError && error.code === code;
}

function harness(options: {
  currentAction?: PipelineActionContract;
  enabled?: boolean;
  freshError?: unknown;
  receipt?: {
    commandId: string;
    requestHash: string;
    status: string;
    resultJson: string | null;
  };
} = {}) {
  const handlerCalls: PipelineCommand[] = [];
  let receipt = options.receipt;
  const resultFor = (value: PipelineCommand): PipelineCommandResult => ({
    commandId: value.commandId,
    status: "completed",
    changeStatus: "INTAKE_READY",
    gateVersion: value.expectedGateVersion,
    sourceDbHash: value.expectedSourceDbHash,
    sourceHeadSha: value.expectedHeadSha,
    interactionId: value.actor.interactionId ?? null,
    humanDecisionId: `DEC-${value.commandId}`,
    enqueuedJobId: null,
  });
  const dependencies = {
    repository: {
      readReceiptByIdempotency: () => receipt,
      findChange: () => ({ id: "CHG-1", projectId: "PRJ-1" }),
      findInteraction: () => undefined,
    },
    unitOfWork: {
      claim: (value: PipelineCommand) => {
        receipt = {
          commandId: value.commandId,
          requestHash: value.requestHash,
          status: "accepted",
          resultJson: null,
        };
      },
      complete: async (value: PipelineCommand) => {
        const result = resultFor(value);
        receipt = {
          commandId: value.commandId,
          requestHash: value.requestHash,
          status: "completed",
          resultJson: JSON.stringify(result),
        };
        return result;
      },
    },
    requireAction: () => options.currentAction ?? action(),
    assertFreshAction: async () => {
      if (options.freshError) throw options.freshError;
      return options.currentAction ?? action();
    },
    isDecisionSurfaceEnabled: () => options.enabled ?? false,
    handlers: new Map([
      [
        "approve_intake",
        (value: PipelineCommand) => {
          handlerCalls.push(value);
          return { changeStatus: "INTAKE_READY" };
        },
      ],
    ]),
  } as unknown as PipelineCommandGatewayDependencies;
  return {
    gateway: createPipelineCommandGateway(dependencies),
    handlerCalls,
  };
}

describe("pipeline command gateway", () => {
  it("rejects a stale command before calling the handler", async () => {
    const fixture = harness();
    const stale = command({ expectedGateVersion: "old" });
    stale.requestHash = canonicalPipelineCommandRequestHash(stale);
    await assert.rejects(fixture.gateway.execute(stale), hasCode("gate_version_drift"));
    assert.equal(fixture.handlerCalls.length, 0);
  });

  it("returns the first receipt for a duplicate idempotency key", async () => {
    const fixture = harness();
    const input = command();
    const first = await fixture.gateway.execute(input);
    const second = await fixture.gateway.execute(input);
    assert.equal(second.commandId, first.commandId);
    assert.equal(fixture.handlerCalls.length, 0);
  });

  it("rejects human decisions from a forged model surface", async () => {
    const fixture = harness({ enabled: true });
    const input = command({
      actor: { kind: "human", surface: "codex_model" as never },
    });
    input.requestHash = canonicalPipelineCommandRequestHash(input);
    await assert.rejects(
      fixture.gateway.execute(input),
      hasCode("actor_surface_forbidden"),
    );
  });

  it("rejects request hash drift before claiming a receipt", async () => {
    const fixture = harness();
    await assert.rejects(
      fixture.gateway.execute(command({ requestHash: "wrong-request-hash" })),
      hasCode("command_freshness_drift"),
    );
  });

  it("normalizes source HEAD drift to command freshness drift", async () => {
    const fixture = harness({
      freshError: { envelope: { reasonCode: "git_head_drift" } },
    });
    await assert.rejects(
      fixture.gateway.execute(command({ expectedHeadSha: "old-head" })),
      hasCode("command_freshness_drift"),
    );
  });

  it("rejects duplicate keys bound to a different request hash", async () => {
    const result = {
      commandId: "CMD-old",
      status: "completed",
    } as PipelineCommandResult;
    const fixture = harness({
      receipt: {
        commandId: "CMD-old",
        requestHash: "other",
        status: "completed",
        resultJson: JSON.stringify(result),
      },
    });
    await assert.rejects(
      fixture.gateway.execute(command()),
      hasCode("idempotency_conflict"),
    );
  });

  it("registers exactly the first-slice decision handlers", () => {
    assert.deepEqual(
      [...FIRST_SLICE_PIPELINE_COMMAND_HANDLERS.keys()],
      [
        "answer_prd_question",
        "accept_prd_assumption",
        "defer_prd_question",
        "lock_prd_briefing",
        "approve_intake",
        "reject_intake",
        "approve_spec",
        "reject_spec",
        "approve_tech_spec",
        "reject_tech_spec",
        "request_spec_changes",
        "return_to_spec",
        "waive_spec_p1",
        "waive_plan_p1",
        "reject_plan",
        "reject_test_plan",
        "adopt_build",
        "adopt_fix",
        "reject_build",
        "waive_review_p1",
        "stop_change",
        "record_qa_manual_check",
        "override_merge",
        "request_rework",
        "approve_plan",
        "approve_merge",
        "reject_merge",
      ],
    );
  });
});
