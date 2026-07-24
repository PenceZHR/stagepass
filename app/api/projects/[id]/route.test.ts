import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sqlite } from "@/server/db";
import { DELETE } from "./route";

describe("DELETE /api/projects/[id]", () => {
  it("uses the production transaction for real PRD and Context native children", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const projectId = `PRJ-ROUTE-${suffix}`;
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "stagepass-route-delete-"));
    fs.mkdirSync(path.join(repoPath, ".ship"), { recursive: true });
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO projects (id,name,repo_path,created_at,updated_at)
      VALUES (?,?,?,?,?)
    `).run(projectId, "route", repoPath, now, now);

    for (const [index, scope] of (["project_prd", "project_context"] as const).entries()) {
      const bindingId = `${projectId}-B-${index}`;
      const runId = `${projectId}-RUN-${index}`;
      const logicalTurnId = crypto.randomUUID();
      const attemptId = `${projectId}-ATT-${index}`;
      const threadId = `${projectId}-THREAD-${index}`;
      const turnId = `${projectId}-TURN-${index}`;
      sqlite.prepare(`
        INSERT INTO codex_thread_bindings
          (binding_id,scope_kind,scope_id,project_id,thread_id,title,status,
           bridge_protocol_version,last_observation_cursor,last_seen_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?, 'ready','v1',0,?,?,?)
      `).run(bindingId, scope, projectId, projectId, threadId, scope, now, now, now);
      sqlite.prepare(`
        INSERT INTO project_ai_runs
          (id,project_id,kind,request_key,sequence,status,owner_attempt,owner_epoch,
           deadline_at,created_at,updated_at)
        VALUES (?,?,?,?,?,'pending',0,0,'9999-01-01T00:00:00.000Z',?,?)
      `).run(
        runId,
        projectId,
        scope === "project_prd" ? "prd_turn" : "context_init",
        `request-${index}`,
        index + 1,
        now,
        now,
      );
      sqlite.prepare(`
        INSERT INTO codex_logical_turns
          (logical_turn_id,project_ai_run_id,binding_id,phase,role,round,ordinal,turn_slot,
           run_correlation_id,canonical_request_json,canonical_request_hash,dispatch_surface,
           status,created_at,updated_at)
        VALUES (?,?,?,?,?,0,0,?,?, '{}',?,'follower_ipc','ready',?,?)
      `).run(
        logicalTurnId,
        runId,
        bindingId,
        scope === "project_prd" ? "PRD" : "Context",
        scope === "project_prd" ? "prd_turn" : "context_generate",
        `${projectId}-slot-${index}`,
        `${projectId}-corr-${index}`,
        `${projectId}-hash-${index}`,
        now,
        now,
      );
      sqlite.prepare(`
        INSERT INTO codex_follower_start_attempts
          (attempt_id,logical_turn_id,run_correlation_id,project_ai_run_id,worker_id,lease_token,
           owner_attempt,owner_epoch,thread_id,purpose,dispatch_surface,normalized_prompt_hash,
           correlation_marker,cwd,sandbox_mode,approval_policy,pre_start_turn_ids_json,
           pre_start_semantic_hash,state,budget_deadline,follower_turn_id,prepared_at,completed_at)
        VALUES (?,?,?,?,?,'token',1,1,?,?,'follower_ipc',?,?,?,?, 'never','[]','base',
                'succeeded','9999-01-01T00:00:00.000Z',?,?,?)
      `).run(
        attemptId,
        logicalTurnId,
        `${projectId}-corr-${index}`,
        runId,
        "worker",
        threadId,
        "route-test",
        `${projectId}-prompt-${index}`,
        `${projectId}-marker-${index}`,
        repoPath,
        "read-only",
        turnId,
        now,
        now,
      );
      sqlite.prepare(`
        INSERT INTO codex_binding_run_leases
          (binding_id,logical_turn_id,attempt_id,worker_id,lease_token,owner_epoch,
           lease_expires_at,deadline_at)
        VALUES (?,?,?,'worker','token',1,'9999-01-01T00:00:00.000Z','9999-01-01T00:00:00.000Z')
      `).run(bindingId, logicalTurnId, attemptId);
      sqlite.prepare(`
        INSERT INTO codex_turn_executions
          (id,start_attempt_id,logical_turn_id,project_ai_run_id,thread_id,turn_id,dispatch_surface,
           lease_token,owner_attempt,owner_epoch,normalized_items_json,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'follower_ipc','token',1,1,'[]','completed',?,?)
      `).run(`${projectId}-EX-${index}`, attemptId, logicalTurnId, runId, threadId, turnId, now, now);
    }

    try {
      const response = await DELETE(
        new Request(`http://localhost/api/projects/${projectId}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: projectId }) },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { success: true });
      assert.equal(
        (sqlite.prepare("SELECT count(*) AS n FROM projects WHERE id=?").get(projectId) as { n: number }).n,
        0,
      );
      for (const table of [
        "codex_thread_bindings",
        "project_ai_runs",
        "codex_logical_turns",
        "codex_follower_start_attempts",
        "codex_turn_executions",
      ]) {
        const ownerColumn = table === "codex_thread_bindings" || table === "project_ai_runs"
          ? "project_id"
          : table === "codex_logical_turns" || table === "codex_follower_start_attempts" || table === "codex_turn_executions"
            ? "project_ai_run_id"
            : "id";
        const row = sqlite.prepare(
          ownerColumn === "project_id"
            ? `SELECT count(*) AS n FROM ${table} WHERE project_id=?`
            : `SELECT count(*) AS n FROM ${table} WHERE project_ai_run_id LIKE ?`,
        ).get(ownerColumn === "project_id" ? projectId : `${projectId}-%`) as { n: number };
        assert.equal(row.n, 0, table);
      }
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
