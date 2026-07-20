"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ProducedFile } from "./produced-file";

export interface ArtifactItem {
  id: string;
  type: string;
  path: string;
  createdAt: string;
}

export function ArtifactsPanel({
  projectId,
  changeId,
  changeStatus,
}: {
  projectId: string;
  changeId: string;
  changeStatus: string;
}) {
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [viewingContent, setViewingContent] = useState<{ id: string; content: string; type: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/changes/${changeId}/artifacts`)
      .then((r) => r.json())
      .then(setItems);
  }, [projectId, changeId]);

  const viewArtifact = async (artifact: ArtifactItem) => {
    const res = await fetch(
      `/api/projects/${projectId}/changes/${changeId}/artifacts/${artifact.id}/content`
    );
    if (res.ok) {
      const data = await res.json();
      setViewingContent({ id: artifact.id, content: data.content, type: artifact.type });
      setEditContent(data.content);
      setEditing(false);
    }
  };

  const saveEdit = async () => {
    if (!viewingContent) return;
    setSaving(true);
    const res = await fetch(
      `/api/projects/${projectId}/changes/${changeId}/artifacts/${viewingContent.id}/content`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      }
    );
    if (res.ok) {
      setViewingContent({ ...viewingContent, content: editContent });
      setEditing(false);
    }
    setSaving(false);
  };

  const canEdit = changeStatus === "PLAN_READY";

  return (
    <div className="rounded-lg border p-4">
      <h3 className="mb-2 font-medium">Artifacts</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No artifacts.</p>
      ) : (
        <div className="max-h-64 overflow-y-auto text-xs">
          {items.map((a) => (
            <div key={a.id} className="flex items-center gap-2 border-b py-1 last:border-0">
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                {a.type}
              </span>
              <ProducedFile
                projectId={projectId}
                changeId={changeId}
                artifactId={a.id}
                label={a.path.split("/").pop() ?? a.path}
                className="flex-1 truncate font-mono"
              />
              <Button variant="ghost" size="sm" className="h-5 px-2 text-[10px]" onClick={() => viewArtifact(a)}>
                View
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Artifact Viewer/Editor Dialog */}
      {viewingContent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setViewingContent(null)}>
          <div className="mx-4 flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg bg-white p-6 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h4 className="font-medium">{viewingContent.type}</h4>
              <div className="flex gap-2">
                {canEdit && !editing && (
                  <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                )}
                {editing && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                    <Button size="sm" disabled={saving} onClick={saveEdit}>
                      {saving ? "Saving..." : "Save"}
                    </Button>
                  </>
                )}
                <Button variant="ghost" size="sm" onClick={() => setViewingContent(null)}>
                  Close
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-auto">
              {editing ? (
                <textarea
                  className="h-96 w-full resize-none rounded border bg-slate-50 p-3 font-mono text-xs dark:bg-slate-800"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                />
              ) : (
                <pre className="rounded bg-slate-50 p-3 font-mono text-xs whitespace-pre-wrap dark:bg-slate-800">
                  {viewingContent.content}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
