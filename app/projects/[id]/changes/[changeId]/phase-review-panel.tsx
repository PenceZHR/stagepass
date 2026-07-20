"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { EditablePhaseArtifact } from "./editable-phase-artifact";
import { StageEvidencePanel, type StageEvidenceSection } from "./stage-evidence-panel";
import type { PhaseOverview } from "./change-detail-types";
import { REWORKABLE_REVIEW_PHASES, type ReviewPhase } from "./change-phase-map";

export interface PhaseArtifactReview {
  id: string;
  type: string;
  path: string;
  editablePath: string | null;
  fileName: string;
  impactLabel: string;
  runId: string | null;
  createdAt: string | null;
  source: "current" | "artifact" | "virtual";
  content: string | null;
  missing: boolean;
}

export interface PhaseRunReview {
  id: string;
  phase: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  summary: string | null;
}

export interface PhaseEventReview {
  id: string;
  type: string;
  message: string | null;
  rawJson: string | null;
  createdAt: string;
  runId: string | null;
}

export interface PhaseReviewResponse {
  phases: PhaseOverview[];
  selected: {
    phase: ReviewPhase;
    selectedRunId: string | null;
    artifacts: PhaseArtifactReview[];
    runs: PhaseRunReview[];
    events: PhaseEventReview[];
  };
}

export function PhaseReviewPanel({
  projectId,
  changeId,
  phase,
  changeStatus,
  latestRunStatus,
  onReviewLoaded,
  onReworked,
}: {
  projectId: string;
  changeId: string;
  phase: ReviewPhase;
  changeStatus: string;
  latestRunStatus?: string | null;
  onReviewLoaded?: (phases: PhaseOverview[]) => void;
  onReworked?: () => void;
}) {
  const {
    selectedRunId,
    setSelectedRunId,
    reloadPhaseReview,
    reviewState,
  } = usePhaseReviewData({ projectId, changeId, phase, onReviewLoaded });
  const [reworking, setReworking] = useState(false);
  const [reworkError, setReworkError] = useState("");

  const handleRework = async () => {
    setReworking(true);
    setReworkError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/changes/${changeId}/rework`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Rework failed");
      onReworked?.();
    } catch (err) {
      setReworkError(String(err));
    } finally {
      setReworking(false);
    }
  };

  const loading = reviewState.phase !== phase || reviewState.runId !== selectedRunId || reviewState.loading;
  const error = reviewState.phase === phase ? reviewState.error : "";
  const review = reviewState.phase === phase ? reviewState.review : null;
  const selected = review?.selected;
  const isChangeRunning = ["PLANNING", "IMPLEMENTING", "CHECKING", "FIXING"].includes(changeStatus);
  const phaseArtifactReadOnly = [
    "REFINING",
    "INTAKE_PENDING",
    "PLANNING",
    "IMPLEMENTING",
    "REVIEWING",
    "CHECKING",
    "FIXING",
    "SPECCING",
    "TECHSPECCING",
    "TESTPLANNING",
    "MERGING",
    "RETRO_PENDING",
  ].includes(changeStatus) || latestRunStatus === "running";
  const hasContent = !!selected && selected.artifacts.length + selected.runs.length + selected.events.length > 0;

  return (
    <PhaseEvidenceView
      projectId={projectId}
      changeId={changeId}
      phase={phase}
      selected={selected}
      selectedRunId={selectedRunId}
      setSelectedRunId={setSelectedRunId}
      loading={loading}
      error={error}
      reworkError={reworkError}
      reworking={reworking}
      isChangeRunning={isChangeRunning}
      phaseArtifactReadOnly={phaseArtifactReadOnly}
      hasContent={hasContent}
      onRework={handleRework}
      onArtifactSaved={reloadPhaseReview}
    />
  );
}

function usePhaseReviewData({
  projectId,
  changeId,
  phase,
  onReviewLoaded,
}: {
  projectId: string;
  changeId: string;
  phase: ReviewPhase;
  onReviewLoaded?: (phases: PhaseOverview[]) => void;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [reviewState, setReviewState] = useState<{
    phase: ReviewPhase;
    runId: string | null;
    review: PhaseReviewResponse | null;
    error: string;
    loading: boolean;
  }>({
    phase,
    runId: null,
    review: null,
    error: "",
    loading: true,
  });
  const reloadPhaseReview = useCallback(() => setReloadToken((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ phase });
    if (selectedRunId) query.set("runId", selectedRunId);
    fetch(`/api/projects/${projectId}/changes/${changeId}/phases?${query.toString()}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load phase");
        return data as PhaseReviewResponse;
      })
      .then((data) => {
        if (!cancelled) {
          setReviewState({ phase, runId: selectedRunId, review: data, error: "", loading: false });
          onReviewLoaded?.(data.phases);
          if (!selectedRunId && data.selected.selectedRunId) {
            setSelectedRunId(data.selected.selectedRunId);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setReviewState({
            phase,
            runId: selectedRunId,
            review: null,
            error: String(err),
            loading: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, changeId, phase, selectedRunId, onReviewLoaded, reloadToken]);

  return {
    selectedRunId,
    setSelectedRunId,
    reloadPhaseReview,
    reviewState,
  };
}

function PhaseEvidenceView({
  projectId,
  changeId,
  phase,
  selected,
  selectedRunId,
  setSelectedRunId,
  loading,
  error,
  reworkError,
  reworking,
  isChangeRunning,
  phaseArtifactReadOnly,
  hasContent,
  onRework,
  onArtifactSaved,
}: {
  projectId: string;
  changeId: string;
  phase: ReviewPhase;
  selected: PhaseReviewResponse["selected"] | undefined;
  selectedRunId: string | null;
  setSelectedRunId: (runId: string | null) => void;
  loading: boolean;
  error: string;
  reworkError: string;
  reworking: boolean;
  isChangeRunning: boolean;
  phaseArtifactReadOnly: boolean;
  hasContent: boolean;
  onRework: () => void;
  onArtifactSaved: () => void;
}) {
  const commonEmptyLabel = "No evidence for this section yet.";
  // Only these phases have a working /rework path; showing the button on the
  // others (Intake/Spec/TechSpec/Review/Merge/Retro) just yields a 400.
  const canRework = REWORKABLE_REVIEW_PHASES.includes(phase);
  const sections: StageEvidenceSection[] = [
    {
      id: "artifacts",
      title: "Artifacts",
      count: selected?.artifacts.length ?? 0,
      emptyLabel: commonEmptyLabel,
      children: (
        <div className="space-y-4">
          {selected?.artifacts.map((artifact) => (
            <EditablePhaseArtifact
              key={artifact.id}
              projectId={projectId}
              changeId={changeId}
              artifact={artifact}
              readOnly={phaseArtifactReadOnly}
              onSaved={onArtifactSaved}
            />
          ))}
        </div>
      ),
    },
    {
      id: "runs",
      title: "Runs",
      count: selected?.runs.length ?? 0,
      emptyLabel: commonEmptyLabel,
      children: (
        <div className="space-y-2 text-xs">
          {selected?.runs.map((run) => (
            <div key={run.id} className="rounded border bg-background p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono">{run.id}</span>
                <span className="rounded bg-muted px-1.5 py-0.5">{run.status}</span>
              </div>
              <p className="mt-1 text-muted-foreground">{run.phase}</p>
              {run.summary ? <p className="mt-1">{run.summary}</p> : null}
            </div>
          ))}
        </div>
      ),
    },
    {
      id: "events",
      title: "Events",
      count: selected?.events.length ?? 0,
      emptyLabel: commonEmptyLabel,
      children: (
        <div className="max-h-80 overflow-y-auto font-mono text-xs">
          {selected?.events.map((evt) => (
            <div key={evt.id} className="border-b py-1 last:border-0">
              <div className="flex items-start gap-1">
                <span className="shrink-0 text-muted-foreground">
                  [{new Date(evt.createdAt).toLocaleTimeString()}]
                </span>
                <span className="shrink-0 font-medium">{evt.type}</span>
                <span className="truncate">{evt.message}</span>
              </div>
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <StageEvidencePanel
      title={`${phase} Phase Review`}
      description="Artifacts, runs, and events for the selected phase."
      loading={loading}
      error={error}
      actionError={reworkError}
      actionSlot={
        <>
          {selected?.runs.length ? (
            <select
              aria-label="Select phase review run"
              className="h-8 rounded border bg-background px-2 text-xs"
              value={selectedRunId ?? selected.selectedRunId ?? ""}
              onChange={(event) => setSelectedRunId(event.target.value || null)}
            >
              {selected.runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.id} · {run.status}
                </option>
              ))}
            </select>
          ) : null}
          {canRework && (
            <Button
              variant="outline"
              size="sm"
              disabled={loading || reworking || isChangeRunning || !hasContent}
              onClick={onRework}
            >
              Rework This Phase
            </Button>
          )}
        </>
      }
      sections={sections}
    />
  );
}
