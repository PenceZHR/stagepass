import type { ReviewPhase } from "./change-phase-map";
import type { CodexControlProjection } from "./codex-task-control";

export interface ChangeDetail {
  id: string;
  projectId: string;
  title: string;
  status: string;
  provider?: string;
  codexThreadId: string | null;
  fixIterations: number;
  blockedPhase?: string | null;
  reworkFromPhase?: string | null;
  gateState?: string | null;
  gitBranch?: string | null;
  createdAt: string;
  updatedAt: string;
  changedFiles?: string[];
  findingsSummary?: { open: number; total: number };
  latestRun?: { id: string; phase: string; status: string; summary?: string | null } | null;
  testPlanCompleted?: boolean;
  artifactCount?: number;
  codexControl?: CodexControlProjection & {
    decisionPhase: string | null;
    interactionKind: string | null;
  };
}

export interface PhaseOverview {
  phase: ReviewPhase;
  available: boolean;
  artifactCount: number;
  runCount: number;
  eventCount: number;
}
