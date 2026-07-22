import { sql, type SQL } from "drizzle-orm";

/**
 * Deleting a set of `runs` rows -- what /rework does when it discards the
 * phases at or after the one being reworked.
 *
 * Sixteen tables reach `runs` through declared foreign keys, and schema.ts
 * declares no ON DELETE behaviour, so the cascade is ours to get right exactly
 * as it is for CHANGE_DELETE_PLAN. Two things make the run-scoped cascade
 * different from the change-scoped one:
 *
 *  1. The change survives. A table that hangs off the *change* and merely
 *     points at a run-scoped row must keep its row and drop the pointer --
 *     deleting it would throw away state belonging to runs that are not being
 *     reworked. Those columns are RUN_POINTER_CLEARS, not delete steps.
 *  2. `rubric_assessments.run_id` is NOT NULL and carries no foreign key (it
 *     names a row in whichever ledger the stage used -- `runs`, `stage_runs`,
 *     or a spec-battle round -- so it cannot have one). Nothing in the database
 *     would refuse a delete that stranded those rows, which makes it the one
 *     table here whose omission is silent instead of loud.
 *
 * run-delete-plan.test.ts derives the real foreign-key graph from schema.ts,
 * severs the RUN_POINTER_CLEARS edges, and fails if this list drifts from what
 * remains -- so a new table that references a run cannot be added without
 * landing in one of the two lists below.
 */

/**
 * Renders `'a', 'b', 'c'` for an `IN (...)` list. Callers must skip the whole
 * plan when there are no runs to delete: `IN ()` is a SQLite syntax error, and
 * there would be nothing to do anyway.
 */
function idList(runIds: readonly string[]): SQL {
  return sql.join(
    runIds.map((runId) => sql`${runId}`),
    sql`, `,
  );
}

/** Rows carrying one of the deleted run ids themselves. */
function byRunId(runIds: readonly string[]): SQL {
  return sql`run_id IN (${idList(runIds)})`;
}

/** The review attempts made by the runs being deleted. */
function runScopedAttemptIds(runIds: readonly string[]): SQL {
  return sql`SELECT id FROM review_attempts WHERE run_id IN (${idList(runIds)})`;
}

/**
 * The review reports those attempts produced. Two levels deep on purpose:
 * `review_reports` carries an `attempt_id`, never a `run_id`, so resolving it
 * against the run ids directly matches nothing and leaves the reports behind.
 */
function runScopedReportIds(runIds: readonly string[]): SQL {
  return sql`SELECT id FROM review_reports WHERE attempt_id IN (${runScopedAttemptIds(runIds)})`;
}

/** The artifacts written by the runs being deleted. */
function runScopedArtifactIds(runIds: readonly string[]): SQL {
  return sql`SELECT id FROM artifacts WHERE run_id IN (${idList(runIds)})`;
}

export interface RunDeleteStep {
  /** Physical table name, as declared in schema.ts. */
  readonly table: string;
  /** Which of the table's rows belong to the runs being deleted. */
  readonly where: (runIds: readonly string[]) => SQL;
}

/**
 * A change-scoped row that outlives the run it points at, and the column that
 * has to let go. These are provenance pointers, not ownership: `review_state`
 * is one row per change and `change_provider_sessions` is one row per
 * change+provider+kind, so deleting either would discard state that belongs to
 * the runs that survive the rework.
 */
export interface RunPointerClear {
  readonly table: string;
  readonly column: string;
  /** The table the column points at -- the edge the test severs before recomputing the closure. */
  readonly references: string;
  readonly where: (runIds: readonly string[]) => SQL;
}

export const RUN_POINTER_CLEARS: readonly RunPointerClear[] = [
  {
    table: "change_provider_sessions",
    column: "last_run_id",
    references: "runs",
    where: (runIds) => sql`last_run_id IN (${idList(runIds)})`,
  },
  {
    table: "review_state",
    column: "latest_attempt_id",
    references: "review_attempts",
    where: (runIds) => sql`latest_attempt_id IN (${runScopedAttemptIds(runIds)})`,
  },
  {
    table: "review_state",
    column: "latest_report_id",
    references: "review_reports",
    where: (runIds) => sql`latest_report_id IN (${runScopedReportIds(runIds)})`,
  },
  {
    table: "review_state",
    column: "latest_valid_review_report_id",
    references: "review_reports",
    where: (runIds) => sql`latest_valid_review_report_id IN (${runScopedReportIds(runIds)})`,
  },
  // A QA run records which review report authorised it. When that report is
  // reworked away the QA result is stale, not void: merge-readiness-service
  // already reads a null `source_review_report_id` as the P1 blocker
  // "QA source Review report is stale", so clearing the pointer lands the run
  // in a state the gate understands. Deleting the qa_runs row instead would
  // take its command results, evidence and failures with it -- an entire QA
  // ledger discarded as a side effect of reworking Build.
  {
    table: "qa_runs",
    column: "source_review_report_id",
    references: "review_reports",
    where: (runIds) => sql`source_review_report_id IN (${runScopedReportIds(runIds)})`,
  },
];

/**
 * Ordered so that every table is emptied before the tables it references.
 * `runs` is last: it is what the whole plan exists to make deletable.
 */
export const RUN_DELETE_PLAN: readonly RunDeleteStep[] = [
  {
    table: "review_prior_finding_reviews",
    where: (runIds) => sql`
      attempt_id IN (${runScopedAttemptIds(runIds)})
        OR prior_finding_id IN (SELECT id FROM findings WHERE run_id IN (${idList(runIds)}))
        OR replacement_finding_id IN (SELECT id FROM findings WHERE run_id IN (${idList(runIds)}))
    `,
  },
  {
    table: "review_artifact_mirrors",
    where: (runIds) => sql`
      report_id IN (${runScopedReportIds(runIds)})
        OR artifact_id IN (${runScopedArtifactIds(runIds)})
    `,
  },
  { table: "review_reports", where: (runIds) => sql`attempt_id IN (${runScopedAttemptIds(runIds)})` },

  // findings.review_attempt_id also points into this closure, but every writer
  // stamps a finding with the run of the attempt that produced it, so a finding
  // and its attempt are always in the same run and die together here.
  { table: "findings", where: byRunId },

  {
    table: "release_note_state",
    where: (runIds) => sql`
      run_id IN (${idList(runIds)})
        OR artifact_id IN (${runScopedArtifactIds(runIds)})
    `,
  },
  {
    table: "review_attempts",
    where: (runIds) => sql`
      run_id IN (${idList(runIds)})
        OR raw_output_artifact_id IN (${runScopedArtifactIds(runIds)})
    `,
  },

  { table: "artifacts", where: byRunId },
  { table: "events", where: byRunId },
  { table: "provider_run_processes", where: byRunId },
  { table: "build_run_records", where: byRunId },

  // No foreign key backs this one -- see the header. It is deleted by the same
  // predicate anyway: run ids are prefixed per ledger (`RUN-…` here versus
  // `STG-RUN-…` for stage_runs), so `run_id IN (…)` cannot reach an assessment
  // that belongs to a different ledger.
  { table: "rubric_assessments", where: byRunId },

  { table: "runs", where: (runIds) => sql`id IN (${idList(runIds)})` },
];
