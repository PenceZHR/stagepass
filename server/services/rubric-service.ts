import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";

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
import { withCurrentExecutionFenceWrite } from "./execution-fence-service";
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
  criteria: Array<{
    text: string;
    blocking?: boolean;
    /**
     * The `criterionKey` this row continues, when the caller is editing a row
     * it read back from a previous version. Omit for a genuinely new criterion.
     * A key that belongs to no version of THIS scope is ignored rather than
     * honoured -- see resolveCriterionKeys.
     */
    criterionKey?: string | null;
  }>;
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

function toCriterion(row: typeof rubricCriteria.$inferSelect): RubricCriterion {
  return {
    id: row.id,
    criterionKey: row.criterionKey,
    ordinal: row.ordinal,
    text: row.text,
    blocking: row.blocking === 1,
  };
}

function readCriteria(rubricId: string): RubricCriterion[] {
  return db
    .select()
    .from(rubricCriteria)
    .where(eq(rubricCriteria.rubricId, rubricId))
    .all()
    .map(toCriterion)
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
 * Decides which `criterionKey` each incoming criterion carries (§5.1).
 *
 * Three rules, tried in order, per criterion:
 *
 *  1. the key the caller sent back, IF it belongs to some version of this same
 *     scope. This is what makes REWORDING safe: the editor round-trips the key,
 *     so fixing a typo keeps the criterion's identity and does not orphan
 *     whatever batch 5 has derived from it.
 *  2. otherwise, the key of an identically-worded criterion in the most recent
 *     version that had one. This is the design doc's literal rule ("正文未变则
 *     沿用同一个 key") and covers any caller that does not track keys.
 *  3. otherwise a fresh key: this is a criterion nobody has seen before.
 *
 * A key that belongs to no version of this scope is DROPPED to rule 3 rather
 * than trusted. Honouring it would let a request bind a brand-new criterion to
 * the identity of an existing one -- and therefore to an existing open gap --
 * which is the one thing a stable key must never allow. The safe direction is a
 * new identity: at worst it costs the continuity that did not exist before.
 *
 * No key may be used twice in one version. `uq_rubric_criteria_rubric_key`
 * would reject it anyway, but failing the whole save because a caller sent a
 * duplicate would be worse than minting a fresh key for the second one.
 */
function resolveCriterionKeys(
  previousVersions: readonly RubricVersionRecord[],
  incoming: SaveRubricVersionInput["criteria"],
): string[] {
  const knownKeys = new Set<string>();
  for (const version of previousVersions) {
    for (const criterion of version.criteria) knownKeys.add(criterion.criterionKey);
  }

  // Newest version first, so a wording that has existed in several versions
  // resolves to its most recent identity. A text repeated inside one version
  // yields a queue, consumed in order, so duplicates stay distinct.
  const keysByText = new Map<string, string[]>();
  for (const version of [...previousVersions].sort((a, b) => b.version - a.version)) {
    const inThisVersion = new Map<string, string[]>();
    for (const criterion of version.criteria) {
      const bucket = inThisVersion.get(criterion.text) ?? [];
      bucket.push(criterion.criterionKey);
      inThisVersion.set(criterion.text, bucket);
    }
    for (const [text, keys] of inThisVersion) {
      if (!keysByText.has(text)) keysByText.set(text, keys);
    }
  }

  const used = new Set<string>();
  const take = (key: string | undefined | null): string | null => {
    if (!key || used.has(key)) return null;
    used.add(key);
    return key;
  };

  return incoming.map((criterion) => {
    const text = criterion.text.trim();
    const carried = knownKeys.has(criterion.criterionKey ?? "")
      ? take(criterion.criterionKey)
      : null;
    if (carried) return carried;

    const queue = keysByText.get(text) ?? [];
    while (queue.length > 0) {
      const matched = take(queue.shift());
      if (matched) return matched;
    }
    return `RBK-${randomUUID()}`;
  });
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
      // Resolved INSIDE the transaction: which key a criterion inherits depends
      // on what the previous versions hold, and reading that outside would race
      // a concurrent save into issuing the same key twice. `toRecord` reads
      // through the module-level `db`, which is the same better-sqlite3
      // connection this transaction is open on, so these reads see the
      // transaction's own state.
      const criterionKeys = resolveCriterionKeys(existing.map(toRecord), input.criteria);

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
            criterionKey: criterionKeys[ordinal]!,
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
  persistRubricAssessments(input, assessments);
  return { ok: true, assessments };
}

/**
 * Records every criterion as `not_assessed` without consulting a model reply.
 *
 * The one legitimate way to write assessments without a parse, and deliberately
 * incapable of writing anything but `not_assessed`: it takes no judgments, so no
 * caller can reach a `yes` through it. It exists for the verdict rubric, which
 * runs last in a round and therefore has no retry vehicle -- see
 * runSpecVerdictRubric in pipeline-spec-stage-service.ts. Storing nothing there
 * would be the one failure this whole mechanism exists to prevent: absent rows
 * read as "this phase has no rubric", i.e. as a pass, whereas `not_assessed`
 * rows are blocking by rubricOutcome().
 */
export function recordUnansweredRubric(input: {
  changeId: string;
  runId: string;
  roundId?: string | null;
  rubric: RubricVersionRecord;
}): RubricAssessmentDraft[] {
  const assessments = buildRubricAssessments(input.rubric.criteria, []);
  persistRubricAssessments(input, assessments);
  return assessments;
}

function persistRubricAssessments(
  input: { changeId: string; runId: string; roundId?: string | null; rubric: RubricVersionRecord },
  assessments: readonly RubricAssessmentDraft[],
): void {
  const now = new Date().toISOString();
  const roundId = input.roundId ?? null;

  // Fenced, not merely retried. These rows are written by a pipeline worker in
  // the middle of a stage, so the same rule the run ledger follows applies: a
  // worker whose lease has been taken over must not still be able to write a
  // verdict for a round somebody else now owns. withCurrentExecutionFenceWrite
  // re-checks the lease INSIDE the transaction, and is a no-op outside a strict
  // fence (rubric editing from the UI, and unit tests), so it costs nothing
  // where there is no execution to fence against.
  withCurrentExecutionFenceWrite("rubric.recordRubricAssessments", input.runId, (tx) => {
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
  });
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
 * Every assessment ever recorded against ANY version of one rubric scope.
 *
 * Three things about this query are load-bearing, and each one is a failure the
 * design doc names:
 *
 *  - it is keyed on the SCOPE, not on one `rubric_id`. Reading
 *    `rubric_id = <current version>` would return nothing the moment somebody
 *    edits the rubric, and "no rows" is indistinguishable from "this phase has
 *    no rubric", which reads as a pass. Verdicts made against an older version
 *    must stay visible and be LABELLED as older (§7.6), not vanish.
 *  - it spans both the project-level default and this change's override.
 *    Creating an override would otherwise hide every verdict made before it.
 *  - callers select a batch by `roundId`, never by `runId` -- see
 *    selectLatestAssessmentBatch.
 */
export function listRubricAssessmentsForScope(scope: {
  projectId: string;
  changeId: string;
  phase: RubricPhase;
  role: RubricRole;
}): StoredRubricAssessment[] {
  return db
    .select({ assessment: rubricAssessments })
    .from(rubricAssessments)
    .innerJoin(rubrics, eq(rubrics.id, rubricAssessments.rubricId))
    .where(
      and(
        eq(rubricAssessments.changeId, scope.changeId),
        eq(rubrics.projectId, scope.projectId),
        eq(rubrics.phase, scope.phase),
        eq(rubrics.role, scope.role),
        or(isNull(rubrics.changeId), eq(rubrics.changeId, scope.changeId)),
      ),
    )
    .all()
    .map((row) => ({
      id: row.assessment.id,
      rubricId: row.assessment.rubricId,
      runId: row.assessment.runId,
      roundId: row.assessment.roundId,
      criterionId: row.assessment.criterionId,
      verdict: row.assessment.verdict as RubricAssessmentDraft["verdict"],
      evidence: row.assessment.evidence,
      createdAt: row.assessment.createdAt,
    }));
}

/**
 * The one batch of verdicts that describes "this round" -- selected by
 * `roundId`, deliberately never by `runId` (§5.2).
 *
 * `resumeBlue` starts a NEW run for a round that has already had its red half
 * answered, and does not re-run red. Red's producer verdicts therefore sit
 * under the round's FIRST `run_id` while the round is being finished under a
 * second one. A caller that filtered on the current `run_id` would find no
 * producer rows, read that as "the producer has no rubric", and pass the stage
 * on the strength of a judgment that was never made. That is precisely the
 * failure this whole mechanism exists to prevent, so the round is the unit.
 *
 * Within a round one rubric ROLE can still hold rows from two versions -- retry
 * the same half after editing the rubric and the old version's rows survive,
 * because persistRubricAssessments only clears rows of the version it is
 * writing. The newest version wins, since that is the one that actually just
 * answered.
 */
export function selectLatestAssessmentBatch(
  assessments: readonly StoredRubricAssessment[],
  scope: { roundId: string | null },
): StoredRubricAssessment[] {
  const inScope = scope.roundId === null
    ? assessments.filter((row) => row.roundId === null)
    : assessments.filter((row) => row.roundId === scope.roundId);
  if (inScope.length === 0) return [];

  const newestByRubric = new Map<string, string>();
  for (const row of inScope) {
    const seen = newestByRubric.get(row.rubricId);
    if (!seen || row.createdAt > seen) newestByRubric.set(row.rubricId, row.createdAt);
  }
  let winner: string | null = null;
  for (const [rubricId, createdAt] of newestByRubric) {
    if (winner === null || createdAt > newestByRubric.get(winner)!) winner = rubricId;
  }
  return inScope.filter((row) => row.rubricId === winner);
}

/** Every version of one scope, newest first, for resolving a verdict's wording. */
export function indexCriteriaByScope(scope: {
  projectId: string;
  changeId: string;
  phase: RubricPhase;
  role: RubricRole;
}): Map<string, { criterion: RubricCriterion; rubricId: string; version: number }> {
  const rows = db
    .select({ criterion: rubricCriteria, rubric: rubrics })
    .from(rubricCriteria)
    .innerJoin(rubrics, eq(rubrics.id, rubricCriteria.rubricId))
    .where(
      and(
        eq(rubrics.projectId, scope.projectId),
        eq(rubrics.phase, scope.phase),
        eq(rubrics.role, scope.role),
        or(isNull(rubrics.changeId), eq(rubrics.changeId, scope.changeId)),
      ),
    )
    .all();
  return new Map(
    rows.map((row) => [
      row.criterion.id,
      {
        criterion: toCriterion(row.criterion),
        rubricId: row.rubric.id,
        version: row.rubric.version,
      },
    ]),
  );
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
