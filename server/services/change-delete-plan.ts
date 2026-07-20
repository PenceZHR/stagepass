import { sql, type SQL } from "drizzle-orm";

/**
 * One table's share of a change deletion.
 *
 * `changes` has 37 tables pointing at it and schema.ts declares no ON DELETE
 * behaviour, so the cascade is ours to get right: every row that references a
 * change (directly, or through a parent row that does) must go before the row
 * it references, or SQLite raises SQLITE_CONSTRAINT_FOREIGNKEY.
 *
 * The order below is the contract. change-delete-plan.test.ts derives the real
 * foreign-key graph from schema.ts and fails if this list drifts from it, so a
 * new table that references a change cannot be added without landing here too.
 */
export interface ChangeDeleteStep {
  /** Physical table name, as declared in schema.ts. */
  readonly table: string;
  /** Which of the table's rows belong to the change being deleted. */
  readonly where: (changeId: string) => SQL;
}

/** Rows carrying the change id themselves. */
function byChangeId(changeId: string): SQL {
  return sql`change_id = ${changeId}`;
}

/** Rows reachable only through a parent row that carries the change id. */
function byParent(column: string, parentTable: string) {
  return (changeId: string): SQL =>
    sql`${sql.identifier(column)} IN (SELECT id FROM ${sql.identifier(parentTable)} WHERE change_id = ${changeId})`;
}

export const CHANGE_DELETE_PLAN: readonly ChangeDeleteStep[] = [
  {
    table: "review_prior_finding_reviews",
    where: (changeId) => sql`
      attempt_id IN (SELECT id FROM review_attempts WHERE change_id = ${changeId})
        OR prior_finding_id IN (SELECT id FROM findings WHERE change_id = ${changeId})
        OR replacement_finding_id IN (SELECT id FROM findings WHERE change_id = ${changeId})
    `,
  },
  { table: "review_artifact_mirrors", where: byChangeId },
  { table: "review_state", where: byChangeId },

  { table: "qa_failures", where: byParent("qa_run_id", "qa_runs") },
  { table: "qa_evidence", where: byParent("qa_run_id", "qa_runs") },
  { table: "qa_command_results", where: byParent("qa_run_id", "qa_runs") },
  { table: "qa_runs", where: byChangeId },

  { table: "merge_blockers", where: byParent("merge_readiness_id", "merge_readiness") },
  {
    table: "merge_decisions",
    where: (changeId) => sql`
      change_id = ${changeId}
        OR readiness_id IN (SELECT id FROM merge_readiness WHERE change_id = ${changeId})
    `,
  },
  { table: "merge_approvals", where: byChangeId },
  { table: "merge_readiness", where: byChangeId },

  { table: "plan_approvals", where: byParent("plan_snapshot_id", "plan_snapshots") },
  { table: "plan_risks", where: byParent("plan_snapshot_id", "plan_snapshots") },
  { table: "plan_steps", where: byParent("plan_snapshot_id", "plan_snapshots") },
  { table: "plan_snapshots", where: byChangeId },

  { table: "testplan_manual_checks", where: byParent("testplan_snapshot_id", "testplan_snapshots") },
  { table: "testplan_risk_mappings", where: byParent("testplan_snapshot_id", "testplan_snapshots") },
  { table: "testplan_coverage_items", where: byParent("testplan_snapshot_id", "testplan_snapshots") },
  { table: "testplan_snapshots", where: byChangeId },

  { table: "required_validation_commands", where: byChangeId },
  { table: "api_snapshots", where: byChangeId },
  { table: "techspec_snapshots", where: byChangeId },

  { table: "stage_states", where: byChangeId },
  { table: "stage_actions", where: byChangeId },
  { table: "stage_gates", where: byChangeId },
  { table: "stage_reports", where: byChangeId },
  { table: "stage_runs", where: byChangeId },
  { table: "legacy_imports", where: byChangeId },

  // qa_command_results.output_artifact_mirror_id and qa_evidence.artifact_mirror_id
  // point here, so the QA rows above must already be gone.
  { table: "artifact_mirrors", where: byChangeId },
  { table: "build_run_records", where: byChangeId },

  { table: "prd_drafts", where: byChangeId },
  { table: "briefing_questions", where: byChangeId },
  { table: "prd_briefings", where: byChangeId },

  { table: "red_fix_claims", where: byChangeId },
  { table: "blue_gap_reviews", where: byChangeId },
  { table: "war_reports", where: byChangeId },
  { table: "requirement_gaps", where: byChangeId },
  { table: "battle_rounds", where: byChangeId },

  { table: "findings", where: byChangeId },
  { table: "review_reports", where: byChangeId },
  { table: "review_attempts", where: byChangeId },
  { table: "human_decisions", where: byChangeId },
  // release_note_state.artifact_id -> artifacts.id and .run_id -> runs.id, so it
  // must be deleted before artifacts and runs below.
  { table: "release_note_state", where: byChangeId },
  // review_artifact_mirrors.artifact_id and review_attempts.raw_output_artifact_id
  // point here, so both must already be gone.
  { table: "artifacts", where: byChangeId },
  { table: "events", where: byChangeId },
  { table: "provider_run_processes", where: byChangeId },
  { table: "pipeline_jobs", where: byChangeId },
  { table: "change_provider_sessions", where: byChangeId },
  { table: "runs", where: byChangeId },
];
