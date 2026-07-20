"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Shared "produced file" affordance for the pipeline UI. Every panel that shows
 * an output file (changed files, .ship artifacts, plan/spec/gate outputs) renders
 * <ProducedFile>, turning a plain path string into a clickable name that opens the
 * file's content in a modal. Resolves content by artifact id when available, else
 * by path via the change file-content endpoint.
 */

export interface ProducedFileTarget {
  /** Already-known content — when present, skips the network fetch entirely. */
  content?: string | null;
  /** Repo-relative or absolute path served by the file-content endpoint. */
  path?: string;
  /** Artifact id served by the artifacts/[artifactId]/content endpoint. */
  artifactId?: string;
  /** Header label; defaults to the path basename. */
  label: string;
}

type ViewerState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; content: string; truncated: boolean };

async function fetchFileContent(
  projectId: string,
  changeId: string,
  target: { path?: string; artifactId?: string },
): Promise<{ content: string; truncated: boolean }> {
  const base = `/api/projects/${projectId}/changes/${changeId}`;
  const url = target.artifactId
    ? `${base}/artifacts/${encodeURIComponent(target.artifactId)}/content`
    : `${base}/file-content?path=${encodeURIComponent(target.path ?? "")}`;

  const res = await fetch(url);
  if (!res.ok) {
    let detail = String(res.status);
    try {
      const body = await res.json();
      if (body?.error) detail = String(body.error);
    } catch {
      // non-JSON error body — keep the status code
    }
    throw new Error(detail);
  }
  const data = await res.json();
  return { content: data.content ?? "", truncated: Boolean(data.truncated) };
}

export function FileViewerModal({
  projectId,
  changeId,
  target,
  onClose,
}: {
  projectId: string;
  changeId: string;
  target: ProducedFileTarget;
  onClose: () => void;
}) {
  const knownContent = target.content;
  const [state, setState] = useState<ViewerState>(() =>
    knownContent != null
      ? { status: "ready", content: knownContent, truncated: false }
      : { status: "loading" },
  );
  const targetPath = target.path;
  const targetArtifactId = target.artifactId;

  // Fetch on mount / when the file identity changes — but only when content
  // wasn't already supplied by the caller (skips a redundant, or in some
  // cases unresolvable, network round-trip). Initial state already reflects
  // that; the modal mounts fresh per open, so we don't reset state inside the
  // effect (that would trip react-hooks/set-state-in-effect).
  useEffect(() => {
    if (knownContent != null) return;
    let cancelled = false;
    fetchFileContent(projectId, changeId, { path: targetPath, artifactId: targetArtifactId })
      .then((r) => {
        if (!cancelled) setState({ status: "ready", content: r.content, truncated: r.truncated });
      })
      .catch((e) => {
        if (!cancelled) {
          setState({ status: "error", message: e instanceof Error ? e.message : "load failed" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, changeId, targetPath, targetArtifactId, knownContent]);

  // Portaled to document.body: callers render <ProducedFile> inline (often
  // inside a <p>), and this modal's block-level markup would otherwise nest
  // invalidly inside whatever phrasing-content parent wraps the trigger.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="mx-4 flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg bg-white p-6 shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-2">
          <h4 className="truncate font-mono text-sm" title={target.path ?? target.label}>
            {target.label}
          </h4>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="flex-1 overflow-auto">
          {state.status === "loading" && (
            <p className="text-sm text-muted-foreground">加载中…</p>
          )}
          {state.status === "error" && (
            <p className="text-sm text-red-600 dark:text-red-400">无法打开文件：{state.message}</p>
          )}
          {state.status === "ready" && (
            <pre className="rounded bg-slate-50 p-3 font-mono text-xs whitespace-pre-wrap dark:bg-slate-800">
              {state.content}
              {state.truncated && "\n\n… (内容过大，已截断)"}
            </pre>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ProducedFile({
  projectId,
  changeId,
  path,
  artifactId,
  content,
  label,
  className,
}: {
  projectId: string;
  changeId: string;
  path?: string;
  artifactId?: string;
  /** Already-known content — when present, opening skips the network fetch. */
  content?: string | null;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const displayLabel = label ?? (path ? path.split("/").pop() || path : "文件");

  // Nothing resolvable to open — degrade to plain text instead of a dead button.
  if (content == null && !path && !artifactId) {
    return <span className={cn("font-mono", className)}>{displayLabel}</span>;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={path ?? displayLabel}
        className={cn(
          "inline-flex max-w-full items-center gap-1 truncate text-left font-mono text-blue-600 underline-offset-2 hover:underline dark:text-blue-400",
          className,
        )}
      >
        <FileText className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{displayLabel}</span>
      </button>
      {open && (
        <FileViewerModal
          projectId={projectId}
          changeId={changeId}
          target={{ path, artifactId, content, label: displayLabel }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
