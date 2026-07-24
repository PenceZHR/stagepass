import {
  readCodexDecisionRollout,
  type CodexDecisionPhase,
  type CodexDecisionRolloutError,
} from "./codex-decision-rollout";

export interface CodexNativeFlags {
  desktopBridge: boolean;
  mcpInteractions: boolean;
  codexDecisionSurfaceMaster: boolean;
  codexDecisionPhases: CodexDecisionPhase[];
  codexDecisionRolloutError: CodexDecisionRolloutError;
}

export type CodexManagedScopeKind =
  | "change"
  | "project_prd"
  | "project_context";

export function readCodexNativeFlags(
  env: NodeJS.ProcessEnv = process.env,
): CodexNativeFlags {
  const rollout = readCodexDecisionRollout(env);
  return {
    desktopBridge: env.STAGEPASS_CODEX_DESKTOP_BRIDGE === "on",
    mcpInteractions: env.STAGEPASS_MCP_INTERACTIONS === "on",
    codexDecisionSurfaceMaster: rollout.masterEnabled,
    codexDecisionPhases: rollout.phases,
    codexDecisionRolloutError: rollout.errorCode,
  };
}

export function isCodexManagedScopeEnabled(
  _scopeKind: CodexManagedScopeKind,
  flags: CodexNativeFlags,
): boolean {
  return flags.desktopBridge;
}
