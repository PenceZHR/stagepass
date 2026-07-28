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
  /**
   * Which door a turn goes out of.
   *
   * `desktop` asks Codex Desktop to start the turn over its private IPC socket
   * -- the original path, and the only one that needs Desktop running, signed
   * and version-matched. `gateway` starts it over app-server, which needs only
   * the `codex` binary.
   *
   * The reason to keep both is that they are not yet equivalent in one respect:
   * on the desktop path Desktop OWNS the turn, on the gateway path Desktop can
   * only view it. Card rendering survives the difference (verified 2026-07-28);
   * anything else that assumes ownership has to be checked before the desktop
   * path can be retired.
   */
  turnTransport: "desktop" | "gateway";
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
    // Defaults to the desktop path: it is the one with production mileage, and
    // an unset variable must never silently move turns to a newer door.
    turnTransport: env.STAGEPASS_CODEX_TURN_TRANSPORT === "gateway"
      ? "gateway"
      : "desktop",
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
