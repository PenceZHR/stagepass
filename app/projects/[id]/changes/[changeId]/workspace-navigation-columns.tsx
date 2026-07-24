"use client";

import { FolderKanban, GitPullRequestArrow } from "lucide-react";

import type {
  WorkspaceChange,
  WorkspaceProject,
} from "./use-workspace-navigation";

export function WorkspaceNavigationColumns({
  projects,
  changes,
  selectedProjectId,
  selectedChangeId,
  loadingProjects,
  loadingChanges,
  error,
  onSelectProject,
  onSelectChange,
}: {
  projects: WorkspaceProject[];
  changes: WorkspaceChange[];
  selectedProjectId: string;
  selectedChangeId: string;
  loadingProjects: boolean;
  loadingChanges: boolean;
  error: string;
  onSelectProject: (projectId: string) => void;
  onSelectChange: (changeId: string) => void;
}) {
  return (
    <>
      <WorkspaceColumn
        title="Projects"
        count={projects.length}
        loading={loadingProjects}
        dataAttribute="projects"
      >
        {projects.map((project) => {
          const active = project.id === selectedProjectId;
          return (
            <li key={project.id}>
              <button
                type="button"
                className="stagepass-workspace-row"
                data-active={active ? "true" : "false"}
                aria-current={active ? "page" : undefined}
                onClick={() => onSelectProject(project.id)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FolderKanban className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                  <span className="min-w-0">
                    <strong className="stagepass-serif block truncate text-sm font-normal">
                      {project.name}
                    </strong>
                    <small className="mt-1 block truncate font-mono text-[0.61rem] opacity-55">
                      {project.id}
                    </small>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </WorkspaceColumn>

      <WorkspaceColumn
        title="Changes"
        count={changes.length}
        loading={loadingChanges}
        dataAttribute="changes"
        error={error}
      >
        {changes.map((change) => {
          const active = change.id === selectedChangeId;
          return (
            <li key={change.id}>
              <button
                type="button"
                className="stagepass-workspace-row"
                data-active={active ? "true" : "false"}
                aria-current={active ? "page" : undefined}
                onClick={() => onSelectChange(change.id)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <GitPullRequestArrow className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                  <span className="min-w-0">
                    <strong className="stagepass-serif block truncate text-sm font-normal">
                      {change.title}
                    </strong>
                    <small className="mt-1 flex gap-1.5 font-mono text-[0.58rem] opacity-60">
                      <span>{change.id}</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{change.status}</span>
                    </small>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </WorkspaceColumn>
    </>
  );
}

function WorkspaceColumn({
  title,
  count,
  loading,
  dataAttribute,
  error,
  children,
}: {
  title: string;
  count: number;
  loading: boolean;
  dataAttribute: "projects" | "changes";
  error?: string;
  children: React.ReactNode;
}) {
  const dataProps = dataAttribute === "projects"
    ? { "data-workspace-projects": true }
    : { "data-workspace-changes": true };

  return (
    <aside
      {...dataProps}
      className="stagepass-workspace-column min-w-0 border-white/10 lg:border-r"
      aria-label={title}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-4">
        <div>
          <p className="stagepass-kicker">Workspace</p>
          <h2 className="stagepass-serif mt-1 text-lg">{title}</h2>
        </div>
        <span className="font-mono text-[0.62rem] text-muted-foreground">
          {loading ? "—" : String(count).padStart(2, "0")}
        </span>
      </div>

      {error ? (
        <p className="mx-4 mt-4 border-l-2 border-destructive pl-3 text-xs text-muted-foreground">
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="space-y-px p-2" aria-busy="true">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-14 animate-pulse rounded-md bg-white/[0.035]" />
          ))}
        </div>
      ) : (
        <ul className="stagepass-workspace-list p-2" role="list">
          {children}
        </ul>
      )}
    </aside>
  );
}
