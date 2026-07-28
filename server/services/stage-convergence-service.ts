import type { AiRunItem, AiRunResult } from "./ai-engine-types";

/**
 * Tools a stage turn uses to ask the human another batch of questions. A turn
 * that called one of these has not produced a stage result: it handed the
 * decision back and is waiting for a card submission to wake it again.
 */
const CLARIFICATION_CARD_TOOLS = new Set([
  "present_stagepass_choices",
  "show_stagepass_card",
]);

/**
 * The one question a converged stage may still show: the human's go-ahead.
 * Fixed so the convergence rule can tell an approval apart from a question,
 * and so the answer can be routed to the gate instead of back to the model.
 */
export const STAGE_APPROVAL_QUESTION_ID = "stagepass_stage_approval";

export type StageConvergence =
  | { kind: "asked_again" }
  | { kind: "converged"; text: string }
  | { kind: "inconclusive"; reason: "turn_not_completed" | "empty_reply" };

function isCardCall(item: AiRunItem): boolean {
  if (item.type !== "mcp_tool_call") return false;
  const name = (item as { name?: unknown }).name;
  if (typeof name !== "string") return false;
  // MCP tool names arrive host-qualified ("<server>/<tool>"); the host prefix
  // is not part of the contract, the tool name is.
  return CLARIFICATION_CARD_TOOLS.has(name.slice(name.lastIndexOf("/") + 1));
}

/**
 * An approval-only card asks nothing further. A card that carries the approval
 * question alongside real questions is still a batch: the stage cannot be
 * settled while any of them is unanswered.
 */
function isApprovalOnlyCard(item: AiRunItem): boolean {
  const result = (item as { result?: unknown }).result;
  if (typeof result !== "string" || !result.includes(STAGE_APPROVAL_QUESTION_ID)) {
    return false;
  }
  try {
    const parsed = JSON.parse(result) as {
      structuredContent?: {
        questions?: Array<{ id?: unknown }>;
        answers?: Array<{ questionId?: unknown }>;
      };
    };
    // Presenting a card returns the batch it rendered under `questions`, with
    // each entry keyed by `id`. This used to read `answers[].questionId`, which
    // a present result never carries -- so it returned false for every card
    // including a pure approval one, every stage that asked for approval was
    // classified as having asked another question batch, and the stage could
    // never converge. No gate opened, so the approval the card was asking for
    // had nothing to fence and the click failed with 「提交失败」.
    //
    // `answers` stays as a second shape rather than a replacement: a completed
    // card reports what was chosen, and the rule is the same either way -- every
    // entry in the batch must be the approval question, so a batch that slips a
    // real question in alongside it is still a clarification.
    const questions = parsed.structuredContent?.questions;
    if (Array.isArray(questions) && questions.length > 0) {
      return questions.every((question) =>
        question?.id === STAGE_APPROVAL_QUESTION_ID);
    }
    const answers = parsed.structuredContent?.answers;
    if (!Array.isArray(answers) || answers.length === 0) return false;
    return answers.every((answer) => answer?.questionId === STAGE_APPROVAL_QUESTION_ID);
  } catch {
    return false;
  }
}

function isClarificationCardCall(item: AiRunItem): boolean {
  return isCardCall(item) && !isApprovalOnlyCard(item);
}

/**
 * Decides whether a finished clarification turn ended the stage's question
 * loop. Only a completed turn that asked nothing further and actually replied
 * may be adopted as the stage's formal result.
 */
export function classifyStageConvergence(result: AiRunResult): StageConvergence {
  if (result.items?.some(isClarificationCardCall)) return { kind: "asked_again" };
  if (!result.success) return { kind: "inconclusive", reason: "turn_not_completed" };
  const text = (result.summary ?? "").trim();
  if (text.length === 0) return { kind: "inconclusive", reason: "empty_reply" };
  return { kind: "converged", text };
}
