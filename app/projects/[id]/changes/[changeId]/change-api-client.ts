import type { ChangeDetail } from "./change-detail-types";
import type { GateStatus } from "./gate-types";
import type { PlanSandboxState } from "./plan-sandbox-types";
import type { PrdBriefingState } from "./prd-briefing-types";
import type { ReviewCenterResponse } from "./review-report-center";
import type { SpecBattleState } from "./spec-battle-types";
import type { TestPlanSandboxState } from "./testplan-sandbox-types";

export async function readJson<T>(res: Response, fallback: string): Promise<T> {
  if (res.ok) {
    return (await res.json()) as T;
  }
  const data = await res.json().catch(() => ({}));
  const message = typeof data.error === "string" ? data.error : fallback;
  throw new Error(message);
}

export function changeApi(projectId: string, changeId: string) {
  const base = `/api/projects/${projectId}/changes/${changeId}`;
  return {
    getChange: async () => readJson<ChangeDetail>(await fetch(base), "Change not found"),
    getGate: async () => readJson<GateStatus>(await fetch(`${base}/gate`), "Failed to load gate"),
    getSpecBattle: async () => readJson<SpecBattleState>(await fetch(`${base}/spec-battle`), "Failed to load spec battle"),
    getPlanSandbox: async () => readJson<PlanSandboxState>(await fetch(`${base}/plan-sandbox`), "Failed to load Plan sandbox"),
    getTestPlanSandbox: async () => readJson<TestPlanSandboxState>(await fetch(`${base}/testplan-sandbox`), "Failed to load TestPlan sandbox"),
    getPrdBriefing: async () => readJson<PrdBriefingState>(await fetch(`${base}/prd-briefing`), "Failed to load PRD briefing"),
    getReviewCenter: async () => readJson<ReviewCenterResponse>(await fetch(`${base}/review-center`), "Failed to load Review center"),
  };
}
