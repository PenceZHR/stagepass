import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";

import * as schema from "../db/schema.ts";
import { CHANGE_DELETE_PLAN } from "./change-delete-plan.ts";
import { runMigrations } from "../db/migrate.ts";

/**
 * The foreign-key graph as schema.ts actually declares it: table -> the tables
 * it references. Read from Drizzle's own metadata rather than the source text,
 * so it cannot drift from the migrations.
 */
function foreignKeyGraph(): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const exported of Object.values(schema)) {
    if (!(exported instanceof SQLiteTable)) continue;
    const config = getTableConfig(exported);
    const referenced = new Set<string>();
    for (const foreignKey of config.foreignKeys) {
      referenced.add(getTableConfig(foreignKey.reference().foreignTable).name);
    }
    graph.set(config.name, referenced);
  }
  return graph;
}

/** Tables whose rows hang off a change, directly or through a parent that does. */
function changeDependentTables(graph: Map<string, Set<string>>): Set<string> {
  const dependent = new Set<string>();

  const reaches = (table: string, visiting: Set<string>): boolean => {
    if (dependent.has(table)) return true;
    if (visiting.has(table)) return false;
    visiting.add(table);
    for (const referenced of graph.get(table) ?? []) {
      if (referenced === "changes" || reaches(referenced, visiting)) return true;
    }
    return false;
  };

  for (const table of graph.keys()) {
    if (table === "changes") continue;
    if (reaches(table, new Set())) dependent.add(table);
  }
  return dependent;
}

describe("change delete plan", () => {
  it("deletes a fully FK-backed native Change graph and preserves Project scopes", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);
    sqlite.pragma("foreign_keys = ON");
    const database = drizzle(sqlite);
    sqlite.exec(`
      INSERT INTO projects (id,name,repo_path,created_at,updated_at)
        VALUES ('PRJ-1','p','/tmp/task2-prj','t','t');
      INSERT INTO changes (id,project_id,title,status,created_at,updated_at)
        VALUES ('CHG-1','PRJ-1','c','PLANNING','t','t');
      INSERT INTO codex_thread_bindings
        (binding_id,scope_kind,scope_id,project_id,change_id,thread_id,title,status,
         bridge_protocol_version,last_observation_cursor,last_seen_at,created_at,updated_at)
        VALUES
        ('B-CHG','change','CHG-1','PRJ-1','CHG-1','TH-CHG','change','ready','v1',0,'t','t','t'),
        ('B-PRD','project_prd','PRJ-1','PRJ-1',NULL,'TH-PRD','prd','ready','v1',0,'t','t','t');
      INSERT INTO project_ai_runs
        (id,project_id,kind,request_key,sequence,status,owner_attempt,owner_epoch,
         deadline_at,created_at,updated_at)
        VALUES ('PAIR-KEEP','PRJ-1','prd_turn','keep',1,'pending',0,0,'z','t','t');
      INSERT INTO codex_interactions
        (id,change_id,binding_id,codex_thread_id,phase,kind,gate_version,source_db_hash,
         payload_json,status,idempotency_key,expires_at,created_at,updated_at)
        VALUES ('INT-1','CHG-1','B-CHG','TH-CHG','Spec','gate_decision',1,'h','{}',
                'completed','ik','z','t','t');
      INSERT INTO pipeline_command_receipts
        (command_id,change_id,interaction_id,codex_thread_id,action,actor_kind,actor_surface,
         idempotency_key,request_hash,status,created_at)
        VALUES ('CMD-1','CHG-1','INT-1','TH-CHG','approve','human','codex_mcp_app',
                'ck','rh','completed','t');
      INSERT INTO pipeline_command_outbox
        (id,command_id,interaction_id,effect_type,effect_payload_json,status,created_at,updated_at)
        VALUES ('OB-1','CMD-1','INT-1','wake','{}','pending','t','t');
      INSERT INTO human_decisions
        (id,change_id,gate,action,created_by,interaction_id,actor_surface,codex_thread_id,
         command_id,created_at)
        VALUES ('HD-1','CHG-1','spec','approve','human','INT-1','codex_mcp_app','TH-CHG',
                'CMD-1','t');
      INSERT INTO pipeline_jobs
        (id,change_id,phase,action_id,status,attempt_no,created_at,job_kind)
        VALUES ('JOB-STAGE','CHG-1','Spec','stage','completed',1,'t','stage');
      INSERT INTO pipeline_jobs
        (id,change_id,phase,action_id,status,attempt_no,created_at,job_kind,effect_type,
         interaction_id,effect_schema_version,effect_payload_json,effect_deadline_at)
        VALUES ('JOB-PRESENT','CHG-1','Spec','present','completed',1,'t','interaction_present',
                'present','INT-1','stagepass.pipeline-effect/v1',
                '{"schemaVersion":"stagepass.pipeline-effect/v1","kind":"interaction_present","interactionId":"INT-1"}','z');
      INSERT INTO pipeline_jobs
        (id,change_id,phase,action_id,status,attempt_no,created_at,job_kind,effect_type,
         interaction_id,command_id,effect_schema_version,effect_payload_json,effect_deadline_at)
        VALUES ('JOB-WAKE','CHG-1','Spec','wake','completed',1,'t','interaction_wakeup',
                'wake','INT-1','CMD-1','stagepass.pipeline-effect/v1',
                '{"schemaVersion":"stagepass.pipeline-effect/v1","kind":"interaction_wakeup","interactionId":"INT-1","commandId":"CMD-1"}','z');
    `);
    for (const [index, job] of ["JOB-STAGE", "JOB-PRESENT", "JOB-WAKE"].entries()) {
      const logical = `00000000-0000-4000-8000-00000000000${index}`;
      const attempt = `ATT-${index}`;
      sqlite.prepare(`
        INSERT INTO codex_logical_turns
          (logical_turn_id,pipeline_job_id,binding_id,phase,role,round,ordinal,turn_slot,
           run_correlation_id,canonical_request_json,canonical_request_hash,dispatch_surface,
           status,created_at,updated_at)
          VALUES (?,?,?,?,?,0,0,?,?,?,?,?,'ready','t','t')
      `).run(
        logical, job, "B-CHG", "Spec",
        index === 0 ? "stage" : index === 1 ? "interaction_present" : "interaction_wakeup",
        `slot-${index}`, `corr-${index}`, "{}", `hash-${index}`,
        index === 2 ? "host_ui_message" : "follower_ipc",
      );
      sqlite.prepare(`
        INSERT INTO codex_follower_start_attempts
          (attempt_id,logical_turn_id,run_correlation_id,pipeline_job_id,worker_id,lease_token,
           owner_attempt,owner_epoch,thread_id,purpose,dispatch_surface,normalized_prompt_hash,
           correlation_marker,cwd,sandbox_mode,approval_policy,pre_start_turn_ids_json,
           pre_start_semantic_hash,state,budget_deadline,prepared_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        attempt, logical, `corr-${index}`, job, "w", "lease", 1, 1, "TH-CHG", "test",
        index === 2 ? "host_ui_message" : "follower_ipc", `prompt-${index}`, `marker-${index}`,
        "/tmp", "read-only", "never", "[]", "base", "succeeded", "z", "t",
      );
      sqlite.prepare(`
        INSERT INTO codex_turn_executions
          (id,start_attempt_id,logical_turn_id,pipeline_job_id,thread_id,turn_id,dispatch_surface,
           lease_token,owner_attempt,owner_epoch,normalized_items_json,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        `EX-${index}`, attempt, logical, job, "TH-CHG", `TURN-${index}`,
        index === 2 ? "host_ui_message" : "follower_ipc", "lease", 1, 1, "[]",
        "completed", "t", "t",
      );
      if (index === 0) {
        sqlite.prepare(`
          INSERT INTO codex_binding_run_leases
            (binding_id,logical_turn_id,attempt_id,worker_id,lease_token,owner_epoch,
             lease_expires_at,deadline_at)
            VALUES ('B-CHG',?,?,?,?,?,?,?)
        `).run(logical, attempt, "w", "lease", 1, "z", "z");
      }
    }

    database.transaction((tx) => {
      for (const step of CHANGE_DELETE_PLAN) {
        tx.run(sql`DELETE FROM ${sql.identifier(step.table)} WHERE ${step.where("CHG-1")}`);
      }
      tx.run(sql`DELETE FROM changes WHERE id = ${"CHG-1"}`);
    });

    assert.equal((sqlite.prepare("SELECT count(*) AS n FROM changes").get() as { n: number }).n, 0);
    assert.equal((sqlite.prepare("SELECT count(*) AS n FROM codex_turn_executions").get() as { n: number }).n, 0);
    assert.equal((sqlite.prepare("SELECT count(*) AS n FROM pipeline_jobs").get() as { n: number }).n, 0);
    assert.equal((sqlite.prepare("SELECT count(*) AS n FROM codex_interactions").get() as { n: number }).n, 0);
    assert.equal((sqlite.prepare("SELECT count(*) AS n FROM pipeline_command_receipts").get() as { n: number }).n, 0);
    assert.equal((sqlite.prepare("SELECT count(*) AS n FROM codex_thread_bindings WHERE binding_id='B-PRD'").get() as { n: number }).n, 1);
    assert.equal((sqlite.prepare("SELECT count(*) AS n FROM project_ai_runs WHERE id='PAIR-KEEP'").get() as { n: number }).n, 1);
  });

  it("deletes each table exactly once", () => {
    const tables = CHANGE_DELETE_PLAN.map((step) => step.table);
    assert.deepEqual(
      tables.filter((table, index) => tables.indexOf(table) !== index),
      [],
      "a table is deleted twice",
    );
  });

  it("covers exactly the tables that reference a change", () => {
    const graph = foreignKeyGraph();
    const dependent = [...changeDependentTables(graph)].sort();
    const planned = CHANGE_DELETE_PLAN.map((step) => step.table).sort();

    assert.deepEqual(
      planned,
      dependent,
      "the delete plan drifted from schema.ts: a table that references a change is missing from " +
        "CHANGE_DELETE_PLAN (its rows would block the delete), or the plan deletes a table that no " +
        "longer hangs off a change",
    );
  });

  it("deletes every table before the tables it references", () => {
    const graph = foreignKeyGraph();
    const position = new Map(CHANGE_DELETE_PLAN.map((step, index) => [step.table, index]));

    for (const [table, index] of position) {
      for (const referenced of graph.get(table) ?? []) {
        if (referenced === table) continue; // self-reference: no ordering to honour
        const referencedIndex = position.get(referenced);
        if (referencedIndex === undefined) continue; // parent outlives the change (e.g. projects)
        assert.ok(
          index < referencedIndex,
          `${table} references ${referenced}, so it must be deleted first, but the plan deletes ` +
            `${table} at #${index} and ${referenced} at #${referencedIndex} -- this raises ` +
            "SQLITE_CONSTRAINT_FOREIGNKEY",
        );
      }
    }
  });
});
