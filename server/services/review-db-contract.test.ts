import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

import { runMigrations } from "../db/migrate.ts";

const migrationsDir = path.join(process.cwd(), "server", "db", "migrations");

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function runMigrationsBeforeReviewContract(sqlite: Database.Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS __migrations (
      tag TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  );

  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf-8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  const record = sqlite.prepare("INSERT OR IGNORE INTO __migrations (tag, applied_at) VALUES (?, ?)");

  for (const entry of entries) {
    if (entry.tag === "0012_review_db_contract") break;

    const sqlPath = path.join(migrationsDir, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlPath)) continue;

    for (const statement of splitStatements(fs.readFileSync(sqlPath, "utf-8"))) {
      sqlite.exec(statement);
    }
    record.run(entry.tag, "2026-06-29T00:00:00.000Z");
  }
}

function freshDb(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO projects (id, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("PRJ-1", "Project", "/tmp/project", "2026-06-29T00:00:00.000Z", "2026-06-29T00:00:00.000Z");
  sqlite
    .prepare(
      "INSERT INTO changes (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("CHG-1", "PRJ-1", "Change", "IMPLEMENTED", "2026-06-29T00:00:00.000Z", "2026-06-29T00:00:00.000Z");
  return sqlite;
}

function insertReviewAttempt(
  sqlite: Database.Database,
  values: { id: string; status?: string; attemptNo?: number; changeId?: string; idempotencyKey?: string },
): void {
  sqlite
    .prepare(
      `INSERT INTO review_attempts (
        id,
        change_id,
        attempt_no,
        status,
        idempotency_key,
        started_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      values.id,
      values.changeId ?? "CHG-1",
      values.attemptNo ?? 1,
      values.status ?? "running",
      values.idempotencyKey ?? values.id,
      "2026-06-29T00:00:00.000Z",
      "2026-06-29T00:00:00.000Z",
      "2026-06-29T00:00:00.000Z",
    );
}

function insertFinding(
  sqlite: Database.Database,
  overrides: {
    id: string;
    source?: string;
    severity?: string;
    evidence?: string | null;
    requiredFix?: string | null;
    reviewAttemptId?: string | null;
    waivable?: number;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO findings (
        id,
        change_id,
        source,
        severity,
        category,
        title,
        evidence,
        required_fix,
        status,
        created_at,
        review_attempt_id,
        waivable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.id,
      "CHG-1",
      overrides.source ?? "review",
      overrides.severity ?? "P1",
      "correctness",
      "Finding",
      overrides.evidence ?? null,
      overrides.requiredFix ?? null,
      "open",
      "2026-06-29T00:00:00.000Z",
      overrides.reviewAttemptId ?? null,
      overrides.waivable ?? 0,
    );
}

describe("review DB contract", () => {
  it("preserves existing findings and applies additive defaults when 0012 runs", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrationsBeforeReviewContract(sqlite);
    sqlite
      .prepare(
        "INSERT INTO projects (id, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "PRJ-OLD",
        "Project",
        "/tmp/project-old",
        "2026-06-29T00:00:00.000Z",
        "2026-06-29T00:00:00.000Z",
      );
    sqlite
      .prepare(
        "INSERT INTO changes (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "CHG-OLD",
        "PRJ-OLD",
        "Old Change",
        "IMPLEMENTED",
        "2026-06-29T00:00:00.000Z",
        "2026-06-29T00:00:00.000Z",
      );
    sqlite
      .prepare(
        `INSERT INTO findings (
          id,
          change_id,
          source,
          severity,
          category,
          title,
          status,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "FND-OLD",
        "CHG-OLD",
        "review",
        "P1",
        "correctness",
        "Legacy finding without DB review evidence",
        "open",
        "2026-06-29T00:00:00.000Z",
      );

    const result = runMigrations(sqlite);
    const finding = sqlite
      .prepare(
        `SELECT id, review_attempt_id, waivable, finding_version
         FROM findings
         WHERE id = ?`,
      )
      .get("FND-OLD") as {
      id: string;
      review_attempt_id: string | null;
      waivable: number;
      finding_version: number;
    };

    assert.deepEqual(result.applied, [
      "0012_review_db_contract",
      "0013_db_first_pipeline",
      "0014_provider_run_lifecycle",
      "0015_pipeline_jobs",
      "0016_process_identity_fencing",
      "0017_provider_run_latest_index",
      "0018_pipeline_job_active_phase",
      "0019_per_action_provider_selection",
      "0020_release_note_state",
      "0021_plan_model_authored_fields",
      "0022_briefing_question_rounds",
      "0023_rubric_core",
    ]);
    assert.equal(finding.id, "FND-OLD");
    assert.equal(finding.review_attempt_id, null);
    assert.equal(finding.waivable, 0);
    assert.equal(finding.finding_version, 1);
  });

  it("allows reviewAttemptId only on review findings", () => {
    const sqlite = freshDb();
    insertReviewAttempt(sqlite, { id: "RAT-1" });

    assert.throws(
      () =>
        insertFinding(sqlite, {
          id: "FND-1",
          source: "lint",
          severity: "P2",
          reviewAttemptId: "RAT-1",
        }),
      /CHECK constraint failed/,
    );
  });

  it("requires evidence and requiredFix for P0/P1 review findings", () => {
    const sqlite = freshDb();
    insertReviewAttempt(sqlite, { id: "RAT-1" });

    assert.throws(
      () =>
        insertFinding(sqlite, {
          id: "FND-1",
          severity: "P1",
          reviewAttemptId: "RAT-1",
          evidence: "clear evidence",
          requiredFix: null,
        }),
      /CHECK constraint failed/,
    );
  });

  it("allows waivable=1 only for P1 review findings", () => {
    const sqlite = freshDb();
    insertReviewAttempt(sqlite, { id: "RAT-1" });

    assert.throws(
      () =>
        insertFinding(sqlite, {
          id: "FND-1",
          severity: "P0",
          reviewAttemptId: "RAT-1",
          evidence: "clear evidence",
          requiredFix: "fix it",
          waivable: 1,
        }),
      /CHECK constraint failed/,
    );

    assert.doesNotThrow(() =>
      insertFinding(sqlite, {
        id: "FND-2",
        severity: "P1",
        reviewAttemptId: "RAT-1",
        evidence: "clear evidence",
        requiredFix: "fix it",
        waivable: 1,
      }),
    );
  });

  it("allows only one running review attempt per change", () => {
    const sqlite = freshDb();

    insertReviewAttempt(sqlite, { id: "RAT-1", attemptNo: 1, status: "running" });
    assert.throws(
      () => insertReviewAttempt(sqlite, { id: "RAT-2", attemptNo: 2, status: "running" }),
      /UNIQUE constraint failed/,
    );
    assert.doesNotThrow(() =>
      insertReviewAttempt(sqlite, { id: "RAT-3", attemptNo: 3, status: "queued" }),
    );
  });

  it("supports baseline build record, report, state, mirror, and prior finding inserts", () => {
    const sqlite = freshDb();
    sqlite
      .prepare(
        "INSERT INTO runs (id, change_id, phase, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "RUN-BUILD-1",
        "CHG-1",
        "build",
        "completed",
        "2026-06-29T00:00:00.000Z",
        "2026-06-29T00:01:00.000Z",
      );
    sqlite
      .prepare(
        `INSERT INTO build_run_records (
          id,
          change_id,
          run_id,
          build_run_id,
          status,
          head_sha,
          adopted_at,
          artifact_hash,
          source,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "BRR-1",
        "CHG-1",
        "RUN-BUILD-1",
        "BUILD-1",
        "adopted",
        "abc123",
        "2026-06-29T00:02:00.000Z",
        "hash-build",
        "db",
        "2026-06-29T00:02:00.000Z",
        "2026-06-29T00:02:00.000Z",
      );
    sqlite
      .prepare(
        "INSERT INTO runs (id, change_id, phase, status, started_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("RUN-REVIEW-1", "CHG-1", "review", "running", "2026-06-29T00:03:00.000Z");
    sqlite
      .prepare(
        "INSERT INTO artifacts (id, change_id, run_id, type, path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "ART-RAW-1",
        "CHG-1",
        "RUN-REVIEW-1",
        "review_raw_output",
        ".ship/review/raw-output.json",
        "2026-06-29T00:03:30.000Z",
      );
    sqlite
      .prepare(
        `INSERT INTO review_attempts (
          id,
          change_id,
          run_id,
          attempt_no,
          status,
          provider,
          review_status,
          idempotency_key,
          source_build_run_id,
          source_head_sha,
          prior_blocking_finding_ids_json,
          raw_output_artifact_id,
          started_at,
          ended_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "RAT-10",
        "CHG-1",
        "RUN-REVIEW-1",
        10,
        "completed",
        "codex",
        "issues_found",
        "idem-10",
        "BUILD-1",
        "abc123",
        '["FND-PRIOR"]',
        "ART-RAW-1",
        "2026-06-29T00:03:00.000Z",
        "2026-06-29T00:04:00.000Z",
        "2026-06-29T00:03:00.000Z",
        "2026-06-29T00:04:00.000Z",
      );
    insertFinding(sqlite, {
      id: "FND-PRIOR",
      source: "review",
      severity: "P1",
      evidence: "prior evidence",
      requiredFix: "fix prior issue",
      reviewAttemptId: "RAT-10",
    });
    insertFinding(sqlite, {
      id: "FND-REPLACEMENT",
      source: "review",
      severity: "P1",
      evidence: "replacement evidence",
      requiredFix: "fix replacement issue",
      reviewAttemptId: "RAT-10",
    });
    sqlite
      .prepare(
        `INSERT INTO review_reports (
          id,
          attempt_id,
          change_id,
          report_version,
          review_conclusion,
          report_db_hash,
          gate_status,
          qa_allowed,
          source_build_run_id,
          source_head_sha,
          finding_version,
          waiver_version,
          blocking_p0,
          blocking_p1,
          waived_p1,
          p2_count,
          findings_db_hash,
          stale_reason,
          legacy_state,
          generated_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "RPT-1",
        "RAT-10",
        "CHG-1",
        1,
        "issues_found",
        "report-hash",
        "blocked_p1",
        0,
        "BUILD-1",
        "abc123",
        1,
        1,
        0,
        1,
        0,
        0,
        "findings-hash",
        null,
        "none",
        "2026-06-29T00:04:30.000Z",
        "2026-06-29T00:04:30.000Z",
      );
    sqlite
      .prepare(
        `INSERT INTO review_state (
          change_id,
          latest_attempt_id,
          latest_attempt_no,
          latest_valid_review_report_id,
          latest_valid_attempt_no,
          gate_status,
          review_status,
          source_build_run_id,
          source_head_sha,
          report_db_hash,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "CHG-1",
        "RAT-10",
        10,
        "RPT-1",
        10,
        "blocked_p1",
        "issues_found",
        "BUILD-1",
        "abc123",
        "report-hash",
        "2026-06-29T00:05:00.000Z",
      );
    sqlite
      .prepare(
        "INSERT INTO artifacts (id, change_id, run_id, type, path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "ART-REPORT-1",
        "CHG-1",
        "RUN-REVIEW-1",
        "review_report",
        ".ship/review-report.md",
        "2026-06-29T00:05:30.000Z",
      );
    sqlite
      .prepare(
        `INSERT INTO review_artifact_mirrors (
          id,
          report_id,
          change_id,
          artifact_id,
          kind,
          path,
          schema_version,
          source_db_hash,
          content_hash,
          mirror_status,
          last_checked_at,
          last_rebuilt_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "RAM-1",
        "RPT-1",
        "CHG-1",
        "ART-REPORT-1",
        "review_report",
        ".ship/review-report.md",
        "review-report/v1",
        "report-hash",
        "content-hash",
        "ok",
        "2026-06-29T00:06:00.000Z",
        "2026-06-29T00:05:30.000Z",
        "2026-06-29T00:05:30.000Z",
      );
    sqlite
      .prepare(
        `INSERT INTO review_prior_finding_reviews (
          id,
          attempt_id,
          prior_finding_id,
          verdict,
          evidence,
          required_fix,
          replacement_finding_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "RPFR-1",
        "RAT-10",
        "FND-PRIOR",
        "still_open",
        "prior still reproduces",
        "fix prior issue",
        "FND-REPLACEMENT",
        "2026-06-29T00:06:30.000Z",
      );

    const state = sqlite
      .prepare(
        `SELECT latest_attempt_no, latest_valid_review_report_id, finding_version, waiver_version
         FROM review_state
         WHERE change_id = ?`,
      )
      .get("CHG-1") as {
      latest_attempt_no: number;
      latest_valid_review_report_id: string;
      finding_version: number;
      waiver_version: number;
    };
    const mirror = sqlite
      .prepare("SELECT artifact_id, path, mirror_status FROM review_artifact_mirrors WHERE id = ?")
      .get("RAM-1") as { artifact_id: string; path: string; mirror_status: string };
    const buildRecord = sqlite
      .prepare("SELECT build_run_id, artifact_hash, source FROM build_run_records WHERE id = ?")
      .get("BRR-1") as { build_run_id: string; artifact_hash: string; source: string };

    assert.deepEqual(state, {
      latest_attempt_no: 10,
      latest_valid_review_report_id: "RPT-1",
      finding_version: 1,
      waiver_version: 1,
    });
    assert.deepEqual(mirror, {
      artifact_id: "ART-REPORT-1",
      path: ".ship/review-report.md",
      mirror_status: "ok",
    });
    assert.deepEqual(buildRecord, {
      build_run_id: "BUILD-1",
      artifact_hash: "hash-build",
      source: "db",
    });
  });
});
