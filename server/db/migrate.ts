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

const CODEX_NATIVE_FK_REBUILD_ORDER = [
  "pipeline_command_outbox",
  "codex_turn_executions",
  "codex_follower_start_attempts",
  "codex_binding_run_leases",
  "codex_logical_turns",
  "codex_interactions",
  "pipeline_command_receipts",
  "codex_thread_bindings",
  "project_ai_runs",
] as const;

const CODEX_NATIVE_EXPECTED_FOREIGN_KEYS: Record<
  (typeof CODEX_NATIVE_FK_REBUILD_ORDER)[number],
  readonly string[]
> = {
  pipeline_command_outbox: [
    "command_id->pipeline_command_receipts.command_id",
    "interaction_id->codex_interactions.id",
  ],
  codex_turn_executions: [
    "start_attempt_id->codex_follower_start_attempts.attempt_id",
    "logical_turn_id->codex_logical_turns.logical_turn_id",
    "pipeline_job_id->pipeline_jobs.id",
    "project_ai_run_id->project_ai_runs.id",
  ],
  codex_follower_start_attempts: [
    "logical_turn_id->codex_logical_turns.logical_turn_id",
    "pipeline_job_id->pipeline_jobs.id",
    "project_ai_run_id->project_ai_runs.id",
  ],
  codex_binding_run_leases: [
    "binding_id->codex_thread_bindings.binding_id",
  ],
  codex_logical_turns: [
    "pipeline_job_id->pipeline_jobs.id",
    "project_ai_run_id->project_ai_runs.id",
    "binding_id->codex_thread_bindings.binding_id",
    "interaction_id->codex_interactions.id",
    "command_id->pipeline_command_receipts.command_id",
  ],
  codex_interactions: [
    "change_id->changes.id",
    "binding_id->codex_thread_bindings.binding_id",
  ],
  pipeline_command_receipts: [
    "change_id->changes.id",
  ],
  codex_thread_bindings: [
    "project_id->projects.id",
    "change_id->changes.id",
  ],
  project_ai_runs: [
    "project_id->projects.id",
  ],
};

function foreignKeySignatures(
  sqlite: Database.Database,
  tableName: string,
): Set<string> {
  return new Set(
    (
      sqlite.prepare(`PRAGMA foreign_key_list("${tableName}")`).all() as Array<{
        table: string;
        from: string;
        to: string;
      }>
    ).map((row) => `${row.from}->${row.table}.${row.to}`),
  );
}

function canonicalCodexNativeCreateStatement(tableName: string): string {
  const sqlPath = path.join(MIGRATIONS_DIR, "0028_codex_native_control_plane.sql");
  const statement = splitStatements(fs.readFileSync(sqlPath, "utf-8")).find((candidate) =>
    candidate.startsWith(`CREATE TABLE IF NOT EXISTS \`${tableName}\``)
  );
  if (!statement) {
    throw new Error(`Missing canonical 0028 CREATE TABLE for ${tableName}`);
  }
  return statement;
}

/**
 * SQLite cannot add a missing table-level FK with ALTER TABLE.  Replay repair
 * therefore rebuilds only defective 0028-owned tables from their canonical DDL,
 * child-first, while preserving every common column and row.
 */
function repairCodexNativeForeignKeys(sqlite: Database.Database): void {
  const defective = CODEX_NATIVE_FK_REBUILD_ORDER.filter((tableName) => {
    if (!tableExists(sqlite, tableName)) return false;
    const actual = foreignKeySignatures(sqlite, tableName);
    return CODEX_NATIVE_EXPECTED_FOREIGN_KEYS[tableName].some((fk) => !actual.has(fk));
  });
  if (defective.length === 0) return;

  const foreignKeysWereEnabled = sqlite.pragma("foreign_keys", { simple: true }) === 1;
  const legacyAlterTableWasEnabled =
    sqlite.pragma("legacy_alter_table", { simple: true }) === 1;
  sqlite.pragma("foreign_keys = OFF");
  sqlite.pragma("legacy_alter_table = ON");
  try {
    for (const tableName of defective) {
      const temporaryName = `__0028_fk_repair_${tableName}`;
      if (tableExists(sqlite, temporaryName)) {
        throw new Error(`Stale 0028 repair table exists: ${temporaryName}`);
      }
      sqlite.exec(`ALTER TABLE "${tableName}" RENAME TO "${temporaryName}"`);
      sqlite.exec(canonicalCodexNativeCreateStatement(tableName));

      const oldColumns = columnNames(sqlite, temporaryName);
      const newColumns = [...columnNames(sqlite, tableName)];
      const commonColumns = newColumns.filter((column) => oldColumns.has(column));
      if (commonColumns.length === 0) {
        throw new Error(`Cannot preserve rows while repairing ${tableName}`);
      }
      const quotedColumns = commonColumns.map((column) => `"${column}"`).join(", ");
      sqlite.exec(
        `INSERT INTO "${tableName}" (${quotedColumns}) SELECT ${quotedColumns} FROM "${temporaryName}"`,
      );
      sqlite.exec(`DROP TABLE "${temporaryName}"`);
    }

    const migrationStatements = splitStatements(
      fs.readFileSync(
        path.join(MIGRATIONS_DIR, "0028_codex_native_control_plane.sql"),
        "utf-8",
      ),
    );
    for (const statement of migrationStatements) {
      if (
        /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS /.test(statement) ||
        /^CREATE TRIGGER IF NOT EXISTS /.test(statement)
      ) {
        sqlite.exec(statement);
      }
    }
  } finally {
    sqlite.pragma(`legacy_alter_table = ${legacyAlterTableWasEnabled ? "ON" : "OFF"}`);
    sqlite.pragma(`foreign_keys = ${foreignKeysWereEnabled ? "ON" : "OFF"}`);
  }

  const violations = sqlite.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("0028 FK repair left foreign-key violations");
  }
}

const CODEX_NATIVE_LEGACY_TABLE_FOREIGN_KEYS = {
  pipeline_jobs: [
    ["interaction_id", "codex_interactions", "id"],
    ["command_id", "pipeline_command_receipts", "command_id"],
  ],
  human_decisions: [
    ["interaction_id", "codex_interactions", "id"],
    ["command_id", "pipeline_command_receipts", "command_id"],
  ],
} as const;

type CodexNativeLegacyTable = keyof typeof CODEX_NATIVE_LEGACY_TABLE_FOREIGN_KEYS;

function addReferenceToCreateSql(
  createSql: string,
  columnName: string,
  targetTable: string,
  targetColumn: string,
): string {
  const columnToken = `(?:\`${columnName}\`|"${columnName}"|\\[${columnName}\\]|${columnName})`;
  const referencePattern = new RegExp(
    `${columnToken}\\s+TEXT\\s+REFERENCES\\s+(?:\`${targetTable}\`|"${targetTable}"|\\[${targetTable}\\]|${targetTable})`,
    "i",
  );
  if (referencePattern.test(createSql)) return createSql;

  const columnPattern = new RegExp(`(${columnToken}\\s+TEXT)(?!\\s+REFERENCES)`, "i");
  if (!columnPattern.test(createSql)) {
    throw new Error(`Cannot locate ${columnName} in legacy table DDL`);
  }
  return createSql.replace(
    columnPattern,
    `$1 REFERENCES \`${targetTable}\`(\`${targetColumn}\`)`,
  );
}

function rebuildLegacyTableWithNativeForeignKeys(
  sqlite: Database.Database,
  tableName: CodexNativeLegacyTable,
): void {
  const createRow = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql: string | null } | undefined;
  if (!createRow?.sql) throw new Error(`Missing CREATE TABLE SQL for ${tableName}`);

  let repairedCreateSql = createRow.sql;
  for (const [columnName, targetTable, targetColumn] of
    CODEX_NATIVE_LEGACY_TABLE_FOREIGN_KEYS[tableName]) {
    repairedCreateSql = addReferenceToCreateSql(
      repairedCreateSql,
      columnName,
      targetTable,
      targetColumn,
    );
  }

  const schemaObjects = sqlite
    .prepare(`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL
      ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END, name
    `)
    .all(tableName) as Array<{ type: "index" | "trigger"; name: string; sql: string }>;
  const columns = [...columnNames(sqlite, tableName)];
  const quotedColumns = columns.map((column) => `"${column}"`).join(", ");
  const temporaryName = `__0028_legacy_fk_repair_${tableName}`;
  if (tableExists(sqlite, temporaryName)) {
    throw new Error(`Stale 0028 repair table exists: ${temporaryName}`);
  }

  sqlite.exec(`ALTER TABLE "${tableName}" RENAME TO "${temporaryName}"`);
  sqlite.exec(repairedCreateSql);
  sqlite.exec(
    `INSERT INTO "${tableName}" (${quotedColumns}) SELECT ${quotedColumns} FROM "${temporaryName}"`,
  );
  sqlite.exec(`DROP TABLE "${temporaryName}"`);
  for (const object of schemaObjects) sqlite.exec(object.sql);
}

/**
 * `pipeline_jobs` and `human_decisions` predate 0028, so their canonical DDL
 * cannot be reconstructed from the additive migration.  Preserve their exact
 * live CREATE TABLE body and every explicit index/trigger, injecting only the
 * two missing 0028 references into each table.
 */
function repairCodexNativeLegacyTableForeignKeys(sqlite: Database.Database): void {
  const defective = (
    Object.keys(CODEX_NATIVE_LEGACY_TABLE_FOREIGN_KEYS) as CodexNativeLegacyTable[]
  ).filter((tableName) => {
    if (!tableExists(sqlite, tableName)) return false;
    const actual = foreignKeySignatures(sqlite, tableName);
    return CODEX_NATIVE_LEGACY_TABLE_FOREIGN_KEYS[tableName].some(
      ([columnName, targetTable, targetColumn]) =>
        !actual.has(`${columnName}->${targetTable}.${targetColumn}`),
    );
  });
  if (defective.length === 0) return;

  const foreignKeysWereEnabled = sqlite.pragma("foreign_keys", { simple: true }) === 1;
  const legacyAlterTableWasEnabled =
    sqlite.pragma("legacy_alter_table", { simple: true }) === 1;
  sqlite.pragma("foreign_keys = OFF");
  sqlite.pragma("legacy_alter_table = ON");
  try {
    sqlite.transaction(() => {
      // Both are parents of 0028-native rows; rebuilding after the native
      // child tables have been repaired keeps the overall repair child-first.
      for (const tableName of defective) {
        rebuildLegacyTableWithNativeForeignKeys(sqlite, tableName);
      }
    })();
  } finally {
    sqlite.pragma(`legacy_alter_table = ${legacyAlterTableWasEnabled ? "ON" : "OFF"}`);
    sqlite.pragma(`foreign_keys = ${foreignKeysWereEnabled ? "ON" : "OFF"}`);
  }

  const violations = sqlite.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error("0028 legacy-table FK repair left foreign-key violations");
  }
}

/**
 * Completes the additive 0028 shape when an installation contains a
 * hand-applied subset but no migration receipt.  New native tables are created
 * by the migration DDL itself; this repair owns the legacy-table columns and
 * the indexes/triggers whose CREATE statements are safely replayable.
 */
export function repairCodexNativeControlPlaneSchema(sqlite: Database.Database): void {
  if (tableExists(sqlite, "projects")) {
    const columns = columnNames(sqlite, "projects");
    addMissingColumn(sqlite, "projects", columns, "default_codex_model", "TEXT");
    addMissingColumn(sqlite, "projects", columns, "default_reasoning_effort", "TEXT");
  }
  if (tableExists(sqlite, "changes")) {
    const columns = columnNames(sqlite, "changes");
    addMissingColumn(sqlite, "changes", columns, "codex_model", "TEXT");
    addMissingColumn(sqlite, "changes", columns, "reasoning_effort", "TEXT");
  }
  if (tableExists(sqlite, "human_decisions")) {
    const columns = columnNames(sqlite, "human_decisions");
    addMissingColumn(
      sqlite,
      "human_decisions",
      columns,
      "interaction_id",
      "TEXT REFERENCES codex_interactions(id)",
    );
    addMissingColumn(
      sqlite,
      "human_decisions",
      columns,
      "actor_surface",
      "TEXT CHECK (actor_surface IS NULL OR actor_surface IN ('codex_mcp_app','stagepass_web_emergency','stagepass_web_ops','legacy_web_migration','recovery'))",
    );
    addMissingColumn(sqlite, "human_decisions", columns, "codex_thread_id", "TEXT");
    addMissingColumn(
      sqlite,
      "human_decisions",
      columns,
      "command_id",
      "TEXT REFERENCES pipeline_command_receipts(command_id)",
    );
  }
  if (tableExists(sqlite, "pipeline_jobs")) {
    const columns = columnNames(sqlite, "pipeline_jobs");
    addMissingColumn(
      sqlite,
      "pipeline_jobs",
      columns,
      "job_kind",
      "TEXT NOT NULL DEFAULT 'stage' CHECK (job_kind IN ('stage','interaction_present','interaction_wakeup'))",
    );
    addMissingColumn(sqlite, "pipeline_jobs", columns, "effect_type", "TEXT");
    addMissingColumn(
      sqlite,
      "pipeline_jobs",
      columns,
      "interaction_id",
      "TEXT REFERENCES codex_interactions(id)",
    );
    addMissingColumn(
      sqlite,
      "pipeline_jobs",
      columns,
      "command_id",
      "TEXT REFERENCES pipeline_command_receipts(command_id)",
    );
    addMissingColumn(sqlite, "pipeline_jobs", columns, "effect_schema_version", "TEXT");
    addMissingColumn(sqlite, "pipeline_jobs", columns, "effect_payload_json", "TEXT");
    addMissingColumn(
      sqlite,
      "pipeline_jobs",
      columns,
      "next_turn_ordinal",
      "INTEGER NOT NULL DEFAULT 0",
    );
    addMissingColumn(sqlite, "pipeline_jobs", columns, "effect_deadline_at", "TEXT");
  }

  repairCodexNativeForeignKeys(sqlite);
  repairCodexNativeLegacyTableForeignKeys(sqlite);

  sqlite.exec(`
    DROP INDEX IF EXISTS uq_pipeline_jobs_one_active_change_phase;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_jobs_one_active_change_phase
      ON pipeline_jobs (change_id, phase)
      WHERE job_kind = 'stage' AND status IN ('queued','leased','running');
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_jobs_interaction_present_effect
      ON pipeline_jobs (interaction_id, effect_type)
      WHERE job_kind = 'interaction_present';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_jobs_interaction_wakeup_effect
      ON pipeline_jobs (command_id, effect_type)
      WHERE job_kind = 'interaction_wakeup';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_thread_bindings_scope
      ON codex_thread_bindings (scope_kind, scope_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_thread_bindings_thread
      ON codex_thread_bindings (thread_id) WHERE thread_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_logical_turns_pipeline_slot
      ON codex_logical_turns (pipeline_job_id, phase, role, round, ordinal)
      WHERE pipeline_job_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_logical_turns_project_slot
      ON codex_logical_turns (project_ai_run_id, phase, role, round, ordinal)
      WHERE project_ai_run_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_logical_turns_turn_slot
      ON codex_logical_turns (turn_slot);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_logical_turns_correlation
      ON codex_logical_turns (run_correlation_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_turn_executions_start_attempt
      ON codex_turn_executions (start_attempt_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_turn_executions_logical_turn
      ON codex_turn_executions (logical_turn_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_codex_turn_executions_thread_turn
      ON codex_turn_executions (thread_id, turn_id);
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

    if (entry.tag === "0028_codex_native_control_plane") {
      repairCodexNativeControlPlaneSchema(sqlite);
    }

    record.run(entry.tag, new Date().toISOString());
    applied.push(entry.tag);
  }

  repairReviewDbContractSchema(sqlite);

  return { applied };
}
