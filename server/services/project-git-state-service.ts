import { eq } from "drizzle-orm";
import { db } from "../db";
import { projects } from "../db/schema";
import type { Project } from "../types";
import { getDefaultBranch, hasCommits, isGitRepo } from "./git-service";

function nowISO(): string {
  return new Date().toISOString();
}

export function resolveGitState(repoPath: string): { gitEnabled: number; gitDefaultBranch: string | null } {
  if (!isGitRepo(repoPath) || !hasCommits(repoPath)) {
    return { gitEnabled: 0, gitDefaultBranch: null };
  }
  return { gitEnabled: 1, gitDefaultBranch: getDefaultBranch(repoPath) };
}

export async function syncProjectGitState(projectId: string): Promise<Project> {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get() as Project | undefined;
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const gitState = resolveGitState(project.repoPath);
  if (
    project.gitEnabled === gitState.gitEnabled &&
    project.gitDefaultBranch === gitState.gitDefaultBranch
  ) {
    return project;
  }

  const now = nowISO();
  db.update(projects)
    .set({ ...gitState, updatedAt: now })
    .where(eq(projects.id, projectId))
    .run();

  return { ...project, ...gitState, updatedAt: now };
}
