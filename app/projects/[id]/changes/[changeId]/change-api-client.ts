import type { ChangeDetail } from "./change-detail-types";
import type { GateStatus } from "./gate-types";
import type { PlanSandboxState } from "./plan-sandbox-types";
import type { PrdBriefingState } from "./prd-briefing-types";
import type { ReviewCenterResponse } from "./review-report-center";
import type { SpecBattleState } from "./spec-battle-types";
import type { TestPlanSandboxState } from "./testplan-sandbox-types";
import type { CodexHealthProjection } from "./codex-task-control";
import type { EmergencyInteraction } from "./emergency-interaction-panel";

export interface PipelineCommandInput {
  actionId: string;
  expectedGateVersion: string;
  expectedSourceDbHash: string;
  expectedHeadSha: string | null;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
}

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
    // The Codex task state is per stage, so the caller says which one it shows.
    getChange: async (stageId?: string) => readJson<ChangeDetail>(
      await fetch(stageId ? `${base}?stage=${encodeURIComponent(stageId)}` : base),
      "Change not found",
    ),
    getGate: async () => readJson<GateStatus>(await fetch(`${base}/gate`), "Failed to load gate"),
    getSpecBattle: async () => readJson<SpecBattleState>(await fetch(`${base}/spec-battle`), "Failed to load spec battle"),
    getPlanSandbox: async () => readJson<PlanSandboxState>(await fetch(`${base}/plan-sandbox`), "Failed to load Plan sandbox"),
    getTestPlanSandbox: async () => readJson<TestPlanSandboxState>(await fetch(`${base}/testplan-sandbox`), "Failed to load TestPlan sandbox"),
    getPrdBriefing: async () => readJson<PrdBriefingState>(await fetch(`${base}/prd-briefing`), "Failed to load PRD briefing"),
    getReviewCenter: async () => readJson<ReviewCenterResponse>(await fetch(`${base}/review-center`), "Failed to load Review center"),
    getCodexHealth: async () => readJson<CodexHealthProjection>(
      await fetch("/api/codex/health"),
      "Failed to load Codex health",
    ),
    openCodexTask: async () => readJson<{ opened: true; threadId: string }>(
      await fetch(`${base}/codex/open`, { method: "POST" }),
      "Failed to open Codex task",
    ),
    interruptCodexTurn: async () => readJson<{ interrupted: true; commandId: string }>(
      await fetch(`${base}/codex/interrupt`, { method: "POST" }),
      "Failed to interrupt Codex turn",
    ),
    getInteraction: async (interactionId: string) =>
      readJson<EmergencyInteraction>(
        await fetch(`/api/interactions/${interactionId}`),
        "Failed to load interaction",
      ),
    executeCommand: async (input: PipelineCommandInput) =>
      readJson<Record<string, unknown>>(
        await fetch(`${base}/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...input, payload: input.payload ?? {} }),
        }),
        "Failed to execute command",
      ),
    saveCodexSettings: async (settings: {
      model: string | null;
      reasoningEffort: string | null;
    }) => readJson<{ model: string | null; reasoningEffort: string | null }>(
      await fetch(`${base}/codex-settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      }),
      "Failed to save Codex settings",
    ),
  };
}
