"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export interface WorkspaceProject {
  id: string;
  name: string;
  repoPath: string;
  createdAt?: string;
}

export interface WorkspaceChange {
  id: string;
  projectId: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const FINISHED_CHANGE_STATUSES = new Set(["DONE", "CANCELLED"]);

function newestFirst(changes: WorkspaceChange[]): WorkspaceChange[] {
  return [...changes].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt));
}

function preferredChange(changes: WorkspaceChange[]): WorkspaceChange | null {
  const sorted = newestFirst(changes);
  return sorted.find((change) => !FINISHED_CHANGE_STATUSES.has(change.status))
    ?? sorted[0]
    ?? null;
}

async function loadProjectChanges(projectId: string): Promise<WorkspaceChange[]> {
  const response = await fetch(`/api/projects/${projectId}/changes`);
  const payload = await response.json().catch(() => []);
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string" ? payload.error : "Failed to load changes",
    );
  }
  return newestFirst(Array.isArray(payload) ? payload : []);
}

export function useWorkspaceNavigation(projectId: string, changeId: string) {
  const router = useRouter();
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [changes, setChanges] = useState<WorkspaceChange[]>([]);
  const [loadedChangesProjectId, setLoadedChangesProjectId] = useState<string | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingChanges, setLoadingChanges] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects")
      .then(async (response) => {
        const payload = await response.json().catch(() => []);
        if (!response.ok) throw new Error("Failed to load projects");
        if (!cancelled) setProjects(Array.isArray(payload) ? payload : []);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoadingProjects(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (loadedChangesProjectId === projectId) return;

    let cancelled = false;
    loadProjectChanges(projectId)
      .then((items) => {
        if (!cancelled) {
          setChanges(items);
          setLoadedChangesProjectId(projectId);
          setError("");
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setChanges([]);
          setLoadedChangesProjectId(projectId);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingChanges(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadedChangesProjectId, projectId]);

  const selectProject = useCallback(async (nextProjectId: string) => {
    if (nextProjectId === projectId) return;
    setLoadingChanges(true);
    setError("");
    try {
      const items = await loadProjectChanges(nextProjectId);
      setChanges(items);
      setLoadedChangesProjectId(nextProjectId);
      const nextChange = preferredChange(items);
      router.push(
        nextChange
          ? `/projects/${nextProjectId}/changes/${nextChange.id}`
          : `/projects/${nextProjectId}`,
      );
    } catch (reason) {
      setChanges([]);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingChanges(false);
    }
  }, [projectId, router]);

  const selectChange = useCallback((nextChangeId: string) => {
    if (nextChangeId === changeId) return;
    router.push(`/projects/${projectId}/changes/${nextChangeId}`);
  }, [changeId, projectId, router]);

  return {
    projects,
    changes,
    selectedProjectId: projectId,
    selectedChangeId: changeId,
    loadingProjects,
    loadingChanges: loadingChanges || loadedChangesProjectId !== projectId,
    error,
    selectProject,
    selectChange,
  };
}
