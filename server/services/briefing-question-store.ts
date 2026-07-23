import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { briefingQuestions } from "../db/schema";

/**
 * The one module allowed to touch briefing_questions.
 *
 * PRD Briefing and Spec Battle ask the human questions in exactly the same
 * shape, so they share one table and one UI component. What they must never
 * share is a query: a Spec card that reaches computePrdGate reads as an
 * unhandled critical question and refuses the PRD draft forever, and a Spec
 * card inside prdAuthorityRows moves the PRD stage hash for no reason.
 *
 * Every reader here takes `phase` as a required argument -- there is no default
 * and no "all phases" reader -- so forgetting the filter is not expressible.
 * briefing-question-store.test.ts additionally fails the build if any other
 * module selects from the table.
 */

export type BriefingQuestionPhase = "PRD" | "Spec";
export type BriefingQuestionRow = typeof briefingQuestions.$inferSelect;
export type NewBriefingQuestion = Omit<
  typeof briefingQuestions.$inferInsert,
  "createdAt" | "updatedAt"
>;

/** Anything with drizzle's select/insert/update surface: `db` or a transaction. */
type Connection = Pick<typeof db, "select" | "insert" | "update">;

function nowISO(): string {
  return new Date().toISOString();
}

/** Oldest round first, stable within a round. The order the room renders. */
function byRound(left: BriefingQuestionRow, right: BriefingQuestionRow): number {
  return left.roundNo - right.roundNo
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

export function listBriefingQuestionsWithDb(
  connection: Connection,
  changeId: string,
  phase: BriefingQuestionPhase,
): BriefingQuestionRow[] {
  return connection
    .select()
    .from(briefingQuestions)
    .where(and(eq(briefingQuestions.changeId, changeId), eq(briefingQuestions.phase, phase)))
    .all()
    .sort(byRound);
}

export function listBriefingQuestions(
  changeId: string,
  phase: BriefingQuestionPhase,
): BriefingQuestionRow[] {
  return listBriefingQuestionsWithDb(db, changeId, phase);
}

export function getBriefingQuestion(
  changeId: string,
  questionId: string,
  phase: BriefingQuestionPhase,
): BriefingQuestionRow | undefined {
  return db
    .select()
    .from(briefingQuestions)
    .where(and(
      eq(briefingQuestions.changeId, changeId),
      eq(briefingQuestions.id, questionId),
      eq(briefingQuestions.phase, phase),
    ))
    .get();
}

export function insertBriefingQuestionsWithDb(
  connection: Connection,
  rows: NewBriefingQuestion[],
): void {
  const now = nowISO();
  for (const row of rows) {
    connection.insert(briefingQuestions).values({ ...row, createdAt: now, updatedAt: now }).run();
  }
}

export function updateBriefingQuestionAnswer(input: {
  changeId: string;
  questionId: string;
  phase: BriefingQuestionPhase;
  status: string;
  answer: string | null;
}): void {
  db.update(briefingQuestions)
    .set({ status: input.status, answer: input.answer, updatedAt: nowISO() })
    .where(and(
      eq(briefingQuestions.changeId, input.changeId),
      eq(briefingQuestions.id, input.questionId),
      eq(briefingQuestions.phase, input.phase),
    ))
    .run();
}
