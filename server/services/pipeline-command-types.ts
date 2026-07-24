export const PIPELINE_COMMAND_ACTOR_SURFACES = [
  "codex_mcp_app",
  "stagepass_web_emergency",
  "stagepass_web_ops",
  "recovery",
] as const;

export type PipelineCommandActorSurface =
  (typeof PIPELINE_COMMAND_ACTOR_SURFACES)[number];

export interface PipelineCommand {
  commandId: string;
  projectId: string;
  changeId: string;
  actionId: string;
  expectedGateVersion: string;
  expectedSourceDbHash: string;
  expectedHeadSha: string | null;
  idempotencyKey: string;
  requestHash: string;
  actor: {
    kind: "human" | "system";
    surface: PipelineCommandActorSurface;
    codexThreadId?: string;
    interactionId?: string;
  };
  payload: Record<string, unknown>;
}

export interface PipelineCommandResult {
  commandId: string;
  status: "completed";
  changeStatus: string;
  gateVersion: string;
  sourceDbHash: string;
  sourceHeadSha: string | null;
  interactionId: string | null;
  humanDecisionId: string | null;
  enqueuedJobId: string | null;
}

export class PipelineCommandError extends Error {
  constructor(
    public readonly code: string,
    message = code,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "PipelineCommandError";
  }
}

export interface PipelineCommandAction {
  externalActionId: string;
  canonicalActionId: string;
}

export interface PipelineCommandHandlerResult {
  changeStatus: string;
  humanDecisionId?: string | null;
  enqueuedJobId?: string | null;
  outboxEffects?: Array<{
    effectType: string;
    payload: Record<string, unknown>;
  }>;
}
