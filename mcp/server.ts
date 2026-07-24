import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  assertHostAttestedMcpChannel,
  type HostAttestedMcpChannel,
} from "./supervisor";
import {
  signStagePassSubmit,
  type StagePassSubmitSigningBroker,
} from "./stagepass-submit-signer";
import {
  StagePassApiClient,
  type SubmitInteractionInput,
  type SubmitInteractionResult,
} from "./stagepass-api-client";
import {
  CONTINUE_TOOL_META,
  PRESENT_TOOL_META,
  STAGEPASS_INTERACTION_RESOURCE_URI,
  STATUS_TOOL_META,
  SUBMIT_TOOL_META,
} from "./tool-metadata";
import type {
  PublicInteractionEnvelope,
} from "../server/services/mcp-presentation-auth-service";

declare const __STAGEPASS_UI_BUNDLE__: string | undefined;

const MAX_SUBMIT_BYTES = 64 * 1024;

const InteractionIdSchema = z.object({
  interactionId: z.string().trim().min(1).max(256),
}).strict();

const SubmitInteractionSchema = InteractionIdSchema.extend({
  actionId: z.string().trim().min(1).max(256),
  expectedGateVersion: z.string().trim().min(1).max(256),
  expectedSourceDbHash: z.string().trim().min(1).max(256),
  expectedHeadSha: z.string().trim().min(1).max(256).nullable(),
  idempotencyKey: z.string().trim().min(1).max(512),
  invocationNonce: z.string().min(32).max(512),
  formValues: z.record(z.string(), z.unknown()).default({}),
}).strict();

const ContinueInteractionSchema = z.object({
  interactionId: z.string().trim().min(1).max(256),
  commandId: z.string().trim().min(1).max(256),
}).strict();

export interface StagePassProtectedBroker
  extends StagePassSubmitSigningBroker {
  readonly health: "ready" | "unsupported";
  presentInteraction(
    channel: HostAttestedMcpChannel,
    interactionId: string,
  ): Promise<{
    envelope: PublicInteractionEnvelope;
    privateInvocationNonce: string;
  }>;
  continueInteraction(
    channel: HostAttestedMcpChannel,
    input: { interactionId: string; commandId: string },
  ): Promise<Record<string, unknown>>;
}

export interface StagePassMcpServerOptions {
  channel: HostAttestedMcpChannel;
  broker: StagePassProtectedBroker;
  apiClient: StagePassApiClient;
  uiBundle?: string;
}

export interface ToolInvocationContext {
  invocationSurface: "model" | "app";
  sourceThreadId: string;
}

export class StagePassMcpToolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StagePassMcpToolError";
  }
}

function invocationContext(extra: unknown): ToolInvocationContext {
  const meta = (
    typeof extra === "object"
    && extra !== null
    && "_meta" in extra
    && typeof extra._meta === "object"
    && extra._meta !== null
  ) ? extra._meta as Record<string, unknown> : {};
  const invocationSurface = meta["stagepass/caller"];
  const sourceThreadId = meta["stagepass/source-thread-attestation"];
  if (
    (invocationSurface !== "model" && invocationSurface !== "app")
    || typeof sourceThreadId !== "string"
    || !sourceThreadId.trim()
  ) {
    throw new StagePassMcpToolError("host_attestation_required");
  }
  return { invocationSurface, sourceThreadId };
}

function requireSameSource(
  context: ToolInvocationContext,
  channel: HostAttestedMcpChannel,
): void {
  assertHostAttestedMcpChannel(channel);
  if (context.sourceThreadId !== channel.sourceThreadId) {
    throw new StagePassMcpToolError("source_thread_mismatch");
  }
}

function requireAppInvocation(
  context: ToolInvocationContext,
  channel: HostAttestedMcpChannel,
): void {
  requireSameSource(context, channel);
  if (context.invocationSurface !== "app") {
    throw new StagePassMcpToolError("app_invocation_required");
  }
}

function enforceEvidenceIdsOnly(value: unknown, key = ""): void {
  if (/(^|_)(raw_?)?path$|file_?path|filesystem/i.test(key)) {
    throw new StagePassMcpToolError("evidence_ids_required");
  }
  if (Array.isArray(value)) {
    for (const child of value) enforceEvidenceIdsOnly(child);
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      enforceEvidenceIdsOnly(child, childKey);
    }
  }
}

function enforceSubmitSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_SUBMIT_BYTES) {
    throw new StagePassMcpToolError("interaction_submit_too_large");
  }
}

export async function callPresentTool(
  input: { interactionId: string },
  context: ToolInvocationContext,
  options: StagePassMcpServerOptions,
) {
  requireSameSource(context, options.channel);
  const result = await options.broker.presentInteraction(
    options.channel,
    input.interactionId,
  );
  if (result.envelope.codexThreadId !== options.channel.sourceThreadId) {
    throw new StagePassMcpToolError("source_thread_mismatch");
  }
  return result;
}

export async function callSubmitTool(
  input: z.infer<typeof SubmitInteractionSchema>,
  context: ToolInvocationContext,
  options: StagePassMcpServerOptions,
): Promise<SubmitInteractionResult> {
  requireAppInvocation(context, options.channel);
  enforceSubmitSize(input);
  enforceEvidenceIdsOnly(input.formValues);
  const { interactionId, ...body } = input;
  const path = `/api/interactions/${encodeURIComponent(interactionId)}/submit`;
  const authorization = await signStagePassSubmit(
    options.broker,
    options.channel,
    { path, body },
  );
  return options.apiClient.submitInteraction(
    interactionId,
    body satisfies SubmitInteractionInput,
    authorization,
  );
}

export async function callContinueTool(
  input: z.infer<typeof ContinueInteractionSchema>,
  context: ToolInvocationContext,
  options: StagePassMcpServerOptions,
  completedPairs: ReadonlyMap<string, string>,
) {
  requireAppInvocation(context, options.channel);
  if (completedPairs.get(input.interactionId) !== input.commandId) {
    throw new StagePassMcpToolError("completed_interaction_command_required");
  }
  return options.broker.continueInteraction(options.channel, input);
}

function interactionHtml(uiBundle?: string): string {
  const bundle = uiBundle
    ?? (typeof __STAGEPASS_UI_BUNDLE__ === "string"
      ? __STAGEPASS_UI_BUNDLE__
      : "document.body.dataset.stagepassBundle='missing';");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root{color-scheme:light dark;font-family:system-ui,sans-serif}
    body{margin:0;padding:16px}
    main{border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:12px;padding:16px}
  </style>
</head>
<body>
  <main id="stagepass-interaction">
    <strong>StagePass</strong>
    <p data-stagepass-status>Loading interaction…</p>
  </main>
  <script>${bundle}</script>
</body>
</html>`;
}

export function createStagePassMcpServer(
  options: StagePassMcpServerOptions,
): McpServer {
  assertHostAttestedMcpChannel(options.channel);
  if (options.broker.health !== "ready") {
    throw new StagePassMcpToolError("protected_channel_unsupported");
  }

  const server = new McpServer({
    name: "stagepass-mcp-server",
    version: "1.0.0",
  });
  const completedPairs = new Map<string, string>();

  registerAppResource(
    server,
    "StagePass interaction",
    STAGEPASS_INTERACTION_RESOURCE_URI,
    { description: "StagePass human interaction card." },
    async () => ({
      contents: [{
        uri: STAGEPASS_INTERACTION_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: interactionHtml(options.uiBundle),
        _meta: {
          ui: {
            prefersBorder: true,
            csp: { connectDomains: [], resourceDomains: [] },
          },
        },
      }],
    }),
  );

  registerAppTool(
    server,
    "present_stagepass_interaction",
    {
      title: "Present StagePass interaction",
      description: "Display an authoritative StagePass interaction.",
      inputSchema: InteractionIdSchema.shape,
      annotations: { readOnlyHint: true },
      _meta: PRESENT_TOOL_META,
    },
    async (input, extra) => {
      const presented = await callPresentTool(
        input,
        invocationContext(extra),
        options,
      );
      return {
        content: [{
          type: "text",
          text: "StagePass interaction is ready for the user.",
        }],
        structuredContent: presented.envelope,
        _meta: {
          stagepass: {
            invocationNonce: presented.privateInvocationNonce,
          },
        },
      };
    },
  );

  registerAppTool(
    server,
    "get_stagepass_interaction_status",
    {
      title: "Get StagePass interaction status",
      description: "Read the current authoritative interaction status.",
      inputSchema: InteractionIdSchema.shape,
      annotations: { readOnlyHint: true },
      _meta: STATUS_TOOL_META,
    },
    async (input, extra) => {
      requireSameSource(invocationContext(extra), options.channel);
      const interaction = await options.apiClient.getInteraction(
        input.interactionId,
      );
      if (interaction.codexThreadId !== options.channel.sourceThreadId) {
        throw new StagePassMcpToolError("source_thread_mismatch");
      }
      const status = { status: interaction.status };
      return {
        content: [{ type: "text", text: `Interaction status: ${status.status}` }],
        structuredContent: status,
      };
    },
  );

  registerAppTool(
    server,
    "submit_stagepass_interaction",
    {
      title: "Submit StagePass interaction",
      description: "Submit the user's interaction choice from the MCP App.",
      inputSchema: SubmitInteractionSchema.shape,
      _meta: SUBMIT_TOOL_META,
    },
    async (input, extra) => {
      const result = await callSubmitTool(
        input,
        invocationContext(extra),
        options,
      );
      if (
        result.status !== "completed"
        || result.interactionId !== input.interactionId
      ) {
        throw new StagePassMcpToolError("interaction_submit_not_completed");
      }
      completedPairs.set(input.interactionId, result.commandId);
      return {
        content: [{ type: "text", text: "StagePass decision accepted." }],
        structuredContent: { ...result },
      };
    },
  );

  registerAppTool(
    server,
    "continue_stagepass_interaction",
    {
      title: "Continue StagePass interaction",
      description: "Continue the attested Codex task after a completed decision.",
      inputSchema: ContinueInteractionSchema.shape,
      _meta: CONTINUE_TOOL_META,
    },
    async (input, extra) => {
      const result = await callContinueTool(
        input,
        invocationContext(extra),
        options,
        completedPairs,
      );
      return {
        content: [{ type: "text", text: "StagePass continuation dispatched." }],
        structuredContent: result,
      };
    },
  );

  return server;
}
