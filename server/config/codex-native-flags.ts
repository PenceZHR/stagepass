import {
  readCodexDecisionRollout,
  type CodexDecisionPhase,
  type CodexDecisionRolloutError,
} from "./codex-decision-rollout";

export interface CodexNativeFlags {
  desktopBridge: boolean;
  mcpInteractions: boolean;
  /**
   * Run a Spec round as ONE delegated turn -- a judge that spawns red and blue
   * as sub-agents -- instead of three server-dispatched turns.
   *
   * Off by default because it is the newer of two live forms, not because it is
   * optional: sub-agents only exist on the desktop bridge, so this is
   * meaningless without it.
   */
  specJudgeSubAgents: boolean;
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
    specJudgeSubAgents: env.STAGEPASS_SPEC_JUDGE_SUBAGENTS === "on",
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
