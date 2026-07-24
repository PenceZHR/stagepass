import { sql, type SQL } from "drizzle-orm";

export interface ProjectDeleteStep {
  readonly table: string;
  readonly where: (projectId: string) => SQL;
}

/**
 * Project-native children are deleted only after every Change has gone through
 * CHANGE_DELETE_PLAN.  The predicates deliberately use project_ai_run_id or a
 * project scope; project owner ids are never interpreted as Change ids.
 */
export const PROJECT_DELETE_PLAN: readonly ProjectDeleteStep[] = [
  {
    table: "codex_turn_executions",
    where: (projectId) => sql`
      project_ai_run_id IN (SELECT id FROM project_ai_runs WHERE project_id = ${projectId})
    `,
  },
  {
    table: "codex_follower_start_attempts",
    where: (projectId) => sql`
      project_ai_run_id IN (SELECT id FROM project_ai_runs WHERE project_id = ${projectId})
    `,
  },
  {
    table: "codex_binding_run_leases",
    where: (projectId) => sql`
      binding_id IN (
        SELECT binding_id FROM codex_thread_bindings
        WHERE project_id = ${projectId}
          AND scope_kind IN ('project_prd', 'project_context')
      )
    `,
  },
  {
    table: "codex_logical_turns",
    where: (projectId) => sql`
      project_ai_run_id IN (SELECT id FROM project_ai_runs WHERE project_id = ${projectId})
    `,
  },
  { table: "project_ai_runs", where: (projectId) => sql`project_id = ${projectId}` },
  {
    table: "codex_thread_bindings",
    where: (projectId) => sql`
      project_id = ${projectId}
        AND scope_kind IN ('project_prd', 'project_context')
    `,
  },
  { table: "projects", where: (projectId) => sql`id = ${projectId}` },
] as const;
