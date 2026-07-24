import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { readCodexNativeFlags } from "@/server/config/codex-native-flags";
import {
  isCodexDecisionSurfaceEnabled,
  type CodexDecisionInteractionKind,
  type CodexDecisionPhase,
} from "@/server/config/codex-decision-rollout";
import {
  canonicalPipelineCommandRequestHash,
  classifyWebPipelineCommand,
} from "@/server/services/pipeline-command-gateway";
import { orchestrateAfterCommand } from "@/server/services/pipeline-command-orchestration";
import {
  PipelineCommandError,
  type PipelineCommand,
} from "@/server/services/pipeline-command-types";
import { requireProjectChange } from "../route-guard";

const PUBLIC_PIPELINE_COMMAND_SCHEMA = z
  .object({
    actionId: z.string().min(1),
    expectedGateVersion: z.string().min(1),
    expectedSourceDbHash: z.string().min(1),
    expectedHeadSha: z.string().min(1).nullable(),
    idempotencyKey: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

type RouteGuardResult = Awaited<ReturnType<typeof requireProjectChange>>;

export interface PublicPipelineCommandRouteDependencies {
  guard: (
    projectId: string,
    changeId: string,
  ) => Promise<RouteGuardResult>;
  commandId: () => string;
  decisionSurfaceEnabled: (
    phase: CodexDecisionPhase,
    kind: CodexDecisionInteractionKind,
  ) => boolean;
  orchestrate: typeof orchestrateAfterCommand;
}
function defaultDependencies(): PublicPipelineCommandRouteDependencies {
  const flags = readCodexNativeFlags();
  return {
    guard: requireProjectChange,
    commandId: () => `CMD-${randomUUID()}`,
    decisionSurfaceEnabled: (phase, kind) =>
      isCodexDecisionSurfaceEnabled({ phase, kind }, flags),
    orchestrate: orchestrateAfterCommand,
  };
}

export async function handlePublicPipelineCommand(
  request: Request,
  params: { id: string; changeId: string },
  dependencies: PublicPipelineCommandRouteDependencies = defaultDependencies(),
): Promise<NextResponse> {
  try {
    const guard = await dependencies.guard(params.id, params.changeId);
    if (guard.response) return guard.response;
    const body = PUBLIC_PIPELINE_COMMAND_SCHEMA.parse(await request.json());
    const classification = classifyWebPipelineCommand(
      body.actionId,
      guard.change.status,
      (phase, kind) => dependencies.decisionSurfaceEnabled(phase, kind),
    );
    const command: PipelineCommand = {
      commandId: dependencies.commandId(),
      projectId: params.id,
      changeId: params.changeId,
      actionId: body.actionId,
      expectedGateVersion: body.expectedGateVersion,
      expectedSourceDbHash: body.expectedSourceDbHash,
      expectedHeadSha: body.expectedHeadSha,
      idempotencyKey: body.idempotencyKey,
      requestHash: "",
      actor: {
        kind: classification.kind,
        surface: classification.surface,
      },
      payload: body.payload,
    };
    command.requestHash = canonicalPipelineCommandRequestHash(
      command,
      classification.canonicalActionId,
    );
    const result = await dependencies.orchestrate({
      command,
      previousStatus: guard.change.status,
    });
    return NextResponse.json(result, {
      status: result.enqueued.length > 0 ? 202 : 200,
    });
  } catch (error) {
    if (error instanceof PipelineCommandError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "invalid_pipeline_command" },
        { status: 422 },
      );
    }
    const message =
      error instanceof Error ? error.message : "Unknown command error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; changeId: string }> },
) {
  return handlePublicPipelineCommand(
    request,
    await params,
  );
}
