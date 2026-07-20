import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  assertColumns,
  assertDbFirstPipelineFoundation,
  dbFirstPipelineColumnAssertions,
} from "../db/db-first-foundation-assertions.ts";
import { runMigrations } from "../db/migrate.ts";

const authoritativeTables = [
  "stage_states",
  "stage_runs",
  "stage_reports",
  "stage_gates",
  "stage_actions",
  "human_decisions",
  "findings",
  "artifact_mirrors",
  "legacy_imports",
  "plan_snapshots",
  "plan_steps",
  "plan_risks",
  "plan_approvals",
  "techspec_snapshots",
  "api_snapshots",
  "required_validation_commands",
  "qa_runs",
  "qa_command_results",
  "qa_failures",
  "qa_evidence",
  "merge_readiness",
  "merge_blockers",
  "merge_approvals",
  "merge_decisions",
];

const phases = ["PRD", "Spec", "Plan", "TestPlan", "Build", "Review", "QA", "Merge"];

function tableExists(sqlite: Database.Database, tableName: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function createDb(): Database.Database {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite);
  return sqlite;
}

function seedChange(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT INTO projects (id, name, repo_path, created_at, updated_at)
       VALUES ('PRJ-DBFIRST', 'DB First', '/tmp/db-first', '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO changes (id, project_id, title, status, created_at, updated_at)
       VALUES ('CHG-DBFIRST', 'PRJ-DBFIRST', 'DB-first pipeline', 'active', '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO runs (id, change_id, phase, status, started_at)
       VALUES ('RUN-BUILD', 'CHG-DBFIRST', 'Build', 'passed', '2026-06-29T00:01:00.000Z')`,
    )
    .run();
}

function seedStageAuthority(sqlite: Database.Database): void {
  const state = sqlite.prepare(
    `INSERT INTO stage_states (
      id, change_id, phase, status, latest_gate_id, db_hash, version, updated_at
    ) VALUES (?, 'CHG-DBFIRST', ?, 'ready', ?, ?, 1, '2026-06-29T00:02:00.000Z')`,
  );
  const gate = sqlite.prepare(
    `INSERT INTO stage_gates (
      id, change_id, phase, status, blockers_json, freshness_json, required_actions_json,
      source_db_hash, gate_version, computed_at
    ) VALUES (?, 'CHG-DBFIRST', ?, 'pass', '[]', '{"fresh":true}', '[]', ?, 1, '2026-06-29T00:02:00.000Z')`,
  );
  const action = sqlite.prepare(
    `INSERT INTO stage_actions (
      id, change_id, phase, action_id, enabled, reason_code, reason, blockers_json,
      gate_version, source_db_hash, requires_idempotency_key, computed_at
    ) VALUES (?, 'CHG-DBFIRST', ?, ?, 1, 'ready', 'Stage action is allowed', '[]', 1, ?, 1, '2026-06-29T00:02:00.000Z')`,
  );

  for (const phase of phases) {
    const gateId = `GATE-${phase}`;
    const sourceHash = `db-hash-${phase}`;
    state.run(`STATE-${phase}`, phase, gateId, sourceHash);
    gate.run(gateId, phase, sourceHash);
    action.run(`ACTION-${phase}`, phase, `continue_${phase.toLowerCase()}`, sourceHash);
  }
}

function seedPlan(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT INTO human_decisions (
        id, change_id, gate, action, reason, created_by, created_at
      ) VALUES ('DEC-PLAN', 'CHG-DBFIRST', 'Plan', 'approve', 'Task 1 scope approved', 'blue', '2026-06-29T00:03:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO plan_snapshots (
        id, change_id, status, source_spec_hash, expected_files_json, forbidden_files_json,
        validation_policy_hash, approved_at, approval_decision_id, snapshot_db_hash, created_at
      ) VALUES (
        'PLAN-SNAP-1', 'CHG-DBFIRST', 'approved', 'spec-hash', '["server/db/schema.ts"]',
        '[".ship/current.json"]', 'validation-hash', '2026-06-29T00:03:00.000Z',
        'DEC-PLAN', 'plan-db-hash', '2026-06-29T00:03:00.000Z'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO plan_steps (
        id, plan_snapshot_id, step_no, title, description, expected_files_json, status, created_at
      ) VALUES ('PLAN-STEP-1', 'PLAN-SNAP-1', 1, 'DB foundation', 'Create DB tables', '["server/db/schema.ts"]', 'ready', '2026-06-29T00:03:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO plan_risks (
        id, plan_snapshot_id, severity, category, title, evidence, required_plan_change, status, created_at
      ) VALUES ('PLAN-RISK-1', 'PLAN-SNAP-1', 'medium', 'migration', 'Runner journal missing', '0013 requires journal entry', 'Add journal context', 'open', '2026-06-29T00:03:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO plan_approvals (id, plan_snapshot_id, decision_id, actor, approved_at)
       VALUES ('PLAN-APPROVAL-1', 'PLAN-SNAP-1', 'DEC-PLAN', 'blue', '2026-06-29T00:03:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO required_validation_commands (
        id, change_id, phase, source_snapshot_id, command, command_order, required, created_at
      ) VALUES
        ('CMD-1', 'CHG-DBFIRST', 'Task1', 'PLAN-SNAP-1', 'git diff --check -- server/db/schema.ts', 2, 1, '2026-06-29T00:03:00.000Z'),
        ('CMD-0', 'CHG-DBFIRST', 'Task1', 'PLAN-SNAP-1', './node_modules/.bin/tsx --test server/db/migrate.test.ts server/services/db-first-pipeline-contract.test.ts', 1, 1, '2026-06-29T00:03:00.000Z')`,
    )
    .run();
}

function seedBuildReviewQaMerge(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT INTO build_run_records (
        id, change_id, run_id, build_run_id, status, head_sha, base_head_sha, base_commit,
        patch_hash, changed_files_hash, adopted_head_sha, adoption_decision_id, adopted_at,
        artifact_hash, source, created_at, updated_at
      ) VALUES (
        'BUILD-1', 'CHG-DBFIRST', 'RUN-BUILD', 'build-run-1', 'adopted', 'head-sha',
        'base-head-sha', 'base-commit', 'patch-hash', 'changed-files-hash', 'adopted-head-sha',
        'DEC-PLAN', '2026-06-29T00:04:00.000Z', 'artifact-hash', 'db-first-contract',
        '2026-06-29T00:04:00.000Z', '2026-06-29T00:04:00.000Z'
      )`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO review_attempts (
        id, change_id, run_id, attempt_no, status, idempotency_key, started_at, created_at, updated_at
      ) VALUES ('RA-1', 'CHG-DBFIRST', 'RUN-BUILD', 1, 'passed', 'review-key-1', '2026-06-29T00:05:00.000Z', '2026-06-29T00:05:00.000Z', '2026-06-29T00:05:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO review_reports (
        id, attempt_id, change_id, report_version, report_db_hash, gate_status, generated_at, created_at
      ) VALUES ('REVIEW-REPORT-1', 'RA-1', 'CHG-DBFIRST', 1, 'review-db-hash', 'pass', '2026-06-29T00:05:00.000Z', '2026-06-29T00:05:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO artifact_mirrors (
        id, change_id, phase, artifact_type, path, content_hash, source_db_hash,
        schema_version, mirror_status, generated_at
      ) VALUES ('MIRROR-QA-1', 'CHG-DBFIRST', 'QA', 'qa_log', '/tmp/qa.log', 'qa-content-hash', 'qa-db-hash', 'qa/v1', 'matched', '2026-06-29T00:06:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO qa_runs (
        id, change_id, source_review_report_id, source_build_run_id, source_head_sha, status, started_at, completed_at
      ) VALUES ('QA-RUN-1', 'CHG-DBFIRST', 'REVIEW-REPORT-1', 'BUILD-1', 'adopted-head-sha', 'failed', '2026-06-29T00:06:00.000Z', '2026-06-29T00:07:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO qa_command_results (
        id, qa_run_id, command, command_order, status, exit_code, duration_ms, output_artifact_mirror_id, completed_at
      ) VALUES ('QA-CMD-1', 'QA-RUN-1', 'npm test', 1, 'failed', 1, 1000, 'MIRROR-QA-1', '2026-06-29T00:07:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO qa_failures (
        id, qa_run_id, command_result_id, severity, title, evidence, required_fix, status, created_at
      ) VALUES ('QA-FAIL-1', 'QA-RUN-1', 'QA-CMD-1', 'P1', 'Test failure', 'npm test failed', 'Fix failing test', 'open', '2026-06-29T00:07:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO qa_evidence (id, qa_run_id, evidence_type, artifact_mirror_id, content_hash, created_at)
       VALUES ('QA-EVIDENCE-1', 'QA-RUN-1', 'log', 'MIRROR-QA-1', 'qa-content-hash', '2026-06-29T00:07:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO merge_readiness (
        id, change_id, status, source_db_hash, source_head_sha, blockers_json, computed_at
      ) VALUES ('MERGE-READY-1', 'CHG-DBFIRST', 'blocked', 'merge-source-db-hash', 'adopted-head-sha', '["QA-FAIL-1"]', '2026-06-29T00:08:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO merge_blockers (
        id, merge_readiness_id, blocker_type, severity, title, source_table, source_id, created_at
      ) VALUES ('MERGE-BLOCKER-1', 'MERGE-READY-1', 'qa_failure', 'P1', 'QA failed', 'qa_failures', 'QA-FAIL-1', '2026-06-29T00:08:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO merge_approvals (id, change_id, decision_id, actor, approved_at)
       VALUES ('MERGE-APPROVAL-1', 'CHG-DBFIRST', 'DEC-PLAN', 'blue', '2026-06-29T00:08:00.000Z')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO merge_decisions (
        id, change_id, readiness_id, decision_type, actor, reason, created_at
      ) VALUES ('MERGE-DECISION-1', 'CHG-DBFIRST', 'MERGE-READY-1', 'hold', 'blue', 'QA blocker remains', '2026-06-29T00:08:00.000Z')`,
    )
    .run();
}

describe("db-first pipeline contract", () => {
  it("keeps stage authority in DB tables instead of artifact mirrors", () => {
    const sqlite = createDb();

    assertDbFirstPipelineFoundation(sqlite);
    for (const table of authoritativeTables) {
      assert.ok(tableExists(sqlite, table), `${table} should exist as an authoritative DB table`);
    }
    for (const table of [
      "plan_snapshots",
      "plan_steps",
      "plan_risks",
      "plan_approvals",
      "qa_runs",
      "qa_command_results",
      "qa_failures",
      "qa_evidence",
      "merge_readiness",
      "merge_blockers",
      "merge_approvals",
      "merge_decisions",
    ]) {
      assertColumns(sqlite, table, dbFirstPipelineColumnAssertions[table]);
    }

    seedChange(sqlite);
    seedStageAuthority(sqlite);
    seedPlan(sqlite);
    sqlite
      .prepare(
        `INSERT INTO techspec_snapshots (
          id, change_id, status, source_spec_hash, content_db_hash, schema_version, reviewed_at, created_at
        ) VALUES ('TECHSPEC-1', 'CHG-DBFIRST', 'approved', 'spec-hash', 'techspec-db-hash', 'techspec/v1', '2026-06-29T00:03:30.000Z', '2026-06-29T00:03:30.000Z')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO api_snapshots (
          id, change_id, status, source_techspec_hash, contract_db_hash, schema_version, reviewed_at, created_at
        ) VALUES ('API-1', 'CHG-DBFIRST', 'approved', 'techspec-db-hash', 'api-db-hash', 'api/v1', '2026-06-29T00:03:40.000Z', '2026-06-29T00:03:40.000Z')`,
    )
      .run();
    seedBuildReviewQaMerge(sqlite);

    const gateBeforeMirrorMismatch = sqlite
      .prepare(
        `SELECT status, source_db_hash, gate_version, required_actions_json
         FROM stage_gates
         WHERE id = 'GATE-Merge'`,
      )
      .get() as
      | {
          status: string;
          source_db_hash: string;
          gate_version: number;
          required_actions_json: string;
        }
      | undefined;
    const actionBeforeMirrorMismatch = sqlite
      .prepare(
        `SELECT enabled, source_db_hash, gate_version, blockers_json, requires_idempotency_key
         FROM stage_actions
         WHERE id = 'ACTION-Merge'`,
      )
      .get() as
      | {
          enabled: number;
          source_db_hash: string;
          gate_version: number;
          blockers_json: string;
          requires_idempotency_key: number;
        }
      | undefined;
    assert.deepEqual(gateBeforeMirrorMismatch, {
      status: "pass",
      source_db_hash: "db-hash-Merge",
      gate_version: 1,
      required_actions_json: "[]",
    });
    assert.deepEqual(actionBeforeMirrorMismatch, {
      enabled: 1,
      source_db_hash: "db-hash-Merge",
      gate_version: 1,
      blockers_json: "[]",
      requires_idempotency_key: 1,
    });

    sqlite
      .prepare(
        `INSERT INTO artifact_mirrors (
          id, change_id, phase, artifact_type, path, content_hash, source_db_hash,
          schema_version, mirror_status, generated_at
        ) VALUES ('MIRROR-MISMATCH-1', 'CHG-DBFIRST', 'Merge', 'gate_report', '/tmp/stale-merge-gate.json', 'stale-content-hash', 'mirror-only-db-hash', 'gate/v1', 'mismatch', '2026-06-29T00:09:00.000Z')`,
      )
      .run();

    const mismatchMirror = sqlite
      .prepare(
        `SELECT path, content_hash, source_db_hash, mirror_status
         FROM artifact_mirrors
         WHERE id = 'MIRROR-MISMATCH-1'`,
      )
      .get() as
      | {
          path: string;
          content_hash: string;
          source_db_hash: string;
          mirror_status: string;
        }
      | undefined;
    assert.deepEqual(mismatchMirror, {
      path: "/tmp/stale-merge-gate.json",
      content_hash: "stale-content-hash",
      source_db_hash: "mirror-only-db-hash",
      mirror_status: "mismatch",
    });
    assert.notEqual(mismatchMirror?.source_db_hash, gateBeforeMirrorMismatch?.source_db_hash);

    const gateAfterMirrorMismatch = sqlite
      .prepare(
        `SELECT status, source_db_hash, gate_version, required_actions_json
         FROM stage_gates
         WHERE id = 'GATE-Merge'`,
      )
      .get();
    const actionAfterMirrorMismatch = sqlite
      .prepare(
        `SELECT enabled, source_db_hash, gate_version, blockers_json, requires_idempotency_key
         FROM stage_actions
         WHERE id = 'ACTION-Merge'`,
      )
      .get();
    assert.deepEqual(gateAfterMirrorMismatch, gateBeforeMirrorMismatch);
    assert.deepEqual(actionAfterMirrorMismatch, actionBeforeMirrorMismatch);

    const approvedPlanRows = sqlite
      .prepare(
        `SELECT ps.id AS snapshot_id, ps.expected_files_json, pstep.step_no
         FROM plan_snapshots ps
         JOIN plan_steps pstep ON pstep.plan_snapshot_id = ps.id
         WHERE ps.change_id = 'CHG-DBFIRST' AND ps.status = 'approved'
         ORDER BY pstep.step_no`,
      )
      .all() as Array<{ snapshot_id: string; expected_files_json: string; step_no: number }>;
    assert.deepEqual(approvedPlanRows.map((row) => row.step_no), [1]);
    assert.equal(approvedPlanRows[0]?.snapshot_id, "PLAN-SNAP-1");

    const commands = sqlite
      .prepare(
        `SELECT command FROM required_validation_commands
         WHERE change_id = 'CHG-DBFIRST' AND phase = 'Task1'
         ORDER BY command_order`,
      )
      .all() as Array<{ command: string }>;
    assert.deepEqual(commands.map((row) => row.command), [
      "./node_modules/.bin/tsx --test server/db/migrate.test.ts server/services/db-first-pipeline-contract.test.ts",
      "git diff --check -- server/db/schema.ts",
    ]);

    const qaLineage = sqlite
      .prepare(
        `SELECT qr.source_review_report_id, qr.source_build_run_id, qcr.command, qcr.status
         FROM qa_runs qr
         JOIN qa_command_results qcr ON qcr.qa_run_id = qr.id
         WHERE qr.id = 'QA-RUN-1'`,
      )
      .get() as
      | {
          source_review_report_id: string;
          source_build_run_id: string;
          command: string;
          status: string;
        }
      | undefined;
    assert.deepEqual(qaLineage, {
      source_review_report_id: "REVIEW-REPORT-1",
      source_build_run_id: "BUILD-1",
      command: "npm test",
      status: "failed",
    });

    const mergeReadiness = sqlite
      .prepare("SELECT id, status FROM merge_readiness WHERE source_db_hash = ?")
      .get("merge-source-db-hash") as { id: string; status: string } | undefined;
    assert.deepEqual(mergeReadiness, { id: "MERGE-READY-1", status: "blocked" });

    const buildAdoption = sqlite
      .prepare(
        `SELECT patch_hash, changed_files_hash, adopted_head_sha
         FROM build_run_records
         WHERE change_id = 'CHG-DBFIRST' AND status = 'adopted'`,
      )
      .get() as
      | {
          patch_hash: string;
          changed_files_hash: string;
          adopted_head_sha: string;
        }
      | undefined;
    assert.deepEqual(buildAdoption, {
      patch_hash: "patch-hash",
      changed_files_hash: "changed-files-hash",
      adopted_head_sha: "adopted-head-sha",
    });
  });
});
