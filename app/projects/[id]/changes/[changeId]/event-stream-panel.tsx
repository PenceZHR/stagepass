"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { EventItem } from "./change-event-types";

export interface EventStreamPanelProps {
  projectId: string;
  changeId: string;
}

export function EventStreamPanel({
  projectId,
  changeId,
}: EventStreamPanelProps) {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(
      `/api/projects/${projectId}/changes/${changeId}/events/stream`
    );
    es.onmessage = (e) => {
      const evt = JSON.parse(e.data) as EventItem;
      setEvents((prev) => [...prev, evt]);
    };
    return () => es.close();
  }, [projectId, changeId]);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [events, autoScroll]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex h-[calc(100vh-20rem)] flex-col rounded-lg border">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <h3 className="font-medium">Event Stream</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAutoScroll(!autoScroll)}
        >
          {autoScroll ? "Pause" : "Resume"}
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 font-mono text-xs">
        {events.length === 0 ? (
          <p className="text-muted-foreground">No events yet.</p>
        ) : (
          events.map((evt) => {
            const isReasoning = evt.type === "ai_reasoning";
            const isAiMessage = evt.type === "ai_message";
            const isCodexOutput = evt.type === "codex_output";
            const isExpandable = isReasoning || isCodexOutput;
            const expanded = expandedIds.has(evt.id);
            return (
              <div
                key={evt.id}
                className={`border-b py-1 last:border-0 ${isReasoning ? "bg-amber-50 dark:bg-amber-950" : isAiMessage ? "bg-blue-50 dark:bg-blue-950" : isCodexOutput ? "bg-slate-50 dark:bg-slate-900" : ""}`}
              >
                <div
                  className={`flex items-start gap-1 ${isExpandable ? "cursor-pointer" : ""}`}
                  onClick={() => isExpandable && toggleExpand(evt.id)}
                >
                  <span className="shrink-0 text-muted-foreground">
                    [{new Date(evt.createdAt).toLocaleTimeString()}]
                  </span>
                  {isReasoning ? (
                    <span className="text-amber-700 dark:text-amber-400">
                      {expanded ? "▼" : "▶"} 💭 {evt.message}
                    </span>
                  ) : isAiMessage ? (
                    <span className="text-blue-700 dark:text-blue-300">
                      🤖 {evt.message}
                    </span>
                  ) : isCodexOutput ? (
                    <span className="text-blue-600 dark:text-blue-400">
                      {expanded ? "▼" : "▶"} {evt.message}
                    </span>
                  ) : (
                    <>
                      <span className="shrink-0 font-medium">{evt.type}</span>
                      <span className="truncate">{evt.message}</span>
                    </>
                  )}
                </div>
                {isExpandable && expanded && evt.rawJson && (
                  <pre className="mt-1 max-h-32 overflow-auto rounded bg-slate-100 p-2 text-[10px] dark:bg-slate-800">
                    {JSON.stringify(JSON.parse(evt.rawJson), null, 2)}
                  </pre>
                )}
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
