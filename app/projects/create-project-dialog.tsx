"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface CreateProjectDialogProps {
  onCreated: (project: { id: string }) => void;
}

async function readJsonResponse(res: Response): Promise<Record<string, unknown>> {
  try {
    const data = await res.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function CreateProjectDialog({ onCreated }: CreateProjectDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [gitEnabled, setGitEnabled] = useState(false);
  const [contextProvider, setContextProvider] = useState<"codex" | "claude">("codex");
  const [prdProvider, setPrdProvider] = useState<"codex" | "claude">("codex");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, repoPath, gitEnabled, contextProvider, prdProvider }),
      });
      const project = await readJsonResponse(res);

      if (!res.ok) {
        setError(typeof project.error === "string" ? project.error : "Failed to create project");
        return;
      }

      if (typeof project.id !== "string") {
        setError("Failed to create project: missing project id");
        return;
      }

      setOpen(false);
      setName("");
      setRepoPath("");
      setGitEnabled(false);
      setContextProvider("codex");
      setPrdProvider("codex");
      onCreated({ id: project.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className={buttonVariants()}>
        New Project
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Project Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My App"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="repoPath">Repository Path</Label>
            <Input
              id="repoPath"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/Users/you/project"
              required
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="gitEnabled"
              checked={gitEnabled}
              onChange={(e) => setGitEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <Label htmlFor="gitEnabled" className="cursor-pointer">
              启用 Git 集成
            </Label>
            <span className="text-xs text-muted-foreground">
              每个 Change 自动创建分支
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="contextProvider">Context 引擎</Label>
              <select
                id="contextProvider"
                value={contextProvider}
                onChange={(e) => setContextProvider(e.target.value as "codex" | "claude")}
                className="h-9 rounded-md border bg-background px-3 text-sm"
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
              </select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="prdProvider">PRD 引擎</Label>
              <select
                id="prdProvider"
                value={prdProvider}
                onChange={(e) => setPrdProvider(e.target.value as "codex" | "claude")}
                className="h-9 rounded-md border bg-background px-3 text-sm"
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
              </select>
            </div>
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Button type="submit" disabled={loading}>
            {loading ? "Creating..." : "Create"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
