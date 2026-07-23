import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  artifacts,
  changes,
  events,
  projects,
  runs,
} from "../db/schema";
import { createChildLogger } from "../logger";
import type { AiProvider, Change, ChangeStatus } from "../types";
import { RUNNING_CHANGE_STATUSES } from "../state-machine/transitions";
import { transitionChangeStatus } from "./change-status-service";
import { CHANGE_DELETE_PLAN } from "./change-delete-plan";
import { branchExists, checkoutBranch, createBranch, generateChangeBranchName, getCurrentBranch, getDefaultBranch } from "./git-service";
import { syncProjectGitState } from "./project-git-state-service";
import { nextSequencedId } from "./record-identity";
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

/**
 * Change ids are allocated max+1, not lowest-free-gap.
 *
 * The gap-filling version handed a brand new change the id of a deleted one,
 * and because the git branch is named after the id -- and deleteChange leaves
 * that branch in place, and createChange checks out a branch that already
 * exists -- the new change silently started from the deleted change's commits.
 * See nextSequencedId's comment for the reproduction.
 */
async function nextChangeId(): Promise<string> {
  const rows = db.select({ id: changes.id }).from(changes).all();
  return nextSequencedId(rows.map((row) => row.id as string), "CHG");
}

async function nextEventId(): Promise<string> {
  const rows = db.select({ id: events.id }).from(events).all();
  return nextSequencedId(rows.map((row) => row.id as string), "EVT");
}

async function nextArtifactId(): Promise<string> {
  const rows = db.select({ id: artifacts.id }).from(artifacts).all();
  return nextSequencedId(rows.map((row) => row.id as string), "ART");
}

/** Bound on the disambiguating suffix, so a broken branchExists cannot spin forever. */
const MAX_BRANCH_NAME_ATTEMPTS = 100;

/**
 * A branch name for this change that no branch currently holds.
 *
 * createChange used to `git checkout` the branch when the name was already
 * taken, which is how a deleted change's work became a new change's starting
 * point. The path was reachable because change ids get recycled (deleting the
 * newest change frees its number again -- max+1 over live rows is not a
 * high-water mark) and because `generateChangeBranchName` is a pure function of
 * id and title, so re-creating a change with the same title after deleting it
 * regenerates the identical branch name. Reproduced end to end on 2026-07-22:
 * create -> commit -> delete -> create returned CHG-001, checked out
 * `ship/chg-001/登录页重构`, and the deleted change's committed file was in the
 * working tree.
 *
 * Adopting the branch is wrong (the new change inherits foreign commits) and so
 * is deleting it (it can hold unmerged work, and this runs behind a UI button),
 * so the collision is resolved by taking a different name instead. The suffix is
 * recorded on the change row like any other branch name, so nothing downstream
 * has to know it happened.
 *
 * NOTE: this makes the *branch* unique, which is the reported defect. It does
 * not make the new branch's *base commit* independent -- createBranch cuts from
 * whatever HEAD is currently on, and nothing in the pipeline ever returns HEAD
 * to the default branch. That is a separate, wider question.
 */
function resolveFreeChangeBranchName(
  repoPath: string,
  changeId: string,
  title: string,
): string {
  const desired = generateChangeBranchName(changeId, title);
  if (!branchExists(repoPath, desired)) return desired;

  for (let suffix = 2; suffix < MAX_BRANCH_NAME_ATTEMPTS; suffix += 1) {
    const candidate = `${desired}-${suffix}`;
    if (branchExists(repoPath, candidate)) continue;
    log.warn(
      { changeId, desired, gitBranch: candidate },
      "Branch name was already taken (typically left behind by a deleted change); cut a distinct branch instead of reusing it",
    );
    return candidate;
  }
  throw new Error(
    `Cannot create change ${changeId}: ${MAX_BRANCH_NAME_ATTEMPTS} branch names starting at ${desired} are all taken`,
  );
}

interface CreateChangeInput {
  projectId: string;
  title: string;
  specMarkdown?: string;
  provider?: AiProvider;
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
    gitBranch = resolveFreeChangeBranchName(project.repoPath, id, input.title);
    createBranch(project.repoPath, gitBranch);
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

  // The status check alone is not enough. RUNNING_CHANGE_STATUSES deliberately
  // omits DELIVERY_PENDING (see its comment in state-machine/transitions.ts:
  // including it would forbid starting any sibling change until someone clicks
  // 运行交付), but pipeline-delivery-stage-service declares
  // `runningStatus: "DELIVERY_PENDING"` -- the same status covers both "parked
  // waiting for a human" and "the delivery run is executing right now".
  //
  // So a change could be deleted mid-run: verified 2026-07-21 against a copy of
  // the production DB, DELETE returned 200 while a delivery run sat at
  // status="running", taking the change row, all 24 runs rows and the on-disk
  // .ship/changes/<id> directory with it while the worker still held them.
  //
  // Ask the runs table what is actually in flight rather than inferring it from
  // the change status. RETRO_PENDING has the same shape and is covered too.
  const inFlight = db
    .select({ id: runs.id, phase: runs.phase })
    .from(runs)
    .where(and(eq(runs.changeId, id), eq(runs.status, "running")))
    .all();
  if (inFlight.length > 0) {
    const phases = [...new Set(inFlight.map((run) => run.phase))].sort().join(", ");
    throw new Error(
      `Cannot delete change while a run is still in flight (${phases}). ` +
      `Stop or block the run first.`,
    );
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

  // The git branch is deliberately NOT deleted: it can hold unmerged commits,
  // and this function is reachable from a UI button. Say so, because the branch
  // outliving the change is exactly the state that used to get silently
  // adopted by the next change to be handed this id.
  //
  // But HEAD must not be left standing on it. createBranch is `git checkout -b`,
  // which cuts from wherever HEAD happens to be, and nothing in this codebase
  // ever moves HEAD back -- there is no `git merge` anywhere, so successive
  // changes deliberately stack, each cut from the previous one's tip. That
  // stacking is load-bearing (verified in the shipped repo: `main` holds a
  // single init commit and never advances, while ship/chg-003 sits three ahead
  // with HEAD parked on it), so cutting new branches from the default branch
  // instead would start every change from an empty tree and silently drop all
  // delivered work. The narrow defect is only this: deleting a change while
  // HEAD is on its branch makes the NEXT change stack on work a human just
  // threw away. Step back one place in the stack instead.
  if (project?.gitEnabled && change.gitBranch) {
    moveHeadOffDeletedBranch(project, change.gitBranch, id);
  }

  log.info(
    { changeId: id, retainedGitBranch: change.gitBranch },
    change.gitBranch
      ? "Change deleted; its git branch is retained and must be removed by hand if unwanted"
      : "Change deleted",
  );
}

/**
 * Leave HEAD somewhere that survives the deletion: the newest remaining
 * change's branch (the tip this one was cut from, so the rest of the stack is
 * preserved), or the project's default branch when no change is left.
 *
 * Best-effort by design. A checkout can fail for reasons that have nothing to
 * do with the deletion -- a dirty worktree, most obviously -- and the change
 * row and its directory are already gone by the time we get here. Failing the
 * whole delete over where HEAD points would turn a completed operation into an
 * error the caller cannot act on, so this warns and leaves HEAD alone.
 */
function moveHeadOffDeletedBranch(
  project: typeof projects.$inferSelect,
  deletedBranch: string,
  changeId: string,
): void {
  try {
    if (getCurrentBranch(project.repoPath) !== deletedBranch) return;

    // Ordered by change id, not by branch name: the branch name embeds the
    // title after the id, so sorting on it would order by title whenever two
    // ids share a prefix.
    const survivor = db
      .select({ id: changes.id, gitBranch: changes.gitBranch })
      .from(changes)
      .where(eq(changes.projectId, project.id))
      .all()
      .filter((row): row is { id: string; gitBranch: string } => Boolean(row.gitBranch))
      .sort((left, right) => right.id.localeCompare(left.id))[0]?.gitBranch ?? null;

    // Never the branch being deleted, whatever the candidate list says. The
    // stored gitDefaultBranch turned out to be exactly that in the shipped
    // database (see getDefaultBranch), so this helper faithfully checked out
    // the branch it was supposed to be stepping off. Probing git directly is
    // the last resort, because the stored column has proven wrong.
    const target = [survivor, project.gitDefaultBranch, getDefaultBranch(project.repoPath)]
      .find((candidate): candidate is string =>
        Boolean(candidate) && candidate !== deletedBranch && branchExists(project.repoPath, candidate!))
      ?? null;
    if (!target) {
      log.warn(
        { changeId, deletedBranch },
        "HEAD is on the deleted change's branch and no surviving branch was found to move to",
      );
      return;
    }

    checkoutBranch(project.repoPath, target);
    log.info(
      { changeId, deletedBranch, movedHeadTo: target },
      "HEAD was on the deleted change's branch; moved it so the next change does not stack on discarded work",
    );
  } catch (error) {
    log.warn(
      { changeId, deletedBranch, err: error instanceof Error ? error.message : String(error) },
      "Could not move HEAD off the deleted change's branch; the next change would stack on discarded work",
    );
  }
}
