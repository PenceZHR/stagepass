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
import { deleteChangeRecords } from "./change-service";
import { resolveGitState, syncProjectGitState } from "./project-git-state-service";
import { resolveProvider } from "./ai-provider-service";
import type { AiProvider } from "../types";
import fs from "fs";
import path from "path";

const log = createChildLogger("project-service");

function generateProjectId(seq: number): string {
  return `PRJ-${String(seq).padStart(3, "0")}`;
}

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

  const { gitEnabled, gitDefaultBranch } = input.gitEnabled
    ? resolveGitState(absPath)
    : { gitEnabled: 0, gitDefaultBranch: null };

  const maxRow = db
    .select({ id: projects.id })
    .from(projects)
    .where(like(projects.id, "PRJ-%"))
    .orderBy(sql`CAST(SUBSTR(${projects.id}, 5) AS INTEGER) DESC`)
    .limit(1)
    .get();
  const maxSeq = maxRow ? parseInt(maxRow.id.slice(4), 10) : 0;
  const id = generateProjectId(maxSeq + 1);
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

  const maxEvt = db
    .select({ id: events.id })
    .from(events)
    .where(like(events.id, "EVT-%"))
    .orderBy(sql`CAST(SUBSTR(${events.id}, 5) AS INTEGER) DESC`)
    .limit(1)
    .get();
  const maxEvtSeq = maxEvt ? parseInt(maxEvt.id.slice(4), 10) : 0;
  const evtId = `EVT-${String(maxEvtSeq + 1).padStart(3, "0")}`;

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

export async function deleteProject(id: string): Promise<void> {
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) throw new Error(`Project not found: ${id}`);

  const projectChanges = db
    .select()
    .from(changes)
    .where(eq(changes.projectId, id))
    .all();

  for (const change of projectChanges) {
    deleteChangeRecords(change.id);
  }

  db.delete(changes).where(eq(changes.projectId, id)).run();
  db.delete(events)
    .where(and(isNull(events.changeId), like(events.rawJson, `%${id}%`)))
    .run();
  db.delete(projects).where(eq(projects.id, id)).run();

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
    resolveProvider(provider, project.contextProvider as AiProvider | null | undefined)
  );
}
