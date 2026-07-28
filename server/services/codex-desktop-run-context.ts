import { resolveStageClarificationPolicy } from "@/lib/stage-clarification-policy";
import { STAGE_APPROVAL_QUESTION_ID } from "./stage-convergence-service";
import type { CodexLogicalTurnRole } from "./codex-desktop-bridge-types";

export interface CodexDesktopRunContextInput {
  logicalTurnId: string;
  role: CodexLogicalTurnRole;
  phase: string;
  prompt: string;
  projectId: string;
  scopeKind: "change" | "change_stage" | "project_prd" | "project_context";
  scopeId: string;
  threadId: string;
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

const CHOICE_CARD_ROLES = new Set<CodexLogicalTurnRole>([
  "stage",
  "spec_writer",
  "spec_critic",
  "spec_verdict",
  "build",
  "fix",
  "prd_turn",
  "context_select",
  "context_generate",
]);

function choiceCardInstruction(input: CodexDesktopRunContextInput): string {
  const policy = resolveStageClarificationPolicy(input.phase);
  const identity = [
    `logicalTurnId=${input.logicalTurnId}`,
    `projectId=${input.projectId}`,
    // A stage scope is keyed "<changeId>:<stageId>"; the card validates the
    // change, not the scope key.
    input.scopeKind === "change"
      ? `changeId=${input.scopeId}`
      : input.scopeKind === "change_stage"
        ? `changeId=${input.scopeId.slice(0, input.scopeId.lastIndexOf(":"))}`
        : "changeId=null",
    `threadId=${input.threadId}`,
  ].join(", ");
  const examples = policy.exampleQuestions
    .map((question, index) => `${index + 1}. ${question}`)
    .join(" ");
  return [
    `stageClarificationPolicy=${policy.id}.`,
    `This ${policy.label} stage must achieve: ${policy.objective}`,
    "This task covers this stage only. Earlier stages ran in their own Codex",
    "tasks whose conversations are not visible here: treat their committed",
    "artifacts under .ship/ as the only record of what they decided, and never",
    "assume an earlier discussion happened in this task. If a decision you need",
    "is not in those artifacts, ask for it rather than inferring it.",
    `Convergence rule: ${policy.completionRule}`,
    "When requirements are not concrete enough to run correctly, use the StagePass Card",
    "plugin tool present_stagepass_choices instead of asking plain-text questions.",
    "Present one to ten concrete requirement questions in each batch, not category names",
    "or PRD dimensions. Each question must ask for a decision the user can make now and",
    "must provide explicit A/B/C-style options (two to eight options per question).",
    "Include only execution-blocking questions; do not ask informational or optional",
    "questions that can be resolved safely from the repository and current context.",
    `Every call must include these exact immutable context fields: ${identity}.`,
    "Wait for a user message beginning with STAGEPASS_SELECTION_CONFIRMED.",
    "Only then summarize the answers as question-to-choice decisions in this same Codex task.",
    "After every confirmed batch, reassess remaining execution-blocking questions.",
    "If any remain, immediately call present_stagepass_choices with another batch of at",
    "most ten new concrete questions; never repeat an answered question.",
    "Use these stage-specific examples only as specificity guidance, not as a fixed",
    `questionnaire: ${examples}`,
    "When no blocking questions remain, stop asking and continue the requested stage.",
    "Emit the formal stage result only when no execution blocker remains.",
    "In that same reply, after the formal result, call present_stagepass_choices one",
    "final time with exactly one question whose questionId is",
    `${STAGE_APPROVAL_QUESTION_ID}, asking the user to approve this stage before the`,
    "next one starts, with two options: A 批准 and B 打回. Ask nothing else in that",
    "call -- it is an approval, not another question batch.",
    "Never claim the click took effect before that confirmation message appears.",
  ].join(" ");
}

/**
 * Builds deterministic, run-scoped role context inline. Hybrid execution never
 * creates or deletes the worktree's shared `.codex/agents` directory.
 */
export function createCodexDesktopRunContext(
  input: CodexDesktopRunContextInput,
): { prompt: string; cleanup(): void } {
  const instruction = ROLE_INSTRUCTIONS[input.role];
  const choiceInstruction = CHOICE_CARD_ROLES.has(input.role)
    ? choiceCardInstruction(input)
    : null;
  if (!instruction && !choiceInstruction) {
    return { prompt: input.prompt, cleanup() {} };
  }
  const roleMarker =
    `[stagepass-role-context:${input.logicalTurnId}:${input.role}]`;
  const choiceMarker =
    `[stagepass-choice-card:${input.logicalTurnId}:${input.role}]`;
  const additions: string[] = [];
  if (instruction && !input.prompt.includes(roleMarker)) {
    additions.push(roleMarker, instruction);
  }
  if (choiceInstruction && !input.prompt.includes(choiceMarker)) {
    additions.push(choiceMarker, choiceInstruction);
  }
  if (additions.length === 0) {
    return { prompt: input.prompt, cleanup() {} };
  }
  return {
    prompt: `${input.prompt}\n\n${additions.join("\n")}`,
    cleanup() {},
  };
}
