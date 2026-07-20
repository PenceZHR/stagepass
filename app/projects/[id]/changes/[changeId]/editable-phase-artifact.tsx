"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ProducedFile } from "./produced-file";

type PhaseArtifactSource = "current" | "artifact" | "virtual";

interface EditablePhaseArtifactReview {
  id: string;
  type: string;
  path: string;
  editablePath: string | null;
  fileName: string;
  impactLabel: string;
  runId: string | null;
  createdAt: string | null;
  source: PhaseArtifactSource;
  content: string | null;
  missing: boolean;
}

interface EditablePhaseArtifactProps {
  projectId: string;
  changeId: string;
  artifact: EditablePhaseArtifactReview;
  readOnly: boolean;
  onSaved: () => void;
}

function isJsonFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".json");
}

export function EditablePhaseArtifact({
  projectId,
  changeId,
  artifact,
  readOnly,
  onSaved,
}: EditablePhaseArtifactProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(artifact.content ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canEdit = !readOnly && !!artifact.editablePath && artifact.content !== null;
  const isEditing = editing && canEdit;
  const displayedContent = isEditing ? draft : artifact.content ?? "";

  useEffect(() => {
    if (readOnly && editing) {
      queueMicrotask(() => {
        setDraft(artifact.content ?? "");
        setError("");
        setEditing(false);
      });
    }
  }, [artifact.content, editing, readOnly]);

  const startEditing = () => {
    setDraft(artifact.content ?? "");
    setError("");
    setEditing(true);
  };

  const cancelEditing = () => {
    setDraft(artifact.content ?? "");
    setError("");
    setEditing(false);
  };

  const save = async () => {
    if (!canEdit) return;
    if (isJsonFile(artifact.fileName)) {
      try {
        JSON.parse(draft);
      } catch {
        setError("JSON 格式不合法，未保存。");
        return;
      }
    }

    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/phase-artifacts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: artifact.editablePath, content: draft }),
      });
      let data: { error?: string } | null = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) throw new Error(data?.error || "保存失败。");
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded border">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
          {artifact.type}
        </span>
        <ProducedFile
          projectId={projectId}
          changeId={changeId}
          artifactId={artifact.source === "artifact" ? artifact.id : undefined}
          content={artifact.content}
          label={artifact.fileName}
          className="font-mono"
        />
        <span className="rounded bg-muted/60 px-1.5 py-0.5">{artifact.impactLabel}</span>
        <span className="text-muted-foreground">{artifact.source}</span>
        {artifact.runId && (
          <span className="font-mono text-muted-foreground">{artifact.runId}</span>
        )}
        <span
          className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
          title={artifact.path}
        >
          {artifact.path}
        </span>
        {canEdit && !isEditing && (
          <Button type="button" variant="outline" size="sm" onClick={startEditing}>
            编辑
          </Button>
        )}
        {isEditing && (
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={saving} onClick={cancelEditing}>
              取消
            </Button>
            <Button type="button" size="sm" disabled={saving} onClick={save}>
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
        )}
      </div>

      {error && (
        <p className="border-b px-3 py-2 text-sm text-red-500" role="alert">
          {error}
        </p>
      )}

      {artifact.content === null ? (
        <p className="p-3 text-sm text-muted-foreground">无法读取文件内容。</p>
      ) : isEditing ? (
        <textarea
          className="min-h-80 w-full resize-y bg-background p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          value={displayedContent}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={`编辑 ${artifact.fileName}`}
          spellCheck={false}
        />
      ) : (
        <pre className="max-h-96 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">
          {artifact.content}
        </pre>
      )}
    </div>
  );
}
