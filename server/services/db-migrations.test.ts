import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runMigrations } from "../db/migrate.ts";

function columnNames(sqlite: Database.Database, tableName: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

function tableNames(sqlite: Database.Database): string[] {
  return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function tableSql(sqlite: Database.Database, tableName: string): string {
  return (sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql: string }).sql;
}

function stripNativeForeignKeysForReplay(
  sqlite: Database.Database,
  tableName: "pipeline_jobs" | "human_decisions",
): void {
  const createSql = (sqlite.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
  ).get(tableName) as { sql: string }).sql
    .replace(
      /\s+REFERENCES\s+[`"]?codex_interactions[`"]?\s*\(\s*[`"]?id[`"]?\s*\)/gi,
      "",
    )
    .replace(
      /\s+REFERENCES\s+[`"]?pipeline_command_receipts[`"]?\s*\(\s*[`"]?command_id[`"]?\s*\)/gi,
      "",
    );
  const objects = sqlite.prepare(`
    SELECT sql FROM sqlite_master
    WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL
    ORDER BY type,name
  `).all(tableName) as Array<{ sql: string }>;
  const columns = columnNames(sqlite, tableName);
  const quoted = columns.map((column) => `"${column}"`).join(", ");
  const temporary = `__missing_fk_${tableName}`;
  sqlite.exec(`ALTER TABLE "${tableName}" RENAME TO "${temporary}"`);
  sqlite.exec(createSql);
  sqlite.exec(`INSERT INTO "${tableName}" (${quoted}) SELECT ${quoted} FROM "${temporary}"`);
  sqlite.exec(`DROP TABLE "${temporary}"`);
  for (const object of objects) sqlite.exec(object.sql);
}

describe("db migrations", () => {
  it("adds the complete Codex-native durable control-plane shape", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);

    for (const table of [
      "codex_thread_bindings",
      "codex_binding_run_leases",
      "project_ai_runs",
      "codex_interactions",
      "pipeline_command_receipts",
      "pipeline_command_outbox",
      "codex_logical_turns",
      "codex_turn_executions",
      "codex_follower_start_attempts",
    ]) {
      assert.ok(tableNames(sqlite).includes(table), `missing ${table}`);
    }
    assert.deepEqual(columnNames(sqlite, "codex_thread_bindings"), [
      "binding_id", "scope_kind", "scope_id", "project_id", "change_id",
      "codex_project_id", "thread_id", "title", "status",
      "bridge_protocol_version", "provision_claim_token", "provision_lease_owner",
      "provision_lease_expires_at", "follower_start_proved_at", "last_turn_id",
      "last_observation_cursor", "last_semantic_snapshot_hash", "last_seen_at",
      "last_error_code", "created_at", "updated_at",
    ]);
    for (const column of [
      "id", "project_id", "kind", "request_key", "sequence", "status",
      "worker_id", "lease_token", "owner_attempt", "owner_epoch", "deadline_at",
      "created_at", "updated_at", "completed_at",
    ]) {
      assert.ok(columnNames(sqlite, "project_ai_runs").includes(column), column);
    }
    for (const column of ["interaction_id", "actor_surface", "codex_thread_id", "command_id"]) {
      assert.ok(columnNames(sqlite, "human_decisions").includes(column), column);
    }
    for (const column of ["default_codex_model", "default_reasoning_effort"]) {
      assert.ok(columnNames(sqlite, "projects").includes(column), column);
    }
    for (const column of ["codex_model", "reasoning_effort"]) {
      assert.ok(columnNames(sqlite, "changes").includes(column), column);
    }
    for (const column of [
      "job_kind", "effect_type", "interaction_id", "command_id",
      "effect_schema_version", "effect_payload_json", "next_turn_ordinal",
      "effect_deadline_at",
    ]) {
      assert.ok(columnNames(sqlite, "pipeline_jobs").includes(column), column);
    }
    for (const table of [
      "codex_logical_turns", "codex_follower_start_attempts", "codex_turn_executions",
    ]) {
      assert.match(tableSql(sqlite, table), /'follower_ipc','host_ui_message'/);
    }
    assert.match(tableSql(sqlite, "codex_logical_turns"), /pipeline_job_id[^]*project_ai_run_id[^]*<>/);
    assert.match(tableSql(sqlite, "codex_follower_start_attempts"), /UNIQUE \(`logical_turn_id`\)/);
  });

  it("repairs and receipts an unrecorded partially applied 0028 without deleting data", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);
    sqlite.pragma("foreign_keys = ON");
    sqlite.prepare(`
      INSERT INTO projects
        (id,name,repo_path,context_status,context_provider,prd_status,prd_provider,git_enabled,created_at,updated_at)
      VALUES ('PRJ-KEEP','keep','/tmp/prj-keep','pending','codex','none','codex',0,'now','now')
    `).run();
    sqlite.exec(`
      INSERT INTO changes (id,project_id,title,status,created_at,updated_at)
        VALUES ('CHG-KEEP','PRJ-KEEP','keep','PLANNING','now','now');
      INSERT INTO codex_thread_bindings
        (binding_id,scope_kind,scope_id,project_id,change_id,thread_id,title,status,
         bridge_protocol_version,last_seen_at,created_at,updated_at)
        VALUES ('B-KEEP','change','CHG-KEEP','PRJ-KEEP','CHG-KEEP','TH-KEEP','keep',
                'ready','v1','now','now','now');
      INSERT INTO pipeline_jobs
        (id,change_id,phase,action_id,status,attempt_no,created_at,job_kind)
        VALUES ('JOB-KEEP','CHG-KEEP','Spec','keep','completed',1,'now','stage');
      INSERT INTO codex_interactions
        (id,change_id,binding_id,codex_thread_id,phase,kind,gate_version,source_db_hash,
         payload_json,status,idempotency_key,expires_at,created_at,updated_at)
        VALUES ('INT-KEEP','CHG-KEEP','B-KEEP','TH-KEEP','Spec','gate_decision',1,'hash',
                '{}','completed','int-keep','9999-01-01T00:00:00.000Z','now','now');
      INSERT INTO pipeline_command_receipts
        (command_id,change_id,interaction_id,codex_thread_id,action,actor_kind,actor_surface,
         idempotency_key,request_hash,status,created_at)
        VALUES ('CMD-KEEP','CHG-KEEP','INT-KEEP','TH-KEEP','approve','human','codex_mcp_app',
                'cmd-keep','request-hash','completed','now');
      INSERT INTO pipeline_jobs
        (id,change_id,phase,action_id,status,attempt_no,created_at,job_kind,effect_type,
         interaction_id,command_id,effect_schema_version,effect_payload_json,effect_deadline_at)
        VALUES ('JOB-EFFECT-KEEP','CHG-KEEP','Spec','wake','completed',1,'now',
                'interaction_wakeup','wake','INT-KEEP','CMD-KEEP','stagepass.pipeline-effect/v1',
                '{"schemaVersion":"stagepass.pipeline-effect/v1","kind":"interaction_wakeup","interactionId":"INT-KEEP","commandId":"CMD-KEEP"}',
                '9999-01-01T00:00:00.000Z');
      INSERT INTO human_decisions
        (id,change_id,gate,action,created_by,interaction_id,actor_surface,codex_thread_id,
         command_id,created_at)
        VALUES ('HD-KEEP','CHG-KEEP','spec','approve','human','INT-KEEP','codex_mcp_app',
                'TH-KEEP','CMD-KEEP','now');
      INSERT INTO codex_logical_turns
        (logical_turn_id,pipeline_job_id,binding_id,phase,role,round,ordinal,turn_slot,
         run_correlation_id,canonical_request_json,canonical_request_hash,dispatch_surface,
         status,created_at,updated_at)
        VALUES ('00000000-0000-4000-8000-000000000099','JOB-KEEP','B-KEEP','Spec','stage',
                0,0,'keep-slot','keep-corr','{}','keep-hash','follower_ipc','ready','now','now');
      INSERT INTO codex_binding_run_leases
        (binding_id,logical_turn_id,worker_id,lease_token,owner_epoch,lease_expires_at,deadline_at)
        VALUES ('B-KEEP','00000000-0000-4000-8000-000000000099','worker','token',1,
                '9999-01-01T00:00:00.000Z','9999-01-01T00:00:00.000Z');
    `);
    sqlite.pragma("foreign_keys = OFF");
    sqlite.pragma("legacy_alter_table = ON");
    stripNativeForeignKeysForReplay(sqlite, "pipeline_jobs");
    stripNativeForeignKeysForReplay(sqlite, "human_decisions");
    sqlite.exec(`
      ALTER TABLE codex_binding_run_leases RENAME TO __lease_without_fk;
      CREATE TABLE codex_binding_run_leases (
        binding_id TEXT PRIMARY KEY NOT NULL,
        logical_turn_id TEXT NOT NULL,
        attempt_id TEXT,
        worker_id TEXT NOT NULL,
        lease_token TEXT NOT NULL,
        owner_epoch INTEGER NOT NULL,
        lease_expires_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL
      );
      INSERT INTO codex_binding_run_leases
        SELECT * FROM __lease_without_fk;
      DROP TABLE __lease_without_fk;
    `);
    sqlite.pragma("legacy_alter_table = OFF");
    sqlite.pragma("foreign_keys = ON");
    assert.equal(
      (sqlite.prepare("PRAGMA foreign_key_list(codex_binding_run_leases)").all() as unknown[]).length,
      0,
    );
    for (const table of ["pipeline_jobs", "human_decisions"]) {
      const signatures = (sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
        from: string;
        table: string;
        to: string;
      }>).map((row) => `${row.from}->${row.table}.${row.to}`);
      assert.equal(signatures.includes("interaction_id->codex_interactions.id"), false);
      assert.equal(signatures.includes("command_id->pipeline_command_receipts.command_id"), false);
    }
    sqlite.prepare("DELETE FROM __migrations WHERE tag = ?").run("0028_codex_native_control_plane");
    sqlite.exec("DROP INDEX uq_codex_thread_bindings_scope");

    const result = runMigrations(sqlite);

    assert.deepEqual(result.applied, ["0028_codex_native_control_plane"]);
    assert.equal(
      (sqlite.prepare("SELECT count(*) AS n FROM projects WHERE id='PRJ-KEEP'").get() as { n: number }).n,
      1,
    );
    assert.equal(
      (sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='uq_codex_thread_bindings_scope'").get() as { n: number }).n,
      1,
    );
    assert.equal(
      (sqlite.prepare("SELECT worker_id FROM codex_binding_run_leases WHERE binding_id='B-KEEP'").get() as { worker_id: string }).worker_id,
      "worker",
    );
    assert.deepEqual(
      (sqlite.prepare("PRAGMA foreign_key_list(codex_binding_run_leases)").all() as Array<{
        from: string;
        table: string;
        to: string;
      }>).map((row) => `${row.from}->${row.table}.${row.to}`),
      ["binding_id->codex_thread_bindings.binding_id"],
    );
    for (const table of ["pipeline_jobs", "human_decisions"]) {
      const signatures = (sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
        from: string;
        table: string;
        to: string;
      }>).map((row) => `${row.from}->${row.table}.${row.to}`);
      assert.ok(signatures.includes("interaction_id->codex_interactions.id"), table);
      assert.ok(signatures.includes("command_id->pipeline_command_receipts.command_id"), table);
    }
    assert.equal(
      (sqlite.prepare("SELECT command_id FROM pipeline_jobs WHERE id='JOB-EFFECT-KEEP'").get() as { command_id: string }).command_id,
      "CMD-KEEP",
    );
    assert.equal(
      (sqlite.prepare("SELECT command_id FROM human_decisions WHERE id='HD-KEEP'").get() as { command_id: string }).command_id,
      "CMD-KEEP",
    );
    assert.throws(() => sqlite.prepare(`
      INSERT INTO codex_logical_turns
        (binding_id,phase,role,round,ordinal,turn_slot,run_correlation_id,
         canonical_request_json,canonical_request_hash,dispatch_surface,status,created_at,updated_at)
      VALUES ('B-KEEP','Spec','stage',0,0,'bad-owner-slot','bad-owner-corr','{}','h',
              'follower_ipc','ready','now','now')
    `).run(), /CHECK constraint failed/);
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
  });

  it("enforces native owner identity, typed effects, UUIDs, and project lease transitions", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);
    sqlite.pragma("foreign_keys = OFF");

    assert.throws(() => sqlite.prepare(`
      INSERT INTO pipeline_jobs
        (id,change_id,phase,action_id,status,attempt_no,created_at,job_kind,effect_type,
         interaction_id,effect_schema_version,effect_payload_json,effect_deadline_at)
      VALUES ('BAD-EFFECT','CHG-X','Spec','present','completed',1,'t','interaction_present',
              'present','INT-X','stagepass.pipeline-effect/v1','{"kind":"wrong"}','z')
    `).run(), /pipeline_job_effect_invalid/);
    assert.throws(() => sqlite.prepare(`
      INSERT INTO codex_logical_turns
        (binding_id,phase,role,round,ordinal,turn_slot,run_correlation_id,
         canonical_request_json,canonical_request_hash,dispatch_surface,status,created_at,updated_at)
      VALUES ('B-X','Spec','stage',0,0,'slot-none','corr-none','{}','h','follower_ipc','ready','t','t')
    `).run(), /CHECK constraint failed/);
    assert.throws(() => sqlite.prepare(`
      INSERT INTO codex_logical_turns
        (pipeline_job_id,project_ai_run_id,binding_id,phase,role,round,ordinal,turn_slot,
         run_correlation_id,canonical_request_json,canonical_request_hash,dispatch_surface,
         status,created_at,updated_at)
      VALUES ('JOB-X','RUN-X','B-X','Spec','stage',0,0,'slot-both','corr-both','{}','h',
              'follower_ipc','ready','t','t')
    `).run(), /CHECK constraint failed/);
    sqlite.prepare(`
      INSERT INTO codex_logical_turns
        (pipeline_job_id,binding_id,phase,role,round,ordinal,turn_slot,run_correlation_id,
         canonical_request_json,canonical_request_hash,dispatch_surface,status,created_at,updated_at)
      VALUES ('JOB-X','B-X','Spec','stage',0,0,'slot-one','corr-one','{}','h',
              'follower_ipc','ready','t','t')
    `).run();
    const generated = sqlite.prepare(
      "SELECT logical_turn_id FROM codex_logical_turns WHERE turn_slot='slot-one'",
    ).get() as { logical_turn_id: string };
    assert.match(generated.logical_turn_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    sqlite.prepare(`
      INSERT INTO projects (id,name,repo_path,created_at,updated_at)
      VALUES ('PRJ-LEASE','lease','/tmp/prj-lease','t','t')
    `).run();
    sqlite.prepare(`
      INSERT INTO changes (id,project_id,title,status,created_at,updated_at)
      VALUES ('CHG-LEASE','PRJ-LEASE','lease','PLANNING','t','t')
    `).run();
    assert.throws(() => sqlite.prepare(`
      INSERT INTO codex_thread_bindings
        (binding_id,scope_kind,scope_id,project_id,change_id,title,status,
         bridge_protocol_version,last_seen_at,created_at,updated_at)
      VALUES ('B-READY-NULL','change','CHG-LEASE','PRJ-LEASE','CHG-LEASE','ready-null',
              'ready','v1','t','t','t')
    `).run(), /CHECK constraint failed/);
    sqlite.prepare(`
      INSERT INTO codex_thread_bindings
        (binding_id,scope_kind,scope_id,project_id,change_id,title,status,
         bridge_protocol_version,last_seen_at,created_at,updated_at)
      VALUES ('B-PROVISIONING','change','CHG-LEASE','PRJ-LEASE','CHG-LEASE','provisioning',
              'provisioning','v1','t','t','t')
    `).run();
    sqlite.prepare(`
      INSERT INTO project_ai_runs
        (id,project_id,kind,request_key,sequence,status,owner_attempt,owner_epoch,
         deadline_at,created_at,updated_at)
      VALUES ('AIR-LIVE','PRJ-LEASE','prd_turn','live',1,'pending',0,0,
              '9999-01-01T00:00:00.000Z','t','t')
    `).run();
    sqlite.prepare(`
      UPDATE project_ai_runs
      SET status='leased',worker_id='w1',lease_token='t1',owner_attempt=1,owner_epoch=1,
          lease_expires_at='9999-01-01T00:00:00.000Z'
      WHERE id='AIR-LIVE'
    `).run();
    sqlite.prepare("UPDATE project_ai_runs SET status='running' WHERE id='AIR-LIVE'").run();
    assert.throws(
      () => sqlite.prepare("UPDATE project_ai_runs SET lease_token='stale' WHERE id='AIR-LIVE'").run(),
      /project_ai_run_transition_invalid/,
    );
    sqlite.prepare("UPDATE project_ai_runs SET status='succeeded' WHERE id='AIR-LIVE'").run();
    assert.throws(
      () => sqlite.prepare(`
        UPDATE project_ai_runs
        SET status='leased',worker_id='w2',lease_token='t2',owner_attempt=2,owner_epoch=2
        WHERE id='AIR-LIVE'
      `).run(),
      /project_ai_run_transition_invalid/,
    );

    sqlite.prepare(`
      INSERT INTO project_ai_runs
        (id,project_id,kind,request_key,sequence,status,worker_id,lease_token,
         owner_attempt,owner_epoch,lease_expires_at,deadline_at,created_at,updated_at)
      VALUES ('AIR-LEASED','PRJ-LEASE','prd_turn','leased',2,'leased','w','tok',1,1,
              '9999-01-01T00:00:00.000Z','9999-01-01T00:00:00.000Z','t','t')
    `).run();
    assert.throws(
      () => sqlite.prepare("UPDATE project_ai_runs SET status='failed' WHERE id='AIR-LEASED'").run(),
      /project_ai_run_transition_invalid/,
    );
    sqlite.prepare(`
      INSERT INTO project_ai_runs
        (id,project_id,kind,request_key,sequence,status,worker_id,lease_token,
         owner_attempt,owner_epoch,lease_expires_at,deadline_at,created_at,updated_at)
      VALUES ('AIR-RUN-EXPIRED','PRJ-LEASE','prd_turn','run-expired',3,'running','w','tok',1,1,
              '2000-01-01T00:00:00.000Z','9999-01-01T00:00:00.000Z','t','t')
    `).run();
    assert.throws(
      () => sqlite.prepare("UPDATE project_ai_runs SET status='failed' WHERE id='AIR-RUN-EXPIRED'").run(),
      /project_ai_run_transition_invalid/,
    );

    sqlite.prepare(`
      INSERT INTO project_ai_runs
        (id,project_id,kind,request_key,sequence,status,worker_id,lease_token,
         owner_attempt,owner_epoch,lease_expires_at,deadline_at,created_at,updated_at)
      VALUES ('AIR-EXPIRED','PRJ-LEASE','context_init','expired',2,'leased','old','old-token',
              1,1,'2000-01-01T00:00:00.000Z','9999-01-01T00:00:00.000Z','t','t')
    `).run();
    sqlite.prepare(`
      UPDATE project_ai_runs
      SET status='leased',worker_id='new',lease_token='new-token',owner_attempt=2,owner_epoch=2,
          lease_expires_at='9999-01-01T00:00:00.000Z'
      WHERE id='AIR-EXPIRED'
    `).run();
    assert.equal(
      (sqlite.prepare("SELECT worker_id FROM project_ai_runs WHERE id='AIR-EXPIRED'").get() as { worker_id: string }).worker_id,
      "new",
    );
    assert.throws(
      () => sqlite.prepare(`
        UPDATE project_ai_runs
        SET status='leased',owner_attempt=3,owner_epoch=3,
            lease_expires_at='9999-01-01T00:00:00.000Z'
        WHERE id='AIR-EXPIRED'
      `).run(),
      /project_ai_run_transition_invalid/,
    );
    sqlite.prepare(`
      INSERT INTO project_ai_runs
        (id,project_id,kind,request_key,sequence,status,worker_id,lease_token,
         owner_attempt,owner_epoch,lease_expires_at,deadline_at,created_at,updated_at)
      VALUES ('AIR-DEADLINE','PRJ-LEASE','context_init','deadline',4,'leased','old','old-token',
              1,1,'2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z','t','t')
    `).run();
    assert.throws(
      () => sqlite.prepare(`
        UPDATE project_ai_runs
        SET status='leased',worker_id='new',lease_token='new-token',owner_attempt=2,owner_epoch=2,
            lease_expires_at='9999-01-01T00:00:00.000Z'
        WHERE id='AIR-DEADLINE'
      `).run(),
      /project_ai_run_transition_invalid/,
    );
  });

  it("applies gate metadata columns to a fresh database", () => {
    const sqlite = new Database(":memory:");

    const result = runMigrations(sqlite);

    assert.ok(result.applied.includes("0008_add_gate_fields"));
    assert.deepEqual(
      ["gate_state", "docs_complete", "retro_done"].every((column) =>
        columnNames(sqlite, "changes").includes(column)
      ),
      true
    );
  });

  it("does not reapply recorded migrations on a second run", () => {
    const sqlite = new Database(":memory:");

    runMigrations(sqlite);
    const second = runMigrations(sqlite);
    const recorded = sqlite
      .prepare("SELECT tag FROM __migrations WHERE tag = ?")
      .all("0008_add_gate_fields");

    assert.deepEqual(second.applied, []);
    assert.equal(recorded.length, 1);
  });

  /**
   * 0022 has to be additive over a database that already holds question cards:
   * the owner's rows predate rounds entirely, and a card that came back with a
   * NULL or 0 round would sort and group wrongly forever. Migrating rows that
   * exist BEFORE the ALTER is the case a fresh-schema check cannot see.
   */
  it("backfills pre-existing briefing questions to round 1", () => {
    const sqlite = new Database(":memory:");
    // Rewind to the pre-round shape: unrecord 0022 and undo it, indexes first --
    // SQLite refuses to drop a column an index still references. Two indexes
    // cover round_no now: 0022's own idx_briefing_questions_change_round, and
    // 0026's idx_briefing_questions_change_phase, which added round_no as a
    // third sort key over the same table. Only 0022 is unrecorded below, so
    // only its index is expected back after the replay; 0026 stays applied and
    // its index stays dropped for the rest of this throwaway connection.
    runMigrations(sqlite);
    sqlite.prepare("DELETE FROM __migrations WHERE tag = ?").run("0022_briefing_question_rounds");
    sqlite.exec("DROP INDEX IF EXISTS `idx_briefing_questions_change_round`");
    sqlite.exec("DROP INDEX IF EXISTS `idx_briefing_questions_change_phase`");
    sqlite.exec("ALTER TABLE `briefing_questions` DROP COLUMN `round_no`");
    // The card is the fixture; its change/project chain is not what is under
    // test, so the row stands alone rather than dragging in two parent tables.
    sqlite.pragma("foreign_keys = OFF");
    sqlite.prepare(`
      INSERT INTO briefing_questions
        (id, change_id, category, severity, question, why_it_matters, suggested_default,
         status, answer, source, created_at, updated_at)
      VALUES ('BQ-LEGACY', 'CHG-LEGACY', 'scope', 'critical', 'q', 'why', NULL,
              'answered', 'recorded answer', 'ai_blue', '2026-07-01T00:00:00.000Z',
              '2026-07-01T00:00:00.000Z')
    `).run();
    assert.equal(columnNames(sqlite, "briefing_questions").includes("round_no"), false);

    const result = runMigrations(sqlite);

    assert.deepEqual(result.applied, ["0022_briefing_question_rounds"]);
    const row = sqlite.prepare("SELECT round_no, status, answer FROM briefing_questions WHERE id = ?")
      .get("BQ-LEGACY") as { round_no: number; status: string; answer: string };
    assert.equal(row.round_no, 1, "a pre-round card belongs to round 1");
    assert.equal(row.status, "answered", "the migration must not disturb recorded decisions");
    assert.equal(row.answer, "recorded answer");
  });

  it("records a migration when its columns were already applied manually", () => {
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
});
