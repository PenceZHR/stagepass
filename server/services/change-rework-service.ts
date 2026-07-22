import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Change, ChangeStatus, RunPhase } from "../types/index";
import { withSqliteWriteRetry } from "../db/write-boundary";
import { RUNNING_CHANGE_STATUSES } from "../state-machine/transitions";
import { nextSequencedId } from "./record-identity";
import { RUN_DELETE_PLAN, RUN_POINTER_CLEARS } from "./run-delete-plan";

type DbLike = typeof import("../db").db;
type SchemaTables = typeof import("../db/schema");

let schemaPromise: Promise<SchemaTables> | null = null;

export type ReworkReviewPhase = "Plan" | "TestPlan" | "Build" | "Implement" | "Check" | "Fix";

const PHASE_TO_RUN_PHASE: Record<ReworkReviewPhase, RunPhase> = {
  Plan: "generate_plan",
  TestPlan: "test_plan",
  Build: "implement",
  Implement: "implement",
  Check: "local_check",
  Fix: "fix_findings",
};

const PHASE_TO_READY_STATUS: Record<ReworkReviewPhase, ChangeStatus> = {
  Plan: "DRAFT",
  TestPlan: "PLAN_APPROVED",
  Build: "PLAN_APPROVED",
  Implement: "PLAN_APPROVED",
  Check: "IMPLEMENTED",
  Fix: "CHECK_FAILED",
};

const PHASE_ORDER: RunPhase[] = [
  "intake",
  "spec",
  "tech_spec",
  "generate_plan",
  "test_plan",
  "implement",
  "review",
  "local_check",
  "fix_findings",
  "release",
  "retro",
  "delivery",
];

const ROOT_FILES_BY_PHASE: Record<RunPhase, string[]> = {
  intake: ["change-request.md"],
  spec: ["prd-delta.md"],
  tech_spec: ["tech-spec-delta.md", "api-spec-delta.md"],
  test_plan: ["test-plan-delta.md"],
  generate_plan: ["plan.json", "plan.md"],
  implement: ["changed-files.json", "implement-summary.md"],
  review: ["review-findings.json"],
  local_check: [
    "local-check.json",
    "scope-check.json",
    "findings.json",
    "semgrep-local.json",
    "lint.log",
    "build.log",
    "typecheck.log",
    "test.log",
  ],
  fix_findings: ["changed-files.json"],
  release: ["release-note.md"],
  retro: ["retro.md"],
  delivery: ["delivery.md"],
};

function nowISO(): string {
  return new Date().toISOString();
}

async function loadSchema(): Promise<SchemaTables> {
  schemaPromise ??= import("../db/schema").catch(async () => {
    const { pathToFileURL } = await import("url");
    return import(
      /* webpackIgnore: true */
      pathToFileURL(path.join(process.cwd(), "server/db/schema.ts")).href
    ) as Promise<SchemaTables>;
  });
  return schemaPromise;
}

async function logReworked(input: Record<string, unknown>) {
  try {
    const { createChildLogger } = await import("../logger");
    createChildLogger("change-rework-service").info(input, "Change reworked");
  } catch {
    // Logging is best-effort so Node's direct TS test runner can exercise the service.
  }
}

function nextEventId(
  activeDb: DbLike,
  eventsTable: SchemaTables["events"]
): string {
  // Was a local max+1 over `/\d+$/`, which reads the trailing digits of *any*
  // id -- including the UUID tail of a provider-minted event. The events ledger
  // already holds one such row, so this function would have minted
  // EVT-25758540649 on the next rework and pushed the sequence permanently into
  // the tens of billions, where the ten-odd anchored `^EVT-(\d+)$` readers would
  // have accepted it. record-identity owns the question now, and it parses only
  // a full `PREFIX-<digits>` id.
  const rows = activeDb.select({ id: eventsTable.id }).from(eventsTable).all();
  return nextSequencedId(rows.map((row) => row.id as string), "EVT");
}

function phaseIndex(phase: RunPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

function assertKnownPhase(phase: ReworkReviewPhase, fromPhase: RunPhase | undefined): asserts fromPhase is RunPhase {
  if (!fromPhase || phaseIndex(fromPhase) === -1 || !PHASE_TO_READY_STATUS[phase]) {
    throw new Error(`Unsupported rework phase: ${phase}`);
  }
}

function isPathInside(filePath: string, root: string): boolean {
  const resolved = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

export interface ReworkFaultInjection {
  beforeStageRename?: (original: string, index: number) => void;
  afterStage?: () => void;
  beforeDbCommit?: () => void;
  beforeStagingCleanup?: () => void;
}

interface StagedPath {
  original: string;
  staged: string;
}

function stagePaths(
  paths: string[],
  changeDir: string,
  beforeRename?: (original: string, index: number) => void,
): { stagingDir: string; entries: StagedPath[] } {
  const stagingDir = path.join(changeDir, `.rework-staging-${randomUUID()}`);
  const candidates = [...new Set(paths.map((candidate) => path.resolve(candidate)))]
    .filter((candidate) => isPathInside(candidate, changeDir) && fs.existsSync(candidate))
    .sort((left, right) => right.length - left.length);
  const entries: StagedPath[] = [];
  if (candidates.length === 0) return { stagingDir, entries };
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    for (const [index, original] of candidates.entries()) {
      beforeRename?.(original, index);
      const staged = path.join(stagingDir, `${index}-${path.basename(original)}`);
      fs.renameSync(original, staged);
      entries.push({ original, staged });
    }
  } catch (error) {
    restoreStagedPaths(entries, stagingDir);
    throw error;
  }
  return { stagingDir, entries };
}

function restoreStagedPaths(entries: StagedPath[], stagingDir: string): void {
  for (const entry of [...entries].reverse()) {
    if (!fs.existsSync(entry.staged)) continue;
    fs.mkdirSync(path.dirname(entry.original), { recursive: true });
    fs.renameSync(entry.staged, entry.original);
  }
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

function rootFilesToClear(changeDir: string, fromPhase: RunPhase): string[] {
  const fromIdx = phaseIndex(fromPhase);
  return PHASE_ORDER
    .filter((phase) => phaseIndex(phase) >= fromIdx)
    .flatMap((phase) => ROOT_FILES_BY_PHASE[phase].map((fileName) => path.join(changeDir, fileName)));
}

function extraPathsToClear(changeDir: string, fromPhase: RunPhase): string[] {
  if (phaseIndex(fromPhase) > phaseIndex("implement")) return [];

  const reportsDir = path.join(changeDir, "reports");
  const buildReports = fs.existsSync(reportsDir)
    ? fs
      .readdirSync(reportsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^build-\d+-report\.md$/.test(entry.name))
      .map((entry) => path.join(reportsDir, entry.name))
    : [];

  return [
    path.join(changeDir, "build"),
    ...buildReports,
  ];
}

export async function reworkChangeWithDb(
  activeDb: DbLike,
  projectId: string,
  changeId: string,
  phase: ReworkReviewPhase,
  faults: ReworkFaultInjection = {},
): Promise<Change> {
  const { artifacts, changes, events, findings, projects, runs } = await loadSchema();
  const change = activeDb
    .select()
    .from(changes)
    .where(and(eq(changes.id, changeId), eq(changes.projectId, projectId)))
    .get();
  if (!change) throw new Error(`Change not found: ${changeId}`);

  // D6 audit (docs/state-projection-audit-2026-07-14.md): this guard used to
  // list only 4 of the 10 running statuses, so /rework could fire while e.g.
  // Review had a live run in flight -- deleting that run (laterPhases below)
  // and force-setting changes.status without going through assertLegalTransition,
  // orphaning the run's pipeline_jobs/provider_run_processes rows.
  if (RUNNING_CHANGE_STATUSES.has(change.status as ChangeStatus)) {
    throw new Error(`Cannot rework while change is in ${change.status}`);
  }

  const project = activeDb
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const fromPhase = PHASE_TO_RUN_PHASE[phase];
  assertKnownPhase(phase, fromPhase);
  const fromIdx = phaseIndex(fromPhase);
  const includeCurrentRun = fromPhase === "test_plan" || fromPhase === "implement";
  const laterPhases = PHASE_ORDER.filter((candidate) =>
    includeCurrentRun ? phaseIndex(candidate) >= fromIdx : phaseIndex(candidate) > fromIdx
  );
  const laterRuns = laterPhases.length === 0
    ? []
    : activeDb
      .select()
      .from(runs)
      .where(and(eq(runs.changeId, changeId), inArray(runs.phase, laterPhases)))
      .all();
  const laterRunIds = laterRuns.map((run) => run.id);
  const changeDir = path.join(project.repoPath, ".ship", "changes", changeId);

  const laterArtifacts = laterRunIds.length > 0
    ? activeDb
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.changeId, changeId), inArray(artifacts.runId, laterRunIds)))
      .all()
    : [];

  const pathsToClear = [
    ...laterArtifacts.map((artifact) => artifact.path),
    ...rootFilesToClear(changeDir, fromPhase),
    ...extraPathsToClear(changeDir, fromPhase),
  ];
  let staged: ReturnType<typeof stagePaths> | null = null;

  const now = nowISO();
  const targetStatus = PHASE_TO_READY_STATUS[phase];
  const patch: Partial<Change> = {
    status: targetStatus,
    blockedPhase: null,
    reworkFromPhase: fromPhase,
    updatedAt: now,
  };
  if (fromPhase !== "fix_findings") {
    patch.fixIterations = 0;
  }

  try {
    staged = stagePaths(pathsToClear, changeDir, faults.beforeStageRename);
    faults.afterStage?.();
    withSqliteWriteRetry("change-rework.apply", () => activeDb.transaction((transaction) => {
      const tx = transaction as unknown as DbLike;
      if (laterRunIds.length > 0) {
        // Was four hand-written deletes -- findings, artifacts, events, runs --
        // against the sixteen tables that actually reference a run, so every
        // rework died on SQLITE_CONSTRAINT_FOREIGNKEY and rolled back: all 21
        // phase/change combinations returned 400. The closure is derived from
        // schema.ts now (run-delete-plan.test.ts), and the pointers that belong
        // to rows outliving the run are released rather than deleted.
        //
        // The DELETE/UPDATE stay tagged templates at the call site: as in
        // change-service.deleteChangeRecordsWithDb, db-write-inventory only
        // recognises db.run(sql`...`) as a write point.
        for (const clear of RUN_POINTER_CLEARS) {
          tx.run(sql`UPDATE ${sql.identifier(clear.table)} SET ${sql.identifier(clear.column)} = NULL WHERE ${clear.where(laterRunIds)}`);
        }
        for (const step of RUN_DELETE_PLAN) {
          tx.run(sql`DELETE FROM ${sql.identifier(step.table)} WHERE ${step.where(laterRunIds)}`);
        }
      }
      if (fromIdx <= phaseIndex("local_check")) {
        // Review findings are exempt for the same reason pipeline-qa-stage-service
        // exempts them when it clears a change's findings: they are Review
        // lineage, not local-check output. Deleting them here discarded that
        // lineage, and -- because review_prior_finding_reviews.prior_finding_id
        // is NOT NULL -- also raised SQLITE_CONSTRAINT_FOREIGNKEY whenever a
        // surviving review attempt had already re-reviewed one of them, which is
        // what made /rework Check and /rework Fix fail even though neither
        // deletes a review run. Findings belonging to a run that *is* being
        // deleted are removed above, review-sourced or not.
        tx.delete(findings).where(and(eq(findings.changeId, changeId), ne(findings.source, "review"))).run();
      }
      tx.update(changes).set(patch).where(eq(changes.id, changeId)).run();
      tx.insert(events).values({
        id: nextEventId(tx, events),
        changeId,
        runId: null,
        type: "change_status_changed",
        message: `Rework ${phase} → ${targetStatus}`,
        rawJson: JSON.stringify({
          action: "rework",
          phase,
          fromPhase,
          from: change.status,
          to: targetStatus,
          deletedRunIds: laterRunIds,
        }),
        createdAt: now,
      }).run();
      faults.beforeDbCommit?.();
    }));
  } catch (error) {
    if (staged) restoreStagedPaths(staged.entries, staged.stagingDir);
    throw error;
  }

  try {
    faults.beforeStagingCleanup?.();
    fs.rmSync(staged.stagingDir, { recursive: true, force: true });
  } catch {
    // DB no longer references staged artifacts; a later maintenance pass may remove the staging directory.
  }

  await logReworked({ changeId, phase, fromPhase, targetStatus, deletedRunIds: laterRunIds });
  return { ...change, ...patch } as Change;
}

export async function reworkChange(
  projectId: string,
  changeId: string,
  phase: ReworkReviewPhase
): Promise<Change> {
  const { db } = await import("../db");
  return reworkChangeWithDb(db, projectId, changeId, phase);
}
