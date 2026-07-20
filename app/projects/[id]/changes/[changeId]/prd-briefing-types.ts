export type BriefingStatus =
  | "intent_captured"
  | "questions_ready"
  | "draft_ready"
  | "final_review_ready"
  | "locked";

export type BriefingQuestionSeverity = "critical" | "important" | "optional";
export type BriefingQuestionStatus = "open" | "answered" | "assumption_accepted" | "deferred";

export interface PrdBriefing {
  id: string;
  changeId: string;
  status: BriefingStatus | string;
  intentText: string;
  finalReviewJson: string | null;
  sourceHashesJson: string;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BriefingQuestion {
  id: string;
  changeId: string;
  category: string;
  severity: BriefingQuestionSeverity;
  question: string;
  whyItMatters: string;
  suggestedDefault: string | null;
  status: BriefingQuestionStatus;
  answer: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrdDraft {
  id: string;
  changeId: string;
  version: number;
  markdown: string;
  sourceQuestionIdsJson: string;
  unresolvedQuestionIdsJson: string;
  draftHash: string;
  createdAt: string;
}

export interface PrdGate {
  canLock: boolean;
  blockingQuestionIds: string[];
  deferredQuestionIds: string[];
  clarityLevel: "low" | "medium" | "high";
  riskLevel: "low" | "medium" | "high";
  draftFresh: boolean;
  finalReviewFresh: boolean;
}

export interface PrdFinalReview {
  unit?: string;
  verdict: "ready" | "needs_answer" | "risky_but_allowed";
  blockingQuestionIds: string[];
  riskSummary: string;
  recommendedNextAction: "lock_prd" | "answer_questions" | "cancel_change";
}

export interface PrdBriefingRun {
  id: string;
  changeId: string;
  phase: string;
  status: "running" | "completed" | "failed" | "stopped" | string;
  startedAt: string | null;
  endedAt: string | null;
  summary: string | null;
}

export interface StageProgressDto {
  schemaVersion: "stage_progress/v1";
  phase: string;
  runId: string;
  stageRunId?: string;
  attemptNo?: number;
  status:
    | "started"
    | "provider_running"
    | "ingesting"
    | "file_candidate"
    | "repairing"
    | "completed"
    | "failed"
    | "invalid_output"
    | "mirror_write_failed"
    | string;
  message?: string;
  source: string;
}

export interface PrdBriefingState {
  briefing: PrdBriefing | null;
  questions: BriefingQuestion[];
  latestDraft: PrdDraft | null;
  gate: PrdGate;
  finalReview: PrdFinalReview | null;
  activeRun: PrdBriefingRun | null;
  stageProgress: StageProgressDto | null;
}
