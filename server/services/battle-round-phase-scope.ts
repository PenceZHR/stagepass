import { and, eq, inArray, type SQL } from "drizzle-orm";
import { battleRounds, requirementGaps } from "../db/schema";
import type { RubricPhase } from "./rubric-assessment";

/**
 * Scopes a `battle_rounds` or `requirement_gaps` query to one phase.
 *
 * ## Why this exists
 *
 * `battle_rounds.phase` has been on the table since the table existed, but Spec
 * was its only writer, so every Spec reader selected on `changeId` alone and was
 * right by accident. The delegated round puts TechSpec, Plan and TestPlan rounds
 * in the same table, and a later phase's round always carries the higher
 * `roundNo` -- so an unscoped `latestRound` hands a Spec caller a TechSpec round.
 * That is not a display bug: `techSpecRunDecision` reads it to decide whether
 * Spec is closed, `approveSpecDecision` reads its status, and the round-limit
 * check counts it.
 *
 * The scope belongs at the READERS rather than at the new writer. Writing a
 * TechSpec round is the whole point of the delegated round, so there is nothing
 * to fix on the writing side -- and scoping only the writer would leave the same
 * trap armed for whoever adds the next phase.
 *
 * ## Why the lowercase alias
 *
 * `recovery-executors` and `recovery-business-evidence` already matched
 * `["Spec", "spec"]` before this module existed. Rather than decide here whether
 * a lowercase row can still be out there, this keeps their tolerance and makes
 * it the single definition: one predicate that every reader shares is what stops
 * the two spellings from diverging again.
 */
export function phaseAliases(phase: RubricPhase): string[] {
  const lower = phase.toLowerCase();
  return lower === phase ? [phase] : [phase, lower];
}

/** `changeId = ? AND phase IN (...)`, the scope every per-phase round reader needs. */
export function battleRoundScope(changeId: string, phase: RubricPhase): SQL | undefined {
  return and(
    eq(battleRounds.changeId, changeId),
    inArray(battleRounds.phase, phaseAliases(phase)),
  );
}

/** True when a row belongs to `phase`, for filtering rows already in hand. */
export function isBattleRoundOfPhase(
  round: Pick<typeof battleRounds.$inferSelect, "phase">,
  phase: RubricPhase,
): boolean {
  return phaseAliases(phase).includes(round.phase);
}

/**
 * `changeId = ? AND source_phase IN (...)` -- the same scope for the gap ledger.
 *
 * A separate function rather than a parameterised one because the two tables
 * name the column differently (`phase` vs `source_phase`), and a helper that
 * took the column as an argument would read worse at every call site than the
 * two names do.
 */
export function requirementGapScope(changeId: string, phase: RubricPhase): SQL | undefined {
  return and(
    eq(requirementGaps.changeId, changeId),
    inArray(requirementGaps.sourcePhase, phaseAliases(phase)),
  );
}
