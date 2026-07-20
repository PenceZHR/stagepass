import assert from "node:assert/strict";
import type Database from "better-sqlite3";

export function tableNames(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

export function columnNames(sqlite: Database.Database, tableName: string): string[] {
  return (
    sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  ).map((column) => column.name);
}

export function assertColumns(
  sqlite: Database.Database,
  tableName: string,
  expectedColumns: string[],
): void {
  const columns = columnNames(sqlite, tableName);
  for (const column of expectedColumns) {
    assert.ok(columns.includes(column), `${tableName}.${column} should exist`);
  }
}

export const dbFirstPipelineTables = [
  "stage_states",
  "stage_runs",
  "stage_reports",
  "stage_gates",
  "stage_actions",
  "artifact_mirrors",
  "legacy_imports",
  "plan_snapshots",
  "plan_steps",
  "plan_risks",
  "plan_approvals",
  "required_validation_commands",
  "testplan_snapshots",
  "testplan_coverage_items",
  "testplan_risk_mappings",
  "testplan_manual_checks",
  "techspec_snapshots",
  "api_snapshots",
  "qa_runs",
  "qa_command_results",
  "qa_failures",
  "qa_evidence",
  "merge_readiness",
  "merge_blockers",
  "merge_approvals",
  "merge_decisions",
] as const;

export const dbFirstPipelineColumnAssertions: Record<string, string[]> = {
  stage_states: [
    "change_id",
    "phase",
    "status",
    "latest_run_id",
    "latest_report_id",
    "latest_gate_id",
    "latest_valid_report_id",
    "db_hash",
    "version",
    "updated_at",
  ],
  stage_runs: [
    "change_id",
    "phase",
    "attempt_no",
    "status",
    "idempotency_key",
    "input_db_hash",
    "output_db_hash",
    "source_lineage_json",
    "error_code",
    "started_at",
    "completed_at",
  ],
  stage_reports: [
    "change_id",
    "phase",
    "source_run_id",
    "status",
    "counts_json",
    "is_fresh",
    "stale_reason",
    "report_db_hash",
    "generated_at",
  ],
  stage_gates: [
    "change_id",
    "phase",
    "status",
    "blockers_json",
    "freshness_json",
    "required_actions_json",
    "source_db_hash",
    "gate_version",
    "computed_at",
  ],
  stage_actions: [
    "change_id",
    "phase",
    "action_id",
    "enabled",
    "reason_code",
    "reason",
    "blockers_json",
    "gate_version",
    "source_db_hash",
    "requires_idempotency_key",
    "computed_at",
  ],
  artifact_mirrors: [
    "change_id",
    "phase",
    "artifact_type",
    "path",
    "content_hash",
    "source_db_hash",
    "schema_version",
    "mirror_status",
    "generated_at",
  ],
  legacy_imports: [
    "change_id",
    "phase",
    "source_path",
    "source_artifact_hash",
    "schema_version",
    "import_status",
    "import_result_json",
    "imported_at",
  ],
  plan_snapshots: [
    "change_id",
    "status",
    "expected_files_json",
    "forbidden_files_json",
    "approval_decision_id",
    "snapshot_db_hash",
  ],
  plan_steps: ["plan_snapshot_id", "step_no", "expected_files_json", "status"],
  plan_risks: [
    "plan_snapshot_id",
    "severity",
    "evidence",
    "required_plan_change",
    "status",
  ],
  plan_approvals: ["plan_snapshot_id", "decision_id", "actor", "approved_at"],
  required_validation_commands: [
    "change_id",
    "phase",
    "command",
    "command_order",
    "required",
  ],
  testplan_snapshots: [
    "change_id",
    "status",
    "test_intent",
    "schema_version",
    "approval_state",
    "approved_at",
    "approval_decision_id",
    "snapshot_db_hash",
  ],
  testplan_coverage_items: [
    "testplan_snapshot_id",
    "item_key",
    "title",
    "requirement_ref",
    "test_type",
    "priority",
    "status",
  ],
  testplan_risk_mappings: [
    "testplan_snapshot_id",
    "coverage_item_key",
    "risk_ref",
    "severity",
    "mitigation",
  ],
  testplan_manual_checks: [
    "testplan_snapshot_id",
    "title",
    "description",
    "required",
    "status",
  ],
  techspec_snapshots: [
    "change_id",
    "status",
    "source_spec_hash",
    "content_json",
    "content_db_hash",
    "schema_version",
  ],
  api_snapshots: [
    "change_id",
    "status",
    "source_techspec_hash",
    "contract_json",
    "contract_db_hash",
    "schema_version",
  ],
  qa_runs: [
    "change_id",
    "source_review_report_id",
    "source_build_run_id",
    "source_head_sha",
    "status",
  ],
  qa_command_results: ["qa_run_id", "command", "command_order", "status", "exit_code"],
  qa_failures: ["qa_run_id", "severity", "evidence", "required_fix", "status"],
  qa_evidence: ["qa_run_id", "evidence_type", "artifact_mirror_id", "content_hash"],
  merge_readiness: [
    "change_id",
    "status",
    "source_db_hash",
    "source_head_sha",
    "blockers_json",
  ],
  merge_blockers: [
    "merge_readiness_id",
    "blocker_type",
    "severity",
    "source_table",
    "source_id",
  ],
  merge_approvals: ["change_id", "decision_id", "actor", "approved_at"],
  merge_decisions: ["change_id", "readiness_id", "decision_type", "actor", "reason"],
  build_run_records: [
    "base_head_sha",
    "base_commit",
    "patch_hash",
    "changed_files_hash",
    "adopted_head_sha",
    "adoption_decision_id",
    "adopted_at",
  ],
};

export function assertDbFirstPipelineFoundation(sqlite: Database.Database): void {
  const tables = tableNames(sqlite);
  for (const table of dbFirstPipelineTables) {
    assert.ok(tables.includes(table), `${table} should exist`);
    assertColumns(sqlite, table, dbFirstPipelineColumnAssertions[table]);
  }
  assertColumns(sqlite, "build_run_records", dbFirstPipelineColumnAssertions.build_run_records);
}
