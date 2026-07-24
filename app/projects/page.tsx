"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, FolderKanban, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    <div className="stagepass-page">
      <header className="stagepass-topbar">
        <span className="stagepass-wordmark">stagepass</span>
        <span className="text-xs text-muted-foreground">Local control plane</span>
        <span className="stagepass-local-state">Local ready</span>
      </header>

      <main className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
        <section className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="max-w-3xl">
            <p className="stagepass-kicker">Project archive</p>
            <h1 className="stagepass-serif mt-4 text-balance text-4xl leading-[1.08] sm:text-6xl">
              Guard every change
              <span className="block text-primary/90">before it reaches the horizon.</span>
            </h1>
            <p className="mt-5 max-w-2xl text-sm leading-7 text-muted-foreground sm:text-base">
              Stagepass keeps workflow position, gate evidence and human decisions visible.
              Detailed reasoning remains in the bound Codex task.
            </p>
          </div>
          <div className="lg:pb-2">
            <CreateProjectDialog onCreated={handleProjectCreated} />
          </div>
        </section>

        <section className="stagepass-surface mt-12 overflow-hidden rounded-2xl" aria-labelledby="projects-heading">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4 sm:px-7">
            <div>
              <p className="stagepass-kicker">Workspace</p>
              <h2 id="projects-heading" className="stagepass-serif mt-1 text-xl">
                Projects
              </h2>
            </div>
            <span className="font-mono text-xs text-muted-foreground">
              {loading ? "—" : String(projects.length).padStart(2, "0")}
            </span>
          </div>

          {loading ? (
            <div className="space-y-px" aria-busy="true" aria-label="Loading projects">
              {[0, 1, 2].map((item) => (
                <div key={item} className="h-20 animate-pulse border-b border-white/8 bg-white/[0.025]" />
              ))}
            </div>
          ) : loadError ? (
            <div className="m-5 border-l-2 border-destructive px-4 py-3 text-sm text-foreground" role="alert">
              <p>{loadError}</p>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => load()}>
                Retry
              </Button>
            </div>
          ) : projects.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <FolderKanban className="mx-auto size-8 text-primary/70" aria-hidden="true" />
              <h3 className="stagepass-serif mt-4 text-xl">No projects yet</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Create a project to establish its local workflow archive.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-white/10" role="list">
              {projects.map((project) => (
                <li key={project.id} className="group flex items-center gap-3 px-5 py-5 transition hover:bg-white/[0.045] sm:px-7">
                  <Link href={`/projects/${project.id}`} className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="stagepass-serif text-lg text-foreground">{project.name}</span>
                      <span className="font-mono text-[0.68rem] text-primary/75">{project.id}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{project.repoPath}</p>
                  </Link>
                  <ArrowUpRight className="size-4 text-muted-foreground transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden="true" />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-muted-foreground opacity-70 transition hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => setDeleteTarget(project)}
                    aria-label={`删除 ${project.name}`}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="mt-5 text-center text-[0.68rem] uppercase tracking-[0.18em] text-muted-foreground/70">
          Local SQLite authority · Codex task execution · audited human gates
        </p>
      </main>

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
