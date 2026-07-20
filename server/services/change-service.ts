import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  artifacts,
  changes,
  events,
  projects,
} from "../db/schema";
import { createChildLogger } from "../logger";
import type { Change, ChangeStatus } from "../types";
import { RUNNING_CHANGE_STATUSES } from "../state-machine/transitions";
import { transitionChangeStatus } from "./change-status-service";
import { CHANGE_DELETE_PLAN } from "./change-delete-plan";
import {
  branchExists,
  checkoutBranch,
  createBranch,
  generateChangeBranchName,
  getCurrentBranch,
} from "./git-service";
import { syncProjectGitState } from "./project-git-state-service";
import fs from "fs";
import path from "path";

const log = createChildLogger("change-service");

function nowISO(): string {
  return new Date().toISOString();
}

/**
 * The branch an adoption should commit on, repairing a change that never got
 * one.
 *
 * createChange assigns a per-change branch when the project has git, so a null
 * gitBranch means that step could not run -- typically the repository was not a
 * git repository yet when the change was opened. Callers used to read that null
 * as `commit.enabled = false` and adopt without committing, which is where the
 * pipeline came apart: HEAD stayed on the run's base commit while the working
 * tree filled up with adopted output, so the next fix cut its patch from that
 * same base and collided with the files already there ("already exists in
 * working directory"). Committing by hand to clear it moved HEAD instead, and
 * adoption then refused for good with git_head_drift. Silently not committing
 * was the root of both.
 *
 * The repair adopts the branch the work is already on rather than creating the
 * per-change branch retroactively: by the time this runs, earlier builds have
 * been adopted onto the current branch, and moving off it now would strand that
 * history. New changes still get their own branch from createChange.
 */
export function resolveAdoptionCommitBranch(input: {
  changeId: string;
  gitEnabled: boolean;
  repoPath: string;
  gitBranch: string | null;
}): string | null {
  if (!input.gitEnabled) return null;
  if (input.gitBranch) return input.gitBranch;

  // No isGitRepo() pre-check: it runs the same rev-parse this does, so it can
  // only ever agree, and a mutation test confirmed no behaviour distinguishes
  // the two. Both a non-repository and a repository with no commits yet fail
  // here, and both should leave adoption uncommitted.
  let currentBranch: string;
  try {
    currentBranch = getCurrentBranch(input.repoPath);
  } catch {
    return null;
  }
  if (!currentBranch) return null;

  db.update(changes)
    .set({ gitBranch: currentBranch, updatedAt: nowISO() })
    .where(eq(changes.id, input.changeId))
    .run();
  log.info(
    { changeId: input.changeId, gitBranch: currentBranch },
    "Adopted the current branch for a change that never got one, so adoption can commit",
  );
  return currentBranch;
}

async function nextChangeId(): Promise<string> {
  const rows = db.select({ id: changes.id }).from(changes).all();
  const usedNums = new Set<number>();
  for (const row of rows) {
    const match = (row.id as string).match(/\d+$/);
    if (match) usedNums.add(parseInt(match[0], 10));
  }
  let n = 1;
  while (usedNums.has(n)) n++;
  return `CHG-${String(n).padStart(3, "0")}`;
}

async function nextEventId(): Promise<string> {
  const rows = db.select({ id: events.id }).from(events).all();
  const used = new Set<string>();
  let maxNum = 0;
  for (const row of rows) {
    const id = row.id as string;
    used.add(id);
    const match = id.match(/^EVT-(\d+)$/);
    if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
  }
  let nextNum = maxNum + 1;
  let candidate = `EVT-${String(nextNum).padStart(3, "0")}`;
  while (used.has(candidate)) {
    nextNum += 1;
    candidate = `EVT-${String(nextNum).padStart(3, "0")}`;
  }
  return candidate;
}

async function nextArtifactId(): Promise<string> {
  const rows = db.select({ id: artifacts.id }).from(artifacts).all();
  let maxNum = 0;
  for (const row of rows) {
    const match = (row.id as string).match(/\d+$/);
    if (match) maxNum = Math.max(maxNum, parseInt(match[0], 10));
  }
  return `ART-${String(maxNum + 1).padStart(3, "0")}`;
}

interface CreateChangeInput {
  projectId: string;
  title: string;
  specMarkdown?: string;
  provider?: "codex" | "claude";
}

export async function createChange(input: CreateChangeInput): Promise<Change> {
  const existingProject = db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();

  if (!existingProject) {
    throw new Error(`Project not found: ${input.projectId}`);
  }

  const project = await syncProjectGitState(input.projectId);

  if (project.prdStatus !== "ready") {
    throw new Error("Cannot create change: PRD is not ready");
  }

  const id = await nextChangeId();
  const now = nowISO();

  const changeDir = path.join(project.repoPath, ".ship", "changes", id);
  fs.mkdirSync(changeDir, { recursive: true });

  const hasSpec = !!input.specMarkdown;
  if (hasSpec) {
    fs.writeFileSync(path.join(changeDir, "spec.md"), input.specMarkdown!);
  }

  const initialStatus = "INTAKE_PENDING";

  // Create git branch if git is enabled
  let gitBranch: string | null = null;
  if (project.gitEnabled) {
    gitBranch = generateChangeBranchName(id, input.title);
    if (branchExists(project.repoPath, gitBranch)) {
      checkoutBranch(project.repoPath, gitBranch);
    } else {
      createBranch(project.repoPath, gitBranch);
    }
    log.info({ changeId: id, gitBranch }, "Git branch created for change");
  }

  const change: Change = {
    id,
    projectId: input.projectId,
    title: input.title,
    status: initialStatus,
    provider: input.provider || "codex",
    codexThreadId: null,
    fixIterations: 0,
    suspendedByPrd: 0,
    preSuspendStatus: null,
    gitBranch,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(changes).values(change).run();

  if (hasSpec) {
    const artId = await nextArtifactId();
    db.insert(artifacts)
      .values({
        id: artId,
        changeId: id,
        runId: null,
        type: "spec",
        path: path.join(changeDir, "spec.md"),
        createdAt: now,
      })
      .run();
  }

  const evtId = await nextEventId();
  db.insert(events)
    .values({
      id: evtId,
      changeId: id,
      runId: null,
      type: "change_created",
      message: `Change ${id} created: ${input.title}`,
      rawJson: JSON.stringify({ changeId: id, projectId: input.projectId }),
      createdAt: now,
    })
    .run();

  log.info({ changeId: id, projectId: input.projectId }, "Change created");
  return change;
}

export async function getChange(id: string): Promise<Change | undefined> {
  return db.select().from(changes).where(eq(changes.id, id)).get() as
    | Change
    | undefined;
}

export async function getChangeForProject(
  projectId: string,
  id: string
): Promise<Change | undefined> {
  return db
    .select()
    .from(changes)
    .where(and(eq(changes.id, id), eq(changes.projectId, projectId)))
    .get() as Change | undefined;
}

export async function listChangesByProject(projectId: string): Promise<Change[]> {
  return db
    .select()
    .from(changes)
    .where(eq(changes.projectId, projectId))
    .all() as Change[];
}

export async function updateChangeStatus(
  id: string,
  status: ChangeStatus
): Promise<Change> {
  const updated = transitionChangeStatus({
    changeId: id,
    to: status,
    message: `Status changed to ${status}`,
  });
  log.info({ changeId: id, to: status }, "Status changed");
  return updated;
}

type ChangeDeleteRunner = Pick<typeof db, "run">;

// The DELETE stays a tagged template at the call site: db-write-inventory only
// recognises db.run(sql`...`) as a write point, so hiding it behind a helper
// would drop this write out of the governed inventory.
function deleteChangeRecordsWithDb(db: ChangeDeleteRunner, changeId: string): void {
  for (const step of CHANGE_DELETE_PLAN) {
    db.run(sql`DELETE FROM ${sql.identifier(step.table)} WHERE ${step.where(changeId)}`);
  }
}

export function deleteChangeRecords(changeId: string): void {
  db.transaction((tx) => deleteChangeRecordsWithDb(tx, changeId));
}

export async function deleteChange(id: string): Promise<void> {
  const change = db.select().from(changes).where(eq(changes.id, id)).get();
  if (!change) throw new Error(`Change not found: ${id}`);

  if (RUNNING_CHANGE_STATUSES.has(change.status as ChangeStatus)) {
    throw new Error(`Cannot delete change in ${change.status} state`);
  }

  const project = db.select().from(projects).where(eq(projects.id, change.projectId)).get();

  // Delete the complete DB graph atomically; order matters for FK constraints.
  db.transaction((tx) => {
    deleteChangeRecordsWithDb(tx, id);
    tx.delete(changes).where(eq(changes.id, id)).run();
  });

  // Delete .ship/changes/<id> directory
  if (project) {
    const changeDir = path.join(project.repoPath, ".ship", "changes", id);
    if (fs.existsSync(changeDir)) {
      fs.rmSync(changeDir, { recursive: true, force: true });
    }
  }

  log.info({ changeId: id }, "Change deleted");
}
