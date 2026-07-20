"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ProducedFile } from "./produced-file";

export interface DiffItem {
  file: string;
  diff: string;
  isNew: boolean;
}

export interface ChangedFilesPanelProps {
  projectId: string;
  changeId: string;
  files: string[];
}

export function ChangedFilesPanel({
  projectId,
  changeId,
  files,
}: ChangedFilesPanelProps) {
  const [diffs, setDiffs] = useState<DiffItem[]>([]);
  const [showingDiff, setShowingDiff] = useState<DiffItem | null>(null);
  const [loading, setLoading] = useState(false);

  const loadDiffs = async () => {
    setLoading(true);
    const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/diff`);
    if (res.ok) {
      const data = await res.json();
      setDiffs(data.files);
    }
    setLoading(false);
  };

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-medium">Changed Files</h3>
        {files.length > 0 && (
          <Button variant="ghost" size="sm" onClick={loadDiffs} disabled={loading}>
            {loading ? "Loading..." : "Load Diffs"}
          </Button>
        )}
      </div>
      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">No files changed yet.</p>
      ) : (
        <div className="max-h-64 overflow-y-auto text-xs">
          {files.map((f) => {
            const diffItem = diffs.find((d) => d.file === f);
            return (
              <div key={f} className="flex items-center gap-2 border-b py-1 font-mono last:border-0">
                <ProducedFile
                  projectId={projectId}
                  changeId={changeId}
                  path={f}
                  label={f}
                  className="flex-1"
                />
                {diffItem && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-2 text-[10px]"
                    onClick={() => setShowingDiff(diffItem)}
                  >
                    Diff
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Diff Viewer Dialog */}
      {showingDiff && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowingDiff(null)}>
          <div className="mx-4 flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg bg-white p-6 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h4 className="font-mono text-sm">
                {showingDiff.file}
                {showingDiff.isNew && <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-800">NEW</span>}
              </h4>
              <Button variant="ghost" size="sm" onClick={() => setShowingDiff(null)}>
                Close
              </Button>
            </div>
            <pre className="flex-1 overflow-auto rounded bg-slate-50 p-3 font-mono text-xs dark:bg-slate-800">
              {showingDiff.diff.split("\n").map((line, i) => {
                let lineClass = "";
                if (line.startsWith("+")) lineClass = "text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950";
                else if (line.startsWith("-")) lineClass = "text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-950";
                else if (line.startsWith("@@")) lineClass = "text-blue-600 dark:text-blue-400";
                return (
                  <div key={i} className={lineClass}>
                    {line}
                  </div>
                );
              })}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
