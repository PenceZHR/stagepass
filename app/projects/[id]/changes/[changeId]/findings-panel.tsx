"use client";

import { useEffect, useState } from "react";
import { ProducedFile } from "./produced-file";

export interface FindingItem {
  id: string;
  source: string;
  severity: string;
  category: string;
  title: string;
  file: string | null;
  status: string;
}

const SEVERITY_COLORS: Record<string, string> = {
  BLOCKER: "bg-red-200 text-red-900",
  P1: "bg-orange-200 text-orange-900",
  P2: "bg-yellow-200 text-yellow-900",
  P3: "bg-gray-200 text-gray-800",
};

export interface FindingsPanelProps {
  projectId: string;
  changeId: string;
}

export function FindingsPanel({
  projectId,
  changeId,
}: FindingsPanelProps) {
  const [items, setItems] = useState<FindingItem[]>([]);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/changes/${changeId}/findings`)
      .then((r) => r.json())
      .then(setItems);
  }, [projectId, changeId]);

  return (
    <div className="rounded-lg border p-4">
      <h3 className="mb-2 font-medium">Findings</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No findings.</p>
      ) : (
        <div className="max-h-64 overflow-y-auto text-xs">
          {items.map((f) => (
            <div key={f.id} className="flex items-center gap-2 border-b py-1 last:border-0">
              <span className="font-mono text-muted-foreground">{f.id}</span>
              <span>{f.source}</span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${SEVERITY_COLORS[f.severity] || "bg-gray-100"}`}
              >
                {f.severity}
              </span>
              <span className="flex-1 truncate">{f.title}</span>
              {f.file && (
                <ProducedFile
                  projectId={projectId}
                  changeId={changeId}
                  path={f.file}
                  label={f.file}
                  className="font-mono text-[10px]"
                />
              )}
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] ${f.status === "open" ? "bg-red-100 text-red-800" : "bg-green-100 text-green-800"}`}
              >
                {f.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
