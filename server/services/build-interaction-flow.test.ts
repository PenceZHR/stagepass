import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PipelineActionContract } from "./action-contract-types";
import {
  projectBuildInteraction,
  type BuildInteractionFactProjection,
} from "./human-interaction-broker";
import {
  canonicalPipelineCommandRequestHash,
  createPipelineCommandGateway,
  parseBuildDecisionPayload,
  type PipelineCommandGatewayDependencies,
} from "./pipeline-command-gateway";
import {
  PipelineCommandError,
  type PipelineCommand,
} from "./pipeline-command-types";

const facts = (
  patch: Partial<BuildInteractionFactProjection> = {},
): BuildInteractionFactProjection => ({
  buildRunId: "build-3",
  purpose: "build",
  baseCommit: "base-3",
  sourceHeadSha: "base-3",
  patchHash: "patch-3",
  changedFilesHash: "files-3",
  changedFiles: ["src/a.ts"],
  deviations: [],
  blockers: [],
  warnings: [],
  diffReference: ".ship/changes/CHG-1/build/runs/build-3.diff",
  ...patch,
});

describe("Build/Fix Codex interaction flow", () => {
  it("projects bounded evidence without inlining the diff", () => {
    const interaction = projectBuildInteraction({
      changeId: "CHG-1",
      phase: "Build",
      title: "Adopt Build",
      summary: "Review the current Build output",
      contract: { gateVersion: "7", sourceDbHash: "db-7" },
      facts: facts({
        changedFiles: Array.from({ length: 140 }, (_, index) => `src/${index}.ts`),
      }),
    });

    assert.deepEqual(interaction.actionIds, ["adopt_build", "reject_build"]);
    assert.equal(interaction.kind, "build_adoption");
    assert.equal(interaction.payload?.buildRunId, "build-3");
    assert.equal(
      (interaction.payload?.changedFiles as string[]).length,
      100,
    );
    assert.equal(
      interaction.payload?.diffReference,
      ".ship/changes/CHG-1/build/runs/build-3.diff",
    );
    assert.equal("diff" in (interaction.payload ?? {}), false);
  });

  it("requires the exact run and patch identity shown in the card", () => {
    assert.throws(
      () => parseBuildDecisionPayload("adopt_build", {
        buildRunId: "build-4",
        patchHash: "patch-4",
        changedFilesHash: "files-4",
        confirmation: false,
      }),
      (error: unknown) =>
        error instanceof PipelineCommandError
        && error.code === "invalid_pipeline_command",
    );
  });

  it("re-reads identity after recording the human decision and before adoption", async () => {
    const order: string[] = [];
    const action: PipelineActionContract = {
      actionId: "adopt_build",
      phase: "Build",
      label: "Adopt",
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
    };
    const command: PipelineCommand = {
      commandId: "CMD-1",
      projectId: "PRJ-1",
      changeId: "CHG-1",
      actionId: "adopt_build",
      expectedGateVersion: "7",
      expectedSourceDbHash: "db-7",
      expectedHeadSha: "base-3",
      idempotencyKey: "idem-1",
      requestHash: "",
      actor: { kind: "human", surface: "stagepass_web_emergency" },
      payload: {
        buildRunId: "build-3",
        patchHash: "patch-3",
        changedFilesHash: "files-3",
        confirmation: true,
      },
    };
    command.requestHash = canonicalPipelineCommandRequestHash(command);
    const dependencies = {
      repository: {
        readReceiptByIdempotency: () => undefined,
        findChange: () => ({ id: "CHG-1", projectId: "PRJ-1" }),
        findInteraction: () => undefined,
      },
      unitOfWork: {
        claim: () => undefined,
        complete: async (
          value: PipelineCommand,
          input: {
            mutate: (context: {
              tx: never;
              decisionId: string | null;
            }) => unknown;
          },
        ) => {
          order.push("human_decision");
          input.mutate({ tx: {} as never, decisionId: "DEC-CMD-1" });
          return {
            commandId: value.commandId,
            status: "completed" as const,
            changeStatus: "IMPLEMENTED",
            gateVersion: "7",
            sourceDbHash: "db-7",
            sourceHeadSha: "base-3",
            interactionId: null,
            humanDecisionId: "DEC-CMD-1",
            enqueuedJobId: null,
          };
        },
      },
      requireAction: () => action,
      assertFreshAction: async () => action,
      isDecisionSurfaceEnabled: () => true,
      prepareBuildCommand: () => {
        order.push("identity_reread");
      },
      handlers: new Map([
        [
          "adopt_build",
          () => {
            order.push("adopt");
            return {
              changeStatus: "IMPLEMENTED",
              humanDecisionId: "DEC-CMD-1",
            };
          },
        ],
      ]),
    } as unknown as PipelineCommandGatewayDependencies;

    await createPipelineCommandGateway(dependencies).execute(command);
    assert.deepEqual(order, ["human_decision", "identity_reread", "adopt"]);
  });

  it("rejects a card when the latest Build identity has drifted", async () => {
    const action = {
      actionId: "adopt_build",
      phase: "Build",
      gateVersion: "7",
      sourceDbHash: "db-7",
    } as PipelineActionContract;
    const command: PipelineCommand = {
      commandId: "CMD-2",
      projectId: "PRJ-1",
      changeId: "CHG-1",
      actionId: "adopt_build",
      expectedGateVersion: "7",
      expectedSourceDbHash: "db-7",
      expectedHeadSha: "base-3",
      idempotencyKey: "idem-2",
      requestHash: "",
      actor: { kind: "human", surface: "stagepass_web_emergency" },
      payload: {
        buildRunId: "build-3",
        patchHash: "patch-3",
        changedFilesHash: "files-3",
        confirmation: true,
      },
    };
    command.requestHash = canonicalPipelineCommandRequestHash(command);
    const dependencies = {
      repository: {
        readReceiptByIdempotency: () => undefined,
        findChange: () => ({ id: "CHG-1", projectId: "PRJ-1" }),
        findInteraction: () => undefined,
      },
      unitOfWork: {
        claim: () => undefined,
        complete: async (
          _value: PipelineCommand,
          input: { mutate: (context: { tx: never; decisionId: string }) => unknown },
        ) => input.mutate({ tx: {} as never, decisionId: "DEC-CMD-2" }),
      },
      requireAction: () => action,
      assertFreshAction: async () => action,
      isDecisionSurfaceEnabled: () => true,
      prepareBuildCommand: () => {
        throw new PipelineCommandError("build_identity_drift");
      },
      handlers: new Map([["adopt_build", () => ({ changeStatus: "IMPLEMENTED" })]]),
    } as unknown as PipelineCommandGatewayDependencies;

    await assert.rejects(
      createPipelineCommandGateway(dependencies).execute(command),
      (error: unknown) =>
        error instanceof PipelineCommandError
        && error.code === "build_identity_drift",
    );
  });
});
