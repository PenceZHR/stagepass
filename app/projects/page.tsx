"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CreateProjectDialog } from "./create-project-dialog";

interface Project {
  id: string;
  name: string;
  repoPath: string;
  gitEnabled?: number;
  gitDefaultBranch?: string | null;
  createdAt: string;
}

async function fetchProjects(): Promise<Project[]> {
  const res = await fetch("/api/projects");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Failed to load projects");
  }
  return Array.isArray(data) ? data : [];
}

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  function load(showLoading = true) {
    if (showLoading) setLoading(true);
    setLoadError("");
    fetchProjects()
      .then((data) => {
        setProjects(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        console.error("[projects] fetch failed", err);
        setLoadError(err instanceof Error ? err.message : "Failed to load projects");
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((data) => {
        if (cancelled) return;
        setProjects(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[projects] fetch failed", err);
        setLoadError(err instanceof Error ? err.message : "Failed to load projects");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/projects/${deleteTarget.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Failed to delete project");
      }
      setDeleteTarget(null);
      load();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete project");
    } finally {
      setDeleteBusy(false);
    }
  }

  function handleProjectCreated(project: { id: string }) {
    router.push(`/projects/${project.id}`);
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projects</h1>
        <CreateProjectDialog onCreated={handleProjectCreated} />
      </div>

      {loading ? (
        <p className="text-muted-foreground">Loading projects...</p>
      ) : loadError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <p>{loadError}</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => load()}>
            Retry
          </Button>
        </div>
      ) : projects.length === 0 ? (
        <p className="text-muted-foreground">No projects yet. Create one to get started.</p>
      ) : (
        <div className="space-y-3">
          {projects.map((p) => (
            <Card
              key={p.id}
              className="group flex flex-row items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/50"
            >
              <Link href={`/projects/${p.id}`} className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-base font-medium">{p.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{p.id}</span>
                  {p.gitEnabled ? (
                    <Badge variant="success">Git</Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground truncate">{p.repoPath}</p>
              </Link>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-opacity"
                onClick={() => setDeleteTarget(p)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除项目</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除项目 &quot;{deleteTarget?.name}&quot; 吗？此操作将删除所有关联的 changes 和 .ship/ 目录，且不可撤销。
            </AlertDialogDescription>
            {deleteError ? (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                {deleteError}
              </div>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
              disabled={deleteBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBusy ? "删除中..." : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
