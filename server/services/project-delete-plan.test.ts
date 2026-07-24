import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";

import { PROJECT_DELETE_PLAN } from "./project-delete-plan";
import { runMigrations } from "../db/migrate";

describe("project delete plan", () => {
  it("deletes PRD and Context native owner graphs with foreign keys enabled", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);
    sqlite.pragma("foreign_keys = ON");
    sqlite.prepare(`
      INSERT INTO projects (id,name,repo_path,created_at,updated_at)
      VALUES ('PRJ-DELETE','delete','/tmp/prj-delete','t','t')
    `).run();

    for (const [index, scope] of (["project_prd", "project_context"] as const).entries()) {
      const bindingId = `B-${index}`;
      const runId = `AIR-${index}`;
      const logicalId = `00000000-0000-4000-8000-00000000001${index}`;
      const attemptId = `ATT-${index}`;
      const threadId = `THREAD-${index}`;
      sqlite.prepare(`
        INSERT INTO codex_thread_bindings
          (binding_id,scope_kind,scope_id,project_id,thread_id,title,status,
           bridge_protocol_version,last_seen_at,created_at,updated_at)
        VALUES (?,?, 'PRJ-DELETE','PRJ-DELETE',?,?, 'ready','v1','t','t','t')
      `).run(bindingId, scope, threadId, scope);
      sqlite.prepare(`
        INSERT INTO project_ai_runs
          (id,project_id,kind,request_key,sequence,status,owner_attempt,owner_epoch,
           deadline_at,created_at,updated_at)
        VALUES (?,'PRJ-DELETE',?,?,?,'pending',0,0,'9999-01-01T00:00:00.000Z','t','t')
      `).run(
        runId,
        scope === "project_prd" ? "prd_turn" : "context_init",
        `request-${index}`,
        index + 1,
      );
      sqlite.prepare(`
        INSERT INTO codex_logical_turns
          (logical_turn_id,project_ai_run_id,binding_id,phase,role,round,ordinal,turn_slot,
           run_correlation_id,canonical_request_json,canonical_request_hash,dispatch_surface,
           status,created_at,updated_at)
        VALUES (?,?,?,?,?,0,0,?,?, '{}',?,'follower_ipc','ready','t','t')
      `).run(
        logicalId,
        runId,
        bindingId,
        scope === "project_prd" ? "PRD" : "Context",
        scope === "project_prd" ? "prd_turn" : "context_generate",
        `slot-${index}`,
        `corr-${index}`,
        `hash-${index}`,
      );
      sqlite.prepare(`
        INSERT INTO codex_follower_start_attempts
          (attempt_id,logical_turn_id,run_correlation_id,project_ai_run_id,worker_id,lease_token,
           owner_attempt,owner_epoch,thread_id,purpose,dispatch_surface,normalized_prompt_hash,
           correlation_marker,cwd,sandbox_mode,approval_policy,pre_start_turn_ids_json,
           pre_start_semantic_hash,state,budget_deadline,follower_turn_id,prepared_at,completed_at)
        VALUES (?,?,?,?,'worker','token',1,1,?,'test','follower_ipc',?,?,'/tmp','read-only',
                'never','[]','base','succeeded','9999-01-01T00:00:00.000Z',?,'t','t')
      `).run(
        attemptId,
        logicalId,
        `corr-${index}`,
        runId,
        threadId,
        `prompt-${index}`,
        `marker-${index}`,
        `TURN-${index}`,
      );
      sqlite.prepare(`
        INSERT INTO codex_binding_run_leases
          (binding_id,logical_turn_id,attempt_id,worker_id,lease_token,owner_epoch,
           lease_expires_at,deadline_at)
        VALUES (?,?,?,'worker','token',1,'9999-01-01T00:00:00.000Z','9999-01-01T00:00:00.000Z')
      `).run(bindingId, logicalId, attemptId);
      sqlite.prepare(`
        INSERT INTO codex_turn_executions
          (id,start_attempt_id,logical_turn_id,project_ai_run_id,thread_id,turn_id,dispatch_surface,
           lease_token,owner_attempt,owner_epoch,normalized_items_json,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'follower_ipc','token',1,1,'[]','completed','t','t')
      `).run(
        `EX-${index}`,
        attemptId,
        logicalId,
        runId,
        threadId,
        `TURN-${index}`,
      );
    }

    const database = drizzle(sqlite);
    database.transaction((tx) => {
      for (const step of PROJECT_DELETE_PLAN) {
        tx.run(sql`DELETE FROM ${sql.identifier(step.table)} WHERE ${step.where("PRJ-DELETE")}`);
      }
    });

    for (const table of [
      "codex_turn_executions",
      "codex_follower_start_attempts",
      "codex_binding_run_leases",
      "codex_logical_turns",
      "project_ai_runs",
      "codex_thread_bindings",
      "projects",
    ]) {
      assert.equal(
        (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
        0,
        table,
      );
    }
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
  });

  it("uses the required project-native child-first order", () => {
    assert.deepEqual(PROJECT_DELETE_PLAN.map((step) => step.table), [
      "codex_turn_executions",
      "codex_follower_start_attempts",
      "codex_binding_run_leases",
      "codex_logical_turns",
      "project_ai_runs",
      "codex_thread_bindings",
      "projects",
    ]);
  });

  it("does not route project owner deletion through Change identity", () => {
    for (const step of PROJECT_DELETE_PLAN.slice(0, -1)) {
      assert.doesNotMatch(String(step.where("PRJ-1")), /change_id\s*=/);
    }
  });
});
