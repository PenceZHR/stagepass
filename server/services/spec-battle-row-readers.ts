import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  battleRounds,
  blueGapReviews,
  humanDecisions,
  redFixClaims,
  requirementGaps,
} from "../db/schema";
import { battleRoundScope, requirementGapScope } from "./battle-round-phase-scope";
import type { RubricPhase } from "./rubric-assessment";
import { isSpecBlockingGap, type RuleGap } from "./spec-battle-rules";

/**
 * `phase` defaults to Spec so every existing caller keeps its exact behaviour
 * while Spec is the only phase with rounds. It is a parameter rather than a
 * hard-coded literal because the delegated round gives TechSpec, Plan and
 * TestPlan rounds in this same table, and each needs the identical reader over
 * its own phase -- see battle-round-phase-scope.ts for why the scope lives here
 * rather than at the writer.
 */
export function latestRound(
  changeId: string,
  phase: RubricPhase = "Spec",
): typeof battleRounds.$inferSelect | null {
  const rows = db.select().from(battleRounds).where(battleRoundScope(changeId, phase)).all();
  return rows.sort((a, b) => b.roundNo - a.roundNo)[0] ?? null;
}

export function allRounds(
  changeId: string,
  phase: RubricPhase = "Spec",
): Array<typeof battleRounds.$inferSelect> {
  return db
    .select()
    .from(battleRounds)
    .where(battleRoundScope(changeId, phase))
    .all()
    .sort((a, b) => a.roundNo - b.roundNo);
}

export function toRuleGap(gap: typeof requirementGaps.$inferSelect): RuleGap {
  return {
    id: gap.id,
    severity: gap.severity as RuleGap["severity"],
    originalSeverity: gap.originalSeverity as RuleGap["originalSeverity"],
    downgradedTo: gap.downgradedTo as RuleGap["downgradedTo"],
    status: gap.status as RuleGap["status"],
  };
}

/**
 * The gaps ONE phase's critic raised.
 *
 * Scoped for the same reason the rounds are: `requirement_gaps` carries
 * `source_phase`, but while Spec was its only writer every reader could ignore
 * it and still be right. `getSpecBattleState` feeds `counts` straight into
 * `approveSpecDecision`, so an unscoped read lets a TechSpec critic's P0 block
 * the Spec gate.
 *
 * Not every gap reader wants this. Merge readiness filters on `mergeBlocking`
 * and the delivery note lists every open gap; an unresolved TechSpec P0 belongs
 * in both, so those stay phase-blind on purpose.
 */
export function getGaps(
  changeId: string,
  phase: RubricPhase = "Spec",
): Array<typeof requirementGaps.$inferSelect> {
  return db.select().from(requirementGaps).where(requirementGapScope(changeId, phase)).all();
}

export function getDecisions(changeId: string): Array<typeof humanDecisions.$inferSelect> {
  return db.select().from(humanDecisions).where(eq(humanDecisions.changeId, changeId)).all();
}

export function getRedFixClaims(changeId: string): Array<typeof redFixClaims.$inferSelect> {
  return db.select().from(redFixClaims).where(eq(redFixClaims.changeId, changeId)).all();
}

export function getBlueGapReviews(changeId: string): Array<typeof blueGapReviews.$inferSelect> {
  return db.select().from(blueGapReviews).where(eq(blueGapReviews.changeId, changeId)).all();
}

export function currentBlockingGaps(changeId: string): Array<typeof requirementGaps.$inferSelect> {
  return getGaps(changeId).filter((gap) => isSpecBlockingGap(toRuleGap(gap)));
}
