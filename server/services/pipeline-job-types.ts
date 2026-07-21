import type { Provider } from "./provider-selection-service";

const PIPELINE_JOB_ACTIONS_BY_PHASE = {
  intake: ["run_prd", "retry_prd"],
  prd_briefing_questions: ["run_prd_briefing_questions"],
  prd_briefing_draft: ["run_prd_briefing_draft"],
  prd_briefing_final_review: ["run_prd_briefing_final_review"],
  spec: ["run_spec", "retry_spec"],
  tech_spec: ["run_tech_spec", "retry_tech_spec"],
  generate_plan: ["run_plan", "retry_plan"],
  test_plan: ["run_test_plan", "retry_test_plan"],
  implement: ["run_build", "retry_build"],
  review: ["run_review", "retry_review"],
  local_check: ["enter_qa", "run_qa", "retry_qa"],
  fix_findings: ["fix_blockers", "run_fix", "retry_fix"],
  release: ["run_release", "merge"],
  retro: ["run_retro"],
  delivery: ["run_delivery"],
} as const;

export type PipelineJobPhase = keyof typeof PIPELINE_JOB_ACTIONS_BY_PHASE;
export type PipelineJobActionId =
  (typeof PIPELINE_JOB_ACTIONS_BY_PHASE)[PipelineJobPhase][number];

type PipelineJobSelection = {
  [Phase in PipelineJobPhase]: {
    phase: Phase;
    actionId: (typeof PIPELINE_JOB_ACTIONS_BY_PHASE)[Phase][number];
  };
}[PipelineJobPhase];

export type EnqueuePipelineJobInput = PipelineJobSelection & {
  changeId: string;
  idempotencyKey?: string | null;
  /** Requested one-off provider; omitted requests use changes.provider. */
  provider?: Provider;
};

interface PipelineJobRecordBase {
  id: string;
  changeId: string;
  idempotencyKey: string | null;
  status: string;
  leasedBy: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  attemptNo: number;
  errorCode: string | null;
  errorSummary: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  provider: Provider;
}

export type PipelineJobRecord = PipelineJobRecordBase & PipelineJobSelection;

export interface PipelineJobPayload {
  job: PipelineJobRecord;
  created: boolean;
}

type PipelineJobRow = Omit<PipelineJobRecordBase, "provider"> & {
  phase: string;
  actionId: string;
  provider?: string | null;
};

type PipelineJobPayloadRow = {
  job: PipelineJobRow;
  created: boolean;
};

/**
 * Resolves the enqueue-time (phase, actionId) selection for an action, or null
 * for actions that never become pipeline jobs (human decisions, approvals).
 * This is what lets read paths evaluate the same enqueue authority the job
 * dispatcher will enforce.
 */
export function pipelineJobSelectionForAction(actionId: string): PipelineJobSelection | null {
  for (const [phase, actions] of Object.entries(PIPELINE_JOB_ACTIONS_BY_PHASE)) {
    if ((actions as readonly string[]).includes(actionId)) {
      return { phase, actionId } as PipelineJobSelection;
    }
  }
  return null;
}

function parsePipelineJobSelection(phase: string, actionId: string): PipelineJobSelection {
  const actions = PIPELINE_JOB_ACTIONS_BY_PHASE[phase as PipelineJobPhase] as
    | readonly string[]
    | undefined;
  if (!actions) {
    throw new Error(`Unsupported pipeline job phase: ${phase}`);
  }
  if (!actions.includes(actionId)) {
    throw new Error(`Unsupported pipeline job phase/action pair: ${phase}:${actionId}`);
  }
  return { phase, actionId } as PipelineJobSelection;
}

export function parsePipelineJobPayload(
  row: PipelineJobRow | PipelineJobPayloadRow,
): PipelineJobPayload {
  const created = "job" in row ? row.created : false;
  const job = "job" in row ? row.job : row;
  const selection = parsePipelineJobSelection(job.phase, job.actionId);
  const provider = job.provider === "claude" ? "claude" : "codex";
  return {
    job: {
      ...job,
      ...selection,
      provider,
    },
    created,
  };
}
