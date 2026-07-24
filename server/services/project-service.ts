import { eq, isNull, and, like, sql } from "drizzle-orm";
import { db } from "../db";
import {
  changes,
  events,
  projects,
} from "../db/schema";
import { createChildLogger } from "../logger";
import type { Project, CreateProjectInput } from "../types";
import { scaffoldShipDir } from "./template-service";
import { initializeProjectContext } from "./context-init-service";
import { ensureFactoryRubrics, PROJECT_RUBRIC_DELETE_PLAN } from "./rubric-service";
import { PROJECT_DELETE_PLAN } from "./project-delete-plan";
import { CHANGE_DELETE_PLAN } from "./change-delete-plan";
import { syncProjectGitState } from "./project-git-state-service";
import { getDefaultBranch, hasCommits, isGitRepo } from "./repository-evidence-service";
import { resolveProviderSelection } from "./provider-selection-service";
import { nextSequencedId } from "./record-identity";
import type { AiProvider } from "../types";
import fs from "fs";
import path from "path";

const log = createChildLogger("project-service");

function nowISO(): string {
  return new Date().toISOString();
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const absPath = path.resolve(input.repoPath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Path does not exist: ${absPath}`);
  }

  const existing = db
    .select()
    .from(projects)
    .where(eq(projects.repoPath, absPath))
    .get();
  if (existing) {
    throw new Error(`Project already registered for path: ${absPath}`);
  }

  const shipDir = path.join(absPath, ".ship");
  if (fs.existsSync(shipDir)) {
    throw new Error(`Project already initialized: .ship/ exists at ${absPath}`);
  }

  const repositoryReady = isGitRepo(absPath) && hasCommits(absPath);
  const gitEnabled = repositoryReady ? 1 : 0;
  const gitDefaultBranch = repositoryReady ? getDefaultBranch(absPath) : null;

  const id = nextSequencedId(
    db.select({ id: projects.id }).from(projects).all().map((row) => row.id),
    "PRJ",
  );
  const now = nowISO();

  const project: Project = {
    id,
    name: input.name,
    repoPath: absPath,
    contextStatus: "pending",
    contextProvider: input.contextProvider,
    prdStatus: "none",
    prdProvider: input.prdProvider,
    gitEnabled,
    gitDefaultBranch,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(projects).values(project).run();

  scaffoldShipDir(absPath);

  const evtId = nextSequencedId(
    db.select({ id: events.id }).from(events).all().map((row) => row.id),
    "EVT",
  );

  db.insert(events)
    .values({
      id: evtId,
      changeId: null,
      runId: null,
      type: "project_created",
      message: `Project ${id} created`,
      rawJson: JSON.stringify({
        projectId: id,
        repoPath: absPath,
        contextProvider: input.contextProvider,
        prdProvider: input.prdProvider,
      }),
      createdAt: now,
    })
    .run();

  // A new project gets the factory rubrics up front so its drawer is populated
  // before any stage has run. Existing projects reach the same state through
  // resolveStageRubric on their next stage; this call is only what saves a brand
  // new project from having to run one first.
  ensureFactoryRubrics(id);

  log.info({ projectId: id, repoPath: absPath }, "Project created");
  return project;
}

export async function getProject(id: string): Promise<Project | undefined> {
  const project = db.select().from(projects).where(eq(projects.id, id)).get() as
    | Project
    | undefined;
  if (!project) return undefined;
  return syncProjectGitState(id);
}

export async function listProjects(): Promise<Project[]> {
  return db.select().from(projects).all() as Project[];
}

export interface DeleteProjectOptions {
  /** Test-only transaction failpoint; throwing here must roll back every row. */
  readonly beforeCommit?: () => void;
}

export async function deleteProject(id: string, options: DeleteProjectOptions = {}): Promise<void> {
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) throw new Error(`Project not found: ${id}`);

  db.transaction((tx) => {
    const projectChanges = tx
      .select()
      .from(changes)
      .where(eq(changes.projectId, id))
      .all();

    for (const change of projectChanges) {
      for (const step of CHANGE_DELETE_PLAN) {
        tx.run(sql`DELETE FROM ${sql.identifier(step.table)} WHERE ${step.where(change.id)}`);
      }
      tx.delete(changes).where(eq(changes.id, change.id)).run();
    }

    tx.delete(events)
      .where(and(isNull(events.changeId), like(events.rawJson, `%${id}%`)))
      .run();
    for (const step of PROJECT_RUBRIC_DELETE_PLAN) {
      tx.run(sql`DELETE FROM ${sql.identifier(step.table)} WHERE ${step.where(id)}`);
    }
    for (const step of PROJECT_DELETE_PLAN) {
      tx.run(sql`DELETE FROM ${sql.identifier(step.table)} WHERE ${step.where(id)}`);
    }
    options.beforeCommit?.();
  });

  const shipDir = path.join(project.repoPath, ".ship");
  if (fs.existsSync(shipDir)) {
    fs.rmSync(shipDir, { recursive: true, force: true });
  }

  log.info({ projectId: id, repoPath: project.repoPath }, "Project deleted");
}

export async function updateProjectProviders(
  id: string,
  providers: { contextProvider?: AiProvider; prdProvider?: AiProvider }
): Promise<Project> {
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) throw new Error(`Project not found: ${id}`);

  db.update(projects)
    .set({ ...providers, updatedAt: nowISO() })
    .where(eq(projects.id, id))
    .run();

  return db.select().from(projects).where(eq(projects.id, id)).get() as Project;
}

export async function regenerateProjectContext(id: string, provider?: AiProvider): Promise<void> {
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) throw new Error(`Project not found: ${id}`);

  const currentStatus = project.contextStatus;
  if (currentStatus === "generating") {
    throw new Error("Context generation already in progress");
  }

  await initializeProjectContext(
    id,
    resolveProviderSelection(provider, project.contextProvider as AiProvider | null | undefined)
  );
}
