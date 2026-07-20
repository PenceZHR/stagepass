import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  assertColumns,
  assertDbFirstPipelineFoundation,
  columnNames,
  dbFirstPipelineTables,
  tableNames,
} from "./db-first-foundation-assertions.ts";
import { runMigrations } from "./migrate.ts";

function indexNames(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("migration runner", () => {
  it("applies the complete schema to a fresh database", () => {
    const sqlite = new Database(":memory:");

    const result = runMigrations(sqlite);

    for (const table of [
      "projects",
      "changes",
      "runs",
      "events",
      "artifacts",
      "release_note_state",
      "findings",
      "battle_rounds",
      "requirement_gaps",
      "red_fix_claims",
      "blue_gap_reviews",
      "human_decisions",
      "war_reports",
      "prd_briefings",
      "briefing_questions",
      "prd_drafts",
      "review_attempts",
      "review_reports",
      "review_state",
      "review_artifact_mirrors",
      "review_prior_finding_reviews",
      "build_run_records",
      "provider_run_processes",
      "pipeline_jobs",
      "change_provider_sessions",
      ...dbFirstPipelineTables,
      "__migrations",
    ]) {
      assert.ok(tableNames(sqlite).includes(table), `${table} should exist`);
    }
    assertColumns(sqlite, "projects", [
      "context_status",
      "context_provider",
      "prd_status",
      "prd_provider",
      "prd_json",
      "prd_markdown",
      "git_enabled",
      "git_default_branch",
    ]);
    assertColumns(sqlite, "changes", [
      "provider",
      "blocked_phase",
      "rework_from_phase",
      "suspended_by_prd",
      "pre_suspend_status",
      "git_branch",
      "gate_state",
      "docs_complete",
      "retro_done",
    ]);
    assertColumns(sqlite, "runs", [
      "job_id",
      "worker_id",
      "lease_token",
      "attempt_no",
      "provider",
    ]);
    assertColumns(sqlite, "findings", [
      "round_id",
      "phase",
      "updated_at",
      "review_attempt_id",
      "source_build_run_id",
      "source_head_sha",
      "waivable",
      "waived_by",
      "waived_at",
      "waiver_decision_id",
      "legacy_state",
      "legacy_finding_key",
      "finding_version",
    ]);
    assertColumns(sqlite, "review_attempts", [
      "id",
      "change_id",
      "run_id",
      "attempt_no",
      "status",
      "provider",
      "review_status",
      "idempotency_key",
      "source_build_run_id",
      "source_head_sha",
      "prior_blocking_finding_ids_json",
      "raw_output_artifact_id",
      "error_code",
      "sanitized_error_summary",
      "started_at",
      "ended_at",
      "completed_at",
      "created_at",
      "updated_at",
    ]);
    assertColumns(sqlite, "review_reports", [
      "id",
      "attempt_id",
      "change_id",
      "report_version",
      "review_conclusion",
      "report_db_hash",
      "gate_status",
      "qa_allowed",
      "source_build_run_id",
      "source_head_sha",
      "finding_version",
      "waiver_version",
      "blocking_p0",
      "blocking_p1",
      "waived_p1",
      "p2_count",
      "findings_db_hash",
      "stale_reason",
      "legacy_state",
      "report_json",
      "generated_at",
      "created_at",
    ]);
    assertColumns(sqlite, "review_state", [
      "change_id",
      "latest_attempt_id",
      "latest_attempt_no",
      "latest_report_id",
      "latest_valid_review_report_id",
      "latest_valid_attempt_no",
      "gate_status",
      "review_status",
      "source_build_run_id",
      "source_head_sha",
      "report_db_hash",
      "finding_version",
      "waiver_version",
      "updated_at",
    ]);
    assertColumns(sqlite, "review_artifact_mirrors", [
      "id",
      "report_id",
      "change_id",
      "artifact_id",
      "kind",
      "path",
      "schema_version",
      "source_db_hash",
      "content_hash",
      "mirror_status",
      "last_checked_at",
      "last_rebuilt_at",
      "error_code",
      "artifact_path",
      "artifact_hash",
      "created_at",
    ]);
    assertColumns(sqlite, "review_prior_finding_reviews", [
      "id",
      "attempt_id",
      "prior_finding_id",
      "verdict",
      "evidence",
      "required_fix",
      "replacement_finding_id",
      "reviewer_notes",
      "created_at",
    ]);
    assertColumns(sqlite, "build_run_records", [
      "id",
      "change_id",
      "run_id",
      "build_run_id",
      "status",
      "head_sha",
      "base_head_sha",
      "base_commit",
      "patch_hash",
      "changed_files_hash",
      "adopted_head_sha",
      "adoption_decision_id",
      "adopted_at",
      "artifact_hash",
      "source",
      "created_at",
      "updated_at",
    ]);
    assertColumns(sqlite, "provider_run_processes", [
      "id",
      "change_id",
      "run_id",
      "phase",
      "provider",
      "pid",
      "ppid",
      "round_id",
      "status",
      "started_at",
      "last_heartbeat_at",
      "ended_at",
      "exit_code",
      "signal",
      "summary",
      "job_id",
      "worker_id",
      "lease_token",
      "attempt_no",
      "external_ref",
      "process_nonce",
      "process_start_time",
      "process_ppid",
      "process_pgid",
      "process_cwd",
      "process_command_json",
    ]);
    assertColumns(sqlite, "pipeline_jobs", [
      "id",
      "change_id",
      "phase",
      "action_id",
      "idempotency_key",
      "status",
      "leased_by",
      "lease_expires_at",
      "heartbeat_at",
      "attempt_no",
      "error_code",
      "error_summary",
      "created_at",
      "started_at",
      "ended_at",
      "lease_token",
      "worker_nonce",
      "provider",
    ]);
    assertColumns(sqlite, "stage_runs", ["provider"]);
    assertDbFirstPipelineFoundation(sqlite);
    for (const column of [
      "id",
      "change_id",
      "round_id",
      "gap_id",
      "canonical_gap_id",
      "claim_status",
      "claim_summary",
      "evidence",
      "artifact_path",
      "source_hashes_json",
      "created_at",
      "updated_at",
    ]) {
      assert.ok(
        columnNames(sqlite, "red_fix_claims").includes(column),
        `red_fix_claims.${column} should exist`,
      );
    }
    for (const column of [
      "id",
      "change_id",
      "round_id",
      "gap_id",
      "canonical_gap_id",
      "verdict",
      "review_summary",
      "evidence",
      "resolution_evidence",
      "downgraded_to",
      "source_hashes_json",
      "created_at",
      "updated_at",
    ]) {
      assert.ok(
        columnNames(sqlite, "blue_gap_reviews").includes(column),
        `blue_gap_reviews.${column} should exist`,
      );
    }
    for (const column of [
      "id",
      "change_id",
      "status",
      "intent_text",
      "final_review_json",
      "locked_at",
      "created_at",
      "updated_at",
    ]) {
      assert.ok(
        columnNames(sqlite, "prd_briefings").includes(column),
        `prd_briefings.${column} should exist`,
      );
    }
    for (const column of [
      "id",
      "change_id",
      "category",
      "severity",
      "question",
      "why_it_matters",
      "suggested_default",
      "status",
      "answer",
    ]) {
      assert.ok(
        columnNames(sqlite, "briefing_questions").includes(column),
        `briefing_questions.${column} should exist`,
      );
    }
    for (const column of [
      "id",
      "change_id",
      "version",
      "markdown",
      "source_question_ids_json",
      "unresolved_question_ids_json",
      "draft_hash",
    ]) {
      assert.ok(
        columnNames(sqlite, "prd_drafts").includes(column),
        `prd_drafts.${column} should exist`,
      );
    }
    assert.ok(result.applied.includes("0008_add_gate_fields"));
    assert.ok(result.applied.includes("0009_spec_battle_mvp"));
    assert.ok(result.applied.includes("0010_spec_battle_gap_ledger"));
    assert.ok(result.applied.includes("0011_prd_briefing_room"));
    assert.ok(result.applied.includes("0012_review_db_contract"));
    assert.ok(result.applied.includes("0013_db_first_pipeline"));
    assert.ok(result.applied.includes("0014_provider_run_lifecycle"));
    assert.ok(result.applied.includes("0015_pipeline_jobs"));
    assert.ok(result.applied.includes("0016_process_identity_fencing"));
    assert.ok(result.applied.includes("0017_provider_run_latest_index"));
    assert.ok(result.applied.includes("0020_release_note_state"));
    assertColumns(sqlite, "release_note_state", [
      "id",
      "change_id",
      "run_id",
      "artifact_id",
      "approved_content_hash",
      "created_at",
    ]);
    for (const index of [
      "uq_review_attempts_change_attempt_no",
      "uq_review_attempts_change_idempotency_key",
      "idx_review_attempts_change_status",
      "uq_review_attempts_one_running_per_change",
      "uq_review_reports_attempt_version",
      "uq_review_reports_attempt_db_hash",
      "idx_review_reports_change_gate_generated",
      "uq_review_prior_finding_reviews_attempt_prior",
      "idx_review_artifact_mirrors_report_kind",
      "idx_build_run_records_change_status_adopted",
      "idx_plan_snapshots_change_status_created",
      "idx_plan_steps_snapshot_step",
      "idx_required_validation_commands_change_phase_order",
      "idx_techspec_snapshots_change_status_created",
      "idx_api_snapshots_change_status_created",
      "idx_qa_runs_change_status_started",
      "idx_qa_command_results_run_order",
      "idx_merge_readiness_change_computed",
      "idx_provider_run_processes_status_pid",
      "idx_provider_run_processes_change_run",
      "uq_pipeline_jobs_change_action_idempotency",
      "idx_pipeline_jobs_status_lease",
      "idx_pipeline_jobs_change_created",
      "idx_pipeline_jobs_lease_fence",
      "idx_provider_run_processes_job_lease_attempt",
      "idx_provider_run_processes_process_identity",
      "idx_provider_run_processes_run_started_id",
      "uq_release_note_state_change_run",
    ]) {
      assert.ok(indexNames(sqlite).includes(index), `${index} should exist`);
    }

    const plan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT p.id
      FROM provider_run_processes AS p
      WHERE p.run_id IN ('RUN-1', 'RUN-2')
        AND NOT EXISTS (
          SELECT 1 FROM provider_run_processes AS newer
          WHERE newer.run_id = p.run_id
            AND (newer.started_at > p.started_at
              OR (newer.started_at = p.started_at AND newer.id > p.id))
        )
      ORDER BY p.started_at DESC, p.id DESC
      LIMIT 3
    `).all() as Array<{ detail: string }>;
    assert.equal(plan.some((row) =>
      row.detail.includes("idx_provider_run_processes_run_started_id")), true);
  });

  it("backfills immutable provider columns from the change default", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);
    sqlite.exec("INSERT INTO projects (id, name, repo_path, created_at, updated_at) VALUES ('p', 'P', '/tmp', 'now', 'now')");
    sqlite.exec("INSERT INTO changes (id, project_id, title, status, provider, created_at, updated_at) VALUES ('c', 'p', 'C', 'INTAKE_PENDING', 'claude', 'now', 'now')");
    sqlite.exec("INSERT INTO pipeline_jobs (id, change_id, phase, action_id, status, created_at) VALUES ('j', 'c', 'intake', 'run_prd', 'queued', 'now')");
    sqlite.exec("INSERT INTO runs (id, change_id, phase, status, started_at) VALUES ('r', 'c', 'intake', 'running', 'now')");
    sqlite.exec("INSERT INTO stage_runs (id, change_id, phase, attempt_no, status, started_at) VALUES ('s', 'c', 'PRD', 1, 'running', 'now')");

    // Re-running the migration must repair rows created without the new field.
    sqlite.prepare("DELETE FROM __migrations WHERE tag = '0019_per_action_provider_selection'").run();
    runMigrations(sqlite);

    assert.equal(sqlite.prepare("SELECT provider FROM pipeline_jobs WHERE id = 'j'").get().provider, "claude");
    assert.equal(sqlite.prepare("SELECT provider FROM runs WHERE id = 'r'").get().provider, "claude");
    assert.equal(sqlite.prepare("SELECT provider FROM stage_runs WHERE id = 's'").get().provider, "claude");
  });

  it("is idempotent when run repeatedly", () => {
    const sqlite = new Database(":memory:");

    runMigrations(sqlite);
    const second = runMigrations(sqlite);
    const migrationRows = sqlite.prepare("SELECT tag FROM __migrations").all();

    assert.deepEqual(second.applied, []);
    assert.equal(migrationRows.length, 22);
  });

  it("records a migration whose columns were already applied manually", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);
    sqlite
      .prepare("DELETE FROM __migrations WHERE tag = ?")
      .run("0008_add_gate_fields");

    const result = runMigrations(sqlite);
    const recorded = sqlite
      .prepare("SELECT tag FROM __migrations WHERE tag = ?")
      .all("0008_add_gate_fields");

    assert.deepEqual(result.applied, ["0008_add_gate_fields"]);
    assert.equal(recorded.length, 1);
  });

  it("records 0013 when build adoption columns already exist", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);
    sqlite
      .prepare("DELETE FROM __migrations WHERE tag = ?")
      .run("0013_db_first_pipeline");

    const result = runMigrations(sqlite);
    const recorded = sqlite
      .prepare("SELECT tag FROM __migrations WHERE tag = ?")
      .all("0013_db_first_pipeline");

    assert.deepEqual(result.applied, ["0013_db_first_pipeline"]);
    assert.equal(recorded.length, 1);
    assertDbFirstPipelineFoundation(sqlite);
  });

  it("repairs old 0012 build_run_records schemas that were already recorded", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);
    sqlite.exec("DROP TABLE build_run_records");
    sqlite.exec(`
      CREATE TABLE build_run_records (
        id TEXT PRIMARY KEY NOT NULL,
        change_id TEXT NOT NULL,
        run_id TEXT,
        status TEXT NOT NULL,
        head_sha TEXT,
        adopted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const result = runMigrations(sqlite);

    assert.deepEqual(result.applied, []);
    assertColumns(sqlite, "build_run_records", [
      "build_run_id",
      "base_head_sha",
      "base_commit",
      "patch_hash",
      "changed_files_hash",
      "adopted_head_sha",
      "adoption_decision_id",
      "artifact_hash",
      "source",
    ]);
    const sourceColumn = (
      sqlite.prepare("PRAGMA table_info(build_run_records)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>
    ).find((column) => column.name === "source");
    assert.equal(sourceColumn?.notnull, 1);
    assert.equal(sourceColumn?.dflt_value, "'unknown'");
    assert.ok(
      indexNames(sqlite).includes("idx_build_run_records_change_status_adopted"),
      "build_run_records adopted index should be repaired",
    );
  });

  it("repairs old recorded 0012 review schemas that are missing additive columns", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);
    sqlite.exec("DROP TABLE review_prior_finding_reviews");
    sqlite.exec("DROP TABLE review_attempts");
    sqlite.exec(`
      CREATE TABLE review_attempts (
        id TEXT PRIMARY KEY NOT NULL,
        change_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        source_build_run_id TEXT,
        source_head_sha TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE review_prior_finding_reviews (
        id TEXT PRIMARY KEY NOT NULL,
        attempt_id TEXT NOT NULL,
        prior_finding_id TEXT NOT NULL,
        verdict TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const result = runMigrations(sqlite);

    assert.deepEqual(result.applied, []);
    assertColumns(sqlite, "review_attempts", [
      "run_id",
      "provider",
      "review_status",
      "prior_blocking_finding_ids_json",
      "raw_output_artifact_id",
      "error_code",
      "sanitized_error_summary",
      "ended_at",
    ]);
    assertColumns(sqlite, "review_prior_finding_reviews", [
      "evidence",
      "required_fix",
      "replacement_finding_id",
      "reviewer_notes",
    ]);
    const attemptColumns = (
      sqlite.prepare("PRAGMA table_info(review_attempts)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>
    );
    const providerColumn = attemptColumns.find((column) => column.name === "provider");
    const reviewStatusColumn = attemptColumns.find((column) => column.name === "review_status");
    assert.equal(providerColumn?.notnull, 1);
    assert.equal(providerColumn?.dflt_value, "'codex'");
    assert.equal(reviewStatusColumn?.notnull, 1);
    assert.equal(reviewStatusColumn?.dflt_value, "'running'");
    assert.ok(
      indexNames(sqlite).includes("idx_review_attempts_change_status"),
      "review_attempts status index should be repaired",
    );
    assert.ok(
      indexNames(sqlite).includes("uq_review_prior_finding_reviews_attempt_prior"),
      "review prior finding unique index should be repaired",
    );
  });
});
