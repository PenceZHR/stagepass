import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  battleRounds,
  blueGapReviews,
  humanDecisions,
  redFixClaims,
  requirementGaps,
} from "../db/schema";
import { isSpecBlockingGap, type RuleGap } from "./spec-battle-rules";

export function latestRound(changeId: string): typeof battleRounds.$inferSelect | null {
  const rows = db.select().from(battleRounds).where(eq(battleRounds.changeId, changeId)).all();
  return rows.sort((a, b) => b.roundNo - a.roundNo)[0] ?? null;
}

export function allRounds(changeId: string): Array<typeof battleRounds.$inferSelect> {
  return db
    .select()
    .from(battleRounds)
    .where(eq(battleRounds.changeId, changeId))
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

export function getGaps(changeId: string): Array<typeof requirementGaps.$inferSelect> {
  return db.select().from(requirementGaps).where(eq(requirementGaps.changeId, changeId)).all();
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
