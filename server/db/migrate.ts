import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const MIGRATIONS_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), "server", "db", "migrations");

interface JournalEntry {
  idx: number;
  tag: string;
}

interface Journal {
  entries: JournalEntry[];
}

/**
 * Errors that mean a statement's effect already exists. Caught so the runner is
 * self-healing on databases that were previously hand-migrated (the original
 * failure mode: columns added manually, no migration record, next ALTER crashes).
 */
function isAlreadyAppliedError(message: string): boolean {
  return (
    message.includes("already exists") ||
    message.includes("duplicate column name")
  );
}

function readJournal(): JournalEntry[] {
  const journalPath = path.join(MIGRATIONS_DIR, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as Journal;
  return [...journal.entries].sort((a, b) => a.idx - b.idx);
}

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tableExists(sqlite: Database.Database, tableName: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function columnNames(sqlite: Database.Database, tableName: string): Set<string> {
  return new Set(
    (
      sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
    ).map((column) => column.name)
  );
}

function addMissingColumn(
  sqlite: Database.Database,
  tableName: string,
  columns: Set<string>,
  columnName: string,
  definition: string
): void {
  if (columns.has(columnName)) return;
  sqlite.exec(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
  columns.add(columnName);
}

function repairReviewDbContractSchema(sqlite: Database.Database): void {
  if (tableExists(sqlite, "build_run_records")) {
    const columns = columnNames(sqlite, "build_run_records");
    addMissingColumn(sqlite, "build_run_records", columns, "run_id", "TEXT");
    addMissingColumn(sqlite, "build_run_records", columns, "build_run_id", "TEXT");
    addMissingColumn(sqlite, "build_run_records", columns, "head_sha", "TEXT");
    addMissingColumn(sqlite, "build_run_records", columns, "base_head_sha", "TEXT");
    addMissingColumn(sqlite, "build_run_records", columns, "base_commit", "TEXT");
    addMissingColumn(sqlite, "build_run_records", columns, "patch_hash", "TEXT");
    addMissingColumn(sqlite, "build_run_records", columns, "changed_files_hash", "TEXT");
    addMissingColumn(sqlite, "build_run_records", columns, "adopted_head_sha", "TEXT");
    addMissingColumn(sqlite, "build_run_records", columns, "adoption_decision_id", "TEXT");
    addMissingColumn(sqlite, "build_run_records", columns, "adopted_at", "TEXT");
    addMissingColumn(sqlite, "build_run_records", columns, "artifact_hash", "TEXT");
    addMissingColumn(
      sqlite,
      "build_run_records",
      columns,
      "source",
      "TEXT NOT NULL DEFAULT 'unknown'"
    );
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS `idx_build_run_records_change_status_adopted` ON `build_run_records` (`change_id`, `status`, `adopted_at`)"
    );
  }

  if (tableExists(sqlite, "review_attempts")) {
    const columns = columnNames(sqlite, "review_attempts");
    addMissingColumn(sqlite, "review_attempts", columns, "run_id", "TEXT");
    addMissingColumn(
      sqlite,
      "review_attempts",
      columns,
      "provider",
      "TEXT NOT NULL DEFAULT 'codex'"
    );
    addMissingColumn(
      sqlite,
      "review_attempts",
      columns,
      "review_status",
      "TEXT NOT NULL DEFAULT 'running'"
    );
    addMissingColumn(sqlite, "review_attempts", columns, "source_build_run_id", "TEXT");
    addMissingColumn(sqlite, "review_attempts", columns, "source_head_sha", "TEXT");
    addMissingColumn(sqlite, "review_attempts", columns, "input_source_db_hash", "TEXT");
    addMissingColumn(sqlite, "review_attempts", columns, "input_source_lineage_json", "TEXT");
    addMissingColumn(
      sqlite,
      "review_attempts",
      columns,
      "prior_blocking_finding_ids_json",
      "TEXT"
    );
    addMissingColumn(sqlite, "review_attempts", columns, "raw_output_artifact_id", "TEXT");
    addMissingColumn(sqlite, "review_attempts", columns, "error_code", "TEXT");
    addMissingColumn(sqlite, "review_attempts", columns, "sanitized_error_summary", "TEXT");
    addMissingColumn(sqlite, "review_attempts", columns, "ended_at", "TEXT");
    addMissingColumn(sqlite, "review_attempts", columns, "completed_at", "TEXT");
    sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS `uq_review_attempts_change_attempt_no` ON `review_attempts` (`change_id`, `attempt_no`)"
    );
    sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS `uq_review_attempts_change_idempotency_key` ON `review_attempts` (`change_id`, `idempotency_key`)"
    );
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS `idx_review_attempts_change_status` ON `review_attempts` (`change_id`, `status`)"
    );
    sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS `uq_review_attempts_one_running_per_change` ON `review_attempts` (`change_id`) WHERE `status` = 'running'"
    );
  }

  if (tableExists(sqlite, "review_prior_finding_reviews")) {
    const columns = columnNames(sqlite, "review_prior_finding_reviews");
    addMissingColumn(sqlite, "review_prior_finding_reviews", columns, "evidence", "TEXT");
    addMissingColumn(sqlite, "review_prior_finding_reviews", columns, "required_fix", "TEXT");
    addMissingColumn(
      sqlite,
      "review_prior_finding_reviews",
      columns,
      "replacement_finding_id",
      "TEXT"
    );
    addMissingColumn(sqlite, "review_prior_finding_reviews", columns, "reviewer_notes", "TEXT");
    sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS `uq_review_prior_finding_reviews_attempt_prior` ON `review_prior_finding_reviews` (`attempt_id`, `prior_finding_id`)"
    );
  }

  if (tableExists(sqlite, "techspec_snapshots")) {
    const columns = columnNames(sqlite, "techspec_snapshots");
    addMissingColumn(sqlite, "techspec_snapshots", columns, "content_json", "TEXT");
  }

  if (tableExists(sqlite, "api_snapshots")) {
    const columns = columnNames(sqlite, "api_snapshots");
    addMissingColumn(sqlite, "api_snapshots", columns, "contract_json", "TEXT");
  }

  if (tableExists(sqlite, "plan_snapshots")) {
    const columns = columnNames(sqlite, "plan_snapshots");
    addMissingColumn(sqlite, "plan_snapshots", columns, "plan_name", "TEXT");
    addMissingColumn(sqlite, "plan_snapshots", columns, "test_plan_json", "TEXT");
    addMissingColumn(sqlite, "plan_snapshots", columns, "model_risks_json", "TEXT");
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS testplan_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      change_id TEXT NOT NULL,
      status TEXT NOT NULL,
      test_intent TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      approval_state TEXT NOT NULL DEFAULT 'pending',
      approved_at TEXT,
      approval_decision_id TEXT,
      snapshot_db_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS testplan_coverage_items (
      id TEXT PRIMARY KEY NOT NULL,
      testplan_snapshot_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      title TEXT NOT NULL,
      requirement_ref TEXT,
      test_type TEXT NOT NULL,
      priority TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS testplan_risk_mappings (
      id TEXT PRIMARY KEY NOT NULL,
      testplan_snapshot_id TEXT NOT NULL,
      coverage_item_key TEXT NOT NULL,
      risk_ref TEXT NOT NULL,
      severity TEXT NOT NULL,
      mitigation TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS testplan_manual_checks (
      id TEXT PRIMARY KEY NOT NULL,
      testplan_snapshot_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      required INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_testplan_snapshots_change_status_created ON testplan_snapshots (change_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_testplan_coverage_snapshot_key ON testplan_coverage_items (testplan_snapshot_id, item_key);
    CREATE INDEX IF NOT EXISTS idx_testplan_risk_mappings_snapshot_coverage ON testplan_risk_mappings (testplan_snapshot_id, coverage_item_key);
    CREATE INDEX IF NOT EXISTS idx_testplan_manual_checks_snapshot_required ON testplan_manual_checks (testplan_snapshot_id, required);
  `);
}

/**
 * Apply every migration listed in the drizzle journal that has not yet been
 * recorded in __migrations. Idempotent: safe to run on a fresh DB, an existing
 * fully-migrated DB, or a partially hand-migrated DB.
 */
export function runMigrations(sqlite: Database.Database): { applied: string[] } {
  // A migration that rebuilds a table has to turn foreign keys off for the
  // drop-and-rename (0024 does), and PRAGMA is connection state, not statement
  // state -- so without this the migration would silently hand the caller a
  // different setting than the one it opened with. Callers make that choice
  // deliberately in both directions: createDatabaseHandle turns them ON, and
  // several tests turn them OFF so they can migrate an in-memory database and
  // then insert partial fixtures. Restoring means neither is overwritten by
  // whatever the last migration happened to leave behind.
  const foreignKeysWereEnabled = sqlite.pragma("foreign_keys", { simple: true }) === 1;
  try {
    return runMigrationsInner(sqlite);
  } finally {
    sqlite.pragma(`foreign_keys = ${foreignKeysWereEnabled ? "ON" : "OFF"}`);
  }
}

function runMigrationsInner(sqlite: Database.Database): { applied: string[] } {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS __migrations (
      tag TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`
  );

  const recorded = new Set(
    (sqlite.prepare("SELECT tag FROM __migrations").all() as Array<{ tag: string }>).map(
      (r) => r.tag
    )
  );

  const record = sqlite.prepare(
    "INSERT OR IGNORE INTO __migrations (tag, applied_at) VALUES (?, ?)"
  );

  const applied: string[] = [];

  for (const entry of readJournal()) {
    if (recorded.has(entry.tag)) continue;

    const sqlPath = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlPath)) continue;

    const statements = splitStatements(fs.readFileSync(sqlPath, "utf-8"));
    for (const statement of statements) {
      try {
        sqlite.exec(statement);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isAlreadyAppliedError(message)) {
          throw new Error(`Migration ${entry.tag} failed: ${message}`);
        }
      }
    }

    record.run(entry.tag, new Date().toISOString());
    applied.push(entry.tag);
  }

  repairReviewDbContractSchema(sqlite);

  return { applied };
}
