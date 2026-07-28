import type { CodexLogicalTurnRole } from "./codex-desktop-bridge-types";
import type { CodexToolSurface } from "./codex-home-profile";

/**
 * What a role expects back from the model, and therefore which tools it may see.
 *
 * ## Why this is one table
 *
 * Two output contracts live in this system at once. A `line_protocol` role has
 * its reply parsed by a strict parser -- the PRD parser rejects a reply missing
 * `TITLE:` or `PRD_DONE: true`. An `interaction_cards` role instead expects the
 * model to call a StagePass card tool and a human to answer it.
 *
 * They are not merely different; they are mutually destructive. A model offered
 * a card it can call and a protocol it was told to write calls the card. That
 * is what a PRD turn did: it answered "请在审批卡中选择批准或打回" and emitted
 * none of the protocol lines, so the parser rejected a turn the model
 * considered a success. Nothing in the prompt can fix that reliably, because the
 * card is genuinely the better answer to the question the model was asked -- the
 * tool should not have been on the table.
 *
 * So the contract has to be declared where both consequences can be derived from
 * it: which parser judges the reply, and which tool surface the turn runs with.
 *
 * ## Why the table is exhaustive
 *
 * `Record<CodexLogicalTurnRole, ...>` makes a new role a compile error until
 * somebody decides its contract. The alternative -- a lookup with a default --
 * is how a role silently inherits the wrong tool surface and fails as a parse
 * error somewhere far away.
 */
/**
 * - `interaction_cards`: told to ask via a card, and given the tools to do it.
 * - `line_protocol`: reply parsed by a strict parser, so the card tools are
 *   withheld -- a model that can see a card will use it.
 * - `unconstrained`: neither. Keeps every tool, gets no card instruction.
 *
 * Three values rather than two because instructing a card and offering the card
 * tools were previously independent, and collapsing them into a binary silently
 * proposed isolating roles like `spec_judge`, which was never told to ask via a
 * card but does need its full tool surface to spawn sub-agents.
 */
export type StageOutputContract =
  | "interaction_cards"
  | "line_protocol"
  | "unconstrained";

interface RoleContract {
  contract: StageOutputContract;
  /**
   * Whether this entry was confirmed by running the role, as opposed to
   * inherited from the behaviour that preceded this table. Not a contract of
   * its own -- it marks the difference between checked and merely carried over.
   */
  verified: boolean;
}

/** Inherited from the CHOICE_CARD_ROLES set this table replaced. */
const CARDS_INHERITED: RoleContract = {
  contract: "interaction_cards",
  verified: false,
};
const UNCONSTRAINED_INHERITED: RoleContract = {
  contract: "unconstrained",
  verified: false,
};

export const ROLE_OUTPUT_CONTRACTS:
Record<CodexLogicalTurnRole, RoleContract> = {
  // Verified 2026-07-28. With the card tools present the reply was "请在审批卡中
  // 选择批准或打回" and carried none of TITLE / OVERVIEW / TARGETUSERS /
  // PRD_DONE, so the parser rejected a turn the model considered finished.
  prd_turn: { contract: "line_protocol", verified: true },

  // Part of the card flow, but driven by their effect payload rather than by a
  // prompt instruction -- `interaction_wakeup` resumes after a saved decision
  // and its prompt is meant to stay exactly as the caller wrote it. They need
  // the tools and none of the wording.
  interaction_present: { contract: "unconstrained", verified: true },
  interaction_wakeup: { contract: "unconstrained", verified: true },

  // The four-phase stages and their adversarial sides: human intervention is
  // the point, so the card is the intended output, not an intrusion.
  stage: CARDS_INHERITED,
  spec_writer: CARDS_INHERITED,
  spec_critic: CARDS_INHERITED,
  spec_verdict: CARDS_INHERITED,
  build: CARDS_INHERITED,
  fix: CARDS_INHERITED,
  context_select: CARDS_INHERITED,
  context_generate: CARDS_INHERITED,

  // Never carried a card instruction, and must keep every tool: the judge
  // spawns sub-agents, and materialization exists so a thread comes into being.
  spec_judge: UNCONSTRAINED_INHERITED,
  delegated_round_judge: UNCONSTRAINED_INHERITED,
  shell_materialization: UNCONSTRAINED_INHERITED,
};

export function outputContractForRole(
  role: CodexLogicalTurnRole,
): StageOutputContract {
  return ROLE_OUTPUT_CONTRACTS[role].contract;
}

/**
 * The tool surface a role's contract implies.
 *
 * The mapping is the entire point of the table: a line protocol only survives
 * if the card tools are absent.
 */
export function toolSurfaceForRole(
  role: CodexLogicalTurnRole,
): CodexToolSurface {
  return outputContractForRole(role) === "line_protocol"
    ? "no-stagepass-plugins"
    : "full";
}

/** Roles whose contract is inherited rather than observed. */
export function unverifiedContractRoles(): CodexLogicalTurnRole[] {
  return (Object.keys(ROLE_OUTPUT_CONTRACTS) as CodexLogicalTurnRole[])
    .filter((role) => !ROLE_OUTPUT_CONTRACTS[role].verified);
}
