import { and, desc, eq } from "drizzle-orm";

import { db } from "../db";
import {
  codexInteractions,
  codexLogicalTurns,
  codexThreadBindings,
} from "../db/schema";
import { createCodexInteractionRepository } from "../repositories/codex-interaction-repository";
import { requireActionDefinition } from "./action-contract-registry-service";

/**
 * Turns a server-created gate decision into a card the existing
 * `stagepass-card` plugin can render, and back again.
 *
 * ## Why the model is handed one opaque id and nothing else
 *
 * The card the human sees has to be the decision StagePass actually opened.
 * If the model composed it -- picked the wording, chose which options to show,
 * copied the ids the receipt needs -- then the card's structure would be the
 * model's output, and a paraphrase or a dropped option would be indistinguishable
 * from the real thing. So the plugin sends an `interactionId` and receives the
 * whole card: question text, option set, and the four identifiers
 * (`logicalTurnId`, `projectId`, `changeId`, `threadId`) the receipt is verified
 * against. The model cannot supply those and therefore cannot forge them.
 *
 * ## Why opening a card is a POST
 *
 * Showing the card moves the interaction `pending -> presented`. That is a
 * write, so this is not dressed up as a read. The repo already had the opposite
 * mistake -- `listBaselineDocs` scaffolding ten files on a GET -- and the cost
 * was that a page view looked like the model writing during a stage.
 *
 * ## What this deliberately does NOT do
 *
 * It never calls `getActions`. That recomputes the contract AND persists it,
 * which would make opening a card a contract write. The option LABELS come from
 * the static `ACTION_DEFINITIONS` registry, and the option SET comes from the
 * interaction, which `ensureDesignInteraction` already filtered down to what the
 * contract had enabled at the moment the card was opened. Whether those options
 * are still legal is re-checked at record time by `executeStageApproval`, which
 * reads the live gate -- the card is a snapshot, the contract is the authority.
 */

/**
 * The question id every server-opened gate decision card carries.
 *
 * Deliberately NOT `stagepass_stage_approval`. That id belongs to the two-option
 * A/B card the model opens for itself at the end of a stage, and its answers are
 * resolved by position ("A" means approve). This card's options are action ids,
 * resolved by name. Two rules that read the same field differently must not
 * share a key, or one silently answers for the other.
 */
export const GATE_DECISION_QUESTION_ID = "stagepass_gate_decision";

export const GATE_DECISION_CARD_SCHEMA_VERSION =
  "stagepass.gate-decision-card/v1";

/** The plugin refuses a question with fewer than two options. */
const MIN_CARD_OPTIONS = 2;

export class GateDecisionCardError extends Error {
  constructor(readonly code: string, readonly status = 409, message = code) {
    super(message);
    this.name = "GateDecisionCardError";
  }
}

export interface GateDecisionCardOption {
  id: string;
  label: string;
}

export interface GateDecisionCard {
  schemaVersion: typeof GATE_DECISION_CARD_SCHEMA_VERSION;
  interactionId: string;
  logicalTurnId: string;
  projectId: string;
  changeId: string;
  threadId: string;
  stage: string;
  batchTitle: string;
  helperText: string;
  questions: [{
    id: typeof GATE_DECISION_QUESTION_ID;
    question: string;
    selectionMode: "single";
    options: GateDecisionCardOption[];
  }];
}

type CardDb = typeof db;

export interface GateDecisionCardDependencies {
  database?: CardDb;
  now?: () => Date;
}

function optionsFor(actionIds: string[]): GateDecisionCardOption[] {
  return actionIds.map((actionId) => ({
    id: actionId,
    // Fails loudly on an action the registry has never heard of. A card that
    // rendered such an option would be a button whose click no surface can
    // execute, which is the exact shape this whole path kept failing in.
    label: requireActionDefinition(actionId).label,
  }));
}

/**
 * Opens the gate decision card and returns everything needed to render and
 * later record it.
 */
export function openGateDecisionCard(
  interactionId: string,
  dependencies: GateDecisionCardDependencies = {},
): GateDecisionCard {
  const database = dependencies.database ?? db;
  const now = dependencies.now ?? (() => new Date());
  const interaction = createCodexInteractionRepository(database)
    .getInteraction(interactionId);
  if (!interaction) {
    throw new GateDecisionCardError("gate_decision_card_not_found", 404);
  }
  if (interaction.kind !== "gate_decision") {
    throw new GateDecisionCardError("gate_decision_card_wrong_kind", 409);
  }
  if (interaction.status !== "pending" && interaction.status !== "presented") {
    // An expired or already-answered decision must not be shown again: the
    // human would be clicking a gate that has since moved.
    throw new GateDecisionCardError(
      `gate_decision_card_${interaction.status}`,
      409,
    );
  }

  // The logical turn this card is being presented in. It is what the receipt is
  // verified against, so it is read here rather than accepted from the caller.
  const logical = database.select().from(codexLogicalTurns).where(and(
    eq(codexLogicalTurns.interactionId, interactionId),
    eq(codexLogicalTurns.role, "interaction_present"),
  )).orderBy(desc(codexLogicalTurns.ordinal)).get();
  if (!logical) {
    throw new GateDecisionCardError("gate_decision_card_turn_not_found", 409);
  }
  const binding = database.select().from(codexThreadBindings)
    .where(eq(codexThreadBindings.bindingId, logical.bindingId)).get();
  if (!binding?.threadId) {
    throw new GateDecisionCardError("gate_decision_card_binding_not_found", 409);
  }

  const options = optionsFor(interaction.actionIds);
  if (options.length < MIN_CARD_OPTIONS) {
    // One option is not a decision. Saying so here beats the plugin's generic
    // `invalid_options`, which names neither the card nor the phase.
    throw new GateDecisionCardError(
      "gate_decision_card_too_few_options",
      409,
      `${interaction.phase} offers ${options.length} enabled action(s); a card needs ${MIN_CARD_OPTIONS}`,
    );
  }

  if (interaction.status === "pending") {
    const stamp = now().toISOString();
    database.update(codexInteractions).set({
      status: "presented",
      presentedAt: stamp,
      updatedAt: stamp,
    }).where(and(
      eq(codexInteractions.id, interactionId),
      // Compare-and-set, not a blind write: two conversations racing to open
      // the same card must not both claim to have presented it.
      eq(codexInteractions.status, "pending"),
    )).run();
  }

  return {
    schemaVersion: GATE_DECISION_CARD_SCHEMA_VERSION,
    interactionId,
    logicalTurnId: logical.logicalTurnId,
    projectId: binding.projectId,
    changeId: interaction.changeId,
    threadId: binding.threadId,
    stage: interaction.phase,
    batchTitle: interaction.title,
    helperText: interaction.summary,
    questions: [{
      id: GATE_DECISION_QUESTION_ID,
      question: interaction.title,
      selectionMode: "single",
      options,
    }],
  };
}

export interface GateDecisionAnswer {
  questionId: string;
  selectedOptionIds: string[];
}

/**
 * The gate action a click on this card stands for, or null if the answers are
 * not a gate decision at all.
 *
 * Returning null rather than throwing is what lets the receipt path try this
 * rule and the stage-approval A/B rule against the same answers without either
 * one claiming an answer that belongs to the other.
 */
export function resolveGateDecision(
  interactionId: string,
  answers: GateDecisionAnswer[],
  dependencies: GateDecisionCardDependencies = {},
): { actionId: string; changeId: string; phase: string } | null {
  const answer = answers.length === 1 ? answers[0] : undefined;
  if (!answer || answer.questionId !== GATE_DECISION_QUESTION_ID) return null;
  if (answer.selectedOptionIds.length !== 1) return null;

  const database = dependencies.database ?? db;
  const interaction = createCodexInteractionRepository(database)
    .getInteraction(interactionId);
  if (!interaction || interaction.kind !== "gate_decision") return null;

  const actionId = answer.selectedOptionIds[0]!;
  // The interaction is the whitelist. A receipt naming an action this card
  // never offered is refused here, before it can reach a command.
  if (!interaction.actionIds.includes(actionId)) {
    throw new GateDecisionCardError(
      "gate_decision_action_not_offered",
      403,
      `${actionId} is not one of ${interaction.actionIds.join(", ")}`,
    );
  }
  return {
    actionId,
    changeId: interaction.changeId,
    phase: interaction.phase,
  };
}

/**
 * Closes the decision once its command has been executed.
 *
 * `completeInteraction` in the repository requires `submitting`, a state this
 * path never enters -- the card goes straight from presented to answered -- so
 * the transition is done here with its own compare-and-set.
 */
export function completeGateDecision(
  interactionId: string,
  dependencies: GateDecisionCardDependencies = {},
): void {
  const database = dependencies.database ?? db;
  const stamp = (dependencies.now ?? (() => new Date()))().toISOString();
  database.update(codexInteractions).set({
    status: "completed",
    completedAt: stamp,
    nonceConsumedAt: stamp,
    updatedAt: stamp,
  }).where(and(
    eq(codexInteractions.id, interactionId),
    eq(codexInteractions.status, "presented"),
  )).run();
}
