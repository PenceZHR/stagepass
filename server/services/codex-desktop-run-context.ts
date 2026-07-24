import type { CodexLogicalTurnRole } from "./codex-desktop-bridge-types";

export interface CodexDesktopRunContextInput {
  logicalTurnId: string;
  role: CodexLogicalTurnRole;
  prompt: string;
}

const ROLE_INSTRUCTIONS: Partial<Record<CodexLogicalTurnRole, string>> = {
  build: [
    "Implement the requested change in the current worktree.",
    "Keep all edits inside the requested scope and report the files changed.",
  ].join(" "),
  fix: [
    "Fix only the persisted findings assigned to this turn.",
    "Verify each fix and report any finding that remains unresolved.",
  ].join(" "),
  spec_writer: "Write the specification from the persisted requirements and current project context.",
  spec_critic: [
    "Perform a fresh adversarial evaluation using only the frozen specification,",
    "current requirements, and versioned review checklist supplied in this turn.",
  ].join(" "),
  spec_verdict: "Decide the specification verdict from the persisted writer and critic artifacts.",
};

/**
 * Builds deterministic, run-scoped role context inline. Hybrid execution never
 * creates or deletes the worktree's shared `.codex/agents` directory.
 */
export function createCodexDesktopRunContext(
  input: CodexDesktopRunContextInput,
): { prompt: string; cleanup(): void } {
  const instruction = ROLE_INSTRUCTIONS[input.role];
  if (!instruction) return { prompt: input.prompt, cleanup() {} };
  const marker = `[stagepass-role-context:${input.logicalTurnId}:${input.role}]`;
  if (input.prompt.includes(marker)) {
    return { prompt: input.prompt, cleanup() {} };
  }
  return {
    prompt: `${input.prompt}\n\n${marker}\n${instruction}`,
    cleanup() {},
  };
}
