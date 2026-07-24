import type { CodexNativeFlags } from "./codex-native-flags";

export const CODEX_DECISION_PHASES = [
  "PRD",
  "Intake",
  "Spec",
  "TechSpec",
  "Plan",
  "TestPlan",
  "Build",
  "Fix",
  "Review",
  "QA",
  "Merge",
] as const;

export type CodexDecisionPhase = (typeof CODEX_DECISION_PHASES)[number];

export const CODEX_DECISION_INTERACTION_KINDS = [
  "prd_question",
  "prd_lock",
  "gate_decision",
  "risk_waiver",
  "build_adoption",
  "review_resolution",
  "merge_decision",
] as const;

export type CodexDecisionInteractionKind =
  (typeof CODEX_DECISION_INTERACTION_KINDS)[number];

export const CODEX_DECISION_ROLLOUT_INVALID =
  "codex_decision_rollout_invalid" as const;
export const CODEX_DECISION_ROLLOUT_INCOMPLETE =
  "codex_decision_rollout_incomplete" as const;

export type CodexDecisionRolloutError =
  | typeof CODEX_DECISION_ROLLOUT_INVALID
  | null;

export const INTERACTION_KIND_ALLOWED_PHASES = {
  prd_question: ["PRD"],
  prd_lock: ["PRD"],
  gate_decision: ["Intake", "Spec", "TechSpec", "TestPlan", "QA"],
  risk_waiver: ["Plan"],
  build_adoption: ["Build", "Fix"],
  review_resolution: ["Review"],
  merge_decision: ["Merge"],
} as const satisfies Record<
  CodexDecisionInteractionKind,
  readonly CodexDecisionPhase[]
>;

export interface CodexDecisionRollout {
  masterEnabled: boolean;
  phases: CodexDecisionPhase[];
  errorCode: CodexDecisionRolloutError;
}

export interface ParsedCodexDecisionPhases {
  phases: CodexDecisionPhase[];
  errorCode: CodexDecisionRolloutError;
}

export class CodexDecisionRolloutIncompleteError extends Error {
  readonly code = CODEX_DECISION_ROLLOUT_INCOMPLETE;

  constructor() {
    super(CODEX_DECISION_ROLLOUT_INCOMPLETE);
    this.name = "CodexDecisionRolloutIncompleteError";
  }
}

const CODEX_DECISION_PHASE_SET = new Set<string>(CODEX_DECISION_PHASES);
const CODEX_DECISION_INTERACTION_KIND_SET = new Set<string>(
  CODEX_DECISION_INTERACTION_KINDS,
);

function isCodexDecisionPhase(value: unknown): value is CodexDecisionPhase {
  return typeof value === "string" && CODEX_DECISION_PHASE_SET.has(value);
}

function isCodexDecisionInteractionKind(
  value: unknown,
): value is CodexDecisionInteractionKind {
  return (
    typeof value === "string" &&
    CODEX_DECISION_INTERACTION_KIND_SET.has(value)
  );
}

export function parseCodexDecisionPhases(
  value: string | undefined,
): ParsedCodexDecisionPhases {
  if (value === undefined) {
    return { phases: [], errorCode: null };
  }

  const tokens = value.split(",").map((token) => token.trim());
  if (
    tokens.length === 0 ||
    tokens.some(
      (token) => token.length === 0 || !isCodexDecisionPhase(token),
    )
  ) {
    return {
      phases: [],
      errorCode: CODEX_DECISION_ROLLOUT_INVALID,
    };
  }

  return {
    phases: [...new Set(tokens as CodexDecisionPhase[])],
    errorCode: null,
  };
}

export function readCodexDecisionRollout(
  env: NodeJS.ProcessEnv = process.env,
): CodexDecisionRollout {
  const parsed = parseCodexDecisionPhases(
    env.STAGEPASS_CODEX_DECISION_PHASES,
  );
  return {
    masterEnabled: env.STAGEPASS_CODEX_DECISION_SURFACE === "on",
    phases: parsed.phases,
    errorCode: parsed.errorCode,
  };
}

export function assertCompleteCodexDecisionRollout(
  env: NodeJS.ProcessEnv = process.env,
): CodexDecisionRollout {
  const rollout = readCodexDecisionRollout(env);
  const enabled = new Set(rollout.phases);
  if (
    !rollout.masterEnabled
    || rollout.errorCode !== null
    || rollout.phases.length !== CODEX_DECISION_PHASES.length
    || CODEX_DECISION_PHASES.some((phase) => !enabled.has(phase))
  ) {
    throw new CodexDecisionRolloutIncompleteError();
  }
  return rollout;
}

export function isCodexDecisionSurfaceEnabled(
  target:
    | CodexDecisionPhase
    | {
        phase: CodexDecisionPhase;
        kind: CodexDecisionInteractionKind;
      },
  flags: CodexNativeFlags,
): boolean {
  if (
    !flags.codexDecisionSurfaceMaster ||
    flags.codexDecisionRolloutError !== null
  ) {
    return false;
  }

  const enabledPhases = new Set<CodexDecisionPhase>(
    flags.codexDecisionPhases,
  );
  if (typeof target === "string") {
    return isCodexDecisionPhase(target) && enabledPhases.has(target);
  }

  if (
    target === null ||
    typeof target !== "object" ||
    !isCodexDecisionPhase(target.phase) ||
    !isCodexDecisionInteractionKind(target.kind) ||
    !enabledPhases.has(target.phase)
  ) {
    return false;
  }

  const allowedPhases: readonly CodexDecisionPhase[] =
    INTERACTION_KIND_ALLOWED_PHASES[target.kind];
  return allowedPhases.includes(target.phase);
}
