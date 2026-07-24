import { createHash, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/server/db";
import { changes } from "@/server/db/schema";
import { createCodexInteractionRepository } from "@/server/repositories/codex-interaction-repository";
import {
  canonicalPipelineCommandRequestHash,
  pipelineCommandGateway,
} from "@/server/services/pipeline-command-gateway";
import { orchestrateAfterCommand } from "@/server/services/pipeline-command-orchestration";
import type { PipelineCommand } from "@/server/services/pipeline-command-types";
import { PipelineCommandError } from "@/server/services/pipeline-command-types";
import {
  canonicalMcpBodyHash,
  McpSubmitAuthError,
  mcpSubmitAuthService,
  type McpSubmitAuthService,
} from "@/server/services/mcp-submit-auth-service";

const PRIVATE_SUBMIT_SCHEMA = z.object({
  actionId: z.string().min(1),
  expectedGateVersion: z.string().min(1),
  expectedSourceDbHash: z.string().min(1),
  expectedHeadSha: z.string().min(1).nullable(),
  idempotencyKey: z.string().min(1),
  invocationNonce: z.string().min(32),
  formValues: z.record(z.string(), z.unknown()).default({}),
}).strict();

export interface PrivateInteractionSubmitDependencies {
  auth: Pick<McpSubmitAuthService, "verify">;
  interactionRepository: Pick<
    ReturnType<typeof createCodexInteractionRepository>,
    "getInteraction"
  >;
  readChangeStatus(changeId: string): string | null;
  commandId(): string;
  execute: typeof pipelineCommandGateway.execute;
}

const interactionRepository = createCodexInteractionRepository(db);
const defaultDependencies: PrivateInteractionSubmitDependencies = {
  auth: mcpSubmitAuthService,
  interactionRepository,
  readChangeStatus(changeId) {
    return db.select({ status: changes.status }).from(changes)
      .where(eq(changes.id, changeId)).get()?.status ?? null;
  },
  commandId: () => `CMD-${randomUUID()}`,
  execute: pipelineCommandGateway.execute.bind(pipelineCommandGateway),
};

export async function handlePrivateInteractionSubmit(
  request: Request,
  interactionId: string,
  dependencies: PrivateInteractionSubmitDependencies = defaultDependencies,
): Promise<NextResponse> {
  try {
    const body = PRIVATE_SUBMIT_SCHEMA.parse(await request.json());
    const source = dependencies.auth.verify(
      request,
      new URL(request.url).pathname,
      canonicalMcpBodyHash(body),
    );
    const interaction = dependencies.interactionRepository
      .getInteraction(interactionId);
    if (!interaction) {
      return NextResponse.json(
        { error: "interaction_not_found" },
        { status: 404 },
      );
    }
    if (
      source.sourceThreadId !== interaction.codexThreadId
      || interaction.status !== "presented"
    ) {
      return NextResponse.json(
        { error: "source_thread_mismatch" },
        { status: 403 },
      );
    }
    const previousStatus = dependencies.readChangeStatus(interaction.changeId);
    if (!previousStatus) {
      return NextResponse.json(
        { error: "interaction_change_missing" },
        { status: 409 },
      );
    }
    const command: PipelineCommand = {
      commandId: dependencies.commandId(),
      projectId: interaction.projectId,
      changeId: interaction.changeId,
      actionId: body.actionId,
      expectedGateVersion: body.expectedGateVersion,
      expectedSourceDbHash: body.expectedSourceDbHash,
      expectedHeadSha: body.expectedHeadSha,
      idempotencyKey: body.idempotencyKey,
      requestHash: "",
      actor: {
        kind: "human",
        surface: "codex_mcp_app",
        codexThreadId: source.sourceThreadId,
        interactionId,
      },
      payload: body.formValues,
    };
    command.requestHash = canonicalPipelineCommandRequestHash(command);
    const invocationNonceHash = createHash("sha256")
      .update(body.invocationNonce)
      .digest("hex");
    const result = await orchestrateAfterCommand({
      command,
      previousStatus,
      execute: (authenticatedCommand) => dependencies.execute(
        authenticatedCommand,
        {
          invocationNonceHash,
          sourceThreadId: source.sourceThreadId,
        },
      ),
    });
    return NextResponse.json(result, {
      status: result.enqueued.length > 0 ? 202 : 200,
    });
  } catch (error) {
    if (error instanceof McpSubmitAuthError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status },
      );
    }
    if (error instanceof PipelineCommandError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status },
      );
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "invalid_interaction_submit" },
        { status: 422 },
      );
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "interaction_submit_failed",
      },
      { status: 400 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ interactionId: string }> },
) {
  return handlePrivateInteractionSubmit(
    request,
    (await params).interactionId,
  );
}
