import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";

import { db } from "../db";
import { rubricAssessments, rubricCriteria, rubrics } from "../db/schema";
import {
  buildRubricAssessments,
  isRubricPhase,
  isRubricRole,
  type RubricAssessmentDraft,
  type RubricCriterion,
  type RubricPhase,
  type RubricRole,
} from "./rubric-assessment";
import { parseRubricLineProtocol } from "./rubric-line-protocol";
import { withSqliteWriteRetry } from "../db/write-boundary";

/**
 * Persistence for rubrics, their criteria, and per-run assessments.
 *
 * ## Versioned writes
 *
 * Editing a rubric NEVER updates a criterion in place. `saveRubricVersion`
 * appends a new `rubrics` row with `version + 1`, moves `is_current` onto it,
 * and writes a fresh set of criterion rows. Old versions stay readable forever.
 *
 * That is not tidiness, it is what makes §4.4 hold. Assessments reference
 * `criterion_id`; if an edit rewrote the criterion text, every finished run
 * would retroactively claim to have been judged against wording it never saw,
 * and a stage that had already been stamped would have no way to explain
 * itself. Appending means an edit cannot reach backwards into anything -- which
 * is precisely why editing a rubric invalidates no gate.
 *
 * ## Scope resolution
 *
 * A change-level rubric overrides the project-level default for that one
 * change (§4.5). `getEffectiveRubric` returns whichever applies plus which one
 * it was, so a caller (and later the UI) can say which is in force.
 */

export interface RubricScope {
  projectId: string;
  /** null selects the project-level default. */
  changeId: string | null;
  phase: RubricPhase;
  role: RubricRole;
}

export interface RubricVersionRecord {
  id: string;
  projectId: string;
  changeId: string | null;
  phase: RubricPhase;
  role: RubricRole;
  version: number;
  isCurrent: boolean;
  createdAt: string;
  criteria: RubricCriterion[];
}

export interface SaveRubricVersionInput extends RubricScope {
  criteria: Array<{ text: string; blocking?: boolean }>;
}

class RubricError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RubricError";
    this.code = code;
  }
}

export { RubricError };

function assertScope(scope: RubricScope): void {
  if (!scope.projectId) throw new RubricError("rubric_scope_invalid", "projectId is required");
  if (!isRubricPhase(scope.phase)) {
    throw new RubricError("rubric_scope_invalid", `unknown rubric phase: ${scope.phase}`);
  }
  if (!isRubricRole(scope.role)) {
    throw new RubricError("rubric_scope_invalid", `unknown rubric role: ${scope.role}`);
  }
}

/**
 * `change_id IS NULL` and `change_id = ?` are different predicates, and getting
 * this wrong is silent: `eq(column, null)` renders `= NULL`, which is never
 * true, so a project-level lookup would always come back empty and every caller
 * would quietly behave as though no rubric existed.
 */
function scopeFilter(scope: RubricScope) {
  return and(
    eq(rubrics.projectId, scope.projectId),
    scope.changeId === null ? isNull(rubrics.changeId) : eq(rubrics.changeId, scope.changeId),
    eq(rubrics.phase, scope.phase),
    eq(rubrics.role, scope.role),
  );
}

function readCriteria(rubricId: string): RubricCriterion[] {
  return db
    .select()
    .from(rubricCriteria)
    .where(eq(rubricCriteria.rubricId, rubricId))
    .all()
    .map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      text: row.text,
      blocking: row.blocking === 1,
    }))
    .sort((a, b) => a.ordinal - b.ordinal);
}

function toRecord(row: typeof rubrics.$inferSelect): RubricVersionRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    changeId: row.changeId,
    phase: row.phase as RubricPhase,
    role: row.role as RubricRole,
    version: row.version,
    isCurrent: row.isCurrent === 1,
    createdAt: row.createdAt,
    criteria: readCriteria(row.id),
  };
}

/** The current version for exactly this scope. Does NOT fall back. */
export function getCurrentRubric(scope: RubricScope): RubricVersionRecord | null {
  assertScope(scope);
  const row = db
    .select()
    .from(rubrics)
    .where(and(scopeFilter(scope), eq(rubrics.isCurrent, 1)))
    .get();
  return row ? toRecord(row) : null;
}

export interface EffectiveRubric {
  rubric: RubricVersionRecord;
  source: "change" | "project";
}

/**
 * The rubric actually in force for a change: its own override if it has one,
 * otherwise the project-level default. Null when neither exists -- an absent
 * rubric is legal and means this phase does no rubric judging (§4.5).
 */
export function getEffectiveRubric(scope: RubricScope): EffectiveRubric | null {
  assertScope(scope);
  if (scope.changeId !== null) {
    const override = getCurrentRubric(scope);
    if (override) return { rubric: override, source: "change" };
  }
  const projectDefault = getCurrentRubric({ ...scope, changeId: null });
  return projectDefault ? { rubric: projectDefault, source: "project" } : null;
}

export function listRubricVersions(scope: RubricScope): RubricVersionRecord[] {
  assertScope(scope);
  return db
    .select()
    .from(rubrics)
    .where(scopeFilter(scope))
    .all()
    .sort((a, b) => a.version - b.version)
    .map(toRecord);
}

/**
 * Appends a new version of a rubric and makes it current.
 *
 * The demotion of the previous current row must land BEFORE the insert:
 * `uq_rubrics_current_*` permits exactly one `is_current = 1` row per scope, so
 * inserting first raises SQLITE_CONSTRAINT. That ordering is the schema
 * enforcing the invariant rather than the service being trusted to maintain it.
 */
export function saveRubricVersion(input: SaveRubricVersionInput): RubricVersionRecord {
  assertScope(input);
  for (const criterion of input.criteria) {
    if (!criterion.text.trim()) {
      throw new RubricError("rubric_criterion_empty", "a rubric criterion cannot be empty");
    }
  }

  const rubricId = withSqliteWriteRetry("rubric.saveRubricVersion", () =>
    db.transaction((tx) => {
      const existing = tx.select().from(rubrics).where(scopeFilter(input)).all();
      const nextVersion = existing.reduce((max, row) => Math.max(max, row.version), 0) + 1;
      const now = new Date().toISOString();
      const id = `RUB-${randomUUID()}`;

      tx.update(rubrics)
        .set({ isCurrent: 0 })
        .where(and(scopeFilter(input), eq(rubrics.isCurrent, 1)))
        .run();

      tx.insert(rubrics)
        .values({
          id,
          projectId: input.projectId,
          changeId: input.changeId,
          phase: input.phase,
          role: input.role,
          version: nextVersion,
          isCurrent: 1,
          createdAt: now,
        })
        .run();

      input.criteria.forEach((criterion, ordinal) => {
        tx.insert(rubricCriteria)
          .values({
            id: `RBC-${randomUUID()}`,
            rubricId: id,
            ordinal,
            text: criterion.text.trim(),
            // Absent means blocking. A criterion someone wrote down is assumed
            // to matter until they say otherwise.
            blocking: criterion.blocking === false ? 0 : 1,
            createdAt: now,
          })
          .run();
      });

      return id;
    }),
  );

  const saved = db.select().from(rubrics).where(eq(rubrics.id, rubricId)).get();
  if (!saved) throw new RubricError("rubric_save_failed", `rubric ${rubricId} did not persist`);
  return toRecord(saved);
}

export interface RecordRubricAssessmentsInput {
  changeId: string;
  runId: string;
  roundId?: string | null;
  rubric: RubricVersionRecord;
  /** Raw model reply. Parsed here so no caller can hand-assemble verdicts. */
  rawText: string;
  /** Block names the host stage legitimately emits. */
  expectedBlockNames?: readonly string[];
}

export type RecordRubricAssessmentsResult =
  | { ok: true; assessments: RubricAssessmentDraft[] }
  | { ok: false; message: string };

/**
 * Parses a reply against one rubric version and stores one row per criterion.
 *
 * Parsing is deliberately inside this function rather than a caller's
 * responsibility: the fail-closed guarantee is "every criterion gets a row,
 * missing ones as not_assessed", and that can only hold if the code that writes
 * rows is the same code that decides what the model said. A caller handing in a
 * pre-parsed list could hand in a short one.
 *
 * A parse failure writes NOTHING. The output is void, the run is retryable, and
 * a half-stored rubric would be worse than none -- it would look like a
 * completed judgment.
 */
export function recordRubricAssessments(
  input: RecordRubricAssessmentsInput,
): RecordRubricAssessmentsResult {
  const criteria = input.rubric.criteria;
  const parsed = parseRubricLineProtocol(input.rawText, {
    criterionIds: criteria.map((criterion) => criterion.id),
    expectedBlockNames: input.expectedBlockNames,
  });
  if (!parsed.ok) return { ok: false, message: parsed.message };

  const assessments = buildRubricAssessments(criteria, parsed.payload.judgments);
  const now = new Date().toISOString();
  const roundId = input.roundId ?? null;

  withSqliteWriteRetry("rubric.recordRubricAssessments", () =>
    db.transaction((tx) => {
      // Re-running a stage for the same run/round replaces its verdicts rather
      // than colliding with uq_rubric_assessments_*. Scoped to this rubric so a
      // producer's rows are never removed by the critic's write.
      tx.delete(rubricAssessments)
        .where(
          and(
            eq(rubricAssessments.runId, input.runId),
            eq(rubricAssessments.rubricId, input.rubric.id),
            roundId === null
              ? isNull(rubricAssessments.roundId)
              : eq(rubricAssessments.roundId, roundId),
          ),
        )
        .run();

      for (const assessment of assessments) {
        tx.insert(rubricAssessments)
          .values({
            id: `RBA-${randomUUID()}`,
            changeId: input.changeId,
            runId: input.runId,
            roundId,
            rubricId: input.rubric.id,
            criterionId: assessment.criterionId,
            verdict: assessment.verdict,
            evidence: assessment.evidence,
            createdAt: now,
          })
          .run();
      }
    }),
  );

  return { ok: true, assessments };
}

export interface StoredRubricAssessment extends RubricAssessmentDraft {
  id: string;
  rubricId: string;
  runId: string;
  roundId: string | null;
  createdAt: string;
}

export function listRubricAssessments(input: {
  runId: string;
  rubricId?: string;
}): StoredRubricAssessment[] {
  return db
    .select()
    .from(rubricAssessments)
    .where(
      input.rubricId
        ? and(eq(rubricAssessments.runId, input.runId), eq(rubricAssessments.rubricId, input.rubricId))
        : eq(rubricAssessments.runId, input.runId),
    )
    .all()
    .map((row) => ({
      id: row.id,
      rubricId: row.rubricId,
      runId: row.runId,
      roundId: row.roundId,
      criterionId: row.criterionId,
      verdict: row.verdict as RubricAssessmentDraft["verdict"],
      evidence: row.evidence,
      createdAt: row.createdAt,
    }));
}

/**
 * Project-level rubric rows a project deletion must remove.
 *
 * Change-scoped rubric rows are handled by CHANGE_DELETE_PLAN, which
 * deleteProject already runs per change. Project-level rows (`change_id IS
 * NULL`) are reachable from neither, and `rubrics.project_id` references
 * `projects.id`, so without this the final `DELETE FROM projects` would raise
 * SQLITE_CONSTRAINT_FOREIGNKEY on any project that ever had a rubric.
 *
 * Ordered children-first, same contract as CHANGE_DELETE_PLAN.
 */
export const PROJECT_RUBRIC_DELETE_PLAN: ReadonlyArray<{
  table: string;
  where: (projectId: string) => SQL;
}> = [
  {
    table: "rubric_assessments",
    where: (projectId) =>
      sql`rubric_id IN (SELECT id FROM rubrics WHERE project_id = ${projectId})`,
  },
  {
    table: "rubric_criteria",
    where: (projectId) =>
      sql`rubric_id IN (SELECT id FROM rubrics WHERE project_id = ${projectId})`,
  },
  { table: "rubrics", where: (projectId) => sql`project_id = ${projectId}` },
];
