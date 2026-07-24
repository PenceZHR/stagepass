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

interface CreateChangeDialogProps {
  projectId: string;
  onCreated: (change: { id: string }) => void;
}

async function readJsonResponse(res: Response): Promise<Record<string, unknown>> {
  try {
    const data = await res.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function CreateChangeDialog({
  projectId,
  onCreated,
}: CreateChangeDialogProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch(`/api/projects/${projectId}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const change = await readJsonResponse(res);

      if (!res.ok) {
        setError(typeof change.error === "string" ? change.error : "Failed to create change");
        return;
      }

      if (typeof change.id !== "string") {
        setError("Failed to create change: missing change id");
        return;
      }

      setOpen(false);
      setTitle("");
      onCreated({ id: change.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create change");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className={buttonVariants()}>
        New Change
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a Change</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="title">What do you want to build or fix?</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Add dark mode toggle to the header"
              required
            />
            <p className="text-xs text-muted-foreground">
              Just describe your idea. AI will help you refine it into a spec.
            </p>
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Button type="submit" disabled={loading}>
            {loading ? "Creating..." : "Start"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
